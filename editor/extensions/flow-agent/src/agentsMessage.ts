/*---------------------------------------------------------------------------------------------
 *  Insilode: what the Agents page may ask the host for. The page is not trusted: each message is checked here for its
 *  type and the shape of every field, and only then becomes one of these actions; anything else is dropped. The row and
 *  worktree actions are the dock's own (dockMessage.ts), so both views offer the same things. Pure (no vscode):
 *  tested on its own (test/agentsMessage.test.mjs); agentsPanel.ts carries the actions out.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { dockAction, type DockAction } from './dockMessage';
import { panelState, type HarnessPanelState } from './layoutStore';
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
	/**
	 * The last messages of an agent's conversation, for a transcript pane. `kind` (with a uuid `id`) names a session of the sidebar's index,
	 * including one another program runs (liveSessions.ts): the host finds its transcript itself and answers nothing for an id it does not list.
	 */
	| { type: 'tail'; id: string; kind?: 'claude' | 'codex' }
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
	 * outside this window's workspace only when folderTrust.ts allows it) or this window's folder. `requestId` is the page's, echoed in the answer.
	 */
	/** `force`: "Resume anyway" for a session another process runs; the host still asks the user itself (termHost.ts), so this is only a request. */
	| { type: 'termOpen'; requestId: string; kind: 'claude' | 'codex'; sessionId?: string; cwd?: string; force?: true }
	/**
	 * The launcher's "Other folder…": the host opens a folder dialog and answers with a `folderPicked` for this `requestId` (and for nothing else).
	 * It carries no path: the only way for a folder outside the workspace to become allowed is the user choosing it in that dialog (folderTrust.ts).
	 */
	| { type: 'pickFolder'; requestId: string }
	/**
	 * The page's pane layout (paneLayout.ts, layoutStore.ts). `layoutSave` is the layout on screen, for the page to come back to; `layoutSaveAs` and
	 * `layoutDelete` keep the layouts the user names. The layouts are validated here, so what reaches storage is always sound.
	 */
	| { type: 'layoutSave'; layout: PaneLayout; harness?: HarnessPanelState }
	| { type: 'layoutSaveAs'; name: string; layout: PaneLayout }
	| { type: 'layoutDelete'; name: string }
	/**
	 * The Harness panel (harnessBridge.ts). `harness`: the summary of the project at `cwd` (an absolute path; none means this window's folder), which
	 * the host only gives for a folder the page was given. `harnessOpen`: open a file of the summary last sent for `cwd` (any other path is refused).
	 * `harnessGo`: one of the harness extension's own views, by name: the page never names a command.
	 */
	| { type: 'harness'; cwd?: string }
	| { type: 'harnessOpen'; cwd?: string; file: string; line?: number }
	| { type: 'harnessGo'; target: 'map' | 'hook' };

/** Host → page: the answer to a `pickFolder`; no `path` means the dialog was cancelled or the folder cannot be used. Only the request that asked uses it. */
export interface AgentsPageFolderPicked {
	type: 'folderPicked';
	requestId: string;
	path?: string;
	name?: string;
}

/** Whether `v` is a path the page may name: text of a sane length, no NUL, absolute on `platform` (a drive path or a share on Windows, a leading slash elsewhere). */
export const isPagePath = (v: unknown, platform: NodeJS.Platform = process.platform): v is string =>
	typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH && !v.includes('\0') && (platform === 'win32' ? path.win32 : path.posix).isAbsolute(v);

/**
 * Whether `v` names a network share (or a device path) on Windows. The folder of a `termOpen` is resolved and stat'ed before folderTrust.ts decides
 * about it, and on Windows that alone opens a connection to the server named: a page must not be able to cause one.
 */
export const isNetworkPath = (v: string, platform: NodeJS.Platform = process.platform): boolean => platform === 'win32' && /^[\\/]{2}/.test(v);

const isRequestId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_REQUEST;

