/*---------------------------------------------------------------------------------------------
 *  Insilode: a git worktree per agent. An agent started "in a worktree" gets its own checkout and its
 *  own branch, so two agents never write over each other's files. The worktrees live inside the
 *  repository, at <repo>/.insilode/worktrees/<slug>, on branch insilode/<slug>:
 *  - inside a workspace folder, so flow-view's diff and flow tools (which only read files of this
 *    window's folders) can show a worktree's changes, and the path is predictable;
 *  - git-ignored through the repository's own info/exclude (never the user's tracked .gitignore),
 *    which keeps them out of `git status`, VS Code's search and Insilode's code index (it asks git
 *    which paths are ignored), so the index does not list every symbol twice.
 *  This file only builds git argument arrays, parses git's output and runs git without a shell;
 *  it never imports vscode, so node tests run it against real repositories.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { unlinkAll } from './worktreeSafety';

/** What a session started in a worktree remembers about it. */
export interface Worktree {
	/** The worktree's folder (absolute). */
	path: string;
	/** The branch the agent works on, e.g. insilode/claude-3f9a. */
	branch: string;
	/** The branch it was cut from and merges back into, e.g. main. */
	base: string;
	/** The main checkout it belongs to. */
	root: string;
}

/**
 * Steps the vscode side adds around a worktree's life (worktreeCleanup.ts: the repository's setup file, which needs the
 * workspace trust and dialogs), so this file stays free of vscode and agents.ts keeps calling the same two functions.
 */
export const worktreeHooks: {
	/** After `git worktree add`, before the agent starts. Throwing stops the start and the worktree is removed again. */
	created?: (wt: Worktree) => Promise<void>;
	/** Before removal. A failure is the hook's to report; removal goes on. */
	beforeRemove?: (wt: Worktree) => Promise<void>;
} = {};

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** The folder under a repository's root that holds Insilode's worktrees, and the line that git-ignores it. */
export const WORKTREE_DIR = path.join('.insilode', 'worktrees');
export const EXCLUDE_LINE = '/.insilode/worktrees/';

/** A branch-safe slug: lower case letters, digits and dashes, at most 40 characters. */
export function slugify(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/** `claude-3f9a`: the agent and a short random part, so two agents started together never collide. */
export function worktreeSlug(cli: string, random: string): string {
	return slugify(`${cli}-${random}`) || `agent-${slugify(random)}`;
}

export const branchFor = (slug: string) => `insilode/${slug}`;
export const worktreePath = (root: string, slug: string) => path.join(root, WORKTREE_DIR, slug);

/**
 * A branch name git accepts and that cannot be read as an option: what `git check-ref-format --branch` allows, minus the
 * rarely used characters. Checked before any name reaches git, also names read back from Insilode's own saved list.
 */
export function validBranch(name: string): boolean {
	return /^[A-Za-z0-9._/-]{1,200}$/.test(name) && !name.startsWith('-') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.')
		&& !name.endsWith('.lock') && !name.includes('..') && !name.includes('//') && !name.split('/').some(p => p.startsWith('.'));
}

function branch(name: string) {
	if (!validBranch(name)) {
		throw new Error(`"${name}" is not a branch name Insilode uses`);
	}
	return name;
}

// ── Argument arrays: the only git command lines this feature runs ───────────────────────────────

export const addArgs = (dir: string, newBranch: string, base: string) => ['worktree', 'add', '-b', branch(newBranch), dir, branch(base)];
/** `--force` only after the user confirmed a second time that the uncommitted changes go. */
export const removeArgs = (dir: string, force: boolean) => ['worktree', 'remove', ...(force ? ['--force'] : []), dir];
/** Left is the base, right is the branch: git prints "<behind>\t<ahead>". */
export const aheadBehindArgs = (base: string, of = 'HEAD') => ['rev-list', '--left-right', '--count', `${branch(base)}...${of === 'HEAD' ? 'HEAD' : branch(of)}`];
export const statusArgs = () => ['status', '--porcelain', '-z'];
export const currentBranchArgs = () => ['symbolic-ref', '--quiet', '--short', 'HEAD'];
export const isAncestorArgs = (base: string, of: string) => ['merge-base', '--is-ancestor', branch(base), branch(of)];
/** Merges in memory, touching no file: exit 1 and the conflicting paths when it would not merge cleanly (git 2.38+). */
export const mergeTreeArgs = (base: string, of: string) => ['merge-tree', '--write-tree', '--name-only', '--no-messages', branch(base), branch(of)];
export const fastForwardArgs = (of: string) => ['merge', '--ff-only', branch(of)];
export const mergeArgs = (of: string, message: string) => ['merge', '--no-ff', '--no-edit', '-m', message, branch(of)];
export const abortMergeArgs = () => ['merge', '--abort'];
export const commonDirArgs = () => ['rev-parse', '--path-format=absolute', '--git-common-dir'];
export const topLevelArgs = () => ['rev-parse', '--show-toplevel'];

// ── Parsing ──────────────────────────────────────────────────────────────────────────────────────

/** `git rev-list --left-right --count base...HEAD`: the base side comes first, so the first number is how far behind. */
export function parseAheadBehind(out: string): { ahead: number; behind: number } | undefined {
	const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(out);
	return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : undefined;
}

/** The paths `git status --porcelain -z` lists (a rename's old path, which follows it, is skipped). */
export function parseStatus(out: string): string[] {
	const parts = out.split('\0');
	const files: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const e = parts[i];
		if (e.length < 4) {
			continue;
		}
		files.push(e.slice(3));
		if (e[0] === 'R' || e[0] === 'C') {
			i++;
		}
	}
	return files;
}

