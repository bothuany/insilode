// Skeleton first, live and with places: where a new type goes (derived from the project's own layout), and a type written in a
// file that does not parse, created after the design, typed but not saved, or written by another tool still being found.
// After an intended change to the text: UPDATE=1 node --test test/skeleton-paths.test.mjs, then read the diff of test/skeleton-expected.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { cleanup, load } from './bundle.mjs'
import { Index, ROOT } from './helpers.mjs'
import { FIXTURES, graphOf, mod } from './types-helpers.mjs'

const temps = []
after(() => {
	cleanup()
	temps.forEach(d => rmSync(d, { recursive: true, force: true }))
})

const match = await load('src/skeleton/match.ts')
const paths = await load('src/skeleton/paths.ts')
const spec = await load('../../../board-canvas/spec.ts')
const changes = await load('src/skeleton/changes.ts')

const A = 'analytics-service/src/main/java/com/turkcell/analyticsservice'
const B = 'billing-service/src/main/java/com/turkcell/billingservice'

/** The design an agent draws for "a bill report with the user in it" in analytics-service. */
const PLAN = spec.parseBoard({
	kind: 'class',
	title: 'Bill + User report (analytics-service)',
	nodes: [
		{ id: 'ctl', label: 'BillUserReportController', kind: 'controller', members: [{ text: 'getReport(): List<BillUserReportDto>' }, { text: 'getReportByCustomerId(customerId: String): BillUserReportDto' }] },
		{ id: 'svc', label: 'BillUserReportService', kind: 'interface', members: [{ text: 'getReport(): List<BillUserReportDto>' }] },
		{ id: 'impl', label: 'BillUserReportServiceImpl', kind: 'service', members: [{ text: 'getReport(): List<BillUserReportDto>' }] },
		{ id: 'dto', label: 'BillUserReportDto', kind: 'dto', members: [{ text: 'customerId: String' }, { text: 'amount: BigDecimal' }] },
		{ id: 'cli', label: 'CustomerClient', kind: 'interface', members: [{ text: 'getCustomer(id: String): String' }] },
	],
	edges: [{ from: 'impl', to: 'svc', kind: 'implements' }, { from: 'ctl', to: 'svc', kind: 'uses' }, { from: 'impl', to: 'cli', kind: 'uses' }],
})

function snapshot(name, text) {
	const file = join(ROOT, 'test', 'skeleton-expected', `${name}.txt`)
	if (process.env.UPDATE) {
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, text + '\n')
		return
	}
	assert.ok(existsSync(file), `no snapshot ${name}: run UPDATE=1 node --test test/skeleton-paths.test.mjs and read test/skeleton-expected/${name}.txt`)
	assert.equal(text + '\n', readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
}

const slash = p => p.split('\\').join('/')
const byLabel = (diff, label) => diff.nodes.find(n => n.label === label)

/** A copy of the CRM fixture in a temp folder, its index, and the way to build a graph from it: what the developer's folder is while they write. */
async function project() {
	const root = mkdtempSync(join(tmpdir(), 'insilode-skeleton-'))
	temps.push(root)
	cpSync(join(FIXTURES, 'skeleton-crm'), root, { recursive: true })
	const index = new Index(root)
	await index.ready
	const { buildTypeGraph } = await mod('graph')
	const { nearestServiceResolver } = await mod('service')
	const graph = async () => buildTypeGraph({ poly: await index.request('typeFacts'), moduleOf: nearestServiceResolver([root]) })
	const write = (rel, text) => {
		const file = join(root, rel)
		mkdirSync(dirname(file), { recursive: true })
		writeFileSync(file, text)
		return file
	}
	const rel = f => slash(relative(root, f))
	return { root, index, graph, write, rel, close: () => index.close() }
}

