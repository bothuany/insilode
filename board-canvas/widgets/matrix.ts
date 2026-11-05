// A matrix as a heat map: one cell per number, diverging (negative blue, positive red) or sequential (light to accent),
// optionally with the numbers in the cells and labels on the rows and columns. `dims` says the true shape when the cells
// are a cut of a larger matrix. At most 24 × 24 cells are drawn.

import { LIMITS, type CanvasElement } from '../canvas';
import { charWidth } from '../measure';
import { clip, mix, type Widget } from '../primitives';
import { BODY_PX, PAD, shell, titleHeight } from './shell';

type El = Extract<CanvasElement, { type: 'matrix' }>;

const cells = (el: El) => el.matrix.cells.slice(0, LIMITS.matrix).map(r => r.slice(0, LIMITS.matrix));
const cols = (el: El) => Math.max(1, ...cells(el).map(r => r.length));
const showValues = (el: El) => el.matrix.showValues ?? (cols(el) <= 8 && cells(el).length <= 8);
const cellW = (el: El) => showValues(el) ? 40 : 18;
const cellH = (el: El) => showValues(el) ? 26 : 18;
const LABEL_PX = BODY_PX - 1;

const rowLabelW = (el: El) => el.matrix.rowLabels?.length ? Math.min(90, Math.max(...el.matrix.rowLabels.map(l => clip(l, 12).length)) * charWidth('x', LABEL_PX, false) + 10) : 0;
const colLabelH = (el: El) => el.matrix.colLabels?.length ? 16 : 0;
const footH = (el: El) => el.matrix.dims ? 18 : 0;

/** The value range the colours span: the given one, else the data's (symmetric around zero when diverging). */
export function matrixRange(el: El): [number, number] {
	if (el.matrix.range) return el.matrix.range;
	const all = cells(el).flat();
	if (el.matrix.scale === 'sequential') return [Math.min(...all, 0), Math.max(...all, 1e-9)];
	const m = Math.max(...all.map(Math.abs), 1e-9);
	return [-m, m];
}

export const matrix: Widget<El> = {
	size(el) {
		return {
			w: Math.max(100, rowLabelW(el) + cols(el) * cellW(el) + 2 * PAD),
			h: titleHeight(el.label) + colLabelH(el) + cells(el).length * cellH(el) + footH(el) + 12,
		};
	},
	paint(el, box, p) {
		const { prims, top } = shell(el.label, box, p);
		const [lo, hi] = matrixRange(el);
		const seq = el.matrix.scale === 'sequential';
		const fill = (v: number) => {
			if (seq) return mix(p.card, p.accent, (v - lo) / (hi - lo || 1));
			return v >= 0 ? mix(p.card, p.red, v / (hi || 1)) : mix(p.card, p.accent, v / (lo || -1));
		};
		const x0 = box.x + PAD + rowLabelW(el);
		const y0 = top + 4 + colLabelH(el);
		const cw = cellW(el), ch = cellH(el), values = showValues(el);
		(el.matrix.colLabels ?? []).slice(0, cols(el)).forEach((l, j) => prims.push({ kind: 'text', x: x0 + j * cw + cw / 2, y: y0 - 4, text: clip(l, Math.floor(cw / 5)), size: LABEL_PX, fill: p.muted, anchor: 'middle' }));
		cells(el).forEach((row, i) => {
			const label = el.matrix.rowLabels?.[i];
			if (label !== undefined) prims.push({ kind: 'text', x: x0 - 6, y: y0 + i * ch + ch / 2 + 3, text: clip(label, 12), size: LABEL_PX, fill: p.muted, anchor: 'end' });
			row.forEach((v, j) => {
				prims.push({ kind: 'rect', x: x0 + j * cw, y: y0 + i * ch, w: cw - 1, h: ch - 1, rx: 2, fill: fill(v) });
				if (values) prims.push({ kind: 'text', x: x0 + j * cw + cw / 2, y: y0 + i * ch + ch / 2 + 3.5, text: Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1), size: LABEL_PX, fill: p.ink, mono: true, anchor: 'middle' });
			});
		});
		if (el.matrix.dims) prims.push({ kind: 'text', x: box.x + PAD, y: box.y + box.h - 8, text: el.matrix.dims, size: LABEL_PX, fill: p.muted, mono: true });
		return prims;
	},
};
