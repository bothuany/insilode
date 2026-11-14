/*---------------------------------------------------------------------------------------------
 *  Insilode type model: the extension-host service. Gathers the C# analyzer's types and the code
 *  index's facts into one TypeGraph, caches it, drops it when either source refreshes, and
 *  serves the boards and the type tree of the chips from it. Works with only the index (no C#
 *  solution) and with only the analyzer. It never starts the analyzer (that may ask which
 *  solution to open): C# types appear once the analyzer is ready, and the graph is rebuilt then.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Analyzer } from '../analyzer';
import type { BoardSpec } from '../../../../../board-canvas/spec';
import { PolyIndex } from '../poly/client';
import { architectureBoard, dtoBoard, typeDetail, type ArchitectureBoardOptions, type DtoBoardOptions, type TypeDetail } from './boards';
import { chipsOf, signatureOf, typeTree, type CardChips, type Signature, type TypeTree } from './chips';
import { classifyOptions } from './classify';
import { exportMermaid, exportPlantUml } from './export';
import { buildTypeGraph } from './graph';
import type { TypeGraph } from './model';
import { nearestServiceResolver } from './service';
import type { CsTypesResponse, PolyTypeFacts } from './wire';

export type TypeBoardKind = 'dto' | 'architecture';
export type ExportFormat = 'mermaid' | 'plantuml';

/** Edits and index refreshes come in bursts: the graph is dropped once they settle. */
const SETTLE_MS = 600;

export class TypeService implements vscode.Disposable {
	/** The service of this window; commands and panels use it without being handed one. */
	static current: TypeService | undefined;

	/** The service of this window, created on first use: nothing needs to construct it (extension.ts may also register it to be disposed). */
	static get(log?: vscode.LogOutputChannel): TypeService {
		return TypeService.current ?? new TypeService(log);
	}

	private readonly changed = new vscode.EventEmitter<void>();
	/** Fires when the graph was dropped because a source refreshed: open boards may redraw. */
	readonly onDidChange: vscode.Event<void> = this.changed.event;

	private graph: Promise<TypeGraph> | undefined;
	private notes: string[] = [];
	/** The last build lacked a source that is on its way (the index still building, a request that failed): it is not kept. */
	private incomplete = false;
	private timer: NodeJS.Timeout | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	/** The sources whose ready events are already followed: they can appear after the service does. */
	private readonly followed = new Set<unknown>();

