// The tour's remaining UX: the key legend against the key handler, the blocked-Next text, the screen-reader summary of the pen
// marks, the hint after a long wait for an answer, and the Escape / outside-click logic of the bar's pop-ups. All pure files, run
// under plain Node (`npm test` in ui/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { KEY_BINDINGS, KEY_HINT, keyAction, legendRows } from '../src/tour/legend.ts'
import { MAX_SUMMARY, markSummary } from '../src/tour/marks.ts'
import { ASK_HINT, ASK_HINT_MS, askHintDue, noPanels, panelsEscape, panelsReduce } from '../src/tour/player.ts'

const player = readFileSync(new URL('../src/tour/TourPlayer.tsx', import.meta.url), 'utf8')

// ---- the legend ---------------------------------------------------------------------------------------------------------

test('every key of the legend does what its row says, and no key is listed twice', () => {
  const seen = new Set()
  for (const b of KEY_BINDINGS) {
    for (const key of b.keys) {
      assert.equal(keyAction(key)?.action, b.action, `${key} is ${b.action}`)
      assert.ok(!seen.has(key), `${key} is bound once`)
      seen.add(key)
    }
  }
  assert.equal(keyAction('x'), undefined, 'a key that is not in the table does nothing')
  assert.deepEqual(keyAction('4'), { action: 'goto', index: 3 }, 'a number key is the step of that number, 0-based')
})

test('the key handler of the player runs the legend\'s table and handles every action in it', () => {
  assert.match(player, /keyAction\(e\.key\)/, 'the handler reads legend.ts, not its own key list')
  for (const b of KEY_BINDINGS) assert.match(player, new RegExp(`case '${b.action}':`), `the handler has a case for ${b.action}`)
  // No second place that binds a key by hand.
  assert.doesNotMatch(player, /e\.key === '(\]|\[|ArrowRight|ArrowLeft|Escape|\/)'/)
})

test('the legend lists the ask key only when there is somebody to ask', () => {
  assert.ok(legendRows(true).some(r => r.action === 'ask'))
  assert.ok(!legendRows(false).some(r => r.action === 'ask'))
  assert.equal(legendRows(true).length, KEY_BINDINGS.length)
})

test('the key hint names keys the table really binds', () => {
  assert.equal(KEY_HINT, 'Right arrow: next · ?: all keys · Esc: exit')
  assert.equal(keyAction('ArrowRight').action, 'next')
  assert.equal(keyAction('?').action, 'legend')
  assert.equal(keyAction('Escape').action, 'exit')
})

// ---- markSummary --------------------------------------------------------------------------------------------------------

test('markSummary says every kind of mark in words', () => {
  assert.equal(markSummary([{ kind: 'ring', lines: [12, 14] }]), 'Marked on this card: ring lines 12 to 14')
  assert.equal(markSummary([{ kind: 'ring', lines: [12, 12] }]), 'Marked on this card: ring line 12')
  assert.equal(markSummary([{ kind: 'underline', lines: [5, 6] }]), 'Marked on this card: underline lines 5 to 6')
  assert.equal(markSummary([{ kind: 'strike', lines: [7, 7] }]), 'Marked on this card: strike through line 7')
  assert.equal(markSummary([{ kind: 'check', lines: [20, 20] }]), 'Marked on this card: check beside line 20')
  assert.equal(markSummary([{ kind: 'cross', lines: [21, 21] }]), 'Marked on this card: cross beside line 21')
  assert.equal(markSummary([{ kind: 'badge', lines: [3, 3], n: 2 }]), 'Marked on this card: number 2 beside line 3')
  assert.equal(markSummary([{ kind: 'connect', to: { file: 'src/Foo.ts', startLine: 1, endLine: 9, label: 'Foo.bar' }, label: 'calls' }]), 'Marked on this card: arrow to Foo.bar labelled calls')
})

