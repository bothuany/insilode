/*---------------------------------------------------------------------------------------------
 *  Insilode: the tour bar's Save. Writes the playing tour to `.insilode/tours/<id>.tour.json`, in exactly the format
 *  tourFile.ts reads back (any file ending in .tour.json), after the reader clicked Save: nothing is written on its own.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, realpathSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Tour, TourMark, TourStep } from '../../../../protocol/flow';
import { MAX_CAPTION, MAX_STEP_TITLE, MAX_TITLE, parseTourFile, TourFileError } from './tour/validate';

export interface TourSaveResult {
	ok: boolean;
	/** The file written, when it was. */
	path?: string;
	message?: string;
}

/** Where saved tours go, under a workspace folder. */
const TOURS_DIR = ['.insilode', 'tours'];
/** A saved tour's id leaves room for a "-2" ... "-99" after it (the file format allows 64 characters). */
const MAX_FILE_ID = 56;
const MAX_ATTEMPTS = 99;
/** A file this large is not a tour: it is never read to see whose it is, and never overwritten. */
const MAX_EXISTING_BYTES = 1_000_000;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * The id a saved tour goes by, and its file name: ASCII letters, digits, `-` and `_` only (accents are folded, anything else is a
 * dash), never a path separator or a dot, never a name Windows reserves. A tour called "Räksmörgås / orders" is "Raksmorgas-orders".
 */
export function cleanTourId(id: string): string {
	const folded = id.normalize('NFKD').replace(/[̀-ͯ]/g, '');
	const name = folded.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, MAX_FILE_ID).replace(/[-_]+$/, '');
	if (!name) {
		return 'tour';
	}
	return RESERVED.test(name) ? `tour-${name}` : name;
}

/** `file` relative to `root`, with forward slashes, when it lies inside it. */
function inside(root: string, file: string): string | undefined {
	const rel = path.relative(root, file);
	return rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
}

/** A tour file spells a path relative to the first workspace folder (that is what a hand-written one does, and where a play resolves it); a file in another folder is spelled in full. A file in none is nothing. */
function spell(roots: readonly string[], file: string | undefined): string | undefined {
	if (!file) {
		return undefined;
	}
	const rel = inside(roots[0], file);
	if (rel) {
		return rel;
	}
	return roots.slice(1).some(r => inside(r, file)) ? path.resolve(file) : undefined;
}

/** The files a tour points at: its steps' code and the ends of its connect marks. */
function tourFiles(tour: Tour): string[] {
	const files: string[] = [];
	for (const s of tour.steps) {
		if (s.at?.file) {
			files.push(s.at.file);
		}
		for (const m of s.marks ?? []) {
			if (m.to?.file) {
				files.push(m.to.file);
			}
		}
	}
	return files;
}

/** A card's label is a method name, unless the step was placed by a line (`a.ts:12`, `12`) or is a file's own name. */
function methodName(label: string, file: string, line: number): string | undefined {
	const base = path.basename(file);
	return label && label !== base && label !== `${base}:${line}` && label !== String(line) ? label.slice(0, 200) : undefined;
}

function markToFile(m: TourMark, roots: readonly string[]): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = { kind: m.kind };
	if (m.kind === 'connect') {
		const file = spell(roots, m.to?.file);
		if (!m.to || !file) {
			return undefined;
		}
		const method = methodName(m.to.label, m.to.file, m.to.startLine);
		out.to = { file, ...(method ? { method } : {}), ...(m.to.startLine > 0 ? { line: m.to.startLine } : {}) };
	} else {
		if (!m.lines) {
			return undefined;
		}
		out.lines = [...m.lines];
		if (m.kind === 'badge') {
			if (m.n === undefined) {
				return undefined;
			}
			out.n = m.n;
		}
	}
	if (m.label) {
		out.label = m.label;
	}
	if (m.sentence !== undefined) {
		out.sentence = m.sentence;
	}
	return out;
}

/** One step as a hand-written file spells it. Only what the format reads: the reader's notes, `drift`, the peek and a command wait are not part of it. */
function stepToFile(s: TourStep, i: number, roots: readonly string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const title = s.title.replace(/\s+/g, ' ').trim().slice(0, MAX_STEP_TITLE);
	if (title) {
		out.title = title;
	}
	// Every step says something; a step with no caption would make the file unreadable.
	out.caption = s.caption.slice(0, MAX_CAPTION).trim() || title || `Step ${i + 1}`;
	const at = s.at;
	if (at?.table) {
		out.table = at.table;
	} else if (at) {
		const file = spell(roots, at.file);
		if (file) {
			out.file = file;
			const method = methodName(at.label, at.file, at.startLine);
			if (method) {
				out.method = method;
			}
			// A step that was not found keeps the last line it was seen at: playing the file reports the drift again.
			if (at.startLine > 0) {
				out.line = at.startLine;
			}
			if (s.highlights?.length) {
				out.lines = s.highlights.map(h => [...h]);
			}
			// Marks sit on code that was found; on a missing step they would only be dropped.
			const marks = s.state === 'missing' ? [] : (s.marks ?? []).map(m => markToFile(m, roots)).filter((m): m is Record<string, unknown> => !!m);
			if (marks.length) {
				out.marks = marks;
			}
		}
	}
	// A file cannot carry commands: a command wait is saved as a plain step.
	if (s.wait && s.wait.kind !== 'command') {
		out.wait = s.wait.prompt ? { kind: s.wait.kind, prompt: s.wait.prompt } : { kind: s.wait.kind };
	}
	return out;
}

