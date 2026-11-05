// The host's side of the canvas board kind: what an agent sends is parsed with its steps' scenes, patched by update_board,
// grounded (code widgets read their lines), rendered with the shared engine, and the user's moves and notes are kept per
// board. Also: the schema the agent sees lists every element type and the two copies of spec.ts agree.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let canvas, overrides, store, tools, prompts, parse
before(async () => {
	canvas = await load('src/board/canvas.ts')
	overrides = await load('src/board/overrides.ts')
	store = await load('src/board/store.ts')
	tools = await load('src/mcp/tools.ts')
	prompts = await load('src/mcp/prompts.ts')
	parse = await load('../../../board-canvas/parse.ts')
})
after(cleanup)

const base = () => ({
	kind: 'canvas', title: 'T', purpose: 'concept',
	elements: [
		{ id: 'in', type: 'rect', label: 'In' },
		{ id: 'box', type: 'frame', label: 'Box', frameData: { collapsed: true } },
		{ id: 'a', type: 'rect', frame: 'box', label: 'A' },
		{ id: 'out', type: 'rect', label: 'Out' },
		{ id: 'e1', type: 'arrow', arrow: { from: 'in', to: 'box' } },
		{ id: 'e2', type: 'arrow', arrow: { from: 'box', to: 'out' } },
	],
})

