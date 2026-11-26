// The reading pane's model, with no Monaco and no DOM: stepping, paths that outlive a re-trace, the pane's keys, what "Keep this
// path" keeps, where peeks sit and which cards the canvas fades. Pure, run under plain Node (`npm test` in ui/).
// Every rule test is named `flow-reading/RCnn …` (docs/plans/flow-reading.md).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROOT,
  chainOf,
  indexFlow,
  initialPane,
  isEditorInput,
  into,
  keepPlan,
  lineTop,
  markKept,
  out,
  over,
  paneKey,
  paneShown,
  peekDiff,
  readAt,
  retrace,
  startReading,
  togglePeek,
  topOf,
  traceOf,
  zoneTops,
} from '../src/read/model.ts'

// ---- a small flow in the shape of the demo's POST /orders -------------------------------------------------------------
const edge = (node, callLine, edgeKind = 'call') => ({ callLine, edgeKind, node })
let seq = 0
const method = (label, startLine, children = [], extra = {}) => ({
  key: `p${seq++}`,
  symbolId: null,
  label,
  sub: '',
  kind: 'method',
  file: `/demo/${label.split('.')[0]}.java`,
  startLine,
  endLine: startLine + 12,
  code: 'code',
  children,
  ...extra,
})
const table = () => method('orders', 1, [], { kind: 'db', code: null, file: null })
const diff = (extra = {}) => ({ added: [1], removed: [], plus: 1, minus: 0, ...extra })

/** ctl place (:15-27, calls the service at :20) -> OrderService.place (:21-33, calls a table :23, createInvoice :24, announce :25). */
function demo({ shift = 0 } = {}) {
  seq = shift
  const createInvoiceHttp = method('create_invoice', 11, [], { file: '/demo/billing/app/main.py' })
  const createInvoice = method('BillingClient.createInvoice', 18, [edge(createInvoiceHttp, 20, 'http')])
  const announce = method('OrderService.announce', 40)
  const orders = table()
  const svc = method('OrderService.place', 21, [edge(orders, 23, 'db'), edge(createInvoice, 24), edge(announce, 25)], { file: '/demo/OrderService.java' })
  const ctl = method('OrderController.place', 15, [edge(svc, 20)], { file: '/demo/OrderController.java' })
  return { ctl, svc, orders, createInvoice, createInvoiceHttp, announce }
}

const at = (idx, node) => idx.pathOf(node.key)

// ---- RC04 stepping ---------------------------------------------------------------------------------------------------
test('flow-reading/RC04 into opens the callee under the call as a peek and puts the cursor on its first call', () => {
  const { ctl, svc } = demo()
  const idx = indexFlow(ctl, null)
  const r = into(startReading(idx, ROOT), idx)
  assert.deepEqual(r.open, [at(idx, svc)])
  assert.equal(r.cursor.path, at(idx, svc))
  assert.equal(r.cursor.line, 23, 'the callee is read from its first call')
  assert.equal(topOf(r), ROOT, 'a peek leaves the top alone')
})

test('flow-reading/RC04 into a callee without code opens its peek and the cursor stays', () => {
  const { ctl, svc, orders } = demo()
  const idx = indexFlow(ctl, null)
  let r = into(startReading(idx, ROOT), idx)
  assert.equal(r.cursor.line, 23)
  r = into(r, idx)
  assert.deepEqual(r.open, [at(idx, svc), at(idx, orders)])
  assert.deepEqual([r.cursor.path, r.cursor.line], [at(idx, svc), 23])
})

test('flow-reading/RC04 over past the last call closes the peek and lands on the caller\'s calling line; at the top it stays', () => {
  const { ctl, svc } = demo()
  const idx = indexFlow(ctl, null)
  let r = into(startReading(idx, ROOT), idx)
  r = over(over(r, idx), idx) // :23 -> :24 -> :25
  assert.deepEqual([r.cursor.path, r.cursor.line, r.open.length], [at(idx, svc), 25, 1], 'on the last call, the peek still open')
  r = over(r, idx)
  assert.deepEqual(r.open, [], 'the peek is closed')
  assert.deepEqual([r.cursor.path, r.cursor.line], [ROOT, 20], 'the top has no next call: the cursor stays on the calling line')
  assert.deepEqual(over(r, idx).cursor, r.cursor, 'and stays there')
  assert.ok(at(idx, svc))
})

