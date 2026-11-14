/*---------------------------------------------------------------------------------------------
 *  Insilode board lint: what draw_board tells the agent about a board it just sent, so it can fix the board by
 *  calling again with the same id. Pure: no `vscode` (checks that need the workspace, such as a file or a
 *  symbol, are done by the tool handler and join this list). The crossing count is an estimate with the
 *  same idea as the canvas layout (layers, barycenter sweeps), not the canvas's own number: the canvas lives
 *  in ui/ and flow-view never imports it.
 *--------------------------------------------------------------------------------------------*/

import type { BoardEdge, BoardGroup, BoardSpec } from '../../../../../board-canvas/spec';

export interface LintItem {
	level: 'error' | 'warn' | 'info';
	text: string;
}

export interface LintResult {
	items: LintItem[];
	/** Nodes drawn after collapsed groups are folded into one box (lifelines for a sequence board). */
	visible: number;
	crossings: number;
}

/** A board over this many visible nodes is hard to read at a glance. */
export const SOFT_NODES = 25;
export const SOFT_EDGES = 35;
export const SOFT_CROSSINGS = 12;
export const SOFT_LIFELINES = 8;

const groupMap = (groups: BoardGroup[] | undefined) => new Map((groups ?? []).map(g => [g.id, g]));

/** Group ids from the outermost down to the node's own group; a cycle of parents is cut where it repeats. */
function chainOf(groups: Map<string, BoardGroup>, id: string | undefined): string[] {
	const chain: string[] = [];
	for (let g = id ? groups.get(id) : undefined; g && !chain.includes(g.id); g = g.parent ? groups.get(g.parent) : undefined) {
		chain.unshift(g.id);
	}
	return chain;
}

