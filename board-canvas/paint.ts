// Turns a laid-out canvas into primitives (rect, text, path, ellipse) and the primitives into SVG. The webview draws the
// same primitives with React; the SVG export and the PNG the agent receives come from `toSvg`. Shapes and text only,
// no foreignObject and no CSS variables, so any viewer renders it and canvas.drawImage rasterises it. A scene (`show`,
// `lit`) decides what is drawn and what is dimmed; the layout itself always runs on every element, so nothing moves
// between steps.

import { DIM, type CanvasElement, type CanvasSpec, type End } from './canvas';
import { iconPath } from './icons';
import { FONT_PX, LINE_H, textWidth, wrap } from './measure';
import { layoutCanvas, rowBoxes, type CanvasLayout, type LayoutOptions, type Placed } from './layout';
import { color, dashOf, mix, type Palette, type Primitive } from './primitives';
import { routeArrow, type Pt, type Route } from './route';
import { ORIGIN_TAG } from './widgets/shell';
import { paintWidget } from './widgets';

export { color, DARK, LIGHT } from './primitives';
export type { Palette, Primitive } from './primitives';

export interface PaintOptions extends LayoutOptions {
	/** The elements drawn (absent: all). An arrow is hidden when an end is hidden. */
	show?: ReadonlySet<string>;
	/** The elements at full strength (absent: all); the rest are dimmed. */
	lit?: ReadonlySet<string>;
}

export interface Painted {
	primitives: Primitive[];
	layout: CanvasLayout;
	routes: Map<string, Route>;
	/** The ids of the elements this scene does not draw. */
	hidden: Set<string>;
}

const DIMMED = 0.28;

