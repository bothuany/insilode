/*---------------------------------------------------------------------------------------------
 *  Insilode: a reader with a time budget whose file work cannot be cancelled. A read on a hung (network) mount never settles; the budget
 *  lets the caller go on without it, but the work still holds one of libuv's few threads. Starting another run each poll would stack up
 *  stuck work until every file read in the extension host waits. So while the work of an earlier run has not settled, a call starts nothing:
 *  it waits for that run for its own budget and gets what the run found, or the last result when the run is still stuck. Waiting matters to
 *  the resume check, which must not answer from a list taken before the poll in flight began. No vscode: tested on its own
 *  (test/budgeted.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** `A` is what a run collects while it works, `T` what a caller gets (made from it by `finish`). */
export class Budgeted<A, T> {
	private pending: Promise<void> | undefined;

	constructor(private last: T) {}

	/** Runs `work` into a fresh accumulator and waits for it at most `budgetMs`; what it has collected by then (or `last`, when an earlier run is still going) is returned. */
	async run(budgetMs: number, work: (acc: A) => Promise<unknown>, fresh: () => A, finish: (acc: A) => T): Promise<T> {
		if (this.pending) {
			await this.within(this.pending, budgetMs);
			return this.last;
		}
		const acc = fresh();
		// A run that outlives its budget still improves the result for the next caller when it does settle.
		const done = this.pending = (async () => work(acc))().catch(() => undefined).then(() => {
			this.pending = undefined;
			this.last = finish(acc);
		});
		await this.within(done, budgetMs);
		return this.last = finish(acc);
	}

	private async within(done: Promise<void>, budgetMs: number): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([done, new Promise<void>(resolve => timer = setTimeout(resolve, budgetMs))]);
		clearTimeout(timer);
	}
}
