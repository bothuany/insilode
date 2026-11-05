// The board panel's side of the canvas board's trust boundary: what the page posts (`move`, `note`, `resetMoves`) is checked
// against the board the tab shows before anything is stored. A stand-in for `vscode` gives the panel a webview whose messages
// the test sends; nothing is opened.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { cleanup, temp } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let BoardPanel, parseCanvasBoard

before(async () => {
	const out = temp('flow-canvas-panel-')
	const stub = join(out, 'vscode.cjs')
	writeFileSync(stub, `
		class EventEmitter { constructor() { this.l = [] } get event() { return f => { this.l.push(f); return { dispose() {} } } } fire(v) { for (const f of this.l) f(v) } dispose() {} }
		const panels = []
		module.exports = {
			EventEmitter,
			ViewColumn: { Active: -1, One: 1 },
			ThemeIcon: class { constructor(id) { this.id = id } },
			ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
			window: {
				activeColorTheme: { kind: 2 },
				createWebviewPanel: () => {
					const p = { title: '', visible: true, active: true, webview: { html: '', cspSource: 'vscode-resource:', posted: [], postMessage(m) { this.posted.push(m); return Promise.resolve(true) }, onDidReceiveMessage(f) { p.send = f; return { dispose() {} } } }, reveal() {}, dispose() {}, onDidDispose() { return { dispose() {} } }, onDidChangeViewState() { return { dispose() {} } } }
					panels.push(p)
					return p
				},
				showWarningMessage() {}, showErrorMessage() {}, showInformationMessage() {},
			},
			workspace: { workspaceFolders: [] },
			Uri: { file: p => ({ fsPath: p }) },
			__panels: panels,
		}`)
	await build({ stdin: { contents: "export { BoardPanel } from './src/boardPanel.ts'; export { parseCanvasBoard } from './src/board/canvas.ts'", resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'mod.mjs'), logLevel: 'silent', alias: { vscode: stub }, external: ['bufferutil', 'utf-8-validate'] })
	const mod = await import(pathToFileURL(join(out, 'mod.mjs')).href)
	BoardPanel = mod.BoardPanel
	parseCanvasBoard = mod.parseCanvasBoard
})
after(cleanup)

const memento = () => {
	const m = new Map()
	return { get: k => m.get(k), update: (k, v) => void m.set(k, v) }
}

/** A panel showing one canvas board (`board:b`), with the function the webview's messages reach it through. */
async function shown() {
	const bp = new BoardPanel({ extensionPath: ROOT, workspaceState: memento() })
	const { spec } = parseCanvasBoard({ kind: 'canvas', title: 'T', elements: [
		{ id: 'f', type: 'frame', label: 'F' },
		{ id: 'a', type: 'rect', label: 'A', frame: 'f' },
		{ id: 'b', type: 'rect', label: 'B' },
	] })
	await bp.asHost().show('b', spec)
	const tab = bp.tabs.get('board:b')
	const send = m => bp.onMessage(tab, m)
	return { bp, send, overrides: () => bp.asHost().overrides('b') }
}

test('canvas panel: a move is stored only for an element of the board, with the host\'s own hash and a place on the drawing', async () => {
	const { send, overrides } = await shown()
	await send({ type: 'move', id: 'a', x: 40.6, y: 12, hash: 'from-the-page' })
	const a = overrides().moves.a
	assert.equal(a.x, 41)
	assert.equal(a.y, 12)
	assert.notEqual(a.hash, 'from-the-page', 'the page never chooses the hash')
	await send({ type: 'move', id: 'nope', x: 1, y: 1 })
	await send({ type: 'move', id: 'b', x: Infinity, y: 1 })
	await send({ type: 'move', id: 'b', x: '5', y: 1 })
	await send({ type: 'move', id: 'b', x: 1e9, y: 1 })
	await send({ type: 'move', id: { toString: () => 'b' }, x: 1, y: 1 })
	assert.deepEqual(Object.keys(overrides().moves), ['a'])
})

test('canvas panel: a note is text on an element of the board, cut to its limit; an empty note removes it', async () => {
	const { send, overrides } = await shown()
	await send({ type: 'note', id: 'b', text: `  ${'x'.repeat(900)}  ` })
	assert.equal(overrides().notes.b.length, 600)
	await send({ type: 'note', id: 'ghost', text: 'not on the board' })
	await send({ type: 'note', id: 'a', text: { evil: true } })
	assert.deepEqual(Object.keys(overrides().notes), ['b'])
	await send({ type: 'note', id: 'b', text: '   ' })
	assert.deepEqual(overrides().notes ?? {}, {})
})

test('canvas panel: reset positions drops the moves and keeps the notes; other boards are untouched', async () => {
	const { bp, send, overrides } = await shown()
	await send({ type: 'move', id: 'b', x: 10, y: 10 })
	await send({ type: 'note', id: 'b', text: 'keep me' })
	await send({ type: 'resetMoves' })
	assert.equal(overrides().moves, undefined)
	assert.deepEqual(overrides().notes, { b: 'keep me' })
	// A board of another kind never takes canvas messages.
	await bp.asHost().show('flow', { version: 1, kind: 'flow', title: 'F', nodes: [{ id: 'b', label: 'B' }], edges: [] })
	await bp.onMessage(bp.tabs.get('board:flow'), { type: 'note', id: 'b', text: 'no' })
	assert.deepEqual(bp.asHost().overrides('flow'), {})
})
