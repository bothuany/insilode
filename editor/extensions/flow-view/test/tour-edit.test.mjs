// Editing a tour while it plays (src/tour/edit.ts): where new steps go and where the reader ends up.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let e
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-tour-edit-'))
	const outfile = join(tmp, 'edit.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'tour', 'edit.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	e = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const step = (title, extra = {}) => ({ title, caption: title, state: 'ok', ...extra })
const tour = n => Array.from({ length: n }, (_, i) => step(`s${i + 1}`))
const titles = plan => plan.steps.map(s => s.title).join(',')

test('insert before, at and after the reader', () => {
	// The reader is on step 3 (index 2) of 4.
	const base = { steps: tour(4), index: 2, add: [step('n')] }
	let p = e.planEdit({ ...base, insert: 1 })
	assert.equal(titles(p), 'n,s1,s2,s3,s4')
	assert.equal(p.index, 3)
	assert.equal(p.first, 0)
	p = e.planEdit({ ...base, insert: 3 })
	assert.equal(titles(p), 's1,s2,n,s3,s4')
	assert.equal(p.index, 3, 'inserted at the reader: they stay on their step, which moved down')
	p = e.planEdit({ ...base, insert: 4 })
	assert.equal(titles(p), 's1,s2,s3,n,s4')
	assert.equal(p.index, 2)
	assert.equal(p.first, 3)
})

test('insert at N+1 appends', () => {
	const p = e.planEdit({ steps: tour(2), index: 1, insert: 3, add: [step('a'), step('b')] })
	assert.equal(titles(p), 's1,s2,a,b')
	assert.equal(p.index, 1)
	assert.equal(p.first, 2)
})

test('replace before, on and after the reader', () => {
	const base = { steps: tour(4), index: 2, add: [step('n')] }
	let p = e.planEdit({ ...base, replace: 1 })
	assert.equal(titles(p), 'n,s2,s3,s4')
	assert.equal(p.index, 2)
	p = e.planEdit({ ...base, replace: 3 })
	assert.equal(titles(p), 's1,s2,n,s4')
	assert.equal(p.index, 2, 'on the replaced step: the same index, now the new step')
	p = e.planEdit({ ...base, replace: 4 })
	assert.equal(titles(p), 's1,s2,s3,n')
	assert.equal(p.index, 2)
	assert.equal(p.first, 3)
})

test('one step becomes three', () => {
	const add = [step('a'), step('b'), step('c')]
	let p = e.planEdit({ steps: tour(3), index: 2, replace: 1, add })
	assert.equal(titles(p), 'a,b,c,s2,s3')
	assert.equal(p.index, 4, 'a reader after the replaced step moves down by two')
	p = e.planEdit({ steps: tour(3), index: 0, replace: 1, add })
	assert.equal(p.index, 0)
})

test('an undefined reader counts as the first step', () => {
	assert.equal(e.planEdit({ steps: tour(3), index: undefined, insert: 1, add: [step('n')] }).index, 1)
	assert.equal(e.planEdit({ steps: tour(3), index: undefined, replace: 2, add: [step('n')] }).index, 0)
})

test('exactly one of replace and insert', () => {
	const msg = 'Give either `replace` or `insert`, not both and not neither.'
	assert.equal(e.planEdit({ steps: tour(3), index: 0, add: [step('n')] }).error, msg)
	assert.equal(e.planEdit({ steps: tour(3), index: 0, replace: 1, insert: 1, add: [step('n')] }).error, msg)
})

test('positions out of range are refused', () => {
	for (const replace of [0, 4, -1, 1.5]) assert.equal(e.planEdit({ steps: tour(3), index: 0, replace, add: [step('n')] }).error, '`replace` must be between 1 and 3.', `replace ${replace}`)
	for (const insert of [0, 5, 2.5]) assert.equal(e.planEdit({ steps: tour(3), index: 0, insert, add: [step('n')] }).error, '`insert` must be between 1 and 4.', `insert ${insert}`)
})

test('a tour never goes past 30 steps', () => {
	assert.match(e.planEdit({ steps: tour(30), index: 0, insert: 1, add: [step('n')] }).error, /at most 30/)
	assert.match(e.planEdit({ steps: tour(29), index: 0, replace: 1, add: [step('a'), step('b'), step('c')] }).error, /at most 30/)
	assert.equal(e.planEdit({ steps: tour(30), index: 0, replace: 1, add: [step('n')] }).error, undefined)
	assert.equal(e.planEdit({ steps: tour(29), index: 0, insert: 1, add: [step('n')] }).error, undefined)
})

test('steps that are not replaced keep their objects and notes; new ones have none', () => {
	const noted = step('kept', { notes: [{ text: 'an answer', by: 'agent', at: 1 }] })
	const steps = [step('s1'), noted, step('s3')]
	const p = e.planEdit({ steps, index: 1, replace: 3, add: [step('n')] })
	assert.equal(p.steps[1], noted)
	assert.equal(p.steps[0], steps[0])
	assert.equal(p.steps[2].notes, undefined)
	assert.equal(steps.length, 3, 'the given list is not changed')
})

test('a refused edit leaves the list and reader as they were', () => {
	const steps = tour(3)
	const p = e.planEdit({ steps, index: 1, replace: 9, add: [step('n')] })
	assert.equal(p.steps, steps)
	assert.equal(p.index, 1)
})

test('map follows a step through an insert before it and a replace that grows', () => {
	const ins = e.planEdit({ steps: tour(4), index: 2, insert: 1, add: [step('a'), step('b')] })
	assert.equal(ins.map(2), 4)
	assert.equal(ins.map(0), 2)
	const rep = e.planEdit({ steps: tour(4), index: 0, replace: 2, add: [step('a'), step('b'), step('c')] })
	assert.equal(rep.map(0), 0)
	assert.equal(rep.map(2), 4)
	assert.equal(e.planEdit({ steps: tour(4), index: 0, replace: 9, add: [step('n')] }).map(3), 3)
})
