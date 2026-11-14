/*---------------------------------------------------------------------------------------------
 *  Insilode boards generated from code: tables as an ER diagram. Tables, columns, primary keys and the entity behind each come
 *  from the entity readers (JPA, SQLAlchemy/Django, TypeORM, Prisma); the relations and their cardinality come from the
 *  relation fields of the entities (a to-many field is 0..*, a nullable to-one is 0..1). A table that only a migration
 *  declares is drawn from the migration (column names only) and says so. C# entities, which the analyzer reads without
 *  columns, come from their fields and are marked as guessed. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { DbColumn, DbSchema } from '../../../../../../protocol/flow';
import type { Migration } from '../../poly/model';
import { byCode, moduleGroupId, type TypeGraph, type TypeInfo } from '../../types/model';
import { MAX_LIST, skip, type GenBoard, type GenEdge, type GenGroup, type GenNode, type Generated } from './board';
import type { BoardMember } from '../../../../../../board-canvas/spec';

/** An entity's schema as the index's schema readers give it. */
export type ErSchema = Pick<DbSchema, 'entity' | 'table' | 'dbSchemaName' | 'columns' | 'relations' | 'file' | 'line'> & {
	/** The table's name is not written in the code (a naming default). */
	guess?: boolean;
	orm?: string;
};

export interface ErInput {
	schemas: ErSchema[];
	graph?: TypeGraph;
	migrations?: Migration[];
}

export interface ErScope {
	/** Table names or entity names: these tables and the tables they relate to directly. Omit for every table (cut to `maxTables`). */
	tables?: string[];
}

export interface ErOptions {
	/** Tables drawn (default 20): over it the most connected stay, the asked-for ones always. */
	maxTables?: number;
	/** Columns listed per table (default 30). */
	maxColumns?: number;
}

interface Table {
	id: string;
	schema: ErSchema;
	type?: TypeInfo;
	/** Read from a migration, not from an entity. */
	fromMigration?: string;
	/** Built from an entity's fields, not from an ORM reader. */
	fromFields?: boolean;
	migrationLine?: number;
}

interface Rel {
	from: Table;
	to: Table;
	field: string;
	/** Cardinality at the `from` end and at the `to` end. */
	fromCard: string;
	toCard: string;
	/** The field holds one target: this end owns the foreign key. */
	toOne: boolean;
}

