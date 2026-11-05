/*---------------------------------------------------------------------------------------------
 *  Insilode agent bridge: which flows an agent's turn touched. Given the files edited in a turn, finds the
 *  entry points (endpoints, jobs) that reach the methods the turn changed, using only backends that are
 *  ready (nothing is started or asked). With the turn's line ranges (`rangesOf`) only the methods an edit
 *  landed in count, and each flow says which of them it goes through; an edit outside every method, or a
 *  file without ranges, counts the whole file ("may be affected"). An edit that lands in an entity (or its ORM
 *  configuration) also names the table it maps to and the endpoints that read or write that table (tableIndex.ts).
 *  Capped in time and size because Roslyn answers one request at a time.
 *--------------------------------------------------------------------------------------------*/

import type { Analyzer } from '../analyzer';
import { entryName, type Endpoints, type Entry } from '../backends';
import type { PolyIndex } from '../poly/client';
import type { FlowProvider, FlowTarget } from '../providers';
import { promises as fs } from 'fs';
import { methodsTouched, spansMatch, type LineRange, type MethodSpan } from './changedMethods';
import { isMigrationPath } from '../poly/migrations';
import type { ChangedTable, TableIndex } from './tableIndex';

export interface AffectedFlow {
	id: string;
	/** What the user reads: the verb and route ("POST /orders"). */
	label: string;
	/** What `flow.showEntry` takes as the label: "Orders.Place". */
	name: string;
	source: 'roslyn' | 'poly';
	/** The changed methods this flow goes through ("Orders.Place"), when the turn's edits were placed in methods. */
	via?: string[];
}

/** A method an edit landed in, as a flow target. */
export interface ChangedMethod {
	target: FlowTarget;
	name: string;
	file: string;
	line: number;
}

export interface TurnImpact {
	files: number;
	flows: AffectedFlow[];
	/** The methods the edits landed in (only where the edits' lines are known), in file order. */
	changed: ChangedMethod[];
	/** The tables whose entity (or ORM configuration) the edits landed in, with who reads or writes each. */
	tables: ChangedTable[];
	/** More flows than fit in `flows`. */
	more: number;
	/** Why the answer may be incomplete. */
	note?: string;
}

/** After an agent's turn: quick, a few files. A change set (a whole branch) passes larger ones. */
export interface ImpactLimits {
	files: number;
	functionsPerFile: number;
	flows: number;
	budgetMs: number;
	/** Changed tables looked at, and the time their endpoints may take on top of `budgetMs`. */
	tables: number;
	tableBudgetMs: number;
}
const TURN_LIMITS: ImpactLimits = { files: 6, functionsPerFile: 25, flows: 12, budgetMs: 7000, tables: 4, tableBudgetMs: 4000 };

/**
 * Where the edits landed in each file, for the entity they are in. A C# file comes with its text so the analyzer's spans can be checked
 * against the disk, and a migration (any file it could be) with its text to be read; the code index re-read the others a moment ago.
 */
async function placed(files: string[], d: { rangesOf?(file: string): Promise<LineRange[] | undefined> }) {
	return Promise.all(files.map(async file => ({
		file,
		ranges: await d.rangesOf?.(file).catch(() => undefined),
		text: /\.cs$/i.test(file) || isMigrationPath(file) ? await fs.readFile(file, 'utf8').catch(() => undefined) : undefined,
	})));
}

