/*---------------------------------------------------------------------------------------------
 *  Insilode boards as mermaid text: the stand-in renderer until the canvas draws boards itself.
 *  flow, plan and architecture boards become a flowchart; class → classDiagram; er → erDiagram;
 *  sequence → sequenceDiagram. Node ids are renamed n0, n1, ... (agents' ids may contain anything)
 *  and every label is quoted and escaped, so no text from a board can break out of the diagram.
 *  Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { BoardEdge, BoardGroup, BoardNode, BoardSpec, NodeStatus } from '../../../../../board-canvas/spec';

/** A label inside "...": quotes, angle brackets, separators and line breaks become mermaid entities. */
export function label(text: string): string {
	// ';' first: the entities below contain one.
	return text.replace(/[\r\n]+/g, ' ').replace(/;/g, '#59;').replace(/%/g, '#37;').replace(/\|/g, '#124;').replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;').replace(/`/g, "'").trim();
}

/** An identifier for erDiagram entities and class names: words and digits, never empty. */
export function ident(text: string, fallback: string): string {
	const s = text.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
	return /^[A-Za-z_]/.test(s) ? s : s ? `_${s}` : fallback;
}

const MARK: Record<NodeStatus, string> = { todo: '', doing: '▶ ', done: '✓ ', skipped: '– ', blocked: '✕ ' };

const CLASS_DEFS = [
	'classDef done fill:#1f6f43,stroke:#5fe0a1,color:#fff',
	'classDef doing fill:#26418f,stroke:#6f86ff,color:#fff',
	'classDef blocked fill:#7a1f2b,stroke:#ff6b7d,color:#fff',
	'classDef skipped fill:#3a3d48,stroke:#777,color:#bbb,stroke-dasharray:4 3',
];

/** Flowchart shape of a node kind: open and close delimiters around the quoted label. */
function shape(kind: BoardNode['kind']): [string, string] {
	switch (kind) {
		case 'entry': case 'actor': return ['([', '])'];
		case 'decision': return ['{', '}'];
		case 'repository': case 'entity': return ['[(', ')]'];
		case 'external': return ['[[', ']]'];
		case 'interface': case 'dto': case 'enum': return ['[/', '/]'];
		case 'note': return ['>', ']'];
		default: return ['[', ']'];
	}
}

function flowchart(spec: BoardSpec, ids: Map<string, string>): string[] {
	const dir = spec.direction ?? (spec.kind === 'plan' ? 'TB' : 'LR');
	const out = [`flowchart ${dir}`];
	const groups = new Map((spec.groups ?? []).map(g => [g.id, g]));
	const node = (n: BoardNode, indent: string) => {
		const [open, close] = shape(n.kind);
		// A detail line is a <br/> inside the quotes (mermaid renders it as a line break).
		const text = label(`${MARK[n.status ?? 'todo']}${n.label}`) + (n.detail ? `<br/>${label(n.detail)}` : '');
		out.push(`${indent}${ids.get(n.id)}${open}"${text}"${close}`);
	};
	const byGroup = new Map<string | undefined, BoardNode[]>();
	for (const n of spec.nodes) {
		const g = n.group && groups.has(n.group) ? n.group : undefined;
		byGroup.set(g, [...(byGroup.get(g) ?? []), n]);
	}
	const children = new Map<string | undefined, BoardGroup[]>();
	for (const g of groups.values()) {
		const parent = g.parent && g.parent !== g.id && groups.has(g.parent) ? g.parent : undefined;
		children.set(parent, [...(children.get(parent) ?? []), g]);
	}
	const emitted = new Set<string>();
	const emitGroup = (g: BoardGroup, indent: string, depth: number) => {
		if (emitted.has(g.id) || depth > 8) {
			return;
		}
		emitted.add(g.id);
		out.push(`${indent}subgraph g${[...groups.keys()].indexOf(g.id)}["${label(g.label)}"]`);
		(byGroup.get(g.id) ?? []).forEach(n => node(n, indent + '  '));
		(children.get(g.id) ?? []).forEach(c => emitGroup(c, indent + '  ', depth + 1));
		out.push(`${indent}end`);
	};
	(byGroup.get(undefined) ?? []).forEach(n => node(n, '  '));
	(children.get(undefined) ?? []).forEach(g => emitGroup(g, '  ', 0));
	// A group in a cycle of parents is never reached from the top: draw it flat rather than lose its nodes.
	for (const g of groups.values()) {
		emitGroup(g, '  ', 0);
	}
	for (const e of spec.edges) {
		const from = ids.get(e.from);
		const to = ids.get(e.to);
		if (!from || !to) {
			continue;
		}
		const text = e.label ?? (e.kind === 'yes' ? 'yes' : e.kind === 'no' ? 'no' : undefined);
		const arrow = e.kind === 'reads' || e.kind === 'uses' || e.kind === 'depends' ? '-.->' : e.kind === 'writes' ? '==>' : '-->';
		out.push(`  ${from} ${arrow}${text ? `|"${label(text)}"|` : ''} ${to}`);
	}
	const styled = spec.nodes.filter(n => n.status && n.status !== 'todo');
	if (styled.length) {
		out.push(...CLASS_DEFS.map(l => `  ${l}`));
		for (const status of ['done', 'doing', 'blocked', 'skipped'] as const) {
			const members = styled.filter(n => n.status === status).map(n => ids.get(n.id));
			if (members.length) {
				out.push(`  class ${members.join(',')} ${status}`);
			}
		}
	}
	return out;
}

