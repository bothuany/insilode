// Turns what an agent sent for a canvas board into a CanvasSpec, dropping what cannot be drawn and saying why. The host
// calls it; the webview receives the result. Every check is structural: ids, frames, ends, limits, strings, the shape of
// each widget's data. `errors` are elements or ends that were dropped; `notes` are values that were cut or changed.

import {
	LIMITS, WIDGETS,
	type ArrowData, type Axes, type CanvasElement, type CanvasSpec, type CodeData, type Color, type Column, type End, type FrameData, type Link,
	type MatrixData, type Origin, type PathData, type Port, type SchemaNode, type Series, type Style,
} from './canvas';

export interface Parsed { spec: CanvasSpec; errors: string[]; notes: string[] }

const TYPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'frame', 'path', 'arrow', ...WIDGETS]);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number = LIMITS.text) => typeof v === 'string' ? v.slice(0, max) : undefined;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const size = (v: unknown) => { const n = num(v); return n === undefined ? undefined : Math.max(8, Math.min(4000, n)); };
const place = (v: unknown) => { const n = num(v); return n === undefined ? undefined : Math.max(-10000, Math.min(10000, n)); };
const pick = <T extends string>(set: Set<string> | readonly string[], v: unknown): T | undefined => typeof v === 'string' && (Array.isArray(set) ? set.includes(v) : (set as Set<string>).has(v)) ? v as T : undefined;
const NAMED = new Set(['accent', 'teal', 'amber', 'green', 'violet', 'red', 'ink', 'muted', 'card', 'canvas']);
const col = (v: unknown): Color | undefined => typeof v === 'string' && (NAMED.has(v) || /^#[0-9a-f]{3,8}$/i.test(v)) ? v as Color : undefined;
const ORIGINS = ['source', 'illustrative', 'runtime'] as const;
const origin = (v: unknown) => pick<Origin>(ORIGINS, v);
/** Path data an agent sends: commands and numbers only, so it cannot carry anything else into an SVG attribute. */
const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]{1,2000}$/;

function link(v: unknown): Link | undefined {
	if (!isObj(v)) return undefined;
	const l: Link = { symbol: str(v.symbol, 200), file: str(v.file, 400), line: num(v.line), board: str(v.board, 64) };
	return l.symbol || l.file || l.board ? l : undefined;
}

function port(v: unknown, i: number): Port | undefined {
	if (!isObj(v) || typeof v.name !== 'string') return undefined;
	return { id: str(v.id, 64) ?? `p${i}`, name: str(v.name, 80)!, type: str(v.type, 120), value: str(v.value, 200), origin: origin(v.origin), link: link(v.link) };
}

function end(v: unknown, shapes: Set<string>, arrows: Set<string>, ports: Map<string, Set<string>>, where: string, errors: string[]): End | undefined {
	const known = (id: string) => {
		if (shapes.has(id)) return true;
		errors.push(`${where}: \`${id}\` is ${arrows.has(id) ? 'an arrow, not a shape an arrow can join' : 'not an element id'}.`);
		return false;
	};
	if (typeof v === 'string') return known(v) ? v : undefined;
	if (!isObj(v)) return undefined;
	if (typeof v.el === 'string') {
		if (!known(v.el)) return undefined;
		const portId = str(v.port, 64);
		if (portId && !ports.get(v.el)?.has(portId)) {
			errors.push(`${where}: \`${v.el}\` has no port \`${portId}\`${ports.get(v.el)?.size ? ` (its ports: ${[...ports.get(v.el)!].join(', ')})` : ''}.`);
			return undefined;
		}
		return { el: v.el, side: pick(SIDES, v.side), port: portId };
	}
	const x = place(v.x), y = place(v.y);
	return x !== undefined && y !== undefined ? { x, y } : undefined;
}

// ---- widgets: each returns its element fields, or says why the element cannot be drawn ------------------------------------------

type Fields = Record<string, unknown>;
type Widget = (it: Record<string, unknown>, notes: string[], where: string) => Fields | string;

