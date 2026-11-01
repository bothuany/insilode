/*---------------------------------------------------------------------------------------------
 *  Insilode: the pen marks of a tour step as the `tour` tool sends them (`steps[].marks`, in source terms) turned into the
 *  TourMark list the canvas draws (protocol/flow.ts). Lines are resolved like a step's `highlights` (current-file, the same
 *  drift handling) and `to` like a step's `at`. A mark that cannot be placed is dropped and said so in `notes`, which the
 *  tool answer shows next to the step's ok / moved / missing state. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { TourMark, TourStep } from '../../../../../protocol/flow';
import type { Method } from './resolve';

/** Most marks one step carries. */
export const MAX_MARKS = 6;

export interface MarkContext {
	/** "steps[2]": names the step in an error. */
	where: string;
	/** A tool call (a mistake is an error that names the field) rather than a tour file (what is wrong is dropped). */
	strict: boolean;
	/** The step the marks are on, already placed: its `at` and `highlights` say where its code is. */
	step: TourStep;
	/** The step's file, absolute and inside the workspace; nothing for a caption-only or table step. */
	file?: string;
	/** The step's file text, for resolving `lines`. */
	text?: string;
	/** What validate.ts's TourFileHost gives (spelled out here: importing it would make a cycle). */
	host: { roots: string[]; readText(file: string): string | undefined; methodsIn?(file: string): readonly Method[] | undefined };
}

/** Contract stub: the pen-marks part replaces this with the real resolution. */
export function parseMarks(_raw: unknown, _ctx: MarkContext): { marks: TourMark[]; notes: string[] } {
	return { marks: [], notes: [] };
}
