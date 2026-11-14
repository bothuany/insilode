/*---------------------------------------------------------------------------------------------
 *  Insilode: the switch for offering Claude Code's bypass permissions mode in terminal Claude sessions
 *  (flowAgent.claude.allowBypassPermissions). It is machine-scoped, so a repository cannot turn it on; the menu of the
 *  Claude start button turns it on (after a warning) or off.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const SECTION = 'flowAgent.claude';
const KEY = 'allowBypassPermissions';
export const BYPASS_SETTING = `${SECTION}.${KEY}`;

export const bypassAllowed = () => vscode.workspace.getConfiguration(SECTION).get<boolean>(KEY, false) === true;

/** `update` rejects when settings.json cannot be written (a syntax error in it, say); callers do not await this, so say so here and report whether it worked. */
async function save(value: boolean): Promise<boolean> {
	try {
		await vscode.workspace.getConfiguration(SECTION).update(KEY, value, vscode.ConfigurationTarget.Global);
		return true;
	} catch (err) {
		void vscode.window.showErrorMessage(`Insilode: could not change ${BYPASS_SETTING} (${err instanceof Error ? err.message : String(err)}). Check your user settings.json for errors.`);
		return false;
	}
}

/** Off: asks for confirmation (with the warning) and turns it on when confirmed. On: turns it off, no warning. Either way only sessions started afterwards change, since a running CLI cannot gain or lose the flag. */
export async function toggleBypass(): Promise<void> {
	if (bypassAllowed()) {
		if (!await save(false)) {
			return;
		}
		void vscode.window.showInformationMessage('Insilode: bypass permissions mode is no longer offered in Claude sessions you start from now on.');
		return;
	}
	const allow = 'Allow';
	const answer = await vscode.window.showWarningMessage(
		'Offer bypass permissions mode in Claude sessions?',
		{ modal: true, detail: 'The agent can then be switched (Shift+Tab) into a mode where it edits files and runs commands without asking you. Sessions still start in their usual mode, and nothing is bypassed until you switch. You can turn this off again from the same menu.' },
		allow,
	);
	if (answer !== allow) {
		return;
	}
	if (!await save(true)) {
		return;
	}
	void vscode.window.showInformationMessage('Insilode: bypass permissions mode is offered in Claude sessions you start from now on. A session that is already running cannot gain it.');
}
