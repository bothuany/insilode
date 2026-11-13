/*---------------------------------------------------------------------------------------------
 *  Insilode: the folders the user left out with `flow.exclude`. Without vscode, so the index worker
 *  gets the patterns as plain data. Each pattern is a folder relative to its workspace folder
 *  (`legacy-java`, `services/old`) or a glob (`**` + `/legacy/**`); either slash style works.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

/** Whether a file lies under an excluded folder, given the workspace roots it may belong to. */
export type Excluder = (fsPath: string, roots: readonly string[]) => boolean;

const NONE: Excluder = () => false;

/** `a/b/` and `.\a\b` and `/a/b` all mean `a/b`. */
export function normalizePattern(p: string): string {
	return p.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+|\/+$/g, '');
}

/**
 * `*` and `?` inside one segment: the linear two-pointer wildcard match, which only ever falls back to the last `*`, so a hostile
 * pattern costs pattern length x segment length at worst and never backtracks exponentially.
 */
function segmentMatches(p: string, s: string): boolean {
	let pi = 0;
	let si = 0;
	let star = -1;
	let mark = 0;
	while (si < s.length) {
		if (p[pi] === '*') {
			star = pi++;
			mark = si;
		} else if (pi < p.length && (p[pi] === '?' || p[pi] === s[si])) {
			pi++;
			si++;
		} else if (star >= 0) {
			pi = star + 1;
			si = ++mark;
		} else {
			return false;
		}
	}
	while (p[pi] === '*') {
		pi++;
	}
	return pi === p.length;
}

/** shortcut: only `*`, `**` and `?` are globs (no braces or classes), upgrade when someone asks for them. */
function compile(pattern: string): (segs: readonly string[]) => boolean {
	const win = process.platform === 'win32';
	// A `**` that is not a whole segment is a `*`: only a whole segment may span folders.
	const pat = (win ? pattern.toLowerCase() : pattern).split('/').filter(Boolean).map(p => (p === '**' ? p : p.replace(/\*+/g, '*')));
	// A plain folder name matches the folder and everything below it (the caller tries every prefix), so `legacy` never matches
	// `legacy-tools`. reach[j]: the first i pattern segments can match the first j path segments; `**` takes zero or more of them.
	return segs => {
		const parts = win ? segs.map(s => s.toLowerCase()) : segs;
		let reach = [true, ...parts.map(() => false)];
		for (const p of pat) {
			const next = [false, ...parts.map(() => false)];
			for (let j = 0; j <= parts.length; j++) {
				next[j] = p === '**' ? reach[j] || (j > 0 && next[j - 1]) : j > 0 && reach[j - 1] && segmentMatches(p, parts[j - 1]);
			}
			reach = next;
		}
		return reach.some((r, j) => r && j > 0);
	};
}

/** Settings are user input: a pattern past this length is ignored. */
const MAX_PATTERN = 300;

/** Three or more `*` in a row mean `**`. */
const collapse = (p: string) => p.replace(/\*{3,}/g, '**');
const usable = (p: string) => p.length <= MAX_PATTERN;

export function excluder(patterns: readonly string[]): Excluder {
	const matchers = patterns.filter(p => typeof p === 'string').map(normalizePattern).filter(Boolean).map(collapse).filter(usable).map(compile);
	if (!matchers.length) {
		return NONE;
	}
	return (fsPath, roots) => {
		for (const root of roots) {
			const rel = path.relative(root, fsPath);
			if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
				continue;
			}
			const segs = rel.split(/[\\/]/);
			return matchers.some(m => m(segs));
		}
		return false;
	};
}

/**
 * The pattern that excludes `dir`, when it lies strictly inside one of the roots (a folder outside the workspace, or
 * the workspace folder itself, is never excluded by a message from a webview), else undefined.
 */
export function excludablePattern(dir: string, roots: readonly string[]): string | undefined {
	for (const root of roots) {
		const rel = path.relative(root, path.resolve(dir));
		// A folder named with `*` or `?` (legal on Linux and macOS) would be written as a glob that matches more than itself.
		if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
			return /[*?]/.test(rel) ? undefined : rel.split(path.sep).join('/');
		}
	}
	return undefined;
}

/** `list` with `pattern` added, or undefined when an equal pattern is already there. */
export function withPattern(list: readonly string[], pattern: string): string[] | undefined {
	return list.some(p => normalizePattern(p) === pattern) ? undefined : [...list, pattern];
}
