/*---------------------------------------------------------------------------------------------
 *  Insilode: the vscode side of the Agents page's terminals. It feeds the bridge (termBridge.ts) with what agent terminals print
 *  (the terminalDataWriteEvent proposal) and wires its size command, and it starts an agent's terminal for the page, in this window's
 *  folder or, after the usual question (folderTrust.ts), in another project's.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentSession, Agents } from './agents';
import { real, trustFolder } from './folderTrust';
import { confirmResumeAnyway } from './resumeAnyway';
import { elsewhereMessage } from './spawnGuard';
import { TermBridge, type TermAttachment, type TermSink } from './termBridge';

/** A session another process runs is not started a second time: the page may offer "Resume anyway" for this one (a `termOpen` with `force`). */
export class ElsewhereError extends Error {
	readonly elsewhere = true;
}

export class TermHost implements vscode.Disposable {
	readonly bridge: TermBridge;
	private readonly subscriptions: vscode.Disposable[];
	/** The terminal each session's output was last taken from, so a closing one is matched to its session after Agents forgot it. */
	private readonly owner = new Map<string, vscode.Terminal>();
	/** Opens in flight, by what they open: a second ask for the same session waits for the first instead of starting a second terminal. */
	private readonly opening = new Map<string, Promise<string>>();

	/** `live`: what runs a Claude session outside this window ("Claude desktop"), nothing when none does (liveSessions.ts); it asks the machine now, not the page's last list. */
	constructor(private readonly agents: Agents, private readonly context: vscode.ExtensionContext, private readonly live?: (sessionId: string) => Promise<string | undefined>) {
		this.bridge = new TermBridge({
			terminalOf: id => agents.terminalOf(id),
			typable: id => agents.sessions.get(id)?.state !== 'ended',
			setDimensions: (pid, cols, rows) => vscode.commands.executeCommand('_insilode.terminal.setDimensions', pid, cols, rows),
		});
		this.subscriptions = [
			vscode.window.onDidWriteTerminalData(e => {
				const id = agents.sessionOf(e.terminal);
				if (!id) {
					return;
				}
				if (this.owner.get(id) !== e.terminal) {
					// The old terminal goes along: it may still hold the pane's size, and the bridge hands that to the new one.
					this.owner.has(id) && this.bridge.restart(id, this.owner.get(id));
					this.owner.set(id, e.terminal);
				}
				this.bridge.write(id, e.data);
			}),
			vscode.window.onDidCloseTerminal(t => {
				for (const [id, term] of this.owner) {
					// Another terminal may have taken the session over since (a resumed agent): that one is still open.
					if (term === t) {
						this.owner.delete(id);
						if (!agents.terminalOf(id)) {
							this.bridge.end(id);
						}
					}
				}
			}),
		];
	}

	/** What the Agents panel calls (agentsPanel.ts); the bridge itself is tested on its own. */
	attach(id: string, sink: TermSink): TermAttachment | undefined {
		// A terminal that never printed is still matched to its session when it closes.
		const t = this.agents.terminalOf(id);
		if (t && !this.owner.has(id)) {
			this.owner.set(id, t);
		}
		return this.bridge.attach(id, sink);
	}

	input(id: string, data: string): boolean {
		return this.bridge.input(id, data);
	}

	resize(id: string, cols: number, rows: number): Promise<boolean> {
		return this.bridge.resize(id, cols, rows);
	}

	dispose(): void {
		this.subscriptions.forEach(d => d.dispose());
		this.bridge.dispose();
	}

	/**
	 * An agent's terminal for the page: the session already running in this window, or a new terminal that starts (`sessionId`: resumes) the CLI
	 * in `cwd` or this window's folder. Returns the session id; throws the sentence the page shows. The terminal is created hidden
	 * and without taking the focus: the page is where it is shown. `force` (the page's "Resume anyway") is only a request: when something does
	 * run the session, the user is asked in a modal of this host, and only a yes goes on (the page cannot skip that).
	 */
	open(kind: 'claude' | 'codex', sessionId?: string, cwd?: string, force?: boolean): Promise<string> {
		const token = `${kind}|${sessionId ?? ''}|${cwd ?? ''}|${force ? 'force' : ''}`;
		let pending = this.opening.get(token);
		if (!pending) {
			pending = this.start(kind, sessionId, cwd, force).finally(() => this.opening.delete(token));
			// A new session has no id yet: two asks for one are two sessions.
			if (sessionId) {
				this.opening.set(token, pending);
			}
		}
		return pending;
	}

	private async start(kind: 'claude' | 'codex', sessionId: string | undefined, cwd: string | undefined, force?: boolean): Promise<string> {
		const owners = sessionId ? [...this.agents.sessions.values()].filter(s => s.id === sessionId || s.agentId === sessionId) : [];
		const known = owners.find(s => s.cli === kind);
		const foreign = owners.find(s => s.cli !== kind);
		// Spawning over another CLI's session would replace its row and leave its terminal running untracked, its events landing on this one.
		if (!known && foreign) {
			throw new Error(`Not started: that session id belongs to a ${foreign.cli === 'claude' ? 'Claude' : foreign.cli === 'codex' ? 'Codex' : 'custom agent'} session in this window.`);
		}
		if (known && known.state !== 'ended' && this.agents.terminalOf(known.id)) {
			return known.id;
		}
		// Two processes on one conversation corrupt it: a session another program runs is only read here, unless the user, asked by this
		// host, resumes it anyway (a stale registry entry looks the same). A confirmed one is not asked of the registry again.
		const elsewhere = () => kind === 'claude' && sessionId ? this.live?.(sessionId) : undefined;
		const refuse = (where: string | undefined) => {
			if (where) {
				throw new ElsewhereError(elsewhereMessage(known?.name ?? '', { source: where }));
			}
		};
		let confirmed = false;
		if (force) {
			const where = await elsewhere();
			confirmed = !!where && await confirmResumeAnyway(known?.name ?? '', { source: where });
			if (!confirmed) {
				refuse(where);
			}
		} else {
			refuse(await elsewhere());
		}
		let folder: string | undefined;
		if (cwd !== undefined) {
			const { where } = await trustFolder(this.context, cwd);
			// Spawned as written (Claude finds a transcript by the folder's spelling), so check that the folder the user saw is still that one.
			if (await real(cwd) !== where) {
				throw new Error('Not started: the folder changed while it was being opened.');
			}
			folder = cwd;
		}
		// The question for a folder can stay open for a long time, and the session may have been started elsewhere meanwhile.
		if (!confirmed) {
			refuse(await elsewhere());
		}
		// Codex's session id is the id of the record, as startOrResume (resume.ts) makes it; Claude's too.
		const past: AgentSession | undefined = !sessionId ? undefined : known ?? { id: sessionId, cli: kind, name: '', state: 'ended', since: Date.now(), todos: [], unread: false, agentId: kind === 'codex' ? sessionId : undefined };
		const session = await this.agents.spawn(kind, past, undefined, undefined, { cwd: folder, quiet: true, ...(confirmed ? { confirmed } : {}) });
		if (!session) {
			throw new Error('The agent did not start (a notice says why).');
		}
		return session.id;
	}
}
