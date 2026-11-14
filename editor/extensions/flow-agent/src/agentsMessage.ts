/*---------------------------------------------------------------------------------------------
 *  Insilode: what the Agents page may ask the host for. The page is not trusted: each message is checked here for its
 *  type and the shape of every field, and only then becomes one of these actions; anything else is dropped. The row and
 *  worktree actions are the dock's own (dockMessage.ts), so both views offer the same things. Pure (no vscode):
 *  tested on its own (test/agentsMessage.test.mjs); agentsPanel.ts carries the actions out.
 *--------------------------------------------------------------------------------------------*/

import { dockAction, PEER_KEY, type DockAction } from './dockMessage';
import { MAX_QUERY, MIN_QUERY } from './sessionSearch';

/** The longest reply the page may type into an agent's prompt. */
export const MAX_REPLY = 8000;

/** The longest chat id, config id and config value the page may name; the host re-checks them against the session. */
const MAX_CHAT = 200;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentsAction =
	| Exclude<DockAction, { type: 'chat' }>
	/** The last messages of an agent's conversation, for the detail panel. */
	| { type: 'tail'; id: string }
	/** Type the reply box's text into the agent's prompt and submit it. */
	| { type: 'reply'; id: string; text: string }
	/** One of the user's own agents from the New menu, by its index in the `customs` list the host sent and its name (the list may have changed since). */
	| { type: 'custom'; index: number; name: string }
	/** The kept worktrees' quick pick (Agents: Kept Worktrees…). */
	| { type: 'kept' }
	/**
	 * The page's own chat (chatSessions.ts). Every id is one the host issued (a project key, a session id from its index, a chat id,
	 * the index of an option it sent): the page never sends a path.
	 */
	| { type: 'chatList' }
	/** Past sessions whose conversation contains the text, across the projects the host lists (sessionSearch.ts). */
	| { type: 'chatSearch'; query: string }
	/** No `session` starts a new one in that project's folder. */
	| { type: 'chatOpen'; project: string; kind: 'claude' | 'codex'; session?: string }
	| { type: 'chatPrompt'; chat: string; text: string }
	| { type: 'chatCancel'; chat: string }
	| { type: 'chatAnswer'; chat: string; req: number; option: number }
	| { type: 'chatSet'; chat: string; config: string; value: string };

/** An integer in [0, below). */
const isIndex = (n: unknown, below: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < below;

export function agentsAction(raw: unknown): AgentsAction | undefined {
	const m = raw as Record<string, unknown> | null;
	if (!m || typeof m !== 'object' || typeof m.type !== 'string') {
		return undefined;
	}
	const id = typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 ? m.id : undefined;
	const chat = typeof m.chat === 'string' && m.chat.length > 0 && m.chat.length <= MAX_CHAT ? m.chat : undefined;
	switch (m.type) {
		case 'tail':
			return id !== undefined ? { type: 'tail', id } : undefined;
		case 'reply':
			return id !== undefined && typeof m.text === 'string' && m.text.trim().length > 0 && m.text.length <= MAX_REPLY ? { type: 'reply', id, text: m.text } : undefined;
		case 'custom':
			return typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 && m.index < 100 && typeof m.name === 'string' && m.name.length <= 200 ? { type: 'custom', index: m.index, name: m.name } : undefined;
		case 'kept':
			return { type: 'kept' };
		case 'chatList':
			return { type: 'chatList' };
		case 'chatSearch':
			return typeof m.query === 'string' && m.query.trim().length >= MIN_QUERY && m.query.length <= MAX_QUERY ? { type: 'chatSearch', query: m.query } : undefined;
		case 'chatOpen':
			return typeof m.project === 'string' && PEER_KEY.test(m.project) && (m.kind === 'claude' || m.kind === 'codex') && (m.session === undefined || (typeof m.session === 'string' && SESSION_ID.test(m.session)))
				? { type: 'chatOpen', project: m.project, kind: m.kind, ...(m.session === undefined ? {} : { session: m.session }) } : undefined;
		case 'chatPrompt':
			return chat !== undefined && typeof m.text === 'string' && m.text.trim().length > 0 && m.text.length <= MAX_REPLY ? { type: 'chatPrompt', chat, text: m.text } : undefined;
		case 'chatCancel':
			return chat !== undefined ? { type: 'chatCancel', chat } : undefined;
		case 'chatAnswer':
			return chat !== undefined && isIndex(m.req, 1e9) && isIndex(m.option, 20) ? { type: 'chatAnswer', chat, req: m.req, option: m.option } : undefined;
		case 'chatSet':
			return chat !== undefined && typeof m.config === 'string' && m.config.length > 0 && m.config.length <= 64 && typeof m.value === 'string' && m.value.length <= MAX_CHAT ? { type: 'chatSet', chat, config: m.config, value: m.value } : undefined;
		// The chat settings link belongs to the dock only.
		case 'chat':
			return undefined;
		default: {
			const d = dockAction(raw);
			return d && d.type !== 'chat' ? d : undefined;
		}
	}
}
