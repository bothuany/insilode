/*---------------------------------------------------------------------------------------------
 *  Insilode: the prompt of a selection ask, with the selected text in it. The agent used to get a file and line numbers
 *  and read the lines from disk, which is wrong when the editor holds unsaved changes (the numbers are the buffer's, the
 *  disk's lines are others). Now the text goes along, with the lines it covers, and says when it comes from an unsaved
 *  buffer. Pure: no `vscode` (tested in test/selection-prompt.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import { place, selectionPrompt, type PointKind } from './tour/ask';

/** The selected text goes into the prompt up to about this many characters; a longer selection is cut at a line break. */
export const MAX_SELECTED_TEXT = 6000;

/** What the editor held at one moment: the whole lines `startLine`..`endLine` (1-based) and their text, from the same document version. */
export interface SelectedLines {
	text: string;
	startLine: number;
	endLine: number;
	/** The buffer has changes that are not on disk. */
	unsaved: boolean;
}

/**
 * The text cut to `max` characters at a line break (a single longer line is cut where it stands), and the last line that
 * is shown in full or in part. `shownEndLine` is below the selection's `endLine` when the text was cut.
 */
export function limitSelected(text: string, startLine: number, max = MAX_SELECTED_TEXT): { text: string; shownEndLine: number; truncated: boolean } {
	const total = text.split('\n').length;
	if (text.length <= max) {
		return { text, shownEndLine: startLine + total - 1, truncated: false };
	}
	const cut = text.lastIndexOf('\n', max);
	const kept = cut > 0 ? text.slice(0, cut) : text.slice(0, max);
	return { text: kept, shownEndLine: startLine + kept.split('\n').length - 1, truncated: true };
}

/** A code fence longer than any run of backticks in the text, so the text cannot close it early. */
const fenceFor = (text: string) => '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(r => r.length + 1)));

/** The selected text as the prompt carries it: what it is and where, the fenced text, and the cut marker when it was cut. */
export function selectedBlock(file: string, sel: SelectedLines): string {
	const shown = limitSelected(sel.text.replace(/\r\n?/g, '\n'), sel.startLine);
	const fence = fenceFor(shown.text);
	const head = sel.unsaved
		? `The selected lines of ${place(file, sel.startLine, sel.endLine)} come from the unsaved buffer in the editor: the line numbers are the buffer's, and the file on disk may differ.`
		: `The selected lines of ${place(file, sel.startLine, sel.endLine)}:`;
	const cutNote = shown.truncated ? `Only line${shown.shownEndLine > sel.startLine ? `s ${sel.startLine}-${shown.shownEndLine}` : ` ${sel.startLine}`} of the selection ${shown.shownEndLine > sel.startLine ? 'are' : 'is'} shown; the rest is cut.` : '';
	return [head, fence, shown.text + (shown.truncated ? '\n[truncated]' : ''), fence, cutNote].filter(Boolean).join('\n');
}

/**
 * The prompt for ask, explain or edit on a selection: the usual prompt (tour/ask.ts) followed by the selected text. `file`
 * is workspace-relative, and the lines are those of `sel`, measured on the live buffer, so the range and the text agree.
 */
export function selectionAskPrompt(p: { kind: PointKind; label: string; file: string; question: string; selected: SelectedLines }): string {
	const where = place(p.file, p.selected.startLine, p.selected.endLine);
	return `${selectionPrompt({ kind: p.kind, label: p.label, where, question: p.question })}\n\n${selectedBlock(p.file, p.selected)}`;
}
