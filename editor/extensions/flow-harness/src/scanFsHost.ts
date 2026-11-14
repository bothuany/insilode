/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the scan's workspace search (ScanHost, scanCore.ts) done with plain fs, for the headless harness lint
 *  (cli/harness-lint.ts), where there is no editor to ask. Reads only; a symbolic link to a folder is not followed.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import type { ScanFolder, ScanHost } from './scanCore';

/** Folders never entered: version control, dependencies, and the agent worktrees (each a whole checkout of the project). */
const SKIP = new Set(['node_modules', '.git']);
// At any depth, as the editor's search excludes them (the worktrees globs in scan.ts).
const WORKTREES = ['.claude/worktrees', '.insilode/worktrees', '.axle/worktrees'];
/** Build output, skipped only when looking for nested CLAUDE.md / AGENTS.md files (the editor's search does the same). */
const BUILD = new Set(['bin', 'obj']);
/** The files listed for a rule's globs, as the editor's search lists at most. */
const LISTING_LIMIT = 20_000;

/** Files of `root` (relative, with `/`) that `accept` takes, in name order, at most `limit`. */
async function walk(root: string, limit: number, skipBuild: boolean, accept: (rel: string) => boolean): Promise<string[]> {
	const out: string[] = [];
	const visit = async (rel: string): Promise<void> => {
		const entries = (await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name < b.name ? -1 : 1);
		for (const e of entries) {
			if (out.length >= limit) {
				return;
			}
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!SKIP.has(e.name) && !WORKTREES.some(w => child === w || child.endsWith(`/${w}`)) && !(skipBuild && BUILD.has(e.name))) {
					await visit(child);
				}
			} else if (accept(child)) {
				out.push(child);
			}
		}
	};
	await visit('');
	return out;
}

export function fsScanHost(roots: string[]): ScanHost {
	const listings = new Map<string, Promise<string[]>>();
	const listingOf = (root: string) => {
		if (!listings.has(root)) {
			listings.set(root, walk(root, LISTING_LIMIT, false, () => true));
		}
		return listings.get(root)!;
	};
	return {
		nested: async (folder: ScanFolder, limit) => (await walk(folder.fsPath, limit, true, rel => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(rel))).map(rel => path.join(folder.fsPath, rel)),
		listing: async (folder, limit) => (await listingOf(folder.fsPath)).slice(0, limit),
		somewhere: async ref => {
			const lists = await Promise.all(roots.map(listingOf));
			// A listing that hit its limit may have left the file out: no verdict, so no finding.
			return lists.some(l => l.length >= LISTING_LIMIT || l.some(f => f === ref || f.endsWith(`/${ref}`)));
		},
	};
}
