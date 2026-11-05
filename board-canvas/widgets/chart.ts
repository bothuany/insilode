// A small chart: `bar` (one group per category), `line`, `scatter` and `points2d` (a scatter whose points are named, for
// vectors and embeddings drawn in 2D). A series is `[y, y, ...]` (the x is the index and its label) or `[[x, y], ...]`.
// Up to six series and 200 points each; ticks are "nice" numbers and the axis ranges can be given.

import { LIMITS, type CanvasElement, type Series } from '../canvas';
import { charWidth } from '../measure';
import { clip, color, cycle, type Palette, type Primitive, type Widget } from '../primitives';
import { BODY_PX, PAD, shell } from './shell';

type El = Extract<CanvasElement, { type: 'chart' }>;

const W = 340;
const H = 210;
const LEFT = 46;
const RIGHT = 14;
const FOOT = 34;
const LABEL_PX = BODY_PX - 1;

interface Pt { x: number; y: number; label?: string }

const seriesOf = (el: El): Series[] => el.chart.series.slice(0, LIMITS.series);

function points(s: Series): Pt[] {
	return (s.points as (number | [number, number])[]).slice(0, LIMITS.points).map((p, i) => Array.isArray(p) ? { x: p[0], y: p[1], label: s.labels?.[i] } : { x: i, y: p, label: s.labels?.[i] });
}

/** Round tick values between lo and hi, about `n` of them. */
export function niceTicks(lo: number, hi: number, n = 4): number[] {
	const span = hi - lo || 1;
	const raw = span / n;
	const mag = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw - 1e-12) ?? mag * 10;
	const out: number[] = [];
	for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9 && out.length < 20; v += step) out.push(Number(v.toPrecision(12)));
	return out;
}

/** A range widened to round numbers, so the first and last tick sit on the frame. */
function niceRange(lo: number, hi: number): [number, number] {
	if (hi - lo < 1e-12) return [lo - 1, hi + 1];
	const t = niceTicks(lo, hi, 4);
	if (t.length < 2) return [lo, hi];
	const step = t[1] - t[0];
	return [Math.floor(lo / step + 1e-9) * step, Math.ceil(hi / step - 1e-9) * step];
}

const fmt = (v: number) => String(Number(v.toPrecision(3)));

