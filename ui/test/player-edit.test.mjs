// The player's 'edit' action: the agent changed the tour while the reader was paused or waiting for an answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { idle, reduce } from '../src/tour/player.ts'

const step = (title, extra = {}) => ({ title, caption: `about ${title}`, state: 'ok', ...extra })
const tour = (n) => ({ id: 't1', title: 'A tour', origin: 'agent', source: 'agent', start: 0, steps: Array.from({ length: n }, (_, i) => step(`s${i + 1}`)) })
const play = (...actions) => actions.reduce(reduce, idle)

test('edit swaps the steps, puts the reader on the given index and keeps them paused', () => {
  const s = play({ type: 'start', tour: tour(3) }, { type: 'goto', index: 1 }, { type: 'pause' })
  const steps = [step('s1'), step('new'), step('s2'), step('s3')]
  const e = reduce(s, { type: 'edit', id: 't1', steps, index: 2 })
  assert.equal(e.tour.steps, steps)
  assert.equal(e.index, 2)
  assert.equal(e.paused, true)
  assert.equal(e.asking, null)
})

test('edit keeps a waiting reader waiting', () => {
  const s = play({ type: 'start', tour: tour(3) }, { type: 'ask' })
  const e = reduce(s, { type: 'edit', id: 't1', steps: [step('a'), step('b')], index: 0 })
  assert.equal(e.asking, 'waiting')
  assert.equal(e.paused, true)
})

test('edit with another id or an empty list changes nothing', () => {
  const s = play({ type: 'start', tour: tour(3) }, { type: 'pause' })
  assert.equal(reduce(s, { type: 'edit', id: 'other', steps: [step('a')], index: 0 }), s)
  assert.equal(reduce(s, { type: 'edit', id: 't1', steps: [], index: 0 }), s)
  assert.equal(reduce(idle, { type: 'edit', id: 't1', steps: [step('a')], index: 0 }), idle)
})

test('edit clamps an index past the end', () => {
  const s = play({ type: 'start', tour: tour(3) }, { type: 'pause' })
  assert.equal(reduce(s, { type: 'edit', id: 't1', steps: [step('a'), step('b')], index: 9 }).index, 1)
  assert.equal(reduce(s, { type: 'edit', id: 't1', steps: [step('a'), step('b')], index: -4 }).index, 0)
})

test('edit keeps the notes the given steps carry', () => {
  const noted = step('kept', { notes: [{ text: 'an answer', by: 'agent', at: 1 }] })
  const s = play({ type: 'start', tour: tour(2) }, { type: 'pause' })
  const e = reduce(s, { type: 'edit', id: 't1', steps: [noted, step('new')], index: 0 })
  assert.equal(e.tour.steps[0].notes[0].text, 'an answer')
  assert.equal(e.tour.steps[1].notes, undefined)
})
