/*---------------------------------------------------------------------------------------------
 *  Insilode: the layout of the Agents page's terminal workspace, as a pure tree: panes (leaves) and row / column splits with
 *  ratios. No `vscode`, no DOM, no imports: everything lives inside `paneLayoutModule`, because the page script cannot import and
 *  gets this module as its source text (agentsPage.ts puts `paneLayoutModule.toString()` into the page). The host validates the
 *  layouts the page saves with the same code (agentsMessage.ts, layoutStore.ts), so a layout that reaches storage is always sound.
 *
 *  Every operation returns a new layout; the one it was given is never changed. Ids come from `seq`, which only grows, so a tree is
 *  deterministic and a pane keeps its id for as long as it lives (the page keys its terminals by it).
 *--------------------------------------------------------------------------------------------*/

export type PaneKind = 'terminal' | 'transcript';
export type PaneAgent = 'claude' | 'codex' | 'custom';
export type DropEdge = 'left' | 'right' | 'top' | 'bottom';
export type DropZone = DropEdge | 'center';

/** What a pane shows. Everything but `kind` and `agent` is optional: a session that is not started yet has no `session`. */
export interface PaneContent {
	kind: PaneKind;
	agent: PaneAgent;
	/** The agent session of this window the pane is attached to (an id of the rows the host sends). */
	session?: string;
	/** The id the CLI resumes the session with, when it is not `session` (Codex's own id); a uuid. */
	resume?: string;
	/** The folder the session works in, as the host reported it: what a resume starts in. */
	cwd?: string;
	title?: string;
	/** The project folder's name, for the header. */
	folder?: string;
	/** For a transcript pane: the key of the other window's project the session runs in. */
	peer?: string;
	/** For a transcript pane of a session of the machine's index that another program runs: what runs it ("Claude desktop"). Whether it still does is the sidebar index's to say, not this field's. */
	ext?: string;
}

export interface PaneLeaf {
	type: 'pane';
	id: string;
	content: PaneContent;
}

