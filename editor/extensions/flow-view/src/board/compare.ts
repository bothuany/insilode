/*---------------------------------------------------------------------------------------------
 *  Insilode board compare: what changed between two versions of a design. The new board comes back with `change` set on every node and
 *  edge that is added or changed, and what the old one had and the new one lacks drawn again as removed (a ghost), so the canvas only
 *  has to colour by `change`. Used for a board with a `base` and for "what changed since the last draw". Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { BoardEdge, BoardGroup, BoardNode, BoardSpec } from '../../../../../board-canvas/spec';

export interface ChangeCounts {
	added: number;
	removed: number;
	changed: number;
}

const membersOf = (n: BoardNode) => (n.members ?? []).map(m => m.text).join('\n');

/** The parts of a node that make it a different design (progress and notes do not). */
function nodeSignature(n: BoardNode): string {
	return [n.label, n.kind, n.tech, n.shape, n.detail, n.group, n.symbol ?? n.file, membersOf(n)].join('\u0001');
}

const edgeKey = (e: BoardEdge) => `${e.from}>${e.to}|${e.kind ?? ''}`;

function edgeSignature(e: BoardEdge, withOrder = true): string {
	return [e.label, withOrder ? e.order : '', e.style, e.async, e.guard, e.fromCard, e.toCard].join('\u0001');
}

/**
 * Which old edge each new edge (by index) is. Edges between the same two nodes of the same kind are told apart the way a reader would:
 * the same message first, then the same label, then the rest in order. A sequence board has many `api -> db` messages; keyed by the
 * ends alone they would collapse into one.
 */
function pairEdges(base: BoardEdge[], next: BoardEdge[]): Map<number, BoardEdge> {
	const pool = new Map<string, BoardEdge[]>();
	for (const e of base) {
		const list = pool.get(edgeKey(e));
		if (list) {
			list.push(e);
		} else {
			pool.set(edgeKey(e), [e]);
		}
	}
	const pairs = new Map<number, BoardEdge>();
	const passes: ((old: BoardEdge, e: BoardEdge) => boolean)[] = [
		(old, e) => edgeSignature(old) === edgeSignature(e),
		(old, e) => (old.label ?? '') === (e.label ?? ''),
		() => true,
	];
	for (const same of passes) {
		next.forEach((e, i) => {
			const list = pool.get(edgeKey(e));
			const at = pairs.has(i) || !list ? -1 : list.findIndex(old => same(old, e));
			if (at >= 0) {
				pairs.set(i, list!.splice(at, 1)[0]);
			}
		});
	}
	return pairs;
}

/**
 * The paired edges whose place in the message order changed. A message removed or added before them renumbers the rest, which is not
 * a change to them. Of the messages that keep their order, the longest run that is still in the old order stays; the others moved, so
 * one message moved past several is the only one marked.
 */
function movedEdges(pairs: Map<number, BoardEdge>, next: BoardEdge[]): Set<number> {
	const ordered = [...pairs]
		.filter(([i, old]) => old.order !== undefined && next[i].order !== undefined)
		.sort(([a], [b]) => next[a].order! - next[b].order! || a - b);
	// Longest strictly increasing run of old orders, in new order (n is the edges of one board: quadratic is fine).
	const len: number[] = [];
	const prev: number[] = [];
	let best = -1;
	ordered.forEach(([, old], k) => {
		len[k] = 1;
		prev[k] = -1;
		for (let j = 0; j < k; j++) {
			if (ordered[j][1].order! < old.order! && len[j] + 1 > len[k]) {
				len[k] = len[j] + 1;
				prev[k] = j;
			}
		}
		if (best < 0 || len[k] > len[best]) {
			best = k;
		}
	});
	const stay = new Set<number>();
	for (let k = best; k >= 0; k = prev[k]) {
		stay.add(ordered[k][0]);
	}
	return new Set(ordered.map(([i]) => i).filter(i => !stay.has(i)));
}

/**
 * `next` with its changes against `base` marked. A `change` the agent already set is kept (it said what it meant). Removed nodes and
 * edges are copied in from `base`; their groups come along when `next` lacks them. The result is a new spec; neither input changes.
 */
export function compareBoards(base: BoardSpec, next: BoardSpec): BoardSpec {
	const before = new Map(base.nodes.map(n => [n.id, n]));
	const nodes: BoardNode[] = next.nodes.map(n => {
		const old = before.get(n.id);
		if (n.change) {
			return n;
		}
		if (!old) {
			return { ...n, change: 'added' };
		}
		return nodeSignature(old) === nodeSignature(n) ? n : { ...n, change: 'changed' };
	});
	const have = new Set(next.nodes.map(n => n.id));
	const groups = new Map((next.groups ?? []).map(g => [g.id, g]));
	const baseGroups = new Map((base.groups ?? []).map(g => [g.id, g]));
	const adopt = (id: string | undefined) => {
		for (let g = id ? baseGroups.get(id) : undefined, n = 0; g && !groups.has(g.id) && n < 8; g = g.parent ? baseGroups.get(g.parent) : undefined, n++) {
			groups.set(g.id, g);
		}
	};
	for (const old of base.nodes) {
		if (!have.has(old.id)) {
			adopt(old.group);
			nodes.push({ ...old, change: 'removed', check: undefined, checkNote: undefined, warn: undefined });
			have.add(old.id);
		}
	}
	const pairs = pairEdges(base.edges, next.edges);
	const moved = movedEdges(pairs, next.edges);
	const edges: BoardEdge[] = next.edges.map((e, i) => {
		const old = pairs.get(i);
		if (e.change) {
			return e;
		}
		if (!old) {
			return { ...e, change: 'added' };
		}
		const same = !moved.has(i) && (old.order === undefined) === (e.order === undefined) && edgeSignature(old, false) === edgeSignature(e, false);
		return same ? e : { ...e, change: 'changed' };
	});
	const kept = new Set(pairs.values());
	for (const old of base.edges) {
		if (!kept.has(old) && have.has(old.from) && have.has(old.to)) {
			edges.push({ ...old, change: 'removed', fragment: old.fragment && groups.has(old.fragment) ? old.fragment : undefined });
		}
	}
	return { ...next, nodes, edges, groups: groups.size ? [...groups.values()] as BoardGroup[] : undefined };
}

/** How many nodes and edges carry each change mark. */
export function countChanges(spec: BoardSpec): ChangeCounts {
	const out: ChangeCounts = { added: 0, removed: 0, changed: 0 };
	for (const x of [...spec.nodes, ...spec.edges]) {
		if (x.change) {
			out[x.change]++;
		}
	}
	return out;
}

/** True when a board has any change mark. */
export const hasChanges = (spec: BoardSpec) => spec.nodes.some(n => n.change) || spec.edges.some(e => e.change);
