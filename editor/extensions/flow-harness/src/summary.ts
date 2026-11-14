/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: `flowHarness.summary`, the harness of one folder as plain JSON (summaryCore.ts) for the Agents page's Harness panel.
 *  Read-only: the scan reads files and writes none. Any absolute folder will do, the open workspace or not (the panel shows the project of
 *  the focused pane), so the scan runs with plain fs (scanFsHost.ts) rather than the editor's own file search, and it is bounded: the
 *  folder walks stop at a deadline, every list and string is capped (summaryCore.ts), and the answer comes back within a hard limit even if
 *  something else hangs. The caller is another extension, which decides what the page may ask for; the command only checks its argument.
 *--------------------------------------------------------------------------------------------*/

import { constants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeDir } from './dirs';
import { lintFolder } from './harnessLint';
import { within } from './pathGuard';
import { scanFolders, type Scope } from './scanCore';
import { listEntries } from './listEntries';
import { fsScanHost } from './scanFsHost';
import { buildSummary, type SummaryExtras, type SummaryResult } from './summaryCore';

export type { HarnessSummary, SummaryResult } from './summaryCore';

/** The folder walks stop after this long, and the answer is given after this long whatever else is still running. */
export const WALK_MS = 1500;
export const HARD_MS = 2500;
const MAX_COMMANDS = 200;
/** A file bigger than this is not read for a summary: instructions and settings are small, and the folder may be one nobody opened. */
const MAX_FILE = 1024 * 1024;
/** All the files of one summary together: 500 links to one big file are 500 big files to read. */
const MAX_TOTAL = 8 * 1024 * 1024;
/** The most entries read from one commands folder (`readdir` reads a whole folder in one call nobody can interrupt), and the most `realpath` calls running at once. */
const MAX_DIR_ENTRIES = 5000;
const LINKS_AT_ONCE = 256;

/** The absolute folder `raw` names, or undefined: anything but a string holding an absolute path (no NUL, at most 1024 characters). */
export function folderOf(raw: unknown): string | undefined {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024 || raw.includes('\0') || !path.isAbsolute(raw)) {
		return undefined;
	}
	const resolved = path.resolve(raw);
	return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

