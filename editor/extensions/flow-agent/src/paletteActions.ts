/*---------------------------------------------------------------------------------------------
 *  Insilode: the dock's row actions (rename, swap to the other CLI, remove) from the command palette. Each picks the
 *  agent with a quick pick when no id was given (the dock passes one), so a keyboard user never needs the row buttons.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents } from './agents';
import { swapAgent } from './swap';
import type { WorktreeRows } from './worktreeActions';

/** `flow.agents.rename`. A stub until the dock part gives it its pick. */
export async function renameFromPalette(_agents: Agents, _id?: unknown): Promise<void> {
	void vscode.window.showInformationMessage('Insilode: rename an agent from its row in the Agents dock.');
}

/** `flow.agents.swap`: the dock passes an id; today the palette needs one too. */
export async function swapFromPalette(agents: Agents, id?: unknown): Promise<void> {
	await swapAgent(agents, id);
}

/** `flow.agents.remove`. A stub until the dock part gives it its pick. */
export async function removeFromPalette(_agents: Agents, _worktrees: WorktreeRows, _id?: unknown): Promise<void> {
	void vscode.window.showInformationMessage('Insilode: remove an agent from its row in the Agents dock.');
}
