/*---------------------------------------------------------------------------------------------
 *  Insilode: edits an agent made through a shell command (sed, a formatter, a generator), which no edit tool reports.
 *  At the end of a turn, `git status --porcelain` (an argument array, never a shell) is compared with the status at the
 *  turn's start: files that changed in between and that no edit tool named are reported to flow-view as "changed by a
 *  command". The pure part (diffing two status lists, merging into a turn) lives apart from the process call, with tests.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { dirtyPaths, diffStatus, isInsilodePath, mergeIntoTurn, MAX_DIRTY, parsePorcelain, type FileSig } from './shellEditsCore';

/** A git that does not answer in this long is not asked again this turn: the sweep must never hold the turn back. */
const GIT_TIMEOUT_MS = 5000;
/** `git status` output beyond this is a repository with far more dirty files than the sweep can read. */
const GIT_MAX_OUTPUT = 4 << 20;
/** Only files this small are hashed; for the rest size and mtime say whether they changed. */
const HASH_MAX_BYTES = 1 << 20;
/** All hashing of one snapshot reads at most this much, so a thousand dirty files cost a bounded read. */
const HASH_BUDGET_BYTES = 32 << 20;

/** Runs git with an argument array; undefined when it is missing, times out, fails (not a repository) or prints too much. */
function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_OUTPUT, windowsHide: true, encoding: 'utf8' }, (err, stdout) => resolve(err ? undefined : stdout));
	});
}

interface Snapshot {
	/** The repository's top folder: porcelain paths are relative to it, whatever folder the agent works in. */
	root: string;
	files: Map<string, FileSig>;
}

/**
 * The dirty files of the repository `cwd` is in, each with what is needed to tell later whether it changed. Undefined when
 * there is no repository or more than `max` files are dirty: a list cut at the cap would shift between two looks, and the
 * files pushed past the cut would be reported as new.
 */
async function takeSnapshot(cwd: string, max: number): Promise<Snapshot | undefined> {
	const top = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim();
	// --untracked-files=all lists each new file, not just the folder it is in.
	const status = top ? await git(top, ['status', '--porcelain', '-z', '--untracked-files=all']) : undefined;
	if (!top || status === undefined) {
		return undefined;
	}
	const root = path.resolve(top);
	const files = new Map<string, FileSig>();
	let budget = HASH_BUDGET_BYTES;
	const dirty = dirtyPaths(parsePorcelain(status));
	if (dirty.length > max) {
		return undefined;
	}
	for (const rel of dirty) {
		if (isInsilodePath(rel)) {
			continue;
		}
		const abs = path.resolve(root, rel);
		try {
			const stat = await fs.stat(abs);
			if (!stat.isFile()) {
				continue; // a submodule or a folder: not something to review as text
			}
			const sig: FileSig = { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
			if (stat.size <= HASH_MAX_BYTES && stat.size <= budget) {
				budget -= stat.size;
				sig.hash = createHash('sha1').update(await fs.readFile(abs)).digest('hex').slice(0, 16);
			}
			files.set(abs, sig);
		} catch (e) {
			// A deleted or renamed-away file is a change like any other; one that cannot be read right now is left out.
			if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
				files.set(abs, { exists: false, size: 0, mtimeMs: 0 });
			}
		}
	}
	return { root, files };
}

/** Remembers each session's git status at the start of its turn and lists what a command changed by the end of it. */
export class ShellEditSweep {
	private readonly started = new Map<string, Snapshot>();

	/** `maxDirty`: more dirty files than this at either look means no sweep for the turn (tests lower it). */
	constructor(private readonly maxDirty = MAX_DIRTY) { }

	/** Records the status at the start of the turn. Never throws; without a repository nothing is recorded. */
	async begin(session: string, cwd: string | undefined): Promise<void> {
		this.started.delete(session);
		if (!cwd) {
			return;
		}
		try {
			const snap = await takeSnapshot(cwd, this.maxDirty);
			if (snap) {
				this.started.set(session, snap);
			}
		} catch {
			// a sweep that fails is a turn without the extra list
		}
	}

	/** The files changed during the turn that no edit tool named (`reported` is what the tools named), absolute, at most 40. */
	async end(session: string, cwd: string | undefined, reported: ReadonlySet<string>): Promise<string[]> {
		const before = this.started.get(session);
		this.started.delete(session);
		if (!before || !cwd) {
			return [];
		}
		try {
			const after = await takeSnapshot(cwd, this.maxDirty);
			// Another repository (the agent moved into a worktree): the two statuses are not comparable.
			if (!after || after.root !== before.root) {
				return [];
			}
			return mergeIntoTurn(reported, diffStatus(before.files, after.files));
		} catch {
			return [];
		}
	}
}
