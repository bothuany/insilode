/*---------------------------------------------------------------------------------------------
 *  Insilode: the Claude Code sessions that run on this machine right now, wherever they were started (a terminal app, the Claude desktop
 *  app, another editor). Claude Code writes one file per running process, <config dir>/sessions/<pid>.json, and removes it on exit; this
 *  reads those files (only the fields named below: the `.key` files and the tokens and socket paths beside them are never read) and
 *  works out which of them are alive. Codex keeps no such registry, so for Codex the index's rollout times are all there is: a session
 *  whose rollout changed in the last two minutes is "recently active", an estimate that the page labels as one.
 *
 *  Everything here is untrusted input from the file system (any program may write there), so every field is type-checked. No vscode:
 *  the file system and the liveness check are injected and it is tested on its own (test/liveSessions.test.mjs). A pid that was reused
 *  by another process after Claude died without cleaning up looks alive to the poll (shortcut: a crashed session's stale file shows there until
 *  its pid is gone or the file is, because telling costs a `ps` per entry). The resume check does tell: `runningElsewhere` asks for the one
 *  process's start time and drops an entry whose process started after the entry says it was written.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatProject, LiveMark, LiveStatus } from './agentsData';
import { Budgeted } from './budgeted';
import { samePath } from './chatCore';
import { openRegular } from './safeFile';

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
	lstat(file: string): Promise<{ isFile(): boolean; size: number; mtimeMs: number }>;
	/** At most `max` bytes; rejects, without waiting, for anything but a regular file of at most that size (safeFile.ts). */
	read(file: string, max: number): Promise<string>;
	isAlive(pid: number): boolean;
	/** When the process with this pid started (epoch ms), nothing when that is not known. Only the resume check asks, never the poll. */
	startTime?(pid: number): Promise<number | undefined>;
}

/** One file is a few hundred bytes; anything bigger is not one of Claude's. */
export const MAX_FILE_BYTES = 64 * 1024;
/** How many sessions `listLive` returns; the cap is applied to what is alive, never to the files before that is known. */
export const MAX_FILES = 200;
/** How many file names of the registry are looked at: a folder with more is not Claude's (a pid is looked up from the name, which costs a syscall each). */
const MAX_NAMES = 5000;
/** `listLive` returns what it has by then, like `scan()` in sessionIndex.ts: a registry on a hung mount must not hold the page's poll up. */
export const LIST_MS = 2000;
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

/**
 * `kill(pid, 0)` sends no signal. EPERM means the process exists but may not be opened: on Windows that is Claude started from an elevated
 * terminal (this user's own, so alive); elsewhere it is another user's process, and the registry is in this user's home, so such a pid is a
 * reused number and not alive for this purpose. Pure: the signal function and the platform are passed in.
 */
export function isAliveWith(pid: number, kill: (pid: number, signal: 0) => unknown, platform: NodeJS.Platform = process.platform): boolean {
	try {
		kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM' && platform === 'win32';
	}
}

/** `ps -o lstart=` prints local time as "Sat Nov 14 00:34:24 2026" (a one-digit day is padded with a space); nothing for anything else. */
export function parsePsStart(out: string): number | undefined {
	const t = Date.parse(out.trim().replace(/\s+/g, ' '));
	return Number.isFinite(t) ? t : undefined;
}

/** Clock and rounding slack: the process cannot have started after the entry was written, give or take this. */
const START_SLACK_MS = 5000;

/**
 * Whether the process that has this pid now cannot be the one that wrote the entry: it started after the entry's `startedAt`, so the pid was
 * reused (the entry's own process had to exist before it wrote). Anything unclear (no `startedAt`, no start time) is not reused: two
 * processes on one session corrupt it, so a doubt means "still running". (The file's `procStart` is a local-time string in the writer's own
 * time zone, which this process may not share; `startedAt` is an epoch and has no such trap.)
 */
export function pidReused(startedAt: number | undefined, processStart: number | undefined): boolean {
	return startedAt !== undefined && processStart !== undefined && Number.isFinite(processStart) && processStart > startedAt + START_SLACK_MS;
}

/**
 * The real thing: node's fs, and `kill(pid, 0)`.
 */
