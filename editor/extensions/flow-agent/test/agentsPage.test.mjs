// The Agents page is one document built from strings in src/agentsPage.ts (and the shell, workspace and layout scripts it puts together);
// a quote lost in them breaks the whole page without a word. This builds the page, checks its CSP and that nothing is loaded from outside,
// runs its script in a small fake DOM with a stub terminal (xterm needs a real browser) and checks what it draws from the host's messages,
// what it posts back, the drag and drop, the layout, the broadcast and the saved layouts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let agentsHtml
let html
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agents-page-'))
	// Bundled without a vscode stub: the page must stay free of `vscode` (the website renders it too).
	const outfile = join(tmp, 'agentsPage.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'agentsPage.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	agentsHtml = (await import(pathToFileURL(outfile).href)).agentsHtml
	html = agentsHtml('n0nce')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

/** The page's own scripts (the avatar one and the app), not the terminal bundle. */
const scriptsOf = source => [...source.matchAll(/<script nonce="n0nce">([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => !s.startsWith('/*insilode:xterm*/'))

// ---- a DOM with just what the page uses ------------------------------------------------------------------------------------
class Node {
	constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = undefined; this.className = ''; this._text = ''; this.value = ''; this.hidden = false; this.innerHTML = ''; this.scrollTop = 0; this.style = {}; this.w = 0; this.h = 0 }
	get firstChild() { return this.children[0] }
	get lastChild() { return this.children[this.children.length - 1] }
	appendChild(c) { if (c.parent) { c.parent.removeChild(c) } c.parent = this; this.children.push(c); return c }
	removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parent = undefined; return c }
	setAttribute(k, v) { this.attrs[k] = String(v) }
	getAttribute(k) { return this.attrs[k] }
	addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }
	contains(n) { return n === this || this.children.some(c => c.contains(n)) }
	focus() { Node.focused = this }
	blur() { if (Node.focused === this) { Node.focused = undefined } }
	getBoundingClientRect() { return { left: 0, top: 0, right: this.w, bottom: this.h, width: this.w, height: this.h } }
	querySelector(sel) { return this.find(n => n.className.split(' ').includes(sel.slice(1)))[0] ?? null }
	get textContent() { return this.isText ? this._text : this.children.map(c => c.textContent).join('') }
	set textContent(v) { this.children = []; this._text = String(v) ; if (v !== '') { const t = new Node('#text'); t.isText = true; t._text = String(v); t.parent = this; this.children.push(t) } }
	fire(type, extra = {}) { const e = { type, target: this, key: undefined, preventDefault() {}, stopPropagation() {}, ...extra }; for (const f of this.listeners[type] || []) { f(e) } return e }
	walk(f) { f(this); this.children.forEach(c => c.walk(f)) }
	find(pred) { const out = []; this.walk(n => { if (!n.isText && pred(n)) { out.push(n) } }); return out }
	byClass(c) { return this.find(n => n.className.split(' ').includes(c)) }
	button(label) { return this.find(n => n.tagName === 'BUTTON' && n.textContent.trim() === label)[0] }
	labelled(label) { return this.find(n => n.attrs['aria-label'] === label)[0] }
}

/** A terminal that records what the page does to it. */
function stubTerminals() {
	const terms = []
	const factory = (host, o) => {
		const t = { host, o, written: [], resets: 0, focused: 0, disposed: false, size: { cols: 100, rows: 30 }, themed: 0,
			write(d) { t.written.push(d) }, reset() { t.resets++; t.written = [] }, fit() { return t.size }, focus() { t.focused++ }, dispose() { t.disposed = true }, setTheme() { t.themed++ } }
		terms.push(t)
		return t
	}
	return { terms, factory }
}

function boot({ vscodeApi = true, term = true } = {}) {
	const posted = []
	const parentPosted = []
	const body = new Node('body')
	const docListeners = {}
	Node.focused = undefined
	const document = {
		body,
		createElement: t => new Node(t),
		createTextNode: s => { const t = new Node('#text'); t.isText = true; t._text = String(s); return t },
		addEventListener: (t, f) => { (docListeners[t] ||= []).push(f) },
		get activeElement() { return Node.focused },
	}
	let onMessage
	const timers = []
	const win = { addEventListener: (t, f) => { if (t === 'message') { onMessage = f } }, parent: { postMessage: (m, o) => parentPosted.push([JSON.parse(JSON.stringify(m)), o]) } }
	win.window = win
	const stub = stubTerminals()
	if (term) { win.insilodeTermFactory = stub.factory }
	const ctx = { window: win, document, setInterval: () => 1, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length }, clearTimeout: id => { if (timers[id - 1]) { timers[id - 1].f = () => {} } }, Math, Object, isFinite, Date, String, Number, Map, Set, Array, JSON, Boolean, RegExp }
	if (vscodeApi) { ctx.acquireVsCodeApi = () => ({ postMessage: m => posted.push(JSON.parse(JSON.stringify(m))) }) }
	// One scope for the page's scripts, as the browser gives them (the avatar script defines window.insilodeAvatar).
	vm.createContext(ctx)
	for (const s of scriptsOf(html)) { vm.runInContext(s, ctx) }
	const page = {
		body, posted, parentPosted, timers, terms: stub.terms,
		send: m => onMessage({ data: m }),
		data: (rows, extra = {}) => page.send({ type: 'data', now: Date.now(), avatar: 'pixel', rows, kept: [], customs: [], ...extra }),
		key: (key, extra = {}) => { const e = { type: 'keydown', key, target: body, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() { e.prevented = true }, ...extra }; for (const f of docListeners.keydown || []) { f(e) } return e },
		chord: (code, extra = {}) => page.key('x', { code, altKey: true, shiftKey: true, ...extra }),
		click: target => { for (const f of docListeners.click || []) { f({ type: 'click', target }) } },
		/** Runs the timers that were set with this delay (or all of them), once. */
		flush: ms => { for (const t of timers.splice(0)) { if (ms === undefined || t.ms === ms) { t.f() } else { timers.push(t) } } },
		text: () => body.textContent,
		app: () => body.find(n => n.attrs && n.attrs.id === 'app')[0],
		panes: () => body.byClass('pane').filter(n => n.tagName === 'SECTION'),
		stage: () => body.byClass('stage')[0],
		side: () => body.byClass('side')[0],
		lastTerm: () => stub.terms.at(-1),
		last: type => posted.filter(m => m.type === type).at(-1),
		all: type => posted.filter(m => m.type === type),
	}
	return page
}

const SID = n => `0a99a3dd-7db0-4ba0-882d-a4dd922189b${n}`
const row = (over = {}) => ({ id: 'a1', cli: 'claude', name: 'Claude 2', state: 'idle', since: Date.now(), todos: [], unread: false, done: 0, explain: false, skeletonOn: false, skeletonAvailable: false, acceptsInput: true, ...over })
const tokens = n => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 })
const rows = () => [
	row({ id: SID(1), name: 'Needy', state: 'blocked', attention: 'approval', need: { kind: 'approval', source: 'permission', text: 'Run rm -rf build', at: 1 }, cwd: '/work/app' }),
	row({ id: SID(2), name: 'Worker', state: 'working', prompt: 'Fix the login bug', activity: 'Editing src/login.ts', todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }], done: 1,
		usage: { used: 80_000, size: 200_000 }, cost: { session: { tokens: tokens(1500), usd: 0.42 }, scope: 'session' }, cwd: '/work/app',
		pr: { number: 12, state: 'open', title: 'Fix login', url: 'x', checks: 'fail', counts: { pass: 3, fail: 1, pending: 0 }, failing: ['lint'], reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', comments: [], reviews: [], author: 'me', headRefOid: 'abc' },
		worktree: { branch: 'insilode/w', base: 'main', ahead: 2, behind: 1, uncommitted: 3 },
		impact: { files: 2, more: 0, flows: [{ label: 'GET /login' }], tables: [{ table: 'users', endpoints: 2 }] },
		clash: [{ text: 'Needy also edits login.ts', same: false, files: ['login.ts'] }], skeletonAvailable: true }),
	row({ id: SID(3), name: 'Finisher', cli: 'codex', state: 'done', attention: 'done', unread: true, explain: true, agentId: SID(9), cwd: '/work/app' }),
	row({ id: SID(4), name: 'Gone', state: 'ended', acceptsInput: false, cwd: '/work/app' }),
]
const sidebarRow = (p, name) => p.side().byClass('srow').find(r => r.textContent.includes(name) && !r.className.includes('crow') || false) ?? p.side().byClass('srow').find(r => r.textContent.includes(name))
/** Opens a row of the sidebar by clicking it, as a user does. */
const openRow = (p, name) => sidebarRow(p, name).fire('click')

