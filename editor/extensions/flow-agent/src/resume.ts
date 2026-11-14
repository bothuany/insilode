/*---------------------------------------------------------------------------------------------
 *  Insilode: starting an agent, new or from the past. Claude keeps every conversation of a folder as a
 *  transcript in ~/.claude/projects/<folder>/<id>.jsonl, Codex in ~/.codex/sessions/<date>/rollout-*.jsonl;
 *  this lists them (newest first, with the name from /rename or the first thing you asked) next to
 *  "New session", and starts `claude --resume <id>` / `codex resume <id>` for the pick.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { projectDir, type Agents, type AgentSession } from './agents';
import { codexHead, codexHome, firstPrompt, newestTitle, rolloutFiles, slice, UUID } from './sessionIndex';

// swap.ts reads Codex's rollouts through these.
export { codexHome, rolloutFiles };

export interface PastSession {
	id: string;
	file: string;
	/** /rename title, if there is one. */
	title?: string;
	/** What the conversation started with. */
	prompt?: string;
	modified: number;
	bytes: number;
}

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;
const MAX_SESSIONS = 60;

/** The folder's Claude conversations, newest first. Empty when Claude has none for it (or the folder cannot be read). */
export async function pastSessions(cwd: string | undefined): Promise<PastSession[]> {
	const dir = projectDir(cwd);
	const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.jsonl') && UUID.test(n.slice(0, -6)));
	const stats = (await Promise.all(names.map(async n => {
		const file = path.join(dir, n);
		const st = await fs.stat(file).catch(() => undefined);
		return st?.isFile() && st.size > 0 ? { id: n.slice(0, -6), file, modified: st.mtimeMs, bytes: st.size } : undefined;
	}))).filter((s): s is NonNullable<typeof s> => !!s).sort((a, b) => b.modified - a.modified).slice(0, MAX_SESSIONS);
	const read = await Promise.all(stats.map(async s => {
		const [head, tail] = await Promise.all([slice(s.file, 'head', HEAD_BYTES).catch(() => []), slice(s.file, 'tail', TAIL_BYTES).catch(() => [])]);
		return { ...s, title: newestTitle(tail) ?? newestTitle(head), prompt: firstPrompt(head) } as PastSession;
	}));
	// A conversation that never got a prompt (opened and closed at once) has nothing to resume.
	return read.filter(s => s.title || s.prompt);
}

/** Codex's sessions of this folder: the session_meta line says which folder, a user_message event says what it was about. */
async function codexSessions(cwd: string | undefined): Promise<PastSession[]> {
	if (!cwd) {
		return [];
	}
	const stats = await Promise.all((await rolloutFiles(path.join(codexHome(), 'sessions'))).map(async file => {
		const st = await fs.stat(file).catch(() => undefined);
		return st && st.size > 0 ? { file, modified: st.mtimeMs, bytes: st.size } : undefined;
	}));
	const files = stats.filter((f): f is NonNullable<typeof f> => !!f);
	const newest = files.sort((a, b) => b.modified - a.modified).slice(0, 200);
	const read = await Promise.all(newest.map(async f => {
		const { id, cwd: where, prompt } = codexHead(await slice(f.file, 'head', 512 * 1024).catch(() => [] as string[]));
		const same = !!where && path.resolve(where) === path.resolve(cwd);
		return same && id && UUID.test(id) && prompt ? { id, file: f.file, prompt, modified: f.modified, bytes: f.bytes } as PastSession : undefined;
	}));
	return read.filter((s): s is PastSession => !!s).slice(0, MAX_SESSIONS);
}

function ago(t: number) {
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
}

const size = (b: number) => b < 1 << 20 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / (1 << 20)).toFixed(1)} MB`;

const NAME = { claude: 'Claude', codex: 'Codex' } as const;

/**
 * The agent's button: a new session, or one of the folder's earlier ones to continue (claude --resume / codex resume).
 * With no earlier session there is nothing to choose, so a new one starts at once. `withNew` false lists only the old ones.
 */
export async function startOrResume(agents: Agents, cli: 'claude' | 'codex', withNew = true) {
	const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const all = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Insilode: reading ${NAME[cli]} sessions` }, () => cli === 'claude' ? pastSessions(cwd) : codexSessions(cwd));
	// A conversation that is running in a terminal now is shown by clicking its row; resuming it a second time would fork it.
	const live = new Set([...agents.sessions.values()].filter(s => s.state !== 'ended').flatMap(s => [s.id, path.basename(s.transcript ?? '', '.jsonl')]));
	const list = all.filter(s => !live.has(s.id));
	if (!list.length) {
		if (withNew) {
			await agents.spawn(cli);
		} else {
			void vscode.window.showInformationMessage(all.length ? `Every ${NAME[cli]} session of this folder is already running.` : `No earlier ${NAME[cli]} sessions for this folder.`);
		}
		return;
	}
	type Item = vscode.QuickPickItem & { session?: PastSession; fresh?: boolean; place?: 'worktree' | 'here' };
	// The other place than the setting's default, one click away: a worktree of its own, or this checkout.
	const inWorktree = vscode.workspace.getConfiguration('flow.agents').get<boolean>('worktree', false);
	const other: Item = inWorktree
		? { label: `$(folder) New ${NAME[cli]} Session in This Checkout`, fresh: true, place: 'here' }
		: { label: `$(git-branch) New ${NAME[cli]} Session in a Worktree`, description: 'its own checkout and branch', fresh: true, place: 'worktree' };
	const items: Item[] = [
		...(withNew ? [{ label: `$(add) New ${NAME[cli]} Session${inWorktree ? ' in a Worktree' : ''}`, fresh: true } as Item, other, { label: 'Resume', kind: vscode.QuickPickItemKind.Separator } as Item] : []),
		...list.map((s): Item => ({
			label: s.title ?? s.prompt!.slice(0, 80),
			description: `${ago(s.modified)} · ${size(s.bytes)}`,
			detail: s.title ? s.prompt : undefined,
			session: s,
		})),
	];
	const pick = await vscode.window.showQuickPick(items, { title: `${NAME[cli]}: New or Resume`, placeHolder: `Start a new session, or pick one to continue (${cli === 'claude' ? 'claude --resume' : 'codex resume'})`, matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true });
	if (!pick) {
		return;
	}
	if (pick.fresh) {
		await agents.spawn(cli, undefined, undefined, pick.place);
		return;
	}
	const s = pick.session!;
	const past: AgentSession = { id: s.id, cli, name: pick.label, state: 'ended', since: s.modified, prompt: s.prompt, todos: [], unread: false, transcript: cli === 'claude' ? s.file : undefined, agentId: cli === 'codex' ? s.id : undefined };
	await agents.spawn(cli, past);
}
