// The Agents page's host side (src/agentsPanel.ts) against a stub `vscode`, a fake webview and a fake chat host: a burst of chat
// events reaches the page in order, and when two opens are asked in a row the last one wins however long each takes.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
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
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agentspanel-'))
	const outfile = join(tmp, 'agentsPanel.cjs')
	await build({
		entryPoints: [join(ROOT, 'src', 'agentsPanel.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent', external: ['@agentclientprotocol/sdk'],
		plugins: [{ name: 'stub-vscode', setup: b => {
			b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }))
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE, loader: 'js' }))
		} }],
	})
	AgentsPanel = (await import(pathToFileURL(outfile).href).then(m => m.default ?? m)).AgentsPanel
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const KEY = 'a1b2c3d4e5f6'
const SID = n => `0a99a3dd-7db0-4ba0-882d-a4dd922189b${n}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** A panel whose page is a list of what the host posted, and a chat host the test controls. */
function setup() {
	const listeners = {}
	const posted = []
	const none = () => ({ dispose() {} })
	globalThis.__panel = () => ({
		visible: false, active: true, webview: { html: '', postMessage: async m => { posted.push(JSON.parse(JSON.stringify(m))); return true }, onDidReceiveMessage: f => { listeners.message = f; return none() } },
		onDidChangeViewState: none, onDidDispose: none, reveal() {}, dispose() {},
	})
	const chatListeners = []
	const chats = {
		onEvent: f => { chatListeners.push(f); return none() },
		projects: async () => [],
		opens: {},
		open(project, kind, session) { return this.opens[session ?? ''] },
		get: id => ({ id, events: [], busy: false }),
		opened: chat => ({ opened: { type: 'chatOpened', chat: chat.id, project: KEY, kind: 'claude', title: 't', busy: false, config: [] }, events: chat.events }),
	}
	const agents = { onDidChange: none, sessions: new Map() }
	const panel = new AgentsPanel(agents, undefined, undefined, chats)
	panel.open()
	return { panel, posted, chats, page: m => listeners.message(m), fire: (chat, event) => chatListeners.forEach(f => f({ chat, event })) }
}

test('a burst of chat events goes out as batches in the order it came in, and only for the open chat', async () => {
	const t = setup()
	t.chats.opens[''] = { id: 'claude:one', events: [] }
	t.page({ type: 'chatOpen', project: KEY, kind: 'claude' })
	await sleep(10)
	t.posted.length = 0
	t.fire('claude:one', { t: 'text', text: 'a' })
	t.fire('claude:one', { t: 'tool', id: 't1', title: 'Read' })
	t.fire('claude:one', { t: 'text', text: 'b' })
	t.fire('claude:other', { t: 'text', text: 'LEAK' })
	t.fire('claude:one', { t: 'tool', id: 't1', status: 'completed' })
	t.fire('claude:one', { t: 'user', text: 'u1' })
	t.fire('claude:one', { t: 'user', text: 'u2' })
	t.fire('claude:one', { t: 'stop', reason: 'end_turn' })
	await sleep(80)
	t.fire('claude:one', { t: 'text', text: 'c' })
	await sleep(80)
	const events = t.posted.filter(m => m.type === 'chatEvents').flatMap(m => m.events)
	assert.deepEqual(events.map(e => e.t === 'tool' ? 'tool:' + e.id : e.t + ':' + (e.text ?? e.reason)), ['text:a', 'tool:t1', 'text:b', 'user:u1', 'user:u2', 'stop:end_turn', 'text:c'])
	assert.equal(events[1].status, 'completed', 'the later tool event filled in the same card')
	assert.ok(!JSON.stringify(t.posted).includes('LEAK'))
	assert.ok(t.posted.filter(m => m.type === 'chatEvents').length <= 2, 'one batch per burst')
})

test('two opens in a row: the last one wins, the older one is never shown, even when it finishes later', async () => {
	const t = setup()
	let finishFirst
	t.chats.opens[SID(1)] = new Promise(r => { finishFirst = () => r({ id: 'claude:first', events: [] }) })
	t.chats.opens[SID(2)] = Promise.resolve({ id: 'claude:second', events: [] })
	t.page({ type: 'chatOpen', project: KEY, kind: 'claude', session: SID(1) })
	t.page({ type: 'chatOpen', project: KEY, kind: 'claude', session: SID(2) })
	await sleep(10)
	finishFirst()
	await sleep(10)
	assert.deepEqual(t.posted.filter(m => m.type === 'chatOpened').map(m => m.chat), ['claude:second'])
	// A late failure of the older open is not shown either.
	t.chats.opens[SID(3)] = new Promise((_, rej) => setTimeout(() => rej(new Error('too late')), 20))
	t.page({ type: 'chatOpen', project: KEY, kind: 'claude', session: SID(3) })
	t.chats.opens[SID(4)] = Promise.resolve({ id: 'claude:fourth', events: [] })
	t.page({ type: 'chatOpen', project: KEY, kind: 'claude', session: SID(4) })
	await sleep(50)
	assert.deepEqual(t.posted.filter(m => m.type === 'chatFailed'), [])
	assert.equal(t.posted.filter(m => m.type === 'chatOpened').at(-1).chat, 'claude:fourth')
})

test('a newer chatSearch aborts the older one and only the newer is answered; the answer carries the page\'s own query', async () => {
	const t = setup()
	const signals = []
	t.chats.search = (query, signal) => new Promise(resolve => { signals.push(signal); setTimeout(() => resolve({ hits: [{ project: KEY, kind: 'claude', session: SID(1), title: query, modified: 1, snippet: 's' }], more: false }), query === 'first' ? 30 : 5) })
	t.page({ type: 'chatSearch', query: 'first' })
	t.page({ type: 'chatSearch', query: 'second' })
	t.page({ type: 'chatSearch', query: 'x' })
	await sleep(60)
	assert.deepEqual(signals.map(s => s.aborted), [true, false])
	assert.deepEqual(t.posted.filter(m => m.type === 'chatFound').map(m => [m.query, m.hits[0].title]), [['second', 'second']])
})

// The page's terminal panes: the bridge (termBridge.ts) is tested on its own; here is how the panel uses it.
const TT = { timeout: 5000 }

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
