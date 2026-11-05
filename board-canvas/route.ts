// Arrow geometry on a laid-out canvas. `straight` and `curve` join two borders directly; `elbow` runs through
// channels: it leaves a box on one side, travels along a line that clears every other box (inflated by 8px) and
// enters the target on the facing side. When no clear line exists between the two boxes, the path goes around the
// outside of the obstacles. Labels sit on the longest segment. Pure, so the host and the webview draw the same lines.

import { DIM, type ArrowData, type CanvasElement, type End, type Side } from './canvas';
import type { Box, CanvasLayout } from './layout';

export interface Pt { x: number; y: number }

export interface Route {
	/** Polyline for straight and elbow; a cubic for curve (`d` holds the path data). */
	points: Pt[];
	d: string;
	start: Pt;
	end: Pt;
	/** Where the label goes. */
	label: Pt;
	/** True when a segment still crosses a box it should not. */
	crosses: string[];
}

const f = (n: number) => Math.round(n * 10) / 10;

function endBox(end: End, l: CanvasLayout): { box: Box; id?: string } | { pt: Pt } | undefined {
	if (typeof end === 'object' && 'x' in end) return { pt: { x: end.x, y: end.y } };
	const id = typeof end === 'string' ? end : end.el;
	const p = l.boxes.get(id) ?? (l.rep.has(id) ? l.boxes.get(l.rep.get(id)!) : undefined);
	return p ? { box: p.box, id: p.el.id } : undefined;
}

const centre = (b: Box): Pt => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

function sideOf(from: Box, to: Box, want?: Side): Side {
	if (want) return want;
	const a = centre(from), b = centre(to);
	const dx = b.x - a.x, dy = b.y - a.y;
	return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top');
}

function anchor(b: Box, side: Side, off = 0): Pt {
	switch (side) {
		case 'top': return { x: b.x + b.w / 2 + off, y: b.y };
		case 'bottom': return { x: b.x + b.w / 2 + off, y: b.y + b.h };
		case 'left': return { x: b.x, y: b.y + b.h / 2 + off };
		case 'right': return { x: b.x + b.w, y: b.y + b.h / 2 + off };
	}
}

const inflate = (b: Box, by: number): Box => ({ x: b.x - by, y: b.y - by, w: b.w + 2 * by, h: b.h + 2 * by });

/** Does the segment p→q (axis-aligned) cross the box? Touching the border counts as clear. */
function segmentHits(p: Pt, q: Pt, b: Box): boolean {
	const x1 = Math.min(p.x, q.x), x2 = Math.max(p.x, q.x), y1 = Math.min(p.y, q.y), y2 = Math.max(p.y, q.y);
	return x1 < b.x + b.w && x2 > b.x && y1 < b.y + b.h && y2 > b.y;
}

export interface RouteInput { el: CanvasElement; arrow: ArrowData; par?: number; pars?: number }

/** Why an arrow was not drawn, for the lint: both ends inside the same collapsed frame, or an end that is not placed. */
export type RouteSkip = { skipped: 'collapsed'; frame: string } | { skipped: 'missing' };

export function routeArrow(input: RouteInput, l: CanvasLayout): Route | RouteSkip {
	const a = endBox(input.arrow.from, l), b = endBox(input.arrow.to, l);
	if (!a || !b) return { skipped: 'missing' };
	if ('id' in a && 'id' in b && a.id === b.id) return { skipped: 'collapsed', frame: a.id! };
	const obstacles = [...l.boxes.values()].filter(p => p.el.type !== 'frame' && p.el.type !== 'arrow' && !('id' in a && p.el.id === a.id) && !('id' in b && p.el.id === b.id)).map(p => ({ id: p.el.id, box: inflate(p.box, DIM.inflate), text: p.el.type === 'text' }));
	const par = input.par ?? 0, pars = input.pars ?? 1;
	const off = (par - (pars - 1) / 2) * DIM.arrowOffset;

	const wantFrom = typeof input.arrow.from === 'object' && 'side' in input.arrow.from ? input.arrow.from.side : undefined;
	const wantTo = typeof input.arrow.to === 'object' && 'side' in input.arrow.to ? input.arrow.to.side : undefined;
	const fromSide = 'box' in a ? sideOf(a.box, 'box' in b ? b.box : { ...b.pt, w: 0, h: 0 }, wantFrom) : undefined;
	const toSide = 'box' in b ? sideOf(b.box, 'box' in a ? a.box : { ...a.pt, w: 0, h: 0 }, wantTo) : undefined;
	const start = 'box' in a ? anchor(a.box, fromSide!, off) : a.pt;
	const end = 'box' in b ? anchor(b.box, toSide!, off) : b.pt;
	const route = input.arrow.route ?? 'elbow';

	if (route === 'straight' || route === 'curve') {
		const points = [start, end];
		const d = route === 'straight'
			? `M${f(start.x)} ${f(start.y)} L${f(end.x)} ${f(end.y)}`
			: cubic(start, end, fromSide, toSide);
		const crosses = obstacles.filter(o => o.text && lineHitsBox(start, end, o.box)).map(o => o.id);
		return { points, d, start, end, label: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }, crosses };
	}

	const points = elbow(start, end, fromSide, toSide, { from: wantFrom, to: wantTo }, obstacles, 'box' in a ? a.box : undefined, 'box' in b ? b.box : undefined, off);
	const crosses = obstacles.filter(o => o.text && points.some((p, i) => i && segmentHits(points[i - 1], p, o.box))).map(o => o.id);
	return { points, d: points.map((p, i) => `${i ? 'L' : 'M'}${f(p.x)} ${f(p.y)}`).join(' '), start: points[0], end: points[points.length - 1], label: labelSpot(points), crosses };
}

