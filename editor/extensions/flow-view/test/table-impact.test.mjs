// A changed entity end to end on a real index: the turn impact names its table and the endpoints that use it, and the change set draws
// a root item for the table with each endpoint's flow cut down to the path that reaches the marked database card.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Index, ROOT } from './helpers.mjs'
import { cleanup, load } from './bundle.mjs'
import { join } from 'node:path'

const FOLDER = join(ROOT, 'test', 'table-fixtures', 'java-jpa')
const file = name => join(FOLDER, 'src', 'main', 'java', 'com', 'acme', name)

let impact
let changeSet
let tableIndex
let index
let entries
let asked
before(async () => {
	impact = await load('src/mcp/turnImpact.ts')
	changeSet = await load('src/changeSet.ts')
	tableIndex = await load('src/mcp/tableIndex.ts')
	index = new Index(FOLDER)
	await index.ready
	entries = (await index.request('entries')).map(e => ({ ...e, source: 'poly' }))
	asked = { tables: 0 }
})
after(async () => {
	await index?.close()
	cleanup()
})

const deps = (rangesOf) => {
	const tables = new tableIndex.TableIndex({
		entries: () => entries,
		poly: { isReady: true, entities: () => index.request('entities'), tables: ms => { asked.tables++; return index.request('tables', ms) } },
		analyzer: { isReady: false, entities: async () => undefined, tables: async () => undefined },
	})
	return {
		analyzer: { isReady: false },
		poly: { isReady: true, refresh: async () => undefined, methods: f => index.request('methods', f) },
		endpoints: { cached: () => entries },
		providerFor: () => ({ impact: async t => ({ label: 'endpoint', items: [] }), graph: async t => index.graph(t.id), callers: async () => null }),
		rangesOf,
		tables,
	}
}

test('an edit in an entity file names the table and every endpoint that reads or writes it', async () => {
	const r = await impact.turnImpact([file('Order.java')], deps(async () => undefined))
	assert.equal(r.tables.length, 1)
	const [t] = r.tables
	assert.deepEqual([t.entity, t.table, t.guess, t.endpoints, t.writers, t.readers], ['Order', 'orders', false, 3, 1, 2])
	assert.deepEqual(t.uses.map(u => `${u.mode} ${u.endpoint.label} ${u.certain ? 'certain' : 'guessed'}`), ['read GET /orders certain', 'read GET /reports/revenue guessed', 'write POST /orders certain'])
	assert.deepEqual(r.flows, [], 'no changed method: the call graph has nothing to add')
})

test('an edit in a service method costs no table walk and names no table', async () => {
	asked.tables = 0
	const methods = await index.request('methods', file('OrderService.java'))
	const place = methods.find(m => m.name.endsWith('place'))
	const r = await impact.turnImpact([file('OrderService.java')], deps(async () => [{ start: place.startLine + 1, end: place.startLine + 1 }]))
	assert.deepEqual(r.tables, [])
	assert.equal(asked.tables, 0)
})

