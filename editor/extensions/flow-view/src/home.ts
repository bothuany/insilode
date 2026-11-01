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
import { entryName, type Endpoints, type Source } from './backends';

/** The commands the shortcut row of the Home page can run. */
const HOME_COMMANDS = new Set(['flow.showAtCursor', 'flow.pickEndpoint', 'workbench.action.quickOpen', 'workbench.view.extension.flowHarness', 'flow.agents.chooseAskTarget', 'flow.settings']);

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

/**
 * How often git saw each file change lately (last 90 days), by `pathKey`. `--relative` makes the paths relative to `root`
 * (and leaves out files outside it): without it they are relative to the repository's top, and a workspace that is a
 * subfolder of the repository would join them onto itself and never match. Nothing when the folder is not a repository.
 */
export function gitChurn(root: string): Promise<Map<string, number>> {
	return new Promise(resolve => {
		execFile('git', ['log', '--since=90.days', '--relative', '--name-only', '--pretty=format:'], { cwd: root, maxBuffer: 32 * 1024 * 1024, timeout: 10_000, windowsHide: true }, (err, out) => {
			const counts = new Map<string, number>();
			if (!err) {
				for (const line of out.split('\n')) {
					const rel = line.trim();
					if (rel) {
						const key = pathKey(path.join(root, rel));
						counts.set(key, (counts.get(key) ?? 0) + 1);
					}
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

	constructor(private readonly context: vscode.ExtensionContext, private readonly endpoints: Endpoints) {
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
			case 'run': return HOME_COMMANDS.has(m.command ?? '') ? vscode.commands.executeCommand(m.command!) : undefined;
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

	/** The endpoints people work on come first: git's churn, asked once per window, in the background. */
	private churn: Promise<Map<string, number>> | undefined;
	private churnOf(root: string) {
		return this.churn ??= gitChurn(root);
	}

	private async post() {
		const folder = vscode.workspace.workspaceFolders?.[0];
		const root = folder?.uri.fsPath ?? '';
		const health = await Promise.resolve(vscode.commands.executeCommand<Health | undefined>('flowHarness.health')).catch(() => undefined);
		// A file that is gone (in a removed agent worktree, say) is no place to go back to.
		const files = this.context.workspaceState.get<Recent[]>(RECENT_FILES, []).filter(r => existsSync(r.path)).slice(0, 7)
			.map(r => ({ path: r.path, name: path.basename(r.path), dir: path.relative(root, path.dirname(r.path)), at: r.at }));
		const flows = this.context.workspaceState.get<RecentFlow[]>(RECENT_FLOWS, []).slice(0, 7);
		const all = this.endpoints.cached();
		// The endpoints whose files changed most lately first; then the order the backends gave.
		const churn = root ? await this.churnOf(root) : new Map<string, number>();
		const heat = (file: string) => churn.get(pathKey(file)) ?? 0;
		const ranked = interleave(all.filter(e => e.source === 'roslyn'), all.filter(e => e.source === 'poly'))
			.map((e, i) => ({ e, i, heat: heat(e.file) }))
			.sort((a, b) => b.heat - a.heat || a.i - b.i)
			.map(x => x.e);
		const endpoints = ranked.slice(0, 7).map(e => {
			const show = entryDisplay(e, path.relative(root, e.file));
			return { id: e.id, source: e.source, label: entryName(e), http: e.http.split(/\s/)[0], route: show.title.replace(/^\S+\s+/, ''), detail: show.detail };
		});
		this.offered = offeredFiles(files, health?.issues);
		await this.panel?.webview.postMessage({
			type: 'data',
			repo: folder?.name ?? 'No folder open',
			branch: await this.branch(),
			hour: new Date().getHours(),
			files, flows, endpoints, health,
			total: all.length,
		});
	}

	private html() {
		return homeHtml(randomBytes(16).toString('base64'));
	}

	dispose() {
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
	--line: var(--vscode-widget-border, #30323c); --raised: var(--vscode-chat-requestBubbleBackground, #262832);
	--signal: #6f86ff; --plan: #ffb454; --ok: #5fe0a1; --bad: #ff6b7d; --violet: #b88cff; --teal: #4fd6d0; --gold: #ffb454;
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
.more { margin: 4px 0 0; padding: 0; border: 0; background: none; color: var(--accent, #8ab4ff); font: inherit; font-size: 12px; cursor: pointer; }
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
.gaps { margin: 6px 0 2px; color: var(--plan); font-size: 12px; }
.sev { flex: none; width: 6px; height: 6px; border-radius: 50%; transform: translateY(-2px); }
.sev.error { background: var(--bad); } .sev.warning { background: var(--plan); }

.keys { display: flex; flex-wrap: wrap; gap: 8px 22px; margin-top: 52px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
.keys button { all: unset; cursor: pointer; display: inline-flex; gap: 8px; align-items: center; }
.keys button:hover { color: var(--text); }
.keys button:focus-visible, .row:focus-visible, .chip:focus-visible, .send:focus-visible { outline: 1.5px solid var(--signal); outline-offset: 2px; }

@media (max-width: 760px) {
	.cols { grid-template-columns: 1fr; gap: 28px; }
	.col, .col:first-child { padding: 0 4px; border-left: 0; }
}
@media (prefers-reduced-motion: reduce) { .ask { transition: none; } }
</style></head><body><main>
	<div class="where">
		<svg width="22" height="12" viewBox="0 0 240 120" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="10"><rect x="76" y="20" width="152" height="80" rx="22"/><path d="M46 60h48M136 60h32"/></g><path d="M14 36l36 24-36 24z" fill="#ffb454"/><path d="M115 37l23 23-23 23-23-23z" fill="#b88cff"/><circle cx="188" cy="60" r="18" fill="#6f86ff"/></svg>
		<b id="repo">…</b><span id="branch"></span>
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
	$('branch').innerHTML = d.branch ? '<span class="branch">' + esc(d.branch) + '</span>' : '';
	const part = d.hour < 5 ? 'Late night' : d.hour < 12 ? 'Morning' : d.hour < 18 ? 'Afternoon' : 'Evening';
	$('greet').textContent = part + ' in ' + d.repo + '. What should we work on?';
	$('files').innerHTML = d.files.length ? d.files.map(f => '<button class="row" data-path="' + esc(f.path) + '"><span class="name">' + esc(f.name) + '</span><span class="sub">' + esc(f.dir || ago(f.at)) + '</span></button>').join('') : '<p class="empty">Files you open show up here.</p>';
	if (d.flows.length) {
		const f = d.flows[0];
		$('resume').innerHTML = '<button class="resume" id="resumeBtn"><svg width="26" height="14" viewBox="0 0 240 120" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="10"><rect x="76" y="20" width="152" height="80" rx="22"/><path d="M46 60h48M136 60h32"/></g><g fill="currentColor"><path d="M14 40l32 20-32 20z"/><path d="M115 39l21 21-21 21-21-21z"/><circle cx="188" cy="60" r="18"/></g></svg><div><b>' + esc(f.label) + '</b><span>Last flow you opened, ' + esc(ago(f.at)) + ' ago</span></div><span class="go">Open canvas</span></button>';
		$('resumeBtn').onclick = () => vscode.postMessage({ type: 'flow', id: f.id, label: f.label, source: f.source || '' });
		$('flowsTitle').innerHTML = 'Flows you opened';
		$('flows').innerHTML = d.flows.map(f => '<button class="row" data-id="' + esc(f.id) + '" data-source="' + esc(f.source || '') + '" data-label="' + esc(f.label) + '"><svg class="glyph" viewBox="0 0 10 10"><path d="M5 0l5 5-5 5-5-5z" fill="#b88cff"/></svg><span class="name">' + esc(f.label) + '</span><span class="sub">' + esc(ago(f.at)) + '</span></button>').join('');
	} else {
		const total = num(d.total);
		$('flowsTitle').innerHTML = 'Endpoints <span>' + (total || '') + '</span>';
		// The route first, as a developer reads it; the service and handler after it.
		$('flows').innerHTML = (d.endpoints.length ? d.endpoints.map(e => '<button class="row" data-id="' + esc(e.id) + '" data-source="' + esc(e.source) + '" data-label="' + esc(e.label) + '" title="' + esc(e.http + ' ' + e.route + '  ' + e.detail) + '"><span class="verb v-' + esc(e.http) + '">' + esc(e.http) + '</span><span class="name">' + esc(e.route) + '</span><span class="sub">' + esc(e.detail) + '</span></button>').join('') : '<p class="empty">Open a source file and press <kbd data-k="mod+alt+F"></kbd> to draw its flow.</p>')
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
		$('health').innerHTML = '<div class="health"><span class="score ' + cls + '">' + score + '</span><p>' + (num(counts.error) ? num(counts.error) + ' broken, ' : '') + num(counts.warning) + ' to look at<br>' + (num(h.startupTokens) / 1000).toFixed(1) + 'k tokens before your first prompt</p></div>'
			+ (h.issues || []).slice(0, 4).map(i => '<button class="row" data-path="' + esc(i.file) + '" data-line="' + lineOf(i.line) + '"><span class="sev ' + esc(i.severity) + '"></span><span class="name">' + esc(i.message) + '</span></button>').join('')
			+ (gaps.length ? '<p class="gaps" title="' + esc(gaps.map(g => g.message).join(' ')) + '">Not set up here: ' + esc(gaps.map(g => g.label).join(', ')) + '</p>' : '')
			// Which counts are the project's and which come from your own ~/.claude: an empty project is not "1 instruction, 20 skills".
			+ (h.bySource
				? '<p class="empty">This project: ' + list(h.bySource.project) + '<br>Yours (~/.claude): ' + list(h.bySource.user) + '</p>'
				: '<p class="empty">' + list(t) + '</p>');
	} else {
		$('health').innerHTML = '<p class="empty">Open a folder to check its harness.</p>';
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