test('flow-reading/RC04 over at the last call of a callee goes on to the caller\'s next call', () => {
  const a = method('A.a', 50)
  const b = method('B.b', 60)
  const inner = method('C.inner', 70)
  const top = method('T.top', 10, [edge(a, 12), edge(b, 14)])
  a.children.push(edge(inner, 52))
  const idx = indexFlow(top, null)
  let r = startReading(idx, ROOT)
  assert.equal(r.cursor.line, 12)
  r = into(r, idx)
  assert.deepEqual([r.cursor.path, r.cursor.line], [at(idx, a), 52])
  r = over(r, idx)
  assert.deepEqual(r.open, [], 'a is left')
  assert.deepEqual([r.cursor.path, r.cursor.line], [ROOT, 14], 'the next call of the caller')
})

test('flow-reading/RC04 into on a line without a call is over', () => {
  const { ctl } = demo()
  const idx = indexFlow(ctl, null)
  const start = startReading(idx, ROOT)
  const r = into({ ...start, cursor: { path: ROOT, line: 18, k: 0 } }, idx)
  assert.deepEqual([r.cursor.path, r.cursor.line, r.open.length], [ROOT, 20, 0])
})

test('flow-reading/RC04 into past the second peek takes the callee to the top with the chain above it; out at the top reads the caller', () => {
  const { ctl, svc, createInvoice, createInvoiceHttp } = demo()
  const idx = indexFlow(ctl, null)
  let r = into(startReading(idx, ROOT), idx) // peek svc
  r = over(r, idx) // :24, createInvoice
  r = into(r, idx) // peek createInvoice, depth 2
  assert.deepEqual(r.open, [at(idx, svc), at(idx, createInvoice)])
  assert.deepEqual([r.cursor.path, r.cursor.line], [at(idx, createInvoice), 20])
  r = into(r, idx)
  assert.equal(topOf(r), at(idx, createInvoiceHttp), 'the callee takes the top')
  assert.deepEqual(r.open, [])
  assert.equal(r.cursor.line, 11)
  assert.deepEqual(chainOf(idx, topOf(r)).map(c => `${c.name}:${c.line}`), ['place:20', 'place:24', 'createInvoice:20'])
  r = out(r, idx)
  assert.equal(topOf(r), at(idx, createInvoice), 'out reads the caller')
  assert.deepEqual([r.cursor.path, r.cursor.line], [at(idx, createInvoice), 20], 'with the cursor on the calling line')
})

test('flow-reading/RC04 out of a peek closes it and returns to the calling line; at the top without a caller it stays', () => {
  const { ctl, svc } = demo()
  const idx = indexFlow(ctl, null)
  let r = into(startReading(idx, ROOT), idx)
  r = out(r, idx)
  assert.deepEqual(r.open, [])
  assert.deepEqual([r.cursor.path, r.cursor.line], [ROOT, 20])
  assert.deepEqual(out(r, idx), r, 'at the top with no caller nothing moves')
  assert.ok(at(idx, svc))
})

test('flow-reading/RC04 several callees on one line are visited in order before the next line', () => {
  const a = method('A.a', 50)
  const b = method('B.b', 60)
  const top = method('T.top', 10, [edge(a, 12), edge(b, 12), edge(method('C.c', 70), 14)])
  const idx = indexFlow(top, null)
  let r = startReading(idx, ROOT)
  assert.deepEqual([r.cursor.line, r.cursor.k], [12, 0])
  r = into(r, idx)
  assert.equal(r.cursor.path, at(idx, a), 'into enters the first callee')
  r = out(r, idx)
  assert.deepEqual([r.cursor.path, r.cursor.line, r.cursor.k, r.open.length], [ROOT, 12, 0, 0], 'back on the line')
  r = over(r, idx)
  assert.deepEqual([r.cursor.line, r.cursor.k], [12, 1], 'then the second callee')
  r = into(r, idx)
  assert.equal(r.cursor.path, at(idx, b))
  r = out(r, idx)
  r = over(r, idx)
  assert.deepEqual([r.cursor.line, r.cursor.k], [14, 0], 'then the next line')
})

