/*---------------------------------------------------------------------------------------------
 *  Insilode: the repository's worktree setup file, .insilode/worktree.json in the main checkout:
 *    { "copy": [".env"], "setup": [["npm", "ci"]], "teardown": [["npm", "run", "clean"]] }
 *  `copy` lists git-ignored files taken from the main checkout into a new worktree, `setup` and `teardown` are commands
 *  as argument arrays. Nothing here ever runs a shell: a command is started with spawn and its arguments as they are.
 *  On Windows a command that is a .cmd shim (npm, npx, yarn) cannot be started by Node without one, so it goes through
 *  cmd.exe with a command line built here, and only when no argument holds a character cmd.exe would interpret.
 *  This file does not import vscode: the trust check, the log and the dialogs are worktreeCleanup.ts's.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { constants, existsSync, promises as fs } from 'fs';
import * as path from 'path';

export interface SetupConfig {
	copy: string[];
	setup: string[][];
	teardown: string[][];
}

export const SETUP_FILE = path.join('.insilode', 'worktree.json');

/** Why a `copy` entry is refused, or undefined when it is a relative path that stays inside the repository. */
export function copyPathProblem(entry: unknown): string | undefined {
	if (typeof entry !== 'string' || !entry.trim()) {
		return 'not a path';
	}
	if (entry.includes('\0')) {
		return 'not a path';
	}
	// Absolute in either spelling, on any platform: the file is read on a machine other than the one that wrote it.
	if (path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry) || /^[A-Za-z]:/.test(entry) || entry.startsWith('\\') || entry.startsWith('~')) {
		return 'absolute paths are not allowed';
	}
	if (entry.split(/[\\/]+/).some(part => part === '..')) {
		return '".." is not allowed';
	}
	if (entry.split(/[\\/]+/).filter(p => p && p !== '.').length === 0) {
		return 'not a file';
	}
	if (entry.split(/[\\/]+/).includes('.git')) {
		return '.git is not copied';
	}
	return undefined;
}

const commandList = (raw: unknown, name: string, errors: string[]): string[][] => {
	if (raw === undefined) {
		return [];
	}
	if (!Array.isArray(raw)) {
		errors.push(`"${name}" must be a list of commands`);
		return [];
	}
	const out: string[][] = [];
	raw.forEach((c, i) => {
		if (Array.isArray(c) && c.length > 0 && c.every(a => typeof a === 'string' && !a.includes('\0')) && c[0]) {
			out.push(c as string[]);
		} else {
			errors.push(`"${name}"[${i}] must be an argument list such as ["npm", "ci"], not a command line`);
		}
	});
	return out;
};

/** The setup file's text as a config, or every problem found: a half-valid file is not run. */
export function parseSetupConfig(text: string): { config: SetupConfig } | { errors: string[] } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return { errors: [`not valid JSON: ${(e as Error).message}`] };
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { errors: ['the file must hold a JSON object'] };
	}
	const r = raw as Record<string, unknown>;
	const errors: string[] = [];
	const copy: string[] = [];
	if (r.copy !== undefined && !Array.isArray(r.copy)) {
		errors.push('"copy" must be a list of paths');
	}
	for (const [i, e] of (Array.isArray(r.copy) ? r.copy : []).entries()) {
		const problem = copyPathProblem(e);
		if (problem) {
			errors.push(`"copy"[${i}] (${JSON.stringify(e)}): ${problem}`);
		} else {
			copy.push(e as string);
		}
	}
	const config = { copy, setup: commandList(r.setup, 'setup', errors), teardown: commandList(r.teardown, 'teardown', errors) };
	return errors.length ? { errors } : { config };
}

/** The setup file of a main checkout: undefined when there is none. Callers check workspace trust first. */
export async function readSetupConfig(root: string): Promise<{ config: SetupConfig } | { errors: string[] } | undefined> {
	let text: string;
	try {
		text = await fs.readFile(path.join(root, SETUP_FILE), 'utf8');
	} catch {
		return undefined;
	}
	return parseSetupConfig(text);
}

