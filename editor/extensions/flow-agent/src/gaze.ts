/*---------------------------------------------------------------------------------------------
 *  Insilode: the agent's gaze. An agent's Read, Edit and search tool calls (hook events from a
 *  terminal agent, tool calls from an ACP session) become `AgentLook`s: a file and lines,
 *  never content, search text or commands. They are throttled per session and handed to
 *  flow-view (`flow.agent.gaze`), which paints them on a flow canvas that is already open.
 *  Pure: no vscode, so the rules are tested on their own (test/gaze.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { patchFiles } from './patch';

/** flow-agent's own copy of the shape: it does not import protocol/, and flow-view maps it to the canvas's GazeEvent. */
export interface AgentLook {
	session: string;
	/** The agent's name in the dock. */
	agent: string;
	/** The agent's dock colour. */
	color: string;
	act: 'read' | 'edit' | 'search';
	/** An absolute path; for a search, the folder searched. */
	file: string;
	startLine?: number;
	endLine?: number;
	/** Counts the session's prompts: flow-view replays the events of the latest one. */
	turn: number;
	at: number;
}

/** One send to flow-view. `burst`: more than BURST_AT events arrived in one second, so the canvas need not animate each one. */
export interface GazeBatch {
	looks: AgentLook[];
	burst?: boolean;
}

/** The agent colours of the dock's avatars (the COL map in avatars.ts, which keeps them inside its page script). */
export const GAZE_COLOR: Record<string, string> = { claude: '#ff9d7d', codex: '#7fe0d6', custom: '#c6a8ff' };

/** Who is looking: the session and how the dock shows it. */
export interface Looker {
	session: string;
	agent: string;
	color: string;
	turn: number;
}

/** Path segments whose files are tooling, not the code a reader follows. */
const SKIP = new Set(['node_modules', '.git', 'out', '.claude']);

const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The absolute path when it lies inside one of `roots` and outside the skipped folders, else nothing. Case is ignored on
 * Windows only, where `C:\x` and `c:\x` are one folder.
 */
export function keep(file: string, roots: readonly string[], cwd?: string): string | undefined {
	if (!file || file.includes('\0')) {
		return undefined;
	}
	const abs = path.resolve(cwd ?? roots[0] ?? '', file);
	const fold = (p: string) => process.platform === 'win32' ? p.toLowerCase() : p;
	for (const root of roots) {
		const rel = path.relative(fold(path.resolve(root)), fold(abs));
		if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
			return rel.split(/[\\/]/).some(seg => SKIP.has(seg)) ? undefined : abs;
		}
	}
	return undefined;
}

type Raw = Omit<AgentLook, keyof Looker | 'at'>;

/** The lines an Edit changed, from its structured patch: the hunk's new range, without its context lines. Reads only the first character of each line. */
function editedLines(response: Record<string, unknown>): { startLine: number; endLine: number } | undefined {
	const hunks = Array.isArray(response.structuredPatch) ? response.structuredPatch.filter(obj) : [];
	let start = Infinity;
	let end = 0;
	for (const h of hunks) {
		if (!whole(h.newStart)) {
			continue;
		}
		const lines = Array.isArray(h.lines) ? h.lines : [];
		let line = h.newStart;
		for (const l of lines) {
			const mark = typeof l === 'string' ? l[0] : ' ';
			// A removal sits between the lines around it: it counts at the line that now follows, which it does not move past.
			if (mark === '+' || mark === '-') {
				start = Math.min(start, line);
				end = Math.max(end, line);
			}
			if (mark !== '-') {
				line++;
			}
		}
		if (!lines.length && typeof h.newLines === 'number') {
			start = Math.min(start, h.newStart);
			end = Math.max(end, h.newStart + Math.max(0, h.newLines - 1));
		}
	}
	return end >= start && start !== Infinity ? { startLine: start, endLine: end } : undefined;
}

/** The lines a Read covered: offset/limit as asked, or what the response says it returned. A whole-file read has none. */
function readLines(input: Record<string, unknown>, response: Record<string, unknown>): { startLine?: number; endLine?: number } {
	const file = obj(response.file) ? response.file : {};
	const start = whole(input.offset) ? input.offset : whole(file.startLine) ? file.startLine : undefined;
	const count = whole(file.numLines) ? file.numLines : whole(input.limit) ? input.limit : undefined;
	if (start === undefined && count === undefined) {
		return {};
	}
	const from = start ?? 1;
	if (from === 1 && whole(file.totalLines) && count !== undefined && count >= file.totalLines) {
		return {};
	}
	return count === undefined ? { startLine: from } : { startLine: from, endLine: from + count - 1 };
}

/**
 * What a terminal agent's PostToolUse hook event looked at. Only the path and line numbers are copied out: `tool_response`
 * carries the file's content and a search carries its pattern, and neither may leave this function.
 */
