// What a painted canvas is made of: a flat list of primitives (rect, text, path, ellipse) and the palette they are coloured
// with. Widgets and the painter both build them, the webview draws them with React and `toSvg` writes them as SVG, so this
// file sits below both (and imports only the spec types, which keeps the widgets free of layout and paint).

import type { Color } from './canvas';

export interface Box { x: number; y: number; w: number; h: number }

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

/** `id` is the element a primitive belongs to: the webview hit-tests and highlights by it. */
interface Base { id?: string; opacity?: number }

export type Primitive =
	| Base & { kind: 'rect'; x: number; y: number; w: number; h: number; rx?: number; fill?: string; stroke?: string; dash?: string; sw?: number }
	| Base & { kind: 'text'; x: number; y: number; text: string; size: number; fill: string; weight?: 600; anchor?: 'start' | 'middle' | 'end'; mono?: boolean; halo?: string }
	| Base & { kind: 'path'; d: string; /** Moves the whole path (path data given by the agent is relative to its element). */ at?: [number, number]; stroke: string; sw?: number; dash?: string; fill?: string; head?: 'arrow' | 'open'; tail?: 'arrow' | 'open' }
	| Base & { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill?: string; stroke?: string; sw?: number };

/** What a widget (table, json, chart, matrix, code) gives the canvas: the size it asks for and the primitives it paints. */
export interface Widget<E> {
	size(el: E): { w: number; h: number };
	paint(el: E, box: Box, p: Palette): Primitive[];
}

export function color(c: Color | undefined, p: Palette, fallback: string): string {
	if (!c) return fallback;
	if (c.startsWith('#')) return c;
	return (p as unknown as Record<string, string>)[c] ?? fallback;
}

export const dashOf = (line?: 'solid' | 'dashed' | 'dotted') => line === 'dashed' ? '6 4' : line === 'dotted' ? '2 4' : undefined;

/** Reads `#rgb`, `#rrggbb` and `rgb(r, g, b)` (the webview resolves theme tokens to the last form). */
export function rgbOf(c: string): [number, number, number] | undefined {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
	if (hex) {
		const h = hex[1].length === 3 ? hex[1].split('').map(x => x + x).join('') : hex[1];
		return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
	}
	const rgb = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
	return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

/** `a` toward `b` by `t` (0..1) as `#rrggbb`; a colour that cannot be read stays `a`. */
export function mix(a: string, b: string, t: number): string {
	const x = rgbOf(a), y = rgbOf(b);
	if (!x || !y) return a;
	const k = Math.max(0, Math.min(1, t));
	return `#${[0, 1, 2].map(i => Math.round(x[i] + (y[i] - x[i]) * k).toString(16).padStart(2, '0')).join('')}`;
}

/** The colours charts and series cycle through. */
export const cycle = (p: Palette): string[] => [p.accent, p.teal, p.amber, p.green, p.violet, p.red];

/** A cell or label that is too long for its column: cut, with an ellipsis. */
export const clip = (s: string, max: number) => s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;

/** A JSON-ish value as one short line. */
export function show(v: unknown, max = 40): string {
	if (v === null || v === undefined) return '';
	if (typeof v === 'string') return clip(v, max);
	if (typeof v === 'number' || typeof v === 'boolean') return String(v);
	try { return clip(JSON.stringify(v) ?? '', max); } catch { return ''; }
}
