// The Agents dock page is not trusted: every message it sends is checked for its shape (src/dockMessage.ts) before the
// host does anything with it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let d
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-dockmsg-'))
	const outfile = join(tmp, 'dockMessage.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'dockMessage.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	d = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('row messages carry an id and become one action each', () => {
	for (const type of ['show', 'pr', 'xray', 'forget', 'compact', 'rename', 'explain', 'swap']) {
		assert.deepEqual(d.dockAction({ type, id: 'a1' }), { type, id: 'a1' }, type)
		assert.equal(d.dockAction({ type }), undefined, `${type} without an id`)
		assert.equal(d.dockAction({ type, id: 7 }), undefined, `${type} with a number for an id`)
	}
	assert.equal(d.dockAction({ type: 'show', id: 'x'.repeat(201) }), undefined, 'an id past the bound')
	assert.deepEqual(d.dockAction({ type: 'ready' }), { type: 'ready' })
	assert.deepEqual(d.dockAction({ type: 'pick', extra: 1 }), { type: 'pick' }, 'extra fields are dropped')
})

test('the page starts only the built-in agents, never a command of its own', () => {
	assert.deepEqual(d.dockAction({ type: 'new', cli: 'claude' }), { type: 'new', cli: 'claude' })
	assert.deepEqual(d.dockAction({ type: 'new', cli: 'codex' }), { type: 'new', cli: 'codex' })
	assert.equal(d.dockAction({ type: 'new', cli: 'rm -rf ~' }), undefined)
	assert.equal(d.dockAction({ type: 'new', cli: 'custom', command: 'x' }), undefined)
})

test('a flow is an index into the host list, a worktree action one of four', () => {
	assert.deepEqual(d.dockAction({ type: 'flow', id: 'a', index: 2 }), { type: 'flow', id: 'a', index: 2 })
	for (const index of [-1, 1.5, '2', undefined]) {
		assert.equal(d.dockAction({ type: 'flow', id: 'a', index }), undefined, String(index))
	}
	for (const action of d.WORKTREE_ACTIONS) {
		assert.deepEqual(d.dockAction({ type: 'wt', id: 'a', action }), { type: 'wt', id: 'a', action })
	}
	assert.equal(d.dockAction({ type: 'wt', id: 'a', action: 'push' }), undefined)
})

test('anything else is dropped', () => {
	for (const m of [null, undefined, 'show', 42, [], {}, { type: 1 }, { type: 'runCommand', id: 'workbench.action.terminal.sendSequence' }, { type: 'constructor', id: 'a' }, { type: 'toString', id: 'a' }]) {
		assert.equal(d.dockAction(m), undefined, JSON.stringify(m))
	}
})
