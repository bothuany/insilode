// The DTO relation board, the architecture board, the type tree of the chips, and the Mermaid and PlantUML text of both.
// After an intended change to the text: UPDATE=1 node --test test/types-boards.test.mjs, then read the diff of test/types-expected.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'
import { ROOT } from './helpers.mjs'
import { csharpResponse, graphOf, mod, short } from './types-helpers.mjs'

after(cleanup)

const boards = await mod('boards')
const exporter = await mod('export')
const spec = await load('src/board/spec.ts')

const names = board => board.nodes.map(n => n.label).sort()
const edgeKey = (board, e) => `${short(e.from)}->${short(e.to)}`
const node = (board, name) => board.nodes.find(n => n.label === name)

function snapshot(name, text) {
	const dir = join(ROOT, 'test', 'types-expected')
	const file = join(dir, `${name}.txt`)
	if (process.env.UPDATE) {
		mkdirSync(dir, { recursive: true })
		writeFileSync(file, text + '\n')
		return
	}
	assert.ok(existsSync(file), `no snapshot ${name}: run UPDATE=1 node --test test/types-boards.test.mjs and read test/types-expected/${name}.txt`)
	assert.equal(text + '\n', readFileSync(file, 'utf8'))
}

test('the DTO board: DTOs and the enums they use, no entities, no services', async () => {
	const g = await graphOf('java-shop')
	const b = boards.dtoBoard(g)
	assert.equal(b.kind, 'er')
	assert.deepEqual(names(b), ['AddressDto', 'CategoryDto', 'CreateOrderRequest', 'Discount', 'Money', 'OrderDto', 'OrderLineDto', 'OrderSummary', 'Status'])
	assert.equal(node(b, 'Status').kind, 'enum')
	assert.deepEqual(node(b, 'Status').members.map(m => m.text), ['NEW', 'PAID', 'SHIPPED'])
	assert.equal(node(b, 'OrderDto').kind, 'dto')
	assert.equal(node(b, 'OrderDto').detail, 'name suffix Dto')
	assert.ok(node(b, 'OrderDto').file.endsWith('OrderDto.java'))
	assert.equal(node(b, 'OrderDto').group, 'mod:java-shop')
	assert.deepEqual(b.groups, [{ id: 'mod:java-shop', label: 'java-shop' }])
	// parseBoard accepts what the board builder makes: it is the format agents' boards go through as well.
	assert.equal(spec.parseBoard(b).nodes.length, b.nodes.length)
	assert.match(b.description, /9 types, \d+ relations\. 2 entities are hidden\./)
})

test('the DTO board: cardinalities from the field types, members that link to the type they refer to', async () => {
	const g = await graphOf('java-shop')
	const b = boards.dtoBoard(g)
	const by = (from, to) => b.edges.find(e => edgeKey(b, e) === `${from}->${to}`)
	assert.deepEqual([by('OrderDto', 'AddressDto').kind, by('OrderDto', 'AddressDto').fromCard, by('OrderDto', 'AddressDto').toCard], ['has', '1', '1'])
	assert.deepEqual([by('OrderDto', 'OrderLineDto').kind, by('OrderDto', 'OrderLineDto').toCard, by('OrderDto', 'OrderLineDto').label], ['has-many', '0..*', 'lines'])
	assert.equal(by('OrderLineDto', 'Money').toCard, '1')
	assert.equal(by('OrderDto', 'Status').toCard, '1')
	// parent is 1, children is 0..*: two edges, each with its own cardinality.
	const category = b.edges.filter(e => edgeKey(b, e) === 'CategoryDto->CategoryDto')
	assert.deepEqual(category.map(e => [e.label, e.toCard]).sort(), [['children', '0..*'], ['parent', '1']])
	const lines = node(b, 'OrderDto').members.find(m => m.text.startsWith('lines'))
	assert.equal(lines.text, 'lines: List<OrderLineDto>')
	assert.equal(short(lines.ref), 'OrderLineDto')
	assert.equal(node(b, 'OrderDto').members.find(m => m.text.startsWith('id')).ref, undefined)
})

