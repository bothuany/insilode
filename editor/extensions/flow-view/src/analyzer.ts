/*---------------------------------------------------------------------------------------------
 *  Insilode: the Roslyn analyzer (custom-ide/analyzer) as a child process of the extension host.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { flowRoot } from './root';
import { excludePatterns, workspaceRoots } from './excludeSetting';
import { byRepo } from './grouping';
import { excluder } from './poly/userExclude';
import type { EntryPoint } from '../../../../protocol/flow';
import type { CsTypesResponse } from './types/wire';
import type { TableEntity, TablesFact } from './poly/model';
import type { EfFact } from './poly/migrations';

export type { EntryPoint };

export interface MethodInfo {
	id: string;
	name: string;
	line: number;
	startLine: number;
	endLine: number;
	isEntry: boolean;
}

/** What the analyzer is asked about a card (Assist.cs `CardRequest`). Without `text` the file is read as it is. */
export interface CardAsk {
	file: string;
	startLine: number;
	endLine: number;
	original?: string | null;
	text?: string | null;
	line: number;
	column: number;
	trigger?: string;
}

/** The method whose body contains the (1-based) line; the smallest one when methods nest. */
export function innermost(methods: MethodInfo[], line: number): MethodInfo | undefined {
	return methods
		.filter(m => m.startLine <= line && line <= m.endLine)
		.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

const SOLUTION_KEY = 'flow.solution';
const ENTRIES_KEY = 'flow.entryPoints';

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const port = (srv.address() as net.AddressInfo).port;
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

function canConnect(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const s = net.connect(port, '127.0.0.1');
		s.once('connect', () => {
			s.destroy();
			resolve(true);
		});
		s.once('error', () => resolve(false));
	});
}

/** The analyzer was gone right after it started (typically: the port was taken in between), so a second try may work. */
class EarlyExit extends Error { }

/** How long a failed start is remembered, so lens and trail requests do not respawn the analyzer on every call. */
const RETRY_AFTER_MS = 10_000;
/** Editing help answers within a few seconds or not at all: the analyzer's own budget is 6 s. */
const ASSIST_TIMEOUT_MS = 8_000;
/** A request waits behind the analyzer's one-at-a-time lock; give up only when something is really stuck. */
const REQUEST_TIMEOUT_MS = 120_000;

export class Analyzer implements vscode.Disposable {
	private child: ChildProcess | undefined;
	private ready: Promise<number> | undefined;
	/** The analyzer only answers requests that carry this: another process on its port is not the analyzer. */
	private readonly token = randomBytes(16).toString('hex');
	/** The last failed start, remembered for `RETRY_AFTER_MS`. */
	private failure: { error: Error; until: number } | undefined;
	/** Ends the wait loop of the start in progress, when the analyzer is stopped meanwhile. */
	private cancelStart: (() => void) | undefined;
	/** Entry points the readiness probe already fetched: the first `entryPoints()` call uses them. */
	private seed: EntryPoint[] | undefined;
	private entriesInFlight: Promise<EntryPoint[]> | undefined;
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
	/** True once the solution is loaded and the analyzer answers; nothing here starts it. */
	isReady = false;
	private readonly becameReady = new vscode.EventEmitter<void>();
	readonly onDidBecomeReady = this.becameReady.event;

	/** The analyzer of this window: the canvas asks it for C# editing help without being handed it (one extension host, one analyzer). */
	static current: Analyzer | undefined;

	constructor(private readonly context: vscode.ExtensionContext, readonly log: vscode.LogOutputChannel) {
		this.status.command = 'flow.pickEndpoint';
		Analyzer.current = this;
	}

	/** Solution already chosen for this workspace: load it in the background so the first flow is instant. */
	warmUp() {
		if (this.loadedSolution()) {
			// The endpoint list is fetched by `Endpoints` when the analyzer reports ready.
			this.port().catch(e => this.log.warn(`warm-up failed: ${e}`));
		}
	}

	private setStatus(text: string, tooltip: string) {
		this.status.text = text;
		this.status.tooltip = tooltip;
		this.status.show();
	}

	/** Last known endpoint list for this workspace (shown instantly while a fresh one loads). */
	cachedEntryPoints(): EntryPoint[] {
		return this.context.workspaceState.get<EntryPoint[]>(ENTRIES_KEY) ?? [];
	}

	/** The published analyzer of an installed Insilode, else analyzer/ at the repository root, built by `npm run setup` (Debug, or Release when only that exists). */
	private get dll() {
		const published = path.join(flowRoot(this.context.extensionPath), 'analyzer', 'FlowAnalyzer.dll');
		if (existsSync(published)) {
			return published;
		}
		const bin = path.join(flowRoot(this.context.extensionPath), 'analyzer', 'bin');
		const debug = path.join(bin, 'Debug', 'net10.0', 'FlowAnalyzer.dll');
		const release = path.join(bin, 'Release', 'net10.0', 'FlowAnalyzer.dll');
		return !existsSync(debug) && existsSync(release) ? release : debug;
	}

