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