test('the DTO board: entities when asked, enums when not turned off', async () => {
	const g = await graphOf('java-shop')
	const withEntities = boards.dtoBoard(g, { includeEntities: true })
	assert.ok(node(withEntities, 'OrderEntity'))
	assert.equal(node(withEntities, 'OrderEntity').kind, 'entity')
	assert.ok(withEntities.edges.some(e => edgeKey(withEntities, e) === 'OrderEntity->OrderLineEntity' && e.toCard === '0..*'))
	assert.doesNotMatch(withEntities.description, /hidden/)
	const noEnums = boards.dtoBoard(g, { includeEnums: false })
	assert.equal(node(noEnums, 'Status'), undefined)
	assert.equal(node(noEnums, 'OrderDto').members.find(m => m.text.startsWith('status')).ref, undefined)
})

test('the DTO board: focus is a neighbourhood of depth N, search keeps the matches and their neighbours', async () => {
	const g = await graphOf('java-shop')
	assert.deepEqual(names(boards.dtoBoard(g, { focusId: 'Money' })), ['Money', 'OrderLineDto', 'OrderSummary'])
	assert.deepEqual(names(boards.dtoBoard(g, { focusId: 'Money', depth: 0 })), ['Money'])
	assert.deepEqual(names(boards.dtoBoard(g, { focusId: 'Money', depth: 2 })), ['CreateOrderRequest', 'Discount', 'Money', 'OrderDto', 'OrderLineDto', 'OrderSummary'])
	const byId = boards.dtoBoard(g, { focusId: 'java:com.acme.shop.dto.Discount' })
	assert.deepEqual(names(byId), ['Discount', 'OrderSummary'])
	assert.equal(byId.title, 'DTO relations: Discount')
	// A field name matches too; the neighbours of the match come along.
	assert.deepEqual(names(boards.dtoBoard(g, { query: 'shipto' })), ['AddressDto', 'CreateOrderRequest', 'OrderLineDto'])
	assert.deepEqual(names(boards.dtoBoard(g, { query: 'CATEGORY' })), ['CategoryDto'])
	const none = boards.dtoBoard(g, { query: 'zzz' })
	assert.equal(none.nodes.length, 0)
	assert.match(none.description, /Nothing matches "zzz"/)
	assert.match(boards.dtoBoard(g, { focusId: 'Nope' }).description, /Focus "Nope" is not a type/)
	// A focus on an entity shows it even though entities are hidden.
	assert.deepEqual(names(boards.dtoBoard(g, { focusId: 'OrderEntity' })), ['OrderEntity'])
})

test('the DTO board: more nodes than the limit are cut, the most connected stay, and it says so', async () => {
	const g = await graphOf('java-shop')
	const b = boards.dtoBoard(g, { maxNodes: 3 })
	assert.equal(b.nodes.length, 3)
	assert.match(b.description, /Showing the 3 most connected of 9 types: search or focus a type to see the rest\./)
	assert.ok(b.edges.every(e => b.nodes.some(n => n.id === e.from) && b.nodes.some(n => n.id === e.to)))
	// The focus is never cut.
	assert.ok(node(boards.dtoBoard(g, { maxNodes: 1, focusId: 'Money' }), 'Money'))
})

test('a diagram cut by maxNodes exports with a first comment line that says how many types it shows', async () => {
	const g = await graphOf('java-shop')
	const cutBoard = boards.dtoBoard(g, { maxNodes: 3 })
	assert.deepEqual(boards.cutOf(cutBoard), { shown: 3, total: 9 })
	const mermaid = boards.withCutNote(exporter.exportMermaid(cutBoard), cutBoard, 'mermaid')
	assert.equal(mermaid.split('\n')[0], '%% showing 3 of 9 types')
	assert.equal(mermaid.split('\n')[1], exporter.exportMermaid(cutBoard).split('\n')[0], 'the diagram itself follows unchanged')
	const uml = boards.withCutNote(exporter.exportPlantUml(cutBoard), cutBoard, 'plantuml').split('\n')
	assert.equal(uml[0], '@startuml')
	assert.equal(uml[1], "' showing 3 of 9 types")
	// The architecture board says the same.
	const arch = boards.architectureBoard(g, { maxNodes: 2 })
	assert.equal(boards.withCutNote('flowchart LR', arch, 'mermaid').split('\n')[0], `%% showing ${boards.cutOf(arch).shown} of ${boards.cutOf(arch).total} types`)
})

