// The Agents dock is one page built from strings in src/dockPage.ts; a quote lost in that string breaks the whole dock
// without a word. This builds the page and checks that its script parses and draws a row.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let html
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-dock-'))
	// The page lives in dockPage.ts, which has no `vscode` (the website renders it too): bundling it without a stub is the test that it stays so.
	const outfile = join(tmp, 'dockPage.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'dockPage.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	const { dockHtml } = await import(pathToFileURL(outfile).href)
	html = dockHtml()
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('the dock page script parses and draws an agent row with its avatar', () => {
	const script = /<script>([\s\S]*)<\/script>/.exec(html)[1]
	assert.doesNotThrow(() => new vm.Script(script), 'the dock script is valid JavaScript')
	const list = { innerHTML: '', querySelectorAll: () => [] }
	const document = { getElementById: () => list, querySelectorAll: () => [] }
	let onMessage
	const window = { addEventListener: (_type, f) => { onMessage = f } }
	const context = { window, document, acquireVsCodeApi: () => ({ postMessage() { } }), setInterval() { }, Math, Object, isFinite, Date, String, Number, Map }
	window.window = window
	vm.runInNewContext(script, context)
	const row = { id: 'a1', cli: 'claude', name: 'Claude 2', state: 'blocked', attention: 'approval', since: Date.now(), todos: [], unread: false, done: 0 }
	onMessage({ data: { type: 'data', list: [row], now: Date.now(), avatar: 'pixel' } })
	assert.match(list.innerHTML, /class="agent blocked approval"/)
	assert.match(list.innerHTML, /<span class="av" data-k="[^"]+"><svg class="ax"/)
	assert.match(list.innerHTML, /Claude 2/)
})

test('the turn-impact line names a changed table and how many endpoints use it, with or without flows', () => {
	const script = /<script>([\s\S]*)<\/script>/.exec(html)[1]
	const list = { innerHTML: '', querySelectorAll: () => [] }
	const document = { getElementById: () => list, querySelectorAll: () => [] }
	let onMessage
	const window = { addEventListener: (_type, f) => { onMessage = f } }
	window.window = window
	vm.runInNewContext(script, { window, document, acquireVsCodeApi: () => ({ postMessage() { } }), setInterval() { }, Math, Object, isFinite, Date, String, Number, Map })
	const draw = impact => {
		onMessage({ data: { type: 'data', list: [{ id: 'a1', cli: 'claude', name: 'Claude', state: 'done', attention: 'none', since: Date.now(), todos: [], unread: false, done: 0, impact }], now: Date.now(), avatar: 'pixel' } })
		return list.innerHTML
	}
	const both = draw({ files: 2, more: 0, flows: [{ label: 'GET /orders' }], tables: [{ table: 'orders', entity: 'Order', endpoints: 4 }] })
	assert.match(both, /This turn touched 1 flow and table orders \(4 endpoints\):/)
	assert.match(both, /data-flow="0"[^>]*>GET \/orders</)
	const only = draw({ files: 1, more: 0, flows: [], tables: [{ table: 'invoices', entity: 'Invoice', endpoints: 1, guess: true, partial: true }] })
	assert.match(only, /This turn touched table invoices\? \(1 endpoint, partial\)<\/b>/)
	assert.doesNotMatch(draw({ files: 1, more: 0, flows: [], tables: [] }), /class="impact"/)
})

test('a changed migration is named in the turn-impact line', () => {
	const script = /<script>([\s\S]*)<\/script>/.exec(html)[1]
	const list = { innerHTML: '', querySelectorAll: () => [] }
	const document = { getElementById: () => list, querySelectorAll: () => [] }
	let onMessage
	const window = { addEventListener: (_type, f) => { onMessage = f } }
	window.window = window
	vm.runInNewContext(script, { window, document, acquireVsCodeApi: () => ({ postMessage() { } }), setInterval() { }, Math, Object, isFinite, Date, String, Number, Map })
	onMessage({ data: { type: 'data', list: [{ id: 'a1', cli: 'claude', name: 'Claude', state: 'done', attention: 'none', since: Date.now(), todos: [], unread: false, done: 0, impact: { files: 1, more: 0, flows: [], tables: [{ table: 'orders', entity: 'Order', migration: '0007_orders_key', endpoints: 4 }] } }], now: Date.now(), avatar: 'pixel' } })
	assert.match(list.innerHTML, /This turn touched table orders \(migration 0007_orders_key, 4 endpoints\)<\/b>/)
})

test('the ⇄ on a Claude or Codex row between turns names the other CLI; none mid-turn or on another agent', () => {
	const script = /<script>([\s\S]*)<\/script>/.exec(html)[1]
	const list = { innerHTML: '', querySelectorAll: () => [] }
	const document = { getElementById: () => list, querySelectorAll: () => [] }
	let onMessage
	const window = { addEventListener: (_type, f) => { onMessage = f } }
	window.window = window
	vm.runInNewContext(script, { window, document, acquireVsCodeApi: () => ({ postMessage() { } }), setInterval() { }, Math, Object, isFinite, Date, String, Number, Map })
	const draw = (cli, state) => {
		onMessage({ data: { type: 'data', list: [{ id: 'a1', cli, name: 'A', state, since: Date.now(), todos: [], unread: false, done: 0 }], now: Date.now(), avatar: 'pixel' } })
		return list.innerHTML
	}
	assert.match(draw('claude', 'idle'), /data-swap="a1" title="Continue in Codex with this conversation"/)
	assert.match(draw('codex', 'ended'), /data-swap="a1" title="Continue in Claude with this conversation"/)
	assert.match(draw('claude', 'done'), /data-swap="a1"/)
	for (const state of ['working', 'blocked', 'starting']) {
		assert.doesNotMatch(draw('claude', state), /data-swap/, state)
	}
	assert.doesNotMatch(draw('custom', 'idle'), /data-swap/)
})
