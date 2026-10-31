/*---------------------------------------------------------------------------------------------
 *  Insilode: what a session has cost so far, in tokens and, where the CLI says, in US dollars. Nothing
 *  here prices tokens itself: there is no price table to go stale. The dollars are the ones Claude
 *  Code's status line reports (`cost.total_cost_usd`, its own API-price estimate since the CLI
 *  started, also on a subscription plan), so the dock labels them "est.". Codex reports no dollars,
 *  and neither does Claude when the user has a status line of their own: then only tokens show.
 *
 *  - Claude Code writes one transcript line per content block of an assistant message, each with the
 *    whole message's `usage`: lines are counted once per `message.id`. `output_tokens` already holds
 *    the thinking tokens, and `iterations[]` repeats the same numbers, so neither is added again.
 *    Subagents write transcripts of their own, `<session>/subagents/agent-<id>.jsonl`: a ledger of its own
 *    counts those (SubagentTotals), apart from the main agent's, and a message is counted once across them.
 *  - Codex's rollout has `token_count` events whose `info.total_token_usage` is the running total;
 *    its `input_tokens` include the cached ones, given again as `cached_input_tokens`.
 *
 *  Transcripts can be hundreds of MB, so they are read once and then only from where the last read
 *  stopped (TranscriptReader). A prompt's share is the running total minus a baseline taken when the
 *  prompt was sent.
 *
 *  Pure (no vscode), so it is tested on its own.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';

export interface Tokens {
	/** Fresh input, not read from or written to the cache. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface Spend {
	tokens: Tokens;
	/** US dollars as the CLI reported them, when it did. */
	usd?: number;
}

/** What the dock shows: the session so far and the prompt it is on (or last finished). */
export interface SessionCost {
	session: Spend;
	/** Absent when the prompt started before Insilode was watching (a reloaded window): its share is unknown. */
	prompt?: Spend;
	/** Where the dollars come from, for the tooltip; absent when there are none. */
	usdSource?: string;
	/** Whose tokens these are, for the tooltip. */
	scope: string;
	/**
	 * Tokens of the conversation from before this CLI started (a resumed session). The dollars count only since the
	 * start, so `session` then holds the tokens since the start too, and this the earlier ones.
	 */
	earlier?: Tokens;
	/** What the session's subagents used, counted apart from `session`; absent when there are none. */
	subagents?: Tokens;
}

export const ZERO: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
const obj = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

export const totalTokens = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