test('flow-reading/RC04 Enter toggles the peek under the cursor without moving the cursor', () => {
  const { ctl, svc } = demo()
  const idx = indexFlow(ctl, null)
  let r = togglePeek(startReading(idx, ROOT), idx)
  assert.deepEqual([r.open, r.cursor.path, r.cursor.line], [[at(idx, svc)], ROOT, 20])
  r = togglePeek(r, idx)
  assert.deepEqual(r.open, [])
})

// ---- RC05 paths outlive a re-trace --------------------------------------------------------------------------------------
test('flow-reading/RC05 a method keeps its place when a call added earlier moves every key', () => {
  const before = demo()
  const idxB = indexFlow(before.ctl, null)
  let r = readAt(startReading(idxB, ROOT), idxB, at(idxB, before.createInvoice))
  // The same flow with one more call at the front of the controller: every key after it is one higher.
  const after = demo({ shift: 1 })
  after.ctl.children.unshift(edge(method('Audit.log', 90), 16))
  const idxA = indexFlow(after.ctl, null)
  assert.notEqual(after.createInvoice.key, before.createInvoice.key)
  r = retrace(r, idxB, idxA, ROOT)
  assert.equal(idxA.keyOf(topOf(r)), after.createInvoice.key, 'still createInvoice, under its new key')
  assert.equal(idxA.node(topOf(r)).label, 'BillingClient.createInvoice')
})

test('flow-reading/RC05 line numbers move on Undo and the cursor follows its call', () => {
  const before = demo()
  before.announce.startLine = 54
  before.announce.children = [edge(method('Mail.send', 70), 55)]
  const idxB = indexFlow(before.ctl, null)
  let r = readAt(startReading(idxB, ROOT), idxB, at(idxB, before.announce))
  assert.deepEqual([r.cursor.line, idxB.node(topOf(r)).startLine], [55, 54])
  const after = demo()
  after.announce.startLine = 45
  after.announce.children = [edge(method('Mail.send', 70), 46)]
  const idxA = indexFlow(after.ctl, null)
  r = retrace(r, idxB, idxA, ROOT)
  assert.equal(idxA.node(topOf(r)).label, 'OrderService.announce')
  assert.equal(r.cursor.line, 46, 'on its call, now line 46')
})

test('flow-reading/RC05 a peek whose call was removed is gone and the cursor is back on its caller', () => {
  const before = demo()
  const discount = method('OrderService.applyDiscount', 60)
  before.svc.children.unshift(edge(discount, 22))
  before.svc.startLine = 21
  const idxB = indexFlow(before.ctl, null)
  let r = readAt(startReading(idxB, ROOT), idxB, at(idxB, before.svc))
  r = into(r, idxB) // peek applyDiscount (the first call, :22)
  assert.deepEqual(r.open, [at(idxB, discount)])
  assert.equal(r.cursor.path, at(idxB, discount))
  const after = demo()
  const idxA = indexFlow(after.ctl, null)
  r = retrace(r, idxB, idxA, ROOT)
  assert.deepEqual(r.open, [], 'the peek is gone')
  assert.equal(idxA.keyOf(r.cursor.path), after.svc.key, 'the cursor is on place')
  assert.equal(idxA.keyOf(topOf(r)), after.svc.key)
})

/** A caller whose code has these lines: `lines` maps a file line to its text. */
const withLines = (m, lines) => {
  const last = Math.max(m.endLine, ...Object.keys(lines).map(Number))
  m.code = Array.from({ length: last - m.startLine + 1 }, (_, i) => lines[m.startLine + i] ?? '  x;').join('\n')
  return m
}

