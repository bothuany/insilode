// Entry of the headless harness lint (bundled to out/harness-lint.js by esbuild.mjs): lints a repository's Claude Code harness
// (.claude/settings*.json, hooks, permission rules, CLAUDE.md / AGENTS.md, rules, skills, subagents, .mcp.json) the way the
// editor's harness map does, so a pull request can fail on a broken rule or hook:
//   node out/harness-lint.js [--cwd <dir>] [--json] [--max-warnings <n>]
// Exit 0: no errors (and no more than --max-warnings warnings); 1: findings; 2: wrong usage or a folder that cannot be read.
// Reads only the folder (never ~/.claude, which a CI machine does not have, and no path under ~ is checked), follows no link out of
// the folder, writes nothing, uses no network.
import { promises as fs } from 'fs';
import * as path from 'path';
import { scanFolders, type Severity } from '../src/scanCore';
import { fsScanHost } from '../src/scanFsHost';

export interface LintLine {
	file: string;
	line: number;
	column: number;
	severity: Severity;
	rule: string;
	message: string;
	fix?: string;
}

/**
 * A permission rule that is never consulted does not do what its author wrote, and the editor shows it as a warning: a pull request
 * that adds one should fail, so the CLI counts it as an error. `shadowed` and `rule-conflict` only fire on an allow rule that a
 * stricter rule already overrides, which is nothing unsafe, so they stay warnings with `overbroad` and the instruction checks:
 * `--max-warnings` is how to fail on those too.
 */
const AS_ERRORS = new Set(['rule-never-applies']);

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
		if (!(await fs.stat(args.cwd)).isDirectory()) {
			throw new Error('not a folder');
		}
		const root = await fs.realpath(args.cwd);
		const harness = await scanFolders([{ name: path.basename(root), fsPath: root }], fsScanHost([root]), { user: false });
		const shown = (file: string) => {
			const rel = path.relative(root, file);
			return rel.startsWith('..') || path.isAbsolute(rel) ? file : rel.split(path.sep).join('/');
		};
		lines = (harness?.items ?? []).flatMap(item => item.issues.map(i => ({
			file: shown(item.file), line: (i.line ?? 0) + 1, column: 1, severity: i.code && AS_ERRORS.has(i.code) && i.severity === 'warning' ? 'error' : i.severity, rule: i.code ?? 'harness', message: i.message.replace(/\s+/g, ' ').trim(), ...(i.fix ? { fix: i.fix } : {}),
		})));
		lines.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
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