/** `sizes` are the children's shares of the split, positive and summing to 1. */
export interface PaneSplit {
	type: 'split';
	id: string;
	dir: 'row' | 'col';
	children: PaneNode[];
	sizes: number[];
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneLayout {
	root?: PaneNode;
	/** Counter behind the ids. */
	seq: number;
	/** The pane that has the focus. */
	focus?: string;
	/** The pane that fills the workspace for now. */
	max?: string;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export const MAX_PANES = 16;
/** Saved layouts a user may keep. */
export const MAX_LAYOUTS = 20;
export const MAX_LAYOUT_NAME = 60;

/** The whole module as one function without free variables: see the header. */
export function paneLayoutModule() {
	const MAX_PANES_ = 16;
	const MAX_DEPTH = 8;
	const GUTTER = 6;
	const KINDS = ['terminal', 'transcript'];
	const AGENTS = ['claude', 'codex', 'custom'];
	const ID = /^[ps][0-9]{1,6}$/;
	const LIMITS: Record<string, number> = { session: 200, resume: 64, cwd: 1024, title: 200, folder: 200, peer: 100, ext: 80 };

	type Content = PaneContent;
	type Leaf = PaneLeaf;
	type Split = PaneSplit;
	type Node = PaneNode;
	type Layout = PaneLayout;

	const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
	const emptyLayout = (): Layout => ({ seq: 0 });

	function leaves(node: Node | undefined, out: Leaf[] = []): Leaf[] {
		if (node) {
			if (node.type === 'pane') {
				out.push(node);
			} else {
				node.children.forEach(c => leaves(c, out));
			}
		}
		return out;
	}
	const panes = (layout: Layout): Leaf[] => leaves(layout.root);
	const find = (layout: Layout, id: string | undefined): Leaf | undefined => panes(layout).find(p => p.id === id);

	function findSplit(node: Node | undefined, id: string): Split | undefined {
		if (!node || node.type === 'pane') {
			return undefined;
		}
		if (node.id === id) {
			return node;
		}
		for (const c of node.children) {
			const s = findSplit(c, id);
			if (s) {
				return s;
			}
		}
		return undefined;
	}

	function parentOf(root: Node | undefined, id: string): Split | undefined {
		if (!root || root.type === 'pane') {
			return undefined;
		}
		for (const c of root.children) {
			if (c.id === id) {
				return root;
			}
			const p = parentOf(c, id);
			if (p) {
				return p;
			}
		}
		return undefined;
	}

	const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
	const normalized = (sizes: number[]) => {
		const t = sum(sizes);
		return t > 0 ? sizes.map(s => s / t) : sizes.map(() => 1 / sizes.length);
	};

	/** A split whose child is a split of the same direction takes that child's children in (their shares scaled), and a split of one child is that child. */
	function tidy(node: Node): Node {
		if (node.type === 'pane') {
			return node;
		}
		const children: Node[] = [];
		const sizes: number[] = [];
		node.children.forEach((c, i) => {
			const t = tidy(c);
			if (t.type === 'split' && t.dir === node.dir) {
				t.children.forEach((g, j) => { children.push(g); sizes.push(node.sizes[i] * t.sizes[j]); });
			} else {
				children.push(t);
				sizes.push(node.sizes[i]);
			}
		});
		return children.length === 1 ? children[0] : { ...node, children, sizes: normalized(sizes) };
	}

	/** The layout with its tree tidied and a focus or maximized pane that is gone dropped. */
	function settle(layout: Layout): Layout {
		const root = layout.root && tidy(layout.root);
		const out: Layout = { seq: layout.seq };
		if (root) {
			out.root = root;
		}
		const ids = new Set(leaves(root).map(p => p.id));
		if (layout.focus && ids.has(layout.focus)) {
			out.focus = layout.focus;
		}
		if (layout.max && ids.has(layout.max) && ids.size > 1) {
			out.max = layout.max;
		}
		return out;
	}

	const nextId = (layout: Layout, prefix: 'p' | 's') => `${prefix}${++layout.seq}`;

	/** Puts `leaf` next to `target` on `edge`: into the target's own split when it runs the same way (the target gives half its share), otherwise in a new split. */
	function insertNext(layout: Layout, targetId: string, edge: DropEdge, leaf: Leaf) {
		const dir = edge === 'left' || edge === 'right' ? 'row' : 'col';
		const before = edge === 'left' || edge === 'top';
		const parent = parentOf(layout.root, targetId);
		if (parent && parent.dir === dir) {
			const at = parent.children.findIndex(c => c.id === targetId);
			const half = parent.sizes[at] / 2;
			parent.sizes[at] = half;
			parent.children.splice(before ? at : at + 1, 0, leaf);
			parent.sizes.splice(before ? at : at + 1, 0, half);
			return;
		}
		const target = leaves(layout.root).find(p => p.id === targetId) ?? findSplit(layout.root, targetId);
		const split: Split = { type: 'split', id: nextId(layout, 's'), dir, children: before ? [leaf, target!] : [target!, leaf], sizes: [0.5, 0.5] };
		if (!parent) {
			layout.root = split;
		} else {
			parent.children[parent.children.findIndex(c => c.id === targetId)] = split;
		}
	}

	function without(node: Node | undefined, id: string): Node | undefined {
		if (!node) {
			return undefined;
		}
		if (node.type === 'pane') {
			return node.id === id ? undefined : node;
		}
		const children: Node[] = [];
		const sizes: number[] = [];
		node.children.forEach((c, i) => {
			const w = without(c, id);
			if (w) {
				children.push(w);
				sizes.push(node.sizes[i]);
			}
		});
		return children.length ? { ...node, children, sizes: normalized(sizes) } : undefined;
	}

	/** The first pane of an empty workspace, or one more pane to the right of the last one. */
	function openPane(layout: Layout, content: Content): { layout: Layout; id?: string } {
		const next = clone(layout);
		const count = panes(next).length;
		if (count >= MAX_PANES_) {
			return { layout };
		}
		const leaf: Leaf = { type: 'pane', id: nextId(next, 'p'), content: clone(content) };
		if (!next.root) {
			next.root = leaf;
		} else {
			insertNext(next, panes(next)[count - 1].id, 'right', leaf);
		}
		next.focus = leaf.id;
		delete next.max;
		return { layout: settle(next), id: leaf.id };
	}

	/** A new pane beside `targetId`. Nothing happens (no `id` in the answer) for an unknown pane or at the pane cap. */
	function splitPane(layout: Layout, targetId: string, edge: DropEdge, content: Content): { layout: Layout; id?: string } {
		if (!find(layout, targetId) || panes(layout).length >= MAX_PANES_) {
			return { layout };
		}
		const next = clone(layout);
		const leaf: Leaf = { type: 'pane', id: nextId(next, 'p'), content: clone(content) };
		insertNext(next, targetId, edge, leaf);
		next.focus = leaf.id;
		delete next.max;
		return { layout: settle(next), id: leaf.id };
	}

	function replaceContent(layout: Layout, id: string, content: Content): Layout {
		const next = clone(layout);
		const leaf = leaves(next.root).find(p => p.id === id);
		if (!leaf) {
			return layout;
		}
		leaf.content = clone(content);
		next.focus = id;
		return settle(next);
	}

	/** On the centre of another pane the two swap places; on an edge the pane leaves its place (its neighbours take the space) and sits beside the other. */
	function movePane(layout: Layout, srcId: string, targetId: string, zone: DropZone): Layout {
		const src = find(layout, srcId);
		if (!src || !find(layout, targetId) || srcId === targetId) {
			return layout;
		}
		const next = clone(layout);
		if (zone === 'center') {
			const a = leaves(next.root).find(p => p.id === srcId)!;
			const b = leaves(next.root).find(p => p.id === targetId)!;
			const copy = clone(a);
			// The leaves keep their ids; what changes is where they sit.
			Object.assign(a, clone(b));
			Object.assign(b, copy);
			next.focus = srcId;
			return settle(next);
		}
		const leaf = leaves(next.root).find(p => p.id === srcId)!;
		next.root = without(next.root, srcId);
		insertNext(next, targetId, zone, leaf);
		next.focus = srcId;
		delete next.max;
		return settle(next);
	}

	/** The pane goes; its share goes to its neighbours in proportion, and the focus moves to the neighbour in order. */
	function closePane(layout: Layout, id: string): Layout {
		const list = panes(layout);
		const at = list.findIndex(p => p.id === id);
		if (at < 0) {
			return layout;
		}
		const next = clone(layout);
		next.root = without(next.root, id);
		if (next.focus === id) {
			const rest = list.filter(p => p.id !== id);
			next.focus = rest.length ? rest[Math.min(at, rest.length - 1)].id : undefined;
			if (next.focus === undefined) {
				delete next.focus;
			}
		}
		if (next.max === id) {
			delete next.max;
		}
		return settle(next);
	}

	/** Moves the border between children `index` and `index + 1` of a split by `delta` (a share of the split); neither child goes under `min`. */
	function resize(layout: Layout, splitId: string, index: number, delta: number, min: number): Layout {
		const next = clone(layout);
		const s = findSplit(next.root, splitId);
		if (!s || !(index >= 0 && index + 1 < s.sizes.length) || !isFinite(delta)) {
			return layout;
		}
		const a = s.sizes[index];
		const b = s.sizes[index + 1];
		if (a + b < 2 * min) {
			return layout;
		}
		const d = Math.max(min - a, Math.min(b - min, delta));
		s.sizes[index] = a + d;
		s.sizes[index + 1] = b - d;
		return next;
	}

	function maximize(layout: Layout, id: string): Layout {
		if (!find(layout, id) || panes(layout).length < 2) {
			return layout;
		}
		return { ...clone(layout), max: id, focus: id };
	}
	function restore(layout: Layout): Layout {
		const next = clone(layout);
		delete next.max;
		return next;
	}
	const toggleMaximize = (layout: Layout, id: string): Layout => layout.max === id ? restore(layout) : maximize(layout, id);

	function focusPane(layout: Layout, id: string): Layout {
		return find(layout, id) && layout.focus !== id ? { ...clone(layout), focus: id } : layout;
	}

	/** The pane `step` places after (or before, when negative) `id` in reading order, wrapping round. */
	function neighbor(layout: Layout, id: string | undefined, step: number): string | undefined {
		const list = panes(layout);
		if (!list.length) {
			return undefined;
		}
		const at = list.findIndex(p => p.id === id);
		return list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length * 4) % list.length].id;
	}

