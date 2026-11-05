/*---------------------------------------------------------------------------------------------
 *  Insilode board: the host's side of the free-form canvas kind. The engine itself (types, parse, layout, routing, paint,
 *  lint) is board-canvas/, shared with the canvas webview; this file turns an agent's `draw_board` input into a BoardSpec
 *  (with the steps' scenes), renders it with the same engine for the picture and the lint, reads the lines a code widget
 *  names, and merges `update_board` patches. Pure: no `vscode`, so it is unit-tested directly.
 *--------------------------------------------------------------------------------------------*/

import type { CanvasSpec, Overrides, Scene } from '../../../../../board-canvas/canvas';
import { lintCanvas, type Finding } from '../../../../../board-canvas/lint';
import { boxesOf, DARK, LIGHT, paintCanvas, toSvg, type Painted } from '../../../../../board-canvas/paint';
import { parseCanvas } from '../../../../../board-canvas/parse';
import type { LintItem, LintResult } from './lint';
import type { BoardSpec, BoardStep } from './spec';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown, max = 100): string[] => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').slice(0, max);

export const MAX_CANVAS_STEPS = 40;

/** Is this input a canvas board (as opposed to one with nodes and edges)? */
export const isCanvasInput = (raw: unknown): boolean => isObj(raw) && raw.kind === 'canvas';

/** The engine's view of a canvas BoardSpec; undefined for a board of another kind. */
export function canvasSpecOf(spec: BoardSpec): CanvasSpec | undefined {
	return spec.kind === 'canvas' && spec.elements ? { title: spec.title, purpose: spec.purpose, layout: spec.layout, columns: spec.columns, elements: spec.elements } : undefined;
}

export interface ParsedCanvasBoard {
	spec: BoardSpec;
	/** Elements and ends that were dropped, in sentences an agent can act on. */
	errors: string[];
	/** Values that were cut or changed, and the steps' problems. */
	notes: string[];
}

/**
 * Checks and cleans a canvas board an agent sent: the engine's parser for the elements, and here the steps. A step's `show`,
 * `open` and `lit` name elements (`open` frames); an id that is not one is left out and said. `nodes` and `edges` of a step
 * belong to the other kinds and are refused with the way out.
 */
export function parseCanvasBoard(input: unknown): ParsedCanvasBoard {
	const parsed = parseCanvas(input);
	const raw = input as Record<string, unknown>;
	const notes = [...parsed.notes];
	if (raw.nodes !== undefined || raw.edges !== undefined) {
		notes.push('a canvas board has `elements`: its `nodes` and `edges` were ignored (an arrow is an element of type "arrow").');
	}
	const ids = new Set(parsed.spec.elements.map(e => e.id));
	const frames = new Set(parsed.spec.elements.filter(e => e.type === 'frame').map(e => e.id));
	const steps: BoardStep[] = [];
	for (const [i, s] of (Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_CANVAS_STEPS) : []).entries()) {
		const x = isObj(s) ? s : {};
		const title = typeof x.title === 'string' ? x.title.slice(0, 80) : undefined;
		const caption = typeof x.caption === 'string' ? x.caption.slice(0, 600) : undefined;
		if (!title && !caption) {
			notes.push(`step #${i + 1} was dropped: it needs a title or a caption.`);
			continue;
		}
		if (x.nodes !== undefined || x.edges !== undefined) {
			notes.push(`step #${i + 1}: this is a canvas board, so a step names elements with \`show\`, \`open\` and \`lit\`, not \`nodes\` and \`edges\`.`);
		}
		const keep = (field: 'show' | 'open' | 'lit', allowed: Set<string>) => {
			const sent = strings(x[field]);
			const bad = sent.filter(id => !allowed.has(id));
			if (bad.length) notes.push(`step #${i + 1}: \`${field}\` names ${bad.slice(0, 3).map(b => `\`${b}\``).join(', ')}, which ${field === 'open' ? 'is not a frame' : 'is not an element'}; left out.`);
			return sent.filter(id => allowed.has(id));
		};
		const show = keep('show', ids), open = keep('open', frames), lit = keep('lit', ids);
		steps.push({
			title: title ?? `Step ${i + 1}`,
			caption: caption ?? '',
			...(Array.isArray(x.show) ? { show } : {}),
			...(open.length ? { open } : {}),
			...(lit.length ? { lit } : {}),
		});
	}
	const spec: BoardSpec = {
		version: 1,
		kind: 'canvas',
		title: parsed.spec.title,
		description: typeof raw.description === 'string' ? raw.description.slice(0, 600) : undefined,
		nodes: [],
		edges: [],
		purpose: parsed.spec.purpose,
		layout: parsed.spec.layout,
		columns: parsed.spec.columns,
		elements: parsed.spec.elements,
		steps: steps.length ? steps : undefined,
	};
	return { spec, errors: parsed.errors, notes };
}

/** What a step shows, as the sets the painter takes (absent fields: everything). */
export function sceneOf(step: BoardStep | undefined): Scene {
	return { show: step?.show ? new Set(step.show) : undefined, open: step?.open ? new Set(step.open) : undefined, lit: step?.lit?.length ? new Set(step.lit) : undefined };
}

export interface RenderedCanvas {
	painted: Painted;
	svg: string;
	/** Where each element ended up: `{ id: { x, y, w, h } }`. */
	boxes: Record<string, { x: number; y: number; w: number; h: number }>;
	findings: Finding[];
}

/** The board as the engine draws it: the picture the host falls back to, the final boxes and the geometric lint. `step` is a 0-based index into the steps. */
export function renderCanvas(spec: BoardSpec, o: { dark?: boolean; overrides?: Overrides; step?: number } = {}): RenderedCanvas | undefined {
	const canvas = canvasSpecOf(spec);
	if (!canvas) return undefined;
	const palette = o.dark === false ? LIGHT : DARK;
	const scene = sceneOf(o.step !== undefined ? spec.steps?.[o.step] : undefined);
	const painted = paintCanvas(canvas, palette, { overrides: o.overrides, ...scene });
	// The lint and the boxes describe the board as drawn (every element), not the scene.
	const full = o.step === undefined && !o.overrides ? painted : paintCanvas(canvas, palette, { overrides: o.overrides });
	return { painted, svg: toSvg(painted, palette), boxes: boxesOf(full.layout), findings: lintCanvas(canvas, full) };
}

/** The geometric and spec findings in the shape the shared answer formatter takes. */
export function lintOf(findings: Finding[]): LintResult {
	const items: LintItem[] = findings.map(f => ({ level: f.level === 'warning' ? 'warn' : 'info', text: f.text }));
	return { items, visible: 0, crossings: 0 };
}

/**
 * Fills the code widgets that name a file: the lines `lines` of it, read through `read` (which must keep to the workspace),
 * cut at the widget's 12 lines. `text` given by the agent wins. A file that cannot be read is said and the widget keeps no
 * text (the lint warns). The widget also links to the file, so a click opens it at the first line.
 */
export function fillCode(spec: BoardSpec, read: (file: string) => string | undefined, resolve: (file: string) => string | undefined): string[] {
	const found: string[] = [];
	for (const el of spec.elements ?? []) {
		if (el.type !== 'code' || el.code.text || !el.code.file) continue;
		const abs = resolve(el.code.file);
		const content = abs ? read(abs) : undefined;
		if (!abs) {
			found.push(`element \`${el.id}\`: file "${el.code.file}" is outside the workspace and was not read.`);
			continue;
		}
		if (content === undefined) {
			found.push(`element \`${el.id}\`: file "${el.code.file}" could not be read; check the path (find_symbol gives real ones).`);
			continue;
		}
		const all = content.replace(/\r\n?/g, '\n').split('\n');
		const [from, to] = el.code.lines ?? [1, Math.min(all.length, 12)];
		if (from > all.length) {
			found.push(`element \`${el.id}\`: lines ${from}-${to} are past the end of ${el.code.file} (${all.length} lines).`);
			continue;
		}
		// Only the lines the widget draws are kept: a wide range would carry the file into the spec, every redraw and read_board.
		const last = Math.min(to, all.length, from + 11);
		el.code = { ...el.code, text: all.slice(from - 1, last).join('\n'), lines: [from, last] };
		el.link = { ...el.link, file: abs, line: el.link?.line ?? from };
	}
	return found;
}