// ---- helpers for the drag and drop ------------------------------------------------------------------------------------------
const dt = () => ({ setData() {}, dropEffect: '', effectAllowed: '' })
/** Drags a sidebar row over `pane` at (x, y) of a 400 x 300 pane and drops it there. */
function dropRow(p, name, pane, x, y) {
	const r = sidebarRow(p, name)
	r.fire('dragstart', { dataTransfer: dt() })
	pane.w = 400; pane.h = 300
	pane.fire('dragover', { clientX: x, clientY: y, dataTransfer: dt() })
	pane.fire('drop', { clientX: x, clientY: y, dataTransfer: dt() })
	r.fire('dragend')
}
const RIGHT = [390, 150], LEFT = [10, 150], TOP = [200, 5], BOTTOM = [200, 295], CENTER = [200, 150]
const titles = p => p.panes().map(n => n.attrs['aria-label'].split(',')[0])
const layouts = (p, extra = {}) => p.send({ type: 'layouts', saved: [], ...extra })
/** Opens the Layouts menu (a menu left open by an earlier step is closed first) and gives back its element. */
function layoutsMenu(p) {
	const btn = p.body.button('Layouts ▾')
	if (btn.attrs['aria-expanded'] === 'true') { btn.fire('click', { stopPropagation() {} }) }
	btn.fire('click', { stopPropagation() {} })
	return p.body.byClass('menu')[0]
}
const menuItem = (menu, label) => menu.find(n => n.tagName === 'BUTTON' && n.textContent.startsWith(label))[0]

test('the page has a locked-down CSP and loads nothing from outside', T, () => {
	assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-n0nce';">/)
	assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']?https?:/i)
	assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i)
	assert.doesNotMatch(html, /require\(|\bimport\s+[\w{]/)
})

test('with the terminal built in it is one more nonced script and the policy is the same; a bundle holding markup is not used', T, () => {
	const withTerm = agentsHtml('n0nce', { js: 'window.insilodeXterm = {};', css: '.xterm { color: red }' })
	const policy = /<meta http-equiv="Content-Security-Policy"[^>]*>/
	assert.equal(withTerm.match(policy)[0], html.match(policy)[0])
	assert.equal(withTerm.match(/<script nonce="n0nce">/g).length, html.match(/<script nonce="n0nce">/g).length + 1)
	assert.match(withTerm, /<style>[^<]*\.xterm \{ color: red \}<\/style>/)
	assert.doesNotMatch(withTerm, /script-src[^;]*unsafe/)
	for (const js of ['x</script><script>alert(1)</script>', 'a <!-- b', '<script>']) {
		const bad = agentsHtml('n0nce', { js, css: '' })
		assert.doesNotMatch(bad, /alert\(1\)|<!--/)
		assert.equal(bad.match(/<script nonce="n0nce">/g).length, html.match(/<script nonce="n0nce">/g).length, 'the page is drawn without it')
	}
	assert.doesNotMatch(agentsHtml('n0nce', { js: '1', css: '</style><script>alert(1)</script>' }), /alert\(1\)/)
})

test('the page stays hidden until its first rows, so nothing jumps when they arrive; without a host it shows itself', T, () => {
	const p = boot()
	assert.equal(p.app().hidden, true)
	p.data([])
	assert.equal(p.app().hidden, false)
	const lone = boot({ vscodeApi: false })
	assert.equal(lone.app().hidden, true)
	lone.flush()
	assert.equal(lone.app().hidden, false)
})

test('the inline scripts parse and the page posts ready; with no host it posts to no window at all', T, () => {
	for (const s of scriptsOf(html)) { assert.doesNotThrow(() => new vm.Script(s)) }
	assert.deepEqual(boot().posted, [{ type: 'ready' }])
	assert.deepEqual(boot({ vscodeApi: false }).parentPosted, [])
})

test('the workspace is the first view; there is no chat view any more', T, () => {
	const p = boot()
	p.data(rows())
	assert.equal(p.body.byClass('work')[0].className.includes('hidden'), false)
	assert.equal(p.body.byClass('main')[0].className.includes('hidden'), true)
	assert.equal(p.body.button('Chat'), undefined)
	assert.ok(p.body.button('Workspace') && p.body.button('Board') && p.body.button('List'))
	assert.equal(p.body.button('Workspace').attrs['aria-pressed'], 'true')
	assert.doesNotMatch(p.text(), /Chat transcript|Message the agent/)
})

test('an empty workspace says what to do and offers both start buttons', T, () => {
	const p = boot()
	p.data([])
	assert.match(p.text(), /Drag a session here, or start a new one/)
	assert.equal(p.panes().length, 0)
	assert.ok(p.body.byClass('wempty')[0].button('New Claude') && p.body.byClass('wempty')[0].button('New Codex'))
})

// ---- opening sessions ------------------------------------------------------------------------------------------------------
test('New Claude opens a pane that says Starting…, then attaches to the session the host answers with', T, () => {
	const p = boot()
	p.data([])
	p.posted.length = 0
	p.body.byClass('wempty')[0].button('New Claude').fire('click')
	const open = p.last('termOpen')
	assert.deepEqual({ ...open, requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'claude' })
	assert.ok(open.requestId.length > 0 && open.requestId.length <= 100)
	assert.equal(p.panes().length, 1)
	assert.match(p.text(), /Starting…/)
	assert.equal(p.terms.length, 0)
	p.send({ type: 'termOpened', id: SID(5), requestId: open.requestId })
	assert.deepEqual(p.last('termAttach'), { type: 'termAttach', id: SID(5) })
	assert.equal(p.terms.length, 1)
	assert.equal(p.body.byClass('pover')[0].className.includes('hidden'), true)
	p.flush(120)
	assert.deepEqual(p.last('termResize'), { type: 'termResize', id: SID(5), cols: 100, rows: 30 })
})

test('a start that fails shows the host\'s sentence with Retry, which asks again with a new request', T, () => {
	const p = boot()
	p.data([])
	p.body.button('Codex').fire('click')
	const first = p.last('termOpen')
	assert.equal(first.kind, 'codex')
	p.send({ type: 'termFailed', requestId: 'someone-elses', message: 'ignored' })
	assert.match(p.text(), /Starting…/)
	p.send({ type: 'termFailed', requestId: first.requestId, message: 'Not started: the agent was not allowed to run in that folder.' })
	assert.match(p.text(), /Could not start/)
	assert.match(p.text(), /not allowed to run in that folder/)
	p.body.button('Retry').fire('click')
	const second = p.all('termOpen')[1]
	assert.equal(second.kind, 'codex')
	assert.notEqual(second.requestId, first.requestId)
	p.send({ type: 'termOpened', id: SID(6), requestId: first.requestId })
	assert.equal(p.terms.length, 0, 'an answer to the first request is not for the pane any more')
	p.send({ type: 'termOpened', id: SID(6), requestId: second.requestId })
	assert.equal(p.terms.length, 1)
})

test('a session of this window opens in the focused pane and attaches; the header says who it is', T, () => {
	const p = boot()
	p.data(rows(), { project: { name: 'my-app' } })
	p.posted.length = 0
	openRow(p, 'Worker')
	assert.deepEqual(p.all('termAttach'), [{ type: 'termAttach', id: SID(2) }])
	assert.equal(p.all('termOpen').length, 0, 'a running session is attached, not started')
	const head = p.panes()[0].byClass('ph')[0]
	assert.match(head.textContent, /Worker/)
	assert.match(head.textContent, /app/)
	assert.match(head.textContent, /⎇ insilode\/w/)
	assert.match(head.textContent, /Working · /)
	assert.ok(head.byClass('sdot')[0].className.includes('working'))
	assert.ok(head.byClass('mark')[0])
	assert.match(p.panes()[0].attrs['aria-label'], /Worker, Claude Code, working/)
	assert.ok(p.panes()[0].className.split(' ').includes('active'))
})

test('output goes to the terminal (a reset replaces it), keystrokes go to the session, big pastes in pieces', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	const t = p.lastTerm()
	p.send({ type: 'termData', id: SID(2), data: 'replay', reset: true })
	p.send({ type: 'termData', id: SID(2), data: ' more' })
	p.send({ type: 'termData', id: SID(3), data: 'not for this pane' })
	assert.deepEqual(t.written, ['replay', ' more'])
	assert.equal(t.resets, 1)
	p.posted.length = 0
	t.o.onData('ls\r')
	assert.deepEqual(p.posted, [{ type: 'termInput', id: SID(2), data: 'ls\r' }])
	p.posted.length = 0
	t.o.onData('x'.repeat(70000))
	assert.deepEqual(p.all('termInput').map(m => m.data.length), [32768, 32768, 4464])
})

test('the size goes to the host clamped to what it accepts, only when it changed, and only for an attached terminal', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	const t = p.lastTerm()
	p.flush(120)
	assert.deepEqual(p.all('termResize'), [{ type: 'termResize', id: SID(2), cols: 100, rows: 30 }])
	// A layout change fits every pane again: the same size is not sent again.
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	p.flush(120)
	assert.equal(p.all('termResize').filter(m => m.id === SID(2)).length, 1)
	// A size the host would refuse is brought into its range first.
	t.size = { cols: 9999, rows: 0 }
	dropRow(p, 'Finisher', p.panes()[0], ...BOTTOM)
	p.flush(120)
	assert.deepEqual(p.all('termResize').filter(m => m.id === SID(2)).at(-1), { type: 'termResize', id: SID(2), cols: 500, rows: 1 })
	// A pane that is not on screen reports nothing (fit has no size to give).
	const mine = () => p.all('termResize').filter(m => m.id === SID(2)).length
	const count = mine()
	t.fit = () => undefined
	t.size = { cols: 80, rows: 24 }
	p.chord('KeyM')
	p.flush(120)
	assert.equal(mine(), count)
	// An ended session reports nothing more.
	t.fit = () => ({ cols: 90, rows: 20 })
	p.send({ type: 'termGone', id: SID(2) })
	p.chord('KeyM')
	p.flush(120)
	assert.equal(mine(), count)
})

