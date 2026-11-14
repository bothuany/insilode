/*---------------------------------------------------------------------------------------------
 *  Insilode: the replay buffer of one agent terminal. The Agents page mirrors an agent's terminal in a pane of its own, and a pane that
 *  opens later (or after a reload of the page) must show what the terminal already printed: this keeps the raw output, bounded.
 *  Pure (no vscode): tested on its own (test/termBuffer.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** About one megabyte of output (UTF-16 units) per agent. */
export const MAX_TERM_BUFFER = 1 << 20;

/**
 * Raw terminal output as the chunks it arrived in. When it grows past the cap the oldest chunks go, whole: a chunk is never cut, so a
 * single chunk bigger than the cap stays until a newer one arrives. (A chunk boundary can still fall inside an escape sequence: the
 * terminal that replays it ignores a broken sequence at the start.)
 */
export class TermBuffer {
	private chunks: string[] = [];
	/** The first chunk still held: dropping moves this on, and the array is compacted now and then, so a drop is not a shift of the whole array. */
	private head = 0;
	private size = 0;

	constructor(private readonly cap = MAX_TERM_BUFFER) {}

	get length(): number {
		return this.size;
	}

	push(data: string): void {
		if (!data) {
			return;
		}
		this.chunks.push(data);
		this.size += data.length;
		while (this.size > this.cap && this.chunks.length - this.head > 1) {
			this.size -= this.chunks[this.head].length;
			this.chunks[this.head++] = '';
		}
		if (this.head > 1024 && this.head * 2 > this.chunks.length) {
			this.chunks = this.chunks.slice(this.head);
			this.head = 0;
		}
	}

	text(): string {
		return this.chunks.slice(this.head).join('');
	}

	clear(): void {
		this.chunks = [];
		this.head = 0;
		this.size = 0;
	}
}
