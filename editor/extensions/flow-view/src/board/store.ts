/*---------------------------------------------------------------------------------------------
 *  Insilode boards held by one window: what an agent drew (or what a plan turned into), latest first.
 *  The store knows nothing about how a board is shown: a BoardHost does (today a Markdown preview with
 *  a mermaid diagram, later the canvas). Pure: no `vscode`, so it is unit-tested directly.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { compareBoards, hasChanges } from './compare';
import type { BoardHighlight, BoardNode, BoardSpec, ChangeMark, NodeStatus } from './spec';

export interface NodePatch { status?: NodeStatus; note?: string; change?: ChangeMark }

/** Whatever shows boards. `show` opens (or reveals) a board; `update` redraws one that is already shown. */
export interface BoardHost {
	show(id: string, spec: BoardSpec, extra?: BoardExtra): void | Promise<void>;
	update(id: string, spec: BoardSpec, extra?: BoardExtra): void | Promise<void>;
}

/** What a host shows next to the board: the board compared with its previous draw, for the "what changed" switch. */
export interface BoardExtra {
	since?: BoardSpec;
	/** The boards the store holds, for C4 zoom: a box with `zoom` opens one of them, and `up` marks the ones that zoom into this board. */
	boards?: BoardRef[];
	/** Bring the board's tab forward if it is open: set when someone asked to see the board (present), never for a draw or an update. */
	reveal?: boolean;
}

export interface BoardRef {
	id: string;
	title: string;
	up: boolean;
}

export interface StoredBoard {
	id: string;
	spec: BoardSpec;
	/** The version this board replaced: what "changes since the last draw" compares with. Memory only. */
	previous?: BoardSpec;
	createdAt: number;
	updatedAt: number;
	/** agent: drawn by a tool call · plan: parsed from a plan an agent proposed. */
	/** Who made it: an agent (draw_board), an agent's plan, or the user pinning a flow. */
	origin: 'agent' | 'plan' | 'user';
	/** The Insilode agent session a plan board belongs to (editing a file linked from one of its nodes moves that node). */
	session?: string;
	planFile?: string;
}

export interface BoardChange { type: 'set' | 'node' | 'delete'; id: string }

export const MAX_BOARDS = 30;

/** The key/value store boards survive a reload in: VS Code's `workspaceState` fits it. The store itself stays vscode-free. */
export interface BoardPersist {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export interface BoardStoreOptions {
	/** Where the boards are kept between windows. Without it they live in memory only (tests, other hosts). */
	persist?: BoardPersist;
	/** Where a problem with saving is written (once): the store itself has no log. */
	warn?: (message: string) => void;
}

/** The workspaceState key the boards are saved under; the version is in the name so a later shape can sit beside it. */
export const BOARDS_KEY = 'flow.boards.v1';

/** Wait this long after a change before saving, so an agent's burst of node updates is one write. */
export const SAVE_DELAY_MS = 400;

/** What is saved of a board: not `previous` (the "what changed" comparison is for this session only). */
export interface PersistedBoard {
	id: string;
	spec: BoardSpec;
	origin: StoredBoard['origin'];
	session?: string;
	planFile?: string;
	createdAt: number;
	updatedAt: number;
}

const ORIGINS = new Set<string>(['agent', 'plan', 'user']);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A saved board checked field by field (the value came from disk and may be damaged or from another version): undefined when it cannot be trusted. */
export function readPersistedBoard(raw: unknown, now = Date.now()): PersistedBoard | undefined {
	if (!isObject(raw) || !isObject(raw.spec)) {
		return undefined;
	}
	const id = cleanBoardId(raw.id);
	const spec = raw.spec;
	if (!id || id !== raw.id || typeof spec.title !== 'string' || typeof spec.kind !== 'string' || !Array.isArray(spec.nodes) || !Array.isArray(spec.edges)) {
		return undefined;
	}
	if (!spec.nodes.every(n => isObject(n) && typeof n.id === 'string' && typeof n.label === 'string') || !spec.edges.every(e => isObject(e) && typeof e.from === 'string' && typeof e.to === 'string')) {
		return undefined;
	}
	const time = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : now);
	return {
		id,
		spec: spec as unknown as BoardSpec,
		origin: typeof raw.origin === 'string' && ORIGINS.has(raw.origin) ? (raw.origin as StoredBoard['origin']) : 'agent',
		session: typeof raw.session === 'string' ? raw.session : undefined,
		planFile: typeof raw.planFile === 'string' ? raw.planFile : undefined,
		createdAt: time(raw.createdAt),
		updatedAt: time(raw.updatedAt),
	};
}

/** A minimal event: the store is used outside VS Code too. */
class Emitter<T> {
	private readonly listeners = new Set<(e: T) => void>();
	readonly event = (listener: (e: T) => void) => {
		this.listeners.add(listener);
		return { dispose: () => void this.listeners.delete(listener) };
	};
	fire(e: T) {
		[...this.listeners].forEach(l => {
			try {
				l(e);
			} catch {
				// one bad listener must not stop the others
			}
		});
	}
}

