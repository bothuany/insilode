/*---------------------------------------------------------------------------------------------
 *  Insilode: the one question asked before an agent runs in a folder outside this window's workspace, used by the Agents page's terminals (termHost.ts). The yes is kept by the folder's real path, across windows and restarts.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isInside, shown } from './chatCore';

/** Folders the user agreed to run agents in (their real paths), kept across windows and restarts. */
export const TRUSTED_FOLDERS = 'flow.agents.trustedFolders';
const MAX_TRUSTED = 200;

/** Takes back every folder the user agreed to run agents in (the palette command "Forget Folders Trusted for Agents"). */
export async function forgetTrustedFolders(context: vscode.ExtensionContext): Promise<void> {
	const n = context.globalState.get<string[]>(TRUSTED_FOLDERS, []).length;
	await context.globalState.update(TRUSTED_FOLDERS, undefined);
	void vscode.window.showInformationMessage(n ? `Insilode: forgot ${n} folder${n === 1 ? '' : 's'} trusted for agents. The next agent in one asks again.` : 'Insilode: no folder was trusted for agents.');
}

/** A path realpath cannot resolve in a second (a dead network mount) is taken as written: the caller then compares it with other paths as written. */
export async function real(p: string): Promise<string> {
	let timer: NodeJS.Timeout | undefined;
	const slow = new Promise<string>(resolve => timer = setTimeout(() => resolve(path.resolve(p)), 1500));
	try {
		return await Promise.race([fs.realpath(p).catch(() => path.resolve(p)), slow]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A cwd inside this (trusted) window's workspace passes; any other folder needs the user's yes, once, kept by its real path.
 * Returns that real path (what the user saw and confirmed) and whether the folder is inside the workspace. Throws the sentence the page shows.
 */
export async function trustFolder(context: vscode.ExtensionContext, cwd: string): Promise<{ where: string; inside: boolean }> {
	if (!vscode.workspace.isTrusted) {
		throw new Error('Trust this workspace to run agents.');
	}
	const where = await real(cwd);
	if (!(await fs.stat(where).then(s => s.isDirectory(), () => false))) {
		throw new Error(`${shown(cwd)} is not a folder any more.`);
	}
	for (const f of vscode.workspace.workspaceFolders ?? []) {
		if (isInside(await real(f.uri.fsPath), where)) {
			return { where, inside: true };
		}
	}
	const trusted = context.globalState.get<string[]>(TRUSTED_FOLDERS, []);
	if (trusted.includes(where)) {
		return { where, inside: false };
	}
	const yes = 'Run Agent Here';
	const answer = await vscode.window.showWarningMessage(`Run an agent in ${shown(where)}?`, {
		modal: true,
		detail: 'This folder is outside the project open in this window. The agent can read, edit and run commands there, and the folder\'s own Claude settings (hooks, permission rules) and its .mcp.json servers load too: a repository you do not trust can make them run code. You can take these folders back with "Insilode: Forget Folders Trusted for Agents".',
	}, yes);
	if (answer !== yes) {
		throw new Error('Not started: the agent was not allowed to run in that folder.');
	}
	await context.globalState.update(TRUSTED_FOLDERS, [...trusted, where].slice(-MAX_TRUSTED));
	return { where, inside: false };
}
