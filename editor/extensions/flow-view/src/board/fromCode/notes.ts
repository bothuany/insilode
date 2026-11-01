/*---------------------------------------------------------------------------------------------
 *  Insilode boards generated from code: the note every kind carries when what it read may be incomplete. The index of Java, Python,
 *  JS/TS and the other tree-sitter languages is built in the background: until it has finished, a board drawn from it can miss
 *  types, tables and calls, and a board whose relations were linked by name says so too. The agent (and the user, in the
 *  Board from Code command) should hear it from every generator, not only the one that happened to have a note. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { FromCodeKind, GenBoard } from './board';

/** What may be missing from a board of each kind while the index is still building. */
const MISSING: Record<FromCodeKind, string> = {
	sequence: 'calls into Java, Python and JS/TS code',
	er: 'tables of Java, Python and JS/TS',
	architecture: 'types and the links between them',
	state: 'enums and the methods that move them',
};

export interface PartialIndexInput {
	kind: FromCodeKind;
	/** The code index has finished its first build (a flow traced by the C# analyzer does not depend on it: pass true). */
	indexReady: boolean;
	/** The board that was generated, when there is one: dotted edges marked as guesses are read from its legend. */
	board?: Pick<GenBoard, 'legend'>;
	/** Why no board was drawn, when that is the case: a reason that already names the building index is not repeated. */
	skipped?: string;
}

/**
 * The notes to append to a generated board's answer: one when the index is still building (what may be missing and to try again),
 * one when some relations are guesses. Empty when the board was read from a finished index without guessing.
 */
export function partialIndexNotes({ kind, indexReady, board, skipped }: PartialIndexInput): string[] {
	const notes: string[] = [];
	if (!indexReady && !/still building/i.test(skipped ?? '')) {
		notes.push(`The code index is still building: ${MISSING[kind]} may be missing. Try again in a moment.`);
	}
	if (board?.legend?.some(l => l.key === 'guess')) {
		notes.push('Some relations are guesses (dotted, marked "?"): linked by name, an HTTP route or a topic, not read from the code.');
	}
	return notes;
}