test('flow-reading/RC05 a removed call peek does not move to the next call of the same method: the call text is part of the path', () => {
  const log = () => method('Audit.log', 40)
  const before = withLines(method('Ctl.place', 15, [edge(log(), 20), edge(log(), 22)]), { 20: '  audit.log(first);', 22: '  audit.log(second);' })
  const ib = indexFlow(before, null)
  let r = into(startReading(ib, ROOT), ib)
  assert.equal(ib.parent(r.open[0]).edge.callLine, 20)
  // The first call was removed; the second moved up a line and is the only one left.
  const after = withLines(method('Ctl.place', 15, [edge(log(), 21)]), { 21: '  audit.log(second);' })
  const ia = indexFlow(after, null)
  r = retrace(r, ib, ia)
  assert.deepEqual(r.open, [], 'the peek is gone: its call text no longer exists')
  assert.equal(r.cursor.path, ROOT)
  // A line that only moved is the same call, and an overload with another argument is another one.
  const moved = withLines(method('Ctl.place', 15, [edge(log(), 25), edge(log(), 27)]), { 25: '  audit.log(first);', 27: '  audit.log(second);' })
  const im = indexFlow(moved, null)
  assert.notEqual(im.pathOf(moved.children[0].node.key), im.pathOf(moved.children[1].node.key))
  const kept = retrace(into(startReading(ib, ROOT), ib), ib, im)
  assert.deepEqual(kept.open.map(p => im.parent(p).edge.callLine), [25], 'the peek follows its call to the line it moved to')
})

test('flow-reading/RC05 the same method reached twice has a path for each occurrence', () => {
  const shared = (key) => method('Util.helper', 80, [], { key })
  const top = method('T.top', 10, [edge(shared('x1'), 12), edge(shared('x2'), 14)])
  const idx = indexFlow(top, null)
  const p1 = idx.pathOf('x1')
  const p2 = idx.pathOf('x2')
  assert.notEqual(p1, p2)
  let r = readAt(startReading(idx, ROOT), idx, p2)
  // Re-traced with the first call gone: only one occurrence is left, and it is the first one now; the reading was on the second.
  const after = method('T.top', 10, [edge(shared('y1'), 14)])
  r = retrace(r, idx, indexFlow(after, null), ROOT)
  assert.equal(topOf(r), ROOT, 'the second occurrence no longer exists: the pane reads the entry')
  // And while both exist, each one's walked mark is its own.
  const r2 = readAt(startReading(idx, ROOT), idx, p1)
  assert.ok(r2.walked.includes(p1) && !r2.walked.includes(p2))
})

test('flow-reading/RC05 a method that left the flow sends the pane to the entry, with history and walked set pruned', () => {
  const before = demo()
  const idxB = indexFlow(before.ctl, null)
  let r = readAt(readAt(startReading(idxB, ROOT), idxB, at(idxB, before.svc)), idxB, at(idxB, before.createInvoice))
  const after = demo()
  after.svc.children = after.svc.children.filter(e => e.node.label !== 'BillingClient.createInvoice')
  const idxA = indexFlow(after.ctl, null)
  r = retrace(r, idxB, idxA, ROOT)
  assert.equal(topOf(r), ROOT)
  assert.deepEqual(r.history, [ROOT])
  assert.equal(r.walked.every(p => idxA.node(p)), true)
})

test('flow-reading/RC05 history and walked paths that still exist stay, the others are dropped', () => {
  const before = demo()
  const idxB = indexFlow(before.ctl, null)
  let r = readAt(readAt(startReading(idxB, ROOT), idxB, at(idxB, before.svc)), idxB, at(idxB, before.announce))
  assert.equal(r.history.length, 3)
  const after = demo()
  after.svc.children = after.svc.children.filter(e => e.node.label !== 'BillingClient.createInvoice')
  r = retrace(r, idxB, indexFlow(after.ctl, null), ROOT)
  assert.equal(r.history.length, 3, 'nothing read was removed')
  assert.equal(r.at, 2)
})

