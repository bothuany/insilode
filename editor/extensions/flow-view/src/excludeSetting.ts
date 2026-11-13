/*---------------------------------------------------------------------------------------------
 *  Insilode: `flow.exclude` read from the settings, and the workspace folders it is relative to.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { excluder, type Excluder } from './poly/userExclude';

/**
 * Every pattern that applies: VS Code does not merge arrays across scopes, so a user-level list would stop applying the
 * moment a workspace one exists (the Exclude button writes the workspace value). The union keeps both.
 */
export const excludePatterns = (): string[] => {
	const v = vscode.workspace.getConfiguration('flow').inspect<unknown[]>('exclude');
	const all = [v?.globalValue, v?.workspaceValue, v?.workspaceFolderValue].flatMap(l => Array.isArray(l) ? l : []);
	return [...new Set(all.filter((p): p is string => typeof p === 'string'))];
};

let current: { key: string; drop: Excluder } | undefined;

/** The excluder for the setting as it is now: built again only when the patterns change, not on every file asked about. */
export function currentExcluder(): Excluder {
	const patterns = excludePatterns();
	const key = JSON.stringify(patterns);
	if (current?.key !== key) {
		current = { key, drop: excluder(patterns) };
	}
	return current.drop;
}

export const workspaceRoots = (): string[] => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
