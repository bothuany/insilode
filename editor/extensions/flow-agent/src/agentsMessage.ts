/*---------------------------------------------------------------------------------------------
 *  Insilode: what the Agents page may ask the host for. The page is not trusted: each message is checked here for its
 *  type and the shape of every field, and only then becomes one of these actions; anything else is dropped. The row and
 *  worktree actions are the dock's own (dockMessage.ts), so both views offer the same things. Pure (no vscode):
 *  tested on its own (test/agentsMessage.test.mjs); agentsPanel.ts carries the actions out.
 *--------------------------------------------------------------------------------------------*/

import { dockAction, type DockAction } from './dockMessage';

/** The longest reply the page may type into an agent's prompt. */
export const MAX_REPLY = 8000;

export type AgentsAction =
	| Exclude<DockAction, { type: 'chat' }>
	/** The last messages of an agent's conversation, for the detail panel. */
	| { type: 'tail'; id: string }
	/** Type the reply box's text into the agent's prompt and submit it. */
	| { type: 'reply'; id: string; text: string }
	/** One of the user's own agents from the New menu, by its index in the `customs` list the host sent and its name (the list may have changed since). */
	| { type: 'custom'; index: number; name: string }
	/** The kept worktrees' quick pick (Agents: Kept Worktrees…). */
	| { type: 'kept' };

export function agentsAction(raw: unknown): AgentsAction | undefined {
	const m = raw as Record<string, unknown> | null;
	if (!m || typeof m !== 'object' || typeof m.type !== 'string') {
		return undefined;
	}
	const id = typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 ? m.id : undefined;
	switch (m.type) {
		case 'tail':
			return id !== undefined ? { type: 'tail', id } : undefined;
		case 'reply':
			return id !== undefined && typeof m.text === 'string' && m.text.trim().length > 0 && m.text.length <= MAX_REPLY ? { type: 'reply', id, text: m.text } : undefined;
		case 'custom':
			return typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 && m.index < 100 && typeof m.name === 'string' && m.name.length <= 200 ? { type: 'custom', index: m.index, name: m.name } : undefined;
		case 'kept':
			return { type: 'kept' };
		// The chat settings link belongs to the dock only.
		case 'chat':
			return undefined;
		default: {
			const d = dockAction(raw);
			return d && d.type !== 'chat' ? d : undefined;
		}
	}
}
