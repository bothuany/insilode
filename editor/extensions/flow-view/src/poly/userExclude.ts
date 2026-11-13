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

/** shortcut: only `*`, `**` and `?` are globs (no braces or classes), upgrade when someone asks for them. */
function toRegExp(pattern: string): RegExp {
	// A trailing `/**` also matches the folder itself, so the walk can skip it without entering.
	const tail = pattern.endsWith('/**');
	const body = tail ? pattern.slice(0, -3) : pattern;
	let re = '';
	for (let i = 0; i < body.length; i++) {
		const c = body[i];
		if (c === '*' && body[i + 1] === '*') {
			if (body[i + 2] === '/') {
				re += '(?:.*/)?';
				i += 2;
			} else {
				re += '.*';
				i += 1;
			}
		} else if (c === '*') {
			re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	// A plain folder name matches by prefix of segments (below), so `legacy` never matches `legacy-tools`.
	return new RegExp(`^${re}${tail ? '(?:/.*)?' : ''}$`, process.platform === 'win32' ? 'i' : '');
}

export function excluder(patterns: readonly string[]): Excluder {
	const res = patterns.filter(p => typeof p === 'string').map(normalizePattern).filter(Boolean).map(toRegExp);
	if (!res.length) {
		return NONE;
	}
	return (fsPath, roots) => {
		for (const root of roots) {
			const rel = path.relative(root, fsPath);
			if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
				continue;
			}
			const segs = rel.split(/[\\/]/);
			let prefix = '';
			for (const s of segs) {
				prefix = prefix ? `${prefix}/${s}` : s;
				if (res.some(r => r.test(prefix))) {
					return true;
				}
			}
			return false;
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
		if (rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
			return rel.split(path.sep).join('/');
		}
	}
	return undefined;
}

/** `list` with `pattern` added, or undefined when an equal pattern is already there. */
export function withPattern(list: readonly string[], pattern: string): string[] | undefined {
	return list.some(p => normalizePattern(p) === pattern) ? undefined : [...list, pattern];
}
