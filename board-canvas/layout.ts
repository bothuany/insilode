// Places every element: frames lay their children out as a row, a column or a grid (gap 16, pad 14, a 28px header
// when labelled); a frame whose children carry x/y is absolute; a collapsed frame is one small box. The layout runs on
// the whole element set (hidden elements keep their place between scenes) and a user's moves are applied last.
// Pure: no DOM, no Node.

import { DIM, type CanvasElement, type CanvasSpec, type Layout, type Overrides } from './canvas';
import { FONT_PX, LINE_H, textWidth, wrap } from './measure';

export interface Box { x: number; y: number; w: number; h: number }

export interface Placed {
	el: CanvasElement;
	box: Box;
	/** Wrapped label lines for a text element. */
	lines?: string[];
	/** The frame is drawn collapsed: its children are not placed; `count` is how many it hides. */
	collapsed?: boolean;
	count?: number;
	/** Nesting depth, 0 at the root. */
	depth: number;
}

export interface CanvasLayout {
	boxes: Map<string, Placed>;
	/** Elements whose frame is collapsed or unknown; arrows to them reattach to the nearest placed ancestor. */
	rep: Map<string, string>;
	w: number;
	h: number;
	/** What the layout noticed: a mixed frame, a missing frame, an element over the limit. */
	notes: string[];
}

export interface LayoutOptions {
	/** Frames to show expanded in addition to the spec (a scene's `open`). */
	open?: Set<string>;
	overrides?: Overrides;
}

const px = (el: CanvasElement) => FONT_PX[el.style?.size ?? 'm'];

/** The size an element asks for before its frame places it. */
export function intrinsicSize(el: CanvasElement): { w: number; h: number; lines?: string[] } {
	switch (el.type) {
		case 'text': {
			const lines = wrap(el.label ?? '', px(el), el.w ?? DIM.textWidth);
			const w = el.w ?? Math.max(...lines.map(l => textWidth(l, px(el))), 1);
			return { w, h: el.h ?? lines.length * LINE_H[el.style?.size ?? 'm'], lines };
		}
		case 'rect': {
			const rows = (el.inputs?.length ?? 0) + (el.output ? 1 : 0);
			const label = textWidth(el.label ?? '', FONT_PX.title) + 28;
			const detail = el.detail ? textWidth(el.detail, FONT_PX.s) + 28 : 0;
			return { w: el.w ?? Math.max(DIM.rect.w, Math.min(320, Math.max(label, detail))), h: el.h ?? DIM.rect.h + rows * DIM.portRow };
		}
		case 'ellipse': return { w: el.w ?? DIM.ellipse.w, h: el.h ?? DIM.ellipse.h };
		case 'diamond': return { w: el.w ?? DIM.diamond.w, h: el.h ?? DIM.diamond.h };
		case 'frame': return { w: el.w ?? DIM.collapsed.w, h: el.h ?? DIM.collapsed.h };
		case 'arrow': return { w: 0, h: 0 };
	}
}

interface Frame { el: CanvasElement | null; children: CanvasElement[]; data: { layout: Layout; columns: number; gap: number; pad: number; align: 'start' | 'center' | 'stretch'; collapsed: boolean } }

