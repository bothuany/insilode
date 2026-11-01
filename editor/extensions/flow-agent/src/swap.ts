/*---------------------------------------------------------------------------------------------
 *  Insilode: "Continue in Codex" / "Continue in Claude" on an agent's row (the ⇄ in the Agents dock). The conversation
 *  goes along: Claude to Codex through Codex's own importer (`codex app-server`, externalAgentConfig/import), Codex to
 *  Claude as a Claude transcript written from the Codex rollout (swapCore.ts). The new agent starts where the old one
 *  ran (its worktree too) and resumes that conversation; the old conversation is left as it is, and its terminal
 *  closes once the new one has started, so the two never work on the same files at once.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { existsSync, promises as fs, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { projectDir, type Agents, type AgentSession } from './agents';
import { codexCommand, codexLaunch } from './codexHooks';
import { agentProcessEnv } from './env';
import { claudeTranscript, codexImportRequests, codexImportStep, codexRolloutId, codexTurns, MAX_ROLLOUT_BYTES, swappedName } from './swapCore';
import { findOnPath } from './usage';

const NAME = { claude: 'Claude', codex: 'Codex' } as const;

/** The import is local (a few hundred milliseconds); a Codex that has not answered by then is not going to. */
const IMPORT_TIMEOUT_MS = 60_000;

function codexHome() {
	return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/** The rollout of a Codex session: ~/.codex/sessions/<y>/<m>/<d>/rollout-<time>-<id>.jsonl, or the same under archived_sessions. */
async function findRollout(id: string): Promise<string | undefined> {
	const suffix = `-${id}.jsonl`.toLowerCase();
	const walk = async (dir: string, depth: number): Promise<string | undefined> => {
		for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const full = path.join(dir, e.name);
			if (e.isDirectory() && depth < 3) {
				const hit = await walk(full, depth + 1);
				if (hit) {
					return hit;
				}
			} else if (e.isFile() && e.name.startsWith('rollout-') && e.name.toLowerCase().endsWith(suffix) && codexRolloutId(e.name) === id) {
				return full;
			}
		}
		return undefined;
	};
	return await walk(path.join(codexHome(), 'sessions'), 0) ?? await walk(path.join(codexHome(), 'archived_sessions'), 0);
}

/** Runs Codex's importer on a Claude transcript and returns the id of the Codex thread it made. */
function importIntoCodex(transcript: string, cwd: string, title: string | undefined): Promise<string> {
	const launch = codexLaunch(process.platform, process.env.PATH ?? '', process.env.PATHEXT, {
		exists: existsSync,
		read: file => {
			try {
				return readFileSync(file, 'utf8');
			} catch {
				return undefined;
			}
		},
	});
	if (!launch) {
		return Promise.reject(new Error('no `codex` program was found on PATH'));
	}
	const run = codexCommand(launch, ['app-server'], 'script' in launch && !launch.node ? findOnPath('node') : undefined, process.execPath, !!process.versions.electron, process.env.ComSpec || 'cmd.exe');
	if (!run) {
		return Promise.reject(new Error(`${'batch' in launch ? launch.batch : 'codex'} cannot be started safely`));
	}
	return new Promise((resolve, reject) => {
		// No shell, no window; stdin carries the JSON-RPC requests, stdout its answers, one per line.
		const child = spawn(run.file, run.argv, { cwd, windowsHide: true, windowsVerbatimArguments: run.verbatim, stdio: ['pipe', 'pipe', 'pipe'], env: agentProcessEnv(run.electronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) });
		let out = '';
		let err = '';
		let settled = false;
		const finish = (fn: () => void) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				// Through cmd.exe (a batch wrapper) the child is cmd.exe: kill(), which ends only it, would leave codex
				// running, so the whole tree goes.
				if (run.verbatim && process.platform === 'win32' && child.pid) {
					spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
				} else {
					child.kill();
				}
				fn();
			}
		};
		const timer = setTimeout(() => finish(() => reject(new Error('Codex did not finish the import within a minute'))), IMPORT_TIMEOUT_MS);
		child.on('error', e => finish(() => reject(e)));
		// A codex that exits before it reads its input makes the write fail (EPIPE): an error of the import, not of the editor.
		child.stdin.on('error', e => finish(() => reject(e)));
		child.on('close', code => finish(() => reject(new Error(`codex app-server exited (${code})${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`))));
		child.stderr.on('data', (d: Buffer) => {
			err = (err + d.toString()).slice(-4000);
		});
		child.stdout.on('data', (d: Buffer) => {
			out += d.toString();
			let n: number;
			while ((n = out.indexOf('\n')) >= 0) {
				const step = codexImportStep(out.slice(0, n));
				out = out.slice(n + 1);
				if ('thread' in step) {
					finish(() => resolve(step.thread));
				} else if ('error' in step) {
					finish(() => reject(new Error(step.error)));
				}
			}
		});
		child.stdin.write(codexImportRequests(transcript, cwd, title).join('\n') + '\n');
	});
}