/** An id an agent chose, cleaned: letters, digits and `-_.:` only, so it can never be a path. */
export function cleanBoardId(raw: unknown): string | undefined {
	if (typeof raw !== 'string') {
		return undefined;
	}
	const id = raw.trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
	return id || undefined;
}

/** A file name for a board id: readable, and unique even when two ids clean to the same words. */
export function boardFileName(id: string): string {
	const slug = id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'board';
	return `${slug}-${createHash('sha1').update(id).digest('hex').slice(0, 8)}.md`;
}

export class BoardStore {
	private readonly boards = new Map<string, StoredBoard>();
	/** Read by the persistence code: the review fixes load boards from it on start and save them on every change. */
	readonly persist: BoardPersist | undefined;
	/** Whether a board is open in a panel: an open board is never evicted. Set by the host that shows boards. */
	private isOpen: ((id: string) => boolean) | undefined;
	private readonly changed = new Emitter<BoardChange>();
	readonly onDidChange = this.changed.event;
	private readonly warn: ((message: string) => void) | undefined;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private dirty = false;
	private warned = false;
	/** Told about the first board the limit pushed out; later ones follow quietly (the message names how to keep a board). */
	private onEvict: ((board: StoredBoard) => void) | undefined;
	private evictionTold = false;
	private host: BoardHost | undefined;
	private seq = 0;
	/** Paints a board before it is shown (skeleton first's plan vs code); the stored board stays as it was drawn. */
	private decorator: ((id: string, spec: BoardSpec) => BoardSpec) | undefined;

	constructor(options: BoardStoreOptions = {}) {
		this.persist = options.persist;
		this.warn = options.warn;
		this.load();
	}

	/** Boards saved by an earlier window of this workspace. They are held, not shown: no tab opens until a board is asked for. */
	private load() {
		let saved: unknown;
		try {
			saved = this.persist?.get<unknown>(BOARDS_KEY);
		} catch {
			return;
		}
		if (!Array.isArray(saved)) {
			return;
		}
		for (const raw of saved) {
			const b = readPersistedBoard(raw);
			if (b) {
				this.boards.set(b.id, { ...b });
			}
		}
		this.evict(undefined, false);
	}

	/** Called once per session with the first board the limit evicted, so the user hears about it (never a silent drop). */
	setOnEvict(callback: ((board: StoredBoard) => void) | undefined) {
		this.onEvict = callback;
	}

	setHost(host: BoardHost | undefined) {
		this.host = host;
	}

	/** Tells the store which boards are open in a panel, so eviction skips them (plan boards are never evicted either). */
	setOpenCheck(isOpen: ((id: string) => boolean) | undefined) {
		this.isOpen = isOpen;
	}

	/** Whether eviction must leave a board alone. */
	protected pinned(board: StoredBoard): boolean {
		return board.origin === 'plan' || this.isOpen?.(board.id) === true;
	}

	setDecorator(decorator: ((id: string, spec: BoardSpec) => BoardSpec) | undefined) {
		this.decorator = decorator;
	}

	/** The board as the user sees it: compared with its `base` first (a board that is its own base is compared with its previous draw), then painted. */
	private shown(id: string, spec: BoardSpec): BoardSpec {
		try {
			const entry = this.boards.get(id);
			const base = spec.base === undefined ? undefined : spec.base === id ? entry?.previous : this.boards.get(spec.base)?.spec;
			const compared = base ? compareBoards(base, spec) : spec;
			return this.decorator?.(id, compared) ?? compared;
		} catch {
			return spec;
		}
	}

	/** What goes next to a board: the board against its previous draw (when something changed), and the boards C4 zoom can reach. */
	private since(id: string): BoardExtra {
		const board = this.boards.get(id);
		const refs = this.list().filter(b => b.id !== id).map((b): BoardRef => ({ id: b.id, title: b.spec.title, up: b.spec.nodes.some(n => n.zoom === id) }));
		const extra: BoardExtra = refs.length ? { boards: refs } : {};
		if (board?.previous) {
			const diff = compareBoards(board.previous, board.spec);
			if (hasChanges(diff)) {
				extra.since = diff;
			}
		}
		return extra;
	}

	/** Shows a board again, in its tab (opened if it was closed): what a click on a C4 box that zooms into it does. */
	async present(id: string): Promise<boolean> {
		const board = this.boards.get(id);
		if (!board) {
			return false;
		}
		await this.host?.show(id, this.shown(id, board.spec), { ...this.since(id), reveal: true });
		return true;
	}

	/** Shows a board again through the decorator, in the tab that has it (the decoration changed, the board did not). */
	async redraw(id: string): Promise<void> {
		const board = this.boards.get(id);
		if (board) {
			await this.host?.update(id, this.shown(id, board.spec), this.since(id));
		}
	}

