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
.side { flex: 0 0 236px; overflow: auto; border-right: 1px solid var(--line); padding: 10px 8px 24px; background: var(--col); }
.sebox { margin: 0 4px 10px; }
.sesearch { width: 100%; box-sizing: border-box; height: 28px; padding: 0 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--input); }
.sresult .sact.snip { white-space: normal; overflow: visible; overflow-wrap: anywhere; }
.snip mark { background: color-mix(in srgb, var(--focus) 30%, transparent); color: inherit; border-radius: 2px; }
.sgroup { margin: 0 0 14px; }
.shead { display: flex; align-items: center; gap: 6px; margin: 0 4px 4px; min-width: 0; }
.sproj { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slabel { margin: 4px 4px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.srow { display: flex; align-items: flex-start; gap: 8px; padding: 5px 8px; border: 1px solid transparent; border-radius: 7px; cursor: pointer; min-width: 0; }
.srow:hover { background: var(--hover); }
.srow.sel { border-color: var(--focus); background: color-mix(in srgb, var(--focus) 12%, transparent); }
.srow.ended { opacity: .62; }
.srow:focus-visible { outline: 1.5px solid var(--focus); outline-offset: -1.5px; }
.sdot { flex: none; width: 8px; height: 8px; margin-top: 5px; border-radius: 50%; background: var(--idle); }
.sdot.working { background: var(--working); } .sdot.needs { background: var(--blocked); } .sdot.done { background: var(--done); }
.sbody { display: flex; flex-direction: column; min-width: 0; }
.sname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sact { color: var(--muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.srecent { margin: 0 0 8px; }
.srecent .sact { margin: 0 4px; }
.main { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 12px 16px 24px; }
.detail { flex: 0 0 420px; max-width: 46%; overflow: auto; border-left: 1px solid var(--line); padding: 14px 16px 28px; }
@media (max-width: 1000px) {
	body { overflow: auto; } #app { height: auto; }
	.split { flex-direction: column; }
	.side { flex: none; max-height: 260px; border-right: 0; border-bottom: 1px solid var(--line); }
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

.cstart { display: flex; gap: 6px; margin: 2px 4px 6px; }
.crow .sglyph { flex: none; width: 8px; margin-top: 1px; color: var(--muted); font-size: 11px; line-height: 1.4; }
.cmore { margin: 2px 4px 0; }
.chat { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.chathead { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--line); min-width: 0; }
.chathead .nm { flex: 1; min-width: 0; }
.chathead h2 { margin: 0; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chatlog { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
.chatlog .cb { min-width: 0; }
.cmsg { max-width: 860px; overflow-wrap: anywhere; }
.cmsg.user { align-self: flex-end; max-width: min(760px, 88%); padding: 7px 11px; border-radius: 10px; background: color-mix(in srgb, var(--focus) 16%, transparent); white-space: pre-wrap; }
.cmsg p { margin: 0 0 8px; white-space: pre-wrap; }
.cmsg p:last-child, .cmsg ul:last-child { margin-bottom: 0; }
.cmsg h1, .cmsg h2, .cmsg h3, .cmsg h4, .cmsg h5, .cmsg h6 { margin: 10px 0 6px; font-size: 14px; }
.cmsg h1 { font-size: 16px; }
.cmsg ul { margin: 0 0 8px; padding-left: 20px; }
.cmsg code { font-family: var(--mono); font-size: 12px; padding: 0 4px; border-radius: 4px; background: var(--col); }
.cmsg pre { margin: 0 0 8px; padding: 8px 10px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--col); font-family: var(--mono); font-size: 12px; line-height: 1.45; white-space: pre; }
.cmsg pre code { padding: 0; background: none; }
.ctool, .cthought { max-width: 860px; border: 1px solid var(--line); border-radius: 8px; background: var(--col); font-size: 12.5px; }
.ctool > summary, .cthought > summary { display: flex; align-items: center; gap: 8px; padding: 5px 9px; cursor: pointer; min-width: 0; }
.ctool > summary .tt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ctool .st { flex: none; width: 12px; color: var(--muted); }
.ctool.completed .st { color: var(--done); } .ctool.failed .st { color: var(--danger-text); } .ctool.in_progress .st { color: var(--working); }
.ctool .tb, .cthought .tb { padding: 0 9px 8px; }
.ctool pre, .cthought .tb { margin: 6px 0 0; font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ctool pre { max-height: 280px; overflow: auto; padding: 6px 8px; border-radius: 6px; background: var(--bg); white-space: pre; overflow-wrap: normal; }
.ctool .fl { margin-top: 4px; color: var(--muted); font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; }
.ctool .del { color: var(--danger-text); } .ctool .add { color: var(--done); }
.cthought { color: var(--muted); font-style: italic; }
.cplan { max-width: 860px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; }
.cask { max-width: 860px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--blocked) 55%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--blocked) 10%, transparent); }
.cask .row2 { margin-top: 7px; }
.cask.done { opacity: .65; border-color: var(--line); background: transparent; }
.cerr { color: var(--danger-text); }
.cnote { color: var(--muted); font-size: 12px; }
.composer { padding: 8px 16px 12px; border-top: 1px solid var(--line); }
.composer textarea { width: 100%; min-height: 58px; max-height: 220px; resize: vertical; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--input); }
.cbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.cbar select { height: 26px; max-width: 180px; border: 1px solid var(--line); border-radius: 7px; background: var(--input); padding: 0 6px; }
@media (max-width: 1000px) { .chat { flex: none; height: 82vh; } }
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
let data = { rows: [], kept: [], customs: [], peers: [], recent: [], now: Date.now(), avatar: 'gyro' };
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
// The page's own chat (host: chatSessions.ts). projects is the host's index; open is the chat on screen: { chat, project, kind, title, busy, config }.
const chat = { projects: [], got: false, open: undefined, loading: false, error: '', usage: undefined, more: new Set(), drafts: new Map(), q: '', found: undefined };
let sseq = 0;              // counts the typing in the session search: a debounced post is sent only when no later keystroke came
const cev = [];            // the open chat's events, as the host sent them (chunks of one kind joined, a tool card filled in by id)
const cels = [];           // one wrapper element per event: a changed event is drawn again inside its own wrapper
const cdirty = new Set();  // indexes of the events that need drawing again
let cflushing = false;
const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : f => setTimeout(f, 16);

// ---- derived ---------------------------------------------------------------------------------------------------------------
const rowById = id => data.rows.find(r => r.id === id);
// A session of another window (the host sent it, validated): { p: its project, r: the row }.
function peerById(id) {
	for (const p of data.peers) { const r = p.rows.find(x => x.id === id); if (r) { return { p, r }; } }
	return undefined;
}
// The sidebar's dot: the same ranking as the board's columns, for own rows and other windows' alike.
const dotOf = s => s.state === 'ended' ? 'idle' : needKind(s) ? 'needs' : s.state === 'working' || s.state === 'starting' ? 'working' : s.state === 'done' || s.attention === 'done' ? 'done' : 'idle';
const DOT_LABEL = { needs: 'needs you', working: 'working', done: 'done', idle: 'idle' };
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

// ---- the shell, built once -------------------------------------------------------------------------------------------------
const side = h('nav', { class: 'side', 'aria-label': 'Projects and sessions' });
const head = h('div', { class: 'head' });
const tools = h('div', { class: 'tools' });
const main = h('div', { class: 'main' });
const detail = h('aside', { class: 'detail', 'aria-label': 'Selected agent' });
const dTop = h('div'), dConv = h('div'), dReply = h('div', { class: 'sec reply hidden' }), dRest = h('div');
add(detail, dTop, dConv, dReply, dRest);
const boardEl = h('div'), keptEl = h('div');
add(main, boardEl, keptEl);
const chatTitle = h('h2'), chatSub = h('div', { class: 'sub' });
const chatLog = h('div', { class: 'chatlog', tabindex: '0', role: 'log', 'aria-label': 'Chat transcript' });
const chatErr = h('div', { class: 'err', role: 'alert' });
const chatInput = h('textarea', { rows: '2', placeholder: 'Message the agent… (Enter sends, Shift+Enter adds a line)', 'aria-label': 'Message the agent', maxlength: '8000' });
const chatBar = h('div', { class: 'cbar' });
const chatSend = h('button', { type: 'button', class: 'btn small primary' }, 'Send');
const chatEl = h('section', { class: 'chat hidden', 'aria-label': 'Chat' },
	h('div', { class: 'chathead' }, h('div', { class: 'nm' }, chatTitle, chatSub)),
	chatLog, chatErr, h('div', { class: 'composer' }, chatInput, h('div', { class: 'cbar' }, chatBar, h('span', { class: 'grow' }), chatSend)));
// Hidden until the first rows arrive: drawn empty first, the whole page would jump when they come (a layout shift), and the
// "No agents running" prompt would flash for agents that are running. Without a host it shows itself after a moment.
const root = h('div', { id: 'app' }, head, tools, h('div', { class: 'split' }, side, main, detail, chatEl));
root.hidden = true;
const reveal = () => { root.hidden = false; };
setTimeout(reveal, 2000);
document.body.appendChild(root);

// The session search (host: chatSearch / chatFound). It is shown once the host has answered chatList, so a page with no host never offers it.
const sesearch = h('input', { class: 'sesearch', type: 'search', placeholder: 'Search past sessions', 'aria-label': 'Search past sessions', maxlength: '200' });
const sebox = h('div', { class: 'sebox hidden' }, sesearch);
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
			item(data.bypass ? '✓ Claude: bypass permissions mode offered (turn off)' : 'Claude: allow bypass permissions mode…', { type: 'start', cli: 'claude', how: 'bypass' }),
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
const viewBtn = (v, label) => { const b = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', onclick: () => { view = v; if (v === 'chat') { post({ type: 'chatList' }); } paint(); } }, label); b.view = v; return b; };
const viewBtns = [viewBtn('board', 'Board'), viewBtn('list', 'List'), viewBtn('chat', 'Chat')];
add(tools, h('div', { class: 'newwrap' }, newBtn('claude', 'Claude'), newBtn('codex', 'Codex'), moreBtn, menu), search, cliSel, chips, h('span', { class: 'grow' }), viewBtns);

// ---- sidebar: this window's project first, then the other open projects, then the closed ones ---------------------------------
function srow(s) {
	const dot = dotOf(s);
	const el = h('div', { class: 'srow' + (s.state === 'ended' ? ' ended' : '') + (s.id === sel ? ' sel' : ''), tabindex: '0', role: 'button', 'aria-label': s.name + ', ' + DOT_LABEL[dot] },
		h('i', { class: 'sdot ' + dot }), h('span', { class: 'sbody' }, h('span', { class: 'sname' }, s.name), h('span', { class: 'sact', title: actLine(s) }, actLine(s))));
	el.addEventListener('click', () => select(s.id));
	el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); select(s.id); } });
	return el;
}
// A chat session of the host's index: its chat id is the one the host will give it once open (kind and session id).
function crow(p, s) {
	const open = chat.open && chat.open.chat === s.kind + ':' + s.id;
	const el = h('div', { class: 'srow crow' + (open && view === 'chat' ? ' sel' : ''), tabindex: '0', role: 'button', 'aria-label': 'Chat: ' + s.title },
		h('span', { class: 'sglyph', 'aria-hidden': 'true' }, '💬'), h('span', { class: 'sbody' }, h('span', { class: 'sname', title: s.title }, s.title), h('span', { class: 'sact' }, (s.kind === 'codex' ? 'Codex' : 'Claude') + ' · ' + dur(Math.max(0, now() - s.modified)) + ' ago')));
	const go = () => openChat(p.key, s.kind, s.id);
	el.addEventListener('click', go);
	el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } });
	return el;
}
function chatRows(key) {
	const p = chat.projects.find(x => x.key === key);
	if (!p) { return null; }
	const list = chat.more.has(key) ? p.sessions : p.sessions.slice(0, 5);
	const start = (kind, label) => h('button', { type: 'button', class: 'btn small', title: 'Start a ' + label + ' chat in ' + p.where, onclick: () => openChat(key, kind) }, '+ ' + label);
	return [h('div', { class: 'cstart' }, start('claude', 'Claude'), start('codex', 'Codex')), list.map(s => crow(p, s)),
		p.sessions.length > 5 ? h('button', { type: 'button', class: 'btn small cmore', onclick: () => { if (chat.more.has(key)) { chat.more.delete(key); } else { chat.more.add(key); } paintSide(); } }, chat.more.has(key) ? 'Show fewer' : 'Show ' + (p.sessions.length - 5) + ' more') : null];
}
// The snippet is transcript text: text nodes only, the match in a <mark> built here. Folded as the host does (sessionSearch.ts fold):
// the same length as the text, so the index found in the folded copy cuts the original at the right place.
const fold = s => s.replace(/[\u0130\u0131]/g, 'i').toLowerCase();
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
			hits.map(hit => {
				const go = () => openChat(hit.project, hit.kind, hit.session);
				const el = h('div', { class: 'srow crow', tabindex: '0', role: 'button', 'aria-label': 'Chat: ' + hit.title },
					h('span', { class: 'sglyph', 'aria-hidden': 'true' }, '💬'),
					h('span', { class: 'sbody' }, h('span', { class: 'sname', title: hit.title }, hit.title), snippet(hit.snippet, chat.q), h('span', { class: 'sact' }, KIND_NAME[hit.kind] + ' · ' + dur(Math.max(0, now() - hit.modified)) + ' ago')));
				el.addEventListener('click', go);
				el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(); } });
				return el;
			})));
	}
	if (f.more) { out.push(h('p', { class: 'note' }, (f.cut ? 'The search stopped early, so older sessions may match too. ' : '') + 'Showing the newest matches. Type more to narrow the search.')); }
	return out;
}
function paintSide() {
	const shown = rows => rows.filter(s => filter.ended || s.state !== 'ended');
	const mine = shown(data.rows);
	const pick = (label, msg, tip) => h('button', { type: 'button', class: 'btn small', title: tip, onclick: () => post(msg) }, label);
	const ownChat = chat.projects.find(p => p.own);
	const out = [h('div', { class: 'sgroup' },
		h('div', { class: 'shead' }, h('span', { class: 'sproj', title: 'This window' }, (data.project && data.project.name) || 'This window'), pick('New session', { type: 'pick' }, 'Start an agent in this project')),
		mine.length ? mine.map(srow) : (ownChat && ownChat.sessions.length ? null : h('p', { class: 'note' }, 'No sessions yet.')),
		ownChat ? chatRows(ownChat.key) : null)];
	// Every open project, with or without sessions: the sidebar is also the way to jump between the open project windows.
	if (data.peers.length) { out.push(h('div', { class: 'slabel' }, 'Open projects')); }
	for (const p of data.peers) {
		const list = shown(p.rows);
		out.push(h('div', { class: 'sgroup' },
			h('div', { class: 'shead' }, h('span', { class: 'sproj', title: p.name }, p.name), pick('Open in IDE', { type: 'peer', action: 'ide', key: p.key }, 'Bring up the window of ' + p.name)),
			list.length ? list.map(srow) : h('p', { class: 'note' }, 'No sessions'),
			chatRows(p.key)));
	}
	if (data.recent.length) {
		out.push(h('div', { class: 'slabel' }, 'Recent'));
		for (const p of data.recent) {
			out.push(h('div', { class: 'srecent' },
				h('div', { class: 'shead' }, h('span', { class: 'sproj', title: p.name }, p.name), pick('Open project', { type: 'peer', action: 'ide', key: p.key }, 'Open ' + p.name + ' in a window')),
				h('div', { class: 'sact', title: p.sessions.join(', ') }, p.sessions.join(', ') + ' (closed)'),
				chatRows(p.key)));
		}
	}
	// Projects the agents have worked in that this window does not know as open or recent.
	const known = new Set(data.peers.map(p => p.key).concat(data.recent.map(p => p.key)));
	const others = chat.projects.filter(p => !p.own && !known.has(p.key));
	if (others.length) { out.push(h('div', { class: 'slabel' }, 'On this machine')); }
	for (const p of others) {
		out.push(h('div', { class: 'sgroup' }, h('div', { class: 'shead' }, h('span', { class: 'sproj', title: p.where }, p.name)), chatRows(p.key)));
	}
	sebox.className = cls('sebox', !chat.got && 'hidden');
	fill(sideList, chat.q ? searchResults() : out);
}

