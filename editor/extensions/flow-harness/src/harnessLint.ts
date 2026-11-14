/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the lines `npm run harness:lint` prints (cli/harness-lint.ts), built from a scan. Shared with the harness summary
 *  (summary.ts), so the Agents page's Harness panel shows exactly the findings a pull request would fail on. No `vscode`.
 *
 *  A lint run reads only the folder (never ~/.claude, which a CI machine does not have), so its findings do not depend on whose
 *  machine it runs on: a user-level deny rule never adds a "shadowed" to a project rule, and the user's home is never checked.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import { scanFolders, type Harness, type ScanHost, type ScanOptions, type Severity } from './scanCore';
import { fsScanHost } from './scanFsHost';

export interface LintLine {
	file: string;
	line: number;
	column: number;
	severity: Severity;
	rule: string;
	message: string;
	fix?: string;
}

/** A lint line with the absolute path of its file as well (the summary opens it; the CLI prints `file`). */
export type FoundLine = LintLine & { abs: string };

/**
 * A permission rule that is never consulted does not do what its author wrote, and the editor shows it as a warning: a pull request
 * that adds one should fail, so the CLI counts it as an error. `shadowed` and `rule-conflict` only fire on an allow rule that a
 * stricter rule already overrides, which is nothing unsafe, so they stay warnings with `overbroad` and the instruction checks:
 * `--max-warnings` is how to fail on those too.
 */
const AS_ERRORS = new Set(['rule-never-applies']);

/** A finding's file as printed: relative to the folder with `/` on every platform (a Windows runner prints the lines a Linux one does), as it is when it lies elsewhere. */
export function shownPath(root: string, file: string, p: path.PlatformPath = path): string {
	const rel = p.relative(root, file);
	return rel.startsWith('..') || p.isAbsolute(rel) ? file : rel.split(p.sep).join('/');
}

/** The findings of a scan as lint lines, in the order the CLI prints them (by file, then line). */
export function lintLines(harness: Harness | undefined, root: string): FoundLine[] {
	const lines = (harness?.items ?? []).flatMap(item => item.issues.map((i): FoundLine => ({
		file: shownPath(root, item.file), abs: item.file, line: (i.line ?? 0) + 1, column: 1, severity: i.code && AS_ERRORS.has(i.code) && i.severity === 'warning' ? 'error' : i.severity, rule: i.code ?? 'harness', message: i.message.replace(/\s+/g, ' ').trim(), ...(i.fix ? { fix: i.fix } : {}),
	})));
	lines.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
	return lines;
}

/**
 * What `harness-lint --cwd <dir>` finds: the folder (by its real path) scanned without the user's files. Throws when the folder cannot be
 * read. `host` is the scan's file search; a caller that has one already shares it (and its listing cache). `options` may bound the work (`maxFileBytes`); `user` is always false.
 */
export async function lintFolder(dir: string, host?: ScanHost, options: ScanOptions = {}): Promise<FoundLine[]> {
	if (!(await fs.stat(dir)).isDirectory()) {
		throw new Error('not a folder');
	}
	const root = await fs.realpath(dir);
	const harness = await scanFolders([{ name: path.basename(root), fsPath: root }], host ?? fsScanHost([root]), { ...options, user: false });
	return lintLines(harness, root);
}
