/*---------------------------------------------------------------------------------------------
 *  Insilode: what the agents have done on this machine. Claude keeps every conversation as ~/.claude/projects/<folder>/<id>.jsonl,
 *  Codex as ~/.codex/sessions/<date>/rollout-*.jsonl; both name the real folder inside the file (the Claude directory name is
 *  lossy, so it is never decoded). `scan` lists the newest sessions grouped by that folder, for the Agents page's chat. The
 *  helpers that read the ends of a transcript are shared with resume.ts. Only fs and os here (no vscode): tested on its own.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { folderKey } from './storageKey';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Transcripts can be hundreds of MB: only their ends are read. */
export async function slice(file: string, from: 'head' | 'tail', bytes: number): Promise<string[]> {
	const h = await fs.open(file, 'r');
	try {
		const { size } = await h.stat();
		const start = from === 'head' ? 0 : Math.max(0, size - bytes);
		const buf = Buffer.alloc(Math.min(bytes, size));
		const { bytesRead } = await h.read(buf, 0, buf.length, start);
		const lines = buf.toString('utf8', 0, bytesRead).split('\n');
		// The first line of a tail and the last of a head may be cut off.
		return (from === 'head' ? (bytesRead === bytes ? lines.slice(0, -1) : lines) : (start ? lines.slice(1) : lines)).filter(Boolean);
	} finally {
		await h.close();
	}
}

export function newestTitle(lines: string[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes('"custom-title"')) {
			try {
				const t = (JSON.parse(lines[i]) as { customTitle?: string }).customTitle?.trim();
				if (t) {
					return t;
				}
			} catch {
				// partial line
			}
		}
	}
	return undefined;
}

/** The first thing the user typed: not a hook's context, a slash command's echo or a tool result. */
export function firstPrompt(lines: string[]): string | undefined {
	for (const line of lines) {
		if (!line.includes('"type":"user"')) {
			continue;
		}
		try {
			const e = JSON.parse(line) as { type?: string; isMeta?: boolean; isSidechain?: boolean; message?: { content?: unknown } };
			if (e.type !== 'user' || e.isMeta || e.isSidechain) {
				continue;
			}
			const c = e.message?.content;
			const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find(b => b?.type === 'text' && typeof b.text === 'string') as { text: string } | undefined)?.text : undefined;
			const t = text?.replace(/\s+/g, ' ').trim();
			if (t && !t.startsWith('<') && !t.startsWith('Caveat:')) {
				return t.slice(0, 160);
			}
		} catch {
			// partial line
		}
	}
	return undefined;
}

/** Codex's own folder: CODEX_HOME, or ~/.codex. */
export function codexHome() {
	return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
}

/** Every rollout-*.jsonl under `dir`: Codex keeps them in <year>/<month>/<day> folders (archived ones lie flat). `into` fills as the walk goes, so a caller that gives up on a slow disk keeps what it has. */
export async function rolloutFiles(dir: string, depth = 0, into: string[] = []): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	await Promise.all(entries.map(async e => {
		const full = path.join(dir, e.name);
		if (e.isDirectory() && depth < 3) {
			await rolloutFiles(full, depth + 1, into);
		} else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
			into.push(full);
		}
	}));
	return into;
}

/** What a Codex rollout's first lines say: the session_meta line names the id and the folder, a user_message event what it was about. */
export function codexHead(lines: string[]): { id?: string; cwd?: string; prompt?: string } {
	const out: { id?: string; cwd?: string; prompt?: string } = {};
	for (const line of lines) {
		try {
			const e = JSON.parse(line) as { type?: string; payload?: { id?: string; cwd?: string; type?: string; message?: string } };
			// The last one before the first prompt wins, as it always did for the resume list; nothing in the Codex files shipped here (a native binary) shows that a forked rollout's first line is the id Codex resumes.
			if (e.type === 'session_meta') {
				out.id = e.payload?.id;
				out.cwd = e.payload?.cwd;
			} else if (e.type === 'event_msg' && e.payload?.type === 'user_message' && typeof e.payload.message === 'string') {
				out.prompt = e.payload.message.replace(/\s+/g, ' ').trim().slice(0, 160);
				break;
			}
		} catch {
			// partial line
		}
	}
	return out;
}

// ---- the machine-wide index ----------------------------------------------------------------------------------------------------

export interface IndexedSession {
	id: string;
	kind: 'claude' | 'codex';
	title: string;
	modified: number;
}

export interface IndexedProject {
	/** folderKey(cwd): what the page sends back to name the folder. */
	key: string;
	cwd: string;
	name: string;
	sessions: IndexedSession[];
}

/** Only the newest files are opened, so a machine with years of sessions costs the same as one with a few days. */
const NEWEST_FILES = 300;
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
const MAX_PROJECTS = 50;
const MAX_SESSIONS = 20;
const RESCAN_MS = 10_000;
/** Files stat'ed or read at once, so thousands of transcripts do not run out of file handles. */
const PARALLEL = 32;
/** The whole scan's budget: a stat that hangs on a dead network mount must not hold up every later open. */
const SCAN_MS = 3000;

const claudeProjects = () => path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');

/** Runs `run` over `items`, a few at a time; no new item starts once `deadline` has passed. */
async function pool<T>(items: T[], deadline: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
		while (next < items.length && Date.now() < deadline) {
			await run(items[next++]);
		}
	}));
}

