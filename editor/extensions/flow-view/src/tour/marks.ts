/*---------------------------------------------------------------------------------------------
 *  Insilode: the pen marks of a tour step as the `tour` tool sends them (`steps[].marks`, in source terms) turned into the
 *  TourMark list the canvas draws (protocol/flow.ts). Lines are resolved like a step's `highlights` (current-file, the same
 *  drift handling) and `to` like a step's `at`. A mark that cannot be placed is dropped and said so in `notes`, which the
 *  tool answer shows next to the step's ok / moved / missing state. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { TourMark, TourStep } from '../../../../../protocol/flow';
import { MAX_HIGHLIGHT_LINES, placeStep, positive, type Method } from './resolve';

/** Most marks one step carries. */
export const MAX_MARKS = 6;
export const MAX_MARK_LABEL = 40;
export const MAX_MARK_SENTENCE = 6;

/**
 * A mistake in a tool call's marks, named by field. validate.ts's TourFileError cannot be used here (it imports this file, and a
 * module cycle is forbidden); the MCP handler turns any Error into the tool's answer, so the agent reads it the same way.
 */
export class MarkError extends Error { }

export interface MarkContext {
	/** "steps[2]": names the step in an error. */
	where: string;
	/** A tool call (a mistake is an error that names the field) rather than a tour file (what is wrong is dropped). */
	strict: boolean;
	/** The step the marks are on, already placed: its `at` and `highlights` say where its code is. */
	step: TourStep;
	/** The step's file, absolute and inside the workspace; nothing for a caption-only or table step. */
	file?: string;
	/** The step's file text, for resolving `lines`. */
	text?: string;
	/** What validate.ts's TourFileHost gives (spelled out here: importing it would make a cycle). */
	host: { roots: string[]; readText(file: string): string | undefined; methodsIn?(file: string): readonly Method[] | undefined };
}

const KINDS: readonly TourMark['kind'][] = ['ring', 'underline', 'strike', 'check', 'cross', 'badge', 'connect'];
const MARK_KEYS = ['kind', 'lines', 'n', 'to', 'label', 'sentence'];
const TO_KEYS = ['file', 'method', 'line'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/g;
/** Plain text: control characters become spaces, runs of spaces one. */
const plain = (v: unknown) => typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim() : '';

/** The same check validate.ts's `insideWorkspace` makes (a copy: importing it would make a cycle). */
function inside(roots: readonly string[], file: string): string | undefined {
	// eslint-disable-next-line no-control-regex
	if (/[\x00-\x1f\x7f-\x9f]/.test(file)) {
		return undefined;
	}
	for (const root of roots) {
		const abs = path.resolve(root, file);
		const rel = path.relative(root, abs);
		if (rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) {
			return abs;
		}
	}
	return undefined;
}

/** A mark whose shape was checked: the line range and the target are still the agent's words. */
interface Shaped {
	/** 1-based position in the agent's list, for the notes. */
	n: number;
	kind: TourMark['kind'];
	lines?: unknown;
	badge?: number;
	to?: { file: string; method: string; line?: number };
	label?: string;
	sentence?: number;
}

/**
 * First pass: what each mark says, checked. In a tool call a mistake is an error naming `steps[i].marks[j].field`; in a tour file
 * what is wrong is dropped (a mark with a bad `kind`, or just the bad optional field).
 */
function shape(raw: unknown, ctx: MarkContext): Shaped[] {
	const { where, strict } = ctx;
	const fail = (message: string): void => {
		if (strict) {
			throw new MarkError(message);
		}
	};
	if (!Array.isArray(raw)) {
		fail(`${where}.marks must be a list of marks.`);
		return [];
	}
	if (raw.length > MAX_MARKS) {
		fail(`${where}.marks has ${raw.length} marks; a step has at most ${MAX_MARKS}. Mark what the caption is about, not every line.`);
	}
	const out: Shaped[] = [];
	raw.slice(0, MAX_MARKS).forEach((m, j) => {
		const at = `${where}.marks[${j}]`;
		if (!isObject(m)) {
			fail(`${at} is not an object.`);
			return;
		}
		const strange = Object.keys(m).find(k => !MARK_KEYS.includes(k));
		if (strange) {
			fail(`${at}.${strange} is not a field of a mark (allowed: ${MARK_KEYS.join(', ')}).`);
			return;
		}
		const kind = KINDS.find(k => k === m.kind);
		if (!kind) {
			fail(`${at}.kind must be one of: ${KINDS.join(', ')}.`);
			return;
		}
		const mark: Shaped = { n: j + 1, kind, lines: m.lines };
		if (m.n !== undefined) {
			if (typeof m.n === 'number' && Number.isInteger(m.n) && m.n >= 1 && m.n <= 99) {
				mark.badge = m.n;
			} else {
				fail(`${at}.n must be a whole number from 1 to 99.`);
				if (kind === 'badge') {
					return;
				}
			}
		}
		if (m.label !== undefined) {
			const label = plain(m.label);
			if (typeof m.label === 'string' && label.length <= MAX_MARK_LABEL) {
				if (label) {
					mark.label = label;
				}
			} else {
				fail(`${at}.label must be text of at most ${MAX_MARK_LABEL} characters.`);
			}
		}
		if (m.sentence !== undefined) {
			if (typeof m.sentence === 'number' && Number.isInteger(m.sentence) && m.sentence >= 1 && m.sentence <= MAX_MARK_SENTENCE) {
				mark.sentence = m.sentence;
			} else {
				fail(`${at}.sentence must be a whole number from 1 to ${MAX_MARK_SENTENCE}: the caption sentence the mark appears with.`);
			}
		}
		if (kind === 'connect' && m.to !== undefined) {
			const to = m.to;
			if (!isObject(to)) {
				fail(`${at}.to must be an object: { file, method?, line? }.`);
			} else {
				const unknown = Object.keys(to).find(k => !TO_KEYS.includes(k));
				if (unknown) {
					fail(`${at}.to.${unknown} is not a field of \`to\` (allowed: ${TO_KEYS.join(', ')}).`);
				} else if (typeof to.file === 'string' && to.file) {
					mark.to = { file: to.file, method: plain(to.method).slice(0, 200), line: positive(to.line) ? to.line : undefined };
				} else {
					fail(`${at}.to.file is missing.`);
				}
			}
		}
		out.push(mark);
	});
	return out;
}

/** `lines` as `[from, to]`, sorted and cut to the length a highlight may have; nothing when it is not one or two positive whole numbers. */
function rangeOf(raw: unknown): [number, number] | undefined {
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) {
		return undefined;
	}
	const [a, b = a] = raw;
	if (!positive(a) || !positive(b)) {
		return undefined;
	}
	const from = Math.min(a, b);
	return [from, Math.min(Math.max(a, b), from + MAX_HIGHLIGHT_LINES - 1)];
}