// ---- header ----------------------------------------------------------------------------------------------------------------
function paintHead() {
	const g = { needs: 0, working: 0, done: 0 };
	let tokens = 0, dollars = 0, priced = false;
	// The page is the place to see every project: the counters take the other open projects' sessions too.
	for (const s of data.rows.concat(...data.peers.map(p => p.rows))) {
		const c = column(s);
		if (g[c] !== undefined) { g[c]++; }
	}
	for (const s of data.rows) {
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
	if (!total && data.peers.some(p => p.rows.length)) {
		// One line, so a session of another project that is selected is not pushed below the fold when the layout is stacked.
		fill(boardEl, [h('p', { class: 'note' }, 'No agents running in this window. The sessions of your other open projects are in the list.')]);
		return;
	}
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
	const peer = !s && sel ? peerById(sel) : undefined;
	if (peer) { return paintPeerDetail(peer); }
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
// A session of another window: what it published, and the two actions that reach it. Replies, rename and the rest happen in its own window.
function paintPeerDetail({ p, r: s }) {
	const kind = needKind(s);
	const done = s.todos.filter(t => t.status === 'completed').length;
	const pr = s.pr;
	fill(dTop, [
		h('div', { class: 'dh' }, avatar(s, true), h('div', { class: 'nm' }, h('h2', null, s.name), h('div', { class: 'sub' }, markOf(s), CLI_NAME[s.cli] || s.cli, stateSpan(s), s.model || null))),
		h('div', { class: 'sub' }, 'Project ' + p.name),
		kind ? h('div', { class: 'need ' + kind }, h('span', { class: 'chip' }, NEED[kind]), h('span', { class: 't' }, s.need || s.activity || '')) : null,
		s.activity && !kind ? h('div', { class: 'activity', title: s.activity }, s.activity) : null,
		s.prompt ? section('Prompt', h('p', null, s.prompt)) : null,
		s.todos.length ? section('Todos · ' + done + '/' + s.todos.length, h('ul', { class: 'todol' }, s.todos.map(t => h('li', { class: t.status }, h('span', { class: 'm' }, t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '●' : '○'), t.text)))) : null,
		s.tokens !== undefined || s.contextPercent !== undefined ? section('Usage', h('div', { class: 'kv' },
			s.contextPercent !== undefined ? [h('span', null, 'Context'), h('span', { class: 'ctx' + level(s.contextPercent) }, s.contextPercent + '% full')] : null,
			s.tokens !== undefined ? [h('span', null, 'Cost'), h('span', null, tok(s.tokens) + ' tok' + (s.usd !== undefined ? ' · ' + usd(s.usd) + ' est.' : ''))] : null)) : null,
	]);
	fill(dConv, []);
	dReply.className = 'sec reply hidden';
	fill(dRest, [
		pr ? section('Pull request', h('div', { class: 'kv' }, h('span', null, '#' + pr.number), h('span', null, pr.title + ' (' + pr.state + ')'))) : null,
		h('div', { class: 'sec row2' },
			act('Open in IDE', { type: 'peer', action: 'ide', key: p.key, id: s.id }, { tip: 'Bring up the window of ' + p.name + ' and show this session there', cls: 'primary' }),
			s.flows ? act('Open flow', { type: 'peer', action: 'flow', key: p.key, id: s.id }, { tip: 'Open the flow canvas for its changes, in its window' }) : null),
		h('p', { class: 'note' }, 'This session runs in another window: reply, rename and the rest are done there.'),
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

// ---- the chat --------------------------------------------------------------------------------------------------------------
// md(): a small Markdown subset (fenced code, inline code, bold, headings, bullets) built node by node through h(), so no
// text of the agent is ever parsed as HTML. Links are left as the plain text they are written as.
const TICK = '\x60';
const FENCE = TICK + TICK + TICK;
function inline(t) {
	const out = [];
	let buf = '';
	let i = 0;
	const flush = () => { if (buf) { out.push(buf); buf = ''; } };
	while (i < t.length) {
		if (t[i] === TICK) {
			const j = t.indexOf(TICK, i + 1);
			if (j > i + 1) { flush(); out.push(h('code', null, t.slice(i + 1, j))); i = j + 1; continue; }
		}
		if (t.slice(i, i + 2) === '**') {
			const j = t.indexOf('**', i + 2);
			if (j > i + 2) { flush(); out.push(h('b', null, t.slice(i + 2, j))); i = j + 2; continue; }
		}
		buf += t[i];
		i++;
	}
	flush();
	return out;
}
function md(text) {
	const out = [];
	const lines = String(text).split('\n');
	let para = [];
	let items = [];
	const endPara = () => { if (para.length) { out.push(h('p', null, inline(para.join('\n')))); para = []; } };
	const endList = () => { if (items.length) { out.push(h('ul', null, items)); items = []; } };
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed.slice(0, 3) === FENCE) {
			endPara(); endList();
			const code = [];
			// An unclosed fence (the answer is still streaming) runs to the end.
			for (i++; i < lines.length && lines[i].trim().slice(0, 3) !== FENCE; i++) { code.push(lines[i]); }
			out.push(h('pre', null, h('code', null, code.join('\n'))));
			continue;
		}
		const head = /^(#{1,6})\s+(.*)$/.exec(trimmed);
		const bullet = /^[-*+]\s+(.*)$/.exec(trimmed) || /^\d+[.)]\s+(.*)$/.exec(trimmed);
		if (head) { endPara(); endList(); out.push(h('h' + head[1].length, null, inline(head[2]))); }
		else if (bullet) { endPara(); items.push(h('li', null, inline(bullet[1]))); }
		else if (!trimmed) { endPara(); endList(); }
		else { endList(); para.push(line); }
	}
	endPara(); endList();
	return out;
}

const cls = (...a) => a.filter(Boolean).join(' ');
const MAX_DIFF_LINES = 300;
const diffLines = (text, mark, klass) => text ? text.split('\n').slice(0, MAX_DIFF_LINES).map(l => h('span', { class: klass }, mark + ' ' + l + '\n')) : [];
const TOOL_MARK = { completed: '✓', failed: '✗', in_progress: '●', pending: '○' };
function renderEvent(e) {
	switch (e.t) {
		case 'user': return h('div', { class: 'cmsg user' }, e.text);
		case 'text': return h('div', { class: 'cmsg' }, md(e.text));
		case 'thought': {
			const d = h('details', { class: 'cthought', open: e.open || null, ontoggle: () => { e.open = d.open; } }, h('summary', null, 'Thinking'), h('div', { class: 'tb' }, e.text));
			return d;
		}
		case 'tool': {
			const body = [];
			if (e.files && e.files.length) { body.push(h('div', { class: 'fl' }, e.files.join('\n'))); }
			for (const d of e.diffs || []) { body.push(h('div', { class: 'fl' }, d.path), h('pre', null, diffLines(d.old, '-', 'del'), diffLines(d.new, '+', 'add'))); }
			if (e.out) { body.push(h('pre', null, e.out)); }
			const d = h('details', { class: cls('ctool', e.status), open: e.open || null, ontoggle: () => { e.open = d.open; } },
				h('summary', null, h('span', { class: 'st' }, TOOL_MARK[e.status] || '○'), h('span', { class: 'tt', title: e.title || e.kind || 'tool' }, e.title || e.kind || 'tool')),
				body.length ? h('div', { class: 'tb' }, body) : null);
			return d;
		}
		case 'plan': return h('div', { class: 'cplan' }, h('ul', { class: 'todol' }, e.entries.map(x => h('li', { class: x.status }, h('span', { class: 'm' }, x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '●' : '○'), x.text))));
		case 'ask': {
			const id = chat.open && chat.open.chat;
			return h('div', { class: cls('cask', e.done && 'done'), role: 'group', 'aria-label': 'The agent asks' },
				h('b', null, e.title), e.files.length ? h('div', { class: 'fl mono' }, e.files.join('\n')) : null,
				h('div', { class: 'row2' }, e.options.map((o, i) => h('button', { type: 'button', class: 'btn small' + (o.kind.indexOf('reject') === 0 ? ' danger' : ''), disabled: e.done || null, onclick: () => { e.done = true; cdirty.add(cev.indexOf(e)); cSchedule(); post({ type: 'chatAnswer', chat: id, req: e.req, option: i }); } }, o.name))));
		}
		case 'stop': return e.reason === 'end_turn' || e.reason === 'cancelled' ? null : h('div', { class: 'cnote' }, 'Stopped: ' + e.reason);
		case 'error': return h('div', { class: 'cerr', role: 'alert' }, e.text);
		default: return null;
	}
}
function cApply(e) {
	const last = cev[cev.length - 1];
	// Chunks of one message join (the host's rule, chatCore.ts appendEvent): a user chunk with no message id is a message of its own.
	if ((e.t === 'text' || e.t === 'thought' || e.t === 'user') && last && last.t === e.t && last.mid === e.mid && !(e.t === 'user' && e.mid === undefined)) { last.text += e.text; cdirty.add(cev.length - 1); return; }
	if (e.t === 'tool') {
		const at = cev.findIndex(x => x.t === 'tool' && x.id === e.id);
		if (at >= 0) { Object.assign(cev[at], e); cdirty.add(at); return; }
	}
	if (e.t === 'plan') {
		const at = cev.findIndex(x => x.t === 'plan');
		if (at >= 0) { cev[at] = Object.assign({}, e); cdirty.add(at); return; }
	}
	if (e.t === 'asked') {
		const at = cev.findIndex(x => x.t === 'ask' && x.req === e.req);
		if (at >= 0) { cev[at].done = true; cdirty.add(at); }
		return;
	}
	if (e.t === 'config') { if (chat.open) { chat.open.config = e.config; paintBar(); } return; }
	if (e.t === 'usage') { chat.usage = e; paintChatHead(); return; }
	if (e.t === 'stop' || (e.t === 'error' && e.fatal)) {
		// The turn is over (a plain error line is not: the host emits those mid-turn): a question still open can no longer be answered.
		cev.forEach((x, i) => { if (x.t === 'ask' && !x.done) { x.done = true; cdirty.add(i); } });
		if (chat.open) { chat.open.busy = false; }
		paintChatHead();
	}
	cev.push(Object.assign({}, e));
	cdirty.add(cev.length - 1);
}
function cFlush() {
	cflushing = false;
	const atEnd = chatLog.scrollTop === undefined || chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 40;
	for (let i = cels.length; i < cev.length; i++) { cels[i] = h('div', { class: 'cb' }); chatLog.appendChild(cels[i]); cdirty.add(i); }
	for (const i of [...cdirty].sort((a, b) => a - b)) { if (cels[i]) { fill(cels[i], [renderEvent(cev[i])]); } }
	cdirty.clear();
	if (atEnd && chatLog.scrollTop !== undefined) { chatLog.scrollTop = chatLog.scrollHeight; }
}
function cSchedule() { if (!cflushing) { cflushing = true; raf(cFlush); } }
function cReset(events) {
	cev.length = 0; cels.length = 0; cdirty.clear();
	wipe(chatLog);
	// A replayed turn that ended says "stop", which must not undo "working" for the turn still running.
	const busy = chat.open && chat.open.busy;
	for (const e of events) { cApply(e); }
	if (chat.open) { chat.open.busy = busy; }
	paintChatHead();
	cFlush();
	if (chatLog.scrollTop !== undefined) { chatLog.scrollTop = chatLog.scrollHeight; }
}
const KIND_NAME = { claude: 'Claude', codex: 'Codex' };
function paintChatHead() {
	const o = chat.open;
	chatTitle.textContent = o ? o.title : 'Chat';
	const project = o ? chat.projects.find(p => p.key === o.project) : undefined;
	const u = chat.usage;
	chatSub.textContent = o ? KIND_NAME[o.kind] + (project ? ' · ' + project.name : '') + (o.busy ? ' · working…' : '') + (u && u.size ? ' · ctx ' + Math.min(100, Math.round(u.used / u.size * 100)) + '%' : '') : '';
	if (project) { chatSub.setAttribute('title', project.where); }
	chatSend.textContent = o && o.busy ? 'Stop' : 'Send';
	chatSend.disabled = !o;
	chatInput.disabled = !o;
	chatErr.textContent = chat.error;
}
// Mode and model (whatever the agent offers), as the host built them from its config options.
function paintBar() {
	const o = chat.open;
	fill(chatBar, o ? o.config.map(c => {
		const sel = h('select', { 'aria-label': c.name, title: c.name, onchange: () => post({ type: 'chatSet', chat: o.chat, config: c.id, value: sel.value }) }, c.items.map(i => h('option', { value: i.value }, i.name)));
		sel.value = c.value === undefined ? '' : c.value;
		return sel;
	}) : []);
}
function paintChat() {
	paintChatHead();
	paintBar();
	if (!chat.open) {
		cev.length = 0; cels.length = 0; cdirty.clear();
		fill(chatLog, [h('p', { class: 'cnote' }, chat.loading ? 'Opening…' : chat.got ? 'Pick a session on the left, or start one with + Claude or + Codex under a project.' : 'The chat is not available here: it needs the Insilode editor.')]);
	}
}
function openChat(project, kind, session) {
	view = 'chat';
	chat.error = '';
	chat.loading = true;
	chat.open = undefined;
	paintChat();
	paint();
	post({ type: 'chatOpen', project, kind, ...(session ? { session } : {}) });
}
function sendChat() {
	const o = chat.open;
	if (!o) { return; }
	if (o.busy) { post({ type: 'chatCancel', chat: o.chat }); return; }
	const text = chatInput.value;
	if (!text.trim() || text.length > 8000) { return; }
	o.busy = true;
	chat.drafts.delete(o.chat);
	chatInput.value = '';
	paintChatHead();
	post({ type: 'chatPrompt', chat: o.chat, text });
}
chatSend.addEventListener('click', sendChat);
chatInput.addEventListener('input', () => { if (chat.open) { chat.drafts.set(chat.open.chat, chatInput.value); } });
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); if (chat.open && !chat.open.busy) { sendChat(); } } });

