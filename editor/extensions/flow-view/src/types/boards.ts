/*---------------------------------------------------------------------------------------------
 *  Insilode type model: the two boards drawn from the type graph (the DTO relations as an ER
 *  diagram, the architecture as modules and roles) and the type tree behind a card's chips.
 *  Pure: no vscode.
 *--------------------------------------------------------------------------------------------*/

import type { BoardEdge, BoardGroup, BoardMember, BoardNode, BoardSpec, NodeKind } from '../board/spec';
import { findType } from './graph';
import { byCode, moduleGroupId, roleGroupId, type Collection, type TypeEdge, type TypeGraph, type TypeInfo, type TypeRole } from './model';
import { displayType } from './typeref';

export interface DtoBoardOptions {
	/** Case-insensitive substring of a type or field name: only matching types and their neighbours are drawn. */
	query?: string;
	/** A type id (or a name as written): draw only its neighbourhood. */
	focusId?: string;
	/** Hops from the focus type, default 1. */
	depth?: number;
	/** Entities (EF Core, JPA, Django models) are hidden unless asked for. */
	includeEntities?: boolean;
	/** Enums that DTO fields refer to are drawn unless turned off. */
	includeEnums?: boolean;
	/** More than this many nodes are cut (the most connected stay) and the description says so. Default 120. */
	maxNodes?: number;
}

export interface ArchitectureBoardOptions {
	/** A type id (or a name as written): draw only its neighbourhood. */
	focusId?: string;
	/** Hops from the focus type, default 2. */
	depth?: number;
	/** Roles left out; the default is `['dto', 'enum']`, which keeps the board about behaviour. */
	hideRoles?: TypeRole[];
	/** `module`: modules collapsed, roles inside (default); `role`: modules opened, role groups collapsed; `none`: everything open. */
	collapse?: 'module' | 'role' | 'none';
	maxNodes?: number;
}

/** One level of a type's tree: its fields and, for those that refer to another type, that type's own tree. */
export interface TypeDetail {
	id: string;
	name: string;
	kind: string;
	role: TypeRole;
	file: string;
	line: number;
	/** Enum members. */
	constants?: string[];
	fields: TypeDetailField[];
	/** Set when `depth` stopped the tree here: some field refers to a type that is not expanded. */
	truncated?: boolean;
}

export interface TypeDetailField {
	name: string;
	/** As declared, packages stripped. */
	type: string;
	card: Collection;
	/** The first type the field refers to, expanded one level deeper; absent for a plain field, a cycle or the depth limit. */
	child?: TypeDetail;
	/** The type the field refers to when it is not expanded (a cycle or the depth limit): chips can still link to it. */
	ref?: string;
}

/** The sentence a cut board's description carries; `cutOf` reads the numbers back, so the export can say the same without a second source of truth. */
const cutSentence = (shown: number, total: number, hint: string) => `Showing the ${shown} most connected of ${total} types: ${hint}.`;
const CUT_SENTENCE = /Showing the (\d+) most connected of (\d+) types:/;

/** How many types a board shows of how many its graph has, when `flow.types.maxNodes` (or the default limit) cut it; undefined for a whole diagram. */
export function cutOf(spec: Pick<BoardSpec, 'description'>): { shown: number; total: number } | undefined {
	const m = CUT_SENTENCE.exec(spec.description ?? '');
	return m ? { shown: Number(m[1]), total: Number(m[2]) } : undefined;
}

/**
 * Diagram source text with a first comment line `%% showing N of M types` (Mermaid) or `' showing N of M types` (PlantUML, after
 * `@startuml`) when the board was cut: a pasted diagram that looks complete otherwise hides that types are missing.
 */
export function withCutNote(text: string, spec: Pick<BoardSpec, 'description'>, format: 'mermaid' | 'plantuml'): string {
	const cut = cutOf(spec);
	if (!cut) {
		return text;
	}
	const note = `showing ${cut.shown} of ${cut.total} types`;
	if (format === 'mermaid') {
		return `%% ${note}\n${text}`;
	}
	const [first, ...rest] = text.split('\n');
	return [first, `' ${note}`, ...rest].join('\n');
}

const DEFAULT_DTO_NODES = 120;
const DEFAULT_ARCH_NODES = 150;
const MAX_FIELDS = 40;

/** Undirected neighbourhood of `start` within `allowed`, `depth` hops. */
export function neighbourhood(start: string[], edges: readonly { from: string; to: string }[], allowed: ReadonlySet<string>, depth: number): Set<string> {
	const adj = new Map<string, string[]>();
	for (const e of edges) {
		if (allowed.has(e.from) && allowed.has(e.to)) {
			adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
			adj.set(e.to, [...(adj.get(e.to) ?? []), e.from]);
		}
	}
	const seen = new Set(start.filter(s => allowed.has(s)));
	let frontier = [...seen];
	for (let d = 0; d < depth && frontier.length; d++) {
		const next: string[] = [];
		for (const id of frontier) {
			for (const n of adj.get(id) ?? []) {
				if (!seen.has(n)) {
					seen.add(n);
					next.push(n);
				}
			}
		}
		frontier = next;
	}
	return seen;
}

