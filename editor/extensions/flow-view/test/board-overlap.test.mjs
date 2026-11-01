// What draw_board and update_board tell the agent about boxes the layout puts on top of each other (src/board/overlap.ts), and
// that its copy of the canvas's nudge (ui/src/board/overlap.ts) cannot drift from the original.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let host, canvas
before(async () => {
	host = await load('src/board/overlap.ts')
	canvas = await load('../../../ui/src/board/overlap.ts')
})
after(cleanup)

const node = (id, label = id, extra = {}) => ({ id, label, ...extra })
const board = (extra = {}) => ({ version: 1, kind: 'flow', title: 'T', nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }], ...extra })

test('undefined, a board with no callouts, and a sequence board give nothing', () => {
	assert.deepEqual(host.checkOverlap(undefined), [])
	assert.deepEqual(host.checkOverlap(board()), [])
	assert.deepEqual(host.checkOverlap(board({ kind: 'sequence', callouts: [{ node: 'a', text: 'x' }, { node: 'a', text: 'y' }] })), [])
})

test('one callout per node, well apart: nothing to report', () => {
	assert.deepEqual(host.checkOverlap(board({ callouts: [{ node: 'a', text: 'First' }, { node: 'b', text: 'Second' }] })), [])
})

test('two callouts on one node: the later one is moved, named by the node label', () => {
	const lines = host.checkOverlap(board({ nodes: [node('a', 'API gateway'), node('b')], callouts: [{ node: 'a', text: 'Retries twice' }, { node: 'a', text: 'Idempotent' }] }))
	assert.equal(lines.length, 1)
	assert.match(lines[0], /^moved callout on 'API gateway' \d+px (right|up) off (callout on 'API gateway'|'API gateway')$/)
})

test('a callout on an edge that reaches over the card at its end is moved off that card', () => {
	// The edge's midpoint is in the 84px gap between the cards and a bubble is 188 wide, so it lands on the next card.
	const spec = board({ nodes: [node('a'), node('b', 'Cache')], callouts: [{ edge: ['a', 'b'], text: 'sync, with a short note' }] })
	const lines = host.checkOverlap(spec)
	assert.equal(lines.length, 1)
	assert.match(lines[0], /^moved callout on 'a' to 'Cache' \d+px (right|up) off 'Cache'$/)
})

test('a node crowded with callouts leaves some that still overlap, and says so', () => {
	const callouts = Array.from({ length: 14 }, (_, i) => ({ node: 'a', text: `Note number ${i}` }))
	const lines = host.checkOverlap(board({ callouts }))
	assert.ok(lines.some(l => l === "callout on 'a' and callout on 'a' still overlap: give them more room"), lines.join('\n'))
	assert.ok(lines.length <= 7)
})

test('lines are short, deterministic and truncate long labels to 24 characters', () => {
	const spec = board({ nodes: [node('a', 'The extremely long name of a service'), node('b')], callouts: [{ node: 'a', text: 'one' }, { node: 'a', text: 'two' }] })
	const first = host.checkOverlap(spec)
	assert.deepEqual(host.checkOverlap(JSON.parse(JSON.stringify(spec))), first)
	assert.match(first[0], /callout on 'The extremely long name…'/)
})

test('a callout on a folded node or a missing edge is left out, like the canvas', () => {
	const spec = board({
		nodes: [node('a'), node('b'), node('x', 'X', { group: 'g' })],
		groups: [{ id: 'g', label: 'Pkg', collapsed: true }],
		callouts: [{ node: 'x', text: 'folded' }, { node: 'x', text: 'folded too' }, { edge: ['b', 'a'], text: 'no such edge' }],
	})
	const lines = host.checkOverlap(spec)
	assert.ok(lines.every(l => l.includes("'Pkg'")), lines.join('\n'))
})

test('more than six lines: six, then a count', () => {
	const nodes = Array.from({ length: 9 }, (_, i) => node(`n${i}`, `Node ${i}`))
	const callouts = nodes.flatMap(n => [{ node: n.id, text: 'First note' }, { node: n.id, text: 'Second note' }])
	const lines = host.checkOverlap({ version: 1, kind: 'flow', title: 'T', nodes, edges: [], callouts })
	assert.equal(lines.length, 7)
	assert.match(lines[6], /^\.\.\.and \d+ more$/)
	assert.deepEqual(host.checkOverlap({ version: 1, kind: 'flow', title: 'T', nodes, edges: [], callouts }), lines)
})

// Fixtures both copies must answer identically: a hand-made list covers the corners, a seeded random set the rest.
const fixtures = () => {
	const box = (id, x, y, w = 100, h = 50) => ({ id, x, y, w, h })
	const list = [
		[box('a', 0, 0), box('b', 200, 0)],
		[box('a', 0, 0), box('b', 0, 40)],
		[box('a', 0, 0), box('b', 90, 0)],
		[box('a', 0, 0), box('c', 0, 58), box('b', 0, 40)],
		[box('card', 0, 0), box('a', 0, -70), box('b', 0, -70), box('c', 0, -70)],
		[box('a', 0, 0), box('b', 96, 10)],
	]
	let seed = 7
	const rand = n => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * n
	for (let k = 0; k < 40; k++) {
		list.push(Array.from({ length: 3 + (k % 8) }, (_, i) => box(`b${i}`, Math.round(rand(300)), Math.round(rand(200)), 60 + Math.round(rand(140)), 30 + Math.round(rand(60)))))
	}
	return list
}

test('host and canvas nudgeApart give identical results on shared fixtures', () => {
	let nudged = 0
	for (const input of fixtures()) {
		for (const opts of [undefined, { fixed: 1 }, { fixed: 2, gap: 12, tolerance: 0 }, { fixed: 1, axes: ['right', 'up'] }, { axes: ['left', 'down', 'up'] }]) {
			const copy = JSON.parse(JSON.stringify(input))
			const mine = host.nudgeApart(input, opts)
			assert.deepEqual(mine, canvas.nudgeApart(input, opts))
			assert.deepEqual(input, copy, 'the input is not changed')
			nudged += mine.moves.length
		}
	}
	assert.ok(nudged > 20, 'the fixtures do exercise moves')
})