test('a session that ended shows "Session ended" with Resume, which asks the host to resume it in its folder by the CLI\'s id', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	p.send({ type: 'termGone', id: SID(2) })
	assert.match(p.text(), /Session ended/)
	assert.ok(p.panes()[0].className.split(' ').includes('ended'))
	p.posted.length = 0
	p.body.button('Resume').fire('click')
	const open = p.last('termOpen')
	assert.deepEqual({ ...open, requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'claude', sessionId: SID(2), cwd: '/work/app' })
	assert.match(p.text(), /Starting…/)
	p.send({ type: 'termOpened', id: SID(2), requestId: open.requestId })
	assert.equal(p.last('termAttach').id, SID(2))
	assert.match(p.text(), /Worker/)
	assert.equal(p.body.byClass('pover')[0].className.includes('hidden'), true)
})

test('a Codex session resumes by its own id, not the row\'s', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Finisher')
	p.send({ type: 'termGone', id: SID(3) })
	p.body.button('Resume').fire('click')
	assert.equal(p.last('termOpen').sessionId, SID(9))
	assert.equal(p.last('termOpen').kind, 'codex')
})

test('a past session of this window (ended) is resumed when the user opens it, in a terminal pane', T, () => {
	const p = boot()
	p.data(rows())
	p.body.button('Ended').fire('click')
	p.posted.length = 0
	openRow(p, 'Gone')
	assert.equal(p.all('termAttach').length, 0)
	const open = p.last('termOpen')
	assert.deepEqual({ ...open, requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'claude', sessionId: SID(4), cwd: '/work/app' })
	assert.match(p.text(), /Starting…/)
})

test('a session is open in at most one pane: opening it again shows that pane', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	assert.equal(p.panes().length, 2)
	p.posted.length = 0
	openRow(p, 'Worker')
	dropRow(p, 'Worker', p.panes()[1], ...CENTER)
	assert.equal(p.panes().length, 2)
	assert.equal(p.all('termAttach').length, 0, 'nothing attached twice')
	assert.deepEqual(titles(p).sort(), ['Needy', 'Worker'])
})

test('a click replaces the focused pane\'s session and lets go of the old one', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	const first = p.lastTerm()
	p.posted.length = 0
	openRow(p, 'Needy')
	assert.deepEqual(p.all('termDetach'), [{ type: 'termDetach', id: SID(2) }])
	assert.equal(first.disposed, true)
	assert.equal(p.panes().length, 1)
	assert.deepEqual(p.all('termAttach'), [{ type: 'termAttach', id: SID(1) }])
	assert.deepEqual(titles(p), ['Needy'])
})

// ---- drag and drop ---------------------------------------------------------------------------------------------------------
test('every row of the sidebar is draggable: this window\'s sessions, other projects\', earlier ones, search hits', T, () => {
	const p = boot()
	p.data(rows(), { project: { name: 'my-app' }, peers: peers(), recent: recent() })
	p.send(index())
	const box = p.body.byClass('sesearch')[0]
	const rowsNow = () => p.side().byClass('srow')
	assert.ok(rowsNow().length >= 6)
	assert.ok(rowsNow().every(r => r.attrs.draggable === 'true'))
	box.value = 'login'
	box.fire('input')
	p.flush()
	p.send({ type: 'chatFound', query: 'login', more: false, hits: [hitFor()] })
	assert.ok(p.side().byClass('srow').length >= 1 && p.side().byClass('srow').every(r => r.attrs.draggable === 'true'))
})

test('dragging over a pane shows the drop zone for where it would land; leaving clears it', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	const pane = p.panes()[0]
	pane.w = 400; pane.h = 300
	const zone = () => pane.byClass('pzone')[0].className
	pane.fire('dragover', { clientX: 10, clientY: 150, dataTransfer: dt() })
	assert.equal(zone(), 'pzone', 'a drag the page did not start shows nothing')
	sidebarRow(p, 'Needy').fire('dragstart', { dataTransfer: dt() })
	assert.ok(p.stage().className.includes('dragging'))
	for (const [at, name] of [[LEFT, 'left'], [RIGHT, 'right'], [TOP, 'top'], [BOTTOM, 'bottom'], [CENTER, 'center']]) {
		const e = pane.fire('dragover', { clientX: at[0], clientY: at[1], dataTransfer: dt(), preventDefault() { this.prevented = true } })
		assert.equal(zone(), 'pzone on z-' + name)
	}
	pane.fire('dragleave', { relatedTarget: null })
	assert.equal(zone(), 'pzone')
	sidebarRow(p, 'Needy').fire('dragend')
	assert.equal(p.stage().className.includes('dragging'), false)
})

test('dropping on the middle of a pane opens the session there; on an edge it splits that side; the layout is saved', T, () => {
	const p = boot()
	p.data(rows())
	layouts(p)
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...CENTER)
	assert.deepEqual(titles(p), ['Needy'])
	dropRow(p, 'Worker', p.panes()[0], ...RIGHT)
	assert.deepEqual(titles(p), ['Needy', 'Worker'])
	dropRow(p, 'Finisher', p.panes()[0], ...BOTTOM)
	assert.equal(p.panes().length, 3)
	p.posted.length = 0
	p.flush(500)
	const saved = p.last('layoutSave').layout
	assert.equal(saved.root.dir, 'row')
	assert.equal(saved.root.children[0].type, 'split')
	assert.equal(saved.root.children[0].dir, 'col')
	assert.deepEqual(saved.root.children[0].children.map(c => c.content.title), ['Needy', 'Finisher'])
	assert.equal(saved.root.children[0].children[0].content.session, SID(1))
	assert.equal(p.all('layoutSave').length, 1, 'one save for the burst of changes')
})

test('dropping on the empty workspace opens the first pane', T, () => {
	const p = boot()
	p.data(rows())
	const empty = p.body.byClass('wempty')[0]
	sidebarRow(p, 'Worker').fire('dragstart', { dataTransfer: dt() })
	empty.fire('dragover', { dataTransfer: dt() })
	assert.equal(empty.className, 'wempty over')
	empty.fire('drop', { dataTransfer: dt() })
	assert.deepEqual(titles(p), ['Worker'])
	assert.deepEqual(p.last('termAttach'), { type: 'termAttach', id: SID(2) })
})

test('a pane\'s header drags the pane: onto another pane\'s middle they swap, onto an edge it moves there', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	dropRow(p, 'Finisher', p.panes()[1], ...RIGHT)
	assert.deepEqual(titles(p), ['Worker', 'Needy', 'Finisher'])
	const drag = (from, to, at) => {
		const [a, b] = [p.panes()[from], p.panes()[to]]
		a.byClass('ph')[0].fire('dragstart', { dataTransfer: dt() })
		b.w = 400; b.h = 300
		b.fire('dragover', { clientX: at[0], clientY: at[1], dataTransfer: dt() })
		b.fire('drop', { clientX: at[0], clientY: at[1], dataTransfer: dt() })
		a.byClass('ph')[0].fire('dragend')
	}
	p.posted.length = 0
	drag(0, 2, CENTER)
	assert.deepEqual(titles(p), ['Finisher', 'Needy', 'Worker'])
	assert.equal(p.all('termAttach').length + p.all('termDetach').length, 0, 'moving a pane never re-attaches its terminal')
	drag(2, 0, TOP)
	assert.deepEqual(titles(p).sort(), ['Finisher', 'Needy', 'Worker'])
	assert.equal(p.body.byClass('sp').find(s => s.className.includes('col')) !== undefined, true)
	// A pane dropped on itself does nothing.
	const before = titles(p).join()
	const self = p.panes()[0]
	self.byClass('ph')[0].fire('dragstart', { dataTransfer: dt() })
	self.w = 400; self.h = 300
	self.fire('dragover', { clientX: 200, clientY: 150, dataTransfer: dt() })
	self.fire('drop', { clientX: 200, clientY: 150, dataTransfer: dt() })
	assert.equal(titles(p).join(), before)
})

test('a drop that would leave a pane too small says so and changes nothing', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	p.stage().w = 500
	p.stage().h = 400
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	assert.equal(p.panes().length, 1)
	assert.match(p.body.byClass('toast')[0].textContent, /no room/i)
	assert.equal(p.body.byClass('toast')[0].className.includes('hidden'), false)
	p.stage().w = 1200
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	assert.equal(p.panes().length, 2)
})

test('a new pane that does not fit beside the focused one goes below it when there is room', T, () => {
	const p = boot()
	p.data([])
	p.stage().w = 600
	p.stage().h = 700
	p.body.byClass('wempty')[0].button('New Claude').fire('click')
	p.body.button('Claude').fire('click')
	assert.equal(p.panes().length, 2, 'two panes side by side need 566 pixels: they fit in 588')
	p.body.button('Codex').fire('click')
	assert.equal(p.panes().length, 3)
	assert.equal(p.body.byClass('sp').filter(s => s.className.split(' ').includes('col')).length, 1, 'the third went below')
	p.stage().h = 300
	p.body.button('Claude').fire('click')
	assert.equal(p.panes().length, 3, 'with no room either way, a note and no new pane')
	assert.match(p.body.byClass('toast')[0].textContent, /no room/i)
})

