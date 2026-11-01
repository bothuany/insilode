/*---------------------------------------------------------------------------------------------
 *  Insilode: "Take the Insilode Tour", the button on Home's first-run strip. It plays a bundled sample tour that walks the
 *  user's own Home, Flow at Cursor and Boards, through the same path an agent's tour takes (`panel.playTour`).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { TourHost } from './tourFile';

/** Plays the sample tour on the canvas. A stub until the Home part builds the tour. */
export async function playSampleTour(_host: TourHost): Promise<void> {
	void vscode.window.showInformationMessage('Insilode: the sample tour is not ready yet.');
}
