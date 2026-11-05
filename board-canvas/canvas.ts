// The canvas board: what an agent draws freely (shapes, frames, arrows, data widgets) and what the host and the
// webview both compute from it. This package imports nothing and reaches no Node built-in, because the extension host
// lays out, lints and renders with it and the canvas webview draws with it (checked by `npm run arch`). Shapes and data
// widgets share one discriminated union: common fields outside, a widget's data in a sub-object named after its type, so
// no field names collide and the MCP schema is a `oneOf` (docs/plans/canvas-board.md).

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

/** Where an element or port points: a code symbol (the host fills file and line), a file, or another board to zoom into. */
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
	/** Where a `runtime` value was observed ("test output", "log line 42"). */
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

export interface PathData { points?: [number, number][]; d?: string; closed?: boolean; smooth?: boolean }

export interface Column { key: string; label?: string; align?: 'left' | 'right'; mono?: boolean; link?: boolean }
export interface TableData { columns: Column[]; rows: Record<string, unknown>[]; maxRows?: number }

/** A typed tree without values; `unknown`: the type is known, the value is not. */
export interface SchemaNode { name: string; type: string; origin?: Origin; link?: Link; children?: SchemaNode[]; unknown?: boolean }
export interface JsonData { value?: unknown; schema?: SchemaNode; open?: number; maxItems?: number }

export interface Series { label: string; points: number[] | [number, number][]; labels?: string[]; color?: Color }
export interface Axes { x?: { label?: string; range?: [number, number] }; y?: { label?: string; range?: [number, number] } }
export interface ChartData { kind: 'bar' | 'line' | 'scatter' | 'points2d'; series: Series[]; axes?: Axes }

export interface MatrixData {
	cells: number[][];
	rowLabels?: string[];
	colLabels?: string[];
	/** The full shape when `cells` is a cut of a larger matrix, e.g. "4 × 768". */
	dims?: string;
	scale?: 'diverging' | 'sequential';
	range?: [number, number];
	showValues?: boolean;
}

/** `text` wins over `file` + `lines`: the host reads the file and fills `text` when the board is drawn. */
export interface CodeData { file?: string; lines?: [number, number]; text?: string; language?: string; highlight?: number[] }

export interface Member { text: string; kind?: 'field' | 'method' | 'property' }

export type CanvasElement = Common & (
	| { type: 'rect'; kind?: string; icon?: string; inputs?: Port[]; output?: Port; members?: Member[] }
	| { type: 'ellipse' }
	| { type: 'diamond' }
	| { type: 'text' }
	| { type: 'frame'; frame?: string; frameData?: FrameData }
	| { type: 'path'; path: PathData }
	| { type: 'arrow'; arrow: ArrowData }
	| { type: 'table'; table: TableData }
	| { type: 'json'; json: JsonData }
	| { type: 'chart'; chart: ChartData }
	| { type: 'matrix'; matrix: MatrixData }
	| { type: 'code'; code: CodeData }
);

export type ElementType = CanvasElement['type'];
export type WidgetType = 'table' | 'json' | 'chart' | 'matrix' | 'code';

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

/** The scene a step shows: which elements are drawn, which frames are open, which elements stay at full strength. */
export interface Scene { show?: ReadonlySet<string>; open?: ReadonlySet<string>; lit?: ReadonlySet<string> }

export const LIMITS = { elements: 300, frames: 60, depth: 3, ports: 12, text: 2000, codeLines: 12, matrix: 24, jsonNodes: 400, members: 12, tableRows: 40, tableCols: 12, series: 6, points: 200 } as const;

/** Spacing and sizes the layout uses; the design page draws them from these numbers. */
export const DIM = {
	frameHead: 28, pad: 14, gap: 16, radius: 8,
	rect: { w: 160, h: 64 }, ellipse: { w: 120, h: 72 }, diamond: { w: 140, h: 80 }, textWidth: 240,
	collapsed: { w: 200, h: 64 }, portRow: 18, memberRow: 18,
	inflate: 8, arrowOffset: 9,
} as const;

/** The element types that carry data: the ones with a widget. */
export const WIDGETS: readonly WidgetType[] = ['table', 'json', 'chart', 'matrix', 'code'];