export function addTokens(a: Tokens, b: Tokens): Tokens {
	return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

/** `now - base`, never below zero (a total that went down means the count restarted: then all of `now` is new). */
export function spendSince(now: Spend, base: Spend): Spend {
	const t = now.tokens, b = base.tokens;
	const restarted = t.input < b.input || t.output < b.output || t.cacheRead < b.cacheRead || t.cacheWrite < b.cacheWrite;
	const tokens = restarted ? t : { input: t.input - b.input, output: t.output - b.output, cacheRead: t.cacheRead - b.cacheRead, cacheWrite: t.cacheWrite - b.cacheWrite };
	const usd = now.usd === undefined ? undefined : base.usd === undefined || now.usd < base.usd ? now.usd : now.usd - base.usd;
	return usd === undefined ? { tokens } : { tokens, usd };
}

/** Counts a Claude transcript's tokens, line by line, each assistant message once. */
export class ClaudeLedger {
	tokens: Tokens = { ...ZERO };
	/** The share of `tokens` from messages before `since`, when that was set before the transcript was read. */
	earlier: Tokens = { ...ZERO };
	/** When the CLI started (ms): messages before it belong to an earlier run of the conversation. */
	since?: number;
	model?: string;
	private readonly seen = new Set<string>();

	feed(lines: string[]) {
		for (const l of lines) {
			if (!l.includes('"usage"')) {
				continue; // most lines are tool output: skip them before parsing
			}
			let e: { type?: string; requestId?: string; timestamp?: string; message?: { id?: string; model?: string; usage?: Record<string, unknown> } };
			try {
				e = JSON.parse(l);
			} catch {
				continue;
			}
			const u = e.type === 'assistant' ? obj(e.message?.usage) : undefined;
			if (!u) {
				continue;
			}
			const id = e.message?.id ?? e.requestId;
			if (id) {
				if (this.seen.has(id)) {
					continue;
				}
				this.seen.add(id);
			}
			// Claude Code writes a stand-in message with the model "<synthetic>" for errors it shows: it cost nothing.
			if (e.message?.model && e.message.model !== '<synthetic>') {
				this.model = e.message.model;
			}
			const add = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
			this.tokens = addTokens(this.tokens, add);
			if (this.since !== undefined && Date.parse(e.timestamp ?? '') < this.since) {
				this.earlier = addTokens(this.earlier, add);
			}
		}
	}
}

/** The transcripts of a Claude session's subagents: `<transcript without .jsonl>/subagents/agent-*.jsonl`. */
export const subagentDir = (transcript: string) => path.join(transcript.replace(/\.jsonl$/i, ''), 'subagents');

/** Reads every subagent transcript incrementally and counts each assistant message once, across files too. */
export class SubagentTotals {
	private readonly ledger = new ClaudeLedger();
	private readonly readers = new Map<string, TranscriptReader>();

	get tokens(): Tokens {
		return this.ledger.tokens;
	}

	/** Picks up new subagent files and what the known ones gained. */
	async update(transcript: string): Promise<void> {
		const dir = subagentDir(transcript);
		let names: string[];
		try {
			names = await fs.readdir(dir);
		} catch {
			return; // no subagent has run
		}
		for (const n of names) {
			if (/^agent-.+\.jsonl$/.test(n) && !this.readers.has(n)) {
				this.readers.set(n, new TranscriptReader(path.join(dir, n)));
			}
		}
		for (const r of this.readers.values()) {
			await r.each(lines => this.ledger.feed(lines));
		}
	}
}

/** The newest running total in these Codex rollout lines, if any. */
export function codexTotals(lines: string[]): Tokens | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!lines[i].includes('token_count')) {
			continue;
		}
		let e: { type?: string; payload?: Record<string, unknown> };
		try {
			e = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const p = obj(e.payload);
		const total = obj(obj(p?.info)?.total_token_usage);
		if (e.type === 'event_msg' && p?.type === 'token_count' && total) {
			const cached = num(total.cached_input_tokens);
			return { input: Math.max(0, num(total.input_tokens) - cached), output: num(total.output_tokens), cacheRead: cached, cacheWrite: 0 };
		}
	}
	return undefined;
}

