// Geometric lint of a laid-out canvas, run by the host after layout: overlapping boxes, arrows through text, an
// element outside its frame. Structural checks (unknown ids, cycles, limits) belong to the parser, which runs first.

import type { CanvasSpec } from './canvas';
import type { Box } from './layout';
import type { Painted } from './paint';

export interface Finding { level: 'warning' | 'info'; text: string; ids: string[] }

const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Box, b: Box) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

export function lintGeometry(spec: CanvasSpec, painted: Painted): Finding[] {
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
	for (const note of painted.layout.notes) out.push({ level: 'info', text: note, ids: [] });
	for (const el of spec.elements) {
		if (el.style?.fill?.startsWith('#') || el.style?.stroke?.startsWith('#') || el.style?.text?.startsWith('#')) out.push({ level: 'info', text: `\`${el.id}\`: a hex colour does not follow the theme; prefer a named colour.`, ids: [el.id] });
		if (el.origin === 'runtime' && !el.source) out.push({ level: 'info', text: `\`${el.id}\`: origin runtime without \`source\` (where the value was observed).`, ids: [el.id] });
	}
	return out.slice(0, 50);
}
