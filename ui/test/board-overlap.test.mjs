// The overlap nudge of the board canvas (src/board/overlap.ts) and the callout bubbles that use it (src/board/callouts.tsx).
// Pure, run under plain Node (`npm test` in ui/); callouts.tsx is JSX, so it is bundled with vite first.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import { nudgeApart } from '../src/board/overlap.ts'

const box = (id, x, y, w = 100, h = 50) => ({ id, x, y, w, h })
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

test('no overlap: the boxes come back unchanged, with no moves', () => {
  const input = [box('a', 0, 0), box('b', 200, 0), box('c', 0, 100)]
  const r = nudgeApart(input)
  assert.deepEqual(r.boxes, input)
  assert.deepEqual(r.moves, [])
  assert.deepEqual(r.stuck, [])
})

test('overlap within the tolerance is ignored, more than it is not', () => {
  const touching = nudgeApart([box('a', 0, 0), box('b', 96, 10)])
  assert.deepEqual(touching.moves, [], '4px of overlap on one axis is fine')
  const both = nudgeApart([box('a', 0, 0), box('b', 90, 40)])
  assert.equal(both.moves.length, 1, '10px on both axes is moved')
  assert.deepEqual(nudgeApart([box('a', 0, 0), box('b', 90, 40)], { tolerance: 12 }).moves, [])
})

test('the shorter way out wins: down when the overlap is flat, right when it is tall', () => {
  // 100 wide, 10 deep overlap: down by 10 + gap beats right by 100 + gap.
  const flat = nudgeApart([box('a', 0, 0), box('b', 0, 40)])
  assert.deepEqual(flat.moves, [{ id: 'b', dx: 0, dy: 18, off: 'a' }])
  assert.deepEqual(flat.boxes[1], box('b', 0, 58))
  // 10 wide, 50 deep overlap: right by 10 + gap.
  const tall = nudgeApart([box('a', 0, 0), box('b', 90, 0)])
  assert.deepEqual(tall.moves, [{ id: 'b', dx: 18, dy: 0, off: 'a' }])
  assert.deepEqual(nudgeApart([box('a', 0, 0), box('b', 90, 0)], { gap: 20 }).moves[0].dx, 30)
})

test('a move that would land on another box tries the other axis', () => {
  // b overlaps a and would go down (shorter) onto c; right is free.
  const r = nudgeApart([box('a', 0, 0), box('c', 0, 58), box('b', 0, 40)])
  const b = r.boxes.find(x => x.id === 'b')
  assert.deepEqual(r.moves, [{ id: 'b', dx: 100 + 8, dy: 0, off: 'a' }])
  assert.ok(!hit(b, r.boxes[0]) && !hit(b, r.boxes[1]))
})

test('a third box on the same spot slides on past the second instead of giving up', () => {
  const r = nudgeApart([box('card', 0, 0), box('a', 0, -70), box('b', 0, -70), box('c', 0, -70)], { fixed: 1 })
  assert.deepEqual(r.stuck, [])
  for (let i = 0; i < r.boxes.length; i++) for (let j = i + 1; j < r.boxes.length; j++) assert.ok(!hit(r.boxes[i], r.boxes[j]), `${r.boxes[i].id} / ${r.boxes[j].id}`)
})

test('a pair with no free spot is reported and left where it was', () => {
  // Eight fixed columns, each landing spot (the gap after one) falls on the next: more hops than a slide takes.
  const columns = Array.from({ length: 8 }, (_, i) => box(`w${i}`, i * 108, 0, 100, 200))
  const input = [...columns, box('x', 30, 30)]
  const r = nudgeApart(input, { fixed: columns.length, axes: ['right'] })
  assert.deepEqual(r.moves, [])
  assert.deepEqual(r.stuck, [['w0', 'x']])
  assert.deepEqual(r.boxes[r.boxes.length - 1], box('x', 30, 30))
})

test('axes: up and left move the later box the other way, the shortest of the given ones wins', () => {
  // b sits over a's lower edge: up clears it by 80 + gap, right would need 90 + gap.
  const up = nudgeApart([box('a', 0, 0), box('b', 10, 30)], { axes: ['right', 'up'] })
  assert.deepEqual(up.moves, [{ id: 'b', dx: 0, dy: -88, off: 'a' }])
  assert.deepEqual(up.boxes[1], box('b', 10, -58))
  const left = nudgeApart([box('a', 100, 0), box('b', 60, 10, 100, 20)], { axes: ['left'] })
  assert.deepEqual(left.moves, [{ id: 'b', dx: -68, dy: 0, off: 'a' }])
})