// ---- RC02 Keep this path -------------------------------------------------------------------------------------------------
/** OrderService.java holds place and applyDiscount, both changed; the controller and billing are unchanged. */
function review() {
  const f = demo()
  const discount = method('OrderService.applyDiscount', 60, [], { file: '/demo/OrderService.java', diff: diff() })
  f.svc.diff = diff()
  f.svc.children.unshift(edge(discount, 22))
  return { ...f, discount }
}
const summary = (f, r, idx) => keepPlan(idx, r)
const brief = p => ({ keys: p.targets.map(t => `${t.via ?? 'keepCard'}:${t.key}`), count: `${p.kept} of ${p.total}` })

test('flow-reading/RC02 with one of two changed methods of a file open, Keep this path keeps that method\'s own lines', () => {
  const f = review()
  const idx = indexFlow(f.ctl, null)
  const r = readAt(startReading(idx, ROOT), idx, at(idx, f.svc))
  const plan = summary(f, r, idx)
  assert.deepEqual(brief(plan), { keys: [`keepCard:${f.svc.key}`], count: '0 of 1' })
  assert.deepEqual([plan.targets[0].file, plan.targets[0].startLine, plan.targets[0].endLine], [f.svc.file, f.svc.startLine, f.svc.endLine])
  // After it ran the host sends the flow again: place no longer carries a change, and it is counted as kept; applyDiscount is still pending.
  f.svc.diff = undefined
  const done = summary(f, markKept(r, plan.targets.map(t => t.path)), idx)
  assert.deepEqual(brief(done), { keys: [], count: '1 of 1' })
})

test('flow-reading/RC02 with the method and a peek both open, both are kept by their own lines', () => {
  const f = review()
  const idx = indexFlow(f.ctl, null)
  let r = readAt(startReading(idx, ROOT), idx, at(idx, f.svc))
  r = into(r, idx)
  assert.deepEqual(r.open, [at(idx, f.discount)])
  const plan = summary(f, r, idx)
  assert.deepEqual(brief(plan), { keys: [`keepCard:${f.svc.key}`, `keepCard:${f.discount.key}`], count: '0 of 2' })
})

test('flow-reading/RC02 the only changed method of a file is still kept by its own lines (the host then forgets the file), and a changed method that is not open is never kept', () => {
  const f = demo()
  const other = method('Other.x', 5, [], { file: '/demo/B.java', diff: diff() })
  f.svc.children.push(edge(other, 30))
  f.svc.file = '/demo/A.java'
  f.svc.diff = diff()
  const idx = indexFlow(f.ctl, null)
  const r = readAt(startReading(idx, ROOT), idx, at(idx, f.svc))
  const plan = keepPlan(idx, r)
  assert.deepEqual(brief(plan), { keys: [`keepCard:${f.svc.key}`], count: '0 of 1' })
  assert.ok(!plan.targets.some(t => t.key === other.key))
  assert.ok(plan.targets.every(t => !('via' in t)), 'there is no whole-file keep in the pane')
})

test('flow-reading/RC02 another changed method of the same file that is not on the flow keeps Keep to the method\'s lines', () => {
  const f = demo()
  f.svc.diff = diff()
  const z = method('OrderService.z', 90, [], { file: f.svc.file, diff: diff() })
  const idx = indexFlow(f.ctl, null)
  const r = readAt(startReading(idx, ROOT), idx, at(idx, f.svc))
  assert.deepEqual(brief(keepPlan(idx, r)), { keys: [`keepCard:${f.svc.key}`], count: '0 of 1' })
})

test('flow-reading/RC02 a method in the folded chain above the top is kept too', () => {
  const f = review()
  // The chain place > place > createInvoice above a re-rooted create_invoice: OrderService.place is in it.
  const idx = indexFlow(f.ctl, null)
  const r = readAt(startReading(idx, ROOT), idx, at(idx, f.createInvoiceHttp))
  assert.deepEqual(chainOf(idx, topOf(r)).map(c => c.name), ['place', 'place', 'createInvoice'])
  const plan = summary(f, r, idx)
  assert.deepEqual(brief(plan), { keys: [`keepCard:${f.svc.key}`], count: '0 of 1' })
})

