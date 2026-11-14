/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: one merged picture of everything that shapes an agent in this workspace —
 *  instructions, rules, skills, subagents, hooks, MCP servers and permission rules — with the
 *  scope each comes from, what it costs in context, and what looks broken.
 *
 *  No `vscode` here: what only the editor can do (searching the workspace) is a `ScanHost` the caller gives (scan.ts for the
 *  editor, scanFsHost.ts for the headless harness lint), so the same checks run in both.
 *--------------------------------------------------------------------------------------------*/

import { constants, promises as fs, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globList } from './effective';
import { parseIndex, parseMemory, projectKey, type Memory } from './memory';
import { lint, ruleGlobs, type InstructionKind, type LintFile } from './lint';
import { projectGaps, type Gap } from './gaps';
import { gitIgnoredOf } from './ignored';
import { claudeDir, codexDir } from './dirs';
import { maskArgs, maskUrl, readMcp, type McpServer } from './mcpconfig';
import { isNetworkPath, pathVerdict, within, type PathVerdict } from './pathGuard';
import { listEntries } from './listEntries';

export type Scope = 'user' | 'project' | 'local' | 'directory';
export type Kind = 'instructions' | 'rules' | 'skills' | 'agents' | 'hooks' | 'mcp' | 'permissions' | 'memory';
export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
	severity: Severity;
	message: string;
	/** 0-based line in `file`, when the problem is on a line. */
	line?: number;
	/** What to do about it, from the lint. */
	fix?: string;
	/** A short, stable id of the check (the lint's own `code`, or one of the scan's: invalid-json, missing-script, …). */
	code?: string;
}

export interface HarnessItem {
	kind: Kind;
	scope: Scope;
	label: string;
	detail: string;
	file: string;
	/** Tokens read only when they apply (a folder's CLAUDE.md, a path-scoped rule, a skill's or subagent's body). Estimates, like `tokens`. */
	onDemand?: number;
	/** Tokens this costs in every session (memory files, skill descriptions); undefined when unknown. */
	tokens?: number;
	issues: Issue[];
	/** Hooks: what to run and when. */
	hook?: { event: string; matcher?: string; command: string; settingsFile: string };
	/** Hooks and permission rules: the 0-based line they are written on in their settings file. */
	line?: number;
	/** Permission rules: allow / ask / deny. */
	rule?: { effect: 'allow' | 'ask' | 'deny'; pattern: string };
	/** Memory: the parsed topic file (its body is what the staleness check reads). */
	memory?: Memory;
	/** Path-scoped rules: the globs they apply to (empty for an always-on rule). */
	paths?: string[];
	/** MCP servers: the manager's id for it, the name its tool calls carry, and whether it is on. */
	mcp?: { id: string; toolPrefix: string; state: McpServer['state']; transport: McpServer['transport']; /** The command line (credential-looking arguments masked) or the URL (user info and secret query values masked). */ target: string };
	agents: string[];
}

export interface Harness {
	root: string;
	items: HarnessItem[];
	score: number;
	counts: Record<Severity, number>;
	/** What this project has not set up (see gaps.ts); missing instructions also lower the score. */
	gaps: Gap[];
	/** Tokens loaded into every new session before the first prompt. */
	startupTokens: number;
	/** Limits the scan hit (more files than it lists): shown with the result, never silently. */
	notes?: string[];
}

/** What the scan needs from the machine's workspace search; the files of one folder at a time. */
export interface ScanFolder {
	name: string;
	fsPath: string;
	/** The caller's own handle for the folder (a vscode WorkspaceFolder), handed back to its host. */
	ref?: unknown;
}

export interface ScanHost {
	/** CLAUDE.md and AGENTS.md anywhere in the folder (absolute paths), build output and VCS folders left out, at most `limit`. */
	nested(folder: ScanFolder, limit: number): Promise<string[]>;
	/** Every file of the folder relative to it with `/`, at most `limit` (the caller can tell a cut list by its length). */
	listing(folder: ScanFolder, limit: number): Promise<string[]>;
	/** Whether a file whose path ends with `ref` exists anywhere in the workspace; true when it cannot be told. */
	somewhere(ref: string): Promise<boolean>;
	/** What the host's searches left out so far (a folder with more entries than it reads): said with the result, never silently. */
	limits?(): string[];
}

export interface ScanOptions {
	/** Skip a file larger than this many bytes as if it were not there (a summary of a folder nobody opened must not read a multi-gigabyte CLAUDE.md). Default: no limit. */
	maxFileBytes?: number;
	/** Leave out Claude's and Codex's memory files (they are read only for the map's memory view). Default true. */
	memory?: boolean;
	/** With the user's files read: still refuse a link in the folders that leads out of them, as the lint without the user's files does (the user's own files are read as ever). */
	confine?: boolean;
	/** Read the user's own files (~/.claude, ~/.codex, the user MCP servers and memory): false for a repository's CI run, which has none. Default true. */
	user?: boolean;
	/** A time (epoch ms) after which the scan reads nothing more and answers with what it has: every walk, read and child process checks it, so a scan past it stops instead of running on. Default: none. */
	deadline?: number;
	/** The most bytes of files read in all (every file's size counts): past it a file is skipped as if it were not there, and the result says so. Default: no limit. */
	maxTotalBytes?: number;
	/** The folder is one nobody opened or trusted (the Agents page's summary): a path its files name is looked at only inside the folder, and a message never quotes a file. Default false. */
	untrusted?: boolean;
}

/** The host of the scan in progress: one scan at a time per process, set by `scanFolders`. */
let host: ScanHost;
/** Whether the scan in progress looks at the user's own files and home folder (see `ScanOptions.user`), set by `scanFolders`. */
let userScan = true;
/**
 * Without the user's files the scan reads only what really lies inside the folders (their real paths): a link to a file elsewhere
 * (a settings file pointing at some secret) is not read, and `outside` collects what was refused, to be reported once.
 */
