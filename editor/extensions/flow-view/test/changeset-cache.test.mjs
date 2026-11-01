// The change-set canvas between file events (src/changeSet.ts): a trace is kept per flow and re-done only when a file it shows
// changed, and a canvas nobody looks at is not traced again. The clock and the file system are faked.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let m
before(async () => {
	m = await load('src/changeSet.ts')
})
after(cleanup)

const card = (key, file, children = []) => ({ key, symbolId: null, label: key, sub: '', kind: 'method', file, startLine: 1, endLine: 5, code: null, children: children.map(node => ({ callLine: 2, edgeKind: 'call', node })) })

/** A file system of `name -> mtime` whose edits the test makes by hand. */
function disk(files) {
	const mtimes = new Map(Object.entries(files))
	return {
		stat: async f => (mtimes.has(f) ? { mtimeMs: mtimes.get(f), size: 10 } : undefined),
		touch: (f, at) => mtimes.set(f, at),
		remove: f => mtimes.delete(f),
	}
}

test('a cached trace comes back as a copy while none of its files changed', async () => {
	const d = disk({ '/a.ts': 100, '/shared.ts': 100 })
	const cache = new m.TraceCache(d.stat, () => 1000)
	await cache.set('A', card('a', '/a.ts', [card('s', '/shared.ts')]), 500)
	const hit = await cache.get('A')
	assert.equal(hit.children[0].node.file, '/shared.ts')
	// What the change set does to the copy (marks, annotations) never reaches the cache.
	hit.children[0].node.diff = { added: [1], removed: [], plus: 1, minus: 0 }
	assert.equal((await cache.get('A')).children[0].node.diff, undefined)
})

test('a changed file invalidates only the flows that show it', async () => {
	const d = disk({ '/a.ts': 100, '/b.ts': 100, '/shared.ts': 100 })
	const cache = new m.TraceCache(d.stat, () => 1000)
	await cache.set('A', card('a', '/a.ts', [card('s', '/shared.ts')]), 500)
	await cache.set('B', card('b', '/b.ts'), 500)
	await cache.set('C', card('c', '/b.ts', [card('s', '/shared.ts')]), 500)
	d.touch('/shared.ts', 700)
	assert.equal(await cache.get('A'), undefined, 'A shows shared.ts')
	assert.ok(await cache.get('B'), 'B does not')
	assert.equal(await cache.get('C'), undefined, 'C shows it too')
	// A deleted file is a change as well.
	d.remove('/b.ts')
	assert.equal(await cache.get('B'), undefined)
})

test('a trace of a file edited while it was being traced is not kept', async () => {
	const d = disk({ '/a.ts': 600 })
	const cache = new m.TraceCache(d.stat, () => 1000)
	await cache.set('A', card('a', '/a.ts'), 500)
	assert.equal(await cache.get('A'), undefined)
})

test('a trace is trusted only for a while, since a flow can change through a file it does not show', async () => {
	const d = disk({ '/a.ts': 100 })
	let now = 1000
	const cache = new m.TraceCache(d.stat, () => now)
	await cache.set('A', card('a', '/a.ts'), 500)
	now += m.TRACE_MAX_AGE_MS - 1
	assert.ok(await cache.get('A'))
	now += 2
	assert.equal(await cache.get('A'), undefined)
})

test('the files of a flow are every distinct file its cards show, in order, and the signature moves with an edit', () => {
	assert.deepEqual(m.filesOf(card('a', '/z.ts', [card('b', '/a.ts'), card('c', '/z.ts'), card('d', null)])), ['/a.ts', '/z.ts'])
	const before = m.signatureOf(['/a.ts'], [{ mtimeMs: 1, size: 2 }])
	assert.notEqual(before, m.signatureOf(['/a.ts'], [{ mtimeMs: 2, size: 2 }]))
	assert.notEqual(before, m.signatureOf(['/a.ts'], [{ mtimeMs: 1, size: 3 }]))
	assert.notEqual(before, m.signatureOf(['/a.ts'], [undefined]))
})

test('a hidden canvas is marked stale and traced once when it shows again', () => {
	// A file event with the tab in front: refresh now.
	assert.deepEqual(m.refreshPlan(true, false, 'disk'), { post: true, stale: false })
	// Hidden: nothing posted, a refresh owed.
	assert.deepEqual(m.refreshPlan(false, false, 'disk'), { post: false, stale: true })
	// More events while hidden change nothing.
	assert.deepEqual(m.refreshPlan(false, true, 'disk'), { post: false, stale: true })
	// Still hidden after a view change: still owed.
	assert.deepEqual(m.refreshPlan(false, true, 'visible'), { post: false, stale: true })
	// Visible again: one refresh, then nothing is owed.
	assert.deepEqual(m.refreshPlan(true, true, 'visible'), { post: true, stale: false })
	assert.deepEqual(m.refreshPlan(true, false, 'visible'), { post: false, stale: false })
})

test('the change set re-traces only the flows whose files changed between two asks', async () => {
	const d = disk({ '/a.ts': 100, '/b.ts': 100 })
	const traced = []
	const flows = [
		{ id: 'a', label: 'GET /a', name: 'A.get', source: 'poly' },
		{ id: 'b', label: 'GET /b', name: 'B.get', source: 'poly' },
	]
	const provider = {
		graph: async t => {
			traced.push(t.id)
			return card(t.id, `/${t.id}.ts`)
		},
	}
	const set = new m.ChangeSetProvider({
		stat: d.stat,
		now: () => 1000,
		impactOf: async () => ({ files: 2, flows, changed: [], tables: [], more: 0 }),
		providerFor: () => provider,
		annotate: async () => undefined,
	})
	set.use({ label: 'Changes since main', files: ['/a.ts', '/b.ts'] })
	await set.graph() // the trace `use` started
	assert.deepEqual(traced.sort(), ['a', 'b'])
	await set.graph() // asked again, nothing changed: both come from the cache
	assert.deepEqual(traced.sort(), ['a', 'b'])
	d.touch('/a.ts', 900)
	await set.graph()
	assert.deepEqual(traced.sort(), ['a', 'a', 'b'], 'only the flow that shows a.ts is traced again')
})
