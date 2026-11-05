// Board lint: what parseBoard reports instead of dropping silently, the lint of a parsed board, symbol matching, and the 7.3 schema fields.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let spec, lint, symbols, tools
before(async () => {
	spec = await load('src/board/spec.ts')
	lint = await load('src/board/lint.ts')
	symbols = await load('src/board/symbols.ts')
	tools = await load('src/mcp/tools.ts')
})
after(cleanup)

const parse = raw => spec.parseBoardWithNotes(raw)
const node = (id, extra = {}) => ({ id, label: id.toUpperCase(), ...extra })

test('board-notes: nothing is dropped silently', () => {
	const { spec: b, notes } = parse({
		kind: 'wizard', title: 't',
		nodes: [node('api'), node('svc', { kind: 'repo', status: 'later' }), node('api'), 7],
		edges: [{ from: 'api', to: 'sevc' }, { from: 'api', to: 'svc', kind: 'weird', style: 'wavy' }],
		groups: [{ id: 'g', label: 'G', kind: 'zone' }],
	})
	assert.equal(b.kind, 'flow')
	const text = notes.join('\n')
	assert.match(text, /board: kind `wizard` is not one of .*drawn as flow/)
	assert.match(text, /node `svc`: kind `repo`/)
	assert.match(text, /status `later`/)
	assert.match(text, /node id `api` is used twice/)
	assert.match(text, /node #4 was dropped/)
	assert.match(text, /no node `sevc` \(did you mean `svc`\?\)/)
	assert.match(text, /style `wavy`/)
	assert.match(text, /group `g`: kind `zone`/)
})

test('board-steps: a step written with `description` and a `focus` list (as Codex did) still says and lights what was meant', () => {
	const { spec: b, notes } = parse({
		title: 't', nodes: [node('a'), node('b'), node('c')], edges: [{ from: 'a', to: 'b' }],
		steps: [
			{ title: 'One', description: 'Why a and b.', focus: ['a', 'b'] },
			{ title: 'Two', description: 'Why c.', focus: ['c'] },
			{ title: 'Three', caption: 'Nothing named.' },
		],
	})
	assert.deepEqual(b.steps.map(s => [s.caption, s.nodes, s.focus]), [['Why a and b.', ['a', 'b'], undefined], ['Why c.', ['c'], undefined], ['Nothing named.', [], undefined]])
	const text = notes.join('\n')
	assert.equal(text.match(/`description` was read as the caption/g).length, 1)
	assert.equal(text.match(/a `focus` list was read as `nodes`/g).length, 1)
	assert.match(text, /step #3 lights up nothing/)
	assert.doesNotMatch(text, /step #1 lights up nothing/)
})

test('board-steps: a step with `caption` and `nodes` gives no note', () => {
	const { notes } = parse({ title: 't', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }], steps: [{ title: 'One', caption: 'c', nodes: ['a'] }, { title: 'Two', edges: [['a', 'b']] }, { title: 'Three', focus: 'a' }] })
	assert.deepEqual(notes, [])
})

test('board-notes: many of one kind are counted, not listed', () => {
	const nodes = Array.from({ length: 9 }, (_, i) => node(`n${i}`, { kind: 'nope' }))
	const { notes } = parse({ title: 't', nodes })
	assert.equal(notes.length, 6)
	assert.match(notes[5], /and 4 more/)
})

test('board-schema: old boards parse the same and the new fields are optional', () => {
	const { spec: b, notes } = parse({ kind: 'flow', title: 'Old', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', label: 'x' }] })
	assert.deepEqual(notes, [])
	for (const f of ['level', 'legend', 'focus', 'base', 'steps', 'highlight', 'callouts']) assert.equal(b[f], undefined, f)
	assert.equal(b.version, 1)
})

test('board-schema: the 7.3 fields are read, capped and validated', () => {
	const { spec: b, notes } = parse({
		kind: 'architecture', level: 'container', title: 'T', focus: 'svc', base: 'order-flow', legend: [{ key: 'writes', text: 'persists' }, { key: 'x' }],
		nodes: [node('api', { symbol: 'OrderService.Place', tech: 'Spring Boot', shape: 'cylinder', change: 'added', lane: 'l', zoom: 'board:two' }), node('svc'), node('db', { shape: 'blob' })],
		edges: [{ from: 'api', to: 'svc', order: 3.7, style: 'dashed', async: true, guard: 'amount > 0', change: 'removed' }],
		groups: [{ id: 'b', label: 'B', kind: 'boundary', tech: 'JVM' }],
		steps: [{ title: 'Validate', caption: 'why', nodes: ['api', 'ghost'], edges: [['api', 'svc'], ['svc', 'api']], focus: 'b' }, {}],
		highlight: [{ path: ['api', 'svc'], label: 'happy' }, { path: ['api'] }],
		callouts: [{ node: 'svc', text: 'Retries twice' }, { edge: ['api', 'svc'], text: 'sync' }, { node: 'ghost', text: 'x' }, { text: 'orphan' }],
	})
	assert.equal(b.level, 'container')
	assert.equal(b.focus, 'svc')
	assert.equal(b.base, 'order-flow')
	assert.deepEqual(b.legend, [{ key: 'writes', text: 'persists' }])
	const api = b.nodes[0]
	assert.deepEqual([api.symbol, api.tech, api.shape, api.change, api.lane, api.zoom], ['OrderService.Place', 'Spring Boot', 'cylinder', 'added', 'l', 'board:two'])
	assert.equal(b.nodes[2].shape, undefined)
	assert.deepEqual(b.edges[0], { from: 'api', to: 'svc', label: undefined, kind: undefined, fromCard: undefined, toCard: undefined, order: 3, style: 'dashed', async: true, guard: 'amount > 0', change: 'removed', fragment: undefined })
	assert.equal(b.groups[0].kind, 'boundary')
	assert.equal(b.groups[0].tech, 'JVM')
	assert.equal(b.steps.length, 1, 'a step without title and caption is dropped')
	assert.deepEqual(b.steps[0].nodes, ['api'])
	assert.deepEqual(b.steps[0].edges, [['api', 'svc']])
	assert.equal(b.steps[0].focus, 'b')
	assert.equal(b.highlight.length, 1)
	assert.equal(b.callouts.length, 2)
	const text = notes.join('\n')
	assert.match(text, /shape `blob`/)
	assert.match(text, /node `ghost` does not exist/)
	assert.match(text, /no edge `svc` → `api`/)
	assert.match(text, /highlight path was dropped/)
	assert.match(text, /callout was dropped/)
})

test('board-schema: sequence fragments need a group of kind alt, loop or opt', () => {
	const { spec: b, notes } = parse({
		kind: 'sequence', title: 's', nodes: [node('a'), node('b')],
		groups: [{ id: 'f', label: '[ok]', kind: 'alt' }, { id: 'l', label: 'x', kind: 'layer' }],
		edges: [{ from: 'a', to: 'b', fragment: 'f' }, { from: 'b', to: 'a', fragment: 'l' }],
	})
	assert.equal(b.edges[0].fragment, 'f')
	assert.equal(b.edges[1].fragment, undefined)
	assert.match(notes.join('\n'), /fragment `l` is not a group of kind alt, loop or opt/)
})

test('board-schema: the draw_board schema lists every new field and the enums match spec.ts', () => {
	const src = readFileSync(join(ROOT, 'src', 'board', 'spec.ts'), 'utf8')
	const union = name => [...new RegExp(`export type ${name}\\s*=([^;]+);`).exec(src)[1].matchAll(/'([^']+)'/g)].map(x => x[1])
	const props = tools.BOARD_SCHEMA.properties
	assert.deepEqual(props.level.enum, union('BoardLevel'))
	assert.deepEqual(props.nodes.items.properties.shape.enum, union('NodeShape'))
	assert.deepEqual(props.nodes.items.properties.change.enum, union('ChangeMark'))
	assert.deepEqual(props.edges.items.properties.change.enum, union('ChangeMark'))
	assert.deepEqual(props.edges.items.properties.style.enum, union('EdgeLine'))
	assert.deepEqual(props.groups.items.properties.kind.enum, union('GroupKind'))
	const fields = name => [...new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src)[1].matchAll(/^\t(\w+)\??:/gm)].map(m => m[1])
	assert.deepEqual(fields('BoardSpec').filter(f => !['version'].includes(f)).sort(), Object.keys(props).sort())
	assert.deepEqual(fields('BoardStep').sort(), Object.keys(props.steps.items.properties).sort())
	assert.deepEqual(fields('BoardHighlight').sort(), Object.keys(props.highlight.items.properties).sort())
	assert.deepEqual(fields('BoardCallout').sort(), Object.keys(props.callouts.items.properties).sort())
	assert.deepEqual(fields('BoardLegendEntry').sort(), Object.keys(props.legend.items.properties).sort())
})

const lintOf = raw => lint.lintBoard(spec.parseBoard(raw))
const texts = r => r.items.map(i => i.text).join('\n')

test('board-lint: orphans, same labels, bare flow edges, decisions and plan cycles', () => {
	const r = lintOf({
		kind: 'flow', title: 't',
		nodes: [node('a'), node('b'), node('c', { label: 'A' }), node('lonely'), node('d', { kind: 'decision' })],
		edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'd' }, { from: 'd', to: 'c', kind: 'yes' }],
	})
	const t = texts(r)
	assert.match(t, /nodes `a`, `c` share the label "A"/)
	assert.match(t, /1 node\(s\) have no edges \(`lonely`\)/)
	assert.match(t, /2 edge\(s\) have no label/)
	assert.match(t, /decision `d` has fewer than two outgoing edges/)
	const plan = lintOf({ kind: 'plan', title: 'p', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', kind: 'next' }, { from: 'b', to: 'a', kind: 'next' }] })
	assert.match(texts(plan), /plan has a cycle/)
	assert.doesNotMatch(texts(plan), /no edges/, 'plan steps are not orphans')
})

test('board-lint: density counts visible nodes (a collapsed group is one box) and crossings are estimated', () => {
	const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i}`, { group: i < 20 ? 'g' : undefined }))
	const edges = Array.from({ length: 29 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, label: 'x' }))
	const open = lintOf({ title: 't', nodes, edges, groups: [{ id: 'g', label: 'Core' }] })
	assert.match(texts(open), /30 visible nodes \(aim for 25 or fewer\).*"Core"/)
	const folded = lintOf({ title: 't', nodes, edges, groups: [{ id: 'g', label: 'Core', collapsed: true }] })
	assert.equal(folded.visible, 11)
	assert.doesNotMatch(texts(folded), /visible nodes/)
	// two crossing lines: a-d and b-c between the same two layers can be uncrossed by ordering, a K3,3 cannot
	assert.equal(lint.estimateCrossings(['a', 'b', 'c', 'd'], [['a', 'c'], ['b', 'd']]), 0)
	const k33 = []
	for (const x of ['a', 'b', 'c']) for (const y of ['x', 'y', 'z']) k33.push([x, y])
	assert.ok(lint.estimateCrossings(['a', 'b', 'c', 'x', 'y', 'z'], k33) >= 3, 'K3,3 has at least 3 crossings in a layered drawing')
	assert.equal(lint.estimateCrossings(['a', 'b'], [['a', 'b'], ['b', 'a']]), 0, 'a cycle does not hang')
	const hair = lintOf({ title: 't', nodes: Array.from({ length: 12 }, (_, i) => node(`n${i}`)), edges: k33.flatMap(([a, b], i) => [{ from: a === 'a' ? 'n0' : a === 'b' ? 'n1' : 'n2', to: `n${3 + (i % 9)}`, label: 'x' }]) })
	assert.ok(hair.crossings >= 0)
})

test('board-lint: sequence boards want order, few lifelines, and no crossing estimate', () => {
	const r = lintOf({ kind: 'sequence', title: 's', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b', order: 1 }, { from: 'b', to: 'a' }, { from: 'a', to: 'b', order: 1 }] })
	const t = texts(r)
	assert.match(t, /1 message\(s\) have no `order`/)
	assert.match(t, /share the same `order`/)
	assert.equal(r.crossings, 0)
	const wide = lintOf({ kind: 'sequence', title: 's', nodes: Array.from({ length: 10 }, (_, i) => node(`p${i}`)), edges: Array.from({ length: 9 }, (_, i) => ({ from: `p${i}`, to: `p${i + 1}`, order: i + 1, label: 'x' })) })
	assert.match(texts(wide), /10 lifelines/)
})

test('board-lint: groups, state, c4 and steps hints', () => {
	const r = lintOf({
		kind: 'architecture', level: 'container', title: 'a', nodes: [node('a', { group: 'solo' }), node('b'), node('c'), node('d'), node('e'), node('f'), node('g')],
		edges: [{ from: 'a', to: 'b', label: 'x' }], groups: [{ id: 'solo', label: 'Solo' }, { id: 'empty', label: 'Empty' }, { id: 'l1', label: '1' }, { id: 'l2', label: '2', parent: 'l1' }, { id: 'l3', label: '3', parent: 'l2' }],
	})
	const t = texts(r)
	assert.match(t, /group `solo` holds a single node/)
	assert.match(t, /group `empty` is empty/)
	assert.match(t, /groups `l3` are nested more than 2 levels/)
	assert.match(t, /no `tech`/)
	assert.match(t, /no `steps`/)
	assert.match(texts(lintOf({ kind: 'state', title: 's', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] })), /no initial state/)
})

test('board-lint: the answer is short, errors first, numbered', () => {
	const result = lintOf({ title: 't', nodes: [node('a')] })
	const lines = lint.formatLint(['x was dropped.'], ['file is missing'], result)
	assert.match(lines[0], /^LINT \(/)
	assert.match(lines[1], /^1\. x was dropped\./)
	assert.match(lines[2], /^2\. file is missing/)
	const many = lint.formatLint(Array.from({ length: 14 }, (_, i) => `note ${i}`), [], result)
	assert.equal(many.length, 1 + lint.MAX_LINT_LINES + 1)
	assert.match(many.at(-1), /and \d+ more/)
	assert.deepEqual(lint.formatLint([], [], { items: [], visible: 1, crossings: 0 }), [])
})

test('board-symbols: the owner decides, near misses are suggested', () => {
	const c = (name, container, line = 1) => ({ name, container, kind: 'method', file: '/w/a.cs', line })
	const cands = [c('Place', 'OrderService', 10), c('Place', 'ShelfService', 20), c('PlaceholderText', 'Ui', 30), c('Cancel', 'OrderService', 40)]
	assert.equal(symbols.matchSymbols('OrderService.Place', cands).exact.line, 10)
	assert.equal(symbols.matchSymbols('Shop.ShelfService.Place', cands).exact.line, 20)
	assert.equal(symbols.matchSymbols('Place', cands).exact.line, 10, 'no owner: the first with that name')
	const miss = symbols.matchSymbols('OrderService.Plac', cands)
	assert.equal(miss.exact, undefined)
	assert.ok(miss.near.length >= 1 && miss.near[0].name.startsWith('Plac'))
	assert.deepEqual(symbols.splitSymbol('A::B::run'), { owner: 'A.B', name: 'run' })
	assert.equal(symbols.symbolQuery('OrderService.Place(int)'), 'Place')
	assert.match(symbols.describeCandidate(c('Place', 'OrderService', 10)), /method OrderService\.Place \/w\/a\.cs:10/)
	assert.equal(symbols.matchSymbols('Nope.Missing', cands).near.length, 0)
})
