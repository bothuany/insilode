/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page, a full-editor webview behind the title bar's Agents button (it replaces VS Code's own
 *  "Open in Agents" window button). One panel per window: the host sends it the rows (agentRows.ts, the dock's own) and
 *  carries out what it asks for. The page is not trusted: every message goes through agentsAction.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildRows, skeletonStages } from './agentRows';
import type { Agents } from './agents';
import { bypassAllowed, BYPASS_SETTING } from './bypass';
import type { StartHow } from './dockMessage';
import type { AgentsPageData, AgentsPageMessage, AgentsPageTail, ChatEvent } from './agentsData';
import { agentsAction } from './agentsMessage';
import { agentsHtml } from './agentsPage';
import { appendEvent } from './chatCore';
import type { ChatSessions } from './chatSessions';
import { readAvatar } from './desktopModel';
import type { Peers } from './peers';
import { renameFromPalette } from './paletteActions';
import { savedAgents } from './pick';
import { startOrResume } from './resume';
import { readTail } from './transcriptTail';
import type { WorktreeRows } from './worktreeActions';

export const OPEN_AGENTS_PAGE = 'flow.agents.openPage';

export class AgentsPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private timer: NodeJS.Timeout | undefined;
	/** A repaint waits for flow-view's answers; one that a newer repaint overtook while waiting is dropped, so the older data never lands last. */
	private paint = 0;
	private listeners: vscode.Disposable[] = [];
	/** The chat the page has open, and the events of it not sent yet: bursts of streamed text go out as one message every ~30 ms. */
	private openChat: string | undefined;
	private chatQueue: ChatEvent[] = [];
	private chatTimer: NodeJS.Timeout | undefined;
	/** Counts the page's opens: when two are asked in a row the last one wins, however long each takes. */
	private openSeq = 0;

	constructor(private readonly agents: Agents, private readonly worktrees?: WorktreeRows, private readonly peers?: Peers, private readonly chats?: ChatSessions) {}

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
		panel.webview.html = agentsHtml(randomBytes(16).toString('base64'));
		const repaint = () => this.post();
		this.listeners = [
			panel.webview.onDidReceiveMessage(raw => this.onMessage(raw)),
			this.agents.onDidChange(repaint),
			...(this.chats ? [this.chats.onEvent(e => this.chatEvent(e.chat, e.event))] : []),
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
		clearTimeout(this.chatTimer);
		this.openChat = undefined;
		this.chatQueue = [];
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
				// A page that (re)loads gets the list and the chat it had open, in full.
				return void this.chatReady();
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
			case 'reply':
				if (!this.agents.typeInto(m.id, m.text, true, savedAgents(), false)) {
					this.send({ type: 'replyFailed', id: m.id });
				}
				return;
			// By index into the list the host sent: the page never names a command.
			case 'custom': {
				const custom = savedAgents()[m.index];
				// The list may have changed since the page was drawn: only the agent the user saw starts.
				return custom && custom.name === m.name ? void this.agents.spawn('custom', undefined, custom) : undefined;
			}
			case 'kept': return void vscode.commands.executeCommand('flow.agents.keptWorktrees');
			// Another window's project or session: looked up by key and id in what this window read (peers.ts), never a path.
			case 'peer': return void this.peers?.act(m.action, m.key, m.id);
			// The page's own chat (chatSessions.ts): every id was issued by the host, and the host re-checks it.
			case 'chatList': return void this.sendIndex();
			case 'chatOpen': return void this.chatOpen(m.project, m.kind, m.session);
			case 'chatPrompt': return void this.chats?.prompt(m.chat, m.text);
			case 'chatCancel': return void this.chats?.cancel(m.chat);
			case 'chatAnswer': return this.chats?.answer(m.chat, m.req, m.option);
			case 'chatSet': return void this.chats?.setOption(m.chat, m.config, m.value);
		}
	}

	private async sendIndex() {
		if (this.chats) {
			this.send({ type: 'chatIndex', projects: await this.chats.projects() });
		}
	}

	/** The open chat in full: its header and its whole transcript, which replaces what the page drew. */
	private sendChat() {
		const chat = this.openChat ? this.chats?.get(this.openChat) : undefined;
		if (!chat || !this.chats) {
			return;
		}
		clearTimeout(this.chatTimer);
		this.chatTimer = undefined;
		this.chatQueue = [];
		const { opened, events } = this.chats.opened(chat);
		this.send(opened);
		this.send({ type: 'chatEvents', chat: opened.chat, reset: true, events });
	}

	private async chatReady() {
		await this.sendIndex();
		this.sendChat();
	}

	private async chatOpen(project: string, kind: 'claude' | 'codex', session: string | undefined) {
		const seq = ++this.openSeq;
		try {
			const chat = await this.chats?.open(project, kind, session);
			if (chat && seq === this.openSeq) {
				this.openChat = chat.id;
				this.sendChat();
				void this.sendIndex();
			}
		} catch (e) {
			// An older open that failed after a newer one began is not what the page waits for.
			if (seq === this.openSeq) {
				this.send({ type: 'chatFailed', project, text: (e as Error).message });
			}
		}
	}

	private chatEvent(chat: string, event: ChatEvent) {
		if (chat !== this.openChat) {
			return;
		}
		appendEvent(this.chatQueue, event);
		this.chatTimer ??= setTimeout(() => {
			this.chatTimer = undefined;
			const events = this.chatQueue;
			this.chatQueue = [];
			if (this.openChat === chat && events.length) {
				this.send({ type: 'chatEvents', chat, events });
			}
		}, 30);
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
