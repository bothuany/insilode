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
	env: { get uiKind() { return globalThis.__uiKind ?? 2 } },
	ProgressLocation: {},
	Uri: { file: p => ({ fsPath: p }) },
	Range: class { constructor(...a) { this.a = a } },
	workspace: { get workspaceFolders() { return globalThis.__folders ?? [] }, getConfiguration: () => ({ get: (k, d) => globalThis.__config?.[k] ?? d }), onDidChangeConfiguration: none },
	window: { createWebviewPanel: (...a) => { (globalThis.__created ??= []).push(a); return globalThis.__panel() }, showTextDocument: (...a) => { (globalThis.__shown ??= []).push(a); return Promise.resolve() } },
	commands: { executeCommand: (...a) => (globalThis.__exec ?? (async () => undefined))(...a) },
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

test('a named save is answered: saved, or refused with a reason, so the page never claims a save the host did not make', TT, async () => {
	const ws = memento(), gs = memento()
	const t = setup({ layouts: new LayoutStore(ws, gs) })
	const answers = () => t.posted.filter(m => m.type === 'layoutSaved')
	t.page({ type: 'layoutSaveAs', name: ' Review ', layout: two() })
	assert.deepEqual(answers(), [{ type: 'layoutSaved', name: 'Review', ok: true }])
	// A layout the host's validation refuses (the page's own rules drifted, or it was tampered with) is answered too, not dropped.
	t.page({ type: 'layoutSaveAs', name: 'Bad', layout: { seq: 1, root: { type: 'pane', id: 'bad', content: {} } } })
	t.page({ type: 'layoutSaveAs', name: 'Empty', layout: { seq: 0 } })
	assert.deepEqual(answers().slice(1), [{ type: 'layoutSaved', name: 'Bad', ok: false, reason: 'invalid' }, { type: 'layoutSaved', name: 'Empty', ok: false, reason: 'invalid' }])
	// The 21st name is refused for the limit.
	for (let i = 0; i < 19; i++) { t.page({ type: 'layoutSaveAs', name: 'L' + i, layout: two() }) }
	t.page({ type: 'layoutSaveAs', name: 'One too many', layout: two() })
	assert.deepEqual(answers().at(-1), { type: 'layoutSaved', name: 'One too many', ok: false, reason: 'limit' })
	assert.equal(new LayoutStore(ws, gs).saved().length, 20)
	// A name that is not one gets no answer to match (the page checks names itself), and nothing is stored.
	const before = answers().length
	t.page({ type: 'layoutSaveAs', name: 5, layout: two() })
	assert.equal(answers().length, before)
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
		pickFolder: async () => { calls.pick = (calls.pick ?? 0) + 1; await sleep(15); return { path: '/picked/app', name: 'app' } },
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

test('a page that says ready again (a reload) starts with nothing attached: what the old page held no longer takes input or a size', TT, async () => {
	const t = withTerm()
	t.page({ type: 'termAttach', id: 's1' })
	t.page({ type: 'termAttach', id: 's2' })
	t.page({ type: 'ready' })
	assert.deepEqual(t.calls.detach.sort(), ['s1', 's2'], 'the old page\'s attachments are let go, so the terminals lose its size override')
	t.page({ type: 'termInput', id: 's1', data: 'stale' })
	t.page({ type: 'termResize', id: 's1', cols: 120, rows: 40 })
	assert.deepEqual([t.calls.input, t.calls.resize], [[], []])
	// The new page attaches what it shows, and only that works again.
	t.page({ type: 'termAttach', id: 's1' })
	t.page({ type: 'termInput', id: 's1', data: 'fresh' })
	t.page({ type: 'termInput', id: 's2', data: 'not re-attached' })
	assert.deepEqual(t.calls.input, [['s1', 'fresh']])
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

// ---- where the page opens ----------------------------------------------------------------------------------------------------

/** A panel stub that records `reveal`, and the stub vscode's window creation and commands; `ui` 1 is the desktop. */
function withOpening({ ui = 1, config = {}, exec }) {
	const revealed = []
	const executed = []
	globalThis.__created = []
	globalThis.__uiKind = ui
	globalThis.__config = config
	globalThis.__exec = async (...a) => { executed.push(a); return exec?.(...a) }
	const none = () => ({ dispose() {} })
	let column
	globalThis.__panel = () => ({
		visible: false, active: true, get viewColumn() { return column }, webview: { html: '', postMessage: async () => true, onDidReceiveMessage: none }, onDidChangeViewState: none, onDidDispose: none,
		reveal: (...a) => revealed.push(a), dispose() {},
	})
	const panel = new AgentsPanel({ onDidChange: none, sessions: new Map() })
	return { panel, revealed, executed, created: () => globalThis.__created, setColumn: c => { column = c },
		done: () => { delete globalThis.__created; delete globalThis.__uiKind; delete globalThis.__config; delete globalThis.__exec } }
}

test('on the desktop the page is made straight in the window core opens for it, once however often it is asked for, and a second ask reveals it where it is', TT, async () => {
	const t = withOpening({ exec: id => id === '_insilode.agents.openWindow' ? 3 : undefined })
	try {
		t.panel.open()
		t.panel.open()
		await sleep(10)
		assert.deepEqual(t.executed, [['_insilode.agents.openWindow']], 'one window')
		assert.equal(t.created().length, 1)
		assert.deepEqual(t.created()[0].slice(0, 3), ['flow.agentsPage', 'Agents', 3], 'in the column of the new window\'s group')
		t.setColumn(3)
		t.panel.open()
		assert.deepEqual(t.revealed, [[]], 'revealed with no column: a column would be an index that goes stale, and core finds the group the page is in')
		assert.equal(t.created().length, 1)
		assert.equal(t.executed.length, 1)
	} finally { t.done() }
})

test('a core without the window command, the tab setting and the web UI show the page as an editor tab; the tab carries the Agents icon', TT, async () => {
	const cases = [
		['a core without the command', () => withOpening({ exec: () => { throw new Error('command \'_insilode.agents.openWindow\' not found') } }), 1],
		['the tab setting', () => withOpening({ config: { location: 'tab' } }), 0],
		['the web UI', () => withOpening({ ui: 2 }), 0],
	]
	for (const [why, make, asked] of cases) {
		const t = make()
		try {
			t.panel.open()
			await sleep(10)
			assert.equal(t.created().length, 1, why)
			assert.equal(t.created()[0][2], -1, why + ': the active group')
			assert.equal(t.executed.length, asked, why)
		} finally { t.done() }
	}
	const t = withOpening({ config: { location: 'tab' } })
	try {
		t.panel.open()
		assert.deepEqual(t.executed, [], 'no window was asked for')
		const icon = t.panel.panel.iconPath
		assert.match(icon.light.fsPath, /media[\\/]agents-light\.svg$/)
		assert.match(icon.dark.fsPath, /media[\\/]agents-dark\.svg$/)
	} finally { t.done() }
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
	const asks = []
	const projects = { projects: async o => { asks.push(o); return [{ key: KEY, name, where: '~/app', cwd: '/work/app', own: true, sessions: [] }] }, runningSignature: async () => sig }
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
		// Only the page's own asks may scan the transcripts; the poll's reads the registry and re-uses the last scan.
		assert.deepEqual(asks.map(o => o?.cached), [false, ...asks.slice(1).map(() => true)])
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

test('a second ask for a tail that is still being read is dropped: one read per session at a time, and it is asked again after it came back', TT, async () => {
	const file = join(tmp, 'pending-tail.jsonl')
	writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } }) + '\n')
	const t = setup({ projects: { transcriptOf: () => file } })
	t.page({ type: 'tail', id: SID(1), kind: 'claude' })
	t.page({ type: 'tail', id: SID(1), kind: 'claude' })
	await sleep(30)
	assert.equal(t.posted.filter(m => m.type === 'tail').length, 1)
	t.page({ type: 'tail', id: SID(1), kind: 'claude' })
	await sleep(30)
	assert.equal(t.posted.filter(m => m.type === 'tail').length, 2)
})

// ---- the Harness panel's host side -----------------------------------------------------------------------------------------
const SUMMARY = (root, over = {}) => ({
	root, score: 90, startupTokens: 0, instructions: [{ name: 'CLAUDE.md', kind: 'instructions', scope: 'project', where: 'CLAUDE.md', file: root + '/CLAUDE.md', detail: '' }], hooks: [], mcp: [], findings: [],
	permissions: { counts: { allow: 0, ask: 0, deny: 0 }, allow: [], ask: [], deny: [] }, skills: { count: 0, items: [] }, agents: { count: 0, items: [] }, commands: { count: 0, items: [] }, counts: { error: 0, warning: 0, info: 0 }, notes: [], ...over,
})

/** A panel over a stubbed harness extension: `asked` is every folder the summary command was called with, `ran` every other command. */
function withHarness({ folders = ['/work/app'], sessions = [], projects, summary } = {}) {
	const asked = []
	const ran = []
	globalThis.__folders = folders.map(f => ({ uri: { fsPath: f }, name: f }))
	globalThis.__shown = []
	globalThis.__exec = async (id, ...args) => {
		if (id === 'flowHarness.summary') {
			asked.push(args[0])
			return summary ? summary(args[0]) : { ok: true, summary: SUMMARY(args[0]) }
		}
		ran.push([id, ...args])
		return undefined
	}
	const none = () => ({ dispose() {} })
	const posted = []
	const listeners = {}
	globalThis.__panel = () => ({ visible: false, active: true, webview: { html: '', postMessage: async m => { posted.push(JSON.parse(JSON.stringify(m))); return true }, onDidReceiveMessage: f => { listeners.message = f; return none() } }, onDidChangeViewState: none, onDidDispose: none, reveal() {}, dispose() {} })
	const agents = { onDidChange: none, sessions: new Map(sessions.map(c => [c, { id: c, cwd: c }])) }
	const panel = new AgentsPanel(agents, undefined, undefined, projects, undefined, undefined)
	panel.open()
	return { posted, asked, ran, page: m => listeners.message(m), shown: () => globalThis.__shown, answers: () => posted.filter(m => m.type === 'harnessData' || m.type === 'harnessFailed'),
		done: () => { delete globalThis.__folders; delete globalThis.__exec; delete globalThis.__shown } }
}

test('the page gets the harness of this window\'s folder, of a folder a session works in and of a project of the index; any other folder is refused without asking the harness extension', TT, async () => {
	const projects = { projects: async () => [{ key: KEY, name: 'other', where: '~/other', cwd: '/work/other', own: false, sessions: [] }] }
	const t = withHarness({ sessions: ['/work/session'], projects })
	try {
		t.page({ type: 'harness' })
		t.page({ type: 'harness', cwd: '/work/app' })
		t.page({ type: 'harness', cwd: '/work/session/' })
		t.page({ type: 'harness', cwd: '/work/other' })
		await sleep(30)
		// The host asks flow-harness for the folder resolved (on Windows that adds a drive to a path written without one), and echoes the page's own cwd.
		const [app, session, other] = ['/work/app', '/work/session', '/work/other'].map(f => resolve(f))
		assert.deepEqual(t.asked, [app, app, session, other])
		assert.deepEqual(t.answers().map(m => [m.type, m.cwd, m.summary?.root]), [['harnessData', undefined, app], ['harnessData', '/work/app', app], ['harnessData', '/work/session/', session], ['harnessData', '/work/other', other]], 'the answer echoes the page\'s own cwd')
		const before = t.asked.length
		for (const cwd of ['/', '/etc', '/work', '/work/app2', '/work/app/../secret', '/work/app/sub', '/Users']) { t.page({ type: 'harness', cwd }) }
		await sleep(30)
		assert.equal(t.asked.length, before, 'nothing was asked for a folder the page was not given')
		const refused = t.answers().slice(4)
		assert.equal(refused.length, 7)
		assert.ok(refused.every(m => m.type === 'harnessFailed' && /not one of the projects/.test(m.message)))
		// What the page sends wrong never gets this far.
		t.page({ type: 'harness', cwd: 'relative/dir' })
		t.page({ type: 'harness', cwd: 5 })
		t.page({ type: 'harness', cwd: 'a\0b' })
		await sleep(10)
		assert.equal(t.answers().length, 11)
	} finally { t.done() }
})

test('a window with no folder says so; a harness extension that is not there is a sentence, not an error', TT, async () => {
	const none = withHarness({ folders: [] })
	try {
		none.page({ type: 'harness' })
		await sleep(10)
		assert.deepEqual(none.answers().map(m => m.message), ['This window has no folder open.'])
	} finally { none.done() }
	const gone = withHarness({ summary: () => { throw new Error('command not found') } })
	try {
		gone.page({ type: 'harness' })
		await sleep(10)
		assert.deepEqual(gone.answers().map(m => [m.type, m.message]), [['harnessFailed', 'The harness extension is not available.']])
	} finally { gone.done() }
	const bad = withHarness({ summary: () => ({ ok: false, message: 'That folder does not exist.' }) })
	try {
		bad.page({ type: 'harness' })
		await sleep(10)
		assert.deepEqual(bad.answers().map(m => m.message), ['That folder does not exist.'])
	} finally { bad.done() }
})

test('a file is opened only if the summary last sent for that folder named it', TT, async () => {
	// The summary names its files after the folder it was asked for, which is the folder resolved: on Windows that has a drive.
	const app = resolve('/work/app')
	const file = app + '/CLAUDE.md'
	const t = withHarness({ folders: ['/work/app', '/work/other'] })
	try {
		t.page({ type: 'harnessOpen', cwd: app, file })
		assert.deepEqual(t.shown(), [], 'nothing was sent yet')
		t.page({ type: 'harness', cwd: app })
		await sleep(10)
		t.page({ type: 'harnessOpen', cwd: app, file, line: 4 })
		t.page({ type: 'harnessOpen', file })
		t.page({ type: 'harnessOpen', cwd: app, file: resolve('/etc/passwd') })
		t.page({ type: 'harnessOpen', cwd: resolve('/work/other'), file })
		t.page({ type: 'harnessOpen', cwd: app, file: app + '/../../etc/passwd' })
		t.page({ type: 'harnessOpen', cwd: app, file: 'CLAUDE.md' })
		await sleep(10)
		assert.deepEqual(t.shown().map(a => [a[0].fsPath, a[1].selection?.a]), [[file, [3, 0, 3, 0]], [file, undefined]], 'the one that was named, with and without its line (cwd left out is this window\'s folder)')
	} finally { t.done() }
})

test('the buttons run the harness extension\'s own views by name; the page never names a command', TT, async () => {
	const t = withHarness()
	try {
		t.page({ type: 'harnessGo', target: 'map' })
		t.page({ type: 'harnessGo', target: 'hook' })
		t.page({ type: 'harnessGo', target: 'workbench.action.quit' })
		t.page({ type: 'harnessGo', command: 'workbench.action.quit' })
		await sleep(10)
		assert.deepEqual(t.ran.map(r => r[0]), ['flowHarness.open', 'flowHarness.addHook'])
	} finally { t.done() }
})

test('the Harness panel\'s state is kept with the layout and comes back with ready; a state that is not sound is not kept', TT, async () => {
	const ws = memento(), gs = memento()
	const t = setup({ layouts: new LayoutStore(ws, gs) })
	t.page({ type: 'ready' })
	assert.deepEqual(t.posted.find(m => m.type === 'layouts'), { type: 'layouts', saved: [] }, 'nothing remembered yet')
	t.page({ type: 'layoutSave', layout: two(), harness: { open: true, width: 400 } })
	t.page({ type: 'layoutSave', layout: two(), harness: { open: 'yes', width: 5 } })
	t.page({ type: 'layoutSave', layout: two(), harness: { open: true, width: 3000 } })
	t.page({ type: 'layoutSave', layout: two(), harness: { open: true, width: 400.5 } })
	const again = setup({ layouts: new LayoutStore(ws, gs) })
	again.page({ type: 'ready' })
	assert.deepEqual(again.posted.find(m => m.type === 'layouts').harness, { open: true, width: 400 })
	// A layout save with no panel state leaves the panel as it was; one with an unsound layout stores neither.
	t.page({ type: 'layoutSave', layout: two() })
	t.page({ type: 'layoutSave', layout: { seq: 'x' }, harness: { open: false, width: 300 } })
	assert.deepEqual(new LayoutStore(ws, gs).harness(), { open: true, width: 400 })
	assert.deepEqual(new LayoutStore(ws, gs).current(), two())
	// What storage holds is validated on the way out too.
	ws.m.set('flow.agents.page.harness', { open: true, width: 'wide' })
	assert.equal(new LayoutStore(ws, gs).harness(), undefined)
})

test('one folder dialog at a time: a second pickFolder while one is open is answered with nothing chosen', TT, async () => {
	const t = withTerm()
	t.page({ type: 'pickFolder', requestId: 'p1' })
	t.page({ type: 'pickFolder', requestId: 'p2' })
	await sleep(40)
	assert.equal(t.calls.pick, 1, 'the host opened one dialog')
	assert.deepEqual(t.posted.filter(m => m.type === 'folderPicked'), [{ type: 'folderPicked', requestId: 'p2' }, { type: 'folderPicked', requestId: 'p1', path: '/picked/app', name: 'app' }])
	t.page({ type: 'pickFolder', requestId: 'p3' })
	await sleep(40)
	assert.equal(t.calls.pick, 2, 'and another one once the first was answered')
	t.dispose()
})
