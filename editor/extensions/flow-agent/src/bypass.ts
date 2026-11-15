/*---------------------------------------------------------------------------------------------
 *  Insilode: the switch for offering Claude Code's bypass permissions mode in terminal Claude sessions
 *  (flow.agents.claude.allowBypassPermissions), and its Codex counterpart (flow.agents.codex.neverAsk). Both are machine-scoped,
 *  so a repository cannot turn them on; the launcher turns each on (after a warning) or off.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const SECTION = 'flow.agents.claude';
const KEY = 'allowBypassPermissions';
export const BYPASS_SETTING = `${SECTION}.${KEY}`;

export const bypassAllowed = () => vscode.workspace.getConfiguration(SECTION).get<boolean>(KEY, false) === true;

const CODEX_SECTION = 'flow.agents.codex';
const CODEX_KEY = 'neverAsk';
export const NEVER_ASK_SETTING = `${CODEX_SECTION}.${CODEX_KEY}`;

export const neverAskAllowed = () => vscode.workspace.getConfiguration(CODEX_SECTION).get<boolean>(CODEX_KEY, false) === true;

/** `update` rejects when settings.json cannot be written (a syntax error in it, say); callers do not await this, so say so here and report whether it worked. */
async function save(value: boolean, section = SECTION, key = KEY): Promise<boolean> {
	try {
		await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
		return true;
	} catch (err) {
		void vscode.window.showErrorMessage(`Insilode: could not change ${section}.${key} (${err instanceof Error ? err.message : String(err)}). Check your user settings.json for errors.`);
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

/**
 * Codex has no flag that offers a mode without enabling it, so "never ask" starts the session with approval policy `never` and its workspace
 * sandbox kept (src/launch.ts). Off: asks for confirmation and turns it on when confirmed. On: turns it off, no warning. Only sessions started afterwards change.
 */
export async function toggleNeverAsk(): Promise<void> {
	if (neverAskAllowed()) {
		if (!await save(false, CODEX_SECTION, CODEX_KEY)) {
			return;
		}
		void vscode.window.showInformationMessage('Insilode: Codex sessions you start from now on ask before they edit files or run commands.');
		return;
	}
	const allow = 'Never Ask';
	const answer = await vscode.window.showWarningMessage(
		'Start Codex sessions without asking?',
		{ modal: true, detail: 'Codex then stops asking before it edits files and runs commands. It stays inside its workspace sandbox: it can change files in the project folder, but not elsewhere on this computer. Only sessions you start afterwards change; a running one keeps asking. You can turn this off again from the same menu.' },
		allow,
	);
	if (answer !== allow) {
		return;
	}
	if (!await save(true, CODEX_SECTION, CODEX_KEY)) {
		return;
	}
	void vscode.window.showInformationMessage('Insilode: Codex sessions you start from now on do not ask before they edit files or run commands (sandboxed to their workspace). A session that is already running keeps asking.');
}