const inside = (base: string, target: string) => {
	const rel = path.relative(base, target);
	return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Copies the listed files from the main checkout into the worktree. Only regular files: a link in the main checkout is
 * not followed, a file the worktree has already (a tracked one) is left alone, and nothing is written outside the
 * worktree even when a folder in it is a link. Returns what was done, a line per entry, for the log.
 */
export async function copyIntoWorktree(root: string, worktree: string, entries: string[]): Promise<string[]> {
	const log: string[] = [];
	const realWorktree = await fs.realpath(worktree);
	for (const entry of entries) {
		const problem = copyPathProblem(entry);
		if (problem) {
			log.push(`copy ${entry}: skipped, ${problem}`);
			continue;
		}
		const from = path.resolve(root, entry);
		const to = path.resolve(worktree, entry);
		if (!inside(path.resolve(root), from) || !inside(path.resolve(worktree), to)) {
			log.push(`copy ${entry}: skipped, outside the repository`);
			continue;
		}
		const st = await fs.lstat(from).catch(() => undefined);
		if (!st) {
			log.push(`copy ${entry}: skipped, not in the main checkout`);
			continue;
		}
		if (!st.isFile()) {
			log.push(`copy ${entry}: skipped, not a regular file`);
			continue;
		}
		await fs.mkdir(path.dirname(to), { recursive: true });
		if (!inside(realWorktree, path.join(await fs.realpath(path.dirname(to)), path.basename(to)))) {
			log.push(`copy ${entry}: skipped, its folder leads out of the worktree`);
			continue;
		}
		try {
			await fs.copyFile(from, to, constants.COPYFILE_EXCL);
			log.push(`copy ${entry}: done`);
		} catch (e) {
			log.push(`copy ${entry}: ${(e as NodeJS.ErrnoException).code === 'EEXIST' ? 'skipped, the worktree has it already' : `failed, ${(e as Error).message}`}`);
		}
	}
	return log;
}

// ── Running commands ─────────────────────────────────────────────────────────────────────────────

export interface Launch {
	file: string;
	args: string[];
	/** For cmd.exe: the one command line is passed as it is. */
	verbatim?: boolean;
}

/** What cmd.exe would still read inside quotes, plus space and shell punctuation, which no shim argument here may hold. */
const CMD_SAFE = /^[\w.:=@/\\,+-]+$/;

/**
 * How to start `argv` without a shell. Elsewhere than Windows that is the command and its arguments. On Windows the
 * command is looked up on PATH with each PATHEXT ending, as a shell would: an .exe/.com runs as it is, a .cmd/.bat goes
 * through cmd.exe, refused (an error string) if any argument could be interpreted by it.
 */
export function launchPlan(argv: string[], platform: NodeJS.Platform, envPath: string, pathext: string | undefined, exists: (file: string) => boolean, comSpec = 'cmd.exe'): Launch | string {
	const [cmd, ...args] = argv;
	if (platform !== 'win32') {
		return { file: cmd, args };
	}
	const w = path.win32;
	const hasDir = /[\\/]/.test(cmd);
	const exts = (pathext || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim().toLowerCase()).filter(Boolean);
	const candidates: string[] = [];
	const names = w.extname(cmd) ? [cmd] : exts.map(e => cmd + e);
	for (const dir of hasDir ? [''] : envPath.split(';').map(d => d.replace(/^"|"$/g, '')).filter(Boolean)) {
		for (const name of names) {
			candidates.push(dir ? w.join(dir, name) : name);
		}
	}
	const file = candidates.find(exists);
	if (!file) {
		return `${cmd} was not found on PATH`;
	}
	const ext = w.extname(file).toLowerCase();
	if (ext === '.exe' || ext === '.com') {
		return { file, args };
	}
	if (ext !== '.cmd' && ext !== '.bat') {
		return `${file} cannot be started without a shell`;
	}
	if (/["%!&|<>^\r\n]/.test(file) || args.some(a => !CMD_SAFE.test(a))) {
		return `${cmd} is a batch file on Windows, which runs through cmd.exe: its arguments may only hold letters, digits and . : = @ / \\ , + - _`;
	}
	return { file: comSpec, args: ['/d', '/s', '/c', `""${file}"${args.map(a => ` ${a}`).join('')}"`], verbatim: true };
}

export interface RunOptions {
	cwd: string;
	log: (line: string) => void;
	timeoutMs?: number;
}

/** Runs one command: no shell, no window, no input; its output goes to `log`. */
export function runCommand(argv: string[], opts: RunOptions): Promise<{ ok: true } | { ok: false; reason: string }> {
	const plan = launchPlan(argv, process.platform, process.env.PATH ?? process.env.Path ?? '', process.env.PATHEXT, existsSync, process.env.ComSpec || 'cmd.exe');
	if (typeof plan === 'string') {
		return Promise.resolve({ ok: false, reason: plan });
	}
	return new Promise(resolve => {
		opts.log(`$ ${argv.join(' ')}`);
		let child;
		try {
			child = spawn(plan.file, plan.args, { cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: plan.verbatim, stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs ?? 15 * 60_000 });
		} catch (e) {
			resolve({ ok: false, reason: (e as Error).message });
			return;
		}
		const forward = (d: Buffer) => d.toString().split(/\r?\n/).filter(Boolean).forEach(opts.log);
		child.stdout.on('data', forward);
		child.stderr.on('data', forward);
		child.on('error', e => resolve({ ok: false, reason: e.message }));
		child.on('close', (code, signal) => resolve(code === 0 ? { ok: true } : { ok: false, reason: signal ? `${argv[0]} was stopped (${signal})` : `${argv.join(' ')} exited with ${code}` }));
	});
}

/** Runs the commands in order and stops at the first failure. */
export async function runCommands(list: string[][], opts: RunOptions): Promise<{ ok: true } | { ok: false; reason: string }> {
	for (const argv of list) {
		const r = await runCommand(argv, opts);
		if (!r.ok) {
			return r;
		}
	}
	return { ok: true };
}

/** After checkout: the copies, then the setup commands, in the worktree. Resolves with the first failure. */
export async function runSetup(root: string, worktree: string, config: SetupConfig, log: (line: string) => void): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		(await copyIntoWorktree(root, worktree, config.copy)).forEach(log);
	} catch (e) {
		return { ok: false, reason: `copying files failed: ${(e as Error).message}` };
	}
	return runCommands(config.setup, { cwd: worktree, log });
}

/** Before removal: the teardown commands, in the worktree. */
export const runTeardown = (worktree: string, config: SetupConfig, log: (line: string) => void) => runCommands(config.teardown, { cwd: worktree, log });
