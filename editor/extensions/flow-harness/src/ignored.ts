/*---------------------------------------------------------------------------------------------
 *  Insilode harness: which found files git ignores. A CLAUDE.md inside build output, a generated
 *  composition or a vendored checkout is not part of the project's harness, and checking it
 *  turned real repositories' health red with problems nobody can or should fix. Git itself is
 *  asked (`git check-ignore`), so every .gitignore, .git/info/exclude and the global excludes count
 *  as `git status` counts them; a tracked file is never ignored. Outside a repository, or without
 *  git, nothing is.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as os from 'os';

/**
 * What to run: git by its bare name, which Windows looks for in the working directory first, so the child starts in the user's home folder
 * (never in the folder being looked at, where a `git.exe` may have been planted) and is told where the repository is with `-C`. fsmonitor
 * is the setting of a repository's own config that runs a program.
 */
export function gitCommand(root: string): { args: string[]; cwd: string } {
	return { args: ['-c', 'core.fsmonitor=false', '-C', root, 'check-ignore', '--stdin', '-z'], cwd: os.homedir() || os.tmpdir() };
}

/** The subset of `files` (absolute paths under `cwd`) that git ignores; `timeoutMs` is how long git may take (a scan with a deadline gives what is left of it). */
export function gitIgnoredOf(cwd: string, files: readonly string[], timeoutMs = 10_000): Promise<Set<string>> {
	if (!files.length) {
		return Promise.resolve(new Set());
	}
	return new Promise(resolve => {
		let out = '';
		let done = false;
		const finish = (set: Set<string>) => {
			if (!done) {
				done = true;
				clearTimeout(timer);
				resolve(set);
			}
		};
		// The folder may be one nobody opened (the Agents page's harness summary looks at any project): its own git config must not get to run a program, and fsmonitor is the setting that does.
		const { args, cwd: neutral } = gitCommand(cwd);
		const child = spawn('git', args, { cwd: neutral, windowsHide: true });
		// A hung git must not hold the harness view: past this, nothing counts as ignored.
		const timer = setTimeout(() => {
			child.kill();
			finish(new Set());
		}, timeoutMs);
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', d => out += d);
		child.on('error', () => finish(new Set()));
		// Exit 1 means "none ignored", 0 "some"; anything else (not a repository) means we cannot tell.
		child.on('close', code => finish(code === 0 ? new Set(out.split('\0').filter(Boolean)) : new Set()));
		child.stdin.on('error', () => undefined);
		child.stdin.end(files.join('\0') + '\0');
	});
}