test('where each new type goes: the package of its siblings, in the module the plan is about', async () => {
	const g = await graphOf('skeleton-crm')
	const baseline = match.baselineOf(g.types, PLAN)
	const diff = match.matchPlan(PLAN, g, { baseline, recent: () => false })
	const rel = f => slash(relative(join(FIXTURES, 'skeleton-crm'), f))
	assert.equal(rel(byLabel(diff, 'BillUserReportController').target.file), `${A}/controller/BillUserReportController.java`)
	assert.equal(rel(byLabel(diff, 'BillUserReportService').target.file), `${A}/service/BillUserReportService.java`)
	assert.equal(rel(byLabel(diff, 'BillUserReportServiceImpl').target.file), `${A}/service/impl/BillUserReportServiceImpl.java`, 'an Impl sits where the project keeps its impls')
	assert.equal(rel(byLabel(diff, 'BillUserReportDto').target.file), `${A}/dto/BillUserReportDto.java`)
	assert.equal(byLabel(diff, 'CustomerClient').target, undefined, 'a type that was there before has no place to be told')
	assert.equal(rel(byLabel(diff, 'CustomerClient').file), `${A}/client/CustomerClient.java`, 'three modules have a CustomerClient: the plan is about analytics-service')
	snapshot('paths-crm', match.diffText(diff, PLAN.title, rel))
	// The design message lists every path; the board shows them on the node.
	const text = match.designText(match.designSummary(diff), rel)
	assert.match(text, /BillUserReportController → analytics-service\/src\/main\/java\/com\/turkcell\/analyticsservice\/controller\/BillUserReportController\.java/)
	const shown = match.decorate(PLAN, diff, [], rel)
	const ctl = shown.nodes.find(n => n.id === 'ctl')
	assert.equal(ctl.target.path, `${A}/controller/BillUserReportController.java`)
	assert.equal(ctl.target.create, true)
	assert.match(ctl.detail, /…\/controller\/BillUserReportController\.java/)
	assert.equal(spec.parseBoard({ kind: 'class', title: 'x', nodes: [{ id: 'a', label: 'A', target: { path: '/etc/x', reason: 'r', create: true } }] }).nodes[0].target, undefined, 'an agent cannot send a path of its own')
})

test("the module spells its own folders: billing-service's plural packages are followed there, and with no sibling the base package is used", async () => {
	const g = await graphOf('skeleton-crm')
	const baseline = match.baselineOf(g.types, PLAN)
	const ctx = { existing: t => baseline.ids.has(t.id) }
	const plan = spec.parseBoard({
		kind: 'class',
		title: 'Bills (billing-service)',
		nodes: [
			{ id: 'c', label: 'BillReportController', kind: 'controller' },
			{ id: 'r', label: 'BillRepository', kind: 'repository' },
			{ id: 'd', label: 'BillReportDto', kind: 'dto' },
		],
	})
	const rel = f => slash(relative(join(FIXTURES, 'skeleton-crm'), f))
	assert.equal(paths.moduleOfPlan(plan, g.types, ctx), 'billing-service', 'the title names the module')
	const target = label => paths.targetFor(plan.nodes.find(n => n.label === label), plan, g.types, ctx)
	assert.equal(rel(target('BillReportController').file), `${B}/controllers/BillReportController.java`)
	const repo = target('BillRepository')
	assert.equal(repo.basis, 'convention')
	assert.equal(rel(repo.file), `${B}/repositories/BillRepository.java`, 'no repository yet: the folder is spelled plural, like controllers and services here')
	assert.equal(target('BillReportDto').packageName, 'com.turkcell.billingservice.dtos')
	assert.equal(paths.targetFor({ id: 'x', label: '../../evil', kind: 'class' }, plan, g.types, ctx), undefined, 'a label that is not an identifier is never made a file name')
})

test('a plan that names no module in a workspace of several: no path is guessed, and the agent is told what to add', async () => {
	const g = await graphOf('skeleton-crm')
	const baseline = match.baselineOf(g.types, PLAN)
	const plan = spec.parseBoard({ kind: 'class', title: 'A new report', nodes: [{ id: 'a', label: 'ReportController', kind: 'controller', members: [{ text: 'get(): String' }] }] })
	const diff = match.matchPlan(plan, g, { baseline })
	assert.equal(diff.nodes[0].target, undefined)
	assert.deepEqual(diff.modules, ['analytics-service', 'billing-service'])
	assert.match(match.designText(match.designSummary(diff)), /cannot tell which module the new types belong in \(analytics-service, billing-service\)/)
	// Saying it anywhere on the board (a group, a node's line) is enough, and the open file's module breaks the tie too.
	const said = spec.parseBoard({ kind: 'class', title: 'A new report', nodes: [{ id: 'a', label: 'ReportController', kind: 'controller', detail: 'billing-service', members: [{ text: 'get(): String' }] }] })
	assert.equal(match.matchPlan(said, g, { baseline }).nodes[0].target.module, 'billing-service')
	assert.equal(match.matchPlan(plan, g, { baseline, hintModule: 'analytics-service' }).nodes[0].target.module, 'analytics-service')
})