export function paintCanvas(spec: CanvasSpec, p: Palette, o: PaintOptions = {}): Painted {
	const layout = layoutCanvas(spec, o);
	const out: Primitive[] = [];
	const routes = new Map<string, Route>();
	const hidden = new Set<string>();
	const shown = (id: string) => !o.show || o.show.has(id);
	const endEl = (e: End): string | undefined => typeof e === 'string' ? e : 'el' in e ? e.el : undefined;
	const endShown = (e: End) => { const id = endEl(e); return id === undefined || shown(layout.rep.get(id) ?? id); };

	// Lit: an element is at full strength when it is listed, or (a frame) holds one that is.
	const parentOf = new Map(spec.elements.map(e => [e.id, e.frame]));
	const litSet = o.lit && o.lit.size ? o.lit : undefined;
	const litFrames = new Set<string>();
	if (litSet) for (const id of litSet) for (let f = parentOf.get(id), n = 0; f && n < 8; f = parentOf.get(f), n++) litFrames.add(f);
	const isLit = (el: CanvasElement) => !litSet || litSet.has(el.id) || litFrames.has(el.id);
	const tag = (prims: Primitive[], el: CanvasElement, dim: boolean) => {
		for (const pr of prims) {
			pr.id = el.id;
			if (dim) pr.opacity = (pr.opacity ?? 1) * DIMMED;
			out.push(pr);
		}
	};

	const placed = [...layout.boxes.values()].sort((a, b) => a.depth - b.depth);
	for (const pl of placed) {
		if (!shown(pl.el.id)) { hidden.add(pl.el.id); continue; }
		const prims: Primitive[] = [];
		paintElement(pl, p, prims);
		const note = o.overrides?.notes?.[pl.el.id];
		if (note) paintNote(pl, note, p, prims);
		tag(prims, pl.el, !isLit(pl.el));
	}

	// Parallel arrows between the same pair are offset so they do not overlap.
	const arrows = spec.elements.filter(e => e.type === 'arrow');
	const pairKey = (a: CanvasElement) => a.type === 'arrow' ? `${endId(a.arrow.from)}>${endId(a.arrow.to)}` : '';
	const counts = new Map<string, number>();
	for (const a of arrows) counts.set(pairKey(a), (counts.get(pairKey(a)) ?? 0) + 1);
	const seen = new Map<string, number>();
	for (const a of arrows) {
		if (a.type !== 'arrow') continue;
		const key = pairKey(a);
		const par = seen.get(key) ?? 0;
		seen.set(key, par + 1);
		if (!shown(a.id) || !endShown(a.arrow.from) || !endShown(a.arrow.to)) { hidden.add(a.id); continue; }
		const r = routeArrow({ el: a, arrow: a.arrow, par, pars: counts.get(key) }, layout);
		if ('skipped' in r) {
			if (r.skipped === 'collapsed') layout.notes.push(`arrow \`${a.id}\`: both ends are inside collapsed frame \`${r.frame}\`; it is drawn when the frame opens.`);
			continue;
		}
		routes.set(a.id, r);
		const stroke = color(a.style?.stroke, p, p.muted);
		const head = a.arrow.head ?? 'arrow';
		const ends = [a.arrow.from, a.arrow.to].map(endEl).filter((x): x is string => !!x);
		const dim = !!litSet && !litSet.has(a.id) && !ends.every(id => litSet.has(id) || litFrames.has(id));
		const prims: Primitive[] = [{ kind: 'path', d: r.d, stroke, sw: 1.4, dash: dashOf(a.style?.line), head: head === 'none' ? undefined : head === 'open' ? 'open' : 'arrow', tail: head === 'both' ? 'arrow' : undefined }];
		const at = a.arrow.at !== undefined ? pointAt(r.points, a.arrow.at) : r.label;
		const badge = [a.arrow.data?.type, a.arrow.data?.shape].filter(Boolean).join(' ');
		if (a.label) prims.push({ kind: 'text', x: at.x, y: at.y - 4, text: a.label, size: FONT_PX.s, fill: p.muted, anchor: 'middle', halo: p.canvas });
		if (badge) {
			const w = textWidth(badge, FONT_PX.s - 0.5, true) + 10;
			prims.push({ kind: 'rect', x: at.x - w / 2, y: at.y + (a.label ? 3 : -7), w, h: 14, rx: 7, fill: p.card, stroke: p.strong });
			prims.push({ kind: 'text', x: at.x, y: at.y + (a.label ? 13 : 3), text: badge, size: FONT_PX.s - 0.5, fill: p.accent, anchor: 'middle', mono: true });
		}
		tag(prims, a, dim);
	}
	return { primitives: out, layout, routes, hidden };
}

const endId = (e: End) => typeof e === 'string' ? e : 'el' in e ? `${e.el}${e.port ? `#${e.port}` : ''}` : `${e.x},${e.y}`;

/** The point `t` (0..1) of the way along a polyline, by length. */
function pointAt(pts: Pt[], t: number): Pt {
	const lens = pts.slice(1).map((q, i) => Math.hypot(q.x - pts[i].x, q.y - pts[i].y));
	let left = Math.max(0, Math.min(1, t)) * lens.reduce((a, b) => a + b, 0);
	for (const [i, len] of lens.entries()) {
		if (left <= len || i === lens.length - 1) {
			const k = len ? Math.min(1, left / len) : 0;
			return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
		}
		left -= len;
	}
	return pts[0];
}

const portText = (arrow: string, port: { name: string; type?: string; value?: string; origin?: keyof typeof ORIGIN_TAG }) =>
	`${arrow} ${port.name}${port.type ? `: ${port.type}` : ''}${port.value ? ` = ${port.value}` : ''}${port.origin ? `  ${ORIGIN_TAG[port.origin]}` : ''}`;

/** The note a user pinned to an element: a small sticky under it, wrapped to 190px. */
function paintNote(pl: Placed, note: string, p: Palette, out: Primitive[]) {
	const lines = wrap(note, FONT_PX.s, 190).slice(0, 6);
	const w = Math.max(...lines.map(l => textWidth(l, FONT_PX.s))) + 16, h = lines.length * LINE_H.s + 10;
	const x = pl.box.x, y = pl.box.y + pl.box.h + 6;
	out.push({ kind: 'rect', x, y, w, h, rx: 4, fill: mix(p.card, p.amber, 0.22), stroke: p.amber });
	lines.forEach((l, i) => out.push({ kind: 'text', x: x + 8, y: y + 8 + FONT_PX.s + i * LINE_H.s - 2, text: l, size: FONT_PX.s, fill: p.ink }));
}

