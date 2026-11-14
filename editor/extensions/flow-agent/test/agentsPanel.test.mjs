// The Agents page's host side (src/agentsPanel.ts) against a stub `vscode` and a fake webview: the list of earlier sessions and its search,
// the pane layouts the host keeps for the page, and the page's terminals.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const VSCODE = `
class EventEmitter { constructor() { this.l = [] } get event() { return f => { this.l.push(f); return { dispose: () => { this.l = this.l.filter(x => x !== f) } } } } fire(e) { for (const f of [...this.l]) f(e) } dispose() { this.l = [] } }
const none = () => ({ dispose() {} })
module.exports = {
	EventEmitter,
	Disposable: class { constructor(f) { this.f = f } dispose() { this.f?.() } },
	ThemeIcon: class { constructor(id) { this.id = id } },
	ThemeColor: class {},
	ViewColumn: { Active: -1 },
	UIKind: { Desktop: 1, Web: 2 },
	env: { uiKind: 2 },
	ProgressLocation: {},
	workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: none },
	window: { createWebviewPanel: () => globalThis.__panel() },
	commands: { executeCommand: async () => undefined },
}`

let tmp
let AgentsPanel
let LayoutStore
const stubVscode = { name: 'stub-vscode', setup: b => {
	b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }))
	b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE, loader: 'js' }))
} }
/** The panel bundled into `dir`: its code finds out/xterm.js beside itself, the way the extension's does. */
async function bundlePanel(dir) {
	const outfile = join(dir, 'agentsPanel.cjs')
	await build({ entryPoints: [join(ROOT, 'src', 'agentsPanel.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent', external: ['@agentclientprotocol/sdk'], plugins: [stubVscode] })
	return (await import(pathToFileURL(outfile).href).then(m => m.default ?? m)).AgentsPanel
}
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agentspanel-'))
	AgentsPanel = await bundlePanel(tmp)
	const store = join(tmp, 'layoutStore.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'layoutStore.ts')], bundle: true, platform: 'node', format: 'esm', outfile: store, logLevel: 'silent' })
	LayoutStore = (await import(pathToFileURL(store).href)).LayoutStore
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const TT = { timeout: 5000 }
const KEY = 'a1b2c3d4e5f6'
const SID = n => `0a99a3dd-7db0-4ba0-882d-a4dd922189b${n}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** A panel whose page is a list of what the host posted. */
function setup(extra = {}) {
	const listeners = {}
	const posted = []
	const none = () => ({ dispose() {} })
	const view = { html: '', postMessage: async m => { posted.push(JSON.parse(JSON.stringify(m))); return true }, onDidReceiveMessage: f => { listeners.message = f; return none() } }
	globalThis.__panel = () => ({ visible: false, active: true, webview: view, onDidChangeViewState: none, onDidDispose: none, reveal() {}, dispose() {} })
	const agents = { onDidChange: none, sessions: new Map() }
	const panel = new (extra.Panel ?? AgentsPanel)(agents, undefined, undefined, extra.projects, extra.term, extra.layouts)
	panel.open()
	return { panel, posted, view, page: m => listeners.message(m) }
}

test('the list of earlier sessions is sent on ready and on chatList, and the page has no chat to open', TT, async () => {
	const projects = { projects: async () => [{ key: KEY, name: 'app', where: '~/app', cwd: '/work/app', own: true, sessions: [] }] }
	const t = setup({ projects })
	t.page({ type: 'ready' })
	await sleep(10)
	assert.deepEqual(t.posted.filter(m => m.type === 'chatIndex').map(m => m.projects[0].cwd), ['/work/app'])
	t.page({ type: 'chatList' })
	await sleep(10)
	assert.equal(t.posted.filter(m => m.type === 'chatIndex').length, 2)
	t.page({ type: 'chatOpen', project: KEY, kind: 'claude' })
	t.page({ type: 'chatPrompt', chat: 'c', text: 'x' })
	await sleep(10)
	assert.ok(!t.posted.some(m => /^chat(Opened|Events|Failed)$/.test(m.type)))
})

