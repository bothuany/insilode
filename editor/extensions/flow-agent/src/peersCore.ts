/*---------------------------------------------------------------------------------------------
 *  Insilode: what the Agents windows share through files, without `vscode` so it is tested on its own (test/peers.test.mjs).
 *  Every window publishes its sessions (rows.json) in its own storage folder; the others read them. A file is something another
 *  process could have written, so everything read here is checked for shape, type and length and rebuilt field by field: nothing
 *  from it becomes a command, a path to run or markup. A request to another window (reveal a session, open its flow) is a
 *  small file the owner reads, validates against its own sessions and deletes; nothing else travels this way.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { AgentRow, PeerRow } from './agentsData';
import { folderKey } from './storageKey';

export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_ROWS = 100;
export const MAX_TODOS = 40;
export const MAX_TEXT = 400;
export const MAX_PROJECTS = 50;
const REQUEST_MAX_BYTES = 1024;
/** A request nobody picked up in this long is stale: the user clicked a minute ago, not now. */
export const REQUEST_TTL_MS = 60_000;

export { folderKey };
const DIR_KEY = /^(?:empty-)?[0-9a-f]{12}$/;
export const isKey = (k: unknown): k is string => typeof k === 'string' && DIR_KEY.test(k);

const CLIS = new Set(['claude', 'codex', 'custom']);
const STATES = new Set(['starting', 'working', 'blocked', 'done', 'idle', 'unknown', 'ended']);
const ATTENTION = new Set(['approval', 'question', 'error', 'done']);
const TODO_STATUS = new Set(['pending', 'in_progress', 'completed']);
const PR_STATES = new Set(['open', 'draft', 'merged', 'closed']);

/** What this window publishes of a row: the sanitised row, slimmed again to what a sidebar draws. */
export function slimRow(r: AgentRow): PeerRow {
	const cut = (s: string | undefined) => s === undefined ? undefined : s.slice(0, MAX_TEXT);
	const u = r.usage;
	const t = r.cost?.session.tokens;
	return {
		id: r.id, cli: r.cli, name: r.name.slice(0, 200), state: r.state, since: r.since, attention: r.attention,
		activity: cut(r.activity), prompt: cut(r.prompt), need: cut(r.need?.text),
		todos: r.todos.slice(0, MAX_TODOS).map(x => ({ text: x.text.slice(0, MAX_TEXT), status: x.status })),
		tokens: t ? t.input + t.output + t.cacheRead + t.cacheWrite : undefined, usd: r.cost?.session.usd,
		contextPercent: u?.size ? Math.min(100, u.percent ?? Math.round(u.used / u.size * 100)) : undefined, model: u?.model?.slice(0, 100),
		pr: r.pr && { number: r.pr.number, state: r.pr.state, title: r.pr.title.slice(0, MAX_TEXT) },
		flows: r.impact?.flows.length ?? 0,
	};
}

const isStr = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optStr = (v: unknown, max = MAX_TEXT) => v === undefined || isStr(v, max);
const optNum = (v: unknown) => v === undefined || isNum(v);

/** One published row, or nothing when any field is missing, of the wrong type or too long. */
export function parseRow(raw: unknown): PeerRow | undefined {
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o !== 'object' || Array.isArray(o)) {
		return undefined;
	}
	if (!isStr(o.id, 200) || !o.id || typeof o.cli !== 'string' || !CLIS.has(o.cli) || !isStr(o.name, 200) || typeof o.state !== 'string' || !STATES.has(o.state) || !isNum(o.since)
		|| !(o.attention === undefined || (typeof o.attention === 'string' && ATTENTION.has(o.attention))) || !optStr(o.activity) || !optStr(o.prompt) || !optStr(o.need)
		|| !optNum(o.tokens) || !optNum(o.usd) || !optNum(o.contextPercent) || !optStr(o.model, 100) || !isNum(o.flows)) {
		return undefined;
	}
	if (!Array.isArray(o.todos) || o.todos.length > MAX_TODOS || !o.todos.every(x => x && typeof x === 'object' && isStr((x as { text?: unknown }).text) && TODO_STATUS.has((x as { status: string }).status))) {
		return undefined;
	}
	const pr = o.pr as Record<string, unknown> | undefined;
	if (pr !== undefined && (!pr || typeof pr !== 'object' || !isNum(pr.number) || typeof pr.state !== 'string' || !PR_STATES.has(pr.state) || !isStr(pr.title))) {
		return undefined;
	}
	return {
		id: o.id, cli: o.cli as PeerRow['cli'], name: o.name, state: o.state as PeerRow['state'], since: o.since, attention: o.attention as PeerRow['attention'],
		activity: o.activity as string | undefined, prompt: o.prompt as string | undefined, need: o.need as string | undefined,
		todos: (o.todos as { text: string; status: PeerRow['todos'][number]['status'] }[]).map(x => ({ text: x.text, status: x.status })),
		tokens: o.tokens as number | undefined, usd: o.usd as number | undefined, contextPercent: o.contextPercent as number | undefined, model: o.model as string | undefined,
		pr: pr && { number: pr.number as number, state: pr.state as 'open', title: pr.title as string }, flows: Math.max(0, Math.min(1000, Math.floor(o.flows))),
	};
}

export interface Snapshot {
	folder: string;
	name: string;
	pid: number;
	updatedAt: number;
	rows: PeerRow[];
}

/**
 * A window's rows.json. `key` is the folder it was read from: a snapshot must name the folder that folder is the storage of
 * (the hash agents.ts keys by), so a file cannot claim to be another project.
 */
