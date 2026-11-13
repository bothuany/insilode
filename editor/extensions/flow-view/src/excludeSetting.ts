/*---------------------------------------------------------------------------------------------
 *  Insilode: `flow.exclude` read from the settings, and the workspace folders it is relative to.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export const excludePatterns = (): string[] => vscode.workspace.getConfiguration('flow').get<unknown[]>('exclude', []).filter((p): p is string => typeof p === 'string');

export const workspaceRoots = (): string[] => (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
