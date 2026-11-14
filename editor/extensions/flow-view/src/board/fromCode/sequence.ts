/*---------------------------------------------------------------------------------------------
 *  Insilode boards generated from code: a traced flow as a sequence diagram. Participants are the classes (or services) the flow
 *  passes through, messages are the calls in the order the code makes them (line order inside a method, depth first), numbered
 *  by edge `order`. Calls the index linked by name, an HTTP route, a topic or a mediator are drawn dotted and marked with a
 *  "?": they are guesses. Returns are not drawn: the index does not know what a call returns. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { FlowNode } from '../../../../../../protocol/flow';
import type { NodeKind } from '../../../../../../board-canvas/spec';
import { GUESS_LEGEND, baseName, skip, type GenEdge, type GenNode, type Generated } from './board';

export interface SequenceOptions {
	/** Call levels below the root (default 6). */
	depth?: number;
	/** Lifelines drawn (default 8): a sequence over this is not readable, so deeper calls into a new participant are cut. */
	maxParticipants?: number;
	/** Messages drawn (default 30). */
	maxMessages?: number;
	/** Path as shown to the agent (relative to the workspace). */
	rel?: (file: string) => string;
}

const VERB = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/;
const KIND: Record<FlowNode['kind'], NodeKind> = { controller: 'controller', handler: 'service', method: 'service', db: 'entity', ambiguous: 'interface', external: 'external' };

/** `OrderService.place` -> class `OrderService`, method `place`. A bare function is its own participant, named after its file. */
function split(n: FlowNode): { owner: string; method: string } {
	const label = n.label;
	const dot = label.lastIndexOf('.');
	if (dot > 0) {
		return { owner: label.slice(0, dot), method: label.slice(dot + 1) };
	}
	return { owner: n.file ? baseName(n.file).replace(/\.[^.]+$/, '') : label, method: label };
}

