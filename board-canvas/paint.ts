// Turns a laid-out canvas into primitives (rect, text, path, circle) and the primitives into SVG. The webview draws the
// same primitives with React; the SVG export and the PNG the agent receives come from `toSvg`. Shapes and text only,
// no foreignObject and no CSS variables, so any viewer renders it and canvas.drawImage rasterises it.

import { DIM, type CanvasSpec, type Color, type End } from './canvas';
import { FONT_PX, LINE_H, textWidth } from './measure';
import { layoutCanvas, type CanvasLayout, type LayoutOptions, type Placed } from './layout';
import { routeArrow, type Route } from './route';

export interface Palette {
	canvas: string; card: string; line: string; strong: string; ink: string; muted: string;
	accent: string; teal: string; amber: string; green: string; violet: string; red: string;
	kinds: Record<string, string>;
}

export const DARK: Palette = {
	canvas: '#181818', card: '#222222', line: '#2c2c2c', strong: '#3f3f3f', ink: '#d4d4d4', muted: '#8b8b8b',
	accent: '#6f86ff', teal: '#4fd6d0', amber: '#ffb454', green: '#5fe0a1', violet: '#b88cff', red: '#ff6b7d',
	kinds: { entry: '#ffb454', controller: '#ffb454', service: '#6f86ff', repository: '#4fd6d0', entity: '#e6c15a', dto: '#5fe0a1', enum: '#b88cff', interface: '#7cc4ff', class: '#8b93a1', external: '#5c6370', step: '#8b93a1', decision: '#ffb454', note: '#e6c15a', actor: '#b88cff' },
};

export const LIGHT: Palette = {
	...DARK,
	canvas: '#ffffff', card: '#f6f7f9', line: '#e3e5ea', strong: '#c9cdd6', ink: '#1f2328', muted: '#6b7280',
};

export type Primitive =
	| { kind: 'rect'; id?: string; x: number; y: number; w: number; h: number; rx?: number; fill?: string; stroke?: string; dash?: string; sw?: number; opacity?: number }
	| { kind: 'text'; id?: string; x: number; y: number; text: string; size: number; fill: string; weight?: 600; anchor?: 'start' | 'middle' | 'end'; mono?: boolean; halo?: string }
	| { kind: 'path'; id?: string; d: string; stroke: string; sw?: number; dash?: string; fill?: string; head?: 'arrow' | 'open'; tail?: 'arrow' | 'open' }
	| { kind: 'ellipse'; id?: string; cx: number; cy: number; rx: number; ry: number; fill?: string; stroke?: string };

export interface Painted { primitives: Primitive[]; layout: CanvasLayout; routes: Map<string, Route> }

export function color(c: Color | undefined, p: Palette, fallback: string): string {
	if (!c) return fallback;
	if (c.startsWith('#')) return c;
	return (p as unknown as Record<string, string>)[c] ?? fallback;
}

const dashOf = (line?: 'solid' | 'dashed' | 'dotted') => line === 'dashed' ? '6 4' : line === 'dotted' ? '2 4' : undefined;