function cubic(s: Pt, e: Pt, fs?: Side, ts?: Side): string {
	const pull = Math.max(40, Math.hypot(e.x - s.x, e.y - s.y) / 3);
	const dir = (side?: Side): Pt => side === 'left' ? { x: -1, y: 0 } : side === 'right' ? { x: 1, y: 0 } : side === 'top' ? { x: 0, y: -1 } : side === 'bottom' ? { x: 0, y: 1 } : { x: 0, y: 0 };
	const a = dir(fs), b = dir(ts);
	return `M${f(s.x)} ${f(s.y)} C${f(s.x + a.x * pull)} ${f(s.y + a.y * pull)}, ${f(e.x + b.x * pull)} ${f(e.y + b.y * pull)}, ${f(e.x)} ${f(e.y)}`;
}

function lineHitsBox(p: Pt, q: Pt, b: Box): boolean {
	// Liang–Barsky clip against the box.
	let t0 = 0, t1 = 1;
	const dx = q.x - p.x, dy = q.y - p.y;
	for (const [pp, qq] of [[-dx, p.x - b.x], [dx, b.x + b.w - p.x], [-dy, p.y - b.y], [dy, b.y + b.h - p.y]]) {
		if (pp === 0) { if (qq < 0) return false; continue; }
		const r = qq / pp;
		if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
	}
	return true;
}

interface Obstacle { id: string; box: Box; text: boolean }

/**
 * An orthogonal path start→end, the cheapest of these candidates: H-V-H or V-H-V with the middle leg at the midpoint
 * and at every gap between obstacles, then four detours that leave the source and enter the target on the same side
 * (top, bottom, left, right) and travel just outside everything in that band. Crossing text costs 100, crossing a box
 * 10, length a little, so a clear path wins and, when none exists, the one that spares the text.
 */
