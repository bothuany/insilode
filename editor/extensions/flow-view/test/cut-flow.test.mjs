// A flow cut at the node limit says so (FlowNode.truncated, and flow_text), and the index's impact answer names where each row
// is and how much of the walk it left out. The projects are written to a temp folder: nothing here is a fixture to maintain.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Index } from './helpers.mjs'
import { cleanup, load, temp } from './bundle.mjs'

after(cleanup)

// The long name of a temp folder: a Windows runner's temp path may be an 8.3 short name, and the index reports the names it walks.
const tempDir = prefix => realpathSync.native(temp(prefix))

const walk = (n, visit) => {
	visit(n)
	n.children.forEach(c => walk(c.node, visit))
}

test('a flow cut at the node limit marks the card that was cut with the calls not drawn', async () => {
	const dir = tempDir('flow-cut-')
	const file = join(dir, 'app.py')
	const calls = 300
	let src = ''
	for (let i = 0; i < calls; i++) {
		src += `def leaf${String(i).padStart(3, '0')}():\n    return ${i}\n\n`
	}
	const head = src.split('\n').length
	src += `def handler():\n${Array.from({ length: calls }, (_, i) => `    leaf${String(i).padStart(3, '0')}()`).join('\n')}\n`
	writeFileSync(file, src)
	const index = new Index(dir)
	try {
		await index.ready
		const hit = await index.functionAt(file, head)
		assert.ok(hit, 'the handler is in the index')
		const root = await index.graph(hit.id)
		assert.ok(root.truncated > 0, 'the root card says calls were not drawn')
		assert.equal(root.children.length + root.truncated, calls, 'every call is either drawn or counted')
		let cards = 0
		walk(root, () => cards++)
		assert.ok(cards <= 222, `the walk stopped near its limit (${cards} cards)`)

		// A flow that fits is whole: no card carries the field.
		const small = await index.functionAt(file, 1)
		const leaf = await index.graph(small.id)
		walk(leaf, n => assert.equal(n.truncated, undefined))

		// What flow_text tells the agent next to the card.
		const flowtext = await load('src/mcp/flowtext.ts')
		const text = flowtext.flowToText(root, { rel: f => f, maxLines: 1000 }).text
		const line = text.split('\n')[0]
		assert.match(line, new RegExp(`\\[${root.truncated} more calls not drawn: the flow was cut at its size limit\\]`))
		assert.equal(flowtext.flowToText(leaf, { rel: f => f }).text.includes('not drawn'), false)
	} finally {
		await index.close()
	}
})

test('impact rows say where each entry point is, so a row can open it', async () => {
	const dir = tempDir('flow-impact-')
	const file = join(dir, 'app.py')
	writeFileSync(file, [
		'from flask import Flask',
		'app = Flask(__name__)',
		'',
		'@app.route("/orders", methods=["GET"])',
		'def list_orders():',
		'    return load_orders()',
		'',
		'def load_orders():',
		'    return fetch_rows()',
		'',
		'def fetch_rows():',
		'    return []',
		'',
	].join('\n'))
	const index = new Index(dir)
	try {
		await index.ready
		const entries = await index.request('entries')
		const entry = entries.find(e => e.action === 'list_orders')
		assert.ok(entry, 'the route is an entry point')
		const leaf = await index.functionAt(file, 12)
		const impact = await index.request('impact', leaf.id)
		assert.equal(impact.label, 'entry point')
		assert.equal(impact.items.length, 1)
		const [row] = impact.items
		assert.equal(row.kind, 'entry')
		assert.equal(row.file, entry.file)
		assert.equal(row.line, entry.line)
		assert.ok(row.line > 0)
		assert.equal(impact.truncated, undefined, 'a short walk is complete')
	} finally {
		await index.close()
	}
})

test('without an entry point, impact names the callers at the top with their place', async () => {
	const dir = tempDir('flow-impact-callers-')
	const file = join(dir, 'job.py')
	writeFileSync(file, 'def run_job():\n    prepare()\n\ndef prepare():\n    save_all()\n\ndef save_all():\n    return 1\n')
	const index = new Index(dir)
	try {
		await index.ready
		const leaf = await index.functionAt(file, 7)
		const impact = await index.request('impact', leaf.id)
		assert.equal(impact.label, 'caller')
		assert.deepEqual(impact.items, [{ label: 'run_job', file, line: 1, kind: 'caller' }])
		assert.equal(impact.truncated, undefined)
	} finally {
		await index.close()
	}
})

test('an impact walk that reaches its limit says how much it left unfollowed', async () => {
	const dir = tempDir('flow-impact-cut-')
	const file = join(dir, 'chain.py')
	const links = 5100
	const name = i => `step${String(i).padStart(5, '0')}`
	let src = ''
	for (let i = 0; i < links; i++) {
		src += `def ${name(i)}():\n    ${i + 1 < links ? `${name(i + 1)}()` : 'return 0'}\n`
	}
	writeFileSync(file, src)
	const index = new Index(dir)
	try {
		await index.ready
		// The last function is called by the whole chain: more callers than the walk follows.
		const last = await index.functionAt(file, (links - 1) * 2 + 1)
		const impact = await index.request('impact', last.id)
		assert.ok(impact.truncated >= 1, 'the walk stopped with callers left to follow')
	} finally {
		await index.close()
	}
})
