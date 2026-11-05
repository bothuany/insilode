// draw_board, update_board and read_board on a canvas board, end to end through AgentTools with a small stand-in for `vscode`:
// what the answer says (dropped elements, lint, boxes, the picture or the host's own SVG), how a patch is merged, that the code
// widget reads a workspace file and nothing outside it, and that read_board returns what the user moved or noted.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { cleanup, temp } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let tools, store, work
const state = { dark: true }

before(async () => {
	work = temp('insilode-canvas-tools-')
	mkdirSync(join(work, 'src'))
	writeFileSync(join(work, 'src', 'a.cs'), 'class A\n{\n    void Run() { }\n}\n')
	const out = temp('flow-canvas-tools-')
	const stub = join(out, 'vscode.cjs')
	writeFileSync(stub, `module.exports = {
		workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: ${JSON.stringify(work)} } }] },
		window: { get activeColorTheme() { return { kind: globalThis.__canvasDark === false ? 1 : 2 } } },
		ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
		Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
	}`)
	await build({ stdin: { contents: "export { AgentTools } from './src/mcp/handlers.ts'; export { BoardStore } from './src/board/store.ts'", resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'mod.mjs'), logLevel: 'silent', alias: { vscode: stub }, external: ['bufferutil', 'utf-8-validate'] })
	const mod = await import(pathToFileURL(join(out, 'mod.mjs')).href)
	tools = mod
	store = mod
	globalThis.__canvasDark = true
})
after(cleanup)

/** A tools object over a store whose host records what it was asked and answers with the given picture. */
function setup(png) {
	const boards = new store.BoardStore()
	const asked = []
	const kept = {}
	boards.setHost({
		show: () => { }, update: () => { },
		image: async (id, ms, step) => { asked.push({ id, ms, step }); return typeof png === 'function' ? png() : png },
		overrides: id => kept[id] ?? {},
	})
	const t = new tools.AgentTools({ boards, skeleton: undefined, log: { warn() { } } })
	return { t, boards, asked, kept }
}

const board = () => ({
	kind: 'canvas', title: 'Order flow', purpose: 'code',
	elements: [
		{ id: 'api', type: 'rect', label: 'POST /orders', icon: 'api', link: { file: 'src/a.cs', line: 3 } },
		{ id: 'svc', type: 'rect', label: 'OrderService', origin: 'source' },
		{ id: 'src', type: 'code', code: { file: 'src/a.cs', lines: [2, 3] } },
		{ id: 'e', type: 'arrow', label: 'places', arrow: { from: 'api', to: 'svc', data: { type: 'Order' } } },
	],
	steps: [{ title: 'Entry', caption: 'It starts here', show: ['api'] }, { title: 'All', caption: 'Both', lit: ['svc'] }],
})

const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n')

test('draw_board canvas: the answer lists the elements, the lint, the boxes and the picture the tab sent', async () => {
	const { t, asked } = setup('iVBORw0KGgo=')
	const r = await t.call('draw_board', { id: 'orders', board: board() })
	assert.ok(!r.isError, textOf(r))
	const text = textOf(r)
	assert.match(text, /Board "orders" drawn and shown to the user in Insilode: canvas \(code\), 4 elements \(2 rect, 1 code, 1 arrow\), 2 steps\./)
	assert.match(text, /Boxes after layout/)
	const boxes = JSON.parse(/Boxes after layout[^:]*: (\{.*\})/.exec(text)[1])
	assert.deepEqual(Object.keys(boxes).sort(), ['api', 'src', 'svc'], 'an arrow is not a box')
	assert.ok(boxes.api.w >= 160 && boxes.src.h > 0)
	assert.match(text, /The picture below is the board as Insilode shows it now\./)
	assert.deepEqual(r.content.at(-1), { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })
	assert.deepEqual(asked, [{ id: 'orders', ms: 10000, step: undefined }])
})

