// The canvas board: what an agent draws freely (shapes, frames, arrows, data widgets) and what the host and the
// webview both compute from it. This package imports nothing and reaches no Node built-in, because the extension
// host lays out, lints and renders with it and the canvas webview draws with it (checked by `npm run arch`).
// Phase 0 carries the shapes the prototype needs; the widgets (table, json, chart, matrix, code) follow the same
// pattern in later phases (docs/plans/canvas-board.md).

export type Side = 'top' | 'right' | 'bottom' | 'left';
export type Layout = 'row' | 'column' | 'grid';
export type Origin = 'source' | 'illustrative' | 'runtime';
export type Color = 'accent' | 'teal' | 'amber' | 'green' | 'violet' | 'red' | 'ink' | 'muted' | 'card' | 'canvas' | `#${string}`;

export interface Style {
	fill?: Color;
	stroke?: Color;
	line?: 'solid' | 'dashed' | 'dotted';
	text?: Color;
	weight?: 'normal' | 'bold';
	size?: 's' | 'm' | 'l';
	opacity?: number;
}

export interface Link { symbol?: string; file?: string; line?: number; board?: string }

export interface Port { id: string; name: string; type?: string; value?: string; origin?: Origin; link?: Link }

/** An arrow end: an element, an element with a side or port, or a free point. */
export type End = string | { el: string; side?: Side; port?: string } | { x: number; y: number };

interface Common {
	id: string;
	/** The frame this element sits in; absent: the root. */
	frame?: string;
	/** Absolute placement inside the parent's content box. A frame whose children use it is an absolute frame. */
	x?: number; y?: number; w?: number; h?: number;
	label?: string;
	detail?: string;
	style?: Style;
	link?: Link;
	origin?: Origin;
	source?: string;
	note?: string;
	/** Grid columns taken. */
	span?: number;
}

export interface FrameData {
	layout?: Layout;
	columns?: number;
	gap?: number;
	pad?: number;
	align?: 'start' | 'center' | 'stretch';
	collapsed?: boolean;
}

export interface ArrowData {
	from: End;
	to: End;
	route?: 'straight' | 'elbow' | 'curve';
	head?: 'arrow' | 'open' | 'none' | 'both';
	/** Where the label sits along the line, 0..1; absent: the longest segment's middle. */
	at?: number;
	/** Drawn as a badge beside the label: the type or shape of what travels. */
	data?: { type?: string; shape?: string };
}

export type CanvasElement = Common & (
	| { type: 'rect'; kind?: string; icon?: string; inputs?: Port[]; output?: Port }
	| { type: 'ellipse' }
	| { type: 'diamond' }
	| { type: 'text' }
	| { type: 'frame'; frame?: string; frameData?: FrameData }
	| { type: 'arrow'; arrow: ArrowData }
);

export type ElementType = CanvasElement['type'];

export interface CanvasSpec {
	title: string;
	purpose?: 'concept' | 'code';
	/** The root's layout; default grid. */
	layout?: Layout;
	columns?: number;
	elements: CanvasElement[];
}

/** A user's move of one element: absolute inside its frame, valid while the frame's layout input keeps this hash. */
export interface Move { x: number; y: number; hash: string }
export interface Overrides { moves?: Record<string, Move>; notes?: Record<string, string> }

export const LIMITS = { elements: 300, frames: 60, depth: 3, ports: 12, text: 2000 } as const;

/** Spacing and sizes the layout uses; the design page draws them from these numbers. */
export const DIM = {
	frameHead: 28, pad: 14, gap: 16, radius: 8,
	rect: { w: 160, h: 64 }, ellipse: { w: 120, h: 72 }, diamond: { w: 140, h: 80 }, textWidth: 240,
	collapsed: { w: 200, h: 64 }, portRow: 18, memberRow: 18,
	inflate: 8, arrowOffset: 9,
} as const;
