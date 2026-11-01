/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the "Why?" view. For one file (the active editor, or one you pick): which
 *  instructions and path-scoped rules an agent working on it reads, which value of each setting
 *  wins and what it overrides, and a permission simulator that says what Claude Code (or Codex)
 *  would do with a tool call, and which rule decided.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { effectiveSettings, instructionsFor, type Effective, type SettingsLayer } from './effective';
import { page } from './page';
import { codexConfig, parseCall, PERMISSION_MODES, resolveMode, simulate, simulateCodex, type ResolvedMode, type Verdict } from './permmatch';
import type { Harness, HarnessItem } from './scan';
import type { Live } from './live';
import { claudeDir, codexDir } from './dirs';

/** Where an organization's managed settings live, by platform (Claude Code's documented locations). */
export function managedSettingsFile(): string {
	return process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
		: process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
			: '/etc/claude-code/managed-settings.json';
}

/** Every settings file Claude Code reads for this project, parsed; a missing file has no data, a broken one an error. */
export async function loadLayers(root: string): Promise<SettingsLayer[]> {
	const files: [SettingsLayer['scope'], string][] = [
		['managed', managedSettingsFile()],
		['local', path.join(root, '.claude', 'settings.local.json')],
		['project', path.join(root, '.claude', 'settings.json')],
		['user', path.join(claudeDir(), 'settings.json')],
	];
	return Promise.all(files.map(async ([scope, file]) => {
		const text = await fs.readFile(file, 'utf8').catch(() => undefined);
		if (text === undefined) {
			return { scope, file };
		}
		try {
			const data = JSON.parse(text) as unknown;
			return data && typeof data === 'object' && !Array.isArray(data) ? { scope, file, data: data as Record<string, unknown> } : { scope, file, error: 'not a JSON object' };
		} catch (e) {
			return { scope, file, error: (e as Error).message };
		}
	}));
}

const MAX_CALL = 4000;

