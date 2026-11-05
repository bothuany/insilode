/*---------------------------------------------------------------------------------------------
 *  Insilode: the pure part of what an agent changed per card, for Keep and for edits made by a shell command. (The turn
 *  impact's "which methods did an edit land in" lives in src/mcp/changedMethods.ts; this file is about the hunks of one
 *  file against its baseline.) No vscode, so it is tested on its own (test/keepCard.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import { structuredPatch } from 'diff';
import { rangeOfHunk, rangeTouches } from './mcp/changedMethods';

/** One hunk of `structuredPatch` with no context (old -> new, 1-based). */
export interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

/** The hunks that turn `base` into `now`, without context lines. Equal texts have none. */
export function hunksBetween(base: string, now: string): Hunk[] {
	return base === now ? [] : structuredPatch('a', 'b', base, now, '', '', { context: 0 }).hunks;
}

/** The text with a line ending, for putting lines back exactly as they were. */
const lineWithEol = (lines: string[], i: number) => lines[i].slice(1) + (lines[i + 1]?.startsWith('\\') ? '' : '\n');

/** Splits keeping each line's own "\n", the way the patch counts lines (the last line may have none). */
const splitKeepEol = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** `now` with the given hunks put back to their old lines: the file as it would be had only the other hunks happened. */
export function revertHunks(now: string, hunks: readonly Hunk[]): string {
	const lines = splitKeepEol(now);
	// From the bottom up, so an edit never moves the lines the next one counts from.
	for (const h of [...hunks].sort((a, b) => b.newStart - a.newStart)) {
		const old: string[] = [];
		h.lines.forEach((l, i) => l.startsWith('-') && old.push(lineWithEol(h.lines, i)));
		lines.splice(h.newStart - 1, h.newLines, ...old);
	}
	return lines.join('');
}

export interface KeepResult {
	/** The baseline after Keep: the file with only the hunks outside the card still counted as changes. */
	baseline: string;
	/** How many hunks Keep took in. */
	kept: number;
	/** The hunks still shown as changes. */
	left: number;
}

/**
 * Keep the hunks inside the lines `start`..`end` (the same test as Undo's, so a card keeps exactly what it shows): the
 * returned baseline holds them as part of the file, and the rest still differ from it. The kept hunks are remembered by
 * being in the baseline, which is a text and not line numbers: lines added or removed above them later cannot bring them
 * back. When nothing is left, `left` is 0 and the baseline equals `now`.
 */
export function keepInRange(base: string, now: string, start: number, end: number): KeepResult {
	const hunks = hunksBetween(base, now);
	const inside = hunks.filter(h => rangeTouches(rangeOfHunk(h), start, end));
	const outside = hunks.filter(h => !inside.includes(h));
	return { baseline: revertHunks(now, outside), kept: inside.length, left: outside.length };
}

/** What a command's change is measured against: nothing known, or a text, or the file did not exist. */
export type HeadText = { state: 'found'; text: string } | { state: 'absent' } | { state: 'unknown' };

export interface CommandBaseline {
	text: string;
	/** The file did not exist before the command. */
	created: boolean;
	from: 'turn-start' | 'head' | 'created';
}

/**
 * Where the baseline of a file a command changed comes from. The turn-start snapshot the tracker holds wins (a tool, or
 * another step of this prompt, saw the file before it changed); else the text at HEAD; a file HEAD does not have is new,
 * so its baseline is empty. Undefined when none is known: nothing is recorded rather than a guess Undo would write back.
 */
export function chooseCommandBaseline(turnStart: string | undefined, head: HeadText): CommandBaseline | undefined {
	if (turnStart !== undefined) {
		return { text: turnStart, created: false, from: 'turn-start' };
	}
	switch (head.state) {
		case 'found': return { text: head.text, created: false, from: 'head' };
		case 'absent': return { text: '', created: true, from: 'created' };
		default: return undefined;
	}
}

/** The size above which a command's change is not reviewed (the timeline file holds no text longer than this either). */
export const MAX_REVIEW_TEXT = 1_000_000;

/** Whether text holds a NUL in its first part: a binary file, which has no lines to review. */
export const looksBinary = (text: string) => text.slice(0, 8000).includes('\0');

/** Whether a command's change to a file is worth a card: it differs, is text, and is not too large to compare. */
export function reviewable(baseline: string, current: string): 'ok' | 'same' | 'binary' | 'large' {
	if (looksBinary(baseline) || looksBinary(current)) {
		return 'binary';
	}
	if (baseline.length > MAX_REVIEW_TEXT || current.length > MAX_REVIEW_TEXT) {
		return 'large';
	}
	return baseline === current ? 'same' : 'ok';
}
