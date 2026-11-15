/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the "Harness" page's pure parts. What the page shows (shaped from the folder's summary, summaryCore.ts, and the MCP
 *  manager's servers), what its messages may ask for (`parseMessage`), and the page itself (markup and script). No `vscode` here, so all of it
 *  is tested on its own; harnessPanel.ts holds the panel and runs what the messages ask.
 *
 *  The page is data in, intents out: it never names a command id (each action is a fixed command on the host), a file it asks to open must be
 *  one the host listed in the data it sent (`openable`), and every string in the data that can carry a credential (a hook's command line, a
 *  permission rule, an MCP server's command or URL) goes through redact.ts again here, whatever redacted it before.
 *--------------------------------------------------------------------------------------------*/

import { page } from './page';
import { redact } from './redact';
import type { HarnessSummary, SummaryResult } from './summaryCore';

export type SectionId = 'lint' | 'instructions' | 'hooks' | 'permissions' | 'mcp' | 'skills' | 'subagents' | 'commands';

/** The rail, in order. */
export const SECTIONS: { id: SectionId; label: string }[] = [
	{ id: 'lint', label: 'Lint' },
	{ id: 'instructions', label: 'Instructions' },
	{ id: 'hooks', label: 'Hooks' },
	{ id: 'permissions', label: 'Permissions' },
	{ id: 'mcp', label: 'MCP servers' },
	{ id: 'skills', label: 'Skills' },
	{ id: 'subagents', label: 'Subagents' },
	{ id: 'commands', label: 'Slash commands' },
];

/** One entry of a list section. `file` (absolute) is what a click opens, and only if the host listed it. */
export interface PageRow {
	name: string;
	scope?: string;
	tag?: string;
	detail?: string;
	tokens?: number;
	where?: string;
	file?: string;
	/** 1-based. */
	line?: number;
}

export interface PageFinding {
	severity: 'error' | 'warning' | 'info';
	message: string;
	where: string;
	file: string;
	line: number;
	code: string;
}

/** The part of an MCP server this page needs: the manager's public view (names, never values) with its usage, last check and busy flag. */
export interface McpRowInput {
	id: string;
	name: string;
	scope: string;
	profile?: string;
	transport: string;
	command?: string;
	args: string[];
	url?: string;
	file: string;
	state: 'on' | 'off' | 'pending';
	stateWhy: string;
	readOnly?: string;
	shadowed: boolean;
	busy: boolean;
	issues: { severity: 'error' | 'warning' | 'info'; message: string }[];
	check?: { ok: boolean; status: string; at: number; ms: number; how: string; toolCount?: number };
	usage?: { label: string };
}

export interface McpInput {
	servers: McpRowInput[];
	cli: { claude: boolean; codex: boolean };
	trusted: boolean;
	problems: { file: string; message: string }[];
}

export interface McpRow {
	id: string;
	name: string;
	scope: string;
	transport: string;
	state: 'on' | 'off' | 'pending';
	stateWhy: string;
	/** The command line or URL, redacted. */
	target: string;
	/** The file it is written in, as the page shows it (the home folder as `~`). */
	where: string;
	readOnly?: string;
	shadowed: boolean;
	busy: boolean;
	/** A repository's server is not started or contacted from an untrusted folder. */
	blocked: boolean;
	issues: { severity: 'error' | 'warning' | 'info'; message: string }[];
	check?: { ok: boolean; status: string; at: number; ms: number; how: string; toolCount?: number };
	usage?: string;
}

export interface PageData {
	/** Absent without a folder. */
	root?: string;
	project: string;
	score?: number;
	/** Findings that are errors or warnings: "N to look at". */
	attention: number;
	/** The summary is being read (the first time). */
	loading: boolean;
	/** Why the summary could not be read; the MCP section does not depend on it. */
	error?: string;
	notes: string[];
	/** The file the Why? button asks about: the last file editor, by name. */
	why?: string;
	sections: { id: SectionId; label: string; count: number; attention: number; muted: boolean }[];
	intro: Partial<Record<SectionId, string>>;
	lint: PageFinding[];
	lists: Record<Exclude<SectionId, 'lint' | 'mcp'>, PageRow[]>;
	mcp: { servers: McpRow[]; cli: McpInput['cli']; trusted: boolean; problems: McpInput['problems'] };
}

export interface PageInput {
	root?: string;
	/** Undefined until the first summary has been read. */
	summary?: SummaryResult;
	mcp?: McpInput;
	why?: string;
	home?: string;
}

const MAX_TARGET = 200;
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** Which section a finding belongs to: by its check (a hook check is about hooks wherever the settings file is), else by the file it is in. */
const BY_CODE: Record<string, SectionId> = {
	'missing-script': 'hooks', 'unknown-event': 'hooks', 'dead-matcher': 'hooks', 'ignored-matcher': 'hooks',
	'duplicate-rule': 'permissions', 'overbroad': 'permissions', 'shadowed': 'permissions', 'rule-conflict': 'permissions', 'rule-never-applies': 'permissions', 'wildcard-before-subcommand': 'permissions',
	'mcp-config': 'mcp', 'mcp-unreadable': 'mcp', 'skill-shadow': 'skills', 'bad-name': 'skills',
};

export function sectionOfFinding(f: Pick<PageFinding, 'code' | 'file'>, files: Partial<Record<SectionId, ReadonlySet<string>>>): SectionId | undefined {
	if (Object.prototype.hasOwnProperty.call(BY_CODE, f.code)) {
		return BY_CODE[f.code];
	}
	return (['instructions', 'skills', 'subagents', 'commands'] as const).find(id => files[id]?.has(f.file));
}

const clean = (text: string) => redact(text, MAX_TARGET);

function mcpRow(s: McpRowInput, trusted: boolean, home: string): McpRow {
	const target = s.transport === 'stdio' ? [s.command ?? '', ...s.args].join(' ') : s.url ?? '';
	const file = home && (s.file === home || s.file.startsWith(home + '/') || s.file.startsWith(home + '\\')) ? '~' + s.file.slice(home.length) : s.file;
	return {
		id: s.id, name: s.name.slice(0, 80), scope: s.scope + (s.profile ? ' ' + s.profile : ''), transport: s.transport, state: s.state, stateWhy: s.stateWhy.slice(0, 240),
		target: clean(target), where: file.slice(0, 160), ...(s.readOnly ? { readOnly: s.readOnly } : {}), shadowed: s.shadowed, busy: s.busy, blocked: s.scope === 'project' && !trusted,
		issues: s.issues.map(i => ({ severity: i.severity, message: i.message.slice(0, 240) })),
		...(s.check ? { check: { ...s.check, status: redact(s.check.status, 300) } } : {}),
		...(s.usage ? { usage: s.usage.label } : {}),
	};
}

/** What the page draws, from the summary (undefined while it is read) and the MCP manager's servers. */
export function buildPageData(input: PageInput): PageData {
	const { root, summary, mcp, home = '' } = input;
	const s: HarnessSummary | undefined = summary?.ok ? summary.summary : undefined;
	const lists: PageData['lists'] = { instructions: [], hooks: [], permissions: [], skills: [], subagents: [], commands: [] };
	const intro: PageData['intro'] = {};
	let lint: PageFinding[] = [];
	if (s) {
		lists.instructions = s.instructions.map(i => ({ name: i.name, scope: i.scope, tag: i.kind === 'rules' ? 'rule' : undefined, detail: i.detail, tokens: i.tokens, where: i.where, file: i.file }));
		lists.hooks = s.hooks.map(h => ({ name: h.event + (h.matcher ? ' · ' + h.matcher : ''), scope: h.scope, detail: clean(h.command), where: h.where, file: h.file, line: h.line }));
		lists.permissions = (['allow', 'ask', 'deny'] as const).flatMap(effect => s.permissions[effect].map(r => ({ name: clean(r.pattern), scope: r.scope, tag: effect, where: r.where, file: r.file })));
		lists.skills = s.skills.items.map(n => ({ name: n.name, scope: n.scope, where: n.where, file: n.file }));
		lists.subagents = s.agents.items.map(n => ({ name: n.name, scope: n.scope, where: n.where, file: n.file }));
		lists.commands = s.commands.items.map(n => ({ name: n.name, scope: n.scope, where: n.where, file: n.file }));
		if (s.permissions.mode) {
			intro.permissions = `Default mode: ${s.permissions.mode}${s.permissions.modeWhere ? ` (${s.permissions.modeWhere})` : ''}. ${s.permissions.counts.allow} allow, ${s.permissions.counts.ask} ask, ${s.permissions.counts.deny} deny.`;
		}
		lint = s.findings.map(f => ({ severity: f.severity, message: f.message, where: f.where, file: f.file, line: f.line, code: f.code }));
	}
	const files: Partial<Record<SectionId, Set<string>>> = {};
	for (const id of ['instructions', 'skills', 'subagents', 'commands'] as const) {
		files[id] = new Set(lists[id].flatMap(r => r.file ? [r.file] : []));
	}
	const attention: Partial<Record<SectionId, number>> = {};
	for (const f of lint.filter(x => x.severity !== 'info')) {
		const id = sectionOfFinding(f, files);
		if (id) {
			attention[id] = (attention[id] ?? 0) + 1;
		}
	}
	const servers = (mcp?.servers ?? []).map(x => mcpRow(x, mcp?.trusted ?? false, home));
	const counts: Record<SectionId, number> = {
		lint: s ? s.counts.error + s.counts.warning + s.counts.info : 0,
		instructions: lists.instructions.length, hooks: lists.hooks.length,
		permissions: s ? s.permissions.counts.allow + s.permissions.counts.ask + s.permissions.counts.deny : 0,
		mcp: servers.length, skills: s?.skills.count ?? 0, subagents: s?.agents.count ?? 0, commands: s?.commands.count ?? 0,
	};
	const toLookAt = s ? s.counts.error + s.counts.warning : 0;
	return {
		...(root ? { root } : {}), project: root ? base(root) : '', ...(s ? { score: s.score } : {}), attention: toLookAt,
		loading: !!root && !summary, ...(summary && !summary.ok ? { error: summary.message } : {}),
		notes: s?.notes ?? [], ...(input.why ? { why: input.why } : {}),
		sections: SECTIONS.map(x => ({ ...x, count: counts[x.id], attention: x.id === 'lint' ? toLookAt : attention[x.id] ?? 0, muted: counts[x.id] === 0 })),
		intro, lint, lists, mcp: { servers, cli: mcp?.cli ?? { claude: false, codex: false }, trusted: mcp?.trusted ?? false, problems: mcp?.problems ?? [] },
	};
}

/** Every absolute path the data names: the files a click may open. A file the host did not send is never opened. */
export function openable(data: PageData): Set<string> {
	return new Set([...data.lint.map(f => f.file), ...Object.values(data.lists).flatMap(rows => rows.flatMap(r => r.file ? [r.file] : []))]);
}

export type McpAction = 'add' | 'checkAll' | 'check' | 'open' | 'edit' | 'toggle' | 'remove';
const MCP_ACTIONS: readonly string[] = ['add', 'checkAll', 'check', 'open', 'edit', 'toggle', 'remove'];
/** The actions that name a server. */
const MCP_ON_SERVER: readonly string[] = ['check', 'open', 'edit', 'toggle', 'remove'];

/** What a message from the page may ask the host for. */
export type PageAction =
	| { kind: 'ready' }
	| { kind: 'refresh' }
	| { kind: 'why' }
	| { kind: 'view'; view: 'map' | 'flow' }
	| { kind: 'open'; file: string; line?: number }
	| { kind: 'mcp'; action: McpAction; id?: string };

const MAX_PATH = 1024;
const MAX_ID = 1024;

/** The one thing a message asks for, or undefined (dropped): the shape and lengths are checked, an unknown type or action is not guessed at, and `files` is what the host last sent. */
export function parseMessage(raw: unknown, files: ReadonlySet<string>): PageAction | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const m = raw as Record<string, unknown>;
	switch (m.type) {
		case 'ready':
			return { kind: 'ready' };
		case 'refresh':
			return { kind: 'refresh' };
		case 'why':
			return { kind: 'why' };
		case 'view':
			return m.view === 'map' || m.view === 'flow' ? { kind: 'view', view: m.view } : undefined;
		case 'open': {
			if (typeof m.file !== 'string' || m.file.length === 0 || m.file.length > MAX_PATH || !files.has(m.file)) {
				return undefined;
			}
			const line = typeof m.line === 'number' && Number.isInteger(m.line) && m.line >= 1 && m.line <= 10_000_000 ? m.line : undefined;
			return { kind: 'open', file: m.file, ...(line ? { line } : {}) };
		}
		case 'mcp': {
			if (typeof m.action !== 'string' || !MCP_ACTIONS.includes(m.action)) {
				return undefined;
			}
			if (!MCP_ON_SERVER.includes(m.action)) {
				return { kind: 'mcp', action: m.action as McpAction };
			}
			// Whether the id names a server is the MCP manager's check (it looks it up in the list it read); here only its shape.
			return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= MAX_ID ? { kind: 'mcp', action: m.action as McpAction, id: m.id } : undefined;
		}
	}
	return undefined;
}