/** The endpoints a changed table reaches that no changed method does: the change set draws them and the agent is told their ids. */
export function tableEndpoints(impact: Pick<TurnImpact, 'flows' | 'tables'>): AffectedFlow[] {
	const seen = new Set(impact.flows.map(f => `${f.source}:${f.id}`));
	const out: AffectedFlow[] = [];
	for (const t of impact.tables) {
		for (const u of t.uses) {
			const key = `${u.endpoint.source}:${u.endpoint.id}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push({ id: u.endpoint.id, label: u.endpoint.label, name: u.endpoint.name, source: u.endpoint.source, via: [`table ${t.table}`] });
			}
		}
	}
	return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** The entry an impact line ("GET Users.Delete", "DELETE /users/{id} UsersController.Delete") stands for. */
export function entryForItem(item: string, entries: Entry[]): Entry | undefined {
	const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
	const want = norm(item);
	return entries.find(e => norm(`${e.http} ${e.controller}.${e.action}`) === want)
		?? entries.find(e => norm(`${e.http} ${entryName(e)}`) === want)
		?? entries.find(e => ` ${want}`.endsWith(` ${norm(`${e.controller}.${e.action}`)}`) || ` ${want}`.endsWith(` ${norm(entryName(e))}`));
}

export async function turnImpact(files: string[], d: { analyzer: Analyzer; poly: PolyIndex; endpoints: Endpoints; providerFor(t: FlowTarget): FlowProvider; rangesOf?(file: string): Promise<LineRange[] | undefined>; tables?: TableIndex }, limits: ImpactLimits = TURN_LIMITS): Promise<TurnImpact> {
	const deadline = Date.now() + limits.budgetMs;
	const entries = d.endpoints.cached();
	const found = new Map<string, AffectedFlow>();
	const changed: ChangedMethod[] = [];
	const unique = [...new Set(files)];
	let skipped = Math.max(0, unique.length - limits.files);
	let partial = false;
	// The agent wrote these moments ago: have the index read them now rather than after its watcher's delay.
	if (d.poly.isReady) {
		await d.poly.refresh(unique.slice(0, limits.files).filter(f => !/\.cs$/i.test(f))).catch(() => undefined);
	}
	for (const file of unique.slice(0, limits.files)) {
		if (Date.now() > deadline) {
			skipped++;
			continue;
		}
		let targets: (FlowTarget & { name?: string })[] = [];
		try {
			// Only when the analyzer is already up: asking for it here could start a solution load nobody wanted.
			const cs = /\.cs$/i.test(file);
			const methods: (MethodSpan & { kind: 'roslyn' | 'poly' })[] = cs
				? d.analyzer.isReady ? (await d.analyzer.methods(file)).map(m => ({ ...m, kind: 'roslyn' as const })) : []
				: d.poly.isReady ? (await d.poly.methods(file)).map(m => ({ ...m, kind: 'poly' as const })) : [];
			partial ||= cs ? !d.analyzer.isReady : !d.poly.isReady;
			// Spans from a copy of the file older than the disk would misplace the edit: then the whole file counts.
			const fresh = methods.length > 0 && spansMatch(methods, await fs.readFile(file, 'utf8').catch(() => ''));
			const ranges = fresh ? await d.rangesOf?.(file).catch(() => undefined) : undefined;
			// Without ranges nothing is known to be changed: every method counts, none is named.
			const touched = ranges ? methodsTouched(methods, ranges) : { methods: [] as typeof methods, wholeFile: true };
			// The changed methods first, so the cap never drops them for the rest of the file.
			const chosen = touched.wholeFile ? [...touched.methods, ...methods.filter(m => !touched.methods.includes(m))] : touched.methods;
			targets = chosen.slice(0, limits.functionsPerFile).map(m => ({ kind: m.kind, id: m.id, name: touched.methods.includes(m) ? m.name : undefined }));
			changed.push(...touched.methods.map(m => ({ target: { kind: m.kind, id: m.id }, name: m.name, file, line: m.line })));
		} catch {
			// a file the backends do not know (a config, a doc): it may still be an entity file
		}
		for (const t of targets) {
			if (Date.now() > deadline) {
				partial = true;
				break;
			}
			try {
				const items = (await d.providerFor(t).impact(t)).items.map(i => i.label);
				for (const item of items) {
					const e = entryForItem(item, entries);
					if (e) {
						const flow = found.get(e.id) ?? { id: e.id, label: e.http, name: entryName(e), source: e.source };
						if (t.name && !flow.via?.includes(t.name)) {
							flow.via = [...flow.via ?? [], t.name];
						}
						found.set(e.id, flow);
					}
				}
			} catch {
				// one function failing must not lose the rest
			}
		}
	}
	const flows = [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
	// An edit in an entity changes a table: who reads or writes it is asked of the table index, which walks the entry points on first use.
	// Where the edit landed is asked on its own, not through the methods: a file of models has none, and its edit is in one model.
	const entities = d.tables ? await d.tables.changed(await placed(unique.slice(0, limits.files), d), limits.tables, Math.min(limits.tableBudgetMs, Math.max(500, deadline - Date.now()))).catch(() => undefined) : undefined;
	return {
		files: unique.length,
		flows: flows.slice(0, limits.flows),
		changed,
		tables: entities?.tables ?? [],
		more: Math.max(0, flows.length - limits.flows),
		note: [skipped || partial ? 'Partial: some files were not checked (index or analyzer not ready, or too many files).' : '', ...entities?.notes.map(n => `Tables: ${n}.`) ?? []].filter(Boolean).join(' ') || undefined,
	};
}
