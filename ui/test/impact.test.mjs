// The impact chip's wording and tone (src/impact/summary.ts), the state of an answer that fills in after the canvas
// (src/impact/fill.ts) and what a screen reader says for a card (src/impact/cardLabel.ts). Pure, run under plain Node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { impactSummary } from '../src/impact/summary.ts'
import { answered, asked, chipState, emptyFill, failed, messageOf } from '../src/impact/fill.ts'
import { cardLabel, cutNote } from '../src/impact/cardLabel.ts'

const row = (label, file = null, line = 0) => ({ label, file, line })

test('entry points: the chip counts them, the style is hot and the popover keeps its sentence', () => {
  const s = impactSummary({ label: 'entry point', items: [row('GET /a'), row('POST /b')] })
  assert.equal(s.chip, 'Affects 2 entry points')
  assert.equal(s.tone, 'hot')
  assert.equal(s.title, 'Changing this method can change the behaviour of:')
  assert.equal(s.hasRows, true)
  assert.equal(s.more, '')
  assert.equal(impactSummary({ label: 'entry point', items: [row('GET /a')] }).chip, 'Affects 1 entry point')
})

test('callers only: a neutral style and its own popover sentence, never the entry-point claim', () => {
  for (const label of ['caller', 'root caller']) {
    const s = impactSummary({ label, items: [row('Job.run'), row('Cli.main')] })
    assert.equal(s.tone, 'neutral')
    assert.equal(s.title, 'Callers at the top of the chain:')
    assert.equal(s.chip, '2 top callers')
    assert.doesNotMatch(s.chip + s.status, /Affects|behaviour/)
  }
  assert.equal(impactSummary({ label: 'caller', items: [row('Job.run')] }).chip, '1 top caller')
})

test('zero rows is a status of what the index found, not a claim that nothing is affected', () => {
  const entry = impactSummary({ label: 'entry point', items: [] })
  assert.equal(entry.status, 'No entry point found in the index')
  assert.equal(entry.chip, 'No entry point found')
  assert.equal(entry.hasRows, false)
  assert.doesNotMatch(entry.chip + entry.status, /Affects|nothing/i)
  const callers = impactSummary({ label: 'caller', items: [] })
  assert.equal(callers.status, 'No callers found in the index')
  assert.equal(callers.tone, 'neutral')
})

test('a walk that stopped at its limit says "at least" and says how much was left', () => {
  const hot = impactSummary({ label: 'entry point', items: [row('GET /a'), row('GET /b'), row('GET /c')], truncated: 40 })
  assert.equal(hot.chip, 'Affects at least 3 entry points')
  assert.match(hot.more, /40 functions left to follow/)
  const cold = impactSummary({ label: 'caller', items: [row('x'), row('y')], truncated: 1 })
  assert.equal(cold.chip, 'At least 2 top callers')
  assert.match(cold.more, /1 function left to follow/)
  // Nothing found yet, and the walk was cut: still not "nothing".
  const none = impactSummary({ label: 'entry point', items: [], truncated: 7 })
  assert.match(none.status, /No entry point found in the index, but the walk stopped/)
})

test('an answer that is asked for ends: in a result or in an error, never in "checking" for good', () => {
  let fill = emptyFill()
  assert.equal(chipState(fill), 'checking')
  fill = asked(fill, false)
  assert.equal(fill.pending, true)
  assert.equal(chipState(fill), 'checking')
  assert.equal(chipState(answered({ label: 'entry point', items: [] })), 'result')
  const bad = failed(fill, new Error('The editor did not answer "impact" in time.'))
  assert.equal(chipState(bad), 'error')
  assert.equal(bad.pending, false)
  assert.equal(bad.error, 'The editor did not answer "impact" in time.')
})

test('a refresh keeps the old impact while it asks, and a failed refresh keeps it next to the error', () => {
  const old = answered({ label: 'entry point', items: [row('GET /a')] })
  const again = asked(old, true)
  assert.equal(again.value, old.value)
  assert.equal(chipState(again), 'result')
  const bad = failed(again, 'boom')
  assert.equal(bad.value, old.value)
  assert.equal(bad.error, 'boom')
  assert.equal(chipState(bad), 'error')
  // Another flow starts empty instead.
  assert.equal(asked(old, false).value, null)
  // Retry clears the error and asks again.
  const retry = asked(bad, true)
  assert.equal(retry.error, '')
  assert.equal(retry.pending, true)
})

test('an error with no text still says something', () => {
  assert.equal(messageOf(new Error('')), 'The editor did not say why.')
  assert.equal(messageOf(undefined), 'The editor did not say why.')
  assert.equal(messageOf('plain'), 'plain')
})

test('cards: the label names the card, its place and a cut flow', () => {
  const node = { label: 'Orders.Service ▸ Get', kind: 'method', file: 'C:\\app\\OrdersService.cs', startLine: 12 }
  assert.equal(cardLabel(node, 'method'), 'Orders.Service.Get, method, OrdersService.cs:12')
  assert.equal(cardLabel({ ...node, truncated: 3 }, 'method'), 'Orders.Service.Get, method, OrdersService.cs:12, +3 more calls not drawn')
  assert.equal(cardLabel({ label: 'Users', kind: 'db', file: null, startLine: 0 }, 'database'), 'Users, database')
  assert.equal(cutNote(1), '+1 more call not drawn')
  assert.equal(cutNote(undefined), '')
  assert.equal(cutNote(0), '')
})