test('markSummary joins the marks in the order the caption brings them in', () => {
  const text = markSummary([
    { kind: 'check', lines: [20, 20], sentence: 3 },
    { kind: 'ring', lines: [12, 14] },
    { kind: 'underline', lines: [30, 30], sentence: 2, label: 'why' },
    { kind: 'cross', lines: [40, 40], sentence: 2 },
  ])
  assert.equal(text, 'Marked on this card: ring lines 12 to 14; underline line 30 labelled why; cross beside line 40; check beside line 20', 'by sentence, then as listed')
})

test('markSummary falls back to the file name for an arrow without a target label, and is empty without marks', () => {
  assert.equal(markSummary([{ kind: 'connect', to: { file: 'C:\\w\\src\\Foo.ts', startLine: 1, endLine: 2, label: '' } }]), 'Marked on this card: arrow to Foo.ts')
  assert.equal(markSummary([]), '')
  assert.equal(markSummary(undefined), '')
})

test('markSummary is cut at a length and says how many marks it left out', () => {
  const marks = Array.from({ length: 6 }, (_, i) => ({ kind: 'ring', lines: [i * 10 + 1, i * 10 + 8], label: 'a rather long label of forty chars...' }))
  const text = markSummary(marks)
  assert.ok(text.length <= MAX_SUMMARY + 30, `short enough (${text.length})`)
  assert.match(text, /; and \d+ more$/)
  // Each mark said adds one ';' (the first is joined by none, but "and N more" adds one): the count of ';' is the marks said.
  const said = text.split(';').length - 1
  assert.equal(said + Number(/and (\d+) more/.exec(text)[1]), 6, 'what was said plus what was left out is every mark')
  assert.ok(text.startsWith('Marked on this card: ring lines 1 to 8'), 'the first mark is always said')
})

// ---- waiting for an answer ----------------------------------------------------------------------------------------------

test('the hint for a long wait is due after twenty seconds and not before, and not without a question', () => {
  assert.equal(ASK_HINT_MS, 20_000)
  assert.equal(askHintDue(1000, 1000), false)
  assert.equal(askHintDue(1000, 1000 + ASK_HINT_MS - 1), false)
  assert.equal(askHintDue(1000, 1000 + ASK_HINT_MS), true)
  assert.equal(askHintDue(1000, 1000 + 5 * ASK_HINT_MS), true)
  assert.equal(askHintDue(null, 1e12), false, 'no open question, no hint')
  assert.equal(ASK_HINT, 'Press Space to continue without an answer')
  assert.equal(keyAction(' ').action, 'toggle', 'and Space is the key that resumes')
})

// ---- the step list and the legend: Escape and a click outside ----------------------------------------------------------------

test('Escape closes an open pop-up first and the tour stays; the next Escape is the tour\'s', () => {
  const open = panelsReduce(noPanels, 'toggleList')
  assert.deepEqual(open, { list: true, legend: false })
  const first = panelsEscape(open)
  assert.equal(first.handled, true, 'handled: the tour is not exited')
  assert.deepEqual(first.panels, noPanels)
  assert.equal(panelsEscape(first.panels).handled, false, 'nothing open: the key goes on to exit the tour')
  assert.equal(panelsEscape(panelsReduce(noPanels, 'toggleLegend')).handled, true, 'the legend closes with Escape too')
})

test('a click outside closes the pop-ups and a click on their buttons toggles them; only one is open at a time', () => {
  assert.deepEqual(panelsReduce({ list: true, legend: false }, 'outside'), noPanels)
  assert.deepEqual(panelsReduce({ list: false, legend: true }, 'outside'), noPanels)
  assert.equal(panelsReduce(noPanels, 'outside'), noPanels, 'nothing open: the same object, no re-render')
  assert.deepEqual(panelsReduce({ list: true, legend: false }, 'toggleLegend'), { list: false, legend: true })
  assert.deepEqual(panelsReduce({ list: false, legend: true }, 'toggleList'), { list: true, legend: false })
  assert.deepEqual(panelsReduce({ list: true, legend: false }, 'toggleList'), noPanels)
  assert.deepEqual(panelsReduce({ list: true, legend: false }, 'closeList'), noPanels, 'choosing a step closes the list')
})
