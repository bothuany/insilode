/*---------------------------------------------------------------------------------------------
 *  Insilode: the Claude Code sessions that run on this machine right now, wherever they were started (a terminal app, the Claude desktop
 *  app, another editor). Claude Code writes one file per running process, <config dir>/sessions/<pid>.json, and removes it on exit; this
 *  reads those files (only the fields named below: the `.key` files and the tokens and socket paths beside them are never read) and
 *  works out which of them are alive. Codex keeps no such registry, so for Codex the index's rollout times are all there is: a session
 *  whose rollout changed in the last two minutes is "recently active", an estimate that the page labels as one.
 *
 *  Everything here is untrusted input from the file system (any program may write there), so every field is type-checked. No vscode:
 *  the file system and the liveness check are injected and it is tested on its own (test/liveSessions.test.mjs). A pid that was reused
 *  by another process after Claude died without cleaning up looks alive: its file carries `procStart`, but comparing that needs
 *  a `ps` per entry or per-OS /proc arithmetic, so it is not compared (shortcut: a crashed session's stale file shows until its pid is gone or the file is).
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatProject, LiveMark, LiveStatus } from './agentsData';
import { samePath } from './chatCore';

export interface LiveSession {
	/** Claude's session id (a uuid). */
	id: string;
	cwd: string;
	pid: number;
	status: LiveStatus;
	/** What runs it, as the file says: "Claude Code CLI", "Claude desktop". */
	source: string;
	name?: string;
	startedAt?: number;
	updatedAt?: number;
}

export interface LiveIo {
	readdir(dir: string): Promise<string[]>;
	/** Not following links: a link is not a regular file. */
	lstat(file: string): Promise<{ isFile(): boolean; size: number }>;
	/** At most `max` bytes. */
	read(file: string, max: number): Promise<string>;
	isAlive(pid: number): boolean;
}

/** One file is a few hundred bytes; anything bigger is not one of Claude's. */
export const MAX_FILE_BYTES = 64 * 1024;
export const MAX_FILES = 200;
/** A Codex rollout that changed this recently counts as recently active. */
export const RECENT_MS = 2 * 60 * 1000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^(\d{1,10})\.json$/;
const WORD = /^[A-Za-z0-9._-]{1,32}$/;

/** Claude's own folder: CLAUDE_CONFIG_DIR, or ~/.claude. */
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
export const claudeSessionsDir = () => path.join(claudeHome(), 'sessions');

/** Where Claude Code keeps a session's transcript (agents.ts projectDir, which cannot be imported here: it reaches vscode). */
export const claudeTranscript = (id: string, cwd: string) => path.join(claudeHome(), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);

/**
 * `status` as Claude writes it: "busy" while a turn runs, "idle" when it waits for the next prompt and "waiting" when it needs the user
 * (a permission or an answer). On this machine only idle and busy were seen in files; "waiting" is what the CLI's own code writes. Anything else is unknown.
 */
export function statusOf(v: unknown): LiveStatus {
	return v === 'busy' ? 'working' : v === 'waiting' ? 'needs' : v === 'idle' ? 'idle' : 'unknown';
}

/** Said as far as the file tells: `entrypoint` "cli" and "claude-desktop" are known; another plain word is shown as it is. A kind other than "interactive" is added. */
export function sourceOf(entrypoint: unknown, kind: unknown): string {
	const base = entrypoint === 'cli' ? 'Claude Code CLI' : entrypoint === 'claude-desktop' ? 'Claude desktop' : typeof entrypoint === 'string' && WORD.test(entrypoint) ? `Claude Code (${entrypoint})` : 'Claude Code';
	return typeof kind === 'string' && kind !== 'interactive' && WORD.test(kind) ? `${base}, ${kind}` : base;
}

const finite = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/** One file's text and name to a session; nothing when it is not a well-formed one. Pure. */
export function parseLive(text: string, fileName: string): LiveSession | undefined {
	const named = FILE_NAME.exec(fileName);
	if (!named) {
		return undefined;
	}
	let j: Record<string, unknown>;
	try {
		const v = JSON.parse(text) as unknown;
		if (!v || typeof v !== 'object' || Array.isArray(v)) {
			return undefined;
		}
		j = v as Record<string, unknown>;
	} catch {
		return undefined;
	}
	const pid = j.pid;
	const { sessionId, cwd } = j;
	// The file's own name and the pid in it agree, or it is not what Claude wrote.
	if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || pid !== Number(named[1])
		|| typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)
		|| typeof cwd !== 'string' || cwd.length > 1024 || cwd.includes('\0') || !path.isAbsolute(cwd)) {
		return undefined;
	}
	const name = typeof j.name === 'string' ? j.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 120) : '';
	return {
		id: sessionId.toLowerCase(), cwd, pid, status: statusOf(j.status), source: sourceOf(j.entrypoint, j.kind),
		...(name ? { name } : {}), startedAt: finite(j.startedAt), updatedAt: finite(j.statusUpdatedAt) ?? finite(j.updatedAt),
	};
}

