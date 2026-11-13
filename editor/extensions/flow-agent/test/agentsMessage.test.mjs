// The Agents page is not trusted: every message it sends is checked for its shape (src/agentsMessage.ts) before the
// host does anything with it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let a
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agentsmsg-'))
	const outfile = join(tmp, 'agentsMessage.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'agentsMessage.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	a = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('the page-only messages become one action each', () => {
	assert.deepEqual(a.agentsAction({ type: 'tail', id: 'a1', extra: 1 }), { type: 'tail', id: 'a1' })
	assert.deepEqual(a.agentsAction({ type: 'reply', id: 'a1', text: 'go on' }), { type: 'reply', id: 'a1', text: 'go on' })
	assert.deepEqual(a.agentsAction({ type: 'reply', id: 'a1', text: 'x'.repeat(a.MAX_REPLY) }).type, 'reply')
	assert.deepEqual(a.agentsAction({ type: 'custom', index: 0, name: 'Gemini' }), { type: 'custom', index: 0, name: 'Gemini' })
	assert.equal(a.agentsAction({ type: 'custom', index: 0 }), undefined)
	assert.deepEqual(a.agentsAction({ type: 'kept' }), { type: 'kept' })
})

test('the dock\'s row and worktree actions pass', () => {
	for (const type of ['show', 'pr', 'xray', 'forget', 'compact', 'rename', 'explain', 'swap']) {
		assert.deepEqual(a.agentsAction({ type, id: 'a1' }), { type, id: 'a1' }, type)
	}
	assert.deepEqual(a.agentsAction({ type: 'ready' }), { type: 'ready' })
	assert.deepEqual(a.agentsAction({ type: 'new', cli: 'claude' }), { type: 'new', cli: 'claude' })
	assert.deepEqual(a.agentsAction({ type: 'wt', id: 'a', action: 'merge' })?.type, 'wt')
})

test('bad replies, indexes and ids are dropped', () => {
	assert.equal(a.agentsAction({ type: 'reply', id: 'a1', text: 'x'.repeat(a.MAX_REPLY + 1) }), undefined)
	assert.equal(a.agentsAction({ type: 'reply', id: 'a1', text: '' }), undefined)
	assert.equal(a.agentsAction({ type: 'reply', id: 'a1', text: ' \n\t ' }), undefined)
	assert.equal(a.agentsAction({ type: 'reply', id: 'a1', text: 5 }), undefined)
	assert.equal(a.agentsAction({ type: 'reply', text: 'hi' }), undefined)
	for (const index of [-1, 1.5, '1', undefined, NaN, 100]) {
		assert.equal(a.agentsAction({ type: 'custom', index, name: 'Gemini' }), undefined, String(index))
	}
	assert.equal(a.agentsAction({ type: 'tail' }), undefined)
	assert.equal(a.agentsAction({ type: 'tail', id: '' }), undefined)
})

test('a peer message names a project by storage key and a session by id, never a path or a command', () => {
	const key = '0123456789ab'
	assert.deepEqual(a.agentsAction({ type: 'peer', action: 'ide', key }), { type: 'peer', action: 'ide', key })
	assert.deepEqual(a.agentsAction({ type: 'peer', action: 'ide', key, id: 's1', extra: 1 }), { type: 'peer', action: 'ide', key, id: 's1' })
	assert.deepEqual(a.agentsAction({ type: 'peer', action: 'flow', key, id: 's1' }), { type: 'peer', action: 'flow', key, id: 's1' })
	assert.equal(a.agentsAction({ type: 'peer', action: 'ide', key: 'empty-0123456789ab' }).key, 'empty-0123456789ab')
	for (const bad of [
		{ type: 'peer', action: 'flow', key }, // a flow needs a session
		{ type: 'peer', action: 'reply', key, id: 's1' }, // only two actions travel
		{ type: 'peer', action: 'ide', key: 'C:\\Users\\me\\project' },
		{ type: 'peer', action: 'ide', key: '../../etc' },
		{ type: 'peer', action: 'ide', key: '0123456789AB' },
		{ type: 'peer', action: 'ide', key: 5 },
		{ type: 'peer', action: 'ide', key, id: 5 },
		{ type: 'peer', action: 'ide', key, id: '' },
		{ type: 'peer', action: 'ide', key, id: 'x'.repeat(201) },
		{ type: 'peer', key },
	]) {
		assert.equal(a.agentsAction(bad), undefined, JSON.stringify(bad))
	}
})

test('the dock-only chat link and anything unknown are dropped', () => {
	assert.equal(a.agentsAction({ type: 'chat' }), undefined)
	for (const m of [null, undefined, 'tail', 42, [], {}, { type: 1 }, { type: 'runCommand', id: 'x' }, { type: 'constructor', id: 'a' }]) {
		assert.equal(a.agentsAction(m), undefined, JSON.stringify(m))
	}
})