	private dotnetAdvised = false;

	/** Said once per window: lens and trail requests keep failing the same way, and a notification each time would be noise. */
	private adviseDotnet() {
		if (this.dotnetAdvised) {
			return;
		}
		this.dotnetAdvised = true;
		void vscode.window.showWarningMessage('Insilode reads C# solutions with the .NET 10 SDK, and could not find it on this PC. Install it, then restart Insilode.', 'Get .NET 10')
			.then(pick => pick && vscode.env.openExternal(vscode.Uri.parse('https://dotnet.microsoft.com/download/dotnet/10.0')));
	}

	port(): Promise<number> {
		if (!this.ready && this.failure && Date.now() < this.failure.until) {
			return Promise.reject(this.failure.error);
		}
		this.ready ??=this.start().catch(e => {
			this.ready = undefined;
			throw e;
		});
		return this.ready;
	}

	/** Whether there is .NET code to load: a solution or project already chosen, or any .sln/.slnx (else a .csproj) in the workspace. */
	async hasSolution(): Promise<boolean> {
		return !!this.loadedSolution() || (await this.findSolutions(1)).length > 0;
	}

	/** Whether the analyzer can start without asking anything: a solution was chosen, or there is exactly one. */
	async canStartQuietly(): Promise<boolean> {
		return !!this.loadedSolution() || (await this.findSolutions(2)).length === 1;
	}

	/**
	 * What the analyzer can open: the solutions, or, when there is none, the project files. `dotnet new webapi` makes a
	 * project and no solution; without this fallback such a repository showed no C# endpoints and said nothing.
	 */
	private async findSolutions(limit: number) {
		const patterns = excludePatterns();
		const drop = excluder(patterns);
		const roots = workspaceRoots();
		const exclude = '**/{node_modules,bin,obj,.claude,.git}/**';
		// Excluded folders are dropped after the search, so it must look further than `limit` for enough to be left.
		const find = async (glob: string) => {
			const all = await vscode.workspace.findFiles(glob, exclude, patterns.length ? 2000 : limit);
			return all.filter(u => !drop(u.fsPath, roots)).slice(0, limit);
		};
		const solutions = await find('**/*.{sln,slnx}');
		return solutions.length ? solutions : find('**/*.{csproj,fsproj,vbproj}');
	}

	/** The solution chosen for this workspace, unless `flow.exclude` has since left its folder out (un-excluding brings it back). */
	loadedSolution(): string | undefined {
		const saved = this.context.workspaceState.get<string>(SOLUTION_KEY);
		return saved && !excluder(excludePatterns())(saved, workspaceRoots()) ? saved : undefined;
	}

	/** Every solution (else project) the workspace holds, for "1 of 12 solutions loaded". */
	async solutionCount(): Promise<number> {
		return (await this.findSolutions(2000)).length;
	}

	private async solution(): Promise<string> {
		const saved = this.loadedSolution();
		if (saved) {
			return saved;
		}
		const found = await this.findSolutions(200);
		if (!found.length) {
			throw new Error('No .sln, .slnx or .csproj in this workspace');
		}
		let pick = found[0];
		if (found.length > 1) {
			// Grouped by repository or module: in a supermodule, a dozen solutions are easier to tell apart under their repository.
			const groups = byRepo(found.map(u => u.fsPath), workspaceRoots());
			const items: (vscode.QuickPickItem & { uri?: vscode.Uri })[] = groups.flatMap(g => [
				...(groups.length > 1 ? [{ label: g.repo.name, kind: vscode.QuickPickItemKind.Separator }] : []),
				...g.files.map(f => ({ label: path.basename(f), description: vscode.workspace.asRelativePath(path.dirname(f)), uri: vscode.Uri.file(f) })),
			]);
			const what = /\.(sln|slnx)$/i.test(found[0].fsPath) ? 'solution' : 'project';
			const chosen = await vscode.window.showQuickPick(items, { title: `Insilode: which ${what} should the flow come from?`, ignoreFocusOut: true, matchOnDescription: true });
			if (!chosen) {
				throw new Error(`No ${what} chosen`);
			}
			pick = chosen.uri!;
		}
		await this.context.workspaceState.update(SOLUTION_KEY, pick.fsPath);
		return pick.fsPath;
	}

	async pickSolution() {
		await this.context.workspaceState.update(SOLUTION_KEY, undefined);
		this.stop();
		this.failure = undefined;
		await this.port();
	}