test('no more than 16 panes', T, () => {
	const p = boot()
	const many = Array.from({ length: 20 }, (_, i) => row({ id: `0a99a3dd-7db0-4ba0-882d-a4dd922189${String(i).padStart(2, '0')}`, name: 'S' + String(i).padStart(2, '0') }))
	p.data(many)
	openRow(p, 'S00')
	for (let i = 1; i < 20; i++) { dropRow(p, 'S' + String(i).padStart(2, '0'), p.panes().at(-1), ...RIGHT) }
	assert.equal(p.panes().length, 16)
	assert.match(p.body.byClass('toast')[0].textContent, /At most 16 panes/)
})

test('a gutter drags a border (neither pane under its minimum) and takes the arrow keys; the sizes are saved', T, () => {
	const p = boot()
	p.data(rows())
	layouts(p)
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	const gutter = p.body.byClass('gutter')[0]
	assert.equal(gutter.attrs.role, 'separator')
	assert.equal(gutter.attrs['aria-orientation'], 'vertical')
	assert.equal(gutter.attrs.tabindex, '0')
	assert.deepEqual([gutter.attrs['aria-valuemin'], gutter.attrs['aria-valuenow'], gutter.attrs['aria-valuemax']], ['0', '50', '100'])
	const wrap = p.body.byClass('sp')[0]
	wrap.w = 1006; wrap.h = 500
	const flex = i => p.panes()[i].style.flex
	assert.equal(flex(0), '0.5 1 0px')
	gutter.fire('pointerdown', { clientX: 500 })
	gutter.fire('pointermove', { clientX: 600 })
	assert.equal(flex(0), '0.6 1 0px')
	assert.equal(flex(1), '0.4 1 0px')
	gutter.fire('pointermove', { clientX: 5000 })
	assert.equal(flex(0), '0.72 1 0px', 'the right pane keeps its minimum width')
	gutter.fire('pointermove', { clientX: -5000 })
	assert.equal(flex(0), '0.28 1 0px')
	gutter.fire('pointerup')
	p.flush(500)
	assert.deepEqual(p.last('layoutSave').layout.root.sizes.map(s => Math.round(s * 100)), [28, 72])
	gutter.fire('keydown', { key: 'ArrowRight' })
	assert.equal(flex(0), '0.3 1 0px')
	assert.equal(gutter.attrs['aria-valuenow'], '30')
	gutter.fire('keydown', { key: 'ArrowLeft', shiftKey: true })
	assert.equal(flex(0), '0.28 1 0px', 'Shift moves it ten times as far, still clamped')
})

test('double-clicking a header maximizes the pane and again restores it; the terminals stay attached', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	const terms = p.terms.length
	p.posted.length = 0
	p.panes()[0].byClass('ph')[0].fire('dblclick', { target: p.panes()[0].byClass('ph')[0] })
	assert.equal(p.stage().byClass('pane').filter(n => n.tagName === 'SECTION').length, 1)
	assert.ok(p.body.labelled('Restore Worker'))
	assert.equal(p.terms.filter(t => t.disposed).length, 0)
	assert.equal(p.all('termDetach').length, 0)
	p.body.labelled('Restore Worker').fire('click')
	assert.equal(p.panes().length, 2)
	assert.equal(p.terms.length, terms)
	// Maximize hides nothing for a single pane.
	p.panes()[1].byClass('ibtn')
	const b = p.body.labelled('Close pane Needy')
	b.fire('click')
	assert.equal(p.body.labelled('Maximize Worker'), undefined, 'one pane has nothing to maximize')
})

test('closing a pane lets go of its terminal and leaves the session running; the last one brings the empty state back', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	const t = p.lastTerm()
	p.posted.length = 0
	p.body.labelled('Close pane Worker').fire('click')
	assert.deepEqual(p.posted.filter(m => m.type !== 'layoutSave'), [{ type: 'termDetach', id: SID(2) }])
	assert.equal(t.disposed, true)
	assert.equal(p.panes().length, 0)
	assert.match(p.text(), /Drag a session here/)
})

// ---- the keyboard ----------------------------------------------------------------------------------------------------------
test('workspace shortcuts: focus next and previous pane, close, maximize; plain keys and other modifiers are not shortcuts', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	dropRow(p, 'Finisher', p.panes()[1], ...RIGHT)
	const active = () => titles(p)[p.panes().findIndex(n => n.className.split(' ').includes('active'))]
	assert.equal(active(), 'Finisher')
	assert.equal(p.chord('BracketRight').prevented, true)
	assert.equal(active(), 'Worker', 'next wraps round')
	p.chord('BracketLeft')
	assert.equal(active(), 'Finisher')
	p.chord('BracketLeft')
	assert.equal(active(), 'Needy')
	assert.ok(p.lastTerm().focused >= 0)
	assert.equal(p.key('x', { code: 'BracketRight' }).prevented, undefined, 'not without the chord')
	assert.equal(p.key('x', { code: 'BracketRight', altKey: true }).prevented, undefined)
	assert.equal(p.key('x', { code: 'BracketRight', altKey: true, shiftKey: true, ctrlKey: true }).prevented, undefined)
	p.chord('KeyM')
	assert.equal(p.stage().byClass('pane').filter(n => n.tagName === 'SECTION').length, 1)
	p.chord('KeyM')
	assert.equal(p.panes().length, 3)
	p.chord('KeyW')
	assert.deepEqual(titles(p), ['Worker', 'Finisher'])
	p.chord('Period')
	assert.equal(p.panes().length, 2)
})

test('Alt+Shift+\\ and Alt+Shift+- split the focused pane with the selected session', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...CENTER)
	assert.deepEqual(titles(p), ['Needy'])
	p.chord('Backslash')
	assert.deepEqual(titles(p), ['Needy', 'Worker'], 'the selected session (Worker) opens to the right')
	openRow(p, 'Finisher')
	dropRow(p, 'Worker', p.panes()[1], ...CENTER)
	assert.deepEqual(titles(p), ['Needy', 'Worker'])
	p.chord('Minus')
	assert.equal(p.panes().length, 3)
	assert.equal(p.body.byClass('sp').filter(s => s.className.split(' ').includes('col')).length, 1)
	p.chord('Minus')
	assert.equal(p.panes().length, 3, 'a session that is open is only shown')
})

test('with nothing selected a split shortcut says so', T, () => {
	const p = boot()
	p.data(rows())
	p.chord('Backslash')
	assert.match(p.body.byClass('toast')[0].textContent, /Select a session/)
})

test('a terminal leaves workspace shortcuts to the page and everything else to the agent; Escape in a terminal does not blur it', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	const { isChord } = p.lastTerm().o
	assert.equal(isChord({ altKey: true, shiftKey: true, code: 'KeyW' }), true)
	assert.equal(isChord({ altKey: true, code: 'KeyW' }), false)
	assert.equal(isChord({ ctrlKey: true, code: 'KeyC' }), false)
	let blurred = false
	const area = { tagName: 'TEXTAREA', className: 'xterm-helper-textarea', blur() { blurred = true } }
	p.key('Escape', { target: area })
	assert.equal(blurred, false)
	const box = { tagName: 'INPUT', className: '', blur() { blurred = true } }
	p.key('Escape', { target: box })
	assert.equal(blurred, true)
	p.posted.length = 0
	p.key('j', { target: area })
	p.key('/', { target: area })
	assert.deepEqual(p.posted, [])
})

// ---- other windows' sessions -----------------------------------------------------------------------------------------------
const peerRow = (over = {}) => ({ id: 'p1', cli: 'claude', name: 'Remote worker', state: 'working', since: Date.now(), prompt: 'Add the api', todos: [{ text: 'a', status: 'in_progress' }], flows: 1, activity: 'Editing api.ts', tokens: 2500, usd: 1.5, contextPercent: 30, pr: { number: 7, state: 'open', title: 'Add api' }, ...over })
const peers = () => [{ key: '0123456789ab', name: 'other-app', rows: [peerRow(), peerRow({ id: 'p2', name: 'Waiting', state: 'blocked', attention: 'approval', need: 'Run rm', flows: 0 }), peerRow({ id: 'p3', name: 'Gone peer', state: 'ended' })] }]
const recent = () => [{ key: 'ba9876543210', name: 'old-app', sessions: ['Fix login', 'Refactor'] }]

test('a session of another window opens as a read-only transcript with a way to that window; nothing is attached or started', T, () => {
	const p = boot()
	p.data(rows(), { project: { name: 'my-app' }, peers: peers() })
	p.posted.length = 0
	openRow(p, 'Remote worker')
	assert.equal(p.all('termAttach').length + p.all('termOpen').length, 0)
	assert.equal(p.terms.length, 0)
	const pane = p.panes()[0]
	assert.match(pane.textContent, /Remote worker/)
	assert.match(pane.textContent, /> Add the api/)
	assert.match(pane.textContent, /Editing api\.ts/)
	assert.match(pane.textContent, /\[>\] a/)
	assert.match(pane.textContent, /Runs in another window \(other-app\): read-only here\./)
	assert.equal(pane.byClass('tlog')[0].attrs.role, 'log')
	p.posted.length = 0
	pane.button('Go to that window').fire('click')
	pane.button('Open flow').fire('click')
	assert.deepEqual(p.all('peer'), [{ type: 'peer', action: 'ide', key: '0123456789ab', id: 'p1' }, { type: 'peer', action: 'flow', key: '0123456789ab', id: 'p1' }])
	openRow(p, 'Waiting')
	assert.equal(p.panes()[0].button('Open flow'), undefined, 'no flow, no button')
})

