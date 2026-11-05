/*---------------------------------------------------------------------------------------------
 *  Insilode Home: the first thing a window shows. One question in the middle — what should we do —
 *  and around it only what helps answer it: where you were, the flows you opened, the endpoints,
 *  and whether the agent's harness is in good shape.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { askInDock } from './askAgent';
import { entryDisplay } from './entryLabel';
import { Command } from './commands';
import { entryName, type Endpoints, type IndexStatus, type Source } from './backends';

/** The commands the shortcut row of the Home page can run. */
export const HOME_COMMANDS: ReadonlySet<string> = new Set([
	'flow.showAtCursor', 'flow.pickEndpoint', 'workbench.action.quickOpen', 'workbench.view.extension.flowHarness', 'flow.agents.chooseAskTarget', 'flow.settings',
	// The first-run strip and the rows under the lists: the sample tour, Import from VS Code (flow-import) and the boards.
	'flow.tour.playSample', 'flow.importFromVSCode', 'flow.board.show', 'flow.board.fromCode',
]);

/** Whether a command id from the page is one of the shortcuts it shows: a message is not a licence to run any command. */
export const isHomeCommand = (command: unknown): command is string => typeof command === 'string' && HOME_COMMANDS.has(command);

/** The strip is dismissed for good in globalState (all windows), and a flow opened once ends it too. */
const STRIP_HIDDEN = 'flow.home.stripHidden';
const FLOW_OPENED = 'flow.home.flowOpened';

const RECENT_FILES = 'flow.home.recentFiles';
/** "Plan first" in words, for the chat panel when flow-agent is not there (flow-agent's planFirst says it the same way). */
const PLAN_FIRST = 'Plan this first and wait for my go-ahead before you change any file.';
const RECENT_FLOWS = 'flow.home.recentFlows';

interface Recent { path: string; at: number }
interface RecentFlow { id: string; label: string; source?: Source; at: number }
interface Health {
	score: number;
	counts: { error: number; warning: number; info: number };
	startupTokens: number;
	totals: Record<string, number>;
	issues: { severity: string; message: string; label: string; file: string; line?: number }[];
	/** This project's counts and the user's own (~/.claude); absent from an older flow-harness. */
	bySource?: { project: Record<string, number>; user: Record<string, number> };
	/** What the project has not set up. */
	gaps?: { label: string; message: string }[];
}

/** How a path is compared with the ones the page was given: resolved, and without case where the file system has none. */
export const pathKey = (file: string, platform: NodeJS.Platform = process.platform) => {
	const abs = (platform === 'win32' ? path.win32 : path.posix).resolve(file);
	return platform === 'win32' || platform === 'darwin' ? abs.toLowerCase() : abs;
};

/**
 * The files the page may ask to open, by `pathKey`: the recent files and the harness issues (in the project or in ~/.claude)
 * this host listed. Anything else the page names is refused: it is not trusted with a path.
 */
export function offeredFiles(files: { path: string }[], issues: unknown, platform: NodeJS.Platform = process.platform): Set<string> {
	const issueFiles = (Array.isArray(issues) ? issues : []).flatMap((i: { file?: unknown } | null) => typeof i?.file === 'string' && i.file ? [i.file] : []);
	return new Set([...files.map(f => f.path), ...issueFiles].map(f => pathKey(f, platform)));
}

/** Whether the page's `open` names a file this host offered. */
export const canOpen = (offered: Set<string>, file: unknown, platform: NodeJS.Platform = process.platform): file is string =>
	typeof file === 'string' && file.length > 0 && offered.has(pathKey(file, platform));

/** A 0-based line from the page (flow-harness counts issue lines from 0), as a whole number inside the file, or undefined. */
export function homeLine(line: unknown, lineCount: number): number | undefined {
	const n = typeof line === 'number' ? line : NaN;
	if (!Number.isInteger(n) || n < 0) {
		return undefined;
	}
	return Math.min(n, Math.max(0, lineCount - 1));
}

/** Where the prompts typed on Home go, in a sentence, from the setting flow.agents.askTarget (flow-agent contributes it). */
export function askTargetSentence(value: unknown): string {
	const none = 'Agent prompts are not available here';
	if (typeof value !== 'string' || !value) {
		return none;
	}
	switch (value) {
		case 'ask': return 'You pick the agent each time';
		case 'remember': return 'You pick the agent with your first prompt, and Insilode remembers it';
		case 'claude': return 'Prompts go to Claude Code';
		case 'codex': return 'Prompts go to Codex';
		case 'chat': return 'Prompts go to the chat panel';
		case 'clipboard': return 'Prompts are copied to the clipboard';
	}
	const name = /^custom:(.+)$/.exec(value)?.[1].trim().slice(0, 40);
	return name ? `Prompts go to ${name}` : none;
}

/** The first-run strip shows until the user hides it or has opened a flow: after that Home is not a place that explains itself. */
export const stripVisible = (s: { hidden: boolean; openedFlow: boolean }) => !s.hidden && !s.openedFlow;

export type IndexState = 'none' | 'indexing' | 'empty' | 'ready';