test('a whole diagram exports with no cut comment', async () => {
	const g = await graphOf('java-shop')
	const whole = boards.dtoBoard(g)
	assert.equal(boards.cutOf(whole), undefined)
	const text = exporter.exportMermaid(whole)
	assert.equal(boards.withCutNote(text, whole, 'mermaid'), text)
	assert.doesNotMatch(boards.withCutNote(exporter.exportPlantUml(whole), whole, 'plantuml'), /showing/)
	// A search that matches nothing is not a cut either.
	assert.equal(boards.cutOf(boards.dtoBoard(g, { query: 'zzz' })), undefined)
})

test('an empty DTO diagram says why, and a filtered empty one does not blame the suffixes', async () => {
	const empty = boards.dtoBoard(await graphOf([], { options: { dtoSuffixes: ['Zzz', 'Yyy'] } }))
	assert.equal(empty.nodes.length, 0)
	assert.match(empty.description, /No DTO found: a name ending in Zzz, Yyy counts as one\./)
	const searched = boards.dtoBoard(await graphOf('java-shop'), { query: 'nothing-matches-this' })
	assert.equal(searched.nodes.length, 0)
	assert.doesNotMatch(searched.description, /No DTO found/)
})

test('the architecture board: modules closed, roles inside, injection as depends', async () => {
	const g = await graphOf('java-shop')
	const b = boards.architectureBoard(g)
	assert.equal(b.kind, 'architecture')
	assert.deepEqual(names(b), ['OrderController', 'OrderEntity', 'OrderLineEntity', 'OrderRepository', 'OrderService', 'PricingService', 'StringUtils'])
	assert.deepEqual(b.groups.map(g => [g.id, g.parent ?? '', g.collapsed ?? false]), [
		['mod:java-shop', '', true],
		['role:java-shop:controller', 'mod:java-shop', false],
		['role:java-shop:service', 'mod:java-shop', false],
		['role:java-shop:repository', 'mod:java-shop', false],
		['role:java-shop:entity', 'mod:java-shop', false],
		['role:java-shop:class', 'mod:java-shop', false],
	])
	assert.deepEqual(b.groups.filter(g => g.parent).map(g => g.label), ['Controllers', 'Services', 'Repositories', 'Entities', 'Classes'])
	assert.equal(node(b, 'OrderController').kind, 'controller')
	assert.equal(node(b, 'OrderController').group, 'role:java-shop:controller')
	assert.equal(node(b, 'OrderController').detail, 'controller · com.acme.shop.web')
	assert.equal(node(b, 'OrderRepository').kind, 'repository')
	const edges = b.edges.map(e => `${edgeKey(b, e)} ${e.kind}`).sort()
	assert.deepEqual(edges, [
		'OrderController->OrderService depends',
		'OrderEntity->OrderLineEntity uses',
		'OrderLineEntity->OrderEntity uses',
		'OrderRepository->OrderEntity uses',
		'OrderService->OrderRepository depends',
		'OrderService->PricingService depends',
	])
	// Methods are the members; the constructor is not one.
	assert.deepEqual(node(b, 'OrderService').members.map(m => m.text), ['place(CreateOrderRequest request): OrderDto', 'all(): List<OrderDto>'])
	assert.match(b.description, /7 types in 1 module, 6 relations\. Hidden roles: dto, enum\./)
	assert.equal(spec.parseBoard(b).nodes.length, 7)
})

test('the architecture board: roles can be shown, collapse levels, focus', async () => {
	const g = await graphOf('java-shop')
	const all = boards.architectureBoard(g, { hideRoles: [] })
	assert.ok(node(all, 'OrderDto'))
	assert.equal(node(all, 'OrderDto').kind, 'dto')
	assert.equal(node(all, 'Status').kind, 'enum')
	assert.ok(all.edges.some(e => edgeKey(all, e) === 'OrderService->OrderDto' && e.kind === 'uses'))
	assert.doesNotMatch(all.description, /Hidden roles/)
	// inheritance and injection beat a plain use between the same two types
	assert.equal(all.edges.filter(e => edgeKey(all, e) === 'OrderService->OrderRepository').length, 1)
	const roles = boards.architectureBoard(g, { collapse: 'role' })
	assert.deepEqual([roles.groups[0].collapsed, roles.groups[1].collapsed], [undefined, true])
	assert.ok(boards.architectureBoard(g, { collapse: 'none' }).groups.every(g => !g.collapsed))
	const focus = boards.architectureBoard(g, { focusId: 'OrderService', depth: 1 })
	assert.deepEqual(names(focus), ['OrderController', 'OrderRepository', 'OrderService', 'PricingService'])
	assert.equal(focus.title, 'Architecture: OrderService')
	const cut = boards.architectureBoard(g, { maxNodes: 2 })
	assert.equal(cut.nodes.length, 2)
	assert.match(cut.description, /Showing the 2 most connected of 7 types: hide roles or focus a type to see the rest\./)
})