/** "name: Type" or "Type name" → "Type name"; anything else keeps its words. */
function attribute(text: string): string {
	const colon = /^\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_][\w<>\[\],. ]*)\s*$/.exec(text);
	if (colon) {
		return `${ident(colon[2], 'string')} ${ident(colon[1], 'field')}`;
	}
	const parts = text.trim().split(/\s+/).map(p => ident(p, '')).filter(Boolean);
	return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : `string ${parts[0] ?? 'field'}`;
}

const LEFT: Record<string, string> = { '1': '||', '0..1': '|o', '0..*': '}o', '*': '}o', '1..*': '}|' };
const RIGHT: Record<string, string> = { '1': '||', '0..1': 'o|', '0..*': 'o{', '*': 'o{', '1..*': '|{' };

function er(spec: BoardSpec): string[] {
	const names = new Map<string, string>();
	const used = new Set<string>();
	for (const n of spec.nodes) {
		let name = ident(n.label, `E${names.size}`);
		while (used.has(name)) {
			name += '_';
		}
		used.add(name);
		names.set(n.id, name);
	}
	const out = ['erDiagram'];
	for (const n of spec.nodes) {
		const attrs = (n.members ?? []).slice(0, 40).map(m => `    ${attribute(m.text)}`);
		out.push(`  ${names.get(n.id)} {`, ...attrs, '  }');
	}
	for (const e of spec.edges) {
		const a = names.get(e.from);
		const b = names.get(e.to);
		if (!a || !b) {
			continue;
		}
		const left = LEFT[e.fromCard ?? ''] ?? '||';
		const right = RIGHT[e.toCard ?? ''] ?? (e.kind === 'has-many' ? 'o{' : '||');
		out.push(`  ${a} ${left}--${right} ${b} : "${label(e.label ?? e.kind ?? 'has')}"`);
	}
	return out;
}

const CLASS_ARROW: Partial<Record<NonNullable<BoardEdge['kind']>, (a: string, b: string) => string>> = {
	extends: (a, b) => `${b} <|-- ${a}`,
	implements: (a, b) => `${b} <|.. ${a}`,
	has: (a, b) => `${a} *-- ${b}`,
	'has-many': (a, b) => `${a} "1" --> "*" ${b}`,
	uses: (a, b) => `${a} ..> ${b}`,
	depends: (a, b) => `${a} ..> ${b}`,
};

