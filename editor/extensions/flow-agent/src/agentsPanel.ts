/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page, a full-editor webview behind the title bar's Agents button (it replaces VS Code's own
 *  "Open in Agents" window button). One panel per window: the host sends it the rows (agentRows.ts, the dock's own) and
 *  carries out what it asks for. The page is not trusted: every message goes through agentsAction.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildRows, skeletonStages } from './agentRows';
import type { Agents } from './agents';
import { bypassAllowed, BYPASS_SETTING } from './bypass';
import type { StartHow } from './dockMessage';
import type { AgentsPageData, AgentsPageLayouts, AgentsPageMessage, AgentsPageTail } from './agentsData';
import { agentsAction } from './agentsMessage';
import { agentsHtml, type TermAssets } from './agentsPage';
import { readAvatar } from './desktopModel';
import type { LayoutStore } from './layoutStore';
import type { Peers } from './peers';
import { renameFromPalette } from './paletteActions';
import { savedAgents } from './pick';
import type { ProjectIndex } from './projectIndex';
import { startOrResume } from './resume';
import type { TermAttachment } from './termBridge';
import type { TermHost } from './termHost';
import { readTail } from './transcriptTail';
import type { WorktreeRows } from './worktreeActions';

export const OPEN_AGENTS_PAGE = 'flow.agents.openPage';

let assets: TermAssets | undefined | null;
/**
 * xterm.js and its style sheet, built next to the extension (esbuild.mjs writes out/xterm.js and out/xterm.css). Read once. Without them (a
 * checkout that was not built, a test) the page still opens: its panes then point at the terminal in the editor.
 */
function termAssets(): TermAssets | undefined {
	if (assets === undefined) {
		try {
			assets = { js: readFileSync(path.join(__dirname, 'xterm.js'), 'utf8'), css: readFileSync(path.join(__dirname, 'xterm.css'), 'utf8') };
		} catch {
			assets = null;
		}
	}
	return assets ?? undefined;
}

