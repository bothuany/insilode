// A traced flow kept as a board (src/board/fromFlow.ts): cards become nodes once, calls, HTTP guesses and table access become edges.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let b
let spec
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-pinboard-'))
	const outfile = join(tmp, 'fromFlow.mjs')
	await build({ entryPoints: { fromFlow: join(ROOT, 'src', 'board', 'fromFlow.ts'), spec: join(ROOT, '..', '..', '..', 'board-canvas', 'spec.ts') }, bundle: true, platform: 'node', format: 'esm', outdir: tmp, logLevel: 'silent' })
	b = await import(pathToFileURL(join(tmp, 'fromFlow.js')).href)
	spec = await import(pathToFileURL(join(tmp, 'spec.js')).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const card = (key, label, kind, file, line, children = [], extra = {}) => ({ key, symbolId: null, label, sub: '', kind, file, startLine: line, endLine: line + 3, code: null, children, ...extra })
const edge = (node, edgeKind = 'call') => ({ callLine: 1, edgeKind, node })

test('a flow becomes a board: one node per card, edges by kind, files kept for navigation', () => {
	const repo = card('r', 'OrderRepo.save', 'method', '/w/Repo.java', 5)
	const shared = card('s', 'Audit.log', 'method', '/w/Audit.java', 2)
	const root = card('c', 'OrderController.place', 'controller', '/w/Ctrl.java', 10, [
		edge(card('i', 'OrderServiceImpl.place', 'method', '/w/Impl.java', 20, [edge(repo), edge(shared)]), 'impl'),
		edge(card('d', 'orders', 'db', null, 0, [], { schema: { writes: true } }), 'db'),
		edge(card('h', 'create_invoice', 'controller', '/w/main.py', 7), 'http'),
		edge(card('m', 'OrderListener.onOrder', 'controller', '/w/Listener.java', 4), 'message'),
		edge(card('s2', 'Audit.log', 'method', '/w/Audit.java', 2)), // the same method reached again
	])
	const board = b.flowToBoard(root, 'POST /orders')
	assert.equal(board.kind, 'flow')
	assert.equal(board.title, 'POST /orders')
	assert.deepEqual(board.nodes.map(n => n.label), ['OrderController.place', 'OrderServiceImpl.place', 'OrderRepo.save', 'Audit.log', 'orders', 'create_invoice', 'OrderListener.onOrder'])
	assert.deepEqual(board.nodes[0], { id: 'n1', label: 'OrderController.place', kind: 'controller', file: '/w/Ctrl.java', line: 10 })
	assert.equal(board.nodes.find(n => n.label === 'orders').kind, 'entity')
	const kinds = board.edges.map(e => `${board.nodes.find(n => n.id === e.from).label}>${board.nodes.find(n => n.id === e.to).label}:${e.kind}${e.label ? ':' + e.label : ''}`)
	assert.deepEqual(kinds, [
		'OrderController.place>OrderServiceImpl.place:implements',
		'OrderServiceImpl.place>OrderRepo.save:calls',
		'OrderServiceImpl.place>Audit.log:calls',
		'OrderController.place>orders:writes',
		'OrderController.place>create_invoice:calls:HTTP?',
		'OrderController.place>OrderListener.onOrder:calls:topic?',
		'OrderController.place>Audit.log:calls',
	])
	// What an agent's board must pass, a pinned one passes too.
	assert.doesNotThrow(() => spec.parseBoard(board))
})
