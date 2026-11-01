// Boards survive a reload: the store saves to a key/value persist (workspaceState in the extension) and loads from it, never
// evicts a plan board or an open board, tells the user once when the limit removes one, and survives a persist that fails.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let spec, store
before(async () => {
	spec = await load('src/board/spec.ts')
	store = await load('src/board/store.ts')
})
after(cleanup)

/** A workspaceState stand-in that remembers what was written and how often. */
function fakePersist(initial) {
	const data = new Map(initial === undefined ? [] : [[store.BOARDS_KEY, initial]])
	const writes = []
	return {
		data,
		writes,
		get: key => data.get(key),
		update: async (key, value) => {
			writes.push(value)
			data.set(key, JSON.parse(JSON.stringify(value)))
		},
	}
}

const draw = (title, extra = {}) => spec.parseBoard({ title, nodes: [{ id: 'a', label: 'A' }], ...extra })
const wait = ms => new Promise(r => setTimeout(r, ms))

test('board-persist: a board is saved after a short wait and loads again in the next window, without opening a tab', async () => {
	const persist = fakePersist()
	const first = new store.BoardStore({ persist })
	await first.set(draw('One'), { id: 'one', origin: 'agent' })
	await first.set(draw('Plan'), { id: 'plan:s1', origin: 'plan', session: 's1', planFile: '/p/plan.md' })
	assert.equal(persist.writes.length, 0, 'saving waits, so a burst of changes is one write')
	await wait(store.SAVE_DELAY_MS + 150)
	assert.equal(persist.writes.length, 1)

	const second = new store.BoardStore({ persist })
	const shown = []
	second.setHost({ show: id => { shown.push(id) }, update: () => { } })
	assert.deepEqual(second.list().map(b => b.id).sort(), ['one', 'plan:s1'])
	assert.equal(second.get('plan:s1').origin, 'plan')
	assert.equal(second.get('plan:s1').session, 's1')
	assert.equal(second.get('plan:s1').planFile, '/p/plan.md')
	assert.equal(second.get('one').spec.title, 'One')
	assert.deepEqual(shown, [], 'loaded boards are not shown until asked for')
	assert.equal(second.get('one').previous, undefined)
	await second.present('one')
	assert.deepEqual(shown, ['one'])
})

test('board-persist: only spec, origin, session, plan file and times are saved, never the previous draw', async () => {
	const persist = fakePersist()
	const s = new store.BoardStore({ persist })
	await s.set(draw('V1'), { id: 'x' })
	await s.set(draw('V2'), { id: 'x' })
	assert.equal(s.get('x').previous.title, 'V1', 'the comparison is kept in memory')
	await s.flush()
	const [saved] = persist.writes.at(-1)
	assert.deepEqual(Object.keys(saved).sort(), ['createdAt', 'id', 'origin', 'planFile', 'session', 'spec', 'updatedAt'])
	assert.equal(saved.spec.title, 'V2')
	assert.equal('previous' in saved, false)
})

test('board-persist: node updates and deletes are saved too, and flush writes at once', async () => {
	const persist = fakePersist()
	const s = new store.BoardStore({ persist })
	const id = await s.set(spec.parseBoard({ kind: 'plan', title: 'P', nodes: [{ id: 'one', label: '1' }] }), { id: 'plan:z', origin: 'plan', present: false })
	await s.flush()
	assert.equal(persist.writes.length, 1)
	await s.updateNode(id, 'one', { status: 'done' })
	await s.flush()
	assert.equal(persist.writes.at(-1)[0].spec.nodes[0].status, 'done')
	s.delete(id)
	await s.flush()
	assert.deepEqual(persist.writes.at(-1), [])
	const writes = persist.writes.length
	await s.flush()
	assert.equal(persist.writes.length, writes, 'nothing changed, nothing written')
})

test('board-persist: a burst of changes is one write after the last one', async () => {
	const persist = fakePersist()
	const s = new store.BoardStore({ persist })
	for (let i = 0; i < 5; i++) {
		await s.set(draw(`b${i}`), { id: `b${i}`, present: false })
		await wait(20)
	}
	await wait(store.SAVE_DELAY_MS + 150)
	assert.equal(persist.writes.length, 1)
	assert.equal(persist.writes[0].length, 5)
})

test('board-persist: damaged saved data loads nothing and never throws', () => {
	for (const bad of ['text', 42, { boards: [] }, [null, 1, 'x', []], [{ id: 'a' }], [{ id: 'a', spec: 'no' }], [{ id: 'a', spec: { title: 'T', kind: 'flow', nodes: 'x', edges: [] } }]]) {
		const s = new store.BoardStore({ persist: fakePersist(bad) })
		assert.equal(s.list().length, 0, JSON.stringify(bad))
	}
	const throwing = { get() { throw new Error('boom') }, update: async () => { } }
	assert.equal(new store.BoardStore({ persist: throwing }).list().length, 0)
})

test('board-persist: a board with a malformed spec is skipped, the others load', () => {
	const good = { id: 'good', spec: draw('Good'), origin: 'agent', createdAt: 5, updatedAt: 7 }
	const s = new store.BoardStore({
		persist: fakePersist([
			{ ...good, id: 'bad-node', spec: { ...good.spec, nodes: [{ id: 'a' }] } },
			{ ...good, id: 'bad-edge', spec: { ...good.spec, edges: [{ from: 'a' }] } },
			{ ...good, id: '../escape' },
			good,
			{ ...good, id: 'odd', origin: 'robot', updatedAt: 'soon' },
		]),
	})
	assert.deepEqual(s.list().map(b => b.id).sort(), ['good', 'odd'])
	assert.equal(s.get('good').createdAt, 5)
	assert.equal(s.get('odd').origin, 'agent', 'an unknown origin falls back')
	assert.ok(s.get('odd').updatedAt > 7, 'a missing time falls back to now')
})

