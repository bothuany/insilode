/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the scan's workspace search (ScanHost, scanCore.ts) done with plain fs, for the headless harness lint
 *  (cli/harness-lint.ts), where there is no editor to ask. Reads only; a symbolic link to a folder is not followed.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, type Dirent } from 'fs';
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

/** The most entries read from one folder, the most entries a walk looks at, and how deep it goes: a folder may hold anything, and `readdir` reads a whole folder in one call nobody can interrupt. */
const DIR_ENTRIES = 5000;
const WALK_ENTRIES = 200_000;
const MAX_DEPTH = 64;

/** The entries of one folder, at most DIR_ENTRIES, in name order. */
async function entriesOf(dir: string): Promise<Dirent[]> {
	const handle = await fs.opendir(dir).catch(() => undefined);
	const out: Dirent[] = [];
	try {
		for (let e = await handle?.read(); e; e = out.length < DIR_ENTRIES ? await handle?.read() : null) {
			out.push(e);
		}
	} catch {
		// A folder that goes away while it is listed: what was read is the list.
	} finally {
		await handle?.close().catch(() => undefined);
	}
	return out.sort((a, b) => a.name < b.name ? -1 : 1);
}

/** Files of `root` (relative, with `/`) that `accept` takes, in name order, at most `limit`; none read after `deadline` (epoch ms) passed. A link to a folder is not entered (a listing entry that is a link is a file, as `Dirent` says). */
async function walk(root: string, limit: number, skipBuild: boolean, accept: (rel: string) => boolean, deadline = Infinity): Promise<string[]> {
	const out: string[] = [];
	let seen = 0;
	const visit = async (rel: string, depth: number): Promise<void> => {
		if (Date.now() > deadline) {
			return;
		}
		for (const e of await entriesOf(path.join(root, rel))) {
			if (out.length >= limit || Date.now() > deadline || ++seen > WALK_ENTRIES) {
				return;
			}
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (depth < MAX_DEPTH && !SKIP.has(e.name) && !WORKTREES.some(w => child === w || child.endsWith(`/${w}`)) && !(skipBuild && BUILD.has(e.name))) {
					await visit(child, depth + 1);
				}
			} else if (accept(child)) {
				out.push(child);
			}
		}
	};
	await visit('', 0);
	return out;
}

/** `deadline`: a time (epoch ms) after which the folder walks stop and answer with what they have (a summary of a huge folder must come back in time); the lint has none. */
export function fsScanHost(roots: string[], deadline = Infinity): ScanHost {
	const listings = new Map<string, Promise<string[]>>();
	const listingOf = (root: string) => {
		if (!listings.has(root)) {
			// A walk the deadline cut answers a list of the full length (padded with empty names), which is how callers tell a cut list: no verdict from it.
			listings.set(root, walk(root, LISTING_LIMIT, false, () => true, deadline).then(l => Date.now() > deadline ? l.concat(new Array<string>(Math.max(0, LISTING_LIMIT - l.length)).fill('')) : l));
		}
		return listings.get(root)!;
	};
	return {
		nested: async (folder: ScanFolder, limit) => (await walk(folder.fsPath, limit, true, rel => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(rel), deadline)).map(rel => path.join(folder.fsPath, rel)),
		listing: async (folder, limit) => (await listingOf(folder.fsPath)).slice(0, limit),
		somewhere: async ref => {
			const lists = await Promise.all(roots.map(listingOf));
			// A listing that hit its limit may have left the file out: no verdict, so no finding.
			return lists.some(l => l.length >= LISTING_LIMIT || l.some(f => f === ref || f.endsWith(`/${ref}`)));
		},
	};
}