test('text from another window never becomes markup, in the sidebar or in its pane', T, () => {
	const p = boot()
	p.data([], { peers: [{ key: '0123456789ab', name: '<script>x</script>', rows: [peerRow({ name: '<img src=x onerror=1>', activity: '<b>b</b>', prompt: '<i>p</i>' })] }], recent: [{ key: 'ba9876543210', name: '<u>r</u>', sessions: ['<u>s</u>'] }] })
	openRow(p, '<img src=x onerror=1>')
	assert.match(p.text(), /<img src=x onerror=1>/)
	assert.match(p.text(), /<i>p<\/i>/)
	assert.equal(p.body.find(n => ['IMG', 'SCRIPT', 'U'].includes(n.tagName) || (n.tagName === 'B' && n.textContent === 'b') || (n.tagName === 'I' && n.textContent === 'p')).length, 0)
})

test('a transcript pane keeps what the host\'s tail says and a window that closed says so', T, () => {
	const p = boot()
	p.data(rows(), { peers: peers() })
	openRow(p, 'Remote worker')
	p.send({ type: 'tail', id: 'p1', entries: [{ role: 'user', text: 'hello agent' }, { role: 'tool', text: 'Edit src/api.ts' }] })
	assert.match(p.panes()[0].textContent, /hello agent/)
	assert.match(p.panes()[0].textContent, /\$ Edit src\/api\.ts/)
	p.data(rows(), { peers: [] })
	assert.match(p.panes()[0].textContent, /not listed any more/)
})

// ---- broadcast -------------------------------------------------------------------------------------------------------------
function threePanes() {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	dropRow(p, 'Finisher', p.panes()[1], ...RIGHT)
	return p
}
const boxOf = (p, name) => p.body.labelled('Broadcast to ' + name)
const bcInput = p => p.body.byClass('bcin')[0]

test('broadcast is off by default: no checkboxes, no input line; turning it on shows both', T, () => {
	const p = threePanes()
	assert.equal(p.body.byClass('bcbar')[0].className.includes('hidden'), true)
	assert.equal(boxOf(p, 'Worker'), undefined)
	assert.equal(p.body.button('Broadcast').attrs['aria-pressed'], 'false')
	p.body.button('Broadcast').fire('click')
	assert.equal(p.body.byClass('bcbar')[0].className.includes('hidden'), false)
	assert.ok(boxOf(p, 'Worker') && boxOf(p, 'Needy') && boxOf(p, 'Finisher'))
	assert.equal(p.body.button('Broadcast').attrs['aria-pressed'], 'true')
	assert.equal(boxOf(p, 'Worker').checked, false, 'nothing is checked until the user checks it')
	assert.match(p.body.byClass('bcnote')[0].textContent, /0 of 3 attached terminals/)
})

test('Enter sends the line and a carriage return to every checked terminal, and only to those; checked panes are marked', T, () => {
	const p = threePanes()
	p.body.button('Broadcast').fire('click')
	for (const n of ['Worker', 'Finisher']) { const b = boxOf(p, n); b.checked = true; b.fire('change', { target: b }) }
	assert.equal(p.panes().filter(n => n.className.split(' ').includes('target')).length, 2)
	assert.match(p.text(), /Receives broadcast/)
	assert.match(p.body.byClass('bcnote')[0].textContent, /2 of 3/)
	p.posted.length = 0
	bcInput(p).value = 'echo hi'
	bcInput(p).fire('keydown', { key: 'Enter' })
	assert.deepEqual(p.all('termInput'), [{ type: 'termInput', id: SID(2), data: 'echo hi\r' }, { type: 'termInput', id: SID(3), data: 'echo hi\r' }])
	assert.equal(bcInput(p).value, '')
	assert.match(p.body.byClass('bcnote')[0].textContent, /Sent to 2 terminals/)
	// An IME composition's Enter does not send.
	p.posted.length = 0
	bcInput(p).value = 'x'
	bcInput(p).fire('keydown', { key: 'Enter', isComposing: true })
	assert.deepEqual(p.all('termInput'), [])
})

test('with nothing checked nothing is sent and it says why; an empty line sends nothing', T, () => {
	const p = threePanes()
	p.body.button('Broadcast').fire('click')
	p.posted.length = 0
	bcInput(p).value = 'echo hi'
	bcInput(p).fire('keydown', { key: 'Enter' })
	assert.deepEqual(p.all('termInput'), [])
	assert.match(p.body.byClass('bcnote')[0].textContent, /Check at least one/)
	assert.equal(bcInput(p).value, 'echo hi', 'the line stays')
	p.body.button('Check all').fire('click')
	bcInput(p).value = ''
	bcInput(p).fire('keydown', { key: 'Enter' })
	assert.deepEqual(p.all('termInput'), [])
	p.body.button('Check none').fire('click')
	assert.equal(p.panes().filter(n => n.className.split(' ').includes('target')).length, 0)
})

test('a pane that is not an attached terminal never receives a broadcast: ended, starting, transcript', T, () => {
	const p = threePanes()
	p.data(rows(), { peers: peers() })
	dropRow(p, 'Remote worker', p.panes()[0], ...BOTTOM)
	p.body.button('Broadcast').fire('click')
	p.body.button('Check all').fire('click')
	assert.equal(p.panes().filter(n => n.className.split(' ').includes('target')).length, 3, 'only the three terminals')
	assert.equal(boxOf(p, 'Remote worker'), undefined, 'a transcript has no checkbox')
	// One session ends after it was checked: it drops out.
	p.send({ type: 'termGone', id: SID(1) })
	assert.equal(boxOf(p, 'Needy').attrs.disabled, '')
	p.posted.length = 0
	bcInput(p).value = 'go'
	bcInput(p).fire('keydown', { key: 'Enter' })
	assert.deepEqual(p.all('termInput').map(m => m.id).sort(), [SID(2), SID(3)].sort())
	// Turning it off forgets the checks.
	p.body.button('Broadcast').fire('click')
	assert.equal(p.body.byClass('bcbar')[0].className.includes('hidden'), true)
	p.body.button('Broadcast').fire('click')
	assert.equal(p.panes().filter(n => n.className.split(' ').includes('target')).length, 0)
})

test('Alt+Shift+B toggles broadcast', T, () => {
	const p = threePanes()
	p.chord('KeyB')
	assert.equal(p.body.byClass('bcbar')[0].className.includes('hidden'), false)
	p.chord('KeyB')
	assert.equal(p.body.byClass('bcbar')[0].className.includes('hidden'), true)
})

// ---- saved layouts and restore ---------------------------------------------------------------------------------------------
const paneJson = (id, session, over = {}) => ({ type: 'pane', id, content: { kind: 'terminal', agent: 'claude', session, title: 'T-' + id, cwd: '/work/app', ...over } })
const saved2 = () => ({ seq: 3, focus: 'p1', root: { type: 'split', id: 's3', dir: 'row', sizes: [0.4, 0.6], children: [paneJson('p1', SID(2)), paneJson('p2', SID(7), { resume: SID(7), title: 'Past' })] } })

test('the layout the host remembers is restored once: panes attach again, nothing is started, and a gone session says Resume', T, () => {
	const p = boot()
	p.data(rows())
	p.posted.length = 0
	layouts(p, { current: saved2() })
	assert.equal(p.panes().length, 2)
	assert.deepEqual(p.all('termAttach').map(m => m.id), [SID(2), SID(7)])
	assert.equal(p.all('termOpen').length, 0, 'a restored workspace starts no agent')
	assert.equal(p.panes()[0].style.flex, '0.4 1 0px')
	p.send({ type: 'termGone', id: SID(7) })
	assert.match(p.panes()[1].textContent, /Session ended/)
	p.posted.length = 0
	p.panes()[1].button('Resume').fire('click')
	assert.deepEqual({ ...p.last('termOpen'), requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'claude', sessionId: SID(7), cwd: '/work/app' })
	// A second layouts message (a list of saved ones changed) does not restore over what is on screen.
	layouts(p, { current: { seq: 1, root: paneJson('p1', SID(1)) } })
	assert.equal(p.panes().length, 2)
})

test('a pane that was never started (no session) restores as Start session, not as a running agent', T, () => {
	const p = boot()
	p.data(rows())
	layouts(p, { current: { seq: 1, root: paneJson('p1', undefined, { session: undefined, title: 'New Claude' }) } })
	assert.equal(p.all('termAttach').length, 0)
	assert.equal(p.all('termOpen').length, 0)
	assert.match(p.text(), /It has not been started yet/)
	p.body.button('Start session').fire('click')
	assert.equal(p.last('termOpen').kind, 'claude')
})

test('a layout the user already changed is not restored over their work; it is saved instead', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	layouts(p, { current: saved2() })
	assert.deepEqual(titles(p), ['Worker'])
	p.flush(500)
	assert.equal(p.last('layoutSave').layout.root.content.session, SID(2))
})

test('an unsound remembered layout is ignored whole', T, () => {
	const p = boot()
	p.data(rows())
	layouts(p, { current: { seq: 1, root: { type: 'pane', id: 'x', content: { kind: 'shell', agent: 'claude' } } } })
	assert.equal(p.panes().length, 0)
	layouts(boot(), { saved: [{ name: 'Bad', layout: { seq: 'a' } }] })
})

test('nothing is saved before the host has said which layout the page had', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	p.flush(500)
	assert.equal(p.all('layoutSave').length, 0)
	layouts(p)
	p.flush(500)
	assert.equal(p.all('layoutSave').length, 1)
})

