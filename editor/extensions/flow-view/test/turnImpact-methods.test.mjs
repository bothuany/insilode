// The method-level turn impact end to end on a real index: an edit in one service function names only the route
// that reaches it, where the file-level answer named every route of the file.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { structuredPatch } from 'diff'
import { Index, ROOT } from './helpers.mjs'

const APP = `const express = require('express');
const svc = require('./service');
const app = express();
app.get('/orders', (req, res) => res.json(svc.listOrders()));
app.post('/refunds', (req, res) => res.json(svc.refundOrder(req.body)));
module.exports = app;
`
const SERVICE_BEFORE = `function listOrders() {
  return [];
}

function refundOrder(body) {
  return { ok: true };
}

module.exports = { listOrders, refundOrder };
`
const SERVICE_AFTER = SERVICE_BEFORE.replace('return { ok: true };', 'return { ok: true, at: Date.now() };')

let c
let index
let dir
before(async () => {
	dir = mkdtempSync(join(tmpdir(), 'flow-impact-'))
	const app = join(dir, 'app')
	mkdirSync(app)
	writeFileSync(join(app, 'app.js'), APP)
	writeFileSync(join(app, 'service.js'), SERVICE_AFTER)
	const outfile = join(dir, 'changedMethods.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'mcp', 'changedMethods.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	c = await import(pathToFileURL(outfile).href)
	index = new Index(app)
	await index.ready
})
after(async () => {
	await index?.close()
	rmSync(dir, { recursive: true, force: true })
})

test('methods carry their span, and an edit in one names that one', async () => {
	const file = join(dir, 'app', 'service.js')
	const methods = await index.request('methods', file)
	const refund = methods.find(m => m.name.endsWith('refundOrder'))
	assert.ok(refund, JSON.stringify(methods))
	assert.deepEqual([refund.startLine, refund.endLine], [5, 7])
	const ranges = c.rangesFromHunks(structuredPatch('a', 'b', SERVICE_BEFORE, SERVICE_AFTER, '', '', { context: 0 }).hunks)
	const touched = c.methodsTouched(methods, ranges)
	assert.deepEqual(touched.methods.map(m => m.name.replace(/^.*\./, '')), ['refundOrder'])
	assert.equal(touched.wholeFile, false)
})

test('only the route that reaches the changed method is affected', async () => {
	const file = join(dir, 'app', 'service.js')
	const methods = await index.request('methods', file)
	const items = async ms => [...new Set((await Promise.all(ms.map(m => index.request('impact', m.id)))).flatMap(r => r.items.map(i => i.label)))].sort()
	const ranges = c.rangesFromHunks(structuredPatch('a', 'b', SERVICE_BEFORE, SERVICE_AFTER, '', '', { context: 0 }).hunks)
	const methodLevel = await items(c.methodsTouched(methods, ranges).methods)
	const fileLevel = await items(methods)
	assert.equal(methodLevel.length, 1, JSON.stringify(methodLevel))
	assert.match(methodLevel[0], /^POST \/refunds\b/)
	assert.ok(fileLevel.length >= 2, `the file-level answer names both routes: ${JSON.stringify(fileLevel)}`)
})

test('spans read before the index saw an edit are caught as stale, and match once it re-reads the file', async () => {
	const file = join(dir, 'app', 'service.js')
	// Three lines above both functions: every span the index holds is now off by three.
	writeFileSync(file, '// a\n// b\n// c\n' + SERVICE_AFTER)
	const stale = await index.request('methods', file)
	assert.equal(c.spansMatch(stale, readFileSync(file, 'utf8')), false)
	await index.request('changed', file)
	const fresh = await index.request('methods', file)
	assert.equal(c.spansMatch(fresh, readFileSync(file, 'utf8')), true)
	assert.deepEqual(fresh.find(m => m.name.endsWith('refundOrder')).startLine, 8)
})
