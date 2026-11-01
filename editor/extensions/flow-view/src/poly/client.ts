/*---------------------------------------------------------------------------------------------
 *  Insilode polyglot index: the extension host side. Starts the worker for the open folders, sends
 *  it file changes, and serves its answers as a FlowProvider and a list of entry points.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import type { FlowNode, FlowProvider, FlowTarget, ImpactResult } from '../providers';
import type { Place, Suggestion } from './assist';
import { VsLsp } from './lspHost';
import { LspRefiner, stripPending } from './lspResolve';
import type { PolyTypeFacts } from '../types/wire';
import { isExcludedPath, type EntryPoint, type Mention, type TableEntity, type TablesFact } from './model';
import type { DbSchema } from '../../../../../protocol/flow';

export const POLY_LANGUAGES = new Set(['java', 'python', 'javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'go', 'php', 'ruby', 'rust']);

/** Prebuilt grammars: copied next to the bundle by esbuild.mjs. Only this extension's own copy is ever loaded (the worker `require`s tree-sitter.js from it). */
function wasmDir(extensionPath: string) {
	return path.join(extensionPath, 'out', 'wasm');
}

const MAX_RESTARTS = 5;
/** How long the worker walks the entry points for tables before it lets another request in. */
const WALK_SLICE_MS = 250;
/** The files the index reads, as watcher globs, and the same as a test on a file name. */
const WATCHED = ['*.java', '*.py', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.go', '*.php', '*.rb', '*.rs', '*.xhtml', '*.jsp', '*.jspx', '*.jsf', 'services.xml', '*.prisma'];
const WATCHED_FILE = new RegExp(`^(${WATCHED.map(g => g.replace(/\./g, '\\.').replace('*', '.*')).join('|')})$`, 'i');

export class PolyIndex implements vscode.Disposable {
	private worker: Worker | undefined;
	private seq = 0;
	private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private readonly ready = new vscode.EventEmitter<void>();
	readonly onDidBecomeReady = this.ready.event;
	private entries: EntryPoint[] = [];
	private changedFiles = new Set<string>();
	private changeTimer: NodeJS.Timeout | undefined;
	private restartTimer: NodeJS.Timeout | undefined;
	/** Crashes since the worker last became ready: the restart backoff and its cap. */
	private crashes = 0;
	private disposed = false;
	/** Why requests fail while there is no worker. */
	private unavailable = 'No folder is open.';
	private readonly disposables: vscode.Disposable[] = [];
	isReady = false;
	/** Files the first index has gone through, of how many: what the endpoint picker shows while it waits. */
	progress: { done: number; total: number } | undefined;
	private readonly progressed = new vscode.EventEmitter<{ done: number; total: number }>();
	readonly onDidProgress = this.progressed.event;

	/** The index of this window: the canvas asks it for editing help without being handed it. */
	static current: PolyIndex | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
		PolyIndex.current = this;
		const watcher = vscode.workspace.createFileSystemWatcher(`**/{${WATCHED.join(',')}}`);
		const changed = (u: vscode.Uri) => {
			if (!this.note(u)) {
				return;
			}
			clearTimeout(this.changeTimer);
			this.changeTimer = setTimeout(() => void this.flush(), 400);
		};
		// Deleting a folder reports the folder only: its indexed files are dropped by path (a removed agent worktree left
		// duplicate cards behind otherwise).
		const deletions = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);
		const removed = (u: vscode.Uri) => {
			if (!WATCHED_FILE.test(path.basename(u.fsPath)) && vscode.workspace.getWorkspaceFolder(u)) {
				void this.request<number>('removedDir', u.fsPath).then(n => n ? this.refreshEntries() : undefined, () => undefined);
			}
		};
		this.disposables.push(deletions, deletions.onDidDelete(removed));
		this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed),
			vscode.workspace.onDidChangeWorkspaceFolders(() => this.restart()));
		this.entries = context.workspaceState.get<EntryPoint[]>('flow.polyEntries', []);
		this.start();
	}

	private start() {
		const roots = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
		if (!roots.length) {
			this.unavailable = 'No folder is open.';
			return;
		}
		const key = createHash('sha1').update(roots.join('|')).digest('hex').slice(0, 12);
		const cacheFile = path.join(this.context.globalStorageUri.fsPath, 'poly', `${key}.json`);
		this.isReady = false;
		const wasm = wasmDir(this.context.extensionPath);
		if (!fs.existsSync(path.join(wasm, 'tree-sitter.js'))) {
			this.log.error(`Index: the tree-sitter runtime is missing from ${wasm}. Reinstall the extension.`);
			this.unavailable = 'The code index cannot start: its parser files are missing.';
			return;
		}
		const worker = this.worker = new Worker(path.join(this.context.extensionPath, 'out', 'polyWorker.js'), {
			workerData: { roots, wasmDir: wasm, cacheFile },
			resourceLimits: { maxOldGenerationSizeMb: 2048 },
		});
		worker.on('message', (m: { id?: number; type?: string; result?: unknown; error?: string; message?: string; stats?: object; ms?: number; parsed?: number; done?: number; total?: number }) => {
			if (this.worker !== worker) {
				return; // an answer from a worker that was replaced
			}
			if (m.type === 'log') {
				this.log.warn(`Index: ${m.message}`);
			} else if (m.type === 'progress') {
				this.progress = { done: m.done ?? 0, total: m.total ?? 0 };
				this.progressed.fire(this.progress);
			} else if (m.type === 'ready') {
				this.log.info(`Index ready in ${m.ms} ms (${m.parsed} parsed): ${JSON.stringify(m.stats)}`);
				this.isReady = true;
				this.crashes = 0;
				void this.refreshEntries();
			} else if (m.id !== undefined) {
				const p = this.pending.get(m.id);
				this.pending.delete(m.id);
				if (m.error) {
					p?.reject(new Error(m.error));
				} else {
					p?.resolve(m.result);
				}
			}
		});
		// A worker that died (out of memory, a crash) must not leave requests waiting for an answer that never comes.
		const lost = (why: string) => {
			if (this.worker === worker) {
				this.worker = undefined;
				this.isReady = false;
				this.pending.forEach(p => p.reject(new Error(why)));
				this.pending.clear();
				this.scheduleRestart(why);
			}
		};
		worker.on('error', e => {
			this.log.error(`Index worker failed: ${e.stack ?? e}`);
			lost('The code index stopped unexpectedly.');
		});
		worker.on('exit', code => lost(`The code index exited (${code}).`));
	}

	/** After a crash: start again with a growing delay, and stop trying when it keeps failing. */
	private scheduleRestart(why: string) {
		if (this.disposed) {
			return;
		}
		if (++this.crashes > MAX_RESTARTS) {
			this.log.error('Index: the worker keeps stopping, not restarting it again.');
			this.unavailable = `${why} It kept failing: reload the window to try again.`;
			return;
		}
		const delay = Math.min(30_000, 1000 * 2 ** (this.crashes - 1));
		this.log.warn(`Index: restarting the worker in ${delay} ms (crash ${this.crashes} of ${MAX_RESTARTS}).`);
		this.unavailable = `${why} It is restarting.`;
		clearTimeout(this.restartTimer);
		this.restartTimer = setTimeout(() => this.start(), delay);
	}

	private restart() {
		clearTimeout(this.restartTimer);
		this.crashes = 0;
		// Detached first: the old worker's exit is a replacement, not a crash.
		const old = this.worker;
		this.worker = undefined;
		void old?.terminate();
		this.pending.forEach(p => p.reject(new Error('index restarted')));
		this.pending.clear();
		this.start();
	}

	private request<T>(op: string, ...args: unknown[]): Promise<T> {
		if (!this.worker) {
			return Promise.reject(new Error(this.unavailable));
		}
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.worker!.postMessage({ id, op, args });
		});
	}

	private async flush() {
		const files = [...this.changedFiles];
		this.changedFiles.clear();
		if (!files.length) {
			return;
		}
		await this.request('changed', ...files).catch(() => undefined);
		void this.refreshEntries();
	}

	private async refreshEntries() {
		try {
			this.entries = await this.request<EntryPoint[]>('entries');
			void this.context.workspaceState.update('flow.polyEntries', this.entries);
			this.ready.fire();
		} catch (e) {
			this.log.warn(`Index entries failed: ${(e as Error).message}`);
		}
	}

	cachedEntryPoints() {
		return this.entries;
	}

	async entryPoints() {
		await this.flush();
		return this.request<EntryPoint[]>('entries');
	}

	functionAt(file: string, line: number) {
		return this.request<{ id: string; label: string } | undefined>('functionAt', file, line);
	}

	/** Completion in a card: what the index offers at the cursor (see `Project.completeAt`). */
	complete(q: { file: string; startLine: number; before: string }) {
		return this.request<{ items: Suggestion[]; why?: string }>('complete', q);
	}

	/** Parameter hints in a card: the function the open call reaches. */
	signature(q: { file: string; startLine: number; before: string }) {
		return this.request<{ label: string; params: string[]; active: number } | undefined>('signature', q);
	}

	/** Go to definition from a card: where the index says the identifier under the cursor is defined (see `Project.definitionAt`). */
	definition(q: { file: string; startLine: number; lineText: string; column: number; cardText: string; cardLine: number }) {
		return this.request<{ places: Place[]; message?: string }>('definition', q);
	}

	/**
	 * Queues a changed file the way the watcher sees it: keyed as VS Code spells the path (an agent says `C:\x`, the
	 * index holds `c:\x`), and only a file the index reads, inside a workspace folder and not excluded.
	 */
	private note(u: vscode.Uri) {
		const folder = vscode.workspace.getWorkspaceFolder(u);
		if (!folder || isExcludedPath(u.fsPath, folder.uri.fsPath) || !WATCHED_FILE.test(path.basename(u.fsPath))) {
			return false;
		}
		this.changedFiles.add(u.fsPath);
		return true;
	}

	/** Re-reads these files now, without waiting for the watcher: for answers about files that just changed. */
	async refresh(files: string[]) {
		files.forEach(f => this.note(vscode.Uri.file(f)));
		await this.flush();
	}

	/** An editor buffer that is not saved yet, read by the index as the file's content until the next save: types appear while the developer types. */
	async overlay(file: string, text: string) {
		const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
		if (!folder || isExcludedPath(file, folder.uri.fsPath) || !WATCHED_FILE.test(path.basename(file))) {
			return;
		}
		await this.request('overlay', file, text).catch(() => undefined);
	}

	methods(file: string) {
		return this.request<{ id: string; name: string; line: number; startLine: number; endLine: number; isEntry: boolean }[]>('methods', file);
	}

	/** The entity and model classes with their tables, for a change to one of them. */
	entities() {
		return this.request<TableEntity[]>('entities');
	}

	/** Every entity's table with its columns, keys and relations (the schema readers' output): what a generated ER board is drawn from. */
	schemas() {
		return this.request<(DbSchema & { orm: string; guess: boolean })[]>('schemas');
	}

	/** Where code mentions these columns by name (in files that also mention the table or its entity): what may still use a column a migration drops. */
	mentions(q: { columns: string[]; words: string[]; limit: number; budgetMs: number }) {
		return this.request<Mention[]>('mentions', q);
	}

	/**
	 * Which tables the entry points reach, walked for at most `budgetMs` (see `Project.tableUses`). The worker answers one request at a
	 * time, so the walk goes in short slices: a flow the canvas asks for in between waits for one slice, not for the whole budget.
	 */
	async tables(budgetMs = 4000) {
		await this.flush();
		const deadline = Date.now() + budgetMs;
		for (;;) {
			const left = deadline - Date.now();
			const fact = await this.request<TablesFact>('tables', Math.max(1, Math.min(WALK_SLICE_MS, left)));
			if (fact.done || Date.now() >= deadline) {
				return fact;
			}
		}
	}

	/** Everything the type model is built from (see `Project.typeFacts`): the facts of every file without function bodies, the calls between classes, the entry points with their types. */
	async typeFacts() {
		await this.flush();
		return this.request<PolyTypeFacts>('typeFacts');
	}

	async graph(id: string, depth?: number) {
		await this.flush();
		return this.request<FlowNode>('graph', id, depth);
	}

	callers(id: string) {
		return this.request<FlowNode | null>('callers', id);
	}

	impact(id: string) {
		return this.request<ImpactResult>('impact', id);
	}

	dispose() {
		if (PolyIndex.current === this) {
			PolyIndex.current = undefined;
		}
		this.disposed = true;
		clearTimeout(this.restartTimer);
		clearTimeout(this.changeTimer);
		void this.worker?.terminate();
		this.ready.dispose();
		this.progressed.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

/**
 * Java, Python, JS/TS (and the other indexed languages) through the polyglot index, refined by the language
 * server where the index could not resolve a call. `flow.lspResolution` turns the second step off.
 */
export class PolyProvider implements FlowProvider, vscode.Disposable {
	private readonly refiner: LspRefiner;
	private readonly save: vscode.Disposable;

	constructor(private readonly index: PolyIndex) {
		this.refiner = new LspRefiner(index, new VsLsp());
		this.save = vscode.workspace.onDidSaveTextDocument(() => this.refiner.reset());
	}

	private id(t: FlowTarget) {
		if (t.kind !== 'poly') {
			throw new Error('not a polyglot target');
		}
		return t.id;
	}

	async graph(t: FlowTarget) {
		const root = await this.index.graph(this.id(t));
		return vscode.workspace.getConfiguration('flow').get<boolean>('lspResolution', true) ? this.refiner.refine(root) : stripPending(root);
	}

	callers(t: FlowTarget) {
		return this.index.callers(this.id(t));
	}

	impact(t: FlowTarget) {
		return this.index.impact(this.id(t));
	}

	dispose() {
		this.save.dispose();
	}
}
