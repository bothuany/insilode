// A code excerpt, coloured by a small tokenizer (keyword, string, comment, number) for C-like languages, Python and SQL,
// not by Monaco: the webview bundle stays small and the host paints the same colours into the picture the agent gets.
// At most LIMITS.codeLines lines are shown; `highlight` marks lines (numbered from `lines[0]` when given, else from 1).

import { LIMITS, type CanvasElement } from '../canvas';
import { charWidth } from '../measure';
import { clip, type Palette, type Primitive, type Widget } from '../primitives';
import { BODY_PX, PAD, shell, titleHeight } from './shell';

type El = Extract<CanvasElement, { type: 'code' }>;
type Lang = 'c' | 'py' | 'sql';
export type TokenKind = 'kw' | 'str' | 'com' | 'num' | 'plain';
export interface Token { text: string; kind: TokenKind }

const words = (s: string) => new Set(s.split(' '));
const KEYWORDS: Record<Lang, Set<string>> = {
	c: words('if else for foreach while do switch case break continue return function const let var new class interface extends implements public private protected static async await try catch finally throw throws import export from default void int long string bool boolean true false null undefined this using namespace enum struct type fn func go defer yield in of is as override abstract readonly record package'),
	py: words('def class return if elif else for while in not and or is import from as with try except finally raise lambda None True False yield async await pass break continue self global'),
	sql: words('select from where join left right inner outer on group by order having insert into values update set delete create table index primary key foreign references not null and or as limit offset union distinct count sum avg case when then else end like in is between'),
};

export const languageOf = (name?: string): Lang => /^(py|python)$/i.test(name ?? '') ? 'py' : /^sql$/i.test(name ?? '') ? 'sql' : 'c';

/** One line into tokens; `block` carries an open block comment from one line to the next. */
export function tokenize(line: string, lang: Lang, block: { open: boolean } = { open: false }): Token[] {
	const out: Token[] = [];
	const push = (text: string, kind: TokenKind) => {
		const last = out[out.length - 1];
		if (last && last.kind === kind && kind === 'plain') last.text += text; else out.push({ text, kind });
	};
	let i = 0;
	while (i < line.length) {
		if (block.open) {
			const end = line.indexOf('*/', i);
			push(end < 0 ? line.slice(i) : line.slice(i, end + 2), 'com');
			i = end < 0 ? line.length : end + 2;
			if (end >= 0) block.open = false;
			continue;
		}
		const c = line[i];
		if (lang === 'c' && line.startsWith('/*', i)) { block.open = true; push('/*', 'com'); i += 2; continue; }
		if ((lang === 'c' && line.startsWith('//', i)) || (lang === 'py' && c === '#') || (lang === 'sql' && line.startsWith('--', i))) { push(line.slice(i), 'com'); break; }
		if (c === '"' || c === '\'' || c === '`') {
			let j = i + 1;
			while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
			push(line.slice(i, Math.min(line.length, j + 1)), 'str');
			i = j + 1;
			continue;
		}
		const num = /^\d[\d_.]*(?:[eE][+-]?\d+)?[a-zA-Z]*/.exec(line.slice(i));
		if (num && !/[A-Za-z_]/.test(line[i - 1] ?? '')) { push(num[0], 'num'); i += num[0].length; continue; }
		const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
		if (word) {
			push(word[0], KEYWORDS[lang].has(lang === 'sql' ? word[0].toLowerCase() : word[0]) ? 'kw' : 'plain');
			i += word[0].length;
			continue;
		}
		push(c, 'plain');
		i++;
	}
	return out;
}

const ROW = 16;
const MAX_CHARS = 72;

/** The lines shown: tabs as two spaces, cut at 12 lines and 72 characters. */
export function codeLines(el: El): string[] {
	return (el.code.text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').slice(0, LIMITS.codeLines).map(l => clip(l.replace(/\t/g, '  '), MAX_CHARS));
}

const start = (el: El) => el.code.lines?.[0] ?? 1;
const gutter = (el: El) => el.code.lines ? String(start(el) + LIMITS.codeLines).length * charWidth('x', BODY_PX, true) + 10 : 0;
const heading = (el: El) => el.label ?? (el.code.file ? `${el.code.file.split('/').pop()}${el.code.lines ? `:${el.code.lines[0]}-${el.code.lines[1]}` : ''}` : undefined);

export const code: Widget<El> = {
	size(el) {
		const lines = codeLines(el);
		const cw = charWidth('x', BODY_PX, true);
		const w = Math.max(...lines.map(l => l.length), 20) * cw + gutter(el) + 2 * PAD;
		return { w: Math.ceil(Math.min(600, w)), h: titleHeight(heading(el)) + Math.max(1, lines.length) * ROW + 12 };
	},
	paint(el, box, p: Palette) {
		const { prims, top } = shell(heading(el), box, p);
		const cw = charWidth('x', BODY_PX, true);
		const tone: Record<TokenKind, string> = { kw: p.violet, str: p.green, com: p.muted, num: p.amber, plain: p.ink };
		const lang = languageOf(el.code.language);
		const block = { open: false };
		const lines = codeLines(el);
		const hl = new Set(el.code.highlight ?? []);
		const x0 = box.x + PAD + gutter(el);
		const out: Primitive[] = [];
		if (!el.code.text) out.push({ kind: 'text', x: box.x + PAD, y: top + 14, text: el.code.file ? `${el.code.file} (not read)` : 'no code', size: BODY_PX, fill: p.muted, mono: true });
		lines.forEach((line, i) => {
			const y = top + 4 + i * ROW;
			if (hl.has(start(el) + i)) out.push({ kind: 'rect', x: box.x + 2, y: y - 1, w: box.w - 4, h: ROW, rx: 3, fill: p.amber, opacity: 0.16 });
			if (el.code.lines) out.push({ kind: 'text', x: x0 - 8, y: y + 11, text: String(start(el) + i), size: BODY_PX - 1, fill: p.muted, mono: true, anchor: 'end' });
			let x = x0;
			for (const t of tokenize(line, lang, block)) {
				if (t.text.trim()) out.push({ kind: 'text', x: x + (t.text.length - t.text.trimStart().length) * cw, y: y + 11, text: t.text.trim(), size: BODY_PX, fill: tone[t.kind], mono: true });
				x += t.text.length * cw;
			}
		});
		return [...prims, ...out];
	},
};
