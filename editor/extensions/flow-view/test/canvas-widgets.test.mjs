// board-canvas widgets (table, json, chart, matrix, code), icons, scenes and moves. Each widget has a fixture whose SVG is
// pinned by a golden file; every widget's primitives must also stay inside its box. After an intended change:
// UPDATE=1 node --test test/canvas-widgets.test.mjs, then read the diff of test/canvas-expected.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let paint, parse, layout, lint, code, chart, json, icons, measure
before(async () => {
	paint = await load('../../../board-canvas/paint.ts')
	parse = await load('../../../board-canvas/parse.ts')
	layout = await load('../../../board-canvas/layout.ts')
	lint = await load('../../../board-canvas/lint.ts')
	code = await load('../../../board-canvas/widgets/code.ts')
	chart = await load('../../../board-canvas/widgets/chart.ts')
	json = await load('../../../board-canvas/widgets/json.ts')
	icons = await load('../../../board-canvas/icons.ts')
	measure = await load('../../../board-canvas/measure.ts')
})
after(cleanup)

const EXPECTED = join(ROOT, 'test', 'canvas-expected')
function golden(name, text) {
	const file = join(EXPECTED, `${name}.svg`)
	if (process.env.UPDATE) {
		mkdirSync(EXPECTED, { recursive: true })
		writeFileSync(file, text + '\n')
		return
	}
	assert.ok(existsSync(file), `no golden file ${name}: run UPDATE=1 node --test test/canvas-widgets.test.mjs and read test/canvas-expected/${name}.svg`)
	assert.equal(text + '\n', readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
}

const FIXTURES = {
	table: { id: 't', type: 'table', label: 'Bills', table: { columns: [{ key: 'id', label: 'id', mono: true }, { key: 'customer', label: 'customer', link: true }, { key: 'total', label: 'total', align: 'right' }], rows: [{ id: 'b-1', customer: 'Ada Lovelace', total: 120.5 }, { id: 'b-2', customer: 'Alan Turing', total: 87 }, { id: 'b-3', customer: 'Grace Hopper', total: 1999.99 }], maxRows: 2 } },
	json: { id: 'j', type: 'json', label: 'Request', json: { schema: { name: 'order', type: 'Order', children: [{ name: 'id', type: 'Guid', origin: 'source' }, { name: 'lines', type: 'OrderLine[]', children: [{ name: 'sku', type: 'string' }] }, { name: 'token', type: 'string', unknown: true }] }, value: { id: '7f3a', lines: [{ sku: 'A-1' }] } } },
	'json-value': { id: 'jv', type: 'json', json: { value: { ok: true, n: 3, tags: ['a', 'b', 'c'], nested: { deep: { deeper: 1 } }, none: null }, open: 1 } },
	chart: { id: 'c', type: 'chart', label: 'Loss', chart: { kind: 'line', series: [{ label: 'train', points: [3.2, 2.1, 1.4, 0.9, 0.7] }, { label: 'val', points: [3.4, 2.5, 1.9, 1.5, 1.4] }], axes: { x: { label: 'epoch' }, y: { label: 'loss' } } } },
	bar: { id: 'b', type: 'chart', label: 'Latency', chart: { kind: 'bar', series: [{ label: 'p50', points: [12, 18, 9], labels: ['api', 'db', 'cache'] }, { label: 'p99', points: [40, 95, 22] }] } },
	points2d: { id: 'p', type: 'chart', chart: { kind: 'points2d', series: [{ label: 'words', points: [[0.2, 0.8], [0.3, 0.7], [0.9, 0.1]], labels: ['king', 'queen', 'apple'] }], axes: { x: { range: [0, 1] }, y: { range: [0, 1] } } } },
	matrix: { id: 'm', type: 'matrix', label: 'Embeddings', matrix: { cells: [[0.12, -0.4, 0.9], [0.55, 0.02, -0.7]], rowLabels: ['Fat', 'ura'], colLabels: ['d0', 'd1', 'd2'], dims: '2 × 768 (3 shown)' } },
	heat: { id: 'h', type: 'matrix', matrix: { cells: Array.from({ length: 10 }, (_, i) => Array.from({ length: 10 }, (_, j) => (i === j ? 1 : 1 / (1 + Math.abs(i - j))))), scale: 'sequential' } },
	code: { id: 'k', type: 'code', code: { file: 'src/Orders/OrderService.cs', lines: [58, 63], language: 'csharp', highlight: [60], text: 'public Order Place(Cart cart)\n{\n    // prices are copied, never referenced\n    var order = new Order(cart.Lines.Select(l => l.Price));\n    return _repo.Save(order);\n}' } },
	python: { id: 'py', type: 'code', label: 'train.py', code: { language: 'python', text: 'def step(x):\n    """one update"""\n    return x - 0.1 * grad(x)  # lr 0.1' } },
}

const paintOne = el => paint.paintCanvas({ title: 'T', elements: [el] }, paint.DARK)

for (const [name, el] of Object.entries(FIXTURES)) {
	test(`widget ${name}: golden picture, primitives stay inside the box`, () => {
		const parsed = parse.parseCanvas({ title: 'T', elements: [el] })
		assert.deepEqual(parsed.errors, [], 'the fixture parses')
		const painted = paint.paintCanvas(parsed.spec, paint.DARK)
		const box = painted.layout.boxes.get(el.id).box
		for (const pr of painted.primitives.filter(p => p.id === el.id)) {
			if (pr.kind === 'rect') {
				assert.ok(pr.x >= box.x - 0.5 && pr.y >= box.y - 0.5 && pr.x + pr.w <= box.x + box.w + 0.5 && pr.y + pr.h <= box.y + box.h + 0.5, `${name}: rect ${JSON.stringify(pr)} leaves ${JSON.stringify(box)}`)
			} else if (pr.kind === 'text') {
				const w = measure.textWidth(pr.text, pr.size, pr.mono)
				const x1 = pr.anchor === 'middle' ? pr.x - w / 2 : pr.anchor === 'end' ? pr.x - w : pr.x
				assert.ok(x1 >= box.x - 1 && x1 + w <= box.x + box.w + 1 && pr.y <= box.y + box.h && pr.y >= box.y, `${name}: text "${pr.text}" (${x1}..${x1 + w}, ${pr.y}) leaves ${JSON.stringify(box)}`)
			}
		}
		golden(name, paint.toSvg(painted, paint.DARK))
	})
}

test('table: rows beyond maxRows become a "+n more" line, and the size follows the rows', () => {
	const a = paintOne({ ...FIXTURES.table })
	assert.ok(a.primitives.some(p => p.kind === 'text' && p.text === '+1 more row'))
	const all = paintOne({ ...FIXTURES.table, table: { ...FIXTURES.table.table, maxRows: 3 } })
	const one = paintOne({ ...FIXTURES.table, table: { ...FIXTURES.table.table, maxRows: 1 } })
	assert.ok(!all.primitives.some(p => p.kind === 'text' && /more row/.test(p.text)))
	assert.ok(one.layout.boxes.get('t').box.h < all.layout.boxes.get('t').box.h, 'fewer rows are shorter')
	assert.ok(one.primitives.some(p => p.kind === 'text' && p.text === '+2 more rows'))
})

test('json: depth, items and the node budget', () => {
	const lines = json.jsonLines({ value: { a: { b: { c: 1 } }, list: Array.from({ length: 12 }, (_, i) => i) }, open: 2, maxItems: 3 })
	assert.equal(lines[0].value, '{2}')
	assert.equal(lines.find(l => l.key === 'b').value, '{1}', 'a level beyond open is summarised, not drawn')
	assert.ok(!lines.some(l => l.key === 'c'))
	assert.ok(lines.some(l => l.value === '… +9 more'), 'a long list shows maxItems entries and counts the rest')
	const big = json.jsonLines({ value: Array.from({ length: 40 }, () => Array.from({ length: 40 }, (_, i) => i)), open: 3, maxItems: 40 })
	assert.equal(big.length, 401, 'at most 400 nodes are built, then one line says so')
	assert.match(big[400].value, /cut at 400 nodes/)
	const typed = json.jsonLines({ schema: { name: 'x', type: 'T', children: [{ name: 'u', type: 'string', unknown: true }] }, value: { u: 'hidden' } })
	assert.equal(typed[1].value, '?', 'unknown wins over the value')
})

test('chart: nice ticks, and bar/line series must have equal lengths', () => {
	assert.deepEqual(chart.niceTicks(0, 95, 4), [0, 25, 50, 75])
	assert.deepEqual(chart.niceTicks(0, 1, 4), [0, 0.25, 0.5, 0.75, 1])
	const bad = parse.parseCanvas({ title: 'T', elements: [{ id: 'c', type: 'chart', chart: { kind: 'bar', series: [{ label: 'a', points: [1, 2] }, { label: 'b', points: [1, 2, 3] }] } }, { id: 'ok', type: 'text', label: 'x' }] })
	assert.ok(bad.errors.some(e => /different lengths/.test(e)))
	assert.deepEqual(bad.spec.elements.map(e => e.id), ['ok'])
	const scatter = parse.parseCanvas({ title: 'T', elements: [{ id: 'c', type: 'chart', chart: { kind: 'scatter', series: [{ label: 'a', points: [[1, 2]] }, { label: 'b', points: [[1, 2], [2, 3]] }] } }] })
	assert.deepEqual(scatter.errors, [], 'a scatter may have series of any length')
})

test('matrix: a ragged matrix is dropped, a large one is cut at 24 x 24 and says so', () => {
	const ragged = parse.parseCanvas({ title: 'T', elements: [{ id: 'm', type: 'matrix', matrix: { cells: [[1, 2], [3]] } }, { id: 'ok', type: 'text', label: 'x' }] })
	assert.ok(ragged.errors.some(e => /different lengths/.test(e)))
	const big = parse.parseCanvas({ title: 'T', elements: [{ id: 'm', type: 'matrix', matrix: { cells: Array.from({ length: 30 }, () => Array(40).fill(0.5)), dims: '30 × 40' } }] })
	assert.equal(big.spec.elements[0].matrix.cells.length, 24)
	assert.equal(big.spec.elements[0].matrix.cells[0].length, 24)
	assert.ok(big.notes.some(n => /30 × 40/.test(n)))
	assert.ok(paintOne(big.spec.elements[0]).layout.boxes.get('m').box.w < 600)
})

test('code: tokens, the 12 line cap and the unread file warning', () => {
	const kinds = code.tokenize('const s = "a b"; // note 3', 'c').map(t => `${t.kind}:${t.text}`)
	assert.deepEqual(kinds, ['kw:const', 'plain: s = ', 'str:"a b"', 'plain:; ', 'com:// note 3'])
	assert.deepEqual(code.tokenize('SELECT n FROM t -- all', 'sql').filter(t => t.kind !== 'plain').map(t => t.kind), ['kw', 'kw', 'com'])
	const block = { open: false }
	code.tokenize('a /* start', 'c', block)
	assert.equal(block.open, true)
	assert.equal(code.tokenize('end */ b', 'c', block)[0].kind, 'com')
	assert.equal(code.languageOf('Python'), 'py')
	const long = parse.parseCanvas({ title: 'T', elements: [{ id: 'k', type: 'code', code: { text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') } }] })
	assert.ok(long.notes.some(n => /20 lines of code/.test(n)))
	assert.equal(code.codeLines(long.spec.elements[0]).length, 12)
	const unread = parse.parseCanvas({ title: 'T', elements: [{ id: 'k', type: 'code', code: { file: 'src/a.cs', lines: [1, 3] } }] })
	assert.ok(lint.lintSpec(unread.spec).some(f => f.level === 'warning' && /could not be read/.test(f.text)))
	assert.ok(parse.parseCanvas({ title: 'T', elements: [{ id: 'k', type: 'code', code: { lines: [1, 3] } }] }).errors.length, 'neither text nor file')
})

test('icons: scaled and moved, an unknown name is a text chip and lints as info', () => {
	assert.ok(icons.ICON_NAMES.length >= 40)
	assert.equal(icons.iconPath('check', 100, 50, 32), 'M 106 67 L 113 74 L 126 59', 'every number is scaled by 2 and moved')
	assert.equal(icons.iconPath('nope', 0, 0, 16), undefined)
	const spec = { title: 'T', elements: [{ id: 'a', type: 'rect', label: 'A', icon: 'database' }, { id: 'b', type: 'rect', label: 'B', icon: 'sparkles' }] }
	const painted = paint.paintCanvas(spec, paint.DARK)
	assert.equal(painted.primitives.filter(p => p.id === 'a' && p.kind === 'path').length, 1)
	assert.ok(painted.primitives.some(p => p.id === 'b' && p.kind === 'text' && p.text === 'sparkles'))
	assert.ok(lint.lintSpec(spec).some(f => f.level === 'info' && /no icon `sparkles`/.test(f.text)))
	for (const name of icons.ICON_NAMES) assert.ok(!/NaN|undefined/.test(icons.iconPath(name, 0, 0, 16)), `${name} has clean path data`)
})

test('path: points are drawn as a polyline, d is sanitised', () => {
	const ok = parse.parseCanvas({ title: 'T', elements: [{ id: 'p', type: 'path', path: { points: [[0, 0], [40, 20], [80, 0]], smooth: true } }, { id: 'd', type: 'path', path: { d: 'M0 0 L10 10' } }, { id: 'bad', type: 'path', path: { d: 'M0 0" onload="x' } }] })
	assert.deepEqual(ok.spec.elements.map(e => e.id), ['p', 'd'])
	assert.ok(ok.errors.some(e => /`bad`.*path needs/.test(e)))
	const painted = paint.paintCanvas(ok.spec, paint.DARK)
	assert.ok(painted.primitives.some(p => p.id === 'p' && p.kind === 'path' && p.d.includes('C')))
	assert.match(paint.toSvg(painted, paint.DARK), /transform="translate\(/)
})

test('arrows that name a port enter and leave on that row', () => {
	const spec = {
		title: 'T', layout: 'row',
		elements: [
			{ id: 'a', type: 'rect', label: 'A', output: { id: 'out', name: 'y' } },
			{ id: 'b', type: 'rect', label: 'B', inputs: [{ id: 'in1', name: 'x1' }, { id: 'in2', name: 'x2' }] },
			{ id: 'e', type: 'arrow', arrow: { from: { el: 'a', port: 'out' }, to: { el: 'b', port: 'in2' } } },
			{ id: 'bad', type: 'arrow', arrow: { from: 'a', to: { el: 'b', port: 'in9' } } },
		],
	}
	const parsed = parse.parseCanvas(spec)
	assert.ok(parsed.errors.some(e => /no port `in9`/.test(e) && /in1, in2/.test(e)))
	const painted = paint.paintCanvas(parsed.spec, paint.DARK)
	const b = painted.layout.boxes.get('b')
	const row = layout.rowBoxes(b.el, b.box).find(r => r.id === 'in2')
	const r = painted.routes.get('e')
	assert.equal(r.end.x, b.box.x, 'enters on the left side of b')
	assert.equal(r.end.y, row.box.y + row.box.h / 2, 'at the height of the port row')
})

test('scenes: show hides without moving, lit dims, an arrow follows its ends', () => {
	const spec = {
		title: 'T', layout: 'row',
		elements: [
			{ id: 'a', type: 'rect', label: 'A' }, { id: 'b', type: 'rect', label: 'B' }, { id: 'c', type: 'rect', label: 'C' },
			{ id: 'ab', type: 'arrow', arrow: { from: 'a', to: 'b' } }, { id: 'bc', type: 'arrow', arrow: { from: 'b', to: 'c' } },
		],
	}
	const all = paint.paintCanvas(spec, paint.DARK)
	const scene = paint.paintCanvas(spec, paint.DARK, { show: new Set(['a', 'b', 'ab']) })
	assert.deepEqual([...scene.hidden].sort(), ['bc', 'c'])
	assert.deepEqual(scene.layout.boxes.get('b').box, all.layout.boxes.get('b').box, 'nothing moves between scenes')
	assert.ok(!scene.primitives.some(p => p.id === 'c' || p.id === 'bc'))
	assert.equal(scene.layout.w, all.layout.w, 'the picture keeps its size')
	const lit = paint.paintCanvas(spec, paint.DARK, { lit: new Set(['a', 'b']) })
	const opacity = id => lit.primitives.find(p => p.id === id).opacity
	assert.equal(opacity('a'), undefined)
	assert.ok(opacity('c') < 0.5, 'c is dimmed')
	assert.equal(opacity('ab'), undefined, 'an arrow between lit ends is lit')
	assert.ok(opacity('bc') < 0.5)
})

test('moves: applied when the frame hash matches, dropped and reported when it does not', () => {
	const spec = { title: 'T', layout: 'row', elements: [{ id: 'a', type: 'rect', label: 'A' }, { id: 'b', type: 'rect', label: 'B' }] }
	const hash = layout.moveHash(spec, 'b')
	assert.equal(typeof hash, 'string')
	assert.equal(layout.moveHash(spec, 'nope'), undefined)
	const moved = layout.layoutCanvas(spec, { overrides: { moves: { b: { x: 300, y: 90, hash } } } })
	assert.deepEqual(moved.boxes.get('b').rel, { x: 300, y: 90 })
	assert.equal(moved.boxes.get('b').box.x, 300)
	assert.deepEqual(moved.stale, [])
	assert.ok(moved.w >= 300 + 160, 'the picture grows to hold a moved element')
	const changed = { ...spec, elements: [...spec.elements, { id: 'c', type: 'rect', label: 'C' }] }
	const stale = layout.layoutCanvas(changed, { overrides: { moves: { b: { x: 300, y: 90, hash } } } })
	assert.deepEqual(stale.stale, ['b'])
	assert.equal(stale.boxes.get('b').box.x, 160 + 16, 'back where the layout puts it')
	const noted = paint.paintCanvas(spec, paint.DARK, { overrides: { notes: { a: 'ask Ada' } } })
	assert.ok(noted.primitives.some(p => p.kind === 'text' && p.text === 'ask Ada'))
	assert.ok(noted.layout.h > paint.paintCanvas(spec, paint.DARK).layout.h, 'a sticky below the last row is inside the picture')
	assert.deepEqual(paint.boxesOf(moved).b, { x: 300, y: 90, w: 160, h: 64 })
})

test('origin pills and the agent note marker are painted; lint says what is missing', () => {
	const spec = { title: 'T', purpose: 'code', elements: [{ id: 'a', type: 'rect', label: 'A', origin: 'runtime', note: 'why' }, { id: 'b', type: 'rect', label: 'B', origin: 'illustrative', style: { fill: '#112233' } }] }
	const painted = paint.paintCanvas(spec, paint.DARK)
	assert.ok(painted.primitives.some(p => p.kind === 'text' && p.text === 'runtime'))
	assert.ok(painted.primitives.some(p => p.kind === 'text' && p.text === 'illustrative'))
	assert.ok(painted.primitives.some(p => p.kind === 'text' && p.text === 'i'))
	const texts = lint.lintCanvas(spec, painted).map(f => f.text).join('\n')
	assert.match(texts, /origin runtime without `source`/)
	assert.match(texts, /hex colour/)
	assert.match(texts, /purpose is "code"/)
})

test('a teaching board: text to vector, in frames, with typed ports and a matrix, lints clean of warnings', () => {
	const spec = {
		title: 'Metin → Vektör', purpose: 'concept', layout: 'column',
		elements: [
			{ id: 'in', type: 'rect', label: 'Metin', detail: '"Fatura ödenmedi"', origin: 'source' },
			{ id: 'model', type: 'frame', label: 'Model', frameData: { layout: 'row' } },
			{ id: 'tok', type: 'rect', frame: 'model', label: 'Tokenlar', detail: 'Fat · ura · öden · medi', icon: 'text' },
			{ id: 'emb', type: 'matrix', frame: 'model', label: 'Embedding', matrix: { cells: [[0.1, -0.3, 0.7], [0.4, 0.2, -0.5]], rowLabels: ['Fat', 'ura'], dims: '4 × 768 (2 × 3 shown)' }, origin: 'illustrative' },
			{ id: 'vec', type: 'json', label: 'Vektör', json: { schema: { name: 'vector', type: 'float[768]', origin: 'illustrative' } } },
			{ id: 'a1', type: 'arrow', label: 'tokenize', arrow: { from: 'in', to: 'tok', data: { shape: 'int[4]' } } },
			{ id: 'a2', type: 'arrow', arrow: { from: 'tok', to: 'emb' } },
			{ id: 'a3', type: 'arrow', label: 'pool', arrow: { from: 'model', to: 'vec', data: { type: 'float', shape: '[768]' } } },
		],
	}
	const parsed = parse.parseCanvas(spec)
	assert.deepEqual(parsed.errors, [])
	const painted = paint.paintCanvas(parsed.spec, paint.LIGHT)
	assert.deepEqual(lint.lintCanvas(parsed.spec, painted).filter(f => f.level === 'warning'), [])
	golden('teaching', paint.toSvg(painted, paint.LIGHT))
})

test('a scene hides an element from the reader: it keeps its place but is not hittable', () => {
	const spec = { title: 'T', elements: [{ id: 'a', type: 'rect', label: 'A' }, { id: 'b', type: 'rect', label: 'B' }] }
	const painted = paint.paintCanvas(spec, paint.DARK, { show: new Set(['a']) })
	assert.ok(painted.layout.boxes.has('b'), 'hidden elements keep their place in the layout')
	assert.deepEqual(paint.hittable(painted).map(p => p.el.id), ['a'])
})
