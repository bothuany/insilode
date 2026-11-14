// Skeleton first, after the hand-over: the developer's declarations are kept as header text, an agent edits the files, and
// every kept header that is gone comes back as a warning (changed, renamed, removed) with the text before and after. Revert puts
// the header back and leaves the body the agent wrote.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'
import { Index } from './helpers.mjs'
import { FIXTURES, mod } from './types-helpers.mjs'

after(cleanup)

const match = await load('src/skeleton/match.ts')
const guard = await load('src/skeleton/guard.ts')
const spec = await load('../../../board-canvas/spec.ts')

const PLAN = spec.parseBoard({
	kind: 'class',
	title: 'Checkout',
	nodes: [
		{ id: 'svc', label: 'CheckoutService', kind: 'service', members: [{ text: 'checkout(order: Order): ReceiptDto' }] },
		{ id: 'money', label: 'Money', members: [{ text: 'cents: number' }] },
		{ id: 'policy', label: 'DiscountPolicy', members: [{ text: 'apply(order: Order): Money' }] },
		{ id: 'order', label: 'Order', members: [{ text: 'total(): Money' }, { text: 'lines: OrderLine[]' }] },
	],
	edges: [],
})

async function graphOfDir(dir) {
	const { buildTypeGraph } = await mod('graph')
	const { nearestServiceResolver } = await mod('service')
	const index = new Index(dir)
	try {
		await index.ready
		const poly = await index.request('typeFacts')
		return buildTypeGraph({ poly, moduleOf: nearestServiceResolver([dir]) })
	} finally {
		await index.close()
	}
}

test('headers: a method to its body, a field on its line, an abstract method without a body, past its annotations', () => {
	const text = ['class A {', '  @Override', '  public Money apply(Order order,', '      int pct) { return null; }', '  abstract total(): Money', '  name: string', '}'].join('\n')
	assert.deepEqual(guard.headerAt(text, 2, 'method'), { text: '  public Money apply(Order order,\n      int pct) {', start: 3, lines: 2 })
	assert.deepEqual(guard.headerAt(text, 5, 'method'), { text: '  abstract total(): Money', start: 5, lines: 1 })
	assert.deepEqual(guard.headerAt(text, 6, 'field'), { text: '  name: string', start: 6, lines: 1 })
	assert.equal(guard.headerAt('def f(self,\n      x: int) -> int:\n    return x', 1, 'method').lines, 2)
})

// Run once per line ending: a Windows checkout (core.autocrlf) hands the fixture over with CRLF, and a developer's files may have
// either, so the copy is rewritten to each one and the agent's edits keep the file's own line ending.
for (const eol of ['\n', '\r\n']) test(`an agent edit (${eol === '\n' ? 'LF' : 'CRLF'}): a changed signature and a renamed field are warned about, a reformatted line and a new body are not`, async () => {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'insilode-skeleton-')))
	try {
		cpSync(join(FIXTURES, 'skeleton-ts'), dir, { recursive: true })
		const src = join(dir, 'src', 'checkout')
		for (const f of readdirSync(src).map(f => join(src, f))) {
			writeFileSync(f, readFileSync(f, 'utf8').replace(/\r?\n/g, eol))
		}
		const before = await graphOfDir(dir)
		const diff = match.matchPlan(PLAN, before)
		const read = file => readFileSync(file, 'utf8')
		const edit = (file, from, to) => {
			const [x, y] = [from, to].map(t => t.replace(/\n/g, eol))
			const text = read(file)
			assert.ok(text.includes(x), `the agent's edit applies to ${file}`)
			writeFileSync(file, text.replace(x, y))
		}
		const kept = guard.headersOf(diff, before.types, read)
		assert.ok(kept.some(h => h.owner === 'CheckoutService' && h.name === 'checkout'))
		assert.ok(kept.some(h => h.owner === 'Money' && h.name === 'cents'))
		assert.ok(kept.some(h => h.owner === 'Order' && h.kind === 'type'))

		const checkout = join(src, 'checkout.ts')
		const money = join(src, 'money.ts')
		const order = join(src, 'order.ts')
		// The agent fills a body, adds a parameter, renames a field and reformats a line.
		edit(checkout, "async checkout(order: Order): Promise<ReceiptDto> {\n\t\tthrow new Error('todo')", "async checkout(order: Order, dryRun: boolean): Promise<ReceiptDto> {\n\t\treturn { orderId: order.id, total: order.total() }")
		edit(money, 'cents: number', 'amount: number')
		edit(order, 'total(): Money {\n\t\treturn new Money()', 'total():   Money {\n\t\treturn this.lines.reduce(() => new Money(), new Money())')

		const now = await graphOfDir(dir)
		const warnings = [checkout, money, order].flatMap(f => guard.goneIn(kept, f, read(f), (a, b) => a === b).map(h => guard.locate(h, now.types, read(f), kept)))
		assert.deepEqual(warnings.map(w => `${w.owner}.${w.name}:${w.reason}`).sort(), ['CheckoutService.checkout:changed', 'Money.cents:renamed'])
		const changed = warnings.find(w => w.name === 'checkout')
		assert.equal(guard.warningText(changed), 'The agent changed CheckoutService.checkout: async checkout(order: Order): Promise<ReceiptDto> → async checkout(order: Order, dryRun: boolean): Promise<ReceiptDto>')

		// Revert puts the developer's header back and keeps the body the agent wrote.
		const reverted = guard.revertText(read(checkout), changed)
		assert.match(reverted, /async checkout\(order: Order\): Promise<ReceiptDto> \{\r?\n\t\treturn \{ orderId/)
		assert.equal(guard.revertText(read(checkout).replace('dryRun: boolean', 'dry: boolean'), changed), undefined, 'a file that moved on is not written over')
		const renamed = warnings.find(w => w.name === 'cents')
		assert.equal(renamed.after.trim(), 'amount: number')
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
