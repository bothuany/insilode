/*---------------------------------------------------------------------------------------------
 *  Insilode: the flow canvas for a whole change set ("show the changes in flow"). The target names no method:
 *  every time the canvas asks, the endpoints the changed files reach are traced again and cut down to the
 *  paths that lead to a changed card (changeSetTree.ts), next to the changed methods no endpoint reaches.
 *--------------------------------------------------------------------------------------------*/

import { changeSetRoot, markTableChanges, pruneToChanged, rekey, showsLine, tableRoot } from './changeSetTree';
import { tableEndpoints, type ImpactLimits, type TurnImpact } from './mcp/turnImpact';
import { goneColumns } from './poly/migrations';
import { NOT_CHECKED, usedBy } from './mcp/tableIndex';
import type { FlowNode, FlowProvider, FlowTarget, ImpactResult } from './providers';

/** A whole branch can touch many files: wider than after one agent turn, still bounded (Roslyn answers one request at a time). */
const SET_LIMITS: ImpactLimits = { files: 60, functionsPerFile: 40, flows: 30, budgetMs: 25_000, tables: 12, tableBudgetMs: 15_000 };
/** Endpoints drawn on behalf of changed tables, on top of the ones a changed method reaches. */
const MAX_TABLE_FLOWS = 30;
/** Changed methods no endpoint reaches, drawn on their own; beyond this the root card says how many were left out. */
const MAX_LOOSE = 40;

export interface ChangeSet {
	/** What the root card says: "Changes since main". */
	label: string;
	/** The changed source files. */
	files: string[];
}

export interface ChangeSetDeps {
	impactOf(files: string[], limits: ImpactLimits): Promise<TurnImpact>;
	providerFor(target: FlowTarget): FlowProvider;
	/** Marks the cards of tracked files with their diff (AgentChanges.annotate). */
	annotate(root: FlowNode): Promise<void>;
}

/** What one trace of a change set found: the canvas draws `root`, the agent is told the rest. */
export interface ChangeSetTrace {
	root: FlowNode;
	impact: TurnImpact;
	/** Flows and methods that were found but could not be traced (a backend still loading). */
	failed: number;
}

export class ChangeSetProvider implements FlowProvider {
	private set: ChangeSet | undefined;
	private shown = 0;
	/** The trace running now: a canvas that asks again meanwhile (a refresh, a second request) waits for it instead of starting another. */
	private running: Promise<ChangeSetTrace> | undefined;
	/** The trace `use` started for the canvas about to open: its first request takes it instead of tracing again. */
	private unclaimed = false;
	private last: Promise<ChangeSetTrace> | undefined;

	constructor(private readonly d: ChangeSetDeps) { }

	/** The target that shows `set`; a new id each time, so the canvas loads it again. Starts tracing it right away. */
	use(set: ChangeSet): Extract<FlowTarget, { kind: 'changes' }> {
		this.set = set;
		this.running = undefined;
		void this.trace().catch(() => undefined); // the canvas and the agent hear of a failure when they wait for it
		this.unclaimed = true;
		return { kind: 'changes', id: String(++this.shown) };
	}

	/** The latest trace (the one the canvas shows, or is about to). */
	latest(): Promise<ChangeSetTrace> | undefined {
		return this.last;
	}

	private trace(): Promise<ChangeSetTrace> {
		const set = this.set;
		if (!set) {
			return Promise.reject(new Error('No change set to show: ask again from the diff view or the agent.'));
		}
		if (!this.running) {
			const run = this.build(set).finally(() => {
				if (this.running === run) {
					this.running = undefined;
				}
			});
			this.running = this.last = run;
		}
		return this.running;
	}

	async graph(): Promise<FlowNode> {
		if (this.unclaimed && this.last) {
			this.unclaimed = false;
			return (await this.last).root;
		}
		// Asked again later: the files may have changed on disk since, so trace them again.
		return (await this.trace()).root;
	}