export const nodeIo: LiveIo = {
	readdir: dir => fs.readdir(dir),
	lstat: file => fs.lstat(file),
	read: async (file, max) => {
		// Sized by the file (a few hundred bytes), not by `max`: this runs for every file on every poll.
		const { handle, size } = await openRegular(file, max);
		try {
			const buf = Buffer.alloc(size);
			const { bytesRead } = await handle.read(buf, 0, size, 0);
			return buf.toString('utf8', 0, bytesRead);
		} finally {
			await handle.close();
		}
	},
	isAlive: pid => isAliveWith(pid, (p, sig) => process.kill(p, sig)),
	// One ps through an argument array (no shell) with a short timeout, C locale for English names. Windows has no ps: the check is skipped there.
	startTime: pid => process.platform === 'win32' ? Promise.resolve(undefined) : new Promise(resolve => {
		execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 1500, windowsHide: true, env: { ...process.env, LC_ALL: 'C' } }, (err, out) => resolve(err ? undefined : parsePsStart(out)));
	}),
};

/** Per registry folder (and io): whether an earlier scan's file work is still stuck, and what it last found (budgeted.ts). */
const scans = new WeakMap<LiveIo, Map<string, Budgeted<LiveSession[], LiveSession[]>>>();

/**
 * The live sessions, newest activity first, at most `max` (200); one per session id. Never throws: no folder, an unreadable or garbled
 * file is skipped. A file's name carries its pid, so liveness is checked before any file is read, and the cap applies only to what
 * is returned. At `budgetMs` what has been read so far is returned (a read that never ends is simply missing); and while an earlier call's
 * file work has not settled, no new work starts and the last list is returned (a hung home folder must not take a thread per poll).
 */
export async function listLive(io: LiveIo = nodeIo, dir = claudeSessionsDir(), o: { max?: number; budgetMs?: number } = {}): Promise<LiveSession[]> {
	let byDir = scans.get(io);
	if (!byDir) {
		scans.set(io, byDir = new Map());
	}
	let scan = byDir.get(dir);
	if (!scan) {
		byDir.set(dir, scan = new Budgeted<LiveSession[], LiveSession[]>([]));
	}
	const all = await scan.run(o.budgetMs ?? LIST_MS, async found => {
		const names = (await io.readdir(dir).catch(() => [] as string[])).filter(n => FILE_NAME.test(n) && parseInt(n) > 0).slice(0, MAX_NAMES);
		await Promise.all(names.filter(n => io.isAlive(parseInt(n))).map(async name => {
			try {
				const file = path.join(dir, name);
				const st = await io.lstat(file);
				if (!st.isFile() || st.size > MAX_FILE_BYTES) {
					return;
				}
				const s = parseLive(await io.read(file, MAX_FILE_BYTES), name);
				if (s) {
					// A file with no time of its own is as old as its last write: stable between two looks, unlike "now".
					found.push(s.updatedAt === undefined && s.startedAt === undefined ? { ...s, updatedAt: st.mtimeMs } : s);
				}
			} catch {
				// skipped
			}
		}));
	}, () => [], found => {
		const byId = new Map<string, LiveSession>();
		for (const s of [...found]) {
			const old = byId.get(s.id);
			if (!old || (s.updatedAt ?? 0) > (old.updatedAt ?? 0)) {
				byId.set(s.id, s);
			}
		}
		return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	});
	return all.slice(0, o.max ?? MAX_FILES);
}

/**
 * The live session, if any, that has one of these ids (a session's own, and the ids its conversation went on under after /clear). Asked of
 * the registry itself, whole: a resume must not go through because the page's capped list did not show the session. A stale file whose pid
 * another process has taken since is not "running": its start time is asked for once (never in the page's poll, which only lists), and an
 * entry the process is younger than is dropped; any doubt keeps it.
 */
export async function runningElsewhere(ids: Iterable<string | undefined>, io: LiveIo = nodeIo, dir = claudeSessionsDir()): Promise<LiveSession | undefined> {
	const want = new Set([...ids].filter((i): i is string => !!i).map(i => i.toLowerCase()));
	const found = want.size ? (await listLive(io, dir, { max: Infinity })).find(l => want.has(l.id)) : undefined;
	if (!found || !io.startTime) {
		return found;
	}
	const started = await io.startTime(found.pid).catch(() => undefined);
	return pidReused(found.startedAt, started) ? undefined : found;
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
