/*---------------------------------------------------------------------------------------------
 *  Insilode: a tour file (a hand-written JSON, later a saved tour or a tour from a pull request) turned into the Tour the canvas
 *  plays. A tour file is untrusted input, like any tool call: paths stay inside the workspace, limits are checked, captions
 *  are plain text with control characters stripped, and every field that is not part of the format is dropped (there are
 *  deliberately no commands and no URIs in a tour). Pure: no `vscode`, so it is tested under plain Node and the MCP `tour`
 *  tool (phase 1) can reuse it.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { Tour, TourStep } from '../../../../../protocol/flow';
import { prose } from './ask';
import { parseFollowUps } from './followUps';
import { parseMarks } from './marks';
import { parseHighlights, placeStep, positive, type Method, type StepInput } from './resolve';
import { parseWait } from './wait';

export const MAX_STEPS = 30;
export const MAX_CAPTION = 600;
export const MAX_TITLE = 120;
export const MAX_STEP_TITLE = 80;

/** The canvas this tour wants to play on. Omitted: the canvas the user has open, else the flow of the first step's code. */
export interface TourFlow {
	/** An endpoint as written in the endpoint list: "POST /api/orders". */
	http?: string;
	/** An entry point id from the index. */
	id?: string;
	/** An absolute workspace file, and a line inside the method. */
	file?: string;
	line?: number;
	/** With `file`: the method to open the flow of. */
	method?: string;
	changes?: boolean;
	/** With `changes`: what the changes are measured against. */
	base?: 'uncommitted' | 'branch' | 'last_commit';
}

export class TourFileError extends Error { }

export interface TourFileHost {
	/** Absolute paths of the workspace folders: a step may only point at code inside one. */
	roots: string[];
	/** The file's text, or nothing when it cannot be read. Used for the peek card of a step that is on no drawn flow. */
	readText(file: string): string | undefined;
	/** The methods of a file, when the host could list them (the code index, the C# analyzer or a language server): steps are then placed by name. */
	methodsIn?(file: string): readonly Method[] | undefined;
}

