/*---------------------------------------------------------------------------------------------
 *  Insilode Settings: the page (HTML, CSS and the script that draws the controls). No `vscode` here, so the page can be
 *  rendered outside the editor too. settings.ts gives it to the webview, sends it `data` messages and answers what it asks.
 *
 *  Everything the host sends goes into the page with textContent, never into markup. The page's messages only name a
 *  setting by key (`set`, `reset`, `open`); settings.ts checks the key and the value again.
 *--------------------------------------------------------------------------------------------*/

export function settingsHtml(nonce: string) {
	const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
	return /* html */ `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root {
	--bg: var(--vscode-editor-background); --text: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground);
	--line: var(--vscode-widget-border, #30323c); --raised: var(--vscode-chat-requestBubbleBackground, color-mix(in srgb, var(--bg) 92%, var(--text)));
	--signal: #6f86ff; --ok: #5fe0a1; --plan: #ffb454;
	--mono: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.5 var(--vscode-font-family, -apple-system, system-ui); }
button, input, select { font: inherit; color: inherit; }
button { cursor: pointer; }
:focus-visible { outline: 1.5px solid var(--signal); outline-offset: 2px; }
[hidden] { display: none !important; }

.app { display: grid; grid-template-columns: 232px minmax(0, 1fr); height: 100%; }
.rail { display: flex; flex-direction: column; gap: 2px; padding: 22px 12px; border-right: 1px solid var(--line); overflow-y: auto; }
.rail h1 { margin: 0 8px 16px; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
.tab { display: flex; align-items: center; gap: 10px; width: 100%; height: 34px; padding: 0 10px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); text-align: left; }
.tab:hover { background: color-mix(in srgb, var(--text) 6%, transparent); color: var(--text); }
.tab[aria-selected="true"] { background: color-mix(in srgb, var(--signal) 16%, transparent); color: var(--text); font-weight: 600; }
.tab svg { flex: none; }
.tab .n { margin-left: auto; min-width: 18px; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--signal) 22%, transparent); color: var(--signal); font-size: 11px; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }
.tab[aria-selected="true"] .n { background: var(--signal); color: #0c0f1f; }
.rail .sp { flex: 1; }
.rail .links { display: flex; flex-direction: column; gap: 2px; padding-top: 12px; border-top: 1px solid var(--line); }
.link { all: unset; display: block; padding: 5px 10px; border-radius: 7px; color: var(--muted); font-size: 12px; cursor: pointer; }
.link:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.link:focus-visible { outline: 1.5px solid var(--signal); }

.main { overflow-y: auto; scroll-behavior: smooth; }
.top { position: sticky; top: 0; z-index: 3; display: flex; align-items: center; gap: 10px; padding: 16px 40px 14px; background: color-mix(in srgb, var(--bg) 92%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); }
.search { position: relative; flex: 1; max-width: 560px; }
.search svg { position: absolute; left: 12px; top: 9px; color: var(--muted); pointer-events: none; }
.search input[type="text"] { width: 100%; max-width: none; height: 34px; padding: 0 44px 0 36px; border: 1px solid var(--line); border-radius: 10px; background: var(--raised); outline: 0; }
.search input[type="text"]:focus { border-color: color-mix(in srgb, var(--signal) 65%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--signal) 14%, transparent); }
.search input[type="text"]::placeholder { color: var(--muted); }
.search kbd { position: absolute; right: 10px; top: 7px; font: 11px var(--mono); padding: 0 6px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; color: var(--muted); }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: var(--muted); font-size: 12px; white-space: nowrap; }
.chip:hover { color: var(--text); }
.chip[aria-pressed="true"] { border-color: color-mix(in srgb, var(--signal) 55%, transparent); background: color-mix(in srgb, var(--signal) 14%, transparent); color: var(--text); }
.chip i { width: 7px; height: 7px; border-radius: 50%; background: var(--signal); }

.body { max-width: 860px; padding: 8px 40px 72px; }
.cat { margin-top: 28px; }
.cat > h2 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
.cat > p { margin: 4px 0 4px; color: var(--muted); }
.group > h3 { margin: 26px 0 8px; color: var(--muted); font-size: 11.5px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.card { border: 1px solid var(--line); border-radius: 14px; background: var(--raised); overflow: hidden; }
.row { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 24px; align-items: center; padding: 14px 18px; border-top: 1px solid var(--line); transition: background .2s, opacity .15s; }
.row:first-child { border-top: 0; }
.row.wide { grid-template-columns: minmax(0, 1fr); }
.row.off { opacity: .5; }
.row.flash { background: color-mix(in srgb, var(--signal) 16%, transparent); }
.row.modified::before { content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px; border-radius: 0 3px 3px 0; background: var(--signal); }
.t { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-weight: 600; }
.badge { padding: 0 7px; border-radius: 999px; background: color-mix(in srgb, var(--plan) 20%, transparent); color: var(--plan); font-size: 10.5px; font-weight: 600; line-height: 17px; letter-spacing: .02em; }
.reset { all: unset; margin-left: 2px; padding: 0 7px; border-radius: 6px; color: var(--muted); font-size: 11.5px; font-weight: 400; cursor: pointer; }
.reset:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.reset:focus-visible { outline: 1.5px solid var(--signal); }
.d { margin-top: 2px; color: var(--muted); font-size: 12.5px; line-height: 1.55; }
.d code, .key { font-family: var(--mono); font-size: 11.5px; }
.d code { padding: 0 4px; border-radius: 4px; background: color-mix(in srgb, var(--text) 9%, transparent); color: var(--text); }
.d b { color: var(--text); font-weight: 600; }
.key { margin-top: 4px; color: color-mix(in srgb, var(--muted) 75%, transparent); }
.ctl { display: flex; align-items: center; justify-content: flex-end; gap: 10px; min-width: 0; }
.row.wide .ctl { justify-content: flex-start; margin-top: 8px; }

.sw { position: relative; display: block; flex: none; width: 38px; height: 22px; padding: 0; border: 0; border-radius: 999px; background: color-mix(in srgb, var(--text) 22%, transparent); transition: background .15s; }
.sw::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.35); transition: transform .15s; }
.sw[aria-checked="true"] { background: var(--signal); }
.sw[aria-checked="true"]::after { transform: translateX(16px); }
.sw:disabled { cursor: default; }

.seg { display: inline-flex; padding: 2px; border: 1px solid var(--line); border-radius: 10px; background: color-mix(in srgb, var(--bg) 60%, transparent); }
.seg button { height: 26px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font-size: 12px; white-space: nowrap; }
.seg button:hover { color: var(--text); }
.seg button[aria-checked="true"] { background: var(--signal); color: #0c0f1f; font-weight: 600; }
.seg button:disabled { cursor: default; }
select, input[type="text"], input[type="number"] { height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); outline: 0; }
select:focus, input[type="text"]:focus, input[type="number"]:focus { border-color: color-mix(in srgb, var(--signal) 65%, transparent); }
input.bad { border-color: #ff6b7d !important; }
select { max-width: 280px; }
input[type="text"] { width: 260px; max-width: 100%; }
input[type="number"] { width: 84px; text-align: right; font-variant-numeric: tabular-nums; }
input[type="range"] { width: 170px; accent-color: var(--signal); }
.row.wide input[type="text"] { width: 100%; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; width: 100%; padding: 6px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
.chips:focus-within { border-color: color-mix(in srgb, var(--signal) 65%, transparent); }
.tag { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px 0 9px; border-radius: 7px; background: color-mix(in srgb, var(--text) 10%, transparent); font: 12px var(--mono); }
.tag button { all: unset; width: 18px; height: 18px; border-radius: 5px; color: var(--muted); text-align: center; line-height: 18px; cursor: pointer; }
.tag button:hover { background: color-mix(in srgb, var(--text) 14%, transparent); color: var(--text); }
.chips input { flex: 1; min-width: 110px; height: 24px; border: 0; background: transparent; padding: 0 4px; }

.flags { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; width: 100%; }
.flag { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); text-align: left; }
.flag:hover { border-color: color-mix(in srgb, var(--text) 28%, transparent); }
.flag .sw { margin-top: 1px; transform: scale(.82); transform-origin: left top; width: 38px; flex: none; margin-right: -6px; }
.flag span { min-width: 0; }
.flag b { display: block; font-weight: 600; font-size: 12.5px; }
.flag small { display: block; color: var(--muted); font-size: 11.5px; line-height: 1.4; }

.btn { height: 28px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; font-size: 12px; }
.btn:hover { background: color-mix(in srgb, var(--text) 8%, transparent); }
.note { color: var(--muted); font-size: 12px; }
.empty { margin: 80px auto 0; max-width: 360px; text-align: center; color: var(--muted); }
.empty b { display: block; margin-bottom: 4px; color: var(--text); font-size: 15px; }

@media (max-width: 760px) {
	.app { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
	.rail { flex-direction: row; align-items: center; padding: 8px 10px; border-right: 0; border-bottom: 1px solid var(--line); overflow-x: auto; overflow-y: hidden; }
	.rail h1, .rail .sp, .rail .links { display: none; }
	.tab { width: auto; flex: none; }
	.top, .body { padding-left: 16px; padding-right: 16px; }
	.row { grid-template-columns: minmax(0, 1fr); }
	.ctl { justify-content: flex-start; }
}
@media (prefers-reduced-motion: reduce) { .sw, .sw::after, .row { transition: none; } .main { scroll-behavior: auto; } }
</style></head><body>
<div class="app">
	<nav class="rail" aria-label="Settings categories">
		<h1>Settings</h1>
		<div id="tabs" role="tablist" style="display:contents"></div>
		<div class="sp"></div>
		<div class="links">
			<button class="link" data-open="json">Open settings.json</button>
			<button class="link" data-open="all">All VS Code settings</button>
		</div>
	</nav>
	<div class="main" id="main">
		<div class="top">
			<label class="search"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg><input id="q" type="text" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>
			<button class="chip" id="mod" aria-pressed="false" title="Show only the settings you changed"><i></i>Changed <span id="modn"></span></button>
		</div>
		<div class="body" id="body"></div>
	</div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const send = m => vscode.postMessage(m);

function el(tag, cls, text) {
	const e = document.createElement(tag);
	if (cls) { e.className = cls; }
	if (text !== undefined) { e.textContent = text; }
	return e;
}
function circ(x, y, r) { return 'M' + (x - r) + ' ' + y + 'a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0a' + r + ' ' + r + ' 0 1 0 ' + (-2 * r) + ' 0'; }
const ICONS = {
	agents: ['M3 6h10v7H3z', 'M8 6V3', 'M6 9v1M10 9v1'],
	notifications: ['M4 11V7a4 4 0 018 0v4l1 1H3z', 'M7 14h2'],
	pr: ['M5 4.5v7', circ(5, 3, 1.5), circ(5, 13, 1.5), circ(11, 5, 1.5), 'M11 6.5v1a3 3 0 01-3 3H5.5'],
	desktop: ['M2 3h12v8H2z', 'M6 14h4M8 11v3'],
	canvas: [circ(3.5, 8, 1.8), circ(12.5, 4, 1.8), circ(12.5, 12, 1.8), 'M5.3 7.4l5.4-2.8M5.3 8.6l5.4 2.8'],
	integrations: ['M6 2v3M10 2v3M4 5h8v3a4 4 0 01-8 0z', 'M8 12v2'],
	editor: ['M6 4L2 8l4 4M10 4l4 4-4 4'],
	more: [circ(3.5, 8, .8), circ(8, 8, .8), circ(12.5, 8, .8)],
};
function icon(id) {
	const s = document.createElementNS(NS, 'svg');
	s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('viewBox', '0 0 16 16');
	s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.4');
	s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
	for (const d of ICONS[id] || ICONS.more) { const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); }
	return s;
}

/** A description's little markdown (code, bold, a link, a #setting# reference) as text and elements, never as markup. */
function md(text, into) {
	for (const part of text.split(/(\`[^\`]+\`|\\*\\*[^*]+\\*\\*|#[\\w.]+#|\\[[^\\]]+\\]\\([^)]*\\))/)) {
		if (!part) { continue; }
		if (part[0] === '\`') { into.appendChild(el('code', '', part.slice(1, -1).replace(/^#([\\w.]+)#$/, '$1'))); }
		else if (part.startsWith('**')) { into.appendChild(el('b', '', part.slice(2, -2))); }
		else if (part[0] === '#' && part.length > 2) { into.appendChild(el('code', '', part.slice(1, -1))); }
		else if (part[0] === '[') { into.appendChild(document.createTextNode(part.slice(1, part.indexOf(']')))); }
		else { into.appendChild(document.createTextNode(part)); }
	}
}

let data = { categories: [], settings: [] };
let sig = '';
let cat = 'agents';
let query = '';
let onlyChanged = false;
const rows = new Map();
const value = key => { const r = rows.get(key); return r ? r.s.value : undefined; };
const post = (key, v) => send({ type: 'set', key, value: v });

// ---- controls: each returns { node, set(value, s) } and posts \`set\` itself ----
function switchControl(s) {
	const b = el('button', 'sw'); b.type = 'button'; b.setAttribute('role', 'switch'); b.setAttribute('aria-label', s.title);
	b.onclick = () => post(s.key, b.getAttribute('aria-checked') !== 'true');
	return { node: b, set: (v, st, off) => { b.setAttribute('aria-checked', String(v === true)); b.disabled = off; } };
}
function segmentsControl(s) {
	const g = el('div', 'seg'); g.setAttribute('role', 'radiogroup'); g.setAttribute('aria-label', s.title);
	const bs = s.options.map(o => { const b = el('button', '', o.label); b.type = 'button'; b.setAttribute('role', 'radio'); b.title = o.description; b.dataset.v = o.value; b.onclick = () => post(s.key, o.value); g.appendChild(b); return b; });
	return { node: g, set: (v, st, off) => bs.forEach(b => { b.setAttribute('aria-checked', String(b.dataset.v === v)); b.disabled = off; }) };
}
function selectControl(s) {
	const sel = document.createElement('select'); sel.setAttribute('aria-label', s.title);
	for (const o of s.options) { const op = el('option', '', o.label); op.value = o.value; op.title = o.description; sel.appendChild(op); }
	sel.onchange = () => post(s.key, sel.value);
	return { node: sel, set: (v, st, off) => { sel.value = v; sel.disabled = off; } };
}
function numberControl(s) {
	const wrap = el('div', 'ctl'); wrap.style.gap = '12px';
	const n = document.createElement('input'); n.type = 'number'; n.setAttribute('aria-label', s.title);
	if (s.min !== undefined) { n.min = s.min; } if (s.max !== undefined) { n.max = s.max; } n.step = s.step || 1;
	let r = null;
	if (s.min !== undefined && s.max !== undefined) {
		r = document.createElement('input'); r.type = 'range'; r.min = s.min; r.max = s.max; r.step = s.step || 1; r.setAttribute('aria-label', s.title);
		r.oninput = () => { n.value = r.value; };
		r.onchange = () => post(s.key, Number(r.value));
		wrap.appendChild(r);
	}
	n.onchange = () => {
		let v = Number(n.value);
		if (n.value === '' || !isFinite(v)) { n.value = rows.get(s.key).s.value; return; }
		if (s.min !== undefined) { v = Math.max(s.min, v); } if (s.max !== undefined) { v = Math.min(s.max, v); }
		if (s.step === 1) { v = Math.round(v); }
		n.value = v; if (r) { r.value = v; }
		post(s.key, v);
	};
	wrap.appendChild(n);
	return { node: wrap, set: (v, st, off) => { if (document.activeElement !== n) { n.value = v; } if (r) { r.value = v; r.disabled = off; } n.disabled = off; } };
}
function textControl(s) {
	const i = document.createElement('input'); i.type = 'text'; i.setAttribute('aria-label', s.title); i.spellcheck = false;
	if (s.examples && s.examples.length) {
		const dl = document.createElement('datalist'); dl.id = 'dl-' + s.key;
		for (const e of s.examples) { const op = document.createElement('option'); op.value = e; dl.appendChild(op); }
		document.body.appendChild(dl); i.setAttribute('list', dl.id);
	}
	const re = s.pattern ? (() => { try { return new RegExp(s.pattern); } catch (e) { return null; } })() : null;
	i.oninput = () => i.classList.toggle('bad', !!re && !re.test(i.value));
	i.onchange = () => { if (re && !re.test(i.value)) { return; } post(s.key, i.value); };
	i.onkeydown = e => { if (e.key === 'Enter') { i.blur(); } };
	return { node: i, set: (v, st, off) => { if (document.activeElement !== i) { i.value = v; i.classList.remove('bad'); } i.disabled = off; } };
}
function listControl(s) {
	const box = el('div', 'chips');
	const input = document.createElement('input'); input.type = 'text'; input.placeholder = 'Add…'; input.setAttribute('aria-label', 'Add to ' + s.title);
	let items = [];
	const commit = list => post(s.key, list);
	const add = () => { const t = input.value.trim().replace(/,+$/, ''); input.value = ''; if (t && items.indexOf(t) < 0) { commit(items.concat([t])); } };
	input.onkeydown = e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } else if (e.key === 'Backspace' && !input.value && items.length) { commit(items.slice(0, -1)); } };
	input.onblur = add;
	box.onclick = () => input.focus();
	return { node: box, set: (v, st, off) => {
		items = Array.isArray(v) ? v : [];
		// Only the chips are rebuilt: replacing the input too would drop its focus after every Enter.
		box.querySelectorAll('.tag').forEach(n => n.remove());
		for (const t of items) { const tag = el('span', 'tag', t); const x = el('button', '', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Remove ' + t); x.onclick = e => { e.stopPropagation(); commit(items.filter(o => o !== t)); }; tag.appendChild(x); box.insertBefore(tag, input.parentNode === box ? input : null); }
		input.disabled = off; if (input.parentNode !== box) { box.appendChild(input); }
	} };
}
function flagsControl(s) {
	const g = el('div', 'flags');
	const items = s.flags.map(f => {
		const b = el('button', 'flag'); b.type = 'button';
		const sw = el('span', 'sw'); sw.setAttribute('role', 'switch');
		const t = el('span'); t.appendChild(el('b', '', f.label)); if (f.description) { t.appendChild(el('small', '', f.description)); }
		b.appendChild(sw); b.appendChild(t);
		b.onclick = () => { const cur = value(s.key) || {}; const o = {}; o[f.key] = !cur[f.key]; post(s.key, o); };
		g.appendChild(b); return { f, b, sw };
	});
	return { node: g, set: (v, st, off) => items.forEach(i => { const on = !!(v && v[i.f.key]); i.sw.setAttribute('aria-checked', String(on)); i.b.disabled = off; }) };
}
function jsonControl(s) {
	const w = el('div', 'ctl'); const note = el('span', 'note'); const b = el('button', 'btn', 'Edit in settings.json'); b.type = 'button';
	b.onclick = () => send({ type: 'open', target: 'setting', key: s.key });
	w.appendChild(note); w.appendChild(b);
	return { node: w, set: v => { note.textContent = Array.isArray(v) ? (v.length ? v.length + ' configured' : 'None yet') : ''; } };
}
const CONTROLS = { switch: switchControl, segments: segmentsControl, select: selectControl, number: numberControl, text: textControl, list: listControl, flags: flagsControl, json: jsonControl };

function build(s) {
	const wide = s.kind === 'list' || s.kind === 'flags';
	const row = el('div', 'row' + (wide ? ' wide' : '')); row.id = 'k-' + s.key;
	const info = el('div');
	const t = el('div', 't'); const title = el('span', '', s.title); const badge = el('span', 'badge', 'Workspace'); badge.title = 'Set for this workspace only';
	const reset = el('button', 'reset', 'Reset'); reset.type = 'button'; reset.title = 'Back to the default';
	reset.onclick = () => send({ type: 'reset', key: s.key });
	t.appendChild(title); t.appendChild(badge); t.appendChild(reset);
	const d = el('div', 'd'); md(s.description, d);
	const k = el('div', 'key', s.key);
	info.appendChild(t); info.appendChild(d); info.appendChild(k);
	const c = CONTROLS[s.kind](s);
	const holder = el('div', 'ctl'); holder.appendChild(c.node);
	row.appendChild(info); row.appendChild(c.node.className === 'ctl' ? c.node : holder);
	const r = { row, s, badge, reset, c, text: (s.title + ' ' + s.description + ' ' + s.key + ' ' + s.group).toLowerCase() };
	rows.set(s.key, r);
	return r;
}

function refresh(s) {
	const r = rows.get(s.key); r.s = s;
	const need = s.needs ? rows.get(s.needs) : null;
	const off = !!need && !need.s.value;
	r.row.classList.toggle('modified', s.modified);
	r.row.classList.toggle('off', off);
	r.badge.hidden = s.scope !== 'workspace';
	r.reset.hidden = !s.modified;
	r.c.set(s.value, s, off);
}

function structure(settings) {
	return JSON.stringify(settings.map(s => [s.key, s.kind, s.options, s.flags, s.min, s.max, s.title, s.description]));
}

function render() {
	const settings = data.settings;
	const next = structure(settings);
	if (next !== sig) {
		sig = next; rows.clear();
		document.querySelectorAll('datalist').forEach(d => d.remove());
		const body = $('body'); body.replaceChildren();
		for (const c of data.categories) {
			const items = settings.filter(s => s.category === c.id);
			if (!items.length) { continue; }
			const sec = el('section', 'cat'); sec.dataset.cat = c.id;
			sec.appendChild(el('h2', '', c.label)); sec.appendChild(el('p', '', c.blurb));
			let card = null, gs = null;
			for (const s of items) {
				if (!gs || gs.dataset.g !== s.group) { gs = el('div', 'group'); gs.dataset.g = s.group; gs.appendChild(el('h3', '', s.group)); card = el('div', 'card'); gs.appendChild(card); sec.appendChild(gs); }
				card.appendChild(build(s).row);
			}
			body.appendChild(sec);
		}
		body.appendChild(Object.assign(el('div', 'empty'), { id: 'none', hidden: true }));
		const none = $('none'); none.appendChild(el('b', '', 'Nothing matches')); none.appendChild(document.createTextNode('Try another word, or open all VS Code settings.'));
	}
	// Every row knows its new state before any is drawn: a dimmed row reads the setting it needs.
	for (const s of settings) { rows.get(s.key).s = s; }
	for (const s of settings) { refresh(s); }
	tabs(); filter();
}

function tabs() {
	const box = $('tabs'); box.replaceChildren();
	for (const c of data.categories) {
		const items = data.settings.filter(s => s.category === c.id);
		if (!items.length) { continue; }
		const b = el('button', 'tab'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.cat = c.id;
		b.setAttribute('aria-selected', String(c.id === cat && !query));
		b.appendChild(icon(c.id)); b.appendChild(el('span', '', c.label));
		const n = items.filter(s => s.modified).length;
		if (n) { b.appendChild(el('span', 'n', String(n))); b.title = n + ' changed'; }
		b.onclick = () => { cat = c.id; query = ''; $('q').value = ''; tabs(); filter(); $('main').scrollTo({ top: 0 }); };
		box.appendChild(b);
	}
	const total = data.settings.filter(s => s.modified).length;
	$('modn').textContent = total ? String(total) : '';
}

function filter() {
	const words = query.toLowerCase().split(/\\s+/).filter(Boolean);
	let shown = 0;
	document.querySelectorAll('.cat').forEach(sec => {
		let any = 0;
		sec.querySelectorAll('.group').forEach(g => {
			let gAny = 0;
			g.querySelectorAll('.row').forEach(rowEl => {
				const r = rows.get(rowEl.id.slice(2));
				const hit = (!words.length || words.every(w => r.text.indexOf(w) >= 0)) && (!onlyChanged || r.s.modified);
				rowEl.hidden = !hit; if (hit) { gAny++; }
			});
			g.hidden = !gAny; any += gAny;
		});
		const showCat = (words.length || onlyChanged) ? true : sec.dataset.cat === cat;
		sec.hidden = !showCat || !any; if (!sec.hidden) { shown += any; }
	});
	$('none').hidden = shown > 0;
}

$('q').oninput = e => { query = e.target.value; tabs(); filter(); };
$('q').onkeydown = e => { if (e.key === 'Escape') { query = ''; e.target.value = ''; tabs(); filter(); } };
$('mod').onclick = () => { onlyChanged = !onlyChanged; $('mod').setAttribute('aria-pressed', String(onlyChanged)); filter(); };
document.addEventListener('keydown', e => { if (e.key === '/' && !/INPUT|SELECT|TEXTAREA/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); $('q').focus(); } });
document.querySelectorAll('[data-open]').forEach(b => b.onclick = () => send({ type: 'open', target: b.dataset.open }));

function focus(target) {
	const r = rows.get(target);
	const c = r ? r.s.category : data.categories.some(x => x.id === target) ? target : null;
	if (!c) { return; }
	cat = c; query = ''; $('q').value = ''; onlyChanged = false; $('mod').setAttribute('aria-pressed', 'false'); tabs(); filter();
	if (r) { r.row.scrollIntoView({ block: 'center' }); r.row.classList.add('flash'); setTimeout(() => r.row.classList.remove('flash'), 1400); }
}

window.addEventListener('message', e => {
	const m = e.data || {};
	if (m.type === 'data') { data = { categories: m.categories, settings: m.settings }; render(); if (m.focus) { focus(m.focus); } }
	else if (m.type === 'focus') { focus(m.target); }
});
send({ type: 'ready' });
</script></body></html>`;
}
