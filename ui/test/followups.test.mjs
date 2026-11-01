// The follow-up questions as the canvas cleans them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeFollowUps } from '../src/tour/followUps.ts'
import { sanitizeTour } from '../src/tour/sanitize.ts'

test('anything but a list is nothing', () => {
  for (const v of [undefined, null, 'a', 3, {}]) assert.equal(sanitizeFollowUps(v), undefined)
  assert.equal(sanitizeFollowUps([]), undefined)
})

test('strings only, whitespace squeezed, empties dropped', () => {
  assert.deepEqual(sanitizeFollowUps(['  why \n this?  ', 4, null, '', '   ', 'a\u0000b']), ['why this?', 'a b'])
})

test('long ones are cut to 120, at most three are kept, duplicates drop case-insensitively', () => {
  assert.equal(sanitizeFollowUps(['x'.repeat(130)])[0].length, 120)
  assert.deepEqual(sanitizeFollowUps(['a', 'b', 'c', 'd']), ['a', 'b', 'c'])
  assert.deepEqual(sanitizeFollowUps(['Why?', 'why?', 'How?']), ['Why?', 'How?'])
})

test('sanitizeTour keeps clean followUps and omits an empty list', () => {
  const base = { id: 't', title: 'T', steps: [{ title: 's', caption: 'c' }] }
  assert.deepEqual(sanitizeTour({ ...base, followUps: ['Why?', 5, 'Why?'] })?.followUps, ['Why?'])
  assert.equal(sanitizeTour({ ...base, followUps: [5] })?.followUps, undefined)
})
