/*---------------------------------------------------------------------------------------------
 *  Insilode: the pure part of the shell-edit sweep (shellEdits.ts). `git status --porcelain -z` is parsed, two
 *  statuses are compared, and what an edit tool already reported is taken out. No vscode, no fs, no process: it is
 *  tested on its own (test/shell-edits.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** At most this many files are reported for one turn: a formatter over the whole repository is not a review. */
export const MAX_SWEPT = 40;
/** Dirty files recorded per snapshot; a status longer than this is a repository nobody can review file by file. */
export const MAX_DIRTY = 2000;

/** One line of `git status --porcelain -z`. Paths are relative to the repository root. */
export interface PorcelainEntry {
	/** The two status letters, index then worktree ("??" for an untracked file). */
	xy: string;
	path: string;
	/** A rename's (or copy's) old path. */
	from?: string;
	untracked: boolean;
	deleted: boolean;
}

/**
 * Parses `git status --porcelain -z`: entries end in NUL and paths are never quoted, so a name with spaces or an arrow
 * in it arrives as it is. A rename or copy is "XY new" followed by the old path as the next field (the order of -z; the
 * "old -> new" spelling belongs to the human format and is not parsed, since a file may be called that).
 */
export function parsePorcelain(text: string): PorcelainEntry[] {
	const fields = text.split('\0');
	const out: PorcelainEntry[] = [];
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i];
		// "XY path": two letters, a space, then the path; anything shorter is the empty field after the last NUL.
		if (f.length < 4 || f[2] !== ' ') {
			continue;
		}
		const xy = f.slice(0, 2);
		const entry: PorcelainEntry = { xy, path: f.slice(3), untracked: xy === '??', deleted: xy.includes('D') };
		if (/[RC]/.test(xy) && i + 1 < fields.length) {
			entry.from = fields[++i];
		}
		if (xy !== '!!') {
			out.push(entry);
		}
	}
	return out;
}

/**
 * The paths a status names, with a rename counted as the old file going away and the new one appearing. A copy leaves its
 * source untouched, so only a rename names the old path. Each path once, in order.
 */
export function dirtyPaths(entries: readonly PorcelainEntry[]): string[] {
	const seen = new Set<string>();
	for (const e of entries) {
		seen.add(e.path);
		if (e.from && e.xy.includes('R')) {
			seen.add(e.from);
		}
	}
	return [...seen];
}

/** What is known of a dirty file at one moment. `hash` only for files small enough to read; otherwise size and mtime say. */
export interface FileSig {
	exists: boolean;
	size: number;
	mtimeMs: number;
	hash?: string;
}

const sameSig = (a: FileSig, b: FileSig) => {
	if (a.exists !== b.exists) {
		return false;
	}
	if (!a.exists) {
		return true;
	}
	// A touch changes the mtime and nothing else: where both sides have a content hash, it decides.
	if (a.hash !== undefined && b.hash !== undefined) {
		return a.hash === b.hash;
	}
	return a.size === b.size && a.mtimeMs === b.mtimeMs;
};

/**
 * The files that changed between two snapshots of the dirty files (path -> signature): dirty now and not before, or dirty
 * at both times with different contents. A file that became clean (committed, reverted) is not listed: it is the same as
 * HEAD again, and there is nothing to review in it.
 */
export function diffStatus(before: ReadonlyMap<string, FileSig>, after: ReadonlyMap<string, FileSig>): string[] {
	const out: string[] = [];
	for (const [file, now] of after) {
		const was = before.get(file);
		if (!was || !sameSig(was, now)) {
			out.push(file);
		}
	}
	return out;
}

/** Paths compare the way the file system does: `C:\x`, `c:/x` and `C:/X` are one file on Windows. */
export function pathKey(file: string, windows = process.platform === 'win32'): string {
	const slashed = file.replace(/\\/g, '/');
	return windows ? slashed.toLowerCase() : slashed;
}

/** Whether a repository-relative path is inside the `.insilode` folder (Insilode's own files, never an agent's work). */
export const isInsilodePath = (rel: string) => rel.replace(/\\/g, '/').split('/').includes('.insilode');

/**
 * What the sweep adds to the turn: the files found that no edit tool reported, each once, at most `cap`. `reported` is the
 * set of paths the tools named, spelled however the agent spelled them.
 */
export function mergeIntoTurn(reported: Iterable<string>, found: readonly string[], cap = MAX_SWEPT, windows?: boolean): string[] {
	const known = new Set([...reported].map(f => pathKey(f, windows)));
	const out: string[] = [];
	for (const file of found) {
		const key = pathKey(file, windows);
		if (known.has(key)) {
			continue;
		}
		known.add(key);
		out.push(file);
		if (out.length >= cap) {
			break;
		}
	}
	return out;
}
