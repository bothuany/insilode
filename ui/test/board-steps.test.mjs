// A canvas board's steps (src/board/steps.ts): the signature that decides whether a redraw restarts the walk includes what each
// step shows, and a step becomes the scene the painter takes. Pure, run under plain Node (`npm test` in ui/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sceneOf, stepsOf, stepsSignature } from '../src/board/steps.ts'

const step = extra => ({ title: 'One', caption: 'first', ...extra })

test('the steps signature changes when a canvas step shows, opens or lights something else', () => {
  const a = stepsSignature([step({ show: ['a'] })])
  assert.equal(a, stepsSignature([step({ show: ['a'] })]), 'the same steps keep the walk running')
  assert.notEqual(a, stepsSignature([step({ show: ['a', 'b'] })]))
  assert.notEqual(a, stepsSignature([step({ show: ['a'], open: ['f'] })]))
  assert.notEqual(a, stepsSignature([step({ show: ['a'], lit: ['a'] })]))
  assert.notEqual(stepsSignature([step()]), stepsSignature([step({ show: [] })]), 'no `show` is everything, `show: []` is nothing')
  assert.notEqual(stepsSignature([step()]), stepsSignature([step({ nodes: ['x'] })]), 'graph steps still count')
})

test('a step is a scene: sets for the painter, absent fields mean everything', () => {
  assert.deepEqual(sceneOf(undefined), { show: undefined, open: undefined, lit: undefined })
  assert.deepEqual(sceneOf(step()), { show: undefined, open: undefined, lit: undefined })
  const s = sceneOf(step({ show: ['a', 'b'], open: ['f'], lit: ['a'] }))
  assert.deepEqual([...s.show], ['a', 'b'])
  assert.deepEqual([...s.open], ['f'])
  assert.deepEqual([...s.lit], ['a'])
  assert.equal(sceneOf(step({ show: [] })).show.size, 0, 'nothing shown is a scene of its own')
  assert.equal(sceneOf(step({ lit: [] })).lit, undefined, 'nothing lit dims nothing')
})

test('a canvas board has its steps and no walk derived from edge order', () => {
  const spec = { version: 1, kind: 'canvas', title: 'T', nodes: [], edges: [], elements: [], steps: [step({ show: ['a'] })] }
  assert.deepEqual(stepsOf(spec), { steps: spec.steps, derived: false })
  assert.deepEqual(stepsOf({ ...spec, steps: undefined }), { steps: [], derived: false })
})
