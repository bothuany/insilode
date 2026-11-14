/*---------------------------------------------------------------------------------------------
 *  Insilode: the vscode side of the Agents page's terminals. It feeds the bridge (termBridge.ts) with what agent terminals print
 *  (the terminalDataWriteEvent proposal) and wires its size command, and it starts an agent's terminal for the page, in this window's
 *  folder or, after the usual question (folderTrust.ts), in another project's.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentSession, Agents } from './agents';
import { real, trustFolder } from './folderTrust';
import { TermBridge, type TermAttachment, type TermSink } from './termBridge';

export class TermHost implements vscode.Disposable {
	readonly bridge: TermBridge;
	private readonly subscriptions: vscode.Disposable[];
	/** The terminal each session's output was last taken from, so a closing one is matched to its session after Agents forgot it. */
	private readonly owner = new Map<string, vscode.Terminal>();
	/** Opens in flight, by what they open: a second ask for the same session waits for the first instead of starting a second terminal. */
	private readonly opening = new Map<string, Promise<string>>();

	constructor(private readonly agents: Agents, private readonly context: vscode.ExtensionContext) {
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
					this.owner.has(id) && this.bridge.restart(id);
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
	 * and without taking the focus: the page is where it is shown.
	 */
	open(kind: 'claude' | 'codex', sessionId?: string, cwd?: string): Promise<string> {
		const token = `${kind}|${sessionId ?? ''}|${cwd ?? ''}`;
		let pending = this.opening.get(token);
		if (!pending) {
			pending = this.start(kind, sessionId, cwd).finally(() => this.opening.delete(token));
			// A new session has no id yet: two asks for one are two sessions.
			if (sessionId) {
				this.opening.set(token, pending);
			}
		}
		return pending;
	}

	private async start(kind: 'claude' | 'codex', sessionId: string | undefined, cwd: string | undefined): Promise<string> {
		const known = sessionId ? [...this.agents.sessions.values()].find(s => s.cli === kind && (s.id === sessionId || s.agentId === sessionId)) : undefined;
		if (known && known.state !== 'ended' && this.agents.terminalOf(known.id)) {
			return known.id;
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
		// Codex's session id is the id of the record, as startOrResume (resume.ts) makes it; Claude's too.
		const past: AgentSession | undefined = !sessionId ? undefined : known ?? { id: sessionId, cli: kind, name: '', state: 'ended', since: Date.now(), todos: [], unread: false, agentId: kind === 'codex' ? sessionId : undefined };
		const session = await this.agents.spawn(kind, past, undefined, undefined, { cwd: folder, quiet: true });
		if (!session) {
			throw new Error('The agent did not start (a notice says why).');
		}
		return session.id;
	}
}
