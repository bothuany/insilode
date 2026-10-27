/*---------------------------------------------------------------------------------------------
 *  Insilode: pull request news becomes work for the agent on that branch. CI failures, requested
 *  changes and conflicts found by polling (prState.ts) are queued per session and typed into the
 *  agent once its turn ends (Agents.onDidTurnEnd, Agents.deliver), within flow.agents.pr.*.
 *
 *  Stub of the shared contract (docs/design/xirp-plan.md, part A): registered, does nothing yet.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents } from './agents';

export class PrEvents implements vscode.Disposable {
	constructor(readonly agents: Agents) { }

	dispose() { }
}
