// Per-card Keep and the baseline of a file a shell command changed (src/changedMethods.ts): the hunks inside a card are folded
// into the baseline, the rest still show, and what Keep took in is remembered by content, not by position.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let k
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-keep-card-'))
	const outfile = join(tmp, 'keep.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'changedMethods.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	k = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const text = (...lines) => lines.join('\n') + '\n'
// Two methods: A.a is lines 2-4, B.b is lines 6-8.
const BASE = text('class A {', '  a() {', '    one', '  }', 'class B {', '  b() {', '    two', '  }')
// The agent edited a's body, inserted a line in b, and removed nothing.
const NOW = text('class A {', '  a() {', '    one changed', '  }', 'class B {', '  b() {', '    two', '    two and a half', '  }')

test('keepInRange: the hunks inside the card join the baseline, the other card still differs', () => {
	const r = k.keepInRange(BASE, NOW, 2, 4)
	assert.equal(r.left, 1)
	assert.equal(r.kept, 1)
	assert.equal(r.baseline, text('class A {', '  a() {', '    one changed', '  }', 'class B {', '  b() {', '    two', '  }'))
	// What remains to review is exactly b's insertion.
	const left = k.hunksBetween(r.baseline, NOW)
	assert.equal(left.length, 1)
	assert.deepEqual(left[0].lines, ['+    two and a half'])
})

test('keepInRange: keeping every card leaves nothing; keeping none leaves the baseline alone', () => {
	const all = k.keepInRange(BASE, NOW, 1, 100)
	assert.equal(all.left, 0)
	assert.equal(all.baseline, NOW)
	const none = k.keepInRange(BASE, NOW, 20, 30)
	assert.equal(none.left, 2)
	assert.equal(none.baseline, BASE)
	assert.equal(none.kept, 0)
})

test('keepInRange: a removal in the card is kept, and a removal between two cards belongs to neither', () => {
	const now = text('class A {', '  a() {', '  }', 'class B {', '  b() {', '    two', '  }')
	// a lost its body line: a gap inside a, lines 2-3 now.
	const r = k.keepInRange(BASE, now, 2, 3)
	assert.equal(r.left, 0)
	assert.equal(r.baseline, now)
	// Lines 1-1 does not hold the gap (it lies between lines 2 and 3), so nothing is kept there.
	assert.equal(k.keepInRange(BASE, now, 1, 1).left, 1)
})

test('keepInRange: keeping one card of a file and undoing the other works from the new baseline', () => {
	const r = k.keepInRange(BASE, NOW, 6, 9)
	assert.equal(r.left, 1)
	// The part still shown (a's edit) reverts to the old line, and b's insertion stays: what Undo of card a would write.
	const [h] = k.hunksBetween(r.baseline, NOW)
	assert.equal(k.revertHunks(NOW, [h]), text('class A {', '  a() {', '    one', '  }', 'class B {', '  b() {', '    two', '    two and a half', '  }'))
})

test('revertHunks: all hunks back give the baseline, for edits of every kind', () => {
	const cases = [
		[text('a', 'b', 'c'), text('a', 'c')],
		[text('a', 'b', 'c'), text('x', 'a', 'b', 'c', 'y')],
		[text('a', 'b', 'c', 'd', 'e'), text('a', 'B', 'c', 'D', 'e')],
		[text('a', 'b', 'c'), text('a', 'b', 'c', 'd')],
		['a\nb', 'a\nb\nc\n'],
		['a\nb\n', 'a\nb'],
		['', text('new', 'file')],
		[text('old', 'file'), ''],
		[text('1', '2', '3', '4', '5', '6'), text('2', '3', '6', '7')],
	]
	for (const [base, now] of cases) {
		assert.equal(k.revertHunks(now, k.hunksBetween(base, now)), base, JSON.stringify([base, now]))
	}
})

test('keepInRange then the rest: folding hunks one card at a time ends at an empty diff', () => {
	let base = BASE
	for (const [s, e] of [[2, 4], [6, 9]]) {
		base = k.keepInRange(base, NOW, s, e).baseline
	}
	assert.equal(base, NOW)
	assert.deepEqual(k.hunksBetween(base, NOW), [])
})

test('a kept hunk does not come back when lines are added above it, and a later edit in it is shown against the kept text', () => {
	const kept = k.keepInRange(BASE, NOW, 2, 4).baseline
	// Someone adds two lines at the top: the kept hunk moves down by two, and the baseline (a text) still holds it.
	const lines = s => s.trimEnd().split('\n')
	const moved = text('// header', '// header 2', ...lines(NOW))
	const baseAbove = text('// header', '// header 2', ...lines(kept))
	assert.deepEqual(k.hunksBetween(baseAbove, moved).map(h => h.lines.join('|')), ['+    two and a half'])
	// A further change of the kept method shows as a change of its own, not as the kept one over again.
	const further = NOW.replace('one changed', 'one changed again')
	assert.deepEqual(k.hunksBetween(kept, further).map(h => h.lines.join('|')), ['-    one changed|+    one changed again', '+    two and a half'])
})

test('chooseCommandBaseline: the turn-start snapshot wins over HEAD; HEAD over nothing; a file HEAD lacks is created', () => {
	assert.deepEqual(k.chooseCommandBaseline('snapshot', { state: 'found', text: 'head' }), { text: 'snapshot', created: false, from: 'turn-start' })
	assert.deepEqual(k.chooseCommandBaseline(undefined, { state: 'found', text: 'head' }), { text: 'head', created: false, from: 'head' })
	assert.deepEqual(k.chooseCommandBaseline(undefined, { state: 'absent' }), { text: '', created: true, from: 'created' })
	assert.equal(k.chooseCommandBaseline(undefined, { state: 'unknown' }), undefined, 'git could not say: record nothing')
	assert.deepEqual(k.chooseCommandBaseline('', { state: 'unknown' }), { text: '', created: false, from: 'turn-start' }, 'an empty snapshot is still a snapshot')
})

test('reviewable: binary and huge files are skipped, an unchanged one has nothing to show', () => {
	assert.equal(k.reviewable('a\n', 'b\n'), 'ok')
	assert.equal(k.reviewable('a\n', 'a\n'), 'same')
	assert.equal(k.reviewable('a\n', 'PK\0\u0003binary'), 'binary')
	assert.equal(k.reviewable('', 'x'.repeat(k.MAX_REVIEW_TEXT + 1)), 'large')
	assert.equal(k.reviewable('', ''), 'same')
})