const table: Widget = (it, notes, where) => {
	const t = isObj(it.table) ? it.table : undefined;
	const rows = Array.isArray(t?.rows) ? t.rows.filter(isObj) : [];
	if (!rows.length) return 'a table needs `table.rows`: [{ "key": value, ... }].';
	let columns: Column[] = (Array.isArray(t?.columns) ? t.columns : []).filter(isObj).filter(c => typeof c.key === 'string').map(c => ({ key: str(c.key, 40)!, label: str(c.label, 40), align: pick<'left' | 'right'>(['left', 'right'], c.align), mono: c.mono === true || undefined, link: c.link === true || undefined }));
	if (!columns.length) columns = Object.keys(rows[0]).slice(0, LIMITS.tableCols).map(key => ({ key }));
	if (columns.length > LIMITS.tableCols) { notes.push(`${where}: only the first ${LIMITS.tableCols} columns are drawn.`); columns = columns.slice(0, LIMITS.tableCols); }
	if (rows.length > LIMITS.tableRows) notes.push(`${where}: ${rows.length} rows; only the first ${LIMITS.tableRows} are kept (\`maxRows\` says how many are drawn).`);
	return { table: { columns, rows: rows.slice(0, LIMITS.tableRows), maxRows: num(t?.maxRows) !== undefined ? Math.max(1, Math.min(LIMITS.tableRows, Math.floor(num(t!.maxRows)!))) : undefined } };
};

function schemaNode(v: unknown, depth: number, budget: { n: number }): SchemaNode | undefined {
	if (!isObj(v) || typeof v.name !== 'string' || typeof v.type !== 'string' || budget.n-- <= 0) return undefined;
	const children = depth < 6 && Array.isArray(v.children) ? v.children.map(c => schemaNode(c, depth + 1, budget)).filter((c): c is SchemaNode => !!c) : undefined;
	return { name: str(v.name, 80)!, type: str(v.type, 120)!, origin: origin(v.origin), link: link(v.link), children: children?.length ? children : undefined, unknown: v.unknown === true || undefined };
}

const json: Widget = (it, notes, where) => {
	const j = isObj(it.json) ? it.json : undefined;
	if (!j || (j.value === undefined && j.schema === undefined)) return 'a json element needs `json.value` (an instance), `json.schema` (a typed tree) or both.';
	let text = '';
	try { text = JSON.stringify(j.value ?? null) ?? ''; } catch { return '`json.value` is not JSON.'; }
	if (text.length > 200_000) return '`json.value` is larger than 200 KB; send the part that matters.';
	const budget = { n: LIMITS.jsonNodes };
	const schema = j.schema === undefined ? undefined : schemaNode(j.schema, 0, budget);
	if (j.schema !== undefined && !schema) return '`json.schema` must be { name, type, children? }.';
	if (budget.n <= 0) notes.push(`${where}: the schema has more than ${LIMITS.jsonNodes} nodes; the rest is dropped.`);
	return { json: { value: j.value, schema, open: num(j.open) !== undefined ? Math.max(0, Math.min(6, Math.floor(num(j.open)!))) : undefined, maxItems: num(j.maxItems) !== undefined ? Math.max(1, Math.min(40, Math.floor(num(j.maxItems)!))) : undefined } };
};

const axis = (v: unknown) => isObj(v) ? { label: str(v.label, 40), range: Array.isArray(v.range) && v.range.length === 2 && v.range.every(n => num(n) !== undefined) ? [v.range[0], v.range[1]] as [number, number] : undefined } : undefined;

const chart: Widget = (it, notes, where) => {
	const c = isObj(it.chart) ? it.chart : undefined;
	const kind = pick<'bar' | 'line' | 'scatter' | 'points2d'>(['bar', 'line', 'scatter', 'points2d'], c?.kind);
	if (!c || !kind) return 'a chart needs `chart.kind` (bar, line, scatter or points2d) and `chart.series`.';
	const raw = (Array.isArray(c.series) ? c.series : []).filter(isObj).slice(0, LIMITS.series);
	if (!raw.length) return 'a chart needs `chart.series`: [{ "label": "loss", "points": [3, 2, 1] }].';
	const series: Series[] = [];
	for (const s of raw) {
		const pts = Array.isArray(s.points) ? s.points : [];
		const pairs = pts.length > 0 && pts.every(p => Array.isArray(p) && p.length === 2 && p.every(n => num(n) !== undefined));
		const flat = pts.length > 0 && pts.every(p => num(p) !== undefined);
		if (!pairs && !flat) return `series \`${str(s.label, 40) ?? '?'}\` needs \`points\`: numbers ([1, 2, 3]) or pairs ([[0, 1], [1, 2]]).`;
		if (pts.length > LIMITS.points) notes.push(`${where}: a series has more than ${LIMITS.points} points; the rest are dropped.`);
		series.push({ label: str(s.label, 40) ?? `series ${series.length + 1}`, points: pts.slice(0, LIMITS.points) as Series['points'], labels: Array.isArray(s.labels) ? s.labels.map(l => str(l, 40) ?? '').slice(0, LIMITS.points) : undefined, color: col(s.color) });
	}
	if ((kind === 'bar' || kind === 'line') && new Set(series.map(s => s.points.length)).size > 1) return `the series have different lengths (${series.map(s => s.points.length).join(', ')}): a ${kind} chart needs the same number of points in each.`;
	const axes: Axes | undefined = isObj(c.axes) ? { x: axis(c.axes.x), y: axis(c.axes.y) } : undefined;
	return { chart: { kind, series, axes } };
};