	private async build(set: ChangeSet): Promise<ChangeSetTrace> {
		const impact = await this.d.impactOf(set.files, SET_LIMITS);
		const branches: FlowNode[] = [];
		let failed = 0;
		// A changed entity is one root item of its own; the endpoints that read or write its table are drawn with the ones a changed method reaches.
		const marks = impact.tables.map(t => ({
			entity: t.entity,
			table: t.table,
			guess: t.guess,
			migration: t.migrations.map(m => ({ name: m.name, summary: m.summary, added: m.ops.filter(o => o.op === 'alter-add' || o.op === 'create').flatMap(o => o.columns), dropped: goneColumns(m.ops, t.table) })),
		}));
		const short = (table: string) => table.split('.').pop();
		for (const [i, t] of impact.tables.entries()) {
			const common = `${usedBy(t)}${t.guess ? ' · table?' : ''}${t.checked < t.of ? ' · partial' : ''}`;
			if (t.entity) {
				branches.push(tableRoot(`${t.entity} changed → table ${short(t.table)}`, marks[i], common, `table${i}`));
			}
			for (const [j, m] of t.migrations.entries()) {
				const still = m.mayStillUse.length ? ` · ${m.mayStillUse.length} ${m.mayStillUse.length === 1 ? 'place' : 'places'} may still use ${[...new Set(m.mayStillUse.map(x => x.column))].join(', ')} (guess)` : '';
				branches.push(tableRoot(`migration ${m.name} ${m.verb} ${short(t.table)} (${m.summary})`, marks[i], `${common}${still}${m.namesOnly ? ' · table names only' : ''}`, `table${i}m${j}`));
			}
		}
		const extra = tableEndpoints(impact);
		const flows = [...impact.flows, ...extra.slice(0, MAX_TABLE_FLOWS)];
		const tableOnly = Math.max(0, extra.length - MAX_TABLE_FLOWS);
		for (const [i, f] of flows.entries()) {
			try {
				const g = await this.d.providerFor({ kind: f.source, id: f.id }).graph({ kind: f.source, id: f.id });
				markTableChanges(g, marks);
				await this.d.annotate(g);
				const pruned = pruneToChanged(g);
				// A flow the table reaches only through a card the walk saw but this trace did not (a depth difference) has nothing to show.
				if (pruned || impact.flows.some(x => x.id === f.id)) {
					branches.push(rekey(pruned ?? { ...g, children: [] }, `f${i}:`));
				}
			} catch {
				failed++; // one flow failing to trace must not lose the others
			}
		}
		let loose = 0;
		let left = 0;
		for (const [i, m] of impact.changed.entries()) {
			if (branches.some(b => showsLine(b, m.file, m.line))) {
				continue;
			}
			if (loose >= MAX_LOOSE) {
				left++;
				continue;
			}
			try {
				const g = await this.d.providerFor(m.target).graph(m.target);
				await this.d.annotate(g);
				branches.push(rekey(pruneToChanged(g) ?? { ...g, children: [] }, `m${i}:`));
				loose++;
			} catch {
				failed++; // a method the backend cannot trace (it is still loading): the diff view still has it
			}
		}
		const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
		const sub = [
			count(set.files.length, 'changed file'),
			count(impact.flows.length + impact.more + extra.length, 'endpoint'),
			impact.tables.length ? `${count(impact.tables.length, 'changed table')} (${count(new Set(impact.tables.flatMap(t => t.uses.map(u => `${u.endpoint.source}:${u.endpoint.id}`))).size, 'endpoint')} read or write ${impact.tables.length === 1 ? 'it' : 'them'}; not checked: ${NOT_CHECKED.split(';')[0]}, other services, migrations)` : '',
			tableOnly ? `${tableOnly} table endpoints not drawn` : '',
			loose ? count(loose + left, 'other changed method') : '',
			impact.more ? `${impact.more} endpoints not drawn` : '',
			left ? `${left} methods not drawn` : '',
			failed ? `${failed} could not be traced` : '',
			!branches.length && !failed ? 'no changed method found (the code index or C# analyzer may still be loading)' : '',
			impact.note ?? '',
		].filter(Boolean).join(' · ');
		return { root: changeSetRoot(set.label, sub, branches), impact, failed };
	}

	async callers(): Promise<FlowNode | null> {
		return null;
	}

	async impact(): Promise<ImpactResult> {
		const impact = (await this.last?.catch(() => undefined))?.impact;
		// The canvas reads it as "Affects 3 endpoints": the ones a changed method reaches and the ones that use a changed table.
		const flows = impact ? [...impact.flows, ...tableEndpoints(impact)] : [];
		return { label: 'endpoint', items: flows.map(f => ({ label: `${f.label} ${f.name}`, file: null, line: 0 })) };
	}
}
