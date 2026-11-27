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
import { bypassAllowed, BYPASS_SETTING, neverAskAllowed, NEVER_ASK_SETTING } from './bypass';
import type { StartHow } from './dockMessage';
import type { AgentsPageData, AgentsPageLayouts, AgentsPageMessage, AgentsPageTail } from './agentsData';
import { agentsAction, refusedSaveName, type AgentsPageFolderPicked } from './agentsMessage';
import { agentsHtml, type TermAssets } from './agentsPage';
import { readAvatar } from './desktopModel';
import { HarnessBridge } from './harnessBridge';
import type { LayoutStore } from './layoutStore';
import { MAX_LAYOUTS, type PaneLayout } from './paneLayout';
import type { Peers } from './peers';
import { renameFromPalette } from './paletteActions';
import { savedAgents } from './pick';
import type { ProjectIndex } from './projectIndex';
import { startOrResume } from './resume';
import type { TermAttachment } from './termBridge';
import { ElsewhereError, type TermHost } from './termHost';
import { readTail } from './transcriptTail';
import type { WorktreeRows } from './worktreeActions';

export const OPEN_AGENTS_PAGE = 'flow.agents.openPage';
/** How often a visible page looks for sessions that other programs run, and how many of those looks pass before the index is read again regardless (the Codex "recently active" estimate ages without any file changing). */
const LIVE_POLL_MS = 3000;
const INDEX_EVERY = 4;

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
	/** The light poll for sessions that run elsewhere: only while the page is visible and has said `ready`. */
	private poll: NodeJS.Timeout | undefined;
	private polling = false;
	private ticks = 0;
	private ready = false;
	/** What the last look at the machine's running sessions, and the last index sent to the page, said: the page is told only when one changes. */
	private liveSig = '';
	private indexSig = '';

	/** The Harness panel's host side: it answers only for folders the page was given, and opens only files its summaries named. */
	private readonly harness = new HarnessBridge({
		near: () => [...(vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath), ...[...this.agents.sessions.values()].map(s => s.cwd).filter((c): c is string => !!c)],
		indexed: async () => (await this.projects?.projects() ?? []).map(p => p.cwd),
		// flow-harness reads the folder (read-only); this extension never imports it.
		summary: folder => vscode.commands.executeCommand('flowHarness.summary', folder),
		open: (file, line) => vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true, ...(line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {}) }),
	});

	constructor(private readonly agents: Agents, private readonly worktrees?: WorktreeRows, private readonly peers?: Peers, private readonly projects?: ProjectIndex, private readonly term?: TermHost, private readonly layouts?: LayoutStore) {}

	/**
	 * Opens the page, or brings the open one to the front. On the desktop it opens in a window of its own (flow.agents.page.location,
	 * default "window"): core makes a compact auxiliary window that shows only the page and keeps every other editor out of it
	 * (`_insilode.agents.openWindow`, editor/patches/flow-core.patch), and the page is created straight in it. In the web UI, which has no
	 * second window, with "tab", and on a core without that command it is an editor tab. One panel, so a second call reveals the same
	 * page wherever it lives now (which also brings its window to the front).
	 */
	open(): void {
		if (this.panel) {
			// No column: a column is an index over all windows' groups, stale as soon as the main window gains one, and naming one would move the page there.
			// Without it core finds the group the page is in already (a webview editor is a singleton) and brings its window up.
			this.panel.reveal();
			return;
		}
		if (this.opening) {
			return;
		}
		if (vscode.env.uiKind === vscode.UIKind.Desktop && vscode.workspace.getConfiguration('flow.agents.page').get<string>('location', 'window') !== 'tab') {
			this.opening = true;
			void this.openInWindow().finally(() => { this.opening = false; });
		} else {
			this.create(vscode.ViewColumn.Active);
		}
	}

	/** A window is being made: a second click meanwhile must not make a second one. */
	private opening = false;

	private async openInWindow() {
		let column: unknown;
		try {
			column = await vscode.commands.executeCommand('_insilode.agents.openWindow');
		} catch {
			// A core without the command (an older build) shows the page as a tab.
		}
		this.create(typeof column === 'number' && column >= 1 ? column : vscode.ViewColumn.Active);
	}

	private create(column: vscode.ViewColumn): void {
		const panel = vscode.window.createWebviewPanel('flow.agentsPage', 'Agents', column, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
		this.panel = panel;
		// The Agents mark (media/agents*.svg, one drawing per theme kind: a tab icon is an image, not a mask).
		const icon = (name: string) => vscode.Uri.file(path.join(__dirname, '..', 'media', name));
		panel.iconPath = { light: icon('agents-light.svg'), dark: icon('agents-dark.svg') };
		panel.webview.html = agentsHtml(randomBytes(16).toString('base64'), termAssets());
		const repaint = () => this.post();
		this.listeners = [
			panel.webview.onDidReceiveMessage(raw => this.onMessage(raw)),
			this.agents.onDidChange(repaint),
			...(this.worktrees ? [this.worktrees.onDidChange(repaint)] : []),
			...(this.peers ? [this.peers.onDidChange(repaint)] : []),
			vscode.workspace.onDidChangeConfiguration(e => (e.affectsConfiguration('flow.agents.avatar') || e.affectsConfiguration('insilode.skeletonFirst') || e.affectsConfiguration('flow.agents.custom') || e.affectsConfiguration(BYPASS_SETTING) || e.affectsConfiguration(NEVER_ASK_SETTING)) && this.post()),
			// A hidden page is not repainted (it keeps its state anyway): it catches up the moment it shows again, and looks for running sessions only while it shows.
			panel.onDidChangeViewState(e => {
				if (e.webviewPanel.visible) {
					this.post();
					this.startPoll();
					void this.pollLive();
				} else {
					this.stopPoll();
				}
			}),
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
		this.stopPoll();
		this.ready = false;
		this.hasRows = false;
		this.pendingFocus = undefined; // it was for this page, not for the next one
		clearTimeout(this.timer);
		this.searching?.abort();
		this.detachAll();
		this.listeners.forEach(d => d.dispose());
		this.listeners = [];
	}

	/**
	 * Shows a live agent in the page and brings the page's window forward (a click on the agent in the desktop status island). False when the
	 * page is not open, so the caller shows the agent's terminal instead. A page that has not said ready yet gets it with its first data.
	 */
	focusSession(id: string): boolean {
		if (!this.panel) {
			return false;
		}
		this.panel.reveal();
		if (this.hasRows) {
			this.send({ type: 'focusSession', id });
		} else {
			this.pendingFocus = id;
		}
		return true;
	}

	/** An agent to show once the page has its rows (focusSession came before them), and whether it has them: a focus for a row the page does not know yet is dropped. */
	private pendingFocus: string | undefined;
	private hasRows = false;

	private send(m: AgentsPageMessage | AgentsPageFolderPicked) {
		void this.panel?.webview.postMessage(m);
	}

	private onMessage(raw: unknown) {
		const m = agentsAction(raw);
		if (!m) {
			// A named save the validation refused is answered like any other, so the page does not report it as saved.
			const refused = refusedSaveName(raw);
			return refused === undefined ? undefined : this.send({ type: 'layoutSaved', name: refused, ok: false, reason: 'invalid' });
		}
		switch (m.type) {
			case 'ready':
				// A page that loads again has forgotten what it showed: what the old one attached must not keep its size or take its input.
				this.detachAll();
				this.ready = true;
				this.hasRows = false; // the rows of this page are on their way
				this.startPoll();
				this.post();
				// A page that (re)loads gets the list of earlier sessions and the layout it had.
				void this.sendIndex();
				return this.sendLayouts(true);
			case 'new': return void vscode.commands.executeCommand('flow.agents.start', m.cli);
			case 'show': return this.agents.show(m.id);
			case 'flow': return this.agents.openImpactFlow(m.id, m.index);
			case 'pr': return this.agents.openPr(m.id);
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
			case 'tail': return void this.tail(m.id, m.kind);
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
			case 'layoutSave':
				this.layouts?.setCurrent(m.layout);
				return m.harness ? this.layouts?.setHarness(m.harness) : undefined;
			case 'layoutSaveAs': return this.saveAs(m.name, m.layout);
			case 'layoutDelete': return void (this.layouts?.remove(m.name), this.sendLayouts(false));
			// The Harness panel: a summary of a project the page was given, and a file that summary named (harnessBridge.ts); the buttons open the harness extension's own views.
			case 'harness': return void this.sendHarness(m.cwd);
			case 'harnessOpen': return void this.harness.open(m.cwd, this.workspaceFolder(), m.file, m.line);
			// One fixed command per target, so the page never names a command id.
			case 'harnessGo': return void Promise.resolve(m.target === 'map' ? vscode.commands.executeCommand('flowHarness.open') : vscode.commands.executeCommand('flowHarness.addHook')).catch(() => undefined);
			// The terminal panes (termHost.ts): the page may only touch a terminal it attached to.
			case 'termAttach': return this.termAttach(m.id);
			case 'termDetach': return this.termDetach(m.id);
			case 'termInput': return void (this.attached.has(m.id) && this.term?.input(m.id, m.data));
			case 'termResize': return void (this.attached.has(m.id) && this.term?.resize(m.id, m.cols, m.rows));
			case 'termOpen': return void this.termOpen(m.requestId, m.kind, m.sessionId, m.cwd, m.force);
			// A folder dialog of this host: the page gets the chosen folder back for this request, and the host allows that folder (folderTrust.ts).
			case 'pickFolder': return void this.pickFolder(m.requestId);
		}
	}

	private detachAll() {
		this.attached.forEach(a => a.detach());
		this.attached.clear();
	}

	private saveAs(name: string, layout: PaneLayout) {
		if (!this.layouts) {
			return;
		}
		const ok = this.layouts.save(name, layout);
		if (ok) {
			this.sendLayouts(false);
		}
		// The layout is the validated one, so what can still refuse it is the cap on names.
		this.send({ type: 'layoutSaved', name, ok, ...(ok ? {} : { reason: this.layouts.saved().length >= MAX_LAYOUTS && !this.layouts.saved().some(s => s.name === name) ? 'limit' as const : 'invalid' as const }) });
	}

	private workspaceFolder(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private async sendHarness(cwd: string | undefined) {
		const answer = await this.harness.load(cwd, this.workspaceFolder());
		if (this.panel) {
			this.send(answer);
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

	private async termOpen(requestId: string, kind: 'claude' | 'codex', sessionId: string | undefined, cwd: string | undefined, force?: true) {
		try {
			if (!this.term) {
				throw new Error('Terminals are not available.');
			}
			this.send({ type: 'termOpened', id: await this.term.open(kind, sessionId, cwd, force), requestId });
		} catch (e) {
			this.send({ type: 'termFailed', requestId, message: (e as Error).message, ...(e instanceof ElsewhereError ? { elsewhere: true as const } : {}) });
		}
	}

	/** One folder dialog at a time: a page that asks again while one is open gets "nothing chosen", so it cannot stack dialogs on the user. */
	private pickingFolder = false;

	private async pickFolder(requestId: string) {
		if (this.pickingFolder) {
			return this.send({ type: 'folderPicked', requestId });
		}
		this.pickingFolder = true;
		try {
			const chosen = await this.term?.pickFolder().catch(() => undefined);
			this.send({ type: 'folderPicked', requestId, ...(chosen ? { path: chosen.path, name: chosen.name } : {}) });
		} finally {
			this.pickingFolder = false;
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

	/** `changedOnly`: the poll's: nothing is sent when the page already has exactly this. */
	private async sendIndex(changedOnly = false) {
		if (!this.projects) {
			return;
		}
		// The poll never makes a scan of the transcripts of its own (every few seconds that is what it would do); it uses the last one.
		const projects = await this.projects.projects({ cached: changedOnly });
		const sig = JSON.stringify(projects);
		if (!changedOnly || sig !== this.indexSig) {
			this.indexSig = sig;
			this.send({ type: 'chatIndex', projects });
		}
	}

	private startPoll() {
		if (!this.poll && this.ready && this.projects && this.panel?.visible) {
			this.poll = setInterval(() => void this.pollLive(), LIVE_POLL_MS);
		}
	}

	private stopPoll() {
		clearInterval(this.poll);
		this.poll = undefined;
	}

	/** Reads the few small files of running sessions (cheap); the index is rebuilt only when they changed, or every few looks. */
	private async pollLive() {
		if (this.polling || !this.ready || !this.projects || !this.panel?.visible) {
			return;
		}
		this.polling = true;
		try {
			const sig = await this.projects.runningSignature();
			if (sig !== this.liveSig || ++this.ticks % INDEX_EVERY === 0) {
				this.liveSig = sig;
				await this.sendIndex(true);
			}
		} catch {
			// The next look tries again.
		} finally {
			this.polling = false;
		}
	}

	/** The layout the page had last (only on load: the page restores it once) and the layouts the user named. */
	private sendLayouts(withCurrent: boolean) {
		if (this.layouts) {
			const current = withCurrent ? this.layouts.current() : undefined;
			const harness = withCurrent ? this.layouts.harness() : undefined;
			const m: AgentsPageLayouts = { type: 'layouts', ...(current ? { current } : {}), ...(harness ? { harness } : {}), saved: this.layouts.saved() };
			this.send(m);
		}
	}

	/** "In a worktree", "Resume a session…" and the permissions switch (Claude's bypass, Codex's never ask) of a start button's menu. */
	private start(cli: 'claude' | 'codex', how: StartHow) {
		if (how === 'bypass') {
			return vscode.commands.executeCommand('flow.agents.claudeBypass');
		}
		if (how === 'neverAsk') {
			return vscode.commands.executeCommand('flow.agents.codexNeverAsk');
		}
		if (how === 'worktree') {
			return cli === 'claude' ? vscode.commands.executeCommand('flow.agents.newClaudeWorktree') : vscode.commands.executeCommand('flow.agents.newCodexWorktree');
		}
		return cli === 'claude' ? vscode.commands.executeCommand('flow.agents.resume') : startOrResume(this.agents, 'codex', false);
	}

	/** The tails being read, by session: the page asks again every few seconds, and a read that has not come back must not be followed by another on the same file. */
	private readonly tailing = new Set<string>();

	private async tail(id: string, kind?: 'claude' | 'codex') {
		if (this.tailing.has(id)) {
			return;
		}
		this.tailing.add(id);
		try {
			await this.readTailOf(id, kind);
		} finally {
			this.tailing.delete(id);
		}
	}

	private async readTailOf(id: string, kind?: 'claude' | 'codex') {
		const s = this.agents.sessions.get(id);
		const reply = (entries: AgentsPageTail['entries'], note?: string) => this.send({ type: 'tail', id, entries, ...(note ? { note } : {}) });
		if (!s && kind) {
			// A session of the sidebar's index, possibly one another program runs: the host finds the file from what it lists, never from the page.
			const file = this.projects?.transcriptOf(kind, id);
			const entries = file ? await readTail(file, kind, 40) : [];
			return reply(entries, entries.length ? undefined : file ? 'No conversation to show yet.' : 'This session is not listed any more.');
		}
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
			// `neverAsk` is Codex's counterpart of `bypass` (flow.agents.codex.neverAsk), for the launcher's permissions row.
			const data: AgentsPageData & { neverAsk: boolean } = {
				type: 'data',
				now: Date.now(),
				avatar: readAvatar(vscode.workspace.getConfiguration('flow.agents').get('avatar')),
				rows: buildRows(this.agents, this.worktrees, stages, customs),
				// Folder names only: the full paths stay with the host.
				kept: this.agents.keptWorktrees.map(k => ({ agent: k.agent, branch: k.branch, base: k.base, folder: path.basename(k.path) })),
				limits: this.agents.latestLimits,
				customs: customs.map(a => a.name),
				bypass: bypassAllowed(),
				neverAsk: neverAskAllowed(),
				project: { name: vscode.workspace.workspaceFolders?.[0]?.name ?? 'This window', ...(vscode.workspace.workspaceFolders?.[0] ? { cwd: vscode.workspace.workspaceFolders[0].uri.fsPath } : {}) },
				peers: this.peers?.view().peers ?? [],
				recent: this.peers?.view().recent ?? [],
			};
			this.send(data);
			this.hasRows = true;
			if (this.pendingFocus !== undefined) {
				this.send({ type: 'focusSession', id: this.pendingFocus });
				this.pendingFocus = undefined;
			}
		}, 60);
	}
}
