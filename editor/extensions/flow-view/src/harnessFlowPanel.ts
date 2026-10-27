/*---------------------------------------------------------------------------------------------
 *  Insilode: the harness flow diagram (ui/src/harness, built to ui/dist-webview/harness.js) in an
 *  editor tab. The model comes from flow-harness through flowHarness.flowModel (protocol/harness.ts);
 *  a click on a piece opens the file it is written in.
 *
 *  Stub of the shared contract (docs/design/xirp-plan.md, part F): the command is registered and does nothing yet.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export function registerHarnessFlow(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): vscode.Disposable {
	void context;
	return vscode.commands.registerCommand('flow.showHarnessFlow', () => log.info('Harness flow: not built yet'));
}