/** Waits for `work`, but no longer than `deadline`: what it has put into its shared arrays by then is what the caller gets. Never throws. */
async function until(deadline: number, work: Promise<unknown>): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	await Promise.race([work.catch(() => undefined), new Promise<void>(resolve => timer = setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
	clearTimeout(timer);
}

interface Read { id: string; cwd: string; title: string }
/** What a file said when it had this modification time and size; a file that is read again only when it changed. */
const cache = new Map<string, Read | null>();

async function readClaude(file: string): Promise<Read | null> {
	const id = path.basename(file, '.jsonl');
	const [head, tail] = await Promise.all([slice(file, 'head', HEAD_BYTES), slice(file, 'tail', TAIL_BYTES).catch(() => [] as string[])]);
	let cwd: string | undefined;
	for (const line of head) {
		if (line.includes('"cwd"')) {
			try {
				const c = (JSON.parse(line) as { cwd?: unknown }).cwd;
				if (typeof c === 'string') {
					cwd = c;
					break;
				}
			} catch {
				// partial line
			}
		}
	}
	const title = newestTitle(tail) ?? newestTitle(head) ?? firstPrompt(head);
	// A conversation that never got a prompt (opened and closed at once) has nothing to resume.
	return cwd && title ? { id, cwd, title } : null;
}

async function readCodex(file: string): Promise<Read | null> {
	const h = codexHead(await slice(file, 'head', HEAD_BYTES));
	return h.id && UUID.test(h.id) && h.cwd && h.prompt ? { id: h.id, cwd: h.cwd, title: h.prompt } : null;
}

/**
 * Every session of the newest 300 transcripts, grouped by the folder it ran in. Never throws: an unreadable or garbled file is
 * skipped, and at `budgetMs` the scan returns what it has read so far (a file or folder that hangs is simply missing).
 */
export async function scan(budgetMs = SCAN_MS): Promise<IndexedProject[]> {
	const deadline = Date.now() + budgetMs;
	const claude: string[] = [];
	let dirs: { name: string; isDirectory(): boolean }[] = [];
	await until(deadline, fs.readdir(claudeProjects(), { withFileTypes: true }).then(d => { dirs = d; }));
	await until(deadline, pool(dirs.filter(d => d.isDirectory()), deadline, async dir => {
		const here = path.join(claudeProjects(), dir.name);
		for (const n of await fs.readdir(here).catch(() => [] as string[])) {
			if (n.endsWith('.jsonl') && UUID.test(n.slice(0, -6))) {
				claude.push(path.join(here, n));
			}
		}
	}));
	const codex: string[] = [];
	await until(deadline, rolloutFiles(path.join(codexHome(), 'sessions'), 0, codex));
	const all = [...claude.map(file => ({ file, kind: 'claude' as const })), ...codex.map(file => ({ file, kind: 'codex' as const }))];
	const files: { file: string; kind: 'claude' | 'codex'; mtime: number; size: number }[] = [];
	await until(deadline, pool(all, deadline, async f => {
		const st = await fs.stat(f.file).catch(() => undefined);
		if (st?.isFile() && st.size > 0) {
			files.push({ file: f.file, kind: f.kind, mtime: st.mtimeMs, size: st.size });
		}
	}));
	const newest = files.sort((a, b) => b.mtime - a.mtime).slice(0, NEWEST_FILES);
	const live = new Set(newest.map(f => `${f.file}|${f.mtime}|${f.size}`));
	const read: (Read & { kind: 'claude' | 'codex'; modified: number })[] = [];
	await until(deadline, pool(newest, deadline, async f => {
		const key = `${f.file}|${f.mtime}|${f.size}`;
		if (!cache.has(key)) {
			cache.set(key, await (f.kind === 'claude' ? readClaude(f.file) : readCodex(f.file)).catch(() => null));
		}
		const r = cache.get(key);
		if (r && path.isAbsolute(r.cwd)) {
			read.push({ ...r, kind: f.kind, modified: f.mtime });
		}
	}));
	for (const k of [...cache.keys()]) {
		if (!live.has(k)) {
			cache.delete(k);
		}
	}
	const exists = new Map<string, boolean>();
	await until(deadline, pool([...new Set(read.map(r => r.cwd))], deadline, async cwd => {
		exists.set(cwd, await fs.stat(cwd).then(s => s.isDirectory(), () => false));
	}));
	const byKey = new Map<string, IndexedProject>();
	for (const r of read) {
		// A folder whose check did not finish in time is left out like one that is gone.
		if (!exists.get(r.cwd)) {
			continue;
		}
		const key = folderKey(r.cwd);
		const project = byKey.get(key) ?? { key, cwd: r.cwd, name: path.basename(r.cwd) || r.cwd, sessions: [] };
		byKey.set(key, project);
		project.sessions.push({ id: r.id, kind: r.kind, title: r.title, modified: r.modified });
	}
	const projects = [...byKey.values()];
	for (const p of projects) {
		p.sessions.sort((a, b) => b.modified - a.modified);
		p.sessions = p.sessions.slice(0, MAX_SESSIONS);
	}
	return projects.sort((a, b) => b.sessions[0].modified - a.sessions[0].modified).slice(0, MAX_PROJECTS);
}

/** `scan`, at most once per 10 seconds: a page that asks again sooner gets the last answer, and asks that overlap share one scan. */
export class SessionIndex {
	private last: { at: number; projects: IndexedProject[] } | undefined;
	private running: Promise<IndexedProject[]> | undefined;

	async list(now = Date.now()): Promise<IndexedProject[]> {
		if (this.last && now - this.last.at < RESCAN_MS) {
			return this.last.projects;
		}
		this.running ??= scan().then(projects => {
			this.last = { at: now, projects };
			return projects;
		}, () => this.last?.projects ?? []).finally(() => this.running = undefined);
		return this.running;
	}
}
