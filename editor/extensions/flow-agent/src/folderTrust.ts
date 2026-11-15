/*---------------------------------------------------------------------------------------------
 *  Insilode: which folders outside this window's workspace an agent may start in, for the Agents page's terminals (termHost.ts). Insilode asks no question of its own
 *  (the CLI asks its own trust question): consent is what the user did before, never what a page says. A folder is allowed when it is in the workspace, one
 *  the sidebar's project index lists (the user ran an agent there), one the user chose in a folder dialog this host opened in this window session, or one in the
 *  stored list of earlier yes answers.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isInside, samePath, shown } from './chatCore';
import { isNetworkPath } from './agentsMessage';

/** Folders the user agreed to run agents in under the old question (their real paths), kept across windows and restarts: earlier yes answers stay valid. Nothing is added to it any more. */
export const TRUSTED_FOLDERS = 'flow.agents.trustedFolders';

/** The real paths of folders the user chose in a dialog of this host, in this window session only (never persisted). */
const picked = new Set<string>();

/** Takes back the folders trusted for agents earlier and the ones chosen in this window (the palette command "Forget Folders Trusted for Agents"). */
export async function forgetTrustedFolders(context: vscode.ExtensionContext): Promise<void> {
	const n = context.globalState.get<string[]>(TRUSTED_FOLDERS, []).length + picked.size;
	picked.clear();
	await context.globalState.update(TRUSTED_FOLDERS, undefined);
	void vscode.window.showInformationMessage(n ? `Insilode: forgot ${n} folder${n === 1 ? '' : 's'} trusted for agents. Choose a folder with Change… to run an agent in it again.` : 'Insilode: no folder was trusted for agents.');
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
 * The folder dialog of the launcher's "Other folder…": the host opens it, so the path is the user's own choice and joins this window session's allowed set.
 * Returns the path (as the dialog gave it) and its name, or nothing when the dialog was cancelled or the folder cannot be used.
 */
export async function pickFolder(): Promise<{ path: string; name: string } | undefined> {
	const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Choose Folder', title: 'Choose a folder to run an agent in' });
	const dir = chosen?.[0]?.fsPath;
	// A share would be refused by the page's next message anyway (agentsMessage.ts), and resolving it opens a connection to its server.
	if (!dir || !path.isAbsolute(dir) || isNetworkPath(dir)) {
		dir && void vscode.window.showWarningMessage('Insilode: a folder on a network share cannot be chosen here.');
		return undefined;
	}
	const where = await real(dir);
	if (!(await fs.stat(where).then(s => s.isDirectory(), () => false))) {
		return undefined;
	}
	picked.add(where);
	return { path: dir, name: path.basename(dir) || dir };
}

/**
 * A cwd inside this (trusted) window's workspace passes; any other folder passes only on the user's earlier actions (see the top of this file).
 * `indexed` lists the folders of the sidebar's project index. Returns the folder's real path and whether it is inside the workspace. Throws the sentence the page shows.
 */
export async function trustFolder(context: vscode.ExtensionContext, cwd: string, indexed?: () => Promise<string[]>): Promise<{ where: string; inside: boolean }> {
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
	if (picked.has(where) || context.globalState.get<string[]>(TRUSTED_FOLDERS, []).includes(where)) {
		return { where, inside: false };
	}
	// Last: it reads the index and resolves every project's folder.
	const listed = await (indexed?.() ?? Promise.resolve([] as string[])).catch(() => [] as string[]);
	if (listed.includes(cwd) || (await Promise.all(listed.map(real))).some(l => samePath(l, where))) {
		return { where, inside: false };
	}
	throw new Error(`Not started: ${shown(where)} is not one of your projects. Choose that folder with Change… first.`);
}