test('a newer chatSearch aborts the older one and only the newer is answered; the answer carries the page\'s own query', TT, async () => {
	const signals = []
	const projects = { search: (query, signal) => new Promise(resolve => { signals.push(signal); setTimeout(() => resolve({ hits: [{ project: KEY, kind: 'claude', session: SID(1), title: query, modified: 1, snippet: 's' }], more: false }), query === 'first' ? 30 : 5) }) }
	const t = setup({ projects })
	t.page({ type: 'chatSearch', query: 'first' })
	t.page({ type: 'chatSearch', query: 'second' })
	t.page({ type: 'chatSearch', query: 'x' })
	await sleep(60)
	assert.deepEqual(signals.map(s => s.aborted), [true, false])
	assert.deepEqual(t.posted.filter(m => m.type === 'chatFound').map(m => [m.query, m.hits[0].title]), [['second', 'second']])
})

// The pane layouts: the host keeps the one on screen (validated) and the named ones, and hands them back.
function memento() {
	const m = new Map()
	return { get: k => m.get(k), update: async (k, v) => { v === undefined ? m.delete(k) : m.set(k, v) }, m }
}
const pane = (id, session) => ({ type: 'pane', id, content: { kind: 'terminal', agent: 'claude', session } })
const two = () => ({ seq: 3, focus: 'p1', root: { type: 'split', id: 's3', dir: 'row', sizes: [0.5, 0.5], children: [pane('p1', 'a'), pane('p2', 'b')] } })

test('the layout on screen is stored as the page saves it and comes back with ready, with the named ones; a named layout is saved and deleted', TT, async () => {
	const ws = memento(), gs = memento()
	const t = setup({ layouts: new LayoutStore(ws, gs) })
	t.page({ type: 'ready' })
	assert.deepEqual(t.posted.filter(m => m.type === 'layouts'), [{ type: 'layouts', saved: [] }], 'nothing remembered yet')
	t.page({ type: 'layoutSave', layout: two() })
	t.page({ type: 'layoutSaveAs', name: ' Review ', layout: two() })
	assert.deepEqual(t.posted.filter(m => m.type === 'layouts').at(-1), { type: 'layouts', saved: [{ name: 'Review', layout: two() }] }, 'the list is sent again, without the current layout')
	const again = setup({ layouts: new LayoutStore(ws, gs) })
	again.page({ type: 'ready' })
	assert.deepEqual(again.posted.find(m => m.type === 'layouts'), { type: 'layouts', current: two(), saved: [{ name: 'Review', layout: two() }] })
	t.page({ type: 'layoutDelete', name: 'Review' })
	assert.deepEqual(t.posted.filter(m => m.type === 'layouts').at(-1), { type: 'layouts', saved: [] })
	// What the page sends wrong never reaches storage.
	t.page({ type: 'layoutSave', layout: { seq: 1, root: { type: 'pane', id: 'bad', content: {} } } })
	t.page({ type: 'layoutSaveAs', name: 'Bad', layout: { seq: 'x' } })
	assert.deepEqual(new LayoutStore(ws, gs).current(), two())
	assert.deepEqual(new LayoutStore(ws, gs).saved(), [])
})

test('the page is built with the terminal when out/xterm.js and out/xterm.css sit beside the host code, and without them when they do not', TT, async () => {
	assert.doesNotMatch(setup().view.html, /insilode:xterm/, 'no files beside the test bundle: a page without terminals')
	assert.match(setup().view.html, /Content-Security-Policy/)
	const dir = join(tmp, 'built')
	mkdirSync(dir)
	writeFileSync(join(dir, 'xterm.js'), 'window.insilodeXterm = {};')
	writeFileSync(join(dir, 'xterm.css'), '.xterm { color: red }')
	const Built = await bundlePanel(dir)
	const html = setup({ Panel: Built }).view.html
	// The nonce is base64: its + and / are not regex characters.
	const nonce = /script-src 'nonce-([^']+)'/.exec(html)[1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
	assert.match(html, new RegExp(`<script nonce="${nonce}">/\\*insilode:xterm\\*/window.insilodeXterm = \\{\\};</script>`))
	assert.match(html, /\.xterm \{ color: red \}/)
	assert.match(html, /default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-[^']+';/)
})

