/*---------------------------------------------------------------------------------------------
 *  Insilode: the question behind "Resume anyway". The registry says another process runs a Claude session; a stale entry (a crash that left
 *  its file behind) looks the same, and the user is the only one who can tell. Every way past the refusal goes through this modal, shown by
 *  the host itself: the page can ask for it (`termOpen` with `force`) but never skip it.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { elsewhereWarning } from './spawnGuard';

export const RESUME_ANYWAY = 'Resume anyway';

/** True when the user chose to resume the session although the registry says `where` runs it. */
export async function confirmResumeAnyway(name: string, where: { source: string; pid?: number }): Promise<boolean> {
	const { message, detail } = elsewhereWarning(name, where);
	return (await vscode.window.showWarningMessage(message, { modal: true, detail }, RESUME_ANYWAY)) === RESUME_ANYWAY;
}