/** Writes the Codex session's conversation as a new Claude transcript of that folder; returns its id and file. */
async function claudeFromCodex(s: AgentSession, cwd: string): Promise<{ id: string; file: string }> {
	if (!s.agentId) {
		throw new Error(`${s.name} has not told Insilode its Codex session id yet (it comes with its first hook event)`);
	}
	const rollout = await findRollout(s.agentId);
	if (!rollout) {
		throw new Error(`the Codex session ${s.agentId} was not found under ${path.join(codexHome(), 'sessions')}`);
	}
	const st = await fs.stat(rollout);
	if (st.size > MAX_ROLLOUT_BYTES) {
		throw new Error(`the Codex session is ${Math.round(st.size / (1 << 20))} MB, more than Insilode moves (${MAX_ROLLOUT_BYTES >> 20} MB)`);
	}
	const id = randomUUID();
	const text = claudeTranscript(codexTurns(await fs.readFile(rollout, 'utf8')), {
		cwd, sessionId: id, gitBranch: s.worktree?.branch, title: s.name, newId: randomUUID, now: new Date().toISOString(),
	});
	if (!text) {
		throw new Error('the Codex session has no exchange to carry over yet: send it a message first');
	}
	const dir = projectDir(cwd);
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `${id}.jsonl`);
	// 'wx': a new file, never one that exists (the id is fresh, so it never should).
	await fs.writeFile(file, text, { flag: 'wx', mode: 0o600 });
	return { id, file };
}

/** Continues agent `id` in the other CLI, with its conversation. */
export async function swapAgent(agents: Agents, id: unknown): Promise<void> {
	const s = typeof id === 'string' ? agents.sessions.get(id) : undefined;
	if (!s || (s.cli !== 'claude' && s.cli !== 'codex')) {
		return;
	}
	const to = s.cli === 'claude' ? 'codex' : 'claude';
	if (s.state === 'working' || s.state === 'blocked' || s.state === 'starting') {
		void vscode.window.showInformationMessage(`Insilode: ${s.name} is in the middle of a turn. Move it to ${NAME[to]} once the turn has ended, so the whole of it goes along.`);
		return;
	}
	const cwd = s.cwd ?? s.worktree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!cwd) {
		return;
	}
	// What would stop the new agent from starting is checked before anything is imported or written, so a refusal
	// leaves no Codex thread or Claude transcript behind.
	if (!vscode.workspace.isTrusted) {
		void vscode.window.showWarningMessage('Agents run commands in your workspace: trust this folder to start one.');
		return;
	}
	if (s.worktree && !existsSync(s.worktree.path)) {
		void vscode.window.showErrorMessage(`Insilode: the worktree of ${s.name} (${s.worktree.path}) is gone; the conversation cannot continue there.`);
		return;
	}
	if (s.state !== 'ended') {
		const go = `Continue in ${NAME[to]}`;
		const pick = await vscode.window.showInformationMessage(
			`Continue ${s.name}'s conversation in ${NAME[to]}?`,
			{ modal: true, detail: `${NAME[to]} starts in the same folder with what was said so far (the messages, not ${NAME[s.cli]}'s tool output). ${s.name}'s terminal closes once ${NAME[to]} is up; its conversation is kept, so you can come back to it.` },
			go,
		);
		if (pick !== go) {
			return;
		}
	}
	let past: AgentSession;
	try {
		past = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Insilode: moving ${s.name} to ${NAME[to]}` }, async (): Promise<AgentSession> => {
			const base: Omit<AgentSession, 'id'> = { cli: to, name: swappedName(s.name, NAME[to]), state: 'ended' as const, since: Date.now(), prompt: s.prompt, todos: [], unread: false, worktree: s.worktree };
			if (to === 'codex') {
				if (!s.transcript || !existsSync(s.transcript)) {
					throw new Error(`${s.name}'s transcript was not found: it has nothing to carry over yet`);
				}
				const thread = await importIntoCodex(s.transcript, cwd, s.name);
				return { ...base, id: thread, agentId: thread };
			}
			const made = await claudeFromCodex(s, cwd);
			return { ...base, id: made.id, transcript: made.file };
		});
	} catch (e) {
		void vscode.window.showErrorMessage(`Insilode: could not move ${s.name} to ${NAME[to]}: ${(e as Error).message}`);
		return;
	}
	// The old agent may have started a turn while the dialog was open or the import ran (a queued prompt, PR news): then
	// the new one has not got that turn, and closing the terminal would cut it off. Nothing has started yet; say so.
	const now = agents.sessions.get(s.id)?.state;
	if (now === 'working' || now === 'blocked') {
		void vscode.window.showWarningMessage(`Insilode: ${s.name} started a new turn while it was being moved, so ${NAME[to]} was not started. Move it again once the turn has ended.`);
		return;
	}
	const wasLive = s.state !== 'ended';
	const started = await agents.spawn(to, past);
	if (started && wasLive) {
		agents.closeTerminal(s.id);
	}
}