function paintOrigin(pl: Placed, p: Palette, out: Primitive[]) {
	const { el, box } = pl;
	if (!el.origin) return;
	const text = el.origin === 'runtime' && el.source ? `runtime · ${el.source}` : el.origin;
	const t = text.length > 28 ? `${text.slice(0, 27)}…` : text;
	const fill = el.origin === 'runtime' ? p.teal : el.origin === 'illustrative' ? p.amber : p.green;
	const w = textWidth(t, FONT_PX.s - 2) + 10;
	out.push({ kind: 'rect', x: box.x + box.w - w - 6, y: box.y - 7, w, h: 13, rx: 6.5, fill: p.canvas, stroke: fill });
	out.push({ kind: 'text', x: box.x + box.w - w / 2 - 6, y: box.y + 2.5, text: t, size: FONT_PX.s - 2, fill, anchor: 'middle' });
}

function paintElement(pl: Placed, p: Palette, out: Primitive[]) {
	const { el, box } = pl;
	const fill = color(el.style?.fill, p, p.card);
	const stroke = color(el.style?.stroke, p, p.line);
	const ink = color(el.style?.text, p, p.ink);
	const dash = dashOf(el.style?.line);
	const weight = el.style?.weight === 'bold' ? 600 : undefined;
	switch (el.type) {
		case 'frame': {
			out.push({ kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, rx: DIM.radius, fill: el.style?.fill ? fill : 'none', stroke: color(el.style?.stroke, p, p.strong), dash: pl.collapsed ? undefined : dash, opacity: el.style?.opacity });
			if (el.label) out.push({ kind: 'text', x: box.x + 14, y: box.y + 19, text: el.label, size: FONT_PX.s + 1.5, fill: ink, weight: 600 });
			if (pl.collapsed) out.push({ kind: 'text', x: box.x + 14, y: box.y + 40, text: `${pl.count ?? 0} element${pl.count === 1 ? '' : 's'} ▸`, size: FONT_PX.s, fill: p.muted });
			break;
		}
		case 'rect': {
			out.push({ kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, rx: DIM.radius, fill, stroke, dash, opacity: el.style?.opacity });
			const stripe = el.kind ? p.kinds[el.kind] : undefined;
			if (stripe) out.push({ kind: 'rect', x: box.x, y: box.y + 8, w: 3, h: box.h - 16, rx: 1.5, fill: stripe });
			if (el.icon) {
				const d = iconPath(el.icon, box.x + box.w - 26, box.y + 8, 16);
				if (d) out.push({ kind: 'path', d, stroke: p.muted, sw: 1.3 });
				else out.push({ kind: 'text', x: box.x + box.w - 8, y: box.y + 16, text: el.icon.slice(0, 10), size: FONT_PX.s - 1.5, fill: p.muted, anchor: 'end', mono: true });
			}
			if (el.label) out.push({ kind: 'text', x: box.x + 12, y: box.y + 22, text: el.label, size: FONT_PX.title, fill: ink, weight: 600 });
			if (el.detail) out.push({ kind: 'text', x: box.x + 12, y: box.y + 38, text: el.detail, size: FONT_PX.s, fill: p.muted });
			for (const row of rowBoxes(el, box)) {
				out.push({ kind: 'text', x: box.x + 12, y: row.box.y + 13, text: portText(row.output ? '←' : '→', row.port), size: FONT_PX.s, fill: ink, mono: true });
			}
			const base = box.y + DIM.rect.h - 6 + ((el.inputs?.length ?? 0) + (el.output ? 1 : 0)) * DIM.portRow;
			(el.members ?? []).slice(0, 12).forEach((m, i) => out.push({ kind: 'text', x: box.x + 12, y: base + i * DIM.memberRow, text: m.text, size: FONT_PX.s, fill: p.muted, mono: true }));
			break;
		}
		case 'ellipse': {
			out.push({ kind: 'ellipse', cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2, ry: box.h / 2, fill, stroke });
			if (el.label) out.push({ kind: 'text', x: box.x + box.w / 2, y: box.y + box.h / 2 + 4, text: el.label, size: FONT_PX.m, fill: ink, weight: 600, anchor: 'middle' });
			break;
		}
		case 'diamond': {
			const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
			out.push({ kind: 'path', d: `M${cx} ${box.y} L${box.x + box.w} ${cy} L${cx} ${box.y + box.h} L${box.x} ${cy} Z`, stroke, fill });
			if (el.label) out.push({ kind: 'text', x: cx, y: cy + 4, text: el.label, size: FONT_PX.m, fill: ink, anchor: 'middle', mono: true });
			break;
		}
		case 'text': {
			const size = FONT_PX[el.style?.size ?? 'm'];
			const lh = LINE_H[el.style?.size ?? 'm'];
			(pl.lines ?? []).forEach((line, i) => out.push({ kind: 'text', x: box.x, y: box.y + size + i * lh, text: line, size, fill: ink, weight }));
			break;
		}
		case 'path': {
			const sw = el.style?.size === 'l' ? 2.4 : el.style?.size === 's' ? 1 : 1.6;
			const filled = el.path.closed && el.style?.fill ? fill : undefined;
			if (el.path.points?.length) out.push({ kind: 'path', d: pathData(el.path.points, box, !!el.path.smooth, !!el.path.closed), stroke: color(el.style?.stroke, p, p.muted), sw, dash, fill: filled });
			else if (el.path.d) out.push({ kind: 'path', d: el.path.d, at: [box.x, box.y], stroke: color(el.style?.stroke, p, p.muted), sw, dash, fill: filled });
			if (el.label) out.push({ kind: 'text', x: box.x, y: box.y - 6, text: el.label, size: FONT_PX.s, fill: ink });
			break;
		}
		case 'arrow': return;
		default:
			out.push(...paintWidget(el, box, p));
	}
	paintOrigin(pl, p, out);
	if (el.note) out.push({ kind: 'ellipse', cx: box.x + 2, cy: box.y + 2, rx: 6, ry: 6, fill: p.amber, stroke: p.canvas }, { kind: 'text', x: box.x + 2, y: box.y + 5, text: 'i', size: 9, fill: p.canvas, anchor: 'middle', weight: 600 });
}

