// Saving a tour (src/tourSave.ts): the tour on the canvas written to `.insilode/tours/<id>.tour.json` and read back by the same
// parser a play uses. Runs against a real temp workspace; its path is resolved with realpathSync.native first (a Windows runner's
// temp folder has an 8.3 short name).
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, load, temp } from './bundle.mjs'

after(cleanup)

const save = await load('src/tourSave.ts')
const v = await load('src/tour/validate.ts')

let work
let other
before(() => {
	work = realpathSync.native(temp('flow-tour-save-'))
	other = realpathSync.native(temp('flow-tour-save-other-'))
	mkdirSync(join(work, 'src'), { recursive: true })
	mkdirSync(join(other, 'lib'), { recursive: true })
	writeFileSync(join(work, 'src', 'a.js'), Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n'))
	writeFileSync(join(other, 'lib', 'b.js'), Array.from({ length: 30 }, (_, i) => `b ${i + 1}`).join('\n'))
})

const methods = new Map([['a.js', [{ name: 'Order.place', startLine: 5, endLine: 30 }, { name: 'Order.cancel', startLine: 32, endLine: 50 }]], ['b.js', [{ name: 'Util.log', startLine: 1, endLine: 10 }]]])
const hostFor = roots => ({
	roots,
	readText: f => (existsSync(f) ? readFileSync(f, 'utf8') : undefined),
	methodsIn: f => methods.get(f.split(/[\\/]/).pop()),
})
/** A tour the way the player holds it: parsed from a file spelling, then given the fields an agent's tour has. */
const tourOf = (roots, raw, extra = {}) => {
	const { tour } = v.parseTourFile({ insilodeTour: 1, id: 'orders', title: 'How orders are placed', ...raw }, hostFor(roots))
	return { ...tour, source: 'agent', origin: 'Claude Code (terminal)', agent: { label: 'Claude', color: '#d97757' }, ...extra }
}
const read = path => JSON.parse(readFileSync(path, 'utf8'))
const reparse = (roots, path) => v.parseTourFile(read(path), hostFor(roots)).tour
const toursDir = root => join(root, '.insilode', 'tours')

const STEPS = [
	{ caption: 'Orders start here.' },
	{ title: 'Place', caption: 'This is where it is placed.', file: 'src/a.js', method: 'Order.place', lines: [[10, 12]], marks: [{ kind: 'ring', lines: [10, 12], label: 'the guard', sentence: 1 }, { kind: 'check', lines: [20, 20] }, { kind: 'badge', lines: [8, 8], n: 2 }, { kind: 'connect', to: { file: 'src/a.js', method: 'Order.cancel' }, label: 'calls' }] },
	{ title: 'Cancel', caption: 'And cancelled here.', file: 'src/a.js', line: 40 },
	{ caption: 'Press Continue.', wait: { kind: 'continue', prompt: 'Ready' } },
]

test('a saved tour reads back as the same tour: steps, marks, lines, start, follow-ups and a hands-on step', async () => {
	const tour = tourOf([work], { steps: STEPS, start: 2, followUps: ['Why a guard?'] })
	const res = await save.saveTour(tour, [work])
	assert.equal(res.ok, true, res.message)
	assert.equal(res.path, join(toursDir(work), 'orders.tour.json'))
	const back = reparse([work], res.path)
	assert.equal(back.id, 'orders')
	assert.equal(back.title, tour.title)
	assert.equal(back.start, tour.start)
	assert.deepEqual(back.followUps, tour.followUps)
	assert.deepEqual(back.steps, tour.steps, 'every step: its place, highlights, marks, wait and state')
	assert.equal(back.source, 'file', 'it is a file now')
	// Written the way a hand-written file spells it: relative to the workspace folder, with forward slashes.
	const file = read(res.path)
	assert.equal(file.insilodeTour, 1)
	assert.equal(file.steps[1].file, 'src/a.js')
	assert.equal(file.steps[1].method, 'Order.place')
	assert.deepEqual(file.steps[1].lines, [[10, 12]])
	assert.equal(file.steps[1].marks[3].to.file, 'src/a.js')
	assert.equal(file.start, 2, 'in the file the first step is 1: the tour opens on its second step')
})

test('nothing the file format rejects is saved: no command, no notes, no agent or origin', async () => {
	const tour = tourOf([work], { steps: STEPS })
	tour.steps[0] = { ...tour.steps[0], wait: { kind: 'command', command: 'flow.home', prompt: 'Open it' }, notes: [{ text: 'my note', by: 'user', at: 1 }, { question: 'q?', text: 'an answer', by: 'agent', at: 2 }] }
	const res = await save.saveTour(tour, [work])
	assert.equal(res.ok, true, res.message)
	const text = readFileSync(res.path, 'utf8')
	const file = JSON.parse(text)
	assert.equal(file.steps[0].wait, undefined, 'a command wait is a plain step in a file')
	assert.equal(file.steps[0].notes, undefined)
	assert.doesNotMatch(text, /flow\.home|my note|an answer|Claude|agent|origin|#d97757/)
	assert.deepEqual(file.steps[3].wait, { kind: 'continue', prompt: 'Ready' }, 'a click or continue wait stays')
	// The keys of the file are the ones the parser knows.
	assert.deepEqual(Object.keys(file).filter(k => !['insilodeTour', 'id', 'title', 'start', 'flow', 'steps', 'followUps'].includes(k)), [])
	assert.equal(reparse([work], res.path).steps[0].wait, undefined)
})

test('a title or id with unicode or slashes is a safe file name inside the tours folder', async () => {
	const wanted = ['../../escape', 'a/b\\c', '.hidden', 'Räksmörgås över 日本語', 'CON', '', '***', 'x'.repeat(200)]
	for (const id of wanted) {
		const name = save.cleanTourId(id)
		assert.match(name, /^[A-Za-z0-9_-]{1,56}$/, JSON.stringify(id))
		assert.doesNotMatch(name, /^con$/i)
	}
	assert.equal(save.cleanTourId('Räksmörgås / orders'), 'Raksmorgas-orders')
	assert.equal(save.cleanTourId('../../escape'), 'escape')
	assert.equal(save.cleanTourId('.hidden'), 'hidden')
	assert.equal(save.cleanTourId('kept_name-2'), 'kept_name-2')
	const tour = tourOf([work], { steps: [{ caption: 'x' }] }, { id: '../../Räksmörgås/evil', title: 'Ünïcode / title' })
	const res = await save.saveTour(tour, [work])
	assert.equal(res.ok, true, res.message)
	assert.equal(res.path, join(toursDir(work), 'Raksmorgas-evil.tour.json'))
	assert.equal(read(res.path).id, 'Raksmorgas-evil')
	assert.equal(reparse([work], res.path).title, 'Ünïcode / title')
})

test('saving twice overwrites the tour\'s own file; another tour\'s file is never overwritten', async () => {
	const dir = toursDir(work)
	mkdirSync(dir, { recursive: true })
	// A hand-written file named like the new tour but holding another id, one that is not JSON, and one that is not a tour.
	writeFileSync(join(dir, 'clash.tour.json'), JSON.stringify({ insilodeTour: 1, id: 'handmade', title: 'Mine', steps: [{ caption: 'keep me' }] }))
	writeFileSync(join(dir, 'clash-2.tour.json'), 'not json')
	writeFileSync(join(dir, 'clash-3.tour.json'), '[1,2]')
	const before = readFileSync(join(dir, 'clash.tour.json'), 'utf8')
	const first = await save.saveTour(tourOf([work], { steps: [{ caption: 'one' }] }, { id: 'clash' }), [work])
	assert.equal(first.ok, true, first.message)
	assert.equal(first.path, join(dir, 'clash-4.tour.json'))
	assert.equal(read(first.path).id, 'clash-4', 'the file name and the id in it stay one')
	const again = await save.saveTour(tourOf([work], { steps: [{ caption: 'one' }, { caption: 'two' }] }, { id: 'clash' }), [work])
	assert.equal(again.path, first.path, 'the same tour: its own file again')
	assert.equal(read(again.path).steps.length, 2)
	assert.equal(readFileSync(join(dir, 'clash.tour.json'), 'utf8'), before, 'the hand-written file is untouched')
	assert.equal(readFileSync(join(dir, 'clash-2.tour.json'), 'utf8'), 'not json')
	assert.equal(readdirSync(dir).filter(f => f.startsWith('clash')).length, 4, 'no duplicates')
})

test('a tour with moved and missing steps is saved with their last known lines', async () => {
	const tour = tourOf([work], { steps: [
		{ caption: 'moved', file: 'src/a.js', method: 'Order.place', line: 45 },
		{ caption: 'gone', file: 'src/a.js', method: 'Order.vanished', line: 12 },
		{ caption: 'outside', file: '../elsewhere.js', line: 3 },
	] })
	assert.deepEqual(tour.steps.map(s => s.state), ['moved', 'missing', 'missing'])
	const res = await save.saveTour(tour, [work])
	assert.equal(res.ok, true, res.message)
	const file = read(res.path)
	assert.equal(file.steps[0].line, 5, 'the new place of the moved method')
	assert.equal(file.steps[1].file, 'src/a.js')
	assert.equal(file.steps[1].line, 12, 'the line it was last seen at')
	assert.equal(file.steps[1].method, 'Order.vanished')
	assert.equal(file.steps[2].file, undefined, 'a place outside the workspace is not written')
	const back = reparse([work], res.path)
	// The moved one is found where it now is; the missing one is reported again when played; the one outside the workspace is words only.
	assert.deepEqual(back.steps.map(s => s.state), ['ok', 'missing', 'ok'])
	assert.equal(back.steps[1].at.startLine, 12)
})

test('a tour with no steps says there is nothing to save, and no folder says to open one', async () => {
	const none = await save.saveTour({ ...tourOf([work], { steps: STEPS }), steps: [] }, [work])
	assert.equal(none.ok, false)
	assert.match(none.message, /no steps/)
	const nowhere = await save.saveTour(tourOf([work], { steps: STEPS }), [])
	assert.equal(nowhere.ok, false)
	assert.match(nowhere.message, /Open a folder/)
})

test('with several folders the tour goes to the first one that holds its code, and the file still reads back', async () => {
	const roots = [work, other]
	const tour = tourOf(roots, { id: 'multi', steps: [{ caption: 'in b', file: join(other, 'lib', 'b.js'), method: 'Util.log' }, { caption: 'in a', file: 'src/a.js', line: 6 }] })
	const inOther = tourOf(roots, { id: 'multi-b', steps: [{ caption: 'only b', file: join(other, 'lib', 'b.js'), line: 2 }] })
	const first = await save.saveTour(tour, roots)
	assert.equal(first.path, join(toursDir(work), 'multi.tour.json'), 'its code is in both: the first folder')
	assert.equal(read(first.path).steps[0].file, join(other, 'lib', 'b.js'), 'a file of another folder is spelled in full')
	assert.deepEqual(reparse(roots, first.path).steps, tour.steps)
	const second = await save.saveTour(inOther, roots)
	assert.equal(second.path, join(toursDir(other), 'multi-b.tour.json'), 'only the second folder holds its code')
	assert.deepEqual(reparse(roots, second.path).steps, inOther.steps)
	const bare = await save.saveTour(tourOf(roots, { id: 'bare', steps: [{ caption: 'just words' }] }), roots)
	assert.equal(bare.path, join(toursDir(work), 'bare.tour.json'), 'no code at all: the first folder')
})
