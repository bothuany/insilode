/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents dock. One row per agent terminal: its avatar (working, waiting for you,
 *  done; src/avatars.ts), the prompt it is on, what it is doing this second, its to-do progress and its context.
 *  Whatever needs you rises to the top, so you never hunt for the stuck one.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents } from './agents';
import { attentionKind, rank } from './attention';
import { readAvatar } from './desktopModel';
import { conflictText } from './conflicts';
import { dockAction } from './dockMessage';
import { dockHtml } from './dockPage';
import { savedAgents } from './pick';
import type { WorktreeRows } from './worktreeActions';

export class AgentsDock implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private timer: NodeJS.Timeout | undefined;
	private readonly changes: vscode.Disposable[];

	constructor(private readonly agents: Agents, private readonly worktrees?: WorktreeRows) {
		this.changes = [
			agents.onDidChange(() => this.post()),
			...(worktrees ? [worktrees.onDidChange(() => this.post())] : []),
			vscode.workspace.onDidChangeConfiguration(e => (e.affectsConfiguration('flow.agents.avatar') || e.affectsConfiguration('insilode.skeletonFirst')) && this.post()),
		];
	}

	dispose() {
		clearTimeout(this.timer);
		this.changes.forEach(d => d.dispose());
	}

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = dockHtml();
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
				case 'rename': return void this.rename(m.id);
				case 'swap': return void vscode.commands.executeCommand('flow.agents.swap', m.id);
				case 'wt': return void this.worktrees?.act(m.id, m.action);
				case 'pick': return void vscode.commands.executeCommand('flow.agents.new');
				case 'chat': return void vscode.commands.executeCommand('workbench.action.openSettings', 'flow.agents.showChat');
				case 'sk': return void this.agents.setSkeletonOn(m.id, m.on);
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

	/** The page only names the agent; the new name is asked for here, so the page never decides what a row says. */
	private async rename(id: string) {
		const s = this.agents.sessions.get(id);
		if (!s) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: 'Rename Agent',
			value: s.name,
			prompt: s.cli === 'claude' ? 'Shown in this list and in Claude\'s /resume' : 'Shown in this list',
			validateInput: v => v.trim() ? undefined : 'A name is required',
		});
		if (name !== undefined) {
			await this.agents.rename(id, name);
		}
	}

	/** Coalesces bursts of hook events into one repaint. */
	private post() {
		const n = this.agents.needsYou;
		if (this.view) {
			this.view.badge = n ? { value: n, tooltip: n === 1 ? '1 agent needs you' : `${n} agents need you` } : undefined;
		}
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			const conflicts = this.agents.conflicts();
			const list = rank([...this.agents.sessions.values()])
				.map(s => ({ ...s, attention: attentionKind(s), done: s.todos.filter(t => t.status === 'completed').length, current: s.todos.find(t => t.status === 'in_progress')?.text, explain: this.agents.canExplain(s), impact: s.impact && { files: s.impact.files, more: s.impact.more, flows: s.impact.flows.map(f => ({ label: f.label, via: f.via })), tables: s.impact.tables },
					// Worktree and conflicts are explicit fields: the session's own record (paths, the base branch) stays here.
					worktree: s.worktree ? this.worktrees?.view(s) : undefined,
					skeletonOn: this.agents.skeletonOn(s.id), skeletonAvailable: s.state !== 'ended' && s.cli !== 'custom',
					clash: s.state === 'ended' ? undefined : conflicts.get(s.id)?.map(c => ({ text: conflictText(c), same: c.sameCheckout, files: c.files.slice(0, 12) })) }));
			const avatar = readAvatar(vscode.workspace.getConfiguration('flow.agents').get('avatar'));
			void this.view?.webview.postMessage({ type: 'data', list, now: Date.now(), avatar });
		}, 60);
	}
}
