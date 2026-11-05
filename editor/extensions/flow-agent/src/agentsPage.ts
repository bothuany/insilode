/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page (HTML, CSS and the script that draws it). No `vscode` here, so the page can be rendered
 *  outside the editor too (the website puts it in an iframe and sends it the same messages). It receives
 *  AgentsPageMessage (agentsData.ts) and posts AgentsAction (agentsMessage.ts) through acquireVsCodeApi().postMessage
 *  (the website's shim defines one too). agentsPanel.ts gives it to the webview and answers.
 *
 *  It is the wide sibling of the dock (dockPage.ts): the same rows, drawn as a board (or a list) with a detail panel for
 *  the selected agent. Text from a row only ever reaches the page through textContent (the h() helper below): the only
 *  markup set as HTML is built from constants (the avatar, the CLI marks).
 *--------------------------------------------------------------------------------------------*/

import { AVATAR_CSS, AVATAR_SCRIPT } from './avatars';
import { DOCK_COLORS, ICON, colorVars } from './dockPage';

const CSS = String.raw`
:root {
	--bg: var(--vscode-editor-background, #1b1c23); --text: var(--vscode-foreground, #cfd2dc); --muted: var(--vscode-descriptionForeground, #8b90a0);
	--line: var(--vscode-widget-border, var(--vscode-panel-border, #30323c)); --hover: var(--vscode-list-hoverBackground, #2a2c36);
	--card: color-mix(in srgb, var(--bg) 82%, #808aa0); --col: color-mix(in srgb, var(--bg) 94%, #808aa0);
	--input: var(--vscode-input-background, #24262e); --focus: var(--vscode-focusBorder, #6f7cff);
	--btn: var(--vscode-button-secondaryBackground, #3a3d4a); --btn-text: var(--vscode-button-secondaryForeground, #e6e8ee);
	--mono: var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace);
	${colorVars(DOCK_COLORS.dark)}
}
body.vscode-light, body.vscode-high-contrast-light {
	--card: color-mix(in srgb, var(--bg) 60%, #fff); --col: color-mix(in srgb, var(--bg) 94%, #5a6480);
	${colorVars(DOCK_COLORS.light)}
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; color: var(--text); background: var(--bg); font: 13px/1.4 var(--vscode-font-family, -apple-system, system-ui, sans-serif); overflow: hidden; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, textarea:focus-visible, .card:focus-visible, .lrow:focus-visible { outline: 1.5px solid var(--focus); outline-offset: -1.5px; }
#app { display: flex; flex-direction: column; height: 100%; }
#app[hidden] { display: none; }
.ico { flex: none; width: 15px; height: 15px; display: block; }
.ico.claude { color: var(--claude); } .ico.codex { color: var(--codex); } .ico.custom { color: var(--custom); }
.mark { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 11.5px; }
.mark.cust { color: var(--custom); }

.head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px; padding: 10px 16px; border-bottom: 1px solid var(--line); }
.counts { display: flex; gap: 14px; }
.count { display: flex; align-items: baseline; gap: 5px; color: var(--muted); }
.count b { font-size: 18px; color: var(--text); font-variant-numeric: tabular-nums; }
.count i { width: 8px; height: 8px; border-radius: 50%; align-self: center; }
.totals { color: var(--muted); font-variant-numeric: tabular-nums; }
.totals b { color: var(--text); font-weight: 600; }
.limits { display: flex; flex-wrap: wrap; gap: 6px 16px; margin-left: auto; }
.lim { display: flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.lim .bar { width: 90px; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.lim .bar i { display: block; height: 100%; background: var(--working); }
.lim.warn .bar i { background: var(--blocked); } .lim.full .bar i { background: var(--danger); }

.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--line); }
.btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border: 1px solid var(--line); border-radius: 7px; background: transparent; }
.btn:hover { background: var(--hover); }
.btn.primary { background: var(--btn); color: var(--btn-text); }
.btn.small { height: 24px; padding: 0 8px; font-size: 12px; }
.btn.danger { color: var(--danger-text); border-color: color-mix(in srgb, var(--danger) 55%, transparent); }
.btn[aria-pressed="true"] { background: color-mix(in srgb, var(--working) 22%, transparent); border-color: var(--working); }
.btn:disabled { opacity: .5; cursor: default; }
.search { flex: 1 1 160px; min-width: 120px; max-width: 320px; height: 28px; padding: 0 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--input); }
.clisel { height: 28px; border: 1px solid var(--line); border-radius: 7px; background: var(--input); padding: 0 6px; }
.grow { flex: 1; }
.newwrap { position: relative; display: inline-flex; gap: 6px; }
.menu { position: absolute; top: 100%; left: 0; margin-top: 3px; z-index: 20; min-width: 230px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--vscode-menu-background, var(--bg)); color: var(--vscode-menu-foreground, var(--text)); box-shadow: 0 6px 18px rgb(0 0 0 / .35); }
.menu[hidden] { display: none; }
.menu button { display: block; width: 100%; min-height: 26px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; text-align: left; }
.menu button:hover, .menu button:focus-visible { background: var(--vscode-menu-selectionBackground, var(--hover)); }
.menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }

.split { display: flex; flex: 1; min-height: 0; }
.main { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 12px 16px 24px; }
.detail { flex: 0 0 420px; max-width: 46%; overflow: auto; border-left: 1px solid var(--line); padding: 14px 16px 28px; }
@media (max-width: 900px) {
	body { overflow: auto; } #app { height: auto; }
	.split { flex-direction: column; }
	.main, .detail { overflow: visible; max-width: none; flex: none; }
	.detail { border-left: 0; border-top: 1px solid var(--line); }
}

.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; align-items: start; }
.colm { background: var(--col); border: 1px solid var(--line); border-radius: 10px; padding: 8px; min-width: 0; }
.colm h3 { margin: 2px 4px 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: flex; align-items: center; gap: 7px; }
.colm h3 i { width: 8px; height: 8px; border-radius: 50%; }
.colm h3 .n { margin-left: auto; font-variant-numeric: tabular-nums; }
.colm.collapsed h3 { margin: 0; cursor: pointer; }
.colm .none { color: var(--muted); padding: 6px 4px; font-size: 12px; }
.card { position: relative; display: block; margin: 0 0 8px; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: var(--card); cursor: pointer; min-width: 0; }
.card:hover { border-color: var(--line); }
.card.sel, .lrow.sel { border-color: var(--focus); background: color-mix(in srgb, var(--focus) 12%, var(--card)); }
.card.ended, .lrow.ended { opacity: .62; }
.card.unread .name::after, .lrow.unread .name::after { content: ""; display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--working); }
.card.blocked, .card.approval, .card.question, .card.error { border-color: color-mix(in srgb, var(--blocked) 45%, transparent); }
.card.sel.blocked, .card.sel.approval, .card.sel.question, .card.sel.error { border-color: var(--focus); }
.top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.av { position: relative; flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: #000; }
.av.big { width: 40px; height: 40px; border-radius: 10px; }
${AVATAR_CSS}
.name { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { margin-left: auto; color: var(--muted); font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.state.s-blocked, .state.s-approval, .state.s-question, .state.s-error { color: var(--blocked); font-weight: 600; }
.prompt { margin: 5px 0 0; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.activity { margin: 4px 0 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.need { display: flex; gap: 7px; align-items: baseline; margin: 6px 0 0; padding: 5px 8px; border-radius: 7px; background: color-mix(in srgb, var(--blocked) 12%, transparent); }
.need.error { background: color-mix(in srgb, var(--danger) 12%, transparent); }
.chip { flex: none; padding: 0 7px; border-radius: 9px; font-size: 11px; font-weight: 600; background: var(--blocked); color: var(--bg); }
.need.error .chip { background: var(--danger); color: #fff; }
.need .t { min-width: 0; overflow-wrap: anywhere; }
.segs { display: flex; gap: 2px; flex: 1; min-width: 40px; }
.seg { flex: 1; height: 5px; border-radius: 2px; background: var(--line); max-width: 28px; }
.seg.completed { background: var(--done); } .seg.in_progress { background: var(--working); }
.todos { display: flex; align-items: center; gap: 8px; margin-top: 7px; font-size: 12px; color: var(--muted); }
.todos .now { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 7px; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.facts .pill { padding: 0 6px; border: 1px solid var(--line); border-radius: 9px; }
.pill.pr-open, .pill.pass { color: var(--done); } .pill.draft, .pill.pending { color: var(--idle); }
.pill.merged { color: var(--custom); } .pill.closed, .pill.fail { color: var(--danger-text); }
.est { font-size: 10.5px; opacity: .75; }
.warnic { color: var(--blocked); }
.ctx.warn { color: var(--blocked); } .ctx.full { color: var(--danger-text); }
.empty { max-width: 460px; margin: 60px auto; text-align: center; color: var(--muted); }
.empty b { color: var(--text); font-size: 15px; }
.empty .row { display: flex; justify-content: center; gap: 10px; margin-top: 16px; }

.lhead, .lrow { display: grid; grid-template-columns: minmax(150px, 1.2fr) 70px 110px minmax(120px, 2fr) 60px minmax(90px, 1fr) minmax(70px, .8fr) minmax(90px, 1fr); gap: 10px; align-items: center; padding: 6px 10px; }
.lhead { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid var(--line); }
.lrow { border: 1px solid transparent; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.lrow:hover { background: var(--hover); }
.lrow > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrow .nm { display: flex; align-items: center; gap: 8px; }
.group { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }

.kept { margin-top: 20px; }
.kept h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: flex; align-items: center; gap: 10px; margin: 0 0 6px; }
.krow { display: flex; gap: 14px; padding: 4px 8px; border-radius: 6px; font-size: 12.5px; }
.krow:hover { background: var(--hover); }
.krow span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.krow .br { font-family: var(--mono); }

.dh { display: flex; align-items: center; gap: 12px; }
.dh .nm { flex: 1; min-width: 0; }
.dh h2 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
.sub { color: var(--muted); font-size: 12px; margin-top: 2px; display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: center; font-variant-numeric: tabular-nums; }
.sec { margin-top: 16px; }
.sec h4 { margin: 0 0 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); display: flex; align-items: center; gap: 8px; }
.sec h4 .btn { margin-left: auto; text-transform: none; letter-spacing: 0; }
.sec p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.todol { list-style: none; margin: 0; padding: 0; }
.todol li { display: flex; gap: 8px; padding: 2px 0; }
.todol li .m { flex: none; width: 14px; color: var(--muted); }
.todol li.completed { color: var(--muted); text-decoration: line-through; } .todol li.completed .m { color: var(--done); }
.todol li.in_progress .m { color: var(--working); } .todol li.in_progress { font-weight: 600; }
.cbar { height: 7px; border-radius: 4px; background: var(--line); overflow: hidden; margin: 3px 0 5px; }
.cbar i { display: block; height: 100%; background: var(--working); }
.cbar.warn i { background: var(--blocked); } .cbar.full i { background: var(--danger); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; font-size: 12.5px; }
.kv > span:nth-child(odd) { color: var(--muted); }
.conv { display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow: auto; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--col); }
.msg { display: flex; gap: 8px; font-size: 12.5px; }
.msg .r { flex: none; width: 52px; color: var(--muted); font-size: 11px; text-transform: uppercase; padding-top: 1px; }
.msg .x { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.msg.user .r { color: var(--working); } .msg.tool .x { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.note { color: var(--muted); font-size: 12px; }
.reply textarea { width: 100%; min-height: 64px; resize: vertical; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--input); }
.reply .rr { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.err { color: var(--danger-text); font-size: 12px; }
.row2 { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.clash { margin: 0 0 6px; padding: 5px 8px; border-radius: 7px; background: color-mix(in srgb, var(--blocked) 12%, transparent); font-size: 12.5px; }
.clash small { display: block; color: var(--muted); margin-top: 2px; }
.clash .f { font-family: var(--mono); font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
.stage { color: var(--muted); font-size: 12px; } .stage .skipped { margin-left: 6px; padding: 0 6px; border: 1px solid var(--line); border-radius: 9px; }
.hidden { display: none !important; }
`;

/** The page's script. Plain JavaScript in String.raw (no backticks and no dollar-brace in it), so it can be tested as text. */
const SCRIPT = String.raw`
// Without an acquireVsCodeApi (neither VS Code nor the website's shim) the page only draws: it never posts to a window it cannot name.
const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => undefined };
const post = m => api.postMessage(m);
const MARK = { claude: ${JSON.stringify(ICON.claude)}, codex: ${JSON.stringify(ICON.codex)} };
${AVATAR_SCRIPT}

// ---- small helpers ---------------------------------------------------------------------------------------------------------
// h(): every piece of text goes through a text node, never through markup, so nothing a row says can become HTML.
function h(tag, props, ...kids) {
	const e = document.createElement(tag);
	if (props) {
		for (const k in props) {
			const v = props[k];
			if (v === undefined || v === null || v === false) { continue; }
			if (k === 'class') { e.className = v; }
			else if (k.slice(0, 2) === 'on') { e.addEventListener(k.slice(2), v); }
			else { e.setAttribute(k, v === true ? '' : String(v)); }
		}
	}
	for (const c of kids.flat(Infinity)) {
		if (c === undefined || c === null || c === false) { continue; }
		e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
	}
	return e;
}
// Markup built from constants only (the CLI marks and the avatar).
function raw(tag, cls, html) { const e = h(tag, { class: cls }); e.innerHTML = html; return e; }
const wipe = e => { while (e.firstChild) { e.removeChild(e.firstChild); } };
// Native append() takes neither arrays nor nulls, which the builders below use freely.
const add = (e, ...kids) => { for (const k of kids.flat(Infinity)) { if (k) { e.appendChild(k); } } };
const fill = (e, kids) => { wipe(e); add(e, kids); };
const dur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'; };
const until = ms => { const m = Math.max(0, Math.round(ms / 60000)); return m < 60 ? m + 'm' : m < 2880 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : Math.floor(m / 1440) + 'd ' + Math.floor(m % 1440 / 60) + 'h'; };
const tok = n => n >= 1e6 ? +(n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n);
const usd = n => n === 0 ? '$0' : n < 0.01 ? '<$0.01' : '$' + n.toFixed(n < 10 ? 2 : 1);
const sum = t => t.input + t.output + t.cacheRead + t.cacheWrite;
const spendText = x => tok(sum(x.tokens)) + ' tok' + (x.usd !== undefined ? ' · ' + usd(x.usd) + ' est.' : '');
const spendTip = (label, x) => label + ': ' + x.tokens.input.toLocaleString() + ' in, ' + x.tokens.output.toLocaleString() + ' out, ' + x.tokens.cacheRead.toLocaleString() + ' cache read, ' + x.tokens.cacheWrite.toLocaleString() + ' cache write' + (x.usd !== undefined ? ', $' + x.usd.toFixed(4) + ' est.' : '');
const LABEL = { working: 'Working', blocked: 'Needs you', done: 'Done', idle: 'Ready', starting: 'Starting', unknown: 'Running', ended: 'Closed' };
const NEED = { approval: 'Approval', question: 'Question', error: 'Error', done: 'Done' };
const CHECK = { pass: '✓ checks', fail: '✗ checks', pending: '● checks', none: '' };
const REVIEW = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };
const STAGE = { design: 'Design', skeleton: 'Skeleton', handover: 'Handover' };
const CLI_NAME = { claude: 'Claude Code', codex: 'Codex', custom: 'Custom' };

// ---- state -----------------------------------------------------------------------------------------------------------------
let data = { rows: [], kept: [], customs: [], now: Date.now(), avatar: 'gyro' };
let skew = 0; // the host's clock minus ours, so elapsed times tick between data messages
const now = () => Date.now() + skew;
let sel;
let view = 'board';
const filter = { q: '', cli: 'all', unread: false, wt: false, ended: false };
const tails = new Map();      // id -> { entries, note }
const tailAsked = new Map();  // id -> the state it was asked in
const drafts = new Map();     // id -> what is typed in the reply box
const sentText = new Map();   // id -> the last reply sent, put back when the host says it could not be typed in
const replyError = new Map();
let ticks = [];
let cardEls = new Map();
let openMenu = false;

// ---- derived ---------------------------------------------------------------------------------------------------------------
const rowById = id => data.rows.find(r => r.id === id);
// What the row waits for, as the host worked it out (attention.ts attentionKind): the page keeps no rule of its own.
const needKind = s => s.attention && s.attention !== 'done' ? s.attention : undefined;
function column(s) {
	if (s.state === 'ended') { return 'ended'; }
	if (needKind(s)) { return 'needs'; }
	if (s.state === 'working' || s.state === 'starting') { return 'working'; }
	return 'done';
}
const avState = s => s.state === 'ended' ? 'idle' : needKind(s) || (s.attention === 'done' ? 'done' : s.state === 'working' || s.state === 'starting' ? 'working' : 'idle');
const ctxPct = s => s.usage && s.usage.size ? Math.min(100, s.usage.percent !== undefined ? s.usage.percent : Math.round(s.usage.used / s.usage.size * 100)) : undefined;
const level = p => p >= 90 ? ' full' : p >= 70 ? ' warn' : '';
function stateText(s) {
	const t = now();
	if (column(s) === 'needs') { return LABEL.blocked + ' · ' + dur(t - ((s.need && s.need.at) || s.since)); }
	if (s.state === 'working' || s.state === 'starting' || s.state === 'blocked') { return LABEL[s.state] + ' · ' + dur(t - s.since); }
	if (s.state === 'done') { return 'Done ' + dur(t - s.since) + ' ago'; }
	return LABEL[s.state] || s.state;
}
function matches(s) {
	if (filter.cli !== 'all' && s.cli !== filter.cli) { return false; }
	if (filter.unread && !s.unread) { return false; }
	if (filter.wt && !s.worktree) { return false; }
	const q = filter.q.trim().toLowerCase();
	if (!q) { return true; }
	return [s.name, s.prompt, s.activity, s.cwd, s.worktree && s.worktree.branch, s.need && s.need.text, s.cli].some(x => x && String(x).toLowerCase().indexOf(q) >= 0);
}
function grouped() {
	const g = { needs: [], working: [], done: [], ended: [] };
	for (const s of data.rows) { if (matches(s)) { g[column(s)].push(s); } }
	g.needs.sort((a, b) => ((a.need && a.need.at) || a.since) - ((b.need && b.need.at) || b.since));
	for (const k of ['working', 'done', 'ended']) { g[k].sort((a, b) => b.since - a.since); }
	return g;
}
const orderOf = g => g.needs.concat(g.working, g.done, filter.ended ? g.ended : []);

// ---- the shell, built once -------------------------------------------------------------------------------------------------
const head = h('div', { class: 'head' });
const tools = h('div', { class: 'tools' });
const main = h('div', { class: 'main' });
const detail = h('aside', { class: 'detail', 'aria-label': 'Selected agent' });
const dTop = h('div'), dConv = h('div'), dReply = h('div', { class: 'sec reply hidden' }), dRest = h('div');
add(detail, dTop, dConv, dReply, dRest);
const boardEl = h('div'), keptEl = h('div');
add(main, boardEl, keptEl);
// Hidden until the first rows arrive: drawn empty first, the whole page would jump when they come (a layout shift), and the
// "No agents running" prompt would flash for agents that are running. Without a host it shows itself after a moment.
const root = h('div', { id: 'app' }, head, tools, h('div', { class: 'split' }, main, detail));
root.hidden = true;
const reveal = () => { root.hidden = false; };
setTimeout(reveal, 2000);
document.body.appendChild(root);

const search = h('input', { class: 'search', type: 'search', placeholder: 'Search agents  ( / )', 'aria-label': 'Search agents' });
search.addEventListener('input', () => { filter.q = search.value; paint(); });
const menu = h('div', { class: 'menu', role: 'menu', hidden: true });
const newBtn = (cli, label) => h('button', { type: 'button', class: 'btn primary', title: 'Start ' + label + ' in a new terminal', onclick: () => post({ type: 'new', cli }) }, raw('span', 'mk', MARK[cli]), label);
const moreBtn = h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: 'More ways to start an agent', onclick: e => { e.stopPropagation(); setMenu(!openMenu); } }, 'More ▾');
function setMenu(on) {
	openMenu = on;
	menu.hidden = !on;
	moreBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
	if (on) {
		const item = (label, msg) => h('button', { type: 'button', role: 'menuitem', onclick: () => { setMenu(false); post(msg); } }, label);
		fill(menu, [
			item('Claude in a worktree', { type: 'start', cli: 'claude', how: 'worktree' }),
			item('Codex in a worktree', { type: 'start', cli: 'codex', how: 'worktree' }),
			item('Resume a Claude session…', { type: 'start', cli: 'claude', how: 'resume' }),
			item('Resume a Codex session…', { type: 'start', cli: 'codex', how: 'resume' }),
			h('hr'),
			data.customs.map((n, i) => item(n, { type: 'custom', index: i, name: n })),
			data.customs.length ? h('hr') : null,
			item('Start an Agent…', { type: 'pick' }),
		]);
	}
}
const chip = (label, key, tip) => { const b = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', title: tip, onclick: () => { filter[key] = !filter[key]; paint(); } }, label); b.fkey = key; return b; };
const chips = [chip('Unread', 'unread', 'Only agents with something you have not looked at'), chip('Worktree', 'wt', 'Only agents in a worktree of their own'), chip('Show ended', 'ended', 'Show agents whose CLI has exited')];
const cliSel = h('select', { class: 'clisel', 'aria-label': 'Filter by CLI', onchange: () => { filter.cli = cliSel.value; paint(); } },
	h('option', { value: 'all' }, 'All CLIs'), h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'codex' }, 'Codex'), h('option', { value: 'custom' }, 'Custom'));
const viewBtn = (v, label) => { const b = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', onclick: () => { view = v; paint(); } }, label); b.view = v; return b; };
const viewBtns = [viewBtn('board', 'Board'), viewBtn('list', 'List')];
add(tools, h('div', { class: 'newwrap' }, newBtn('claude', 'Claude'), newBtn('codex', 'Codex'), moreBtn, menu), search, cliSel, chips, h('span', { class: 'grow' }), viewBtns);

// ---- header ----------------------------------------------------------------------------------------------------------------
function paintHead() {
	const g = { needs: 0, working: 0, done: 0 };
	let tokens = 0, dollars = 0, priced = false;
	for (const s of data.rows) {
		const c = column(s);
		if (g[c] !== undefined) { g[c]++; }
		if (s.cost) { tokens += sum(s.cost.session.tokens); if (s.cost.session.usd !== undefined) { dollars += s.cost.session.usd; priced = true; } }
	}
	const count = (n, label, color) => h('span', { class: 'count' }, h('i', { style: 'background:var(' + color + ')' }), h('b', null, String(n)), label);
	const lim = data.limits && data.limits.windows ? data.limits.windows.map(w => {
		const p = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
		return h('span', { class: 'lim' + (p >= 90 ? ' full' : p >= 70 ? ' warn' : ''), title: (data.limits.harness || 'Plan') + ' ' + w.label + ' limit: ' + p + '% used' },
			// Each part its own element: two text nodes side by side would form one flex item, and the gap would not part them.
			w.label, h('span', { class: 'bar' }, h('i', { style: 'width:' + p + '%' })), h('span', null, p + '%'), w.resetsAt ? h('span', null, 'resets in ' + until(w.resetsAt - now())) : null);
	}) : [];
	fill(head, [
		h('div', { class: 'counts' }, count(g.needs, 'Needs you', '--blocked'), count(g.working, 'Working', '--working'), count(g.done, 'Done', '--done')),
		data.rows.some(s => s.cost) ? h('span', { class: 'totals', title: 'Tokens and dollars are what the CLIs report for each session; dollars are estimates.' }, h('b', null, tok(tokens)), ' tokens' + (priced ? ' · ' : ''), priced ? h('b', null, usd(dollars)) : null, priced ? ' est.' : null) : null,
		lim.length ? h('div', { class: 'limits' }, lim) : null,
	]);
}

// ---- cards and rows --------------------------------------------------------------------------------------------------------
const avKept = new Map();
function avatar(s, big) {
	const pct = ctxPct(s);
	const key = [s.id, data.avatar, s.cli, avState(s), pct === undefined ? '' : pct, big ? 'b' : 's'].join('|');
	const old = avKept.get(key);
	if (old) { avKept.set(key, old); return old; }
	const e = raw('span', 'av' + (big ? ' big' : ''), window.insilodeAvatar(data.avatar, s.cli, avState(s), pct, big ? 34 : 24));
	avKept.set(key, e);
	return e;
}
const cliMark = s => MARK[s.cli] ? raw('span', 'mark', MARK[s.cli] + '') : h('span', { class: 'mark cust', title: s.command || 'custom agent' }, 'custom');
const markOf = s => { const e = cliMark(s); e.setAttribute('title', CLI_NAME[s.cli] || s.cli); return e; };
function prPill(s) {
	const p = s.pr;
	if (!p) { return null; }
	const tip = p.title + ' (' + p.state + ')' + (p.checks !== 'none' ? '\nChecks: ' + p.counts.pass + ' passed, ' + p.counts.fail + ' failed, ' + p.counts.pending + ' pending' + (p.failing.length ? '\nFailing: ' + p.failing.join(', ') : '') : '');
	return h('span', { class: 'pill pr-' + p.state, title: tip }, '#' + p.number + ' ' + p.state + (p.checks !== 'none' ? ' ' + CHECK[p.checks] : ''));
}
function costText(s) { return s.cost ? spendText(s.cost.session) : ''; }
function branchText(s) {
	const w = s.worktree;
	return w ? '⎇ ' + w.branch + (w.ahead !== undefined ? ' ↑' + w.ahead + ' ↓' + (w.behind || 0) : '') : '';
}
function wire(el, s) {
	el.addEventListener('click', () => select(s.id));
	el.addEventListener('dblclick', () => post({ type: 'show', id: s.id }));
	el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === el) { e.preventDefault(); e.stopPropagation(); post({ type: 'show', id: s.id }); } });
	el.setAttribute('data-id', s.id);
	cardEls.set(s.id, el);
}
function stateSpan(s) { const e = h('span', { class: 'state s-' + (needKind(s) || s.state) }, stateText(s)); ticks.push(() => { e.textContent = stateText(s); }); return e; }
function card(s) {
	const kind = needKind(s);
	const pct = ctxPct(s);
	const el = h('div', { class: 'card ' + s.state + (kind ? ' ' + kind : '') + (s.unread ? ' unread' : '') + (s.id === sel ? ' sel' : ''), tabindex: '0', role: 'button', 'aria-label': s.name + ', ' + stateText(s), title: 'Click to select, double-click or Enter to open' });
	wire(el, s);
	const needText = s.need ? s.need.text : kind === 'approval' ? s.activity : '';
	const done = s.todos.filter(t => t.status === 'completed').length;
	add(el,
		h('div', { class: 'top' }, avatar(s), h('span', { class: 'name' }, s.name), markOf(s), stateSpan(s)),
		s.prompt ? h('div', { class: 'prompt' }, s.prompt) : null,
		kind ? h('div', { class: 'need ' + kind }, h('span', { class: 'chip' }, NEED[kind]), needText ? h('span', { class: 't' }, needText) : null) : null,
		s.activity && !(s.need && s.activity === s.need.text) && !(kind === 'approval' && !s.need) ? h('div', { class: 'activity', title: s.activity }, s.activity) : null,
		s.todos.length ? h('div', { class: 'todos', title: done + ' of ' + s.todos.length + ' todos done' }, h('span', { class: 'segs' }, s.todos.slice(0, 14).map(t => h('span', { class: 'seg ' + t.status }))), done + '/' + s.todos.length) : null,
		h('div', { class: 'facts' },
			pct !== undefined ? h('span', { class: 'ctx' + level(pct), title: 'Context window ' + pct + '% full' }, 'ctx ' + pct + '%') : s.usage ? h('span', { class: 'ctx', title: 'Tokens in context' }, tok(s.usage.used) + ' ctx') : null,
			s.cost ? h('span', { title: spendTip('Session', s.cost.session) }, costText(s)) : null,
			prPill(s),
			s.worktree ? h('span', { class: 'mono', title: 'Worktree on ' + s.worktree.branch + ', from ' + s.worktree.base }, branchText(s)) : null,
			s.clash && s.clash.length ? h('span', { class: 'warnic', title: s.clash.map(c => c.text).join('\n') }, '⚠') : null));
	return el;
}
function lrow(s) {
	const kind = needKind(s);
	const pct = ctxPct(s);
	const el = h('div', { class: 'lrow ' + s.state + (kind ? ' ' + kind : '') + (s.unread ? ' unread' : '') + (s.id === sel ? ' sel' : ''), tabindex: '0', role: 'button', 'aria-label': s.name + ', ' + stateText(s) });
	wire(el, s);
	add(el,
		h('span', { class: 'nm' }, avatar(s), h('span', { class: 'name' }, s.name), s.clash && s.clash.length ? h('span', { class: 'warnic', title: s.clash.map(c => c.text).join('\n') }, '⚠') : null),
		h('span', null, markOf(s)),
		stateSpan(s),
		h('span', { title: (s.need ? s.need.text : s.activity) || s.prompt || '' }, (s.need ? s.need.text : s.activity) || s.prompt || ''),
		h('span', { class: 'ctx' + (pct !== undefined ? level(pct) : '') }, pct !== undefined ? pct + '%' : ''),
		h('span', null, costText(s)),
		h('span', null, prPill(s)),
		h('span', { class: 'mono', title: s.worktree ? s.worktree.branch : '' }, branchText(s)));
	return el;
}

function paintBoard() {
	const g = grouped();
	const total = data.rows.length;
	const focusId = [...cardEls].filter(([, e]) => e === document.activeElement).map(([id]) => id)[0];
	cardEls = new Map();
	if (!total) {
		fill(boardEl, [h('div', { class: 'empty' }, h('b', null, 'No agents running.'), h('p', null, 'Start one and it runs in a terminal like always. Here you see at a glance which agent is working, which one waits for you and which one is done.'),
			h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn primary', onclick: () => post({ type: 'new', cli: 'claude' }) }, raw('span', 'mk', MARK.claude), 'New Claude'), h('button', { type: 'button', class: 'btn primary', onclick: () => post({ type: 'new', cli: 'codex' }) }, raw('span', 'mk', MARK.codex), 'New Codex')))]);
		return;
	}
	if (view === 'list') {
		const out = [h('div', { class: 'lhead' }, h('span', null, 'Agent'), h('span', null, 'CLI'), h('span', null, 'State'), h('span', null, 'Activity'), h('span', null, 'Context'), h('span', null, 'Cost'), h('span', null, 'PR'), h('span', null, 'Branch'))];
		const all = orderOf(g);
		if (!all.length) { out.push(h('p', { class: 'note' }, 'No agents match the filters.')); }
		for (const s of all) { out.push(lrow(s)); }
		fill(boardEl, out);
	} else {
		const col = (key, title, color, empty) => {
			const rows = g[key];
			const collapsed = key === 'ended' && !filter.ended;
			const el = h('section', { class: 'colm ' + key + (collapsed ? ' collapsed' : ''), 'aria-label': title },
				h('h3', collapsed ? { onclick: () => { filter.ended = true; paint(); }, title: 'Show ended agents' } : null, h('i', { style: 'background:var(' + color + ')' }), title, h('span', { class: 'n' }, String(rows.length))));
			if (!collapsed) { add(el, rows.length ? rows.map(card) : h('div', { class: 'none' }, empty)); }
			return el;
		};
		fill(boardEl, [h('div', { class: 'board' },
			col('needs', 'Needs you', '--blocked', 'Nothing is waiting for you.'),
			col('working', 'Working', '--working', 'No agent is working.'),
			col('done', 'Done', '--done', 'Nothing finished yet.'),
			col('ended', 'Ended', '--ended', 'No ended agents.'))]);
	}
	if (focusId && cardEls.get(focusId)) { cardEls.get(focusId).focus(); }
}
function paintKept() {
	if (!data.kept.length) { fill(keptEl, []); return; }
	fill(keptEl, [h('div', { class: 'kept' },
		h('h3', null, 'Kept worktrees', h('button', { type: 'button', class: 'btn small', onclick: () => post({ type: 'kept' }), title: 'Open, merge or remove the worktrees kept after their agent left' }, 'Manage…')),
		data.kept.map(k => h('div', { class: 'krow', title: k.folder }, h('span', null, k.agent), h('span', { class: 'br' }, '⎇ ' + k.branch), h('span', null, 'from ' + k.base), h('span', null, k.folder))))]);
}

// ---- the detail panel ------------------------------------------------------------------------------------------------------
const section = (title, ...kids) => h('div', { class: 'sec' }, h('h4', null, title), kids);
const act = (label, msg, extra) => h('button', { type: 'button', class: 'btn small' + (extra && extra.cls ? ' ' + extra.cls : ''), title: extra && extra.tip, onclick: () => post(msg) }, label);

function paintDetail() {
	const s = sel ? rowById(sel) : undefined;
	if (!s) {
		fill(dTop, [h('p', { class: 'note' }, data.rows.length ? 'Select an agent to see its prompt, todos, conversation, PR and worktree. j / k move, Enter opens it.' : 'No agent selected.')]);
		fill(dConv, []); fill(dRest, []); dReply.className = 'sec reply hidden';
		return;
	}
	const pct = ctxPct(s);
	const kind = needKind(s);
	const canSwap = (s.cli === 'claude' || s.cli === 'codex') && ['idle', 'done', 'unknown'].indexOf(s.state) >= 0;
	const canCompact = s.usage && s.cli !== 'custom' && (s.state === 'idle' || s.state === 'done');
	const w = s.worktree;
	const done = s.todos.filter(t => t.status === 'completed').length;
	fill(dTop, [
		h('div', { class: 'dh' }, avatar(s, true),
			h('div', { class: 'nm' }, h('h2', null, s.name), h('div', { class: 'sub' }, markOf(s), CLI_NAME[s.cli] || s.cli, stateSpan(s), s.usage && s.usage.model ? s.usage.model : null)),
			h('button', { type: 'button', class: 'btn small', title: 'Rename', 'aria-label': 'Rename ' + s.name, onclick: () => post({ type: 'rename', id: s.id }) }, '✎ Rename')),
		s.cwd || w ? h('div', { class: 'sub mono', title: s.cwd || w.path }, (w ? '⎇ ' + w.branch + ' · ' : '') + (s.cwd || (w && w.path) || '')) : null,
		kind ? h('div', { class: 'need ' + kind }, h('span', { class: 'chip' }, NEED[kind]), h('span', { class: 't' }, (s.need ? s.need.text : s.activity) || '')) : null,
		s.activity && !kind ? h('div', { class: 'activity', title: s.activity }, s.activity) : null,
		s.prompt ? section('Prompt', h('p', null, s.prompt)) : null,
		s.todos.length ? section('Todos · ' + done + '/' + s.todos.length, h('ul', { class: 'todol' }, s.todos.map(t => h('li', { class: t.status }, h('span', { class: 'm' }, t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'), t.text)))) : null,
		s.usage ? section('Context', h('div', { class: 'cbar' + level(pct || 0) }, h('i', { style: 'width:' + (pct || 0) + '%' })),
			h('div', { class: 'row2' }, h('span', { class: 'note' }, pct !== undefined ? tok(s.usage.used) + ' / ' + tok(s.usage.size) + ' tokens (' + pct + '%)' : tok(s.usage.used) + ' tokens; the agent has not said how large its window is'),
				pct !== undefined ? act('X-ray', { type: 'xray', id: s.id }, { tip: 'What fills the context window?' }) : null)) : null,
		s.cost ? section('Cost', h('div', { class: 'kv' },
			s.cost.prompt ? [h('span', null, 'This prompt'), h('span', { title: spendTip('This prompt', s.cost.prompt) }, spendText(s.cost.prompt))] : null,
			h('span', null, s.cost.earlier ? 'Since resume' : 'Session'), h('span', { title: spendTip('Session', s.cost.session) }, spendText(s.cost.session)),
			s.cost.subagents ? [h('span', null, 'Subagents'), h('span', null, tok(sum(s.cost.subagents)) + ' tok')] : null),
			h('p', { class: 'note' }, 'Tokens of the ' + s.cost.scope + '.' + (s.cost.usdSource ? ' Dollars (est.): ' + s.cost.usdSource + '.' : ' No dollar figure: the CLI does not report one.'))) : null,
	]);
	paintConv(s);
	paintReply(s);
	const pr = s.pr;
	fill(dRest, [
		pr ? section('Pull request & CI', h('div', { class: 'kv' },
			h('span', null, '#' + pr.number), h('span', null, pr.title + ' (' + pr.state + ')'),
			h('span', null, 'Checks'), h('span', null, pr.checks === 'none' ? 'none' : pr.counts.pass + ' passed, ' + pr.counts.fail + ' failed, ' + pr.counts.pending + ' pending'),
			pr.failing.length ? [h('span', null, 'Failing'), h('span', { class: 'mono' }, pr.failing.join(', '))] : null,
			pr.reviewDecision ? [h('span', null, 'Review'), h('span', null, REVIEW[pr.reviewDecision] || pr.reviewDecision)] : null,
			pr.mergeable === 'CONFLICTING' ? [h('span', null, 'Merge'), h('span', { class: 'err' }, 'Has conflicts with its base')] : null),
			h('div', { class: 'row2', style: 'margin-top:6px' }, act('Open PR', { type: 'pr', id: s.id }, { tip: 'Open on GitHub' }))) : null,
		w ? section('Worktree', h('div', { class: 'kv' },
			h('span', null, 'Branch'), h('span', { class: 'mono' }, w.branch), h('span', null, 'Base'), h('span', { class: 'mono' }, w.base),
			w.ahead !== undefined ? [h('span', null, 'Commits'), h('span', null, '↑' + w.ahead + ' ahead · ↓' + (w.behind || 0) + ' behind')] : null,
			w.uncommitted ? [h('span', null, 'Uncommitted'), h('span', null, w.uncommitted + ' files')] : null),
			s.state === 'ended' ? h('p', { class: 'note' }, 'Forget this agent to keep, merge or remove its worktree.') : h('div', { class: 'row2', style: 'margin-top:6px' },
				act('Open', { type: 'wt', id: s.id, action: 'open' }, { tip: 'Open the worktree folder' }),
				act('Changes', { type: 'wt', id: s.id, action: 'diff' }, { tip: 'Show the changes of this branch since ' + w.base + ' in flow' }),
				// No confirm here: the host asks itself, with the commit count and what happens to uncommitted work (worktreeFlow.ts).
				act('Merge…', { type: 'wt', id: s.id, action: 'merge' }, { tip: 'Merge ' + w.branch + ' into ' + w.base + ' (asks first)' }),
				act('Remove…', { type: 'wt', id: s.id, action: 'remove' }, { tip: 'Remove the worktree folder; the branch stays (asks first)', cls: 'danger' }))) : null,
		s.clash && s.clash.length ? section('Conflicts', s.clash.map(c => h('div', { class: 'clash' }, '⚠ ' + c.text,
			c.same ? h('small', null, 'Same checkout: each writes over the edits of the other. Start agents that work in parallel in a worktree.') : null,
			c.files.length ? h('div', { class: 'f' }, c.files.join(', ')) : null))) : null,
		s.impact && (s.impact.flows.length || (s.impact.tables && s.impact.tables.length)) ? section('Impact',
			h('p', { class: 'note' }, 'This turn changed ' + s.impact.files + (s.impact.files === 1 ? ' file' : ' files') + (s.impact.more ? ' and reaches ' + s.impact.more + ' more flows' : '') + '.'),
			s.impact.flows.length ? h('div', { class: 'row2', style: 'margin-top:6px' }, s.impact.flows.map((f, i) => h('button', { type: 'button', class: 'btn small', title: f.via && f.via.length ? 'Through ' + f.via.join(', ') : 'Open on the canvas', onclick: () => post({ type: 'flow', id: s.id, index: i }) }, f.label))) : null,
			(s.impact.tables || []).map(t => h('p', { class: 'note' }, 'table ' + t.table + (t.guess ? '?' : '') + ' (' + (t.migration ? 'migration ' + t.migration + ', ' : '') + t.endpoints + (t.endpoints === 1 ? ' endpoint' : ' endpoints') + (t.partial ? ', partial' : '') + ')'))) : null,
		s.explain ? section('Review', h('div', { class: 'row2' }, act('Explain', { type: 'explain', id: s.id }, { tip: 'Ask the agent to explain what it just changed, as a tour on the flow canvas' }))) : null,
		s.skeletonAvailable ? section('Skeleton first', h('div', { class: 'row2' },
			h('button', { type: 'button', class: 'btn small', 'aria-pressed': s.skeletonOn ? 'true' : 'false', title: 'Skeleton first for this agent: when a change adds or changes types, the agent draws its design on a board and stops for you.', onclick: () => post({ type: 'sk', id: s.id, on: !s.skeletonOn }) }, s.skeletonOn ? 'On' : 'Off'),
			s.skeletonStage && STAGE[s.skeletonStage.stage] ? h('span', { class: 'stage' }, 'Stage ', h('b', null, STAGE[s.skeletonStage.stage]), s.skeletonStage.skipped ? h('span', { class: 'skipped' }, 'skipped') : null) : null)) : null,
		h('div', { class: 'sec row2' },
			act('Show', { type: 'show', id: s.id }, { tip: 'Bring its terminal (or chat) to the front', cls: 'primary' }),
			canSwap ? act('Swap to ' + (s.cli === 'claude' ? 'Codex' : 'Claude'), { type: 'swap', id: s.id }, { tip: 'Continue in the other CLI with this conversation' }) : null,
			canCompact ? act('Compact', { type: 'compact', id: s.id }, { tip: 'Send /compact: keeps a summary, frees most of the window' }) : null,
			s.state === 'ended' ? act('Forget', { type: 'forget', id: s.id }, { tip: 'Remove from the list' }) : null),
	]);
}
function paintConv(s) {
	const t = tails.get(s.id);
	const old = dConv.firstChild && dConv.firstChild.lastChild;
	// A repaint keeps where the reader scrolled to; a conversation already at its end stays at its end as it grows.
	const atEnd = !old || old.scrollTop === undefined || old.scrollTop + old.clientHeight >= old.scrollHeight - 4;
	const was = old && old.scrollTop;
	const body = !t ? h('p', { class: 'note' }, 'Loading…') : t.entries.length ? h('div', { class: 'conv', tabindex: '0', 'aria-label': 'Conversation' }, t.entries.map(m => h('div', { class: 'msg ' + m.role }, h('span', { class: 'r' }, m.role === 'assistant' ? 'agent' : m.role), h('span', { class: 'x' }, m.text)))) : h('p', { class: 'note' }, t.note || 'No messages yet.');
	fill(dConv, [h('div', { class: 'sec' }, h('h4', null, 'Conversation', h('button', { type: 'button', class: 'btn small', title: 'Read the conversation again', onclick: () => askTail(s.id, true) }, 'Refresh')), body)]);
	if (t && t.entries.length && body.scrollTop !== undefined) { body.scrollTop = atEnd ? body.scrollHeight : was; }
}
// The reply box is built once and kept: a repaint never touches what is typed in it.
const replyText = h('textarea', { rows: '3', placeholder: 'Reply to the agent… (Ctrl/Cmd+Enter to send; line breaks are sent as spaces)', 'aria-label': 'Reply to the agent', maxlength: '8000' });
const replyErr = h('span', { class: 'err', role: 'alert' });
const replyBtn = h('button', { type: 'button', class: 'btn small primary', onclick: () => sendReply() }, 'Send');
add(dReply, h('h4', null, 'Reply'), replyText, h('div', { class: 'rr' }, replyBtn, replyErr));
let replyFor;
function setReplyMsg(text, bad) { replyErr.textContent = text; replyErr.className = bad ? 'err' : 'note'; }
replyText.addEventListener('input', () => { if (replyFor) { drafts.set(replyFor, replyText.value); } setReplyMsg('', false); });
replyText.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendReply(); } });
function sendReply() {
	const text = replyText.value;
	if (!replyFor || !text.trim() || text.length > 8000) { return; }
	sentText.set(replyFor, text);
	replyError.delete(replyFor);
	post({ type: 'reply', id: replyFor, text });
	replyText.value = '';
	drafts.delete(replyFor);
	setReplyMsg('Sent.', false);
	const id = replyFor;
	setTimeout(() => { if (sel === id) { askTail(id, true); } }, 1500);
}
function paintReply(s) {
	const can = s.acceptsInput && s.state !== 'ended';
	dReply.className = 'sec reply' + (can ? '' : ' hidden');
	if (replyFor !== s.id) {
		replyFor = s.id;
		replyText.value = drafts.get(s.id) || '';
		setReplyMsg(replyError.get(s.id) || '', true);
	}
}
function askTail(id, force) {
	const s = rowById(id);
	if (!s) { return; }
	const key = s.state + '|' + s.since;
	if (!force && tailAsked.get(id) === key) { return; }
	tailAsked.set(id, key);
	post({ type: 'tail', id });
}

// ---- selection and painting ------------------------------------------------------------------------------------------------
function select(id) {
	if (id === sel) { return; }
	sel = id;
	if (id) { askTail(id, true); }
	for (const [cid, el] of cardEls) {
		const c = el.className.split(' ').filter(x => x !== 'sel');
		if (cid === id) { c.push('sel'); }
		el.className = c.join(' ');
	}
	paintDetail();
}
function paint() {
	if (sel && !rowById(sel)) { sel = undefined; }
	ticks = [];
	const mainTop = main.scrollTop, detTop = detail.scrollTop;
	paintHead();
	paintBoard();
	paintKept();
	paintDetail();
	for (const b of chips) { b.setAttribute('aria-pressed', filter[b.fkey] ? 'true' : 'false'); }
	for (const b of viewBtns) { b.setAttribute('aria-pressed', view === b.view ? 'true' : 'false'); }
	main.scrollTop = mainTop; detail.scrollTop = detTop;
	// Avatars no row uses any more are dropped, so the cache does not grow with every state change.
	const live = new Set();
	for (const s of data.rows) { live.add([s.id, data.avatar, s.cli, avState(s), ctxPct(s) === undefined ? '' : ctxPct(s), 's'].join('|')); live.add([s.id, data.avatar, s.cli, avState(s), ctxPct(s) === undefined ? '' : ctxPct(s), 'b'].join('|')); }
	for (const k of [...avKept.keys()]) { if (!live.has(k)) { avKept.delete(k); } }
}
setInterval(() => { for (const f of ticks) { f(); } }, 1000);

window.addEventListener('message', e => {
	const m = e.data;
	if (!m || typeof m !== 'object') { return; }
	if (m.type === 'data') {
		data = Object.assign({ rows: [], kept: [], customs: [] }, m);
		skew = typeof m.now === 'number' ? m.now - Date.now() : 0;
		paint();
		reveal();
		if (sel) { askTail(sel, false); }
		if (openMenu) { setMenu(true); }
	} else if (m.type === 'tail') {
		tails.set(m.id, { entries: Array.isArray(m.entries) ? m.entries : [], note: m.note });
		const s = sel === m.id ? rowById(m.id) : undefined;
		if (s) { paintConv(s); }
	} else if (m.type === 'replyFailed') {
		const text = sentText.get(m.id);
		replyError.set(m.id, 'The agent is not at its prompt, so the reply could not be typed in. Your text is kept.');
		if (text && !drafts.get(m.id)) { drafts.set(m.id, text); }
		if (replyFor === m.id) {
			setReplyMsg(replyError.get(m.id), true);
			if (!replyText.value && text) { replyText.value = text; }
		}
	}
});

// ---- keyboard --------------------------------------------------------------------------------------------------------------
const typing = t => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
document.addEventListener('keydown', e => {
	if (e.key === 'Escape') {
		if (openMenu) { setMenu(false); return; }
		if (typing(e.target)) { if (e.target.blur) { e.target.blur(); } return; }
		if (sel) { select(undefined); }
		return;
	}
	if (typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) { return; }
	const order = orderOf(grouped());
	const at = order.findIndex(s => s.id === sel);
	if (e.key === 'j' || e.key === 'ArrowDown' || e.key === 'k' || e.key === 'ArrowUp') {
		if (!order.length) { return; }
		e.preventDefault();
		const down = e.key === 'j' || e.key === 'ArrowDown';
		const next = order[at < 0 ? (down ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + (down ? 1 : -1)))];
		select(next.id);
		const el = cardEls.get(next.id);
		if (el && el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); }
	} else if (e.key === 'Enter') {
		if (e.target && e.target.tagName === 'BUTTON') { return; }
		if (sel) { post({ type: 'show', id: sel }); }
	} else if (e.key === 'r') {
		const s = sel ? rowById(sel) : undefined;
		if (s && s.acceptsInput && s.state !== 'ended') { e.preventDefault(); replyText.focus(); }
	} else if (e.key === '/') {
		e.preventDefault();
		search.focus();
	}
});
document.addEventListener('click', e => { if (openMenu && !menu.contains(e.target)) { setMenu(false); } });
paint();
post({ type: 'ready' });
`;

export function agentsHtml(): string {
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agents</title><style>${CSS}</style></head><body><script>${SCRIPT}</script></body></html>`;
}