	private async start(): Promise<number> {
		const sln = await this.solution();
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.launch(sln);
			} catch (e) {
				if (e instanceof EarlyExit && attempt === 0) {
					this.log.info('analyzer exited right after it started: trying once more on another port');
					continue;
				}
				// Lens and trail requests keep asking: remember the failure instead of respawning for each of them.
				this.failure = { error: e as Error, until: Date.now() + RETRY_AFTER_MS };
				throw e;
			}
		}
	}

	/** Whether the process on `port` is our analyzer and loaded: it answers a request that carries the token. */
	private async probe(port: number): Promise<boolean> {
		if (!await canConnect(port)) {
			return false;
		}
		try {
			const res = await fetch(`http://127.0.0.1:${port}/api/entrypoints`, { headers: { 'x-flow-token': this.token }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
			const body: unknown = res.ok ? await res.json() : undefined;
			if (Array.isArray(body)) {
				this.seed = body as EntryPoint[];
				return true;
			}
		} catch {
			// not listening yet, or not the analyzer
		}
		return false;
	}

	private async launch(sln: string): Promise<number> {
		this.setStatus('$(loading~spin) Insilode', `Insilode: loading ${path.basename(sln)}`);
		const port = await freePort();
		this.log.info(`starting analyzer for ${sln} on ${port}`);
		const startedAt = Date.now();
		let aborted = false;
		this.cancelStart = () => { aborted = true; };
		// The token goes in the environment, not on the command line: any user of the machine can read a process's arguments
		// (ps, /proc/<pid>/cmdline), and only its own user its environment. The analyzer reads INSILODE_ANALYZER_TOKEN and clears it.
		const child = this.child = spawn('dotnet', [this.dll, 'serve', sln, String(port), String(process.pid)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, INSILODE_ANALYZER_TOKEN: this.token } });
		let stderr = '';
		child.stderr!.on('data', d => {
			stderr = (stderr + String(d)).slice(-4000);
			this.log.info(String(d).trimEnd());
		});
		const spawnFailed = new Promise<never>((_, reject) => child.once('error', e => {
			aborted = true; // the wait loop below must not keep polling a process that never existed
			reject(new Error((e as NodeJS.ErrnoException).code === 'ENOENT' ? 'dotnet was not found: install the .NET 10 SDK and make sure it is on PATH' : `Analyzer failed to start: ${e.message}`));
		}));
		spawnFailed.catch(() => undefined);
		child.on('exit', code => {
			this.log.info(`analyzer exited (${code})`);
			if (this.child === child) {
				this.child = undefined;
				this.ready = undefined;
				this.isReady = false;
				this.setStatus('$(warning) Insilode', 'Insilode analyzer stopped — click to restart');
			}
		});
		const loaded = vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Insilode: loading ${path.basename(sln)}` }, async () => {
			const deadline = Date.now() + 180_000;
			while (Date.now() < deadline) {
				if (aborted) {
					throw new Error('Analyzer start was cancelled');
				}
				if (await this.probe(port)) {
					this.setStatus('$(type-hierarchy-sub) Insilode', `Insilode: ${path.basename(sln)} ready — click for endpoints`);
					this.isReady = true;
					this.becameReady.fire();
					this.seed = undefined; // only the listeners that ran just now may use it
					return port;
				}
				if (child.exitCode !== null) {
					// `dotnet` is there, but not a .NET 10 for the analyzer: its launcher says so on stderr.
					if (/You must install or update \.NET|Framework: 'Microsoft\./.test(stderr)) {
						throw new Error('.NET 10 is required: install the .NET 10 SDK');
					}
					const message = 'Analyzer exited while loading the solution (see Output → Insilode)';
					throw Date.now() - startedAt < 5_000 ? new EarlyExit(message) : new Error(message);
				}
				await new Promise(r => setTimeout(r, 400));
			}
			throw new Error('Analyzer did not start within 3 minutes');
		});
		try {
			return await Promise.race([loaded, spawnFailed]);
		} catch (e) {
			// Nothing is left running (or spinning in the status bar) after a failed start; `aborted` ends the wait loop.
			aborted = true;
			child.kill();
			if (e instanceof Error && /dotnet was not found|\.NET 10 is required/.test(e.message)) {
				this.adviseDotnet();
			}
			if (this.child === child) {
				this.child = undefined;
				this.ready = undefined;
				this.isReady = false;
				this.setStatus('$(warning) Insilode', e instanceof Error && /dotnet was not found|\.NET 10 is required|failed to start/.test(e.message) ? 'Insilode analyzer could not start' : 'Insilode analyzer stopped — click to restart');
			}
			throw e;
		}
	}

	async get<T>(apiPath: string): Promise<T> {
		const port = await this.port();
		const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, { headers: { 'x-flow-token': this.token }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!res.ok) {
			throw new Error(`${apiPath}: ${res.status}`);
		}
		return res.json() as Promise<T>;
	}

	/**
	 * Editing help for a card (see Assist.cs): a POST with the card's text. It never starts the analyzer and never waits for a solution to
	 * load (typing must not queue behind that): `undefined` when the analyzer is not ready. Rejects on a timeout or an error.
	 */
	async assist<T>(op: 'complete' | 'signature' | 'hover' | 'definition', body: CardAsk, ms = ASSIST_TIMEOUT_MS): Promise<T | undefined> {
		if (!this.isReady || !this.ready) {
			return undefined;
		}
		const port = await this.ready;
		const res = await fetch(`http://127.0.0.1:${port}/api/assist/${op}`, {
			method: 'POST',
			headers: { 'x-flow-token': this.token, 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(ms),
		});
		if (!res.ok) {
			throw new Error(`assist/${op}: ${res.status}`);
		}
		return await res.json() as T;
	}

	methods(file: string) {
		return this.get<MethodInfo[]>(`/api/methods?file=${encodeURIComponent(file)}`);
	}

	/**
	 * Every source type with its members and constructor parameters, and every controller action with its parameter and return types
	 * (Types.cs): what the type model is built from. Like `assist` it never starts the analyzer and does not wait for a solution to load:
	 * `undefined` when the analyzer is not ready.
	 */
	async types(): Promise<CsTypesResponse | undefined> {
		if (!this.isReady || !this.ready) {
			return undefined;
		}
		const port = await this.ready;
		const res = await fetch(`http://127.0.0.1:${port}/api/types`, { headers: { 'x-flow-token': this.token }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!res.ok) {
			throw new Error(`/api/types: ${res.status}`);
		}
		return await res.json() as CsTypesResponse;
	}

	/**
	 * The entities the EF model maps, with their tables (Schema.cs). Like `types` it never starts the analyzer: `undefined` when it is not
	 * ready. `version` counts the refreshes that changed the solution, so a cached answer is stale once it moves.
	 */
	async entities(): Promise<{ version: number; entities: TableEntity[] } | undefined> {
		if (!this.isReady || !this.ready) {
			return undefined;
		}
		const port = await this.ready;
		const res = await fetch(`http://127.0.0.1:${port}/api/entities`, { headers: { 'x-flow-token': this.token }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!res.ok) {
			throw new Error(`/api/entities: ${res.status}`);
		}
		return await res.json() as { version: number; entities: TableEntity[] };
	}

	/**
	 * The database cards the C# entry points reach (Tables.cs), walked for at most `budgetMs` more of them; the analyzer remembers where it
	 * stopped and starts over after a refresh. Never starts the analyzer: `undefined` when it is not ready.
	 */
	async tables(budgetMs: number): Promise<(TablesFact & { version: number }) | undefined> {
		if (!this.isReady || !this.ready) {
			return undefined;
		}
		const port = await this.ready;
		const res = await fetch(`http://127.0.0.1:${port}/api/tables?budgetMs=${Math.max(200, Math.floor(budgetMs))}`, { headers: { 'x-flow-token': this.token }, signal: AbortSignal.timeout(budgetMs + REQUEST_TIMEOUT_MS) });
		if (!res.ok) {
			throw new Error(`/api/tables: ${res.status}`);
		}
		return await res.json() as TablesFact & { version: number };
	}

	/** What an EF Core migration file does to tables (Migrations.cs); undefined when the file is not one. Never starts the analyzer: undefined when it is not ready. */
	async migration(file: string): Promise<EfFact | undefined> {
		if (!this.isReady || !this.ready) {
			return undefined;
		}
		const port = await this.ready;
		const res = await fetch(`http://127.0.0.1:${port}/api/migration?file=${encodeURIComponent(file)}`, { headers: { 'x-flow-token': this.token }, signal: AbortSignal.timeout(ASSIST_TIMEOUT_MS) });
		if (res.status === 404) {
			return undefined;
		}
		if (!res.ok) {
			throw new Error(`/api/migration: ${res.status}`);
		}
		return await res.json() as EfFact | undefined ?? undefined;
	}

	/** One request at a time: callers that arrive while one runs share its answer. */
	entryPoints(): Promise<EntryPoint[]> {
		this.entriesInFlight ??= (async () => {
			let list = this.seed;
			this.seed = undefined;
			list ??= await this.get<EntryPoint[]>('/api/entrypoints');
			await this.context.workspaceState.update(ENTRIES_KEY, list);
			return list;
		})().finally(() => { this.entriesInFlight = undefined; });
		return this.entriesInFlight;
	}

	/** Ends the analyzer process; it starts again on the next request. */
	stop() {
		this.status.hide();
		this.isReady = false;
		this.cancelStart?.();
		this.seed = undefined;
		this.child?.kill();
		this.child = undefined;
		this.ready = undefined;
	}

	dispose() {
		if (Analyzer.current === this) {
			Analyzer.current = undefined;
		}
		this.stop();
		this.status.dispose();
		this.becameReady.dispose();
	}
}