/** `git merge-tree --write-tree --name-only --no-messages`: exit 0 is clean; exit 1 lists the conflicted paths after the tree id. */
export function parseMergeTree(code: number, out: string): { clean: boolean; conflicts: string[] } | undefined {
	if (code !== 0 && code !== 1) {
		return undefined; // an older git without --write-tree, or an error: the caller falls back to a real merge it can abort
	}
	const lines = out.split('\n').map(l => l.trim());
	const conflicts = [...new Set(lines.slice(1).filter(Boolean))];
	return { clean: code === 0, conflicts };
}

export interface WorktreeEntry {
	path: string;
	branch?: string;
	head?: string;
	bare?: boolean;
	detached?: boolean;
}

/** `git worktree list --porcelain`: blocks of lines separated by an empty one. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
	const list: WorktreeEntry[] = [];
	for (const block of out.replace(/\r/g, '').split('\n\n')) {
		const e: Partial<WorktreeEntry> = {};
		for (const line of block.split('\n')) {
			const sp = line.indexOf(' ');
			const key = sp < 0 ? line : line.slice(0, sp);
			const value = sp < 0 ? '' : line.slice(sp + 1);
			if (key === 'worktree') {
				e.path = value;
			} else if (key === 'branch') {
				e.branch = value.replace(/^refs\/heads\//, '');
			} else if (key === 'HEAD') {
				e.head = value;
			} else if (key === 'bare') {
				e.bare = true;
			} else if (key === 'detached') {
				e.detached = true;
			}
		}
		if (e.path) {
			list.push(e as WorktreeEntry);
		}
	}
	return list;
}

/** The comment Insilode writes above its exclude line. */
const EXCLUDE_NOTE = '# Insilode: agent worktrees (see flow-agent/src/worktrees.ts)';
/** What Insilode excluded before .insilode/worktree.json existed: all of .insilode, which kept that file out of the repository. */
const OLD_EXCLUDE_LINE = '/.insilode/';

/**
 * The exclude file with Insilode's line added, or undefined when it is there already. Only the worktrees are excluded, so
 * the setup file next to them (.insilode/worktree.json) can be committed and shared. The line older versions wrote under
 * Insilode's note (all of .insilode) is narrowed to the worktrees; a line you wrote yourself is left as it is.
 */
export function withExclude(text: string): string | undefined {
	const lines = text.split(/\r?\n/);
	const trimmed = lines.map(l => l.trim());
	if (trimmed.includes(EXCLUDE_LINE)) {
		return undefined;
	}
	const old = trimmed.findIndex((l, i) => l === OLD_EXCLUDE_LINE && trimmed[i - 1] === EXCLUDE_NOTE);
	if (old >= 0) {
		lines[old] = EXCLUDE_LINE;
		return lines.join('\n');
	}
	if (trimmed.includes('.insilode/') || trimmed.includes('/.insilode') || trimmed.includes('.insilode') || trimmed.includes(OLD_EXCLUDE_LINE)) {
		return undefined;
	}
	const sep = text && !text.endsWith('\n') ? '\n' : '';
	return `${text}${sep}${EXCLUDE_NOTE}\n${EXCLUDE_LINE}\n`;
}

// ── Running git ──────────────────────────────────────────────────────────────────────────────────

/**
 * Runs git with an argument array, never a shell, no window and no prompt: a credential or editor prompt would hang a
 * command nobody can see. Resolves with the exit code; it never throws for a non-zero exit.
 */