/** What the first index is doing, so "No endpoints found" is not said while the answer is still coming. `total`: endpoints known now. */
export function indexView(status: IndexStatus, total: number): { state: IndexState; text: string } {
	if (!status.hasFolder) {
		return { state: 'none', text: 'Open a folder to index its code.' };
	}
	if (!status.ready) {
		const p = status.progress;
		const n = (v: number) => Math.max(0, Math.floor(Number.isFinite(v) ? v : 0)).toLocaleString('en-US');
		return { state: 'indexing', text: p && p.total > 0 ? `Indexing… ${n(p.done)} of ${n(p.total)} files` : 'Indexing…' };
	}
	return total === 0 ? { state: 'empty', text: 'No endpoints found' } : { state: 'ready', text: '' };
}

/** The harness gaps as the page lists them: a few, as plain text, so the page does not draw an unbounded list from another extension. */
export function shapeGaps(gaps: unknown): { label: string; message: string }[] {
	const text = (v: unknown, max: number) => typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
	return (Array.isArray(gaps) ? gaps : []).flatMap((g: { label?: unknown; message?: unknown } | null) => {
		const label = text(g?.label, 60);
		return label ? [{ label, message: text(g?.message, 200) }] : [];
	}).slice(0, 5);
}

/** "Harness health 72 / 100 · 3 gaps". */
export function healthLabel(score: unknown, gapCount: number): string {
	const n = typeof score === 'number' && Number.isFinite(score) ? Math.round(score) : 0;
	return `Harness health ${n} / 100${gapCount ? ` · ${gapCount} gap${gapCount === 1 ? '' : 's'}` : ''}`;
}

/**
 * Git's churn per root, kept once it is known. A failed attempt (git missing, not a repository, a timeout) is never kept:
 * the next show tries again, and `failed` says the last attempt did not work, so the page can say "churn unavailable".
 */
export class ChurnCache {
	private readonly known = new Map<string, Map<string, number>>();
	private readonly inflight = new Map<string, Promise<Map<string, number> | undefined>>();
	private readonly misses = new Set<string>();

	constructor(private readonly load: (root: string) => Promise<Map<string, number> | undefined>) { }

	/** What is known now, without asking git. */
	peek(root: string) {
		return this.known.get(root);
	}

	/** The last attempt for `root` ended in a failure and none is running. */
	failed(root: string) {
		return this.misses.has(root) && !this.inflight.has(root);
	}

	get(root: string): Promise<Map<string, number> | undefined> {
		const hit = this.known.get(root);
		if (hit) {
			return Promise.resolve(hit);
		}
		let run = this.inflight.get(root);
		if (!run) {
			run = Promise.resolve().then(() => this.load(root)).catch(() => undefined).then(got => {
				this.inflight.delete(root);
				if (got) {
					this.known.set(root, got);
					this.misses.delete(root);
				} else {
					this.misses.add(root);
				}
				return got;
			});
			this.inflight.set(root, run);
		}
		return run;
	}
}

/**
 * How often git saw each file change lately (last 90 days), by `pathKey`. `--relative` makes the paths relative to `root`
 * (and leaves out files outside it): without it they are relative to the repository's top, and a workspace that is a
 * subfolder of the repository would join them onto itself and never match. Nothing when the folder is not a repository.
 */
export const gitChurn = async (root: string) => await gitChurnResult(root) ?? new Map<string, number>();

/** `gitChurn`, but a git error (not a repository, no git, the timeout) is undefined rather than an empty answer, so it is not mistaken for "nothing changed". */
export function gitChurnResult(root: string): Promise<Map<string, number> | undefined> {
	return new Promise(resolve => {
		execFile('git', ['log', '--since=90.days', '--relative', '--name-only', '--pretty=format:'], { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 10_000, windowsHide: true }, (err, out) => {
			if (err) {
				resolve(undefined);
				return;
			}
			const counts = new Map<string, number>();
			for (const line of out.split('\n')) {
				const rel = line.trim();
				if (rel) {
					const key = pathKey(path.join(root, rel));
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}
			resolve(counts);
		});
	});
}

/** a1 b1 a2 b2 …: with two backends neither pushes the other off a short list. */
function interleave<T>(a: T[], b: T[]): T[] {
	const out: T[] = [];
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		out.push(...[a[i], b[i]].filter((x): x is T => x !== undefined));
	}
	return out;
}

