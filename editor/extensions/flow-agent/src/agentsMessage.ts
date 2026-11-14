/*---------------------------------------------------------------------------------------------
 *  Insilode: what the Agents page may ask the host for. The page is not trusted: each message is checked here for its
 *  type and the shape of every field, and only then becomes one of these actions; anything else is dropped. The row and
 *  worktree actions are the dock's own (dockMessage.ts), so both views offer the same things. Pure (no vscode):
 *  tested on its own (test/agentsMessage.test.mjs); agentsPanel.ts carries the actions out.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { dockAction, type DockAction } from './dockMessage';
import { layoutName, parse, type PaneLayout } from './paneLayout';
import { MAX_QUERY, MIN_QUERY } from './sessionSearch';
import { MAX_COLS, MAX_ROWS, MIN_COLS, MIN_ROWS } from './termBridge';

/** The most keystrokes (or pasted text) one termInput carries, and the longest folder or request id a termOpen names. */
export const MAX_TERM_INPUT = 64 * 1024;
const MAX_PATH = 1024;
const MAX_REQUEST = 100;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentsAction =
	| Exclude<DockAction, { type: 'chat' }>
	/** The last messages of an agent's conversation, for a transcript pane. */
	| { type: 'tail'; id: string }
	/** One of the user's own agents from the New menu, by its index in the `customs` list the host sent and its name (the list may have changed since). */
	| { type: 'custom'; index: number; name: string }
	/** The kept worktrees' quick pick (Agents: Kept Worktrees…). */
	| { type: 'kept' }
	/** The sidebar's earlier sessions across the machine (projectIndex.ts) and the search through them. */
	| { type: 'chatList' }
	/** Past sessions whose conversation contains the text, across the projects the host lists (sessionSearch.ts). */
	| { type: 'chatSearch'; query: string }
	/**
	 * The page's terminal panes (termBridge.ts). `id` is an agent session id from the rows. Attach: replay the terminal's output and stream the
	 * rest; input: raw keystrokes; resize: the pane's size in cells.
	 */
	| { type: 'termAttach'; id: string }
	| { type: 'termDetach'; id: string }
	| { type: 'termInput'; id: string; data: string }
	| { type: 'termResize'; id: string; cols: number; rows: number }
	/**
	 * Open an agent in a terminal pane (termHost.ts): `sessionId` resumes that session, none starts a new one; in `cwd` (an absolute path; one
	 * outside this window's workspace is asked about once) or this window's folder. `requestId` is the page's, echoed in the answer.
	 */
	| { type: 'termOpen'; requestId: string; kind: 'claude' | 'codex'; sessionId?: string; cwd?: string }
	/**
	 * The page's pane layout (paneLayout.ts, layoutStore.ts). `layoutSave` is the layout on screen, for the page to come back to; `layoutSaveAs` and
	 * `layoutDelete` keep the layouts the user names. The layouts are validated here, so what reaches storage is always sound.
	 */
	| { type: 'layoutSave'; layout: PaneLayout }
	| { type: 'layoutSaveAs'; name: string; layout: PaneLayout }
	| { type: 'layoutDelete'; name: string };

/** An integer in [min, max]. */
const isRange = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

export function agentsAction(raw: unknown): AgentsAction | undefined {
	const m = raw as Record<string, unknown> | null;
	if (!m || typeof m !== 'object' || typeof m.type !== 'string') {
		return undefined;
	}
	const id = typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 ? m.id : undefined;
		switch (m.type) {
		case 'tail':
			return id !== undefined ? { type: 'tail', id } : undefined;
		case 'custom':
			return typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 && m.index < 100 && typeof m.name === 'string' && m.name.length <= 200 ? { type: 'custom', index: m.index, name: m.name } : undefined;
		case 'kept':
			return { type: 'kept' };
		case 'chatList':
			return { type: 'chatList' };
		case 'chatSearch':
			return typeof m.query === 'string' && m.query.trim().length >= MIN_QUERY && m.query.length <= MAX_QUERY ? { type: 'chatSearch', query: m.query } : undefined;
		case 'termAttach':
			return id !== undefined ? { type: 'termAttach', id } : undefined;
		case 'termDetach':
			return id !== undefined ? { type: 'termDetach', id } : undefined;
		case 'termInput':
			return id !== undefined && typeof m.data === 'string' && m.data.length > 0 && m.data.length <= MAX_TERM_INPUT ? { type: 'termInput', id, data: m.data } : undefined;
		case 'termResize':
			return id !== undefined && isRange(m.cols, MIN_COLS, MAX_COLS) && isRange(m.rows, MIN_ROWS, MAX_ROWS) ? { type: 'termResize', id, cols: m.cols, rows: m.rows } : undefined;
		case 'termOpen':
			return typeof m.requestId === 'string' && m.requestId.length > 0 && m.requestId.length <= MAX_REQUEST && (m.kind === 'claude' || m.kind === 'codex')
				&& (m.sessionId === undefined || (typeof m.sessionId === 'string' && SESSION_ID.test(m.sessionId)))
				&& (m.cwd === undefined || (typeof m.cwd === 'string' && m.cwd.length <= MAX_PATH && !m.cwd.includes('\0') && path.isAbsolute(m.cwd)))
				? { type: 'termOpen', requestId: m.requestId, kind: m.kind, ...(m.sessionId === undefined ? {} : { sessionId: m.sessionId }), ...(m.cwd === undefined ? {} : { cwd: m.cwd }) } : undefined;
		case 'layoutSave': {
			const layout = parse(m.layout);
			return layout ? { type: 'layoutSave', layout } : undefined;
		}
		case 'layoutSaveAs': {
			const layout = parse(m.layout);
			const name = layoutName(m.name);
			return layout?.root && name !== undefined ? { type: 'layoutSaveAs', name, layout } : undefined;
		}
		case 'layoutDelete': {
			const name = layoutName(m.name);
			return name !== undefined ? { type: 'layoutDelete', name } : undefined;
		}
		// The chat settings link belongs to the dock only.
		case 'chat':
			return undefined;
		default: {
			const d = dockAction(raw);
			return d && d.type !== 'chat' ? d : undefined;
		}
	}
}