const tableName = (s: string) => s.replace(/["'`[\]]/g, '').split('.').pop()!.trim().toLowerCase();
/** A C# entity's `Id` or `OrderId`: the key by convention, which is why such a table is marked as guessed. */
const looksLikeKey = (field: string, entity: string) => field === 'Id' || field.toLowerCase() === `${entity.toLowerCase()}id`;
const extOf = (file?: string | null) => (file ? file.slice(file.lastIndexOf('.')) : '');
const safeId = (s: string) => `t_${s.replace(/[^A-Za-z0-9_]+/g, '_')}`;

/** `one customer` / `many items` as the schema readers write them. */
function relationFields(s: ErSchema): Map<string, 'one' | 'many'> {
	const out = new Map<string, 'one' | 'many'>();
	for (const r of s.relations) {
		const m = /^(one|many)\s+(.+)$/.exec(r);
		if (m) {
			out.set(m[2].trim(), m[1] as 'one' | 'many');
		}
	}
	return out;
}

export function erFromTables(input: ErInput, scope: ErScope = {}, opts: ErOptions = {}): Generated {
	const maxTables = Math.max(2, opts.maxTables ?? 20);
	const maxColumns = Math.max(3, opts.maxColumns ?? 30);
	const notes: string[] = [];
	const graph = input.graph;
	const entityTypes = new Map<string, TypeInfo[]>();
	for (const t of graph?.types ?? []) {
		if (t.role === 'entity' || t.kind === 'class' || t.kind === 'record') {
			entityTypes.set(t.name, [...entityTypes.get(t.name) ?? [], t]);
		}
	}
	const typeFor = (s: ErSchema) => {
		const list = entityTypes.get(s.entity) ?? [];
		return list.find(t => s.file && t.file === s.file) ?? list.find(t => t.role === 'entity') ?? (list.length === 1 ? list[0] : undefined);
	};

	// Tables: the entity readers first; then entities only the type graph knows (C#); then tables only a migration declares.
	const tables: Table[] = [];
	// Two services (or two stacks in one folder) may each own a table of the same name: a table is told apart by its name, the module of its entity and the language of its file.
	const byTable = new Map<string, Table>();
	const lookup = (name: string, module?: string, file?: string | null) => byTable.get(`${tableName(name)}@${module ?? ''}@${extOf(file)}`) ?? tables.find(t => tableName(t.schema.table) === tableName(name));
	const add = (t: Omit<Table, 'id'>) => {
		const key = `${tableName(t.schema.table)}@${t.type?.module ?? ''}@${extOf(t.schema.file)}`;
		if (byTable.has(key)) {
			return;
		}
		let id = safeId(t.schema.table);
		while (tables.some(x => x.id === id)) {
			id += '_';
		}
		const table = { ...t, id };
		tables.push(table);
		byTable.set(key, table);
	};
	for (const s of input.schemas) {
		add({ schema: s, type: typeFor(s) });
	}
	for (const t of graph?.types ?? []) {
		if (t.role === 'entity' && t.kind !== 'enum' && !tables.some(x => x.type === t || (x.schema.entity === t.name && x.schema.file === t.file))) {
			const fields = t.fields.filter(f => !f.isStatic);
			const rels = fields.filter(f => f.refs.length).map(f => `${f.collection === 'many' ? 'many' : 'one'} ${f.name}`);
			const columns: DbColumn[] = fields.filter(f => !f.refs.length).map(f => ({ name: f.name, column: f.name, type: f.type, key: looksLikeKey(f.name, t.name), nullable: !!f.nullable, maxLength: null }));
			add({ schema: { entity: t.name, table: t.name, dbSchemaName: null, columns, relations: rels, file: t.file, line: t.line, guess: true, orm: 'fields' }, type: t, fromFields: true });
		}
	}
	for (const m of input.migrations ?? []) {
		for (const op of m.ops) {
			if (op.op === 'create' && !lookup(op.table)) {
				add({
					schema: { entity: op.table, table: op.table, dbSchemaName: null, columns: op.columns.map(c => ({ name: c, column: c, type: '', key: false, nullable: false, maxLength: null })), relations: [], file: m.file, line: op.line, guess: !!op.guess },
					fromMigration: m.name,
					migrationLine: op.line,
				});
			}
		}
	}
	if (!tables.length) {
		return skip('Insilode found no entity, ORM model or migration that declares a table in this workspace (it reads JPA, SQLAlchemy, Django, TypeORM, Prisma, EF Core and SQL/Flyway/Alembic/Liquibase migrations). Nothing to draw an ER diagram of.');
	}

	// Relations from the relation fields: a field of a schema'd entity named in `relations`, or any field that refers to another table's entity.
	const idByType = new Map<string, Table>();
	for (const t of tables) {
		if (t.type) {
			idByType.set(t.type.id, t);
		}
	}
	const rels: Rel[] = [];
	for (const t of tables) {
		if (!t.type) {
			continue;
		}
		const fields = relationFields(t.schema);
		for (const f of t.type.fields) {
			const word = fields.get(f.name);
			if (f.isStatic || (!word && t.schema.orm !== 'fields')) {
				continue;
			}
			for (const ref of f.refs) {
				const to = idByType.get(ref);
				if (!to) {
					continue;
				}
				const many = word ? word === 'many' : f.collection === 'many';
				rels.push({ from: t, to, field: f.name, toOne: !many, fromCard: many ? '1' : '0..*', toCard: many ? '0..*' : f.nullable || f.collection === 'optional' ? '0..1' : '1' });
			}
		}
	}
	// A foreign key the reader names in the column's type (SQLAlchemy `ForeignKey("customers.id")`, written `→customers.id`) is a certain relation, whatever the type graph says.
	for (const t of tables) {
		for (const c of t.schema.columns) {
			const target = /^→\s*([^.\s]+)/.exec(c.type);
			const to = target ? lookup(target[1], t.type?.module, t.schema.file) : undefined;
			if (to && !rels.some(r => r.from === t && r.to === to && r.toOne)) {
				rels.push({ from: t, to, field: c.name, toOne: true, fromCard: '0..*', toCard: c.nullable ? '0..1' : '1' });
			}
		}
	}
	if (!graph && input.schemas.some(s => s.relations.length)) {
		notes.push('The type graph was not available, so relations between tables are not drawn (columns and keys are).');
	}
	// The two ends of one relationship (Order.items and Item.order) are drawn once: from the end that holds the foreign key.
	const merged: { rel: Rel; label: string }[] = [];
	const used = new Set<Rel>();
	for (const r of rels) {
		if (used.has(r)) {
			continue;
		}
		used.add(r);
		const back = rels.find(o => !used.has(o) && o.from === r.to && o.to === r.from && o.toOne !== r.toOne);
		if (back) {
			used.add(back);
			const owner = r.toOne ? r : back;
			const other = r.toOne ? back : r;
			merged.push({ rel: owner, label: `${owner.field} / ${other.field}` });
		} else {
			merged.push({ rel: r, label: r.field });
		}
	}

	// Scope: the asked-for tables and their direct neighbours; the most connected stay when over the cap.
	const asked = (scope.tables ?? []).map(s => s.trim()).filter(Boolean);
	const seeds = new Set<Table>();
	const unmatched: string[] = [];
	for (const a of asked) {
		const key = tableName(a);
		const hit = tables.filter(t => tableName(t.schema.table) === key || t.schema.entity.toLowerCase() === a.toLowerCase());
		hit.forEach(h => seeds.add(h));
		if (!hit.length) {
			unmatched.push(a);
		}
	}
	if (asked.length && !seeds.size) {
		return skip(`No table or entity named ${asked.map(a => `"${a}"`).join(', ')}. Tables: ${tables.map(t => t.schema.table).sort(byCode).slice(0, 30).join(', ')}${tables.length > 30 ? ', ...' : ''}.`);
	}
	if (unmatched.length) {
		notes.push(`No table or entity named ${unmatched.map(a => `"${a}"`).join(', ')}; ignored.`);
	}
	let chosen = new Set<Table>(asked.length ? seeds : tables);
	if (asked.length) {
		for (const m of merged) {
			if (seeds.has(m.rel.from) || seeds.has(m.rel.to)) {
				chosen.add(m.rel.from);
				chosen.add(m.rel.to);
			}
		}
	}
	const universe = chosen.size;
	if (chosen.size > maxTables) {
		const degree = new Map<Table, number>();
		for (const m of merged) {
			if (chosen.has(m.rel.from) && chosen.has(m.rel.to)) {
				degree.set(m.rel.from, (degree.get(m.rel.from) ?? 0) + 1);
				degree.set(m.rel.to, (degree.get(m.rel.to) ?? 0) + 1);
			}
		}
		const ranked = [...chosen].sort((a, b) => Number(seeds.has(b)) - Number(seeds.has(a)) || (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || byCode(a.schema.table, b.schema.table));
		chosen = new Set(ranked.slice(0, maxTables));
		notes.push(`Showing ${maxTables} of ${universe} tables (the most connected${seeds.size ? ' and the ones you asked for' : ''}). Pass \`scope.tables\` with the table names you care about to see their neighbourhood.`);
	}

	const ordered = tables.filter(t => chosen.has(t)).sort((a, b) => byCode(a.schema.table, b.schema.table));
	const edges: GenEdge[] = [];
	for (const m of merged) {
		if (chosen.has(m.rel.from) && chosen.has(m.rel.to)) {
			edges.push({ from: m.rel.from.id, to: m.rel.to.id, kind: m.rel.toCard === '0..*' ? 'has-many' : 'has', label: m.label, fromCard: m.rel.fromCard, toCard: m.rel.toCard, ...(m.rel.from.fromFields || m.rel.to.fromFields ? { style: 'dotted' as const } : {}) });
		}
	}
	const fkTargets = new Map<string, Table>();
	for (const e of edges) {
		fkTargets.set(`${e.from}|${e.label?.split(' / ')[0]}`, ordered.find(t => t.id === e.to)!);
	}
	const modules = new Set(ordered.map(t => t.type?.module).filter((m): m is string => !!m));
	const nodes: GenNode[] = ordered.map(t => {
		const s = t.schema;
		const members: BoardMember[] = s.columns.slice(0, maxColumns).map(c => {
			const target = fkTargets.get(`${t.id}|${c.name}`);
			const fk = !!target || (!c.key && /_id$/i.test(c.column) && [...fkTargets.keys()].some(k => k.startsWith(`${t.id}|`)));
			return { text: `${c.name}${c.type ? `: ${c.type}` : ''}${c.key ? '  PK' : fk ? '  FK' : ''}`, kind: 'field' as const, ...(target ? { ref: target.id } : {}) };
		});
		if (s.columns.length > maxColumns) {
			members.push({ text: `… ${s.columns.length - maxColumns} more columns`, kind: 'field' });
		}
		return {
			id: t.id,
			label: s.table,
			kind: 'entity' as const,
			detail: t.fromMigration ? `declared by migration ${t.fromMigration}; no entity found` : `entity ${s.entity}${s.guess ? ' · table name guessed' : ''}${t.fromFields ? ' · columns from fields' : ''}`,
			...(t.fromMigration ? {} : { symbol: s.entity }),
			...(s.file ? { file: s.file, line: t.migrationLine ?? s.line } : {}),
			...(t.type && modules.size > 1 ? { group: moduleGroupId(t.type.module) } : {}),
			...(members.length ? { members } : {}),
		};
	});
	const groups: GenGroup[] | undefined = modules.size > 1 ? [...modules].sort(byCode).map(m => ({ id: moduleGroupId(m), label: m })) : undefined;
	const migrationOnly = ordered.filter(t => t.fromMigration);
	if (migrationOnly.length) {
		notes.push(`${migrationOnly.length} table(s) are declared only by a migration (no entity found), so they show column names only: ${migrationOnly.slice(0, MAX_LIST).map(t => t.schema.table).join(', ')}.`);
	}
	const fromFields = ordered.filter(t => t.fromFields);
	if (fromFields.length) {
		notes.push(`${fromFields.length} table(s) come from entity fields, not an ORM reader (the C# analyzer reads no columns): table name, keys and column list are guesses (dotted relations): ${fromFields.slice(0, MAX_LIST).map(t => t.schema.entity).join(', ')}.`);
	}
	const guessedNames = ordered.filter(t => t.schema.guess && !t.fromFields && !t.fromMigration);
	if (guessedNames.length) {
		notes.push(`Table name guessed (a naming default, not written in the code): ${guessedNames.slice(0, MAX_LIST).map(t => t.schema.table).join(', ')}.`);
	}
	notes.push('Not drawn: relations declared only in the database (foreign keys no entity or migration reader sees), views, and cross-service relations.');
	const board: GenBoard = {
		version: 1,
		kind: 'er',
		title: asked.length ? `Tables: ${[...seeds].map(t => t.schema.table).slice(0, 4).join(', ')}` : 'Tables',
		description: `${nodes.length} table${nodes.length === 1 ? '' : 's'}, ${edges.length} relation${edges.length === 1 ? '' : 's'}, read from the entities and migrations.${universe > nodes.length ? ` ${universe - nodes.length} more not shown.` : ''}`,
		direction: 'LR',
		nodes,
		edges,
		...(groups ? { groups } : {}),
		...(seeds.size === 1 ? { focus: [...seeds][0].id } : {}),
		...(edges.some(e => e.style === 'dotted') ? { legend: [{ key: 'guess', text: 'dotted: a guess, from entity fields rather than an ORM reader' }] } : {}),
	};
	return { board, notes };
}