export function paintCanvas(spec: CanvasSpec, p: Palette, o: LayoutOptions = {}): Painted {
	const layout = layoutCanvas(spec, o);
	const out: Primitive[] = [];
	const routes = new Map<string, Route>();
	const placed = [...layout.boxes.values()].sort((a, b) => a.depth - b.depth);
	for (const pl of placed) paintElement(pl, p, out);
	// Parallel arrows between the same pair are offset so they do not overlap.
	const arrows = spec.elements.filter(e => e.type === 'arrow');
	const pairKey = (a: typeof arrows[number]) => a.type === 'arrow' ? `${endId(a.arrow.from)}>${endId(a.arrow.to)}` : '';
	const counts = new Map<string, number>();
	for (const a of arrows) counts.set(pairKey(a), (counts.get(pairKey(a)) ?? 0) + 1);
	const seen = new Map<string, number>();
	for (const a of arrows) {
		if (a.type !== 'arrow') continue;
		const key = pairKey(a);
		const par = seen.get(key) ?? 0;
		seen.set(key, par + 1);
		const r = routeArrow({ el: a, arrow: a.arrow, par, pars: counts.get(key) }, layout);
		if ('skipped' in r) {
			if (r.skipped === 'collapsed') layout.notes.push(`arrow \`${a.id}\`: both ends are inside collapsed frame \`${r.frame}\`; it is drawn when the frame opens.`);
			continue;
		}
		routes.set(a.id, r);
		const stroke = color(a.style?.stroke, p, p.muted);
		const head = a.arrow.head ?? 'arrow';
		out.push({ kind: 'path', id: a.id, d: r.d, stroke, sw: 1.4, dash: dashOf(a.style?.line), head: head === 'none' ? undefined : head === 'open' ? 'open' : 'arrow', tail: head === 'both' ? 'arrow' : undefined });
		const label = [a.label, a.arrow.data?.type ?? a.arrow.data?.shape].filter(Boolean).join('  ');
		if (label) out.push({ kind: 'text', x: r.label.x, y: r.label.y - 4, text: label, size: FONT_PX.s - 0.5, fill: p.muted, anchor: 'middle', mono: true, halo: p.canvas });
	}
	return { primitives: out, layout, routes };
}

const endId = (e: End) => typeof e === 'string' ? e : 'el' in e ? e.el : `${e.x},${e.y}`;