test('a type written in the wrong module or package differs, with the reason', async () => {
	const p = await project()
	try {
		const before = await p.graph()
		const baseline = match.baselineOf(before.types, PLAN)
		const plan = spec.parseBoard({ kind: 'class', title: PLAN.title, nodes: PLAN.nodes.filter(n => n.id === 'ctl' || n.id === 'svc' || n.id === 'impl').map(n => ({ ...n, members: [] })) })
		// The controller in billing-service, the service in the wrong package of analytics-service.
		const files = [
			p.write(`${B}/controllers/BillUserReportController.java`, 'package com.turkcell.billingservice.controllers;\n\npublic class BillUserReportController {\n}\n'),
			p.write(`${A}/controller/BillUserReportService.java`, 'package com.turkcell.analyticsservice.controller;\n\npublic interface BillUserReportService {\n}\n'),
			p.write(`${A}/service/impl/BillUserReportServiceImpl.java`, 'package com.turkcell.analyticsservice.service.impl;\n\npublic class BillUserReportServiceImpl {\n}\n'),
		]
		await p.index.request('changed', ...files)
		const diff = match.matchPlan(plan, await p.graph(), { baseline, recent: () => true, hintModule: 'analytics-service' })
		const ctl = byLabel(diff, 'BillUserReportController')
		assert.equal(ctl.check, 'differs')
		assert.match(ctl.note, /written in billing-service, the plan is about analytics-service/)
		const svc = byLabel(diff, 'BillUserReportService')
		assert.equal(svc.check, 'differs')
		assert.match(svc.note, /in package com\.turkcell\.analyticsservice\.controller, but next to BillBehaviorService/)
		assert.equal(byLabel(diff, 'BillUserReportServiceImpl').check, 'matches', 'in the right place, nothing to say')
	} finally {
		await p.close()
	}
})

// A half-typed file (reconstructed from a real session: a bad import line and calls cut off mid-typing): tree-sitter turns the whole
// file into one ERROR node and the class is gone from the index. Also two honest slips: a method called getReportById where the
// plan says getReportByCustomerId, and a return type of another DTO.
const BROKEN = `package com.turkcell.analyticsservice.controller;

import ...UserReportService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/analytics/bill-report")
@RequiredArgsConstructor
public class BillUserReportController {

	private final BillUserReportService BillUserReportService;

	@GetMapping
	public ResponseEntity<List<BillAnalyticsDto>> getReport() {
		return ResponseEntity.ok(BillUserReportSe
	}

	@GetMapping("/{customerId}")
	public ResponseEntity<BillUserReportDto> getReportById(@PathVariable String customerId) {
		return ResponseEntity.ok(BillUserReportSe
	}
}
`

test('a Java file that does not parse still declares its type and members to the index', async () => {
	const p = await project()
	try {
		const file = p.write(`${A}/controller/BillUserReportController.java`, BROKEN)
		await p.index.request('changed', file)
		const facts = await p.index.request('typeFacts')
		const written = facts.files.find(f => f.file.endsWith('BillUserReportController.java'))
		assert.deepEqual(written.types.map(t => t.name), ['BillUserReportController'])
		const t = written.types[0]
		assert.deepEqual(t.methods, ['getReport', 'getReportById'])
		assert.equal(t.fields[0].name, 'BillUserReportService')
		assert.deepEqual(t.annotations.map(a => a.name), ['RestController', 'RequestMapping', 'RequiredArgsConstructor'])
		assert.equal(t.annotations[1].value, '/api/analytics/bill-report')
		assert.equal(written.module, 'com.turkcell.analyticsservice.controller')
		assert.equal(written.funcs.find(f => f.name === 'getReportById').paramInfo[0].typeText, 'String')
		// A file that parses is read by the tree as before: nothing is added twice.
		const ok = facts.files.find(f => f.file.endsWith('BillBehaviorController.java'))
		assert.deepEqual(ok.types[0].methods, ['<init>', 'count'])
	} finally {
		await p.close()
	}
})

test('a type in a file with errors matches; a method written under another name or with another type differs instead of missing', async () => {
	const p = await project()
	try {
		const baseline = match.baselineOf((await p.graph()).types, PLAN)
		const file = p.write(`${A}/controller/BillUserReportController.java`, BROKEN)
		await p.index.request('changed', file)
		const diff = match.matchPlan(PLAN, await p.graph(), { baseline, recent: f => slash(f).endsWith('BillUserReportController.java') })
		const ctl = byLabel(diff, 'BillUserReportController')
		assert.equal(ctl.check, 'differs', 'written, but not as planned: never "missing"')
		assert.equal(ctl.members[0].check, 'differs')
		assert.match(ctl.members[0].note, /returns .*BillAnalyticsDto/)
		assert.equal(ctl.members[1].check, 'differs')
		assert.match(ctl.members[1].note, /named getReportById in the code/)
		assert.equal(ctl.target.basis, 'siblings')
		assert.equal(byLabel(diff, 'BillUserReportDto').check, 'missing', 'the DTO nobody wrote is still missing')
		snapshot('broken-java', slash(match.diffText(diff, PLAN.title, p.rel).split(p.root).join('<project>')))
	} finally {
		await p.close()
	}
})