const matrix: Widget = (it, notes, where) => {
	const m = isObj(it.matrix) ? it.matrix : undefined;
	const rows = Array.isArray(m?.cells) ? m.cells : [];
	if (!rows.length || !rows.every(r => Array.isArray(r) && r.length > 0 && r.every(n => num(n) !== undefined))) return 'a matrix needs `matrix.cells`: rows of numbers, [[1, 0], [0, 1]].';
	if (new Set(rows.map(r => (r as unknown[]).length)).size > 1) return `the matrix rows have different lengths (${rows.map(r => (r as unknown[]).length).join(', ')}): every row needs the same number of cells.`;
	let cells = rows as number[][];
	if (cells.length > LIMITS.matrix || cells[0].length > LIMITS.matrix) {
		notes.push(`${where}: ${cells.length} × ${cells[0].length} cells; only the first ${LIMITS.matrix} × ${LIMITS.matrix} are drawn. Say the real shape in \`dims\`.`);
		cells = cells.slice(0, LIMITS.matrix).map(r => r.slice(0, LIMITS.matrix));
	}
	const labels = (v: unknown, n: number, what: string) => {
		if (!Array.isArray(v)) return undefined;
		if (v.length !== n) notes.push(`${where}: ${v.length} ${what} for ${n} ${what === 'rowLabels' ? 'rows' : 'columns'}.`);
		return v.slice(0, n).map(l => str(l, 40) ?? '');
	};
	const range = Array.isArray(m!.range) && m!.range.length === 2 && m!.range.every(n => num(n) !== undefined) ? [m!.range[0], m!.range[1]] as [number, number] : undefined;
	const data: MatrixData = { cells, rowLabels: labels(m!.rowLabels, cells.length, 'rowLabels'), colLabels: labels(m!.colLabels, cells[0].length, 'colLabels'), dims: str(m!.dims, 40), scale: pick<'diverging' | 'sequential'>(['diverging', 'sequential'], m!.scale), range, showValues: typeof m!.showValues === 'boolean' ? m!.showValues : undefined };
	return { matrix: data };
};

const code: Widget = (it, notes, where) => {
	const c = isObj(it.code) ? it.code : undefined;
	const text = str(c?.text, 6000);
	const file = str(c?.file, 400);
	if (!c || (!text && !file)) return 'a code element needs `code.text`, or `code.file` with `code.lines` (the host reads the lines).';
	const lines = Array.isArray(c.lines) && c.lines.length === 2 && c.lines.every(n => num(n) !== undefined) ? [Math.max(1, Math.floor(c.lines[0] as number)), Math.max(1, Math.floor(c.lines[1] as number))] as [number, number] : undefined;
	if (lines && lines[1] < lines[0]) return '`code.lines` is [first, last] with last >= first.';
	const count = text ? text.replace(/\n$/, '').split('\n').length : lines ? lines[1] - lines[0] + 1 : 0;
	if (count > LIMITS.codeLines) notes.push(`${where}: ${count} lines of code; only the first ${LIMITS.codeLines} are drawn. Show the part that matters.`);
	const highlight = Array.isArray(c.highlight) ? c.highlight.filter(n => num(n) !== undefined).map(n => Math.floor(n as number)).slice(0, 12) : undefined;
	const data: CodeData = { file, lines, text, language: str(c.language, 20), highlight: highlight?.length ? highlight : undefined };
	return { code: data };
};

const path: Widget = (it, _notes, _where) => {
	const p = isObj(it.path) ? it.path : undefined;
	const points = Array.isArray(p?.points) && p.points.length >= 2 && p.points.every(q => Array.isArray(q) && q.length === 2 && q.every(n => num(n) !== undefined)) ? (p.points as [number, number][]).slice(0, LIMITS.points).map(([x, y]): [number, number] => [Math.max(0, Math.min(4000, x)), Math.max(0, Math.min(4000, y))]) : undefined;
	const d = typeof p?.d === 'string' && PATH_D.test(p.d) ? p.d : undefined;
	if (!points && !d) return 'a path needs `path.points` (at least two [x, y] pairs) or `path.d` (SVG path data).';
	const data: PathData = { points, d: points ? undefined : d, closed: p!.closed === true || undefined, smooth: p!.smooth === true || undefined };
	return { path: data };
};