/** The text of a regular file of at most MAX_FILE bytes, checked on the opened handle (a named pipe opens at once with O_NONBLOCK and is not a file), or undefined. */
async function readSmall(file: string, noFollow = false): Promise<string | undefined> {
	const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (noFollow ? (constants.O_NOFOLLOW ?? 0) : 0)).catch(() => undefined);
	try {
		const st = await handle?.stat();
		if (!handle || !st?.isFile() || st.size > MAX_FILE) {
			return undefined;
		}
		const buffer = Buffer.alloc(st.size);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString('utf8', 0, bytesRead);
	} catch {
		return undefined;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** `permissions.defaultMode` of the first of these settings files that has one: local before project before the user's, as Claude Code lets them override each other. */
async function defaultMode(files: string[], root: string): Promise<SummaryExtras['mode']> {
	const realRoot = await fs.realpath(root).catch(() => root);
	for (const file of files) {
		try {
			// A settings file of the folder that is a link leading out of it is not read (as the scan does not read it); the user's own file is.
			let target = file;
			if (file.startsWith(root + path.sep)) {
				const real = await fs.realpath(file);
				if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
					continue;
				}
				// Read what was checked, by its resolved path: a link put there since is refused by the open.
				target = real;
			}
			const text = await readSmall(target, target !== file);
			if (text === undefined) {
				continue;
			}
			const mode = (JSON.parse(text) as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
			// A word (acceptEdits, bypassPermissions, plan): anything else in that field is not a mode to show.
			if (typeof mode === 'string' && /^[A-Za-z]{1,32}$/.test(mode)) {
				return { mode, file };
			}
		} catch {
			// Missing or not JSON: the scan already reports a settings file that is invalid.
		}
	}
	return undefined;
}

/** Slash commands of a folder (`commands/a.md` is `/a`, `commands/x/b.md` is `/x:b`): names only, the files are not read. */
async function commandsIn(dir: string, scope: Scope, root?: string, deadline = Infinity): Promise<SummaryExtras['commands']> {
	const out: SummaryExtras['commands'] = [];
	// The folder's own commands folder is listed only if it really lies in the folder (a link out of it would list someone else's files).
	if (root !== undefined) {
		const [real, realDir] = await Promise.all([fs.realpath(root).catch(() => root), fs.realpath(dir).catch(() => undefined)]);
		if (realDir === undefined || !within(real, realDir)) {
			return out;
		}
	}
	const visit = async (rel: string[]): Promise<void> => {
		if (Date.now() > deadline) {
			return;
		}
		for (const e of await listEntries(path.join(dir, ...rel), MAX_DIR_ENTRIES)) {
			if (out.length >= MAX_COMMANDS || Date.now() > deadline) {
				return;
			}
			if (e.isDirectory() && rel.length < 2) {
				await visit([...rel, e.name]);
			} else if (e.isFile() && e.name.endsWith('.md')) {
				out.push({ name: '/' + [...rel, e.name.slice(0, -3)].join(':'), scope, file: path.join(dir, ...rel, e.name) });
			}
		}
	};
	await visit([]);
	return out;
}

/**
 * The files among `files` that lie in the folder as written (the user's own files are the user's) but whose real path is outside it: what the summary must not name.
 * Checked a few at a time up to `deadline` (the caller leaves room before the hard limit); a file not checked by then is treated as outside (left out rather than named unchecked).
 */
async function linksOut(root: string, files: string[], deadline = Infinity): Promise<Set<string>> {
	const real = await fs.realpath(root).catch(() => root);
	const unsafe = new Set<string>();
	const mine = [...new Set(files)].filter(f => within(root, f));
	for (let at = 0; at < mine.length; at += LINKS_AT_ONCE) {
		const batch = mine.slice(at, at + LINKS_AT_ONCE);
		if (Date.now() > deadline) {
			batch.forEach(f => unsafe.add(f));
			continue;
		}
		await Promise.all(batch.map(async f => {
			const target = await fs.realpath(f).catch(() => undefined);
			if (target !== undefined && !within(real, target)) {
				unsafe.add(f);
			}
		}));
	}
	return unsafe;
}

const running = new Map<string, Promise<SummaryResult>>();

async function summarize(root: string): Promise<SummaryResult> {
	const deadline = Date.now() + WALK_MS;
	const user = claudeDir();
	const host = fsScanHost([root], deadline, true);
	// The findings are the lint's own (the CLI's scan: the folder only, by its real path), so the panel says what a pull request would fail on. The lists below
	// come from a second scan that also reads the user's own settings, hooks, commands and servers, which are part of the harness an agent here runs with.
	const real = await fs.realpath(root).catch(() => root);
	const lint = await lintFolder(root, real === root ? host : fsScanHost([real], deadline, true), { maxFileBytes: MAX_FILE, maxTotalBytes: MAX_TOTAL, deadline, untrusted: true });
	// Without the user's own memory files (not part of a summary) and with the user's settings, hooks and servers, which are part of the harness an agent here runs with.
	// A link in the folder that leads out of it is not followed (the user's own files are read as they are).
	const harness = await scanFolders([{ name: path.basename(root) || root, fsPath: root }], host, { memory: false, confine: true, maxFileBytes: MAX_FILE, maxTotalBytes: MAX_TOTAL, deadline, untrusted: true });
	if (!harness) {
		return { ok: false, message: 'Nothing to scan.' };
	}
	const [mode, project, own] = await Promise.all([
		defaultMode([path.join(root, '.claude', 'settings.local.json'), path.join(root, '.claude', 'settings.json'), path.join(user, 'settings.json')], root),
		commandsIn(path.join(root, '.claude', 'commands'), 'project', root, deadline),
		commandsIn(path.join(user, 'commands'), 'user', undefined, deadline),
	]);
	const unsafe = await linksOut(root, [...harness.items.map(i => i.file), ...lint.map(l => l.abs), ...project.map(c => c.file)], deadline + HARD_MS - WALK_MS - 300);
	return { ok: true, summary: buildSummary(harness, { lint, mode, commands: [...project, ...own], timedOut: Date.now() > deadline, home: os.homedir(), unsafe }, root) };
}

/** The harness summary of `folder` (an absolute path to an existing folder), or the sentence why not. Never throws. */
export async function harnessSummary(folder: unknown): Promise<SummaryResult> {
	const root = folderOf(folder);
	if (!root) {
		return { ok: false, message: 'The folder must be an absolute path.' };
	}
	if (!(await fs.stat(root).then(s => s.isDirectory(), () => false))) {
		return { ok: false, message: 'That folder does not exist.' };
	}
	// A second ask for the same folder while the first is still being worked out shares it.
	let pending = running.get(root);
	if (!pending) {
		let timer: NodeJS.Timeout | undefined;
		const work = summarize(root).catch((e): SummaryResult => ({ ok: false, message: `The harness could not be read: ${(e as Error).message}` }));
		const late = new Promise<SummaryResult>(resolve => { timer = setTimeout(() => resolve({ ok: false, message: 'Reading the harness took too long.' }), HARD_MS); });
		pending = Promise.race([work, late]).finally(() => { clearTimeout(timer); running.delete(root); });
		running.set(root, pending);
	}
	return pending;
}
