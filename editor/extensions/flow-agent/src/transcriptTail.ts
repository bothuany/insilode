/*---------------------------------------------------------------------------------------------
 *  Insilode: the last messages of an agent's conversation, read from its transcript (Claude Code's jsonl, Codex's
 *  rollout), for the Agents page's detail panel. Read-only and shortened.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import type { TailEntry } from './agentsData';

const TEXT_CHARS = 600;
const TOOL_CHARS = 140;
const MAX_LINES = 6;
/**
 * How much of the end of a transcript is read: enough for many messages, never a whole long session. When nothing parses
 * in a window (its last lines are one huge tool result or a pasted image), the next, larger window is read, up to the last.
 */
const WINDOWS = [512 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
	return v && typeof v === 'object' && !Array.isArray(v) ? v as Rec : undefined;
}

/** Trims each line, drops blank runs, keeps a few lines, and cuts to `limit` characters with an ellipsis. */
function shorten(text: string, limit: number): string {
	const lines = text.split(/\r?\n/).map(l => l.replace(/[ \t]+/g, ' ').trim()).filter(l => l);
	let out = lines.slice(0, MAX_LINES).join('\n');
	let cut = lines.length > MAX_LINES;
	if (out.length > limit) {
		out = out.slice(0, limit);
		cut = true;
	}
	return cut ? out.trimEnd() + '…' : out;
}

function firstLine(text: string): string {
	return text.split(/\r?\n/).map(l => l.trim()).find(l => l) ?? '';
}

function stamp(v: unknown): number | undefined {
	if (typeof v !== 'string') {
		return undefined;
	}
	const t = Date.parse(v);
	return Number.isNaN(t) ? undefined : t;
}

/** Text the CLIs put in user turns that the person never typed. */
function injected(text: string): boolean {
	const t = text.trimStart();
	return /^<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|environment_context|user_instructions|user-prompt-submit-hook|INSTRUCTIONS|permissions instructions|collaboration_mode|turn_aborted)\b/i.test(t)
		|| /^# AGENTS\.md instructions/.test(t)
		|| /^Caveat: The messages below were generated/.test(t);
}

function tool(name: string, detail: string, at: number | undefined): TailEntry {
	const d = firstLine(detail);
	return { role: 'tool', text: shorten(d ? `${name}${name === 'Bash' || name === 'shell' ? ':' : ''} ${d}` : name, TOOL_CHARS), at };
}

function claudeTool(block: Rec, at: number | undefined): TailEntry {
	const name = typeof block.name === 'string' ? block.name : 'Tool';
	const input = rec(block.input) ?? {};
	const pick = (...keys: string[]): string => {
		for (const k of keys) {
			if (typeof input[k] === 'string' && input[k]) {
				return input[k] as string;
			}
		}
		return '';
	};
	return tool(name, name === 'Bash' ? pick('command') : pick('file_path', 'notebook_path', 'path', 'pattern', 'command', 'url', 'description', 'query'), at);
}

function claudeEntries(lines: string[]): TailEntry[] {
	const out: TailEntry[] = [];
	let lastId: string | undefined;
	for (const line of lines) {
		let e: Rec | undefined;
		try {
			e = rec(JSON.parse(line));
		} catch {
			continue;
		}
		const m = rec(e?.message);
		if (!e || !m || e.isMeta === true || e.isSidechain === true) {
			continue;
		}
		const at = stamp(e.timestamp);
		const content = m.content;
		if (e.type === 'user') {
			lastId = undefined;
			const text = typeof content === 'string'
				? content
				: Array.isArray(content) ? content.map(b => rec(b)).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b!.text as string).join('\n') : '';
			if (text.trim() && !injected(text)) {
				out.push({ role: 'user', text: shorten(text, TEXT_CHARS), at });
			}
		} else if (e.type === 'assistant') {
			const id = typeof m.id === 'string' ? m.id : undefined;
			const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
			for (const raw of blocks) {
				const b = rec(raw);
				if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
					const prev = out[out.length - 1];
					// Blocks of one message arrive on separate lines; they read as one entry.
					if (id && id === lastId && prev?.role === 'assistant') {
						prev.text = shorten(prev.text + '\n' + b.text, TEXT_CHARS);
					} else {
						out.push({ role: 'assistant', text: shorten(b.text, TEXT_CHARS), at });
					}
					lastId = id;
				} else if (b?.type === 'tool_use') {
					out.push(claudeTool(b, at));
				}
			}
		}
	}
	return out;
}

function codexCommand(args: unknown): string {
	let a = args;
	if (typeof args === 'string') {
		try {
			a = JSON.parse(args);
		} catch {
			return args;
		}
	}
	const o = rec(a);
	const c = o?.command ?? o?.cmd;
	if (Array.isArray(c)) {
		// ["bash", "-lc", "npm test"]: the script is the part worth showing.
		const strs = c.filter(x => typeof x === 'string') as string[];
		return strs.length >= 3 && /^-\w*c$/.test(strs[strs.length - 2]) ? strs[strs.length - 1] : strs.join(' ');
	}
	return typeof c === 'string' ? c : '';
}

function codexEntries(lines: string[]): TailEntry[] {
	const out: TailEntry[] = [];
	for (const line of lines) {
		let e: Rec | undefined;
		try {
			e = rec(JSON.parse(line));
		} catch {
			continue;
		}
		const p = rec(e?.payload);
		if (!e || !p || e.type !== 'response_item') {
			continue;
		}
		const at = stamp(e.timestamp);
		if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
			const text = Array.isArray(p.content)
				? p.content.map(b => rec(b)).filter(b => (b?.type === 'input_text' || b?.type === 'output_text') && typeof b.text === 'string').map(b => b!.text as string).join('\n')
				: '';
			if (text.trim() && (p.role === 'assistant' || !injected(text))) {
				out.push({ role: p.role, text: shorten(text, TEXT_CHARS), at });
			}
		} else if (p.type === 'function_call') {
			out.push(tool(typeof p.name === 'string' ? p.name : 'tool', codexCommand(p.arguments), at));
		} else if (p.type === 'local_shell_call') {
			out.push(tool('shell', codexCommand(rec(p.action)), at));
		} else if (p.type === 'custom_tool_call') {
			out.push(tool(typeof p.name === 'string' ? p.name : 'tool', typeof p.input === 'string' ? p.input : '', at));
		}
	}
	return out;
}

/** At most `max` entries, oldest first, parsed from the transcript's lines. Pure. */
export function tailEntries(lines: string[], cli: 'claude' | 'codex', max: number): TailEntry[] {
	if (!(max > 0)) {
		return [];
	}
	const all = cli === 'claude' ? claudeEntries(lines) : codexEntries(lines);
	return all.slice(-Math.floor(max)).map(e => e.at === undefined ? { role: e.role, text: e.text } : e);
}

/** Reads only the end of the file (never the whole of a long transcript) and parses it with tailEntries. */
export async function readTail(file: string, cli: 'claude' | 'codex', max: number): Promise<TailEntry[]> {
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(file, 'r');
		const size = (await handle.stat()).size;
		for (const window of WINDOWS) {
			const start = Math.max(0, size - window);
			const buf = Buffer.alloc(size - start);
			const { bytesRead } = await handle.read(buf, 0, buf.length, start);
			let lines = buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
			if (start > 0) {
				// The window begins mid-line.
				lines = lines.slice(1);
			}
			const entries = tailEntries(lines, cli, max);
			if (entries.length || start === 0) {
				return entries;
			}
		}
		return [];
	} catch {
		return [];
	} finally {
		await handle?.close().catch(() => undefined);
	}
}
