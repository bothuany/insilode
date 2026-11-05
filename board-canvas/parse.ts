// Turns what an agent sent for a canvas board into a CanvasSpec, dropping what cannot be drawn and saying why. The
// host calls it; the webview receives the result. Every check is structural: ids, frames, ends, limits, strings.

import { LIMITS, type ArrowData, type CanvasElement, type CanvasSpec, type Color, type End, type FrameData, type Port, type Style } from './canvas';

export interface Parsed { spec: CanvasSpec; errors: string[]; notes: string[] }

const TYPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'frame', 'arrow']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number = LIMITS.text) => typeof v === 'string' ? v.slice(0, max) : undefined;
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const pick = <T extends string>(set: Set<string> | readonly string[], v: unknown): T | undefined => typeof v === 'string' && (Array.isArray(set) ? set.includes(v) : (set as Set<string>).has(v)) ? v as T : undefined;
const NAMED = new Set(['accent', 'teal', 'amber', 'green', 'violet', 'red', 'ink', 'muted', 'card', 'canvas']);
const col = (v: unknown): Color | undefined => typeof v === 'string' && (NAMED.has(v) || /^#[0-9a-f]{3,8}$/i.test(v)) ? v as Color : undefined;

function port(v: unknown, i: number): Port | undefined {
	if (!isObj(v) || typeof v.name !== 'string') return undefined;
	return { id: str(v.id, 64) ?? `p${i}`, name: str(v.name, 80)!, type: str(v.type, 120), value: str(v.value, 200), origin: pick(['source', 'illustrative', 'runtime'], v.origin), link: isObj(v.link) ? { symbol: str(v.link.symbol, 200), file: str(v.link.file, 400), line: num(v.link.line), board: str(v.link.board, 64) } : undefined };
}

function end(v: unknown, known: Set<string>, where: string, errors: string[]): End | undefined {
	if (typeof v === 'string') {
		if (known.has(v)) return v;
		errors.push(`${where}: \`${v}\` is not an element id.`);
		return undefined;
	}
	if (!isObj(v)) return undefined;
	if (typeof v.el === 'string') {
		if (!known.has(v.el)) { errors.push(`${where}: \`${v.el}\` is not an element id.`); return undefined; }
		return { el: v.el, side: pick(SIDES, v.side), port: str(v.port, 64) };
	}
	const x = num(v.x), y = num(v.y);
	return x !== undefined && y !== undefined ? { x, y } : undefined;
}

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
	if (frames.size > LIMITS.frames) notes.push(`more than ${LIMITS.frames} frames; the rest are drawn as rects.`);

	const elements: CanvasElement[] = [];
	const seen = new Set<string>();
	for (const [i, it] of items.entries()) {
		const id = str(it.id, 64);
		const where = `element ${id ? `\`${id}\`` : `#${i + 1}`}`;
		if (!id) { errors.push(`${where}: missing id.`); continue; }
		if (seen.has(id)) { errors.push(`${where}: duplicate id; the first one is kept.`); continue; }
		const type = pick<CanvasElement['type']>(TYPES, it.type);
		if (!type) { errors.push(`${where}: unknown type \`${String(it.type).slice(0, 20)}\`; one of ${[...TYPES].join(', ')}.`); continue; }
		const frame = str(it.frame, 64);
		if (frame && !frames.has(frame)) notes.push(`${where}: frame \`${frame}\` is not a frame; placed at the root.`);
		if (frame === id) { errors.push(`${where}: an element cannot be its own frame.`); continue; }
		const style: Style | undefined = isObj(it.style) ? {
			fill: col(it.style.fill), stroke: col(it.style.stroke), text: col(it.style.text),
			line: pick(['solid', 'dashed', 'dotted'], it.style.line), weight: pick(['normal', 'bold'], it.style.weight), size: pick(['s', 'm', 'l'], it.style.size),
			opacity: num(it.style.opacity),
		} : undefined;
		const common = {
			id, frame: frame && frames.has(frame) ? frame : undefined,
			x: num(it.x), y: num(it.y), w: num(it.w), h: num(it.h),
			label: str(it.label, 400), detail: str(it.detail, 400), style,
			link: isObj(it.link) ? { symbol: str(it.link.symbol, 200), file: str(it.link.file, 400), line: num(it.link.line), board: str(it.link.board, 64) } : undefined,
			origin: pick<'source' | 'illustrative' | 'runtime'>(['source', 'illustrative', 'runtime'], it.origin), source: str(it.source, 200), note: str(it.note), span: num(it.span),
		};
		switch (type) {
			case 'rect': {
				const inputs = Array.isArray(it.inputs) ? it.inputs.slice(0, LIMITS.ports).map(port).filter((p): p is Port => !!p) : undefined;
				elements.push({ ...common, type, kind: str(it.kind, 24), icon: str(it.icon, 40), inputs: inputs?.length ? inputs : undefined, output: port(it.output, 0) });
				break;
			}
			case 'frame': {
				const d = isObj(it.frameData) ? it.frameData : isObj(it.layoutData) ? it.layoutData : {};
				const frameData: FrameData = { layout: pick(['row', 'column', 'grid'], d.layout), columns: num(d.columns), gap: num(d.gap), pad: num(d.pad), align: pick(['start', 'center', 'stretch'], d.align), collapsed: d.collapsed === true };
				elements.push({ ...common, type, frameData });
				break;
			}
			case 'arrow': {
				const a = isObj(it.arrow) ? it.arrow : it;
				const from = end(a.from, ids, where, errors), to = end(a.to, ids, where, errors);
				if (!from || !to) { if (!isObj(a.from) && typeof a.from !== 'string') errors.push(`${where}: an arrow needs \`from\` and \`to\`.`); continue; }
				const arrow: ArrowData = { from, to, route: pick(['straight', 'elbow', 'curve'], a.route), head: pick(['arrow', 'open', 'none', 'both'], a.head), at: num(a.at), data: isObj(a.data) ? { type: str(a.data.type, 80), shape: str(a.data.shape, 80) } : undefined };
				elements.push({ ...common, type, arrow });
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
	const spec: CanvasSpec = { title, purpose: pick(['concept', 'code'], raw.purpose), layout: pick(['row', 'column', 'grid'], raw.layout), columns: num(raw.columns), elements };
	return { spec, errors, notes };
}
