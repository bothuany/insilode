/*---------------------------------------------------------------------------------------------
 *  Insilode: the tour bar's Save. Writes the playing tour to `.insilode/tours/<id>.tour.json`, in exactly the format
 *  tourFile.ts reads back (any file ending in .tour.json), after the reader clicked Save: nothing is written on its own.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Tour } from '../../../../protocol/flow';

export interface TourSaveResult {
	ok: boolean;
	/** The file written, when it was. */
	path?: string;
	message?: string;
}

/** Writes `tour` under the first workspace folder; the file round-trips through `parseTourFile`. A stub until the tour part fills it. */
export async function saveTour(_tour: Tour, _roots: readonly string[]): Promise<TourSaveResult> {
	return { ok: false, message: 'Saving a tour is not built yet.' };
}

/** The Save click: writes the tour and says where, with an Open button; says why when it could not. */
export async function saveTourWithNotice(tour: Tour): Promise<void> {
	const roots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];
	const res = await saveTour(tour, roots);
	void vscode.window.showInformationMessage(res.ok && res.path ? `Insilode: tour saved to ${vscode.workspace.asRelativePath(res.path)}.` : `Insilode: ${res.message ?? 'the tour could not be saved.'}`);
}