const STYLE = `
.top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; margin-bottom: 14px; }
.top h1 { margin: 0; }
.top .spacer { flex: 1; }
.layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 560px) { .layout { grid-template-columns: minmax(0, 1fr); } }
#rail { position: sticky; top: 8px; }
#tabs { display: flex; flex-direction: column; gap: 1px; }
button.tab { display: flex; align-items: baseline; gap: 8px; text-align: left; border: 0; border-radius: 6px; padding: 4px 8px; width: 100%; }
button.tab[aria-selected="true"] { background: var(--vscode-list-inactiveSelectionBackground, var(--card)); font-weight: 600; }
button.tab.muted { color: var(--muted); }
.count { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; }
.attn, .count.attn { color: var(--ask); font-weight: 600; }
hr { border: 0; border-top: 1px solid var(--line); margin: 10px 0; }
.views-h { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 8px 4px; }
button.view { display: block; width: 100%; text-align: left; border: 0; border-radius: 6px; padding: 4px 8px; }
#main { min-width: 0; }
#main:focus { outline: none; }
#main h2 { margin-top: 0; }
.sec-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
.sec-head h2 { flex: 1 1 10em; margin: 0 0 8px; }
.actions { display: flex; flex-wrap: wrap; gap: 4px; }
.kv { margin: 4px 0 0; overflow-wrap: anywhere; }
.kv span + span::before { content: ' · '; color: var(--muted); }
.card.row { align-items: flex-start; }
.name { font-weight: 600; margin-right: 4px; }
.chip { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 9px; border: 1px solid var(--line); margin-right: 4px; white-space: nowrap; }
.on { color: var(--allow); } .off { color: var(--deny); } .pending { color: var(--ask); }
.srv.shadowed { opacity: .65; }
.issue { font-size: 12px; margin-top: 4px; }
.issue.error { color: var(--deny); } .issue.warning { color: var(--ask); } .issue.info { color: var(--muted); }
.status { margin-top: 4px; font-size: 12px; }
.menu-wrap { position: relative; display: inline-block; }
.menu { position: absolute; right: 0; top: 100%; z-index: 5; min-width: 150px; margin-top: 2px; padding: 4px; display: flex; flex-direction: column; background: var(--vscode-menu-background, var(--vscode-editor-background)); border: 1px solid var(--line); border-radius: 6px; }
.menu button { text-align: left; border: 0; }
`;

