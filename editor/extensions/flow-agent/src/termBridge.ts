/*---------------------------------------------------------------------------------------------
 *  Insilode: the bridge between an agent's real terminal and a pane of the Agents page. The terminal stays a VS Code terminal (it survives a
 *  reload of the window and the hooks keep tracking it); the page draws a copy of it: the output is replayed and streamed to the page,
 *  its keystrokes are typed into the terminal, and the terminal takes the pane's size. Everything vscode is injected (TermEnv, built in
 *  termHost.ts), so this is tested on its own (test/termBridge.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import { TermBuffer } from './termBuffer';

/** Live output goes out at most this often per session, or as soon as this much is waiting. */
export const FLUSH_MS = 16;
export const FLUSH_BYTES = 64 * 1024;
/** The sizes the core command accepts (editor/patches/flow-core.patch, `_insilode.terminal.setDimensions`). */
export const MIN_COLS = 2;
export const MAX_COLS = 500;
export const MIN_ROWS = 1;
export const MAX_ROWS = 300;

export interface TermTerminal {
	readonly processId: PromiseLike<number | undefined>;
	sendText(text: string, shouldExecute?: boolean): void;
}

export interface TermEnv {
	/** The terminal of an agent session; nothing for an unknown session or one whose terminal is closed. */
	terminalOf(id: string): TermTerminal | undefined;
	/** Whether text typed now would reach the agent (its session has not ended: a shell may be all that is left behind it). */
	typable(id: string): boolean;
	/** The core command: the exact size of the terminal with this process id, or its own size again when both are undefined. */
	setDimensions(processId: number, cols: number | undefined, rows: number | undefined): PromiseLike<unknown>;
}

/** Where one attachment's output goes. `data` with `reset` replaces what the pane drew; `gone`: the terminal closed. */
export interface TermSink {
	data(chunk: string, reset?: boolean): void;
	gone(): void;
}

export interface TermAttachment {
	/** Everything the terminal printed that the buffer still holds, to draw before the live chunks. */
	replay: string;
	/** Stops the live chunks; the last one to leave gives the terminal its own size back. */
	detach(): void;
}

export const validSize = (cols: unknown, rows: unknown): boolean =>
	typeof cols === 'number' && Number.isInteger(cols) && cols >= MIN_COLS && cols <= MAX_COLS
	&& typeof rows === 'number' && Number.isInteger(rows) && rows >= MIN_ROWS && rows <= MAX_ROWS;

export class TermBridge {
	private readonly buffers = new Map<string, TermBuffer>();
	private readonly sinks = new Map<string, Set<TermSink>>();
	/** Output of a session that its sinks have not been given yet, and the timer that gives it. */
	private readonly pending = new Map<string, { chunks: string[]; size: number; timer?: ReturnType<typeof setTimeout> }>();
	/** The size a pane gave each session's terminal, while a pane is attached: it moves to a new terminal when the session is resumed in one. */
	private readonly sizes = new Map<string, { cols: number; rows: number }>();
	/** Counts the size changes of a session: a resize whose process id arrives after a newer one (or a detach) is stale. */
	private readonly sizeSeq = new Map<string, number>();

	constructor(private readonly env: TermEnv) {}

	/** Output of the session's terminal, as it was written. */
	write(id: string, data: string): void {
		if (!data) {
			return;
		}
		let buffer = this.buffers.get(id);
		if (!buffer) {
			this.buffers.set(id, buffer = new TermBuffer());
		}
		buffer.push(data);
		if (!this.sinks.get(id)?.size) {
			return;
		}
		let p = this.pending.get(id);
		if (!p) {
			this.pending.set(id, p = { chunks: [], size: 0 });
		}
		p.chunks.push(data);
		p.size += data.length;
		if (p.size >= FLUSH_BYTES) {
			this.flush(id);
		} else {
			p.timer ??= setTimeout(() => this.flush(id), FLUSH_MS);
		}
	}

