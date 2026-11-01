/*---------------------------------------------------------------------------------------------
 *  Insilode board overlap check: what draw_board and update_board tell the agent about boxes (cards, callouts, labels) that the
 *  layout would put on top of each other, and what Insilode nudged apart on its own. The canvas that lays the board out lives in
 *  ui/ and flow-view never imports it, so this mirrors its geometry (like board/lint.ts mirrors its crossings); a test compares
 *  the two. Deterministic: the same spec always gives the same lines. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { BoardNode, BoardSpec } from './spec';

export interface Box {
	id: string;
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Move {
	id: string;
	dx: number;
	dy: number;
	/** The earlier box it was moved off. */
	off: string;
}

export type Axis = 'right' | 'down' | 'up' | 'left';

export interface NudgeOptions {
	/** Overlap in px (on both axes) that is ignored. Default 4. */
	tolerance?: number;
	/** Air left between a moved box and the one it was moved off. Default 8. */
	gap?: number;
	/** How many leading boxes are fixed (cards): they are obstacles and never move. Default 0. */
	fixed?: number;
	/** The ways a box may move, the first one winning a tie. Default right and down; callout bubbles use right and up. */
	axes?: Axis[];
}

export interface Nudged {
	boxes: Box[];
	moves: Move[];
	/** Pairs [earlier, later] that still overlap because no free spot was found. */
	stuck: [string, string][];
}

/** One box slid past a blocker at most this many times when a single move would land on another box. */
const HOPS = 4;

const overlapW = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
const overlapH = (a: Box, b: Box) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);

const VECTOR: Record<Axis, { x: number; y: number }> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, down: { x: 0, y: 1 }, up: { x: 0, y: -1 } };

/** How far `b` must move along `axis` to sit clear of `o`, with `gap` between them. */
function clearance(b: Box, o: Box, axis: Axis, gap: number): number {
	const d = axis === 'right' ? o.x + o.w - b.x : axis === 'left' ? b.x + b.w - o.x : axis === 'down' ? o.y + o.h - b.y : b.y + b.h - o.y;
	return Math.ceil(Math.max(d, 0) + gap);
}

/**
 * A copy of ui/src/board/overlap.ts `nudgeApart` (flow-view never imports ui/; test/board-overlap.test.mjs bundles both and
 * compares them, so change the two together): each box that overlaps an earlier one by more than `tolerance` on both axes moves
 * along the shortest of its `axes` that clears the box it hit; a move only counts when the moved box then touches no other box;
 * when no free spot is found the box stays and the pair is reported in `stuck`.
 */
export function nudgeApart(input: Box[], opts: NudgeOptions = {}): Nudged {
	const tolerance = opts.tolerance ?? 4;
	const gap = opts.gap ?? 8;
	const fixed = opts.fixed ?? 0;
	const axes = opts.axes ?? ['right', 'down'];
	const boxes = input.map(b => ({ ...b }));
	const moves: Move[] = [];
	const stuck: [string, string][] = [];
	const hits = (a: Box, b: Box) => overlapW(a, b) > tolerance && overlapH(a, b) > tolerance;
	const blocker = (box: Box, self: number) => boxes.findIndex((o, k) => k !== self && hits(box, o));
	const shift = (b: Box, axis: Axis, d: number): Box => ({ ...b, x: b.x + VECTOR[axis].x * d, y: b.y + VECTOR[axis].y * d });

	for (let i = fixed; i < boxes.length; i++) {
		const b = boxes[i];
		const first = boxes.findIndex((o, k) => k < i && hits(b, o));
		if (first < 0) {
			continue;
		}
		const hit = boxes[first];
		const tries = axes.map((axis, n) => ({ axis, d: clearance(b, hit, axis, gap), n })).sort((p, q) => (p.d - q.d) || (p.n - q.n));
		let chosen = tries.find(t => blocker(shift(b, t.axis, t.d), i) < 0);
		let total = chosen?.d ?? 0;
		if (!chosen) {
			const slid = tries.map(t => {
				let d = t.d;
				for (let hop = 0; ; hop++) {
					const k = blocker(shift(b, t.axis, d), i);
					if (k < 0) {
						return { axis: t.axis, d, n: t.n };
					}
					if (hop === HOPS) {
						return undefined;
					}
					d += clearance(shift(b, t.axis, d), boxes[k], t.axis, gap);
				}
			}).filter((m): m is { axis: Axis; d: number; n: number } => !!m);
			const best = slid.sort((p, q) => (p.d - q.d) || (p.n - q.n))[0];
			chosen = best && { axis: best.axis, d: best.d, n: best.n };
			total = best?.d ?? 0;
		}
		if (!chosen) {
			stuck.push([hit.id, b.id]);
			continue;
		}
		const v = VECTOR[chosen.axis];
		b.x += v.x * total;
		b.y += v.y * total;
		moves.push({ id: b.id, dx: v.x * total, dy: v.y * total, off: hit.id });
	}
	return { boxes, moves, stuck };
}