export function git(cwd: string, args: string[], timeout = 30_000): Promise<GitResult> {
	return new Promise(resolve => {
		execFile('git', args, {
			cwd, timeout, windowsHide: true, maxBuffer: 8 << 20,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' },
		}, (err, stdout, stderr) => {
			const code = err ? typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1 : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && code === -1 ? err.message : '')) });
		});
	});
}

const firstLine = (r: GitResult) => (r.stderr || r.stdout).trim().split('\n')[0] || `git exited with ${r.code}`;

/** The repository's top folder and its current branch, or a reason it has none (not a repo, a detached HEAD). */
export async function repoInfo(cwd: string): Promise<{ root: string; branch: string } | string> {
	const top = await git(cwd, topLevelArgs());
	if (top.code !== 0) {
		return 'this folder is not a git repository';
	}
	const head = await git(cwd, currentBranchArgs());
	const name = head.stdout.trim();
	if (head.code !== 0 || !name) {
		return 'HEAD is detached: check out a branch first';
	}
	if (!validBranch(name)) {
		return `the branch "${name}" has a name Insilode does not pass to git`;
	}
	return { root: path.normalize(top.stdout.trim()), branch: name };
}

/** Two spellings of one folder: git prints C:/x/y, VS Code c:\x\y, and Windows ignores case. */
export function sameDir(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
	const p = platform === 'win32' ? path.win32 : path.posix;
	const n = (x: string) => {
		const r = p.resolve(x).replace(/[\\/]+$/, '');
		return platform === 'win32' ? r.toLowerCase() : r;
	};
	return n(a) === n(b);
}

/** Adds Insilode's line to <common git dir>/info/exclude, so every worktree of the repository ignores .insilode too. */
export async function ensureExcluded(root: string): Promise<void> {
	const common = await git(root, commonDirArgs());
	if (common.code !== 0) {
		throw new Error(firstLine(common));
	}
	const file = path.join(path.resolve(root, common.stdout.trim()), 'info', 'exclude');
	const text = await fs.readFile(file, 'utf8').catch(() => '');
	const next = withExclude(text);
	if (next !== undefined) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, next);
	}
}

/** Creates a worktree for a new agent: ignores .insilode, then `git worktree add -b insilode/<slug> <dir> <base>`. */
export async function createWorktree(cwd: string, slug: string): Promise<Worktree> {
	const info = await repoInfo(cwd);
	if (typeof info === 'string') {
		throw new Error(info);
	}
	// A folder below the repository's top would put the worktree (a copy of the whole repository) outside this window's
	// folder, where neither the dock's conflict check nor flow-view's diff can see it: refused, with the reason.
	// Compared by real path: Windows may hand out a short 8.3 name (C:\Users\RUNNER~1) where git prints the long one, and
	// macOS's /var is a link to /private/var, so the same folder can be spelled two ways that no string compare equates.
	const real = (x: string) => fs.realpath(x).catch(() => x);
	if (!sameDir(await real(cwd), await real(info.root))) {
		throw new Error(`this folder is inside the repository ${info.root}; open that folder to start agents in worktrees`);
	}
	const dir = worktreePath(info.root, slug);
	const newBranch = branchFor(slug);
	await ensureExcluded(info.root);
	await fs.mkdir(path.dirname(dir), { recursive: true });
	const r = await git(info.root, addArgs(dir, newBranch, info.branch), 120_000);
	if (r.code !== 0) {
		throw new Error(firstLine(r));
	}
	const wt = { path: dir, branch: newBranch, base: info.branch, root: info.root };
	if (worktreeHooks.created) {
		try {
			await worktreeHooks.created(wt);
		} catch (e) {
			await removeWorktree(wt, true, { skipTeardown: true }); // a failed setup is no reason to run teardown commands; no half-made worktree is left behind; its branch stays, empty of work
			throw e;
		}
	}
	return wt;
}

export async function aheadBehind(wt: Worktree): Promise<{ ahead: number; behind: number } | undefined> {
	const r = await git(wt.path, aheadBehindArgs(wt.base));
	return r.code === 0 ? parseAheadBehind(r.stdout) : undefined;
}

export async function changedFiles(dir: string): Promise<string[] | undefined> {
	const r = await git(dir, statusArgs());
	return r.code === 0 ? parseStatus(r.stdout) : undefined;
}