export class FlowHome implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly disposables: vscode.Disposable[] = [];
	/** What the page shows while the slow parts (the harness check, git) are still on their way. */
	private health: Health | undefined;
	private healthState: 'pending' | 'ok' | 'unavailable' = 'pending';
	private branchName: string | undefined;
	private readonly churnCache = new ChurnCache(gitChurnResult);
	private repostTimer: NodeJS.Timeout | undefined;

	constructor(private readonly context: vscode.ExtensionContext, private readonly endpoints: Endpoints) {
		// The index fills in while Home is open: say so as it goes (progress comes often, so not more than a few times a second).
		this.disposables.push(
			endpoints.onDidChange(() => this.repostSoon()),
			endpoints.onDidChangeStatus(() => this.repostSoon()),
			vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('flow.agents.askTarget') && this.repostSoon()),
		);
		// Remember where you were: the files you open and the flows you draw.
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(e => {
			if (e?.document.uri.scheme === 'file') {
				const list = this.context.workspaceState.get<Recent[]>(RECENT_FILES, []).filter(r => r.path !== e.document.uri.fsPath);
				void this.context.workspaceState.update(RECENT_FILES, [{ path: e.document.uri.fsPath, at: Date.now() }, ...list].slice(0, 12));
			}
		}));
	}

	rememberFlow(id: string, label: string, source?: Source) {
		const list = this.context.workspaceState.get<RecentFlow[]>(RECENT_FLOWS, []).filter(r => r.id !== id);
		void this.context.workspaceState.update(RECENT_FLOWS, [{ id, label, source, at: Date.now() }, ...list].slice(0, 8));
		if (!this.context.globalState.get<boolean>(FLOW_OPENED)) {
			void this.context.globalState.update(FLOW_OPENED, true);
		}
	}

	/** Posts the page again from what is known, once a burst of changes is over: no git, no harness check. */
	private repostSoon() {
		if (this.panel && !this.repostTimer) {
			this.repostTimer = setTimeout(() => {
				this.repostTimer = undefined;
				this.send();
			}, 250);
		}
	}

	async show() {
		if (this.panel) {
			this.panel.reveal();
			await this.post();
			return;
		}
		const panel = this.panel = vscode.window.createWebviewPanel('flow.home', 'Home', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false });
		panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'flow.svg');
		panel.onDidDispose(() => this.panel = undefined);
		panel.webview.onDidReceiveMessage(m => this.onMessage(m).catch(e => vscode.window.showErrorMessage(`Insilode: ${(e as Error).message ?? e}`)));
		panel.webview.html = this.html();
		panel.onDidChangeViewState(e => e.webviewPanel.visible && void this.post());
	}

	private async onMessage(m: { type: string; text?: string; plan?: boolean; path?: string; id?: string; label?: string; source?: Source; command?: string; line?: unknown }) {
		// The prompt is the user's own typing: a string, or nothing.
		if (m.text !== undefined && typeof m.text !== 'string') {
			return undefined;
		}
		switch (m.type) {
			case 'ready': return this.post();
			// "Plan first" goes as an option: flow-agent says it the way the chosen agent understands (/plan is Claude Code's).
			case 'ask': return await askInDock(m.text ?? '', true, 'Home', [], { plan: m.plan === true }) || vscode.commands.executeCommand('workbench.action.chat.open', { query: m.plan === true ? `${PLAN_FIRST} ${m.text ?? ''}` : m.text, isPartialQuery: false });
			case 'draft': return await askInDock(m.text ?? '', false, 'Home') || vscode.commands.executeCommand('workbench.action.chat.open', { query: m.text, isPartialQuery: true });
			case 'open': return this.open(m.path, m.line);
			// The flow is looked up by its id in the index; the page only gets to name it with text and a known backend.
			case 'flow': return typeof m.id === 'string' && m.id.length <= 2000 && typeof m.label === 'string'
				? vscode.commands.executeCommand(Command.showEntry, m.id, m.label.slice(0, 500), m.source === 'roslyn' || m.source === 'poly' ? m.source : undefined)
				: undefined;
			// Only the shortcuts this page shows: a message is not a licence to run any command.
			// A command of a part that is not installed (Import lives in flow-import) says so rather than failing silently.
			case 'run': {
				const command = m.command ?? '';
				if (!HOME_COMMANDS.has(command)) {
					return undefined;
				}
				return Promise.resolve(vscode.commands.executeCommand(command)).then(undefined, () => void vscode.window.showInformationMessage(`Insilode: "${command}" is not available in this window.`));
			}
			case 'hideStrip':
				await this.context.globalState.update(STRIP_HIDDEN, true);
				return this.send();
			default: return undefined;
		}
	}

	/**
	 * Opens a row of the page. Only a file this host itself listed in its last `data` message (a recent file, a harness issue
	 * in the project or in ~/.claude) can be opened: the page is not trusted with a path, so a message cannot open any file on disk.
	 */
	private async open(file: unknown, line: unknown) {
		if (!canOpen(this.offered, file)) {
			return;
		}
		// A listed file can be gone since (or be binary): then there is nothing to open, and nothing to report from a click.
		const doc = await Promise.resolve(vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(file)))).catch(() => undefined);
		if (!doc) {
			return;
		}
		const at = homeLine(line, doc.lineCount);
		await vscode.window.showTextDocument(doc, { selection: at !== undefined ? new vscode.Range(at, 0, at, 0) : undefined });
	}

	/** The files the last `data` message listed, by `pathKey`: the only ones `open` accepts. */
	private offered = new Set<string>();

	private async branch(): Promise<string | undefined> {
		try {
			const git = vscode.extensions.getExtension<{ getAPI(v: 1): { repositories: { state: { HEAD?: { name?: string } } }[] } }>('vscode.git');
			const api = (git?.isActive ? git.exports : await git?.activate())?.getAPI(1);
			return api?.repositories[0]?.state.HEAD?.name;
		} catch {
			return undefined;
		}
	}

	/** Home's first paint is the cheap data; the harness check and git's churn arrive after it as more messages. */
	private async post() {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const root = folder?.uri.fsPath ?? '';
		this.send();
		if (!this.panel) {
			return;
		}
		await Promise.all([
			this.loadHealth(root),
			this.loadChurn(root),
			this.branch().then(b => {
				if (b !== this.branchName) {
					this.branchName = b;
					this.send();
				}
			}),
		]);
	}

	/** flow-harness answers the health command; without it (or a folder) the page says "not available", it does not fail. */
	private async loadHealth(root: string) {
		if (!root) {
			return;
		}
		try {
			this.health = await Promise.resolve(vscode.commands.executeCommand<Health | undefined>('flowHarness.health')) ?? undefined;
			this.healthState = this.health ? 'ok' : 'unavailable';
		} catch {
			this.health = undefined;
			this.healthState = 'unavailable';
		}
		this.send();
	}

	/** The endpoints people work on come first: git's churn, asked in the background and only kept when git answered. */
	private async loadChurn(root: string) {
		if (root && !this.churnCache.peek(root)) {
			await this.churnCache.get(root);
			this.send();
		}
	}

	private send() {
		const panel = this.panel;
		if (!panel) {
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0];
		const root = folder?.uri.fsPath ?? '';
		// A file that is gone (in a removed agent worktree, say) is no place to go back to.
		const files = this.context.workspaceState.get<Recent[]>(RECENT_FILES, []).filter(r => existsSync(r.path)).slice(0, 7)
			.map(r => ({ path: r.path, name: path.basename(r.path), dir: path.relative(root, path.dirname(r.path)), at: r.at }));
		const flows = this.context.workspaceState.get<RecentFlow[]>(RECENT_FLOWS, []).slice(0, 7);
		const all = this.endpoints.cached();
		// The endpoints whose files changed most lately first; then the order the backends gave.
		const churn = (root && this.churnCache.peek(root)) || new Map<string, number>();
		const heat = (file: string) => churn.get(pathKey(file)) ?? 0;
		const ranked = interleave(all.filter(e => e.source === 'roslyn'), all.filter(e => e.source === 'poly'))
			.map((e, i) => ({ e, i, heat: heat(e.file) }))
			.sort((a, b) => b.heat - a.heat || a.i - b.i)
			.map(x => x.e);
		const endpoints = ranked.slice(0, 7).map(e => {
			const show = entryDisplay(e, path.relative(root, e.file));
			return { id: e.id, source: e.source, label: entryName(e), http: e.http.split(/\s/)[0], route: show.title.replace(/^\S+\s+/, ''), detail: show.detail };
		});
		const gaps = shapeGaps(this.health?.gaps);
		const health = this.health && { ...this.health, gaps, label: healthLabel(this.health.score, gaps.length) };
		this.offered = offeredFiles(files, this.health?.issues);
		const hidden = this.context.globalState.get<boolean>(STRIP_HIDDEN, false);
		const openedFlow = this.context.globalState.get<boolean>(FLOW_OPENED, false) || flows.length > 0;
		void Promise.resolve(panel.webview.postMessage({
			type: 'data',
			repo: folder?.name ?? 'No folder open',
			branch: this.branchName,
			hour: new Date().getHours(),
			files, flows, endpoints, health,
			healthState: root ? this.healthState : 'nofolder',
			total: all.length,
			strip: stripVisible({ hidden, openedFlow }),
			agent: askTargetSentence(vscode.workspace.getConfiguration('flow.agents').get('askTarget')),
			index: indexView(this.endpoints.status(), all.length),
			// "churn unavailable" only when the last attempt failed; without a folder there is nothing to ask git.
			churn: !root || this.churnCache.peek(root) ? 'ok' : this.churnCache.failed(root) ? 'unavailable' : 'pending',
		})).catch(() => undefined);
	}

	private html() {
		return homeHtml(randomBytes(16).toString('base64'));
	}

	dispose() {
		clearTimeout(this.repostTimer);
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}

