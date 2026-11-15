/*---------------------------------------------------------------------------------------------
 *  Insilode: the Harness panel of the Agents page, as CSS and script text agentsPage.ts puts into the page: a collapsible panel on the right
 *  with the harness of the project of the focused pane (instructions, hooks, permissions, MCP servers, skills, subagents, slash commands, and
 *  the harness lint's findings). The data is flow-harness's summary (harnessData.ts), asked for through the host (harnessBridge.ts): the page
 *  names a folder, never a command, and asks to open only files the summary named. No `vscode`; it uses the shell's helpers (h, add, fill,
 *  post, base ...) and the workspace's (ws, focusTarget, scheduleSave ...) as the page's globals. Every string reaches the page as a text node.
 *--------------------------------------------------------------------------------------------*/

export const HARNESS_CSS = String.raw`
.hpanel { position: relative; flex: 0 0 auto; display: flex; flex-direction: column; width: 340px; min-width: 0; border-left: 1px solid var(--line); background: var(--col); }
.hgrip { position: absolute; left: -4px; top: 0; bottom: 0; width: 7px; z-index: 3; cursor: col-resize; touch-action: none; }
.hgrip::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: var(--focus); opacity: 0; transition: opacity .12s; }
.hgrip:hover::after, .hgrip:focus-visible::after, .hgrip.drag::after { opacity: .85; }
.hgrip:focus-visible { outline: none; }
.hh { display: flex; align-items: center; gap: 8px; flex: none; min-height: 40px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--line); }
.hh b { font-size: 13px; }
.hh .hproj { flex: 1 1 0; min-width: 0; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hsub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; flex: none; padding: 6px 12px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.hsub b { color: var(--text); font-weight: 600; }
.hbody { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 4px 0 10px; }
.hstate { margin: 14px 12px; color: var(--muted); }
.hstate.bad { color: var(--danger-text); }
.hstate .row2 { margin-top: 8px; }
.hbody.stale { opacity: .6; }
.hsec { border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent); }
.hsh { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 30px; padding: 0 12px; border: 0; background: transparent; text-align: left; font-weight: 600; }
.hsh:hover { background: var(--hover); }
.hsh .chev { flex: none; width: 10px; color: var(--muted); font-size: 10px; }
.hsh .ht { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hn { flex: none; min-width: 20px; padding: 0 6px; border-radius: 9px; background: color-mix(in srgb, var(--muted) 20%, transparent); color: var(--muted); font-size: 11px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums; }
.hn.err { background: var(--danger); color: #fff; } .hn.warn { background: var(--blocked); color: var(--bg); }
.hlist { padding: 0 6px 8px; }
.hrow { display: flex; align-items: baseline; gap: 8px; width: 100%; min-height: 24px; padding: 2px 6px; border: 0; border-radius: 5px; background: transparent; text-align: left; font-size: 12.5px; }
button.hrow:hover { background: var(--hover); }
.hrow .hm { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hrow .hm.wrap { white-space: normal; overflow-wrap: anywhere; }
.hrow .hd { flex: none; color: var(--muted); font-size: 11.5px; white-space: nowrap; }
.hrow .mono { font-family: var(--mono); font-size: 12px; }
.hrow .hev { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12px; }
.hchip { flex: none; padding: 0 6px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); font-size: 10.5px; line-height: 15px; white-space: nowrap; }
.hchip.error { border-color: var(--danger); color: var(--danger-text); } .hchip.warning { border-color: var(--blocked); color: var(--blocked); }
.hsubsec { margin: 2px 0 0; }
.hsubsec .hsh { min-height: 26px; padding: 0 6px; font-weight: 500; }
.hmode { margin: 0 6px 4px; padding: 2px 6px; color: var(--muted); font-size: 12px; }
.hmode b { color: var(--text); font-weight: 600; }
.hnone { margin: 0 6px 6px; padding: 2px 6px; color: var(--muted); font-size: 12px; }
.hfoot { display: flex; flex-wrap: wrap; gap: 6px; flex: none; padding: 8px 12px; border-top: 1px solid var(--line); }
.hnote { margin: 4px 12px; color: var(--muted); font-size: 11.5px; }
.split { position: relative; }
.hpanel.over { position: absolute; top: 0; right: 0; bottom: 0; z-index: 15; max-width: calc(100% - 40px); box-shadow: -8px 0 24px rgb(0 0 0 / .4); background: var(--vscode-sideBar-background, var(--col)); }
@media (prefers-reduced-motion: reduce) { .hgrip::after { transition: none; } }
`;

