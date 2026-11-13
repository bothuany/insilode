/*---------------------------------------------------------------------------------------------
 *  Insilode polyglot index + language server: the VS Code side of `Lsp` (see lspResolve.ts).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { currentExcluder } from '../excludeSetting';
import { isExcludedPath } from './model';
import type { Lsp, Place } from './lspResolve';

const ANSWER_MS = 1500;

type Result = vscode.Location | vscode.LocationLink;

/** Language servers that are still loading answer late or never: no answer in time is no answer. */
function within<T>(p: Thenable<T>, fallback: T): Promise<T> {
	return new Promise(resolve => {
		const timer = setTimeout(() => resolve(fallback), ANSWER_MS);
		Promise.resolve(p).then(v => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
	});
}

function inWorkspace(uri: vscode.Uri) {
	const folder = uri.scheme === 'file' ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
	return !!folder && !isExcludedPath(uri.fsPath, folder.uri.fsPath) && !currentExcluder()(uri.fsPath, [folder.uri.fsPath]);
}

function places(list: Result[] | undefined): Place[] {
	const out: Place[] = [];
	for (const r of list ?? []) {
		const uri = 'targetUri' in r ? r.targetUri : r.uri;
		const range = 'targetUri' in r ? (r.targetSelectionRange ?? r.targetRange) : r.range;
		if (inWorkspace(uri)) {
			out.push({ file: uri.fsPath, line: range.start.line + 1 });
		}
	}
	return out;
}

export class VsLsp implements Lsp {
	private query(command: 'vscode.executeDefinitionProvider' | 'vscode.executeImplementationProvider', file: string, line: number, character: number) {
		// The id can only be one of the two literals in the parameter type.
		return within(vscode.commands.executeCommand<Result[]>(command, vscode.Uri.file(file), new vscode.Position(line - 1, character)), undefined); // nosemgrep: insilode-command-id-not-allowlisted
	}

	async definitions(file: string, line: number, character: number) {
		return places(await this.query('vscode.executeDefinitionProvider', file, line, character));
	}

	async implementations(file: string, line: number, character: number) {
		return places(await this.query('vscode.executeImplementationProvider', file, line, character));
	}
}