test('canvas board: a spec carries elements, empty nodes and edges, and steps with scenes', () => {
	const raw = { ...base(), steps: [{ title: 'One', caption: 'first', show: ['in'] }, { title: 'Two', caption: 'second', show: ['in', 'box', 'e1'], open: ['box'], lit: ['in', 'ghost'] }, { title: 'Three', caption: 'x', nodes: ['in'], open: ['in'] }, { caption: '' }] }
	const { spec, errors, notes } = canvas.parseCanvasBoard(raw)
	assert.equal(spec.kind, 'canvas')
	assert.deepEqual([spec.nodes, spec.edges], [[], []])
	assert.equal(spec.elements.length, 6)
	assert.deepEqual(errors, [])
	assert.deepEqual(spec.steps.map(s => s.title), ['One', 'Two', 'Three'], 'a step with neither title nor caption is dropped')
	assert.deepEqual(spec.steps[0].show, ['in'])
	assert.deepEqual(spec.steps[1].open, ['box'])
	assert.deepEqual(spec.steps[1].lit, ['in'], 'an unknown id is left out')
	assert.equal(spec.steps[2].show, undefined, 'no `show`: everything')
	assert.equal(spec.steps[2].open, undefined, 'a node is not a frame')
	const text = notes.join('\n')
	assert.match(text, /step #2: `lit` names `ghost`/)
	assert.match(text, /step #3: this is a canvas board.*`show`, `open` and `lit`/)
	assert.match(text, /step #3: `open` names `in`, which is not a frame/)
	assert.match(text, /step #4 was dropped/)
	assert.match(canvas.parseCanvasBoard({ ...base(), nodes: [{ id: 'x' }] }).notes.join('\n'), /`nodes` and `edges` were ignored/)
	assert.ok(canvas.isCanvasInput(raw) && !canvas.isCanvasInput({ kind: 'flow' }) && !canvas.isCanvasInput('x'))
	assert.throws(() => canvas.parseCanvasBoard({ kind: 'canvas', title: 'T' }), /non-empty "elements"/)
})

test('canvas board: a step becomes a scene; the picture of a step and the boxes come from the same engine', () => {
	const { spec } = canvas.parseCanvasBoard({ ...base(), steps: [{ title: 'One', caption: 'c', show: ['in', 'box', 'e1'], lit: ['in'] }] })
	const full = canvas.renderCanvas(spec)
	const one = canvas.renderCanvas(spec, { step: 0 })
	assert.ok(full.svg.includes('>Out<') && !one.svg.includes('>Out<'), 'step 1 does not draw `out`')
	assert.deepEqual(one.boxes, full.boxes, 'the boxes describe the whole board, so an agent can place the next step')
	assert.equal(full.boxes.box.w, 200, 'a collapsed frame is one small box')
	assert.deepEqual(canvas.sceneOf(undefined), { show: undefined, open: undefined, lit: undefined })
	assert.equal(canvas.renderCanvas({ ...spec, kind: 'flow' }), undefined)
	const light = canvas.renderCanvas(spec, { dark: false })
	assert.ok(light.svg.includes('#ffffff') && full.svg.includes('#181818'))
	const moved = canvas.renderCanvas(spec, { overrides: { moves: { out: { x: 500, y: 0, hash: 'stale' } } } })
	assert.notEqual(JSON.stringify(moved.painted.layout.stale), '[]', 'a move with another hash is reported stale')
})

test('canvas board: update_board patches merge, remove (arrows with them) and add, and are checked like a drawing', () => {
	const { spec } = canvas.parseCanvasBoard({ ...base(), elements: [...base().elements.map(e => e.id === 'in' ? { ...e, style: { fill: 'teal', line: 'dashed' } } : e)] })
	const { raw, changed } = canvas.patchElements(spec, [
		{ id: 'in', label: 'Input', style: { fill: 'amber' } },
		{ id: 'out', remove: true },
		{ id: 'nope', remove: true },
		{ id: 'extra', type: 'text', label: 'new' },
	])
	assert.match(changed.join('\n'), /changed `in` \(label, style\)/)
	assert.match(changed.join('\n'), /removed `out`/)
	assert.match(changed.join('\n'), /removed arrow `e2` \(an end was removed\)/)
	assert.match(changed.join('\n'), /`nope` is not on the board/)
	assert.match(changed.join('\n'), /added `extra`/)
	const again = canvas.parseCanvasBoard(raw)
	assert.deepEqual(again.errors, [], 'what is left is a valid board')
	const byId = Object.fromEntries(again.spec.elements.map(e => [e.id, e]))
	assert.equal(byId.in.label, 'Input')
	assert.deepEqual(byId.in.style, { fill: 'amber', line: 'dashed', stroke: undefined, text: undefined, weight: undefined, size: undefined, opacity: undefined }, 'style merges one level')
	assert.ok(!byId.out && !byId.e2 && byId.e1 && byId.extra)
	assert.equal(again.spec.title, 'T')
	assert.equal(again.spec.purpose, 'concept')
	// A patch that breaks the board is reported, not applied silently.
	const bad = canvas.parseCanvasBoard(canvas.patchElements(spec, [{ id: 'e1', arrow: { from: 'in', to: 'ghost' } }]).raw)
	assert.ok(bad.errors.some(e => /`ghost` is not an element id/.test(e)))
})

test('canvas board: a code widget reads its lines inside the workspace, and says when it cannot', () => {
	const { spec } = canvas.parseCanvasBoard({ kind: 'canvas', title: 'T', elements: [
		{ id: 'ok', type: 'code', code: { file: 'src/a.cs', lines: [2, 3] } },
		{ id: 'own', type: 'code', code: { file: 'src/a.cs', text: 'given' } },
		{ id: 'out', type: 'code', code: { file: '../secret.txt', lines: [1, 2] } },
		{ id: 'gone', type: 'code', code: { file: 'src/none.cs', lines: [1, 2] } },
		{ id: 'past', type: 'code', code: { file: 'src/a.cs', lines: [40, 42] } },
		{ id: 'whole', type: 'code', code: { file: 'src/a.cs' } },
	] })
	const files = { '/w/src/a.cs': 'one\r\ntwo\r\nthree\r\nfour' }
	const found = canvas.fillCode(spec, f => files[f], f => f.startsWith('..') ? undefined : `/w/${f}`)
	const by = Object.fromEntries(spec.elements.map(e => [e.id, e]))
	assert.equal(by.ok.code.text, 'two\nthree')
	assert.deepEqual(by.ok.link, { file: '/w/src/a.cs', line: 2 }, 'a click opens the file at the first line')
	assert.equal(by.own.code.text, 'given')
	assert.equal(by.whole.code.text, 'one\ntwo\nthree\nfour')
	assert.equal(by.out.code.text, undefined)
	assert.equal(by.gone.code.text, undefined)
	const text = found.join('\n')
	assert.match(text, /`out`: file "..\/secret.txt" is outside the workspace/)
	assert.match(text, /`gone`: file "src\/none.cs" could not be read/)
	assert.match(text, /`past`: lines 40-42 are past the end of src\/a.cs \(4 lines\)/)
})

const memento = () => {
	const m = new Map()
	return { get: k => m.get(k), update: (k, v) => void m.set(k, v), m }
}

test('canvas board: moves and notes are validated, bounded and kept per board', () => {
	const keep = memento()
	const o = new overrides.OverridesStore(keep)
	assert.deepEqual(o.get('b'), {})
	assert.ok(o.move('b', 'a', 120.4, 30, 'h1'))
	assert.deepEqual(o.get('b').moves.a, { x: 120, y: 30, hash: 'h1' })
	assert.equal(o.move('b', 'a', NaN, 1, 'h'), false)
	assert.equal(o.move('b', 'a', 'x', 1, 'h'), false)
	assert.equal(o.move('b', 'a', overrides.MAX_COORD + 1, 1, 'h'), false)
	assert.deepEqual(o.get('b').moves.a, { x: 120, y: 30, hash: 'h1' }, 'a refused move changes nothing')
	assert.ok(o.note('b', 'a', '  ask Ada  '))
	assert.equal(o.get('b').notes.a, 'ask Ada')
	assert.equal(o.note('b', 'a', 7), false)
	assert.ok(o.note('b', 'a', 'x'.repeat(5000)))
	assert.equal(o.get('b').notes.a.length, overrides.MAX_NOTE_TEXT)
	assert.ok(o.note('b', 'a', '  '))
	assert.equal(o.get('b').notes.a, undefined, 'an empty note removes it')
	o.note('b', 'a', 'keep');
	o.resetMoves('b')
	assert.deepEqual(o.get('b'), { notes: { a: 'keep' }, moves: undefined }, 'reset positions keeps the notes')
	// pruning: elements the redraw no longer has are forgotten
	o.move('b', 'gone', 1, 1, 'h')
	o.note('b', 'gone', 'x')
	o.prune('b', ['a'])
	assert.deepEqual(Object.keys(o.get('b').moves ?? {}), [])
	assert.deepEqual(Object.keys(o.get('b').notes), ['a'])
	for (let i = 0; i < overrides.MAX_MOVES; i++) assert.ok(o.move('c', `e${i}`, i, i, 'h'))
	assert.equal(o.move('c', 'one-more', 1, 1, 'h'), false, `at most ${overrides.MAX_MOVES} moves per board`)
	assert.ok(o.move('c', 'e0', 5, 5, 'h'), 'an element already moved can move again')
	for (let i = 0; i < 60; i++) o.move(`board-${i}`, 'a', 1, 1, 'h')
	assert.ok(Object.keys(keep.m.get('flow.board.overrides')).length <= 40, 'the oldest boards are forgotten')
	assert.deepEqual(o.get('board-0'), {})
	o.forget('board-59')
	assert.deepEqual(o.get('board-59'), {})
})

test('canvas board: the store asks its host for overrides and for a picture of a step', async () => {
	const calls = []
	const s = new store.BoardStore()
	s.setHost({ show() { }, update() { }, image: async (id, ms, step) => { calls.push([id, ms, step]); return 'PNG' }, overrides: id => ({ notes: { [id]: 'n' } }) })
	assert.equal(await s.image('b', 5000, 2), 'PNG')
	assert.deepEqual(calls, [['b', 5000, 2]])
	assert.deepEqual(s.overrides('b'), { notes: { b: 'n' } })
	const bare = new store.BoardStore()
	assert.deepEqual(bare.overrides('b'), {})
	assert.equal(await bare.image('b'), undefined)
})

test('canvas board: the schema lists every element type with the data it needs, and the steps fields', () => {
	const props = tools.BOARD_SCHEMA.properties
	const items = props.elements.items
	assert.deepEqual(items.properties.type.enum, [...tools.ELEMENT_TYPES])
	assert.deepEqual(items.required, ['id', 'type'])
	assert.equal(items.oneOf.length, tools.ELEMENT_TYPES.length, 'a variant per type: oneOf')
	for (const v of items.oneOf) {
		for (const key of v.required ?? []) assert.ok(key in items.properties, `the data key ${key} is a property`)
	}
	assert.deepEqual(items.oneOf.filter(v => v.required).map(v => v.required[0]).sort(), ['arrow', 'chart', 'code', 'json', 'matrix', 'path', 'table'])
	for (const k of ['show', 'open', 'lit']) assert.equal(props.steps.items.properties[k].type, 'array')
	assert.deepEqual(props.purpose.enum, ['concept', 'code'])
	assert.ok(tools.TOOLS.find(t => t.name === 'read_board').annotations.readOnlyHint)
	assert.deepEqual(tools.TOOLS.find(t => t.name === 'update_board').inputSchema.properties.elements.items.required, ['id'])
	const image = tools.TOOLS.find(t => t.name === 'draw_board').inputSchema.properties.image
	assert.deepEqual(image.oneOf.map(o => o.type), ['boolean', 'object'])
	JSON.parse(JSON.stringify(tools.TOOLS))
	// Every type the schema offers is one the parser accepts.
	const sample = { rect: {}, ellipse: {}, diamond: {}, text: {}, frame: {}, path: { path: { points: [[0, 0], [5, 5]] } }, table: { table: { rows: [{ a: 1 }] } }, json: { json: { value: 1 } }, chart: { chart: { kind: 'line', series: [{ label: 's', points: [1, 2] }] } }, matrix: { matrix: { cells: [[1]] } }, code: { code: { text: 'x' } }, arrow: { arrow: { from: 'rect', to: 'text' } } }
	const parsed = parse.parseCanvas({ title: 'T', elements: tools.ELEMENT_TYPES.map(type => ({ id: type, type, ...sample[type] })) })
	assert.deepEqual(parsed.errors, [])
	assert.equal(parsed.spec.elements.length, tools.ELEMENT_TYPES.length)
})

test('canvas board: the example in the diagram_guide draws, without errors or warnings', () => {
	const guide = prompts.getPrompt('diagram_guide', {}).messages[0].content.text
	assert.match(guide, /Kind canvas: teach a concept, explain code/)
	const example = JSON.parse(/Example \(a canvas board\):\n(\{.*\})\n/.exec(guide)[1])
	assert.equal(example.id, 'embed')
	const { spec, errors } = canvas.parseCanvasBoard(example.board)
	assert.deepEqual(errors, [])
	assert.equal(spec.steps.length, 2)
	const rendered = canvas.renderCanvas(spec)
	assert.deepEqual(rendered.findings.filter(f => f.level === 'warning'), [])
	assert.equal(canvas.lintOf(rendered.findings).items.every(i => i.level === 'warn' || i.level === 'info'), true)
})

test('canvas board: ui/src/board/spec.ts is flow-view\'s spec.ts but for the path of the board-canvas import', () => {
	const read = file => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n').replace(/from '(\.\.\/)+board-canvas\/canvas'/, "from 'board-canvas/canvas'")
	assert.equal(read('../../../ui/src/board/spec.ts'), read('src/board/spec.ts'))
	assert.match(readFileSync(join(ROOT, 'src/board/spec.ts'), 'utf8'), /from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/board-canvas\/canvas'/)
	assert.match(readFileSync(join(ROOT, '../../../ui/src/board/spec.ts'), 'utf8'), /from '\.\.\/\.\.\/\.\.\/board-canvas\/canvas'/)
})