test('draw_board canvas: the code widget read the workspace file; the answer says what it dropped or could not read', async () => {
	const { t, boards } = setup('x')
	const raw = board()
	raw.elements.push({ id: 'bad', type: 'matrix', matrix: { cells: [[1, 2], [3]] } }, { id: 'out', type: 'code', code: { file: '../outside.txt', lines: [1, 2] } }, { id: 'e2', type: 'arrow', arrow: { from: 'api', to: 'ghost' } })
	const r = await t.call('draw_board', { id: 'orders', board: raw })
	const text = textOf(r)
	assert.match(text, /dropped: element `bad`: the matrix rows have different lengths/)
	assert.match(text, /dropped: element `e2`: `ghost` is not an element id/)
	assert.match(text, /`out`: file "..\/outside.txt" is outside the workspace/)
	assert.match(text, /LINT \(/)
	const stored = boards.get('orders').spec
	assert.equal(stored.elements.find(e => e.id === 'src').code.text, '{\n    void Run() { }', 'lines 2 to 3 of the file')
	assert.equal(stored.elements.find(e => e.id === 'api').link.file.endsWith('a.cs'), true, 'the link is the real path inside the workspace')
	assert.ok(!stored.elements.some(e => e.id === 'bad'))
})

test('draw_board canvas: image false skips the picture, {step} asks for that step, and a tab that does not answer gets the host SVG', async () => {
	let one = setup('p')
	let r = await one.t.call('draw_board', { board: board(), image: false })
	assert.ok(!r.content.some(c => c.type === 'image'))
	assert.deepEqual(one.asked, [])
	assert.doesNotMatch(textOf(r), /The picture below/)
	one = setup('p')
	r = await one.t.call('draw_board', { id: 's', board: board(), image: { step: 2 } })
	assert.deepEqual(one.asked, [{ id: 's', ms: 10000, step: 1 }], 'steps are numbered from 1 in the tool, from 0 in the host')
	assert.match(textOf(r), /The picture below is the board at step 2/)
	r = await one.t.call('draw_board', { id: 's', board: board(), image: { step: 9 } })
	assert.match(textOf(r), /image\.step 9 is not a step of this board \(1 to 2\)/)
	const none = setup(undefined)
	r = await none.t.call('draw_board', { board: board() })
	assert.ok(!r.content.some(c => c.type === 'image'))
	assert.match(textOf(r), /No picture: the board tab did not answer in time[\s\S]*<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[\s\S]*OrderService/)
	assert.match(textOf(r), /#181818/, 'a dark theme draws the dark palette')
	globalThis.__canvasDark = false
	r = await setup(undefined).t.call('draw_board', { board: board() })
	globalThis.__canvasDark = true
	assert.match(textOf(r), /fill="#ffffff"/)
})

test('draw_board canvas: Mermaid source and an unknown kind are refused or left to the other kinds', async () => {
	const { t } = setup('x')
	const r = await t.call('draw_board', { board: board(), source: { mermaid: 'graph TD; a-->b' } })
	assert.ok(r.isError)
	assert.match(textOf(r), /`source` \(Mermaid\) is for the other board kinds/)
	const flow = await t.call('draw_board', { board: { kind: 'flow', title: 'F', nodes: [{ id: 'a', label: 'A' }] }, image: false })
	assert.ok(!flow.isError)
	assert.match(textOf(flow), /flow, 1 nodes/)
})

test('update_board canvas: patches merge, remove with their arrows, add, and the board is drawn again', async () => {
	const { t, boards, asked } = setup('p')
	await t.call('draw_board', { id: 'orders', board: board(), image: false })
	const r = await t.call('update_board', { id: 'orders', elements: [{ id: 'svc', label: 'OrderService.Place', style: { fill: 'amber' } }, { id: 'src', remove: true }, { id: 'note', type: 'text', label: 'Retries twice' }] })
	assert.ok(!r.isError, textOf(r))
	const text = textOf(r)
	assert.match(text, /Board "orders" updated and shown/)
	assert.match(text, /Changes: changed `svc` \(label, style\); removed `src`; added `note`\./)
	assert.deepEqual(asked.map(a => a.id), ['orders'], 'the picture is asked again')
	const els = boards.get('orders').spec.elements
	assert.equal(els.find(e => e.id === 'svc').label, 'OrderService.Place')
	assert.equal(els.find(e => e.id === 'svc').style.fill, 'amber')
	assert.ok(!els.some(e => e.id === 'src') && els.some(e => e.id === 'note'))
	assert.equal(boards.get('orders').spec.steps.length, 2, 'steps are kept')
	assert.ok(boards.get('orders').previous, 'the previous draw is kept, as for every redraw')
	// removing a shape takes its arrows with it
	const gone = await t.call('update_board', { id: 'orders', elements: [{ id: 'api', remove: true }] })
	assert.match(textOf(gone), /removed arrow `e` \(an end was removed\)/)
	// problems
	assert.match(textOf(await t.call('update_board', { id: 'nope', elements: [{ id: 'a' }] })), /No board "nope"/)
	assert.match(textOf(await t.call('update_board', { id: 'orders', elements: [] })), /`elements` is empty/)
	assert.match(textOf(await t.call('update_board', { id: 'orders', elements: [{ label: 'no id' }] })), /Each element patch is an object with an `id`/)
	const flow = await t.call('draw_board', { id: 'f', board: { kind: 'flow', title: 'F', nodes: [{ id: 'a', label: 'A' }] }, image: false })
	assert.ok(!flow.isError)
	assert.match(textOf(await t.call('update_board', { id: 'f', elements: [{ id: 'a' }] })), /is a flow board: `elements` patches are for canvas boards/)
})

test('read_board: the spec, the boxes with the user\'s moves, and what they moved and noted', async () => {
	const { t, kept } = setup('p')
	await t.call('draw_board', { id: 'orders', board: board(), image: false })
	const plain = JSON.parse(textOf(await t.call('read_board', { id: 'orders' })))
	assert.equal(plain.id, 'orders')
	assert.equal(plain.spec.kind, 'canvas')
	assert.equal(plain.spec.elements.length, 4)
	assert.equal(plain.spec.nodes, undefined, 'a canvas board has no nodes to read')
	assert.deepEqual(plain.overrides, { moves: {}, notes: {} })
	const before = plain.boxes.svc
	const hash = (await import('node:crypto')).createHash('sha1').update('x').digest('hex') // a move with a hash that does not match is stale
	kept.orders = { moves: { svc: { x: 700, y: 20, hash } }, notes: { api: 'rename to PlaceOrder' } }
	const after = JSON.parse(textOf(await t.call('read_board', { id: 'orders' })))
	assert.deepEqual(after.overrides.notes, { api: 'rename to PlaceOrder' })
	assert.deepEqual(after.overrides.moves.svc, { x: 700, y: 20, hash })
	assert.deepEqual(after.boxes.svc, before, 'a move whose frame input changed is not applied')
	assert.match(textOf(await t.call('read_board', { id: 'missing' })), /No board "missing"/)
	assert.match(textOf(await t.call('read_board', {})), /`id` is required/)
	const flow = await t.call('draw_board', { id: 'f', board: { kind: 'flow', title: 'F', nodes: [{ id: 'a', label: 'A' }] }, image: false })
	assert.ok(!flow.isError)
	const f = JSON.parse(textOf(await t.call('read_board', { id: 'f' })))
	assert.equal(f.spec.nodes.length, 1)
	assert.equal(f.boxes, undefined)
})
