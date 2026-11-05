/*---------------------------------------------------------------------------------------------
 *  Insilode skeleton first: what survives a window reload. Per agent session only the stage, the id of its design board and whether
 *  the developer chose "just do it" are kept (in the workspace state); the design itself is the plan board, which the board store
 *  persists on its own, and the comparison with the code is recomputed. Damaged data is ignored. Pure: no vscode.
 *--------------------------------------------------------------------------------------------*/

import type { Stage } from './sessions';

export const SESSIONS_KEY = 'flow.skeleton.sessions.v1';

/** The part of vscode.Memento used here, so a test can pass a plain object. */
export interface Memory {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

/** One session as stored. `stage` is null for a session that only has the "just do it" badge. */
export interface SavedSession {
	session: string;
	stage: Stage | null;
	boardId: string;
	skipped: boolean;
}

const STAGES: readonly string[] = ['design', 'skeleton', 'handover'];
/** Session ids come from the agent bridge: a longer one is not one of ours. */
const MAX_ID = 200;

/** The saved sessions of a stored value: wrong shapes, duplicate ids and everything past `max` are left out. */
export function parseSaved(raw: unknown, max: number): SavedSession[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const seen = new Set<string>();
	const out: SavedSession[] = [];
	for (const e of raw) {
		if (out.length >= max) {
			break;
		}
		if (typeof e !== 'object' || e === null) {
			continue;
		}
		const { session, stage, boardId, skipped } = e as Record<string, unknown>;
		if (typeof session !== 'string' || session.length > MAX_ID || seen.has(session)) {
			continue;
		}
		const staged = typeof stage === 'string' && STAGES.includes(stage);
		if (staged ? typeof boardId !== 'string' || !boardId || boardId.length > MAX_ID : stage !== null && stage !== undefined) {
			continue;
		}
		if (!staged && skipped !== true) {
			continue; // nothing to remember
		}
		seen.add(session);
		out.push({ session, stage: staged ? stage as Stage : null, boardId: staged ? boardId as string : '', skipped: skipped === true });
	}
	return out;
}

/**
 * The stages and "just do it" badges of the agent sessions, written to the workspace state on every change. A badge is kept per
 * session until its next design step or until the session ends (`forget`).
 */
export class SessionMemory {
	/** Insertion order is age: the oldest badge goes first when there are too many. */
	private readonly skipped = new Set<string>();

	constructor(private readonly state: Memory | undefined, private readonly max: number) { }

	/**
	 * What was saved, for the sessions whose design board still exists (`boardExists`); the others are dropped without a word.
	 * The badges are taken over as they were saved.
	 */
	restore(boardExists: (id: string) => boolean): SavedSession[] {
		let raw: unknown;
		try {
			raw = this.state?.get<unknown>(SESSIONS_KEY);
		} catch {
			return [];
		}
		const saved = parseSaved(raw, this.max);
		saved.filter(s => s.skipped).forEach(s => this.skipped.add(s.session));
		// The design stage has no board yet and is never written; an entry that says so anyway is not one of ours.
		return saved.filter(s => s.stage !== null && s.stage !== 'design' && boardExists(s.boardId));
	}

	isSkipped(session: string) {
		return this.skipped.has(session);
	}

	/** The developer chose "just do it" for this session. */
	skip(session: string) {
		this.skipped.delete(session);
		this.skipped.add(session);
		while (this.skipped.size > this.max) {
			this.skipped.delete(this.skipped.values().next().value as string);
		}
	}

	/** The badge is over: the next design step of the session, or the session ended. */
	forget(session: string) {
		this.skipped.delete(session);
	}

	/** Writes the sessions that are past the design stage (nothing is drawn before) and the badges. */
	save(live: Iterable<{ session: string; stage: Stage; boardId: string }>) {
		const out: SavedSession[] = [];
		for (const s of live) {
			if (s.stage !== 'design' && out.length < this.max) {
				out.push({ session: s.session, stage: s.stage, boardId: s.boardId, skipped: false });
			}
		}
		for (const id of this.skipped) {
			if (out.length < this.max && !out.some(o => o.session === id)) {
				out.push({ session: id, stage: null, boardId: '', skipped: true });
			}
		}
		try {
			void Promise.resolve(this.state?.update(SESSIONS_KEY, out)).catch(() => undefined);
		} catch {
			// A state that cannot be written only costs the stage after a reload.
		}
	}
}
