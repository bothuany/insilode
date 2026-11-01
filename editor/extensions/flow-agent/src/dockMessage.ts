/*---------------------------------------------------------------------------------------------
 *  Insilode: what the Agents dock page may ask the host for. The page is not trusted: each message is
 *  checked here for its type and the shape of every field, and only then becomes one of these
 *  actions; anything else is dropped. Pure (no vscode), so the routing is tested on its own
 *  (test/dockMessage.test.mjs); dock.ts carries the actions out.
 *--------------------------------------------------------------------------------------------*/


/** What the page may ask for on a worktree row; anything else is ignored. */
export const WORKTREE_ACTIONS = ['open', 'diff', 'merge', 'remove'] as const;
export type WorktreeAction = typeof WORKTREE_ACTIONS[number];

export type DockAction =
	| { type: 'ready' }
	/** Only the two built-in agents start from the page: your own commands go through "Start an Agent…". */
	| { type: 'new'; cli: 'claude' | 'codex' }
	| { type: 'show' | 'pr' | 'xray' | 'forget' | 'compact' | 'rename' | 'explain' | 'swap'; id: string }
	/** An index into the impact list the host sent: the page never names a flow itself. */
	| { type: 'flow'; id: string; index: number }
	/** The page names the row and one of four actions; the folder and branches come from the host's own record. */
	| { type: 'wt'; id: string; action: WorktreeAction }
	| { type: 'pick' | 'chat' }
	/** An agent's Skeleton button: skeleton first on or off for that agent. */
	| { type: 'sk'; id: string; on: boolean };

const MAX_ID = 200;
const ID_TYPES = new Set(['show', 'pr', 'xray', 'forget', 'compact', 'rename', 'explain', 'swap']);

export function dockAction(raw: unknown): DockAction | undefined {
	const m = raw as Record<string, unknown> | null;
	if (!m || typeof m !== 'object' || typeof m.type !== 'string') {
		return undefined;
	}
	const id = typeof m.id === 'string' && m.id.length <= MAX_ID ? m.id : undefined;
	switch (m.type) {
		case 'ready':
		case 'pick':
		case 'chat':
			return { type: m.type };
		case 'new':
			return m.cli === 'claude' || m.cli === 'codex' ? { type: 'new', cli: m.cli } : undefined;
		case 'flow':
			return id !== undefined && typeof m.index === 'number' && Number.isInteger(m.index) && m.index >= 0 ? { type: 'flow', id, index: m.index } : undefined;
		case 'sk':
			return id !== undefined && typeof m.on === 'boolean' ? { type: 'sk', id, on: m.on } : undefined;
		case 'wt':
			return id !== undefined && WORKTREE_ACTIONS.includes(m.action as WorktreeAction) ? { type: 'wt', id, action: m.action as WorktreeAction } : undefined;
		default:
			return id !== undefined && ID_TYPES.has(m.type) ? { type: m.type as 'show', id } : undefined;
	}
}
