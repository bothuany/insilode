/*---------------------------------------------------------------------------------------------
 *  Insilode: two settings that were named `flowAgent.*` while every other one is `flow.agents.*`. A value the user wrote
 *  under the old name is copied to the new one once and the old key removed from their user settings.json.
 *
 *  Pure (no vscode): `read` is `getConfiguration().inspect(key)`, the result is what to write. Only the user's own
 *  (global) value moves: a workspace's value never does, so a repository cannot get the bypass setting switched on this way. A
 *  value of the old name set only in WORKSPACE settings (`flowAgent.agentsPage.location` in a .vscode/settings.json) is therefore
 *  not migrated and must be renamed by hand.
 *--------------------------------------------------------------------------------------------*/

export interface Inspected {
	globalValue?: unknown;
	workspaceValue?: unknown;
	workspaceFolderValue?: unknown;
}

export interface Rename {
	from: string;
	to: string;
	/** Only a value the new setting accepts is moved; anything else stays under the old key, which nothing reads any more. */
	valid: (value: unknown) => boolean;
}

export const RENAMED_SETTINGS: readonly Rename[] = [
	{ from: 'flowAgent.agentsPage.location', to: 'flow.agents.page.location', valid: v => v === 'window' || v === 'tab' },
	{ from: 'flowAgent.claude.allowBypassPermissions', to: 'flow.agents.claude.allowBypassPermissions', valid: v => typeof v === 'boolean' },
];

export interface Move {
	from: string;
	to: string;
	value: unknown;
}

/** The moves to make now: the old key has a user value the new key accepts and the new key has none of its own. */
export function settingMoves(read: (key: string) => Inspected | undefined): Move[] {
	const moves: Move[] = [];
	for (const { from, to, valid } of RENAMED_SETTINGS) {
		const value = read(from)?.globalValue;
		if (value !== undefined && valid(value) && read(to)?.globalValue === undefined) {
			moves.push({ from, to, value });
		}
	}
	return moves;
}
