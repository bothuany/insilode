/*---------------------------------------------------------------------------------------------
 *  Insilode board: what the user did to a canvas board by hand (moved an element, pinned a note), kept per board id so it
 *  survives the agent redrawing the board. A move carries the hash of its frame's layout input: the layout drops it when
 *  that input changed. The webview posts the move; this class validates and stores it, and the agent reads it back with
 *  `read_board`. Pure: it only needs a place to keep one JSON value (workspaceState in the window, a Map in tests).
 *--------------------------------------------------------------------------------------------*/

import type { Overrides } from '../../../../../board-canvas/canvas';

/** The part of vscode.Memento this needs. */
export interface Keep {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void> | void;
}

export const MAX_MOVES = 300;
export const MAX_NOTES = 100;
export const MAX_NOTE_TEXT = 600;
/** A drag lands inside a drawing, not 20 km away. */
export const MAX_COORD = 20_000;
const KEY = 'flow.board.overrides';
const MAX_BOARDS = 40;

type All = Record<string, Overrides>;

export class OverridesStore {
	constructor(private readonly keep: Keep) { }

	// Entries, not a plain object indexed by board id: a board may be called `__proto__` (cleanBoardId allows it), and
	// assigning that key on an object would set its prototype instead of storing the board.
	private all(): [string, Overrides][] {
		const v = this.keep.get<All>(KEY);
		return v && typeof v === 'object' ? Object.entries(v) : [];
	}

	private write(id: string, o: Overrides | undefined) {
		const rest = this.all().filter(([k]) => k !== id); // re-inserted last: the oldest boards are the ones forgotten
		if (o && (Object.keys(o.moves ?? {}).length || Object.keys(o.notes ?? {}).length)) {
			rest.push([id, o]);
		}
		void this.keep.update(KEY, Object.fromEntries(rest.slice(Math.max(0, rest.length - MAX_BOARDS))));
	}

	get(id: string): Overrides {
		return this.all().find(([k]) => k === id)?.[1] ?? {};
	}

	/** Stores a move; false when the numbers are not a place on a drawing. */
	move(id: string, el: string, x: unknown, y: unknown, hash: string): boolean {
		if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
			return false;
		}
		const cur = this.get(id);
		const moves = { ...cur.moves };
		if (!(el in moves) && Object.keys(moves).length >= MAX_MOVES) {
			return false;
		}
		moves[el] = { x: Math.round(x), y: Math.round(y), hash };
		this.write(id, { ...cur, moves });
		return true;
	}

	/** Stores a note ("" removes it); false when it is not text or the board holds too many. */
	note(id: string, el: string, text: unknown): boolean {
		if (typeof text !== 'string') {
			return false;
		}
		const cur = this.get(id);
		const notes = { ...cur.notes };
		const clean = text.trim().slice(0, MAX_NOTE_TEXT);
		if (!clean) {
			delete notes[el];
		} else if (!(el in notes) && Object.keys(notes).length >= MAX_NOTES) {
			return false;
		} else {
			notes[el] = clean;
		}
		this.write(id, { ...cur, notes });
		return true;
	}

	/** "Reset positions": every move of the board goes, the notes stay. */
	resetMoves(id: string) {
		const cur = this.get(id);
		this.write(id, { ...cur, moves: undefined });
	}

	/** The board was redrawn: what belonged to an element that is no longer there is forgotten. */
	prune(id: string, elements: Iterable<string>) {
		const cur = this.get(id);
		const have = new Set(elements);
		const moves = Object.fromEntries(Object.entries(cur.moves ?? {}).filter(([k]) => have.has(k)));
		const notes = Object.fromEntries(Object.entries(cur.notes ?? {}).filter(([k]) => have.has(k)));
		if (Object.keys(moves).length !== Object.keys(cur.moves ?? {}).length || Object.keys(notes).length !== Object.keys(cur.notes ?? {}).length) {
			this.write(id, { moves, notes });
		}
	}

	forget(id: string) {
		this.write(id, undefined);
	}
}