export class WhyView implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	/** The file on show; undefined follows the active editor. */
	private picked: string | undefined;
	private current: string | undefined;
	/** What the page may open, by index: it never names a path itself. */
	private openable: string[] = [];
	/** The mode chosen on the page for the simulator: per page, never saved, gone when the page closes. */
	private modeOverride: string | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly harness: () => Harness | undefined, private readonly live?: Live) {
		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(ed => {
			if (this.panel && !this.picked && ed?.document.uri.scheme === 'file') {
				void this.render(ed.document.uri.fsPath);
			}
		}));
	}

	async show(arg?: unknown) {
		const uri = arg instanceof vscode.Uri ? arg : undefined;
		this.picked = uri?.fsPath;
		const file = this.picked ?? vscode.window.activeTextEditor?.document.uri.fsPath ?? this.current;
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel('flowHarness.why', 'Why?', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: false, localResourceRoots: [] });
			this.panel.webview.html = this.html();
			this.panel.onDidDispose(() => {
				this.panel = undefined;
				this.modeOverride = undefined;
			}, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => void this.message(m), null, this.disposables);
		} else {
			this.panel.reveal(undefined, true);
		}
		this.current = file;
		await this.render(file);
	}

	private async message(m: { type?: unknown; text?: unknown; agent?: unknown; index?: unknown; mode?: unknown }) {
		if (m.type === 'ready') {
			await this.render(this.current);
		} else if (m.type === 'mode') {
			// Only a known mode is kept; anything else (or an empty value) goes back to the detected one.
			this.modeOverride = typeof m.mode === 'string' && (PERMISSION_MODES as readonly string[]).includes(m.mode) ? m.mode : undefined;
			await this.render(this.current);
		} else if (m.type === 'pick') {
			const picked = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: this.harness() && vscode.Uri.file(this.harness()!.root), title: 'Why? for which file' });
			if (picked?.[0]) {
				this.picked = picked[0].fsPath;
				await this.render(this.picked);
			}
		} else if (m.type === 'follow') {
			this.picked = undefined;
			await this.render(vscode.window.activeTextEditor?.document.uri.fsPath ?? this.current);
		} else if (m.type === 'open' && Number.isInteger(m.index) && typeof m.index === 'number' && this.openable[m.index]) {
			await vscode.window.showTextDocument(vscode.Uri.file(this.openable[m.index]), { preview: true, viewColumn: vscode.ViewColumn.One });
		} else if (m.type === 'simulate' && typeof m.text === 'string' && (m.agent === 'Claude' || m.agent === 'Codex')) {
			void this.panel?.webview.postMessage({ type: 'verdict', text: m.text, agent: m.agent, verdict: await this.simulate(m.text.slice(0, MAX_CALL), m.agent) });
		}
	}

	/** The simulator, also behind `flowHarness.simulatePermission` for scripts and the MCP side. */
	async simulate(text: string, agent: 'Claude' | 'Codex' = 'Claude'): Promise<(Verdict & { modeInfo?: ResolvedMode }) | { error: string }> {
		const h = this.harness();
		const call = parseCall(text);
		if (!h || !call) {
			return { error: h ? 'Write a tool call such as Bash(git push --force), Edit(src/x.ts) or WebFetch(https://example.com)' : 'Open a folder first' };
		}
		const ctx = { cwd: h.root, home: os.homedir() };
		if (agent === 'Codex') {
			const toml = await fs.readFile(path.join(codexDir(), 'config.toml'), 'utf8').catch(() => '');
			return simulateCodex(call, codexConfig(toml), ctx);
		}
		const eff = effectiveSettings(await loadLayers(h.root));
		const mode = this.mode(eff);
		const v = simulate(call, eff.rules, { ...ctx, mode: mode.mode, additionalDirs: eff.additionalDirs.map(d => path.resolve(h.root, d)) });
		return { ...v, modeInfo: mode };
	}

	/**
	 * The permission mode to simulate in (see resolveMode): the one chosen on this page, else the one the newest Claude Code
	 * session's hooks reported, else defaultMode as the settings apply it, else Claude Code's built-in default.
	 */
	private mode(eff: Effective): ResolvedMode {
		const s = [...this.live?.sessions.values() ?? []].filter(x => x.cli === 'claude' && x.mode).sort((a, b) => b.at - a.at)[0];
		return resolveMode(s?.mode, eff.mode, this.modeOverride, eff.modeNote);
	}

	private async render(file: string | undefined) {
		const h = this.harness();
		if (!this.panel || !h) {
			return;
		}
		this.current = file;
		this.openable = [];
		const open = (f: string) => this.openable.push(f) - 1;
		const target = file ?? h.root;
		const applied = instructionsFor(target, h.root, h.items.filter(i => i.kind === 'instructions' || i.kind === 'rules'));
		const layers = await loadLayers(h.root);
		const eff = effectiveSettings(layers);
		const show = (f: string) => f.startsWith(h.root + path.sep) ? path.relative(h.root, f) : f.replace(os.homedir(), '~');
		const agents = [...new Set(applied.map(a => a.agent))];
		this.panel.title = file ? `Why? ${path.basename(file)}` : 'Why?';
		void this.panel.webview.postMessage({
			type: 'data',
			file: file ? show(file) : undefined,
			following: !this.picked,
			agents: agents.map(agent => ({
				agent,
				items: applied.filter(a => a.agent === agent).map(a => ({ label: (a.item as HarnessItem).label, kind: a.item.kind, scope: a.item.scope, when: a.when, why: a.why, tokens: a.item.tokens, open: open(a.item.file) })),
			})),
			layers: layers.map(l => ({ scope: l.scope, file: show(l.file), exists: !!l.data || !!l.error, error: l.error, open: l.data || l.error ? open(l.file) : -1 })),
			scalars: eff.scalars.map(s => ({ key: s.key, value: JSON.stringify(s.value), scope: s.scope, overridden: s.overridden.map(o => ({ scope: o.scope, value: JSON.stringify(o.value) })) })),
			env: eff.env.map(e => ({ key: e.key, scope: e.scope })),
			rules: { allow: eff.rules.filter(r => r.effect === 'allow').length, ask: eff.rules.filter(r => r.effect === 'ask').length, deny: eff.rules.filter(r => r.effect === 'deny').length },
			mode: this.mode(eff),
		});
	}

	private html() {
		return page('Why?', /* html */ `
<div class="row head"><div class="grow"><h1 id="title">Why?</h1><p class="sub" id="sub">What an agent working on this file reads, and what it may do.</p></div>
<button id="follow" title="Follow the active editor">Active editor</button><button id="pick">Pick a file…</button></div>
<h2>Instructions and rules, in the order they stack</h2><div id="instr"></div>
<p class="muted">Instruction files never override each other: the agent reads all of them, the more specific later, and a later line wins where two disagree.</p>
<h2>Permission simulator</h2>
<div class="card"><div class="row modeline"><p class="grow" id="modeline"><b>Permission mode</b></p>
<label class="muted" for="mode">Try another mode</label><select id="mode"></select></div>
<div class="row"><select id="agent" aria-label="Which agent"><option>Claude</option><option>Codex</option></select>
<input id="call" class="grow mono" aria-label="Tool call to check" placeholder="Bash(git push --force) · Edit(src/x.ts) · WebFetch(https://github.com) · mcp__github__create_issue" spellcheck="false">
<button class="primary" id="go">Check</button></div><div id="verdict"></div><div id="status" class="sr-only" role="status" aria-live="polite"></div></div>
<h2>Settings: which value wins</h2><p class="muted">Managed settings win, then local, then project, then user. Permission lists merge across files, and a deny from any of them wins.</p>
<div id="layers"></div><div id="scalars"></div>`, /* js */ `
const $ = id => document.getElementById(id);
const scopeTag = s => el('span', { class: 'tag' }, s);
let last;
function render(d) {
	last = d;
	$('title').textContent = d.file ? 'Why? ' + d.file : 'Why? (project root)';
	$('sub').textContent = d.following ? 'Following the active editor.' : 'A file you picked.';
	$('follow').disabled = d.following;
	const instr = $('instr'); instr.replaceChildren();
	if (!d.agents.length) instr.append(el('p', { class: 'muted' }, 'No instructions or rules apply here.'));
	for (const a of d.agents) {
		instr.append(el('h3', {}, a.agent));
		a.items.forEach((i, n) => instr.append(el('div', { class: 'card row' },
			el('span', { class: 'muted mono' }, String(n + 1)),
			el('div', { class: 'grow' }, el('button', { class: 'link', type: 'button', onclick: () => vscode.postMessage({ type: 'open', index: i.open }) }, i.label), ' ', scopeTag(i.scope), ' ',
				el('span', { class: 'tag' + (i.when === 'not-loaded' ? ' deny' : '') }, i.when === 'always' ? 'every session' : i.when === 'on-demand' ? 'when working here' : 'not loaded'),
				el('div', { class: 'muted' }, i.why)),
			i.tokens ? el('span', { class: 'tag est', title: 'Estimated from the file size (about 4 characters per token)' }, '~' + fmt(i.tokens) + ' tok') : null)));
	}
	const layers = $('layers'); layers.replaceChildren(el('table', {}, el('tr', {}, el('th', {}, 'Scope'), el('th', {}, 'File'), el('th', {}, '')),
		d.layers.map(l => el('tr', {}, el('td', {}, l.scope), el('td', { class: 'mono' }, l.open >= 0 ? el('button', { class: 'link', type: 'button', onclick: () => vscode.postMessage({ type: 'open', index: l.open }) }, l.file) : l.file),
			el('td', { class: l.error ? 'deny' : 'muted' }, l.error ? 'Broken JSON, ignored: ' + l.error : l.exists ? '' : (l.scope === 'managed' ? 'none (checked)' : 'not present'))))));
	const sc = $('scalars'); sc.replaceChildren();
	// The mode the simulator assumes, above the call box where it changes the answer; the select shows an override only while one is set.
	$('modeline').replaceChildren(el('b', {}, d.mode.text));
	$('mode').value = d.mode.source === 'override' ? d.mode.mode : '';
	sc.append(el('p', {}, 'Permission mode: ', el('b', {}, d.mode.mode), el('span', { class: 'muted' }, ' (' + d.mode.text + ')'), ' · rules: ', el('span', { class: 'allow' }, d.rules.allow + ' allow'), ', ', el('span', { class: 'ask' }, d.rules.ask + ' ask'), ', ', el('span', { class: 'deny' }, d.rules.deny + ' deny')));
	if (d.scalars.length) sc.append(el('table', {}, el('tr', {}, el('th', {}, 'Setting'), el('th', {}, 'Value'), el('th', {}, 'From'), el('th', {}, 'Overrides')),
		d.scalars.map(s => el('tr', {}, el('td', { class: 'mono' }, s.key), el('td', { class: 'mono' }, s.value), el('td', {}, s.scope),
			el('td', {}, s.overridden.map(o => el('div', {}, el('s', { class: 'mono' }, o.value), ' ', el('span', { class: 'muted' }, o.scope))))))));
	if (d.env.length) sc.append(el('p', { class: 'muted' }, 'Environment: ' + d.env.map(e => e.key + ' (' + e.scope + ')').join(', ')));
}
function verdict(v) {
	const box = $('verdict'); box.replaceChildren();
	const say = t => { $('status').textContent = t; };
	if (v.error) { box.append(el('p', { class: 'muted' }, v.error)); say(v.error); return; }
	// A verdict from a guessed mode says so; one from a mode a session reported does not need to.
	const withMode = v.modeInfo ? ' with mode ' + v.modeInfo.mode + (v.modeInfo.assumed ? ' (assumed)' : ' (reported by a session)') : '';
	box.append(el('p', {}, el('b', { class: v.decision }, v.decision.toUpperCase()), el('span', { class: 'muted' }, withMode), '  ', v.reason));
	say(v.decision + withMode + ': ' + v.reason);
	if (v.rule) box.append(el('p', { class: 'muted' }, 'Deciding rule: ', el('span', { class: 'mono' }, v.rule.pattern), ' (' + v.rule.scope + ' settings)'));
	if (v.parts && v.parts.length > 1) box.append(el('table', {}, v.parts.map(p => el('tr', {}, el('td', { class: 'mono' }, p.command), el('td', { class: p.decision === 'none' ? 'ask' : p.decision }, p.decision === 'none' ? 'not covered' : p.decision + (p.rule ? ' by ' + p.rule.pattern : ''))))));
	for (const n of v.notes) box.append(el('p', { class: 'muted' }, '• ' + n));
}
const check = () => { const text = $('call').value.trim(); if (text) vscode.postMessage({ type: 'simulate', text, agent: $('agent').value }); };
$('go').onclick = check;
$('call').addEventListener('keydown', e => { if (e.key === 'Enter') check(); });
$('agent').onchange = () => { $('mode').disabled = $('agent').value === 'Codex'; check(); };
// The same list the extension checks the choice against; '' goes back to the detected mode.
$('mode').append(el('option', { value: '' }, 'As detected'), ...${JSON.stringify(PERMISSION_MODES)}.map(m => el('option', { value: m }, m)));
// The extension keeps the choice and re-renders; asking again re-runs the simulation in the new mode.
$('mode').onchange = () => { vscode.postMessage({ type: 'mode', mode: $('mode').value }); check(); };
$('pick').onclick = () => vscode.postMessage({ type: 'pick' });
$('follow').onclick = () => vscode.postMessage({ type: 'follow' });
window.addEventListener('message', e => { const m = e.data; if (m.type === 'data') render(m); else if (m.type === 'verdict' && m.text === $('call').value.trim()) verdict(m.verdict); });
vscode.postMessage({ type: 'ready' });
`, 'h3 { font-size: 13px; margin: 12px 0 4px; } .head { flex-wrap: wrap; } .card > .row { flex-wrap: wrap; } #call { min-width: 160px; } .head .grow { min-width: 220px; } h1 { overflow-wrap: anywhere; } .modeline { flex-wrap: wrap; margin-bottom: 6px; } #modeline { margin: 0; } .card > .row + .row { margin-top: 6px; }');
	}

	dispose() {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}
