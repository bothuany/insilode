/*---------------------------------------------------------------------------------------------
 *  Insilode: Codex's observe-only hooks. Claude Code takes them per run (--settings); Codex reads hooks
 *  only from its config layers, so Insilode writes its own profile, $CODEX_HOME/insilode.config.toml, and
 *  starts Codex with `-p insilode`: the user's config.toml is never touched, and a Codex started by hand
 *  never sees these hooks. The same profile gives Codex the `insilode` MCP server, which Claude Code gets
 *  per run (--mcp-config).
 *
 *  Codex runs a hook only after the user trusted it (/hooks), and records that trust against the
 *  hook's hash. So the profile must be byte-for-byte the same in every workspace and window: the
 *  command names one shared script, and the script learns which window to report to from the
 *  terminal's environment (FLOW_HOOK_DIR), not from its own text.
 *
 *  Pure (no vscode), so it is tested on its own.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';

export const CODEX_PROFILE = 'insilode';

/** Where Codex keeps its config, sessions and profiles. */
export function codexHome(env: NodeJS.ProcessEnv = process.env) {
	return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function codexProfileFile(env: NodeJS.ProcessEnv = process.env) {
	return path.join(codexHome(env), `${CODEX_PROFILE}.config.toml`);
}

/**
 * The events Insilode listens to, and the tools each one is limited to. PreToolUse only needs the edits
 * (to keep the file as it was); Codex reports every edit as apply_patch.
 */
export const CODEX_EVENTS: [event: string, matcher?: string][] = [
	['SessionStart'],
	['UserPromptSubmit'],
	['PreToolUse', '^apply_patch$'],
	['PermissionRequest'],
	['PostToolUse'],
	['Stop'],
	['SessionEnd'],
];

/**
 * The hook's command line. Codex runs hooks through PowerShell on Windows and sh elsewhere. In the
 * desktop editor `execPath` is the Insilode executable itself, which runs a script only with
 * ELECTRON_RUN_AS_NODE set (else it opens a window); each hook is its own shell, so setting it
 * there touches nothing else.
 */
export function codexHookCommand(platform: NodeJS.Platform, execPath: string, script: string, electron: boolean): string {
	if (platform === 'win32') {
		const ps = (s: string) => `'${s.replace(/'/g, "''")}'`; // PowerShell literal string
		return `${electron ? '$env:ELECTRON_RUN_AS_NODE=1; ' : ''}& ${ps(execPath)} ${ps(script)}`;
	}
	const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
	return `${electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${sh(execPath)} ${sh(script)}`;
}

/** A TOML basic string: always valid, whatever the text holds. */
export function tomlString(s: string) {
	return `"${s.replace(/[\\"]/g, c => `\\${c}`).replace(/[\u0000-\u001f\u007f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
}

/** The `insilode` MCP server as Codex starts it: flow-view's server script, run by `execPath` (as Node when it is the editor). */
export interface CodexMcp {
	execPath: string;
	script: string;
	electron: boolean;
}

/**
 * The variables the `insilode` server needs from the agent's terminal: the folder whose window it talks to, the agent
 * session its tours come from, and where the bridge and the agents' transcripts are when they are moved from their
 * defaults. Codex starts an MCP server with only a few variables of its own (PATH, USERPROFILE, TEMP…) plus those named
 * in `env_vars`, so the profile names them instead of holding their values: its text stays the same in every window.
 */
export const CODEX_MCP_ENV = ['INSILODE_WORKSPACE', 'INSILODE_SESSION', 'INSILODE_BRIDGE_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];

/**
 * The profile Insilode writes: the hooks (when `hookCommand` is given) and the `insilode` tools (when `mcp` is).
 * Deterministic: the same input gives the same bytes, so trust given once holds.
 */
export function codexProfile(hookCommand: string | undefined, mcp?: CodexMcp, timeout = 5): string {
	const lines = [
		'# Written by Insilode. Used only when Insilode starts Codex (codex -p insilode): read-only hooks that tell',
		'# Insilode\'s Agents dock what the agent is doing (they print nothing, so they never decide anything), and',
		'# the `insilode` tools that show files, flows and diagrams in the editor. Your own config.toml stays as it',
		'# is. Delete this file to stop it; Insilode writes it again when it starts Codex.',
	];
	if (mcp) {
		lines.push(
			'',
			'[mcp_servers.insilode]',
			`command = ${tomlString(mcp.execPath)}`,
			`args = [${tomlString(mcp.script)}]`,
			...(mcp.electron ? ['env = { ELECTRON_RUN_AS_NODE = "1" }'] : []),
			`env_vars = [${CODEX_MCP_ENV.map(tomlString).join(', ')}]`,
		);
	}
	for (const [event, matcher] of hookCommand === undefined ? [] : CODEX_EVENTS) {
		lines.push('', `[[hooks.${event}]]`);
		if (matcher) {
			lines.push(`matcher = ${tomlString(matcher)}`);
		}
		lines.push(`[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${tomlString(hookCommand ?? '')}`, `timeout = ${timeout}`);
	}
	return lines.join('\n') + '\n';
}

/**
 * How to start `codex` without a shell: a program to run directly, a JavaScript entry for Node, or a batch file of the
 * user's own (a wrapper that is not npm's shim), which only cmd.exe can run.
 */
export type CodexLaunch = { file: string } | { script: string; node?: string } | { batch: string };

/** The file system calls `codexLaunch` needs, passed in so tests lay out a PATH of their own. */
export interface LaunchFs {
	exists(file: string): boolean;
	read(file: string): string | undefined;
}

/**
 * Where `codex` is, found the way a shell would find it, so it can be started with an argument array and no shell.
 * Elsewhere than Windows that is the first `codex` on PATH. On Windows each PATH folder is tried with each PATHEXT
 * ending, in order: an `.exe` (Codex's standalone install) runs as it is; npm's `codex.cmd` shim, which Node cannot
 * start without cmd.exe, is read for the script it hands to Node (`"%dp0%\node_modules\@openai\codex\bin\codex.js"`)
 * and the node.exe beside it, if there is one. Any other .cmd (a wrapper the user wrote, such as one that runs the
 * Codex desktop app's codex.exe) is returned as a batch file. Undefined when there is no codex.
 */
export function codexLaunch(platform: NodeJS.Platform, envPath: string, pathext: string | undefined, fs: LaunchFs): CodexLaunch | undefined {
	const win = platform === 'win32';
	const join = win ? path.win32.join : path.posix.join;
	const dirs = envPath.split(win ? ';' : ':').map(d => d.replace(/^"|"$/g, '')).filter(Boolean);
	if (!win) {
		const dir = dirs.find(d => fs.exists(join(d, 'codex')));
		return dir ? { file: join(dir, 'codex') } : undefined;
	}
	const exts = (pathext || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim().toLowerCase()).filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			const file = join(dir, `codex${ext}`);
			if (!fs.exists(file)) {
				continue;
			}
			if (ext === '.exe' || ext === '.com') {
				return { file };
			}
			if (ext === '.cmd' || ext === '.bat') {
				const shim = /"%~?dp0%?\\([^"%]+?\.[cm]?js)"/i.exec(fs.read(file) ?? '');
				const script = shim ? join(dir, shim[1]) : undefined;
				if (!script || !fs.exists(script)) {
					return { batch: file };
				}
				const node = join(dir, 'node.exe');
				return { script, ...(fs.exists(node) ? { node } : {}) };
			}
		}
	}
	return undefined;
}

/**
 * cmd.exe's arguments for running a batch file with fixed arguments: `/d /s /c ""<file>" <args>"`, to be passed with
 * `windowsVerbatimArguments` (what Node itself builds for `shell: true`, but with nothing but this one command line).
 * The arguments are Insilode's own constants; the file comes from PATH. Undefined when any of it holds a character
 * cmd.exe would still interpret inside quotes (`"`, `%`, `!`) or a line break, so nothing is ever expanded.
 */
export function batchCommandLine(file: string, args: readonly string[]): string[] | undefined {
	const parts = [file, ...args];
	if (parts.some(p => /["%!\r\n]/.test(p)) || args.some(a => !/^[\w.-]+$/.test(a))) {
		return undefined;
	}
	return ['/d', '/s', '/c', `""${file}" ${args.join(' ')}"`];
}

/** A `codex` run with fixed arguments: the program, its arguments, and how Node must pass them. */
export interface CodexCommand {
	file: string;
	argv: string[];
	verbatim: boolean;
	/** Set when the script runs under this editor's own executable in Node mode. */
	electronAsNode: boolean;
}

/**
 * How to run `codex <args>` from a launch: the program itself, Node with npm's script, or cmd.exe with one fixed command
 * line for a batch wrapper (undefined when that line could be interpreted). `node` is the Node to use when the shim has
 * none beside it; `execPath` is this process, the last resort.
 */
export function codexCommand(launch: CodexLaunch, args: readonly string[], node: string | undefined, execPath: string, isElectron: boolean, comSpec = 'cmd.exe'): CodexCommand | undefined {
	if ('file' in launch) {
		return { file: launch.file, argv: [...args], verbatim: false, electronAsNode: false };
	}
	if ('batch' in launch) {
		const line = batchCommandLine(launch.batch, args);
		return line ? { file: comSpec, argv: line, verbatim: true, electronAsNode: false } : undefined;
	}
	const file = launch.node ?? node ?? execPath;
	return { file, argv: [launch.script, ...args], verbatim: false, electronAsNode: file === execPath && isElectron };
}

/**
 * The shared hook script: posts the event to the Insilode window named by the terminal's FLOW_HOOK_DIR,
 * and prints nothing (Codex then takes no decision from it; Stop treats empty output as success).
 */
export const CODEX_HOOK_SCRIPT = `// Written by Insilode: forwards Codex hook events to the Insilode window that started the agent (observe only).
const fs = require('fs'), http = require('http'), path = require('path');
const dir = process.env.FLOW_HOOK_DIR;
if (!dir) process.exit(0);
let body = '';
process.stdin.on('data', d => body += d).on('end', () => {
	let port, token;
	try { port = fs.readFileSync(path.join(dir, 'hook-port'), 'utf8').trim(); token = fs.readFileSync(path.join(dir, 'hook-token'), 'utf8').trim(); } catch { process.exit(0); }
	if (!port) process.exit(0);
	const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: 3000, headers: { 'Content-Type': 'application/json', 'X-Flow-Token': token, 'X-Flow-Agent': process.env.FLOW_AGENT_SESSION || '' } }, res => { res.resume(); res.on('end', () => process.exit(0)); });
	req.on('error', () => process.exit(0)).on('timeout', () => { req.destroy(); process.exit(0); });
	req.end(body);
});
setTimeout(() => process.exit(0), 4000);
`;