	constructor(private readonly log?: vscode.LogOutputChannel) {
		TypeService.current = this;
		this.disposables.push(
			this.changed,
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('flow.types') && this.invalidate()),
			vscode.workspace.onDidSaveTextDocument(d => d.languageId === 'csharp' && this.invalidate()),
		);
	}

	/** Drops the graph now (the next request builds it again) and tells listeners after things settle. */
	private invalidate() {
		this.graph = undefined;
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.changed.fire(), SETTLE_MS);
	}

	/**
	 * Files that just changed (a save, an agent's edit): the index reads them now rather than when its watcher settles, and the
	 * next graph is built from them. Skeleton first recolours its board from that graph.
	 */
	async refreshFiles(files: string[]): Promise<void> {
		await PolyIndex.current?.refresh(files).catch(() => undefined);
		this.invalidate();
	}

	/** Buffers the developer is typing in (not saved): the index reads their text now, and the next graph is built from it. */
	async refreshBuffers(buffers: { file: string; text: string }[]): Promise<void> {
		await Promise.all(buffers.map(b => PolyIndex.current?.overlay(b.file, b.text)));
		this.invalidate();
	}

	/** Whether the last graph had every source it needs: false while the index builds or C# is loading. */
	get complete(): boolean {
		return !this.incomplete;
	}

	/** Follows the index and the analyzer, which may start after this service. */
	private follow() {
		const poly = PolyIndex.current;
		if (poly && !this.followed.has(poly)) {
			this.followed.add(poly);
			this.disposables.push(poly.onDidBecomeReady(() => this.invalidate()));
		}
		const analyzer = Analyzer.current;
		if (analyzer && !this.followed.has(analyzer)) {
			this.followed.add(analyzer);
			this.disposables.push(analyzer.onDidBecomeReady(() => this.invalidate()));
		}
	}

	/** The type graph (built on first use, then cached). Never rejects: a source that fails is skipped and named in `warnings()`. */
	getGraph(): Promise<TypeGraph> {
		this.follow();
		if (!this.graph) {
			const building = this.build();
			this.graph = building;
			// A graph built while a source was not ready is not kept: the next request tries again.
			void building.then(() => {
				if (this.incomplete && this.graph === building) {
					this.graph = undefined;
				}
			});
		}
		return this.graph;
	}

	/** Messages about sources that could not be read (the index not ready, C# not loaded): a board can say why it is empty. */
	warnings(): string[] {
		return [...this.notes];
	}

	private async build(): Promise<TypeGraph> {
		const notes: string[] = [];
		let incomplete = false;
		const started = Date.now();
		const poly = PolyIndex.current;
		const analyzer = Analyzer.current;
		let facts: PolyTypeFacts | undefined;
		let cs: CsTypesResponse | undefined;
		if (!poly) {
			notes.push('The code index is not running.');
		} else if (!poly.isReady) {
			incomplete = true;
			notes.push('The code index is still building: Java, Python, JS/TS, Go, PHP, Ruby and Rust types appear when it is done.');
		} else {
			try {
				facts = await poly.typeFacts();
			} catch (e) {
				incomplete = true;
				notes.push(`The code index could not list its types (${(e as Error).message}).`);
			}
		}
		if (analyzer && !analyzer.isReady) {
			// Not started here: starting it may ask which solution to open.
			notes.push(await analyzer.hasSolution().catch(() => false) ? 'C# analysis is not loaded yet: C# types appear when it is.' : '');
		} else if (analyzer) {
			try {
				cs = await analyzer.types();
				if (cs?.truncated) {
					notes.push('The C# analyzer listed only part of the types of this solution.');
				}
			} catch (e) {
				incomplete = true;
				notes.push(`The C# analyzer could not list its types (${(e as Error).message}).`);
			}
		}
		const roots = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
		const cfg = vscode.workspace.getConfiguration('flow.types');
		const graph = buildTypeGraph({
			poly: facts, csharp: cs, moduleOf: nearestServiceResolver(roots),
			options: classifyOptions({ dtoSuffixes: cfg.get('dtoSuffixes'), includeEntities: cfg.get('includeEntities'), includeEnums: cfg.get('includeEnums') }),
		});
		this.notes = notes.filter(Boolean);
		this.incomplete = incomplete;
		this.log?.info(`types: ${graph.types.length} types, ${graph.edges.length} edges in ${Date.now() - started} ms${this.notes.length ? ` (${this.notes.join(' ')})` : ''}`);
		return graph;
	}

	/** The DTO relation board or the architecture board. */
	board(kind: 'dto', opts?: DtoBoardOptions): Promise<BoardSpec>;
	board(kind: 'architecture', opts?: ArchitectureBoardOptions): Promise<BoardSpec>;
	board(kind: TypeBoardKind, opts?: DtoBoardOptions & ArchitectureBoardOptions): Promise<BoardSpec>;
	async board(kind: TypeBoardKind, opts: DtoBoardOptions & ArchitectureBoardOptions = {}): Promise<BoardSpec> {
		const graph = await this.getGraph();
		const max = vscode.workspace.getConfiguration('flow.types').get<number>('maxNodes');
		const withMax = { ...opts, maxNodes: opts.maxNodes ?? (typeof max === 'number' && max > 0 ? max : undefined) };
		const board = kind === 'dto' ? dtoBoard(graph, withMax) : architectureBoard(graph, withMax);
		const why = this.notes.length ? this.notes.join(' ') : graph.types.length ? '' : 'No types were found in this workspace.';
		if (why) {
			board.description = [board.description, why].filter(Boolean).join(' ');
		}
		return board;
	}

	/** The type tree behind a card's chip: `ref` is a type id or a name as written in `fromFile`. */
	async detail(ref: string, fromFile?: string, depth = 2): Promise<TypeDetail | undefined> {
		return typeDetail(await this.getGraph(), ref, fromFile, depth);
	}

	/** The declared parameter and return types of the method whose declaration starts at `file:line` (a card's first line). */
	async signatureOf(file: string, line: number, endLine?: number): Promise<Signature | undefined> {
		return signatureOf(await this.getGraph(), file, line, endLine);
	}

	/**
	 * The chips of many cards in one answer, by the key the caller gave each. `ready` is false while a source of types is still on its
	 * way (the code index building, C# not loaded): the answer may be missing chips and `onDidChange` fires when there are more.
	 */
	async chips(nodes: { key: string; file: string; line: number; endLine?: number }[]): Promise<{ chips: Record<string, CardChips>; ready: boolean }> {
		const graph = await this.getGraph();
		const chips: Record<string, CardChips> = {};
		for (const n of nodes) {
			const c = chipsOf(graph, n.file, n.line, n.endLine);
			if (c) {
				chips[n.key] = c;
			}
		}
		return { chips, ready: !this.incomplete && graph.types.length > 0 };
	}

	/** The fields of a type for a chip that was opened, `depth` levels of the types they refer to included. */
	async tree(ref: string, fromFile?: string, depth = 0): Promise<TypeTree | undefined> {
		return typeTree(await this.getGraph(), ref, fromFile, depth);
	}

	/** A board as Mermaid or PlantUML source text. */
	exportBoard(board: BoardSpec, format: ExportFormat): string {
		return format === 'plantuml' ? exportPlantUml(board) : exportMermaid(board);
	}

	dispose() {
		if (TypeService.current === this) {
			TypeService.current = undefined;
		}
		clearTimeout(this.timer);
		this.disposables.forEach(d => d.dispose());
	}
}