/** The tour as the JSON of a tour file with `id` as its id. `roots`: the workspace folders (the first is what paths are relative to). */
export function tourToFile(tour: Tour, id: string, roots: readonly string[]): Record<string, unknown> {
	const file: Record<string, unknown> = {
		insilodeTour: 1,
		id,
		title: tour.title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || id,
	};
	// In the file the first step is 1.
	if (tour.start > 0 && tour.start < tour.steps.length) {
		file.start = tour.start + 1;
	}
	file.steps = tour.steps.map((s, i) => stepToFile(s, i, roots));
	const followUps = tour.followUps?.filter(q => q.trim());
	if (followUps?.length) {
		file.followUps = followUps;
	}
	return file;
}

/** Whose file this is: its own id; nothing when there is no such file, null when it is there and not a readable tour. */
async function ownerOf(file: string): Promise<string | null | undefined> {
	let stat;
	try {
		stat = await fs.stat(file);
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null;
	}
	if (!stat.isFile() || stat.size > MAX_EXISTING_BYTES) {
		return null;
	}
	try {
		const json: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
		const id = typeof json === 'object' && json !== null ? (json as { id?: unknown }).id : undefined;
		return typeof id === 'string' ? id : null;
	} catch {
		return null;
	}
}

/** The real path of `p`, or itself when it does not exist (yet). */
function real(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}

/**
 * Writes `tour` under the first workspace folder that holds its files (the first folder when none does), as
 * `.insilode/tours/<id>.tour.json`; the file round-trips through `parseTourFile`. The same tour saved again replaces its own
 * file. A file of another tour (or one that is not a tour) is never overwritten: the new one gets a number after its name.
 */
export async function saveTour(tour: Tour, roots: readonly string[]): Promise<TourSaveResult> {
	if (!roots.length) {
		return { ok: false, message: 'Open a folder first: a tour is saved inside the workspace.' };
	}
	if (!tour.steps.length) {
		return { ok: false, message: 'This tour has no steps, so there is nothing to save.' };
	}
	const files = tourFiles(tour);
	const root = roots.find(r => files.some(f => inside(r, f))) ?? roots[0];
	const base = cleanTourId(tour.id);
	const dir = path.join(root, ...TOURS_DIR);
	try {
		await fs.mkdir(dir, { recursive: true });
		// `.insilode` may be a link to somewhere else: the tour is written inside the workspace or not at all.
		if (!inside(real(root), real(dir))) {
			return { ok: false, message: 'The .insilode folder points outside the workspace, so the tour was not saved.' };
		}
		for (let n = 1; n <= MAX_ATTEMPTS; n++) {
			const id = n === 1 ? base : `${base}-${n}`;
			const target = path.join(dir, `${id}.tour.json`);
			const owner = await ownerOf(target);
			if (owner !== undefined && owner !== id) {
				continue;
			}
			// Spelled the way the file format wants (relative to the first workspace folder, which is where a play
			// resolves it, wherever the file itself lies), and checked by reading it back the way a play does: a tour
			// that would not load is not written.
			const content = tourToFile(tour, id, roots);
			try {
				parseTourFile(content, { roots: [...roots], readText: () => undefined });
			} catch (e) {
				if (e instanceof TourFileError) {
					return { ok: false, message: `The tour does not fit the tour file format: ${e.message}` };
				}
				throw e;
			}
			await fs.writeFile(target, `${JSON.stringify(content, null, 2)}\n`, 'utf8');
			return { ok: true, path: target };
		}
		return { ok: false, message: `There are already ${MAX_ATTEMPTS} saved tours called "${base}": rename or remove some.` };
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		const why = code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'the folder is not writable' : (e as Error).message;
		return { ok: false, message: `The tour could not be saved to ${path.join(...TOURS_DIR)}: ${why}.` };
	}
}

/** The Save click: writes the tour and says where, with an Open button; says why when it could not. Only the path that was written is ever shown or opened. */
export async function saveTourWithNotice(tour: Tour): Promise<void> {
	const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
	const res = await saveTour(tour, roots);
	if (!res.ok || !res.path) {
		void vscode.window.showWarningMessage(`Insilode: ${res.message ?? 'the tour could not be saved.'}`);
		return;
	}
	const saved = res.path;
	// Not awaited: the notification stays until it is dismissed, and the panel must not wait for that.
	void vscode.window.showInformationMessage(`Insilode: tour saved to ${vscode.workspace.asRelativePath(saved)}.`, 'Open').then(async pick => {
		if (pick === 'Open') {
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(saved)));
		}
	});
}
