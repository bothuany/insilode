// The rule behind Agents.spawn's refusal to take over a live session's id (src/spawnGuard.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let m
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-spawnguard-'))
	const outfile = join(tmp, 'spawnGuard.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'spawnGuard.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('an id is taken while its session has not ended and its terminal is open', T, () => {
	for (const state of ['starting', 'idle', 'working', 'blocked', 'done', 'unknown']) {
		assert.equal(m.idInUse({ state }, true), true, state)
	}
})

test('a session whose CLI ended (the shell may stay open), one whose terminal is gone and an unknown id can be resumed', T, () => {
	assert.equal(m.idInUse({ state: 'ended' }, true), false)
	assert.equal(m.idInUse({ state: 'idle' }, false), false)
	assert.equal(m.idInUse(undefined, true), false)
})
