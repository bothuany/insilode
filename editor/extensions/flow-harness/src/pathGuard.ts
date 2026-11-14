/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: which paths named in a file's text may be looked at on disk. A line in a CLAUDE.md (`@//host/share/x.md`) or a hook
 *  command (`bash \\host\share\x.sh`) names a path the scan would stat; on Windows that opens an SMB connection to a machine the file's
 *  author chose and hands it the user's NTLM hash. Pure (no fs, no `vscode`): the platform's `path` is a parameter, so it is tested with
 *  both `path.win32` and `path.posix`.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';

export type PathVerdict = 'ok' | 'network' | 'outside';

/** Whether `raw`, as a file wrote it or a link names it, starts like a network or device path: two slashes in any mix (`\\host\share`, `//host/share`, `\\?\UNC\…`, `\\.\pipe\…`) or the NT form a junction reports (`\??\UNC\…`). */
export const isNetworkPath = (raw: string): boolean => /^(?:[\\/]{2}|\\\?\?\\)/.test(raw);

/** Whether `target` is `root` or lies inside it (by `p`'s own rules: case and drive letters on Windows). */
export function within(root: string, target: string, p: path.PlatformPath = path): boolean {
	const rel = p.relative(root, target);
	return rel === '' || (!rel.startsWith('..' + p.sep) && rel !== '..' && !p.isAbsolute(rel));
}

/**
 * Whether the path `raw` (what the file wrote), resolved to `target`, may be stat'ed or read.
 * 'network': `raw` starts with two slashes (POSIX `resolve` would collapse them, so `target` alone cannot tell), or `target` is a network path outside `root` (a folder opened
 * from a share may still check what lies in it). 'outside': `confine` is set (the folder is not trusted) and `target` is not inside `root`.
 */
export function pathVerdict(raw: string, target: string, root: string, confine: boolean, p: path.PlatformPath = path): PathVerdict {
	if (isNetworkPath(raw)) {
		return 'network';
	}
	const inside = within(root, target, p);
	if (!inside && /^[\\/]{2}/.test(target)) {
		return 'network';
	}
	return confine && !inside ? 'outside' : 'ok';
}