const WIDGET_PARSERS: Record<string, Widget> = { table, json, chart, matrix, code, path };

export function parseCanvas(raw: unknown): Parsed {
	const errors: string[] = [], notes: string[] = [];
	if (!isObj(raw)) throw new Error('A canvas board must be an object: { kind: "canvas", title, elements }.');
	const title = str(raw.title, 120) ?? 'Board';
	const list = Array.isArray(raw.elements) ? raw.elements : [];
	if (!list.length) throw new Error('A canvas board needs a non-empty "elements" array: [{ id, type, label?, frame?, ... }].');
	if (list.length > LIMITS.elements) notes.push(`${list.length - LIMITS.elements} element(s) beyond the first ${LIMITS.elements} were dropped.`);
	const items = list.slice(0, LIMITS.elements).filter(isObj);
	const ids = new Set<string>();
	for (const it of items) if (typeof it.id === 'string' && it.id) ids.add(it.id);
	const frames = new Set(items.filter(it => it.type === 'frame' && typeof it.id === 'string').map(it => it.id as string));
	const arrowIds = new Set(items.filter(it => it.type === 'arrow' && typeof it.id === 'string').map(it => it.id as string));
	const shapes = new Set([...ids].filter(id => !arrowIds.has(id)));
	// The ports of every rect, for an arrow that names one.
	const ports = new Map<string, Set<string>>();
	for (const it of items) if (it.type === 'rect' && typeof it.id === 'string') ports.set(it.id, new Set([...(Array.isArray(it.inputs) ? it.inputs : []).slice(0, LIMITS.ports).map(port).filter((p): p is Port => !!p).map(p => p.id), ...(isObj(it.output) ? [port(it.output, 0)?.id].filter((x): x is string => !!x) : [])]));
	let frameCount = 0;

	const elements: CanvasElement[] = [];
	const seen = new Set<string>();
	for (const [i, it] of items.entries()) {
		const id = str(it.id, 64);
		const where = `element ${id ? `\`${id}\`` : `#${i + 1}`}`;
		if (!id) { errors.push(`${where}: missing id.`); continue; }
		if (seen.has(id)) { errors.push(`${where}: duplicate id; the first one is kept.`); continue; }
		// Ids key objects (moves, notes) on the host: these three would reach the prototype.
		if (id === '__proto__' || id === 'constructor' || id === 'prototype') { errors.push(`${where}: \`${id}\` is not allowed as an id.`); continue; }
		let type = pick<CanvasElement['type']>(TYPES, it.type);
		if (!type) { errors.push(`${where}: unknown type \`${String(it.type).slice(0, 20)}\`; one of ${[...TYPES].join(', ')}.`); continue; }
		if (type === 'frame' && ++frameCount > LIMITS.frames) {
			if (frameCount === LIMITS.frames + 1) notes.push(`more than ${LIMITS.frames} frames; the rest are drawn as rects.`);
			type = 'rect';
		}
		const frame = str(it.frame, 64);
		if (frame && !frames.has(frame)) notes.push(`${where}: frame \`${frame}\` is not a frame; placed at the root.`);
		if (frame === id) { errors.push(`${where}: an element cannot be its own frame.`); continue; }
		const style: Style | undefined = isObj(it.style) ? {
			fill: col(it.style.fill), stroke: col(it.style.stroke), text: col(it.style.text),
			line: pick(['solid', 'dashed', 'dotted'], it.style.line), weight: pick(['normal', 'bold'], it.style.weight), size: pick(['s', 'm', 'l'], it.style.size),
			opacity: num(it.style.opacity) !== undefined ? Math.max(0, Math.min(1, num(it.style.opacity)!)) : undefined,
		} : undefined;
		const common = {
			id, frame: frame && frames.has(frame) ? frame : undefined,
			x: place(it.x), y: place(it.y), w: size(it.w), h: size(it.h),
			label: str(it.label, 400), detail: str(it.detail, 400), style,
			link: link(it.link),
			origin: origin(it.origin), source: str(it.source, 200), note: str(it.note), span: num(it.span) !== undefined ? Math.max(1, Math.min(12, Math.floor(num(it.span)!))) : undefined,
		};
		switch (type) {
			case 'rect': {
				const inputs = Array.isArray(it.inputs) ? it.inputs.slice(0, LIMITS.ports).map(port).filter((p): p is Port => !!p) : undefined;
				const members = Array.isArray(it.members) ? it.members.slice(0, LIMITS.members).map(m => typeof m === 'string' ? { text: m } : isObj(m) && typeof m.text === 'string' ? { text: m.text, kind: pick<'field' | 'method' | 'property'>(['field', 'method', 'property'], m.kind) } : undefined).filter((m): m is { text: string; kind?: 'field' | 'method' | 'property' } => !!m).map(m => ({ ...m, text: m.text.slice(0, 120) })) : undefined;
				const portIds = [...(inputs ?? []).map(p => p.id), ...(isObj(it.output) ? [port(it.output, 0)?.id] : [])];
				if (new Set(portIds).size < portIds.length) errors.push(`${where}: two ports share an id; an arrow cannot tell them apart.`);
				if (Array.isArray(it.inputs) && it.inputs.length > LIMITS.ports) notes.push(`${where}: only the first ${LIMITS.ports} ports are drawn.`);
				elements.push({ ...common, type: 'rect', kind: str(it.kind, 24), icon: str(it.icon, 40), inputs: inputs?.length ? inputs : undefined, output: port(it.output, 0), members: members?.length ? members : undefined });
				break;
			}
			case 'frame': {
				const d = isObj(it.frameData) ? it.frameData : isObj(it.layoutData) ? it.layoutData : {};
				const frameData: FrameData = { layout: pick(['row', 'column', 'grid'], d.layout), columns: num(d.columns) !== undefined ? Math.max(1, Math.min(12, Math.floor(num(d.columns)!))) : undefined, gap: num(d.gap), pad: num(d.pad), align: pick(['start', 'center', 'stretch'], d.align), collapsed: d.collapsed === true };
				elements.push({ ...common, type, frameData });
				break;
			}
			case 'arrow': {
				const a = isObj(it.arrow) ? it.arrow : it;
				const from = end(a.from, shapes, arrowIds, ports, where, errors), to = end(a.to, shapes, arrowIds, ports, where, errors);
				if (!from || !to) { if (a.from === undefined || a.to === undefined) errors.push(`${where}: an arrow needs \`from\` and \`to\`.`); continue; }
				const same = (x: End) => typeof x === 'string' ? x : 'el' in x ? x.el : undefined;
				if (same(from) !== undefined && same(from) === same(to)) { errors.push(`${where}: an arrow cannot join \`${same(from)}\` to itself.`); continue; }
				const arrow: ArrowData = { from, to, route: pick(['straight', 'elbow', 'curve'], a.route), head: pick(['arrow', 'open', 'none', 'both'], a.head), at: num(a.at) !== undefined ? Math.max(0, Math.min(1, num(a.at)!)) : undefined, data: isObj(a.data) ? { type: str(a.data.type, 80), shape: str(a.data.shape, 80) } : undefined };
				elements.push({ ...common, type, arrow });
				break;
			}
			case 'table': case 'json': case 'chart': case 'matrix': case 'code': case 'path': {
				const made = WIDGET_PARSERS[type](it, notes, where);
				if (typeof made === 'string') { errors.push(`${where}: ${made}`); continue; }
				elements.push({ ...common, type, ...made } as CanvasElement);
				break;
			}
			default:
				elements.push({ ...common, type } as CanvasElement);
		}
		seen.add(id);
	}
	// A frame cycle (a in b, b in a) would never finish laying out: break it at the root.
	const parent = new Map(elements.map(e => [e.id, e.frame]));
	for (const e of elements) {
		const trail = new Set<string>();
		for (let f = e.frame; f; f = parent.get(f)) {
			if (trail.has(f) || f === e.id) { errors.push(`frame \`${f}\` contains itself through \`${e.id}\`; \`${e.id}\` is placed at the root.`); e.frame = undefined; break; }
			trail.add(f);
		}
	}
	// An arrow whose end was dropped (its element failed to parse) would be drawn to nowhere.
	const kept = new Set(elements.map(e => e.id));
	for (let n = elements.length - 1; n >= 0; n--) {
		const e = elements[n];
		if (e.type !== 'arrow') continue;
		const gone = [e.arrow.from, e.arrow.to].map(x => typeof x === 'string' ? x : 'el' in x ? x.el : undefined).find(id => id !== undefined && !kept.has(id));
		if (gone) { errors.push(`arrow \`${e.id}\` was dropped: \`${gone}\` is not drawn.`); elements.splice(n, 1); }
	}
	const spec: CanvasSpec = { title, purpose: pick(['concept', 'code'], raw.purpose), layout: pick(['row', 'column', 'grid'], raw.layout), columns: num(raw.columns) !== undefined ? Math.max(1, Math.min(12, Math.floor(num(raw.columns)!))) : undefined, elements };
	return { spec, errors, notes };
}
