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

test('Codex: with the setting off the command is what it always was; resume keeps the uuid rule', () => {
	assert.equal(l.codexStartCommand({ resume: false, profile: 'insilode', neverAsk: false }), 'codex -p insilode')
	assert.equal(l.codexStartCommand({ resume: false, neverAsk: false }), 'codex')
	assert.equal(l.codexStartCommand({ resume: true, id, profile: 'insilode', neverAsk: false }), `codex resume -p insilode ${id}`)
	assert.equal(l.codexStartCommand({ resume: true, profile: 'insilode', neverAsk: false }), 'codex resume -p insilode', 'no id: Codex\'s own picker')
	for (const bad of ['not-a-uuid', '$(rm -rf ~)', `${id}; ls`, `${id} --last`, '']) {
		assert.equal(l.codexStartCommand({ resume: true, id: bad, profile: 'insilode', neverAsk: true }), 'codex resume -p insilode --ask-for-approval never --sandbox workspace-write', JSON.stringify(bad))
	}
	assert.equal(l.codexStartCommand({ resume: false, id, neverAsk: false }), 'codex', 'a new session takes no id')
})

test('Codex: with the setting on, sessions never ask but the sandbox stays; the dangerous flags never appear', () => {
	const flags = ' --ask-for-approval never --sandbox workspace-write'
	assert.equal(l.codexStartCommand({ resume: false, profile: 'insilode', neverAsk: true }), `codex -p insilode${flags}`)
	assert.equal(l.codexStartCommand({ resume: false, neverAsk: true }), `codex${flags}`)
	assert.equal(l.codexStartCommand({ resume: true, id, profile: 'insilode', neverAsk: true }), `codex resume -p insilode${flags} ${id}`)
	for (const o of [{ resume: false }, { resume: true, id }, { resume: true, id, profile: 'insilode' }]) {
		for (const neverAsk of [false, true]) {
			assert.doesNotMatch(l.codexStartCommand({ ...o, neverAsk }), /dangerously|danger-full-access|read-only|-a never|--yolo/)
		}
	}
})

test('the Codex setting is off by default, machine-scoped and described', () => {
	const props = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).contributes.configuration.properties
	const s = props['flow.agents.codex.neverAsk']
	assert.equal(s.type, 'boolean')
	assert.equal(s.default, false)
	assert.equal(s.scope, 'machine', 'a workspace cannot turn it on')
	assert.ok((s.markdownDescription || s.description).length > 40)
	assert.match(s.markdownDescription, /workspace-write/)
})

test('the setting is off by default, machine-scoped and described', () => {
	const props = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).contributes.configuration.properties
	const s = props['flow.agents.claude.allowBypassPermissions']
	assert.equal(s.type, 'boolean')
	assert.equal(s.default, false)
	assert.equal(s.scope, 'machine', 'a workspace cannot turn it on')
	assert.ok((s.markdownDescription || s.description).length > 40)
	const loc = props['flow.agents.page.location']
	assert.deepEqual(loc.enum, ['window', 'tab'])
	assert.equal(loc.default, 'window')
})