function classDiagram(spec: BoardSpec, ids: Map<string, string>): string[] {
	const out = ['classDiagram', `  direction ${spec.direction ?? 'TB'}`];
	for (const n of spec.nodes) {
		const id = ids.get(n.id)!;
		out.push(`  class ${id}["${label(n.label)}"] {`);
		if (n.kind === 'interface' || n.kind === 'enum') {
			out.push(`    <<${n.kind}>>`);
		}
		for (const m of (n.members ?? []).slice(0, 40)) {
			// classDiagram member lines cannot hold braces, quotes or backticks.
			out.push(`    ${m.visibility ?? ''}${m.text.replace(/[{}"`]/g, '').replace(/[\r\n]+/g, ' ')}`);
		}
		out.push('  }');
	}
	for (const e of spec.edges) {
		const a = ids.get(e.from);
		const b = ids.get(e.to);
		if (!a || !b) {
			continue;
		}
		const line = (CLASS_ARROW[e.kind ?? 'calls'] ?? ((x: string, y: string) => `${x} --> ${y}`))(a, b);
		out.push(`  ${line}${e.label ? ` : ${label(e.label)}` : ''}`);
	}
	return out;
}

/** The nesting of a message's fragment: group ids from the outermost down, for the groups that are fragments. */
function fragmentChain(groups: Map<string, BoardGroup>, id: string | undefined): BoardGroup[] {
	const chain: BoardGroup[] = [];
	for (let g = id ? groups.get(id) : undefined; g && !chain.includes(g) && chain.length < 8; g = g.parent ? groups.get(g.parent) : undefined) {
		chain.unshift(g);
	}
	return chain;
}

function sequence(spec: BoardSpec, ids: Map<string, string>): string[] {
	const out = ['sequenceDiagram'];
	for (const n of spec.nodes) {
		out.push(`  ${n.kind === 'actor' || n.shape === 'actor' ? 'actor' : 'participant'} ${ids.get(n.id)} as ${label(n.label)}`);
	}
	const groups = new Map((spec.groups ?? []).filter(g => g.kind === 'alt' || g.kind === 'loop' || g.kind === 'opt').map(g => [g.id, g]));
	// Messages in drawn order: by `order`, then array position.
	const edges = spec.edges.map((e, i) => ({ e, i })).sort((a, b) => (a.e.order ?? Infinity) - (b.e.order ?? Infinity) || a.i - b.i).map(x => x.e);
	let open: BoardGroup[] = [];
	const close = (to: number) => {
		while (open.length > to) {
			open.pop();
			out.push(`${'  '.repeat(open.length + 1)}end`);
		}
	};
	for (const e of edges) {
		const a = ids.get(e.from);
		const b = ids.get(e.to);
		if (!a || !b) {
			continue;
		}
		const chain = fragmentChain(groups, e.fragment);
		let common = 0;
		while (common < open.length && common < chain.length && open[common] === chain[common]) {
			common++;
		}
		close(common);
		for (const g of chain.slice(common)) {
			const parent = open[open.length - 1];
			const isElse = g.kind === 'alt' && parent?.kind === 'alt' && g.parent === parent.id;
			if (isElse) {
				// An else branch continues its parent's box.
				out.push(`${'  '.repeat(open.length)}else ${label(g.label)}`);
				open[open.length - 1] = g;
			} else {
				out.push(`${'  '.repeat(open.length + 1)}${g.kind} ${label(g.label)}`);
				open.push(g);
			}
		}
		const arrow = e.async ? '-)' : e.style === 'dashed' ? '-->>' : e.kind === 'reads' || e.kind === 'uses' ? '-->>' : '->>';
		out.push(`${'  '.repeat(open.length + 1)}${a}${arrow}${b}: ${label(e.label ?? '') || ' '}`);
	}
	close(0);
	return out;
}

function state(spec: BoardSpec, ids: Map<string, string>): string[] {
	const out = ['stateDiagram-v2', `  direction ${spec.direction === 'TB' ? 'TB' : 'LR'}`];
	const byId = new Map(spec.nodes.map(n => [n.id, n]));
	for (const n of spec.nodes) {
		if (n.shape === 'initial' || n.shape === 'final') {
			continue;
		}
		if (n.shape === 'choice') {
			out.push(`  state ${ids.get(n.id)} <<choice>>`);
		} else {
			out.push(`  state "${label(n.label)}" as ${ids.get(n.id)}`);
		}
	}
	const name = (id: string) => {
		const n = byId.get(id);
		return n?.shape === 'initial' || n?.shape === 'final' ? '[*]' : ids.get(id);
	};
	for (const e of spec.edges) {
		const a = name(e.from);
		const b = name(e.to);
		if (!a || !b) {
			continue;
		}
		const text = [e.label, e.guard ? `[${e.guard}]` : ''].filter(Boolean).join(' ');
		out.push(`  ${a} --> ${b}${text ? ` : ${label(text)}` : ''}`);
	}
	return out;
}

/** The mermaid source of a board (no code fence). */
export function toMermaid(spec: BoardSpec): string {
	const ids = new Map<string, string>(spec.nodes.map((n, i) => [n.id, `n${i}`]));
	const lines = spec.kind === 'er' ? er(spec)
		: spec.kind === 'class' ? classDiagram(spec, ids)
		: spec.kind === 'sequence' ? sequence(spec, ids)
		: spec.kind === 'state' ? state(spec, ids)
		: flowchart(spec, ids);
	return lines.join('\n');
}