/** An absolute path as the page sends one, or undefined. */
const absolutePath = (v: unknown): string | undefined => isPagePath(v) ? v : undefined;

/** An integer in [min, max]. */
const isRange = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

/** The name of a `layoutSaveAs` that `agentsAction` refused, for the host to answer it; undefined for anything else (or a name that is not text). */
export function refusedSaveName(raw: unknown): string | undefined {
	const m = raw as Record<string, unknown> | null;
	if (!m || typeof m !== 'object' || m.type !== 'layoutSaveAs' || typeof m.name !== 'string') {
		return undefined;
	}
	return layoutName(m.name) ?? m.name.slice(0, 60);
}

export function agentsAction(raw: unknown): AgentsAction | undefined {
	const m = raw as Record<string, unknown> | null;
	if (!m || typeof m !== 'object' || typeof m.type !== 'string') {
		return undefined;
	}
	const id = typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 200 ? m.id : undefined;
		switch (m.type) {
		case 'tail':
			if (m.kind === undefined) {
				return id !== undefined ? { type: 'tail', id } : undefined;
			}
			return id !== undefined && (m.kind === 'claude' || m.kind === 'codex') && SESSION_ID.test(id) ? { type: 'tail', id, kind: m.kind } : undefined;
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
		case 'pickFolder':
			return isRequestId(m.requestId) ? { type: 'pickFolder', requestId: m.requestId } : undefined;
		case 'termOpen':
			return typeof m.requestId === 'string' && m.requestId.length > 0 && m.requestId.length <= MAX_REQUEST && (m.kind === 'claude' || m.kind === 'codex')
				&& (m.sessionId === undefined || (typeof m.sessionId === 'string' && SESSION_ID.test(m.sessionId)))
				&& (m.cwd === undefined || (isPagePath(m.cwd) && !isNetworkPath(m.cwd)))
				? { type: 'termOpen', requestId: m.requestId, kind: m.kind, ...(m.sessionId === undefined ? {} : { sessionId: m.sessionId }), ...(m.cwd === undefined ? {} : { cwd: m.cwd }), ...(m.force === true && m.kind === 'claude' && m.sessionId !== undefined ? { force: true as const } : {}) } : undefined;
		case 'layoutSave': {
			const layout = parse(m.layout);
			const harness = panelState(m.harness);
			return layout ? { type: 'layoutSave', layout, ...(harness ? { harness } : {}) } : undefined;
		}
		case 'harness': {
			const cwd = m.cwd === undefined ? undefined : absolutePath(m.cwd);
			return m.cwd === undefined || cwd !== undefined ? { type: 'harness', ...(cwd === undefined ? {} : { cwd }) } : undefined;
		}
		case 'harnessOpen': {
			const cwd = m.cwd === undefined ? undefined : absolutePath(m.cwd);
			const file = absolutePath(m.file);
			const line = m.line === undefined ? undefined : isRange(m.line, 1, 1_000_000) ? m.line : null;
			return file !== undefined && (m.cwd === undefined || cwd !== undefined) && line !== null ? { type: 'harnessOpen', ...(cwd === undefined ? {} : { cwd }), file, ...(line === undefined ? {} : { line }) } : undefined;
		}
		case 'harnessGo':
			return m.target === 'map' || m.target === 'hook' ? { type: 'harnessGo', target: m.target } : undefined;
		case 'layoutSaveAs': {
			const layout = parse(m.layout);
			const name = layoutName(m.name);
			return layout?.root && name !== undefined ? { type: 'layoutSaveAs', name, layout } : undefined;
		}
		case 'layoutDelete': {
			const name = layoutName(m.name);
			return name !== undefined ? { type: 'layoutDelete', name } : undefined;
		}
		// The chat settings link belongs to the dock only; the context X-ray is gone from the product, so a page that still asks for it is ignored.
		case 'chat':
		case 'xray':
			return undefined;
		default: {
			const d = dockAction(raw);
			return d && d.type !== 'chat' ? d : undefined;
		}
	}
}
