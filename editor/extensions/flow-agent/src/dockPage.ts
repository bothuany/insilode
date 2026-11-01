/*---------------------------------------------------------------------------------------------
 *  Insilode: the page of the Agents dock (HTML, CSS and the script that draws the rows). No `vscode` here, so the
 *  page can be rendered outside the editor too: the website (site/) puts it in an iframe and sends it the
 *  same `data` messages the dock sends it. dock.ts gives it to the webview and answers what it asks for.
 *--------------------------------------------------------------------------------------------*/

import { AVATAR_CSS, AVATAR_SCRIPT } from './avatars';

/** The real marks: Claude's spark (from the Claude Code extension) and the Codex cloud (lobe-icons). */
const ICON = {
	claude: '<svg class="ico claude" viewBox="0 0 24 24" aria-hidden="true"><path fill="#D97757" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>',
	codex: '<svg class="ico codex" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="flow-codex" x1="12" x2="12" y1="0" y2="24" gradientUnits="userSpaceOnUse"><stop stop-color="#B1A7FF"/><stop offset=".5" stop-color="#7A9DFF"/><stop offset="1" stop-color="#3941FF"/></linearGradient></defs><path fill="url(#flow-codex)" fill-rule="evenodd" clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/></svg>',
};

export function dockHtml(): string {
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';`;
	return /* html */ `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root {
	--text: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --line: var(--vscode-widget-border, #30323c);
	--hover: var(--vscode-list-hoverBackground); --card: color-mix(in srgb, var(--vscode-sideBar-background) 70%, #2a2c36);
	--mono: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
	--working: #6f86ff; --blocked: #ffb454; --done: #5fe0a1; --idle: #9aa4bf; --ended: #5b5f6e;
	--claude: #d97757; --codex: #7fd1d1; --custom: #b88cff;
}
* { box-sizing: border-box; }
body { margin: 0; padding: 8px 10px 16px 8px; color: var(--text); font: 13px/1.4 var(--vscode-font-family, -apple-system, system-ui); background: transparent; }
.new { display: flex; gap: 6px; margin-bottom: 10px; }
.new button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 28px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; cursor: pointer; }
.new button:hover { background: var(--hover); }
.new button:focus-visible, .agent:focus-visible { outline: 1.5px solid var(--working); outline-offset: -1.5px; }
.new button.more { flex: 0 0 auto; padding: 0 10px; color: var(--muted); }
.ico { flex: none; width: 15px; height: 15px; display: block; }
.ico.claude { color: var(--claude); } .ico.codex { color: var(--codex); } .ico.custom { color: var(--custom); }

.agent { position: relative; display: block; width: 100%; margin: 0 0 6px; padding: 9px 10px 9px 12px; border: 1px solid transparent; border-radius: 10px; background: var(--card); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.agent:hover { border-color: var(--line); }
.agent.blocked { border-color: color-mix(in srgb, var(--blocked) 45%, transparent); background: color-mix(in srgb, var(--blocked) 8%, var(--card)); }
.agent.ended { opacity: .62; }
.top { display: flex; align-items: center; gap: 8px; min-width: 0; }
/* The agent's avatar (src/avatars.ts): who it is and what it is doing, on a dark tile in every colour theme. */
.av { position: relative; flex: none; display: grid; place-items: center; width: 26px; height: 26px; margin: -4px 0; border-radius: 8px; background: #000; }
${AVATAR_CSS}
.name { font-weight: 600; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.state { margin-left: auto; color: var(--muted); font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.blocked .state { color: var(--blocked); font-weight: 600; }
.unread .name::after { content: ''; display: inline-block; width: 6px; height: 6px; margin-left: 6px; border-radius: 50%; background: var(--done); vertical-align: middle; }
.prompt { margin: 5px 0 0 34px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--text); opacity: .86; }
.activity { margin: 4px 0 0 34px; color: var(--muted); font: 11.5px/1.35 var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.blocked .activity { color: var(--blocked); }
.todos { display: flex; align-items: center; gap: 8px; margin: 7px 0 0 34px; }
.segs { display: flex; gap: 2px; flex: none; }
.seg { width: 10px; height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--idle) 30%, transparent); }
.seg.completed { background: var(--done); } .seg.in_progress { background: var(--working); }
.todos .now { min-width: 0; color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.impact { margin: 6px 0 0 34px; color: var(--muted); font-size: 11.5px; line-height: 1.6; }
.impact b { color: var(--text); font-weight: 600; }
.impact .flow { display: inline-block; margin: 0 4px 2px 0; padding: 0 6px; border-radius: 5px; border: 1px solid var(--line); font: 11px/1.5 var(--mono); color: var(--text); cursor: pointer; }
.impact .flow:hover { background: var(--hover); }
.wt { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 6px 0 0 34px; color: var(--muted); font: 11px/1.5 var(--mono); }
.wt .br { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.wt .ab { font-variant-numeric: tabular-nums; }
.wt .act { padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); font: 11px/1.5 var(--vscode-font-family, system-ui); cursor: pointer; }
.wt .act:hover { background: var(--hover); color: var(--text); }
.explain { margin: 6px 0 0 34px; }
.explain .act { padding: 0 8px; border: 1px solid color-mix(in srgb, var(--working) 55%, transparent); border-radius: 5px; color: var(--working); font: 11px/1.5 var(--vscode-font-family, system-ui); cursor: pointer; }
.explain .act:hover { background: color-mix(in srgb, var(--working) 14%, transparent); }
/* Skeleton first: one button per agent, in the Explain this style; pressed is filled. */
.explain .act[aria-pressed="true"] { background: var(--working); color: #0c0f1f; }
/* Its explanation, on hover and on keyboard focus (a native title shows on neither in every host). */
.explain.sk { position: relative; }
.explain.sk .act:hover::after, .explain.sk .act:focus-visible::after { content: attr(data-tip); position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 5; padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--text); font: 11.5px/1.45 var(--vscode-font-family, system-ui); white-space: normal; pointer-events: none; }
.clash { margin: 6px 0 0 34px; padding: 4px 7px; border-radius: 6px; background: color-mix(in srgb, var(--blocked) 10%, transparent); color: var(--blocked); font-size: 11.5px; line-height: 1.45; }
.clash.same { background: color-mix(in srgb, #ff6b7d 12%, transparent); color: #ff8c99; }
.clash small { display: block; color: var(--muted); }
.todos .count { flex: none; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.ctx { position: absolute; left: 46px; right: 10px; bottom: 0; height: 2px; border-radius: 2px; background: transparent; overflow: hidden; }
.ctx i { display: block; height: 100%; background: color-mix(in srgb, var(--working) 55%, transparent); }
.ctx.warn i { background: var(--blocked); } .ctx.full i { background: #ff6b7d; }
/* How full the context window is: the model, used / window and the share, or only the tokens when the CLI gave no window. */
.ctxline { display: flex; align-items: center; gap: 6px; margin: 6px 0 0 34px; color: var(--muted); font: 11px/1.4 var(--mono); font-variant-numeric: tabular-nums; }
.ctxline .model { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ctxline .amt { flex: none; }
.ctxline.warn .pct { color: var(--blocked); } .ctxline.full .pct { color: #ff6b7d; font-weight: 600; }
.cmp { flex: none; margin-left: auto; padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); font: 11px/1.5 var(--vscode-font-family, system-ui); cursor: pointer; }
.cmp:hover { background: var(--hover); color: var(--text); }
.ctx { cursor: pointer; overflow: visible; } .ctx::before { content: ''; position: absolute; left: 0; right: 0; top: -6px; bottom: -2px; } .ctx:hover i { filter: brightness(1.4); }
.x { position: absolute; top: 6px; right: 6px; display: none; width: 18px; height: 18px; border: 0; border-radius: 5px; background: transparent; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 18px; }
.agent.ended:hover .x { display: block; }
.agent:hover .state { visibility: hidden; }
.x:hover, .ren:hover, .swp:hover { background: var(--hover); color: var(--text); }
.ren, .swp { position: absolute; top: 6px; right: 6px; display: none; width: 18px; height: 18px; border-radius: 5px; color: var(--muted); cursor: pointer; font-size: 12px; line-height: 18px; text-align: center; }
.swp { right: 26px; }
.agent:hover .ren, .agent:focus-visible .ren, .agent:hover .swp, .agent:focus-visible .swp { display: block; }
.agent.ended:hover .ren { right: 26px; }
.agent.ended:hover .swp { right: 46px; }
.empty { margin: 4px 2px; color: var(--muted); line-height: 1.55; }
.empty b { color: var(--text); font-weight: 600; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 12px; color: var(--muted); font-size: 11.5px; }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 7px; height: 7px; border-radius: 50%; }
.foot { margin-top: 14px; color: var(--muted); font-size: 11.5px; }
.foot button { all: unset; color: var(--vscode-textLink-foreground); cursor: pointer; }
/* Why it waits for you: a chip with the kind, then the question, the permission or the error itself. */
.need { display: flex; align-items: baseline; gap: 6px; margin: 5px 0 0 34px; min-width: 0; font-size: 11.5px; }
.chip { flex: none; padding: 0 6px; border-radius: 5px; font: 600 10.5px/1.6 var(--vscode-font-family, system-ui); text-transform: uppercase; letter-spacing: .03em; }
.need .t { min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.need.approval .chip { background: color-mix(in srgb, var(--blocked) 22%, transparent); color: var(--blocked); }
.need.question .chip { background: color-mix(in srgb, var(--working) 22%, transparent); color: var(--working); }
.need.error .chip { background: color-mix(in srgb, #ff6b7d 22%, transparent); color: #ff6b7d; }
.need.done .chip { background: color-mix(in srgb, var(--done) 18%, transparent); color: var(--done); }
.agent.question { border-color: color-mix(in srgb, var(--working) 45%, transparent); }
.agent.error { border-color: color-mix(in srgb, #ff6b7d 45%, transparent); }
/* Tokens and dollars of this prompt and the session; the PR and its checks. */
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; margin: 5px 0 0 34px; color: var(--muted); font: 11px/1.5 var(--mono); font-variant-numeric: tabular-nums; }
.meta .est { opacity: .7; } .meta .sp { white-space: nowrap; }
.meta .cost { display: inline-flex; flex-wrap: wrap; gap: 0 10px; }
.pr { padding: 0 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--text); cursor: pointer; }
.pr:hover { background: var(--hover); }
.pr .ck.pass { color: var(--done); } .pr .ck.fail { color: #ff6b7d; } .pr .ck.pending { color: var(--blocked); }
.pr.merged { color: var(--custom); } .pr.closed { color: var(--muted); }
</style></head><body>
<div class="new">
	<button data-cli="claude" title="Start Claude Code in a new terminal, or resume an earlier session">${ICON.claude}Claude</button>
	<button data-cli="codex" title="Start Codex in a new terminal, or resume an earlier session">${ICON.codex}Codex</button>
	<button class="more" data-cli="pick"title="Start another agent: Gemini, Aider, your own command…" aria-label="Start another agent">Other…</button>
</div>
<div id="list"></div>
<script>
const vscode = acquireVsCodeApi();
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let data = { list: [], now: Date.now() };
${AVATAR_SCRIPT}
// What the avatar shows: a question, an approval or an unread error first, then the state.
const avState = s => s.state === 'ended' ? 'idle' : s.attention === 'approval' || s.attention === 'question' || s.attention === 'error' ? s.attention : s.attention === 'done' ? 'done' : s.state === 'blocked' ? 'approval' : s.state === 'working' || s.state === 'starting' ? 'working' : 'idle';
const ago = (t, now) => { const s = Math.max(0, Math.round((now - t) / 1000)); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h'; };
const tok = n => n >= 1e6 ? +(n / 1e6).toFixed(n % 1e6 ? 1 : 0) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n);
const usd = n => n === 0 ? '$0' : n < 0.01 ? '<$0.01' : '$' + n.toFixed(n < 10 ? 2 : 1);
const sum = t => t.input + t.output + t.cacheRead + t.cacheWrite;
const spendLine = (label, x) => label + ' ' + tok(sum(x.tokens)) + ' tok' + (x.usd !== undefined ? ' · ' + usd(x.usd) : '');
const spendTip = (label, x) => label + ': ' + x.tokens.input.toLocaleString() + ' in, ' + x.tokens.output.toLocaleString() + ' out, ' + x.tokens.cacheRead.toLocaleString() + ' cache read, ' + x.tokens.cacheWrite.toLocaleString() + ' cache write' + (x.usd !== undefined ? ', $' + x.usd.toFixed(4) + ' est.' : '');
const NEED = { approval: 'Approval', question: 'Question', error: 'Error', done: 'Done' };
const PRSTATE = { open: 'open', draft: 'draft', merged: 'merged', closed: 'closed' };
const CHECK = { pass: '✓ checks', fail: '✗ checks', pending: '● checks', none: '' };
const LABEL = { working: 'Working', blocked: 'Needs you', done: 'Done', idle: 'Ready', starting: 'Starting', unknown: 'Running', ended: 'Closed' };
function avatar(s, pct) {
	const st = avState(s);
	const key = [s.id, data.avatar, s.cli, st, pct ?? ''].join('|');
	return '<span class="av" data-k="' + esc(key) + '">' + window.insilodeAvatar(data.avatar, s.cli, st, pct, 24) + '</span>';
}
// Skeleton first: one toggle button per agent; what it does is in its tooltip. The stages are talked through with the agent, so
// the row shows nothing else. The page sends only the row and the state it asks for.
const SK_TIP = 'Skeleton first for this agent. When a change adds or changes types, entities or interfaces, the agent draws its design on a board and stops; you write the types and signatures, and the board marks them against the design as you save. Then tell the agent "check", "hand over" (it fills the bodies), "just do it" or "done".';
function skeletonButton(s) {
	if (!s.skeletonAvailable) { return ''; }
	return '<div class="explain sk"><span class="act" role="button" tabindex="0" aria-pressed="' + (s.skeletonOn ? 'true' : 'false') + '" data-sk="' + (s.skeletonOn ? 'off' : 'on') + '" data-tip="' + esc(SK_TIP + (s.skeletonOn ? ' On: click to turn it off.' : ' Off: click to turn it on.')) + '" aria-description="' + esc(SK_TIP) + '">Skeleton</span></div>';
}
function render() {
	const el = document.getElementById('list');
	if (!data.list.length) {
		el.innerHTML = '<p class="empty"><b>No agents running.</b><br>Start one above. It runs in a terminal like always; here you see at a glance which one is working, which one waits for you and which one is done.</p>'
			+ '<div class="legend"><span><i style="background:var(--working)"></i>Working</span><span><i style="background:var(--blocked)"></i>Needs you</span><span><i style="background:var(--done)"></i>Done</span></div>'
			+ '<p class="foot">Prefer the chat panel? <button id="chat">Turn it back on</button></p>';
		const c = document.getElementById('chat'); if (c) c.onclick = () => vscode.postMessage({ type: 'chat' });
		return;
	}
	// An avatar that did not change keeps its element, so its animation runs on instead of restarting with every repaint.
	const kept = new Map([...el.querySelectorAll('.av[data-k]')].map(a => [a.dataset.k, a]));
	el.innerHTML = data.list.map(s => {
		// Without a window size from the CLI there is no share to show: no bar, only the tokens in the tooltip.
		const sized = !!(s.usage && s.usage.size);
		// Codex counts its share its own way (it leaves out a fixed baseline): the dock shows the figure the CLI shows.
		const pct = sized ? Math.min(100, s.usage.percent ?? Math.round(s.usage.used / s.usage.size * 100)) : 0;
		// A question or approval it waits on says "Needs you" whatever the state (a startup prompt comes before any hook).
		const waits = (s.attention === 'question' || s.attention === 'approval') && s.state !== 'ended';
		const state = waits && s.state !== 'blocked' ? LABEL.blocked : s.state === 'working' || s.state === 'blocked' ? LABEL[s.state] + ' · ' + ago(s.since, Date.now()) : s.state === 'done' ? 'Done ' + ago(s.since, Date.now()) + ' ago' : LABEL[s.state];
		const todos = s.todos.length ? '<div class="todos"><span class="segs">' + s.todos.slice(0, 12).map(t => '<span class="seg ' + esc(t.status) + '"></span>').join('') + '</span><span class="count">' + s.done + '/' + s.todos.length + '</span>' + (s.current ? '<span class="now">' + esc(s.current) + '</span>' : '') + '</div>' : '';
		// A changed entity says which table it is and how many endpoints use it: "and table orders (4 endpoints)"; a name that is a guess ends in "?".
		const tablesSaid = s.impact && s.impact.tables ? s.impact.tables.map(t => 'table ' + esc(t.table) + (t.guess ? '?' : '') + ' (' + (t.migration ? 'migration ' + esc(t.migration) + ', ' : '') + t.endpoints + (t.endpoints === 1 ? ' endpoint' : ' endpoints') + (t.partial ? ', partial' : '') + ')').join(', ') : '';
		const impact = s.impact && (s.impact.flows.length || tablesSaid) ? '<div class="impact"><b>This turn touched ' + (s.impact.flows.length ? (s.impact.flows.length + s.impact.more) + (s.impact.flows.length + s.impact.more === 1 ? ' flow' : ' flows') : '') + (s.impact.flows.length && tablesSaid ? ' and ' : '') + tablesSaid + (s.impact.flows.length ? ':' : '') + '</b> ' + s.impact.flows.map((f, i) => '<span class="flow" role="button" tabindex="0" data-flow="' + i + '" title="' + esc((f.via && f.via.length ? 'Through ' + f.via.join(', ') + '. ' : '') + 'Open this flow') + '">' + esc(f.label) + '</span>').join('') + (s.impact.more ? '<span>+' + s.impact.more + ' more</span>' : '') + '</div>' : '';
		// Once the turn has ended with an edit: the agent that made the change explains it as a tour on the canvas.
		const explain = s.explain ? '<div class="explain"><span class="act" role="button" tabindex="0" data-explain="1" title="Ask ' + esc(s.name) + ' to explain what it just changed, as a tour on the flow canvas">Explain this</span></div>' : '';
		const kind = s.attention;
		// A need says what it waits for (an error you have seen still says what went wrong); a finished turn you have not opened only says so.
		const chip = s.need ? s.need.kind : kind;
		const needText = s.need ? s.need.text : kind === 'approval' ? s.activity : '';
		const need = chip ? '<div class="need ' + esc(chip) + '"><span class="chip">' + esc(NEED[chip]) + '</span>' + (needText ? '<span class="t">' + esc(needText) + '</span>' : '') + '</div>' : '';
		const c = s.cost;
		// Both lines are the same kind of estimate, so both say so. A resumed conversation counts from this CLI's start, as its dollars do.
		const est = x => x.usd !== undefined ? ' <span class="est">est.</span>' : '';
		const earlier = c && c.earlier ? '\\n' + tok(sum(c.earlier)) + ' tokens from before this CLI started (the conversation was resumed) are not counted here.' : '';
		const cost = c ? '<span class="cost" title="' + esc((c.prompt ? spendTip('This prompt', c.prompt) + '\\n' : '') + spendTip(c.earlier ? 'Since this CLI started' : 'Session', c.session) + '\\nTokens of the ' + c.scope + '.' + (c.usdSource ? ' Dollars: ' + c.usdSource + '.' : ' No dollar figure: the CLI does not report one.') + earlier) + '">'
			+ (c.prompt ? '<span class="sp">' + esc(spendLine('prompt', c.prompt)) + est(c.prompt) + '</span>' : '') + '<span class="sp">' + esc(spendLine(c.earlier ? 'since resume' : 'session', c.session)) + est(c.session) + '</span></span>' : '';
		const p = s.pr;
		const checks = p && p.checks !== 'none' ? ' <span class="ck ' + esc(p.checks) + '">' + esc(CHECK[p.checks]) + '</span>' : '';
		const prTip = p ? p.title + ' (' + PRSTATE[p.state] + ')' + (p.checks !== 'none' ? '\\nChecks: ' + p.counts.pass + ' passed, ' + p.counts.fail + ' failed, ' + p.counts.pending + ' pending' + (p.failing.length ? '\\nFailing: ' + p.failing.join(', ') : '') : '') + '\\nOpen on GitHub' : '';
		const pr = p ? '<span class="pr ' + esc(p.state) + '" role="button" data-pr="1" title="' + esc(prTip) + '">#' + esc(p.number) + ' ' + esc(PRSTATE[p.state]) + checks + '</span>' : '';
		const meta = cost || pr ? '<div class="meta">' + pr + cost + '</div>' : '';
		const w = s.worktree;
		const counts = w && w.ahead !== undefined ? '<span class="ab" title="' + esc('Commits ahead of / behind ' + w.base) + '">↑' + w.ahead + ' ↓' + w.behind + '</span>' : '';
		const dirty = w && w.uncommitted ? '<span title="Files changed and not committed in the worktree">' + w.uncommitted + ' uncommitted</span>' : '';
		const act = (a, label, tip) => '<span class="act" role="button" tabindex="0" data-wt="' + a + '" title="' + esc(tip) + '">' + label + '</span>';
		const wt = w ? '<div class="wt"><span class="br" title="' + esc('Worktree on ' + w.branch + ', from ' + w.base) + '">⎇ ' + esc(w.branch) + '</span>' + counts + dirty
			+ act('open', 'Open', 'Open the worktree folder') + act('diff', 'Changes', 'Show the changes of this branch since ' + w.base + ' in flow') + act('merge', 'Merge', 'Merge into ' + w.base + ' (asks first)') + act('remove', 'Remove', 'Remove the worktree folder (asks first; the branch stays)') + '</div>' : '';
		const clash = (s.clash || []).map(c => '<div class="clash' + (c.same ? ' same' : '') + '" title="' + esc(c.files.join(', ')) + '">⚠ ' + esc(c.text)
			+ (c.same ? '<small>Same checkout: each writes over the edits of the other. Start agents that work in parallel in a worktree (Other… → in a worktree).</small>' : '') + '</div>').join('');
		const level = pct >= 90 ? ' full' : pct >= 70 ? ' warn' : '';
		// Only at the prompt: while the agent asks for permission, the Enter after /compact would answer its menu (slashRefusal in askTarget.ts, checked again in Agents.slash).
		const canCompact = s.usage && s.cli !== 'custom' && (s.state === 'idle' || s.state === 'done');
		const ctx = s.usage ? '<div class="ctxline' + level + '" title="' + esc(sized ? s.usage.used.toLocaleString() + ' of ' + s.usage.size.toLocaleString() + ' tokens in the context window' : s.usage.used.toLocaleString() + ' tokens in context; the agent has not said how large its window is') + '">'
			+ (s.usage.model ? '<span class="model">' + esc(s.usage.model) + '</span><span>·</span>' : '')
			+ '<span class="amt">' + (sized ? tok(s.usage.used) + ' / ' + tok(s.usage.size) + ' <span class="pct">' + pct + '%</span>' : tok(s.usage.used) + ' tokens') + '</span>'
			+ (canCompact ? '<span class="cmp" data-compact="' + esc(s.id) + '" role="button" title="Send /compact: keeps a summary, frees most of the window">Compact</span>' : '')
			+ '</div>' : '';
		return '<button class="agent ' + s.state + (kind ? ' ' + kind : '') + (s.unread ? ' unread' : '') + '" data-id="' + esc(s.id) + '" title="' + esc(s.name + (sized ? ' · context ' + pct + '% full' : '')) + '">'
			+ '<div class="top">' + avatar(s, sized ? pct : undefined) + '<span class="name">' + esc(s.name) + '</span><span class="state">' + esc(state) + '</span></div>'
			+ (s.prompt ? '<div class="prompt">' + esc(s.prompt) + '</div>' : '')
			+ need
			+ (s.activity && !(kind === 'approval' && !s.need) && !(s.need && s.activity === s.need.text) ? '<div class="activity">' + esc(s.activity) + '</div>' : '')
			+ todos
			+ clash
			+ impact
			+ explain
			+ skeletonButton(s)
			+ wt
			+ ctx
			+ meta
			+ (sized ? '<div class="ctx' + level + '" data-xray="1" title="Context ' + pct + '% full: what fills it?"><i style="width:' + pct + '%"></i></div>' : '')
			+ '<span class="ren" data-rename="' + esc(s.id) + '" title="Rename" role="button">✎</span>'
			// Claude to Codex and back, with the conversation: only between turns, so the transcript holds the whole of the last one.
			+ ((s.cli === 'claude' || s.cli === 'codex') && s.state !== 'working' && s.state !== 'blocked' && s.state !== 'starting' ? '<span class="swp" data-swap="' + esc(s.id) + '" title="Continue in ' + (s.cli === 'claude' ? 'Codex' : 'Claude') + ' with this conversation" role="button">⇄</span>' : '')
			+ (s.state === 'ended' ? '<span class="x"data-forget="' + esc(s.id) + '" title="Remove from list" role="button">×</span>' : '')
			+ '</button>';
	}).join('');
	el.querySelectorAll('.av[data-k]').forEach(a => { const old = kept.get(a.dataset.k); if (old) { a.replaceWith(old); } });
	// The Skeleton button sits inside the row's own button: Enter and Space press it, not the row.
	el.querySelectorAll('[data-sk]').forEach(x => x.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); x.click(); } });
	el.querySelectorAll('.agent').forEach(b => b.onclick = e => {
		const f = e.target.closest('[data-forget]');
		const fl = e.target.closest('[data-flow]');
		const rn = e.target.closest('[data-rename]');
		const cp = e.target.closest('[data-compact]');
		const wa = e.target.closest('[data-wt]');
		const pr = e.target.closest('[data-pr]');
		const xr = e.target.closest('[data-xray]');
		const ex = e.target.closest('[data-explain]');
		const sw = e.target.closest('[data-swap]');
		if (sw) {
			vscode.postMessage({ type: 'swap', id: sw.dataset.swap });
			return;
		}
		if (e.target.closest('.sk')) {
			// The Skeleton button is not a click on the row.
			const sk = e.target.closest('[data-sk]');
			if (sk) { vscode.postMessage({ type: 'sk', id: b.dataset.id, on: sk.dataset.sk === 'on' }); }
			return;
		}
		vscode.postMessage(ex ? { type: 'explain', id: b.dataset.id } : wa ? { type: 'wt', id: b.dataset.id, action: wa.dataset.wt } : pr ? { type: 'pr', id: b.dataset.id } : cp ? { type: 'compact', id: cp.dataset.compact } : rn ? { type: 'rename', id: rn.dataset.rename } : f ? { type: 'forget', id: f.dataset.forget } : fl ? { type: 'flow', id: b.dataset.id, index: Number(fl.dataset.flow) } : xr ? { type: 'xray', id: b.dataset.id } : { type: 'show', id: b.dataset.id });
	});
}
document.querySelectorAll('.new button').forEach(b => b.onclick = () => vscode.postMessage(b.dataset.cli === 'pick' ? { type: 'pick' } : { type: 'new', cli: b.dataset.cli }));
window.addEventListener('message', e => { if (e.data.type === 'data') { data = e.data; render(); } });
setInterval(() => data.list.some(s => s.state === 'working' || s.state === 'blocked' || s.state === 'done') && render(), 5000);
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