/** The most connected `max` of `ids` (the `keep` ones always). */
export function cut(ids: Set<string>, edges: readonly { from: string; to: string }[], max: number, keep: ReadonlySet<string>): Set<string> {
	if (ids.size <= max) {
		return ids;
	}
	const degree = new Map<string, number>();
	for (const e of edges) {
		if (ids.has(e.from) && ids.has(e.to) && e.from !== e.to) {
			degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
			degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
		}
	}
	const ranked = [...ids].sort((a, b) => Number(keep.has(b)) - Number(keep.has(a)) || (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || byCode(a, b));
	return new Set(ranked.slice(0, Math.max(1, max)));
}

const card = (c: Collection) => (c === 'many' ? '0..*' : c === 'optional' ? '0..1' : '1');

function matches(t: TypeInfo, q: string): boolean {
	return t.name.toLowerCase().includes(q) || t.qualifiedName.toLowerCase().includes(q) || t.fields.some(f => f.name.toLowerCase().includes(q));
}

/** `name: Map<String, List<AddressDto>>`: one line, packages stripped. */
const fieldText = (name: string, type: string) => `${name}: ${displayType(type)}`;

/**
 * The DTO relation (ER-like) board: every DTO of the workspace, an edge for each field that refers to another drawn type with the
 * cardinality the field's type says (a collection is 0..*, a nullable or optional is 0..1, anything else 1). Entities are left out
 * unless asked for; enums are drawn when a drawn type has a field of that enum. A search keeps the types that match and their direct
 * neighbours; a focus keeps the neighbourhood of one type, `depth` hops deep.
 */
export function dtoBoard(graph: TypeGraph, opts: DtoBoardOptions = {}): BoardSpec {
	const includeEntities = opts.includeEntities ?? graph.options.includeEntities;
	const includeEnums = opts.includeEnums ?? graph.options.includeEnums;
	const maxNodes = Math.max(1, Math.floor(opts.maxNodes ?? DEFAULT_DTO_NODES));
	const base = new Set(graph.types.filter(t => t.isDto || (includeEntities && t.role === 'entity')).map(t => t.id));
	const hiddenEntities = includeEntities ? 0 : graph.types.filter(t => t.role === 'entity').length;
	const fieldEdges = graph.edges.filter(e => e.via === 'field');
	const enums = new Set<string>();
	if (includeEnums) {
		for (const e of fieldEdges) {
			if (base.has(e.from) && graph.byId.get(e.to)?.kind === 'enum') {
				enums.add(e.to);
			}
		}
	}
	const universe = new Set([...base, ...enums]);
	let ids = new Set(universe);
	const keep = new Set<string>();
	let note = '';
	const focus = opts.focusId ? findType(graph, opts.focusId) : undefined;
	if (opts.focusId && !focus) {
		note = ` Focus "${opts.focusId}" is not a type of this workspace.`;
	}
	if (focus) {
		// A focus outside the base set (an entity, a service) still shows with what it refers to.
		const allowed = new Set([...universe, focus.id]);
		if (includeEnums) {
			for (const e of fieldEdges) {
				if (e.from === focus.id && graph.byId.get(e.to)?.kind === 'enum') {
					allowed.add(e.to);
				}
			}
		}
		ids = neighbourhood([focus.id], fieldEdges, allowed, Math.max(0, Math.floor(opts.depth ?? 1)));
		keep.add(focus.id);
	}
	const query = opts.query?.trim().toLowerCase();
	if (query) {
		const hits = [...ids].filter(id => matches(graph.byId.get(id)!, query));
		ids = neighbourhood(hits, fieldEdges, ids, 1);
		hits.forEach(h => keep.add(h));
		if (!hits.length) {
			note += ` Nothing matches "${opts.query}".`;
		}
	}
	const total = ids.size;
	ids = cut(ids, fieldEdges, maxNodes, keep);
	const nodes: BoardNode[] = [];
	const modules = new Set<string>();
	for (const id of [...ids].sort(byCode)) {
		const t = graph.byId.get(id)!;
		modules.add(t.module);
		const members: BoardMember[] = t.kind === 'enum'
			? (t.constants ?? []).slice(0, MAX_FIELDS).map(c => ({ text: c, kind: 'field' as const }))
			: t.fields.filter(f => !f.isStatic).slice(0, MAX_FIELDS).map((f): BoardMember => ({ text: fieldText(f.name, f.type), kind: 'field', ref: f.refs.find(r => ids.has(r)) }));
		nodes.push({
			id, label: t.name, kind: t.kind === 'enum' ? 'enum' : t.role === 'entity' ? 'entity' : 'dto',
			detail: t.kind === 'enum' ? 'enum' : t.isDto ? t.dtoReason : 'entity', group: moduleGroupId(t.module), file: t.file, line: t.line, members,
		});
	}
	const edges: BoardEdge[] = [];
	for (const e of fieldEdges) {
		if (ids.has(e.from) && ids.has(e.to)) {
			edges.push({
				from: e.from, to: e.to, kind: e.collection === 'many' ? 'has-many' : 'has', label: e.names.slice(0, 3).join(', ') + (e.names.length > 3 ? ', …' : ''),
				fromCard: '1', toCard: card(e.collection),
			});
		}
	}
	const groups: BoardGroup[] = [...modules].sort(byCode).map(m => ({ id: moduleGroupId(m), label: m }));
	const parts = [`${nodes.length} type${nodes.length === 1 ? '' : 's'}, ${edges.length} relation${edges.length === 1 ? '' : 's'}.`];
	if (total > nodes.length) {
		parts.push(cutSentence(nodes.length, total, 'search or focus a type to see the rest'));
	}
	if (hiddenEntities) {
		parts.push(`${hiddenEntities} entit${hiddenEntities === 1 ? 'y is' : 'ies are'} hidden.`);
	}
	if (!nodes.length && !opts.focusId && !query) {
		// An empty board with nothing filtered: say why, so the canvas's empty state can offer the two ways out.
		parts.push(`No DTO found: a name ending in ${graph.options.dtoSuffixes.join(', ')} counts as one.`);
	}
	return { version: 1, kind: 'er', title: focus ? `DTO relations: ${focus.name}` : 'DTO relations', description: parts.join(' ') + note, direction: 'LR', nodes, edges, groups };
}

const ROLE_KIND: Record<TypeRole, NodeKind> = { controller: 'controller', handler: 'entry', service: 'service', repository: 'repository', entity: 'entity', dto: 'dto', interface: 'interface', class: 'class', enum: 'enum' };
const ROLE_LABEL: Record<TypeRole, string> = { controller: 'Controllers', handler: 'Handlers', service: 'Services', repository: 'Repositories', entity: 'Entities', dto: 'DTOs', interface: 'Interfaces', class: 'Classes', enum: 'Enums' };
const ROLE_ORDER: TypeRole[] = ['controller', 'handler', 'service', 'repository', 'entity', 'dto', 'interface', 'class', 'enum'];
const EDGE_RANK: Record<string, number> = { extends: 0, implements: 1, ctor: 2, field: 3, generic: 4, method: 5 };

/**
 * The architecture board: not a class diagram of the repository but its layers. Modules are groups (closed until opened), the types of
 * a module sit in a group per role (controllers, handlers, services, repositories, entities, DTOs, interfaces, classes), and the edges are
 * inheritance, constructor injection (depends) and field or parameter types (uses), with class-to-class calls where nothing else links two types.
 */
export function architectureBoard(graph: TypeGraph, opts: ArchitectureBoardOptions = {}): BoardSpec {
	const hide = new Set<TypeRole>(opts.hideRoles ?? ['dto', 'enum']);
	const maxNodes = Math.max(1, Math.floor(opts.maxNodes ?? DEFAULT_ARCH_NODES));
	const collapse = opts.collapse ?? 'module';
	const universe = new Set(graph.types.filter(t => !hide.has(t.role)).map(t => t.id));
	// One edge per pair of types: inheritance beats injection beats a field or parameter type beats a call.
	const best = new Map<string, TypeEdge>();
	for (const e of graph.edges) {
		if (!universe.has(e.from) || !universe.has(e.to) || e.from === e.to) {
			continue;
		}
		const key = `${e.from}|${e.to}`;
		const hit = best.get(key);
		if (!hit || EDGE_RANK[e.via] < EDGE_RANK[hit.via]) {
			best.set(key, e);
		}
	}
	const pairs = [...best.values()];
	const calls = graph.calls.filter(c => universe.has(c.from) && universe.has(c.to) && c.from !== c.to && !best.has(`${c.from}|${c.to}`));
	const links = [...pairs, ...calls];
	let ids = new Set(universe);
	const keep = new Set<string>();
	const focus = opts.focusId ? findType(graph, opts.focusId) : undefined;
	let note = '';
	if (opts.focusId && !focus) {
		note = ` Focus "${opts.focusId}" is not a type of this workspace.`;
	} else if (focus) {
		const allowed = new Set([...universe, focus.id]);
		ids = neighbourhood([focus.id], [...links, ...graph.edges.filter(e => e.from === focus.id || e.to === focus.id)], allowed, Math.max(0, Math.floor(opts.depth ?? 2)));
		keep.add(focus.id);
	}
	const total = ids.size;
	ids = cut(ids, links, maxNodes, keep);
	const nodes: BoardNode[] = [];
	const modules = new Map<string, Set<TypeRole>>();
	for (const id of [...ids].sort(byCode)) {
		const t = graph.byId.get(id)!;
		modules.set(t.module, (modules.get(t.module) ?? new Set()).add(t.role));
		const members: BoardMember[] = [];
		for (const m of t.methods.filter(x => !x.isConstructor && !x.isAccessor && x.visibility !== '-').slice(0, 8)) {
			members.push({ text: `${m.name}${m.signature}`, kind: 'method', visibility: m.visibility });
		}
		if (!['controller', 'service', 'handler', 'repository'].includes(t.role)) {
			for (const f of t.fields.filter(x => !x.isStatic).slice(0, 6)) {
				members.push({ text: fieldText(f.name, f.type), kind: 'field', visibility: f.visibility });
			}
		}
		nodes.push({
			id, label: t.name, kind: ROLE_KIND[t.role], detail: `${t.role}${t.packageName ? ` · ${t.packageName}` : ''}`,
			group: roleGroupId(t.module, t.role), file: t.file, line: t.line, members: members.length ? members : undefined,
		});
	}
	const groups: BoardGroup[] = [];
	for (const [mod, roles] of [...modules].sort((a, b) => byCode(a[0], b[0]))) {
		groups.push({ id: moduleGroupId(mod), label: mod, collapsed: collapse === 'module' ? true : undefined });
		for (const role of ROLE_ORDER.filter(r => roles.has(r))) {
			groups.push({ id: roleGroupId(mod, role), label: ROLE_LABEL[role], parent: moduleGroupId(mod), collapsed: collapse === 'role' ? true : undefined });
		}
	}
	const edges: BoardEdge[] = [];
	for (const e of pairs) {
		if (ids.has(e.from) && ids.has(e.to)) {
			const kind = e.via === 'extends' ? 'extends' : e.via === 'implements' ? 'implements' : e.via === 'ctor' ? 'depends' : 'uses';
			edges.push({ from: e.from, to: e.to, kind, label: kind === 'extends' || kind === 'implements' ? undefined : e.names.slice(0, 2).join(', ') || undefined });
		}
	}
	for (const c of calls) {
		if (ids.has(c.from) && ids.has(c.to)) {
			edges.push({ from: c.from, to: c.to, kind: 'calls', label: `${c.count} call${c.count === 1 ? '' : 's'}` });
		}
	}
	const parts = [`${nodes.length} type${nodes.length === 1 ? '' : 's'} in ${modules.size} module${modules.size === 1 ? '' : 's'}, ${edges.length} relation${edges.length === 1 ? '' : 's'}.`];
	if (total > nodes.length) {
		parts.push(cutSentence(nodes.length, total, 'hide roles or focus a type to see the rest'));
	}
	if (hide.size) {
		parts.push(`Hidden roles: ${ROLE_ORDER.filter(r => hide.has(r)).join(', ')}.`);
	}
	return { version: 1, kind: 'architecture', title: focus ? `Architecture: ${focus.name}` : 'Architecture', description: parts.join(' ') + note, direction: 'TB', nodes, edges, groups };
}

/** The tree of a type for the chips on a card: its fields and, for those that refer to another type, that type's own tree, `depth` levels deep. */
export function typeDetail(graph: TypeGraph, ref: string, fromFile?: string, depth = 2): TypeDetail | undefined {
	const root = findType(graph, ref, fromFile);
	if (!root) {
		return undefined;
	}
	const build = (t: TypeInfo, level: number, path: ReadonlySet<string>): TypeDetail => {
		const fields: TypeDetailField[] = [];
		let cutShort = false;
		const here = new Set([...path, t.id]);
		for (const f of t.fields.filter(x => !x.isStatic).slice(0, 60)) {
			const target = f.refs[0] ? graph.byId.get(f.refs[0]) : undefined;
			const field: TypeDetailField = { name: f.name, type: f.type, card: f.collection };
			if (target) {
				if (level < depth && !here.has(target.id)) {
					field.child = build(target, level + 1, here);
				} else {
					field.ref = target.id;
					cutShort ||= !here.has(target.id);
				}
			}
			fields.push(field);
		}
		return { id: t.id, name: t.name, kind: t.kind, role: t.role, file: t.file, line: t.line, constants: t.constants, fields, truncated: cutShort || undefined };
	};
	return build(root, 0, new Set());
}
