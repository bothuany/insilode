/*---------------------------------------------------------------------------------------------
 *  Insilode: the terminal workspace of the Agents page, as CSS and script text agentsPage.ts puts into the page: the split layout of
 *  panes (the tree and its operations are paneLayout.ts, `L` in the page), drag and drop of sessions and panes, the terminals (xterm.js
 *  behind a small factory, so a page without it, and the tests, still run), broadcast, and the saved layouts. No `vscode` and no
 *  imports of the page's other parts: it uses the shell's helpers (h, add, fill, post, rowById ...) as the page's globals.
 *--------------------------------------------------------------------------------------------*/

export const WORKSPACE_CSS = String.raw`
.work { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.stage { position: relative; display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; padding: 6px; background: var(--col); }
.sp { display: flex; flex: 1 1 0; min-width: 0; min-height: 0; }
.sp.row { flex-direction: row; } .sp.col { flex-direction: column; }
.gutter { position: relative; flex: none; touch-action: none; }
.gutter.v { width: 6px; cursor: col-resize; } .gutter.h { height: 6px; cursor: row-resize; }
.gutter::after { content: ""; position: absolute; border-radius: 2px; background: var(--focus); opacity: 0; transition: opacity .12s; }
.gutter.v::after { top: 0; bottom: 0; left: 2px; width: 2px; } .gutter.h::after { left: 0; right: 0; top: 2px; height: 2px; }
.gutter:hover::after, .gutter:focus-visible::after, .gutter.drag::after { opacity: .85; }
.gutter:focus-visible { outline: none; }

.pane { position: relative; display: flex; flex-direction: column; flex: 1 1 0; min-width: 280px; min-height: 140px; border: 1px solid var(--line); border-radius: 8px; background: var(--term-bg, var(--bg)); overflow: hidden; container-type: inline-size; }
.pane.active { border-color: var(--focus); }
.pane:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.pane.needs:not(.active) { border-color: color-mix(in srgb, var(--blocked) 60%, var(--line)); }
.pane.target { border-color: var(--blocked); box-shadow: 0 0 0 1px var(--blocked); }
.ph { display: flex; align-items: center; gap: 7px; flex: none; height: 32px; padding: 0 4px 0 10px; border-bottom: 1px solid var(--line); background: var(--card); cursor: grab; min-width: 0; user-select: none; }
.pane.active .ph { background: color-mix(in srgb, var(--focus) 13%, var(--card)); }
.ph:active { cursor: grabbing; }
.ph .pt { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph .pf, .ph .pbr, .ph .pstate { color: var(--muted); font-size: 11.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ph .pbr { font-family: var(--mono); }
.ph .pstate { margin-left: 2px; font-variant-numeric: tabular-nums; }
.ph .pstate.s-blocked, .ph .pstate.s-approval, .ph .pstate.s-question, .ph .pstate.s-error { color: var(--blocked); font-weight: 600; }
.ph .pgrow { flex: 1 1 0; }
.ph .bctag { flex: none; padding: 0 6px; border-radius: 9px; font-size: 11px; font-weight: 600; background: var(--blocked); color: var(--bg); }
.ph label.bcb { display: inline-flex; align-items: center; gap: 4px; padding: 0 4px; font-size: 11.5px; color: var(--muted); cursor: pointer; }
.ibtn { flex: none; display: inline-grid; place-items: center; width: 24px; height: 24px; padding: 0; border: 0; border-radius: 5px; background: transparent; color: var(--muted); }
.ibtn:hover, .ibtn[aria-expanded="true"] { background: var(--hover); color: var(--text); }
.ibtn svg { display: block; }
@container (max-width: 520px) { .ph .pstate, .ph .pf { display: none; } }
@container (max-width: 400px) { .ph .pbr { display: none; } }
.pb { position: relative; flex: 1 1 auto; min-height: 0; padding: 4px 0 2px 8px; background: var(--term-bg, var(--bg)); overflow: hidden; }
.pb .xterm { height: 100%; }
.pb .xterm-viewport { background-color: transparent !important; }
.pane.ended .pb { opacity: .55; }
.pover { position: absolute; left: 0; right: 0; bottom: 0; top: 32px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 16px; text-align: center; background: color-mix(in srgb, var(--bg) 62%, transparent); z-index: 3; }
.pover .pm { max-width: 360px; overflow-wrap: anywhere; }
.pover .pm b { display: block; margin-bottom: 2px; font-size: 14px; }
.pover .pm small { color: var(--muted); }
.pover .errtxt { color: var(--danger-text); }
.pzone { position: absolute; inset: 0; pointer-events: none; opacity: 0; z-index: 6; border: 2px solid var(--focus); border-radius: 8px; background: color-mix(in srgb, var(--focus) 20%, transparent); clip-path: inset(0); transition: opacity .12s ease, clip-path .12s ease; }
.pzone.on { opacity: 1; }
.pzone.z-left { clip-path: inset(0 50% 0 0); } .pzone.z-right { clip-path: inset(0 0 0 50%); } .pzone.z-top { clip-path: inset(0 0 50% 0); } .pzone.z-bottom { clip-path: inset(50% 0 0 0); }
.stage.dragging .pb, .stage.dragging .pover { pointer-events: none; }
.wempty { position: relative; display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 24px; text-align: center; color: var(--muted); border: 1.5px dashed var(--line); border-radius: 10px; }
.wempty b { color: var(--text); font-size: 16px; }
.wempty p { margin: 0; max-width: 420px; }
.wempty .row { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 14px; }
.wempty kbd, .kbd { padding: 0 5px; border: 1px solid var(--line); border-radius: 4px; font: 11px var(--mono); color: var(--text); }
.wempty.over { border-color: var(--focus); background: color-mix(in srgb, var(--focus) 12%, transparent); transition: background .12s ease, border-color .12s ease; }
.tlog { height: 100%; overflow: auto; padding: 2px 10px 8px 2px; font: 12px/1.5 var(--mono); }
.tlog .tl { white-space: pre-wrap; overflow-wrap: anywhere; }
.tlog .tl.dim { color: var(--muted); } .tlog .tl.user { color: var(--working); } .tlog .tl.warn { color: var(--blocked); }
.pb.tx { display: flex; flex-direction: column; }
.pb.tx .tlog { flex: 1 1 0; height: auto; min-height: 0; }
.tbanner { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; flex: none; margin: 0 8px 6px 0; padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--working) 45%, var(--line)); border-radius: 7px; background: color-mix(in srgb, var(--working) 10%, var(--card)); font-size: 12.5px; }
.tbanner.needs { border-color: color-mix(in srgb, var(--blocked) 55%, var(--line)); background: color-mix(in srgb, var(--blocked) 10%, var(--card)); }
.tbanner.idle { border-color: var(--line); background: var(--card); }
.tbanner b { font-weight: 600; }
.tbanner .tsub { color: var(--muted); font-size: 12px; flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
.tfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: none; padding: 6px 10px; border-top: 1px solid var(--line); background: var(--card); font-size: 12px; color: var(--muted); }
.tfoot .grow { flex: 1; }
.bcbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: none; padding: 8px 12px; border-top: 1px solid var(--line); background: var(--card); }
.bcbar .bcin { flex: 1 1 260px; min-width: 160px; height: 28px; padding: 0 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--input); font-family: var(--mono); }
.bcbar .bcnote { color: var(--muted); font-size: 12px; }
.toast { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 30; max-width: 80%; padding: 7px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--vscode-menu-background, var(--card)); color: var(--vscode-menu-foreground, var(--text)); box-shadow: 0 6px 18px rgb(0 0 0 / .35); font-size: 12.5px; }
.menu.fixed { position: fixed; margin: 0; max-height: 70vh; overflow: auto; }
.menu .mrow { display: flex; align-items: center; gap: 2px; }
.menu .mrow > button:first-child { flex: 1; }
.menu .mrow .x { flex: none; width: 24px; min-height: 24px; padding: 0; text-align: center; }
.menu button.danger { color: var(--danger-text); }
.menu .mform { display: flex; gap: 6px; padding: 4px; }
.menu .mform input { flex: 1; min-width: 0; height: 26px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--input); }
.menu .mform button { width: auto; min-height: 26px; border: 1px solid var(--line); text-align: center; }
.menu .mnote { margin: 2px 10px 4px; color: var(--muted); font-size: 11.5px; }
@media (prefers-reduced-motion: reduce) { .pzone, .gutter::after, .wempty.over { transition: none; } }
`;

