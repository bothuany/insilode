/*---------------------------------------------------------------------------------------------
 *  Insilode: the shell of the Agents page as script text (agentsPage.ts puts it into the page): the helpers, the state the host's data
 *  fills, the sidebar of sessions (every row can be dragged into the workspace), the toolbar (the launcher, the counts), the Board and List overviews, the menus,
 *  the messages from the host and the keyboard. The terminal workspace itself is agentsWorkspace.ts and runs in the same script scope.
 *  Text from a row only ever reaches the page through textContent (the h() helper): the only markup set as HTML is built from
 *  constants (the avatar, the CLI marks, the pane icons).
 *--------------------------------------------------------------------------------------------*/

export const SHELL_CSS = String.raw`
.counts { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.count { display: inline-flex; align-items: center; gap: 5px; color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.count b { color: var(--text); font-weight: 600; }
.count i { width: 8px; height: 8px; border-radius: 50%; }
.totals { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.totals b { color: var(--text); font-weight: 600; }
.limits { display: flex; flex-wrap: wrap; gap: 4px 14px; }
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
.seg2 { display: inline-flex; gap: 0; }
.seg2 .btn { border-radius: 0; margin-left: -1px; } .seg2 .btn:first-child { border-radius: 7px 0 0 7px; margin-left: 0; } .seg2 .btn:last-child { border-radius: 0 7px 7px 0; }
.menu { position: absolute; top: 100%; left: 0; margin-top: 3px; z-index: 20; min-width: 230px; padding: 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--vscode-menu-background, var(--bg)); color: var(--vscode-menu-foreground, var(--text)); box-shadow: 0 6px 18px rgb(0 0 0 / .35); }
.menu[hidden], .menu.hidden { display: none; }
.menu button { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 26px; padding: 0 10px; border: 0; border-radius: 5px; background: transparent; text-align: left; }
.menu button .hint { margin-left: auto; color: var(--muted); font-size: 11.5px; }
.menu button:hover, .menu button:focus-visible { background: var(--vscode-menu-selectionBackground, var(--hover)); }
.menu button:disabled { opacity: .5; }
.menu hr { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }

.split { display: flex; flex: 1; min-height: 0; }
.side { flex: 0 0 236px; overflow: auto; border-right: 1px solid var(--line); padding: 10px 8px 24px; background: var(--col); }
@media (max-width: 960px) { .side { flex-basis: 204px; } .tools { padding: 8px 12px; } }
.sebox { display: flex; gap: 6px; margin: 0 4px 10px; }
.sesearch { flex: 1; min-width: 0; box-sizing: border-box; height: 28px; padding: 0 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--input); }
.sresult .sact.snip { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
.snip mark { background: color-mix(in srgb, var(--focus) 30%, transparent); color: inherit; border-radius: 2px; }
.sgroup { margin: 0 0 14px; }
.shead { display: flex; align-items: center; gap: 6px; margin: 0 4px 4px; min-width: 0; }
.sproj { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slabel { margin: 4px 4px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.srow { display: flex; align-items: flex-start; gap: 8px; padding: 5px 8px; border: 1px solid transparent; border-radius: 7px; cursor: grab; min-width: 0; }
.srow:hover { background: var(--hover); }
.srow.sel { border-color: var(--focus); background: color-mix(in srgb, var(--focus) 12%, transparent); }
.srow.inpane { box-shadow: inset 2px 0 0 var(--focus); }
.srow.ended { opacity: .62; }
.srow:focus-visible { outline: 1.5px solid var(--focus); outline-offset: -1.5px; }
.sdot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: var(--idle); }
.sdot.working { background: var(--working); } .sdot.needs { background: var(--blocked); } .sdot.done { background: var(--done); }
.sdot.recent { background: transparent; border: 1.5px solid var(--working); }
.sdot.ended { background: transparent; border: 1.5px solid var(--ended); }
.xbadge { display: inline-block; margin-right: 4px; padding: 0 6px; border: 1px solid var(--line); border-radius: 9px; font-size: 10.5px; line-height: 15px; color: var(--muted); white-space: nowrap; }
.xbadge.est { border-style: dashed; }
.queue { display: flex; align-items: center; gap: 8px; flex: none; padding: 6px 10px; overflow-x: auto; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--blocked) 8%, var(--card)); }
.qlabel { flex: none; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--blocked); }
.qchip { display: inline-flex; align-items: center; gap: 7px; flex: none; max-width: 300px; height: 26px; padding: 0 10px; border: 1px solid color-mix(in srgb, var(--blocked) 45%, var(--line)); border-radius: 13px; background: var(--card); }
.qchip:hover { background: var(--hover); }
.qchip .sdot { margin-top: 0; }
.qchip .qt { min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qchip .qp { min-width: 0; color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (prefers-reduced-motion: no-preference) { .queue { animation: qin .16s ease-out; } }
@keyframes qin { from { max-height: 0; opacity: 0; padding-top: 0; padding-bottom: 0; } to { max-height: 60px; opacity: 1; } }
.sicon { flex: none; display: block; margin-top: 1px; }
.sglyph { flex: none; margin-top: 1px; }
.sbody { display: flex; flex: 1 1 auto; flex-direction: column; min-width: 0; }
.ssub { display: flex; gap: 4px; min-width: 0; color: var(--muted); font-size: 11.5px; }
.ssub .swhere { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ssub .ssep, .ssub .sstate { flex: none; white-space: nowrap; }
.plus { flex: none; width: 24px; padding: 0; justify-content: center; font-size: 15px; line-height: 1; }
.pop { position: fixed; z-index: 25; width: 300px; max-width: calc(100vw - 8px); max-height: 80vh; overflow: auto; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--vscode-menu-background, var(--bg)); color: var(--vscode-menu-foreground, var(--text)); box-shadow: 0 6px 18px rgb(0 0 0 / .35); }
.pop .slabel { margin: 8px 2px 4px; }
.pop .slabel:first-child { margin-top: 0; }
.popopt { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 26px; padding: 0 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; text-align: left; }
.popopt:hover { background: var(--hover); }
.popopt[aria-checked="true"] { border-color: var(--focus); background: color-mix(in srgb, var(--focus) 12%, transparent); }
.popopt:disabled { opacity: .5; cursor: default; }
.popopt .hint { margin-left: auto; color: var(--muted); font-size: 11.5px; }
.popopt .mk { display: inline-flex; }
.pline { display: flex; align-items: center; gap: 8px; margin: 0 2px; min-width: 0; }
.pline .pfold { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pop select { width: 100%; margin-top: 6px; }
.pop .pnote { margin: 4px 2px 0; color: var(--muted); font-size: 11.5px; }
.pop .pacts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; margin: 10px 2px 0; }
.pop .plink { padding: 0; border: 0; background: transparent; color: var(--focus); font-size: 12px; }
.pop .plink:hover { text-decoration: underline; }
.pop .plink:disabled { color: var(--muted); cursor: default; text-decoration: none; }
.pop .pstart { margin-left: auto; }
.sname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sact { color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srecent { margin: 0 0 8px; }
.srecent .sact { margin: 0 4px; }
.cmore { margin: 2px 4px 0; }
.main { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 12px 16px 24px; }
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 12px; }

.board { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; align-items: start; }
.colm { background: var(--col); border: 1px solid var(--line); border-radius: 10px; padding: 8px; min-width: 0; }
.colm h3 { margin: 2px 4px 8px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: flex; align-items: center; gap: 7px; }
.colm h3 i { width: 8px; height: 8px; border-radius: 50%; }
.colm h3 .n { margin-left: auto; font-variant-numeric: tabular-nums; }
.colm.collapsed h3 { margin: 0; cursor: pointer; }
.colm .none { color: var(--muted); padding: 6px 4px; font-size: 12px; }
.card { position: relative; display: block; margin: 0 0 8px; padding: 9px 10px; border: 1px solid transparent; border-radius: 9px; background: var(--card); cursor: pointer; min-width: 0; }
.card:hover { border-color: var(--line); }
.card.ended, .lrow.ended { opacity: .62; }
.card.unread .name::after, .lrow.unread .name::after { content: ""; display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--working); }
.card.blocked, .card.approval, .card.question, .card.error { border-color: color-mix(in srgb, var(--blocked) 45%, transparent); }
.top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.av { position: relative; flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: #000; }
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
.facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin-top: 7px; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.facts .pill { padding: 0 6px; border: 1px solid var(--line); border-radius: 9px; }
.pill.pr-open, .pill.pass { color: var(--done); } .pill.draft, .pill.pending { color: var(--idle); }
.pill.merged { color: var(--custom); } .pill.closed, .pill.fail { color: var(--danger-text); }
.warnic { color: var(--blocked); }
.ctx.warn { color: var(--blocked); } .ctx.full { color: var(--danger-text); }
.mono { font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.note { color: var(--muted); font-size: 12px; }
.row2 { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.lhead, .lrow { display: grid; grid-template-columns: minmax(150px, 1.2fr) 70px 110px minmax(120px, 2fr) 60px minmax(90px, 1fr) minmax(70px, .8fr) minmax(90px, 1fr); gap: 10px; align-items: center; padding: 6px 10px; }
.lhead { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid var(--line); }
.lrow { border: 1px solid transparent; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
.lrow:hover { background: var(--hover); }
.lrow > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lrow .nm { display: flex; align-items: center; gap: 8px; }
.kept { margin-top: 20px; }
.kept h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); display: flex; align-items: center; gap: 10px; margin: 0 0 6px; }
.krow { display: flex; gap: 14px; padding: 4px 8px; border-radius: 6px; font-size: 12.5px; }
.krow:hover { background: var(--hover); }
.krow span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.krow .br { font-family: var(--mono); }
.empty { max-width: 460px; margin: 60px auto; text-align: center; color: var(--muted); }
.empty b { color: var(--text); font-size: 15px; }
.dlg { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 16px; background: rgb(0 0 0 / .45); }
.dlgbox { width: min(520px, 100%); max-height: 100%; overflow: auto; padding: 16px 18px; border: 1px solid var(--line); border-radius: 10px; background: var(--vscode-menu-background, var(--bg)); color: var(--vscode-menu-foreground, var(--text)); box-shadow: 0 10px 30px rgb(0 0 0 / .45); }
.dlgbox h2 { margin: 0 0 12px; font-size: 15px; }
.klist { display: grid; gap: 7px; margin-bottom: 12px; }
.kr { display: grid; grid-template-columns: minmax(170px, max-content) 1fr; gap: 6px 16px; align-items: baseline; }
.kr .kbd { justify-self: start; white-space: nowrap; }
@media (max-width: 480px) { .kr { grid-template-columns: 1fr; } }
.hidden { display: none !important; }
`;