function elbow(s: Pt, e: Pt, fs: Side | undefined, ts: Side | undefined, want: { from?: Side; to?: Side }, obstacles: Obstacle[], source: Box | undefined, target: Box | undefined, off: number): Pt[] {
	const stub = 12;
	const cost = (pts: Pt[]) => {
		let c = 0;
		for (let i = 1; i < pts.length; i++) {
			c += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
			for (const o of obstacles) if (segmentHits(pts[i - 1], pts[i], o.box)) c += o.text ? 100_000 : 10_000;
		}
		return c;
	};
	const candidates: { pts: Pt[]; penalty: number }[] = [];
	const boxes = obstacles.map(o => o.box);
	const leave = (side: Side): Pt => source ? anchor(source, side, off) : s;
	const enter = (side: Side): Pt => target ? anchor(target, side, off) : e;
	const out = (p: Pt, side: Side): Pt => side === 'left' ? { x: p.x - stub, y: p.y } : side === 'right' ? { x: p.x + stub, y: p.y } : side === 'top' ? { x: p.x, y: p.y - stub } : { x: p.x, y: p.y + stub };
	const SIDES: Side[] = ['top', 'bottom', 'left', 'right'];
	const isH = (side: Side) => side === 'left' || side === 'right';
	// Every pair of sides (a chosen side is fixed); the natural pair costs nothing extra, the others a little, so a
	// clear path on an odd side still beats a crossing on the natural one.
	for (const a of want.from ? [want.from] : source ? SIDES : [fs ?? 'right']) {
		for (const b of want.to ? [want.to] : target ? SIDES : [ts ?? 'left']) {
			const penalty = (a === fs ? 0 : 40) + (b === ts ? 0 : 40);
			const p0 = leave(a), p1 = out(p0, a), q1 = enter(b), q0 = out(q1, b);
			if (isH(a) && isH(b)) {
				for (const mx of [(p1.x + q0.x) / 2, ...gaps(boxes, 'x', Math.min(p1.x, q0.x), Math.max(p1.x, q0.x))]) candidates.push({ pts: dedupe([p0, p1, { x: mx, y: p1.y }, { x: mx, y: q0.y }, q0, q1]), penalty });
			} else if (!isH(a) && !isH(b)) {
				for (const my of [(p1.y + q0.y) / 2, ...gaps(boxes, 'y', Math.min(p1.y, q0.y), Math.max(p1.y, q0.y))]) candidates.push({ pts: dedupe([p0, p1, { x: p1.x, y: my }, { x: q0.x, y: my }, q0, q1]), penalty });
			} else if (isH(a)) {
				candidates.push({ pts: dedupe([p0, p1, { x: q0.x, y: p1.y }, q0, q1]), penalty });
			} else {
				candidates.push({ pts: dedupe([p0, p1, { x: p1.x, y: q0.y }, q0, q1]), penalty });
			}
		}
	}
	// Detours: leave and enter on the same side and run just outside everything that lies between the two ends.
	const ends = [source ?? { ...s, w: 0, h: 0 }, target ?? { ...e, w: 0, h: 0 }];
	const x1 = Math.min(...ends.map(b => b.x)), x2 = Math.max(...ends.map(b => b.x + b.w));
	const y1 = Math.min(...ends.map(b => b.y)), y2 = Math.max(...ends.map(b => b.y + b.h));
	const inXBand = boxes.filter(b => b.x + b.w > x1 && b.x < x2);
	const inYBand = boxes.filter(b => b.y + b.h > y1 && b.y < y2);
	const viaY = (y: number, side: Side) => { const f0 = leave(side), t = enter(side); return dedupe([f0, { x: f0.x, y }, { x: t.x, y }, t]); };
	const viaX = (x: number, side: Side) => { const f0 = leave(side), t = enter(side); return dedupe([f0, { x, y: f0.y }, { x, y: t.y }, t]); };
	candidates.push({ pts: viaY(Math.min(y1, ...inXBand.map(b => b.y)) - stub, 'top'), penalty: 80 });
	candidates.push({ pts: viaY(Math.max(y2, ...inXBand.map(b => b.y + b.h)) + stub, 'bottom'), penalty: 80 });
	candidates.push({ pts: viaX(Math.min(x1, ...inYBand.map(b => b.x)) - stub, 'left'), penalty: 80 });
	candidates.push({ pts: viaX(Math.max(x2, ...inYBand.map(b => b.x + b.w)) + stub, 'right'), penalty: 80 });
	let best = candidates[0].pts, bestCost = Infinity;
	for (const c of candidates) {
		const k = cost(c.pts) + c.penalty;
		if (k < bestCost) { best = c.pts; bestCost = k; }
	}
	return best;
}

/** The middles of the free intervals along one axis between `lo` and `hi`, nearest the centre first. */
function gaps(obstacles: Box[], axis: 'x' | 'y', lo: number, hi: number): number[] {
	const spans = obstacles.map(b => axis === 'x' ? [b.x, b.x + b.w] : [b.y, b.y + b.h]).filter(([a, b]) => b > lo && a < hi).sort((p, q) => p[0] - q[0]);
	const out: number[] = [];
	let cur = lo;
	for (const [a, b] of spans) {
		if (a > cur + 2) out.push((cur + a) / 2);
		cur = Math.max(cur, b);
	}
	if (hi > cur + 2) out.push((cur + hi) / 2);
	const mid = (lo + hi) / 2;
	return out.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
}

function dedupe(pts: Pt[]): Pt[] {
	const out: Pt[] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
	}
	// Drop a middle point that lies on the straight line between its neighbours.
	for (let i = 1; i < out.length - 1;) {
		const a = out[i - 1], b = out[i], c = out[i + 1];
		if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1); else i++;
	}
	return out;
}

function labelSpot(pts: Pt[]): Pt {
	let best = { len: -1, at: { x: pts[0].x, y: pts[0].y } };
	for (let i = 1; i < pts.length; i++) {
		const len = Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y);
		if (len > best.len) best = { len, at: { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 } };
	}
	return best.at;
}
