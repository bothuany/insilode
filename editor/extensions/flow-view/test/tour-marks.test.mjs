// The pen marks of a tour step (src/tour/marks.ts): resolved to current-file lines and cards in a tool call (strict: a mistake is an
// error naming the field) and in a tour file (what is wrong is dropped). Pure, so it is bundled with esbuild and run under plain Node.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let m
let v
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-tour-marks-'))
	for (const name of ['marks', 'validate']) {
		const outfile = join(tmp, `${name}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', 'tour', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		const mod = await import(pathToFileURL(outfile).href)
		if (name === 'marks') m = mod
		else v = mod
	}
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const work = resolve(tmpdir(), 'insilode-marks-work')
const PLACE = join(work, 'src', 'OrderService.cs')
const PRICE = join(work, 'src', 'PriceCalculator.cs')
const text = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n')
const methods = new Map([
	[PLACE, [{ name: 'OrderService.Place', startLine: 58, endLine: 90 }, { name: 'OrderService.Cancel', startLine: 92, endLine: 110 }]],
	[PRICE, [{ name: 'PriceCalculator.Total', startLine: 30, endLine: 52 }]],
])
const host = { roots: [work], readText: f => (methods.has(f) ? text : undefined), methodsIn: f => methods.get(f) }

/** The step the marks are on, placed like validate.ts places it. */
const placed = { title: 'Place', caption: 'c', state: 'ok', at: { file: PLACE, startLine: 58, endLine: 90, label: 'OrderService.Place' } }
const run = (raw, { strict = true, step = placed } = {}) => m.parseMarks(raw, { where: 'steps[1]', strict, step, file: step.at?.file, text, host })
const fails = (raw, pattern) => assert.throws(() => run(raw), e => e instanceof m.MarkError && pattern.test(e.message), String(pattern))

test('every kind resolves to the mark the canvas draws, in the agent\'s order, with a label and a sentence kept', () => {
	const { marks, notes } = run([
		{ kind: 'ring', lines: [71, 76] },
		{ kind: 'underline', lines: [72], sentence: 2 },
		{ kind: 'strike', lines: [80, 78] },
		{ kind: 'check', lines: [60, 60], label: 'right' },
		{ kind: 'cross', lines: [61] },
		{ kind: 'badge', lines: [62], n: 3 },
	])
	assert.deepEqual(notes, [])
	assert.deepEqual(marks, [
		{ kind: 'ring', lines: [71, 76] },
		{ kind: 'underline', lines: [72, 72], sentence: 2 },
		{ kind: 'strike', lines: [78, 80] },
		{ kind: 'check', lines: [60, 60], label: 'right' },
		{ kind: 'cross', lines: [61, 61] },
		{ kind: 'badge', lines: [62, 62], n: 3 },
	])
	const connect = run([{ kind: 'connect', to: { file: 'src/PriceCalculator.cs', method: 'PriceCalculator.Total' }, label: 'price', sentence: 6 }])
	assert.deepEqual(connect.marks, [{ kind: 'connect', to: { file: PRICE, startLine: 30, endLine: 52, label: 'PriceCalculator.Total' }, label: 'price', sentence: 6 }])
})

test('a range is cut to 80 lines like a highlight, and a label loses its control characters', () => {
	const wide = { ...placed, at: { ...placed.at, startLine: 1, endLine: 120 } }
	const { marks } = run([{ kind: 'ring', lines: [5, 110], label: 'a\nb\tc' }], { step: wide })
	assert.deepEqual(marks, [{ kind: 'ring', lines: [5, 84], label: 'a b c' }])
})

test('lines outside the method are dropped with a note naming the mark, the lines and the method', () => {
	const { marks, notes } = run([{ kind: 'ring', lines: [40, 44] }, { kind: 'underline', lines: [89, 91] }, { kind: 'check', lines: [95] }, { kind: 'strike', lines: [70] }])
	assert.deepEqual(marks, [{ kind: 'strike', lines: [70, 70] }])
	assert.deepEqual(notes, [
		'mark 1 (ring): lines 40-44 are outside OrderService.Place; dropped',
		'mark 2 (underline): lines 89-91 are outside OrderService.Place; dropped',
		'mark 3 (check): line 95 is outside OrderService.Place; dropped',
	])
})

test('a mark without what its kind needs is dropped with a note, in a tool call too', () => {
	const { marks, notes } = run([{ kind: 'ring' }, { kind: 'badge', lines: [60] }, { kind: 'connect', label: 'x' }, { kind: 'ring', lines: [0] }])
	assert.deepEqual(marks, [])
	assert.match(notes[0], /mark 1 \(ring\): needs `lines`/)
	assert.match(notes[1], /mark 2 \(badge\): needs `n`/)
	assert.match(notes[2], /mark 3 \(connect\): needs `to`/)
	assert.match(notes[3], /mark 4 \(ring\): needs `lines`/)
})

test('a step that is missing, or points at no code, drops every mark with one note and never draws on a wrong place', () => {
	const missing = { title: 'm', caption: 'c', state: 'missing', at: { file: PLACE, startLine: 60, endLine: 60, label: 'OrderService.Plase' } }
	const a = run([{ kind: 'ring', lines: [60] }, { kind: 'check', lines: [60] }], { step: missing })
	assert.deepEqual(a.marks, [])
	assert.deepEqual(a.notes, ['the marks were dropped: the step\'s code was not found'])
	const intro = run([{ kind: 'ring', lines: [60] }], { step: { title: 'i', caption: 'c', state: 'ok' } })
	assert.deepEqual(intro.notes, ['the mark was dropped: the step points at no code'])
	const table = run([{ kind: 'ring', lines: [1] }], { step: { title: 't', caption: 'c', state: 'ok', at: { file: '', startLine: 0, endLine: 0, label: 'orders', table: 'orders' } } })
	assert.equal(table.marks.length, 0)
	assert.throws(() => run([{ kind: 'nope' }], { step: missing }), /kind must be one of/, 'a malformed mark is still heard about on a missing step')
})

test('connect finds its target by method (a moved one too) and drops an unknown one, or one outside the workspace, with a note', () => {
	const moved = run([{ kind: 'connect', to: { file: 'src/PriceCalculator.cs', method: 'Total', line: 5 } }])
	assert.deepEqual(moved.marks[0].to, { file: PRICE, startLine: 30, endLine: 52, label: 'PriceCalculator.Total' })
	const byLine = run([{ kind: 'connect', to: { file: PRICE, line: 40 } }])
	assert.equal(byLine.marks[0].to.label, 'PriceCalculator.Total')
	const unknown = run([{ kind: 'connect', to: { file: 'src/PriceCalculator.cs', method: 'PriceCalculator.Tota1' } }])
	assert.deepEqual(unknown.marks, [])
	assert.match(unknown.notes[0], /^mark 1 \(connect\): connect to src\/PriceCalculator\.cs:PriceCalculator\.Tota1 not found \(no method "PriceCalculator\.Tota1" in the file \(closest: PriceCalculator\.Total\)\)/)
	const nofile = run([{ kind: 'connect', to: { file: 'src/Gone.cs', method: 'X' } }])
	assert.match(nofile.notes[0], /connect to src\/Gone\.cs:X not found/)
	const outside = run([{ kind: 'connect', to: { file: '../../etc/passwd', line: 1 } }])
	assert.deepEqual(outside.marks, [])
	assert.match(outside.notes[0], /not inside the workspace/)
})

test('in a tool call, too many marks, an unknown field or kind, a bad n, a long label and a bad sentence are errors naming the field', () => {
	fails('ring', /steps\[1\]\.marks must be a list/)
	fails(Array.from({ length: 7 }, () => ({ kind: 'ring', lines: [60] })), /steps\[1\]\.marks has 7 marks; a step has at most 6/)
	fails([{ kind: 'ring', lines: [60] }, { kind: 'ring', colour: 'red' }], /steps\[1\]\.marks\[1\]\.colour is not a field of a mark/)
	fails([{ kind: 'sparkle', lines: [60] }], /steps\[1\]\.marks\[0\]\.kind must be one of/)
	fails([{ lines: [60] }], /marks\[0\]\.kind/)
	fails([{ kind: 'badge', lines: [60], n: 0 }], /marks\[0\]\.n must be a whole number from 1 to 99/)
	fails([{ kind: 'badge', lines: [60], n: 100 }], /marks\[0\]\.n/)
	fails([{ kind: 'badge', lines: [60], n: 1.5 }], /marks\[0\]\.n/)
	fails([{ kind: 'ring', lines: [60], label: 'x'.repeat(41) }], /marks\[0\]\.label must be text of at most 40/)
	fails([{ kind: 'ring', lines: [60], sentence: 0 }], /marks\[0\]\.sentence must be a whole number from 1 to 6/)
	fails([{ kind: 'ring', lines: [60], sentence: 7 }], /marks\[0\]\.sentence/)
	fails([{ kind: 'connect', to: { file: 'src/a.cs', colour: 1 } }], /marks\[0\]\.to\.colour is not a field of `to`/)
	fails([{ kind: 'connect', to: {} }], /marks\[0\]\.to\.file is missing/)
	fails(['ring'], /marks\[0\] is not an object/)
	assert.equal(run([{ kind: 'badge', lines: [60], n: 99 }, { kind: 'ring', lines: [60], label: 'x'.repeat(40), sentence: 6 }]).marks.length, 2, 'the limits themselves are fine')
})

test('in a tour file the same mistakes are dropped silently: the mark, or just the field that is wrong', () => {
	const file = (raw) => run(raw, { strict: false })
	assert.deepEqual(file('ring'), { marks: [], notes: [] })
	assert.equal(file(Array.from({ length: 9 }, () => ({ kind: 'ring', lines: [60] }))).marks.length, 6, 'the first six stay')
	assert.deepEqual(file([{ kind: 'sparkle', lines: [60] }, { kind: 'ring', colour: 'red', lines: [60] }, 'ring', { kind: 'badge', lines: [60], n: 0 }]), { marks: [], notes: [] })
	assert.deepEqual(file([{ kind: 'ring', lines: [60], label: 'x'.repeat(41), sentence: 9 }, { kind: 'ring', lines: [61], n: 500 }]).marks, [{ kind: 'ring', lines: [60, 60] }, { kind: 'ring', lines: [61, 61] }])
	assert.deepEqual(file([{ kind: 'connect', to: { file: 'src/PriceCalculator.cs', colour: 1 } }]).marks, [], 'a target with a field of its own is not a target')
})

// ---- the whole path: parseTourArgs and parseTourFile ----------------------------------------------------------------------

test('through parseTourArgs the marks land on the step and the notes join the step\'s note', () => {
	const { tour, notes } = v.parseTourArgs({
		title: 'T',
		steps: [
			{ caption: 'Intro' },
			{ file: PLACE, method: 'OrderService.Place', line: 70, caption: 'Prices are copied here.', marks: [{ kind: 'ring', lines: [71, 76] }, { kind: 'check', lines: [40] }, { kind: 'connect', to: { file: PRICE, method: 'Total' }, label: 'price' }] },
		],
	}, host, 'Agent tour')
	assert.equal(tour.steps[0].marks, undefined)
	assert.deepEqual(tour.steps[1].marks, [
		{ kind: 'ring', lines: [71, 76] },
		{ kind: 'connect', to: { file: PRICE, startLine: 30, endLine: 52, label: 'PriceCalculator.Total' }, label: 'price' },
	])
	assert.equal(notes[0], undefined)
	assert.match(notes[1], /mark 2 \(check\): line 40 is outside OrderService\.Place/)
})

test('through parseTourArgs a mistake in a mark is an error naming the step and the mark', () => {
	assert.throws(() => v.parseTourArgs({ title: 'T', steps: [{ caption: 'a' }, { file: PLACE, line: 70, caption: 'b', marks: [{ kind: 'ring', lines: [71], shiny: true }] }] }, host, 'x'), /steps\[1\]\.marks\[0\]\.shiny is not a field of a mark/)
	assert.throws(() => v.parseTourArgs({ title: 'T', steps: [{ file: PLACE, line: 70, caption: 'b', marks: 'ring' }] }, host, 'x'), /steps\[0\]\.marks must be a list/)
})

test('through parseTourFile a bad mark is dropped without a word and the tour still loads', () => {
	const { tour } = v.parseTourFile({ insilodeTour: 1, id: 't', title: 'T', steps: [{ file: PLACE, method: 'OrderService.Place', caption: 'b', marks: [{ kind: 'sparkle' }, { kind: 'ring', lines: [71] }] }] }, host)
	assert.deepEqual(tour.steps[0].marks, [{ kind: 'ring', lines: [71, 71] }])
})

test('stepFiles lists the file a connect mark ends at, so its methods are known before the tour is placed', () => {
	const files = v.stepFiles({ steps: [{ file: 'src/OrderService.cs', caption: 'a', marks: [{ kind: 'connect', to: { file: 'src/PriceCalculator.cs' } }] }] }, [work])
	assert.deepEqual(files.sort(), [PLACE, PRICE].sort())
})