	/** Where every pane sits in a workspace of `w` x `h` (the gutters between panes taken off first). */
	function rects(layout: Layout, w: number, h: number): Map<string, Rect> {
		const out = new Map<string, Rect>();
		const place = (n: Node, r: Rect) => {
			if (n.type === 'pane') {
				out.set(n.id, r);
				return;
			}
			const row = n.dir === 'row';
			const room = Math.max(0, (row ? r.w : r.h) - GUTTER * (n.children.length - 1));
			let at = row ? r.x : r.y;
			n.children.forEach((c, i) => {
				const len = room * n.sizes[i];
				place(c, row ? { x: at, y: r.y, w: len, h: r.h } : { x: r.x, y: at, w: r.w, h: len });
				at += len + GUTTER;
			});
		};
		if (layout.root) {
			place(layout.root, { x: 0, y: 0, w, h });
		}
		return out;
	}

	/** Whether every pane would be at least `minW` x `minH` in a workspace of `w` x `h`. */
	function fits(layout: Layout, w: number, h: number, minW: number, minH: number): boolean {
		for (const r of rects(layout, w, h).values()) {
			if (r.w < minW - 0.5 || r.h < minH - 0.5) {
				return false;
			}
		}
		return true;
	}

	/** The part of a pane a point at (x, y) of a `w` x `h` pane is over: the middle fifth-to-fifth is the centre, anything else the nearest edge. */
	function dropZone(w: number, h: number, x: number, y: number): DropZone {
		if (!(w > 0 && h > 0)) {
			return 'center';
		}
		const fx = Math.max(0, Math.min(1, x / w));
		const fy = Math.max(0, Math.min(1, y / h));
		if (fx >= 0.28 && fx <= 0.72 && fy >= 0.28 && fy <= 0.72) {
			return 'center';
		}
		const d: [number, DropEdge][] = [[fx, 'left'], [1 - fx, 'right'], [fy, 'top'], [1 - fy, 'bottom']];
		d.sort((p, q) => p[0] - q[0]);
		return d[0][1];
	}

