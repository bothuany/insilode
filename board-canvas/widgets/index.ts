// The widgets by element type. Layout asks one for its `size`, paint for its primitives; adding a widget is a file in this
// folder, a line here and its type in canvas.ts.

import type { CanvasElement, WidgetType } from '../canvas';
import type { Box, Palette, Primitive } from '../primitives';
import { chart } from './chart';
import { code } from './code';
import { json } from './json';
import { matrix } from './matrix';
import { table } from './table';

interface Any { size(el: never): { w: number; h: number }; paint(el: never, box: Box, p: Palette): Primitive[] }

const WIDGET: Record<WidgetType, Any> = { table, json, chart, matrix, code };

export const isWidget = (el: CanvasElement): el is Extract<CanvasElement, { type: WidgetType }> => el.type in WIDGET;

export function widgetSize(el: CanvasElement): { w: number; h: number } | undefined {
	return isWidget(el) ? (WIDGET[el.type] as { size(e: CanvasElement): { w: number; h: number } }).size(el) : undefined;
}

export function paintWidget(el: CanvasElement, box: Box, p: Palette): Primitive[] {
	return isWidget(el) ? (WIDGET[el.type] as { paint(e: CanvasElement, b: Box, p: Palette): Primitive[] }).paint(el, box, p) : [];
}
