// Hands-on tour steps as the canvas sees them: the wait rebuilt from what the host sends, the default prompts and which moves are
// allowed. All pure (src/tour/wait.ts), run under plain Node (`npm test` in ui/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { movePermitted, sanitizeWait, stepBlocks, waitPrompt } from '../src/tour/wait.ts'
import { sanitizeStep } from '../src/tour/sanitize.ts'

test('a click or continue wait keeps its kind and a prompt cut to 80 characters', () => {
  assert.deepEqual(sanitizeWait({ kind: 'click' }), { kind: 'click' })
  assert.deepEqual(sanitizeWait({ kind: 'continue', prompt: 'Ready?' }), { kind: 'continue', prompt: 'Ready?' })
  assert.equal(sanitizeWait({ kind: 'click', prompt: 'a'.repeat(200) }).prompt.length, 80)
  assert.deepEqual(sanitizeWait({ kind: 'click', prompt: '  one \n\t two  ' }), { kind: 'click', prompt: 'one two' }, 'plain text on one line')
  assert.deepEqual(sanitizeWait({ kind: 'click', prompt: '   ' }), { kind: 'click' }, 'an empty prompt is none')
  assert.deepEqual(sanitizeWait({ kind: 'click', prompt: 7 }), { kind: 'click' })
})

test('a command wait needs a command of at most 100 characters; its prompt defaults to "Run it"', () => {
  assert.deepEqual(sanitizeWait({ kind: 'command', command: 'flow.home', prompt: 'Open Home' }), { kind: 'command', command: 'flow.home', prompt: 'Open Home' })
  assert.deepEqual(sanitizeWait({ kind: 'command', command: 'flow.home' }), { kind: 'command', command: 'flow.home', prompt: 'Run it' })
  assert.equal(sanitizeWait({ kind: 'command', prompt: 'Go' }), undefined, 'a command wait without a command is dropped')
  assert.equal(sanitizeWait({ kind: 'command', command: '', prompt: 'Go' }), undefined)
  assert.equal(sanitizeWait({ kind: 'command', command: '   ', prompt: 'Go' }), undefined)
  assert.equal(sanitizeWait({ kind: 'command', command: 'x'.repeat(101) }), undefined)
  assert.ok(sanitizeWait({ kind: 'command', command: 'x'.repeat(100) }))
  assert.equal(sanitizeWait({ kind: 'command', command: 'flow.home\nrm -rf' }), undefined, 'a line break is not part of a command id')
  assert.equal(sanitizeWait({ kind: 'command', command: 5 }), undefined)
})

test('a command is only for the command kind, and every other shape is nothing', () => {
  assert.deepEqual(sanitizeWait({ kind: 'click', command: 'flow.home', extra: 1 }), { kind: 'click' }, 'fields that are not part of the wait are not copied')
  for (const raw of [undefined, null, 'click', 5, [], { kind: 'wait' }, {}, { kind: 5 }]) {
    assert.equal(sanitizeWait(raw), undefined, JSON.stringify(raw))
  }
})

test('a step carries its wait through sanitizeStep, and a bad wait leaves the step playing without it', () => {
  const base = { title: 's', caption: 'c', state: 'ok' }
  assert.deepEqual(sanitizeStep({ ...base, wait: { kind: 'continue' } }).wait, { kind: 'continue' })
  assert.equal(sanitizeStep({ ...base, wait: { kind: 'command' } }).wait, undefined)
  assert.ok(sanitizeStep({ ...base, wait: { kind: 'command' } }), 'the step itself stays')
})

test('waitPrompt gives each kind its own text', () => {
  assert.equal(waitPrompt({ kind: 'click' }), 'Click the highlighted card to go on')
  assert.equal(waitPrompt({ kind: 'click', prompt: 'Open the card' }), 'Open the card')
  assert.equal(waitPrompt({ kind: 'continue' }), 'Continue')
  assert.equal(waitPrompt({ kind: 'continue', prompt: 'Got it' }), 'Got it')
  assert.equal(waitPrompt({ kind: 'command', command: 'flow.home', prompt: 'Open Home' }), 'Open Home')
})

test('a step blocks while it waits and has not been done', () => {
  const wait = { kind: 'click' }
  assert.equal(stepBlocks(undefined, new Set(), 0), false, 'no wait, no block')
  assert.equal(stepBlocks(wait, new Set(), 0), true)
  assert.equal(stepBlocks(wait, new Set([1]), 0), true, 'another step being done does not help')
  assert.equal(stepBlocks(wait, new Set([0]), 0), false)
  assert.equal(stepBlocks(wait, [0], 0), false, 'a plain list of indexes works too')
})

test('going back is always allowed; going on needs every step on the way to be done', () => {
  const steps = [{}, { wait: { kind: 'click' } }, {}, { wait: { kind: 'continue' } }, {}]
  const none = new Set()
  assert.equal(movePermitted(steps, none, 0, 1), true, 'step 0 does not wait')
  assert.equal(movePermitted(steps, none, 1, 2), false, 'step 1 waits')
  assert.equal(movePermitted(steps, none, 0, 2), false, 'a jump over step 1 is refused')
  assert.equal(movePermitted(steps, none, 0, 4), false)
  assert.equal(movePermitted(steps, none, 1, 0), true, 'back is allowed from a blocked step')
  assert.equal(movePermitted(steps, none, 3, 1), true)
  assert.equal(movePermitted(steps, none, 1, 1), true, 'staying is not a move')
  assert.equal(movePermitted(steps, new Set([1]), 0, 3), true, 'once step 1 is done a jump lands on step 3')
  assert.equal(movePermitted(steps, new Set([1]), 0, 4), false, 'but not over step 3')
  assert.equal(movePermitted(steps, new Set([1, 3]), 0, 4), true)
  assert.equal(movePermitted(steps, none, 4, 4), true)
  assert.equal(movePermitted(steps, none, 2, 3), true, 'step 2 does not wait; step 3 only blocks what is past it')
  assert.equal(movePermitted(steps, none, 2, 4), false)
})
