/*---------------------------------------------------------------------------------------------
 *  Insilode type model: a board as Mermaid or PlantUML text, for a README or a wiki. Mermaid comes
 *  from board/mermaid.ts (ER boards as erDiagram, architecture boards as classDiagram, with the
 *  roles and modules as a flowchart when asked); PlantUML is written here. Node ids become n0,
 *  n1, ... and every text is cleaned, so nothing in a type name can break the diagram. Pure.
 *--------------------------------------------------------------------------------------------*/

import type { BoardEdge, BoardNode, BoardSpec } from '../../../../../board-canvas/spec';
import { toMermaid } from '../board/mermaid';

/**
 * The Mermaid source of a board (no code fence). An architecture board becomes a classDiagram (members, UML arrows);
 * `layout: 'flowchart'` keeps the modules and roles as nested subgraphs instead.
 */
export function exportMermaid(board: BoardSpec, opts: { layout?: 'class' | 'flowchart' } = {}): string {
	if (board.kind === 'architecture' && (opts.layout ?? 'class') === 'class') {
		return toMermaid({ ...board, kind: 'class' });
	}
	return toMermaid(board);
}

/** A text inside "..." or after a colon: no quotes, braces, line breaks or the PlantUML escape. */
const text = (s: string) => s.replace(/[\r\n]+/g, ' ').replace(/"/g, "'").replace(/@/g, '').replace(/[{}]/g, '').replace(/\\/g, '/').trim();

const STEREO: Partial<Record<NonNullable<BoardNode['kind']>, string>> = { controller: 'controller', service: 'service', repository: 'repository', entity: 'entity', dto: 'dto', interface: 'interface', enum: 'enum' };

function member(m: NonNullable<BoardNode['members']>[number]): string {
	return `${m.visibility ?? ''}${text(m.text)}`;
}

function umlNode(n: BoardNode, id: string, indent: string, out: string[], er: boolean) {
	const label = text(n.label);
	const members = n.members ?? [];
	if (n.kind === 'enum') {
		out.push(`${indent}enum "${label}" as ${id} {`, ...(members.map(m => `${indent}  ${text(m.text)}`)), `${indent}}`);
		return;
	}
	const keyword = er ? 'entity' : n.kind === 'interface' ? 'interface' : 'class';
	const stereo = !er && n.kind && STEREO[n.kind] && n.kind !== 'interface' ? ` <<${STEREO[n.kind]}>>` : '';
	out.push(`${indent}${keyword} "${label}" as ${id}${stereo}${members.length ? ' {' : ''}`);
	if (members.length) {
		out.push(...members.map(m => `${indent}  ${member(m)}`), `${indent}}`);
	}
}

function arrow(e: BoardEdge, a: string, b: string): string {
	const label = e.label ? ` : ${text(e.label)}` : '';
	switch (e.kind) {
		case 'extends': return `${b} <|-- ${a}${label}`;
		case 'implements': return `${b} <|.. ${a}${label}`;
		case 'uses': case 'depends': case 'reads': return `${a} ..> ${b}${label}`;
		case 'has': return `${a} "${e.fromCard ?? '1'}" --> "${e.toCard ?? '1'}" ${b}${label}`;
		case 'has-many': return `${a} "${e.fromCard ?? '1'}" --> "${e.toCard ?? '0..*'}" ${b}${label}`;
		default: return `${a} --> ${b}${label}`;
	}
}

/** The PlantUML source of a board: an ER board as entities and cardinalities, an architecture board as packages (modules) of packages (roles) of classes. */
export function exportPlantUml(board: BoardSpec): string {
	const ids = new Map(board.nodes.map((n, i) => [n.id, `n${i}`]));
	const out = ['@startuml', `title ${text(board.title)}`, 'hide empty members'];
	const er = board.kind === 'er';
	if (er) {
		out.push('hide circle', 'skinparam linetype ortho');
	} else {
		out.push('skinparam packageStyle rectangle', 'left to right direction');
	}
	const groups = new Map((board.groups ?? []).map(g => [g.id, g]));
	const byGroup = new Map<string | undefined, BoardNode[]>();
	for (const n of board.nodes) {
		const g = n.group && groups.has(n.group) ? n.group : undefined;
		byGroup.set(g, [...(byGroup.get(g) ?? []), n]);
	}
	const children = new Map<string | undefined, string[]>();
	for (const g of groups.values()) {
		const parent = g.parent && g.parent !== g.id && groups.has(g.parent) ? g.parent : undefined;
		children.set(parent, [...(children.get(parent) ?? []), g.id]);
	}
	const emitted = new Set<string>();
	const emitGroup = (gid: string, indent: string, depth: number) => {
		const g = groups.get(gid)!;
		if (emitted.has(gid) || depth > 8) {
			return;
		}
		emitted.add(gid);
		out.push(`${indent}package "${text(g.label)}" {`);
		(byGroup.get(gid) ?? []).forEach(n => umlNode(n, ids.get(n.id)!, indent + '  ', out, er));
		(children.get(gid) ?? []).forEach(c => emitGroup(c, indent + '  ', depth + 1));
		out.push(`${indent}}`);
	};
	(byGroup.get(undefined) ?? []).forEach(n => umlNode(n, ids.get(n.id)!, '', out, er));
	(children.get(undefined) ?? []).forEach(g => emitGroup(g, '', 0));
	for (const g of groups.keys()) {
		emitGroup(g, '', 0);
	}
	for (const e of board.edges) {
		const a = ids.get(e.from);
		const b = ids.get(e.to);
		if (a && b) {
			out.push(arrow(e, a, b));
		}
	}
	out.push('@enduml');
	return out.join('\n');
}
