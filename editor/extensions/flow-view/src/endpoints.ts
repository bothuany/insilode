/*---------------------------------------------------------------------------------------------
 *  Insilode: the endpoints of the solution, controller by controller. Each row leads with its HTTP
 *  verb in the verb's own colour, so a list of a hundred routes reads at a glance; a filter at
 *  the top narrows by name, verb or controller. Opening one draws its flow.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Command } from './commands';
import { entryName, type Endpoints, type Entry } from './backends';
import { excludePatterns, workspaceRoots } from './excludeSetting';
import { repoResolver, sections, startsCollapsed } from './grouping';
import { excludablePattern, withPattern } from './poly/userExclude';

export class EndpointsView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private list: Entry[];
	private current: string | undefined;
	/** The solution line: asking for the solutions walks the workspace, so it is asked again only when the list changes. */
	private solution: ReturnType<Endpoints['solutionInfo']> | undefined;

	private readonly subscription: vscode.Disposable;

	constructor(private readonly endpoints: Endpoints) {
		this.list = endpoints.cached();
		this.subscription = endpoints.onDidChange(() => void this.refresh());
	}

	dispose() {
		this.subscription.dispose();
	}

	/** The flow on the canvas; its row stays marked. */
	setCurrent(id: string) {
		this.current = id;
		void this.post();
	}

	async refresh() {
		this.list = this.endpoints.cached();
		this.solution = undefined;
		await this.post();
	}

	resolveWebviewView(view: vscode.WebviewView) {
		this.view = view;
		view.webview.options = { enableScripts: true };
		view.webview.html = this.html();
		view.webview.onDidReceiveMessage(m => {
			if (m.type === 'ready') {
				void this.post();
			} else if (m.type === 'open') {
				this.current = m.id;
				void vscode.commands.executeCommand(Command.showEntry, m.id, m.label, m.source);
			} else if (m.type === 'pick') {
				void vscode.commands.executeCommand('flow.pickSolution');
			} else if (m.type === 'manage') {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'flow.exclude');
			} else if (m.type === 'exclude' && typeof m.dir === 'string') {
				void this.exclude(m.dir);
			}
		});
		view.onDidChangeVisibility(() => view.visible && void this.post());
	}

	/** Adds a folder to `flow.exclude` in the workspace settings: only one inside a workspace folder, whatever the webview says. */
	private async exclude(dir: string) {
		const pattern = excludablePattern(dir, workspaceRoots());
		if (!pattern) {
			return;
		}
		const next = withPattern(vscode.workspace.getConfiguration('flow').inspect<string[]>('exclude')?.workspaceValue ?? [], pattern);
		if (next) {
			await vscode.workspace.getConfiguration('flow').update('exclude', next, vscode.ConfigurationTarget.Workspace)
				.then(undefined, (e: Error) => void vscode.window.showWarningMessage(`Insilode could not exclude ${pattern}: ${e.message}`));
		}
	}

	private async post() {
		const repos = sections(this.list, repoResolver(workspaceRoots()), e => entryName({ controller: e.controller, action: '' } as Entry).replace(/\.$/, ''), f => vscode.workspace.asRelativePath(f));
		const info = await (this.solution ??= this.endpoints.solutionInfo()).catch(() => undefined);
		await this.view?.webview.postMessage({
			type: 'data',
			current: this.current,
			repos,
			collapse: startsCollapsed(repos),
			langs: [...new Set(repos.flatMap(r => r.langs))].sort(),
			excluded: excludePatterns().length,
			solution: info && { name: path.basename(info.file), rel: vscode.workspace.asRelativePath(info.file), total: info.total },
		});
	}

	private html() {
		const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
		return /* html */ `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root {
	--text: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-widget-border, #30323c);
	--hover: var(--vscode-list-hoverBackground); --sel: var(--vscode-list-inactiveSelectionBackground);
	--mono: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
	--get: #5fe0a1; --post: #ffb454; --put: #6f86ff; --patch: #b88cff; --delete: #ff6b7d; --other: #9aa4bf;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 0 8px 16px 6px; color: var(--text); font: 13px/1.4 var(--vscode-font-family, -apple-system, system-ui); background: transparent; }
.filter { position: sticky; top: 0; z-index: 1; padding: 6px 0 8px 2px; background: var(--vscode-sideBar-background); }
.filter input { width: 100%; height: 26px; padding: 0 10px; border-radius: 7px; border: 1px solid var(--vscode-input-border, var(--line)); background: var(--vscode-input-background); color: var(--text); font: inherit; outline: none; }
.filter input:focus { border-color: color-mix(in srgb, #6f86ff 60%, transparent); }
.filter input::placeholder { color: var(--muted); }
.count { margin: 6px 2px 0; color: var(--muted); font-size: 11.5px; }

.group > summary, .repo > summary { list-style: none; display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 6px 0 2px; border-radius: 6px; cursor: pointer; user-select: none; }
.group > summary::-webkit-details-marker, .repo > summary::-webkit-details-marker { display: none; }
.group > summary:hover, .repo > summary:hover { background: var(--hover); }
.chev { width: 14px; height: 14px; flex: none; color: var(--muted); transition: transform .12s; }
.group[open] > summary .chev, .repo[open] > summary .chev { transform: rotate(90deg); }
.group > summary .name, .repo > summary .name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.group > summary .n, .repo > summary .n { flex: none; }
.group > summary .n, .repo > summary .n { margin-left: auto; color: var(--muted); font-size: 11.5px; font-variant-numeric: tabular-nums; }

.row { display: flex; align-items: center; gap: 0; width: 100%; height: 24px; padding: 0 6px 0 22px; border: 0; border-radius: 6px; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.row:hover { background: var(--hover); }
.row.current { background: var(--sel); }
.row:focus-visible, .group > summary:focus-visible, .repo > summary:focus-visible, .chip:focus-visible, .exclude:focus-visible { outline: 1.5px solid #6f86ff; outline-offset: -1.5px; }
/* The verb leads, in a fixed column, so actions line up whatever their verb. */
.verb { flex: none; width: 50px; font: 600 10.5px var(--mono); letter-spacing: .02em; }
.verb.GET { color: var(--get); } .verb.POST { color: var(--post); } .verb.PUT { color: var(--put); } .verb.PATCH { color: var(--patch); } .verb.DELETE { color: var(--delete); } .verb.other { color: var(--other); }
.action { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/* A repository header is the outer level: its controllers and rows sit one step further in. */
.repo > summary .name { font-weight: 700; flex: 0 1 auto; }
.repo > summary .langs { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 11px; }
.repo .group > summary { padding-left: 14px; }
.repo .row { padding-left: 36px; }
.exclude { flex: none; height: 18px; padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; background: transparent; color: var(--muted); font: inherit; font-size: 11px; cursor: pointer; opacity: 0; }
.repo > summary:hover .exclude, .exclude:focus-visible { opacity: 1; }
.exclude:hover { color: var(--text); background: var(--hover); }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.bar input { flex: 1 1 120px; width: auto; min-width: 0; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { height: 22px; padding: 0 8px; border: 1px solid var(--line); border-radius: 11px; background: transparent; color: var(--muted); font: inherit; font-size: 11px; cursor: pointer; }
.chip[aria-pressed="true"] { color: var(--text); border-color: color-mix(in srgb, #6f86ff 60%, transparent); background: color-mix(in srgb, #6f86ff 18%, transparent); }
.notes p { margin: 4px 2px 0; color: var(--muted); font-size: 11.5px; }
.notes b { color: var(--text); font-weight: 600; }
.notes button { all: unset; color: var(--vscode-textLink-foreground); cursor: pointer; }
.empty { margin: 12px 4px; color: var(--muted); line-height: 1.5; }
.empty button { all: unset; color: var(--vscode-textLink-foreground); cursor: pointer; }
mark { background: color-mix(in srgb, #ffb454 30%, transparent); color: inherit; border-radius: 2px; }
@media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
</style></head><body>
<div class="filter"><div class="bar"><input id="q" placeholder="Filter by name, verb or controller" aria-label="Filter endpoints"><div class="chips" id="chips"></div></div><p class="count" id="count"></p></div>
<div class="notes" id="notes"></div>
<div id="list"></div>
<script>
const vscode = acquireVsCodeApi();
const state = vscode.getState() || { open: {} };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const VERBS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
let data = { repos: [], langs: [] };
state.langs = state.langs || {};
const hl = (text, q) => { if (!q) return esc(text); const i = text.toLowerCase().indexOf(q); return i < 0 ? esc(text) : esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length)); };
const CHEV = '<svg class="chev" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function render() {
	const q = document.getElementById('q').value.trim().toLowerCase();
	const verbOnly = VERBS.find(v => v.toLowerCase() === q);
	const picked = data.langs.filter(l => state.langs[l]);
	const multi = data.repos.length > 1;
	let shown = 0, total = 0;
	const html = data.repos.map(r => {
		const before = shown;
		const groups = r.groups.map(g => {
			total += g.items.length;
			const items = g.items.filter(e => (!picked.length || picked.includes(e.lang)) && (!q || (verbOnly ? e.verb === verbOnly : (e.action + ' ' + g.name + ' ' + e.route).toLowerCase().includes(q))));
			if (!items.length) return '';
			shown += items.length;
			const key = r.dir + '|' + g.name;
			const open = q || state.open[key] || items.some(e => e.id === data.current);
			return '<details class="group"' + (open ? ' open' : '') + ' data-name="' + esc(key) + '"><summary title="' + esc(g.name) + '">' + CHEV + '<span class="name">' + hl(g.name, verbOnly ? '' : q) + '</span><span class="n">' + items.length + '</span></summary>'
				+ items.map(e => '<button class="row' + (e.id === data.current ? ' current' : '') + '" data-id="' + esc(e.id) + '" data-source="' + esc(e.source) + '" data-label="' + esc(g.name + '.' + e.action) + '" title="' + esc(e.verb + ' ' + (e.route || '') + '\\n' + e.file + ':' + e.line) + '"><span class="verb ' + (VERBS.includes(e.verb) ? e.verb : 'other') + '">' + esc(e.verb) + '</span><span class="action">' + hl(e.action, verbOnly ? '' : q) + '</span></button>').join('')
				+ '</details>';
		}).join('');
		if (!multi || !groups) return groups;
		const open = q || (state.open[r.dir] ?? !data.collapse) || r.groups.some(g => g.items.some(e => e.id === data.current));
		const langs = [...new Set(r.groups.flatMap(g => g.items.map(e => e.lang)))].sort().join(' · ');
		return '<details class="repo"' + (open ? ' open' : '') + ' data-name="' + esc(r.dir) + '"><summary title="' + esc(r.rel || r.dir) + '">' + CHEV + '<span class="name">' + esc(r.name) + '</span><span class="langs">' + esc(langs) + '</span><span class="n">' + (shown - before) + '</span>'
			+ '<button class="exclude" data-dir="' + esc(r.dir) + '" title="Exclude this folder from flows" aria-label="Exclude ' + esc(r.name) + ' from flows">Exclude</button></summary>' + groups + '</details>';
	}).join('');
	document.getElementById('list').innerHTML = html || (total ? '<p class="empty">No endpoint matches.</p>' : '<p class="empty">No endpoints found yet. Insilode lists routes from Spring, JAX-RS, ASP.NET, FastAPI, Flask, Django, Express, NestJS and more. For a .NET project you can <button data-act="pick">choose a solution</button>.</p>');
	document.getElementById('count').textContent = total ? (q || picked.length ? shown + ' of ' + total : total + ' endpoints') : '';
	document.getElementById('chips').innerHTML = data.langs.length > 1 ? data.langs.map(l => '<button class="chip" aria-pressed="' + !!state.langs[l] + '" data-lang="' + esc(l) + '">' + esc(l) + '</button>').join('') : '';
	const notes = [];
	if (data.solution) notes.push('<p>Solution <b title="' + esc(data.solution.rel) + '">' + esc(data.solution.name) + '</b>' + (data.solution.total > 1 ? ' (1 of ' + data.solution.total + ' solutions loaded)' : '') + ' · <button data-act="pick">Switch</button></p>');
	if (data.excluded) notes.push('<p>' + data.excluded + (data.excluded === 1 ? ' folder' : ' folders') + ' excluded · <button data-act="manage">Manage</button></p>');
	document.getElementById('notes').innerHTML = notes.join('');
	document.querySelectorAll('details.group, details.repo').forEach(d => d.addEventListener('toggle', () => { if (!q) { state.open[d.dataset.name] = d.open; vscode.setState(state); } }));
	document.querySelectorAll('.row').forEach(b => b.onclick = () => { data.current = b.dataset.id; vscode.postMessage({ type: 'open', id: b.dataset.id, label: b.dataset.label, source: b.dataset.source }); render(); });
	document.querySelectorAll('.exclude').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); vscode.postMessage({ type: 'exclude', dir: b.dataset.dir }); });
	document.querySelectorAll('.chip').forEach(b => b.onclick = () => { state.langs[b.dataset.lang] = !state.langs[b.dataset.lang]; vscode.setState(state); render(); });
	document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => vscode.postMessage({ type: b.dataset.act }));
}
document.getElementById('q').addEventListener('input', render);
window.addEventListener('message', e => { if (e.data.type === 'data') { data = e.data; render(); } });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
	}
}