/** The layered-layout crossing count of a graph: cycles broken, longest-path layers, barycenter sweeps, crossings between neighbouring layers. */
export function estimateCrossings(ids: string[], edges: [string, string][]): number {
	const index = new Map(ids.map((id, i) => [id, i]));
	const out: number[][] = ids.map(() => []);
	const seen = new Set<string>();
	for (const [a, b] of edges) {
		const i = index.get(a);
		const j = index.get(b);
		if (i === undefined || j === undefined || i === j || seen.has(`${i}>${j}`)) {
			continue;
		}
		seen.add(`${i}>${j}`);
		out[i].push(j);
	}
	// Depth-first walk: an edge that closes a cycle runs backwards.
	const state = new Array<number>(ids.length).fill(0);
	const back = new Set<string>();
	for (let root = 0; root < ids.length; root++) {
		if (state[root]) {
			continue;
		}
		const stack: [number, number][] = [[root, 0]];
		state[root] = 1;
		while (stack.length) {
			const top = stack[stack.length - 1];
			if (top[1] < out[top[0]].length) {
				const w = out[top[0]][top[1]++];
				if (state[w] === 1) {
					back.add(`${top[0]}>${w}`);
				} else if (state[w] === 0) {
					state[w] = 1;
					stack.push([w, 0]);
				}
			} else {
				state[top[0]] = 2;
				stack.pop();
			}
		}
	}
	const pairs: [number, number][] = [];
	for (let v = 0; v < ids.length; v++) {
		for (const w of out[v]) {
			pairs.push(back.has(`${v}>${w}`) ? [w, v] : [v, w]);
		}
	}
	const layer = new Array<number>(ids.length).fill(0);
	const indeg = new Array<number>(ids.length).fill(0);
	const succ: number[][] = ids.map(() => []);
	for (const [a, b] of pairs) {
		succ[a].push(b);
		indeg[b]++;
	}
	const queue = ids.map((_, i) => i).filter(i => indeg[i] === 0);
	for (let q = 0; q < queue.length; q++) {
		for (const w of succ[queue[q]]) {
			layer[w] = Math.max(layer[w], layer[queue[q]] + 1);
			if (--indeg[w] === 0) {
				queue.push(w);
			}
		}
	}
	// Long edges get a dummy node on every layer they pass, so crossings are counted where the lines really are.
	let total = ids.length;
	const links: [number, number][] = [];
	const dummyLayer: number[] = [];
	for (const [a, b] of pairs) {
		let prev = a;
		for (let l = layer[a] + 1; l < layer[b]; l++) {
			const d = total++;
			dummyLayer[d] = l;
			links.push([prev, d]);
			prev = d;
		}
		links.push([prev, b]);
	}
	const layerOf = (v: number) => (v < ids.length ? layer[v] : dummyLayer[v]);
	const layers: number[][] = [];
	for (let v = 0; v < total; v++) {
		(layers[layerOf(v)] ??= []).push(v);
	}
	const pos = new Array<number>(total).fill(0);
	const up: number[][] = Array.from({ length: total }, () => []);
	const down: number[][] = Array.from({ length: total }, () => []);
	for (const [a, b] of links) {
		down[a].push(b);
		up[b].push(a);
	}
	const settle = () => layers.forEach(l => l?.forEach((v, i) => (pos[v] = i)));
	settle();
	for (let sweep = 0; sweep < 4; sweep++) {
		const downward = sweep % 2 === 0;
		const order = downward ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i);
		for (const li of order) {
			const l = layers[li];
			if (!l) {
				continue;
			}
			const mean = (v: number) => {
				const ns = downward ? up[v] : down[v];
				return ns.length ? ns.reduce((t, w) => t + pos[w], 0) / ns.length : pos[v];
			};
			const key = new Map(l.map(v => [v, mean(v)]));
			l.sort((p, q) => key.get(p)! - key.get(q)! || p - q);
			l.forEach((v, i) => (pos[v] = i));
		}
	}
	let crossings = 0;
	const byTop = new Map<number, [number, number][]>();
	for (const [a, b] of links) {
		const l = byTop.get(layerOf(a)) ?? [];
		l.push([a, b]);
		byTop.set(layerOf(a), l);
	}
	for (const l of byTop.values()) {
		for (let i = 0; i < l.length; i++) {
			for (let j = i + 1; j < l.length; j++) {
				if ((pos[l[i][0]] - pos[l[j][0]]) * (pos[l[i][1]] - pos[l[j][1]]) < 0) {
					crossings++;
				}
			}
		}
	}
	return crossings;
}

const list = (ids: string[], max = 4) => ids.slice(0, max).map(i => `\`${i}\``).join(', ') + (ids.length > max ? ` and ${ids.length - max} more` : '');