// The page's terminal panes: the bridge (termBridge.ts) is tested on its own; here is how the panel uses it.

/** A panel over a fake terminal host: attach records the sink, so a test can print into the pane. */
function withTerm() {
	const calls = { input: [], resize: [], detach: [], open: [] }
	const sinks = {}
	const term = {
		attach: (id, sink) => id === 'gone' ? undefined : (sinks[id] = sink, { replay: 'replay:' + id, detach: () => calls.detach.push(id) }),
		input: (id, data) => calls.input.push([id, data]),
		resize: (id, cols, rows) => calls.resize.push([id, cols, rows]),
		open: async (kind, sessionId, cwd) => { calls.open.push([kind, sessionId, cwd]); if (cwd === '/nope') throw new Error('not a folder'); return sessionId ?? 'new-session' },
	}
	const none = () => ({ dispose() {} })
	const posted = []
	const listeners = {}
	globalThis.__panel = () => ({
		visible: false, active: true, webview: { html: '', postMessage: async m => { posted.push(JSON.parse(JSON.stringify(m))); return true }, onDidReceiveMessage: f => { listeners.message = f; return none() } },
		onDidChangeViewState: none, onDidDispose: none, reveal() {}, dispose() {},
	})
	const panel = new AgentsPanel({ onDidChange: none, sessions: new Map() }, undefined, undefined, undefined, term)
	panel.open()
	return { posted, calls, sinks, page: m => listeners.message(m), dispose: () => panel.dispose() }
}

test('attach sends the replay as a reset, then live chunks; an unknown session is told it is gone', TT, async () => {
	const t = withTerm()
	t.page({ type: 'termAttach', id: 's1' })
	t.sinks.s1.data('live ')
	t.sinks.s1.data('', true)
	t.page({ type: 'termAttach', id: 'gone' })
	await sleep(10)
	assert.deepEqual(t.posted, [
		{ type: 'termData', id: 's1', data: 'replay:s1', reset: true },
		{ type: 'termData', id: 's1', data: 'live ' },
		{ type: 'termData', id: 's1', data: '', reset: true },
		{ type: 'termGone', id: 'gone' },
	])
})

test('the page may type into and resize only a terminal it attached, and not after it detached', TT, async () => {
	const t = withTerm()
	t.page({ type: 'termInput', id: 's1', data: 'before' })
	t.page({ type: 'termResize', id: 's1', cols: 80, rows: 24 })
	t.page({ type: 'termAttach', id: 's1' })
	t.page({ type: 'termInput', id: 's1', data: 'a' })
	t.page({ type: 'termResize', id: 's1', cols: 100, rows: 30 })
	t.page({ type: 'termInput', id: 's2', data: 'other' })
	t.page({ type: 'termDetach', id: 's1' })
	t.page({ type: 'termInput', id: 's1', data: 'after' })
	t.page({ type: 'termResize', id: 's1', cols: 90, rows: 20 })
	await sleep(10)
	assert.deepEqual(t.calls.input, [['s1', 'a']])
	assert.deepEqual(t.calls.resize, [['s1', 100, 30]])
	assert.deepEqual(t.calls.detach, ['s1'])
	// A message the page got wrong is dropped before it gets here.
	t.page({ type: 'termInput', id: 's1', data: 'x'.repeat(64 * 1024 + 1) })
	t.page({ type: 'termResize', id: 's1', cols: 1, rows: 1 })
	assert.equal(t.calls.input.length, 1)
})