test('flow-reading/RC02 with nothing changed open there is nothing to keep and no count', () => {
  const f = demo()
  const idx = indexFlow(f.ctl, null)
  const r = into(startReading(idx, ROOT), idx)
  assert.deepEqual(brief(keepPlan(idx, r)), { keys: [], count: '0 of 0' })
})

// ---- RC03 keys ----------------------------------------------------------------------------------------------------------
const key = (k, mods = {}, over = {}) => paneKey({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, altGraph: false, inPane: true, target: 'DIV', ...mods, ...over })

test('flow-reading/RC03 j, l, h, Enter and Escape act only while the focus is in the pane', () => {
  assert.equal(key('j'), 'over')
  assert.equal(key('l'), 'into')
  assert.equal(key('h'), 'out')
  assert.equal(key('Enter'), 'peek')
  assert.equal(key('Escape'), 'escape')
  for (const k of ['j', 'l', 'h', 'Enter', 'Escape', '[', ']']) assert.equal(key(k, {}, { inPane: false }), undefined, `${k} outside the pane is not the pane's`)
})

test('flow-reading/RC03 brackets count with AltGr and not with Ctrl or Alt alone', () => {
  assert.equal(key('[', { ctrlKey: true, altKey: true, altGraph: true }), 'back')
  assert.equal(key(']', { ctrlKey: true, altKey: true, altGraph: true }), 'forward')
  assert.equal(key('['), 'back')
  assert.equal(key(']'), 'forward')
  assert.equal(key('[', { ctrlKey: true }), undefined, 'Ctrl+[ is the editor\'s')
  assert.equal(key('[', { altKey: true }), undefined, 'Alt+[ is not AltGr')
  assert.equal(key(']', { metaKey: true }), undefined)
})

test('flow-reading/RC03 Alt+F10, Alt+F11 and Alt+Shift+F11 step over, into and out; bare F10 and F11 pass through', () => {
  assert.equal(key('F10', { altKey: true }), 'over')
  assert.equal(key('F11', { altKey: true }), 'into')
  assert.equal(key('F11', { altKey: true, shiftKey: true }), 'out')
  assert.equal(key('F11'), undefined, 'F11 is VS Code\'s full screen')
  assert.equal(key('F10'), undefined)
  assert.equal(key('F11', { shiftKey: true }), undefined)
  assert.equal(key('F11', { altKey: true, ctrlKey: true }), undefined)
  assert.equal(key('ArrowLeft', { altKey: true }), undefined, 'Alt+← stays VS Code\'s')
  assert.equal(key('F11', { altKey: true }, { inPane: false }), undefined)
})

test('flow-reading/RC03 any other key or modifier combination passes through untouched', () => {
  for (const [k, mods] of [['j', { ctrlKey: true }], ['j', { altKey: true }], ['j', { metaKey: true }], ['J', {}], ['l', { shiftKey: true }], ['Enter', { ctrlKey: true }], ['Enter', { shiftKey: true }], ['Escape', { altKey: true }], ['x', {}], ['k', {}], ['ArrowDown', {}], [' ', {}]]) assert.equal(key(k, mods), undefined, `${JSON.stringify([k, mods])}`)
})

test('flow-reading/RC03 only the editor own hidden input is the pane input; the find widget inputs keep their keys', () => {
  assert.equal(isEditorInput('TEXTAREA', 'inputarea monaco-mouse-cursor-text'), true)
  assert.equal(isEditorInput('TEXTAREA', 'input'), false, 'the find box (a textarea in the editor)')
  assert.equal(isEditorInput('INPUT', 'input'), false)
  assert.equal(isEditorInput('DIV', 'inputarea'), false)
  // So j, l, h and Escape typed in the find box are not steps.
  assert.equal(key('Escape', {}, { target: 'TEXTAREA', monaco: isEditorInput('TEXTAREA', 'input') }), undefined)
  assert.equal(key('l', {}, { target: 'INPUT', monaco: isEditorInput('INPUT', 'input') }), undefined)
})