test('board-persist: ids stay path-safe and a fresh id never collides with a loaded one', async () => {
	const saved = [{ id: 'board-1', spec: draw('Board'), origin: 'agent', createdAt: 1, updatedAt: 1 }, { id: 'board-2', spec: draw('Board'), origin: 'agent', createdAt: 1, updatedAt: 2 }]
	const s = new store.BoardStore({ persist: fakePersist(saved) })
	const id = await s.set(draw('Board'), { present: false })
	assert.equal(id, 'board-3')
	assert.equal(s.list().length, 3)
	assert.equal(store.cleanBoardId('../../etc/passwd'), 'etc-passwd')
	assert.match(await s.set(draw('x'), { id: '../../x/..', present: false }), /^[A-Za-z0-9._:-]+$/)
})

test('board-persist: eviction skips plan boards and open boards, and never the board just drawn', async () => {
	const s = new store.BoardStore({ persist: fakePersist() })
	const open = new Set(['open-1'])
	s.setOpenCheck(id => open.has(id))
	await s.set(draw('Plan'), { id: 'plan:s', origin: 'plan', present: false })
	await s.set(draw('Open'), { id: 'open-1', present: false })
	for (let i = 0; i < store.MAX_BOARDS + 6; i++) {
		await wait(1)
		await s.set(draw(`b${i}`), { id: `b${i}`, present: false })
	}
	assert.ok(s.get('plan:s'), 'the plan board is the oldest after the open one and is kept')
	assert.ok(s.get('open-1'), 'a board open in a tab survives 31 more boards')
	assert.equal(s.list().length, store.MAX_BOARDS)
	assert.equal(s.get('b0'), undefined)
	assert.ok(s.get(`b${store.MAX_BOARDS + 5}`))
})

test('board-persist: when everything is pinned the store holds more than the limit instead of dropping a board', async () => {
	const s = new store.BoardStore()
	s.setOpenCheck(() => true)
	const told = []
	s.setOnEvict(b => told.push(b.id))
	for (let i = 0; i < store.MAX_BOARDS + 3; i++) {
		await s.set(draw(`b${i}`), { id: `b${i}`, present: false })
	}
	assert.equal(s.list().length, store.MAX_BOARDS + 3)
	assert.deepEqual(told, [])
})

test('board-persist: an evicted board fires the delete change and the user is told once per session', async () => {
	const s = new store.BoardStore()
	const events = []
	const told = []
	s.onDidChange(e => events.push(`${e.type}:${e.id}`))
	s.setOnEvict(b => told.push(b.spec.title))
	for (let i = 0; i < store.MAX_BOARDS + 4; i++) {
		await wait(1)
		await s.set(draw(`b${i}`), { id: `b${i}`, present: false })
	}
	assert.deepEqual(events.filter(e => e.startsWith('delete')), ['delete:b0', 'delete:b1', 'delete:b2', 'delete:b3'])
	assert.deepEqual(told, ['b0'], 'once, naming the first board the limit removed')
})

test('board-persist: a persist that rejects is swallowed and logged once; drawing goes on', async () => {
	const warned = []
	let calls = 0
	const persist = { get: () => undefined, update: async () => { calls++; throw new Error('disk full') } }
	const s = new store.BoardStore({ persist, warn: m => warned.push(m) })
	await s.set(draw('A'), { id: 'a', present: false })
	await s.flush()
	await s.set(draw('B'), { id: 'b', present: false })
	await s.flush()
	assert.equal(calls, 2, 'the next change tries again')
	assert.equal(warned.length, 1)
	assert.match(warned[0], /could not be saved \(disk full\)/)
	assert.equal(s.list().length, 2)
	const sync = new store.BoardStore({ persist: { get: () => undefined, update: () => { throw new Error('sync boom') } } })
	await sync.set(draw('C'), { id: 'c', present: false })
	await sync.flush()
	assert.ok(sync.get('c'))
})

test('board-persist: two windows on one workspace: the last write wins and neither crashes', async () => {
	const persist = fakePersist()
	const a = new store.BoardStore({ persist })
	const b = new store.BoardStore({ persist })
	await a.set(draw('From A'), { id: 'a', present: false })
	await b.set(draw('From B'), { id: 'b', present: false })
	await a.flush()
	await b.flush()
	assert.deepEqual(new store.BoardStore({ persist }).list().map(x => x.id), ['b'])
})

test('board-persist: showing a board brings its tab forward, drawing or updating one does not', async () => {
	const s = new store.BoardStore()
	const extras = []
	s.setHost({ show: (id, sp, extra) => { extras.push(['show', extra?.reveal === true]) }, update: (id, sp, extra) => { extras.push(['update', extra?.reveal === true]) } })
	const id = await s.set(draw('A'), { id: 'a' })
	await s.updateNode(id, 'a', { status: 'done' })
	await s.redraw(id)
	await s.present(id)
	assert.deepEqual(extras, [['show', false], ['update', false], ['update', false], ['show', true]])
})
