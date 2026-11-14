/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: `flowHarness.summary`, the harness of one folder as plain JSON (summaryCore.ts) for the Agents page's Harness panel.
 *  Read-only: the scan reads files and writes none. Any absolute folder will do, the open workspace or not (the panel shows the project of
 *  the focused pane), so the scan runs with plain fs (scanFsHost.ts) rather than the editor's own file search, and it is bounded: the
 *  folder walks stop at a deadline, every list and string is capped (summaryCore.ts), and the answer comes back within a hard limit even if
 *  something else hangs. The caller is another extension, which decides what the page may ask for; the command only checks its argument.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeDir } from './dirs';
import { lintFolder } from './harnessLint';
import { scanFolders, type Scope } from './scanCore';
import { fsScanHost } from './scanFsHost';
import { buildSummary, type SummaryExtras, type SummaryResult } from './summaryCore';

export type { HarnessSummary, SummaryResult } from './summaryCore';

/** The folder walks stop after this long, and the answer is given after this long whatever else is still running. */
export const WALK_MS = 1500;
export const HARD_MS = 2500;
const MAX_COMMANDS = 200;
/** A file bigger than this is not read for a summary: instructions and settings are small, and the folder may be one nobody opened. */
const MAX_FILE = 1024 * 1024;

/** The absolute folder `raw` names, or undefined: anything but a string holding an absolute path (no NUL, at most 1024 characters). */
export function folderOf(raw: unknown): string | undefined {
	if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024 || raw.includes('\0') || !path.isAbsolute(raw)) {
		return undefined;
	}
	const resolved = path.resolve(raw);
	return resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
}

/** `permissions.defaultMode` of the first of these settings files that has one: local before project before the user's, as Claude Code lets them override each other. */
async function defaultMode(files: string[], root: string): Promise<SummaryExtras['mode']> {
	const realRoot = await fs.realpath(root).catch(() => root);
	for (const file of files) {
		try {
			// A settings file of the folder that is a link leading out of it is not read (as the scan does not read it); the user's own file is.
			if (file.startsWith(root + path.sep)) {
				const real = await fs.realpath(file);
				if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
					continue;
				}
			}
			const st = await fs.stat(file);
			if (!st.isFile() || st.size > MAX_FILE) {
				continue;
			}
			const mode = (JSON.parse(await fs.readFile(file, 'utf8')) as { permissions?: { defaultMode?: unknown } } | null)?.permissions?.defaultMode;
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
async function commandsIn(dir: string, scope: Scope): Promise<SummaryExtras['commands']> {
	const out: SummaryExtras['commands'] = [];
	const visit = async (rel: string[]): Promise<void> => {
		const entries = (await fs.readdir(path.join(dir, ...rel), { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name < b.name ? -1 : 1);
		for (const e of entries) {
			if (out.length >= MAX_COMMANDS) {
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

const running = new Map<string, Promise<SummaryResult>>();

async function summarize(root: string): Promise<SummaryResult> {
	const deadline = Date.now() + WALK_MS;
	const user = claudeDir();
	const host = fsScanHost([root], deadline);
	// The findings are the lint's own (the CLI's scan: the folder only, by its real path), so the panel says what a pull request would fail on. The lists below
	// come from a second scan that also reads the user's own settings, hooks, commands and servers, which are part of the harness an agent here runs with.
	const real = await fs.realpath(root).catch(() => root);
	const lint = await lintFolder(root, real === root ? host : fsScanHost([real], deadline), { maxFileBytes: MAX_FILE });
	// Without the user's own memory files (not part of a summary) and with the user's settings, hooks and servers, which are part of the harness an agent here runs with.
	// A link in the folder that leads out of it is not followed (the user's own files are read as they are).
	const harness = await scanFolders([{ name: path.basename(root) || root, fsPath: root }], host, { memory: false, confine: true, maxFileBytes: MAX_FILE });
	if (!harness) {
		return { ok: false, message: 'Nothing to scan.' };
	}
	const [mode, project, own] = await Promise.all([
		defaultMode([path.join(root, '.claude', 'settings.local.json'), path.join(root, '.claude', 'settings.json'), path.join(user, 'settings.json')], root),
		commandsIn(path.join(root, '.claude', 'commands'), 'project'),
		commandsIn(path.join(user, 'commands'), 'user'),
	]);
	return { ok: true, summary: buildSummary(harness, { lint, mode, commands: [...project, ...own], timedOut: Date.now() > deadline, home: os.homedir() }, root) };
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
