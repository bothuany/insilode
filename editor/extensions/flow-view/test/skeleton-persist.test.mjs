// Skeleton first across a reload: the stage, the board id and the "just do it" badge are kept in the workspace state (a fake Memento here).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

after(cleanup)

const persist = await load('src/skeleton/persist.ts')
const KEY = 'flow.skeleton.sessions.v1'

/** A Memento that keeps its values like workspaceState does: serialised, so what comes back is a copy. */
const memento = (initial = {}) => {
	const data = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]))
	return {
		data,
		get: k => data.has(k) ? JSON.parse(data.get(k)) : undefined,
		update: async (k, v) => { data.set(k, JSON.stringify(v)) },
	}
}
const live = (session, stage, boardId = `skeleton-${session}`) => ({ session, stage, boardId })
const stored = m => m.get(KEY)

test('skeleton-persist: the stage and board of a session past the design stage are written, the design stage is not', () => {
	const m = memento()
	const mem = new persist.SessionMemory(m, 20)
	mem.save([live('a', 'skeleton'), live('b', 'design'), live('c', 'handover')])
	assert.deepEqual(stored(m), [
		{ session: 'a', stage: 'skeleton', boardId: 'skeleton-a', skipped: false },
		{ session: 'c', stage: 'handover', boardId: 'skeleton-c', skipped: false },
	])
})

test('skeleton-persist: a reload brings the stages back for boards that still exist and drops the others silently', () => {
	const m = memento()
	new persist.SessionMemory(m, 20).save([live('a', 'skeleton'), live('c', 'handover')])
	const after = new persist.SessionMemory(m, 20)
	const back = after.restore(id => id === 'skeleton-c')
	assert.deepEqual(back.map(s => [s.session, s.stage, s.boardId]), [['c', 'handover', 'skeleton-c']], 'the board of a is gone, so a is dropped')
	after.save(back.map(s => live(s.session, s.stage, s.boardId)))
	assert.deepEqual(stored(m).map(s => s.session), ['c'], 'the dropped entry is gone from the state at the next save')
})

test('skeleton-persist: "just do it" is remembered per session until its next design step or the end of the session', () => {
	const m = memento()
	const mem = new persist.SessionMemory(m, 20)
	mem.skip('a')
	mem.save([live('b', 'skeleton')])
	assert.equal(mem.isSkipped('a'), true)
	assert.equal(mem.isSkipped('b'), false)
	const reloaded = new persist.SessionMemory(m, 20)
	reloaded.restore(() => true)
	assert.equal(reloaded.isSkipped('a'), true, 'the badge survives a reload, though the session has no stage')
	reloaded.forget('a')
	reloaded.save([])
	assert.equal(reloaded.isSkipped('a'), false)
	assert.deepEqual(stored(m), [])
	const again = new persist.SessionMemory(m, 20)
	again.restore(() => true)
	assert.equal(again.isSkipped('a'), false)
})

test('skeleton-persist: the number of sessions is bounded, the oldest badge goes first', () => {
	const m = memento()
	const mem = new persist.SessionMemory(m, 3)
	for (const id of ['a', 'b', 'c', 'd']) mem.skip(id)
	assert.equal(mem.isSkipped('a'), false)
	assert.equal(mem.isSkipped('d'), true)
	mem.save(['s1', 's2', 's3', 's4'].map(s => live(s, 'skeleton')))
	assert.equal(stored(m).length, 3)
	const big = memento({ [KEY]: Array.from({ length: 50 }, (_, i) => ({ session: `s${i}`, stage: 'skeleton', boardId: `b${i}`, skipped: false })) })
	assert.equal(new persist.SessionMemory(big, 20).restore(() => true).length, 20)
})

test('skeleton-persist: damaged data is ignored, and two entries with one id become one', () => {
	for (const bad of [undefined, null, 'x', 7, {}, [null, 3, 'x', []], [{ session: 5, stage: 'skeleton', boardId: 'b' }], [{ session: 'a', stage: 'nonsense', boardId: 'b' }], [{ session: 'a', stage: 'skeleton' }], [{ session: 'a', stage: 'skeleton', boardId: '' }], [{ session: 'a', stage: null }]]) {
		const mem = new persist.SessionMemory(memento({ [KEY]: bad }), 20)
		assert.deepEqual(mem.restore(() => true), [], JSON.stringify(bad))
	}
	const dup = memento({ [KEY]: [{ session: 'a', stage: 'skeleton', boardId: 'b1', skipped: false }, { session: 'a', stage: 'handover', boardId: 'b2', skipped: false }, { session: 'ok', stage: 'design', boardId: 'b3' }] })
	assert.deepEqual(new persist.SessionMemory(dup, 20).restore(() => true).map(s => [s.session, s.stage, s.boardId]), [['a', 'skeleton', 'b1']], 'a design-stage entry is not restored')
	assert.equal(persist.parseSaved([{ session: 'x'.repeat(500), stage: 'skeleton', boardId: 'b' }], 20).length, 0, 'an id of that length is not one of ours')
})

test('skeleton-persist: without a state, or with one that throws, nothing breaks', async () => {
	const none = new persist.SessionMemory(undefined, 20)
	none.skip('a')
	none.save([live('a', 'skeleton')])
	assert.deepEqual(none.restore(() => true), [])
	assert.equal(none.isSkipped('a'), true)
	const broken = new persist.SessionMemory({ get: () => { throw new Error('no') }, update: () => { throw new Error('no') } }, 20)
	assert.deepEqual(broken.restore(() => true), [])
	broken.save([live('a', 'skeleton')])
	const rejecting = new persist.SessionMemory({ get: () => undefined, update: () => Promise.reject(new Error('no')) }, 20)
	rejecting.save([live('a', 'skeleton')])
	await new Promise(r => setTimeout(r, 5)) // an unhandled rejection would fail the run
})