export const chart: Widget<El> = {
	size() {
		return { w: W, h: H };
	},
	paint(el, box, p: Palette) {
		const { prims, top } = shell(el.label, box, p);
		const all = seriesOf(el);
		const pts = all.map(points);
		const colors = all.map((s, i) => color(s.color, p, cycle(p)[i % 6]));
		const kind = el.chart.kind;
		const categorical = kind === 'bar' || (kind === 'line' && pts.every(l => l.every((q, i) => q.x === i)));
		const legendH = all.length > 1 ? 18 : 0;
		const yLabel = el.chart.axes?.y?.label ? 12 : 0;
		const plot = { x: box.x + LEFT, y: top + legendH + 6 + yLabel, w: box.w - LEFT - RIGHT, h: box.h - (top - box.y) - legendH - FOOT - 6 - yLabel };
		const ys = pts.flat().map(q => q.y), xs = pts.flat().map(q => q.x);
		const lo = ys.length ? Math.min(...ys) : 0, hi = ys.length ? Math.max(...ys) : 1;
		const yr = el.chart.axes?.y?.range ?? (kind === 'bar' ? niceRange(Math.min(0, lo), Math.max(0, hi)) : niceRange(lo, hi));
		const categories = Math.max(1, ...pts.map(l => l.length));
		const xr: [number, number] = el.chart.axes?.x?.range ?? (categorical ? [0, categories - 1] : niceRange(xs.length ? Math.min(...xs) : 0, xs.length ? Math.max(...xs) : 1));
		const px = (v: number) => categorical ? plot.x + (kind === 'bar' ? (v + 0.5) / categories : categories > 1 ? v / (categories - 1) : 0.5) * plot.w : plot.x + (v - xr[0]) / (xr[1] - xr[0] || 1) * plot.w;
		const py = (v: number) => plot.y + plot.h - (Math.max(yr[0], Math.min(yr[1], v)) - yr[0]) / (yr[1] - yr[0] || 1) * plot.h;
		const out: Primitive[] = [];
		for (const t of niceTicks(yr[0], yr[1], 4)) {
			out.push({ kind: 'rect', x: plot.x, y: py(t), w: plot.w, h: 1, fill: p.line });
			out.push({ kind: 'text', x: plot.x - 6, y: py(t) + 3, text: fmt(t), size: LABEL_PX, fill: p.muted, anchor: 'end', mono: true });
		}
		out.push({ kind: 'rect', x: plot.x, y: plot.y + plot.h, w: plot.w, h: 1, fill: p.strong });
		if (categorical) {
			const labels = all[0]?.labels;
			const every = Math.max(1, Math.ceil(categories / Math.max(1, Math.floor(plot.w / 44))));
			for (let i = 0; i < categories; i += every) out.push({ kind: 'text', x: px(i), y: plot.y + plot.h + 13, text: labels?.[i] !== undefined ? clip(labels[i], 7) : String(i), size: LABEL_PX, fill: p.muted, anchor: 'middle' });
		} else {
			for (const t of niceTicks(xr[0], xr[1], 5)) out.push({ kind: 'text', x: px(t), y: plot.y + plot.h + 13, text: fmt(t), size: LABEL_PX, fill: p.muted, anchor: 'middle', mono: true });
		}
		all.forEach((_s, k) => {
			const fill = colors[k];
			const l = pts[k];
			if (kind === 'bar') {
				const band = plot.w / categories, bw = band * 0.7 / all.length;
				l.forEach((q, i) => {
					const y1 = py(q.y), y0 = py(0);
					out.push({ kind: 'rect', x: plot.x + i * band + band * 0.15 + k * bw, y: Math.min(y0, y1), w: Math.max(1, bw - 1), h: Math.max(1, Math.abs(y0 - y1)), rx: 2, fill });
				});
			} else if (kind === 'line') {
				if (l.length > 1) out.push({ kind: 'path', d: l.map((q, i) => `${i ? 'L' : 'M'}${px(q.x).toFixed(1)} ${py(q.y).toFixed(1)}`).join(' '), stroke: fill, sw: 1.8 });
				if (l.length <= 40) for (const q of l) out.push({ kind: 'ellipse', cx: px(q.x), cy: py(q.y), rx: 2.6, ry: 2.6, fill });
			} else {
				for (const q of l) {
					out.push({ kind: 'ellipse', cx: px(q.x), cy: py(q.y), rx: kind === 'points2d' ? 4.5 : 3.5, ry: kind === 'points2d' ? 4.5 : 3.5, fill, opacity: 0.9 });
					if (kind === 'points2d' && q.label) { const left = px(q.x) > plot.x + plot.w * 0.7; out.push({ kind: 'text', x: px(q.x) + (left ? -7 : 7), y: py(q.y) + 3, text: clip(q.label, 14), size: LABEL_PX, fill: p.ink, anchor: left ? 'end' : 'start', halo: p.card }); }
				}
			}
		});
		if (all.length > 1) {
			let x = box.x + PAD;
			all.forEach((s, k) => {
				out.push({ kind: 'rect', x, y: top + 3, w: 9, h: 9, rx: 2, fill: colors[k] });
				out.push({ kind: 'text', x: x + 13, y: top + 11, text: clip(s.label, 16), size: LABEL_PX, fill: p.muted });
				x += 13 + Math.min(16, s.label.length) * charWidth('x', LABEL_PX, false) + 14;
			});
		}
		if (el.chart.axes?.x?.label) out.push({ kind: 'text', x: plot.x + plot.w / 2, y: box.y + box.h - 6, text: el.chart.axes.x.label, size: LABEL_PX, fill: p.muted, anchor: 'middle' });
		if (el.chart.axes?.y?.label) out.push({ kind: 'text', x: box.x + PAD, y: plot.y - 8, text: el.chart.axes.y.label, size: LABEL_PX, fill: p.muted });
		return [...prims, ...out];
	},
};
