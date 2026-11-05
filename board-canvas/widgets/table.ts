// A table of records: a header, up to `maxRows` rows (default 8) and a "+n more" line. Columns are as wide as their widest
// cell (cut at 28 characters); a `link` column is drawn in the accent colour, `mono` in the code font.

import { LIMITS, type CanvasElement } from '../canvas';
import { textWidth } from '../measure';
import { clip, show, type Palette, type Primitive, type Widget } from '../primitives';
import { BODY_PX, PAD, shell, titleHeight } from './shell';

type El = Extract<CanvasElement, { type: 'table' }>;

const ROW = 22;
const HEAD = 26;
const CELL = 28;

const columnsOf = (el: El) => el.table.columns.slice(0, LIMITS.tableCols);
const shownRows = (el: El) => Math.max(0, Math.min(el.table.rows.length, el.table.maxRows ?? 8, LIMITS.tableRows));

function widths(el: El): number[] {
	return columnsOf(el).map(c => {
		const cells = el.table.rows.slice(0, shownRows(el)).map(r => textWidth(clip(show(r[c.key], CELL), CELL), BODY_PX, c.mono));
		return Math.min(240, Math.max(56, textWidth(c.label ?? c.key, BODY_PX), ...cells) + 2 * PAD);
	});
}

export const table: Widget<El> = {
	size(el) {
		const more = el.table.rows.length > shownRows(el) ? ROW : 0;
		return { w: Math.max(120, widths(el).reduce((a, b) => a + b, 0)), h: titleHeight(el.label) + HEAD + shownRows(el) * ROW + more + 4 };
	},
	paint(el, box, p: Palette) {
		const { prims, top } = shell(el.label, box, p);
		const cols = columnsOf(el);
		const natural = widths(el);
		const total = natural.reduce((a, b) => a + b, 0) || 1;
		const ws = natural.map(w => w * box.w / total);
		prims.push({ kind: 'rect', x: box.x + 1, y: top, w: box.w - 2, h: HEAD, fill: p.line });
		const out: Primitive[] = [];
		let x = box.x;
		cols.forEach((c, i) => {
			const at = c.align === 'right' ? x + ws[i] - PAD : x + PAD;
			const anchor = c.align === 'right' ? 'end' as const : 'start' as const;
			out.push({ kind: 'text', x: at, y: top + 17, text: clip(c.label ?? c.key, 24), size: BODY_PX, fill: p.muted, weight: 600, anchor });
			el.table.rows.slice(0, shownRows(el)).forEach((r, j) => {
				out.push({ kind: 'text', x: at, y: top + HEAD + j * ROW + 15, text: clip(show(r[c.key], CELL), CELL), size: BODY_PX, fill: c.link ? p.accent : p.ink, mono: c.mono, anchor });
			});
			x += ws[i];
		});
		for (let j = 1; j < shownRows(el); j++) out.push({ kind: 'rect', x: box.x + 1, y: top + HEAD + j * ROW - 3, w: box.w - 2, h: 1, fill: p.line, opacity: 0.6 });
		const hidden = el.table.rows.length - shownRows(el);
		if (hidden > 0) out.push({ kind: 'text', x: box.x + PAD, y: top + HEAD + shownRows(el) * ROW + 15, text: `+${hidden} more row${hidden === 1 ? '' : 's'}`, size: BODY_PX, fill: p.muted });
		return [...prims, ...out];
	},
};