// The canvas's callout geometry (ui/src/board/callouts.tsx) and card geometry (ui/src/board/model.ts), copied.
const WIDTH = 188;
const CHARS = 31;
const LINE = 13;
const HEADER_H = 44;
const DETAIL_H = 14;
const ROW_H = 18;
const CARD_PAD = 6;
const SUMMARY_W = 210;
const SUMMARY_H = 66;
const MAX_ROWS = 14;
const GAP_MAIN = 84;
const GAP_CROSS = 22;
const LABEL_W = 7.4;
const MEMBER_W = 6.7;
const MARK_SIZE: Record<string, number> = { initial: 24, final: 28, choice: 34 };
/** Lines of a callout, as the canvas wraps them: words to at most CHARS characters, a longer word cut, six lines at most. */
const MAX_LINES = 6;
/** The most lines this check returns; the rest is counted. */
const MAX_REPORTED = 6;
const NAME = 24;

/** The number of lines `text` wraps to on the canvas (the same rule as callouts.tsx `wrap`). */
function wrapLines(text: string): number {
	let lines = 0;
	let line = 0;
	for (const raw of text.split(/\s+/).filter(Boolean)) {
		const word = Math.min(raw.length, CHARS);
		if (line && line + 1 + word > CHARS) {
			lines++;
			line = word;
		} else {
			line = line ? line + 1 + word : word;
		}
	}
	return Math.min(MAX_LINES, lines + (line ? 1 : 0));
}

/** The canvas's `cardSize`, with members shown (its default). */
function cardSize(n: BoardNode): { w: number; h: number } {
	const mark = n.shape ? MARK_SIZE[n.shape] : undefined;
	if (mark) {
		return { w: mark, h: mark };
	}
	const detail = [n.tech ? `[${n.tech}]` : '', n.detail ?? ''].filter(Boolean).join(' ');
	const all = n.members ?? [];
	const rows = all.slice(0, MAX_ROWS);
	const more = all.length - rows.length;
	let w = n.label.length * LABEL_W + 40;
	if (detail) {
		w = Math.max(w, Math.min(detail.length, 44) * 6.2 + 28);
	}
	for (const m of rows) {
		w = Math.max(w, m.text.length * MEMBER_W + 44);
	}
	w = Math.min(380, Math.max(168, Math.ceil(w)));
	const rowCount = rows.length + (more ? 1 : 0);
	return { w, h: HEADER_H + (detail ? DETAIL_H : 0) + (rowCount ? rowCount * ROW_H + CARD_PAD * 2 : 0) };
}

interface Card {
	label: string;
	w: number;
	h: number;
}

/**
 * ESTIMATED positions of the visible cards: the canvas's layered layout (barycenter sweeps, nested groups) is too big to copy, so
 * this uses its simple parts: cycles broken by a depth-first walk, longest-path layers along the main axis, the board's own order
 * inside a layer, the same gaps, and nodes with no edge in a grid below. Callout-to-callout overlaps on one node do not depend on
 * this at all; overlaps with a card are as right as the estimate is.
 */