test('flow-reading/RC03 Enter and Space on a button and every key in a text field are the element\'s own', () => {
  assert.equal(key('Enter', {}, { target: 'BUTTON' }), undefined)
  assert.equal(key(' ', {}, { target: 'BUTTON' }), undefined)
  assert.equal(key('j', {}, { target: 'INPUT' }), undefined)
  assert.equal(key('j', {}, { target: 'TEXTAREA' }), undefined)
  // The editor's own hidden textarea is how Monaco takes keys: the pane's keys work there (it is read-only).
  assert.equal(key('j', {}, { target: 'TEXTAREA', monaco: true }), 'over')
  assert.equal(key('j', {}, { target: 'BUTTON' }), 'over', 'a letter on a focused button is still a step')
})

// ---- peek zones ---------------------------------------------------------------------------------------------------------
test('peek zones: removed lines come before the peeks on the same line, and every zone sits below the zones above it', () => {
  const zones = [
    { id: 'peek-b', after: 2, kind: 'peek', height: 60 },
    { id: 'c', after: 5, kind: 'peek', height: 50 },
    { id: 'peek-a', after: 2, kind: 'peek', height: 100 },
    { id: 'del', after: 2, kind: 'del', height: 40 },
    { id: 'first', after: 0, kind: 'del', height: 20 },
  ]
  const placed = zoneTops(zones, 20, 6)
  const by = Object.fromEntries(placed.map(z => [z.id, z.top]))
  assert.deepEqual(placed.map(z => z.id), ['first', 'del', 'peek-b', 'peek-a', 'c'], 'by line, then removed lines, then peeks in the order given')
  assert.equal(by.first, 6, 'before the first line')
  // after line 2: 6 padding + 2 lines + the 20 px zone before line 1
  assert.equal(by.del, 6 + 2 * 20 + 20)
  assert.equal(by['peek-b'], by.del + 40)
  assert.equal(by['peek-a'], by['peek-b'] + 60)
  assert.equal(by.c, 6 + 5 * 20 + 20 + 40 + 60 + 100)
  assert.ok(placed.every((z, i) => i === 0 || z.ordinal > placed[i - 1].ordinal), 'ordinals follow the order')
})

test('peek zones: a line sits below every zone that comes before it', () => {
  const zones = [
    { id: 'del', after: 2, kind: 'del', height: 40 },
    { id: 'p', after: 2, kind: 'peek', height: 100 },
    { id: 'q', after: 5, kind: 'peek', height: 50 },
  ]
  assert.equal(lineTop(zones, 1, 20, 6), 6)
  assert.equal(lineTop(zones, 2, 20, 6), 26)
  assert.equal(lineTop(zones, 3, 20, 6), 6 + 2 * 20 + 140, 'after the removed lines and the peek')
  assert.equal(lineTop(zones, 6, 20, 6), 6 + 5 * 20 + 190)
})

test('peek zones: opening or closing one peek is only its own add or remove', () => {
  const f = demo()
  const idx = indexFlow(f.ctl, null)
  const a = startReading(idx, ROOT)
  const b = into(a, idx)
  assert.deepEqual(peekDiff(a, b), { add: [at(idx, f.svc)], remove: [] })
  assert.deepEqual(peekDiff(b, out(b, idx)), { add: [], remove: [at(idx, f.svc)] })
  assert.deepEqual(peekDiff(b, b), { add: [], remove: [] })
  // A new top replaces the whole document: what was open there goes, what is open on the new top comes.
  const rerooted = readAt(b, idx, at(idx, f.svc))
  assert.deepEqual(peekDiff(b, rerooted), { add: [], remove: [at(idx, f.svc)] })
})