test('the Layouts menu lists saved layouts; applying one replaces the workspace and starts nothing', T, () => {
	const p = boot()
	p.data(rows())
	layouts(p, { saved: [{ name: 'Review', layout: saved2() }, { name: 'Solo', layout: { seq: 1, root: paneJson('p1', SID(1)) } }] })
	openRow(p, 'Finisher')
	p.posted.length = 0
	const menu = layoutsMenu(p)
	assert.equal(p.body.button('Layouts ▾').attrs['aria-expanded'], 'true')
	assert.match(menu.textContent, /Review.*2 panes/)
	menuItem(menu, 'Review').fire('click')
	assert.deepEqual(titles(p), ['Worker', 'T-p2'].map(t => t === 'T-p2' ? 'Past' : t).map(t => t))
	assert.deepEqual(p.all('termDetach'), [{ type: 'termDetach', id: SID(3) }])
	assert.deepEqual(p.all('termAttach').map(m => m.id), [SID(2), SID(7)])
	assert.equal(p.all('termOpen').length, 0)
	assert.equal(p.body.byClass('menu')[0].className.includes('hidden'), true)
})

test('"Save layout as…" posts the layout under a trimmed name; nothing is saved without panes or with a bad name', T, () => {
	const p = boot()
	p.data(rows())
	layouts(p)
	const save = (name) => {
		const menu = layoutsMenu(p)
		menu.find(n => n.tagName === 'INPUT')[0].value = name
		menu.button('Save').fire('click')
	}
	save('Empty')
	assert.equal(p.all('layoutSaveAs').length, 0, 'an empty workspace is not worth saving')
	openRow(p, 'Worker')
	dropRow(p, 'Needy', p.panes()[0], ...RIGHT)
	save('   ')
	save('x'.repeat(61))
	assert.equal(p.all('layoutSaveAs').length, 0)
	save('  Review  ')
	const m = p.last('layoutSaveAs')
	assert.equal(m.name, 'Review')
	assert.equal(m.layout.root.children.length, 2)
	assert.match(p.body.byClass('toast')[0].textContent, /Saved layout "Review"/)
})

test('at 20 saved layouts a new name is refused, an existing one is replaced', T, () => {
	const p = boot()
	p.data(rows())
	const twenty = Array.from({ length: 20 }, (_, i) => ({ name: 'L' + i, layout: { seq: 1, root: paneJson('p1', SID(1)) } }))
	layouts(p, { saved: twenty })
	openRow(p, 'Worker')
	const save = name => {
		const menu = layoutsMenu(p)
		menu.find(n => n.tagName === 'INPUT')[0].value = name
		menu.button('Save').fire('click')
	}
	save('One more')
	assert.equal(p.all('layoutSaveAs').length, 0)
	assert.match(p.body.byClass('toast')[0].textContent, /At most 20/)
	save('L3')
	assert.equal(p.last('layoutSaveAs').name, 'L3')
})

test('a saved layout is deleted from the menu; Escape closes the menu and gives the focus back', T, () => {
	const p = boot()
	p.data(rows())
	layouts(p, { saved: [{ name: 'Review', layout: saved2() }] })
	const btn = p.body.button('Layouts ▾')
	btn.fire('click', { stopPropagation() {} })
	p.body.byClass('menu')[0].labelled('Delete layout Review').fire('click')
	assert.deepEqual(p.last('layoutDelete'), { type: 'layoutDelete', name: 'Review' })
	btn.fire('click', { stopPropagation() {} })
	p.key('Escape')
	assert.equal(p.body.byClass('menu')[0].className.includes('hidden'), true)
	assert.equal(Node.focused, btn)
	assert.equal(btn.attrs['aria-expanded'], 'false')
	layouts(p, { saved: [] })
	btn.fire('click', { stopPropagation() {} })
	assert.match(p.body.byClass('menu')[0].textContent, /No saved layouts yet/)
	p.click(p.body)
	assert.equal(p.body.byClass('menu')[0].className.includes('hidden'), true, 'a click elsewhere closes it')
})

// ---- the pane menu ---------------------------------------------------------------------------------------------------------
test('the pane\'s … menu has the row actions the page already had, posting the same messages', T, () => {
	const p = boot()
	p.data(rows())
	openRow(p, 'Worker')
	p.posted.length = 0
	const act = label => {
		p.body.labelled('Actions for Worker').fire('click', { stopPropagation() {} })
		p.body.byClass('menu')[0].button(label).fire('click')
	}
	act('Show changes on the flow canvas')
	act('Open flow: GET /login')
	act('Rename…')
	act('X-ray the context window')
	act('Open pull request #12')
	act('Merge insilode/w…')
	act('Remove the worktree…')
	act('Show its terminal in the editor')
	act('Skeleton first: off (turn on)')
	assert.deepEqual(p.posted, [
		{ type: 'wt', id: SID(2), action: 'diff' }, { type: 'flow', id: SID(2), index: 0 }, { type: 'rename', id: SID(2) }, { type: 'xray', id: SID(2) },
		{ type: 'pr', id: SID(2) }, { type: 'wt', id: SID(2), action: 'merge' }, { type: 'wt', id: SID(2), action: 'remove' }, { type: 'show', id: SID(2) }, { type: 'sk', id: SID(2), on: true }])
	p.body.labelled('Actions for Worker').fire('click', { stopPropagation() {} })
	assert.match(p.body.byClass('menu')[0].textContent, /Close pane \(the session keeps running\)/)
	p.body.byClass('menu')[0].button('Close pane (the session keeps running)').fire('click')
	assert.equal(p.panes().length, 0)
})

test('an ended row offers Forget in its pane menu; a Codex row offers Swap', T, () => {
	const p = boot()
	p.data(rows())
	p.body.button('Ended').fire('click')
	p.send({ type: 'data', now: Date.now(), avatar: 'pixel', rows: rows().map(r => r.id === SID(4) ? { ...r, state: 'ended' } : r), kept: [], customs: [] })
	layouts(p, { current: { seq: 1, root: paneJson('p1', SID(4)) } })
	p.body.labelled('Actions for Gone').fire('click', { stopPropagation() {} })
	p.body.byClass('menu')[0].button('Forget this session').fire('click')
	assert.deepEqual(p.last('forget'), { type: 'forget', id: SID(4) })
})

// ---- starting sessions the host's way --------------------------------------------------------------------------------------
test('the More menu\'s starts open the new session in a pane when the host\'s row for it appears; the bypass switch does not', T, () => {
	const p = boot()
	p.data(rows(), { customs: ['Gemini'] })
	p.data2 = r => p.data(r, { customs: ['Gemini'] })
	p.posted.length = 0
	p.body.button('More ▾').fire('click', { stopPropagation() {} })
	p.body.byClass('menu')[0].button('Claude in a worktree').fire('click')
	assert.deepEqual(p.last('start'), { type: 'start', cli: 'claude', how: 'worktree' })
	assert.equal(p.panes().length, 0)
	p.data2(rows().concat([row({ id: SID(8), name: 'Fresh claude', state: 'working' })]))
	assert.deepEqual(titles(p), ['Fresh claude'])
	assert.deepEqual(p.last('termAttach'), { type: 'termAttach', id: SID(8) })
	p.data2(rows().concat([row({ id: SID(8), name: 'Fresh claude' }), row({ id: SID(9), name: 'Later one', state: 'working' })]))
	assert.equal(p.panes().length, 1, 'only the next new session is taken, once')
	p.body.button('More ▾').fire('click', { stopPropagation() {} })
	p.body.byClass('menu')[0].button('Claude: allow bypass permissions mode…').fire('click')
	p.data2(rows().concat([row({ id: SID(8), name: 'Fresh claude' }), row({ id: SID(9) }), row({ id: SID(5), name: 'Other', state: 'working' })]))
	assert.equal(p.panes().length, 1)
	p.body.button('More ▾').fire('click', { stopPropagation() {} })
	p.body.byClass('menu')[0].button('Gemini').fire('click')
	assert.deepEqual(p.last('custom'), { type: 'custom', index: 0, name: 'Gemini' })
	p.data2(rows().concat([row({ id: SID(8), name: 'Fresh claude' }), row({ id: SID(9) }), row({ id: SID(5) }), row({ id: SID(6), name: 'gem', cli: 'custom', state: 'working' })]))
	assert.deepEqual(titles(p).sort(), ['Fresh claude', 'gem'])
})

test('earlier sessions of a project start again in its folder; this window\'s own folder needs no path', T, () => {
	const p = boot()
	p.data([])
	p.send(index())
	p.posted.length = 0
	p.body.byClass('crow')[0].fire('click')
	assert.deepEqual({ ...p.last('termOpen'), requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'claude', sessionId: SESSION })
	p.send({ type: 'termOpened', id: SESSION, requestId: p.last('termOpen').requestId })
	assert.deepEqual(p.last('termAttach'), { type: 'termAttach', id: SESSION })
	p.body.byClass('crow')[1].fire('click')
	assert.deepEqual({ ...p.last('termOpen'), requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'codex', sessionId: SESSION2, cwd: '/work/other' })
})

test('"+ Codex" under a project opens a new session in a new pane, in that project\'s folder', T, () => {
	const p = boot()
	p.data([])
	p.send(index())
	p.posted.length = 0
	const other = p.side().byClass('sgroup').find(g => /other/.test(g.textContent) && !/Login work/.test(g.textContent))
	other.button('+ Codex').fire('click')
	assert.deepEqual({ ...p.last('termOpen'), requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'codex', cwd: '/work/other' })
	p.body.button('+ Claude').fire('click')
	assert.equal(p.panes().length, 2, 'each new session has a pane of its own')
	assert.deepEqual({ ...p.last('termOpen'), requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'claude' })
})