function estimateLayout(ids: string[], cards: Map<string, Card>, edges: [string, string][], dir: 'LR' | 'TB'): Map<string, Box> {
	const lr = dir === 'LR';
	const index = new Map(ids.map((id, i) => [id, i]));
	const out: number[][] = ids.map(() => []);
	const seen = new Set<string>();
	for (const [a, b] of edges) {
		const i = index.get(a);
		const j = index.get(b);
		if (i === undefined || j === undefined || i === j || seen.has(`${i}>${j}`)) {
			continue;
		}
		seen.add(`${i}>${j}`);
		out[i].push(j);
	}
	const connected = ids.map((_, i) => out[i].length > 0 || out.some(o => o.includes(i)));
	const state = new Array<number>(ids.length).fill(0);
	const back = new Set<string>();
	const visit = (root: number) => {
		const stack: [number, number][] = [[root, 0]];
		state[root] = 1;
		while (stack.length) {
			const top = stack[stack.length - 1];
			if (top[1] < out[top[0]].length) {
				const w = out[top[0]][top[1]++];
				if (state[w] === 1) {
					back.add(`${top[0]}>${w}`);
				} else if (state[w] === 0) {
					state[w] = 1;
					stack.push([w, 0]);
				}
			} else {
				state[top[0]] = 2;
				stack.pop();
			}
		}
	};
	for (let v = 0; v < ids.length; v++) {
		if (!state[v]) {
			visit(v);
		}
	}
	const succ: number[][] = ids.map(() => []);
	const indeg = new Array<number>(ids.length).fill(0);
	for (let v = 0; v < ids.length; v++) {
		for (const w of out[v]) {
			const [a, b] = back.has(`${v}>${w}`) ? [w, v] : [v, w];
			succ[a].push(b);
			indeg[b]++;
		}
	}
	const layer = new Array<number>(ids.length).fill(0);
	const queue = ids.map((_, i) => i).filter(i => indeg[i] === 0);
	for (let q = 0; q < queue.length; q++) {
		for (const w of succ[queue[q]]) {
			layer[w] = Math.max(layer[w], layer[queue[q]] + 1);
			if (--indeg[w] === 0) {
				queue.push(w);
			}
		}
	}
	const layers: number[][] = [];
	ids.forEach((_, v) => connected[v] && (layers[layer[v]] ??= []).push(v));
	const boxes = new Map<string, Box>();
	const size = (v: number) => cards.get(ids[v])!;
	let main = 0;
	let crossMax = 0;
	for (const l of layers.filter(Boolean)) {
		const thick = Math.max(...l.map(v => (lr ? size(v).w : size(v).h)));
		let cross = 0;
		for (const v of l) {
			const { w, h } = size(v);
			const sizeMain = lr ? w : h;
			const at = main + (thick - sizeMain) / 2;
			boxes.set(ids[v], { id: ids[v], x: lr ? at : cross, y: lr ? cross : at, w, h });
			cross += (lr ? h : w) + GAP_CROSS;
		}
		crossMax = Math.max(crossMax, cross - GAP_CROSS);
		main += thick + GAP_MAIN;
	}
	const layeredMain = Math.max(0, main - GAP_MAIN);
	const loose = ids.map((_, i) => i).filter(i => !connected[i]);
	if (loose.length) {
		const width = lr ? layeredMain : crossMax;
		const target = Math.max(width, 1100);
		let x = 0;
		let y = layers.length ? (lr ? crossMax : layeredMain) + GAP_MAIN * 0.6 : 0;
		let rowH = 0;
		for (const i of loose) {
			const { w, h } = size(i);
			if (x > 0 && x + w > target) {
				x = 0;
				y += rowH + GAP_CROSS;
				rowH = 0;
			}
			boxes.set(ids[i], { id: ids[i], x, y, w, h });
			x += w + GAP_CROSS;
			rowH = Math.max(rowH, h);
		}
	}
	return boxes;
}

/**
 * Estimated midpoint of the edge from `s` to `t`, as route.ts draws it: out of the source's side facing the target and into the
 * target's near side (the straight forward case; an edge that doubles back is taken between the box centres).
 */
function edgeMid(s: Box, t: Box, dir: 'LR' | 'TB'): { x: number; y: number } {
	const head = (b: Box) => Math.min(22, b.h / 2);
	if (dir === 'LR' && t.x >= s.x + s.w + 10) {
		return { x: (s.x + s.w + t.x) / 2, y: (s.y + head(s) + t.y + head(t)) / 2 };
	}
	if (dir === 'TB' && t.y >= s.y + s.h + 10) {
		return { x: (s.x + s.w / 2 + t.x + t.w / 2) / 2, y: (s.y + s.h + t.y) / 2 };
	}
	return { x: (s.x + s.w / 2 + t.x + t.w / 2) / 2, y: (s.y + s.h / 2 + t.y + t.h / 2) / 2 };
}

const short = (text: string) => (text.length > NAME ? `${text.slice(0, NAME - 1)}…` : text);

