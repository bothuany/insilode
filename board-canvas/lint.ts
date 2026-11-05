// Lint of a canvas board that the host runs and the agent reads. `lintSpec` needs only the spec (colours, origins, icons,
// code); `lintGeometry` needs the laid-out picture (overlapping boxes, arrows through text, an element outside its
// frame); `lintCanvas` is both. Structural checks (unknown ids, cycles, limits, ragged matrices) belong to the parser,
// which runs first and whose errors the host reports as dropped elements. Symbols that do not resolve are the host's
// (it owns the index), as for every other board kind.

import type { CanvasSpec } from './canvas';
import { hasIcon, ICON_NAMES } from './icons';
import type { Box } from './layout';
import type { Painted } from './paint';

export interface Finding { level: 'warning' | 'info'; text: string; ids: string[] }

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

export function lintSpec(spec: CanvasSpec): Finding[] {
	const out: Finding[] = [];
	const linked = (e: CanvasSpec['elements'][number]) => !!(e.link?.symbol || e.link?.file || e.link?.board);
	for (const el of spec.elements) {
		if (el.style?.fill?.startsWith('#') || el.style?.stroke?.startsWith('#') || el.style?.text?.startsWith('#')) out.push({ level: 'info', text: `\`${el.id}\`: a hex colour does not follow the theme; prefer a named colour.`, ids: [el.id] });
		if (el.origin === 'runtime' && !el.source) out.push({ level: 'info', text: `\`${el.id}\`: origin runtime without \`source\` (where the value was observed).`, ids: [el.id] });
		if (el.type === 'rect' && el.icon && !hasIcon(el.icon)) out.push({ level: 'info', text: `\`${el.id}\`: no icon \`${el.icon}\`, drawn as a text chip; icons: ${ICON_NAMES.join(', ')}.`, ids: [el.id] });
		if (el.type === 'code') {
			const lines = el.code.text ? el.code.text.replace(/\n$/, '').split('\n').length : el.code.lines ? el.code.lines[1] - el.code.lines[0] + 1 : 0;
			if (lines > 12) out.push({ level: 'warning', text: `\`${el.id}\`: ${lines} lines of code; only 12 are drawn. Show the lines that matter, and \`link\` the rest.`, ids: [el.id] });
			if (el.code.file && !el.code.text) out.push({ level: 'warning', text: `\`${el.id}\`: the code of \`${el.code.file}\` could not be read, so nothing is drawn. Give \`code.text\`, or a file inside the workspace.`, ids: [el.id] });
		}
	}
	if (spec.purpose === 'code' && !spec.elements.some(e => linked(e) || (e.type === 'code' && e.code.file))) out.push({ level: 'info', text: 'purpose is "code" but no element links to code (`link.symbol`, `link.file`, or a code element with a `file`).', ids: [] });
	return out;
}

export function lintGeometry(_spec: CanvasSpec, painted: Painted): Finding[] {
	const out: Finding[] = [];
	const placed = [...painted.layout.boxes.values()].filter(p => p.el.type !== 'frame');
	for (let i = 0; i < placed.length; i++) {
		for (let j = i + 1; j < placed.length; j++) {
			if (overlap(placed[i].box, placed[j].box)) out.push({ level: 'warning', text: `\`${placed[i].el.id}\` and \`${placed[j].el.id}\` overlap.`, ids: [placed[i].el.id, placed[j].el.id] });
		}
	}
	for (const p of painted.layout.boxes.values()) {
		const parent = p.el.frame ? painted.layout.boxes.get(p.el.frame) : undefined;
		if (parent && !parent.collapsed && !inside(p.box, parent.box)) out.push({ level: 'warning', text: `\`${p.el.id}\` sticks out of frame \`${parent.el.id}\`.`, ids: [p.el.id] });
	}
	for (const [id, r] of painted.routes) {
		if (r.crosses.length) out.push({ level: 'warning', text: `arrow \`${id}\` runs through the text of ${r.crosses.map(c => `\`${c}\``).join(', ')}.`, ids: [id, ...r.crosses] });
	}
	for (const note of painted.layout.notes) out.push({ level: note.includes('some children have x/y') ? 'warning' : 'info', text: note, ids: [] });
	return out;
}

export function lintCanvas(spec: CanvasSpec, painted: Painted): Finding[] {
	return [...lintGeometry(spec, painted), ...lintSpec(spec)].slice(0, 50);
}
