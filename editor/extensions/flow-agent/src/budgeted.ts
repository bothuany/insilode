/*---------------------------------------------------------------------------------------------
 *  Insilode: a reader with a time budget whose file work cannot be cancelled. A read on a hung (network) mount never settles; the budget
 *  lets the caller go on without it, but the work still holds one of libuv's few threads. Starting another run each poll would stack up
 *  stuck work until every file read in the extension host waits. So while the work of an earlier run has not settled, a call starts nothing
 *  and gets the last result. No vscode: tested on its own (test/budgeted.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** `A` is what a run collects while it works, `T` what a caller gets (made from it by `finish`). */
export class Budgeted<A, T> {
	private busy = false;

	constructor(private last: T) {}

	/** Runs `work` into a fresh accumulator and waits for it at most `budgetMs`; what it has collected by then (or `last`, when an earlier run is still going) is returned. */
	async run(budgetMs: number, work: (acc: A) => Promise<unknown>, fresh: () => A, finish: (acc: A) => T): Promise<T> {
		if (this.busy) {
			return this.last;
		}
		this.busy = true;
		const acc = fresh();
		// A run that outlives its budget still improves the result for the next caller when it does settle.
		const done = (async () => work(acc))().catch(() => undefined).then(() => {
			this.busy = false;
			this.last = finish(acc);
		});
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([done, new Promise<void>(resolve => timer = setTimeout(resolve, budgetMs))]);
		clearTimeout(timer);
		return this.last = finish(acc);
	}
}