/** What a merge back would do, worked out before asking the user; nothing is changed here. */
export type MergePlan =
	| { kind: 'refuse'; reason: string }
	| { kind: 'nothing' }
	| { kind: 'fast-forward' | 'merge'; ahead: number; uncommitted: number };

export async function planMerge(wt: Worktree): Promise<MergePlan> {
	const main = await repoInfo(wt.root);
	if (typeof main === 'string') {
		return { kind: 'refuse', reason: `the main checkout: ${main}` };
	}
	if (main.branch !== wt.base) {
		return { kind: 'refuse', reason: `the main checkout is on ${main.branch}, not ${wt.base}. Check out ${wt.base} there first.` };
	}
	// Untracked files do not stop a merge unless it would overwrite them, which git checks itself.
	const tracked = await git(wt.root, [...statusArgs(), '--untracked-files=no']);
	const dirty = parseStatus(tracked.stdout).length;
	if (tracked.code !== 0 || dirty) {
		return { kind: 'refuse', reason: tracked.code !== 0 ? firstLine(tracked) : `the main checkout has uncommitted changes (${dirty} file${dirty === 1 ? '' : 's'}). Commit or stash them first, then merge.` };
	}
	const counts = await git(wt.root, aheadBehindArgs(wt.base, wt.branch));
	const ab = parseAheadBehind(counts.stdout);
	if (!ab) {
		return { kind: 'refuse', reason: firstLine(counts) };
	}
	const uncommitted = (await changedFiles(wt.path))?.length ?? 0;
	if (!ab.ahead) {
		return { kind: 'nothing' };
	}
	if ((await git(wt.root, isAncestorArgs(wt.base, wt.branch))).code === 0) {
		return { kind: 'fast-forward', ahead: ab.ahead, uncommitted };
	}
	const check = await git(wt.root, mergeTreeArgs(wt.base, wt.branch));
	const parsed = parseMergeTree(check.code, check.stdout);
	if (parsed && !parsed.clean) {
		const list = parsed.conflicts.slice(0, 8).join(', ') + (parsed.conflicts.length > 8 ? ` and ${parsed.conflicts.length - 8} more` : '');
		return { kind: 'refuse', reason: `${wt.branch} conflicts with ${wt.base} in ${list || 'some files'}. Resolve it in the worktree (merge ${wt.base} into ${wt.branch} there), then merge back.` };
	}
	return { kind: 'merge', ahead: ab.ahead, uncommitted };
}

/** Runs the merge the plan described, in the main checkout. A merge that stops on a conflict is aborted: no half-merged tree is left. */
export async function merge(wt: Worktree, kind: 'fast-forward' | 'merge'): Promise<{ ok: true } | { ok: false; reason: string }> {
	const r = await git(wt.root, kind === 'fast-forward' ? fastForwardArgs(wt.branch) : mergeArgs(wt.branch, `Merge ${wt.branch} (Insilode agent worktree)`), 120_000);
	if (r.code === 0) {
		return { ok: true };
	}
	if (kind === 'merge') {
		await git(wt.root, abortMergeArgs());
	}
	return { ok: false, reason: `${firstLine(r)}${kind === 'merge' ? ' (the merge was aborted; nothing changed)' : ''}` };
}

/** Why a plain (not forced) removal is refused up front: git refuses a worktree with changes, so nothing may run before. */
export function removalRefusal(changed: string[] | undefined): string | undefined {
	return changed?.length ? `the worktree has ${changed.length} uncommitted change${changed.length === 1 ? '' : 's'}` : undefined;
}

/**
 * Removes the worktree folder: the teardown commands first, then every link in it is unlinked and checked to be gone,
 * and only then git deletes the folder. `git worktree remove --force` on Git for Windows follows junctions and symlinks
 * and deletes what they point at (the main checkout's node_modules once); see worktreeSafety.ts.
 */
export async function removeWorktree(wt: Worktree, force: boolean, opts: { skipTeardown?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
	// Git would refuse a plain removal of a dirty worktree after the teardown has run and the links are gone: ask first.
	if (!force) {
		const refusal = removalRefusal(await changedFiles(wt.path));
		if (refusal) {
			return { ok: false, reason: refusal };
		}
	}
	if (!opts.skipTeardown) {
		await worktreeHooks.beforeRemove?.(wt).catch(() => undefined);
	}
	try {
		await unlinkAll(wt.path);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
			return { ok: false, reason: (e as Error).message };
		}
	}
	const r = await git(wt.root, removeArgs(wt.path, force), 60_000);
	return r.code === 0 ? { ok: true } : { ok: false, reason: firstLine(r) };
}
