/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the context X-ray. What fills a running session's context window, from its
 *  transcript (measured usage, Claude Code's own /context estimate when it was run, Insilode's
 *  estimates otherwise), and what looks like waste, each with a fix that never changes your
 *  configuration without showing the change and asking first.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { itemKey } from './activity';
import type { Live } from './live';
import { page, SEGMENT_COLORS } from './page';
import type { Harness } from './scan';
import { arrayAt, previewAndWrite } from './settings';
import { isTranscriptPath } from './transcript';
import { xray, type XrayModel } from './xraymodel';
import { claudeDir, projectTranscriptDir } from './dirs';

/** What flow-agent's dock sends for one agent: never a command, only what it knows about the session. */
export interface XraySession {
	/** flow-agent's id for the session: Compact and Measure go through it (flow.agents.slash), never through a terminal name. */
	id?: string;
	agent: string;
	cli: string;
	transcript?: string;
	usage?: { used: number; size: number };
}

function sessionOf(raw: unknown): XraySession | undefined {
	const r = raw as Record<string, unknown> | undefined;
	if (!r || typeof r !== 'object' || typeof r.agent !== 'string') {
		return undefined;
	}
	const u = r.usage as { used?: unknown; size?: unknown } | undefined;
	return {
		id: typeof r.id === 'string' ? r.id.slice(0, 200) : undefined,
		agent: r.agent.slice(0, 200),
		cli: typeof r.cli === 'string' ? r.cli : 'claude',
		// Only a Claude Code transcript is read: a .jsonl inside ~/.claude/projects, `..` resolved.
		transcript: isTranscriptPath(r.transcript, claudeDir()) ? r.transcript : undefined,
		usage: u && typeof u.used === 'number' && typeof u.size === 'number' ? { used: u.used, size: u.size } : undefined,
	};
}