test('attaching again keeps one attachment: the new one is made before the old one leaves', TT, async () => {
	const t = withTerm()
	t.page({ type: 'termAttach', id: 's1' })
	t.page({ type: 'termAttach', id: 's1' })
	assert.deepEqual(t.calls.detach, ['s1'], 'only the first is let go')
	t.page({ type: 'termInput', id: 's1', data: 'a' })
	assert.equal(t.calls.input.length, 1)
})

test('a closed terminal is reported once and forgotten', TT, async () => {
	const t = withTerm()
	t.page({ type: 'termAttach', id: 's1' })
	t.sinks.s1.gone()
	t.page({ type: 'termInput', id: 's1', data: 'late' })
	await sleep(10)
	assert.deepEqual(t.posted.filter(m => m.type === 'termGone'), [{ type: 'termGone', id: 's1' }])
	assert.equal(t.calls.input.length, 0)
})

test('closing the page lets every attachment go', TT, async () => {
	const t = withTerm()
	t.page({ type: 'termAttach', id: 's1' })
	t.page({ type: 'termAttach', id: 's2' })
	t.dispose()
	assert.deepEqual(t.calls.detach.sort(), ['s1', 's2'])
})

test('termOpen answers with the session or the sentence, tagged with the page\'s request id', TT, async () => {
	const t = withTerm()
	t.page({ type: 'termOpen', requestId: 'r1', kind: 'claude', sessionId: SID(1) })
	t.page({ type: 'termOpen', requestId: 'r2', kind: 'codex', cwd: '/nope' })
	t.page({ type: 'termOpen', requestId: 'r3', kind: 'claude' })
	await sleep(20)
	assert.deepEqual(t.calls.open, [['claude', SID(1), undefined], ['codex', undefined, '/nope'], ['claude', undefined, undefined]])
	assert.deepEqual(t.posted.filter(m => m.type === 'termOpened' || m.type === 'termFailed'), [
		{ type: 'termOpened', id: SID(1), requestId: 'r1' },
		{ type: 'termFailed', requestId: 'r2', message: 'not a folder' },
		{ type: 'termOpened', id: 'new-session', requestId: 'r3' },
	])
})

test('without a terminal host the panes answer "gone" and "failed" instead of throwing', TT, async () => {
	const t = setup()
	t.page({ type: 'termAttach', id: 's1' })
	t.page({ type: 'termInput', id: 's1', data: 'x' })
	t.page({ type: 'termOpen', requestId: 'r1', kind: 'claude' })
	await sleep(10)
	assert.deepEqual(t.posted, [{ type: 'termGone', id: 's1' }, { type: 'termFailed', requestId: 'r1', message: 'Terminals are not available.' }])
})

// Sessions that other programs run: the page is told while it is visible, and only when something changed.

/** A panel whose visibility the test drives, and whose 3-second poll the test runs by hand. */
function withLive(projects) {
	const timers = new Set()
	const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval }
	globalThis.setInterval = f => { const t = { f }; timers.add(t); return t }
	globalThis.clearInterval = t => timers.delete(t)
	const posted = []
	const listeners = {}
	const none = () => ({ dispose() {} })
	const win = { visible: true, active: true, webview: { html: '', postMessage: async m => { posted.push(JSON.parse(JSON.stringify(m))); return true }, onDidReceiveMessage: f => { listeners.message = f; return none() } },
		onDidChangeViewState: f => { listeners.view = f; return none() }, onDidDispose: f => { listeners.dispose = f; return none() }, reveal() {}, dispose() {} }
	globalThis.__panel = () => win
	// A visible page also gets the rows: an empty set of agents is enough for that.
	const agents = { onDidChange: none, sessions: new Map(), conflicts: () => [], askSessions: () => [], keptWorktrees: [], latestLimits: undefined }
	const panel = new AgentsPanel(agents, undefined, undefined, projects)
	panel.open()
	return {
		posted, timers, panel, page: m => listeners.message(m),
		show: visible => { win.visible = visible; listeners.view({ webviewPanel: win }) },
		tick: async () => { for (const t of [...timers]) { await t.f() } await sleep(5) },
		indexes: () => posted.filter(m => m.type === 'chatIndex'),
		restore: () => { globalThis.setInterval = real.setInterval; globalThis.clearInterval = real.clearInterval },
	}
}

