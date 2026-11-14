// Where the Agents page keeps its pane layouts (src/layoutStore.ts): the one on screen in the workspace's storage, the named ones in the
// global storage; whatever is read back or handed in is validated first, and the caps hold.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let s
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-layoutstore-'))
	const outfile = join(tmp, 'layoutStore.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'layoutStore.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	s = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const memento = () => { const m = new Map(); return { get: k => m.get(k), update: async (k, v) => { v === undefined ? m.delete(k) : m.set(k, v) }, m } }
const pane = (id, session) => ({ type: 'pane', id, content: { kind: 'terminal', agent: 'claude', session } })
const one = (n = 1) => ({ seq: n, root: pane('p' + n, 's' + n), focus: 'p' + n })
const two = () => ({ seq: 3, root: { type: 'split', id: 's3', dir: 'row', sizes: [0.5, 0.5], children: [pane('p1', 'a'), pane('p2', 'b')] } })
const store = () => { const ws = memento(), gs = memento(); return { ws, gs, store: new s.LayoutStore(ws, gs) } }

test('the layout on screen is kept per workspace and comes back as it was; an empty workspace is kept as nothing', T, () => {
	const t = store()
	assert.equal(t.store.current(), undefined)
	t.store.setCurrent(two())
	assert.deepEqual(t.store.current(), two())
	assert.ok(t.ws.m.has(s.CURRENT_KEY) && !t.gs.m.has(s.CURRENT_KEY))
	t.store.setCurrent({ seq: 3 })
	assert.equal(t.store.current(), undefined)
	assert.equal(t.ws.m.has(s.CURRENT_KEY), false)
})

test('a stored layout that is not sound is not restored', T, () => {
	const t = store()
	for (const bad of ['x', 5, [], { seq: 1, root: pane('x', 's') }, { seq: 'a' }, { seq: 1, root: { type: 'pane', id: 'p1', content: { kind: 'shell', agent: 'claude' } } }]) {
		t.ws.m.set(s.CURRENT_KEY, bad)
		assert.equal(t.store.current(), undefined, JSON.stringify(bad))
	}
})

test('named layouts: saved in order, replaced by name, deleted; one with no panes is not saved', T, () => {
	const t = store()
	assert.equal(t.store.save('Review', two()), true)
	assert.equal(t.store.save('Solo', one()), true)
	assert.deepEqual(t.store.saved().map(x => x.name), ['Review', 'Solo'])
	assert.equal(t.store.save('Review', one(2)), true)
	assert.deepEqual(t.store.saved().map(x => x.name), ['Review', 'Solo'])
	assert.deepEqual(t.store.saved()[0].layout, one(2))
	assert.equal(t.store.save('Empty', { seq: 0 }), false)
	assert.equal(t.store.save('  ', one()), false)
	assert.equal(t.store.save('x'.repeat(61), one()), false)
	assert.equal(t.store.save('  Trimmed ', one()), true)
	assert.ok(t.store.saved().some(x => x.name === 'Trimmed'))
	t.store.remove('Solo')
	t.store.remove('Nothing')
	assert.deepEqual(t.store.saved().map(x => x.name), ['Review', 'Trimmed'])
	assert.ok(t.gs.m.has(s.SAVED_KEY) && !t.ws.m.has(s.SAVED_KEY), 'named layouts are global')
})

test('no more than 20 named layouts: a 21st name is refused, an existing one may still be replaced', T, () => {
	const t = store()
	for (let i = 0; i < 20; i++) { assert.equal(t.store.save('L' + i, one()), true) }
	assert.equal(t.store.save('One more', one()), false)
	assert.equal(t.store.saved().length, 20)
	assert.equal(t.store.save('L7', two()), true)
	assert.deepEqual(t.store.saved()[7].layout, two())
	// Stored data past the cap, with duplicates and unsound entries, is read as at most 20 sound distinct ones.
	t.gs.m.set(s.SAVED_KEY, [...Array.from({ length: 30 }, (_, i) => ({ name: 'N' + i, layout: one() })), { name: 'N1', layout: one() }, { name: 'Bad', layout: { seq: 'x' } }, null, 'x'])
	assert.equal(t.store.saved().length, 20)
	t.gs.m.set(s.SAVED_KEY, [{ name: 'A', layout: one() }, { name: 'A', layout: two() }, { name: 'Bad', layout: { seq: 'x' } }, { name: '', layout: one() }, { name: 'Empty', layout: { seq: 0 } }, null])
	assert.deepEqual(t.store.saved().map(x => x.name), ['A'])
	t.gs.m.set(s.SAVED_KEY, 'nope')
	assert.deepEqual(t.store.saved(), [])
})
