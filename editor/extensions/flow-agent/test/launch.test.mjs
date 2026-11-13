// The command a terminal Claude session starts with: Claude's own "bypass permissions" mode is offered only when the machine setting is on.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let l
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-launch-'))
	const outfile = join(tmp, 'launch.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'launch.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	l = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const id = '11111111-1111-4111-8111-111111111111'

test('without the setting the command is what it always was', () => {
	assert.equal(l.claudeCommand({ resume: false, id, settings: '/s.json', mcp: '/m.json', allowBypass: false }), `claude --session-id ${id} --settings "/s.json" --mcp-config "/m.json"`)
	assert.equal(l.claudeCommand({ resume: true, id, allowBypass: false }), `claude --resume ${id}`)
})

test('with the setting on, bypass permissions is offered, never started in', () => {
	const c = l.claudeCommand({ resume: false, id, settings: '/s.json', mcp: '/m.json', allowBypass: true })
	assert.equal(c, `claude --session-id ${id} --allow-dangerously-skip-permissions --settings "/s.json" --mcp-config "/m.json"`)
	assert.doesNotMatch(c, /--dangerously-skip-permissions|--permission-mode/)
	assert.match(l.claudeCommand({ resume: true, id, allowBypass: true }), /^claude --resume \S+ --allow-dangerously-skip-permissions$/)
})

test('the setting is off by default, machine-scoped and described', () => {
	const props = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).contributes.configuration.properties
	const s = props['flowAgent.claude.allowBypassPermissions']
	assert.equal(s.type, 'boolean')
	assert.equal(s.default, false)
	assert.equal(s.scope, 'machine', 'a workspace cannot turn it on')
	assert.ok((s.markdownDescription || s.description).length > 40)
	const loc = props['flowAgent.agentsPage.location']
	assert.deepEqual(loc.enum, ['window', 'tab'])
	assert.equal(loc.default, 'window')
})