/**
 * Short lines for the agent, one per move or per overlap that is left: "moved callout on 'Cache' 24px up off 'API'",
 * "'A' and 'B' still overlap: give them more room". Nothing when the board has no overlap or there is no board. A sequence board has
 * lifelines, not boxes, and its callouts are out of scope. The card positions are estimated (see estimateLayout), so the lines are
 * a good guide to what the canvas nudges, not a promise of its exact pixels.
 */
export function checkOverlap(spec: BoardSpec | undefined): string[] {
	if (!spec || spec.kind === 'sequence' || !spec.callouts?.length) {
		return [];
	}
	const groups = new Map((spec.groups ?? []).map(g => [g.id, g]));
	// A node inside a collapsed group is drawn as one summary box: the outermost collapsed group on its chain.
	const rep = (n: BoardNode): string => {
		let swallowed: string | undefined;
		const seen = new Set<string>();
		for (let g = n.group ? groups.get(n.group) : undefined; g && !seen.has(g.id); g = g.parent ? groups.get(g.parent) : undefined) {
			seen.add(g.id);
			if (g.collapsed === true) {
				swallowed = g.id;
			}
		}
		return swallowed ? `group:${swallowed}` : n.id;
	};
	const byNode = new Map(spec.nodes.map(n => [n.id, n]));
	const repOf = (id: string) => {
		const n = byNode.get(id);
		return n ? rep(n) : undefined;
	};
	const cards = new Map<string, Card>();
	for (const n of spec.nodes) {
		const id = rep(n);
		if (cards.has(id)) {
			continue;
		}
		cards.set(id, id === n.id ? { label: n.label, ...cardSize(n) } : { label: groups.get(id.slice('group:'.length))?.label ?? id, w: SUMMARY_W, h: SUMMARY_H });
	}
	const ids = [...cards.keys()];
	const drawn: [string, string][] = [];
	for (const e of spec.edges) {
		const a = repOf(e.from);
		const b = repOf(e.to);
		if (a && b && a !== b) {
			drawn.push([a, b]);
		}
	}
	const placed = estimateLayout(ids, cards, drawn, spec.direction ?? 'LR');

	// The callouts the canvas keeps, each with the point it is about; the bubble sits above-right of it.
	const names = new Map<string, string>();
	const bubbles: Box[] = [];
	spec.callouts.forEach((c, i) => {
		let at: { x: number; y: number } | undefined;
		let on = '';
		if (c.node) {
			const box = placed.get(repOf(c.node) ?? '');
			at = box && { x: box.x + box.w - 10, y: box.y };
			on = short(cards.get(repOf(c.node) ?? '')?.label ?? c.node);
		} else if (c.edge) {
			const a = placed.get(repOf(c.edge[0]) ?? '');
			const b = placed.get(repOf(c.edge[1]) ?? '');
			const hit = drawn.some(([from, to]) => from === repOf(c.edge![0]) && to === repOf(c.edge![1]));
			at = hit && a && b ? edgeMid(a, b, spec.direction ?? 'LR') : undefined;
			on = `${short(byNode.get(c.edge[0])?.label ?? c.edge[0])}' to '${short(byNode.get(c.edge[1])?.label ?? c.edge[1])}`;
		}
		if (!at) {
			return;
		}
		const h = wrapLines(c.text) * LINE + 12;
		const id = `callout:${i}`;
		names.set(id, `callout on '${on}'`);
		bubbles.push({ id, x: at.x + 16, y: at.y - h - 14, w: WIDTH, h });
	});
	if (!bubbles.length) {
		return [];
	}
	const fixed = [...placed.values()];
	for (const f of fixed) {
		names.set(f.id, `'${short(cards.get(f.id)!.label)}'`);
	}
	const nudged = nudgeApart([...fixed, ...bubbles], { fixed: fixed.length, axes: ['right', 'up'] });
	// What still overlaps comes first: it needs the agent to act, while the moves only say what Insilode did.
	const lines: string[] = [];
	for (const [a, b] of nudged.stuck) {
		lines.push(`${names.get(a)} and ${names.get(b)} still overlap: give them more room`);
	}
	for (const m of nudged.moves) {
		lines.push(`moved ${names.get(m.id)} ${Math.abs(m.dx || m.dy)}px ${m.dx ? (m.dx > 0 ? 'right' : 'left') : (m.dy > 0 ? 'down' : 'up')} off ${names.get(m.off)}`);
	}
	return lines.length > MAX_REPORTED ? [...lines.slice(0, MAX_REPORTED), `...and ${lines.length - MAX_REPORTED} more`] : lines;
}