test('the architecture board: C# types and class-to-class calls', async () => {
	const g = await graphOf([], { csharp: csharpResponse() })
	const b = boards.architectureBoard(g)
	assert.deepEqual(names(b), ['IOrderService', 'Order', 'OrderLine', 'OrderService', 'OrdersController', 'ShopDbContext'])
	const edges = b.edges.map(e => `${edgeKey(b, e)} ${e.kind}`).sort()
	assert.ok(edges.includes('OrderService->IOrderService implements'))
	assert.ok(edges.includes('OrdersController->IOrderService depends'))
	assert.ok(edges.includes('OrderService->ShopDbContext depends'))
	assert.ok(edges.includes('ShopDbContext->Order uses'))
	assert.deepEqual(b.groups.filter(g => !g.parent).map(g => g.label), ['Shop.Api'])
	// Calls the index resolved fill in where nothing else links two types.
	const withCalls = { ...g, calls: [{ from: 'csharp:Shop.Api.Controllers.OrdersController', to: 'csharp:Shop.Api.Services.OrderService', count: 3 }] }
	const c = boards.architectureBoard(withCalls)
	assert.ok(c.edges.some(e => e.kind === 'calls' && e.label === '3 calls' && edgeKey(c, e) === 'OrdersController->OrderService'))
})

test('typeDetail: the tree of fields with the types they refer to, a cycle guard and a depth limit', async () => {
	const g = await graphOf('java-shop')
	const order = boards.typeDetail(g, 'OrderDto', undefined, 2)
	assert.equal(order.name, 'OrderDto')
	assert.deepEqual(order.fields.map(f => [f.name, f.type, f.card]), [['id', 'Long', 'one'], ['address', 'AddressDto', 'one'], ['lines', 'List<OrderLineDto>', 'many'], ['note', 'Optional<String>', 'one'], ['status', 'Status', 'one']])
	const lines = order.fields.find(f => f.name === 'lines').child
	assert.equal(lines.name, 'OrderLineDto')
	assert.equal(lines.fields.find(f => f.name === 'price').child.name, 'Money')
	assert.equal(order.fields.find(f => f.name === 'status').child.constants.join(), 'NEW,PAID,SHIPPED')
	// depth 0: only the type's own fields, with the types they refer to as links.
	const shallow = boards.typeDetail(g, 'OrderDto', undefined, 0)
	assert.equal(shallow.fields.find(f => f.name === 'lines').child, undefined)
	assert.equal(short(shallow.fields.find(f => f.name === 'lines').ref), 'OrderLineDto')
	assert.equal(shallow.truncated, true)
	// a type that holds itself is not expanded again
	const category = boards.typeDetail(g, 'CategoryDto', undefined, 5)
	assert.equal(category.fields.find(f => f.name === 'parent').child, undefined)
	assert.equal(short(category.fields.find(f => f.name === 'parent').ref), 'CategoryDto')
	assert.equal(category.truncated, undefined)
	assert.equal(boards.typeDetail(g, 'NoSuchType'), undefined)
	// by id, and by name from a file next to the type
	assert.equal(boards.typeDetail(g, 'java:com.acme.shop.dto.Money').name, 'Money')
	assert.equal(boards.typeDetail(g, 'Money', category.file).file, g.types.find(t => t.name === 'Money').file)
})

test('typeDetail: the same name in two languages resolves to the one nearest the file', async () => {
	const g = await graphOf(['java-shop', 'py-app'])
	const java = g.types.find(t => t.name === 'Money')
	const python = g.types.find(t => t.name === 'Address')
	assert.equal(boards.typeDetail(g, 'Address', python.file).id, python.id)
	assert.equal(boards.typeDetail(g, 'Money', java.file).id, java.id)
})

