// Where a tour step points when the code moved (src/tour/resolve.ts), and the strict reading of the MCP `tour` tool's arguments
// (parseTourArgs). Pure, so it is bundled with esbuild and run under plain Node, like tour-file.test.mjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let r
let v
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-tour-resolve-'))
	for (const name of ['resolve', 'validate']) {
		const outfile = join(tmp, `${name}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', 'tour', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		const mod = await import(pathToFileURL(outfile).href)
		if (name === 'resolve') r = mod
		else v = mod
	}
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const FILE = '/w/src/OrderService.cs'
const text = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join('\n')
const methods = [
	{ name: 'OrderService.Place', startLine: 58, endLine: 90 },
	{ name: 'OrderService.Cancel', startLine: 92, endLine: 110 },
	{ name: 'PriceCalculator.Total', startLine: 30, endLine: 52 },
	{ name: 'OrderService.Reserve', startLine: 10, endLine: 20 },
	{ name: 'InventoryClient.Reserve', startLine: 22, endLine: 28 },
]
const place = (input, where = {}) => r.placeStep({ caption: 'c', ...input }, { file: FILE, methods, text, base: 'OrderService.cs', ...where })

test('a method is found by its name: ok when the line hint is inside it, with the lines of the method', () => {
	const { step, note } = place({ method: 'OrderService.Place', line: 70, lines: [[71, 76]] })
	assert.equal(step.state, 'ok')
	assert.equal(note, undefined)
	assert.deepEqual(step.at, { file: FILE, startLine: 58, endLine: 90, label: 'OrderService.Place' })
	assert.deepEqual(step.highlights, [[71, 76]])
	assert.equal(step.title, 'OrderService.Place')
	assert.ok(step.peek.code.length > 0)
})

test('a method that moved is found and marked moved, with where it is now', () => {
	const { step, note } = place({ method: 'PriceCalculator.Total', line: 12 })
	assert.equal(step.state, 'moved')
	assert.deepEqual([step.at.startLine, step.at.endLine], [30, 52])
	assert.match(note, /you said line 12; the method is now at 30-52/)
})

test('a name without its owner matches the last segment; an owner must match when given', () => {
	assert.equal(place({ method: 'Place' }).step.at.label, 'OrderService.Place')
	assert.equal(place({ method: 'orderservice.place' }).step.state, 'ok', 'case is ignored')
	assert.equal(place({ method: 'Other.Place' }).step.state, 'missing', 'another owner is another method')
})

test('a method that is gone is missing, never placed wrongly, and the closest names are offered', () => {
	const { step, note } = place({ method: 'OrderService.Plase', line: 60 })
	assert.equal(step.state, 'missing')
	assert.match(note, /no method "OrderService.Plase" in the file \(closest: OrderService.Place\)/)
	assert.equal(step.peek, undefined, 'no code is shown for a step that points nowhere')
	const far = place({ method: 'Completely.Different' })
	assert.equal(far.step.state, 'missing')
	assert.doesNotMatch(far.note, /closest/)
})

test('a renamed method: the closest name is the one that was renamed', () => {
	const { note } = place({ method: 'InventoryClient.ReserveStock' })
	assert.match(note, /closest: InventoryClient.Reserve, OrderService.Reserve/)
})

test('overloads: the one nearest the line hint wins, and the step says there were several', () => {
	const overloads = [{ name: 'Repo.Save', startLine: 10, endLine: 20 }, { name: 'Repo.Save', startLine: 40, endLine: 55 }, { name: 'Repo.Save', startLine: 80, endLine: 99 }]
	const near = place({ method: 'Repo.Save', line: 82 }, { methods: overloads })
	assert.deepEqual([near.step.at.startLine, near.step.state], [80, 'ok'])
	assert.match(near.note, /3 methods are called Repo.Save/)
	const between = place({ method: 'Save', line: 33 }, { methods: overloads })
	assert.equal(between.step.at.startLine, 40, 'by distance to the range')
	assert.equal(place({ method: 'Save' }, { methods: overloads }).step.at.startLine, 10, 'without a hint, the first')
})

test('a line alone: the innermost method that holds it', () => {
	const nested = [{ name: 'Outer.Run', startLine: 10, endLine: 60 }, { name: 'Outer.Run.inner', startLine: 20, endLine: 30 }]
	assert.equal(place({ line: 25 }, { methods: nested }).step.at.label, 'Outer.Run.inner')
	assert.equal(place({ line: 40 }, { methods: nested }).step.at.label, 'Outer.Run')
})

test('a line that no method holds is placed by the line, and says so; with no list of methods it is placed by line quietly', () => {
	const { step, note } = place({ line: 115 })
	assert.deepEqual([step.state, step.at.startLine, step.at.label], ['ok', 115, 'OrderService.cs:115'])
	assert.match(note, /no method holds line 115/)
	const unknown = place({ line: 70 }, { methods: undefined })
	assert.equal(unknown.step.state, 'ok')
	assert.equal(unknown.note, undefined)
	assert.equal(place({ method: 'Place', line: 70 }, { methods: undefined }).note, 'the methods of this file could not be listed: placed by line')
	assert.equal(place({ method: 'Place' }, { methods: undefined }).step.state, 'missing', 'a name with no list and no line cannot be found')
})

test('neither a method nor a line is missing; an unreadable file is missing; a caption alone points nowhere', () => {
	assert.match(place({}).note, /give `method`/)
	assert.equal(place({}).step.state, 'missing')
	const unreadable = place({ method: 'OrderService.Place' }, { text: undefined })
	assert.equal(unreadable.step.state, 'missing')
	assert.match(unreadable.note, /cannot be read/)
	const intro = r.placeStep({ caption: 'Hello', title: 'Intro' }, {})
	assert.deepEqual(intro.step, { title: 'Intro', caption: 'Hello', state: 'ok' })
	const table = r.placeStep({ caption: 'c', table: 'orders' }, {})
	assert.deepEqual(table.step.at, { file: '', startLine: 0, endLine: 0, label: 'orders', table: 'orders' })
})

test('highlights are kept, three at most, and one outside the method is noted', () => {
	const { step, note } = place({ method: 'OrderService.Place', lines: [[71, 76], [200, 201]] })
	assert.deepEqual(step.highlights, [[71, 76], [200, 201]])
	assert.match(note, /a highlight lies outside the method/)
	assert.equal(place({ method: 'OrderService.Place', lines: [[1, 2], [3, 4], [5, 6], [7, 8]] }).step.highlights.length, 3)
})

test('nameMatches and closestNames', () => {
	assert.ok(r.nameMatches('A.B.run', 'run'))
	assert.ok(r.nameMatches('A.B.run', 'B.run'))
	assert.ok(r.nameMatches('Ns::Cls#run', 'cls.run'), 'separators of every language')
	assert.ok(!r.nameMatches('A.B.run', 'A.run'))
	assert.ok(!r.nameMatches('run', ''))
	assert.deepEqual(r.closestNames([{ name: 'A.getUser' }, { name: 'A.deleteUser' }, { name: 'A.zzzzzz' }], 'A.getUsers'), ['A.getUser'])
})

// ---- which steps the drawn flow does not hold -------------------------------------------------------------------------

const node = (file, startLine, endLine, children = [], extra = {}) => ({ key: 'k', symbolId: null, label: 'x', sub: '', kind: 'method', file, startLine, endLine, code: null, children: children.map(n => ({ callLine: 1, edgeKind: 'call', node: n })), ...extra })

test('markOffFlow: a placed step no drawn card holds is offflow, one a card holds stays, a table needs its card', () => {
	const root = node('C:\\w\\src\\OrderService.cs', 58, 90, [node(null, 0, 0, [], { schema: { table: 'orders' } })])
	const steps = [
		place({ method: 'OrderService.Place' }).step,
		place({ method: 'PriceCalculator.Total' }).step,
		r.placeStep({ caption: 'c', table: 'Orders' }, {}).step,
		r.placeStep({ caption: 'c', table: 'invoices' }, {}).step,
		place({ method: 'Nope.Nope' }).step,
		r.placeStep({ caption: 'intro' }, {}).step,
	]
	steps[0].at.file = 'c:/w/src/OrderService.cs'
	const notes = r.markOffFlow(steps, r.drawnOf(root, null))
	assert.deepEqual(steps.map(s => s.state), ['ok', 'offflow', 'ok', 'missing', 'missing', 'ok'])
	assert.match(notes.get(1), /side card/)
	assert.match(notes.get(3), /no card for table "invoices"/)
	assert.equal(notes.has(0), false)
})

// ---- the arguments of the tour tool -------------------------------------------------------------------------------------

const work = resolve(tmpdir(), 'insilode-tour-args')
const host = { roots: [work], readText: () => text, methodsIn: () => methods }
const args = (extra = {}) => ({ title: 'T', steps: [{ caption: 'one' }], ...extra })
const parse = (raw, h = host) => v.parseTourArgs(raw, h, 'Agent tour')
const fails = (raw, pattern) => assert.throws(() => parse(raw), e => e instanceof v.TourFileError && pattern.test(e.message), String(pattern))

test('tool arguments: a tour with an id, a title, steps placed by method, and the agent as its origin', () => {
	const { tour, flow, notes } = parse(args({ id: 'place-order', start: 2, steps: [{ caption: 'intro' }, { file: 'src/OrderService.cs', method: 'OrderService.Place', line: 70, caption: 'why' }] }))
	assert.deepEqual([tour.id, tour.title, tour.origin, tour.source, tour.start], ['place-order', 'T', 'Agent tour', 'agent', 1])
	assert.deepEqual(tour.steps.map(s => s.state), ['ok', 'ok'])
	assert.equal(tour.steps[1].at.file, join(work, 'src', 'OrderService.cs'))
	assert.equal(tour.steps[1].at.startLine, 58)
	assert.equal(flow, undefined)
	assert.deepEqual(notes, [undefined, undefined])
	assert.equal(parse(args()).tour.id, 'tour', 'the default id')
})

test('tool arguments: limits and strangers are errors that name the field', () => {
	fails(args({ steps: Array.from({ length: 31 }, () => ({ caption: 'x' })) }), /31 steps.*at most 30/)
	fails(args({ steps: [{ caption: 'x'.repeat(601) }] }), /steps\[0\]\.caption is 601 characters/)
	fails(args({ title: 'y'.repeat(121) }), /`title`/)
	fails(args({ title: '' }), /`title` is required/)
	fails(args({ extra: 1 }), /tour\.extra is not a field of a tour \(allowed: id, title, flow, steps, start, followUps\)/)
	fails(args({ steps: [{ caption: 'x', command: 'workbench.action.terminal.new' }] }), /steps\[0\]\.command is not a field of a tour step/)
	fails(args({ flow: { shell: 'x' } }), /flow\.shell/)
	fails(args({ flow: { http: 'GET /x' } }), /flow\.http/)
	fails(args({ steps: [{ caption: 'x', file: '../../etc/passwd', line: 1 }] }), /steps\[0\]\.file "..\/..\/etc\/passwd" is not inside the workspace/)
	fails(args({ steps: [{ caption: 'x', file: 'a.cs', line: 0 }] }), /steps\[0\]\.line/)
	fails(args({ start: 0 }), /`start`/)
	fails(args({ id: '../x' }), /`id`/)
	fails({ title: 'T' }, /"steps" must list at least one/)
	fails('tour', /arguments of `tour` are an object/)
})

test('tool arguments: the flow to play on', () => {
	assert.deepEqual(parse(args({ flow: { id: 'poly:a#f@1' } })).flow, { id: 'poly:a#f@1' })
	assert.deepEqual(parse(args({ flow: { file: 'src/OrderService.cs', method: 'OrderService.Place' } })).flow, { file: join(work, 'src', 'OrderService.cs'), method: 'OrderService.Place' })
	assert.deepEqual(parse(args({ flow: { changes: true, base: 'branch' } })).flow, { changes: true, base: 'branch' })
	fails(args({ flow: { changes: true, base: 'tomorrow' } }), /flow\.base must be one of/)
	fails(args({ flow: { file: '../x.cs' } }), /flow\.file/)
})

test('tool arguments: a step with a method the file does not have is missing, and the report says what is closest', () => {
	const { tour, notes } = parse(args({ steps: [{ caption: 'c', file: 'src/OrderService.cs', method: 'OrderService.Plase' }] }))
	assert.equal(tour.steps[0].state, 'missing')
	assert.match(notes[0], /closest: OrderService.Place/)
})

test('stepFiles: the workspace files the steps name, once each, never a table step or a file outside', () => {
	const files = v.stepFiles({ steps: [{ file: 'a.cs' }, { file: 'a.cs' }, { file: 'b.cs', table: 'orders' }, { file: '../x.cs' }, { caption: 'c' }, 'junk', { file: 7 }] }, [work])
	assert.deepEqual(files, [join(work, 'a.cs')])
	assert.deepEqual(v.stepFiles(null, [work]), [])
})
