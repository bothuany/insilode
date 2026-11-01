// A tour's follow-up questions (src/tour/followUps.ts): strict for the tool, lenient for a tour file.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let f
let v
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-tour-followups-'))
	const load = async (entry, name) => {
		const outfile = join(tmp, name)
		await build({ entryPoints: [join(ROOT, 'src', 'tour', entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		return import(pathToFileURL(outfile).href)
	}
	f = await load('followUps.ts', 'f.mjs')
	v = await load('validate.ts', 'v.mjs')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const host = { roots: [], readText: () => undefined }
const args = (extra = {}) => ({ title: 'T', steps: [{ title: 's', caption: 'c' }], ...extra })

test('strict accepts nothing, and 1 to 3 entries of at most 120', () => {
	assert.equal(f.parseFollowUps(undefined, true), undefined)
	assert.equal(f.parseFollowUps([], true), undefined)
	assert.deepEqual(f.parseFollowUps(['a', 'b', 'c'], true), ['a', 'b', 'c'])
	assert.equal(f.parseFollowUps(['x'.repeat(120)], true)[0].length, 120)
})

test('strict errors name the field', () => {
	const bad = (raw, re) => assert.throws(() => f.parseFollowUps(raw, true), e => e instanceof f.FollowUpError && re.test(e.message))
	bad(['a', 'b', 'c', 'd'], /`followUps` has 4 entries; at most 3 are shown/)
	bad(['a', 'x'.repeat(130)], /`followUps\[1\]` is 130 characters long; at most 120 are shown/)
	bad('why?', /`followUps`/)
	bad(['a', 4], /`followUps\[1\]`/)
	bad(['a', '  \n '], /`followUps\[1\]`/)
})

test('control characters become spaces', () => {
	assert.deepEqual(f.parseFollowUps(['a\u0000\tb\nc'], true), ['a b c'])
})

test('non-strict cuts and drops instead of throwing; duplicates go in both modes', () => {
	assert.deepEqual(f.parseFollowUps(['x'.repeat(130), 4, '', 'Why?', 'why?', 'b', 'c'], false), ['x'.repeat(120), 'Why?', 'b'])
	assert.equal(f.parseFollowUps('nope', false), undefined)
	assert.equal(f.parseFollowUps([1, ''], false), undefined)
	assert.deepEqual(f.parseFollowUps(['A', 'a'], true), ['A'])
})

test('through parseTourArgs: followUps reach the tour, too many is an error', () => {
	const { tour } = v.parseTourArgs(args({ followUps: ['Why?', 'How?'] }), host, 'Agent tour')
	assert.deepEqual(tour.followUps, ['Why?', 'How?'])
	assert.throws(() => v.parseTourArgs(args({ followUps: ['a', 'b', 'c', 'd'] }), host, 'Agent tour'), /`followUps` has 4 entries/)
})

test('a tour file keeps up to three', () => {
	const { tour } = v.parseTourFile(args({ insilodeTour: 1, id: 'x', followUps: ['a', 'b', 'c', 'd'] }), host)
	assert.deepEqual(tour.followUps, ['a', 'b', 'c'])
})
