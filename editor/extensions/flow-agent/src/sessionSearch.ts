/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page's session search. Looks for a text in what the user and the agent SAID in the sessions the host
 *  lists (the same ones the page can open): the text blocks of Claude's jsonl transcripts and the message events of Codex's
 *  rollouts. Tool calls, tool results, thoughts and a hook's injected lines are left out on purpose: a result blob (a file, a
 *  build log) would match nearly any word and bury the conversation. Bounded in files, bytes per file, time and hits; async fs;
 *  never throws; stops when `signal` aborts. A snippet is text from any project on the machine: it is returned to the caller
 *  and nowhere else (no logging here). Only fs (no vscode): tested on its own (test/sessionSearch.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { slice } from './sessionIndex';

export const MIN_QUERY = 2;
export const MAX_QUERY = 200;
/** The newest sessions looked into, bytes read from the start of each, the whole search's time and the hits kept. */
const MAX_FILES = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BUDGET_MS = 3000;
const MAX_HITS = 50;
const SNIPPET = 160;
/** Files read at once: a few, so one slow disk does not hold up the rest, and still in the order of their age. */
const CHUNK = 6;

export interface SearchSession {
	id: string;
	kind: 'claude' | 'codex';
	title: string;
	modified: number;
}
export interface SearchProject {
	key: string;
	sessions: SearchSession[];
}
export interface SessionHit {
	project: string;
	kind: 'claude' | 'codex';
	session: string;
	title: string;
	modified: number;
	snippet: string;
}
export interface SearchLimits {
	files?: number;
	fileBytes?: number;
	ms?: number;
	hits?: number;
}

/** Whitespace runs (and newlines) as one space, as the page draws a snippet. */
export const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => v && typeof v === 'object' ? v as Rec : undefined;

/** The text blocks of a message's content (a string, or blocks of which only `text` ones count). */
function blocksText(content: unknown, types: string[]): string[] {
	if (typeof content === 'string') {
		return [content];
	}
	return Array.isArray(content)
		? content.map(rec).filter(b => b && types.includes(b.type as string) && typeof b.text === 'string').map(b => b!.text as string)
		: [];
}

/** What one transcript line says, as user or assistant text; nothing for every other kind of line. */
export function saidIn(line: string, kind: 'claude' | 'codex'): string[] {
	let e: Rec | undefined;
	try {
		e = rec(JSON.parse(line));
	} catch {
		return [];
	}
	if (!e) {
		return [];
	}
	if (kind === 'claude') {
		return (e.type === 'user' || e.type === 'assistant') && !e.isMeta && !e.isSidechain ? blocksText(rec(e.message)?.content, ['text']) : [];
	}
	const p = rec(e.payload);
	if (e.type === 'event_msg' && (p?.type === 'user_message' || p?.type === 'agent_message') && typeof p.message === 'string') {
		return [p.message];
	}
	return e.type === 'response_item' && p?.type === 'message' && p.role === 'assistant' ? blocksText(p.content, ['output_text']) : [];
}

/**
 * The case-insensitive form of a text, with exactly the length of the text: a match index found in it is an index of the original.
 * `toLowerCase` keeps every code point's UTF-16 length but one (U+0130 `İ` becomes two units), so that one is folded to `i`.
 * U+0131 `ı` is folded to `i` too, so a Turkish search typed with the dotless `ı` finds `I` and the other way round.
 * The page folds the same way to mark the match (agentsPage.ts).
 */
export const fold = (s: string) => s.replace(/[\u0130\u0131]/g, 'i').toLowerCase();

/** About 160 characters around the first match (a long match leaves less room before it), with an ellipsis where the text goes on; a surrogate pair is never cut in two. */
export function snippetAround(flat: string, at: number, length: number): string {
	let from = Math.max(0, at - Math.max(0, Math.min(50, SNIPPET - length)));
	if (from > 0 && isLowSurrogate(flat.charCodeAt(from))) {
		from--;
	}
	let end = from + SNIPPET;
	if (end < flat.length && isHighSurrogate(flat.charCodeAt(end - 1))) {
		end++;
	}
	return `${from > 0 ? '…' : ''}${flat.slice(from, end)}${end < flat.length ? '…' : ''}`;
}
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;

async function inFile(file: string, kind: 'claude' | 'codex', needle: string, bytes: number, signal: AbortSignal): Promise<string | undefined> {
	for (const line of await slice(file, 'head', bytes).catch(() => [] as string[])) {
		if (signal.aborted) {
			return undefined;
		}
		for (const text of saidIn(line, kind)) {
			const flat = tidy(text);
			const at = fold(flat).indexOf(needle);
			if (at >= 0) {
				return snippetAround(flat, at, needle.length);
			}
		}
	}
	return undefined;
}

/**
 * The sessions of `projects` (newest first) whose conversation contains `query` (case-insensitive), each with one snippet around
 * its first match. `more`: there may be more (the hit cap was reached, or the file or time budget ended the search first). `cut`:
 * sessions were not searched in full (too many files, a file larger than the bytes read, or time ran out): an empty answer is not "none".
 * `fileOf` names a session's transcript; one it does not know is skipped. Returns what it has when `signal` aborts or time runs out.
 */
export async function searchSessions(
	projects: SearchProject[],
	fileOf: (kind: 'claude' | 'codex', id: string) => string | undefined,
	query: string,
	signal: AbortSignal,
	limits: SearchLimits = {},
): Promise<{ hits: SessionHit[]; more: boolean; cut: boolean }> {
	const needle = fold(tidy(query));
	const hits: SessionHit[] = [];
	let more = false;
	let cut = false;
	if (needle.length < MIN_QUERY || needle.length > MAX_QUERY) {
		return { hits, more, cut };
	}
	const maxHits = limits.hits ?? MAX_HITS;
	const all = projects.flatMap(p => p.sessions.map(s => ({ project: p.key, s }))).sort((a, b) => b.s.modified - a.s.modified);
	const todo = all.slice(0, limits.files ?? MAX_FILES);
	more = cut = all.length > todo.length;
	let timer: NodeJS.Timeout | undefined;
	let timedOut = false;
	const run = (async () => {
		for (let i = 0; i < todo.length; i += CHUNK) {
			if (signal.aborted || timedOut) {
				return;
			}
			const chunk = todo.slice(i, i + CHUNK);
			const found = await Promise.all(chunk.map(async ({ project, s }) => {
				const file = fileOf(s.kind, s.id);
				const bytes = limits.fileBytes ?? MAX_FILE_BYTES;
				const snippet = file ? await inFile(file, s.kind, needle, bytes, signal) : undefined;
				// Only the first `bytes` of a file are read: a miss in a larger one is not a miss in all of it.
				if (snippet === undefined && file && ((await fs.stat(file).catch(() => undefined))?.size ?? 0) > bytes) {
					cut = more = true;
				}
				return snippet === undefined ? undefined : { project, kind: s.kind, session: s.id, title: s.title, modified: s.modified, snippet };
			}));
			if (signal.aborted || timedOut) {
				return;
			}
			for (const h of found) {
				if (h && hits.length < maxHits) {
					hits.push(h);
				} else if (h) {
					more = true;
				}
			}
			if (hits.length >= maxHits) {
				more = more || i + CHUNK < todo.length;
				return;
			}
		}
	})().catch(() => undefined);
	await Promise.race([run, new Promise<void>(resolve => timer = setTimeout(() => { timedOut = true; more = cut = true; resolve(); }, limits.ms ?? BUDGET_MS))]);
	clearTimeout(timer);
	return { hits: signal.aborted ? [] : hits.slice(0, maxHits), more, cut };
}