/** The real thing: node's fs, and `kill(pid, 0)` (no signal is sent; EPERM means the process exists but is another user's). */
export const nodeIo: LiveIo = {
	readdir: dir => fs.readdir(dir),
	lstat: file => fs.lstat(file),
	read: async (file, max) => {
		const h = await fs.open(file, 'r');
		try {
			const buf = Buffer.alloc(max);
			const { bytesRead } = await h.read(buf, 0, max, 0);
			return buf.toString('utf8', 0, bytesRead);
		} finally {
			await h.close();
		}
	},
	isAlive: pid => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return (e as NodeJS.ErrnoException).code === 'EPERM';
		}
	},
};

/** The live sessions, newest activity first; one per session id. Never throws: no folder, an unreadable or garbled file is skipped. */
export async function listLive(io: LiveIo = nodeIo, dir = claudeSessionsDir()): Promise<LiveSession[]> {
	const names = (await io.readdir(dir).catch(() => [] as string[])).filter(n => FILE_NAME.test(n)).sort((a, b) => parseInt(b) - parseInt(a)).slice(0, MAX_FILES);
	const found = await Promise.all(names.map(async name => {
		try {
			const file = path.join(dir, name);
			const st = await io.lstat(file);
			if (!st.isFile() || st.size > MAX_FILE_BYTES) {
				return undefined;
			}
			const s = parseLive(await io.read(file, MAX_FILE_BYTES), name);
			return s && io.isAlive(s.pid) ? s : undefined;
		} catch {
			return undefined;
		}
	}));
	const byId = new Map<string, LiveSession>();
	for (const s of found) {
		const old = s && byId.get(s.id);
		if (s && (!old || (s.updatedAt ?? 0) > (old.updatedAt ?? 0))) {
			byId.set(s.id, s);
		}
	}
	return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export interface MergeOptions {
	/** Sessions that are not "elsewhere": this window's and the other Insilode windows' (they are listed as agents). */
	skip: ReadonlySet<string>;
	/** The real path of a folder, so two spellings of one folder are one project. */
	realOf(cwd: string): string;
	/** The key, name and shortened path of a folder no project lists yet. */
	describe(cwd: string): { key: string; name: string; where: string };
	now: number;
}

/**
 * The sidebar's projects with what runs outside this window marked on them: a Claude session some process runs (listed in the project
 * of its folder, or in a project of its own when none lists the folder), and a Codex session whose rollout changed in the last two
 * minutes. Marked sessions come first in their project, and projects with one come first after this window's own. `files`
 * names the transcript of each live Claude session, for the host (never sent to the page). Inputs are not changed.
 */
export function mergeLive(projects: ChatProject[], live: LiveSession[], o: MergeOptions): { projects: ChatProject[]; files: Map<string, string> } {
	const out = projects.map(p => ({ ...p, sessions: [...p.sessions] }));
	const files = new Map<string, string>();
	const marked = new Set<ChatProject>();
	for (const l of live) {
		if (o.skip.has(l.id)) {
			continue;
		}
		files.set(l.id, claudeTranscript(l.id, l.cwd));
		const mark: LiveMark = { status: l.status, source: l.source, basis: 'live' };
		const home = out.find(p => p.sessions.some(s => s.kind === 'claude' && s.id === l.id));
		if (home) {
			home.sessions = home.sessions.map(s => s.kind === 'claude' && s.id === l.id ? { ...s, live: mark } : s);
			marked.add(home);
			continue;
		}
		const where = o.realOf(l.cwd);
		let into = out.find(p => samePath(o.realOf(p.cwd), where));
		if (!into) {
			into = { ...o.describe(l.cwd), cwd: l.cwd, own: false, sessions: [] };
			out.push(into);
		}
		into.sessions.push({ id: l.id, kind: 'claude', title: l.name || 'Untitled session', modified: l.updatedAt ?? l.startedAt ?? o.now, live: mark });
		marked.add(into);
	}
	for (const p of out) {
		p.sessions = p.sessions.map(s => {
			if (s.kind !== 'codex' || s.live || o.skip.has(s.id) || o.now - s.modified > RECENT_MS || s.modified > o.now + RECENT_MS) {
				return s;
			}
			marked.add(p);
			return { ...s, live: { status: 'unknown', source: 'Codex', basis: 'recent' } satisfies LiveMark };
		});
		// Stable: marked sessions first, each group in the order it had (newest first).
		p.sessions = [...p.sessions.filter(s => s.live), ...p.sessions.filter(s => !s.live)];
	}
	const rank = (p: ChatProject) => p.own ? 0 : marked.has(p) ? 1 : 2;
	return { projects: out.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || a.i - b.i).map(x => x.p), files };
}