export class XrayView implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private session: XraySession | undefined;
	private model: XrayModel | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly harness: () => Harness | undefined, private readonly live: Live) { }

	/** Opens the X-ray for `arg` (from the dock), or asks which session. */
	async show(arg?: unknown) {
		let s = sessionOf(arg);
		if (!s) {
			s = await this.pick();
			if (!s) {
				return;
			}
		}
		this.session = s;
		if (!this.panel) {
			this.panel = vscode.window.createWebviewPanel('flowHarness.xray', 'Context X-ray', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, localResourceRoots: [] });
			this.panel.webview.html = this.html();
			this.panel.onDidDispose(() => this.panel = undefined, null, this.disposables);
			this.panel.webview.onDidReceiveMessage(m => void this.message(m), null, this.disposables);
		} else {
			this.panel.reveal();
		}
		await this.render();
	}

	/** The running agents Insilode knows, the newest Claude Code session of this folder, or the harness alone. */
	private async pick(): Promise<XraySession | undefined> {
		const h = this.harness();
		const picks: (vscode.QuickPickItem & { s: XraySession })[] = [...this.live.sessions.values()]
			.sort((a, b) => b.at - a.at)
			.map(x => ({ label: x.agent, description: x.cli, detail: x.transcript ? 'Running session' : 'No transcript (estimates only)', s: { id: x.id, agent: x.agent, cli: x.cli, transcript: x.transcript } }));
		if (h) {
			const dir = projectTranscriptDir(h.root);
			const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.jsonl'));
			const newest = (await Promise.all(names.map(async n => ({ file: path.join(dir, n), mtime: (await fs.stat(path.join(dir, n)).catch(() => undefined))?.mtimeMs ?? 0 }))))
				.sort((a, b) => b.mtime - a.mtime)[0];
			if (newest && !picks.some(p => p.s.transcript === newest.file)) {
				picks.push({ label: 'Latest Claude Code session in this folder', description: new Date(newest.mtime).toLocaleString(), detail: path.basename(newest.file), s: { agent: 'Latest session', cli: 'claude', transcript: newest.file } });
			}
			picks.push({ label: 'The harness alone', detail: 'What this project loads before the first prompt (estimates)', s: { agent: 'Harness', cli: 'claude' } });
		}
		if (picks.length === 1) {
			return picks[0].s;
		}
		return (await vscode.window.showQuickPick(picks, { title: 'Context X-ray: which session?' }))?.s;
	}

	private async render() {
		const h = this.harness();
		const s = this.session;
		if (!this.panel || !s) {
			return;
		}
		const facts = s.transcript ? await this.live.facts(s.transcript) : undefined;
		this.model = xray({
			agent: s.agent, cli: s.cli, facts, reported: s.usage, items: h?.items ?? [],
			usesOf: i => this.live.summary(itemKey(i)).month, covered: this.live.covered, sessions: this.live.sessionsSeen,
		});
		this.panel.title = `Context X-ray: ${s.agent}`;
		const can = { measure: await this.slash('context', true) === 'sent', compact: await this.slash('compact', true) === 'sent' };
		void this.panel.webview.postMessage({
			type: 'data', model: this.model, can,
			transcript: s.transcript ? path.basename(s.transcript) : undefined,
		});
	}

	/**
	 * Asks flow-agent to type a slash command into this session, or with `check` whether it would now. flow-agent owns the
	 * session's terminal and its state: it types only while the agent sits at its prompt, so the Enter never answers a
	 * permission prompt. A session it does not know (the latest transcript, the harness alone) gets nothing typed.
	 */
	private async slash(kind: 'compact' | 'context', check: boolean): Promise<string> {
		const id = this.session?.id;
		if (!id) {
			return 'unknown';
		}
		const r = await Promise.resolve(vscode.commands.executeCommand<string>('flow.agents.slash', id, kind, check)).catch(() => undefined);
		return typeof r === 'string' ? r : 'unknown';
	}

	private async message(m: { type?: unknown; id?: unknown }) {
		if (m.type === 'ready' || m.type === 'refresh') {
			await this.render();
			return;
		}
		// By id, not position: a refresh between render and click must not turn the click into another action.
		const w = m.type === 'act' && typeof m.id === 'string' ? this.model?.waste.find(x => x.id === m.id) : undefined;
		const a = w?.action;
		const h = this.harness();
		if (!a) {
			return;
		}
		if (a.kind === 'open') {
			await vscode.window.showTextDocument(vscode.Uri.file(a.file), { preview: true });
		} else if (a.kind === 'disable-mcp' && h) {
			// .mcp.json is shared; switching one of its servers off for yourself belongs in your local settings, shown as a diff first.
			const file = path.join(h.root, '.claude', 'settings.local.json');
			const written = await previewAndWrite(file, `Disable the ${a.server} MCP server in this project for you`, (st: object) => {
				const list = arrayAt<unknown>(st, 'disabledMcpjsonServers');
				if (!list.includes(a.server)) {
					list.push(a.server);
				}
			});
			if (written) {
				void vscode.window.showInformationMessage(`${a.server} is off for your next sessions here. A running session keeps it until it restarts.`);
			}
		} else if (a.kind === 'measure' || a.kind === 'compact') {
			await this.send(a.kind === 'measure' ? 'context' : 'compact');
		}
	}

	/** Types /context or /compact into the agent's terminal, only on a click, without taking focus from the X-ray. */
	private async send(kind: 'compact' | 'context') {
		const command = `/${kind}`;
		const r = await this.slash(kind, false);
		if (r === 'sent') {
			if (kind === 'context') {
				// Claude Code writes the report into the transcript as it prints it.
				setTimeout(() => void this.render(), 2500);
			}
			return;
		}
		const name = this.session?.agent ?? 'The agent';
		const why: Record<string, string> = {
			waiting: `${name} is waiting for your answer in its terminal: answer it, then try again (Enter there would approve it).`,
			busy: `${name} is working: try again when it is back at its prompt.`,
			'not-ready': `${name} has not said it is at its prompt yet.`,
			unsupported: `${name} does not take ${command}.`,
		};
		void vscode.window.showInformationMessage(why[r] ?? `Run ${command} in the session yourself; Insilode has no terminal for it.`);
		void this.render();
	}

	private html() {
		return page('Context X-ray', /* html */ `
<div class="row"><div class="grow"><h1 id="title">Context X-ray</h1><p class="sub" id="sub"></p></div><button id="refresh">Refresh</button></div>
<div id="total"></div><div class="bar" id="bar" aria-hidden="true"></div><div id="segments"></div>
<h2>Looks like waste</h2><div id="waste"></div>
<p class="muted" id="legend"><span class="tag measured">measured</span> the API's own token count · <span class="tag">Claude Code's estimate</span> from /context · <span class="tag est">estimate</span> Insilode's, about 4 characters per token · <span class="tag est">derived</span> a measured total minus estimates</p>`, /* js */ `
const $ = id => document.getElementById(id);
// Segment colours per theme: the pale set is under 3:1 on a white page, so a light theme gets a darker one (SEGMENT_COLORS, measured in test/page.test.mjs).
const COLORS = ${JSON.stringify(SEGMENT_COLORS)}[document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark'];
const HOW = { measured: ['measured', 'tag measured'], 'claude-estimate': ["Claude Code's estimate", 'tag'], estimate: ['estimate', 'tag est'], derived: ['derived', 'tag est'] };
const howTag = h => h ? el('span', { class: HOW[h][1] }, HOW[h][0]) : null;
function render(d) {
	const m = d.model;
	$('title').textContent = 'Context X-ray: ' + m.agent;
	$('sub').textContent = m.source === 'context' ? 'Breakdown from the /context report' + (m.contextAt ? ' of ' + new Date(m.contextAt).toLocaleString() : '') + '.'
		: m.source === 'baseline' ? 'Breakdown from the transcript' + (d.transcript ? ' (' + d.transcript + ')' : '') + '. Run /context in the session for Claude Code\\'s own numbers.'
		: 'No transcript: what the harness loads, estimated from its files.';
	const total = $('total'); total.replaceChildren();
	if (m.used !== undefined) total.append(el('p', {}, el('b', {}, fmt(m.used) + ' of ' + fmt(m.size) + ' tokens in use'), ' (' + Math.round(m.used / m.size * 100) + '%) ', howTag(m.usedHow), m.compactions ? el('span', { class: 'muted' }, ' · compacted ' + (m.partial ? 'at least ' : '') + m.compactions + '×') : null));
	const bar = $('bar'); bar.replaceChildren();
	const whole = Math.max(m.size, m.segments.reduce((a, s) => a + s.tokens, 0));
	m.segments.forEach((s, i) => bar.append(el('i', { style: 'width:' + (s.tokens / whole * 100).toFixed(2) + '%;background:' + COLORS[i % COLORS.length], title: s.label + ': ' + fmt(s.tokens) })));
	const seg = $('segments'); seg.replaceChildren(el('table', {}, m.segments.map((s, i) => el('tr', {},
		el('td', {}, el('span', { style: 'display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;background:' + COLORS[i % COLORS.length] }), s.label, s.detail ? el('div', { class: 'muted' }, s.detail) : null),
		el('td', { class: 'mono', style: 'text-align:right' }, (s.how === 'measured' ? '' : '~') + fmt(s.tokens)), el('td', {}, howTag(s.how))))));
	const waste = $('waste'); waste.replaceChildren();
	if (!m.waste.length) waste.append(el('p', { class: 'muted' }, 'Nothing stands out.'));
	m.waste.forEach((w, i) => {
		const a = w.action;
		const label = !a ? null : a.kind === 'open' ? 'Open' : a.kind === 'disable-mcp' ? 'Disable here…' : a.kind === 'measure' ? (d.can.measure ? 'Measure with /context' : null) : (d.can.compact ? 'Compact' : null);
		waste.append(el('div', { class: 'card row' }, el('div', { class: 'grow' }, el('b', {}, w.title), ' ', howTag(w.how), el('div', { class: 'muted' }, w.detail)),
			label ? el('button', { class: a.kind === 'disable-mcp' ? 'primary' : '', 'aria-label': label.replace(/…$/, '') + ': ' + w.title, onclick: () => { announce(label.replace(/…$/, '') + ' asked for.'); vscode.postMessage({ type: 'act', id: w.id }); } }, label) : null));
	});
	// What a screen reader hears after a refresh: the total and how many things look like waste (the list itself is read by moving into it).
	announce('Context X-ray of ' + m.agent + (m.used !== undefined ? ': ' + fmt(m.used) + ' of ' + fmt(m.size) + ' tokens in use' : '') + (m.waste.length ? ', ' + m.waste.length + (m.waste.length === 1 ? ' thing looks' : ' things look') + ' like waste.' : ', nothing stands out.'));
}
$('refresh').onclick = () => { announce('Refreshing.'); vscode.postMessage({ type: 'refresh' }); };
window.addEventListener('message', e => { if (e.data.type === 'data') render(e.data); });
vscode.postMessage({ type: 'ready' });
`);
	}

	dispose() {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}