export class AgentsPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private timer: NodeJS.Timeout | undefined;
	/** A repaint waits for flow-view's answers; one that a newer repaint overtook while waiting is dropped, so the older data never lands last. */
	private paint = 0;
	private listeners: vscode.Disposable[] = [];
	/** The session search in flight: a newer query aborts it, and so does closing the page. */
	private searching: AbortController | undefined;
	/** The terminals this page shows, by agent session: only these may be typed into or resized by the page. */
	private readonly attached = new Map<string, TermAttachment>();

	constructor(private readonly agents: Agents, private readonly worktrees?: WorktreeRows, private readonly peers?: Peers, private readonly projects?: ProjectIndex, private readonly term?: TermHost, private readonly layouts?: LayoutStore) {}

	/**
	 * Opens the page, or brings the open one to the front. On the desktop it opens in a window of its own (flow.agents.page.location,
	 * default "window"); in the web UI, which has no second window, and with "tab" it stays an editor tab. One panel, so a second
	 * call reveals the same page wherever it lives now.
	 */
	open(): void {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		this.create();
		if (vscode.env.uiKind === vscode.UIKind.Desktop && vscode.workspace.getConfiguration('flow.agents.page').get<string>('location', 'window') !== 'tab') {
			void this.intoWindow(this.panel);
		}
	}

	/** Moves the active editor into a new window, once the page is the active editor: the command moves whichever one is active, so a slow open must not move another tab. */
	private async intoWindow(panel: vscode.WebviewPanel | undefined) {
		if (panel && !panel.active) {
			await new Promise<void>(resolve => {
				const done = () => { d.dispose(); clearTimeout(t); resolve(); };
				const d = panel.onDidChangeViewState(e => e.webviewPanel.active && done());
				const t = setTimeout(done, 3000);
			});
		}
		if (panel && panel.active && panel === this.panel) {
			await Promise.resolve(vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow')).catch(() => undefined);
		}
	}

	private create(): void {
		const panel = vscode.window.createWebviewPanel('flow.agentsPage', 'Agents', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
		this.panel = panel;
		panel.iconPath = new vscode.ThemeIcon('sparkle') as unknown as vscode.WebviewPanel['iconPath'];
		panel.webview.html = agentsHtml(randomBytes(16).toString('base64'), termAssets());
		const repaint = () => this.post();
		this.listeners = [
			panel.webview.onDidReceiveMessage(raw => this.onMessage(raw)),
			this.agents.onDidChange(repaint),
			...(this.worktrees ? [this.worktrees.onDidChange(repaint)] : []),
			...(this.peers ? [this.peers.onDidChange(repaint)] : []),
			vscode.workspace.onDidChangeConfiguration(e => (e.affectsConfiguration('flow.agents.avatar') || e.affectsConfiguration('insilode.skeletonFirst') || e.affectsConfiguration('flow.agents.custom') || e.affectsConfiguration(BYPASS_SETTING)) && this.post()),
			// A hidden page is not repainted (it keeps its state anyway): it catches up the moment it shows again.
			panel.onDidChangeViewState(e => e.webviewPanel.visible && this.post()),
			panel.onDidDispose(() => this.release(panel)),
		];
	}

	dispose(): void {
		const panel = this.panel;
		this.release(panel);
		panel?.dispose();
	}

	/** Forgets the panel and everything listening for it; safe to run twice. */
	private release(panel: vscode.WebviewPanel | undefined) {
		if (panel !== this.panel) {
			return;
		}
		this.panel = undefined;
		clearTimeout(this.timer);
		this.searching?.abort();
		this.attached.forEach(a => a.detach());
		this.attached.clear();
		this.listeners.forEach(d => d.dispose());
		this.listeners = [];
	}

	private send(m: AgentsPageMessage) {
		void this.panel?.webview.postMessage(m);
	}

	private onMessage(raw: unknown) {
		const m = agentsAction(raw);
		switch (m?.type) {
			case 'ready':
				this.post();
				// A page that (re)loads gets the list of earlier sessions and the layout it had.
				void this.sendIndex();
				return this.sendLayouts(true);
			case 'new': return void vscode.commands.executeCommand('flow.agents.start', m.cli);
			case 'show': return this.agents.show(m.id);
			case 'flow': return this.agents.openImpactFlow(m.id, m.index);
			case 'pr': return this.agents.openPr(m.id);
			case 'xray': return this.agents.xray(m.id);
			// Through the worktree rows: an agent's worktree must not drop out of sight with its row.
			case 'forget': return void (this.worktrees ? this.worktrees.forget(m.id) : this.agents.forget(m.id));
			case 'compact': return this.agents.compact(m.id);
			// The prompt is built here from the host's own record of the turn: the page only names the row.
			case 'explain': return this.agents.explain(m.id, savedAgents());
			case 'rename': return void renameFromPalette(this.agents, m.id);
			case 'swap': return void vscode.commands.executeCommand('flow.agents.swap', m.id);
			case 'wt': return void this.worktrees?.act(m.id, m.action);
			// One fixed command per pair, so the page never names a command id.
			case 'start': return void this.start(m.cli, m.how);
			case 'pick': return void vscode.commands.executeCommand('flow.agents.new');
			case 'sk': return void this.agents.setSkeletonOn(m.id, m.on);
			case 'tail': return void this.tail(m.id);
			// By index into the list the host sent: the page never names a command.
			case 'custom': {
				const custom = savedAgents()[m.index];
				// The list may have changed since the page was drawn: only the agent the user saw starts.
				return custom && custom.name === m.name ? void this.agents.spawn('custom', undefined, custom) : undefined;
			}
			case 'kept': return void vscode.commands.executeCommand('flow.agents.keptWorktrees');
			// Another window's project or session: looked up by key and id in what this window read (peers.ts), never a path.
			case 'peer': return void this.peers?.act(m.action, m.key, m.id);
			// The sidebar's earlier sessions: every id in what the host answers is its own.
			case 'chatList': return void this.sendIndex();
			case 'chatSearch': return void this.chatSearch(m.query);
			// The pane layouts, validated by agentsAction; what is stored is only ever what paneLayout.ts accepts.
			case 'layoutSave': return this.layouts?.setCurrent(m.layout);
			case 'layoutSaveAs': return void (this.layouts?.save(m.name, m.layout) && this.sendLayouts(false));
			case 'layoutDelete': return void (this.layouts?.remove(m.name), this.sendLayouts(false));
			// The terminal panes (termHost.ts): the page may only touch a terminal it attached to.
			case 'termAttach': return this.termAttach(m.id);
			case 'termDetach': return this.termDetach(m.id);
			case 'termInput': return void (this.attached.has(m.id) && this.term?.input(m.id, m.data));
			case 'termResize': return void (this.attached.has(m.id) && this.term?.resize(m.id, m.cols, m.rows));
			case 'termOpen': return void this.termOpen(m.requestId, m.kind, m.sessionId, m.cwd);
		}
	}

	/** The replay first, then live chunks (the bridge batches them). Attaching again replaces the pane's attachment without ever leaving the terminal unattached, so its size is kept. */
	private termAttach(id: string) {
		const attachment = this.term?.attach(id, {
			data: (data, reset) => this.send({ type: 'termData', id, data, ...(reset ? { reset: true as const } : {}) }),
			gone: () => {
				this.attached.delete(id);
				this.send({ type: 'termGone', id });
			},
		});
		if (!attachment) {
			return this.send({ type: 'termGone', id });
		}
		const old = this.attached.get(id);
		this.attached.set(id, attachment);
		this.send({ type: 'termData', id, data: attachment.replay, reset: true });
		old?.detach();
	}

	private termDetach(id: string) {
		this.attached.get(id)?.detach();
		this.attached.delete(id);
	}

	private async termOpen(requestId: string, kind: 'claude' | 'codex', sessionId: string | undefined, cwd: string | undefined) {
		try {
			if (!this.term) {
				throw new Error('Terminals are not available.');
			}
			this.send({ type: 'termOpened', id: await this.term.open(kind, sessionId, cwd), requestId });
		} catch (e) {
			this.send({ type: 'termFailed', requestId, message: (e as Error).message });
		}
	}

	private async chatSearch(query: string) {
		if (!this.projects) {
			return;
		}
		this.searching?.abort();
		const mine = this.searching = new AbortController();
		// A search that failed is not "no match": it is cut short.
		const { hits, more, cut } = await this.projects.search(query, mine.signal).catch(() => ({ hits: [], more: false, cut: true }));
		// Only the newest query is answered; the page drops an answer for a query it no longer shows as well.
		if (!mine.signal.aborted) {
			this.send({ type: 'chatFound', query, hits, more, cut });
		}
	}

	private async sendIndex() {
		if (this.projects) {
			this.send({ type: 'chatIndex', projects: await this.projects.projects() });
		}
	}

	/** The layout the page had last (only on load: the page restores it once) and the layouts the user named. */
	private sendLayouts(withCurrent: boolean) {
		if (this.layouts) {
			const current = withCurrent ? this.layouts.current() : undefined;
			const m: AgentsPageLayouts = { type: 'layouts', ...(current ? { current } : {}), saved: this.layouts.saved() };
			this.send(m);
		}
	}

	/** "In a worktree", "Resume a session…" and Claude's bypass switch of a start button's menu. */
	private start(cli: 'claude' | 'codex', how: StartHow) {
		if (how === 'bypass') {
			return vscode.commands.executeCommand('flow.agents.claudeBypass');
		}
		if (how === 'worktree') {
			return cli === 'claude' ? vscode.commands.executeCommand('flow.agents.newClaudeWorktree') : vscode.commands.executeCommand('flow.agents.newCodexWorktree');
		}
		return cli === 'claude' ? vscode.commands.executeCommand('flow.agents.resume') : startOrResume(this.agents, 'codex', false);
	}

	private async tail(id: string) {
		const s = this.agents.sessions.get(id);
		const reply = (entries: AgentsPageTail['entries'], note?: string) => this.send({ type: 'tail', id, entries, ...(note ? { note } : {}) });
		if (!s || !s.transcript || (s.cli !== 'claude' && s.cli !== 'codex')) {
			return reply([], s?.cli === 'custom' ? 'A custom agent keeps no transcript Insilode can read.' : 'No conversation to show yet.');
		}
		try {
			const entries = await readTail(s.transcript, s.cli, 40);
			reply(entries, entries.length ? undefined : 'No conversation to show yet.');
		} catch {
			reply([], 'The conversation could not be read.');
		}
	}

	/** Coalesces bursts of hook events into one repaint. */
	private post() {
		if (!this.panel?.visible) {
			return;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(async () => {
			const mine = ++this.paint;
			const stages = await skeletonStages(this.agents);
			if (mine !== this.paint || !this.panel) {
				return;
			}
			const customs = savedAgents();
			const data: AgentsPageData = {
				type: 'data',
				now: Date.now(),
				avatar: readAvatar(vscode.workspace.getConfiguration('flow.agents').get('avatar')),
				rows: buildRows(this.agents, this.worktrees, stages, customs),
				// Folder names only: the full paths stay with the host.
				kept: this.agents.keptWorktrees.map(k => ({ agent: k.agent, branch: k.branch, base: k.base, folder: path.basename(k.path) })),
				limits: this.agents.latestLimits,
				customs: customs.map(a => a.name),
				bypass: bypassAllowed(),
				project: { name: vscode.workspace.workspaceFolders?.[0]?.name ?? 'This window' },
				peers: this.peers?.view().peers ?? [],
				recent: this.peers?.view().recent ?? [],
			};
			this.send(data);
		}, 60);
	}
}