export function looksFromHook(tool: string, input: Record<string, unknown> = {}, response: Record<string, unknown> = {}, cwd: string | undefined, roots: readonly string[]): Raw[] {
	const str = (v: unknown) => typeof v === 'string' ? v : undefined;
	const one = (act: Raw['act'], file: string | undefined, lines: { startLine?: number; endLine?: number } = {}): Raw[] => {
		const abs = file ? keep(file, roots, cwd) : undefined;
		return abs ? [{ act, file: abs, ...lines }] : [];
	};
	switch (tool) {
		case 'Read':
			return one('read', str(input.file_path), readLines(input, response));
		case 'Edit':
		case 'MultiEdit':
			return one('edit', str(input.file_path), editedLines(response));
		case 'Write':
			return one('edit', str(input.file_path));
		case 'NotebookEdit':
			return one('edit', str(input.notebook_path));
		case 'Grep':
		case 'Glob':
			// The folder only: the pattern, glob and type filters say what the agent looks for, and stay out.
			return one('search', str(input.path) ?? cwd);
		case 'apply_patch':
			return patchFiles(input, cwd).flatMap(f => one('edit', f));
		default:
			return [];
	}
}

/**
 * Files a shell command changed during a turn (shellEdits.ts) look like any other edit on the canvas: a file, no lines (the
 * command's diff is not known here), and no content. The same roots and skipped folders apply as to an Edit tool.
 */
export function looksFromCommandEdits(files: readonly string[], roots: readonly string[]): Raw[] {
	return files.flatMap(f => {
		const abs = keep(f, roots);
		return abs ? [{ act: 'edit' as const, file: abs }] : [];
	});
}

/** ACP tool kinds that look at code; the rest (execute, fetch, think, other) are not gaze. */
const ACP_ACT: Record<string, Raw['act']> = { read: 'read', edit: 'edit', delete: 'edit', move: 'edit', search: 'search' };

/** What an ACP tool call looked at: its kind and locations. Never its title, which can hold the search text. */
export function looksFromAcp(kind: string | null | undefined, locations: readonly { path?: unknown; line?: unknown }[] | null | undefined, roots: readonly string[]): Raw[] {
	const act = kind ? ACP_ACT[kind] : undefined;
	if (!act) {
		return [];
	}
	return (locations ?? []).flatMap(l => {
		const abs = typeof l.path === 'string' && path.isAbsolute(l.path) ? keep(l.path, roots) : undefined;
		return abs ? [{ act, file: abs, ...(whole(l.line) && act !== 'search' ? { startLine: l.line } : {}) }] : [];
	});
}

/** Same file within this many ms: one look (a range of reads becomes one). */
export const COALESCE_MS = 300;
/** At most four batches a second. */
export const BATCH_MS = 250;
export const BURST_AT = 20;

/**
 * Per session, looks at one file within COALESCE_MS merge into one (their line ranges joined); batches leave at most every
 * BATCH_MS. `now` and `later` are injected so tests run without real time.
 */
export class GazeQueue {
	private queue: AgentLook[] = [];
	private timer: unknown;
	/** When the looks of the last second arrived, to tell a burst. */
	private recent: number[] = [];
	private last = -Infinity;

	constructor(
		private readonly send: (batch: GazeBatch) => void,
		private readonly now: () => number = Date.now,
		private readonly later: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
		private readonly cancel: (t: unknown) => void = t => clearTimeout(t as NodeJS.Timeout),
	) { }

	push(who: Looker, raws: readonly Raw[]) {
		const at = this.now();
		for (const r of raws) {
			this.recent.push(at);
			const look: AgentLook = { ...who, ...r, at };
			let prev: AgentLook | undefined;
			for (let i = this.queue.length - 1; i >= 0 && !prev; i--) {
				prev = this.queue[i].session === look.session && this.queue[i].file === look.file ? this.queue[i] : undefined;
			}
			if (prev && prev.act === look.act && at - prev.at <= COALESCE_MS && near(prev, look)) {
				merge(prev, look);
			} else {
				this.queue.push(look);
			}
		}
		this.recent = this.recent.filter(t => at - t < 1000);
		this.schedule(at);
	}

	private schedule(at: number) {
		if (this.timer !== undefined || !this.queue.length) {
			return;
		}
		// A look waits COALESCE_MS for the reads that follow it, so a run of them leaves as one.
		this.timer = this.later(() => this.flush(), Math.max(this.last + BATCH_MS - at, COALESCE_MS));
	}

	/** Sends what is queued now. */
	flush() {
		if (this.timer !== undefined) {
			this.cancel(this.timer);
			this.timer = undefined;
		}
		if (!this.queue.length) {
			return;
		}
		const looks = this.queue;
		this.queue = [];
		this.last = this.now();
		this.send(this.recent.length > BURST_AT ? { looks, burst: true } : { looks });
	}

	dispose() {
		if (this.timer !== undefined) {
			this.cancel(this.timer);
		}
		this.timer = undefined;
		this.queue = [];
	}
}

/** Ranges this far apart stay two looks: joined, they would cover every method in between. */
const NEAR_LINES = 20;

function near(a: AgentLook, b: AgentLook) {
	if (a.startLine === undefined || b.startLine === undefined) {
		return true;
	}
	return b.startLine <= (a.endLine ?? a.startLine) + NEAR_LINES && a.startLine <= (b.endLine ?? b.startLine) + NEAR_LINES;
}

/** Two looks at one file become one: the lines both covered; no lines (the whole file) wins. */
function merge(into: AgentLook, look: AgentLook) {
	into.at = look.at;
	if (into.startLine === undefined || look.startLine === undefined) {
		delete into.startLine;
		delete into.endLine;
		return;
	}
	const end = Math.max(into.endLine ?? into.startLine, look.endLine ?? look.startLine);
	into.startLine = Math.min(into.startLine, look.startLine);
	into.endLine = end;
}