/** `file` as an absolute path inside one of the roots, else nothing (`../../etc/passwd`, another drive, an absolute path elsewhere). */
export function insideWorkspace(roots: readonly string[], file: string): string | undefined {
	// A name with a line break or a control character is not a file a tour points at: it would end up in a terminal prompt.
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

const CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/g;

/** Plain text: control characters become spaces (a tab or a newline too), runs of spaces one. Length is checked by the caller. */
const plain = (v: unknown) => typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim() : '';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function tooLong(what: string, text: string, max: number) {
	if (text.length > max) {
		throw new TourFileError(`${what} is ${text.length} characters long; at most ${max} are shown.`);
	}
}

const FLOW_KEYS = ['http', 'id', 'file', 'method', 'line', 'changes', 'base'];
const STEP_KEYS = ['title', 'caption', 'file', 'method', 'line', 'lines', 'table', 'anchor', 'hash', 'notes', 'marks', 'wait'];
const TOUR_KEYS = ['id', 'title', 'flow', 'steps', 'start', 'followUps'];
const BASES: readonly string[] = ['uncommitted', 'branch', 'last_commit'];

/** In a tool call a field Insilode does not know is a mistake the agent should hear about; in a file it is dropped. */
function noStrangers(what: string, raw: Record<string, unknown>, known: readonly string[], strict: boolean) {
	const strange = Object.keys(raw).filter(k => !known.includes(k));
	if (strict && strange.length) {
		throw new TourFileError(`${what}.${strange[0]} is not a field of ${what.startsWith('steps') ? 'a tour step' : what === 'flow' ? 'flow' : 'a tour'} (allowed: ${known.join(', ')}).`);
	}
}

function parseFlow(raw: unknown, host: TourFileHost, strict: boolean): TourFlow | undefined {
	if (!isObject(raw)) {
		return undefined;
	}
	noStrangers('flow', raw, strict ? FLOW_KEYS.filter(k => k !== 'http') : FLOW_KEYS, strict);
	const flow: TourFlow = {};
	const http = plain(raw.http);
	if (http) {
		flow.http = http.slice(0, 200);
	}
	const id = plain(raw.id);
	if (id) {
		flow.id = id.slice(0, 400);
	}
	if (typeof raw.file === 'string' && raw.file) {
		const file = insideWorkspace(host.roots, raw.file);
		if (!file) {
			throw new TourFileError(`flow.file "${raw.file}" is not inside the workspace.`);
		}
		flow.file = file;
		if (positive(raw.line)) {
			flow.line = raw.line;
		}
		const method = plain(raw.method).slice(0, 200);
		if (method) {
			flow.method = method;
		}
	}
	if (raw.changes === true) {
		flow.changes = true;
		if (typeof raw.base === 'string' && BASES.includes(raw.base)) {
			flow.base = raw.base as TourFlow['base'];
		} else if (strict && raw.base !== undefined) {
			throw new TourFileError(`flow.base must be one of: ${BASES.join(', ')}.`);
		}
	}
	return Object.keys(flow).length ? flow : undefined;
}

/** What one raw step says, checked: the fields every step may have. `file` is the absolute path, or undefined when it names a place outside the workspace. */
interface Cleaned { input: StepInput; given: string; abs: string | undefined }

function cleanStep(raw: unknown, i: number, host: TourFileHost, strict: boolean): Cleaned {
	const where = `steps[${i}]`;
	if (!isObject(raw)) {
		throw new TourFileError(`${where} is not an object.`);
	}
	noStrangers(where, raw, STEP_KEYS, strict);
	const caption = prose(raw.caption);
	if (!caption) {
		throw new TourFileError(`${where}.caption is missing: every step says something.`);
	}
	tooLong(`${where}.caption`, caption, MAX_CAPTION);
	const title = plain(raw.title);
	tooLong(`${where}.title`, title, MAX_STEP_TITLE);
	const given = typeof raw.file === 'string' ? raw.file : '';
	const abs = given ? insideWorkspace(host.roots, given) : undefined;
	if (strict && given && !abs) {
		throw new TourFileError(`${where}.file "${given}" is not inside the workspace; only files inside it can be shown.`);
	}
	const table = plain(raw.table).slice(0, 200);
	const method = plain(raw.method).slice(0, 200);
	const input: StepInput = { caption };
	if (title) {
		input.title = title;
	}
	if (table) {
		input.table = table;
	}
	if (method) {
		input.method = method;
	}
	if (positive(raw.line)) {
		input.line = raw.line;
	} else if (strict && raw.line !== undefined) {
		throw new TourFileError(`${where}.line must be a whole number of 1 or more.`);
	}
	const lines = parseHighlights(raw.lines);
	if (lines.length) {
		input.lines = lines;
	}
	return { input, given, abs };
}

/** The workspace files the steps of a raw tour name, once each: what the host lists the methods of before the tour is placed. */
export function stepFiles(raw: unknown, roots: readonly string[]): string[] {
	const steps = isObject(raw) && Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_STEPS) : [];
	const files = new Set<string>();
	for (const s of steps) {
		const abs = isObject(s) && typeof s.file === 'string' && s.file && !plain(s.table) ? insideWorkspace(roots, s.file) : undefined;
		if (abs) {
			files.add(abs);
		}
		// A connect mark ends at another file's code: its methods are listed too.
		for (const m of isObject(s) && Array.isArray(s.marks) ? s.marks.slice(0, 6) : []) {
			const to = isObject(m) && isObject(m.to) && typeof m.to.file === 'string' ? insideWorkspace(roots, m.to.file) : undefined;
			if (to) {
				files.add(to);
			}
		}
	}
	return [...files];
}

export interface ParsedTour {
	tour: Tour;
	flow: TourFlow | undefined;
	/** One entry per step: what to tell the agent (where a method went, what is closest to a name that is gone). */
	notes: (string | undefined)[];
}

/** The steps of a tour (or of a tour edit), checked and placed: one step and one note for the agent per raw step. */
export function parseTourSteps(rawSteps: unknown, host: TourFileHost, strict: boolean, max = MAX_STEPS): { steps: TourStep[]; notes: (string | undefined)[] } {
	if (!Array.isArray(rawSteps) || !rawSteps.length) {
		throw new TourFileError('"steps" must list at least one step.');
	}
	if (rawSteps.length > max) {
		throw new TourFileError(`"steps" has ${rawSteps.length} steps; a tour has at most ${max}. A longer one is a document: split it into two tours.`);
	}
	// A file named by several steps is read once.
	const cache = new Map<string, string | undefined>();
	const readText = (f: string) => (cache.has(f) ? cache.get(f) : cache.set(f, host.readText(f)).get(f));
	const steps: TourStep[] = [];
	const notes: (string | undefined)[] = [];
	rawSteps.forEach((raw, i) => {
		const { input, given, abs } = cleanStep(raw, i, host, strict);
		// A step Insilode cannot place is shown greyed with its caption, and never points at a wrong card.
		const placed = given && !abs
			? { step: { title: input.title ?? '', caption: input.caption, state: 'missing' as const, at: { file: '', startLine: input.line ?? 0, endLine: input.line ?? 0, label: input.method || path.basename(given) } }, note: 'the file is outside the workspace' }
			: placeStep(input, { file: abs, methods: abs ? host.methodsIn?.(abs) : undefined, text: abs ? readText(abs) : undefined, base: abs ? path.basename(abs) : undefined });
		placed.step.title ||= `Step ${i + 1}`;
		// Pen marks and a hands-on wait: what cannot be used is dropped, and the agent hears why in the step's note.
		const extra: string[] = [];
		const given_ = isObject(raw) ? raw : {};
		if (given_.marks !== undefined) {
			const marks = parseMarks(given_.marks, { where: `steps[${i}]`, strict, step: placed.step, file: abs, text: abs ? readText(abs) : undefined, host });
			if (marks.marks.length) {
				placed.step.marks = marks.marks;
			}
			extra.push(...marks.notes);
		}
		if (given_.wait !== undefined) {
			const wait = parseWait(given_.wait, { where: `steps[${i}]`, strict });
			if (wait.wait) {
				placed.step.wait = wait.wait;
			}
			if (wait.note) {
				extra.push(wait.note);
			}
		}
		steps.push(placed.step);
		notes.push([placed.note, ...extra].filter(Boolean).join('; ') || undefined);
	});
	return { steps, notes };
}

