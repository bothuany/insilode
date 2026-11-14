/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the editor's scan. The checks are scanCore.ts's; this gives them the workspace folders and VS Code's own
 *  file search.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { scanFolders, type Harness, type ScanFolder, type ScanHost } from './scanCore';

export { claudeMemoryDir } from './scanCore';
export type { Harness, HarnessItem, Issue, Kind, Scope, Severity } from './scanCore';

const NESTED_EXCLUDE = '{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**,**/.claude/worktrees/**,**/.insilode/worktrees/**,**/.axle/worktrees/**}';
const LISTING_EXCLUDE = '{**/node_modules/**,**/.git/**,**/.claude/worktrees/**,**/.insilode/worktrees/**,**/.axle/worktrees/**}';

const workspaceHost: ScanHost = {
	nested: async (folder, limit) => (await vscode.workspace.findFiles(new vscode.RelativePattern(folder.ref as vscode.WorkspaceFolder, '**/{CLAUDE,AGENTS}.md'), NESTED_EXCLUDE, limit)).map(u => u.fsPath),
	// This folder's files only: a rule's globs are relative to the folder that holds it.
	listing: async (folder, limit) => (await vscode.workspace.findFiles(new vscode.RelativePattern(folder.ref as vscode.WorkspaceFolder, '**/*'), LISTING_EXCLUDE, limit)).map(u => path.relative(folder.fsPath, u.fsPath).split(path.sep).join('/')),
	somewhere: ref => Promise.resolve(vscode.workspace.findFiles(`**/${ref}`, '{**/node_modules/**,**/.git/**}', 1)).then(r => r.length > 0, () => true),
};

export function scan(): Promise<Harness | undefined> {
	const folders: ScanFolder[] = (vscode.workspace.workspaceFolders ?? []).map(f => ({ name: f.name, fsPath: f.uri.fsPath, ref: f }));
	return scanFolders(folders, workspaceHost);
}
