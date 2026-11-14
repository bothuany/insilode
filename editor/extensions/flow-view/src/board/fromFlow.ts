/*---------------------------------------------------------------------------------------------
 *  Insilode board: a traced flow kept as a board. Boards used to come only from an agent (draw_board,
 *  plan mode), so without one the feature was empty. "Pin Flow as Board" keeps the flow on the canvas
 *  as a board that stays in the board list and exports to Mermaid: each card a node that still opens
 *  its file and line, each call, HTTP guess and table access an edge. Pure (no vscode).
 *--------------------------------------------------------------------------------------------*/

import type { FlowNode } from '../../../../../protocol/flow';
import { MAX_NODES, type BoardEdge, type BoardNode, type BoardSpec, type NodeKind } from '../../../../../board-canvas/spec';

const KIND: Record<FlowNode['kind'], NodeKind> = {
	controller: 'controller', handler: 'service', method: 'service', db: 'entity', ambiguous: 'interface', external: 'external',
};

/** The flow under `root` as a board: one node per card (repeated cards drawn once), edges as the flow draws them. */
export function flowToBoard(root: FlowNode, title: string): BoardSpec {
	const nodes: BoardNode[] = [];
	const edges: BoardEdge[] = [];
	const ids = new Map<string, string>();
	// A card met twice (two calls reach the same method) is one node: keyed by what it is, not by its place in the tree.
	const keyOf = (n: FlowNode) => n.kind === 'db' ? `db:${n.label}` : n.file ? `${n.file}:${n.startLine}` : `${n.kind}:${n.label}`;
	const idOf = (n: FlowNode) => {
		const k = keyOf(n);
		let id = ids.get(k);
		if (!id) {
			id = `n${ids.size + 1}`;
			ids.set(k, id);
			nodes.push({
				id,
				label: n.label,
				kind: KIND[n.kind] ?? 'class',
				...(n.sub ? { detail: n.sub } : {}),
				...(n.file ? { file: n.file, line: n.startLine } : {}),
			});
		}
		return id;
	};
	const walk = (n: FlowNode, depth: number) => {
		const from = idOf(n);
		for (const c of n.children) {
			if (nodes.length >= MAX_NODES) {
				return;
			}
			const to = idOf(c.node);
			const edge: BoardEdge = { from, to };
			if (c.edgeKind === 'db') {
				edge.kind = c.node.schema?.writes ? 'writes' : 'reads';
			} else if (c.edgeKind === 'impl') {
				edge.kind = 'implements';
			} else if (c.edgeKind === 'http') {
				edge.kind = 'calls';
				edge.label = 'HTTP?';
			} else if (c.edgeKind === 'message') {
				edge.kind = 'calls';
				edge.label = 'topic?';
			} else {
				edge.kind = 'calls';
			}
			if (!edges.some(e => e.from === edge.from && e.to === edge.to && e.kind === edge.kind)) {
				edges.push(edge);
			}
			if (depth < 30) {
				walk(c.node, depth + 1);
			}
		}
	};
	walk(root, 0);
	return { version: 1, kind: 'flow', title, description: 'Pinned from the flow canvas.', direction: 'LR', nodes, edges };
}
