// A JSON tree: a value, a typed schema (names and types without values) or both (values under their types). Objects and
// arrays open down to `open` levels (default 2); a long one lists `maxItems` entries (default 8) and "+n more". At most
// LIMITS.jsonNodes lines are ever built, so a huge value costs nothing.

import { LIMITS, type CanvasElement, type JsonData, type Origin, type SchemaNode } from '../canvas';
import { charWidth } from '../measure';
import { clip, show, type Widget } from '../primitives';
import { BODY_PX, ORIGIN_TAG, PAD, shell, titleHeight } from './shell';

type El = Extract<CanvasElement, { type: 'json' }>;

type Tone = 'str' | 'num' | 'bool' | 'null' | 'muted';
export interface JsonLine { depth: number; key?: string; type?: string; value?: string; tone?: Tone; origin?: Origin; unknown?: boolean }

const ROW = 17;
const INDENT = 14;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toneOf = (v: unknown): Tone => typeof v === 'string' ? 'str' : typeof v === 'number' ? 'num' : typeof v === 'boolean' ? 'bool' : v === null ? 'null' : 'muted';

const literal = (v: unknown, max: number) => typeof v === 'string' ? JSON.stringify(clip(v, max)) : show(v, max) || 'null';

/** The lines of a JsonData: what is drawn, in order. Exported for the tests. */
export function jsonLines(d: JsonData): JsonLine[] {
	const open = d.open ?? 2;
	const items = Math.max(1, Math.min(40, d.maxItems ?? 8));
	const out: JsonLine[] = [];
	let budget = LIMITS.jsonNodes;
	const room = () => {
		if (budget-- > 0) return true;
		if (budget === -1) out.push({ depth: 0, value: `… (cut at ${LIMITS.jsonNodes} nodes)`, tone: 'muted' });
		return false;
	};
	const value = (key: string | undefined, v: unknown, depth: number) => {
		if (!room()) return;
		if (Array.isArray(v)) {
			out.push({ depth, key, value: `[${v.length}]`, tone: 'muted' });
			if (depth >= open) return;
			v.slice(0, items).forEach((x, i) => value(String(i), x, depth + 1));
			if (v.length > items) out.push({ depth: depth + 1, value: `… +${v.length - items} more`, tone: 'muted' });
		} else if (isObj(v)) {
			const keys = Object.keys(v);
			out.push({ depth, key, value: `{${keys.length}}`, tone: 'muted' });
			if (depth >= open) return;
			keys.slice(0, items).forEach(k => value(k, v[k], depth + 1));
			if (keys.length > items) out.push({ depth: depth + 1, value: `… +${keys.length - items} more`, tone: 'muted' });
		} else {
			out.push({ depth, key, value: literal(v, 40), tone: toneOf(v) });
		}
	};
	const schema = (n: SchemaNode, v: unknown, has: boolean, depth: number) => {
		if (!room()) return;
		const kids = n.children ?? [];
		const line: JsonLine = { depth, key: n.name, type: n.type, origin: n.origin, unknown: n.unknown };
		if (!kids.length) {
			if (n.unknown) line.value = '?';
			else if (has) { line.value = isObj(v) || Array.isArray(v) ? show(v, 30) : literal(v, 30); line.tone = toneOf(v); }
		}
		out.push(line);
		if (depth >= open) return;
		kids.slice(0, items).forEach(c => schema(c, isObj(v) ? v[c.name] : undefined, isObj(v) && c.name in v, depth + 1));
		if (kids.length > items) out.push({ depth: depth + 1, value: `… +${kids.length - items} more`, tone: 'muted' });
	};
	if (d.schema) schema(d.schema, d.value, d.value !== undefined, 0);
	else value(undefined, d.value ?? null, 0);
	return out;
}

const charsOf = (l: JsonLine) => (l.key ? l.key.length : 0) + (l.type ? l.type.length + 2 : 0) + (l.value ? l.value.length + (l.key ? 2 : 0) : 0) + (l.origin ? ORIGIN_TAG[l.origin].length + 2 : 0);

export const json: Widget<El> = {
	size(el) {
		const lines = jsonLines(el.json);
		const cw = charWidth('x', BODY_PX, true);
		const w = Math.max(...lines.map(l => (l.depth * INDENT / cw + charsOf(l)) * cw), 80) + 2 * PAD;
		return { w: Math.min(440, Math.ceil(w)), h: titleHeight(el.label) + lines.length * ROW + 10 };
	},
	paint(el, box, p) {
		const { prims, top } = shell(el.label, box, p);
		const cw = charWidth('x', BODY_PX, true);
		const tone: Record<Tone, string> = { str: p.green, num: p.amber, bool: p.violet, null: p.muted, muted: p.muted };
		const max = Math.max(8, Math.floor((box.w - 2 * PAD) / cw));
		jsonLines(el.json).forEach((l, i) => {
			let x = box.x + PAD + l.depth * INDENT;
			const y = top + 5 + i * ROW + 11;
			const put = (text: string, fill: string) => {
				const room = Math.max(0, max - Math.round((x - box.x - PAD) / cw));
				if (!text || !room) return;
				const t = clip(text, room);
				prims.push({ kind: 'text', x, y, text: t, size: BODY_PX, fill, mono: true });
				x += t.length * cw;
			};
			if (l.key !== undefined) put(l.key, p.ink);
			if (l.type) { put(l.key !== undefined ? ': ' : '', p.muted); put(l.type, p.accent); }
			if (l.value) { put(l.key !== undefined ? (l.type ? ' = ' : ': ') : '', p.muted); put(l.value, l.unknown ? p.amber : tone[l.tone ?? 'muted']); }
			if (l.origin) put(`  ${ORIGIN_TAG[l.origin]}`, p.muted);
		});
		return prims;
	},
};
