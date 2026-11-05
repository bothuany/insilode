// What the review card's Keep and Undo buttons show: which buttons, their labels, the card they name, and why one is off
// (src/agentEdit/state.ts). Pure, run under plain Node (`npm test` in ui/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentEditState, cardName, UNDO_OFF } from '../src/agentEdit/state.ts'

const card = (diff = {}, label = 'OrderService ▸ Place') => ({ key: 'p1', label, file: 'C:\\shop\\OrderService.cs', startLine: 10, endLine: 30, diff: { plus: 3, minus: 1, ...diff } })

test('an agent edit: Keep, Undo, Keep all and Undo all, each naming what it acts on, nothing off, no badge', () => {
  const s = agentEditState(card())
  assert.deepEqual([s.keep.label, s.undo.label, s.keepAll.label, s.undoAll.label], ['Keep', 'Undo', 'Keep all', 'Undo all'])
  assert.equal(s.keep.ariaLabel, 'Keep the change to OrderService.Place')
  assert.equal(s.undo.ariaLabel, 'Undo the change to OrderService.Place')
  assert.equal(s.keepAll.ariaLabel, 'Keep every change of this prompt')
  assert.equal(s.undoAll.ariaLabel, 'Undo every change of this prompt')
  assert.deepEqual([s.keep.disabled, s.undo.disabled, s.keepAll.disabled, s.undoAll.disabled], [false, false, false, false])
  assert.deepEqual(s.badges, ['Already on disk'], 'the change is written before the reader looks: Keep accepts it after the fact')
})

test('a card measured against a commit: Undo is off with the reason, Keep still works, the prompt-wide buttons stay on', () => {
  const s = agentEditState(card({ base: 'main' }))
  assert.equal(s.undo.disabled, true)
  assert.equal(s.undo.reason, UNDO_OFF)
  assert.equal(s.undo.reason, 'Undo is off: this change includes committed work')
  assert.equal(s.undo.hint, s.undo.reason, 'the tooltip says why')
  assert.equal(s.keep.disabled, false)
  assert.equal(s.undoAll.disabled, false)
  assert.match(s.undoAll.hint, /skipped/)
})

test('Keep takes the whole file only when the card is the only changed card of its file; unknown counts as other cards', () => {
  assert.equal(agentEditState(card(), 0).keep.via, 'file')
  assert.equal(agentEditState(card(), 1).keep.via, 'card')
  assert.equal(agentEditState(card(), 4).keep.via, 'card')
  assert.equal(agentEditState(card()).keep.via, 'card', 'not told: the safe one')
})

test('the badges say how the change got here', () => {
  assert.deepEqual(agentEditState(card({ source: 'command' })).badges, ['Already on disk', 'changed by a command'])
  assert.deepEqual(agentEditState(card({ source: 'git' })).badges, ['Already on disk'])
  assert.deepEqual(agentEditState(card({ source: 'command', base: 'the last commit' })).badges, ['Already on disk', 'changed by a command'])
  assert.equal(agentEditState(card({ source: 'command', base: 'the last commit' })).undo.disabled, true, 'a command change measured against HEAD cannot be undone')
  assert.deepEqual(agentEditState({ key: 'p2', label: 'f', startLine: 1, endLine: 2 }).badges, [], 'a card with no diff has none')
})

test('cardName reads a card label the way a tour does', () => {
  assert.equal(cardName('OrderService ▸ Place'), 'OrderService.Place')
  assert.equal(cardName('Place'), 'Place')
})