test('fixed boxes never move, even when they overlap each other', () => {
  const r = nudgeApart([box('a', 0, 0), box('b', 10, 10), box('c', 5, 5)], { fixed: 2 })
  assert.deepEqual(r.boxes.slice(0, 2), [box('a', 0, 0), box('b', 10, 10)])
  assert.deepEqual(r.moves.map(m => m.id), ['c'])
  assert.deepEqual(r.stuck, [])
})

test('the input is not changed and the same input always gives the same answer', () => {
  const input = [box('a', 0, 0), box('b', 20, 20), box('c', 40, 10), box('d', 300, 300)]
  const copy = JSON.parse(JSON.stringify(input))
  const first = nudgeApart(input)
  assert.deepEqual(input, copy)
  assert.deepEqual(nudgeApart(input), first)
  assert.deepEqual(nudgeApart(JSON.parse(JSON.stringify(input))), first)
  // The order given decides who moves: reversed, a different box moves.
  const reversed = nudgeApart([...input].reverse())
  assert.notDeepEqual(reversed.moves.map(m => m.id), first.moves.map(m => m.id))
})

test('running it on its own output changes nothing', () => {
  const input = [box('a', 0, 0), box('b', 20, 20), box('c', 40, 10), box('d', 60, 30), box('e', 300, 300)]
  const once = nudgeApart(input)
  const twice = nudgeApart(once.boxes)
  assert.deepEqual(twice.boxes, once.boxes)
  assert.deepEqual(twice.moves, [])
})

// placeBubbles: bundled once, the board built by hand (the layout's own fields are all it reads).
let tmp, callouts
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ui-overlap-'))
  const root = resolve(import.meta.dirname, '..')
  const out = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: { ssr: join(root, 'src/board/callouts.tsx'), write: false, minify: false, rollupOptions: { output: { format: 'esm' } } },
  })
  const code = (Array.isArray(out) ? out[0] : out).output[0].code
  writeFileSync(join(tmp, 'callouts.mjs'), code)
  callouts = await import(pathToFileURL(join(tmp, 'callouts.mjs')).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const vnode = (id, x, y, w = 168, h = 60) => ({ id, box: { x, y, w, h }, rel: { x, y }, rows: [], more: 0, node: { id, label: id } })
const layoutOf = (nodes, calls) => ({ nodes, groups: [], edges: [], bounds: { x: 0, y: 0, w: 1000, h: 1000 }, rep: new Map(), callouts: calls })
const noOverlap = list => {
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(!hit(list[i], list[j]), `box ${i} overlaps box ${j}`)
}

test('placeBubbles: a callout with nothing near it keeps the place it always had', () => {
  const l = layoutOf([vnode('a', 400, 400)], [{ text: 'Retries twice', node: 'a' }])
  const [b] = callouts.placeBubbles(l, 'LR')
  assert.deepEqual(b.box, { x: 400 + 168 - 10 + 16, y: 400 - 25 - 14, w: 188, h: 25 })
})

test('placeBubbles: two callouts on one node do not overlap each other or the card', () => {
  const l = layoutOf([vnode('a', 400, 400)], [{ text: 'Retries twice, then dead-letters the message', node: 'a' }, { text: 'Idempotent by key', node: 'a' }, { text: 'A third note on the same spot', node: 'a' }])
  const bubbles = callouts.placeBubbles(l, 'LR')
  assert.equal(bubbles.length, 3)
  noOverlap([l.nodes[0].box, ...bubbles.map(b => b.box)])
})

test('placeBubbles: a callout that reaches over a neighbouring card is moved off it', () => {
  // b sits where a's callout (above-right of a) would land.
  const a = vnode('a', 400, 400)
  const b = vnode('b', 600, 330, 168, 60)
  const l = layoutOf([a, b], [{ text: 'Over the neighbour', node: 'a' }])
  const [bubble] = callouts.placeBubbles(l, 'LR')
  assert.ok(!hit(bubble.box, b.box) && !hit(bubble.box, a.box))
  assert.ok(bubble.box.x > a.box.x + a.box.w - 10 + 16 || bubble.box.y < 400 - 25 - 14, 'it moved right or up')
  // Same layout, same answer.
  assert.deepEqual(callouts.placeBubbles(l, 'LR'), [bubble])
})
