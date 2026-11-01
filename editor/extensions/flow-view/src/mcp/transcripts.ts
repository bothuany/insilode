/*---------------------------------------------------------------------------------------------
 *  Search of the agent transcripts of a workspace ("was this done before?"): Claude Code's
 *  ~/.claude/projects/<folder key>/*.jsonl and Codex's rollout-*.jsonl whose session_meta cwd is
 *  the folder. Plain Node (fs, path, os, readline) so the stdio server could use it: no `vscode`.
 *  Only what the user and the assistant wrote is searched, never tool results.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { redact } from './redact';

export type SessionAgent = 'claude' | 'codex';

export interface SessionHit {
	agent: SessionAgent;
	id: string;
	/** ISO date (day) of the transcript's last write. */
	date: string;
	prompt: string;
	snippet: string;
}

export interface SessionSearch {
	hits: SessionHit[];
	/** Transcripts that were looked at, so "no match" can say how much it covered. */
	scanned: number;
	/** The byte budget of the call ran out before every transcript was read, so older ones may hold more matches. */
	truncated?: boolean;
}

/** A transcript is read up to this many bytes, and a line longer than the line cap is skipped (tool results and images). */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** All transcripts of one call together are read up to this many bytes. */
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
/** How much of a transcript's start is read to learn its folder. */
const HEAD_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 1024 * 1024;
/** At most this many transcripts are opened per call, newest first. */
const MAX_FILES = 400;
const SNIPPET = 200;
const PROMPT = 160;

interface Candidate {
	agent: SessionAgent;
	file: string;
	id: string;
	modified: number;
}