	/** Adds a board, or replaces the one with the same id; returns its id. Shown when `present` is not false. */
	async set(spec: BoardSpec, opts: { id?: string; origin?: StoredBoard['origin']; session?: string; planFile?: string; present?: boolean } = {}): Promise<string> {
		const id = cleanBoardId(opts.id) ?? this.freshId(spec.title);
		const old = this.boards.get(id);
		const now = Date.now();
		this.boards.set(id, { id, spec, previous: old?.spec, createdAt: old?.createdAt ?? now, updatedAt: now, origin: opts.origin ?? old?.origin ?? 'agent', session: opts.session ?? old?.session, planFile: opts.planFile ?? old?.planFile });
		this.evict(id, true);
		this.changed.fire({ type: 'set', id });
		this.save();
		if (opts.present !== false) {
			await this.host?.show(id, this.shown(id, spec), this.since(id)); // a replaced board is shown again if its tab was closed
		}
		return id;
	}

	/**
	 * Drops the oldest boards over MAX_BOARDS, never the one just drawn, a plan or one open in a tab: when everything left is
	 * pinned the store holds more than the limit rather than lose work.
	 */
	private evict(keep: string | undefined, tell: boolean) {
		while (this.boards.size > MAX_BOARDS) {
			const oldest = [...this.boards.values()].filter(b => b.id !== keep && !this.pinned(b)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
			if (!oldest) {
				return;
			}
			this.boards.delete(oldest.id);
			this.changed.fire({ type: 'delete', id: oldest.id });
			if (tell && !this.evictionTold) {
				this.evictionTold = true;
				try {
					this.onEvict?.(oldest);
				} catch {
					// the message is a courtesy: the drawing goes on
				}
			}
		}
	}

	/** Saves soon: a change restarts the wait, so a burst of updates is one write. */
	private save() {
		if (!this.persist) {
			return;
		}
		this.dirty = true;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
		this.saveTimer.unref?.();
	}

	/** Writes now what a change left unsaved (the extension calls it when it is disposed, before the host exits). */
	async flush(): Promise<void> {
		clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		if (!this.persist || !this.dirty) {
			return;
		}
		this.dirty = false;
		const value: PersistedBoard[] = [...this.boards.values()].map(b => ({ id: b.id, spec: b.spec, origin: b.origin, session: b.session, planFile: b.planFile, createdAt: b.createdAt, updatedAt: b.updatedAt }));
		try {
			await this.persist.update(BOARDS_KEY, value);
		} catch (e) {
			// A failed save must not break drawing: say so once (the next change tries again).
			if (!this.warned) {
				this.warned = true;
				this.warn?.(`boards: could not be saved (${(e as Error)?.message ?? e})`);
			}
		}
	}

	private freshId(title: string) {
		const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'board';
		let id: string;
		do {
			id = `${slug}-${++this.seq}`;
		} while (this.boards.has(id));
		return id;
	}

	get(id: string) {
		return this.boards.get(id);
	}

	/** Latest first. */
	list(): StoredBoard[] {
		return [...this.boards.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Changes one node. Throws a message naming the valid ids, so an agent can correct itself. */
	async updateNode(id: string, nodeId: string, patch: NodePatch): Promise<BoardNode> {
		const [node] = await this.update(id, { nodes: [{ nodeId, ...patch }] });
		return node;
	}

	/** Changes several nodes and/or the highlighted routes in one redraw. Throws a message naming the valid ids. */
	async update(id: string, patch: { nodes?: (NodePatch & { nodeId: string })[]; highlight?: BoardHighlight[] }): Promise<BoardNode[]> {
		const board = this.boards.get(id);
		if (!board) {
			throw new Error(`No board "${id}". Boards: ${this.list().map(b => b.id).join(', ') || 'none drawn yet'}.`);
		}
		let nodes = board.spec.nodes;
		const touched: BoardNode[] = [];
		for (const p of patch.nodes ?? []) {
			const node = nodes.find(n => n.id === p.nodeId);
			if (!node) {
				throw new Error(`Board "${id}" has no node "${p.nodeId}". Nodes: ${board.spec.nodes.slice(0, 40).map(n => n.id).join(', ')}.`);
			}
			const next: BoardNode = { ...node, ...(p.status ? { status: p.status } : {}), ...(p.note !== undefined ? { note: p.note.slice(0, 600) } : {}), ...(p.change ? { change: p.change } : {}) };
			nodes = nodes.map(n => n === node ? next : n);
			touched.push(next);
		}
		const spec: BoardSpec = { ...board.spec, nodes, ...(patch.highlight ? { highlight: patch.highlight.length ? patch.highlight : undefined } : {}) };
		this.boards.set(id, { ...board, spec, updatedAt: Date.now() });
		this.changed.fire({ type: 'node', id });
		this.save();
		await this.host?.update(id, this.shown(id, spec), this.since(id));
		return touched;
	}

	/** Plan boards of one agent session, newest first. */
	forSession(session: string) {
		return this.list().filter(b => b.origin === 'plan' && b.session === session);
	}

	delete(id: string) {
		if (this.boards.delete(id)) {
			this.changed.fire({ type: 'delete', id });
			this.save();
		}
	}
}
