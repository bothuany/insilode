// What an empty board offers (emptyActions in src/board/protocol.ts) and the messages those actions send to the host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyActions } from '../src/board/protocol.ts'

const ids = list => list.map(a => a.id)

test('an empty DTO diagram offers Include entities and Edit DTO suffixes', () => {
  const actions = emptyActions('dto', {}, true)
  assert.deepEqual(ids(actions), ['entities', 'suffixes'])
  assert.deepEqual(actions[0].rebuild, { includeEntities: true })
  assert.equal(actions[0].setting, undefined)
  assert.equal(actions[0].label, 'Include entities')
  assert.equal(actions[1].setting, 'flow.types.dtoSuffixes')
  assert.equal(actions[1].rebuild, undefined)
  assert.equal(actions[1].label, 'Edit DTO suffixes')
})

test('entities already on: only the suffix setting is offered', () => {
  assert.deepEqual(ids(emptyActions('dto', { includeEntities: true }, true)), ['suffixes'])
})

test('filters on: the way out is clearing them, whatever the diagram', () => {
  for (const opts of [{ query: 'zzz' }, { focusId: 'T1' }, { hideRoles: ['dto'] }]) {
    for (const source of ['dto', 'architecture', undefined]) {
      const actions = emptyActions(source, opts, true)
      assert.deepEqual(ids(actions), ['clear'])
      assert.deepEqual(actions[0].rebuild, { query: undefined, focusId: undefined, depth: undefined, hideRoles: undefined })
    }
  }
})

test('a board the host cannot redraw, or another kind of board, offers nothing', () => {
  assert.deepEqual(emptyActions('dto', {}, false), [])
  assert.deepEqual(emptyActions('architecture', {}, true), [])
  assert.deepEqual(emptyActions(undefined, {}, false), [])
})

test('the settings message is the one the host checks against its list', () => {
  const suffixes = emptyActions('dto', {}, true).find(a => a.id === 'suffixes')
  const message = { type: 'settings', setting: suffixes.setting }
  assert.deepEqual(message, { type: 'settings', setting: 'flow.types.dtoSuffixes' })
})