// ---- folded chain -------------------------------------------------------------------------------------------------------
test('folded chain: one entry per ancestor, outermost first, each with the line it calls the next from and where to go back to', () => {
  const { ctl, svc, createInvoice, createInvoiceHttp } = demo()
  const idx = indexFlow(ctl, null)
  const chain = chainOf(idx, at(idx, createInvoiceHttp))
  assert.deepEqual(chain.map(c => [c.name, c.line, c.key]), [['place', 20, ctl.key], ['place', 24, svc.key], ['createInvoice', 20, createInvoice.key]])
  assert.deepEqual(chain.map(c => c.path), [ROOT, at(idx, svc), at(idx, createInvoice)])
  assert.deepEqual(chainOf(idx, ROOT), [], 'the entry has nothing above it')
})

test('folded chain: above the entry is its first caller, when callers are shown', () => {
  const { ctl } = demo()
  const caller = method('Gateway.forward', 30, [], { file: '/demo/Gateway.java' })
  const up = { ...method('OrderController.place', 15), key: ctl.key, children: [edge(caller, 33)] }
  const idx = indexFlow(ctl, up)
  const chain = chainOf(idx, ROOT)
  assert.deepEqual(chain.map(c => [c.name, c.line, c.key]), [['forward', 33, caller.key]])
  // Out at the entry reads that caller, with the cursor on the line that calls.
  const r = out(startReading(idx, ROOT), idx)
  assert.equal(topOf(r), chain[0].path)
  assert.equal(r.cursor.line, 33)
  assert.equal(into(r, idx), r, 'a caller card has no calls to step into')
})

// ---- the canvas trace -------------------------------------------------------------------------------------------------
test('trace: the path to the cursor is solid, the callee under it is next, read cards are plain and the rest fade', () => {
  const { ctl, svc, createInvoice, announce, orders } = demo()
  const idx = indexFlow(ctl, null)
  let r = into(startReading(idx, ROOT), idx)
  r = over(r, idx) // on createInvoice's call in place (:24)
  const t = traceOf(idx, r)
  assert.equal(t.node(ctl.key), 'path')
  assert.equal(t.node(svc.key), 'path')
  assert.equal(t.node(createInvoice.key), 'next')
  assert.equal(t.node(orders.key), 'dim', 'the cursor has not been in the table')
  assert.equal(t.node(announce.key), 'dim')
  assert.equal(t.edge(ctl.key, svc.key), 'path')
  assert.equal(t.edge(svc.key, createInvoice.key), 'next')
  assert.equal(t.edge(svc.key, announce.key), 'dim')
  // Into createInvoice and on past its last call: the cursor is back in place on the next call, and createInvoice was read.
  const further = over(into(r, idx), idx)
  assert.equal(further.cursor.line, 25)
  assert.equal(traceOf(idx, further).node(createInvoice.key), 'read', 'a card the cursor has been in stays plain after it left')
  assert.equal(traceOf(idx, further).node(announce.key), 'next')
})

// ---- RC06 the pane's open/closed choice ----------------------------------------------------------------------------------
test('flow-reading/RC06 the pane opens unless the user closed it last time', () => {
  assert.equal(initialPane(() => 'closed', false), false, 'stored closed: closed')
  assert.equal(initialPane(() => 'open', false), true)
  assert.equal(initialPane(() => null, false), true, 'nothing stored: open')
})

test('flow-reading/RC06 storage that is missing or throws leaves the pane open', () => {
  assert.equal(initialPane(() => { throw new Error('SecurityError') }, false), true)
  assert.equal(initialPane(undefined, false), true, 'no storage at all')
})

test('flow-reading/RC06 the site\'s home hero never opens it, and a tour hides it while it plays', () => {
  assert.equal(initialPane(() => 'open', true), false)
  assert.equal(initialPane(() => null, true), false)
  assert.equal(initialPane(() => { throw new Error('x') }, true), false)
  assert.equal(paneShown(true, false), true)
  assert.equal(paneShown(true, true), false, 'a tour plays: the cards show their code')
  assert.equal(paneShown(false, false), false)
})