/** An `update_board` patch of one element: `{ id, ...fields }` merges, `{ id, remove: true }` removes, a new id adds. */
export type ElementPatch = Record<string, unknown> & { id: string };

/**
 * The board's elements with the patches applied, as input for the parser again (so a patch is checked like a drawing). A
 * patch keeps the fields it does not mention; `style` merges one level, every other field is replaced. Removing an element
 * also removes the arrows that end at it. Returns the board as raw input plus what changed.
 */
export function patchElements(spec: BoardSpec, patches: ElementPatch[]): { raw: Record<string, unknown>; changed: string[] } {
	const list: Record<string, unknown>[] = (spec.elements ?? []).map(e => ({ ...e }));
	const changed: string[] = [];
	for (const p of patches) {
		const at = list.findIndex(e => e.id === p.id);
		if (p.remove === true) {
			if (at >= 0) {
				const [gone] = list.splice(at, 1);
				// The children of a removed frame move up to its own frame (or the root), and the answer says so.
				const up = typeof gone.frame === 'string' ? gone.frame : undefined;
				const kids = list.filter(e => e.frame === p.id);
				for (const k of kids) k.frame = up;
				changed.push(`removed \`${p.id}\`${kids.length ? ` (its ${kids.length} element${kids.length === 1 ? '' : 's'} moved to ${up ? `frame \`${up}\`` : 'the root'})` : ''}`);
			}
			else changed.push(`\`${p.id}\` is not on the board, nothing to remove`);
			continue;
		}
		const { remove: _remove, ...fields } = p;
		if (at < 0) {
			list.push(fields);
			changed.push(`added \`${p.id}\``);
			continue;
		}
		const old = list[at];
		list[at] = { ...old, ...fields, ...(isObj(old.style) && isObj(fields.style) ? { style: { ...old.style, ...fields.style } } : {}) };
		changed.push(`changed \`${p.id}\` (${Object.keys(fields).filter(k => k !== 'id').join(', ') || 'nothing'})`);
	}
	const gone = new Set((spec.elements ?? []).map(e => e.id).filter(id => !list.some(e => e.id === id)));
	const kept = list.filter(e => {
		if (e.type !== 'arrow') return true;
		const a = (isObj(e.arrow) ? e.arrow : e) as Record<string, unknown>;
		const end = (v: unknown) => typeof v === 'string' ? v : isObj(v) && typeof v.el === 'string' ? v.el : undefined;
		const dangling = [end(a.from), end(a.to)].some(id => id !== undefined && gone.has(id));
		if (dangling) changed.push(`removed arrow \`${String(e.id)}\` (an end was removed)`);
		return !dangling;
	});
	return {
		raw: { kind: 'canvas', title: spec.title, description: spec.description, purpose: spec.purpose, layout: spec.layout, columns: spec.columns, steps: spec.steps, elements: kept },
		changed,
	};
}