export function sequenceFromFlow(root: FlowNode, title: string, opts: SequenceOptions = {}): Generated {
	const depth = Math.max(1, opts.depth ?? 6);
	const maxParticipants = Math.max(2, opts.maxParticipants ?? 8);
	const maxMessages = Math.max(1, opts.maxMessages ?? 30);
	const notes: string[] = [];
	if (!root.children.length) {
		return skip(`${root.label} makes no call the index can follow, so there is no sequence to draw. Use flow_text to check what the index sees.`);
	}
	const nodes: GenNode[] = [];
	const edges: GenEdge[] = [];
	const byKey = new Map<string, GenNode>();
	let cutParticipants = 0;
	let cutMessages = 0;
	let guesses = 0;
	const ids = new Set<string>();
	const idOf = (base: string) => {
		let id = base.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'p';
		while (ids.has(id)) {
			id += '_';
		}
		ids.add(id);
		return id;
	};
	const rel = opts.rel ?? ((f: string) => f);

	// One participant per class; a table is a participant of its own, named after the table.
	const participant = (n: FlowNode): GenNode | undefined => {
		const { owner } = split(n);
		const key = n.kind === 'db' ? `db:${n.label}` : n.kind === 'external' ? `ext:${n.label}` : `c:${owner}`;
		let p = byKey.get(key);
		if (!p) {
			if (nodes.length >= maxParticipants) {
				return undefined;
			}
			p = {
				id: idOf(n.kind === 'db' ? n.label : owner),
				label: n.kind === 'db' ? n.label : owner,
				kind: KIND[n.kind] ?? 'class',
				...(n.kind === 'db' ? { shape: 'cylinder' as const, detail: n.schema ? `table of ${n.schema.entity}` : undefined } : {}),
				...(n.kind === 'external' ? { detail: 'external call (not in the workspace)' } : {}),
				...(n.kind !== 'db' && n.kind !== 'external' ? { symbol: owner } : n.kind === 'db' && n.schema ? { symbol: n.schema.entity } : {}),
				...(n.file ? { file: n.file, line: n.startLine } : n.kind === 'db' && n.schema?.file ? { file: n.schema.file, line: n.schema.line } : {}),
			};
			byKey.set(key, p);
			nodes.push(p);
		}
		return p;
	};

	const route = VERB.test(root.sub) ? root.sub : undefined;
	let client: GenNode | undefined;
	if (route) {
		client = { id: 'client', label: 'Client', kind: 'actor', shape: 'actor' };
		nodes.push(client);
		ids.add('client');
	}
	const rootP = participant(root)!;
	let order = 0;
	const message = (from: GenNode, to: GenNode, label: string, extra: Partial<GenEdge> = {}) => {
		edges.push({ from: from.id, to: to.id, kind: 'message', label, order: ++order, ...extra });
	};
	if (client && route) {
		message(client, rootP, route);
	}
	const expanded = new Set<string>();

	const walk = (n: FlowNode, from: GenNode, level: number) => {
		const key = n.symbolId ?? `${n.file}:${n.startLine}`;
		if (n.kind !== 'db' && expanded.has(key)) {
			return;
		}
		expanded.add(key);
		// Line order is the order the code makes the calls in; the sort is stable for calls on one line.
		const calls = n.children.map((c, i) => ({ c, i })).sort((a, b) => (a.c.callLine || 1e9) - (b.c.callLine || 1e9) || a.i - b.i).map(x => x.c);
		for (const c of calls) {
			if (order >= maxMessages + (client ? 1 : 0)) {
				cutMessages++;
				continue;
			}
			const to = participant(c.node);
			if (!to) {
				cutParticipants++;
				continue;
			}
			const callee = split(c.node).method;
			if (c.edgeKind === 'db') {
				const table = c.node.schema;
				const guess = !!c.guess;
				guesses += guess ? 1 : 0;
				message(from, to, `${table?.writes ? 'writes' : 'reads'}${table?.ops?.length ? ` ${table.ops[table.ops.length - 1]}` : ''}${guess ? ' ?' : ''}`, { kind: table?.writes ? 'writes' : 'reads', ...(guess ? { style: 'dotted' as const } : {}) });
				continue;
			}
			const guessed = !!c.guess || c.edgeKind === 'http' || c.edgeKind === 'message' || c.edgeKind === 'mediator';
			const marks = c.edgeKind === 'http' ? 'HTTP? ' : c.edgeKind === 'message' ? 'topic? ' : c.edgeKind === 'mediator' ? 'mediator? ' : c.guess ? '? ' : '';
			guesses += guessed ? 1 : 0;
			message(from, to, `${marks}${callee}`, {
				...(guessed ? { style: 'dotted' as const } : {}),
				...(c.edgeKind === 'message' ? { async: true } : {}),
			});
			if (level < depth) {
				walk(c.node, to, level + 1);
			} else if (c.node.children.length) {
				notes.push(`${split(c.node).owner}.${callee} makes ${c.node.children.length} deeper call(s) that are not drawn (depth ${depth}).`);
			}
		}
	};
	walk(root, rootP, 1);

	if (cutParticipants) {
		notes.push(`${cutParticipants} call(s) into further participants were left out: a sequence shows at most ${maxParticipants} lifelines. Draw a sequence for a deeper method (pass its file and method) to see them.`);
	}
	if (cutMessages) {
		notes.push(`${cutMessages} call(s) were left out: a sequence shows at most ${maxMessages} messages.`);
	}
	if (guesses) {
		notes.push(`${guesses} message(s) are guesses (dotted, marked "?"): linked by name, an HTTP route, a topic or a mediator, not read from a declared type.`);
	}
	notes.push('Messages are in the order the code makes the calls. Branches, loops and returns are not drawn: the index does not know them.');
	notes.push(...[...byKey.values()].filter(p => p.file).slice(0, 12).map(p => `${p.label}: ${rel(p.file!)}:${p.line}`));
	return {
		notes,
		board: {
			version: 1,
			kind: 'sequence',
			title,
			description: `${order} message${order === 1 ? '' : 's'} between ${nodes.length} participants, from ${root.label}.${cutMessages || cutParticipants ? ' Cut for size.' : ''}${guesses ? ` ${guesses} guessed.` : ''}`,
			direction: 'LR',
			nodes,
			edges,
			...(guesses ? { legend: [GUESS_LEGEND] } : {}),
		},
	};
}