let confined: string[] | undefined;
/** With `confined`: the paths (as written, not resolved) the check applies to; undefined: every path. */
let checkedOnly: string[] | undefined;
const outside = new Set<string>();
/** Files bigger than this are not read (see `ScanOptions.maxFileBytes`), set by `scanFolders`. */
let maxRead = Infinity;
/** When the scan in progress must stop (see `ScanOptions.deadline`), and whether its folder is trusted, set by `scanFolders`. */
let stopAt = Infinity;
let untrustedScan = false;
/** The most bytes the scan may read in all, and how many it has (see `ScanOptions.maxTotalBytes`). */
let maxTotal = Infinity;
let readBytes = 0;
/** Limits this scan hit (a settings file with more rules than are read) and the file or folder each was hit in, reported with the result: in `notes`, and as a finding the map and the lint show. */
const limits = new Map<string, string>();
const cut = (message: string, where: string) => void (limits.has(message) || limits.set(message, where));
/** What a scan of a folder nobody trusted reads at most (`cap`); a trusted scan reads all of it, protected only by its deadline and, for links to folders, by loop detection. */
const cap = (n: number) => untrustedScan ? n : Infinity;
const late = () => Date.now() > stopAt;

/** What one list or walk of an untrusted scan takes at most: a folder can hold anything, and the scan is for a map, not an index. */
const MAX_ENTRIES = 1000;
const MAX_WALK_ENTRIES = 3000;
const MAX_WALK_FILES = 500;
const MAX_DEPTH = 8;
/** The most hooks and rules read from one settings file, and paths one instruction file has checked on disk. */
const MAX_SETTING_ITEMS = 500;
const MAX_REFS = 100;
/** The part of a file looked at for its frontmatter, and the longest value kept from it. */
const FRONT_BYTES = 256 * 1024;
const FRONT_VALUE = 4096;
const FRONT_ITEMS = 500;

const home = os.homedir();
const tokensOf = (text: string) => Math.round(text.length / 4);
/** The folders of the scan in progress, as given. */
let roots: string[] = [];

/** Whether `p`, or a folder between the scanned folder and it, is a link that names a network path: `realpath` would open the connection to find out where it leads (on Windows a link in a repository can say `\\host\share`). */
async function linksToNetwork(p: string): Promise<boolean> {
	const root = roots.find(r => p === r || p.startsWith(r + path.sep));
	let at = root ?? '';
	for (const part of root ? path.relative(root, p).split(path.sep).filter(Boolean) : [p]) {
		at = root ? path.join(at, part) : part;
		const target = await fs.readlink(at).catch(() => undefined);
		if (target !== undefined && isNetworkPath(target)) {
			return true;
		}
	}
	return false;
}

/** Whether `p` may be read: not when a check applies to it (see `confined`) and its real path leads out of the folders. Records what was refused. */
async function inFolders(p: string): Promise<{ ok: boolean; real?: string }> {
	if (!confined || (checkedOnly && !checkedOnly.some(r => p === r || p.startsWith(r + path.sep)))) {
		return { ok: true };
	}
	if (await linksToNetwork(p)) {
		outside.add(p);
		return { ok: false };
	}
	const real = await fs.realpath(p).catch(() => undefined);
	if (real !== undefined && !confined.some(r => real === r || real.startsWith(r + path.sep))) {
		outside.add(p);
		return { ok: false };
	}
	return { ok: real !== undefined, real };
}

/** O_NONBLOCK: opening a named pipe or a device answers at once instead of waiting for a writer; O_NOFOLLOW: no link in the last place of a path already resolved. Windows has neither. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Opens `file`, checks the handle itself (a regular file, not too big) and reads it from there: nothing can change between the check and the read. */
async function readRegular(file: string, noFollow: boolean): Promise<string | undefined> {
	const handle = await fs.open(file, OPEN_FLAGS | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0)).catch(() => undefined);
	if (!handle) {
		return undefined;
	}
	try {
		const st = await handle.stat();
		if (!st.isFile() || st.size > maxRead) {
			return undefined;
		}
		if (readBytes + st.size > maxTotal) {
			cut('The files of this folder add up to more than is read for a summary, so some were skipped.', file);
			return undefined;
		}
		readBytes += st.size;
		const buffer = Buffer.alloc(st.size);
		let got = 0;
		while (got < buffer.length) {
			const { bytesRead } = await handle.read(buffer, got, buffer.length - got, got);
			if (!bytesRead) {
				break;
			}
			got += bytesRead;
		}
		return buffer.toString('utf8', 0, got);
	} catch {
		return undefined;
	} finally {
		await handle.close().catch(() => undefined);
	}
}

async function read(p: string): Promise<string | undefined> {
	if (late()) {
		return undefined;
	}
	const { ok, real } = await inFolders(p);
	// A file that was checked is read by the path the check resolved, so a link swapped in afterwards is refused by the open; an unchecked one is read as written (a link to a file in the folder is a normal setup).
	return ok ? readRegular(real ?? p, real !== undefined) : undefined;
}
const exists = (p: string) => late() ? Promise.resolve(true) : fs.stat(p).then(() => true, () => false);
const show = (root: string, p: string) => p.startsWith(root + path.sep) ? path.relative(root, p) : p.replace(home, '~');