/** The lint of a parsed board. Each text names what is wrong and how to fix it. */
export function lintBoard(spec: BoardSpec): LintResult {
	const items: LintItem[] = [];
	const add = (level: LintItem['level'], text: string) => items.push({ level, text });
	const groups = groupMap(spec.groups);
	const sequence = spec.kind === 'sequence';
	const touched = new Set<string>();
	spec.edges.forEach(e => (touched.add(e.from), touched.add(e.to)));

	// Fold collapsed groups: a node inside one is drawn as the group.
	const collapsedAbove = (group: string | undefined) => chainOf(groups, group).find(id => groups.get(id)?.collapsed);
	const rep = (id: string) => {
		const n = spec.nodes.find(x => x.id === id);
		const c = n ? collapsedAbove(n.group) : undefined;
		return c ? `group:${c}` : id;
	};
	const visibleIds = [...new Set(spec.nodes.map(n => rep(n.id)))];
	const visible = visibleIds.length;

	// Same label on two nodes: the reader cannot tell them apart.
	const byLabel = new Map<string, string[]>();
	for (const n of spec.nodes) {
		const k = n.label.trim().toLowerCase();
		byLabel.set(k, [...(byLabel.get(k) ?? []), n.id]);
	}
	for (const ids of byLabel.values()) {
		if (ids.length > 1) {
			add('warn', `nodes ${list(ids)} share the label "${spec.nodes.find(n => n.id === ids[0])!.label}": rename them or merge them into one node.`);
		}
	}

	// Orphans.
	if (spec.edges.length > 0 || spec.nodes.length > 1) {
		const orphans = spec.nodes.filter(n => !touched.has(n.id) && n.kind !== 'note' && n.shape !== 'initial' && spec.kind !== 'plan' && !(spec.callouts ?? []).some(c => c.node === n.id));
		if (orphans.length) {
			add('warn', `${orphans.length} node(s) have no edges (${list(orphans.map(n => n.id))}): connect them or leave them out, they are drawn in a grid at the bottom.`);
		}
	}

	if (sequence) {
		const lifelines = new Set(spec.edges.flatMap(e => [e.from, e.to]));
		if (lifelines.size > SOFT_LIFELINES) {
			add('warn', `${lifelines.size} lifelines: a sequence is easiest to read with ${SOFT_LIFELINES} or fewer; split it by phase or merge the small participants.`);
		}
		const unordered = spec.edges.filter(e => e.order === undefined);
		if (unordered.length) {
			add('warn', `${unordered.length} message(s) have no \`order\` (1, 2, 3...): they are drawn in array order. Number every message.`);
		}
		const orders = spec.edges.map(e => e.order).filter((o): o is number => o !== undefined);
		if (new Set(orders).size < orders.length) {
			add('warn', 'two messages share the same `order`: give each one its own number.');
		}
	} else {
		if (visible > SOFT_NODES) {
			const names = [...groups.values()].filter(g => !g.parent).map(g => g.label);
			add('warn', `${visible} visible nodes (aim for ${SOFT_NODES} or fewer): split the board${names.length ? ` by ${names.slice(0, 3).map(n => `"${n}"`).join(', ')}` : ' by layer or feature'}, or put related nodes in \`groups\` with collapsed: true.`);
		}
		const folded = new Map<string, number>();
		for (const e of spec.edges) {
			const a = rep(e.from);
			const b = rep(e.to);
			if (a !== b) {
				folded.set(`${a}>${b}`, 1);
			}
		}
		if (folded.size > SOFT_EDGES) {
			add('warn', `${folded.size} edges: too many lines to follow; keep the ones that answer the question and show the rest as a \`callouts\` note.`);
		}
	}

	let crossings = 0;
	if (!sequence && spec.edges.length > 1) {
		crossings = estimateCrossings(visibleIds, spec.edges.map((e): [string, string] => [rep(e.from), rep(e.to)]));
		if (crossings > SOFT_CROSSINGS) {
			add('warn', `about ${crossings} edge crossings: group the nodes that talk to each other (\`groups\`), drop the cross links, or split the board.`);
		}
	}

	// Edge labels.
	if (spec.kind === 'flow' || sequence) {
		const bare = spec.edges.filter(e => !e.label && (e.kind === undefined || e.kind === 'calls' || e.kind === 'message'));
		if (bare.length) {
			add('warn', `${bare.length} edge(s) have no label (${edgeList(bare)}): say what flows, with a verb or a payload ("validates", "OrderPlaced event").`);
		}
	}
	const decisions = spec.nodes.filter(n => n.kind === 'decision' && spec.edges.filter(e => e.from === n.id).length < 2);
	if (decisions.length) {
		add('warn', `decision ${list(decisions.map(n => n.id))} has fewer than two outgoing edges: add the yes/no (or each case) branches.`);
	}

	// Plans must not loop.
	if (spec.kind === 'plan' && hasCycle(spec.nodes.map(n => n.id), spec.edges)) {
		add('warn', 'the plan has a cycle (a step that leads back to an earlier one): a plan runs in one direction; draw a loop as a note.');
	}

	// Groups.
	for (const g of groups.values()) {
		if (g.kind === 'alt' || g.kind === 'loop' || g.kind === 'opt') {
			continue;
		}
		const inside = spec.nodes.filter(n => chainOf(groups, n.group).includes(g.id)).length;
		const kids = [...groups.values()].some(x => x.parent === g.id);
		if (inside === 0 && !kids) {
			add('info', `group \`${g.id}\` is empty: remove it.`);
		} else if (inside === 1 && !kids) {
			add('info', `group \`${g.id}\` holds a single node: a box around one node adds nothing.`);
		}
	}
	const deep = [...groups.keys()].filter(id => chainOf(groups, id).length > 2);
	if (deep.length) {
		add('warn', `groups ${list(deep)} are nested more than 2 levels deep: flatten them.`);
	}

	if (spec.kind === 'state' && !spec.nodes.some(n => n.shape === 'initial')) {
		add('info', 'no initial state: add a node with shape "initial" and an edge to the first state.');
	}
	if (spec.kind === 'architecture' && spec.level && spec.level !== 'context') {
		const bare = spec.nodes.filter(n => !n.tech && n.kind !== 'note');
		if (bare.length) {
			add('info', `${bare.length} box(es) have no \`tech\` (${list(bare.map(n => n.id))}): a ${spec.level} diagram names the technology under each box.`);
		}
	}
	if (spec.kind !== 'plan' && spec.kind !== 'er' && !spec.nodes.some(n => n.symbol || n.file)) {
		add('info', 'no node links to code: give real code a `symbol` (from find_symbol or flow_text) so a click opens it and Insilode can tell when it goes stale.');
	}
	if (!spec.steps && spec.nodes.length > 6) {
		add('info', 'this board has no `steps`: add 3-10 with a caption each so the user is walked through it instead of reading a paragraph in chat.');
	}

	const rank = { error: 0, warn: 1, info: 2 } as const;
	items.sort((a, b) => rank[a.level] - rank[b.level]);
	return { items, visible, crossings };
}

