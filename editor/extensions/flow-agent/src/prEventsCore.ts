/*---------------------------------------------------------------------------------------------
 *  Insilode: the rules behind pull request news for an agent, without vscode so they are tested on
 *  their own (prEvents.ts wires them to sessions, timers and settings). A tracker turns successive
 *  snapshots of one PR into events nobody has been told of yet, a queue holds them for one session,
 *  and a daily cap limits how often one PR may send an agent off on its own.
 *--------------------------------------------------------------------------------------------*/

import type { PrNote, PrState } from './prState';

export type PrEventKind = 'checkFailed' | 'changesRequested' | 'conflict' | 'comment' | 'review';

export interface PrEvent {
	kind: PrEventKind;
	text: string;
	/** What makes it the same news again; an event with a key seen before is never raised twice. */
	key: string;
	/** The failing check, for `checkFailed`, so several fold into one phrase. */
	name?: string;
}

export type PrEventSettings = Record<PrEventKind, boolean>;

export const MAX_QUEUE = 10;
export const MAX_LINE = 600;

/** Bots (`dependabot[bot]`, `some-bot`) are not asking for anything. */
export function isBot(login: string): boolean {
	return /(\[bot\]|-bot)$/i.test(login);
}

/** A GitHub login as it may appear in the line: logins are [A-Za-z0-9-] (bots add [bot]); anything else is dropped. */
function login(name: string | undefined): string {
	return (name ?? '').replace(/[^A-Za-z0-9\-[\]]/g, '').slice(0, 40) || 'someone';
}

/**
 * Remembers which news of one PR was already seen. The first snapshot only sets the baseline: what is
 * already there when Insilode starts looking is not news.
 */
export class PrTracker {
	private seen: Set<string> | undefined;

	observe(pr: PrState): PrEvent[] {
		const all = this.events(pr);
		const first = !this.seen;
		const seen = this.seen ??= new Set();
		const fresh: PrEvent[] = [];
		for (const e of all) {
			if (!seen.has(e.key)) {
				seen.add(e.key);
				fresh.push(e);
			}
		}
		return first ? [] : fresh;
	}

	private events(pr: PrState): PrEvent[] {
		const out: PrEvent[] = [];
		const oid = pr.headRefOid ?? '';
		for (const name of pr.failing ?? []) {
			out.push({ kind: 'checkFailed', key: `check:${oid}:${name}`, name, text: `CI failed (${name})` });
		}
		if (pr.mergeable === 'CONFLICTING') {
			out.push({ kind: 'conflict', key: `conflict:${oid}`, text: 'the branch has merge conflicts' });
		}
		const foreign = (n: PrNote) => !!n.author && !isBot(n.author) && n.author.toLowerCase() !== (pr.author ?? '').toLowerCase();
		for (const r of pr.reviews ?? []) {
			if (!foreign(r)) {
				continue;
			}
			// Who did what, never what they wrote: on a public repository anyone can review or comment, and their text typed
			// into the agent's prompt would read as if it came from you. The agent reads it with `gh pr view` itself, as data.
			if (r.state === 'CHANGES_REQUESTED') {
				out.push({ kind: 'changesRequested', key: `cr:${r.id}`, text: `changes requested by ${login(r.author)}` });
			} else if (r.state === 'APPROVED' || r.state === 'COMMENTED') {
				out.push({ kind: 'review', key: `review:${r.id}`, text: `${r.state === 'APPROVED' ? 'approved' : 'reviewed'} by ${login(r.author)}` });
			}
		}
		for (const c of pr.comments ?? []) {
			if (foreign(c)) {
				out.push({ kind: 'comment', key: `comment:${c.id}`, text: `comment by ${login(c.author)}` });
			}
		}
		return out;
	}
}

/** The events a session may hear, per the settings. */
export function allowed(events: PrEvent[], settings: Partial<PrEventSettings>): PrEvent[] {
	return events.filter(e => settings[e.kind] !== false);
}

/** News waiting for one session: at most MAX_QUEUE, the oldest dropped first, no key twice. */
export class EventQueue {
	private items: PrEvent[] = [];

	add(events: PrEvent[]) {
		for (const e of events) {
			if (!this.items.some(i => i.key === e.key)) {
				this.items.push(e);
			}
		}
		if (this.items.length > MAX_QUEUE) {
			this.items = this.items.slice(this.items.length - MAX_QUEUE);
		}
	}

	get size() {
		return this.items.length;
	}

	peek(): readonly PrEvent[] {
		return this.items;
	}

	clear() {
		this.items = [];
	}
}

/** One line for the agent: failing checks folded into one phrase, the rest as they came, under MAX_LINE. */
export function composeLine(number: number, events: readonly PrEvent[]): string {
	const names = events.filter(e => e.kind === 'checkFailed').map(e => e.name);
	const parts: string[] = [];
	if (names.length) {
		parts.push(`CI failed (${names.join(', ')})`);
	}
	for (const e of events) {
		if (e.kind !== 'checkFailed') {
			parts.push(e.text);
		}
	}
	const head = `[Insilode] PR #${number}: `;
	const tail = '. Read the details with `gh pr view --comments` and the failing checks with `gh pr checks`, then look into it.';
	let body = parts.join('; ');
	const room = MAX_LINE - head.length - tail.length;
	if (body.length > room) {
		body = `${body.slice(0, room - 1)}…`;
	}
	return `${head}${body}${tail}`.replace(/\s+/g, ' ');
}

/** Automatic sends per PR per local day. `max` 0 means never automatic. */
export class DailyCap {
	private readonly counts = new Map<string, number>();

	constructor(private readonly now: () => Date = () => new Date()) { }

	private key(pr: string) {
		const d = this.now();
		return `${pr}|${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
	}

	allows(pr: string, max: number): boolean {
		return max > 0 && (this.counts.get(this.key(pr)) ?? 0) < max;
	}

	record(pr: string) {
		const k = this.key(pr);
		this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
		// Yesterday's counts are of no use: keep the map small.
		for (const old of [...this.counts.keys()]) {
			if (!old.endsWith(k.slice(k.indexOf('|')))) {
				this.counts.delete(old);
			}
		}
	}
}