test('a visible page looks for running sessions every few seconds and is sent the index only when it changed; hidden or closed, it stops', TT, async () => {
	let sig = 'a', name = 'one'
	const projects = { projects: async () => [{ key: KEY, name, where: '~/app', cwd: '/work/app', own: true, sessions: [] }], runningSignature: async () => sig }
	const t = withLive(projects)
	try {
		assert.equal(t.timers.size, 0, 'nothing to look for before the page has said ready')
		t.page({ type: 'ready' })
		await sleep(10)
		assert.equal(t.timers.size, 1)
		assert.equal(t.indexes().length, 1)
		await t.tick()
		assert.equal(t.indexes().length, 1, 'the same machine: nothing sent')
		sig = 'b'
		await t.tick()
		assert.equal(t.indexes().length, 1, 'a change in what runs but the same index: nothing to say')
		name = 'two'
		sig = 'c'
		await t.tick()
		assert.deepEqual(t.indexes().map(m => m.projects[0].name), ['one', 'two'])
		// Every few looks the index is read anyway (the "active recently" estimate ages without a file changing).
		name = 'three'
		for (let i = 0; i < 4; i++) { await t.tick() }
		assert.equal(t.indexes().at(-1).projects[0].name, 'three')
		t.show(false)
		assert.equal(t.timers.size, 0, 'a hidden page is not looked after')
		t.show(true)
		assert.equal(t.timers.size, 1)
		t.panel.dispose()
		assert.equal(t.timers.size, 0)
	} finally {
		t.restore()
	}
})

test('a look that is still running is not started again, and one that fails is tried again next time', TT, async () => {
	let calls = 0, fail = true
	const projects = { projects: async () => [], runningSignature: async () => { calls++; await sleep(30); if (fail) { throw new Error('boom') } return 'x' } }
	const t = withLive(projects)
	try {
		t.page({ type: 'ready' })
		await sleep(10)
		await t.tick()
		await t.tick()
		assert.equal(calls, 1, 'the second look found the first still going')
		await sleep(50)
		fail = false
		await t.tick()
		await sleep(50)
		assert.equal(calls, 2, 'the failed look did not stop the next one')
		await t.tick()
		assert.equal(calls, 3, 'and the one that finished leaves the way free')
	} finally {
		t.restore()
	}
})

test('a tail of an indexed session is read from the transcript the host lists, never from the page; an id it does not list gets a note', TT, async () => {
	const file = join(tmp, 'live-tail.jsonl')
	writeFileSync(file, [
		JSON.stringify({ type: 'user', timestamp: '2026-11-14T10:00:00Z', message: { role: 'user', content: 'Fix the login redirect' } }),
		JSON.stringify({ type: 'assistant', timestamp: '2026-11-14T10:00:05Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'On it.' }] } }),
	].join('\n') + '\n')
	const asked = []
	const projects = { transcriptOf: (kind, id) => { asked.push([kind, id]); return id === SID(1) ? file : undefined } }
	const t = setup({ projects })
	t.page({ type: 'tail', id: SID(1), kind: 'claude' })
	t.page({ type: 'tail', id: SID(2), kind: 'claude' })
	await sleep(30)
	const tails = t.posted.filter(m => m.type === 'tail')
	assert.deepEqual(tails.find(m => m.id === SID(1)).entries.map(e => [e.role, e.text]), [['user', 'Fix the login redirect'], ['assistant', 'On it.']])
	assert.deepEqual(tails.find(m => m.id === SID(2)), { type: 'tail', id: SID(2), entries: [], note: 'This session is not listed any more.' })
	assert.deepEqual(asked, [['claude', SID(1)], ['claude', SID(2)]])
})