test('the sidebar controls post the existing and the peer messages', T, () => {
	const p = boot()
	p.data(rows(), { project: { name: 'my-app' }, peers: peers(), recent: recent() })
	p.posted.length = 0
	p.body.button('New session').fire('click')
	p.side().button('Open in IDE').fire('click')
	p.body.button('Open project').fire('click')
	assert.deepEqual(p.posted, [{ type: 'pick' }, { type: 'peer', action: 'ide', key: '0123456789ab' }, { type: 'peer', action: 'ide', key: 'ba9876543210' }])
})

test('without a terminal in the page (the website) a pane shows the conversation tail and points at the editor\'s terminal', T, () => {
	const p = boot({ term: false })
	p.data(rows())
	p.posted.length = 0
	openRow(p, 'Worker')
	assert.deepEqual(p.posted.filter(m => m.type !== 'layoutSave'), [{ type: 'tail', id: SID(2) }], 'nothing is attached: there is no terminal to attach')
	assert.match(p.panes()[0].textContent, /> Fix the login bug/)
	p.send({ type: 'tail', id: SID(2), entries: [{ role: 'assistant', text: 'on it' }] })
	assert.match(p.panes()[0].textContent, /on it/)
	assert.match(p.panes()[0].textContent, /the live one runs in the editor/)
	p.posted.length = 0
	p.panes()[0].button('Show terminal in the editor').fire('click')
	assert.deepEqual(p.posted, [{ type: 'show', id: SID(2) }])
	assert.equal(p.panes()[0].byClass('pover')[0].className.includes('hidden'), true)
	// There is nothing to broadcast to either.
	p.body.button('Broadcast').fire('click')
	assert.equal(p.body.labelled('Broadcast to Worker').attrs.disabled, '')
})

test('the keyboard reaches the sidebar: Alt+Shift+S focuses it, Enter on a row opens it', T, () => {
	const p = boot()
	p.data(rows(), { project: { name: 'my-app' } })
	p.chord('KeyS')
	assert.equal(Node.focused.className.includes('srow'), true)
	const row0 = sidebarRow(p, 'Needy')
	row0.fire('keydown', { key: 'Enter' })
	assert.deepEqual(titles(p), ['Needy'])
	assert.ok(sidebarRow(p, 'Needy').className.includes('sel'))
	assert.ok(sidebarRow(p, 'Needy').className.includes('inpane'))
	assert.equal(sidebarRow(p, 'Worker').className.includes('inpane'), false)
})