/** Plain JavaScript in String.raw (no backticks and no dollar-brace in it). Runs first; agentsWorkspace.ts's script follows in the same scope, then BOOT_SCRIPT. */
export const SHELL_SCRIPT = String.raw`
// Without an acquireVsCodeApi (neither VS Code nor the website's shim) the page only draws: it never posts to a window it cannot name.
const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => undefined };
const post = m => api.postMessage(m);

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
// Markup built from constants only (the CLI marks, the avatar and the pane icons).
function raw(tag, cls, html) { const e = h(tag, { class: cls }); e.innerHTML = html; return e; }
const wipe = e => { while (e.firstChild) { e.removeChild(e.firstChild); } };
// Native append() takes neither arrays nor nulls, which the builders below use freely.
const add = (e, ...kids) => { for (const k of kids.flat(Infinity)) { if (k) { e.appendChild(k); } } };
const fill = (e, kids) => { wipe(e); add(e, kids); };
const cls = (...a) => a.filter(Boolean).join(' ');
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
const CLI_NAME = { claude: 'Claude Code', codex: 'Codex', custom: 'Custom' };
const KIND_NAME = { claude: 'Claude', codex: 'Codex' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- the keyboard shortcuts ------------------------------------------------------------------------------------------------
// The modifier is the platform's: Ctrl+Alt on a Mac, where it types nothing (Option+Shift+letter types characters there: it is the only way to
// type a dotless i on the US layout), and Alt+Shift elsewhere (Ctrl+Alt is AltGr on Windows and Linux and types characters on Turkish and
// other layouts). The platform is the page's own: the webview runs in the browser the user looks at, which the host cannot tell.
const isMac = (() => { try { return typeof navigator !== 'undefined' && !!navigator && /Mac|iPhone|iPad/i.test(String(navigator.platform || navigator.userAgent || '')); } catch (x) { return false; } })();
const MOD = isMac ? 'Ctrl+Option+' : 'Alt+Shift+';
// Letters by the physical key (e.code): the keys that carry R D W M S N H have the same letters on a US and a Turkish Q keyboard, and a modifier may change what e.key says. Arrows and paging by what they are called (e.key).
const LETTER_CHORDS = new Map([['KeyR', 'splitRight'], ['KeyD', 'splitDown'], ['KeyW', 'close'], ['KeyM', 'max'], ['KeyS', 'sidebar'], ['KeyN', 'needs'], ['KeyH', 'harness']]);
const NAMED_CHORDS = new Map([['ArrowLeft', 'left'], ['ArrowRight', 'right'], ['ArrowUp', 'up'], ['ArrowDown', 'down'], ['PageUp', 'moveBack'], ['PageDown', 'moveFwd']]);
const chordOk = e => isMac ? !!e.ctrlKey && !!e.altKey && !e.shiftKey && !e.metaKey : !!e.altKey && !!e.shiftKey && !e.ctrlKey && !e.metaKey;
const chordOf = e => chordOk(e) ? (NAMED_CHORDS.get(e.key) || LETTER_CHORDS.get(e.code)) : undefined;
// What the "Keyboard shortcuts" dialog lists: the key (after the modifier) and what it does.
const SHORTCUTS = [['Arrow keys', 'Focus the pane in that direction'], ['R', 'Split right with the selected session'], ['D', 'Split down with the selected session'], ['W', 'Close the pane (its session keeps running)'], ['M', 'Maximize or restore the pane'],
	['PageUp / PageDown', 'Swap the pane with the previous or the next one'], ['S', 'Focus the session list'], ['N', 'Jump to the next session that needs you'], ['H', 'Show or hide the harness panel']];

// ---- state -----------------------------------------------------------------------------------------------------------------
let data = { rows: [], kept: [], customs: [], peers: [], recent: [], now: Date.now(), avatar: 'gyro' };
let skew = 0; // the host's clock minus ours, so elapsed times tick between data messages
const now = () => Date.now() + skew;
let view = 'work'; // 'work' (the terminal workspace), 'board' or 'list'
let selKey;        // the sidebar row last picked: the split shortcuts (R and D) open it
let selContent;    // a function making that row's pane content
const rowEls = new Map();
const filter = { q: '', cli: 'all', unread: false, wt: false, ended: false };
const tails = new Map(); // id -> { entries, note }
let ticks = [];
let cardEls = new Map();
// The earlier sessions of every project (host: projectIndex.ts) and the search through them.
const chat = { projects: [], got: false, more: new Set(), q: '', found: undefined };
let sseq = 0;      // counts the typing in the session search: a debounced post is sent only when no later keystroke came
let expect;        // a session started through the host's own commands (a worktree, a picker): the next new row of it opens in a pane

// ---- derived ---------------------------------------------------------------------------------------------------------------
const rowById = id => data.rows.find(r => r.id === id);
// A session of another window (the host sent it, validated): { p: its project, r: the row }.
function peerById(id) {
	for (const p of data.peers) { const r = p.rows.find(x => x.id === id); if (r) { return { p, r }; } }
	return undefined;
}
// The dot: the same ranking as the board's columns, for own rows and other windows' alike.
const dotOf = s => s.state === 'ended' ? 'idle' : needKind(s) ? 'needs' : s.state === 'working' || s.state === 'starting' ? 'working' : s.state === 'done' || s.attention === 'done' ? 'done' : 'idle';
const DOT_LABEL = { needs: 'needs you', working: 'working', done: 'done', idle: 'idle', recent: 'active recently', ended: 'ended' };
// The sidebar's dot, one scale for every row: working, needs you, idle or done (green), ended (a ring).
const rowDot = s => s.state === 'ended' ? 'ended' : needKind(s) ? 'needs' : s.state === 'working' || s.state === 'starting' ? 'working' : 'done';
const ago = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 2880 ? Math.floor(m / 60) + 'h ago' : Math.floor(m / 1440) + 'd ago'; };
function rowState(s) {
	if (s.state === 'ended') { return 'ended ' + ago(now() - s.since); }
	const d = rowDot(s);
	return d === 'needs' ? 'needs you' : d === 'working' ? 'working' : s.state === 'done' || s.attention === 'done' ? 'done' : 'idle';
}
// A session some other program runs (host: liveSessions.ts): Claude's status as that program wrote it, and for Codex only an estimate from its transcript.
const LIVE_DOT = { working: 'working', needs: 'needs', idle: 'done', unknown: 'idle' };
const LIVE_TEXT = { working: 'Working', needs: 'Needs you', idle: 'Idle', unknown: 'Running' };
const LIVE_STATUS = ['working', 'needs', 'idle', 'unknown'];
const liveOf = s => s && s.live && typeof s.live === 'object' ? s.live : undefined;
const liveDot = l => l.basis === 'recent' ? 'recent' : LIVE_DOT[l.status] || 'idle';
const liveTip = l => l.basis === 'recent' ? 'Active recently: its Codex transcript changed in the last 2 minutes. An estimate, since Codex lists no running sessions.' : 'Running in ' + l.source + ' on this computer: ' + (LIVE_TEXT[l.status] || 'Running').toLowerCase() + '. It is read-only here.';
// Only what a live mark may be reaches the page's state: it came from files any program can write.
const cleanLive = l => l && typeof l === 'object' && LIVE_STATUS.indexOf(l.status) >= 0 && typeof l.source === 'string' && l.source.length <= 80 && (l.basis === 'live' || l.basis === 'recent') ? { status: l.status, source: l.source, basis: l.basis } : undefined;
// A session of the machine's index (host: projectIndex.ts): { p: its project, s: the session }.
function indexed(kind, id) {
	for (const p of chat.projects) { const s = p.sessions.find(x => x.id === id && x.kind === kind); if (s) { return { p, s }; } }
	return undefined;
}
// Own rows carry the need as an object, other windows' as one line.
const actLine = s => (s.need && typeof s.need === 'object' ? s.need.text : s.need) || s.activity || s.prompt || LABEL[s.state] || '';
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

// What a pane shows for each kind of row (paneLayout.ts PaneContent). A session of this window is attached; one that ended is resumed by the CLI's own id.
const agentOf = cli => cli === 'claude' || cli === 'codex' ? cli : 'custom';
function ownContent(s) {
	const resume = UUID.test(s.agentId || '') ? s.agentId : UUID.test(s.id) ? s.id : undefined;
	return { kind: s.cli === 'custom' && s.state === 'ended' ? 'transcript' : 'terminal', agent: agentOf(s.cli), session: s.id, ...(resume ? { resume } : {}), ...(s.cwd ? { cwd: s.cwd } : {}), title: s.name };
}
// Another window's session cannot be owned: a read-only pane with a way to that window.
const peerContent = (p, r) => ({ kind: 'transcript', agent: agentOf(r.cli), session: r.id, title: r.name, folder: p.name, peer: p.key });
// A session of the machine's index that another program runs: read-only here (two processes on one session would corrupt it), with a way to resume once it stops.
const extContent = (p, kind, id, title, l) => ({ kind: 'transcript', agent: kind, session: id, resume: id, cwd: p.cwd, folder: p.name, title, ext: l.basis === 'recent' ? 'Codex' : l.source });
// An earlier session of the machine's index: started again in its folder, this window's own included (a pane keeps the folder it belongs to, so a saved layout applied in another project still resumes there), unless something runs it right now.
function indexContent(p, kind, id, title) {
	const x = indexed(kind, id);
	const l = x && liveOf(x.s);
	return l ? extContent(p, kind, id, title, l) : { kind: 'terminal', agent: kind, resume: id, cwd: p.cwd, folder: p.name, title };
}

// ---- menus: one at a time, under the button that opened it -----------------------------------------------------------------
// items: { label, run, hint, danger, disabled } | { sep } | { note } | { form } (the layout name) | { label, run, remove: { label, run } }
const menuEl = h('div', { class: 'menu fixed hidden', role: 'menu' });
let menuState;
let menuButtons = [];
function menuNode(it) {
	if (it.sep) { return h('hr'); }
	if (it.note) { return h('p', { class: 'mnote' }, it.note); }
	if (it.form) {
		const input = h('input', { type: 'text', maxlength: '60', placeholder: 'Save this layout as…', 'aria-label': 'Name for the layout' });
		const save = h('button', { type: 'button', onclick: () => { if (saveLayoutAs(input.value)) { closeMenu(true); } } }, 'Save');
		input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (saveLayoutAs(input.value)) { closeMenu(true); } } });
		menuButtons.push(input);
		return h('div', { class: 'mform' }, input, save);
	}
	const b = h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : null, disabled: it.disabled || null, onclick: () => { closeMenu(false); it.run(); } }, it.label, it.hint ? h('span', { class: 'hint' }, it.hint) : null);
	menuButtons.push(b);
	if (!it.remove) { return b; }
	const x = h('button', { type: 'button', class: 'x', role: 'menuitem', title: it.remove.label, 'aria-label': it.remove.label, onclick: () => { closeMenu(false); it.remove.run(); } }, '×');
	menuButtons.push(x);
	return h('div', { class: 'mrow' }, b, x);
}
function showMenu(anchor, build) {
	if (menuState && menuState.anchor === anchor) { return closeMenu(false); }
	closeMenu(false);
	closeLauncher(false);
	menuState = { anchor };
	anchor.setAttribute('aria-expanded', 'true');
	menuButtons = [];
	fill(menuEl, build().map(menuNode));
	menuEl.className = 'menu fixed';
	const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 0, bottom: 0 };
	menuEl.style.left = Math.max(4, Math.min(r.left, (window.innerWidth || 1200) - 270)) + 'px';
	menuEl.style.top = (r.bottom + 3) + 'px';
	const first = menuButtons.find(b => !b.disabled);
	if (first && first.focus) { first.focus(); }
}
function closeMenu(refocus) {
	if (!menuState) { return; }
	const a = menuState.anchor;
	menuState = undefined;
	a.setAttribute('aria-expanded', 'false');
	menuEl.className = 'menu fixed hidden';
	wipe(menuEl);
	if (refocus && a.focus) { a.focus(); }
}
menuEl.addEventListener('keydown', e => {
	const live = menuButtons.filter(b => !b.disabled);
	const at = live.indexOf(document.activeElement);
	if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
		e.preventDefault();
		const next = live[(at + (e.key === 'ArrowDown' ? 1 : -1) + live.length) % live.length];
		if (next && next.focus) { next.focus(); }
	} else if (e.key === 'Tab') { closeMenu(false); }
});

// ---- the launcher: one popover for every way to start an agent -------------------------------------------------------------
// Built once per open and changed in place (a rebuild would detach the node a click came from, and the document's click handler would close it).
const launchEl = h('div', { class: 'pop hidden', role: 'dialog', 'aria-label': 'New session' });
const launch = { open: false, anchor: undefined, key: undefined, pick: undefined }; // pick: { req, apply } of the folder dialog the host was asked to open
const OTHER_FOLDER = '::other-folder::'; // the folder list's own entry, not a path (every path is absolute)
let pickSeq = 0;
// The host's answer to a pickFolder: used only by the launcher that asked for it, once, and only while it is still open.
function folderPicked(m) {
	const p = launch.pick;
	if (!p || !launch.open || typeof m.requestId !== 'string' || m.requestId !== p.req) { return; }
	launch.pick = undefined;
	if (typeof m.path === 'string' && m.path && m.path.length <= 1024 && typeof m.name === 'string') { p.apply(m.path, m.name); }
}
const plusEls = new Map(); // project key -> its "+" button, so the focus can come back to the one the sidebar drew last
// The projects the sidebar knows, this window's first: a folder to start in.
function launchProjects(extra) {
	const out = [];
	const seen = new Set();
	const one = (cwd, name, where) => { if (cwd && !seen.has(cwd)) { seen.add(cwd); out.push({ cwd, name, where: where || cwd }); } };
	if (data.project) { one(data.project.cwd, data.project.name, data.project.cwd); }
	for (const p of chat.projects) { one(p.cwd, p.name, p.where); }
	if (extra) { one(extra, base(extra), extra); }
	return out;
}
function closeLauncher(refocus) {
	if (!launch.open) { return; }
	const a = (launch.key && plusEls.get(launch.key)) || launch.anchor;
	launch.open = false;
	launch.pick = undefined;
	launchEl.className = 'pop hidden';
	wipe(launchEl);
	for (const e of [launch.anchor, a]) { if (e && e.setAttribute) { e.setAttribute('aria-expanded', 'false'); } }
	if (refocus && a && a.focus) { a.focus(); }
}
// preset: { cwd, name, key } when a project's "+" opened it; otherwise the folder starts as the focused pane's project, else this window's.
function openLauncher(anchor, preset) {
	if (launch.open && (launch.anchor === anchor || (preset && launch.key === preset.key))) { return closeLauncher(true); }
	closeLauncher(false);
	closeMenu(false);
	const winCwd = (data.project && data.project.cwd) || '';
	const st = { cli: 'claude', cwd: preset ? preset.cwd : hFocusCwd(), worktree: false };
	const projects = launchProjects(st.cwd);
	const nameOf = cwd => { const p = projects.find(x => x.cwd === cwd); return p ? p.name : cwd ? base(cwd) : (data.project && data.project.name) || 'This window'; };
	const isWin = () => !st.cwd || st.cwd === winCwd;
	const isCustom = () => st.cli.indexOf('custom:') === 0;
	const cliOf = () => isCustom() ? 'custom' : st.cli;
	const harnesses = [{ k: 'claude', label: 'Claude Code' }, { k: 'codex', label: 'Codex' }].concat(data.customs.map((n, i) => ({ k: 'custom:' + i, label: n, custom: i })));
	const hBtns = harnesses.map(x => h('button', { type: 'button', role: 'radio', class: 'popopt', 'data-k': 'h:' + x.k, onclick: () => { st.cli = x.k; sync(); } }, MARK[x.k] ? raw('span', 'mk', MARK[x.k]) : null, x.label));
	const worktree = h('button', { type: 'button', role: 'switch', class: 'popopt', 'data-k': 'worktree', onclick: () => { st.worktree = !st.worktree; sync(); } }, 'Worktree', h('span', { class: 'hint' }));
	const wnote = h('p', { class: 'pnote' });
	const foldEl = h('span', { class: 'pfold' });
	// Another project than this window's is named by its whole path: a name alone could be any folder, and the agent starts there on one click.
	const pathEl = h('p', { class: 'pnote' });
	const otherOpt = h('option', { value: OTHER_FOLDER }, 'Other folder…');
	const optOf = p => h('option', { value: p.cwd }, p.name + (p.where && p.where !== p.name ? '  ' + p.where : ''));
	const sel = h('select', { class: 'clisel hidden', 'aria-label': 'Folder to start in' }, projects.map(optOf), otherOpt);
	const change = h('button', { type: 'button', class: 'btn small', 'data-k': 'change', onclick: () => { sel.className = sel.className.indexOf('hidden') >= 0 ? 'clisel' : 'clisel hidden'; if (sel.className === 'clisel' && sel.focus) { sel.focus(); } } }, 'Change…');
	sel.addEventListener('change', () => {
		sel.className = 'clisel hidden';
		if (sel.value === OTHER_FOLDER) {
			// The host opens the folder dialog; the answer names the folder it allowed, and only the request made here is taken.
			const req = 'f' + (++pickSeq) + '-' + Date.now().toString(36);
			launch.pick = { req, apply: (cwd, name) => {
				if (!projects.some(x => x.cwd === cwd)) { const np = { cwd, name, where: cwd }; projects.push(np); fill(sel, projects.map(optOf).concat(otherOpt)); }
				st.cwd = cwd;
				sync();
			} };
			sync();
			post({ type: 'pickFolder', requestId: req });
			return;
		}
		st.cwd = sel.value;
		sync();
	});
	// Permissions: each agent's "do not ask" mode is a machine setting the host applies to every session of that agent started afterwards, so this row shows that setting and flips it.
	// Claude's offers bypass permissions mode (sessions still start asking); Codex's starts sessions that never ask, with its workspace sandbox kept.
	const permsGroup = (cli, how, on, k, t) => {
		const flip = () => { closeLauncher(true); post({ type: 'start', cli, how }); };
		return h('div', { role: 'radiogroup', 'aria-label': 'Permissions', class: cli === 'claude' ? null : 'hidden', 'data-cli': cli },
			h('button', { type: 'button', role: 'radio', 'aria-checked': on ? 'false' : 'true', class: 'popopt', 'data-k': k.ask, title: on ? t.offTitle : null, onclick: on ? flip : null }, 'Ask each time'),
			on
				? h('button', { type: 'button', role: 'radio', 'aria-checked': 'true', class: 'popopt', 'data-k': k.on, title: t.onTitle }, t.label, h('span', { class: 'hint' }, t.hint))
				: h('button', { type: 'button', class: 'plink', 'data-k': k.allow, title: t.allowTitle, onclick: flip }, t.allow));
	};
	const claudePerms = permsGroup('claude', 'bypass', !!data.bypass, { ask: 'ask', on: 'bypass', allow: 'allow' }, { label: 'Bypass permissions', hint: 'offered', allow: 'Allow bypass permissions mode…', offTitle: 'Stop offering bypass permissions mode in the Claude sessions you start from now on', onTitle: 'Claude sessions you start offer bypass permissions mode (Shift+Tab); they still start asking', allowTitle: 'Offer bypass permissions mode in Claude sessions; the editor asks you to confirm' });
	const codexPerms = permsGroup('codex', 'neverAsk', !!data.neverAsk, { ask: 'cask', on: 'neverask', allow: 'callow' }, { label: 'Never ask (sandboxed)', hint: 'on', allow: 'Never ask (sandboxed)…', offTitle: 'Codex sessions you start from now on ask before they edit files or run commands', onTitle: 'Codex sessions you start do not ask before they edit files or run commands; they stay inside their workspace sandbox', allowTitle: 'Start Codex sessions without asking, inside their workspace sandbox; the editor asks you to confirm' });
	const perms = h('div', { class: 'perms' }, h('div', { class: 'slabel' }, 'Permissions'), claudePerms, codexPerms);
	const resume = h('button', { type: 'button', class: 'plink', 'data-k': 'resume', onclick: () => { const cli = st.cli; closeLauncher(false); expectNew(cli); post({ type: 'start', cli, how: 'resume' }); } }, 'Resume a session…');
	const agent = h('button', { type: 'button', class: 'plink', 'data-k': 'agent', onclick: () => { closeLauncher(false); expectNew(undefined); post({ type: 'pick' }); } }, 'Start an Agent…');
	const go = h('button', { type: 'button', class: 'btn primary pstart', 'data-k': 'start', onclick: () => {
		const cli = cliOf();
		closeLauncher(false);
		if (isCustom()) { const i = Number(st.cli.slice(7)); expectNew('custom'); post({ type: 'custom', index: i, name: data.customs[i] }); }
		else if (st.worktree) { expectNew(cli); post({ type: 'start', cli, how: 'worktree' }); }
		else { startNew(cli, st.cwd || undefined, st.cwd ? nameOf(st.cwd) : undefined); }
	} }, 'Start');
	function sync() {
		// Worktrees and the user's own agents start through the editor's own commands, which take no folder: only this window's.
		if (!isWin() && isCustom()) { st.cli = 'claude'; }
		const wtOk = isWin() && !isCustom();
		if (!wtOk) { st.worktree = false; }
		hBtns.forEach((b, i) => { b.setAttribute('aria-checked', harnesses[i].k === st.cli ? 'true' : 'false'); if (harnesses[i].custom !== undefined) { if (isWin()) { b.removeAttribute('disabled'); } else { b.setAttribute('disabled', ''); } b.setAttribute('title', isWin() ? '' : 'Your own agents start in this window\'s project'); } });
		worktree.setAttribute('aria-checked', st.worktree ? 'true' : 'false');
		worktree.lastChild.textContent = st.worktree ? 'On' : 'Off';
		if (wtOk) { worktree.removeAttribute('disabled'); } else { worktree.setAttribute('disabled', ''); }
		wnote.textContent = wtOk ? '' : isCustom() ? 'Your own agents have no worktree.' : 'A worktree starts from this window\'s project.';
		wnote.className = wnote.textContent ? 'pnote' : 'pnote hidden';
		foldEl.textContent = nameOf(st.cwd);
		foldEl.setAttribute('title', st.cwd || (data.project && data.project.name) || '');
		pathEl.textContent = isWin() ? '' : st.cwd;
		pathEl.className = isWin() ? 'pnote hidden' : 'pnote';
		sel.value = st.cwd;
		perms.className = st.cli === 'claude' || st.cli === 'codex' ? 'perms' : 'perms hidden';
		claudePerms.className = st.cli === 'claude' ? '' : 'hidden';
		codexPerms.className = st.cli === 'codex' ? '' : 'hidden';
		resume.className = isCustom() ? 'plink hidden' : 'plink';
		// Resume and the agent picker are the editor's own, for this window's project: with another folder chosen they would not act on it.
		for (const b of [resume, agent]) { if (isWin()) { b.removeAttribute('disabled'); b.setAttribute('title', ''); } else { b.setAttribute('disabled', ''); b.setAttribute('title', 'Only in this window\'s project'); } }
	}
	fill(launchEl, [h('div', { class: 'slabel' }, 'Harness'), h('div', { role: 'radiogroup', 'aria-label': 'Harness' }, hBtns),
		h('div', { class: 'slabel' }, 'Folder'), h('div', { class: 'pline' }, foldEl, change), pathEl, sel,
		h('div', { class: 'slabel' }, 'Options'), worktree, wnote, perms,
		h('div', { class: 'pacts' }, resume, agent, go)]);
	sync();
	launch.open = true;
	launch.anchor = anchor;
	launch.key = preset ? preset.key : undefined;
	anchor.setAttribute('aria-expanded', 'true');
	launchEl.className = 'pop';
	const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 0, bottom: 0 };
	launchEl.style.left = Math.max(4, Math.min(r.left, (window.innerWidth || 1200) - 310)) + 'px';
	launchEl.style.top = (r.bottom + 3) + 'px';
	if (hBtns[0].focus) { hBtns[0].focus(); }
}
// Tab leaving either end of the popover closes it, as it does a menu; Escape is the document's.
launchEl.addEventListener('keydown', e => {
	if (e.key !== 'Tab') { return; }
	const live = Array.from(launchEl.querySelectorAll('button:not([disabled]), select:not([disabled])')).filter(n => n.offsetParent !== null);
	const at = live.indexOf(document.activeElement);
	if (live.length && ((!e.shiftKey && at === live.length - 1) || (e.shiftKey && at === 0))) { closeLauncher(true); }
});

// The keyboard shortcuts dialog (filled by showShortcuts).
const shortcutsEl = h('div', { class: 'dlg hidden', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' });
shortcutsEl.addEventListener('click', e => { if (e.target === shortcutsEl) { closeShortcuts(); } });
let shortcutsFrom;

// ---- the shell, built once -------------------------------------------------------------------------------------------------
const side = h('nav', { class: 'side', 'aria-label': 'Projects and sessions' });
const tools = h('div', { class: 'tools' });
const work = h('div', { class: 'work' });
const filters = h('div', { class: 'filters' });
const boardEl = h('div'), keptEl = h('div');
const main = h('div', { class: 'main hidden' }, filters, boardEl, keptEl);
// Hidden until the first rows arrive: drawn empty first, the whole page would jump when they come (a layout shift). Without a host it shows itself after a moment.
// The Harness panel (agentsHarnessPanel.ts) sits right of the workspace and fills itself; hidden until it is asked for.
const harnessPanel = h('aside', { class: 'hpanel hidden', 'aria-label': 'Harness' });
const root = h('div', { id: 'app' }, tools, h('div', { class: 'split' }, side, work, main, harnessPanel), menuEl, launchEl, shortcutsEl);
root.hidden = true;
const reveal = () => { root.hidden = false; };
setTimeout(reveal, 2000);
document.body.appendChild(root);

// The search through earlier sessions (host: chatSearch / chatFound), shown once the host has answered chatList, so a page with no host never offers it.
const sesearch = h('input', { class: 'sesearch', type: 'search', placeholder: 'Search past sessions', 'aria-label': 'Search past sessions', maxlength: '200' });
const endedBtn = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', title: 'Also list sessions whose CLI has exited', onclick: () => { filter.ended = !filter.ended; paint(); } }, 'Ended');
const sebox = h('div', { class: 'sebox hidden' }, sesearch, endedBtn);
const sideList = h('div');
add(side, sebox, sideList);
sesearch.addEventListener('input', () => {
	const q = sesearch.value.trim();
	const mine = ++sseq;
	chat.found = undefined;
	chat.q = q.length >= 2 ? q : '';
	paintSide();
	// The host also needs two characters; one that arrives while typing goes out only when the typing paused.
	if (chat.q) { setTimeout(() => { if (mine === sseq) { post({ type: 'chatSearch', query: q }); } }, 250); }
});

// The toolbar: the launcher, the counts, the harness panel, the three views and the "…" menu (layouts, help).
const newBtn = h('button', { type: 'button', class: 'btn primary', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Start an agent: choose the harness, the folder and how it starts', onclick: e => { e.stopPropagation(); openLauncher(newBtn); } }, '+ New session');
// Started by the host's own commands (a worktree, a picker), which give back no id: the next new session of that kind opens in a pane.
const expectNew = cli => { expect = { cli, known: new Set(data.rows.map(r => r.id)), until: Date.now() + 60000 }; };
const viewBtn = (v, label, tip) => { const b = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', title: tip, onclick: () => setView(v) }, label); b.view = v; return b; };
const viewBtns = [viewBtn('work', 'Workspace', 'Terminal panes you can split and rearrange'), viewBtn('board', 'Board', 'Agents by what they wait for'), viewBtn('list', 'List', 'Agents as a table')];
// The Harness panel's toggle (agentsHarnessPanel.ts) and the "…" menu: the saved layouts and the help that have no place of their own in the toolbar.
const harnessBtn = h('button', { type: 'button', class: 'btn', 'aria-pressed': 'false', title: 'Show the harness of the focused pane\'s project: instructions, hooks, permissions, MCP servers (' + MOD + 'H)', onclick: () => toggleHarness() }, 'Harness');
const dotsBtn = h('button', { type: 'button', class: 'btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Layouts and help', title: 'Layouts and help', onclick: e => { e.stopPropagation(); showMenu(dotsBtn, dotsItems); } }, '⋯');
const dotsItems = () => [{ note: 'Layouts: save the panes, or apply a saved set' }, ...layoutItems(), { sep: true }, { label: 'Keyboard shortcuts', run: () => showShortcuts() }];
// What paintHead fills: the counts by state, the token and dollar totals and the plan's limits.
const countsEl = h('div', { class: 'counts', role: 'status', 'aria-label': 'Sessions by state' });
const totalsEl = h('span', { class: 'totals hidden' });
const limitsEl = h('div', { class: 'limits hidden' });
add(tools, newBtn, countsEl, harnessBtn, h('span', { class: 'grow' }), totalsEl, limitsEl, h('div', { class: 'seg2', role: 'group', 'aria-label': 'View' }, viewBtns), dotsBtn);

// The shortcuts, listed with the platform's own modifier. A dialog, so it can be read at leisure; Escape or Close puts it away.
function showShortcuts() {
	const close = h('button', { type: 'button', class: 'btn small primary', onclick: () => closeShortcuts() }, 'Close');
	fill(shortcutsEl, [h('div', { class: 'dlgbox' }, h('h2', null, 'Keyboard shortcuts'),
		h('div', { class: 'klist' }, SHORTCUTS.map(k => h('div', { class: 'kr' }, h('span', { class: 'kbd' }, MOD + k[0]), h('span', { class: 'kt' }, k[1])))),
		h('p', { class: 'note' }, 'They work inside a terminal too, and are not sent to the agent.'), h('div', { class: 'row2' }, close))]);
	shortcutsEl.className = 'dlg';
	shortcutsFrom = document.activeElement;
	if (close.focus) { close.focus(); }
}
function closeShortcuts() {
	shortcutsEl.className = 'dlg hidden';
	wipe(shortcutsEl);
	if (shortcutsFrom && shortcutsFrom.focus) { shortcutsFrom.focus(); }
	shortcutsFrom = undefined;
}
function setView(v) {
	if (view === v) { return; }
	view = v;
	closeMenu(false);
	closeLauncher(false);
	paint();
	if (v === 'work') { for (const pv of ws.views.values()) { scheduleFit(pv); } }
}

// Board and List filters.
const search = h('input', { class: 'search', type: 'search', placeholder: 'Search agents  ( / )', 'aria-label': 'Search agents' });
search.addEventListener('input', () => { filter.q = search.value; paint(); });
const chip = (label, key, tip) => { const b = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', title: tip, onclick: () => { filter[key] = !filter[key]; paint(); } }, label); b.fkey = key; return b; };
const chips = [chip('Unread', 'unread', 'Only agents with something you have not looked at'), chip('Worktree', 'wt', 'Only agents in a worktree of their own'), chip('Show ended', 'ended', 'Show agents whose CLI has exited')];
const cliSel = h('select', { class: 'clisel', 'aria-label': 'Filter by CLI', onchange: () => { filter.cli = cliSel.value; paint(); } },
	h('option', { value: 'all' }, 'All CLIs'), h('option', { value: 'claude' }, 'Claude'), h('option', { value: 'codex' }, 'Codex'), h('option', { value: 'custom' }, 'Custom'));
add(filters, search, cliSel, chips);

// ---- sidebar: every project, the ones with a live session first, then by the latest activity --------------------------------
// Every row is draggable into the workspace (dragRow) and opens in the focused pane on a click or Enter.
function pickRow(key, contentFn) {
	selKey = key;
	selContent = contentFn;
	for (const [k, el] of rowEls) { el.className = el.className.split(' ').filter(c => c !== 'sel').concat(k === key ? ['sel'] : []).join(' '); }
	openInPane(contentFn());
}
function rowEl(key, contentFn, label, kids, extra) {
	const el = h('div', { class: cls('srow', extra, key === selKey && 'sel', isOpen(contentFn()) && 'inpane'), tabindex: '0', role: 'button', 'aria-label': label, 'data-key': key, title: 'Click to open in the focused pane, or drag it into the workspace' }, kids);
	el.addEventListener('click', () => pickRow(key, contentFn));
	el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); pickRow(key, contentFn); } });
	dragRow(el, contentFn);
	rowEls.set(key, el);
	return el;
}
// The harness's mark, at the row's right end.
const glyphOf = cli => MARK[cli] ? raw('span', 'sglyph', MARK[cli] + '') : h('span', { class: 'sglyph mark cust', title: 'custom agent' }, 'custom');
// One shape for every session, own, another window's, another program's or ended: a state dot, the name, the harness's mark and a muted line
// "where it runs or the CLI, then the state and when". The state has a place that never shrinks, so only the place's name is cut when the row is narrow.
function sessRow(key, content, label, o) {
	const el = rowEl(key, content, label, [h('i', { class: 'sdot ' + o.dot, title: o.dotTip || DOT_LABEL[o.dot] }),
		h('span', { class: 'sbody' }, h('span', { class: 'sname', title: o.name }, o.name),
			h('span', { class: 'ssub', title: o.where + ' · ' + o.state + (o.tip ? '\n' + o.tip : '') }, h('span', { class: 'swhere' }, o.where), h('span', { class: 'ssep' }, '·'), h('span', { class: 'sstate' }, o.state))),
		glyphOf(o.cli)], o.extra);
	return el;
}
function srow(s, content, key) {
	const dot = rowDot(s);
	return sessRow(key, content, s.name + ', ' + DOT_LABEL[dot], { dot, name: s.name, cli: s.cli, where: CLI_NAME[s.cli] || s.cli, state: rowState(s), tip: actLine(s), extra: s.state === 'ended' ? 'ended' : '' });
}
const xbadge = l => h('span', { class: 'xbadge' + (l.basis === 'recent' ? ' est' : ''), title: liveTip(l) }, l.basis === 'recent' ? 'active recently' : 'external · ' + l.source);
// A session of the machine's index: one another program runs says where and in what state; an earlier one says it ended and when.
function crow(p, s) {
	const key = 'idx:' + s.kind + ':' + s.id;
	const l = liveOf(s);
	const content = () => indexContent(p, s.kind, s.id, s.title);
	if (l) {
		const recent = l.basis === 'recent';
		const state = recent ? 'active recently' : LIVE_TEXT[l.status].toLowerCase();
		return sessRow(key, content, KIND_NAME[s.kind] + ' session: ' + s.title + ', ' + (recent ? 'active recently' : 'running in ' + l.source + ', ' + LIVE_TEXT[l.status].toLowerCase()),
			{ dot: liveDot(l), dotTip: liveTip(l), name: s.title, cli: s.kind, where: recent ? 'Codex' : l.source, state, extra: 'crow ext' });
	}
	return sessRow(key, content, KIND_NAME[s.kind] + ' session: ' + s.title, { dot: 'ended', name: s.title, cli: s.kind, where: CLI_NAME[s.kind], state: 'ended ' + ago(now() - s.modified), extra: 'crow' });
}
// The earlier sessions of a project: the newest five, and every one that runs elsewhere (it is counted above, so it must show).
function chatRows(key) {
	const p = chat.projects.find(x => x.key === key);
	if (!p) { return null; }
	const open = chat.more.has(key);
	const list = open ? p.sessions : p.sessions.filter((s, i) => i < 5 || liveOf(s));
	const hidden = p.sessions.length - list.length;
	return [list.map(s => crow(p, s)),
		hidden > 0 || (open && p.sessions.length > 5) ? h('button', { type: 'button', class: 'btn small cmore', onclick: () => { if (open) { chat.more.delete(key); } else { chat.more.add(key); } paintSide(); } }, open ? 'Show fewer' : 'Show ' + hidden + ' more') : null];
}
// The snippet is transcript text: text nodes only, the match in a <mark> built here. Folded as the host does (sessionSearch.ts fold):
// the same length as the text, so the index found in the folded copy cuts the original at the right place.
const fold = s => s.replace(/[İı]/g, 'i').toLowerCase();
function snippet(text, q) {
	const needle = fold(q.replace(/\s+/g, ' '));
	const at = fold(text).indexOf(needle);
	return at < 0 ? h('span', { class: 'sact snip' }, text) : h('span', { class: 'sact snip' }, text.slice(0, at), h('mark', null, text.slice(at, at + needle.length)), text.slice(at + needle.length));
}
function searchResults() {
	const f = chat.found;
	if (!f) { return h('p', { class: 'note', role: 'status' }, 'Searching…'); }
	if (!f.hits.length) { return h('p', { class: 'note', role: 'status' }, f.cut ? 'No match in the sessions searched; the search stopped early.' : 'No past session mentions "' + chat.q + '".'); }
	const out = [];
	const groups = new Map();
	for (const hit of f.hits) {
		if (!groups.has(hit.project)) { groups.set(hit.project, []); }
		groups.get(hit.project).push(hit);
	}
	for (const [key, hits] of groups) {
		const p = chat.projects.find(x => x.key === key);
		out.push(h('div', { class: 'sgroup sresult' }, h('div', { class: 'shead' }, h('span', { class: 'sproj', title: p ? p.where : '' }, p ? p.name : 'Project')),
			p ? hits.map(hit => rowEl('hit:' + hit.kind + ':' + hit.session, () => indexContent(p, hit.kind, hit.session, hit.title), KIND_NAME[hit.kind] + ' session: ' + hit.title,
				[raw('span', 'sicon', MARK[hit.kind]), h('span', { class: 'sbody' }, h('span', { class: 'sname', title: hit.title }, hit.title), snippet(hit.snippet, chat.q), h('span', { class: 'sact' }, KIND_NAME[hit.kind] + ' · ' + ago(now() - hit.modified)))], 'crow')) : null));
	}
	if (f.more) { out.push(h('p', { class: 'note' }, (f.cut ? 'The search stopped early, so older sessions may match too. ' : '') + 'Showing the newest matches. Type more to narrow the search.')); }
	return out;
}
// A project's header: its name, one "+" that opens the launcher on its folder (when the folder is known) and whatever opens its window.
function projectHead(name, where, key, cwd, extra) {
	const plus = cwd ? h('button', { type: 'button', class: 'btn small plus', title: 'New session in ' + name, 'aria-label': 'New session in ' + name, 'aria-haspopup': 'dialog', 'aria-expanded': launch.open && launch.key === key ? 'true' : 'false' }, '+') : null;
	if (plus) {
		plus.addEventListener('click', e => { e.stopPropagation(); openLauncher(plus, { cwd, name, key }); });
		plusEls.set(key, plus);
	}
	return h('div', { class: 'shead' }, h('span', { class: 'sproj', title: where }, name), plus, extra);
}
function paintSide() {
	// A row being dragged must stay in the page until the drop: the repaint waits for it.
	if (typeof ws !== 'undefined' && ws.drag) { ws.dirty = true; return; }
	const keep = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-key') : undefined;
	const keepPlus = [...plusEls].filter(([, e]) => e === document.activeElement).map(([k]) => k)[0];
	rowEls.clear();
	plusEls.clear();
	const shown = rows => rows.filter(s => filter.ended || s.state !== 'ended');
	const pick = (label, msg, tip) => h('button', { type: 'button', class: 'btn small', title: tip, onclick: () => post(msg) }, label);
	const cwdOf = key => { const c = chat.projects.find(x => x.key === key); return c ? c.cwd : undefined; };
	const ownChat = chat.projects.find(p => p.own);
	// One entry per project: what to draw, and what orders it (a live session, then the latest activity).
	const items = [{ rows: data.rows, chatKey: ownChat && ownChat.key, draw: () => h('div', { class: 'sgroup' },
		projectHead((data.project && data.project.name) || 'This window', 'This window', 'own', (data.project && data.project.cwd) || (ownChat && ownChat.cwd)),
		shown(data.rows).map(s => srow(s, () => ownContent(s), 'row:' + s.id)), ownChat ? chatRows(ownChat.key) : null) }];
	// Every open project, with or without sessions: the sidebar is also the way to jump between the open project windows.
	for (const p of data.peers) {
		items.push({ rows: p.rows, chatKey: p.key, draw: () => { const list = shown(p.rows); return h('div', { class: 'sgroup' },
			projectHead(p.name, p.name, p.key, cwdOf(p.key), pick('Open in IDE', { type: 'peer', action: 'ide', key: p.key }, 'Bring up the window of ' + p.name)),
			list.length ? list.map(s => srow(s, () => peerContent(p, s), 'peer:' + s.id)) : h('p', { class: 'note' }, 'No sessions'), chatRows(p.key)); } });
	}
	for (const p of data.recent) {
		items.push({ rows: [], chatKey: p.key, draw: () => h('div', { class: 'srecent' },
			projectHead(p.name, p.name, p.key, cwdOf(p.key), pick('Open project', { type: 'peer', action: 'ide', key: p.key }, 'Open ' + p.name + ' in a window')),
			h('div', { class: 'sact', title: p.sessions.join(', ') }, p.sessions.join(', ') + ' (closed)'), chatRows(p.key)) });
	}
	// Projects the agents have worked in that this window does not know as open or recent.
	const known = new Set(data.peers.map(p => p.key).concat(data.recent.map(p => p.key)));
	for (const p of chat.projects.filter(x => !x.own && !known.has(x.key))) {
		items.push({ rows: [], chatKey: p.key, draw: () => h('div', { class: 'sgroup' }, projectHead(p.name, p.where, p.key, p.cwd), chatRows(p.key)) });
	}
	for (const it of items) {
		const cp = chat.projects.find(x => x.key === it.chatKey);
		const cs = cp ? cp.sessions : [];
		it.live = it.rows.some(r => r.state !== 'ended') || cs.some(x => { const l = liveOf(x); return l && l.basis === 'live'; });
		it.at = Math.max(0, ...it.rows.map(r => r.since || 0), ...cs.map(x => x.modified || 0));
	}
	items.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.at - a.at);
	sebox.className = cls('sebox', !chat.got && 'hidden');
	endedBtn.setAttribute('aria-pressed', filter.ended ? 'true' : 'false');
	fill(sideList, chat.q ? searchResults() : items.map(it => it.draw()));
	const again = keep ? rowEls.get(keep) : keepPlus ? plusEls.get(keepPlus) : undefined;
	if (again && again.focus) { again.focus(); }
}

// ---- header ----------------------------------------------------------------------------------------------------------------
// Sessions other programs run (Claude's own list of running ones; Codex has none): the ones the sidebar shows with a state of their own.
// A session that this window or another Insilode window runs is an agent row already (under any id its conversation has had): never counted twice.
function externalLive() {
	const out = [];
	const ours = new Set([...data.rows, ...data.peers.flatMap(p => p.rows)].flatMap(r => [r.id, r.agentId, ...(r.aliases || [])]));
	for (const p of chat.projects) { for (const s of p.sessions) { const l = liveOf(s); if (l && l.basis === 'live' && !ours.has(s.id)) { out.push({ p, s, l }); } } }
	return out;
}
// The counts and the totals in the toolbar. The counts take the other windows' sessions and the ones other programs run, so they never say less than the list.
function paintHead() {
	const g = { needs: 0, working: 0, done: 0 };
	let tokens = 0, dollars = 0, priced = false;
	for (const s of data.rows.concat(...data.peers.map(p => p.rows))) {
		const c = column(s);
		if (g[c] !== undefined) { g[c]++; }
	}
	for (const x of externalLive()) {
		const k = x.l.status === 'needs' ? 'needs' : x.l.status === 'working' ? 'working' : x.l.status === 'idle' ? 'done' : undefined;
		if (k) { g[k]++; }
	}
	for (const s of data.rows) {
		if (s.cost) { tokens += sum(s.cost.session.tokens); if (s.cost.session.usd !== undefined) { dollars += s.cost.session.usd; priced = true; } }
	}
	const count = (n, label, color, tip) => n ? h('span', { class: 'count', title: tip || null }, h('i', { style: 'background:var(' + color + ')' }), h('b', null, String(n)), ' ' + label) : null;
	fill(countsEl, [count(g.working, 'working', '--working', 'Sessions working'), count(g.needs, 'needs you', '--blocked', 'Sessions waiting for you, here or elsewhere on this computer (' + MOD + 'N jumps to the next)'), count(g.done, 'done', '--done', 'Sessions that are idle or done')]);
	const lim = data.limits && data.limits.windows ? data.limits.windows.map(w => {
		const p = Math.max(0, Math.min(100, Math.round(w.usedPercent)));
		return h('span', { class: 'lim' + (p >= 90 ? ' full' : p >= 70 ? ' warn' : ''), title: (data.limits.harness || 'Plan') + ' ' + w.label + ' limit: ' + p + '% used' },
			// Each part its own element: two text nodes side by side would form one flex item, and the gap would not part them.
			w.label, h('span', { class: 'bar' }, h('i', { style: 'width:' + p + '%' })), h('span', null, p + '%'), w.resetsAt ? h('span', null, 'resets in ' + until(w.resetsAt - now())) : null);
	}) : [];
	const withCost = data.rows.some(s => s.cost);
	totalsEl.className = withCost ? 'totals' : 'totals hidden';
	totalsEl.setAttribute('title', 'Tokens and dollars are what the CLIs report for each session; dollars are estimates.');
	fill(totalsEl, withCost ? [h('span', null, h('b', null, tok(tokens)), ' tokens' + (priced ? ' · ' : ''), priced ? h('b', null, usd(dollars)) : null, priced ? ' est.' : null)] : []);
	limitsEl.className = lim.length ? 'limits' : 'limits hidden';
	fill(limitsEl, lim);
}

// ---- cards and rows of the Board and List ----------------------------------------------------------------------------------
const avKept = new Map();
function avatar(s) {
	const pct = ctxPct(s);
	const key = [s.id, data.avatar, s.cli, avState(s), pct === undefined ? '' : pct].join('|');
	const old = avKept.get(key);
	if (old) { avKept.set(key, old); return old; }
	const e = raw('span', 'av', window.insilodeAvatar(data.avatar, s.cli, avState(s), pct, 24));
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
const costText = s => s.cost ? spendText(s.cost.session) : '';
function branchText(s) {
	const w = s.worktree;
	return w ? '⎇ ' + w.branch + (w.ahead !== undefined ? ' ↑' + w.ahead + ' ↓' + (w.behind || 0) : '') : '';
}
// A click or Enter opens the agent in the workspace, which takes the page over from the overview.
function wire(el, s) {
	const open = () => { selKey = 'row:' + s.id; selContent = () => ownContent(s); openInPane(ownContent(s)); };
	el.addEventListener('click', open);
	el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === el) { e.preventDefault(); e.stopPropagation(); open(); } });
	el.setAttribute('data-id', s.id);
	cardEls.set(s.id, el);
}
function stateSpan(s) { const e = h('span', { class: 'state s-' + (needKind(s) || s.state) }, stateText(s)); ticks.push(() => { e.textContent = stateText(s); }); return e; }
function card(s) {
	const kind = needKind(s);
	const pct = ctxPct(s);
	const el = h('div', { class: 'card ' + s.state + (kind ? ' ' + kind : '') + (s.unread ? ' unread' : ''), tabindex: '0', role: 'button', 'aria-label': s.name + ', ' + stateText(s), title: 'Click or press Enter to open it in the workspace' });
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
	const el = h('div', { class: 'lrow ' + s.state + (kind ? ' ' + kind : '') + (s.unread ? ' unread' : ''), tabindex: '0', role: 'button', 'aria-label': s.name + ', ' + stateText(s) });
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
		fill(boardEl, [h('div', { class: 'empty' }, h('b', null, 'No agents running in this window.'), h('p', null, 'Start one in the workspace: it runs in a terminal pane here. This overview shows at a glance which agent is working, which one waits for you and which one is done.'))]);
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

// ---- the attention queue ---------------------------------------------------------------------------------------------------
// A slim strip above the panes: the sessions that wait for the user, in this window, in the other windows and in other programs. Empty, it is not there.
const queueEl = h('div', { class: 'queue hidden', role: 'region', 'aria-label': 'Sessions that need you' });
let qsig = '', qcursor;
// Claude sessions that other programs run and that say they wait for the user (Claude's "waiting" status); Codex has no such status.
const externalWaiting = () => externalLive().filter(x => x.l.status === 'needs');
// Each item: { key, title, project, run } in the order they are worked: this window's longest-waiting first, then the other windows', then the other programs'.
function queueItems() {
	const items = [];
	const since = s => (s.need && s.need.at) || s.since;
	const open = content => { const pv = findPane(content); if (pv) { setView('work'); setFocus(pv.id, true); } else { openInPane(content); } };
	for (const s of data.rows.filter(r => column(r) === 'needs').sort((a, b) => since(a) - since(b))) {
		items.push({ key: 'own:' + s.id, title: s.name, project: (data.project && data.project.name) || 'This window', run: () => open(ownContent(s)) });
	}
	for (const p of data.peers) {
		for (const s of p.rows.filter(r => column(r) === 'needs').sort((a, b) => since(a) - since(b))) {
			// Another window's session cannot be owned here: the pane is its read-only copy, and the way in is that window.
			items.push({ key: 'peer:' + s.id, title: s.name, project: p.name, run: () => { const pv = findPane(peerContent(p, s)); if (pv) { setView('work'); setFocus(pv.id, true); } else { post({ type: 'peer', action: 'ide', key: p.key, id: s.id }); } } });
		}
	}
	for (const x of externalWaiting()) {
		items.push({ key: 'ext:' + x.s.kind + ':' + x.s.id, title: x.s.title, project: x.p.name, run: () => open(indexContent(x.p, x.s.kind, x.s.id, x.s.title)) });
	}
	return items;
}
function paintQueue() {
	const items = queueItems();
	const sig = JSON.stringify(items.map(i => [i.key, i.title, i.project]));
	if (sig === qsig) { return; }
	qsig = sig;
	// A strip that is built again would take the focus from the chip the keyboard is on.
	const keep = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-q') : undefined;
	fill(queueEl, items.length ? [h('b', { class: 'qlabel' }, 'Needs you · ' + items.length),
		items.map(i => { const b = h('button', { type: 'button', class: 'qchip', 'data-q': i.key, title: 'Open ' + i.title + ' (' + i.project + ')', 'aria-label': i.title + ', ' + i.project + ', needs you', onclick: () => { qcursor = i.key; i.run(); } }, h('i', { class: 'sdot needs' }), h('span', { class: 'qt' }, i.title), h('span', { class: 'qp' }, i.project)); return b; })] : []);
	queueEl.className = items.length ? 'queue' : 'queue hidden';
	const again = keep ? Array.from(queueEl.children).find(e => e.getAttribute('data-q') === keep) : undefined;
	if (again && again.focus) { again.focus(); }
}
// The N shortcut: the next session that needs the user, round and round the queue.
function jumpToNext() {
	const items = queueItems();
	if (!items.length) { notice('Nothing is waiting for you.'); return; }
	const next = items[(items.findIndex(i => i.key === qcursor) + 1) % items.length];
	qcursor = next.key;
	next.run();
}

// ---- painting --------------------------------------------------------------------------------------------------------------
function paint() {
	ticks = [];
	const mainTop = main.scrollTop;
	paintSide();
	paintHead();
	paintQueue();
	if (view !== 'work') { paintBoard(); paintKept(); }
	work.className = cls('work', view !== 'work' && 'hidden');
	main.className = cls('main', view === 'work' && 'hidden');
	for (const b of chips) { b.setAttribute('aria-pressed', filter[b.fkey] ? 'true' : 'false'); }
	for (const b of viewBtns) { b.setAttribute('aria-pressed', view === b.view ? 'true' : 'false'); }
	main.scrollTop = mainTop;
	paintWorkspace();
	harnessSync();
	// Avatars no row uses any more are dropped, so the cache does not grow with every state change.
	const live = new Set();
	for (const s of data.rows) { live.add([s.id, data.avatar, s.cli, avState(s), ctxPct(s) === undefined ? '' : ctxPct(s)].join('|')); }
	for (const k of [...avKept.keys()]) { if (!live.has(k)) { avKept.delete(k); } }
}
setInterval(() => { for (const f of ticks) { f(); } }, 1000);

// A session started through the host's own commands shows up as a new row: it opens in a pane of its own.
function adoptNew() {
	if (!expect) { return; }
	if (Date.now() > expect.until) { expect = undefined; return; }
	const fresh = data.rows.find(r => !expect.known.has(r.id) && r.state !== 'ended' && (!expect.cli || r.cli === expect.cli));
	if (fresh) { expect = undefined; openBeside(ownContent(fresh), 'right'); }
}

window.addEventListener('message', e => {
	const m = e.data;
	if (!m || typeof m !== 'object') { return; }
	if (m.type === 'data') {
		data = Object.assign({ rows: [], kept: [], customs: [], peers: [], recent: [] }, m);
		skew = typeof m.now === 'number' ? m.now - Date.now() : 0;
		paint();
		reveal();
		adoptNew();
	} else if (m.type === 'folderPicked') {
		folderPicked(m);
	} else if (wsMessage(m)) {
		return;
	} else if (m.type === 'chatIndex') {
		chat.projects = Array.isArray(m.projects) ? m.projects.map(p => p && Array.isArray(p.sessions) ? Object.assign({}, p, { sessions: p.sessions.map(s => { const c = Object.assign({}, s); const live = cleanLive(s && s.live); if (live) { c.live = live; } else { delete c.live; } return c; }) }) : p) : [];
		chat.got = true;
		paintSide();
		paintHead();
		paintQueue();
		// What runs elsewhere may have changed: the read-only panes say so, and read the conversation again.
		refreshExtPanes();
	} else if (m.type === 'chatFound') {
		// An answer to an earlier query, or to one that was cleared since, is not for what is typed now.
		if (m.query !== chat.q || !Array.isArray(m.hits)) { return; }
		chat.found = { hits: m.hits.filter(x => x && typeof x.project === 'string' && typeof x.session === 'string').map(x => ({ project: x.project, kind: x.kind === 'codex' ? 'codex' : 'claude', session: x.session, title: String(x.title || ''), modified: Number(x.modified) || 0, snippet: String(x.snippet || '') })), more: !!m.more, cut: !!m.cut };
		paintSide();
	}
});

// ---- keyboard --------------------------------------------------------------------------------------------------------------
const typing = t => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
// xterm's own input element is a textarea: keys typed there belong to the agent (Escape included), never to the page.
const inTerm = t => !!(t && t.className && String(t.className).indexOf('xterm') >= 0);
document.addEventListener('keydown', e => {
	if (e.isComposing || e.keyCode === 229) { return; }
	if (wsKey(e)) { return; }
	if (e.key === 'Escape') {
		if (shortcutsEl.className.indexOf('hidden') < 0) { closeShortcuts(); return; }
		if (launch.open) { closeLauncher(true); return; }
		if (menuState) { closeMenu(true); return; }
		if (inTerm(e.target)) { return; }
		if (typing(e.target) && e.target.blur) { e.target.blur(); }
		return;
	}
	if (inTerm(e.target) || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) { return; }
	if (e.key === '/') {
		e.preventDefault();
		(view === 'work' ? sesearch : search).focus();
		return;
	}
	// j and k move through the cards of the Board and the rows of the List.
	if (view === 'work' || (e.key !== 'j' && e.key !== 'k' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) { return; }
	const order = orderOf(grouped());
	if (!order.length) { return; }
	e.preventDefault();
	const at = order.findIndex(s => cardEls.get(s.id) === document.activeElement);
	const down = e.key === 'j' || e.key === 'ArrowDown';
	const next = order[at < 0 ? (down ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + (down ? 1 : -1)))];
	const el = cardEls.get(next.id);
	if (el) { el.focus(); if (el.scrollIntoView) { el.scrollIntoView({ block: 'nearest' }); } }
});
document.addEventListener('click', e => {
	if (menuState && !menuEl.contains(e.target) && !menuState.anchor.contains(e.target)) { closeMenu(false); }
	if (launch.open && !launchEl.contains(e.target) && !(launch.anchor && launch.anchor.contains(e.target))) { closeLauncher(false); }
});
`;

/** The last statements: everything above is defined by now. */
export const BOOT_SCRIPT = String.raw`
render();
paint();
post({ type: 'ready' });
`;