// ---- selection and painting ------------------------------------------------------------------------------------------------
function select(id) {
	// A terminal agent was picked while the chat is on screen: go back to the board, where its detail is.
	const fromChat = !!id && view === 'chat';
	if (fromChat) { view = 'board'; sel = undefined; }
	if (id === sel) { return; }
	sel = id;
	if (id) { askTail(id, true); }
	for (const [cid, el] of cardEls) {
		const c = el.className.split(' ').filter(x => x !== 'sel');
		if (cid === id) { c.push('sel'); }
		el.className = c.join(' ');
	}
	paintSide();
	paintDetail();
	if (fromChat) { paint(); }
}
function paint() {
	if (sel && !rowById(sel) && !peerById(sel)) { sel = undefined; }
	ticks = [];
	const mainTop = main.scrollTop, detTop = detail.scrollTop;
	paintSide();
	paintHead();
	paintBoard();
	paintKept();
	paintDetail();
	paintChatHead();
	const chatView = view === 'chat';
	main.className = cls('main', chatView && 'hidden');
	detail.className = cls('detail', chatView && 'hidden');
	chatEl.className = cls('chat', !chatView && 'hidden');
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
		data = Object.assign({ rows: [], kept: [], customs: [], peers: [], recent: [] }, m);
		skew = typeof m.now === 'number' ? m.now - Date.now() : 0;
		paint();
		reveal();
		if (sel) { askTail(sel, false); }
		if (openMenu) { setMenu(true); }
	} else if (m.type === 'tail') {
		tails.set(m.id, { entries: Array.isArray(m.entries) ? m.entries : [], note: m.note });
		const s = sel === m.id ? rowById(m.id) : undefined;
		if (s) { paintConv(s); }
	} else if (m.type === 'chatIndex') {
		chat.projects = Array.isArray(m.projects) ? m.projects : [];
		chat.got = true;
		paintSide();
		if (!chat.open) { paintChat(); }
	} else if (m.type === 'chatFound') {
		// An answer to an earlier query, or to one that was cleared since, is not for what is typed now.
		if (m.query !== chat.q || !Array.isArray(m.hits)) { return; }
		chat.found = { hits: m.hits.filter(x => x && typeof x.project === 'string' && typeof x.session === 'string').map(x => ({ project: x.project, kind: x.kind === 'codex' ? 'codex' : 'claude', session: x.session, title: String(x.title || ''), modified: Number(x.modified) || 0, snippet: String(x.snippet || '') })), more: !!m.more, cut: !!m.cut };
		paintSide();
	} else if (m.type === 'chatOpened') {
		if (!chat.open || chat.open.chat !== m.chat) { chat.usage = undefined; }
		chat.open = { chat: m.chat, project: m.project, kind: m.kind, title: m.title, busy: !!m.busy, config: Array.isArray(m.config) ? m.config : [] };
		chat.loading = false;
		chat.error = '';
		chatInput.value = chat.drafts.get(m.chat) || '';
		paintChat();
		paintSide();
	} else if (m.type === 'chatEvents') {
		if (!chat.open || m.chat !== chat.open.chat || !Array.isArray(m.events)) { return; }
		if (m.reset) { cReset(m.events); } else { for (const e of m.events) { cApply(e); } cSchedule(); }
	} else if (m.type === 'chatFailed') {
		chat.loading = false;
		chat.error = String(m.text || 'The chat could not be opened.');
		paintChat();
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
	// The keys below move through the board's agents, which are not on screen in the chat view.
	if (view === 'chat') { return; }
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
		if (sel && rowById(sel)) { post({ type: 'show', id: sel }); }
	} else if (e.key === 'r') {
		const s = sel ? rowById(sel) : undefined;
		if (s && s.acceptsInput && s.state !== 'ended') { e.preventDefault(); replyText.focus(); }
	} else if (e.key === '/') {
		e.preventDefault();
		search.focus();
	}
});
document.addEventListener('click', e => { if (openMenu && !menu.contains(e.target)) { setMenu(false); } });
paintChat();
paint();
post({ type: 'ready' });
`;

/** `nonce` is made per load by agentsPanel.ts (the website passes its own): the one script runs by it. */
export function agentsHtml(nonce: string): string {
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agents</title><style>${CSS}</style></head><body><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