// ---- Board and List --------------------------------------------------------------------------------------------------------
test('the board sorts agents into columns and the header counts them', T, () => {
	const p = boot()
	p.data(rows(), { limits: { harness: 'claude', windows: [{ label: '5h', usedPercent: 40, resetsAt: Date.now() + 3_600_000 }] } })
	p.body.button('Board').fire('click')
	const cols = Object.fromEntries(p.body.find(n => n.tagName === 'SECTION' && n.attrs['aria-label']).filter(c => ['Needs you', 'Working', 'Done', 'Ended'].includes(c.attrs['aria-label'])).map(c => [c.attrs['aria-label'], c]))
	assert.match(cols['Needs you'].textContent, /Needy/)
	assert.match(cols['Needs you'].textContent, /Run rm -rf build/)
	assert.match(cols['Working'].textContent, /Worker/)
	assert.match(cols['Working'].textContent, /Fix the login bug/)
	assert.match(cols['Working'].textContent, /1\/3/)
	assert.match(cols['Working'].textContent, /ctx 40%/)
	assert.match(cols['Working'].textContent, /1\.5k tok · \$0\.42 est\./)
	assert.match(cols['Working'].textContent, /#12 open ✗ checks/)
	assert.match(cols['Working'].textContent, /⎇ insilode\/w ↑2 ↓1/)
	assert.match(cols['Done'].textContent, /Finisher/)
	assert.doesNotMatch(cols['Ended'].textContent, /Gone/, 'the Ended column is collapsed')
	const head = p.body.byClass('head')[0].textContent
	assert.match(head, /1Needs you/)
	assert.match(head, /1Working/)
	assert.match(head, /5h/)
	assert.match(head, /resets in 1h 0m/)
	assert.match(head, /1\.5k tokens/)
})

test('opening a card from the board or the list switches to the workspace and opens the pane', T, () => {
	const p = boot()
	p.data(rows())
	p.body.button('Board').fire('click')
	assert.equal(p.body.byClass('work')[0].className.includes('hidden'), true)
	p.posted.length = 0
	p.body.byClass('card').find(c => /Worker/.test(c.textContent)).fire('click')
	assert.equal(p.body.byClass('work')[0].className.includes('hidden'), false)
	assert.equal(p.body.byClass('main')[0].className.includes('hidden'), true)
	assert.deepEqual(titles(p), ['Worker'])
	assert.deepEqual(p.all('termAttach'), [{ type: 'termAttach', id: SID(2) }])
	p.body.button('List').fire('click')
	p.body.byClass('lrow').find(c => /Needy/.test(c.textContent)).fire('keydown', { key: 'Enter' })
	assert.deepEqual(titles(p), ['Needy'])
	assert.equal(p.body.button('Workspace').attrs['aria-pressed'], 'true')
})

test('row text never becomes markup', T, () => {
	const p = boot()
	p.data([row({ name: '<img src=x onerror=alert(1)>', prompt: '<b>bold</b>' })])
	p.body.button('Board').fire('click')
	assert.match(p.text(), /<img src=x onerror=alert\(1\)>/)
	openRow(p, '<img src=x onerror=alert(1)>')
	assert.equal(p.body.find(n => n.tagName === 'IMG' || (n.tagName === 'B' && n.textContent === 'bold')).length, 0)
})

test('filters narrow the board, the list view shows a dense row per agent, and ended can be shown', T, () => {
	const p = boot()
	p.data(rows())
	p.body.button('Board').fire('click')
	const search = p.body.byClass('search')[0]
	search.value = 'login'
	search.fire('input')
	assert.doesNotMatch(p.body.byClass('main')[0].textContent, /Needy|Finisher/)
	assert.match(p.body.byClass('main')[0].textContent, /Worker/)
	search.value = ''
	search.fire('input')
	p.body.byClass('main')[0].button('Unread').fire('click')
	assert.match(p.body.byClass('main')[0].textContent, /Finisher/)
	assert.doesNotMatch(p.body.byClass('main')[0].textContent, /Worker/)
	p.body.byClass('main')[0].button('Unread').fire('click')
	p.body.byClass('main')[0].button('Show ended').fire('click')
	assert.match(p.body.byClass('main')[0].textContent, /Gone/)
	p.body.button('List').fire('click')
	assert.equal(p.body.byClass('lrow').length, 4)
	assert.match(p.body.byClass('lhead')[0].textContent, /Agent.*CLI.*State/)
})

test('j and k move through the cards of the board, / focuses the search; none of it in the workspace', T, () => {
	const p = boot()
	p.data(rows())
	p.key('j')
	assert.equal(p.body.byClass('card').length, 0, 'the board is not drawn in the workspace')
	p.body.button('Board').fire('click')
	p.key('j')
	assert.match(Node.focused.textContent, /Needy/)
	p.key('j')
	assert.match(Node.focused.textContent, /Worker/)
	p.key('k')
	assert.match(Node.focused.textContent, /Needy/)
	p.key('/')
	assert.equal(Node.focused.className, 'search')
})

test('kept worktrees get their own section with a Manage button', T, () => {
	const p = boot()
	p.data(rows(), { kept: [{ agent: 'Old agent', branch: 'insilode/old', base: 'main', folder: 'old-wt' }] })
	p.body.button('Board').fire('click')
	assert.match(p.body.byClass('kept')[0].textContent, /Old agent.*insilode\/old.*main.*old-wt/)
	p.posted.length = 0
	p.body.button('Manage…').fire('click')
	assert.deepEqual(p.posted, [{ type: 'kept' }])
	p.data(rows())
	assert.equal(p.body.byClass('kept').length, 0)
})

test('the counters count the other open projects too; a project without sessions is listed with a way to its window', T, () => {
	const p = boot()
	p.data([], { peers: peers().concat([{ key: 'ffffffffffff', name: 'idle-app', rows: [] }]) })
	assert.deepEqual(p.body.byClass('count').map(c => c.textContent), ['1Needs you', '1Working', '0Done'])
	assert.match(p.side().textContent, /idle-app.*No sessions/)
	assert.ok(p.side().byClass('shead').filter(h => /idle-app/.test(h.textContent))[0].button('Open in IDE'))
})

test('the sidebar lists this project first, then open projects, then recent ones, with a dot per session', T, () => {
	const p = boot()
	p.data(rows(), { project: { name: 'my-app' }, peers: peers(), recent: recent() })
	const t = p.side().textContent
	assert.ok(t.indexOf('my-app') < t.indexOf('other-app') && t.indexOf('other-app') < t.indexOf('old-app'))
	assert.match(t, /Needy.*Worker.*Finisher/)
	assert.match(t, /Remote worker.*Editing api\.ts/)
	assert.match(t, /Waiting.*Run rm/)
	assert.doesNotMatch(t, /Gone peer/)
	assert.match(t, /Fix login, Refactor \(closed\)/)
	const dots = p.side().byClass('sdot').map(d => d.className)
	assert.ok(dots.some(c => c.includes('needs')) && dots.some(c => c.includes('working')) && dots.some(c => c.includes('done')))
	p.body.button('Ended').fire('click')
	assert.match(p.side().textContent, /Gone peer/)
})

test('elapsed time ticks locally from the host clock', T, () => {
	const p = boot()
	const t0 = Date.now()
	p.data([row({ id: SID(2), name: 'W', state: 'working', since: t0 - 65_000 })], { now: t0 })
	openRow(p, 'W')
	assert.match(p.panes()[0].byClass('pstate')[0].textContent, /Working · 1m 5s/)
})

test('a data message repaints a pane\'s header only when something it shows changed, so a focused button keeps its focus', T, () => {
	const p = boot()
	const now = Date.now()
	const same = () => rows().map(r => ({ ...r, since: now }))
	p.data(same())
	openRow(p, 'Worker')
	const btn = p.body.labelled('Actions for Worker')
	btn.focus()
	p.data(same())
	assert.equal(p.body.labelled('Actions for Worker'), btn, 'the same header, not a new one')
	assert.equal(Node.focused, btn)
	p.data(same().map(r => r.id === SID(2) ? { ...r, state: 'done', attention: 'done' } : r))
	assert.ok(p.panes()[0].byClass('sdot')[0].className.includes('done'))
	assert.notEqual(p.body.labelled('Actions for Worker'), btn, 'a change to what it shows builds it again')
})

// ---- the sidebar's session search ------------------------------------------------------------------------------------------
const PROJECT = 'a1b2c3d4e5f6'
const SESSION = '0a99a3dd-7db0-4ba0-882d-a4dd922189be'
const SESSION2 = '1a99a3dd-7db0-4ba0-882d-a4dd922189be'
const index = () => ({ type: 'chatIndex', projects: [
	{ key: PROJECT, name: 'app', where: '~/app', cwd: '/work/app', own: true, sessions: [{ id: SESSION, kind: 'claude', title: 'Login work', modified: Date.now() - 60_000 }] },
	{ key: 'ffffffffffff', name: 'other', where: '~/other', cwd: '/work/other', own: false, sessions: [{ id: SESSION2, kind: 'codex', title: 'Other work', modified: Date.now() - 90_000 }] },
] })

// ---- the session search ----------------------------------------------------------------------------------------------------
const searchBox = p => p.body.byClass('sesearch')[0]
const typeInto = (p, text) => { const box = searchBox(p); box.value = text; box.fire('input') }
const searches = p => p.posted.filter(m => m.type === 'chatSearch')
const hitFor = (over = {}) => ({ project: PROJECT, kind: 'claude', session: SESSION, title: 'Login work', modified: Date.now() - 120_000, snippet: '…the cookie domain broke the LOGIN redirect after…', ...over })

test('the search box appears once the host has listed sessions; typing posts one chatSearch after a pause, with "searching…" meanwhile', T, () => {
	const p = boot()
	p.data([])
	assert.equal(searchBox(p).parent.className.includes('hidden'), true, 'no host answer yet: not offered')
	p.send(index())
	assert.equal(searchBox(p).parent.className.includes('hidden'), false)
	p.posted.length = 0
	for (const text of ['lo', 'log', 'login']) { typeInto(p, text) }
	assert.deepEqual(searches(p), [], 'nothing before the pause')
	assert.match(p.body.byClass('side')[0].textContent, /Searching/)
	p.flush()
	assert.deepEqual(searches(p), [{ type: 'chatSearch', query: 'login' }], 'only the last keystroke is searched')
})

test('one character posts nothing and shows the normal list; clearing the box restores it', T, () => {
	const p = boot()
	p.data([])
	p.send(index())
	p.posted.length = 0
	typeInto(p, 'l')
	p.flush()
	assert.deepEqual(searches(p), [])
	assert.match(p.body.byClass('side')[0].textContent, /Login work/)
	typeInto(p, 'login')
	assert.doesNotMatch(p.body.byClass('side')[0].textContent, /On this machine/)
	typeInto(p, '')
	assert.match(p.body.byClass('side')[0].textContent, /On this machine/)
})

test('hits are grouped by project and drawn as text with the match marked; a snippet with markup stays text', T, () => {
	const p = boot()
	p.data([])
	p.send(index())
	typeInto(p, 'login')
	p.flush()
	p.send({ type: 'chatFound', query: 'login', more: true, hits: [hitFor(), hitFor({ session: '1a99a3dd-7db0-4ba0-882d-a4dd922189be', title: 'Evil', snippet: '<img src=x onerror=alert(1)> a login <b>x</b>' })] })
	const side = p.body.byClass('side')[0]
	assert.match(side.textContent, /Login work/)
	assert.match(side.textContent, /the cookie domain broke the LOGIN redirect/)
	assert.match(side.textContent, /<img src=x onerror=alert\(1\)> a login <b>x<\/b>/, 'shown as typed')
	assert.equal(side.find(n => n.tagName === 'IMG' || n.tagName === 'B').length, 0, 'no element came from the snippet')
	const marks = side.find(n => n.tagName === 'MARK')
	assert.deepEqual(marks.map(m => m.textContent), ['LOGIN', 'login'])
	assert.equal(side.byClass('shead').length, 1, 'one project group')
	assert.match(side.textContent, /Showing the newest matches/)
	assert.equal(side.find(n => n.innerHTML && !n.innerHTML.startsWith('<svg')).length, 0, 'innerHTML is only ever the CLI mark, never text of a hit')
})

test('the mark sits on the match after İ, ß and emoji, which a lower-cased copy shifts', T, () => {
	const p = boot()
	p.data([])
	p.send(index())
	typeInto(p, 'login')
	p.flush()
	p.send({ type: 'chatFound', query: 'login', more: false, cut: false, hits: [hitFor({ snippet: 'İİİİİ ß 😀 the LOGIN redirect' })] })
	assert.deepEqual(p.body.byClass('side')[0].find(n => n.tagName === 'MARK').map(m => m.textContent), ['LOGIN'])
})

test('the mark finds a Turkish word whichever of ı, I, i and İ either side spells it with', T, () => {
	for (const [snippet, query, marked] of [['the Iğdır road', 'ığdır', 'Iğdır'], ['the IŞIK road', 'ışık', 'IŞIK'], ['the ışık road', 'IŞIK', 'ışık'], ['the İstanbul road', 'istanbul', 'İstanbul']]) {
		const p = boot()
		p.data([])
		p.send(index())
		typeInto(p, query)
		p.flush()
		p.send({ type: 'chatFound', query, more: false, cut: false, hits: [hitFor({ snippet })] })
		assert.deepEqual(p.body.byClass('side')[0].find(n => n.tagName === 'MARK').map(m => m.textContent), [marked], query)
	}
})

test('an empty answer from a cut-short search does not claim there is no match; hits from one carry a hint', T, () => {
	const p = boot()
	p.data([])
	p.send(index())
	typeInto(p, 'nothing')
	p.flush()
	p.send({ type: 'chatFound', query: 'nothing', more: true, cut: true, hits: [] })
	const side = () => p.body.byClass('side')[0].textContent
	assert.match(side(), /No match in the sessions searched; the search stopped early/)
	assert.doesNotMatch(side(), /No past session mentions/)
	typeInto(p, 'login')
	p.flush()
	p.send({ type: 'chatFound', query: 'login', more: true, cut: true, hits: [hitFor()] })
	assert.match(side(), /The search stopped early/)
	typeInto(p, 'nope')
	p.flush()
	p.send({ type: 'chatFound', query: 'nope', more: false, cut: false, hits: [] })
	assert.match(side(), /No past session mentions "nope"/)
})

test('clicking a hit starts that session again in a pane; an empty answer says so', T, () => {
	const p = boot()
	p.data([])
	p.send(index())
	typeInto(p, 'login')
	p.flush()
	p.send({ type: 'chatFound', query: 'login', more: false, hits: [hitFor({ kind: 'codex' })] })
	p.posted.length = 0
	p.body.byClass('sresult')[0].byClass('crow')[0].fire('click')
	assert.deepEqual({ ...p.posted.pop(), requestId: undefined }, { type: 'termOpen', requestId: undefined, kind: 'codex', sessionId: SESSION })
	typeInto(p, 'nothing')
	p.flush()
	p.send({ type: 'chatFound', query: 'nothing', more: false, hits: [] })
	assert.match(p.body.byClass('side')[0].textContent, /No past session mentions "nothing"/)
})

test('an answer to an earlier query, or to a cleared one, is ignored', T, () => {
	const p = boot()
	p.data([])
	p.send(index())
	typeInto(p, 'login')
	p.flush()
	typeInto(p, 'logout')
	p.flush()
	p.send({ type: 'chatFound', query: 'login', more: false, hits: [hitFor({ title: 'Stale' })] })
	assert.doesNotMatch(p.body.byClass('side')[0].textContent, /Stale/)
	assert.match(p.body.byClass('side')[0].textContent, /Searching/)
	typeInto(p, '')
	p.send({ type: 'chatFound', query: 'logout', more: false, hits: [hitFor({ title: 'Stale' })] })
	assert.doesNotMatch(p.body.byClass('side')[0].textContent, /Stale/)
	assert.match(p.body.byClass('side')[0].textContent, /On this machine/)
})
