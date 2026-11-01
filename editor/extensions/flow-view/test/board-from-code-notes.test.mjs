// The partial-index note every board_from_code kind carries, and the quick-pick items of the Board from Code command.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let gen
before(async () => { gen = await load('src/board/fromCode/index.ts') })
after(cleanup)

const KINDS = ['sequence', 'er', 'architecture', 'state']

test('partial index: every kind says the index is still building, and what may be missing', () => {
	for (const kind of KINDS) {
		const notes = gen.partialIndexNotes({ kind, indexReady: false })
		assert.equal(notes.length, 1, kind)
		assert.match(notes[0], /^The code index is still building: .+ may be missing\. Try again in a moment\.$/, kind)
	}
	assert.match(gen.partialIndexNotes({ kind: 'er', indexReady: false })[0], /tables of Java, Python and JS\/TS/)
	assert.match(gen.partialIndexNotes({ kind: 'state', indexReady: false })[0], /enums/)
})

test('partial index: a finished index and no guesses add nothing', () => {
	for (const kind of KINDS) {
		assert.deepEqual(gen.partialIndexNotes({ kind, indexReady: true }), [], kind)
		assert.deepEqual(gen.partialIndexNotes({ kind, indexReady: true, board: { legend: [{ key: 'other', text: 'x' }] } }), [], kind)
	}
})

test('partial index: a board built from guesses says so, with or without a finished index', () => {
	const board = { legend: [{ key: 'guess', text: 'dotted' }] }
	for (const kind of KINDS) {
		const done = gen.partialIndexNotes({ kind, indexReady: true, board })
		assert.equal(done.length, 1, kind)
		assert.match(done[0], /guesses/)
		const both = gen.partialIndexNotes({ kind, indexReady: false, board })
		assert.equal(both.length, 2, kind)
		assert.match(both[0], /still building/)
		assert.match(both[1], /guesses/)
	}
})

const source = {
	tables: [{ name: 'orders', detail: 'Order' }, { name: 'customers' }, { name: 'orders' }, { name: 'Account', detail: 'entity' }],
	enums: [{ name: 'OrderStatus', detail: 'shop' }, { name: 'Role' }],
	modules: ['shop', 'billing', 'shop'],
	indexReady: true,
}

test('Board from Code: the kind pick marks a Sequence that needs an open flow', () => {
	const none = gen.kindChoices(false)
	assert.deepEqual(none.map(k => k.kind), ['sequence', 'er', 'architecture', 'state'])
	assert.match(none[0].description, /needs an open flow/)
	assert.equal(none[0].needsFlow, true)
	assert.ok(none.slice(1).every(k => !k.needsFlow && !/needs an open flow/.test(k.description)))
	const open = gen.kindChoices(true)
	assert.equal(open[0].needsFlow, false)
	assert.doesNotMatch(open[0].description, /needs an open flow/)
})

test('Board from Code: the scope pick lists Whole project first, then the real tables, enums or modules', () => {
	const er = gen.scopeChoices('er', source)
	assert.deepEqual(er.map(c => c.label), ['Whole project', 'Account', 'customers', 'orders'])
	assert.deepEqual(er[0].scope, {})
	assert.deepEqual(er.find(c => c.label === 'orders').scope, { tables: ['orders'] }, 'a duplicate name is listed once')
	assert.equal(er.find(c => c.label === 'orders').description, 'Order')

	const states = gen.scopeChoices('state', source)
	assert.deepEqual(states.map(c => c.label), ['Whole project', 'OrderStatus', 'Role'])
	assert.deepEqual(states[1].scope, { enum: 'OrderStatus' })
	assert.match(states[0].description, /look for the enum/)

	const arch = gen.scopeChoices('architecture', source)
	assert.deepEqual(arch.map(c => c.label), ['Whole project', 'billing', 'shop'])
	assert.deepEqual(arch[2].scope, { module: 'shop' })
})

test('Board from Code: a Sequence has no scope pick (its scope is the open flow); an index still building is said in the first item', () => {
	assert.deepEqual(gen.scopeChoices('sequence', source), [])
	const building = gen.scopeChoices('er', { ...source, indexReady: false })
	assert.match(building[0].description, /code index is still building/)
	assert.doesNotMatch(gen.scopeChoices('er', source)[0].description, /still building/)
	assert.deepEqual(gen.scopeChoices('er', { tables: [], enums: [], modules: [], indexReady: true }).map(c => c.label), ['Whole project'])
})

test('Board from Code: a long list is capped', () => {
	const tables = Array.from({ length: gen.MAX_CHOICES + 50 }, (_, i) => ({ name: `t${String(i).padStart(4, '0')}` }))
	assert.equal(gen.scopeChoices('er', { ...source, tables }).length, gen.MAX_CHOICES + 1)
})

test('Board from Code: an error is shown whole, on one line', () => {
	const message = 'No state board was drawn: no enum has clear transitions.\n- The type graph is empty.\n\n  - Try again.'
	assert.equal(gen.boardFromCodeMessage(message), 'No state board was drawn: no enum has clear transitions. - The type graph is empty. - Try again.')
})
