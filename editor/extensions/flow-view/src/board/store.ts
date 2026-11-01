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
	private host: BoardHost | undefined;
	private seq = 0;
	/** Paints a board before it is shown (skeleton first's plan vs code); the stored board stays as it was drawn. */
	private decorator: ((id: string, spec: BoardSpec) => BoardSpec) | undefined;

	constructor(options: BoardStoreOptions = {}) {
		this.persist = options.persist;
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
		await this.host?.show(id, this.shown(id, board.spec), this.since(id));
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
		while (this.boards.size > MAX_BOARDS) {
			const oldest = [...this.boards.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
			this.boards.delete(oldest.id);
			this.changed.fire({ type: 'delete', id: oldest.id });
		}
		this.changed.fire({ type: 'set', id });
		if (opts.present !== false) {
			await this.host?.show(id, this.shown(id, spec), this.since(id)); // a replaced board is shown again if its tab was closed
		}
		return id;
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
		}
	}
}