/** Plain JavaScript in String.raw (no backticks and no dollar-brace in it), run after the workspace's and before the boot. */
export const HARNESS_SCRIPT = String.raw`
// ---- the Harness panel -----------------------------------------------------------------------------------------------------
const HP_MIN = 260, HP_MAX = 640, HP_DEBOUNCE = 400, HP_GUARD = 8000;
const SCOPE_NAME = { user: 'User', project: 'Project', local: 'Local', directory: 'Folder' };
const hp = {
	open: false, width: 340,
	over: false,          // the panel lies over the panes (they would be under their minimum size beside it) rather than next to them
	touched: false,       // the user opened, closed or resized it: a state the host sends late is not applied over that
	want: '',             // the folder the last ask was for ('' = this window's folder): only an answer for it is taken
	target: '',           // the folder the panel is heading for (asked, or waiting out the pause)
	state: 'idle',        // 'idle' | 'loading' | 'ready' | 'failed'
	summary: undefined, message: '', shown: undefined,
	timer: undefined, guard: undefined,
	collapsed: new Set(), // sections the user folded or unfolded, by key: the default is in SECTION_OPEN
};
const SECTION_OPEN = { findings: true, instructions: true };
// A hSection is open unless the user toggled it away from its default.
const hSecOpen = key => (SECTION_OPEN[key] === true) !== hp.collapsed.has(key);

const hpBody = h('div', { class: 'hbody' });
const hpHead = h('div');
const hpFoot = h('div', { class: 'hfoot' });
const hpGrip = h('div', { class: 'hgrip', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical', 'aria-label': 'Resize the harness panel', title: 'Drag to resize' });
add(harnessPanel, hpGrip, hpHead, hpBody, hpFoot);

// The project of the focused pane: the folder its session works in, else this window's folder (the host's, when this says none).
function hFocusCwd() {
	const id = ws.layout.focus;
	const pv = id ? ws.views.get(id) : undefined;
	if (pv) {
		const own = pv.content.session ? rowById(pv.content.session) : undefined;
		const cwd = pv.content.cwd || (own && own.cwd);
		if (cwd) { return cwd; }
	}
	return (data.project && data.project.cwd) || '';
}

const hStr = (v, d) => typeof v === 'string' ? v : (d === undefined ? '' : d);
const hNum = v => typeof v === 'number' && isFinite(v) ? v : 0;
const hList = (v, max) => (Array.isArray(v) ? v : []).filter(x => x && typeof x === 'object').slice(0, max || 100);
const hScope = v => SCOPE_NAME[v] ? v : 'project';
const hFile = x => ({ where: hStr(x.where), file: hStr(x.file) });
// Only what the panel draws reaches its state: the summary came from another extension, over the host.
function hClean(s) {
	if (!s || typeof s !== 'object') { return undefined; }
	const p = s.permissions && typeof s.permissions === 'object' ? s.permissions : {};
	const rules = k => hList(p[k]).map(x => Object.assign(hFile(x), { pattern: hStr(x.pattern), scope: hScope(x.scope) }));
	const names = n => ({ count: hNum(n && n.count), items: hList(n && n.items).map(x => Object.assign(hFile(x), { name: hStr(x.name), scope: hScope(x.scope) })) });
	const c = s.counts && typeof s.counts === 'object' ? s.counts : {};
	const k = p.counts && typeof p.counts === 'object' ? p.counts : {};
	return {
		root: hStr(s.root), score: hNum(s.score), startupTokens: hNum(s.startupTokens),
		instructions: hList(s.instructions).map(x => Object.assign(hFile(x), { name: hStr(x.name), kind: x.kind === 'rules' ? 'rules' : 'instructions', scope: hScope(x.scope), detail: hStr(x.detail), tokens: typeof x.tokens === 'number' ? x.tokens : undefined })),
		hooks: hList(s.hooks).map(x => Object.assign(hFile(x), { event: hStr(x.event), matcher: hStr(x.matcher), command: hStr(x.command), scope: hScope(x.scope), line: typeof x.line === 'number' ? x.line : undefined })),
		permissions: { mode: hStr(p.mode), modeWhere: hStr(p.modeWhere), counts: { allow: hNum(k.allow), ask: hNum(k.ask), deny: hNum(k.deny) }, allow: rules('allow'), ask: rules('ask'), deny: rules('deny') },
		mcp: hList(s.mcp).map(x => Object.assign(hFile(x), { name: hStr(x.name), transport: hStr(x.transport), scope: hScope(x.scope), state: x.state === 'off' || x.state === 'pending' ? x.state : 'on', target: hStr(x.target) })),
		skills: names(s.skills), agents: names(s.agents), commands: names(s.commands),
		findings: hList(s.findings).map(x => Object.assign(hFile(x), { severity: x.severity === 'error' || x.severity === 'warning' ? x.severity : 'info', message: hStr(x.message), line: typeof x.line === 'number' ? x.line : undefined, code: hStr(x.code) })),
		counts: { error: hNum(c.error), warning: hNum(c.warning), info: hNum(c.info) },
		notes: (Array.isArray(s.notes) ? s.notes : []).filter(n => typeof n === 'string').slice(0, 10),
	};
}

// ---- asking the host -------------------------------------------------------------------------------------------------------
function harnessLoad() {
	clearTimeout(hp.timer);
	hp.timer = undefined;
	if (!hp.open) { return; }
	const cwd = hFocusCwd();
	hp.want = cwd;
	hp.target = cwd;
	hp.state = 'loading';
	clearTimeout(hp.guard);
	// A host that never answers (an older one, a harness extension that is off) must not leave "Reading…" up for good.
	hp.guard = setTimeout(() => { if (hp.state === 'loading') { hp.state = 'failed'; hp.message = 'The harness did not answer.'; paintHarness(); } }, HP_GUARD);
	post(Object.assign({ type: 'harness' }, cwd ? { cwd } : {}));
	paintHarness();
}
// The focus moved to a pane of another project: ask again once the focus has rested a moment.
function harnessSync() {
	if (!hp.open) { return; }
	const want = hFocusCwd();
	if (want === hp.target) { return; }
	hp.target = want;
	clearTimeout(hp.timer);
	hp.timer = setTimeout(harnessLoad, HP_DEBOUNCE);
}
function harnessMessage(m) {
	if (m.type !== 'harnessData' && m.type !== 'harnessFailed') { return false; }
	// An answer for a project that is not the one last asked about is a late one.
	if ((typeof m.cwd === 'string' ? m.cwd : '') !== hp.want || !hp.open) { return true; }
	clearTimeout(hp.guard);
	if (m.type === 'harnessData') {
		const s = hClean(m.summary);
		if (s) { hp.summary = s; hp.shown = hp.want; hp.state = 'ready'; } else { hp.state = 'failed'; hp.message = 'The harness could not be read.'; }
	} else {
		hp.state = 'failed';
		hp.message = hStr(m.message) || 'The harness could not be read.';
	}
	paintHarness();
	return true;
}
function hOpenFile(x) {
	if (!x.file) { return; }
	post(Object.assign({ type: 'harnessOpen', file: x.file }, hp.want ? { cwd: hp.want } : {}, typeof x.line === 'number' && x.line >= 1 ? { line: x.line } : {}));
}

// ---- showing and hiding ----------------------------------------------------------------------------------------------------
function hSetWidth(w) {
	hp.width = Math.max(HP_MIN, Math.min(HP_MAX, Math.round(w)));
	harnessPanel.style.width = hp.width + 'px';
	harnessDock();
}
const hClass = () => 'hpanel' + (hp.open ? '' : ' hidden') + (hp.open && hp.over ? ' over' : '');
// Next to the panes while every pane would keep its minimum size, over them when it would not: decided by the panes, not by the window's width.
function harnessDock() {
	if (!hp.open) { return; }
	const r = stage.getBoundingClientRect ? stage.getBoundingClientRect() : { width: 0, height: 0 };
	let over = false;
	// A workspace that is not on screen has no size to judge by: the panel stays beside it.
	if (r.width > 0 && r.height > 0) {
		// The stage is as wide as it is with the panel beside it: add the panel back to know what the panes could have.
		const room = r.width + (hp.over ? 0 : hp.width) - hp.width - 2 * STAGE_PAD;
		const shown = ws.layout.max ? { seq: 0, root: L.find(ws.layout, ws.layout.max) } : ws.layout;
		over = !L.fits(shown, room, r.height - 2 * STAGE_PAD, PANE_W, PANE_H);
	}
	if (over !== hp.over) {
		hp.over = over;
		harnessPanel.className = hClass();
		for (const pv of ws.views.values()) { scheduleFit(pv); }
	}
}
if (typeof ResizeObserver === 'function') { new ResizeObserver(() => harnessDock()).observe(stage); }
function toggleHarness(on) {
	hp.open = on === undefined ? !hp.open : !!on;
	hp.touched = true;
	harnessPanel.className = hClass();
	harnessDock();
	harnessBtn.setAttribute('aria-pressed', hp.open ? 'true' : 'false');
	if (hp.open) { harnessLoad(); } else { clearTimeout(hp.timer); clearTimeout(hp.guard); hp.timer = undefined; }
	for (const pv of ws.views.values()) { scheduleFit(pv); }
	scheduleSave();
}
// What the host remembers of the panel, once, unless the user has already touched it.
function restoreHarness(s) {
	if (hp.touched || !s || typeof s !== 'object' || typeof s.open !== 'boolean' || typeof s.width !== 'number') { return; }
	hSetWidth(s.width);
	if (s.open) {
		hp.open = true;
		harnessPanel.className = hClass();
		harnessDock();
		harnessBtn.setAttribute('aria-pressed', 'true');
		// The host's first messages come before it has said which folder this window has: ask once that has settled, not twice.
		hp.target = '';
		hp.timer = setTimeout(harnessLoad, HP_DEBOUNCE);
		paintHarness();
	}
}
{
	let from;
	hpGrip.addEventListener('pointerdown', e => {
		e.preventDefault();
		from = { x: e.clientX, w: hp.width };
		hpGrip.className = 'hgrip drag';
		if (hpGrip.setPointerCapture && e.pointerId !== undefined) { try { hpGrip.setPointerCapture(e.pointerId); } catch (x) { /* no capture: the drag still follows */ } }
	});
	hpGrip.addEventListener('pointermove', e => { if (from) { hp.touched = true; hSetWidth(from.w - (e.clientX - from.x)); for (const pv of ws.views.values()) { scheduleFit(pv); } } });
	const stop = () => { if (from) { from = undefined; hpGrip.className = 'hgrip'; scheduleSave(); } };
	hpGrip.addEventListener('pointerup', stop);
	hpGrip.addEventListener('pointercancel', stop);
	hpGrip.addEventListener('keydown', e => {
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') { return; }
		e.preventDefault();
		e.stopPropagation();
		hp.touched = true;
		hSetWidth(hp.width + (e.key === 'ArrowLeft' ? 1 : -1) * (e.shiftKey ? 64 : 16));
		for (const pv of ws.views.values()) { scheduleFit(pv); }
		scheduleSave();
	});
}

// ---- painting --------------------------------------------------------------------------------------------------------------
const hChip = (text, cls, tip) => h('span', { class: 'hchip' + (cls ? ' ' + cls : ''), title: tip || null }, text);
const hPill = (n, cls) => h('span', { class: 'hn' + (cls ? ' ' + cls : '') }, String(n));
function hToggle(key) {
	if (hp.collapsed.has(key)) { hp.collapsed.delete(key); } else { hp.collapsed.add(key); }
	paintHarness();
}
function hSecHead(key, title, pill) {
	const open = hSecOpen(key);
	return h('button', { type: 'button', class: 'hsh', 'data-hk': key, 'aria-expanded': open ? 'true' : 'false', onclick: () => hToggle(key) },
		h('span', { class: 'chev', 'aria-hidden': 'true' }, open ? '▾' : '▸'), h('span', { class: 'ht' }, title), pill);
}
function hSection(key, title, pill, body) {
	return h('section', { class: 'hsec', 'aria-label': title }, hSecHead(key, title, pill), hSecOpen(key) ? h('div', { class: 'hlist' }, body) : null);
}
function hByAttr(el, attr, val) {
	for (const c of Array.from(el.children || [])) {
		if (c.getAttribute && c.getAttribute(attr) === val) { return c; }
		const f = hByAttr(c, attr, val);
		if (f) { return f; }
	}
	return undefined;
}
// A row that opens its file when it has one.
function hFileRow(x, kids, tip) {
	const title = tip || (x.where ? x.where + (typeof x.line === 'number' ? ':' + x.line : '') : null);
	if (!x.file) { return h('div', { class: 'hrow', title }, kids); }
	return h('button', { type: 'button', class: 'hrow', title: title ? 'Open ' + title : 'Open', onclick: () => hOpenFile(x) }, kids);
}
const hScopeChip = x => hChip(SCOPE_NAME[x.scope] || x.scope, '', x.where ? 'Defined in ' + x.where : null);
function hNone(text) { return h('p', { class: 'hnone' }, text); }

function hInstructionRows(s) {
	if (!s.instructions.length) { return hNone('No CLAUDE.md, AGENTS.md or rules in this project.'); }
	return s.instructions.map(x => hFileRow(x, [h('span', { class: 'hm', title: x.detail || null }, x.name), x.tokens !== undefined ? h('span', { class: 'hd', title: 'About ' + x.tokens + ' tokens' }, '~' + tok(x.tokens) + ' tok') : null, hScopeChip(x)]));
}
function hHookRows(s) {
	if (!s.hooks.length) { return hNone('No hooks.'); }
	return s.hooks.map(x => hFileRow(x, [h('span', { class: 'hev', title: x.event + (x.matcher ? ' · ' + x.matcher : '') }, x.event + (x.matcher ? ' · ' + x.matcher : '')), h('span', { class: 'hd' }, '→'), h('span', { class: 'hm mono', title: x.command }, x.command), hScopeChip(x)]));
}
function hPermissionRows(s) {
	const p = s.permissions;
	const out = [];
	if (p.mode) { out.push(h('p', { class: 'hmode', title: p.modeWhere ? 'Set in ' + p.modeWhere : null }, 'Default mode: ', h('b', null, p.mode))); }
	for (const k of ['allow', 'ask', 'deny']) {
		const n = p.counts[k];
		const key = 'perm:' + k;
		out.push(h('div', { class: 'hsubsec' }, hSecHead(key, k[0].toUpperCase() + k.slice(1), hPill(n, k === 'deny' && n ? 'err' : '')),
			hSecOpen(key) ? h('div', { class: 'hlist' }, p[k].length ? p[k].map(x => hFileRow(x, [h('span', { class: 'hm mono', title: x.pattern }, x.pattern), hScopeChip(x)])) : hNone(n ? 'The hList is too long to show.' : 'None.'),
				n > p[k].length && p[k].length ? h('p', { class: 'hnote' }, 'Showing ' + p[k].length + ' of ' + n + '.') : null) : null));
	}
	return out;
}
function hMcpRows(s) {
	if (!s.mcp.length) { return hNone('No MCP servers.'); }
	return s.mcp.map(x => hFileRow(x, [h('span', { class: 'hm' }, x.name), h('span', { class: 'hd', title: x.target }, x.transport), x.state !== 'on' ? hChip(x.state === 'off' ? 'off' : 'awaiting approval') : null, hScopeChip(x)], x.target ? x.target : undefined));
}
function hNameRows(n, none) {
	if (!n.items.length) { return hNone(none); }
	return [n.items.map(x => hFileRow(x, [h('span', { class: 'hm' }, x.name), hScopeChip(x)])), n.count > n.items.length ? h('p', { class: 'hnote' }, 'Showing ' + n.items.length + ' of ' + n.count + '.') : null];
}
function hFindingRows(s) {
	if (!s.findings.length) { return hNone('No findings: this is what npm run harness:lint would print, and it prints nothing.'); }
	const total = s.counts.error + s.counts.warning + s.counts.info;
	return [s.findings.map(x => hFileRow(x, [hChip(x.severity, x.severity), h('span', { class: 'hm wrap', title: x.code || null }, x.message), h('span', { class: 'hd' }, x.where + (typeof x.line === 'number' ? ':' + x.line : ''))])),
		total > s.findings.length ? h('p', { class: 'hnote' }, 'Showing ' + s.findings.length + ' of ' + total + '.') : null];
}

function paintHarness() {
	if (!hp.open) { return; }
	// The keyboard may be on a hSection button: it keeps the focus through the repaint.
	const keep = document.activeElement && document.activeElement.getAttribute ? document.activeElement.getAttribute('data-hk') : undefined;
	// Only the harness of the project being shown: another project's is never left up under this one's name.
	const s = hp.summary && hp.shown === hp.want ? hp.summary : undefined;
	const project = s ? base(s.root) : (hp.want ? base(hp.want) : (data.project && data.project.name) || 'This window');
	const refresh = h('button', { type: 'button', class: 'ibtn', title: 'Read the harness again', 'aria-label': 'Refresh the harness', disabled: hp.state === 'loading' || null, onclick: () => harnessLoad() }, '↻');
	const close = h('button', { type: 'button', class: 'ibtn', title: 'Hide the harness panel (' + MOD + 'H)', 'aria-label': 'Hide the harness panel', onclick: () => toggleHarness(false) }, raw('span', null, ICO.close));
	fill(hpHead, h('div', { class: 'hh' }, h('b', null, 'Harness'), h('span', { class: 'hproj', title: s ? s.root : hp.want }, project), refresh, close));
	const body = [];
	if (hp.state === 'failed') {
		body.push(h('div', { class: 'hstate bad', role: 'alert' }, hp.message, h('div', { class: 'row2' }, h('button', { type: 'button', class: 'btn small', onclick: () => harnessLoad() }, 'Try again'))));
	} else if (!s) {
		body.push(h('div', { class: 'hstate', role: 'status' }, 'Reading the harness…'));
	}
	let sub = null;
	if (s) {
		const f = s.counts;
		sub = h('div', { class: 'hsub' }, h('span', { title: 'The map\'s health score for this project' }, 'Health ', h('b', null, String(s.score))),
			s.startupTokens ? h('span', { title: 'Loaded into every new session before the first prompt (an estimate)' }, h('b', null, tok(s.startupTokens)), ' tokens at start') : null,
			f.error + f.warning ? h('span', null, h('b', null, String(f.error)), ' error' + (f.error === 1 ? '' : 's') + ', ', h('b', null, String(f.warning)), ' warning' + (f.warning === 1 ? '' : 's')) : null);
		const p = s.permissions;
		const perm = p.counts.allow + p.counts.ask + p.counts.deny;
		body.push(
			hSection('findings', 'Harness lint', hPill(s.findings.length, s.counts.error ? 'err' : s.counts.warning ? 'warn' : ''), hFindingRows(s)),
			hSection('instructions', 'Instructions', hPill(s.instructions.length), hInstructionRows(s)),
			hSection('hooks', 'Hooks', hPill(s.hooks.length), hHookRows(s)),
			h('section', { class: 'hsec', 'aria-label': 'Permissions' }, hSecHead('permissions', 'Permissions', hPill(perm)), hSecOpen('permissions') ? h('div', { class: 'hlist' }, hPermissionRows(s)) : null),
			hSection('mcp', 'MCP servers', hPill(s.mcp.length), hMcpRows(s)),
			hSection('skills', 'Skills', hPill(s.skills.count), hNameRows(s.skills, 'No skills.')),
			hSection('agents', 'Subagents', hPill(s.agents.count), hNameRows(s.agents, 'No subagents.')),
			hSection('commands', 'Slash commands', hPill(s.commands.count), hNameRows(s.commands, 'No slash commands.')),
			s.notes.map(n => h('p', { class: 'hnote' }, n)));
	}
	fill(hpBody, body);
	hpBody.className = hp.state === 'loading' && s ? 'hbody stale' : 'hbody';
	if (sub) { add(hpHead, sub); }
	fill(hpFoot, [h('button', { type: 'button', class: 'btn small', title: 'Open the Harness page of this window\'s project', onclick: () => post({ type: 'harnessGo', target: 'map' }) }, 'Open Harness'),
		h('button', { type: 'button', class: 'btn small', title: 'Add a hook to this window\'s project in the hooks studio', onclick: () => post({ type: 'harnessGo', target: 'hook' }) }, 'Hooks studio')]);
	const again = keep ? hByAttr(hpBody, 'data-hk', keep) : undefined;
	if (again && again.focus) { again.focus(); }
}
`;
