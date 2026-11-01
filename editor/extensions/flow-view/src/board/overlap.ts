/*---------------------------------------------------------------------------------------------
 *  Insilode board overlap check: what draw_board and update_board tell the agent about boxes (cards, callouts, labels) that the
 *  layout would put on top of each other, and what Insilode nudged apart on its own. The canvas that lays the board out lives in
 *  ui/ and flow-view never imports it, so this mirrors its geometry (like board/lint.ts mirrors its crossings); a test compares
 *  the two. Deterministic: the same spec always gives the same lines. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { BoardSpec } from './spec';

/**
 * Short lines for the agent, one per move or per overlap that is left: "moved 'Cache' 24px right off 'API'",
 * "'A' and 'B' still overlap: give them more room". Nothing when the board has no overlap or there is no board.
 * Contract stub: the board-overlap part replaces this.
 */
export function checkOverlap(_spec: BoardSpec | undefined): string[] {
	return [];
}
