/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page, a full-editor webview behind the title bar's Agents button (it replaces VS Code's own
 *  "Open in Agents" window button). Stub of the contract: the panel itself is built in its own change.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents } from './agents';
import type { WorktreeRows } from './worktreeActions';

export const OPEN_AGENTS_PAGE = 'flow.agents.openPage';

export class AgentsPanel implements vscode.Disposable {
	constructor(private readonly agents: Agents, private readonly worktrees?: WorktreeRows) {}

	/** Opens the page, or brings the open one to the front. */
	open(): void {
		void this.agents;
		void this.worktrees;
	}

	dispose(): void {
		// nothing yet
	}
}
