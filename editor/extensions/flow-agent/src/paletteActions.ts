/*---------------------------------------------------------------------------------------------
 *  Insilode: the dock's row actions (rename, swap to the other CLI, remove) from the command palette. Each picks the
 *  agent with a quick pick when no id was given (the dock passes one), so a keyboard user never needs the row buttons.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents, AgentSession } from './agents';
import { rank } from './attention';
import { agentPickItems, type AgentAction } from './pick';
import { swapAgent } from './swap';
import type { WorktreeRows } from './worktreeActions';

/** The same rule the dock's Rename always had: a name is required. */
export function validateAgentName(value: string): string | undefined {
	return value.trim() ? undefined : 'A name is required';
}

const TITLE: Record<AgentAction, string> = { rename: 'Rename Agent', swap: 'Continue an Agent in the Other CLI', remove: 'Remove an Agent' };
const EMPTY: Record<AgentAction, string> = {
	rename: 'Insilode: there is no agent in this window to rename. Start one from the Agents dock.',
	swap: 'Insilode: there is no Claude or Codex agent in this window to continue in the other CLI.',
	remove: 'Insilode: there is no agent in this window to remove.',
};

/**
 * The agent an action is for. The dock passes an id (and skips the pick); the palette passes nothing and gets a quick pick of
 * this window's agents, the one that needs you first. A stale or made-up id gives nothing.
 */
async function agentFor(agents: Agents, id: unknown, action: AgentAction): Promise<AgentSession | undefined> {
	if (typeof id === 'string') {
		return agents.sessions.get(id);
	}
	const items = agentPickItems(rank([...agents.sessions.values()]), action);
	if (!items.length) {
		void vscode.window.showInformationMessage(EMPTY[action]);
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(items, { title: TITLE[action], placeHolder: 'Choose an agent', matchOnDescription: true, ignoreFocusOut: true });
	return pick && agents.sessions.get(pick.id);
}

/** `flow.agents.rename`: an input box with the agent's name, the rule and the prompt the dock's Rename has. */
export async function renameFromPalette(agents: Agents, id?: unknown): Promise<void> {
	const s = await agentFor(agents, id, 'rename');
	if (!s) {
		return;
	}
	const name = await vscode.window.showInputBox({
		title: 'Rename Agent',
		value: s.name,
		prompt: s.cli === 'claude' ? 'Shown in this list and in Claude\'s /resume' : 'Shown in this list',
		validateInput: validateAgentName,
	});
	if (name !== undefined) {
		await agents.rename(s.id, name);
	}
}

/** `flow.agents.swap`: continue the conversation in the other CLI (swap.ts), for the agent from the dock or the one picked. */
export async function swapFromPalette(agents: Agents, id?: unknown): Promise<void> {
	const s = await agentFor(agents, id, 'swap');
	if (s) {
		await swapAgent(agents, s.id);
	}
}

/**
 * `flow.agents.remove`: takes the agent off the list. One with a worktree goes through the worktree rows (keep, merge or remove
 * the folder first, as the dock's × does); the others are simply forgotten. The dock offers × only on a closed agent, so a
 * running one asked for here is confirmed first: removing it closes its terminal.
 */
export async function removeFromPalette(agents: Agents, worktrees: WorktreeRows, id?: unknown): Promise<void> {
	const s = await agentFor(agents, id, 'remove');
	if (!s) {
		return;
	}
	if (s.state !== 'ended') {
		const go = 'Close and Remove';
		const pick = await vscode.window.showWarningMessage(`${s.name} is still running.`, { modal: true, detail: 'Removing it closes its terminal. Its conversation stays in the CLI\'s own history, so it can be resumed.' }, go);
		if (pick !== go) {
			return;
		}
	}
	if (s.worktree) {
		await worktrees.forget(s.id);
	} else {
		agents.forget(s.id);
	}
}
