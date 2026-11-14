/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents dock. One row per agent terminal: its avatar (working, waiting for you,
 *  done; src/avatars.ts), the prompt it is on, what it is doing this second, its to-do progress and its context.
 *  Whatever needs you rises to the top, so you never hunt for the stuck one.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import type { Agents } from './agents';
import { buildRows, skeletonStages } from './agentRows';
import { readAvatar } from './desktopModel';
import { bypassAllowed, BYPASS_SETTING } from './bypass';
import { dockAction, type StartHow } from './dockMessage';
import { dockHtml } from './dockPage';
import { renameFromPalette } from './paletteActions';
import type { Peers } from './peers';
import { savedAgents } from './pick';
import { startOrResume } from './resume';
import type { WorktreeRows } from './worktreeActions';

export class AgentsDock implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private timer: NodeJS.Timeout | undefined;
	/** A repaint waits for flow-view's answers; one that a newer repaint overtook while waiting is dropped, so the older data never lands last. */
	private paint = 0;
	private readonly changes: vscode.Disposable[];

	constructor(private readonly agents: Agents, private readonly worktrees?: WorktreeRows, private readonly peers?: Peers) {
		this.changes = [
			agents.onDidChange(() => this.post()),
			...(peers ? [peers.onDidChange(() => this.post())] : []),
			...(worktrees ? [worktrees.onDidChange(() => this.post())] : []),
			vscode.workspace.onDidChangeConfiguration(e => (e.affectsConfiguration('flow.agents.avatar') || e.affectsConfiguration('insilode.skeletonFirst') || e.affectsConfiguration(BYPASS_SETTING)) && this.post()),
		];
	}

	dispose() {
		clearTimeout(this.timer);
		this.changes.forEach(d => d.dispose());
	}

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = dockHtml(randomBytes(16).toString('base64'));
		// The page is not trusted: dockAction checks each message's shape and turns it into one known action, or nothing.
		view.webview.onDidReceiveMessage(raw => {
			const m = dockAction(raw);
			switch (m?.type) {
				case 'ready': return this.post();
				// The button offers a new session or one of the earlier ones to resume.
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
				// The same box the palette's Rename Agent opens (paletteActions.ts): the page only names the row.
				case 'rename': return void renameFromPalette(this.agents, m.id);
				case 'swap': return void vscode.commands.executeCommand('flow.agents.swap', m.id);
				case 'wt': return void this.worktrees?.act(m.id, m.action);
				// The chevron menu: one fixed command per pair, so the page never names a command id.
				case 'start': return void this.start(m.cli, m.how);
				case 'pick': return void vscode.commands.executeCommand('flow.agents.new');
				case 'chat': return void vscode.commands.executeCommand('flow.settings', 'flow.agents.showChat');
				case 'sk': return void this.agents.setSkeletonOn(m.id, m.on);
				case 'peer': return void this.peers?.act(m.action, m.key, m.id);
			}
		});
		view.onDidChangeVisibility(() => view.visible && this.post());
		view.onDidDispose(() => {
			if (this.view === view) {
				this.view = undefined;
				clearTimeout(this.timer);
			}
		});
	}

	/** "In a worktree", "Resume a session…" and Claude's bypass switch of a start button's menu. */
	private start(cli: 'claude' | 'codex', how: StartHow) {
		if (how === 'bypass') {
			return vscode.commands.executeCommand('flow.agents.claudeBypass');
		}
		if (how === 'worktree') {
			return cli === 'claude' ? vscode.commands.executeCommand('flow.agents.newClaudeWorktree') : vscode.commands.executeCommand('flow.agents.newCodexWorktree');
		}
		// Claude's resume is its own command; Codex's goes through the same list the button shows, without the "new session" rows.
		return cli === 'claude' ? vscode.commands.executeCommand('flow.agents.resume') : startOrResume(this.agents, 'codex', false);
	}

	/** Coalesces bursts of hook events into one repaint. */
	private post() {
		const n = this.agents.needsYou;
		if (this.view) {
			this.view.badge = n ? { value: n, tooltip: n === 1 ? '1 agent needs you' : `${n} agents need you` } : undefined;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(async () => {
			const mine = ++this.paint;
			const stages = await skeletonStages(this.agents);
			if (mine !== this.paint) {
				return;
			}
			const list = buildRows(this.agents, this.worktrees, stages, savedAgents());
			const avatar = readAvatar(vscode.workspace.getConfiguration('flow.agents').get('avatar'));
			void this.view?.webview.postMessage({ type: 'data', list, now: Date.now(), avatar, peers: this.peers?.view().peers ?? [], bypass: bypassAllowed() });
		}, 60);
	}
}