export function layoutCanvas(spec: CanvasSpec, o: LayoutOptions = {}): CanvasLayout {
	const notes: string[] = [];
	const byId = new Map(spec.elements.map(e => [e.id, e]));
	const frames = new Map<string | null, Frame>();
	const frameOf = (el: CanvasElement): Frame['data'] => {
		const d = el.type === 'frame' ? el.frameData ?? {} : {};
		return { layout: d.layout ?? 'row', columns: d.columns ?? 3, gap: d.gap ?? DIM.gap, pad: d.pad ?? DIM.pad, align: d.align ?? 'start', collapsed: !!d.collapsed && !o.open?.has(el.id) };
	};
	frames.set(null, { el: null, children: [], data: { layout: spec.layout ?? 'grid', columns: spec.columns ?? 3, gap: DIM.gap, pad: 0, align: 'start', collapsed: false } });
	for (const el of spec.elements) if (el.type === 'frame') frames.set(el.id, { el, children: [], data: frameOf(el) });
	for (const el of spec.elements) {
		if (el.type === 'arrow') continue;
		const parent = el.frame && frames.has(el.frame) ? el.frame : null;
		if (el.frame && !frames.has(el.frame)) notes.push(`\`${el.id}\`: frame \`${el.frame}\` is not a frame; placed at the root.`);
		if (parent === el.id) continue;
		frames.get(parent)!.children.push(el);
	}

	const boxes = new Map<string, Placed>();
	const rep = new Map<string, string>();
	const seen = new Set<string>();

	// Bottom-up: the size of a frame is the size of its laid-out children; positions are relative until the parent places it.
	interface Sized { w: number; h: number; place: (x: number, y: number, depth: number, w?: number, h?: number) => void }
	const size = (el: CanvasElement, depth: number): Sized => {
		if (el.type === 'frame' && !seen.has(el.id)) {
			seen.add(el.id);
			const f = frames.get(el.id)!;
			if (f.data.collapsed || depth >= 3) {
				if (depth >= 3 && !f.data.collapsed) notes.push(`\`${el.id}\`: frames nest deeper than 3; drawn collapsed.`);
				const s = { w: DIM.collapsed.w, h: DIM.collapsed.h };
				return { ...s, place: (x, y, d) => { const hidden = descendants(el.id); boxes.set(el.id, { el, box: { x, y, ...s }, collapsed: true, count: hidden.length, depth: d }); for (const c of hidden) rep.set(c, el.id); } };
			}
			return sizeFrame(f, depth);
		}
		const s = intrinsicSize(el);
		// `w`/`h`: the slot the frame gives (align: stretch); a leaf takes it, a frame keeps its own size.
		return { w: s.w, h: s.h, place: (x, y, d, w = s.w, h = s.h) => boxes.set(el.id, { el, box: { x, y, w, h }, lines: s.lines, depth: d }) };
	};
	const descendants = (id: string): string[] => frames.get(id)?.children.flatMap(c => [c.id, ...(c.type === 'frame' ? descendants(c.id) : [])]) ?? [];

	const sizeFrame = (f: Frame, depth: number): Sized => {
		const { gap, pad, align } = f.data;
		const head = f.el?.label ? DIM.frameHead : 0;
		const kids = f.children.map(c => ({ el: c, s: size(c, depth + 1) }));
		const absolute = kids.filter(k => k.el.x !== undefined || k.el.y !== undefined);
		if (absolute.length && absolute.length < kids.length) notes.push(`\`${f.el?.id ?? 'root'}\`: some children have x/y and some do not; the ones without are stacked under the others.`);
		const slots: { k: typeof kids[number]; x: number; y: number; w: number; h: number }[] = [];
		let w = 0, h = 0;
		if (absolute.length) {
			for (const k of absolute) {
				const x = k.el.x ?? 0, y = k.el.y ?? 0;
				slots.push({ k, x, y, w: k.s.w, h: k.s.h });
				w = Math.max(w, x + k.s.w);
				h = Math.max(h, y + k.s.h);
			}
			let y = h + (h ? gap : 0);
			for (const k of kids.filter(k => !absolute.includes(k))) {
				slots.push({ k, x: 0, y, w: k.s.w, h: k.s.h });
				w = Math.max(w, k.s.w);
				y += k.s.h + gap;
				h = y - gap;
			}
		} else if (f.data.layout === 'row') {
			let x = 0;
			const rowH = Math.max(0, ...kids.map(k => k.s.h));
			for (const k of kids) {
				const kh = align === 'stretch' ? rowH : k.s.h;
				slots.push({ k, x, y: align === 'center' ? (rowH - k.s.h) / 2 : 0, w: k.s.w, h: kh });
				x += k.s.w + gap;
			}
			w = Math.max(0, x - gap);
			h = rowH;
		} else if (f.data.layout === 'column') {
			let y = 0;
			const colW = Math.max(0, ...kids.map(k => k.s.w));
			for (const k of kids) {
				const kw = align === 'stretch' ? colW : k.s.w;
				slots.push({ k, x: align === 'center' ? (colW - k.s.w) / 2 : 0, y, w: kw, h: k.s.h });
				y += k.s.h + gap;
			}
			w = colW;
			h = Math.max(0, y - gap);
		} else {
			// Grid: rows of `columns` cells; a child's `span` takes that many cells; each row is as tall as its tallest child.
			const cols = Math.max(1, f.data.columns);
			const colW = Math.max(0, ...kids.map(k => Math.ceil(k.s.w / Math.max(1, Math.min(cols, k.el.span ?? 1)))));
			let col = 0, y = 0, rowH = 0;
			const row: typeof slots = [];
			const flush = () => { for (const s of row) if (align === 'stretch') s.h = rowH; else if (align === 'center') s.y += (rowH - s.h) / 2; row.length = 0; y += rowH + gap; rowH = 0; col = 0; };
			for (const k of kids) {
				const span = Math.max(1, Math.min(cols, k.el.span ?? 1));
				if (col + span > cols) flush();
				const slot = { k, x: col * (colW + gap), y, w: span * colW + (span - 1) * gap, h: k.s.h };
				slots.push(slot);
				row.push(slot);
				rowH = Math.max(rowH, k.s.h);
				col += span;
				if (col >= cols) flush();
			}
			if (row.length) flush();
			w = kids.length ? cols * colW + (cols - 1) * gap : 0;
			h = Math.max(0, y - gap);
		}
		const total = { w: w + 2 * pad, h: h + 2 * pad + head };
		return {
			...total,
			place: (x, y, d) => {
				if (f.el) boxes.set(f.el.id, { el: f.el, box: { x, y, ...total }, depth: d });
				for (const s of slots) {
					const m = o.overrides?.moves?.[s.k.el.id];
					const mx = m && m.hash === frameHash(f) ? m.x : s.x;
					const my = m && m.hash === frameHash(f) ? m.y : s.y;
					s.k.s.place(x + pad + mx, y + head + pad + my, d + 1, s.k.el.type === 'frame' ? undefined : s.w, s.k.el.type === 'frame' ? undefined : s.h);
				}
			},
		};
	};

	const root = sizeFrame(frames.get(null)!, 0);
	root.place(0, 0, 0);
	for (const el of spec.elements) if (el.type !== 'arrow' && !boxes.has(el.id) && !rep.has(el.id)) notes.push(`\`${el.id}\` was not placed.`);
	return { boxes, rep, w: root.w, h: root.h, notes };
}

/** A frame's layout input: its children's ids and sizes in order. A move stored with another hash no longer applies. */
export function frameHash(f: { el: CanvasElement | null; children: CanvasElement[] }): string {
	return `${f.el?.id ?? ''}:${f.children.map(c => `${c.id}/${c.type}/${c.w ?? ''}x${c.h ?? ''}`).join(',')}`;
}