/** The dollars in Claude Code's status-line JSON (`cost.total_cost_usd`), when it sent them. */
export function statusUsd(payload: unknown): number | undefined {
	const v = obj(obj(payload)?.cost)?.total_cost_usd;
	return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Reads a growing file from where it stopped last time, a chunk at a time, and keeps a cut-off last line for next time. */
export class TranscriptReader {
	private offset = 0;
	private rest = '';
	private busy: Promise<void> | undefined;

	constructor(readonly file: string, private readonly chunk = 4 << 20) { }

	/** The complete lines added since the last call. */
	async read(): Promise<string[]> {
		const out: string[] = [];
		await this.each(lines => out.push(...lines));
		return out;
	}

	/**
	 * Hands the new lines to `sink` a chunk at a time, yielding between chunks: the first read of a large transcript
	 * must neither hold it all in memory nor block the extension host. A call during a read waits for that read.
	 */
	each(sink: (lines: string[]) => void): Promise<void> {
		this.busy ??= this.readNew(sink).finally(() => this.busy = undefined);
		return this.busy;
	}

	private async readNew(sink: (lines: string[]) => void): Promise<void> {
		let h: fs.FileHandle;
		try {
			h = await fs.open(this.file, 'r');
		} catch {
			return; // not written yet
		}
		try {
			const { size } = await h.stat();
			if (size < this.offset) {
				// Shorter than before: a new file in its place. Start over.
				this.offset = 0;
				this.rest = '';
			}
			const buf = Buffer.alloc(Math.min(this.chunk, Math.max(1, size - this.offset)));
			while (this.offset < size) {
				const { bytesRead } = await h.read(buf, 0, Math.min(buf.length, size - this.offset), this.offset);
				if (!bytesRead) {
					break;
				}
				this.offset += bytesRead;
				// A chunk can end inside a multibyte character: cut at the last newline, whose bytes are never part of one.
				const slice = buf.subarray(0, bytesRead);
				const nl = slice.lastIndexOf(0x0a);
				if (nl < 0) {
					this.rest += slice.toString('utf8');
					continue;
				}
				const text = this.rest + slice.toString('utf8', 0, nl);
				this.rest = slice.toString('utf8', nl + 1);
				sink(text.split('\n').filter(Boolean));
				if (this.offset < size) {
					await new Promise(resolve => setImmediate(resolve));
				}
			}
		} finally {
			await h.close();
		}
	}
}

/**
 * One session's running cost: its transcript, the totals so far, the dollars the CLI last reported and the
 * baseline of the current prompt.
 */
export class CostTracker {
	private readonly ledger = new ClaudeLedger();
	private codex: Tokens | undefined;
	private reader: TranscriptReader | undefined;
	private subagents = new SubagentTotals();
	private usd: number | undefined;
	private base: Spend | undefined;

	constructor(readonly cli: 'claude' | 'codex') { }

	/** Reads what the transcript gained since last time (a new path starts over). */
	async update(file: string | undefined) {
		if (!file) {
			return;
		}
		if (this.reader?.file !== file) {
			this.reader = new TranscriptReader(file);
			this.subagents = new SubagentTotals();
		}
		await this.reader.each(lines => {
			if (this.cli === 'codex') {
				this.codex = codexTotals(lines) ?? this.codex;
			} else {
				this.ledger.feed(lines);
			}
		});
		if (this.cli === 'claude') {
			await this.subagents.update(file).catch(() => undefined);
		}
	}

	/**
	 * The CLI starts now, before its transcript is read: what the transcript holds from before (a resumed conversation)
	 * is kept apart, since the dollars Claude Code reports count only from its start.
	 */
	started(at: number) {
		if (!this.reader) {
			this.ledger.since = at;
		}
	}

	/** Claude's status line said what the CLI has spent so far. */
	setUsd(usd: number | undefined) {
		if (usd !== undefined) {
			this.usd = usd;
		}
	}

	get total(): Spend {
		const tokens = this.cli === 'codex' ? this.codex ?? { ...ZERO } : this.ledger.tokens;
		return this.usd === undefined ? { tokens } : { tokens, usd: this.usd };
	}

	/** A prompt was sent: what comes after it is that prompt's. */
	markPrompt() {
		this.base = this.total;
	}

	/** Undefined until the session has used a token. */
	snapshot(): SessionCost | undefined {
		const session = this.total;
		// Before the first request the status line already reports $0: nothing to show yet.
		if (!totalTokens(session.tokens)) {
			return undefined;
		}
		const earlier = this.cli === 'claude' && totalTokens(this.ledger.earlier) ? this.ledger.earlier : undefined;
		const subagents = this.cli === 'claude' && totalTokens(this.subagents.tokens) ? { ...this.subagents.tokens } : undefined;
		return {
			// A resumed conversation: the session line counts from this CLI's start, like the dollars beside it.
			session: earlier ? spendSince(session, { tokens: earlier }) : session,
			...(earlier ? { earlier } : {}),
			...(subagents ? { subagents } : {}),
			...(this.base ? { prompt: spendSince(session, this.base) } : {}),
			...(session.usd !== undefined ? { usdSource: 'Claude Code\'s own estimate at API prices, since this CLI started' } : {}),
			scope: this.cli === 'codex' ? 'Codex session' : subagents ? 'main agent (subagents counted apart)' : 'main agent (subagents not included)',
		};
	}
}