test('exports: Mermaid of the DTO board (erDiagram)', async () => {
	const g = await graphOf('java-shop')
	const text = exporter.exportMermaid(boards.dtoBoard(g))
	assert.match(text, /^erDiagram/)
	assert.match(text, /OrderDto \|\|--o\{ OrderLineDto : "lines"/)
	snapshot('dto-board.mermaid', text)
})

test('exports: Mermaid of the architecture board (classDiagram, or the flowchart with the modules)', async () => {
	const g = await graphOf('java-shop')
	const b = boards.architectureBoard(g)
	const text = exporter.exportMermaid(b)
	assert.match(text, /^classDiagram/)
	assert.match(text, /class n\d+\["OrderService"\] \{/)
	assert.match(text, /n\d+ \.\.> n\d+ : repo/)
	snapshot('architecture-board.mermaid', text)
	const flow = exporter.exportMermaid(b, { layout: 'flowchart' })
	assert.match(flow, /^flowchart TB/)
	assert.match(flow, /subgraph g0\["java-shop"\]/)
	assert.match(flow, /subgraph g1\["Controllers"\]/)
	snapshot('architecture-board.flowchart', flow)
})

test('exports: PlantUML of both boards', async () => {
	const g = await graphOf('java-shop')
	const er = exporter.exportPlantUml(boards.dtoBoard(g))
	assert.match(er, /^@startuml/)
	assert.match(er, /@enduml$/)
	assert.match(er, /entity "OrderDto" as n\d+/)
	assert.match(er, /n\d+ "1" --> "0\.\.\*" n\d+ : lines/)
	assert.match(er, /enum "Status" as n\d+ \{/)
	snapshot('dto-board.puml', er)
	const arch = exporter.exportPlantUml(boards.architectureBoard(g))
	assert.match(arch, /package "java-shop" \{/)
	assert.match(arch, /package "Services" \{/)
	assert.match(arch, /class "OrderService" as n\d+ <<service>> \{/)
	assert.match(arch, /class "OrderRepository" as n\d+ <<repository>>/)
	assert.match(arch, /n\d+ \.\.> n\d+ : repo/)
	snapshot('architecture-board.puml', arch)
})

test('exports: nothing a type is named can break the text', async () => {
	const evil = { version: 1, kind: 'architecture', title: 'a"b\n@enduml', nodes: [{ id: 'x', label: 'Foo"Bar{}', kind: 'class', members: [{ text: 'm(): "x"\n}' }] }, { id: 'y', label: 'Y', kind: 'enum', members: [{ text: 'A' }] }], edges: [{ from: 'x', to: 'y', kind: 'uses', label: 'a"\nb' }, { from: 'x', to: 'gone' }] }
	const puml = exporter.exportPlantUml(evil)
	assert.equal(puml.split('\n').filter(l => l.includes('@enduml')).length, 1)
	assert.doesNotMatch(puml, /gone/)
	assert.doesNotThrow(() => exporter.exportMermaid(evil))
})

// Mermaid's own parser (the one the Markdown preview uses) accepts every export; skipped when editor/vscode has no mermaid installed.
const deps = join(ROOT, '..', '..', 'vscode', 'extensions', 'mermaid-markdown-features', 'node_modules')
const mermaidFile = join(deps, 'mermaid', 'dist', 'mermaid.core.mjs')
const purifyFile = join(deps, 'dompurify', 'dist', 'purify.es.mjs')
const parseAvailable = existsSync(mermaidFile) && existsSync(purifyFile)

test('exports: the Mermaid text of both boards parses', { skip: !parseAvailable && 'mermaid is not installed in editor/vscode' }, async () => {
	const { pathToFileURL } = await import('node:url')
	const purify = (await import(pathToFileURL(purifyFile).href)).default
	Object.assign(purify, { addHook() { }, removeHook() { }, sanitize: s => s, isSupported: true })
	const { parse } = (await import(pathToFileURL(mermaidFile).href)).default
	const g = await graphOf(['java-shop', 'ts-app', 'go-svc'], { csharp: csharpResponse() })
	for (const board of [boards.dtoBoard(g), boards.dtoBoard(g, { includeEntities: true }), boards.architectureBoard(g), boards.architectureBoard(g, { hideRoles: [] })]) {
		await assert.doesNotReject(parse(exporter.exportMermaid(board)), board.title)
		if (board.kind === 'architecture') {
			await assert.doesNotReject(parse(exporter.exportMermaid(board, { layout: 'flowchart' })), `${board.title} (flowchart)`)
		}
	}
})