const rangeText = (r: [number, number]) => (r[0] === r[1] ? `line ${r[0]} is` : `lines ${r[0]}-${r[1]} are`);

/** The marks of one step, placed. `raw` is the step's `marks` as written; the marks come back in the agent's order. */
export function parseMarks(raw: unknown, ctx: MarkContext): { marks: TourMark[]; notes: string[] } {
	// Pass one checks the shape (and throws in a tool call), so a malformed mark is heard about even on a step that is missing.
	const shaped = shape(raw, ctx);
	const marks: TourMark[] = [];
	const notes: string[] = [];
	if (!shaped.length) {
		return { marks, notes };
	}
	const at = ctx.step.at;
	// A step that points at no code has no card to draw on, and a missing one must never be drawn on a wrong place.
	if (!at || !at.file || ctx.step.state === 'missing') {
		notes.push(`${shaped.length === 1 ? 'the mark was' : 'the marks were'} dropped: ${ctx.step.state === 'missing' ? "the step's code was not found" : 'the step points at no code'}`);
		return { marks, notes };
	}
	for (const m of shaped) {
		const done: TourMark = { kind: m.kind };
		const why = `mark ${m.n} (${m.kind})`;
		if (m.kind === 'connect') {
			if (!m.to) {
				notes.push(`${why}: needs \`to\` (file and method) and was dropped`);
				continue;
			}
			const abs = inside(ctx.host.roots, m.to.file);
			const name = `${m.to.file}${m.to.method ? `:${m.to.method}` : m.to.line ? `:${m.to.line}` : ''}`;
			const placed = abs ? placeStep({ caption: '', method: m.to.method || undefined, line: m.to.line }, { file: abs, methods: ctx.host.methodsIn?.(abs), text: ctx.host.readText(abs), base: path.basename(abs) }) : undefined;
			const target = placed?.step.at;
			if (!placed || !target || placed.step.state === 'missing') {
				notes.push(`${why}: connect to ${name} not found${placed?.note ? ` (${placed.note})` : abs ? '' : ' (not inside the workspace)'}; dropped`);
				continue;
			}
			done.to = { file: target.file, startLine: target.startLine, endLine: target.endLine, label: target.label };
		} else {
			const range = rangeOf(m.lines);
			if (!range) {
				notes.push(`${why}: needs \`lines\` ([from] or [from, to]) and was dropped`);
				continue;
			}
			// The lines are the current file's, and must lie in the step's own code: a mark on code the card does not show has nothing to sit on.
			if (range[0] < at.startLine || range[1] > at.endLine) {
				notes.push(`${why}: ${rangeText(range)} outside ${at.label}; dropped`);
				continue;
			}
			done.lines = range;
			if (m.kind === 'badge') {
				if (m.badge === undefined) {
					notes.push(`${why}: needs \`n\` and was dropped`);
					continue;
				}
				done.n = m.badge;
			}
		}
		if (m.label) {
			done.label = m.label;
		}
		if (m.sentence !== undefined) {
			done.sentence = m.sentence;
		}
		marks.push(done);
	}
	return { marks, notes };
}