/**
 * The page. Its one script runs by a nonce made for each load, as on the canvas and the boards: no inline handler and no
 * injected <script> can run. Everything the host sends is escaped where it goes into markup, numbers included: they come from
 * another extension (flowHarness.health) and from the indexed source, and are not trusted to be what their type says.
 */
export function homeHtml(nonce: string) {
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	return /* html */ `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root {
	--bg: var(--vscode-editor-background); --text: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground);
	--line: var(--vscode-widget-border, color-mix(in srgb, var(--text) 18%, transparent));
	--raised: var(--vscode-chat-requestBubbleBackground, color-mix(in srgb, var(--text) 6%, var(--bg)));
	--signal: var(--vscode-textLink-foreground, #3b5bdb); --plan: var(--vscode-editorWarning-foreground, #b26a00);
	--ok: var(--vscode-testing-iconPassed, #1a7f4b); --bad: var(--vscode-errorForeground, #c62828);
	--violet: var(--vscode-terminal-ansiMagenta, #8250df); --teal: var(--vscode-terminal-ansiCyan, #0f8b8d); --gold: var(--plan);
	--mono: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.5 var(--vscode-font-family, -apple-system, system-ui); }
main { max-width: 980px; margin: 0 auto; padding: clamp(40px, 11vh, 120px) 32px 48px; }

.where { display: flex; align-items: center; gap: 10px; color: var(--muted); font-size: 12.5px; }
.where svg { flex: none; }
.where b { color: var(--text); font-weight: 600; }
.branch { font-family: var(--mono); font-size: 12px; padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }

h1 { margin: 18px 0 18px; font-size: clamp(26px, 3.2vw, 34px); line-height: 1.15; font-weight: 600; letter-spacing: -0.02em; }

/* The one thing that is bigger than everything else: the question to the agent. */
.ask { position: relative; display: flex; flex-direction: column; border-radius: 16px; background: var(--raised); border: 1px solid var(--line); transition: border-color .15s, box-shadow .15s; }
.ask:focus-within { border-color: color-mix(in srgb, var(--signal) 65%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--signal) 13%, transparent); }
.ask textarea { resize: none; border: 0; outline: 0; background: transparent; color: var(--text); font: 15px/1.5 inherit; font-family: inherit; padding: 16px 18px 6px; min-height: 76px; }
.ask textarea::placeholder { color: var(--muted); }
.ask-bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px 10px 14px; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: 12px inherit; font-family: inherit; cursor: pointer; }
.chip:hover { color: var(--text); border-color: color-mix(in srgb, var(--text) 25%, transparent); }
.chip i { width: 7px; height: 7px; border-radius: 50%; background: currentColor; }
.chip.plan { color: var(--plan); border-color: color-mix(in srgb, var(--plan) 35%, transparent); }
.spacer { flex: 1; }
.send { width: 30px; height: 30px; border-radius: 50%; border: 0; background: var(--text); color: var(--bg); cursor: pointer; display: grid; place-items: center; }
.send:disabled { opacity: .3; cursor: default; }
.hint { margin: 10px 4px 0; color: var(--muted); font-size: 12px; }
.hint .link { background: none; border: 0; padding: 0; color: var(--vscode-textLink-foreground); font: inherit; cursor: pointer; }
.hint .link:hover { text-decoration: underline; }
kbd { font: 11px var(--mono); padding: 0 5px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; color: var(--text); }

/* Where you left off: the last flow you opened, one click back onto its canvas. */
.resume { display: flex; align-items: center; gap: 14px; width: 100%; margin-top: 28px; padding: 14px 18px; border: 1px solid var(--line); border-radius: 14px; background: color-mix(in srgb, var(--signal) 7%, var(--bg)); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.resume:hover { border-color: color-mix(in srgb, var(--signal) 55%, transparent); }
.resume:focus-visible { outline: 1.5px solid var(--signal); outline-offset: 2px; }
.resume svg { flex: none; color: var(--signal); }
.resume b { display: block; font-family: var(--mono); font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.resume span { display: block; color: var(--muted); font-size: 12px; }
.resume .go { margin-left: auto; color: var(--signal); font-weight: 600; flex: none; }

/* Below the question: three lists side by side, separated by hairlines, no boxes. */
.cols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 56px; }
.col { padding: 0 24px; border-left: 1px solid var(--line); min-width: 0; }
.col:first-child { padding-left: 4px; border-left: 0; }
.col h2 { margin: 0 0 10px; font-size: 12.5px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }
.col h2 span { color: var(--muted); font-weight: 400; }
.more { margin: 4px 0 0; padding: 0; border: 0; background: none; color: var(--vscode-textLink-foreground, #3b5bdb); font: inherit; font-size: 12px; cursor: pointer; }
.more:hover { text-decoration: underline; }
.row { display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 5px 8px; margin-left: -8px; border: 0; border-radius: 7px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.row:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
.row .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.row .sub { margin-left: auto; color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
.verb { font: 600 10px var(--mono); width: 38px; flex: none; }
.v-GET { color: var(--ok); } .v-POST { color: var(--plan); } .v-PUT { color: var(--signal); } .v-PATCH { color: var(--violet); } .v-DELETE { color: var(--bad); }
.glyph { flex: none; width: 8px; height: 8px; transform: translateY(-1px); }
.empty { color: var(--muted); font-size: 12.5px; margin: 4px 0; }

.health { display: flex; align-items: baseline; gap: 10px; margin-bottom: 6px; }
.score { font-size: 30px; font-weight: 600; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.score.good { color: var(--ok); } .score.mid { color: var(--plan); } .score.bad { color: var(--bad); }
.health p { margin: 0; color: var(--muted); font-size: 12px; }
.sev { flex: none; width: 6px; height: 6px; border-radius: 50%; transform: translateY(-2px); }
.sev.error { background: var(--bad); } .sev.warning { background: var(--plan); }

.fl-a { fill: var(--plan); } .fl-v { fill: var(--violet); } .fl-s { fill: var(--signal); }
.idx { margin-left: auto; font-size: 12px; color: var(--plan); }
.idx:empty { display: none; }
.gaps { margin: 8px 0 2px; color: var(--plan); font-size: 12px; }
.gaplist { margin: 0 0 6px; padding-left: 16px; color: var(--muted); font-size: 12px; }
.gaplist b { color: var(--text); font-weight: 600; }
.chip.primary { color: var(--bg); background: var(--signal); border-color: var(--signal); }
.chip.primary:hover { color: var(--bg); filter: brightness(1.1); }

/* First run: what Insilode is, and where a prompt typed here goes. Gone once it is hidden or a flow was opened. */
.strip { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; margin-bottom: 26px; padding: 12px 16px; border: 1px solid color-mix(in srgb, var(--signal) 40%, var(--line)); border-radius: 12px; background: color-mix(in srgb, var(--signal) 8%, var(--bg)); }
.strip-text { flex: 1 1 320px; min-width: 0; }
.strip-text b { display: block; font-weight: 600; }
.strip-text span { display: block; color: var(--muted); font-size: 12.5px; }
.strip-acts { display: flex; gap: 8px; flex: none; }

/* Under the lists: the parts that are not on the canvas. */
.tools { margin-top: 36px; display: grid; gap: 4px; }
.tool { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid var(--line); }
.tool div { flex: 1; min-width: 0; }
.tool b { font-weight: 600; margin-right: 8px; }
.tool span { color: var(--muted); font-size: 12px; }

.keys { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 52px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.keys button { all: unset; cursor: pointer; display: inline-flex; gap: 8px; align-items: center; }
.keys button:hover { color: var(--text); }
.keys button:focus-visible, .row:focus-visible, .chip:focus-visible, .more:focus-visible, .send:focus-visible { outline: 1.5px solid var(--signal); outline-offset: 2px; }

@media (max-width: 760px) {
	.cols { grid-template-columns: 1fr; gap: 28px; }
	.col, .col:first-child { padding: 0 4px; border-left: 0; }
}
@media (prefers-reduced-motion: reduce) { .ask { transition: none; } }
</style></head><body><main>
	<div id="strip"></div>
	<div class="where">
		<svg width="22" height="12" viewBox="0 0 240 120" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="10"><rect x="76" y="20" width="152" height="80" rx="22"/><path d="M46 60h48M136 60h32"/></g><path class="fl-a" d="M14 36l36 24-36 24z"/><path class="fl-v" d="M115 37l23 23-23 23-23-23z"/><circle class="fl-s" cx="188" cy="60" r="18"/></svg>
		<b id="repo">…</b><span id="branch"></span><span class="idx" id="idx" role="status"></span>
	</div>
	<h1 id="greet">What should we work on?</h1>
	<form class="ask" id="ask">
		<textarea id="q" placeholder="Describe a change, ask about the code, or type / for a skill" rows="2" aria-label="Ask the agent"></textarea>
		<div class="ask-bar">
			<button type="button" class="chip plan" data-plan="1" title="Ask the agent to plan before it edits (Claude Code gets /plan)"><i></i>Plan first</button>
			<button type="button" class="chip" data-draft="Review my uncommitted changes and list risks, most serious first." title="Put this prompt in the agent's prompt to finish or send">Review my changes</button>
			<button type="button" class="chip" data-draft="Explain how this repo is laid out and where the main flows start." title="Put this prompt in the agent's prompt to finish or send">Explain this repo</button>
			<span class="spacer"></span>
			<button class="send" id="send" disabled aria-label="Send to the agent"><svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
		</div>
	</form>
	<p class="hint"><kbd>Enter</kbd> sends to the agent you chose (<button class="link" data-run="flow.agents.chooseAskTarget">change</button>), <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</p>

	<div id="resume"></div>

	<section class="cols">
		<div class="col"><h2>Where you were</h2><div id="files"></div></div>
		<div class="col"><h2 id="flowsTitle">Flows</h2><div id="flows"></div></div>
		<div class="col"><h2>Harness</h2><div id="health"></div></div>
	</section>

	<section class="tools" aria-label="More of Insilode">
		<div class="tool"><div><b>Import from VS Code</b><span>Bring over your settings, keybindings, snippets, theme and extensions.</span></div><button class="chip" data-run="flow.importFromVSCode">Import…</button></div>
		<div class="tool"><div><b>Boards</b><span>Draw a diagram from your code, or reopen the one you had.</span></div><button class="chip" data-run="flow.board.show">Show board</button><button class="chip" data-run="flow.board.fromCode">Board from code…</button></div>
	</section>

	<nav class="keys" aria-label="Shortcuts">
		<button data-run="flow.showAtCursor"><kbd data-k="mod+alt+F"></kbd> Show flow at cursor</button>
		<button data-run="flow.pickEndpoint"><kbd data-k="mod+alt+E"></kbd> Trace an endpoint</button>
		<button data-run="workbench.action.quickOpen"><kbd data-k="mod+P"></kbd> Go to file</button>
		<button data-run="workbench.view.extension.flowHarness"><kbd>Harness</kbd> Open the map</button>
		<button data-run="flow.settings"><kbd>Settings</kbd> Change how Insilode works</button>
	</nav>
</main>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
// Shortcut labels follow the OS: ⌥⌘F on a Mac, Ctrl+Alt+F elsewhere (the same chord the keybindings register).
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const MODS = { ctrl: ['⌃', 'Ctrl'], alt: ['⌥', 'Alt'], shift: ['⇧', 'Shift'], mod: ['⌘', 'Ctrl'] };
const keyLabel = k => { const parts = k.split('+'); const key = parts.filter(p => !MODS[p]);
	// Apple order is ⌃⌥⇧⌘; Windows and Linux read Ctrl+Alt+Shift+key.
	const order = MAC ? ['ctrl', 'alt', 'shift', 'mod'] : ['mod', 'ctrl', 'alt', 'shift'];
	const mods = order.filter(m => parts.includes(m)).map(m => MODS[m][MAC ? 0 : 1]);
	return MAC ? mods.concat(key).join('') : [...new Set(mods)].concat(key).join('+'); };
const applyKeys = () => document.querySelectorAll('kbd[data-k]').forEach(el => { el.textContent = keyLabel(el.dataset.k); });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// A count from the host as a finite number (0 otherwise): numbers are written into markup unescaped only after this.
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const ago = t => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 60 ? m + ' min' : m < 1440 ? Math.round(m / 60) + ' h' : Math.round(m / 1440) + ' d'; };
const q = $('q');
let plan = false;
q.addEventListener('input', () => { $('send').disabled = !q.value.trim(); });
q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
$('ask').addEventListener('submit', e => { e.preventDefault(); submit(); });
function submit() { const t = q.value.trim(); if (!t) return; vscode.postMessage({ type: 'ask', text: t, plan }); q.value = ''; $('send').disabled = true; }
document.querySelectorAll('[data-draft]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'draft', text: b.dataset.draft })));
document.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => { plan = !plan; b.setAttribute('aria-pressed', String(plan)); b.style.background = plan ? 'color-mix(in srgb, var(--plan) 14%, transparent)' : ''; q.focus(); }));
document.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => vscode.postMessage({ type: 'run', command: b.dataset.run })));
window.addEventListener('message', e => {
	const d = e.data; if (d.type !== 'data') return;
	$('repo').textContent = d.repo;
	// The first-run strip: shown until it is hidden or a flow was opened (the host decides). What it says about the agent comes from the host too.
	$('strip').innerHTML = d.strip ? '<section class="strip" aria-label="About Insilode"><div class="strip-text"><b>Insilode draws your code&#39;s call flow on a canvas and lets an agent point at it.</b><span>' + esc(d.agent || '') + '</span></div><div class="strip-acts"><button class="chip" data-run="flow.agents.chooseAskTarget">Change</button><button class="chip primary" data-run="flow.tour.playSample">Take the tour</button><button class="chip" data-hide="1" aria-label="Hide this welcome">Hide</button></div></section>' : '';
	document.querySelectorAll('.strip [data-run]').forEach(b => b.onclick = () => vscode.postMessage({ type: 'run', command: b.dataset.run }));
	document.querySelectorAll('.strip [data-hide]').forEach(b => b.onclick = () => vscode.postMessage({ type: 'hideStrip' }));
	const ix = d.index || {};
	$('idx').textContent = ix.state === 'indexing' ? String(ix.text || '') : '';
	$('branch').innerHTML = d.branch ? '<span class="branch">' + esc(d.branch) + '</span>' : '';
	const part = d.hour < 5 ? 'Late night' : d.hour < 12 ? 'Morning' : d.hour < 18 ? 'Afternoon' : 'Evening';
	$('greet').textContent = part + ' in ' + d.repo + '. What should we work on?';
	$('files').innerHTML = d.files.length ? d.files.map(f => '<button class="row" data-path="' + esc(f.path) + '"><span class="name">' + esc(f.name) + '</span><span class="sub">' + esc(f.dir || ago(f.at)) + '</span></button>').join('') : '<p class="empty">Files you open show up here.</p>';
	if (d.flows.length) {
		const f = d.flows[0];
		$('resume').innerHTML = '<button class="resume" id="resumeBtn"><svg width="26" height="14" viewBox="0 0 240 120" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="10"><rect x="76" y="20" width="152" height="80" rx="22"/><path d="M46 60h48M136 60h32"/></g><g fill="currentColor"><path d="M14 40l32 20-32 20z"/><path d="M115 39l21 21-21 21-21-21z"/><circle cx="188" cy="60" r="18"/></g></svg><div><b>' + esc(f.label) + '</b><span>Last flow you opened, ' + esc(ago(f.at)) + ' ago</span></div><span class="go">Open canvas</span></button>';
		$('resumeBtn').onclick = () => vscode.postMessage({ type: 'flow', id: f.id, label: f.label, source: f.source || '' });
		$('flowsTitle').innerHTML = 'Flows you opened';
		$('flows').innerHTML = d.flows.map(f => '<button class="row" data-id="' + esc(f.id) + '" data-source="' + esc(f.source || '') + '" data-label="' + esc(f.label) + '"><svg class="glyph" viewBox="0 0 10 10"><path class="fl-v" d="M5 0l5 5-5 5-5-5z"/></svg><span class="name">' + esc(f.label) + '</span><span class="sub">' + esc(ago(f.at)) + '</span></button>').join('');
	} else {
		const total = num(d.total);
		$('flowsTitle').innerHTML = 'Endpoints <span>' + (total || '') + '</span>';
		// The route first, as a developer reads it; the service and handler after it.
		$('flows').innerHTML = (d.endpoints.length ? d.endpoints.map(e => '<button class="row" data-id="' + esc(e.id) + '" data-source="' + esc(e.source) + '" data-label="' + esc(e.label) + '" title="' + esc(e.http + ' ' + e.route + '  ' + e.detail) + '"><span class="verb v-' + esc(e.http) + '">' + esc(e.http) + '</span><span class="name">' + esc(e.route) + '</span><span class="sub">' + esc(e.detail) + '</span></button>').join('') : ix.state === 'indexing' || ix.state === 'none' ? '<p class="empty">' + esc(ix.text) + '</p>'
				: '<p class="empty">' + (ix.state === 'empty' ? esc(ix.text) + '. ' : '') + 'Open a source file and press <kbd data-k="mod+alt+F"></kbd> to draw its flow.</p>')
			+ (d.churn === 'unavailable' && d.endpoints.length ? '<p class="empty">Order by recent changes: churn unavailable.</p>' : '')
			+ (total > d.endpoints.length ? '<button class="more" data-run="flow.pickEndpoint">All ' + total + ' endpoints…</button>' : '');
	}
	const h = d.health;
	if (h) {
		const score = num(h.score);
		const cls = score >= 85 ? 'good' : score >= 60 ? 'mid' : 'bad';
		const t = h.totals;
		const n = (k, one, many) => num(k) + ' ' + (num(k) === 1 ? one : many || one + 's');
		const list = c => { c = c || {}; return [n(c.instructions, 'instruction'), n(c.skills, 'skill'), n(c.hooks, 'hook'), num(c.mcp) + ' MCP'].join(', '); };
		const gaps = h.gaps || [];
		const counts = h.counts || {};
		// A line goes back to the host as a number; anything else is no line at all.
		const lineOf = l => Number.isInteger(l) && l >= 0 ? String(l) : '';
		$('health').innerHTML = '<div class="health"><span class="score ' + cls + '">' + score + '</span><p>' + (h.label ? '<b>' + esc(h.label) + '</b><br>' : '') + (num(counts.error) ? num(counts.error) + ' broken, ' : '') + num(counts.warning) + ' to look at<br>' + (num(h.startupTokens) / 1000).toFixed(1) + 'k tokens before your first prompt</p></div>'
			+ (h.issues || []).slice(0, 4).map(i => '<button class="row" data-path="' + esc(i.file) + '" data-line="' + lineOf(i.line) + '"><span class="sev ' + esc(i.severity) + '"></span><span class="name">' + esc(i.message) + '</span></button>').join('')
			// The gaps and what to do about them are in the page, not in a tooltip.
			+ (gaps.length ? '<p class="gaps">Not set up here:</p><ul class="gaplist">' + gaps.slice(0, 6).map(g => '<li><b>' + esc(g.label) + '</b>' + (g.message ? ' ' + esc(g.message) : '') + '</li>').join('') + '</ul>' : '')
			// Which counts are the project's and which come from your own ~/.claude: an empty project is not "1 instruction, 20 skills".
			+ (h.bySource
				? '<p class="empty">This project: ' + list(h.bySource.project) + '<br>Yours (~/.claude): ' + list(h.bySource.user) + '</p>'
				: '<p class="empty">' + list(t) + '</p>');
	} else {
		$('health').innerHTML = '<p class="empty">' + (d.healthState === 'pending' ? 'Checking the harness…' : d.healthState === 'unavailable' ? 'Harness health is not available here.' : 'Open a folder to check its harness.') + '</p>';
	}
	document.querySelectorAll('.row[data-path]').forEach(b => b.onclick = () => vscode.postMessage({ type: 'open', path: b.dataset.path, line: b.dataset.line ? Number(b.dataset.line) : undefined }));
	applyKeys();
	document.querySelectorAll('.row[data-id]').forEach(b => b.onclick = () => vscode.postMessage({ type: 'flow', id: b.dataset.id, label: b.dataset.label, source: b.dataset.source }));
	// Drawn with the list, after the page's own [data-run] buttons were wired.
	document.querySelectorAll('.more[data-run]').forEach(b => b.onclick = () => vscode.postMessage({ type: 'run', command: b.dataset.run }));
});
applyKeys();
vscode.postMessage({ type: 'ready' });
q.focus();
</script></body></html>`;
}
