// What a failed install of Claude Code's or Codex's extension means for the next one (src/agentExtensionsCore.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let c
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agentext-'))
	const outfile = join(tmp, 'agentExtensionsCore.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'agentExtensionsCore.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	c = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('no gallery stops for this start; not on Open VSX is never tried again; anything else is tried at the next start', () => {
	assert.equal(c.agentExtensionStep(new Error('No extension gallery service configured.')), 'stop')
	assert.equal(c.agentExtensionStep(Object.assign(new Error('x'), { name: 'NotFound' })), 'skip')
	assert.equal(c.agentExtensionStep(Object.assign(new Error('x'), { code: 'NotFound' })), 'skip')
	assert.equal(c.agentExtensionStep(new Error("Extension 'openai.chatgpt' not found.")), 'skip')
	assert.equal(c.agentExtensionStep(new Error('getaddrinfo ENOTFOUND open-vsx.org')), 'retry')
	assert.equal(c.agentExtensionStep(Object.assign(new Error('Canceled'), { name: 'Canceled' })), 'retry')
	assert.equal(c.agentExtensionStep(undefined), 'retry')
})