test('a file created after the design turns from missing to written, and an unsaved buffer counts until it is saved', async () => {
	const p = await project()
	try {
		const baseline = match.baselineOf((await p.graph()).types, PLAN)
		const plan = spec.parseBoard({ kind: 'class', title: PLAN.title, nodes: [PLAN.nodes[3]] })
		const recent = f => slash(f).endsWith('BillUserReportDto.java')
		const diffNow = async () => match.matchPlan(plan, await p.graph(), { baseline, recent })
		const state = async () => byLabel(await diffNow(), 'BillUserReportDto')
		const text = async () => slash(match.diffText(await diffNow(), PLAN.title, p.rel).split(p.root).join('<project>'))
		assert.equal((await state()).check, 'missing')
		snapshot('created-before', await text())
		// Created by another tool (the watcher's case): the index is told the file changed.
		const file = p.write(`${A}/dto/BillUserReportDto.java`, 'package com.turkcell.analyticsservice.dto;\n\npublic class BillUserReportDto {\n\tprivate String customerId;\n}\n')
		await p.index.request('changed', file)
		let now = await state()
		assert.equal(now.check, 'missing', 'one of two fields: the type is there, the rest is not')
		assert.equal(now.members[0].check, 'matches')
		assert.match(now.note, /1 of 2 members written/)
		snapshot('created-after', await text())
		// Typing in the editor, not saved: the buffer is read as the file.
		await p.index.request('overlay', file, 'package com.turkcell.analyticsservice.dto;\n\npublic class BillUserReportDto {\n\tprivate String customerId;\n\tprivate java.math.BigDecimal amount;\n}\n')
		now = await state()
		assert.equal(now.check, 'matches')
		// Closed without saving: the disk is read again.
		await p.index.request('changed', file)
		assert.equal((await state()).members[1].check, 'missing')
		// Deleted: the type is gone again.
		rmSync(file)
		await p.index.request('changed', file)
		assert.equal((await state()).check, 'missing')
	} finally {
		await p.close()
	}
})

test('changes come in bursts: the latest of each file is handed over once, after things settle', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] })
	const seen = []
	const errors = []
	const b = new changes.ChangeBatcher(500, batch => { seen.push([...batch]) }, e => errors.push(e.message))
	b.add('a.java', 1)
	t.mock.timers.tick(300)
	b.add('a.java', 2)
	b.add('b.java', 3)
	t.mock.timers.tick(300)
	assert.equal(seen.length, 0, 'each change restarts the wait: typing never reads on every key')
	assert.equal(b.waiting, true)
	t.mock.timers.tick(200)
	await Promise.resolve()
	await Promise.resolve()
	assert.deepEqual(seen, [[['a.java', 2], ['b.java', 3]]])
	assert.equal(b.waiting, false)
	const failing = new changes.ChangeBatcher(10, () => { throw new Error('boom') }, e => errors.push(e.message))
	failing.add('x', 1)
	t.mock.timers.tick(10)
	await new Promise(r => setImmediate(r))
	assert.deepEqual(errors, ['boom'], 'a failing read is reported, never an unhandled rejection')
	b.add('late', 1)
	b.dispose()
	t.mock.timers.tick(1000)
	assert.equal(seen.length, 1, 'disposed: nothing more is handed over')
})

test('the empty file for a new type: the package line and the declaration, no members', () => {
	const node = (label, kind) => ({ id: label, label, kind })
	assert.equal(paths.stubFor(node('BillUserReportController', 'controller'), 'com.turkcell.analyticsservice.controller', 'x/BillUserReportController.java'),
		'package com.turkcell.analyticsservice.controller;\n\npublic class BillUserReportController {\n}\n')
	assert.equal(paths.stubFor(node('BillUserReportService', 'interface'), 'com.a', 'x/BillUserReportService.java'), 'package com.a;\n\npublic interface BillUserReportService {\n}\n')
	assert.equal(paths.stubFor(node('Order', 'class'), 'Shop', 'x/Order.cs'), 'namespace Shop;\n\npublic class Order\n{\n}\n')
	assert.equal(paths.stubFor(node('Order', 'class'), '', 'x/order.ts'), 'export class Order {\n}\n')
	assert.equal(paths.stubFor(node('Order', 'class'), '', 'x/order.go'), undefined, 'a language without a stub only offers the path')
})

test('a label that is not a safe type name gets no path and no stub', () => {
	for (const label of ['../../evil', 'X {} /*', 'CON', 'nul', 'COM1', 'a b']) {
		assert.equal(paths.isTypeName(label), false, label)
		assert.equal(paths.stubFor({ id: 'x', label, kind: 'class' }, 'a.b', 'x/Y.java'), undefined, label)
	}
	assert.equal(paths.isTypeName('BillUserReportController'), true)
	assert.equal(paths.isTypeName('Console'), true)
})
