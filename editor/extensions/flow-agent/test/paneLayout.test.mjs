// The pane layout tree (src/paneLayout.ts): splitting, moving, closing, resizing, maximizing and the validation of untrusted JSON. It is
// pure, so it is tested on its own; one test also runs its source text in a bare context, the way the page gets it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let L
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-panelayout-'))
	const outfile = join(tmp, 'paneLayout.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'paneLayout.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	L = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const c = (name, over = {}) => ({ kind: 'terminal', agent: 'claude', session: name, title: name, ...over })
/** A layout of panes opened one after the other: a, b, c ... */
function opened(...names) {
	let layout = L.emptyLayout()
	const ids = {}
	for (const n of names) {
		const r = L.openPane(layout, c(n))
		layout = r.layout
		ids[n] = r.id
	}
	return { layout, ids }
}
const shape = n => n.type === 'pane' ? n.content.session : `${n.dir}[${n.children.map(shape).join(' ')}]`
const sizes = n => n.sizes.map(s => Math.round(s * 1000) / 1000)
const sumOf = n => n.sizes.reduce((a, b) => a + b, 0)

test('the first pane is the root; the next ones open to its right in one row', T, () => {
	const { layout, ids } = opened('a', 'b', 'c')
	assert.equal(shape(layout.root), 'row[a b c]')
	assert.deepEqual(sizes(layout.root), [0.5, 0.25, 0.25])
	assert.equal(layout.focus, ids.c)
	assert.ok(Math.abs(sumOf(layout.root) - 1) < 1e-9)
})

test('splitting on an edge puts the new pane beside the target, in the right direction', T, () => {
	const { layout, ids } = opened('a')
	const right = L.splitPane(layout, ids.a, 'right', c('b'))
	assert.equal(shape(right.layout.root), 'row[a b]')
	assert.equal(right.layout.focus, right.id)
	assert.equal(shape(L.splitPane(layout, ids.a, 'left', c('b')).layout.root), 'row[b a]')
	assert.equal(shape(L.splitPane(layout, ids.a, 'bottom', c('b')).layout.root), 'col[a b]')
	assert.equal(shape(L.splitPane(layout, ids.a, 'top', c('b')).layout.root), 'col[b a]')
})

test('splitting inside a split of the other direction nests; of the same direction joins it and halves the target\'s share', T, () => {
	const { layout, ids } = opened('a', 'b')
	const nested = L.splitPane(layout, ids.b, 'bottom', c('c')).layout
	assert.equal(shape(nested.root), 'row[a col[b c]]')
	assert.deepEqual(sizes(nested.root), [0.5, 0.5])
	assert.deepEqual(sizes(nested.root.children[1]), [0.5, 0.5])
	const joined = L.splitPane(layout, ids.a, 'right', c('c')).layout
	assert.equal(shape(joined.root), 'row[a c b]')
	assert.deepEqual(sizes(joined.root), [0.25, 0.25, 0.5])
})

test('an operation never changes the layout it was given', T, () => {
	const { layout, ids } = opened('a', 'b')
	const frozen = JSON.stringify(layout)
	L.splitPane(layout, ids.a, 'top', c('x'))
	L.replaceContent(layout, ids.a, c('y'))
	L.movePane(layout, ids.a, ids.b, 'bottom')
	L.closePane(layout, ids.a)
	L.resize(layout, layout.root.id, 0, 0.1, 0.1)
	L.maximize(layout, ids.a)
	assert.equal(JSON.stringify(layout), frozen)
})

test('replacing a pane\'s content keeps its place and id, and focuses it', T, () => {
	const { layout, ids } = opened('a', 'b')
	const next = L.replaceContent(layout, ids.a, c('z'))
	assert.equal(shape(next.root), 'row[z b]')
	assert.equal(next.focus, ids.a)
	assert.equal(L.replaceContent(layout, 'p999', c('z')), layout)
})

test('moving a pane onto the centre of another swaps them; the ids travel with the panes', T, () => {
	const { layout, ids } = opened('a', 'b', 'c')
	const next = L.movePane(layout, ids.a, ids.c, 'center')
	assert.equal(shape(next.root), 'row[c b a]')
	assert.equal(L.find(next, ids.a).content.session, 'a')
	assert.equal(next.focus, ids.a)
	assert.deepEqual(sizes(next.root), sizes(layout.root))
})

test('moving a pane to an edge of another takes it out of its place (the neighbours take the space) and puts it beside the target', T, () => {
	const { layout, ids } = opened('a', 'b', 'c')
	const next = L.movePane(layout, ids.a, ids.c, 'bottom')
	assert.equal(shape(next.root), 'row[b col[c a]]')
	assert.ok(Math.abs(sumOf(next.root) - 1) < 1e-9)
	assert.equal(next.focus, ids.a)
	// Moving next to its own neighbour on the side it already is on changes nothing in the order.
	assert.equal(shape(L.movePane(layout, ids.a, ids.b, 'left').root), 'row[a b c]')
	assert.equal(shape(L.movePane(layout, ids.a, ids.b, 'top').root), 'row[col[a b] c]')
	// Onto itself, or an unknown pane: nothing.
	assert.equal(L.movePane(layout, ids.a, ids.a, 'right'), layout)
	assert.equal(L.movePane(layout, ids.a, 'p999', 'right'), layout)
})

test('closing a pane gives its share to its siblings in proportion and collapses a split left with one child', T, () => {
	const { layout, ids } = opened('a', 'b', 'c')
	const two = L.closePane(layout, ids.a)
	assert.equal(shape(two.root), 'row[b c]')
	assert.deepEqual(sizes(two.root), [0.5, 0.5])
	const one = L.closePane(two, ids.b)
	assert.equal(one.root.type, 'pane')
	assert.equal(one.root.content.session, 'c')
	assert.equal(one.focus, ids.c)
	const none = L.closePane(one, ids.c)
	assert.equal(none.root, undefined)
	assert.equal(none.focus, undefined)
	// A nested split that ends up with a same-direction parent is flattened.
	const nested = L.splitPane(opened('a', 'b').layout, opened('a', 'b').ids.b, 'bottom', c('c')).layout
	const b = L.panes(nested).find(p => p.content.session === 'b')
	assert.equal(shape(L.closePane(nested, b.id).root), 'row[a c]')
})

test('closing the focused pane moves the focus to the one that takes its place', T, () => {
	const { layout, ids } = opened('a', 'b', 'c')
	const focused = L.focusPane(layout, ids.b)
	assert.equal(L.closePane(focused, ids.b).focus, ids.c)
	assert.equal(L.closePane(L.focusPane(layout, ids.c), ids.c).focus, ids.b)
	assert.equal(L.closePane(L.focusPane(layout, ids.a), ids.b).focus, ids.a)
})

test('resizing moves one border and keeps the sum at 1; neither neighbour goes under the minimum', T, () => {
	const { layout } = opened('a', 'b')
	const id = layout.root.id
	const moved = L.resize(layout, id, 0, 0.1, 0.2)
	assert.deepEqual(sizes(moved.root), [0.6, 0.4])
	const clamped = L.resize(layout, id, 0, 0.9, 0.2)
	assert.deepEqual(sizes(clamped.root), [0.8, 0.2])
	assert.deepEqual(sizes(L.resize(layout, id, 0, -0.9, 0.2).root), [0.2, 0.8])
	// A bad border, a bad split or a delta that is not a number changes nothing.
	assert.equal(L.resize(layout, id, 1, 0.1, 0.2), layout)
	assert.equal(L.resize(layout, 's999', 0, 0.1, 0.2), layout)
	assert.equal(L.resize(layout, id, 0, NaN, 0.2), layout)
	// Two children that already cannot both reach the minimum stay as they are.
	assert.equal(L.resize(layout, id, 0, 0.1, 0.6), layout)
})

test('maximize and restore: one pane at a time, only with two or more panes, cleared by closing it or splitting', T, () => {
	const { layout, ids } = opened('a', 'b')
	assert.equal(L.maximize(opened('a').layout, opened('a').ids.a).max, undefined)
	const big = L.maximize(layout, ids.a)
	assert.equal(big.max, ids.a)
	assert.equal(L.toggleMaximize(big, ids.a).max, undefined)
	assert.equal(L.toggleMaximize(big, ids.b).max, ids.b)
	assert.equal(L.restore(big).max, undefined)
	assert.equal(L.splitPane(big, ids.a, 'right', c('c')).layout.max, undefined)
	assert.equal(L.closePane(big, ids.a).max, undefined)
	// Closing another pane down to one leaves nothing to maximize.
	assert.equal(L.closePane(big, ids.b).max, undefined)
})

test('the pane cap: no more than 16 panes', T, () => {
	let layout = L.emptyLayout()
	let last
	for (let i = 0; i < 20; i++) {
		const r = i % 2 ? L.splitPane(layout, last, 'bottom', c('n' + i)) : L.openPane(layout, c('n' + i))
		layout = r.layout
		last = r.id ?? last
	}
	assert.equal(L.panes(layout).length, 16)
	assert.equal(L.splitPane(layout, last, 'right', c('x')).id, undefined)
	assert.equal(L.openPane(layout, c('x')).id, undefined)
})

test('focus order: next and previous wrap round', T, () => {
	const { layout, ids } = opened('a', 'b', 'c')
	assert.equal(L.neighbor(layout, ids.a, 1), ids.b)
	assert.equal(L.neighbor(layout, ids.c, 1), ids.a)
	assert.equal(L.neighbor(layout, ids.a, -1), ids.c)
	assert.equal(L.neighbor(layout, undefined, 1), ids.a)
	assert.equal(L.neighbor(layout, undefined, -1), ids.c)
	assert.equal(L.neighbor(L.emptyLayout(), undefined, 1), undefined)
})

test('rects and fits: the gutters are taken off, and a split that would leave a pane too small does not fit', T, () => {
	const { layout, ids } = opened('a', 'b')
	const r = L.rects(layout, 1006, 400)
	assert.deepEqual([r.get(ids.a).w, r.get(ids.b).w, r.get(ids.a).h], [500, 500, 400])
	assert.equal(r.get(ids.b).x, 506)
	assert.ok(L.fits(layout, 1006, 400, 280, 160))
	assert.ok(!L.fits(layout, 500, 400, 280, 160))
	const down = L.splitPane(layout, ids.a, 'bottom', c('c')).layout
	assert.ok(!L.fits(down, 1006, 300, 280, 160))
	assert.ok(L.fits(down, 1006, 400, 280, 160))
})

test('the drop zone: the middle is the centre, anything else the nearest edge', T, () => {
	assert.equal(L.dropZone(400, 300, 200, 150), 'center')
	assert.equal(L.dropZone(400, 300, 10, 150), 'left')
	assert.equal(L.dropZone(400, 300, 390, 150), 'right')
	assert.equal(L.dropZone(400, 300, 200, 5), 'top')
	assert.equal(L.dropZone(400, 300, 200, 295), 'bottom')
	// A corner goes to the nearer edge; a point outside the pane is clamped; an empty rect is the centre.
	assert.equal(L.dropZone(400, 300, 5, 60), 'left')
	assert.equal(L.dropZone(400, 300, -50, 150), 'left')
	assert.equal(L.dropZone(0, 0, 1, 1), 'center')
})

test('a layout survives JSON, and validate gives back an equal one', T, () => {
	let { layout, ids } = opened('a', 'b', 'c')
	layout = L.splitPane(layout, ids.b, 'bottom', c('d', { agent: 'codex', cwd: '/work/app', resume: '0a99a3dd-7db0-4ba0-882d-a4dd922189b1', folder: 'app', peer: 'abc', ext: 'Claude desktop' })).layout
	layout = L.maximize(layout, ids.a)
	const back = L.validate(JSON.parse(JSON.stringify(layout)))
	assert.deepEqual(back, layout)
	assert.deepEqual(L.parse({ seq: 0 }), { seq: 0 })
})

test('untrusted layouts: anything unsound is refused whole, and validate then gives the empty layout', T, () => {
	const pane = (id, over = {}) => ({ type: 'pane', id, content: { kind: 'terminal', agent: 'claude', ...over } })
	const row = (children, sizes, over = {}) => ({ type: 'split', id: 's9', dir: 'row', children, sizes, ...over })
	const bad = [
		undefined, null, 'x', 5, [], {}, { seq: -1 }, { seq: 1.5 }, { seq: 'a' },
		{ seq: 1, root: 'x' },
		{ seq: 1, root: pane('x1') },
		{ seq: 1, root: pane('p1', { kind: 'shell' }) },
		{ seq: 1, root: pane('p1', { agent: 'bard' }) },
		{ seq: 3, root: row([pane('p1'), pane('p1')], [0.5, 0.5]) },
		{ seq: 3, root: row([pane('p1'), pane('p2')], [0.5]) },
		{ seq: 3, root: row([pane('p1'), pane('p2')], [0.5, -0.5]) },
		{ seq: 3, root: row([pane('p1'), pane('p2')], [0.5, 'a']) },
		{ seq: 3, root: row([pane('p1')], [1]) },
		{ seq: 3, root: row([pane('p1'), pane('p2')], [0.5, 0.5], { dir: 'diag' }) },
		{ seq: 3, root: row([pane('p1'), pane('p2')], [0.5, 0.5], { id: 'p1' }) },
		{ seq: 3, root: { type: 'split', id: 's9', dir: 'row', children: 'ab', sizes: [] } },
	]
	for (const raw of bad) {
		assert.equal(L.parse(raw), undefined, JSON.stringify(raw))
		assert.deepEqual(L.validate(raw), { seq: 0 })
	}
	// More than 16 panes, whether flat or as a staircase (the depth limit is the pane cap's, see the staircase test below).
	const many = Array.from({ length: 17 }, (_, i) => pane('p' + (i + 1)))
	assert.equal(L.parse({ seq: 17, root: row(many, many.map(() => 1 / 17)) }), undefined)
	let deep = pane('p1')
	for (let i = 0; i < 16; i++) { deep = { type: 'split', id: 's' + (i + 2), dir: i % 2 ? 'row' : 'col', children: [deep, pane('p' + (i + 20))], sizes: [0.5, 0.5] } }
	assert.equal(L.parse({ seq: 40, root: deep }), undefined)
})

/** The depth of the deepest pane: a lone pane is 0. */
const depthOf = (n, d = 0) => n.type === 'pane' ? d : Math.max(...n.children.map(k => depthOf(k, d + 1)))

test('the depth limit agrees with the pane cap: a staircase of 16 panes (depth 15) is still sound, so it keeps saving', T, () => {
	let layout = L.openPane(L.emptyLayout(), c('n0')).layout
	let last = L.panes(layout)[0].id
	for (let i = 1; i < 16; i++) {
		const r = L.splitPane(layout, last, i % 2 ? 'bottom' : 'right', c('n' + i))
		layout = r.layout
		last = r.id
	}
	assert.equal(L.panes(layout).length, 16)
	assert.equal(depthOf(layout.root), 15)
	const back = L.parse(JSON.parse(JSON.stringify(layout)))
	assert.ok(back, 'a sound layout is not refused for its depth')
	assert.deepEqual(back, layout)
})

test('seq is worked out from the ids, never trusted: a stored seq of 999999 cannot make the next pane id unparseable', T, () => {
	const pane = (id) => ({ type: 'pane', id, content: { kind: 'terminal', agent: 'claude' } })
	const stored = L.parse({ seq: 999999, root: pane('p1') })
	assert.equal(stored.seq, 1)
	// The next ids are the ones the parser takes: opening a pane and saving again works.
	const more = L.openPane(stored, c('b'))
	assert.ok(more.id)
	assert.ok(L.parse(JSON.parse(JSON.stringify(more.layout))))
	// The highest ids parse; a layout that has run out of ids is left as it is, so the successor of an id is always one that parses.
	const high = L.parse({ seq: 1, root: pane('p999997') })
	assert.equal(high.seq, 999997)
	const split = L.splitPane(high, 'p999997', 'right', c('b'))
	assert.ok(split.id, 'two ids are left: the pane\'s and its split\'s')
	assert.deepEqual([split.id, split.layout.root.id], ['p999998', 's999999'])
	assert.deepEqual(L.parse(JSON.parse(JSON.stringify(split.layout))), split.layout, 'the highest layout a split can make still saves')
	assert.equal(L.splitPane(split.layout, split.id, 'bottom', c('c')).id, undefined, 'out of ids: nothing happens')
	assert.equal(L.openPane(split.layout, c('c')).id, undefined)
	assert.equal(L.movePane(split.layout, 'p999997', split.id, 'left'), split.layout, 'an edge move needs a split of its own')
	assert.notEqual(L.movePane(split.layout, 'p999997', split.id, 'center'), split.layout, 'a swap makes no id')
	// A malformed seq is still a malformed layout.
	assert.equal(L.parse({ seq: 1e9, root: pane('p1') }), undefined)
})

test('towards: the pane next to this one in a direction, by where the panes sit', T, () => {
	// a | (b over c) | d  as a row of three, the middle one a column.
	const { layout: row3, ids } = opened('a', 'b', 'd')
	const withC = L.splitPane(row3, ids.b, 'bottom', c('c'))
	const layout = withC.layout
	const cid = withC.id
	const W = 1000, H = 600
	assert.equal(L.towards(layout, ids.a, 'right', W, H), ids.b, 'from the left pane, the upper of the two (it holds the left pane\'s top half too)')
	assert.equal(L.towards(layout, ids.b, 'left', W, H), ids.a)
	assert.equal(L.towards(layout, cid, 'left', W, H), ids.a)
	assert.equal(L.towards(layout, ids.b, 'down', W, H), cid)
	assert.equal(L.towards(layout, cid, 'up', W, H), ids.b)
	assert.equal(L.towards(layout, cid, 'right', W, H), ids.d)
	assert.equal(L.towards(layout, ids.d, 'left', W, H), ids.b, 'the pane that shares the most edge, the upper on a tie')
	// Nothing beyond the edge: no wrapping, no answer.
	assert.equal(L.towards(layout, ids.a, 'left', W, H), undefined)
	assert.equal(L.towards(layout, ids.d, 'right', W, H), undefined)
	assert.equal(L.towards(layout, ids.a, 'up', W, H), undefined)
	assert.equal(L.towards(layout, ids.b, 'up', W, H), undefined)
	assert.equal(L.towards(layout, cid, 'down', W, H), undefined)
	// A pane that is not there, a lone pane and a direction that is none.
	assert.equal(L.towards(layout, 'p99', 'right', W, H), undefined)
	assert.equal(L.towards(opened('a').layout, opened('a').ids.a, 'right', W, H), undefined)
	assert.equal(L.towards(layout, ids.a, 'sideways', W, H), undefined)
	// The size only decides how much the gutters take: an unusable one still gives the same answer.
	assert.equal(L.towards(layout, ids.a, 'right', 0, 0), ids.b)
})

test('towards: of two panes beside it, the one that faces the most of it wins; a pane that only touches at a corner is not beside it', T, () => {
	// a is tall on the left; on the right b is small on top and c large below.
	let { layout, ids } = opened('a', 'b')
	const c1 = L.splitPane(layout, ids.b, 'bottom', c('c'))
	// The column on the right holds b over c: its border moves up, so b gets a fifth of the height and c the rest.
	layout = L.resize(c1.layout, c1.layout.root.children[1].id, 0, -0.3, 0.1)
	assert.equal(L.towards(layout, ids.a, 'right', 1000, 600), c1.id, 'c faces more of a than b does')
	assert.equal(L.towards(layout, c1.id, 'left', 1000, 600), ids.a)
	// A diagonal pane is not a neighbour: from the top-left pane of a 2x2 grid, down is the one under it, not the far corner.
	let g = opened('a', 'b').layout
	const [pa, pb] = L.panes(g).map(p => p.id)
	g = L.splitPane(g, pa, 'bottom', c('c')).layout
	g = L.splitPane(g, pb, 'bottom', c('d')).layout
	const [ga, gc, gb, gd] = ['a', 'c', 'b', 'd'].map(n => L.panes(g).find(p => p.content.session === n).id)
	assert.equal(L.towards(g, ga, 'down', 1000, 600), gc)
	assert.equal(L.towards(g, ga, 'right', 1000, 600), gb)
	assert.equal(L.towards(g, gd, 'up', 1000, 600), gb)
	assert.equal(L.towards(g, gd, 'left', 1000, 600), gc)
})

test('what validation keeps: sizes normalised, strings capped, extra keys dropped, a stale focus or maximized pane forgotten, seq never below an id', T, () => {
	const raw = {
		seq: 1, focus: 'p77', max: 'p88', evil: '<img onerror=x>',
		root: { type: 'split', id: 's4', dir: 'col', sizes: [0.2, 0.2], extra: 1, children: [
			{ type: 'pane', id: 'p2', content: { kind: 'transcript', agent: 'codex', title: 'T', session: 'x'.repeat(201), cwd: 'a\0b', ext: 'x'.repeat(81), bogus: 1 } },
			{ type: 'pane', id: 'p3', content: { kind: 'terminal', agent: 'custom', title: 'x'.repeat(200) } },
		] },
	}
	const out = L.parse(raw)
	assert.deepEqual(out.root.sizes, [0.5, 0.5])
	assert.equal(out.seq, 4)
	assert.equal(out.focus, undefined)
	assert.equal(out.max, undefined)
	assert.equal('evil' in out, false)
	assert.equal('extra' in out.root, false)
	assert.deepEqual(out.root.children[0].content, { kind: 'transcript', agent: 'codex', title: 'T' })
	assert.equal(out.root.children[1].content.title.length, 200)
	// A good focus and maximized pane stay.
	assert.equal(L.parse({ ...raw, focus: 'p2', max: 'p3' }).max, 'p3')
})

test('names of saved layouts: trimmed, one line, 1 to 60 characters', T, () => {
	assert.equal(L.layoutName('  Review  '), 'Review')
	assert.equal(L.layoutName(''), undefined)
	assert.equal(L.layoutName('   '), undefined)
	assert.equal(L.layoutName('a\nb'), undefined)
	assert.equal(L.layoutName('x'.repeat(61)), undefined)
	assert.equal(L.layoutName('x'.repeat(60)).length, 60)
	assert.equal(L.layoutName(5), undefined)
})

test('the module\'s source text runs on its own in a bare context, as the page uses it', T, () => {
	const source = L.paneLayoutModule.toString()
	assert.doesNotMatch(source, /\bimport\b|\brequire\b/)
	const bare = vm.runInNewContext(`(${source})()`, { Math, Object, isFinite, JSON, Set, Map, Number, Array })
	const a = bare.openPane(bare.emptyLayout(), c('a'))
	const b = bare.splitPane(a.layout, a.id, 'bottom', c('b'))
	assert.equal(shape(b.layout.root), 'col[a b]')
	assert.deepEqual(JSON.parse(JSON.stringify(bare.validate(b.layout))), JSON.parse(JSON.stringify(b.layout)))
})
