// Entry of the headless harness lint (bundled to out/harness-lint.js by esbuild.mjs): lints a repository's Claude Code harness
// (.claude/settings*.json, hooks, permission rules, CLAUDE.md / AGENTS.md, rules, skills, subagents, .mcp.json) the way the
// editor's harness map does, so a pull request can fail on a broken rule or hook:
//   node out/harness-lint.js [--cwd <dir>] [--json] [--max-warnings <n>]
// Paths are relative to --cwd and always written with `/`, on Windows too.
// Exit 0: no errors (and no more than --max-warnings warnings); 1: findings; 2: wrong usage or a folder that cannot be read.
// Reads only the folder (never ~/.claude, which a CI machine does not have, and no path under ~ is checked), follows no link out of
// the folder, writes nothing, uses no network.
import * as path from 'path';
import { lintFolder, shownPath, type LintLine } from '../src/harnessLint';

export { shownPath };
export type { LintLine };

const USAGE = 'Usage: harness-lint [--cwd <dir>] [--json] [--max-warnings <n>]\n';

interface Args {
	cwd: string;
	json: boolean;
	maxWarnings?: number;
}

/** `--flag value` and `--flag=value`; undefined (with the reason in `error`) for anything else. */
function parse(argv: string[]): Args | { error: string } | 'help' {
	const args: Args = { cwd: process.cwd(), json: false };
	for (let i = 0; i < argv.length; i++) {
		const [flag, inline] = argv[i].startsWith('--') ? argv[i].split(/=(.*)/s, 2) : [argv[i], undefined];
		const value = () => inline ?? argv[++i];
		if (flag === '--json') {
			args.json = true;
		} else if (flag === '--cwd') {
			const v = value();
			if (!v) {
				return { error: '--cwd needs a folder' };
			}
			args.cwd = path.resolve(v);
		} else if (flag === '--max-warnings') {
			const v = value();
			if (v === undefined || !/^\d+$/.test(v)) {
				return { error: '--max-warnings needs a whole number' };
			}
			args.maxWarnings = Number(v);
		} else if (flag === '-h' || flag === '--help') {
			return 'help';
		} else {
			return { error: `Unknown argument ${argv[i]}` };
		}
	}
	return args;
}

export async function main(argv: string[], out: { stdout: (s: string) => void; stderr: (s: string) => void }): Promise<number> {
	const args = parse(argv);
	if (args === 'help') {
		out.stdout(USAGE);
		return 0;
	}
	if ('error' in args) {
		out.stderr(`${args.error}\n${USAGE}`);
		return 2;
	}
	let lines: LintLine[];
	try {
		lines = (await lintFolder(args.cwd)).map(({ abs, ...line }) => line);
	} catch (e) {
		out.stderr(`Cannot read ${args.cwd}: ${(e as Error).message}\n`);
		return 2;
	}
	if (args.json) {
		out.stdout(JSON.stringify(lines, null, 2) + '\n');
	} else {
		out.stdout(lines.map(l => `${l.file}:${l.line}:${l.column} ${l.severity} ${l.rule} ${l.message}\n`).join(''));
	}
	const errors = lines.filter(l => l.severity === 'error').length;
	const warnings = lines.filter(l => l.severity === 'warning').length;
	out.stderr(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}\n`);
	return errors > 0 || (args.maxWarnings !== undefined && warnings > args.maxWarnings) ? 1 : 0;
}

if (require.main === module) {
	main(process.argv.slice(2), { stdout: s => void process.stdout.write(s), stderr: s => void process.stderr.write(s) }).then(code => {
		process.exitCode = code;
	}, e => {
		process.stderr.write(`[harness-lint] ${(e as Error)?.stack ?? e}\n`);
		process.exitCode = 2;
	});
}
