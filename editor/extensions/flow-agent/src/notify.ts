/*---------------------------------------------------------------------------------------------
 *  Insilode: tells you when an agent starts needing you while you look elsewhere. A VS Code
 *  notification (which the OS shows as well when the window is in the background, if VS Code is
 *  set up to), with a button that brings the agent's terminal up. Nothing here takes focus by
 *  itself: only the button does, when you press it.
 *
 *  "Elsewhere" means the window is not focused, or the agent's terminal is not the active one. VS
 *  Code does not say whether the terminal panel itself is open, so an active terminal in a closed
 *  panel counts as seen.
 *
 *  Digest: while the window is not focused and flow.agents.notify.digestMinutes is above 0, finished turns and errors
 *  are counted into one notification: the first shows at once and starts a timer, what follows is held back until it
 *  fires. Approvals and questions are never held: an agent waiting for you must not wait minutes for you to hear of it.
 *  When the window gets focus again the digest is dropped: the user is back and the dock shows everything.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents } from './agents';
import { attentionKey, attentionKind, digestMessage, notification, type DigestEntry } from './attention';

export class AttentionNotifier implements vscode.Disposable {
	/** The attention each session was last notified (or seen) for, so a repeated hook is not news. */
	private readonly last = new Map<string, string | undefined>();
	private readonly sub: vscode.Disposable;
	private readonly focusSub: vscode.Disposable;
	private held: DigestEntry[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(private readonly agents: Agents) {
		this.sub = agents.onDidChange(() => this.check());
		this.focusSub = vscode.window.onDidChangeWindowState(w => w.focused && this.dropDigest());
	}

	dispose() {
		this.sub.dispose();
		this.focusSub.dispose();
		this.dropDigest();
	}

	private dropDigest() {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.held = [];
	}

	private flushDigest() {
		const message = digestMessage(this.held);
		this.dropDigest();
		if (message && !vscode.window.state.focused) {
			void vscode.window.showInformationMessage(message, 'Show Agents').then(pick => pick && vscode.commands.executeCommand('workbench.view.extension.flowAgents'));
		}
	}

	private check() {
		const config = vscode.workspace.getConfiguration('flow.agents.notify');
		for (const s of this.agents.sessions.values()) {
			const key = attentionKey(s);
			if (this.last.get(s.id) === key) {
				continue;
			}
			this.last.set(s.id, key);
			const n = notification(s, { quiet: config.get<boolean>('quiet', false), enabled: k => config.get<boolean>(k, true), watched: this.agents.isWatched(s.id) });
			if (!n) {
				continue;
			}
			const minutes = config.get<number>('digestMinutes', 5);
			const kind = attentionKind(s);
			if (!vscode.window.state.focused && minutes > 0 && (kind === 'done' || kind === 'error')) {
				if (this.timer) {
					this.held.push({ session: s.id, kind });
					continue;
				}
				this.timer = setTimeout(() => this.flushDigest(), minutes * 60_000);
			}
			const show = n.warn ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
			// A notification VS Code shows cannot be taken back, so one for a question answered meanwhile stays in the list;
			// its button then still brings the terminal up, which is harmless.
			void show(n.message, 'Show Terminal').then(pick => pick && this.agents.show(s.id));
		}
		for (const id of this.last.keys()) {
			if (!this.agents.sessions.has(id)) {
				this.last.delete(id);
			}
		}
	}
}
