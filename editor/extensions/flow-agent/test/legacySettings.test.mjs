// The two settings renamed from `flowAgent.*` to `flow.agents.*` (src/legacySettings.ts): what moves, and what never does.
// Pure, so it is bundled with esbuild and run under plain Node.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let legacy
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agent-legacy-settings-'))
	const outfile = join(tmp, 'legacySettings.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'legacySettings.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	legacy = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const reader = table => key => table[key]
const LOCATION = ['flowAgent.agentsPage.location', 'flow.agents.page.location']
const BYPASS = ['flowAgent.claude.allowBypassPermissions', 'flow.agents.claude.allowBypassPermissions']

test('a user value under the old name moves to the new name, once', () => {
	const read = reader({ [LOCATION[0]]: { globalValue: 'tab' }, [BYPASS[0]]: { globalValue: true } })
	assert.deepEqual(legacy.settingMoves(read), [
		{ from: LOCATION[0], to: LOCATION[1], value: 'tab' },
		{ from: BYPASS[0], to: BYPASS[1], value: true },
	])
	assert.deepEqual(legacy.settingMoves(reader({})), [])
})

test('a new setting that already has a user value is not overwritten', () => {
	assert.deepEqual(legacy.settingMoves(reader({ [LOCATION[0]]: { globalValue: 'tab' }, [LOCATION[1]]: { globalValue: 'window' } })), [])
	assert.deepEqual(legacy.settingMoves(reader({ [BYPASS[0]]: { globalValue: true }, [BYPASS[1]]: { globalValue: false } })), [])
})

test('a workspace or folder value never moves, so a repository cannot switch bypass on', () => {
	const old = { workspaceValue: true, workspaceFolderValue: true }
	assert.deepEqual(legacy.settingMoves(reader({ [BYPASS[0]]: old })), [])
	assert.deepEqual(legacy.settingMoves(reader({ [BYPASS[0]]: { ...old, globalValue: false } })), [{ from: BYPASS[0], to: BYPASS[1], value: false }], 'only the user value')
	assert.deepEqual(legacy.settingMoves(reader({ [LOCATION[0]]: { workspaceValue: 'tab' } })), [])
})

test('a value the new setting would not accept stays where it is', () => {
	assert.deepEqual(legacy.settingMoves(reader({ [BYPASS[0]]: { globalValue: 'yes' }, [LOCATION[0]]: { globalValue: 'floating' } })), [])
})

test('the new names are the settings package.json contributes, and the old ones are gone', () => {
	const props = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).contributes.configuration.properties
	for (const [from, to] of legacy.RENAMED_SETTINGS.map(r => [r.from, r.to])) {
		assert.ok(props[to], to)
		assert.equal(props[from], undefined, from)
	}
	assert.equal(props[BYPASS[1]].scope, 'machine')
	assert.equal(props[BYPASS[1]].default, false)
})