/** A polyline (or, smooth, a Catmull-Rom spline as cubics) through the points, moved to the element's box. */
function pathData(points: [number, number][], box: { x: number; y: number }, smooth: boolean, closed: boolean): string {
	const q = points.map(([x, y]) => ({ x: x + box.x, y: y + box.y }));
	const f = (n: number) => Math.round(n * 10) / 10;
	let d = `M${f(q[0].x)} ${f(q[0].y)}`;
	if (smooth && q.length > 2) {
		for (let i = 0; i < q.length - 1; i++) {
			const a = q[Math.max(0, i - 1)], b = q[i], c = q[i + 1], e = q[Math.min(q.length - 1, i + 2)];
			d += ` C${f(b.x + (c.x - a.x) / 6)} ${f(b.y + (c.y - a.y) / 6)}, ${f(c.x - (e.x - b.x) / 6)} ${f(c.y - (e.y - b.y) / 6)}, ${f(c.x)} ${f(c.y)}`;
		}
	} else {
		for (const pt of q.slice(1)) d += ` L${f(pt.x)} ${f(pt.y)}`;
	}
	return closed ? `${d} Z` : d;
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = `font-family="'Segoe UI', system-ui, sans-serif"`;
const MONO = `font-family="Consolas, 'JetBrains Mono', Menlo, monospace"`;

/** The SVG of a painted canvas, `margin` around it. */
export function toSvg(painted: Painted, p: Palette, margin = 24): string {
	const w = Math.ceil(painted.layout.w + 2 * margin), h = Math.ceil(painted.layout.h + 2 * margin);
	const out = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
		`<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${p.muted}"/></marker>`,
		`<marker id="o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="${p.muted}" stroke-width="1.4"/></marker></defs>`,
		`<rect width="${w}" height="${h}" fill="${p.canvas}"/>`,
		`<g transform="translate(${margin} ${margin})">`,
	];
	const op = (pr: Primitive) => pr.opacity !== undefined ? ` opacity="${pr.opacity}"` : '';
	// Coordinates come from glyph widths and fractions: two decimals are plenty, and the file stays readable and stable.
	const r = (n: number) => Math.round(n * 100) / 100;
	for (const pr of painted.primitives) {
		switch (pr.kind) {
			case 'rect': out.push(`<rect x="${r(pr.x)}" y="${r(pr.y)}" width="${r(pr.w)}" height="${r(pr.h)}" rx="${pr.rx ?? 0}" fill="${pr.fill ?? 'none'}" stroke="${pr.stroke ?? 'none'}"${pr.dash ? ` stroke-dasharray="${pr.dash}"` : ''}${pr.sw ? ` stroke-width="${pr.sw}"` : ''}${op(pr)}/>`); break;
			case 'ellipse': out.push(`<ellipse cx="${r(pr.cx)}" cy="${r(pr.cy)}" rx="${r(pr.rx)}" ry="${r(pr.ry)}" fill="${pr.fill ?? 'none'}" stroke="${pr.stroke ?? 'none'}"${op(pr)}/>`); break;
			case 'path': out.push(`<path d="${xml(pr.d)}"${pr.at ? ` transform="translate(${r(pr.at[0])} ${r(pr.at[1])})"` : ''} fill="${pr.fill ?? 'none'}" stroke="${pr.stroke}" stroke-width="${pr.sw ?? 1}" stroke-linecap="round" stroke-linejoin="round"${pr.dash ? ` stroke-dasharray="${pr.dash}"` : ''}${pr.head ? ` marker-end="url(#${pr.head === 'open' ? 'o' : 'a'})"` : ''}${pr.tail ? ` marker-start="url(#a)"` : ''}${op(pr)}/>`); break;
			case 'text': {
				const tw = textWidth(pr.text, pr.size, pr.mono);
				const halo = pr.halo ? `<rect x="${r(pr.anchor === 'middle' ? pr.x - tw / 2 - 4 : pr.anchor === 'end' ? pr.x - tw - 4 : pr.x - 4)}" y="${r(pr.y - pr.size)}" width="${tw + 8}" height="${pr.size + 5}" rx="3" fill="${pr.halo}"${op(pr)}/>` : '';
				out.push(`${halo}<text x="${r(pr.x)}" y="${r(pr.y)}" ${pr.mono ? MONO : FONT} xml:space="preserve" font-size="${pr.size}"${pr.weight ? ` font-weight="${pr.weight}"` : ''}${pr.anchor ? ` text-anchor="${pr.anchor}"` : ''} fill="${pr.fill}"${op(pr)}>${xml(pr.text)}</text>`);
				break;
			}
		}
	}
	out.push('</g></svg>');
	return out.join('\n');
}

/** What an agent is told about each element: `{ id: {x, y, w, h} }` in the layout's own coordinates, rounded. */
export function boxesOf(layout: CanvasLayout): Record<string, { x: number; y: number; w: number; h: number }> {
	const r = (n: number) => Math.round(n);
	return Object.fromEntries([...layout.boxes.values()].map(pl => [pl.el.id, { x: r(pl.box.x), y: r(pl.box.y), w: r(pl.box.w), h: r(pl.box.h) }]));
}

