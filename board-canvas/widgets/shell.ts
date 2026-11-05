// What every widget shares: the card it sits in, with an optional title, and the numbers its rows are measured by.

import { DIM, type Origin } from '../canvas';
import { FONT_PX } from '../measure';
import type { Box, Palette, Primitive } from '../primitives';

export const TITLE_H = 24;
export const PAD = 10;
export const BODY_PX = FONT_PX.s;

/** The card and its title; `top` is where the body starts. */
export function shell(label: string | undefined, box: Box, p: Palette): { prims: Primitive[]; top: number } {
	const prims: Primitive[] = [{ kind: 'rect', x: box.x, y: box.y, w: box.w, h: box.h, rx: DIM.radius, fill: p.card, stroke: p.line }];
	if (label) prims.push({ kind: 'text', x: box.x + PAD, y: box.y + 16, text: label, size: FONT_PX.s + 1, fill: p.ink, weight: 600 });
	return { prims, top: box.y + (label ? TITLE_H : 6) };
}

export const titleHeight = (label: string | undefined) => label ? TITLE_H : 6;

/** The short tag a value carries when its origin is said: where it came from, in two or three letters. */
export const ORIGIN_TAG: Record<Origin, string> = { source: 'src', illustrative: 'ill', runtime: 'live' };
