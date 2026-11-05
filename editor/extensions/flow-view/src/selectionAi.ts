/*---------------------------------------------------------------------------------------------
 *  Insilode: selection actions in the editor. With code selected the user can ask the agent about it, have it
 *  explained as a tour, or ask the agent to change it (docs/research/inline-ai.md). They are the same three
 *  things the canvas offers on a card (`pointAsk`), and they share one prompt builder (tour/ask.ts): Insilode has
 *  no model of its own, so each is a prompt with a file and lines, sent to the agent the user chose
 *  (flow.agents.ask). An edit comes back as the usual reviewable change; nothing here shows a diff itself.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { askInDock } from './askAgent';
import { selectionAskPrompt, type SelectedLines } from './selectionPrompt';
import { MAX_QUESTION, oneLine, place, selectedRange, type PointKind } from './tour/ask';

export const SelectionCommand = {
	ask: 'flow.selection.ask',
	explain: 'flow.selection.explain',
	edit: 'flow.selection.edit',
} as const;

const PROMPT: Record<PointKind, { title: string; placeHolder: string } | undefined> = {
	ask: { title: 'Ask the agent about this code', placeHolder: 'What would you like to know?' },
	edit: { title: 'Edit this code with the agent', placeHolder: 'How should it change? (e.g. "return early when the list is empty")' },
	explain: undefined,
};

/**
 * The whole lines the selection touches, read in one look at the document: the text and the line numbers are of the same
 * version, and the numbers are the live buffer's (the disk may hold other lines when there are unsaved changes).
 */
function lookAt(ed: vscode.TextEditor): (SelectedLines & { version: number }) | undefined {
	const range = selectedRange(ed.selection);
	if (!range) {
		return undefined;
	}
	const doc = ed.document;
	const text = doc.getText(new vscode.Range(range.startLine - 1, 0, range.endLine - 1, doc.lineAt(range.endLine - 1).range.end.character));
	return { text, ...range, unsaved: doc.isDirty, version: doc.version };
}

async function run(kind: PointKind): Promise<void> {
	const ed = vscode.window.activeTextEditor;
	let sel = ed && lookAt(ed);
	if (!ed || !sel) {
		void vscode.window.showInformationMessage('Select some code first.');
		return;
	}
	if (ed.document.uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(ed.document.uri)) {
		void vscode.window.showInformationMessage('The agent can only be pointed at a file in this workspace.');
		return;
	}
	const file = ed.document.uri.fsPath;
	const rel = vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/');
	let question = '';
	const ask = PROMPT[kind];
	if (ask) {
		const answer = await vscode.window.showInputBox({ ...ask, prompt: place(rel, sel.startLine, sel.endLine), ignoreFocusOut: true });
		question = oneLine(answer, MAX_QUESTION);
		if (!question) {
			return;
		}
	}
	// The editor may have changed while the box was open: look again, so the lines sent are the ones the numbers name.
	if (ed.document.version !== sel.version) {
		sel = lookAt(ed);
		if (!sel) {
			void vscode.window.showInformationMessage('The selection changed. Select the code again.');
			return;
		}
	}
	if (sel.unsaved) {
		// The agent reads files from disk: say so once, and let the user choose between disk and buffer.
		const save = 'Save and ask';
		const unsaved = 'Ask with unsaved text';
		const pick = await vscode.window.showInformationMessage(`${rel.split('/').pop()} has unsaved changes.`, save, unsaved);
		if (pick === undefined) {
			return;
		}
		if (pick === save) {
			await ed.document.save();
			// Saving may reformat the file: the selection and its lines are read again. A save that did not take stays labelled as unsaved.
			sel = lookAt(ed);
			if (!sel) {
				void vscode.window.showInformationMessage('The selection changed. Select the code again.');
				return;
			}
		}
	}
	const label = rel.split('/').pop() ?? 'this code';
	const prompt = selectionAskPrompt({ kind, label, file: rel, question, selected: sel });
	if (!await askInDock(prompt, true, 'editor', [file])) {
		await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: false, attachFiles: [ed.document.uri] });
	}
}

/** The lightbulb on a selection: the selection hint. */
class SelectionActions implements vscode.CodeActionProvider {
	static readonly kinds = [vscode.CodeActionKind.RefactorRewrite.append('insilode')];

	provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection): vscode.CodeAction[] {
		if (range.isEmpty || document.uri.scheme !== 'file') {
			return [];
		}
		const make = (title: string, command: string, kind: vscode.CodeActionKind) => {
			const a = new vscode.CodeAction(title, kind);
			a.command = { title, command };
			return a;
		};
		const [rewrite] = SelectionActions.kinds;
		return [
			make('Insilode: Edit with agent…', SelectionCommand.edit, rewrite),
			make('Insilode: Ask agent about this…', SelectionCommand.ask, vscode.CodeActionKind.Empty.append('insilode').append('ask')),
			make('Insilode: Explain with a tour', SelectionCommand.explain, vscode.CodeActionKind.Empty.append('insilode').append('explain')),
		];
	}
}

export function registerSelectionActions(): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(SelectionCommand.ask, () => run('ask')),
		vscode.commands.registerCommand(SelectionCommand.explain, () => run('explain')),
		vscode.commands.registerCommand(SelectionCommand.edit, () => run('edit')),
		vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, new SelectionActions(), {
			providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite.append('insilode'), vscode.CodeActionKind.Empty.append('insilode')],
		}),
	];
}
