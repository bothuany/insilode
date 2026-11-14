// A reader with a time budget whose file work cannot be cancelled (src/budgeted.ts): while the work of an earlier call has not settled, a call
// starts nothing and gets the last result, so a hung mount costs one stuck call, not one per poll.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let m
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-budgeted-'))
	const outfile = join(tmp, 'budgeted.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'budgeted.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const sorted = a => [...a].sort()

test('a run that finishes in time returns what it collected, and the next run starts again', T, async () => {
	const b = new m.Budgeted([])
	let runs = 0
	const run = () => b.run(500, async acc => { runs++; acc.push(runs) }, () => [], sorted)
	assert.deepEqual(await run(), [1])
	assert.deepEqual(await run(), [2])
})

test('a run that outlives its budget returns what it has; until it settles no other starts and the last result is returned, then runs start again', T, async () => {
	const b = new m.Budgeted(['never run'])
	let release
	const gate = new Promise(r => { release = r })
	let starts = 0
	const stuck = () => b.run(50, async acc => { starts++; acc.push('a'); await gate; acc.push('late') }, () => [], sorted)
	assert.deepEqual(await stuck(), ['a'])
	assert.deepEqual(await stuck(), ['a'], 'the last result')
	assert.deepEqual(await stuck(), ['a'])
	assert.equal(starts, 1, 'one stuck run, not one per call')
	release()
	await new Promise(r => setTimeout(r, 20))
	assert.deepEqual(await b.run(50, async acc => { acc.push('b') }, () => [], sorted), ['b'], 'free again once the work settled')
})

test('before any run settled the last result is the one given at the start; work that rejects frees the guard', T, async () => {
	const b = new m.Budgeted('start')
	assert.equal(await b.run(50, async () => { throw new Error('boom') }, () => 0, n => 'ran ' + n), 'ran 0')
	assert.equal(await b.run(50, async () => undefined, () => 1, n => 'ran ' + n), 'ran 1')
})

test('a call that arrives while a run is in flight waits for it and gets what it found, not the list from before', T, async () => {
	const b = new m.Budgeted(['old'])
	const slow = b.run(1000, async acc => { await new Promise(r => setTimeout(r, 80)); acc.push('new') }, () => [], sorted)
	// The resume check lands here: answering ['old'] would miss a session the run in flight is about to report.
	const joined = await b.run(1000, async acc => { acc.push('never') }, () => [], sorted)
	assert.deepEqual(joined, ['new'])
	assert.deepEqual(await slow, ['new'])
})
