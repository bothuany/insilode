/*---------------------------------------------------------------------------------------------
 *  Insilode: edits an agent made through a shell command (sed, a formatter, a generator), which no edit tool reports.
 *  At the end of a turn, `git status --porcelain` (an argument array, never a shell) is compared with the status at the
 *  turn's start: files that changed in between and that no edit tool named are reported to flow-view as "changed by a
 *  command". The pure part (diffing two status lists, merging into a turn) lives apart from the process call, with tests.
 *--------------------------------------------------------------------------------------------*/

/** Remembers each session's git status at the start of its turn and lists what a command changed by the end of it. */
export class ShellEditSweep {
	/** Records the status at the start of the turn. A stub until the edits part fills it. */
	async begin(_session: string, _cwd: string | undefined): Promise<void> { }

	/** The files changed during the turn that no edit tool named (`reported` is what the tools named). A stub until the edits part fills it. */
	async end(_session: string, _cwd: string | undefined, _reported: ReadonlySet<string>): Promise<string[]> {
		return [];
	}
}
