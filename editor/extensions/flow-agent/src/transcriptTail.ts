/*---------------------------------------------------------------------------------------------
 *  Insilode: the last messages of an agent's conversation, read from its transcript (Claude Code's jsonl, Codex's
 *  rollout), for the Agents page's detail panel. Read-only and shortened. Stub of the contract: built in its own change.
 *--------------------------------------------------------------------------------------------*/

import type { TailEntry } from './agentsData';

/** At most `max` entries, oldest first, parsed from the transcript's lines. Pure. */
export function tailEntries(lines: string[], cli: 'claude' | 'codex', max: number): TailEntry[] {
	void lines;
	void cli;
	void max;
	return [];
}

/** Reads only the end of the file (never the whole of a long transcript) and parses it with tailEntries. */
export async function readTail(file: string, cli: 'claude' | 'codex', max: number): Promise<TailEntry[]> {
	void file;
	return tailEntries([], cli, max);
}
