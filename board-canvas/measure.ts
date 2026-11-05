// Text measurement by a glyph width table, the same in the host and in the webview, so a layout is deterministic and
// golden-testable (today's board estimates with an average width too). The table is for a 12px humanist sans
// (Segoe UI / system-ui); other sizes scale linearly. Unknown glyphs (CJK, emoji) count as a wide square.

export type TextSize = 's' | 'm' | 'l' | 'title';

export const FONT_PX: Record<TextSize, number> = { s: 11, m: 12.5, l: 15, title: 14 };
export const LINE_H: Record<TextSize, number> = { s: 15, m: 17, l: 21, title: 19 };

// Widths at 12px, per character class. Narrow: i j l ' | ! . , : ; Wide: m w M W @ and capitals in general.
const NARROW = new Set("ijlt'|!.,:;If1()[]{}");
const WIDE = new Set('mwMWW@%&');
const CAPS = /[A-Z]/;
const MONO_PX = 0.6; // JetBrains Mono / Consolas at 1em

export function charWidth(ch: string, px: number, mono: boolean): number {
	if (mono) return px * MONO_PX;
	const code = ch.codePointAt(0) ?? 0;
	if (ch === ' ') return px * 0.28;
	if (NARROW.has(ch)) return px * 0.3;
	if (WIDE.has(ch)) return px * 0.9;
	if (CAPS.test(ch)) return px * 0.68;
	if (code > 0x2e7f) return px * 1.0; // CJK and wider scripts
	if (code > 0x24f) return px * 0.62; // other scripts: like Latin lower case
	return px * 0.56;
}

export function textWidth(text: string, px: number, mono = false): number {
	let w = 0;
	for (const ch of text) w += charWidth(ch, px, mono);
	return Math.ceil(w);
}

/** Wraps at `maxWidth` on spaces; a single word longer than the width is kept whole. */
export function wrap(text: string, px: number, maxWidth: number, mono = false): string[] {
	const lines: string[] = [];
	for (const para of text.split('\n')) {
		let line = '';
		for (const word of para.split(' ')) {
			const next = line ? `${line} ${word}` : word;
			if (line && textWidth(next, px, mono) > maxWidth) {
				lines.push(line);
				line = word;
			} else {
				line = next;
			}
		}
		lines.push(line);
	}
	return lines;
}