function frontMatter(text: string): Record<string, string> {
	const m = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/.exec(text.slice(0, FRONT_BYTES));
	const out: Record<string, string> = {};
	const lines = m?.groups?.body.split(/\r?\n/) ?? [];
	// A value is collected as parts and joined once, when it ends: joining at every line would copy the whole value for each of them.
	const clip = (parts: string[]) => parts.join(' ').slice(0, FRONT_VALUE);
	let key = '';
	let items: string[] = [];
	const flush = () => {
		if (key && items.length) {
			out[key] = [out[key], ...items].filter(Boolean).join(',').slice(0, FRONT_VALUE);
		}
		items = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const kv = /^(?<k>[\w-]+):\s*(?<v>.*)$/.exec(line);
		if (!kv?.groups) {
			if (key && /^\s*-\s+/.test(line) && items.length < FRONT_ITEMS) {
				items.push(line.replace(/^\s*-\s+/, ''));
			}
			continue;
		}
		flush();
		key = kv.groups.k;
		const inline = kv.groups.v.trim();
		const next = () => lines[i + 1] ?? '';
		// `description: >` and `description: |`: the text is the indented lines below, shown as one line.
		if (/^[>|][+-]?\d*$/.test(inline)) {
			const parts: string[] = [];
			while (i + 1 < lines.length && (!next().trim() || /^\s/.test(next()))) {
				parts.push(lines[++i].trim());
			}
			out[key] = clip(parts).replace(/\s+/g, ' ').trim();
			continue;
		}
		// A value that goes on over indented lines (or starts on the next one); list items and nested keys are not part of it.
		const parts = inline ? [inline] : [];
		while (/^\s+\S/.test(next()) && !/^\s*-\s+/.test(next()) && (parts.length || !/^\s+[\w-]+:(\s|$)/.test(next()))) {
			parts.push(lines[++i].trim());
		}
		out[key] = clip(parts).replace(/^(["'])(.*)\1$/, '$2');
	}
	flush();
	return out;
}

/** The entries of one folder, as Dirents, at most `limit` (a folder may hold millions: `readdir` would read them all in one call nobody can interrupt). For a folder nobody trusted, empty when its real path leads out of the scanned folders. */
async function entriesOf(dir: string, limit: number): Promise<import('fs').Dirent[]> {
	// A trusted scan lists what it is pointed at: the files it reads from there are checked one by one (`read`), as ever.
	if (late() || (untrustedScan && !(await inFolders(dir)).ok)) {
		return [];
	}
	return listEntries(dir, limit, () => cut(`A folder has more than ${limit} entries, so only the first ${limit} were read.`, dir));
}

async function listDir(dir: string): Promise<string[]> {
	return (await entriesOf(dir, cap(MAX_ENTRIES))).map(e => path.join(dir, e.name));
}

/** How long a trusted walk may take: it is chained with the scans that follow it, so a folder tree nobody can finish is cut and said, not waited for. */
const TRUSTED_WALK_MS = 20_000;

/**
 * The files below `dir` that `accept` takes. Real folders are entered. A link to a folder is entered only by a trusted scan; an untrusted scan never
 * follows one, so a link to /usr or to its own folder costs nothing. A trusted walk takes each real folder once and lists each real file once, whatever
 * number of links lead to them (a link back into a folder, `a -> .`, is a loop; two links to one folder would double the walk at every level), and stops
 * after `TRUSTED_WALK_MS`. An untrusted walk instead stops at a depth, a number of entries and files, and the scan's deadline. A link to a file is a
 * candidate like any file: `read` decides whether it may be read. Whatever is left out is said (`cut`).
 */
async function filesBelow(dir: string, accept: (name: string) => boolean): Promise<string[]> {
	const out: string[] = [];
	let seen = 0;
	const until = Date.now() + TRUSTED_WALK_MS;
	// The real path of every folder entered and file listed in this walk (a trusted one: an untrusted walk follows no link, so there is no second way in).
	const visited = new Set<string>();
	// `here` is the real path of `d`, so `here/name` is the real path of a real entry of it.
	const visit = async (d: string, depth: number, here: string): Promise<void> => {
		for (const e of await entriesOf(d, cap(MAX_ENTRIES))) {
			if (late()) {
				return;
			}
			if (!untrustedScan && Date.now() > until) {
				cut(`Reading a rules folder took longer than ${TRUSTED_WALK_MS / 1000} seconds, so only part of it was read.`, dir);
				return;
			}
			if (out.length >= cap(MAX_WALK_FILES) || ++seen > cap(MAX_WALK_ENTRIES)) {
				cut(out.length >= cap(MAX_WALK_FILES) ? `Only the first ${MAX_WALK_FILES} rule files of a folder are read.` : `A rules folder holds more than ${MAX_WALK_ENTRIES} entries, so only part of it was read.`, dir);
				return;
			}
			const p = path.join(d, e.name);
			// Some file systems give no type with a listing: lstat answers for them, still without following a link.
			const st = e.isDirectory() || e.isFile() || e.isSymbolicLink() ? e : await fs.lstat(p).catch(() => undefined);
			const again = 'A link leads back into a folder or to a file the walk has already been to, so it was not followed again.';
			if (st?.isDirectory()) {
				const real = path.join(here, e.name);
				if (!untrustedScan && visited.has(real)) {
					cut(again, dir);
				} else if (depth < cap(MAX_DEPTH)) {
					visited.add(real);
					await visit(p, depth + 1, real);
				} else {
					cut(`A rules folder is more than ${MAX_DEPTH} levels deep, so what lies below it was not read.`, dir);
				}
			} else if (st?.isSymbolicLink() && (await fs.stat(p).catch(() => undefined))?.isDirectory()) {
				const real = untrustedScan ? undefined : await fs.realpath(p).catch(() => undefined);
				if (real === undefined || visited.has(real)) {
					cut(untrustedScan ? 'A link to a folder was not followed.' : again, dir);
				} else {
					visited.add(real);
					await visit(p, depth + 1, real);
				}
			} else if (st && accept(e.name) && (st.isFile() || (st.isSymbolicLink() && (await fs.stat(p).catch(() => undefined))?.isFile()))) {
				const real = untrustedScan ? undefined : st.isSymbolicLink() ? await fs.realpath(p).catch(() => undefined) : path.join(here, e.name);
				if (real !== undefined && visited.has(real)) {
					cut(again, dir);
				} else {
					real !== undefined && visited.add(real);
					out.push(p);
				}
			}
		}
	};
	// An untrusted walk follows no link and keeps no real path: `here` is only used by a trusted one.
	const top = untrustedScan ? dir : await fs.realpath(dir).catch(() => dir);
	visited.add(top);
	await visit(dir, 0, top);
	return out;
}

/**
 * Prose often names a path relative to some project folder ("Data/Extensions/X.cs"): it is only
 * broken when nothing in the workspace ends with it.
 */
const somewhere = new Map<string, Promise<boolean>>();
/** Every distinct path costs a workspace search: past this many in one scan, the rest are given the benefit of the doubt. */
const MAX_LOOKUPS = 25;
function existsSomewhere(ref: string): Promise<boolean> {
	const clean = ref.replace(/^\.\//, '');
	if (!somewhere.has(clean)) {
		if (somewhere.size >= MAX_LOOKUPS) {
			return Promise.resolve(true);
		}
		somewhere.set(clean, Promise.resolve(host.somewhere(clean)).catch(() => true));
	}
	return somewhere.get(clean)!;
}

/**
 * Paths a memory file points at: `@imports` and backticked relative paths that look like files.
 * Only what is clearly meant as a path is checked, so prose never turns into false alarms.
 */
/** What a path named in a file's text is reported as when it is not looked at (see pathGuard.ts). The message names no path: it is the file's own text. */
function notChecked(verdict: PathVerdict, line: number): Issue {
	return { severity: 'info', message: verdict === 'network' ? 'Names a network path, so it was not checked' : 'Names a path outside the project, so it was not checked', line, code: 'path-not-checked' };
}

/** Whether the scan may stat `target`, which `raw` (a path as a file of `owner` wrote it) resolved to. Only a folder nobody trusted is confined to itself, and only for its own files: the user's are theirs. */
function verdictOf(raw: string, target: string, root: string, owner: string): PathVerdict {
	return pathVerdict(raw, target, root, untrustedScan && within(root, owner), path);
}

async function brokenPaths(file: string, text: string, root: string): Promise<Issue[]> {
	const issues: Issue[] = [];
	const lines = text.split(/\r?\n/);
	let inFence = false;
	let checked = 0;
	for (let i = 0; i < lines.length && !late(); i++) {
		const line = lines[i];
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}
		const candidates: { ref: string; isImport: boolean }[] = [];
		for (const m of line.matchAll(/(?:^|\s)@(?<p>[~.\w/-]+\.\w+)/g)) {
			candidates.push({ ref: m.groups!.p, isImport: true });
		}
		for (const m of line.matchAll(/`(?<p>(?:\.{1,2}\/|[\w.-]+\/)[\w./-]+\.[a-zA-Z]{1,6})`/g)) {
			if (!/[*{}$<>]/.test(m.groups!.p)) {
				candidates.push({ ref: m.groups!.p, isImport: false });
			}
		}
		for (const c of candidates) {
			// A lint run without the user's files cannot know the home folder of whoever works on the repository.
			if (!userScan && c.ref.startsWith('~')) {
				continue;
			}
			if (++checked > cap(MAX_REFS)) {
				cut(`Only the first ${MAX_REFS} paths named in an instruction file are checked.`, file);
				break;
			}
			// A file may name anything: only what the guard allows is looked at (a network path would open a connection to whoever wrote it).
			const first = c.ref.startsWith('~') ? path.join(home, c.ref.slice(1)) : path.resolve(c.ref.startsWith('.') ? path.dirname(file) : root, c.ref);
			const targets = [first, path.resolve(path.dirname(file), c.ref)].filter((t, n, all) => all.indexOf(t) === n);
			const verdicts = targets.map(t => verdictOf(c.ref, t, root, file));
			const open = targets.filter((_, n) => verdicts[n] === 'ok');
			if (!open.length) {
				issues.push(notChecked(verdicts.includes('network') ? 'network' : 'outside', i));
				continue;
			}
			let found = false;
			for (const t of open) {
				found = found || await exists(t);
			}
			if (!found && !(!c.isImport && await existsSomewhere(c.ref))) {
				issues.push({ severity: c.isImport ? 'error' : 'warning', message: c.isImport ? `Import @${c.ref} does not exist` : `Mentions ${c.ref}, which does not exist`, line: i, code: c.isImport ? 'broken-import' : 'broken-path' });
			}
		}
	}
	return issues;
}

async function memoryFile(items: HarnessItem[], root: string, file: string, scope: Scope, agents: string[], where: string) {
	const text = await read(file);
	if (text === undefined) {
		return;
	}
	const tokens = tokensOf(text);
	const issues = await brokenPaths(file, text, root);
	const lines = text.split(/\r?\n/).length;
	if (lines > 300) {
		issues.push({ severity: 'info', message: `${lines} lines: costs about ${tokens.toLocaleString()} tokens in every session`, code: 'long-file' });
	}
	items.push({ kind: 'instructions', scope, label: show(root, file), detail: where, file, tokens: scope === 'directory' ? undefined : tokens, onDemand: scope === 'directory' ? tokens : undefined, issues, agents });
}

interface HookEntry { matcher?: string; hooks?: { type?: string; command?: string }[] }
interface Settings {
	hooks?: Record<string, HookEntry[]>;
	permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; defaultMode?: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Valid JSON of the wrong shape (`"allow": "Bash"`, `"hooks": []`) must not break the scan of every other file. */
function settingsShape(raw: unknown): Settings {
	if (!isObject(raw)) {
		return {};
	}
	const hooks: Record<string, HookEntry[]> = {};
	for (const [event, entries] of Object.entries(isObject(raw.hooks) ? raw.hooks : {})) {
		hooks[event] = (Array.isArray(entries) ? entries : []).filter(isObject).map(e => ({
			matcher: typeof e.matcher === 'string' ? e.matcher : undefined,
			hooks: (Array.isArray(e.hooks) ? e.hooks : []).filter(isObject).map(h => ({ type: typeof h.type === 'string' ? h.type : undefined, command: typeof h.command === 'string' ? h.command : undefined })),
		}));
	}
	const perms = isObject(raw.permissions) ? raw.permissions : {};
	return {
		hooks,
		permissions: { allow: strings(perms.allow), ask: strings(perms.ask), deny: strings(perms.deny), defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : undefined },
	};
}

async function settingsFile(items: HarnessItem[], root: string, file: string, scope: Scope) {
	const text = await read(file);
	if (text === undefined) {
		return;
	}
	let s: Settings;
	try {
		s = settingsShape(JSON.parse(text));
	} catch (e) {
		// Where, never what: the parser's own message quotes the start of the text, which can be anything a link points at.
		const at = /\(line (\d+) column (\d+)\)/.exec((e as Error).message);
		items.push({ kind: 'hooks', scope, label: show(root, file), detail: 'Not valid JSON: the agent ignores this file', file, issues: [{ severity: 'error', message: at ? `Invalid JSON at line ${at[1]}, column ${at[2]}` : 'Invalid JSON', ...(at ? { line: Number(at[1]) - 1 } : {}), code: 'invalid-json' }], agents: ['Claude'] });
		return;
	}
	const lines = text.split(/\r?\n/);
	// Each lookup reads lines until it finds its own; a file with thousands of rules would read them all for every one, so the lookups together read a bounded number (the rest are put on line 1).
	let budget = 2_000_000;
	const find = (from: number, needle: string) => {
		for (let n = from; n < lines.length && budget > 0; n++, budget--) {
			if (lines[n].includes(needle)) {
				return n;
			}
		}
		return -1;
	};
	const lineOf = (needle: string) => Math.max(0, find(0, needle));
	// Two hooks may run the same command: each takes the next line that holds it, in file order (the order JSON.parse
	// gives too), so a finding about the second one lands on the second one.
	const taken = new Map<string, number>();
	const nextLineOf = (needle: string) => {
		const i = find((taken.get(needle) ?? -1) + 1, needle);
		if (i >= 0) {
			taken.set(needle, i);
		}
		return i >= 0 ? i : lineOf(needle);
	};
	let hookCount = 0;
	for (const [event, entries] of Object.entries(s.hooks ?? {})) {
		for (const entry of entries) {
			for (const h of entry.hooks ?? []) {
				if (!h.command) {
					continue;
				}
				if (++hookCount > cap(MAX_SETTING_ITEMS)) {
					cut(`Only the first ${MAX_SETTING_ITEMS} hooks, and the first ${MAX_SETTING_ITEMS} allow, ask and deny rules each, of a settings file are read.`, file);
					break;
				}
				const issues: Issue[] = [];
				// A script the hook runs must exist, or every matching tool call fails the hook.
				const script = /(?:bash|sh|node|python3?)\s+["']?(?<p>[^\s"']+\.(?:sh|js|mjs|py))/.exec(h.command)?.groups?.p
					?? /^["']?(?<p>[^\s"']+\.(?:sh|js|mjs|py))/.exec(h.command.trim())?.groups?.p;
				if (script) {
					const resolved = script
						.replace(/\$\{CLAUDE_PROJECT_DIR(?::-[^}]*)?\}|\$CLAUDE_PROJECT_DIR\b|%CLAUDE_PROJECT_DIR%/gi, () => root)
						.replace(/\$\{HOME\}|\$HOME\b|%USERPROFILE%/gi, () => home)
						.replace(/^~(?=[\\/]|$)/, () => home);
					// Whatever is still a variable (${CLAUDE_PLUGIN_ROOT}, say) is only known to Claude Code: no verdict, no penalty.
					// A script under the home folder is the user's own, not the repository's: no verdict without the user's files.
					const inHome = !userScan && /^~(?=[\\/]|$)|\$\{HOME\}|\$HOME\b|%USERPROFILE%/i.test(script);
					if (!inHome && !/[$%]/.test(resolved)) {
						// The script's path is the file's text: a network path is never stat'ed, and in a folder nobody trusted neither is one that leaves it.
						const target = path.resolve(root, resolved);
						const verdict = verdictOf(script, target, root, file);
						if (verdict !== 'ok') {
							issues.push(notChecked(verdict, lineOf(script)));
						} else if (!await exists(target)) {
							issues.push({ severity: 'error', message: `Script ${script} does not exist`, line: lineOf(script), code: 'missing-script' });
						}
					}
				}
				// Inline shell gets a readable name from the variable it checks or the first program it runs.
				const inlineVar = /\$\{?(?<v>[A-Z][A-Z0-9_]{3,})/.exec(h.command)?.groups?.v;
				const name = script ? path.basename(script)
					: h.command.trim().startsWith('[') || h.command.includes(';') ? `inline script${inlineVar ? ` (${inlineVar})` : ''}`
						: h.command.split(/\s+/).slice(0, 2).map(t => path.basename(t)).join(' ');
				items.push({
					kind: 'hooks', scope, label: name,
					detail: `${event}${entry.matcher ? ` · ${entry.matcher}` : ''}`,
					file, issues, agents: ['Claude'],
					hook: { event, matcher: entry.matcher, command: h.command, settingsFile: file },
					line: nextLineOf(JSON.stringify(h.command).slice(1, 61)),
				});
			}
		}
	}
	for (const effect of ['allow', 'ask', 'deny'] as const) {
		if ((s.permissions?.[effect]?.length ?? 0) > cap(MAX_SETTING_ITEMS)) {
			cut(`Only the first ${MAX_SETTING_ITEMS} hooks, and the first ${MAX_SETTING_ITEMS} allow, ask and deny rules each, of a settings file are read.`, file);
		}
		for (const pattern of (s.permissions?.[effect] ?? []).slice(0, cap(MAX_SETTING_ITEMS))) {
			items.push({ kind: 'permissions', scope, label: pattern, detail: effect, file, issues: [], agents: ['Claude'], rule: { effect, pattern }, line: lineOf(JSON.stringify(pattern)) });
		}
	}
}

async function skillsIn(items: HarnessItem[], dir: string, scope: Scope, agents: string[]) {
	for (const d of await listDir(dir)) {
		const file = path.join(d, 'SKILL.md');
		const text = await read(file);
		if (text === undefined) {
			continue;
		}
		const fm = frontMatter(text);
		const issues: Issue[] = [];
		if (!fm.description) {
			issues.push({ severity: 'warning', message: 'No description: the agent cannot tell when to use this skill', line: 0, code: 'no-description' });
		}
		// Only name + description sit in context until the skill is used.
		const listed = tokensOf(`${fm.name ?? ''} ${fm.description ?? ''}`);
		items.push({ kind: 'skills', scope, label: fm.name || path.basename(d), detail: fm.description ?? '', file, tokens: listed, onDemand: Math.max(0, tokensOf(text) - listed), issues, agents });
	}
}

async function agentsIn(items: HarnessItem[], dir: string, scope: Scope) {
	for (const file of (await listDir(dir)).filter(f => f.endsWith('.md'))) {
		const text = await read(file);
		// Refused (a link out of the repository, already reported) is not the same as empty: skip it.
		if (text === undefined) {
			continue;
		}
		const fm = frontMatter(text);
		const listed = tokensOf(`${fm.name ?? ''} ${fm.description ?? ''}`);
		// The body is the subagent's own prompt: it fills the subagent's window when spawned, not the main one.
		items.push({ kind: 'agents', scope, label: fm.name || path.basename(file, '.md'), detail: fm.description ?? '', file, tokens: listed, onDemand: Math.max(0, tokensOf(text) - listed), issues: [], agents: ['Claude'] });
	}
}

async function rulesIn(items: HarnessItem[], root: string, dir: string, scope: Scope, agents: string[], globKey: string) {
	for (const file of await filesBelow(dir, name => /\.mdc?$/.test(name))) {
		const text = await read(file);
		if (text === undefined) {
			continue;
		}
		const fm = frontMatter(text);
		const always = fm.alwaysApply === 'true' || !fm[globKey];
		items.push({ kind: 'rules', scope, label: path.relative(dir, file), detail: always ? 'Every file' : `Files matching ${fm[globKey]}`, file, tokens: always ? tokensOf(text) : undefined, onDemand: always ? undefined : tokensOf(text), issues: await brokenPaths(file, text, root), agents, paths: always ? [] : globList(fm[globKey]) });
	}
}

/**
 * Every MCP server either agent loads here (mcpconfig.ts reads the same files the MCP manager edits): user and local
 * servers in .claude.json, the project's .mcp.json, plugin and managed ones, and Codex's config.toml files.
 */
async function mcpServers(items: HarnessItem[], root: string, user: boolean) {
	// Without the user's files only the folder's own are read: the others are answered as missing.
	const mine = (p: string) => user || p === root || p.startsWith(root + path.sep);
	const config = await readMcp({
		root, home, platform: process.platform, claudeDir: claudeDir(), codexDir: codexDir(), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || undefined,
		read: p => mine(p) ? read(p) : Promise.resolve(undefined), list: d => mine(d) ? fs.readdir(d).catch(() => [] as string[]) : Promise.resolve([] as string[]),
	});
	const scopeOf = (s: McpServer): Scope => s.scope === 'local' || s.scope === 'project' ? s.scope : 'user';
	for (const s of config.servers) {
		const target = s.transport === 'stdio' ? [s.command ?? '', ...maskArgs(s.args)].join(' ') : maskUrl(s.url ?? '');
		const state = s.state === 'off' ? 'off' : s.state === 'pending' ? 'awaiting approval' : '';
		items.push({
			kind: 'mcp', scope: scopeOf(s), label: s.name,
			detail: [s.scope === 'user' || s.scope === 'local' || s.scope === 'project' ? '' : s.scope, s.transport, target, state].filter(Boolean).join(' · '),
			file: s.file, issues: s.issues.map(i => ({ ...i, code: 'mcp-config' })), agents: [s.harness],
			mcp: { id: s.id, toolPrefix: s.toolPrefix, state: s.state, transport: s.transport, target },
		});
	}
	for (const p of config.problems) {
		items.push({ kind: 'mcp', scope: p.file.startsWith(root) ? 'project' : 'user', label: show(root, p.file), detail: 'Not readable: the agent ignores its MCP servers', file: p.file, issues: [{ severity: 'error', message: p.message, code: 'mcp-unreadable' }], agents: [p.file.endsWith('.toml') ? 'Codex' : 'Claude'] });
	}
}

/** Same rule allowed in one place and denied in another: the stricter one wins, which surprises people. */
function conflicts(items: HarnessItem[]) {
	const rules = items.filter(i => i.rule);
	// By pattern, so a rule is compared with the rules that have its pattern, not with every rule.
	const byPattern = new Map<string, HarnessItem[]>();
	for (const r of rules) {
		const same = byPattern.get(r.rule!.pattern);
		if (same) {
			same.push(r);
		} else {
			byPattern.set(r.rule!.pattern, [r]);
		}
	}
	for (const r of rules) {
		const clash = byPattern.get(r.rule!.pattern)!.find(o => o !== r && o.rule!.effect !== r.rule!.effect);
		if (clash && r.rule!.effect === 'allow') {
			r.issues.push({ severity: 'warning', message: `Also "${clash.rule!.effect}" in ${clash.scope} settings, which wins`, code: 'rule-conflict' });
		}
	}
	const seen = new Map<string, HarnessItem>();
	for (const s of items.filter(i => i.kind === 'skills')) {
		const first = seen.get(s.label);
		if (first && first.scope !== s.scope && first.agents.join() === s.agents.join()) {
			s.issues.push({ severity: 'info', message: `Same name as a ${first.scope} skill; one shadows the other`, code: 'skill-shadow' });
		}
		seen.set(s.label, s);
	}
}

/** Which lint rules apply to an item's file. */
function lintKind(i: HarnessItem): InstructionKind | undefined {
	const base = path.basename(i.file).toLowerCase();
	if (i.kind === 'instructions') {
		return base === 'agents.md' ? 'agents-md' : base === 'copilot-instructions.md' ? 'copilot' : 'claude-md';
	}
	if (i.kind === 'rules') {
		return i.agents.includes('Cursor') ? 'cursor-rule' : 'claude-rule';
	}
	return i.kind === 'skills' ? 'skill' : i.kind === 'agents' ? 'agent' : undefined;
}

/** The harness lint (lint.ts) over what the scan found; each finding becomes an issue on the item whose file (and line) it names. */
async function lintItems(items: HarnessItem[], root: string, folder: ScanFolder) {
	const seen = new Set<string>();
	const files: LintFile[] = [];
	for (const i of items) {
		const kind = lintKind(i);
		if (kind && !seen.has(i.file)) {
			seen.add(i.file);
			const text = await read(i.file);
			if (text !== undefined) {
				files.push({ file: i.file, label: show(root, i.file), kind, text });
			}
		}
	}
	// Listing the project is only worth it when some rule is scoped to globs.
	const scoped = files.some(f => (f.kind === 'claude-rule' || f.kind === 'cursor-rule') && ruleGlobs(f).length);
	const limit = 20_000;
	// This folder's files only: a rule's globs are relative to the folder that holds it.
	const listed = scoped ? await host.listing(folder, limit) : [];
	if (listed.length >= limit) {
		cut(`The project has more than ${limit} files, so a rule's globs were checked against the first ${limit} only: none is called dead.`, root);
	}
	const findings = late() ? [] : lint({
		files,
		hooks: items.filter(i => i.hook).map(i => ({ ...i.hook!, line: i.line ?? 0 })),
		rules: items.filter(i => i.rule).map(i => ({ ...i.rule!, scope: i.scope === 'directory' ? 'project' : i.scope, file: i.file, line: i.line ?? 0 })),
		projectFiles: scoped ? listed : undefined,
		projectFilesTruncated: listed.length >= limit,
		untrusted: untrustedScan,
		cwd: root, home,
	});
	const byFile = new Map<string, HarnessItem[]>();
	for (const i of items) {
		const here = byFile.get(i.file);
		if (here) {
			here.push(i);
		} else {
			byFile.set(i.file, [i]);
		}
	}
	for (const f of findings) {
		const here = byFile.get(f.file) ?? [];
		const item = here.find(i => i.line === f.line) ?? here[0];
		item?.issues.push({ severity: f.severity, message: f.message, line: f.line, fix: f.fix, code: f.code });
	}
}

/** Where Claude Code keeps its auto memory for a folder. */
export const claudeMemoryDir = (root: string) => path.join(claudeDir(), 'projects', projectKey(root), 'memory');

/**
 * The agents' own memory for this folder, read only: Claude Code's MEMORY.md (loaded in every session) and its topic files
 * (read when recalled), and Codex's ~/.codex/memories when there is one.
 */
async function memoryIn(items: HarnessItem[], root: string) {
	const dir = claudeMemoryDir(root);
	const indexFile = path.join(dir, 'MEMORY.md');
	const indexText = await read(indexFile);
	const index = indexText === undefined ? [] : parseIndex(indexText);
	if (indexText !== undefined) {
		const issues: Issue[] = index.filter(e => !/^https?:/.test(e.target)).map(e => ({ e, file: path.join(dir, e.target) }))
			.filter(x => !existsSyncSafe(x.file)).map(({ e }) => ({ severity: 'warning' as const, message: `Points at ${e.target}, which does not exist`, line: e.line, fix: 'Delete the line, or restore the file' }));
		items.push({ kind: 'memory', scope: 'user', label: 'MEMORY.md', detail: `Claude's memory index for this folder: ${index.length} entr${index.length === 1 ? 'y' : 'ies'}, loaded in every session`, file: indexFile, tokens: tokensOf(indexText), issues, agents: ['Claude'] });
	}
	for (const file of (await listDir(dir)).filter(f => /\.md$/i.test(f) && path.basename(f) !== 'MEMORY.md')) {
		const text = await read(file);
		if (text === undefined) {
			continue;
		}
		const st = await fs.stat(file).catch(() => undefined);
		const m = parseMemory(file, text);
		const entry = index.find(e => path.basename(e.target) === path.basename(file));
		m.indexLine = entry?.line;
		m.modified ??= st?.mtimeMs;
		const issues: Issue[] = entry || indexText === undefined ? [] : [{ severity: 'info', message: 'Not in MEMORY.md: Claude does not know it is there unless it lists the folder', fix: 'Add a line for it to MEMORY.md, or delete it' }];
		items.push({ kind: 'memory', scope: 'user', label: m.name, detail: [m.type ?? 'memory', m.description].filter(Boolean).join(' · '), file, onDemand: tokensOf(text), issues, agents: ['Claude'], memory: m });
	}
	const codex = path.join(codexDir(), 'memories');
	for (const file of (await listDir(codex)).filter(f => /\.(md|txt|json)$/i.test(f))) {
		const text = await read(file);
		if (text !== undefined) {
			const m = parseMemory(file, text);
			m.modified ??= (await fs.stat(file).catch(() => undefined))?.mtimeMs;
			items.push({ kind: 'memory', scope: 'user', label: m.name, detail: ['Codex', m.type, m.description].filter(Boolean).join(' · '), file, onDemand: tokensOf(text), issues: [], agents: ['Codex'], memory: m });
		}
	}
}

const existsSyncSafe = (p: string) => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

/** Most nested CLAUDE.md / AGENTS.md files listed per folder: a monorepo can hold thousands, and the search stops here. */
const MAX_NESTED = 200;

/**
 * What one workspace folder contributes. The user's own files (home folder) belong to no folder: `first` reads them once,
 * with the first folder, so a workspace of three folders does not list them three times.
 */
async function scanFolder(items: HarnessItem[], folder: ScanFolder, first: boolean, user: boolean, memory: boolean): Promise<string[]> {
	const root = folder.fsPath;
	const notes: string[] = [];

	// Instructions: user, then project, then nested folders (more specific wins).
	if (first && user) {
		await memoryFile(items, root, path.join(claudeDir(), 'CLAUDE.md'), 'user', ['Claude'], 'Your instructions, every project');
		await memoryFile(items, root, path.join(codexDir(), 'AGENTS.md'), 'user', ['Codex'], 'Your instructions, every project');
	}
	await memoryFile(items, root, path.join(root, 'CLAUDE.md'), 'project', ['Claude'], 'Loaded in every session');
	await memoryFile(items, root, path.join(root, 'CLAUDE.local.md'), 'local', ['Claude'], 'Yours only, not committed');
	await memoryFile(items, root, path.join(root, 'AGENTS.md'), 'project', ['Codex', 'Cursor'], 'Loaded in every session');
	await memoryFile(items, root, path.join(root, '.github', 'copilot-instructions.md'), 'project', ['Copilot'], 'Copilot reads it in every chat');
	const found = await host.nested(folder, MAX_NESTED);
	// Git answers with the paths as it was given them.
	const ignored = late() ? new Set<string>() : await gitIgnoredOf(root, found, Math.min(10_000, Math.max(0, stopAt - Date.now())));
	const nested = found.filter(f => !ignored.has(f));
	for (const file of nested) {
		if (path.dirname(file) !== root) {
			await memoryFile(items, root, file, 'directory', path.basename(file) === 'CLAUDE.md' ? ['Claude'] : ['Codex', 'Cursor'], `When working under ${path.relative(root, path.dirname(file))}/`);
		}
	}
	if (found.length >= MAX_NESTED) {
		// The search stopped at its limit, so files past it are not listed: say so where the list is, never silently.
		const message = `Insilode listed the first ${MAX_NESTED} CLAUDE.md and AGENTS.md files in ${folder.name}; there may be more, and they are not checked or counted.`;
		notes.push(message);
		items.push({ kind: 'instructions', scope: 'directory', label: `More than ${MAX_NESTED} CLAUDE.md / AGENTS.md files`, detail: 'Only the first ones are listed', file: found[0], issues: [{ severity: 'info', message, fix: 'Ignore build output and vendored folders in .gitignore, or open the part of the repository you work in as its own folder' }], agents: [] });
	}

	await rulesIn(items, root, path.join(root, '.claude', 'rules'), 'project', ['Claude'], 'paths');
	if (first && user) {
		await rulesIn(items, root, path.join(claudeDir(), 'rules'), 'user', ['Claude'], 'paths');
	}
	await rulesIn(items, root, path.join(root, '.cursor', 'rules'), 'project', ['Cursor'], 'globs');

	await skillsIn(items, path.join(root, '.claude', 'skills'), 'project', ['Claude']);
	await skillsIn(items, path.join(root, '.agents', 'skills'), 'project', ['Codex']);
	await skillsIn(items, path.join(root, '.cursor', 'skills'), 'project', ['Cursor']);
	if (first && user) {
		await skillsIn(items, path.join(claudeDir(), 'skills'), 'user', ['Claude']);
	}

	await agentsIn(items, path.join(root, '.claude', 'agents'), 'project');
	if (first && user) {
		await agentsIn(items, path.join(claudeDir(), 'agents'), 'user');
	}

	if (user && memory) {
		await memoryIn(items, root);
	}

	if (first && user) {
		await settingsFile(items, root, path.join(claudeDir(), 'settings.json'), 'user');
	}
	await settingsFile(items, root, path.join(root, '.claude', 'settings.json'), 'project');
	await settingsFile(items, root, path.join(root, '.claude', 'settings.local.json'), 'local');
	await mcpServers(items, root, user);
	return notes;
}

/** What makes an item the same one found twice: the user's Codex memories and MCP servers are read again with every folder. */
const sameItem = (i: HarnessItem) => JSON.stringify([i.kind, i.scope, i.file, i.label, i.detail, i.line ?? null, i.mcp?.id ?? null]);

/**
 * The harness of these folders (a multi-root workspace has one in each). `host` answers what needs the workspace search;
 * `undefined` for no folders.
 */
export function scanFolders(folders: ScanFolder[], scanHost: ScanHost, options: ScanOptions = {}): Promise<Harness | undefined> {
	// The scan keeps its host and options in module variables: two at once (the editor's own and a summary of another folder) would swap them under each other.
	const run = scanning.then(() => scanNow(folders, scanHost, options));
	scanning = run.then(() => undefined, () => undefined);
	return run;
}
/** The scan in progress (or the last one): the next waits for it. */
let scanning: Promise<void> = Promise.resolve();

async function scanNow(folders: ScanFolder[], scanHost: ScanHost, options: ScanOptions): Promise<Harness | undefined> {
	host = scanHost;
	maxRead = options.maxFileBytes ?? Infinity;
	stopAt = options.deadline ?? Infinity;
	maxTotal = options.maxTotalBytes ?? Infinity;
	roots = folders.map(f => f.fsPath);
	readBytes = 0;
	untrustedScan = options.untrusted === true;
	somewhere.clear();
	outside.clear();
	limits.clear();
	if (!folders.length) {
		return undefined;
	}
	const user = options.user !== false;
	userScan = user;
	confined = user && !options.confine ? undefined : await Promise.all(folders.map(f => fs.realpath(f.fsPath).catch(() => f.fsPath)));
	// Only what lies inside the folders is checked when the user's files are read too; without them everything is.
	checkedOnly = user ? folders.map(f => f.fsPath) : undefined;
	const root = folders[0].fsPath;
	const items: HarnessItem[] = [];
	const notes: string[] = [];
	for (const [n, folder] of folders.entries()) {
		const batch: HarnessItem[] = [];
		notes.push(...await scanFolder(batch, folder, n === 0, user, options.memory !== false));
		const known = new Set(items.map(sameItem));
		const mine = batch.filter(i => !known.has(sameItem(i)));
		if (n > 0) {
			// Two folders both have a CLAUDE.md: the label says whose.
			mine.forEach(i => (i.label = `${folder.name}: ${i.label}`));
		}
		await lintItems(mine, folder.fsPath, folder);
		items.push(...mine);
	}

	conflicts(items);
	for (const why of host.limits?.() ?? []) {
		cut(why, root);
	}
	for (const file of outside) {
		items.push({ kind: 'instructions', scope: 'project', label: show(root, file), detail: 'A link to a file outside the repository: not read', file, issues: [{ severity: 'warning', message: `${show(root, file)} is a link to something outside the repository, so it was not read`, fix: 'Keep the file in the repository, or leave it out of the lint', code: 'outside-repo' }], agents: [] });
	}

	// The gaps are told before the limit items are added: an item that says what was cut is not a CLAUDE.md.
	const gaps = projectGaps(items);
	// What was cut or skipped is a finding of its own (info): the map and the lint list findings, and a note nobody reads is a silent cut.
	// Its file is the file or folder it was cut in, with no line: it is no instruction file, and the map opens no other file for it.
	for (const [message, where] of limits) {
		notes.push(message);
		items.push({ kind: 'instructions', scope: 'directory', label: 'Scan limit', detail: message, file: where, issues: [{ severity: 'info', message, code: 'scan-limited' }], agents: [] });
	}
	const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
	items.forEach(i => i.issues.forEach(x => counts[x.severity]++));
	const score = Math.max(0, 100 - counts.error * 12 - counts.warning * 4 - counts.info - gaps.reduce((a, g) => a + g.cost, 0));
	const claudeStartup = items.filter(i => i.agents.includes('Claude') && i.tokens && (i.kind === 'instructions' || i.kind === 'skills' || i.kind === 'agents' || i.kind === 'rules' || i.kind === 'memory'));
	return { root, items, score, counts, gaps, startupTokens: claudeStartup.reduce((a, i) => a + (i.tokens ?? 0), 0), ...(notes.length ? { notes } : {}) };
}