function edgeList(edges: BoardEdge[]): string {
	return edges.slice(0, 3).map(e => `\`${e.from}\`→\`${e.to}\``).join(', ') + (edges.length > 3 ? ` and ${edges.length - 3} more` : '');
}

function hasCycle(ids: string[], edges: BoardEdge[]): boolean {
	const out = new Map<string, string[]>();
	for (const e of edges) {
		out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
	}
	const state = new Map<string, 1 | 2>();
	for (const root of ids) {
		if (state.has(root)) {
			continue;
		}
		const stack: [string, number][] = [[root, 0]];
		state.set(root, 1);
		while (stack.length) {
			const top = stack[stack.length - 1];
			const next = out.get(top[0]) ?? [];
			if (top[1] < next.length) {
				const w = next[top[1]++];
				if (state.get(w) === 1) {
					return true;
				}
				if (!state.has(w)) {
					state.set(w, 1);
					stack.push([w, 0]);
				}
			} else {
				state.set(top[0], 2);
				stack.pop();
			}
		}
	}
	return false;
}

/** Most lines the answer carries: the agent reads a short list. Errors (parse notes) come first, then warnings, then hints. */
export const MAX_LINT_LINES = 10;

/** `notes`: what parseBoard dropped; `extra`: findings of the host's own checks (files, symbols); `lint`: the lint of the spec. */
export function formatLint(notes: string[], extra: string[], lint: LintResult): string[] {
	const lines = [
		...notes.map(text => ({ level: 0, text })),
		...extra.map(text => ({ level: 1, text })),
		...lint.items.map(i => ({ level: i.level === 'error' ? 0 : i.level === 'warn' ? 1 : 2, text: i.text })),
	].sort((a, b) => a.level - b.level);
	if (!lines.length) {
		return [];
	}
	const shown = lines.slice(0, MAX_LINT_LINES).map((l, i) => `${i + 1}. ${l.level === 2 ? '(hint) ' : ''}${l.text}`);
	return [`LINT (${lines.length}):`, ...shown, ...(lines.length > MAX_LINT_LINES ? [`...and ${lines.length - MAX_LINT_LINES} more: fix these first, then draw again with the same id.`] : [])];
}