	// ---- untrusted input -------------------------------------------------------------------------------------------------

	const text = (v: unknown, max: number): string | undefined => typeof v === 'string' && v.length > 0 && v.length <= max && v.indexOf('\0') < 0 ? v : undefined;

	function content(raw: unknown): Content | undefined {
		const m = raw as Record<string, unknown> | null;
		if (!m || typeof m !== 'object' || KINDS.indexOf(m.kind as string) < 0 || AGENTS.indexOf(m.agent as string) < 0) {
			return undefined;
		}
		const out = { kind: m.kind, agent: m.agent } as Content;
		for (const k of Object.keys(LIMITS)) {
			const v = text(m[k], LIMITS[k]);
			if (v !== undefined) {
				(out as unknown as Record<string, string>)[k] = v;
			}
		}
		return out;
	}

	/** The layout in `raw` when it is sound (a tree of at most 16 panes with unique ids, valid contents and sizes), else `undefined`. */
	function parse(raw: unknown): Layout | undefined {
		const m = raw as Record<string, unknown> | null;
		if (!m || typeof m !== 'object' || Array.isArray(m)) {
			return undefined;
		}
		const seen = new Set<string>();
		let count = 0;
		let top = 0;
		const idOf = (v: unknown): string | undefined => {
			if (typeof v !== 'string' || !ID.test(v) || seen.has(v)) {
				return undefined;
			}
			seen.add(v);
			top = Math.max(top, Number(v.slice(1)));
			return v;
		};
		const node = (r: unknown, depth: number): Node | undefined => {
			const n = r as Record<string, unknown> | null;
			if (!n || typeof n !== 'object' || depth > MAX_DEPTH) {
				return undefined;
			}
			if (n.type === 'pane') {
				const c = content(n.content);
				const id = idOf(n.id);
				if (!c || id === undefined || ++count > MAX_PANES_) {
					return undefined;
				}
				return { type: 'pane', id, content: c };
			}
			if (n.type !== 'split' || (n.dir !== 'row' && n.dir !== 'col') || !Array.isArray(n.children) || !Array.isArray(n.sizes) || n.children.length < 2 || n.children.length > MAX_PANES_ || n.sizes.length !== n.children.length) {
				return undefined;
			}
			const id = idOf(n.id);
			if (id === undefined || !n.sizes.every(s => typeof s === 'number' && isFinite(s) && s > 0 && s <= 1)) {
				return undefined;
			}
			const children: Node[] = [];
			for (const c of n.children) {
				const k = node(c, depth + 1);
				if (!k) {
					return undefined;
				}
				children.push(k);
			}
			return { type: 'split', id, dir: n.dir, children, sizes: normalized(n.sizes as number[]) };
		};
		let root: Node | undefined;
		if (m.root !== undefined) {
			root = node(m.root, 0);
			if (!root) {
				return undefined;
			}
		}
		const seq = typeof m.seq === 'number' && Number.isInteger(m.seq) && m.seq >= 0 && m.seq < 1e9 ? Math.max(m.seq, top) : undefined;
		if (seq === undefined) {
			return undefined;
		}
		const ids = new Set(leaves(root).map(p => p.id));
		const out: Layout = { seq };
		if (root) {
			out.root = root;
		}
		if (typeof m.focus === 'string' && ids.has(m.focus)) {
			out.focus = m.focus;
		}
		if (typeof m.max === 'string' && ids.has(m.max) && ids.size > 1) {
			out.max = m.max;
		}
		return settle(out);
	}

	/** The layout in `raw`, or the empty one when it is not sound. */
	const validate = (raw: unknown): Layout => parse(raw) ?? emptyLayout();

	/** A name for a saved layout: trimmed, one line, 1 to 60 characters. */
	function layoutName(raw: unknown): string | undefined {
		if (typeof raw !== 'string') {
			return undefined;
		}
		const t = raw.trim();
		// eslint-disable-next-line no-control-regex
		return t.length > 0 && t.length <= 60 && !/[\u0000-\u001f\u007f]/.test(t) ? t : undefined;
	}

	return { emptyLayout, panes, find, openPane, splitPane, replaceContent, movePane, closePane, resize, maximize, restore, toggleMaximize, focusPane, neighbor, rects, fits, dropZone, parse, validate, layoutName };
}

const api = paneLayoutModule();
export const { emptyLayout, panes, find, openPane, splitPane, replaceContent, movePane, closePane, resize, maximize, restore, toggleMaximize, focusPane, neighbor, rects, fits, dropZone, parse, validate, layoutName } = api;