/** Plain JavaScript in String.raw (no backticks and no dollar-brace in it), run after the shell's: it relies on the shell's names and the page's `L` (paneLayout.ts). */
export const WORKSPACE_SCRIPT = String.raw`
// ---- the workspace ---------------------------------------------------------------------------------------------------------
const PANE_W = 280, PANE_H = 140, STAGE_PAD = 6;
const ICO = {
	max: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	restore: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
	close: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
	more: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/></svg>',
};
const ws = {
	layout: L.emptyLayout(),
	views: new Map(),        // pane id -> its view: { el, head, body, over, zone, content, status, term ... }
	splits: new Map(),       // split id -> { kids } of what is drawn now, so a border moves without a rebuild
	drag: undefined,         // { content: () => content } for a session, { pane: id } for a pane
	saved: [],               // the layouts the user named
	got: false,              // the host has said which layout the page had
	touched: false,          // the user changed the workspace: a layout the host sends late is not restored over it
	autostart: new Set(),    // panes the user just opened: they start (or resume) their session; a restored pane never does
	bc: { on: false, checked: new Set() },
	reqs: 0, saveTimer: undefined, toastTimer: undefined, dirty: false,
};
const stage = h('div', { class: 'stage', role: 'region', 'aria-label': 'Terminal workspace' });
const toast = h('div', { class: 'toast hidden', role: 'status' });
const bcInput = h('input', { type: 'text', class: 'bcin', placeholder: 'One line for every checked terminal; Enter sends it', 'aria-label': 'Line to send to every checked terminal', maxlength: '4000' });
const bcNote = h('span', { class: 'bcnote', role: 'status' });
const bcSend = h('button', { type: 'button', class: 'btn small primary', onclick: () => broadcast() }, 'Send');
const bcBar = h('div', { class: 'bcbar hidden', role: 'group', 'aria-label': 'Broadcast' },
	h('b', null, 'Broadcast'), bcInput, bcSend,
	h('button', { type: 'button', class: 'btn small', onclick: () => checkAll(true) }, 'Check all'),
	h('button', { type: 'button', class: 'btn small', onclick: () => checkAll(false) }, 'Check none'), bcNote);
add(work, queueEl, stage, bcBar, toast);

function notice(text) {
	toast.textContent = text;
	toast.className = 'toast';
	clearTimeout(ws.toastTimer);
	ws.toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 4500);
}
const base = p => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
// A share of a split as the CSS flex it is drawn with: no more digits than a pixel can show.
const flexOf = size => (Math.round(size * 10000) / 10000) + ' 1 0px';

// ---- terminals: xterm.js behind a factory ----------------------------------------------------------------------------------
// A factory is make(host, { onData, isChord }) -> { write(text), reset(), fit() -> { cols, rows } | undefined, focus(), dispose(), setTheme() }.
// The tests put a stub on window.insilodeTermFactory; the editor's page has window.insilodeXterm (out/xterm.js); the website has neither.
const termFactory = () => window.insilodeTermFactory || (window.insilodeXterm ? xtermFactory : undefined);
function xtermFactory(host, o) {
	const X = window.insilodeXterm;
	const css = n => getComputedStyle(document.body).getPropertyValue(n).trim();
	const theme = () => {
		const t = { background: css('--vscode-terminal-background') || css('--term-bg'), foreground: css('--vscode-terminal-foreground') || css('--text'),
			cursor: css('--vscode-terminalCursor-foreground') || css('--vscode-terminal-foreground'), selectionBackground: css('--vscode-terminal-selectionBackground') };
		['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'].forEach(c => {
			t[c.toLowerCase()] = css('--vscode-terminal-ansi' + c);
			t['bright' + c] = css('--vscode-terminal-ansiBright' + c);
		});
		for (const k in t) { if (!t[k]) { delete t[k]; } }
		return t;
	};
	const term = new X.Terminal({ cursorBlink: true, scrollback: 5000, fontFamily: css('--vscode-editor-font-family') || 'monospace', fontSize: 12.5, allowProposedApi: false, theme: theme() });
	const fit = new X.FitAddon();
	term.loadAddon(fit);
	term.open(host);
	term.onData(o.onData);
	// A workspace shortcut is the page's, not the agent's: xterm leaves it alone and it bubbles to the page's own key handler.
	term.attachCustomKeyEventHandler(e => !o.isChord(e));
	return {
		write: t => term.write(t), reset: () => term.reset(), focus: () => term.focus(), dispose: () => term.dispose(), setTheme: () => { term.options.theme = theme(); },
		fit: () => {
			// A pane that is not on screen has no size to fit to.
			if (!host.offsetWidth || !host.offsetHeight) { return undefined; }
			try { fit.fit(); } catch (e) { return undefined; }
			return { cols: term.cols, rows: term.rows };
		},
	};
}
const CHORD = { KeyN: 'needs', BracketRight: 'next', BracketLeft: 'prev', Backslash: 'splitRight', Minus: 'splitDown', NumpadSubtract: 'splitDown', KeyW: 'close', KeyM: 'max', KeyB: 'broadcast', KeyS: 'sidebar', Comma: 'moveBack', Period: 'moveFwd' };
const chordOf = e => e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey ? CHORD[e.code] : undefined;
if (typeof MutationObserver === 'function') {
	// The theme (light, dark, high contrast) changes the variables the terminals draw with.
	new MutationObserver(() => { for (const pv of ws.views.values()) { if (pv.term && pv.term.setTheme) { pv.term.setTheme(); } } }).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
}

// ---- what a pane knows about its session ----------------------------------------------------------------------------------
const identOf = c => c.resume || c.session || '';
function findPane(c) {
	for (const pv of ws.views.values()) {
		const p = pv.content;
		if ((c.session && p.session === c.session) || (identOf(c) && (identOf(p) === identOf(c) || p.session === identOf(c)))) { return pv; }
	}
	return undefined;
}
const isOpen = c => !!findPane(c);
// x: the session of the machine's index that a read-only pane (content.ext) shows, with whatever outside this window runs it ({ p, s }).
function infoOf(pv) {
	const c = pv.content;
	const own = c.session ? rowById(c.session) : undefined;
	const peer = !own && c.session && c.peer ? peerById(c.session) : undefined;
	const x = !own && !peer && c.ext !== undefined && c.session ? indexed(c.agent, c.session) : undefined;
	return { own, peer, s: own || (peer && peer.r), x };
}
function titleOf(pv) {
	const i = infoOf(pv);
	return (i.s && i.s.name) || (i.x && i.x.s.title) || pv.content.title || CLI_NAME[pv.content.agent] || 'Session';
}
function dotFor(pv) {
	const i = infoOf(pv);
	if (i.s) { return dotOf(i.s); }
	if (pv.content.ext !== undefined) { const l = i.x && liveOf(i.x.s); return l ? liveDot(l) : 'idle'; }
	return pv.status === 'starting' || pv.status === 'live' ? 'working' : 'idle';
}
const needsYou = pv => { const i = infoOf(pv); const l = i.x && liveOf(i.x.s); return !!(i.s && needKind(i.s)) || !!(l && l.basis === 'live' && l.status === 'needs'); };
const paneClass = pv => cls('pane', ws.layout.focus === pv.id && 'active', ws.layout.max === pv.id && 'maxed', pv.status === 'ended' && 'ended',
	needsYou(pv) && 'needs', bcEligible(pv) && ws.bc.on && ws.bc.checked.has(pv.id) && 'target');
// A read-only pane of a session some other program runs (or ran): it reads the conversation again while that goes on.
const isExt = pv => pv.content.kind === 'transcript' && pv.content.ext !== undefined && !!pv.content.session && (pv.content.agent === 'claude' || pv.content.agent === 'codex') && UUID.test(pv.content.session);
const requestTail = pv => post({ type: 'tail', id: pv.content.session, kind: pv.content.agent });
function refreshExtPanes() { for (const pv of ws.views.values()) { if (isExt(pv)) { paintPane(pv); requestTail(pv); } } }
setInterval(() => {
	if (document.hidden) { return; }
	for (const pv of ws.views.values()) { const l = isExt(pv) && infoOf(pv).x && liveOf(infoOf(pv).x.s); if (l) { requestTail(pv); } }
}, 3000);

// ---- views of the panes ----------------------------------------------------------------------------------------------------
function makeView(leaf) {
	const pv = { id: leaf.id, content: leaf.content, status: 'idle', error: '', req: undefined, term: undefined, attached: undefined, cols: 0, rows: 0, ticks: [], fitTimer: undefined, ro: undefined };
	pv.head = h('header', { class: 'ph', draggable: 'true', title: 'Drag to move this pane; double-click to maximize' });
	pv.body = h('div', { class: 'pb' });
	pv.over = h('div', { class: 'pover hidden' });
	pv.zone = h('div', { class: 'pzone', 'aria-hidden': 'true' });
	pv.el = h('section', { class: 'pane', tabindex: '0', role: 'group', 'aria-label': 'Pane' }, pv.head, pv.body, pv.over, pv.zone);
	pv.el.addEventListener('focusin', () => setFocus(pv.id, false));
	pv.el.addEventListener('mousedown', () => setFocus(pv.id, false));
	pv.el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === pv.el) { e.preventDefault(); setFocus(pv.id, true); } });
	pv.head.addEventListener('dblclick', e => { if (!e.target || e.target.tagName !== 'BUTTON') { toggleMax(pv.id); } });
	pv.head.addEventListener('dragstart', e => {
		beginDrag({ pane: pv.id }, e);
	});
	pv.head.addEventListener('dragend', () => endDrag());
	const over = e => {
		if (!ws.drag || ws.drag.pane === pv.id) { return; }
		e.preventDefault();
		if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
		const r = pv.el.getBoundingClientRect ? pv.el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
		showZone(pv, L.dropZone(r.width, r.height, e.clientX - r.left, e.clientY - r.top));
	};
	pv.el.addEventListener('dragenter', over);
	pv.el.addEventListener('dragover', over);
	pv.el.addEventListener('dragleave', e => { if (!e.relatedTarget || !pv.el.contains(e.relatedTarget)) { showZone(pv, undefined); } });
	pv.el.addEventListener('drop', e => {
		if (!ws.drag) { return; }
		e.preventDefault();
		const zone = pv.zoneName || 'center';
		dropOn(pv.id, zone);
	});
	return pv;
}
function showZone(pv, zone) {
	if (pv.zoneName === zone) { return; }
	pv.zoneName = zone;
	pv.zone.className = 'pzone' + (zone ? ' on z-' + zone : '');
}
function clearZones() { for (const pv of ws.views.values()) { showZone(pv, undefined); } emptyEl.className = 'wempty'; }

function beginDrag(d, e) {
	ws.drag = d;
	stage.className = 'stage dragging';
	if (e && e.dataTransfer) {
		// Firefox starts no drag without data; the page itself reads what is dragged from ws.drag.
		try { e.dataTransfer.setData('application/x-insilode-agents', 'x'); e.dataTransfer.effectAllowed = 'copyMove'; } catch (x) { /* a drag the browser refuses */ }
	}
}
function endDrag() {
	ws.drag = undefined;
	stage.className = 'stage';
	clearZones();
	if (ws.dirty) { ws.dirty = false; paintSide(); }
}

// ---- the layout on screen --------------------------------------------------------------------------------------------------
const emptyEl = h('div', { class: 'wempty' });
function paintEmpty() {
	fill(emptyEl, [h('b', null, 'Drag a session here, or start a new one'),
		h('p', null, 'Every pane is a live terminal. Drop a session from the list on the left to open it, on the middle of a pane to put it there, or on an edge to split the pane.'),
		h('div', { class: 'row' }, startBtn('claude', 'New Claude'), startBtn('codex', 'New Codex')),
		h('p', null, h('span', { class: 'kbd' }, 'Alt+Shift+\\'), ' splits with the selected session, ', h('span', { class: 'kbd' }, 'Alt+Shift+]'), ' moves between panes.')]);
}
function startBtn(cli, label) {
	return h('button', { type: 'button', class: 'btn primary', title: 'Start ' + CLI_NAME[cli] + ' in a new pane', onclick: () => startNew(cli) }, raw('span', 'mk', MARK[cli]), label);
}
emptyEl.addEventListener('dragover', e => { if (ws.drag && !ws.layout.root) { e.preventDefault(); emptyEl.className = 'wempty over'; } });
emptyEl.addEventListener('dragleave', () => { emptyEl.className = 'wempty'; });
emptyEl.addEventListener('drop', e => {
	if (!ws.drag) { return; }
	e.preventDefault();
	const d = ws.drag;
	endDrag();
	if (d.content) { openContent(d.content()); }
});

function nodeEl(n) {
	if (n.type === 'pane') { return ws.views.get(n.id).el; }
	const wrap = h('div', { class: 'sp ' + n.dir, 'data-split': n.id });
	const kids = [];
	n.children.forEach((c, i) => {
		const el = nodeEl(c);
		el.style.flex = flexOf(n.sizes[i]);
		kids.push(el);
		if (i > 0) { wrap.appendChild(gutter(n, i - 1, wrap)); }
		wrap.appendChild(el);
	});
	ws.splits.set(n.id, { kids, wrap });
	return wrap;
}
function render() {
	wipe(stage);
	ws.splits.clear();
	const l = ws.layout;
	const max = l.max ? ws.views.get(l.max) : undefined;
	if (!l.root) {
		paintEmpty();
		add(stage, emptyEl);
	} else if (max) {
		max.el.style.flex = '1 1 0px';
		add(stage, max.el);
	} else {
		const root = nodeEl(l.root);
		root.style.flex = '1 1 0px';
		add(stage, root);
	}
	paintActive();
	for (const pv of ws.views.values()) { scheduleFit(pv); }
}
function paintActive() { for (const pv of ws.views.values()) { pv.el.className = paneClass(pv); } }

// A border between two children of a split: drag it, or focus it and use the arrow keys.
function gutter(n, index, wrap) {
	const horizontal = n.dir === 'row';
	const g = h('div', { class: 'gutter ' + (horizontal ? 'v' : 'h'), role: 'separator', tabindex: '0', 'aria-orientation': horizontal ? 'vertical' : 'horizontal', 'aria-label': 'Resize panes' });
	g.setAttribute('aria-valuemin', '0');
	g.setAttribute('aria-valuemax', '100');
	g.setAttribute('aria-valuenow', String(Math.round(n.sizes[index] * 100)));
	const room = () => {
		const r = wrap.getBoundingClientRect ? wrap.getBoundingClientRect() : { width: 0, height: 0 };
		return Math.max(0, (horizontal ? r.width : r.height) - 6 * (n.children.length - 1));
	};
	const nudge = (delta) => {
		const total = room();
		const min = total > 0 ? (horizontal ? PANE_W : PANE_H) / total : 0.1;
		const next = L.resize(ws.layout, n.id, index, delta, Math.min(min, 0.45));
		if (next !== ws.layout) {
			ws.layout = next;
			applySizes(n.id);
			const now = findSplitNode(next.root, n.id);
			if (now) { g.setAttribute('aria-valuenow', String(Math.round(now.sizes[index] * 100))); }
			layoutChanged();
		}
	};
	let from;
	g.addEventListener('pointerdown', e => {
		e.preventDefault();
		from = { at: horizontal ? e.clientX : e.clientY, layout: ws.layout };
		g.className += ' drag';
		if (g.setPointerCapture && e.pointerId !== undefined) { try { g.setPointerCapture(e.pointerId); } catch (x) { /* no capture: the drag still follows */ } }
	});
	g.addEventListener('pointermove', e => {
		if (!from) { return; }
		const total = room();
		if (total <= 0) { return; }
		ws.layout = from.layout;
		nudge(((horizontal ? e.clientX : e.clientY) - from.at) / total);
	});
	const stop = () => { if (from) { from = undefined; g.className = g.className.replace(' drag', ''); scheduleSave(); } };
	g.addEventListener('pointerup', stop);
	g.addEventListener('pointercancel', stop);
	g.addEventListener('keydown', e => {
		const back = horizontal ? 'ArrowLeft' : 'ArrowUp', fwd = horizontal ? 'ArrowRight' : 'ArrowDown';
		if (e.key !== back && e.key !== fwd) { return; }
		e.preventDefault();
		e.stopPropagation();
		nudge((e.key === fwd ? 1 : -1) * (e.shiftKey ? 0.1 : 0.02));
	});
	return g;
}
function applySizes(splitId) {
	const el = ws.splits.get(splitId);
	const split = findSplitNode(ws.layout.root, splitId);
	if (!el || !split) { return; }
	el.kids.forEach((k, i) => { k.style.flex = flexOf(split.sizes[i]); });
	for (const pv of ws.views.values()) { scheduleFit(pv); }
}
function findSplitNode(n, id) {
	if (!n || n.type === 'pane') { return undefined; }
	if (n.id === id) { return n; }
	for (const c of n.children) { const f = findSplitNode(c, id); if (f) { return f; } }
	return undefined;
}

// ---- changing the layout ---------------------------------------------------------------------------------------------------
function stageFits(layout) {
	const r = stage.getBoundingClientRect ? stage.getBoundingClientRect() : { width: 0, height: 0 };
	// A workspace that is not on screen (another view) has no size to check against.
	return !r.width || !r.height || L.fits(layout, r.width - 2 * STAGE_PAD, r.height - 2 * STAGE_PAD, PANE_W, PANE_H);
}
const sameSource = (a, b) => a.kind === b.kind && a.session === b.session && a.resume === b.resume && a.cwd === b.cwd;
function commit(next, load) {
	const ids = new Set(L.panes(next).map(p => p.id));
	for (const [id, pv] of [...ws.views]) {
		if (!ids.has(id)) { unmount(pv); ws.views.delete(id); ws.bc.checked.delete(id); }
	}
	ws.layout = next;
	for (const leaf of L.panes(next)) {
		let pv = ws.views.get(leaf.id);
		if (!pv) {
			pv = makeView(leaf);
			ws.views.set(leaf.id, pv);
			setup(pv, ws.autostart.delete(leaf.id));
		} else if (!sameSource(pv.content, leaf.content)) {
			unmountContent(pv);
			pv.content = leaf.content;
			setup(pv, ws.autostart.delete(leaf.id));
		} else {
			pv.content = leaf.content;
		}
	}
	if (!load) { ws.touched = true; }
	render();
	paintSide();
	paintWorkspace();
	layoutChanged();
}
function layoutChanged() { paintBroadcast(); scheduleSave(); }
function scheduleSave() {
	if (!ws.got) { return; }
	clearTimeout(ws.saveTimer);
	ws.saveTimer = setTimeout(() => post({ type: 'layoutSave', layout: ws.layout }), 500);
}
// A change to what a pane says about its own session (the id it got, its title): saved, but the pane is not rebuilt and the focus stays where it is.
function patchContent(pv, patch) {
	const content = Object.assign({}, pv.content, patch);
	const focus = ws.layout.focus;
	const next = Object.assign({}, L.replaceContent(ws.layout, pv.id, content));
	if (focus === undefined) { delete next.focus; } else { next.focus = focus; }
	ws.layout = next;
	pv.content = content;
	scheduleSave();
}
function setFocus(id, grab) {
	if (!ws.views.has(id)) { return; }
	if (ws.layout.focus !== id) {
		ws.layout = L.focusPane(ws.layout, id);
		paintActive();
		scheduleSave();
	}
	if (grab) {
		const pv = ws.views.get(id);
		if (pv.term) { pv.term.focus(); } else { pv.el.focus(); }
	}
}
const focusTarget = () => ws.layout.focus && ws.views.has(ws.layout.focus) ? ws.layout.focus : (L.panes(ws.layout)[0] || {}).id;

// Opens a session. With no options it takes the place of the focused pane (or opens the first one); { beside } splits the focused pane;
// { target, zone } is a drop. A session that is open already is shown where it is (focused, or moved there by a drop): never twice.
function openContent(content, o) {
	o = o || {};
	const same = findPane(content);
	if (same && o.target && o.zone) { return dropMove(same.id, o.target, o.zone); }
	if (same) { return setFocus(same.id, true); }
	let next, id;
	const target = o.target || focusTarget();
	if (!ws.layout.root) {
		({ layout: next, id } = L.openPane(ws.layout, content));
	} else if (o.beside || (o.zone && o.zone !== 'center')) {
		({ layout: next, id } = L.splitPane(ws.layout, target, o.beside || o.zone, content));
		if (!id) { return notice('At most 16 panes. Close one first.'); }
		// A new pane that does not fit to the right of the focused one goes below it instead, when that fits.
		if (o.beside === 'right' && !stageFits(next)) {
			const below = L.splitPane(ws.layout, target, 'bottom', content);
			if (below.id && stageFits(below.layout)) { next = below.layout; id = below.id; }
		}
	} else {
		next = L.replaceContent(ws.layout, target, content);
		id = target;
	}
	if (!id) { return notice('At most 16 panes. Close one first.'); }
	if (!stageFits(next)) { return notice('There is no room for another pane here. Close one, or make the window larger.'); }
	ws.autostart.add(id);
	commit(next);
	setFocus(id, true);
}
function dropMove(src, target, zone) {
	if (src === target) { return; }
	const next = L.movePane(ws.layout, src, target, zone);
	if (zone !== 'center' && !stageFits(next)) { return notice('There is no room to move the pane there. Close one, or make the window larger.'); }
	commit(next);
	setFocus(src, false);
}
function dropOn(targetId, zone) {
	const d = ws.drag;
	endDrag();
	if (!d) { return; }
	if (d.pane) { return dropMove(d.pane, targetId, zone); }
	openContent(d.content(), { target: targetId, zone });
}
// A sidebar row or a card opened by a click or Enter: in the focused pane.
function openInPane(content) { setView('work'); openContent(content); }
function openBeside(content, edge) { setView('work'); openContent(content, { beside: edge }); }
// A new session of its own pane, in this window's folder or another project's.
function startNew(cli, cwd, folder) {
	setView('work');
	openContent({ kind: 'terminal', agent: cli, ...(cwd ? { cwd } : {}), ...(folder ? { folder } : {}), title: 'New ' + CLI_NAME[cli] }, { beside: 'right' });
}
function closeView(id) {
	if (!ws.views.has(id)) { return; }
	commit(L.closePane(ws.layout, id));
	if (ws.layout.focus) { setFocus(ws.layout.focus, true); }
}
function toggleMax(id) { commit(L.toggleMaximize(ws.layout, id)); setFocus(id, false); }
function loadLayout(layout) {
	for (const pv of ws.views.values()) { unmount(pv); }
	ws.views.clear();
	ws.bc.checked.clear();
	ws.autostart.clear();
	commit(layout, true);
}

// ---- a pane's session: attach, start, resume, end ---------------------------------------------------------------------------
function unmountContent(pv) {
	if (pv.attached) { post({ type: 'termDetach', id: pv.attached }); }
	pv.attached = undefined;
	pv.req = undefined;
	clearTimeout(pv.fitTimer);
	if (pv.ro) { pv.ro.disconnect(); pv.ro = undefined; }
	if (pv.term) { pv.term.dispose(); pv.term = undefined; }
	wipe(pv.body);
	pv.body.className = 'pb';
	pv.cols = 0; pv.rows = 0;
	pv.sig = undefined; pv.osig = undefined; pv.tsig = undefined;
}
function unmount(pv) { unmountContent(pv); }
// A pane that has its content: a transcript draws itself; a terminal attaches to its session, starts it (when the user just opened it),
// or, when the session is not one this window runs, waits showing "Session ended" with a button.
function setup(pv, start) {
	const c = pv.content;
	pv.status = 'idle';
	pv.error = '';
	if (c.kind === 'transcript') { if (isExt(pv)) { requestTail(pv); } return; }
	if (!c.session) {
		if (start) { return startPane(pv); }
		pv.status = 'ended';
		return;
	}
	const own = rowById(c.session);
	if (start && own && own.state === 'ended') { return startPane(pv); }
	attachPane(pv);
}
function attachPane(pv) {
	const make = termFactory();
	// A page with no terminal (the website, a checkout that was not built) shows what the host can read of the conversation instead.
	if (!make) { pv.status = 'noterm'; post({ type: 'tail', id: pv.content.session }); return; }
	if (!pv.term) {
		pv.term = make(pv.body, { onData: d => sendInput(pv, d), isChord: e => !!chordOf(e) });
		if (typeof ResizeObserver === 'function') { pv.ro = new ResizeObserver(() => scheduleFit(pv)); pv.ro.observe(pv.body); }
	}
	pv.status = 'live';
	pv.attached = pv.content.session;
	post({ type: 'termAttach', id: pv.attached });
	scheduleFit(pv);
}
function sendInput(pv, data) {
	if (pv.status !== 'live' || !pv.attached) { return; }
	// The host takes at most 64 KB at once: a large paste goes in pieces, in order.
	for (let i = 0; i < data.length; i += 32768) { post({ type: 'termInput', id: pv.attached, data: data.slice(i, i + 32768) }); }
}
function startPane(pv) {
	const c = pv.content;
	if (c.agent !== 'claude' && c.agent !== 'codex') { pv.status = 'ended'; pv.error = 'This agent cannot be started from here.'; return; }
	if (pv.attached) { post({ type: 'termDetach', id: pv.attached }); pv.attached = undefined; }
	pv.req = 'w' + (++ws.reqs) + '-' + Date.now().toString(36);
	pv.status = 'starting';
	pv.error = '';
	post({ type: 'termOpen', requestId: pv.req, kind: c.agent, ...(c.resume ? { sessionId: c.resume } : {}), ...(c.cwd ? { cwd: c.cwd } : {}) });
}
// A read-only pane becomes the terminal of the session: the host asks the machine again and refuses a session that something still runs.
function resumeHere(pv) {
	const c = pv.content;
	const next = L.replaceContent(ws.layout, pv.id, { kind: 'terminal', agent: c.agent, resume: c.resume || c.session, ...(c.cwd ? { cwd: c.cwd } : {}), ...(c.folder ? { folder: c.folder } : {}), ...(c.title ? { title: c.title } : {}) });
	ws.autostart.add(pv.id);
	commit(next);
	setFocus(pv.id, true);
}
function scheduleFit(pv) {
	if (!pv.term) { return; }
	clearTimeout(pv.fitTimer);
	pv.fitTimer = setTimeout(() => fitNow(pv), 120);
}
function fitNow(pv) {
	if (!pv.term) { return; }
	const s = pv.term.fit();
	if (!s) { return; }
	const cols = clamp(Math.floor(s.cols) || 0, 2, 500), rows = clamp(Math.floor(s.rows) || 0, 1, 300);
	if (pv.attached && (cols !== pv.cols || rows !== pv.rows)) {
		pv.cols = cols; pv.rows = rows;
		post({ type: 'termResize', id: pv.attached, cols, rows });
	}
}
const paneOf = id => [...ws.views.values()].filter(pv => pv.content.kind === 'terminal' && pv.attached === id);
function wsMessage(m) {
	if (m.type === 'termData') {
		for (const pv of paneOf(m.id)) {
			if (!pv.term || typeof m.data !== 'string') { continue; }
			if (m.reset) { pv.term.reset(); }
			if (m.data) { pv.term.write(m.data); }
			if (pv.status === 'ended') { pv.status = 'live'; paintPane(pv); }
		}
	} else if (m.type === 'termGone') {
		for (const pv of paneOf(m.id)) { pv.status = 'ended'; pv.attached = undefined; paintPane(pv); paintBroadcast(); }
	} else if (m.type === 'termOpened') {
		const pv = [...ws.views.values()].find(p => p.req && p.req === m.requestId);
		if (!pv || typeof m.id !== 'string') { return; }
		pv.req = undefined;
		const other = [...ws.views.values()].find(p => p !== pv && p.content.session === m.id);
		// The session was open in another pane already: that one stays, this pane (a duplicate) goes.
		if (other) { closeView(pv.id); setFocus(other.id, true); return; }
		patchContent(pv, { session: m.id });
		const row = rowById(m.id);
		if (row && (!pv.content.cwd) && row.cwd) { patchContent(pv, { cwd: row.cwd }); }
		attachPane(pv);
		paintPane(pv);
		paintBroadcast();
		setFocus(pv.id, true);
	} else if (m.type === 'termFailed') {
		const pv = [...ws.views.values()].find(p => p.req && p.req === m.requestId);
		if (!pv) { return; }
		pv.req = undefined;
		pv.status = 'failed';
		pv.error = String(m.message || 'The session could not be started.');
		paintPane(pv);
	} else if (m.type === 'tail') {
		tails.set(m.id, { entries: Array.isArray(m.entries) ? m.entries : [], note: m.note });
		for (const pv of ws.views.values()) { if ((pv.content.kind === 'transcript' || pv.status === 'noterm') && pv.content.session === m.id) { paintPane(pv); } }
	} else if (m.type === 'layouts') {
		ws.saved = Array.isArray(m.saved) ? m.saved.filter(x => x && typeof x.name === 'string' && L.parse(x.layout)) : [];
		if (!ws.got) {
			ws.got = true;
			const cur = m.current ? L.parse(m.current) : undefined;
			// Only a workspace nobody touched is restored; a pane whose session still runs attaches again, any other waits for "Resume".
			if (cur && cur.root && !ws.touched && !ws.layout.root) { loadLayout(cur); }
			else if (ws.touched) { scheduleSave(); }
		}
	} else {
		return false;
	}
	return true;
}

// ---- painting the panes ----------------------------------------------------------------------------------------------------
function paintWorkspace() {
	for (const pv of ws.views.values()) { paintPane(pv); }
	paintBroadcast();
}
function paneMenuItems(pv) {
	const { own, peer, s } = infoOf(pv);
	const items = [];
	const item = (label, msg, o) => items.push(Object.assign({ label, run: () => post(msg) }, o || {}));
	if (own) {
		const canSwap = (own.cli === 'claude' || own.cli === 'codex') && ['idle', 'done', 'unknown'].indexOf(own.state) >= 0;
		const canCompact = own.usage && own.cli !== 'custom' && (own.state === 'idle' || own.state === 'done');
		const w = own.worktree;
		if (w) { item('Show changes on the flow canvas', { type: 'wt', id: own.id, action: 'diff' }); }
		(own.impact ? own.impact.flows : []).slice(0, 3).forEach((f, i) => item('Open flow: ' + f.label, { type: 'flow', id: own.id, index: i }));
		if (own.explain) { item('Explain what it changed', { type: 'explain', id: own.id }); }
		item('Show its terminal in the editor', { type: 'show', id: own.id });
		item('Rename…', { type: 'rename', id: own.id });
		if (canCompact) { item('Compact the conversation', { type: 'compact', id: own.id }); }
		if (ctxPct(own) !== undefined) { item('X-ray the context window', { type: 'xray', id: own.id }); }
		if (own.pr) { item('Open pull request #' + own.pr.number, { type: 'pr', id: own.id }); }
		if (canSwap) { item('Swap to ' + (own.cli === 'claude' ? 'Codex' : 'Claude'), { type: 'swap', id: own.id }); }
		if (own.skeletonAvailable) { item(own.skeletonOn ? 'Skeleton first: on (turn off)' : 'Skeleton first: off (turn on)', { type: 'sk', id: own.id, on: !own.skeletonOn }); }
		if (w && own.state !== 'ended') {
			items.push({ sep: true });
			item('Open the worktree folder', { type: 'wt', id: own.id, action: 'open' });
			item('Merge ' + w.branch + '…', { type: 'wt', id: own.id, action: 'merge' });
			item('Remove the worktree…', { type: 'wt', id: own.id, action: 'remove' }, { danger: true });
		}
		if (own.state === 'ended') { items.push({ sep: true }); item('Forget this session', { type: 'forget', id: own.id }, { danger: true }); }
	} else if (peer) {
		item('Go to that window', { type: 'peer', action: 'ide', key: peer.p.key, id: peer.r.id });
		if (peer.r.flows) { item('Open flow in that window', { type: 'peer', action: 'flow', key: peer.p.key, id: peer.r.id }); }
	}
	if (items.length) { items.push({ sep: true }); }
	items.push({ label: ws.layout.max === pv.id ? 'Restore pane size' : 'Maximize pane', run: () => toggleMax(pv.id), disabled: L.panes(ws.layout).length < 2 });
	items.push({ label: 'Close pane (the session keeps running)', run: () => closeView(pv.id) });
	return items;
}
function paintPane(pv) {
	const c = pv.content;
	const { own, peer, s, x } = infoOf(pv);
	const xl = x && liveOf(x.s);
	const dot = dotFor(pv);
	const title = titleOf(pv);
	const folder = (own && own.cwd ? base(own.cwd) : '') || c.folder || (c.cwd ? base(c.cwd) : '') || (peer ? peer.p.name : '');
	const branch = own && own.worktree ? own.worktree.branch : '';
	const eligible = bcEligible(pv);
	const maxed = ws.layout.max === pv.id;
	const multi = L.panes(ws.layout).length > 1;
	const checked = eligible && ws.bc.on && ws.bc.checked.has(pv.id);
	// The header is built again only when something it shows changed: a data message arrives with every hook event, and a repaint would take the focus from a button the keyboard is on.
	const sig = JSON.stringify([title, dot, folder, branch, c.agent, c.cwd, own && own.clash && own.clash.map(x => x.text), s && [s.state, needKind(s), s.since, s.need && s.need.at], c.ext !== undefined && [xl && [xl.status, xl.source, xl.basis], chat.got], eligible, ws.bc.on && c.kind === 'terminal', checked, maxed, multi]);
	if (sig !== pv.sig) {
		pv.sig = sig;
		pv.ticks = [];
		const mark = c.agent === 'claude' || c.agent === 'codex' ? raw('span', 'mark', MARK[c.agent] + '') : h('span', { class: 'mark cust' }, 'custom');
		mark.setAttribute('title', CLI_NAME[c.agent] || c.agent);
		const state = s ? (function () { const e = h('span', { class: 'pstate s-' + (needKind(s) || s.state) }, stateText(s)); pv.ticks.push(() => { e.textContent = stateText(s); }); return e; })() : null;
		const xstate = xl ? h('span', { class: 'pstate' + (xl.basis === 'live' && xl.status === 'needs' ? ' s-blocked' : ''), title: liveTip(xl) }, xl.basis === 'recent' ? 'Active recently' : LIVE_TEXT[xl.status]) : null;
		const tools = [];
		if (ws.bc.on && c.kind === 'terminal') {
			const box = h('input', { type: 'checkbox', 'aria-label': 'Broadcast to ' + title, disabled: !eligible || null });
			box.checked = checked;
			box.addEventListener('change', e => { if (e.target.checked) { ws.bc.checked.add(pv.id); } else { ws.bc.checked.delete(pv.id); } paintPane(pv); paintActive(); paintBroadcast(); });
			tools.push(h('label', { class: 'bcb', title: eligible ? 'Send the broadcast line to this terminal' : 'Not an attached terminal' }, box, 'Send'));
			if (checked) { tools.push(h('span', { class: 'bctag' }, 'Receives broadcast')); }
		}
		const menuBtn = h('button', { type: 'button', class: 'ibtn', title: 'Session actions', 'aria-label': 'Actions for ' + title, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, raw('span', null, ICO.more));
		menuBtn.addEventListener('click', e => { e.stopPropagation(); showMenu(menuBtn, () => paneMenuItems(pv)); });
		fill(pv.head, [h('i', { class: 'sdot ' + dot, title: DOT_LABEL[dot], style: 'margin-top:0' }), mark,
			h('span', { class: 'pt', title: title }, title), folder ? h('span', { class: 'pf', title: c.cwd || (own && own.cwd) || folder }, folder) : null, branch ? h('span', { class: 'pbr', title: 'Worktree branch ' + branch }, '⎇ ' + branch) : null,
			own && own.clash && own.clash.length ? h('span', { class: 'warnic', title: own.clash.map(x => x.text).join('\n') }, '⚠') : null, state, xl ? xbadge(xl) : null, xstate,
			h('span', { class: 'pgrow' }), tools,
			multi ? h('button', { type: 'button', class: 'ibtn', title: (maxed ? 'Restore' : 'Maximize') + ' (Alt+Shift+M)', 'aria-label': (maxed ? 'Restore ' : 'Maximize ') + title, 'aria-pressed': maxed ? 'true' : 'false', onclick: () => toggleMax(pv.id) }, raw('span', null, maxed ? ICO.restore : ICO.max)) : null,
			menuBtn,
			h('button', { type: 'button', class: 'ibtn', title: 'Close pane; the session keeps running (Alt+Shift+W)', 'aria-label': 'Close pane ' + title, onclick: () => closeView(pv.id) }, raw('span', null, ICO.close))]);
		pv.el.setAttribute('aria-label', title + ', ' + CLI_NAME[c.agent] + ', ' + DOT_LABEL[dot]);
	}
	pv.el.className = paneClass(pv);
	paintOver(pv);
	if (c.kind === 'transcript' || pv.status === 'noterm') { paintTranscript(pv); }
}
function paintOver(pv) {
	const c = pv.content;
	const where = c.folder || base(c.cwd) || 'this project';
	const resumes = !!(c.resume || c.session);
	const canStart = (c.agent === 'claude' || c.agent === 'codex') && c.kind === 'terminal';
	const go = () => { startPane(pv); paintPane(pv); };
	let spec;
	if (pv.status === 'starting') {
		spec = { title: 'Starting…', text: (c.resume ? 'Resuming the session in ' : 'Starting ' + CLI_NAME[c.agent] + ' in ') + where + '.' };
	} else if (pv.status === 'ended') {
		spec = { title: 'Session ended', text: pv.error || (resumes ? 'It is not running in this window.' : 'It has not been started yet.'), bad: !!pv.error, button: canStart ? [resumes ? 'Resume' : 'Start session', go, 'primary'] : undefined };
	} else if (pv.status === 'failed') {
		spec = { title: 'Could not start', text: pv.error, bad: true, button: ['Retry', go, 'primary'] };
	}
	// Built again only when what it says changed, so a button the keyboard is on keeps its focus.
	const sig = spec ? JSON.stringify([spec.title, spec.text, spec.bad, spec.button && spec.button[0]]) : '';
	if (sig !== pv.osig) {
		pv.osig = sig;
		if (spec) {
			fill(pv.over, [h('div', { class: 'pm', role: spec.bad ? 'alert' : 'status' }, h('b', null, spec.title), spec.text ? h('small', { class: spec.bad ? 'errtxt' : null }, spec.text) : null),
				spec.button ? h('div', { class: 'row2' }, h('button', { type: 'button', class: 'btn ' + spec.button[2], onclick: spec.button[1] }, spec.button[0])) : null]);
		} else {
			wipe(pv.over);
		}
	}
	pv.over.className = spec ? 'pover' : 'pover hidden';
}
// The read-only pane: what the session publishes (another window's) or the conversation tail the host read, set as a terminal log.
function paintTranscript(pv) {
	const c = pv.content;
	const { peer, s, x } = infoOf(pv);
	const lines = [];
	const line = (text, k) => lines.push([text, k || '']);
	const ext = c.ext !== undefined && !s;
	if (ext) {
		const tail = tails.get(c.session);
		for (const m of tail ? tail.entries : []) { line((m.role === 'user' ? '> ' : m.role === 'tool' ? '$ ' : '') + m.text, m.role === 'user' ? 'user' : m.role === 'tool' ? 'dim' : ''); }
		if (!lines.length) { line(tail ? tail.note || 'Nothing to show yet.' : 'Reading the conversation…', 'dim'); }
	} else if (!s) {
		line('This session is not listed any more: its window may be closed.', 'dim');
	} else {
		if (s.prompt) { line('> ' + s.prompt, 'user'); }
		const need = s.need && typeof s.need === 'object' ? s.need.text : s.need;
		if (need) { line('! ' + need, 'warn'); }
		if (s.activity) { line('… ' + s.activity, 'dim'); }
		for (const t of s.todos || []) { line((t.status === 'completed' ? '[x] ' : t.status === 'in_progress' ? '[>] ' : '[ ] ') + t.text); }
		const tail = tails.get(c.session);
		for (const m of tail ? tail.entries : []) { line((m.role === 'user' ? '> ' : m.role === 'tool' ? '$ ' : '') + m.text, m.role === 'user' ? 'user' : m.role === 'tool' ? 'dim' : ''); }
		if (tail && !tail.entries.length && tail.note && !peer) { line(tail.note, 'dim'); }
		if (lines.length === 0) { line('Nothing to show yet.', 'dim'); }
	}
	const noterm = pv.status === 'noterm';
	// The banner of a read-only pane of a session another program runs: who runs it, or how to take it over once nothing does. A session that something still runs is never offered for resuming.
	const xl = x && liveOf(x.s);
	let banner;
	if (ext) {
		const resume = () => resumeHere(pv);
		if (xl && xl.basis === 'live') { banner = { cls: xl.status === 'needs' ? 'needs' : '', title: 'Running in ' + xl.source + ' — read-only here', sub: LIVE_TEXT[xl.status] + '. Close it there to resume it here.' }; }
		else if (xl) { banner = { cls: 'idle', title: 'Active recently in Codex — read-only here', sub: 'Its transcript changed in the last 2 minutes. That is an estimate: Codex lists no running sessions, so it may still be running.', button: ['Resume here anyway', resume] }; }
		else if (!chat.got) { banner = { cls: 'idle', title: 'Checking whether it still runs elsewhere…' }; }
		else { banner = { cls: 'idle', title: 'No longer running elsewhere', sub: 'Pick it up in a terminal here.', button: ['Resume here', resume] }; }
	}
	const sig = JSON.stringify([lines, titleOf(pv), noterm, peer && [peer.p.name, peer.p.key, peer.r.id, !!peer.r.flows], banner && [banner.cls, banner.title, banner.sub, banner.button && banner.button[0]]]);
	if (sig === pv.tsig) { return; }
	pv.tsig = sig;
	const old = pv.body.querySelector ? pv.body.querySelector('.tlog') : pv.body.firstChild;
	const atEnd = !old || old.scrollTop === undefined || old.scrollTop + old.clientHeight >= old.scrollHeight - 4;
	const log = h('div', { class: 'tlog', tabindex: '0', role: 'log', 'aria-label': 'Transcript of ' + titleOf(pv) }, lines.map(l => h('div', { class: 'tl' + (l[1] ? ' ' + l[1] : '') }, l[0])));
	pv.body.className = 'pb tx';
	fill(pv.body, [banner ? h('div', { class: 'tbanner ' + banner.cls, role: 'status' }, h('b', null, banner.title), banner.sub ? h('span', { class: 'tsub' }, banner.sub) : null,
		banner.button ? h('button', { type: 'button', class: 'btn small primary', onclick: banner.button[1] }, banner.button[0]) : null) : null, log]);
	if (log.scrollTop !== undefined && atEnd) { log.scrollTop = log.scrollHeight; }
	if (noterm) {
		add(pv.body, h('div', { class: 'tfoot' }, h('span', null, 'This page draws no terminal: the live one runs in the editor.'), h('span', { class: 'grow' }),
			h('button', { type: 'button', class: 'btn small primary', onclick: () => post({ type: 'show', id: c.session }) }, 'Show terminal in the editor')));
	} else if (peer) {
		add(pv.body, h('div', { class: 'tfoot' }, h('span', null, 'Runs in another window (' + peer.p.name + '): read-only here.'), h('span', { class: 'grow' }),
			peer.r.flows ? h('button', { type: 'button', class: 'btn small', onclick: () => post({ type: 'peer', action: 'flow', key: peer.p.key, id: peer.r.id }) }, 'Open flow') : null,
			h('button', { type: 'button', class: 'btn small primary', onclick: () => post({ type: 'peer', action: 'ide', key: peer.p.key, id: peer.r.id }) }, 'Go to that window')));
	}
}

// ---- broadcast -------------------------------------------------------------------------------------------------------------
// Only a terminal pane that is attached to its session can receive it: a pane that is starting, ended, a transcript or without a terminal never does.
function bcEligible(pv) { return pv.content.kind === 'terminal' && pv.status === 'live' && !!pv.attached && !!pv.term; }
const bcTargets = () => L.panes(ws.layout).map(p => ws.views.get(p.id)).filter(pv => pv && ws.bc.checked.has(pv.id) && bcEligible(pv));
function paintBroadcast() {
	bcBar.className = ws.bc.on ? 'bcbar' : 'bcbar hidden';
	broadcastBtn.setAttribute('aria-pressed', ws.bc.on ? 'true' : 'false');
	const live = [...ws.views.values()].filter(bcEligible).length;
	const n = bcTargets().length;
	bcSend.disabled = !n;
	if (ws.bc.on) { bcNote.textContent = n + ' of ' + live + ' attached terminal' + (live === 1 ? '' : 's') + ' will receive it.'; }
}
function toggleBroadcast(on) {
	ws.bc.on = on === undefined ? !ws.bc.on : on;
	if (!ws.bc.on) { ws.bc.checked.clear(); }
	paintWorkspace();
	paintActive();
	if (ws.bc.on) { setView('work'); }
}
function checkAll(on) {
	ws.bc.checked.clear();
	if (on) { for (const pv of ws.views.values()) { if (bcEligible(pv)) { ws.bc.checked.add(pv.id); } } }
	paintWorkspace();
	paintActive();
}
function broadcast() {
	const text = bcInput.value;
	if (!text || text.length > 4000) { return; }
	const to = bcTargets();
	if (!to.length) { bcNote.textContent = 'Check at least one attached terminal first.'; return; }
	// Enter is a carriage return for a terminal.
	for (const pv of to) { post({ type: 'termInput', id: pv.attached, data: text + '\r' }); }
	bcInput.value = '';
	bcNote.textContent = 'Sent to ' + to.length + ' terminal' + (to.length === 1 ? '' : 's') + '.';
}
bcInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); broadcast(); } });

// ---- saved layouts ---------------------------------------------------------------------------------------------------------
function layoutItems() {
	const items = ws.saved.map(s => ({ label: s.name, hint: L.panes(s.layout).length + ' pane' + (L.panes(s.layout).length === 1 ? '' : 's'), run: () => { setView('work'); loadLayout(L.validate(s.layout)); ws.touched = true; scheduleSave(); },
		remove: { label: 'Delete layout ' + s.name, run: () => post({ type: 'layoutDelete', name: s.name }) } }));
	if (!items.length) { items.push({ note: 'No saved layouts yet. Applying one never starts an agent: panes of sessions that are not running wait for Resume.' }); }
	items.push({ sep: true });
	items.push({ form: true });
	return items;
}
function saveLayoutAs(name) {
	const clean = String(name || '').trim();
	if (!clean || clean.length > 60 || !L.panes(ws.layout).length) { return false; }
	if (ws.saved.length >= 20 && !ws.saved.some(s => s.name === clean)) { notice('At most 20 saved layouts. Delete one first.'); return false; }
	post({ type: 'layoutSaveAs', name: clean, layout: ws.layout });
	notice('Saved layout "' + clean + '".');
	return true;
}

// ---- drag sources in the sidebar and the keyboard ---------------------------------------------------------------------------
// A row draggable by mouse; the same content opens from the keyboard (Enter, Alt+Shift+\ and Alt+Shift+-).
function dragRow(el, contentFn) {
	el.setAttribute('draggable', 'true');
	el.addEventListener('dragstart', e => beginDrag({ content: contentFn }, e));
	el.addEventListener('dragend', () => endDrag());
}
function wsKey(e) {
	const c = chordOf(e);
	if (!c) { return false; }
	e.preventDefault();
	const f = ws.layout.focus;
	if (c === 'broadcast') { toggleBroadcast(); return true; }
	if (c === 'needs') { jumpToNext(); return true; }
	if (c === 'sidebar') { const el = rowEls.get(selKey) || side.querySelector('.srow'); if (el && el.focus) { el.focus(); } return true; }
	setView('work');
	if (c === 'next' || c === 'prev') { const id = L.neighbor(ws.layout, f, c === 'next' ? 1 : -1); if (id) { setFocus(id, true); } }
	else if (c === 'splitRight' || c === 'splitDown') {
		const content = selContent && selContent();
		if (!content) { notice('Select a session in the list first (Alt+Shift+S), then split with it.'); }
		else { openContent(content, { beside: c === 'splitRight' ? 'right' : 'bottom' }); }
	}
	else if (c === 'close') { if (f) { closeView(f); } }
	else if (c === 'max') { if (f) { toggleMax(f); } }
	else if (c === 'moveBack' || c === 'moveFwd') {
		const to = L.neighbor(ws.layout, f, c === 'moveFwd' ? 1 : -1);
		if (f && to && to !== f) { commit(L.movePane(ws.layout, f, to, 'center')); setFocus(f, true); }
	}
	return true;
}
setInterval(() => { for (const pv of ws.views.values()) { for (const f of pv.ticks) { f(); } } }, 1000);
`;
