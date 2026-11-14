/*---------------------------------------------------------------------------------------------
 *  Insilode: the rule that keeps `Agents.spawn` from taking over a session id that something still runs. Pure (no vscode): tested on its
 *  own (test/spawnGuard.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/**
 * Whether a resumed session's id is taken: a session of this window has it, its CLI has not ended and its terminal is open. A session
 * whose CLI ended but whose shell stayed open is not taken: resuming it opens a new terminal, and the page's bridge moves over to it.
 */
export function idInUse(existing: { state: string } | undefined, hasTerminal: boolean): boolean {
	return !!existing && existing.state !== 'ended' && hasTerminal;
}

/** What the user is told when a Claude session that some live process runs (the registry in liveSessions.ts says so) is asked to resume: where it runs, and what to do. */
export function elsewhereMessage(name: string, where: { source: string; pid: number }): string {
	return `${name || 'That session'} is running in ${where.source} (process ${where.pid}), not started a second time: two processes on one conversation corrupt it. Close it there first.`;
}