test('the change set draws a root item for the table and each endpoint cut down to the marked database card', async () => {
	const provider = new changeSet.ChangeSetProvider({
		impactOf: (files, limits) => impact.turnImpact(files, deps(async () => undefined), limits),
		providerFor: () => ({ graph: async t => index.graph(t.id), callers: async () => null, impact: async () => ({ label: 'endpoint', items: [] }) }),
		annotate: async () => undefined,
	})
	provider.use({ label: 'Changes since main', files: [file('Order.java')] })
	const root = await provider.graph()
	const [table, ...flows] = root.children.map(c => c.node)
	assert.equal(table.label, 'Order changed → table orders')
	assert.equal(table.sub, '3 endpoints read or write it')
	assert.equal(table.kind, 'db')
	assert.match(root.sub, /1 changed file · 3 endpoints · 1 changed table \(3 endpoints read or write it; not checked: dynamic SQL/)
	assert.equal(flows.length, 3)
	const path = n => n.children.length ? `${n.label}${n.children.map(c => ` > ${path(c.node)}`).join('')}` : `${n.label}${n.tableChange ? ' [table changed]' : ''}`
	assert.deepEqual(flows.map(f => path(f)).sort(), [
		'OrderController.create > OrderService.place > orders [table changed]',
		'OrderController.list > OrderService.list > orders [table changed]',
		'OrderController.revenue > OrderService.revenueReport > orders [table changed]',
	].sort())
	// A flow's other cards are cut away: the controller reaches the service, the service reaches the table, nothing else is drawn.
	assert.ok(flows.every(f => f.children.length === 1))
	// The guessed link is drawn as a guess: the raw SQL edge carries `guess`.
	const revenue = flows.find(f => f.label === 'OrderController.revenue')
	assert.equal(revenue.children[0].node.children[0].guess, true)
})

// A file of models has no methods: where the edit landed still says which model it is in.
test('an edit in one of two models in a file names that one table, in models.py and in schema.prisma', async () => {
	const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
	const { tmpdir } = await import('node:os')
	const dir = mkdtempSync(join(tmpdir(), 'flow-models-'))
	let own
	try {
		mkdirSync(join(dir, 'prisma'))
		const py = join(dir, 'models.py')
		const prisma = join(dir, 'prisma', 'schema.prisma')
		writeFileSync(py, ['from sqlalchemy import Column, Integer', 'from sqlalchemy.orm import declarative_base', 'Base = declarative_base()', '', 'class Order(Base):', '    __tablename__ = "orders"', '    id = Column(Integer, primary_key=True)', '', 'class Customer(Base):', '    __tablename__ = "customers"', '    id = Column(Integer, primary_key=True)', ''].join('\n'))
		writeFileSync(prisma, ['model Order {', '  id Int @id', '  @@map("orders")', '}', '', 'model Customer {', '  id Int @id', '  @@map("customers")', '}', ''].join('\n'))
		own = new Index(dir)
		await own.ready
		const ents = await own.request('entities')
		const mk = rangesOf => ({
			analyzer: { isReady: false },
			poly: { isReady: true, refresh: async () => undefined, methods: f => own.request('methods', f) },
			endpoints: { cached: () => [] },
			providerFor: () => ({ impact: async () => ({ label: 'endpoint', items: [] }) }),
			rangesOf,
			tables: new tableIndex.TableIndex({ entries: () => [], poly: { isReady: true, entities: async () => ents, tables: ms => own.request('tables', ms) }, analyzer: { isReady: false, entities: async () => undefined, tables: async () => undefined } }),
		})
		const named = async (file, ranges) => (await impact.turnImpact([file], mk(async () => ranges))).tables.map(t => t.entity).sort()
		assert.deepEqual(await named(py, [{ start: 11, end: 11 }]), ['Customer'])
		assert.deepEqual(await named(py, [{ start: 6, end: 6 }]), ['Order'])
		assert.deepEqual(await named(prisma, [{ start: 7, end: 7 }]), ['Customer'])
		assert.deepEqual(await named(prisma, [{ start: 3, end: 3 }]), ['Order'])
		assert.deepEqual(await named(py, undefined), ['Customer', 'Order'], 'without lines the whole file counts')
	} finally {
		await own?.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

test('a span the disk no longer agrees with cannot place an edit: that entity counts as changed', () => {
	const list = [{ entity: 'Order', table: 'orders', schemaName: null, orm: 'EF Core', guess: false, spans: [{ file: '/w/E.cs', line: 3, endLine: 5 }] }]
	const fresh = 'namespace S;\n\npublic class Order\n{\n}\n\npublic class Other\n{\n}\n'
	const moved = 'namespace S;\n// a\n// b\n// c\n\npublic class Order\n{\n}\n'
	const at = (text, line) => tableIndex.entitiesTouched(list, '/w/E.cs', [{ start: line, end: line }], text).length
	assert.equal(at(fresh, 8), 0, 'the edit is in Other: Order is untouched')
	assert.equal(at(fresh, 4), 1)
	assert.equal(at(moved, 8), 1, 'the analyzer has not seen the extra line: its span is stale, so the entity counts')
})

test('the change set counts the endpoints a table reaches, in its chip and for the agent, when no method changed', async () => {
	const provider = new changeSet.ChangeSetProvider({
		impactOf: (files, limits) => impact.turnImpact(files, deps(async () => undefined), limits),
		providerFor: () => ({ graph: async t => index.graph(t.id), callers: async () => null, impact: async () => ({ label: 'endpoint', items: [] }) }),
		annotate: async () => undefined,
	})
	provider.use({ label: 'Changes since main', files: [file('Order.java')] })
	await provider.graph()
	const { items } = await provider.impact()
	assert.deepEqual(items.map(i => i.label).sort(), ['GET /orders Order.list', 'GET /reports/revenue Order.revenue', 'POST /orders Order.create'].sort())
	const trace = await provider.latest()
	assert.deepEqual(impact.tableEndpoints(trace.impact).map(f => `${f.label} ${f.via[0]}`), ['GET /orders table orders', 'GET /reports/revenue table orders', 'POST /orders table orders'])
})