const SCRIPT = /* js */ `
const post = m => vscode.postMessage(m);
const EMPTY = { lint: 'No findings: the lint found nothing to fix.', instructions: 'No instruction files found.', hooks: 'No hooks configured.', permissions: 'No permission rules set.',
	skills: 'No skills found.', subagents: 'No subagents found.', commands: 'No slash commands found.' };
const SEV = { error: 'deny', warning: 'ask', info: 'muted' };
const ago = t => { const s = (Date.now() - t) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
let data = null, sel = 'lint', menu = null;
const seen = new Map();
document.getElementById('why').onclick = () => post({ type: 'why' });
document.getElementById('refresh').onclick = () => post({ type: 'refresh' });
document.getElementById('v-map').onclick = () => post({ type: 'view', view: 'map' });
document.getElementById('v-flow').onclick = () => post({ type: 'view', view: 'flow' });
// A click outside the open "more" menu closes it.
document.addEventListener('click', e => { if (menu && !(e.target && e.target.closest && e.target.closest('.menu-wrap'))) { menu = null; draw(); } });

function fileBtn(label, file, line, title) {
	if (!file) return el('span', {}, label);
	return el('button', { type: 'button', class: 'link', title, onclick: () => post({ type: 'open', file, line }) }, label);
}
function select(id) { sel = id; menu = null; draw(); const t = document.getElementById('tab-' + id); if (t) t.focus(); }
function tabKey(e, id) {
	const ids = data.sections.map(s => s.id), at = ids.indexOf(id), n = ids.length;
	const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? ids[(at + 1) % n] : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? ids[(at + n - 1) % n] : e.key === 'Home' ? ids[0] : e.key === 'End' ? ids[n - 1] : null;
	if (!next) return;
	e.preventDefault();
	select(next);
}
function renderTop() {
	document.getElementById('project').textContent = data.project;
	const h = document.getElementById('health');
	h.replaceChildren();
	if (data.score !== undefined) {
		h.append('Health ', el('b', {}, String(data.score)), data.attention ? el('span', { class: 'attn' }, ' · ' + data.attention + ' to look at') : el('span', { class: 'muted' }, ' · nothing to look at'));
	}
	const w = document.getElementById('whyfile');
	w.textContent = data.why || '';
	document.getElementById('why').title = data.why ? 'Why does an agent behave as it does on ' + data.why + '?' : 'Pick a file: why does an agent behave as it does on it?';
}
function renderRail() {
	document.getElementById('tabs').replaceChildren(...data.sections.map(s => el('button', {
		type: 'button', role: 'tab', id: 'tab-' + s.id, 'data-k': 'tab:' + s.id, 'aria-selected': String(s.id === sel), 'aria-controls': 'main', tabindex: s.id === sel ? '0' : '-1',
		class: 'tab' + (s.muted ? ' muted' : ''), onclick: () => select(s.id), onkeydown: e => tabKey(e, s.id),
	}, el('span', { class: 'grow' }, s.label), el('span', { class: 'count' + (s.attention ? ' attn' : ''), title: s.attention ? s.attention + ' to look at' : null }, data.loading && s.id !== 'mcp' ? '…' : String(s.count)))));
}
function rowEl(r) {
	return el('div', { class: 'card row' },
		el('div', { class: 'grow' },
			el('div', {}, el('span', { class: 'name' }, fileBtn(r.name, r.file, r.line, r.where)), r.tag ? el('span', { class: 'tag ' + r.tag }, r.tag) : null, ' ', r.scope ? el('span', { class: 'tag' }, r.scope) : null),
			r.detail ? el('div', { class: 'muted mono kv' }, r.detail) : null,
			r.where ? el('div', { class: 'muted kv' }, r.where + (r.line ? ':' + r.line : '')) : null),
		r.tokens ? el('span', { class: 'tag est', title: 'Estimated from the file size (about 4 characters per token)' }, '~' + fmt(r.tokens) + ' tok') : null);
}
function findingEl(f) {
	return el('div', { class: 'card row' }, el('span', { class: 'tag ' + SEV[f.severity] }, f.severity),
		el('div', { class: 'grow' }, el('div', {}, f.message), el('div', { class: 'kv muted' }, fileBtn(f.where + ':' + f.line, f.file, f.line, f.where))));
}
function menuItem(label, aria, type, id) {
	return el('button', { type: 'button', role: 'menuitem', 'aria-label': aria, onclick: () => { menu = null; post({ type: 'mcp', action: type, id }); draw(); } }, label);
}
function menuKey(e, s) {
	const items = [...e.currentTarget.querySelectorAll('[role=menuitem]')], at = items.indexOf(document.activeElement);
	if (e.key === 'Escape') { e.preventDefault(); menu = null; draw(); const b = document.querySelector('[data-k="' + s.id + ':more"]'); if (b) b.focus(); return; }
	const next = e.key === 'ArrowDown' ? items[(at + 1) % items.length] : e.key === 'ArrowUp' ? items[(at + items.length - 1) % items.length] : e.key === 'Home' ? items[0] : e.key === 'End' ? items[items.length - 1] : null;
	if (next) { e.preventDefault(); next.focus(); }
}
function serverEl(s, trusted) {
	const c = s.check, canEdit = !s.readOnly, open = menu === s.id;
	return el('div', { class: 'card srv' + (s.shadowed ? ' shadowed' : ''), id: 's-' + s.id },
		el('div', { class: 'row' },
			el('div', { class: 'grow' }, el('span', { class: 'name' }, s.name), el('span', { class: 'chip' }, s.scope), el('span', { class: 'chip' }, s.transport),
				el('span', { class: 'chip ' + s.state, title: s.stateWhy }, s.state === 'pending' ? 'awaiting approval' : s.state)),
			el('div', { class: 'actions' },
				el('button', { type: 'button', 'data-k': s.id + ':check', 'aria-label': (s.busy ? 'Checking ' : 'Check ') + s.name, disabled: s.busy || s.blocked, onclick: () => post({ type: 'mcp', action: 'check', id: s.id }),
					title: s.blocked ? "Trust the folder to check the repository's servers" : 'Start it once (or contact its URL) and list its tools' }, s.busy ? 'Checking…' : 'Check'),
				el('button', { type: 'button', 'data-k': s.id + ':open', 'aria-label': 'Open the file of ' + s.name, title: s.where, onclick: () => post({ type: 'mcp', action: 'open', id: s.id }) }, 'Open'),
				canEdit ? el('span', { class: 'menu-wrap' },
					el('button', { type: 'button', 'data-k': s.id + ':more', 'aria-label': 'More actions for ' + s.name, 'aria-haspopup': 'menu', 'aria-expanded': String(open), onclick: e => { e.stopPropagation(); menu = open ? null : s.id; draw(); if (menu) { const f = document.querySelector('.menu [role=menuitem]'); if (f) f.focus(); } } }, '⋯'),
					open ? el('div', { class: 'menu', role: 'menu', 'aria-label': 'Actions for ' + s.name, onkeydown: e => menuKey(e, s) },
						menuItem('Edit…', 'Edit ' + s.name, 'edit', s.id), menuItem(s.state === 'off' ? 'Turn on…' : 'Turn off…', (s.state === 'off' ? 'Turn on ' : 'Turn off ') + s.name, 'toggle', s.id), menuItem('Remove…', 'Remove ' + s.name, 'remove', s.id)) : null) : null)),
		el('div', { class: 'mono kv' }, s.target),
		el('div', { class: 'kv muted' }, el('span', {}, s.stateWhy), s.usage ? el('span', {}, s.usage) : null, el('span', { title: s.where }, s.where.split(/[\\\\/]/).slice(-2).join('/'))),
		s.readOnly ? el('div', { class: 'issue info' }, s.readOnly) : null,
		...s.issues.map(i => el('div', { class: 'issue ' + i.severity }, i.message)),
		c ? el('div', { class: 'status ' + (c.ok ? 'on' : 'off') }, (c.ok ? '✓ ' : '✗ ') + c.status, el('span', { class: 'muted' }, ' · ' + c.how + ', ' + ago(c.at) + (c.toolCount !== undefined ? ', ' + c.toolCount + ' tools' : ''))) : null);
}
function mcpSection() {
	const m = data.mcp;
	return [
		el('div', { class: 'sec-head' }, el('h2', {}, 'MCP servers'), el('div', { class: 'actions' },
			el('button', { type: 'button', class: 'primary', 'data-k': 'mcp:add', onclick: () => post({ type: 'mcp', action: 'add' }) }, 'Add server…'),
			el('button', { type: 'button', 'data-k': 'mcp:all', onclick: () => post({ type: 'mcp', action: 'checkAll' }) }, 'Check all'))),
		el('p', { class: 'sub' }, 'Every server Claude Code and Codex load for this folder. Check starts one once (or contacts its URL), lists its tools and stops it; nothing runs until you click.'),
		...m.problems.map(p => el('div', { class: 'card issue error' }, p.file + ': ' + p.message)),
		...(m.servers.length ? m.servers.map(s => serverEl(s, m.trusted)) : [el('p', { class: 'muted' }, 'No MCP servers configured.')]),
	];
}
function renderMain() {
	const main = document.getElementById('main');
	main.setAttribute('aria-labelledby', 'tab-' + sel);
	const sec = data.sections.find(s => s.id === sel);
	if (sel === 'mcp') { main.replaceChildren(...mcpSection()); return; }
	const kids = [el('div', { class: 'sec-head' }, el('h2', {}, sec.label))];
	if (data.error) kids.push(el('p', { class: 'muted' }, data.error));
	else if (data.loading) kids.push(el('p', { class: 'muted' }, 'Reading the harness…'));
	else {
		if (data.intro[sel]) kids.push(el('p', { class: 'sub' }, data.intro[sel]));
		const rows = sel === 'lint' ? data.lint.map(findingEl) : data.lists[sel].map(rowEl);
		kids.push(...(rows.length ? rows : [el('p', { class: 'muted' }, EMPTY[sel])]));
		if (data.notes.length) kids.push(...data.notes.map(n => el('p', { class: 'muted' }, n)));
	}
	main.replaceChildren(...kids);
}
function draw() {
	// Everything is drawn again on every update, so the control that had focus is a new element: put focus back on its twin.
	const a = document.activeElement, had = a && a.dataset ? a.dataset.k : undefined;
	renderTop(); renderRail(); renderMain();
	if (had) { const again = [...document.querySelectorAll('[data-k]')].find(b => b.dataset.k === had); if (again && !again.disabled) again.focus(); }
}
window.addEventListener('message', e => {
	const m = e.data;
	if (!m || m.type !== 'data') return;
	data = m.data;
	if (!data.sections.some(s => s.id === sel)) sel = data.sections[0].id;
	if (menu && !data.mcp.servers.some(s => s.id === menu)) menu = null;
	draw();
	// A check that finished since the last update is said once (never the whole list on the first draw).
	for (const s of data.mcp.servers) {
		const at = s.check ? s.check.at : 0;
		if (seen.has(s.id) && at && at !== seen.get(s.id)) announce(s.name + ': ' + (s.check.ok ? 'passed' : 'failed') + '. ' + s.check.status);
		seen.set(s.id, at);
	}
});
post({ type: 'ready' });
`;

/** The page's markup and script; the data arrives by message. */
export function harnessHtml(): string {
	return page('Harness', `
<header class="top"><h1>Harness</h1><span id="project" class="muted"></span><span id="health"></span><span class="spacer"></span>
<span id="whyfile" class="muted mono"></span><button id="why" type="button">Why?</button><button id="refresh" type="button">Refresh</button></header>
<div class="layout">
<nav id="rail" aria-label="Harness"><div id="tabs" role="tablist" aria-orientation="vertical" aria-label="Sections"></div><hr>
<div class="views-h">Views</div><button id="v-map" class="view" type="button">Map</button><button id="v-flow" class="view" type="button">Flow</button></nav>
<main id="main" role="tabpanel" tabindex="-1"></main>
</div>`, SCRIPT, STYLE);
}