export function parseSnapshot(raw: unknown, key: string): Snapshot | undefined {
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o !== 'object' || Array.isArray(o) || !isStr(o.folder, 1000) || !isStr(o.name, 200) || !isNum(o.pid) || !Number.isInteger(o.pid) || o.pid <= 0 || !isNum(o.updatedAt)
		|| !Array.isArray(o.rows) || o.rows.length > MAX_ROWS) {
		return undefined;
	}
	if (key.startsWith('empty-') ? o.folder !== '' : !path.isAbsolute(o.folder) || folderKey(o.folder) !== key) {
		return undefined;
	}
	const rows: PeerRow[] = [];
	for (const r of o.rows) {
		const row = parseRow(r);
		if (!row) {
			return undefined; // one bad row and the whole file is not ours to believe
		}
		rows.push(row);
	}
	return { folder: o.folder, name: o.name, pid: o.pid, updatedAt: o.updatedAt, rows };
}

/** Whether a process exists. EPERM means it does, under another user. */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM';
	}
}

async function readJson(file: string): Promise<unknown> {
	const st = await fs.stat(file);
	if (!st.isFile() || st.size > MAX_FILE_BYTES) {
		throw new Error('not a file of a sane size');
	}
	return JSON.parse(await fs.readFile(file, 'utf8'));
}

export interface PeerFound { key: string; name: string; folder: string; pid: number; rows: PeerRow[] }
export interface RecentFound { key: string; name: string; folder: string; sessions: string[] }

/** The project.json a window writes so a closed project can be listed and reopened. */
export function parseProject(raw: unknown, key: string): { folder: string; name: string } | undefined {
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o !== 'object' || !isStr(o.folder, 1000) || !isStr(o.name, 200) || !path.isAbsolute(o.folder) || folderKey(o.folder) !== key) {
		return undefined;
	}
	return { folder: o.folder, name: o.name };
}

/** Session names of a sessions.json, for the Recent list; a damaged file gives none. */
export function sessionNames(raw: unknown): string[] {
	const list = (raw as { sessions?: unknown } | null)?.sessions;
	return (Array.isArray(list) ? list : []).flatMap((s: { name?: unknown }) => s && isStr(s.name, 200) && s.name ? [s.name] : []).slice(0, 20);
}

/**
 * The other windows' projects under `root` (the `agents` folder of the global storage): the open ones (a rows.json whose process
 * is alive) and the closed ones that have a project.json and some sessions. `own` is this window's folder and is skipped.
 */
export async function readProjects(root: string, own: string, alive: (pid: number) => boolean = pidAlive): Promise<{ peers: PeerFound[]; recent: RecentFound[] }> {
	const peers: PeerFound[] = [];
	const recent: RecentFound[] = [];
	const names = await fs.readdir(root).catch(() => [] as string[]);
	for (const key of names.filter(n => isKey(n) && n !== own).slice(0, 500)) {
		const dir = path.join(root, key);
		const snap = await readJson(path.join(dir, 'rows.json')).then(j => parseSnapshot(j, key)).catch(() => undefined);
		if (snap && alive(snap.pid)) {
			peers.push({ key, name: snap.name, folder: snap.folder, pid: snap.pid, rows: snap.rows });
			continue;
		}
		const project = await readJson(path.join(dir, 'project.json')).then(j => parseProject(j, key)).catch(() => undefined);
		const sessions = project ? await readJson(path.join(dir, 'sessions.json')).then(sessionNames).catch(() => []) : [];
		if (project && sessions.length) {
			recent.push({ key, name: project.name, folder: project.folder, sessions });
		}
	}
	peers.sort((a, b) => a.name.localeCompare(b.name));
	recent.sort((a, b) => a.name.localeCompare(b.name));
	return { peers: peers.slice(0, MAX_PROJECTS), recent: recent.slice(0, MAX_PROJECTS) };
}

/** Atomic: a reader never sees half a file. */
export async function writeJson(file: string, value: unknown) {
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
	await fs.rename(tmp, file);
}

export type PeerRequest = { type: 'reveal' | 'flow'; id: string };
const REQUEST_FILE = /^request-[0-9a-f]{16}\.json$/;

/** A request as read from a file: only `reveal` and `flow`, an id of sane length, and a time (checked by the caller against its clock). */
export function parseRequest(raw: unknown, now: number): PeerRequest | undefined {
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o !== 'object' || (o.type !== 'reveal' && o.type !== 'flow') || !isStr(o.id, 200) || !o.id || !isNum(o.at) || Math.abs(now - o.at) > REQUEST_TTL_MS) {
		return undefined;
	}
	return { type: o.type, id: o.id };
}

/** Drops a request into another window's folder (`dir` is built from a validated key by the caller). */
export async function writeRequest(dir: string, req: PeerRequest) {
	await writeJson(path.join(dir, `request-${randomBytes(8).toString('hex')}.json`), { ...req, at: Date.now() });
}

/**
 * Reads and deletes the requests waiting in this window's folder. Each file is deleted whatever it holds; what is returned is
 * only a `reveal` or `flow` for a session `has` knows, so a foreign id or any other type does nothing.
 */
export async function takeRequests(dir: string, has: (id: string) => boolean, now = Date.now()): Promise<PeerRequest[]> {
	const out: PeerRequest[] = [];
	for (const name of (await fs.readdir(dir).catch(() => [] as string[])).filter(n => REQUEST_FILE.test(n)).slice(0, 20)) {
		const file = path.join(dir, name);
		const raw = await fs.stat(file).then(st => st.isFile() && st.size <= REQUEST_MAX_BYTES ? fs.readFile(file, 'utf8') : undefined).then(t => t === undefined ? undefined : JSON.parse(t) as unknown).catch(() => undefined);
		await fs.unlink(file).catch(() => undefined);
		const req = parseRequest(raw, now);
		if (req && has(req.id)) {
			out.push(req);
		}
	}
	return out;
}