function paintElement(pl: Placed, p: Palette, out: Primitive[]) {
	const { el, box } = pl;
	const fill = color(el.style?.fill, p, p.card);
	const stroke = color(el.style?.stroke, p, p.line);
	const ink = color(el.style?.text, p, p.ink);
	const dash = dashOf(el.style?.line);
	const weight = el.style?.weight === 'bold' ? 600 : undefined;
	switch (el.type) {
		case 'frame': {
			out.push({ kind: 'rect', id: el.id, x: box.x, y: box.y, w: box.w, h: box.h, rx: DIM.radius, fill: el.style?.fill ? fill : 'none', stroke: color(el.style?.stroke, p, p.strong), dash: pl.collapsed ? undefined : dash, opacity: el.style?.opacity });
			if (el.label) out.push({ kind: 'text', x: box.x + 14, y: box.y + 19, text: el.label, size: FONT_PX.s + 1.5, fill: ink, weight: 600 });
			if (pl.collapsed) out.push({ kind: 'text', x: box.x + 14, y: box.y + 40, text: `${pl.count ?? 0} element${pl.count === 1 ? '' : 's'} ▸`, size: FONT_PX.s, fill: p.muted });
			return;
		}
		case 'rect': {
			out.push({ kind: 'rect', id: el.id, x: box.x, y: box.y, w: box.w, h: box.h, rx: DIM.radius, fill, stroke, dash, opacity: el.style?.opacity });
			const stripe = el.kind ? p.kinds[el.kind] : undefined;
			if (stripe) out.push({ kind: 'rect', x: box.x, y: box.y + 8, w: 3, h: box.h - 16, rx: 1.5, fill: stripe });
			if (el.label) out.push({ kind: 'text', x: box.x + 12, y: box.y + 22, text: el.label, size: FONT_PX.title, fill: ink, weight: 600 });
			if (el.detail) out.push({ kind: 'text', x: box.x + 12, y: box.y + 38, text: el.detail, size: FONT_PX.s, fill: p.muted });
			let y = box.y + DIM.rect.h - 6;
			for (const port of el.inputs ?? []) {
				out.push({ kind: 'text', x: box.x + 12, y, text: `→ ${port.name}${port.type ? `: ${port.type}` : ''}${port.value ? ` = ${port.value}` : ''}`, size: FONT_PX.s, fill: ink, mono: true });
				y += DIM.portRow;
			}
			if (el.output) out.push({ kind: 'text', x: box.x + 12, y, text: `← ${el.output.name}${el.output.type ? `: ${el.output.type}` : ''}${el.output.value ? ` = ${el.output.value}` : ''}`, size: FONT_PX.s, fill: ink, mono: true });
			return;
		}
		case 'ellipse': {
			out.push({ kind: 'ellipse', id: el.id, cx: box.x + box.w / 2, cy: box.y + box.h / 2, rx: box.w / 2, ry: box.h / 2, fill, stroke });
			if (el.label) out.push({ kind: 'text', x: box.x + box.w / 2, y: box.y + box.h / 2 + 4, text: el.label, size: FONT_PX.m, fill: ink, weight: 600, anchor: 'middle' });
			return;
		}
		case 'diamond': {
			const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
			out.push({ kind: 'path', id: el.id, d: `M${cx} ${box.y} L${box.x + box.w} ${cy} L${cx} ${box.y + box.h} L${box.x} ${cy} Z`, stroke, fill });
			if (el.label) out.push({ kind: 'text', x: cx, y: cy + 4, text: el.label, size: FONT_PX.m, fill: ink, anchor: 'middle', mono: true });
			return;
		}
		case 'text': {
			const size = FONT_PX[el.style?.size ?? 'm'];
			const lh = LINE_H[el.style?.size ?? 'm'];
			(pl.lines ?? []).forEach((line, i) => out.push({ kind: 'text', id: i ? undefined : el.id, x: box.x, y: box.y + size + i * lh, text: line, size, fill: ink, weight }));
			return;
		}
	}
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = `font-family="'Segoe UI', system-ui, sans-serif"`;
const MONO = `font-family="Consolas, 'JetBrains Mono', Menlo, monospace"`;

export function toSvg(painted: Painted, p: Palette, margin = 24): string {
	const w = Math.ceil(painted.layout.w + 2 * margin), h = Math.ceil(painted.layout.h + 2 * margin);
	const out = [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
		`<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${p.muted}"/></marker>`,
		`<marker id="o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="${p.muted}" stroke-width="1.4"/></marker></defs>`,
		`<rect width="${w}" height="${h}" fill="${p.canvas}"/>`,
		`<g transform="translate(${margin} ${margin})">`,
	];
	for (const pr of painted.primitives) {
		switch (pr.kind) {
			case 'rect': out.push(`<rect x="${pr.x}" y="${pr.y}" width="${pr.w}" height="${pr.h}" rx="${pr.rx ?? 0}" fill="${pr.fill ?? 'none'}" stroke="${pr.stroke ?? 'none'}"${pr.dash ? ` stroke-dasharray="${pr.dash}"` : ''}${pr.sw ? ` stroke-width="${pr.sw}"` : ''}${pr.opacity !== undefined ? ` opacity="${pr.opacity}"` : ''}/>`); break;
			case 'ellipse': out.push(`<ellipse cx="${pr.cx}" cy="${pr.cy}" rx="${pr.rx}" ry="${pr.ry}" fill="${pr.fill ?? 'none'}" stroke="${pr.stroke ?? 'none'}"/>`); break;
			case 'path': out.push(`<path d="${pr.d}" fill="${pr.fill ?? 'none'}" stroke="${pr.stroke}" stroke-width="${pr.sw ?? 1}"${pr.dash ? ` stroke-dasharray="${pr.dash}"` : ''}${pr.head ? ` marker-end="url(#${pr.head === 'open' ? 'o' : 'a'})"` : ''}${pr.tail ? ` marker-start="url(#a)"` : ''}/>`); break;
			case 'text': {
				const halo = pr.halo ? `<rect x="${pr.anchor === 'middle' ? pr.x - textWidth(pr.text, pr.size, pr.mono) / 2 - 4 : pr.x - 4}" y="${pr.y - pr.size}" width="${textWidth(pr.text, pr.size, pr.mono) + 8}" height="${pr.size + 5}" rx="3" fill="${pr.halo}"/>` : '';
				out.push(`${halo}<text x="${pr.x}" y="${pr.y}" ${pr.mono ? MONO : FONT} font-size="${pr.size}"${pr.weight ? ` font-weight="${pr.weight}"` : ''}${pr.anchor ? ` text-anchor="${pr.anchor}"` : ''} fill="${pr.fill}">${xml(pr.text)}</text>`);
				break;
			}
		}
	}
	out.push('</g></svg>');
	return out.join('\n');
}
