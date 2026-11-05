/*---------------------------------------------------------------------------------------------
 *  Insilode boards generated from code, the Board from Code command: the quick-pick items for the kind and for the scope, built
 *  from what the index knows (real tables, enums, modules) instead of free text. Pure: no `vscode`; the command turns the items
 *  into a quick pick and sends the chosen scope to `board_from_code`.
 *--------------------------------------------------------------------------------------------*/

import type { FromCodeKind } from './board';

/** What the command read from the index to offer as choices. */
export interface ScopeSource {
	/** Table names (from the schema readers) and entity types. */
	tables: { name: string; detail?: string }[];
	/** Enum type names. */
	enums: { name: string; detail?: string }[];
	/** Modules or services of the type graph. */
	modules: string[];
	/** The code index has finished its first build: while it has not, the lists may be short. */
	indexReady: boolean;
}

/** What the index gives the command: schema readers' output and the type graph, as far as the picks need them. */
export interface IndexForChoices {
	schemas: { table: string; entity?: string }[];
	graph?: { types: { name: string; kind: string; role: string; module: string }[] };
	indexReady: boolean;
}

/** The lists the scope picks are built from: tables (schema tables, then entity types), enums and modules of the type graph. */
export function scopeSourceFrom({ schemas, graph, indexReady }: IndexForChoices): ScopeSource {
	const types = graph?.types ?? [];
	return {
		tables: [
			...schemas.map(s => ({ name: s.table, detail: s.entity && s.entity !== s.table ? s.entity : undefined })),
			...types.filter(t => t.role === 'entity').map(t => ({ name: t.name, detail: 'entity' })),
		],
		enums: types.filter(t => t.kind === 'enum').map(t => ({ name: t.name, detail: t.module })),
		modules: [...new Set(types.map(t => t.module))],
		indexReady,
	};
}

export interface KindChoice {
	label: string;
	description: string;
	kind: FromCodeKind;
	/** Sequence without an open flow: the command explains instead of drawing. */
	needsFlow: boolean;
}

export interface ScopeChoice {
	label: string;
	description?: string;
	/** The `scope` of `board_from_code`; empty means the whole project. */
	scope: Record<string, unknown>;
}

/** The first quick pick: the four kinds. Sequence says so when no flow is open, because it draws the flow on the canvas. */
export function kindChoices(flowOpen: boolean): KindChoice[] {
	return [
		{ label: 'Sequence', description: flowOpen ? 'the calls of the flow on the canvas, in order' : 'the calls of the flow on the canvas, in order (needs an open flow)', kind: 'sequence', needsFlow: !flowOpen },
		{ label: 'Tables (ER)', description: 'columns, keys and relations', kind: 'er', needsFlow: false },
		{ label: 'Architecture', description: 'modules or packages and their dependencies', kind: 'architecture', needsFlow: false },
		{ label: 'States', description: 'an enum and its transitions', kind: 'state', needsFlow: false },
	];
}

/** The most items a scope pick lists: a longer list is searched by typing, but the picker should not be a wall. */
export const MAX_CHOICES = 200;

const byName = <T extends { name: string }>(list: T[]): T[] => {
	const seen = new Set<string>();
	return list.filter(x => !seen.has(x.name) && !!seen.add(x.name)).sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * The second quick pick: "Whole project" first, then what the index has. Sequence has no pick (its scope is the open flow), so it
 * returns nothing. An index that is still building says so in the first item, since the list after it may be short.
 */
export function scopeChoices(kind: FromCodeKind, source: ScopeSource): ScopeChoice[] {
	if (kind === 'sequence') {
		return [];
	}
	const building = source.indexReady ? '' : ' (the code index is still building: the list may be short)';
	const whole: Record<Exclude<FromCodeKind, 'sequence'>, ScopeChoice> = {
		er: { label: 'Whole project', description: `every table, capped${building}`, scope: {} },
		architecture: { label: 'Whole project', description: `every module${building}`, scope: {} },
		state: { label: 'Whole project', description: `let Insilode look for the enum with clear transitions${building}`, scope: {} },
	};
	if (kind === 'er') {
		return [whole.er, ...byName(source.tables).slice(0, MAX_CHOICES).map((t): ScopeChoice => ({ label: t.name, description: t.detail, scope: { tables: [t.name] } }))];
	}
	if (kind === 'architecture') {
		return [whole.architecture, ...[...new Set(source.modules)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_CHOICES).map((m): ScopeChoice => ({ label: m, description: 'module', scope: { module: m } }))];
	}
	return [whole.state, ...byName(source.enums).slice(0, MAX_CHOICES).map((e): ScopeChoice => ({ label: e.name, description: e.detail, scope: { enum: e.name } }))];
}

/** The text an error of `board_from_code` is shown with: the whole message (an agent-facing one can span lines), not its first line. */
export function boardFromCodeMessage(message: string): string {
	return message.split('\n').map(l => l.trim()).filter(Boolean).join(' ');
}