/** A tour file. Throws a TourFileError naming the bad field. */
export function parseTourFile(raw: unknown, host: TourFileHost): ParsedTour {
	if (!isObject(raw)) {
		throw new TourFileError('A tour file is a JSON object.');
	}
	// Tour files saved before the rename (Axle) carry "axleTour": they are the users' own files, so they keep loading.
	const format = raw.insilodeTour ?? raw.axleTour;
	if (format !== 1) {
		throw new TourFileError(`"insilodeTour": 1 is missing (this file says ${JSON.stringify(format)}): not a tour file, or one from a newer Insilode.`);
	}
	const id = plain(raw.id);
	if (!/^[\w.-]{1,64}$/.test(id)) {
		throw new TourFileError('"id" is missing or not a name of letters, digits, - _ . (at most 64).');
	}
	const title = plain(raw.title);
	if (!title) {
		throw new TourFileError('"title" is missing.');
	}
	tooLong('"title"', title, MAX_TITLE);
	const { steps, notes } = parseTourSteps(raw.steps, host, false);
	const tour: Tour = {
		id,
		title,
		origin: plain(raw.author).slice(0, 80) || 'Tour file',
		source: 'file',
		steps,
		// In the file the first step is 1.
		start: positive(raw.start) ? Math.min(raw.start, steps.length) - 1 : 0,
	};
	const followUps = parseFollowUps(raw.followUps, false);
	if (followUps?.length) {
		tour.followUps = followUps;
	}
	const agent = isObject(raw.agent) ? raw.agent : undefined;
	const label = agent && plain(agent.label).slice(0, 40);
	if (agent && label && typeof agent.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(agent.color)) {
		tour.agent = { label, color: agent.color };
	}
	return { tour, flow: parseFlow(raw.flow, host, false), notes };
}

/** The arguments of the MCP `tour` tool. A field Insilode does not know, or a path outside the workspace, is an error naming it. */
export function parseTourArgs(raw: unknown, host: TourFileHost, origin: string): ParsedTour {
	if (!isObject(raw)) {
		throw new TourFileError('The arguments of `tour` are an object.');
	}
	noStrangers('tour', raw, TOUR_KEYS, true);
	const id = raw.id === undefined ? 'tour' : plain(raw.id);
	if (!/^[\w.-]{1,64}$/.test(id)) {
		throw new TourFileError('`id` is not a name of letters, digits, - _ . (at most 64).');
	}
	const title = plain(raw.title);
	if (!title) {
		throw new TourFileError('`title` is required.');
	}
	tooLong('`title`', title, MAX_TITLE);
	const { steps, notes } = parseTourSteps(raw.steps, host, true);
	if (raw.start !== undefined && !positive(raw.start)) {
		throw new TourFileError('`start` must be a whole number of 1 or more.');
	}
	const tour: Tour = { id, title, origin, source: 'agent', steps, start: positive(raw.start) ? Math.min(raw.start, steps.length) - 1 : 0 };
	const followUps = parseFollowUps(raw.followUps, true);
	if (followUps?.length) {
		tour.followUps = followUps;
	}
	return { tour, flow: parseFlow(raw.flow, host, true), notes };
}

/**
 * What the canvas says about the tour playing on it, accepted only for the tour the host sent (`playing`): the id is checked, the
 * index must be a whole number inside the tour. Anything else, including a made-up id, is nothing.
 */
export function tourReport(playing: { id: string; steps: number } | undefined, m: unknown): { exit: true } | { exit: false; index: number; paused: boolean } | undefined {
	if (!playing || !isObject(m) || m.id !== playing.id) {
		return undefined;
	}
	if (m.type === 'tourExit') {
		return { exit: true };
	}
	const index = m.index;
	return m.type === 'tourState' && typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < playing.steps
		? { exit: false, index, paused: m.paused === true }
		: undefined;
}
