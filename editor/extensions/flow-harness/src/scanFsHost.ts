/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the scan's workspace search (ScanHost, scanCore.ts) done with plain fs, for the headless harness lint
 *  (cli/harness-lint.ts), where there is no editor to ask. Reads only; a symbolic link to a folder is not followed.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { listEntries } from './listEntries';
import type { ScanFolder, ScanHost } from './scanCore';

/** Folders never entered: version control, dependencies, and the agent worktrees (each a whole checkout of the project). */
const SKIP = new Set(['node_modules', '.git']);
// At any depth, as the editor's search excludes them (the worktrees globs in scan.ts).
const WORKTREES = ['.claude/worktrees', '.insilode/worktrees', '.axle/worktrees'];
/** Build output, skipped only when looking for nested CLAUDE.md / AGENTS.md files (the editor's search does the same). */
const BUILD = new Set(['bin', 'obj']);
/** The files listed for a rule's globs, as the editor's search lists at most. */
const LISTING_LIMIT = 20_000;

/** What a scan of a folder nobody trusted reads at most: entries of one folder (`readdir` reads a whole folder in one call nobody can interrupt), entries of a walk, and how deep it goes. A trusted scan has none of these. */
const DIR_ENTRIES = 5000;
const WALK_ENTRIES = 200_000;
const MAX_DEPTH = 64;

/** Files of `root` (relative, with `/`) that `accept` takes, in name order, at most `limit`; none read after `deadline` (epoch ms) passed. A link to a folder is not entered (a listing entry that is a link is a file, as `Dirent` says). `cut` is told what an untrusted walk left out. */
async function walk(root: string, limit: number, skipBuild: boolean, accept: (rel: string) => boolean, deadline = Infinity, cut?: (why: string) => void): Promise<string[]> {
	const out: string[] = [];
	let seen = 0;
	const visit = async (rel: string, depth: number): Promise<void> => {
		if (Date.now() > deadline) {
			return;
		}
		for (const e of await listEntries(path.join(root, rel), cut ? DIR_ENTRIES : Infinity, () => cut?.(`A folder has more than ${DIR_ENTRIES} entries, so only the first ${DIR_ENTRIES} were read.`))) {
			if (out.length >= limit || Date.now() > deadline) {
				return;
			}
			if (cut && ++seen > WALK_ENTRIES) {
				cut(`The folder has more than ${WALK_ENTRIES} files and folders, so only part of it was searched.`);
				return;
			}
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				if (!SKIP.has(e.name) && !WORKTREES.some(w => child === w || child.endsWith(`/${w}`)) && !(skipBuild && BUILD.has(e.name))) {
					if (!cut || depth < MAX_DEPTH) {
						await visit(child, depth + 1);
					} else {
						cut(`A folder is more than ${MAX_DEPTH} levels deep, so what lies below was not searched.`);
					}
				}
			} else if (accept(child)) {
				out.push(child);
			}
		}
	};
	await visit('', 0);
	return out;
}

/**
 * `deadline`: a time (epoch ms) after which the folder walks stop and answer with what they have (a summary of a huge folder must come back in time); the lint has none.
 * `untrusted`: the folder is one nobody opened, so the walks are capped (see DIR_ENTRIES); a cut is recorded for `limits` and makes the listing look cut (see below).
 */
export function fsScanHost(roots: string[], deadline = Infinity, untrusted = false): ScanHost {
	const listings = new Map<string, Promise<string[]>>();
	const cuts = new Set<string>();
	const record = (why: string) => void cuts.add(why);
	const listingOf = (root: string) => {
		if (!listings.has(root)) {
			// A walk the deadline or a cap cut answers a list of the full length (padded with empty names), which is how callers tell a cut list: no verdict from it.
			let short = false;
			listings.set(root, walk(root, LISTING_LIMIT, false, () => true, deadline, untrusted ? why => { short = true; record(why); } : undefined).then(l => Date.now() > deadline || short ? l.concat(new Array<string>(Math.max(0, LISTING_LIMIT - l.length)).fill('')) : l));
		}
		return listings.get(root)!;
	};
	return {
		nested: async (folder: ScanFolder, limit) => (await walk(folder.fsPath, limit, true, rel => /(^|\/)(CLAUDE|AGENTS)\.md$/.test(rel), deadline, untrusted ? record : undefined)).map(rel => path.join(folder.fsPath, rel)),
		listing: async (folder, limit) => (await listingOf(folder.fsPath)).slice(0, limit),
		somewhere: async ref => {
			const lists = await Promise.all(roots.map(listingOf));
			// A listing that hit its limit may have left the file out: no verdict, so no finding.
			return lists.some(l => l.length >= LISTING_LIMIT || l.some(f => f === ref || f.endsWith(`/${ref}`)));
		},
		limits: () => [...cuts],
	};
}