/** Claude Code's folder key: every character that is not a letter or digit becomes a dash. */
export function claudeKey(folder: string): string {
	return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

export function queryWords(query: string): string[] {
	return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

async function stat(file: string): Promise<fs.Stats | undefined> {
	return fs.promises.stat(file).catch(() => undefined);
}

async function claudeFiles(folders: string[]): Promise<Candidate[]> {
	const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
	const out: Candidate[] = [];
	for (const folder of folders) {
		const dir = path.join(root, claudeKey(folder));
		// Only the files directly in the folder: <session>/subagents/ holds sidechains, not conversations.
		for (const name of await fs.promises.readdir(dir).catch(() => [] as string[])) {
			if (name.endsWith('.jsonl')) {
				const file = path.join(dir, name);
				const st = await stat(file);
				if (st?.isFile() && st.size > 0) {
					out.push({ agent: 'claude', file, id: name.slice(0, -6), modified: st.mtimeMs });
				}
			}
		}
	}
	return out;
}

async function codexFiles(): Promise<Candidate[]> {
	const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
	const out: Candidate[] = [];
	const walk = async (dir: string, depth: number): Promise<void> => {
		for (const e of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
			const full = path.join(dir, e.name);
			if (e.isDirectory() && depth < 4) {
				await walk(full, depth + 1);
			} else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
				const st = await stat(full);
				if (st && st.size > 0) {
					out.push({ agent: 'codex', file: full, id: e.name.slice('rollout-'.length, -'.jsonl'.length), modified: st.mtimeMs });
				}
			}
		}
	};
	await walk(path.join(home, 'sessions'), 0);
	await walk(path.join(home, 'archived_sessions'), 0);
	return out;
}

/** The complete lines in the first bytes of a file (a line cut by the end of the window is dropped). */
async function headLines(file: string): Promise<string[]> {
	const fh = await fs.promises.open(file, 'r').catch(() => undefined);
	if (!fh) {
		return [];
	}
	try {
		const buf = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
		const lines = buf.toString('utf8', 0, bytesRead).split('\n');
		if (bytesRead === HEAD_BYTES) {
			lines.pop();
		}
		return lines;
	} catch {
		return [];
	} finally {
		await fh.close().catch(() => undefined);
	}
}

/**
 * Whether the transcript belongs to one of the folders, read from its first lines: Codex's session_meta cwd (which
 * also gives the session id), the first Claude line that has a cwd. The Claude folder key is lossy (a b and a-b
 * share one), so the key alone is not proof.
 */
async function owned(c: Candidate, folders: string[]): Promise<Candidate | undefined> {
	const lines = await headLines(c.file);
	for (const line of c.agent === 'codex' ? lines.slice(0, 1) : lines) {
		let e: { type?: string; cwd?: unknown; payload?: { id?: string; cwd?: unknown } };
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (c.agent === 'codex') {
			const cwd = e.type === 'session_meta' ? e.payload?.cwd : undefined;
			return typeof cwd === 'string' && folders.some(f => same(f, cwd)) ? { ...c, id: e.payload?.id ?? c.id } : undefined;
		}
		if (typeof e.cwd === 'string') {
			const cwd = e.cwd;
			return folders.some(f => same(f, cwd)) ? c : undefined;
		}
	}
	return undefined;
}

const same = (a: string, b: string) => {
	const x = path.resolve(a);
	const y = path.resolve(b);
	return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

function blocksText(content: unknown): string | undefined {
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		const parts = content.filter(b => b && typeof b.text === 'string' && (b.type === 'text' || b.type === 'output_text' || b.type === 'input_text')).map(b => b.text as string);
		return parts.length ? parts.join('\n') : undefined;
	}
	return undefined;
}

type Said = { who: 'user' | 'assistant'; text: string };

/** What one Claude Code line says as the user or the assistant; tool results, hook context and sidechains are not it. */
function claudeSaid(e: Record<string, any>): Said | undefined {
	if ((e.type !== 'user' && e.type !== 'assistant') || e.isMeta || e.isSidechain) {
		return undefined;
	}
	const text = blocksText(e.message?.content);
	return text ? { who: e.type, text } : undefined;
}

/** The same for Codex: user_message and agent_message events, and assistant messages of the response stream. */
function codexSaid(e: Record<string, any>): Said | undefined {
	const p = e.payload;
	if (e.type === 'event_msg' && typeof p?.message === 'string') {
		return p.type === 'user_message' ? { who: 'user', text: p.message } : p.type === 'agent_message' ? { who: 'assistant', text: p.message } : undefined;
	}
	if (e.type === 'response_item' && p?.type === 'message' && p.role === 'assistant') {
		const text = blocksText(p.content);
		return text ? { who: 'assistant', text } : undefined;
	}
	return undefined;
}

/** About 200 characters around the first of the words that occurs in the text. Obvious secrets are blanked before the cut, so the cut never leaves half of one. */
export function snippetAround(text: string, words: string[]): string {
	const flat = redact(tidy(text));
	const low = flat.toLowerCase();
	const at = Math.min(...words.map(w => low.indexOf(w)).filter(i => i >= 0));
	const start = Math.max(0, (Number.isFinite(at) ? at : 0) - 70);
	const body = flat.slice(start, start + SNIPPET);
	return `${start > 0 ? '...' : ''}${body}${start + SNIPPET < flat.length ? '...' : ''}`;
}

/** Streams one transcript; resolves the hit (with the first prompt) or undefined. Stops at the first match. */
async function searchFile(c: Candidate, words: string[], budget: { left: number; cut: boolean }): Promise<SessionHit | undefined> {
	// The end option stops the read at the per-file cap, so a huge file never buffers beyond it.
	const stream = fs.createReadStream(c.file, { encoding: 'utf8', end: MAX_FILE_BYTES - 1 });
	const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
	// Bytes are counted as they stream, and the read is closed when the call's budget is spent.
	stream.on('data', chunk => {
		budget.left -= Buffer.byteLength(chunk as string);
		if (budget.left < 0 && !budget.cut) {
			budget.cut = true;
			lines.close();
		}
	});
	let prompt = '';
	const id = c.id;
	let snippet: string | undefined;
	try {
		for await (const line of lines) {
			if (line.length > MAX_LINE_CHARS) {
				continue;
			}
			const needsPrompt = !prompt;
			const low = line.toLowerCase();
			// A cheap test before the parse: a line that lacks one of the words cannot match (a prompt still has to be found).
			if (!needsPrompt && !words.every(w => low.includes(w))) {
				continue;
			}
			if (!low.includes('"user') && !low.includes('"assistant') && !low.includes('agent_message')) {
				continue;
			}
			let said: Said | undefined;
			try {
				const e = JSON.parse(line) as Record<string, any>;
				said = c.agent === 'claude' ? claudeSaid(e) : codexSaid(e);
			} catch {
				continue;
			}
			if (!said) {
				continue;
			}
			const flat = tidy(said.text);
			if (!prompt && said.who === 'user' && flat && !flat.startsWith('<') && !flat.startsWith('Caveat:')) {
				prompt = redact(flat).slice(0, PROMPT);
			}
			const lowText = flat.toLowerCase();
			if (words.every(w => lowText.includes(w))) {
				snippet = snippetAround(flat, words);
				break;
			}
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	return snippet === undefined ? undefined : { agent: c.agent, id, date: new Date(c.modified).toISOString().slice(0, 10), prompt, snippet };
}

/**
 * The newest transcripts of these workspace folders whose prompts or answers contain every word of the query.
 * A hit is a session, shown with the first match in it.
 */
export async function searchSessions(opts: { folders: string[]; query: string; limit: number; agent?: SessionAgent; budgetBytes?: number; maxFiles?: number }): Promise<SessionSearch> {
	const words = queryWords(opts.query);
	if (!words.length || !opts.folders.length) {
		return { hits: [], scanned: 0 };
	}
	const all = [
		...(opts.agent === 'codex' ? [] : await claudeFiles(opts.folders)),
		...(opts.agent === 'claude' ? [] : await codexFiles()),
	].sort((a, b) => b.modified - a.modified);
	const maxFiles = opts.maxFiles ?? MAX_FILES;
	const budget = { left: opts.budgetBytes ?? MAX_TOTAL_BYTES, cut: false };
	const hits: SessionHit[] = [];
	let scanned = 0;
	// The cap counts this workspace's transcripts only: other folders' Codex rollouts must not use up the window.
	for (const candidate of all) {
		if (hits.length >= opts.limit || scanned >= maxFiles) {
			break;
		}
		const c = await owned(candidate, opts.folders);
		if (!c) {
			continue;
		}
		if (budget.left <= 0) {
			budget.cut = true;
			break;
		}
		scanned++;
		const hit = await searchFile(c, words, budget).catch(() => undefined);
		if (hit) {
			hits.push(hit);
		}
		if (budget.cut) {
			break;
		}
	}
	return { hits, scanned, truncated: budget.cut };
}

export function formatSessions(query: string, r: SessionSearch): string {
	const cut = r.truncated ? `\nThe search stopped early: the read budget of ${MAX_TOTAL_BYTES / 1024 / 1024} MB per call was used up, so older sessions were not searched.` : '';
	if (!r.hits.length) {
		return `No past session of this workspace mentions "${redact(query)}" (${r.scanned} transcript${r.scanned === 1 ? '' : 's'} looked at). Try fewer or different words.${cut}`;
	}
	return [
		`${r.hits.length} past session${r.hits.length === 1 ? '' : 's'} for "${redact(query)}", newest first:`,
		// Redacted again here: every line that leaves through the MCP server passes this one place, whoever built the hit.
		...r.hits.map(h => `- [${h.agent}] ${h.date} session ${h.id}\n  first prompt: ${redact(h.prompt) || '(none)'}\n  match: ${redact(h.snippet)}`),
	].join('\n') + cut;
}