	private flush(id: string): void {
		const p = this.pending.get(id);
		if (!p) {
			return;
		}
		clearTimeout(p.timer);
		this.pending.delete(id);
		const data = p.chunks.join('');
		for (const sink of [...this.sinks.get(id) ?? []]) {
			sink.data(data);
		}
	}

	/**
	 * A new terminal now runs the session (it was resumed while the old one stayed open): what the old one printed goes, and so does the
	 * size the pane gave the old terminal: `previous` is given its own back and the new one (the env's terminalOf) takes the pane's.
	 */
	restart(id: string, previous?: TermTerminal): void {
		this.dropPending(id);
		this.buffers.get(id)?.clear();
		for (const sink of [...this.sinks.get(id) ?? []]) {
			sink.data('', true);
		}
		const size = this.sizes.get(id);
		if (!size) {
			return;
		}
		void Promise.resolve(previous?.processId).catch(() => undefined).then(pid => pid === undefined ? undefined : this.env.setDimensions(pid, undefined, undefined)).catch(() => undefined);
		void this.setSize(id, size.cols, size.rows);
	}

	/** The session's terminal closed: its output is freed and every attachment is told. */
	end(id: string): void {
		this.dropPending(id);
		this.buffers.delete(id);
		this.sizeSeq.delete(id);
		this.sizes.delete(id);
		const sinks = this.sinks.get(id);
		this.sinks.delete(id);
		for (const sink of sinks ?? []) {
			sink.gone();
		}
	}

	private dropPending(id: string) {
		clearTimeout(this.pending.get(id)?.timer);
		this.pending.delete(id);
	}

	/** Nothing for a session with no terminal. Several attachments to one session are fine. */
	attach(id: string, sink: TermSink): TermAttachment | undefined {
		if (!this.env.terminalOf(id)) {
			return undefined;
		}
		// What is still waiting goes to the sinks that were there first: the new one gets it in the replay, and must not get it twice.
		this.flush(id);
		let set = this.sinks.get(id);
		if (!set) {
			this.sinks.set(id, set = new Set());
		}
		set.add(sink);
		let done = false;
		return {
			replay: this.buffers.get(id)?.text() ?? '',
			detach: () => {
				if (done) {
					return;
				}
				done = true;
				const now = this.sinks.get(id);
				if (!now?.delete(sink) || now.size) {
					return;
				}
				this.sinks.delete(id);
				this.dropPending(id);
				// No pane shows it any more: the terminal goes back to the size of its own view.
				void this.setSize(id, undefined, undefined);
			},
		};
	}

	/** Types into the session's terminal, as keys (no Enter added). False when it cannot take it. */
	input(id: string, data: string): boolean {
		const t = this.env.terminalOf(id);
		if (!t || !data || !this.env.typable(id)) {
			return false;
		}
		t.sendText(data, false);
		return true;
	}

	/** The last pane to ask decides the terminal's size. False for a session that nothing is attached to, or an out-of-range size. */
	async resize(id: string, cols: number, rows: number): Promise<boolean> {
		if (!validSize(cols, rows) || !this.sinks.get(id)?.size) {
			return false;
		}
		return this.setSize(id, cols, rows);
	}

	private async setSize(id: string, cols: number | undefined, rows: number | undefined): Promise<boolean> {
		const seq = (this.sizeSeq.get(id) ?? 0) + 1;
		this.sizeSeq.set(id, seq);
		if (cols === undefined || rows === undefined) {
			this.sizes.delete(id);
		} else {
			this.sizes.set(id, { cols, rows });
		}
		const t = this.env.terminalOf(id);
		const pid = t ? await Promise.resolve(t.processId).catch(() => undefined) : undefined;
		if (pid === undefined || this.sizeSeq.get(id) !== seq) {
			return false;
		}
		return (await Promise.resolve(this.env.setDimensions(pid, cols, rows)).catch(() => false)) === true;
	}

	dispose(): void {
		for (const id of [...this.pending.keys()]) {
			this.dropPending(id);
		}
		this.buffers.clear();
		this.sinks.clear();
		this.sizes.clear();
	}
}
