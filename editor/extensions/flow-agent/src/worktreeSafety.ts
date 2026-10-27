/*---------------------------------------------------------------------------------------------
 *  Insilode: what makes removing an agent worktree safe, without vscode so node tests run it:
 *  - links: `git worktree remove --force` on Git for Windows follows an NTFS junction (or a symlink) and deletes what it
 *    points at (it once emptied the main checkout's node_modules). Every link inside the worktree is unlinked, without
 *    following any, and checked to be gone before git is let near the folder (as .claude/hooks/implementer-gate.mjs does);
 *  - cleanup: classifying a worktree as done or not, and the second look at every guard just before it is deleted.
 *--------------------------------------------------------------------------------------------*/

import { promises as nodeFs } from 'fs';
import * as path from 'path';

// ── Links ────────────────────────────────────────────────────────────────────────────────────────

export interface DirEntry {
	name: string;
	/** A real directory (a link to one is not). */
	isDir: boolean;
	/** A symlink or an NTFS junction (Node reports a junction as a symlink on Windows). */
	isLink: boolean;
}

/** The file system calls the link walk needs, so tests can lay out a tree of their own. */
export interface LinkFs {
	readdir(dir: string): Promise<DirEntry[]>;
	/** Removes the link itself, never what it points at. */
	unlinkLink(file: string): Promise<void>;
}

/** The real thing: lstat-based, so a link is never followed. */
export const realLinkFs: LinkFs = {
	async readdir(dir) {
		const entries = await nodeFs.readdir(dir, { withFileTypes: true });
		const out: DirEntry[] = [];
		for (const e of entries) {
			// lstat confirms what the listing says: it never follows, and a junction may be listed as a plain directory.
			const st = await nodeFs.lstat(path.join(dir, e.name));
			out.push({ name: e.name, isLink: st.isSymbolicLink(), isDir: st.isDirectory() });
		}
		return out;
	},
	async unlinkLink(file) {
		// A directory link (junction) goes with rmdir, a file symlink with unlink: both remove only the link. Which one fits
		// depends on the platform, so the other is the fallback.
		const win = process.platform === 'win32';
		try {
			await (win ? nodeFs.rmdir(file) : nodeFs.unlink(file));
		} catch {
			await (win ? nodeFs.unlink(file) : nodeFs.rmdir(file));
		}
	},
};

/** Every link under `dir`, without following any link and without looking at the worktree's own `.git` entry. */
export async function findLinks(dir: string, fs: LinkFs = realLinkFs, top = true): Promise<string[]> {
	const found: string[] = [];
	for (const e of await fs.readdir(dir)) {
		const file = path.join(dir, e.name);
		if (top && e.name === '.git' && !e.isLink) {
			continue; // a file in a worktree: it points at the repository's metadata, and git needs it
		}
		if (e.isLink) {
			found.push(file);
		} else if (e.isDir) {
			found.push(...await findLinks(file, fs, false));
		}
	}
	return found;
}

/** Unlinks every link in the worktree, then looks again: throws (naming one) unless none is left. */
export async function unlinkAll(dir: string, fs: LinkFs = realLinkFs): Promise<number> {
	const links = await findLinks(dir, fs);
	for (const link of links) {
		await fs.unlinkLink(link);
	}
	const left = await findLinks(dir, fs);
	if (left.length) {
		throw new Error(`${left[0]} is still a link; not removing the worktree`);
	}
	return links.length;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────────────────────────

/** What is known about one worktree, read from git and the dock. */
export interface WorktreeFacts {
	/** The branch tip, so a commit made after the list was shown is noticed. */
	head: string;
	/** The branch is contained in the default branch (also in its remote copy). */
	merged: boolean;
	/** Its upstream branch is gone after `fetch --prune`: what a squash- or rebase-merged PR leaves behind. */
	remoteGone: boolean;
	/** Commits on the branch that the default branch does not have. */
	ahead: number;
	/** Commits that exist on no remote branch and not in the default branch: the only copy of that work. */
	unpushed: number;
	/** Uncommitted changes (files) in the worktree; undefined when its status cannot be read. */
	dirty: number | undefined;
	/** A live agent session is attached to it. */
	live: boolean;
	/** Age of the last commit, in days. */
	ageDays: number;
}

/** What stops a worktree from being removed now: empty means every guard holds. */
export function blockers(f: WorktreeFacts): string[] {
	const out: string[] = [];
	if (f.live) {
		out.push('an agent session is still attached');
	}
	if (f.dirty === undefined) {
		out.push('its status cannot be read');
	} else if (f.dirty > 0) {
		out.push(`${f.dirty} uncommitted ${f.dirty === 1 ? 'change' : 'changes'}`);
	}
	if (!f.merged && !f.remoteGone && f.unpushed > 0) {
		out.push(`${f.unpushed} ${f.unpushed === 1 ? 'commit is' : 'commits are'} not merged or pushed`);
	}
	return out;
}

export type WorktreeState = 'merged' | 'remote gone' | 'unmerged';

export interface Classified {
	state: WorktreeState;
	blockers: string[];
	/** Pre-picked in the list: it is done and nothing guards it. */
	safe: boolean;
}

export function classify(f: WorktreeFacts): Classified {
	const state: WorktreeState = f.merged ? 'merged' : f.remoteGone ? 'remote gone' : 'unmerged';
	const b = blockers(f);
	return { state, blockers: b, safe: state !== 'unmerged' && b.length === 0 };
}

/** The decision made right before deleting: the facts as they are now against the ones the user was shown. */
export function recheck(shown: WorktreeFacts, now: WorktreeFacts): { ok: true } | { ok: false; reason: string } {
	const b = blockers(now);
	if (b.length) {
		return { ok: false, reason: b.join(', ') };
	}
	if (now.head !== shown.head) {
		return { ok: false, reason: 'a commit was made since the list was shown' };
	}
	return { ok: true };
}
