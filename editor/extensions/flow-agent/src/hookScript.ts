/*---------------------------------------------------------------------------------------------
 *  Insilode: the script Claude Code runs for every hook event of an agent Insilode started. It posts the event to the Insilode window and
 *  prints back at most one of the known reminders (skeleton first). Pure (no vscode): tested end to end in test/hookScript.test.mjs.
 *--------------------------------------------------------------------------------------------*/

import { HOOK_CONTEXT } from './skeleton';

/** What runs a hook script: a program and whether it is the editor itself, which only runs a script as Node. */
export interface HookRunner {
	exe: string;
	electron: boolean;
}

/**
 * The program that runs every hook (Claude's and Codex's): a plain `node` when there is one, because it starts several
 * times quicker than the editor in Node mode; the editor's own binary (ELECTRON_RUN_AS_NODE) only when node is not found.
 * `electron` is false in server mode, where `execPath` is already plain node.
 */
export function hookRunner(node: string | undefined, execPath: string, electron: boolean): HookRunner {
	return node ? { exe: node, electron: false } : { exe: execPath, electron };
}

/**
 * The command line Claude Code runs for a hook; it goes through bash (Git Bash on Windows). Double quotes keep a path with
 * spaces whole, and what bash would still read inside them ($, `, ", \) is escaped. On Windows a path is written with
 * forward slashes instead: bash reads a backslash as an escape, and node takes either.
 */
export function claudeHookCommand(runner: HookRunner, script: string, platform: NodeJS.Platform = process.platform): string {
	const q = (p: string) => `"${(platform === 'win32' ? p.replace(/\\/g, '/') : p.replace(/\\/g, '\\\\')).replace(/(["$`])/g, '\\$1')}"`;
	return `${runner.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}${q(runner.exe)} ${q(script)}`;
}

/**
 * Reads the event from stdin and posts it to the Insilode window that owns this folder now. Never blocks the agent and never decides
 * anything. The one thing it passes back is context for the agent (`hookSpecificOutput.additionalContext`, skeleton first's
 * reminders, HOOK_CONTEXT in skeleton.ts), and only those exact texts for their own events.
 */
export function hookScript(portFile: string, tokenFile: string) {
	return `// Written by Insilode: forwards Claude Code hook events to the Insilode window (observe only; it may hand the agent context, never a decision).
const fs = require('fs'), http = require('http');
let body = '';
process.stdin.on('data', d => body += d).on('end', () => {
	let port, token;
	try { port = fs.readFileSync(${JSON.stringify(portFile)}, 'utf8').trim(); token = fs.readFileSync(${JSON.stringify(tokenFile)}, 'utf8').trim(); } catch { process.exit(0); }
	if (!port) process.exit(0);
	const req = http.request({ host: '127.0.0.1', port, path: '/hook', method: 'POST', timeout: 3000, headers: { 'Content-Type': 'application/json', 'X-Flow-Token': token, 'X-Flow-Agent': process.env.FLOW_AGENT_SESSION || '' } }, res => {
		let out = '';
		res.setEncoding('utf8');
		res.on('data', d => { out += d; if (out.length > 8000) res.destroy(); });
		res.on('end', () => {
			// Only the one text Insilode sends, exactly: whatever else answers on this port cannot put words into the agent's context.
			let o;
			// A reply past the cap is not Insilode's: it is dropped whole, never parsed.
			try { if (out.length <= 8000) o = JSON.parse(out).hookSpecificOutput; } catch {}
			const known = ${JSON.stringify(HOOK_CONTEXT)};
			if (o && typeof o.hookEventName === 'string' && Object.prototype.hasOwnProperty.call(known, o.hookEventName) && o.additionalContext === known[o.hookEventName]) {
				process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: o.hookEventName, additionalContext: o.additionalContext } }), () => process.exit(0));
			} else {
				process.exit(0);
			}
		});
	});
	req.on('error', () => process.exit(0)).on('timeout', () => { req.destroy(); process.exit(0); });
	req.end(body);
});
setTimeout(() => process.exit(0), 4000);
`;
}
