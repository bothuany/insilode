// Pull request news for an agent: diffing, baseline, dedupe, filters, queue and daily cap (src/prEventsCore.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let c, p
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-prev-'))
	for (const [name, file] of [['c', 'prEventsCore'], ['p', 'prState']]) {
		const outfile = join(tmp, `${file}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${file}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		const m = await import(pathToFileURL(outfile).href)
		if (name === 'c') { c = m } else { p = m }
	}
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const base = (o = {}) => ({ number: 12, state: 'open', title: 't', url: 'https://github.com/o/r/pull/12', checks: 'pass', counts: { pass: 1, fail: 0, pending: 0 }, failing: [], reviewDecision: '', mergeable: 'MERGEABLE', headRefOid: 'aaa', comments: [], reviews: [], author: 'me', ...o })
const note = (id, author, body = '', state = '') => ({ id, author, body, state })

test('parsePr reads the new fields', () => {
	const r = p.parsePr({ number: 1, url: 'https://github.com/o/r/pull/1', state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING', headRefOid: 'abc', author: { login: 'me' }, comments: [{ id: 'C1', author: { login: 'bob' }, body: 'hi' }], reviews: [{ id: 'R1', author: { login: 'al' }, body: 'fix', state: 'changes_requested' }] })
	assert.equal(r.reviewDecision, 'CHANGES_REQUESTED')
	assert.equal(r.mergeable, 'CONFLICTING')
	assert.equal(r.headRefOid, 'abc')
	assert.equal(r.author, 'me')
	assert.deepEqual(r.comments, [{ id: 'C1', author: 'bob', body: 'hi', state: '' }])
	assert.equal(r.reviews[0].state, 'CHANGES_REQUESTED')
	assert.match(p.PR_FIELDS, /headRefOid/)
})

test('the first snapshot is a baseline: nothing is raised', () => {
	const t = new c.PrTracker()
	assert.deepEqual(t.observe(base({ failing: ['build'], mergeable: 'CONFLICTING', comments: [note('c1', 'bob', 'x')] })), [])
	assert.deepEqual(t.observe(base({ failing: ['build'], mergeable: 'CONFLICTING', comments: [note('c1', 'bob', 'x')] })), [])
})

test('new failures, conflicts, comments and reviews are raised once', () => {
	const t = new c.PrTracker()
	t.observe(base())
	const next = base({ failing: ['build', 'lint'], mergeable: 'CONFLICTING', comments: [note('c1', 'bob', 'please\nrename')], reviews: [note('r1', 'alice', 'broken', 'CHANGES_REQUESTED'), note('r2', 'carol', '', 'APPROVED')] })
	const kinds = t.observe(next).map(e => e.kind).sort()
	assert.deepEqual(kinds, ['changesRequested', 'checkFailed', 'checkFailed', 'comment', 'conflict', 'review'])
	assert.deepEqual(t.observe(next), [])
})

test('a check that fails again on a new push is new news; the same push is not', () => {
	const t = new c.PrTracker()
	t.observe(base())
	assert.equal(t.observe(base({ failing: ['build'] })).length, 1)
	assert.equal(t.observe(base({ failing: ['build'] })).length, 0)
	const again = t.observe(base({ failing: ['build'], headRefOid: 'bbb' }))
	assert.equal(again.length, 1)
	assert.equal(again[0].key, 'check:bbb:build')
})

test('conflict is keyed by commit; UNKNOWN is not a conflict', () => {
	const t = new c.PrTracker()
	t.observe(base())
	assert.deepEqual(t.observe(base({ mergeable: 'UNKNOWN' })), [])
	assert.equal(t.observe(base({ mergeable: 'CONFLICTING' })).length, 1)
	assert.equal(t.observe(base({ mergeable: 'CONFLICTING' })).length, 0)
	assert.equal(t.observe(base({ mergeable: 'CONFLICTING', headRefOid: 'ccc' })).length, 1)
})

test('bots and the PR author are ignored', () => {
	const t = new c.PrTracker()
	t.observe(base())
	const out = t.observe(base({
		comments: [note('c1', 'dependabot[bot]', 'x'), note('c2', 'ci-bot', 'x'), note('c3', 'Me', 'mine'), note('c4', 'bob', 'real')],
		reviews: [note('r1', 'me', 'self', 'COMMENTED'), note('r2', 'copilot[bot]', 'x', 'CHANGES_REQUESTED')],
	}))
	assert.deepEqual(out.map(e => e.key), ['comment:c4'])
	assert.ok(c.isBot('x-bot') && c.isBot('y[bot]') && !c.isBot('robot'))
})

test('settings drop disabled kinds', () => {
	const evs = [{ kind: 'comment', key: 'a', text: 'a' }, { kind: 'conflict', key: 'b', text: 'b' }]
	assert.deepEqual(c.allowed(evs, { comment: false, conflict: true }).map(e => e.key), ['b'])
})

test('the queue holds ten, drops the oldest and ignores repeated keys', () => {
	const q = new c.EventQueue()
	q.add(Array.from({ length: 12 }, (_, i) => ({ kind: 'comment', key: `k${i}`, text: String(i) })))
	assert.equal(q.size, 10)
	assert.equal(q.peek()[0].key, 'k2')
	q.add([{ kind: 'comment', key: 'k5', text: 'dup' }])
	assert.equal(q.size, 10)
	q.clear()
	assert.equal(q.size, 0)
})

test('one combined line, on one line, under the limit', () => {
	const line = c.composeLine(12, [
		{ kind: 'checkFailed', key: 'a', name: 'build', text: 'CI failed (build)' },
		{ kind: 'checkFailed', key: 'b', name: 'lint', text: 'CI failed (lint)' },
		{ kind: 'changesRequested', key: 'c', text: 'changes requested by alice: fix\nthis' },
	])
	assert.equal(line, '[Insilode] PR #12: CI failed (build, lint); changes requested by alice: fix this. Please look into it.')
	const long = c.composeLine(1, [{ kind: 'comment', key: 'x', text: 'y'.repeat(2000) }])
	assert.ok(long.length <= c.MAX_LINE)
	assert.ok(long.endsWith('Please look into it.'))
})

test('the daily cap counts per PR per day; 0 means never', () => {
	let day = new Date(2026, 9, 28, 10)
	const cap = new c.DailyCap(() => day)
	assert.equal(cap.allows('a', 0), false)
	for (let i = 0; i < 2; i++) { assert.ok(cap.allows('a', 2)); cap.record('a') }
	assert.equal(cap.allows('a', 2), false)
	assert.equal(cap.allows('b', 2), true)
	day = new Date(2026, 9, 29, 0, 5)
	assert.equal(cap.allows('a', 2), true)
})
