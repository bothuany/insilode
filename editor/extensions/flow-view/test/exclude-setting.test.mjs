// flow.exclude: the patterns that apply across the settings scopes (src/excludeSetting.ts), and the matcher's guards for patterns
// that come from settings or from a webview (src/poly/userExclude.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { cleanup, temp } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let setting, ex
before(async () => {
	const out = temp('flow-exclude-setting-')
	const stub = join(out, 'vscode.cjs')
	writeFileSync(stub, `module.exports = { workspace: { getConfiguration: () => ({ inspect: () => globalThis.__inspect }) } }`)
	await build({ entryPoints: [join(ROOT, 'src', 'excludeSetting.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'setting.mjs'), logLevel: 'silent', alias: { vscode: stub } })
	await build({ entryPoints: [join(ROOT, 'src', 'poly', 'userExclude.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'ex.mjs'), logLevel: 'silent' })
	setting = await import(pathToFileURL(join(out, 'setting.mjs')).href)
	ex = await import(pathToFileURL(join(out, 'ex.mjs')).href)
})
after(cleanup)

const W = process.platform === 'win32' ? 'C:\\ws' : '/ws'
const at = (...p) => [W, ...p].join(process.platform === 'win32' ? '\\' : '/')

test('excludePatterns: the user, workspace and folder values apply together, once each', () => {
	globalThis.__inspect = { globalValue: ['old', 'shared'], workspaceValue: ['shared', 'new'], workspaceFolderValue: ['inner', 7] }
	assert.deepEqual(setting.excludePatterns(), ['old', 'shared', 'new', 'inner'])
	globalThis.__inspect = undefined
	assert.deepEqual(setting.excludePatterns(), [])
})

test('currentExcluder: follows the setting', () => {
	globalThis.__inspect = { globalValue: ['legacy'] }
	assert.equal(setting.currentExcluder()(at('legacy', 'a.ts'), [W]), true)
	assert.equal(setting.currentExcluder(), setting.currentExcluder(), 'built once while the setting is the same')
	globalThis.__inspect = { globalValue: ['other'] }
	assert.equal(setting.currentExcluder()(at('legacy', 'a.ts'), [W]), false)
})

test('excluder: wildcards in a row are one, and a pattern over the caps is ignored', () => {
	const deep = at(...Array.from({ length: 60 }, () => 'a'), 'b.ts')
	const many = Array.from({ length: 12 }, () => 'a').join('/**/') // 11 wildcards
	const t = Date.now()
	assert.equal(ex.excluder([many])(deep, [W]), false, 'more than 8 wildcards: ignored')
	assert.equal(ex.excluder(['**/***/**/**/zzz/**'])(deep, [W]), false)
	assert.equal(ex.excluder(['a/' + 'x'.repeat(400)])(at('a', 'x'.repeat(400)), [W]), false, 'over 300 characters: ignored')
	assert.ok(Date.now() - t < 1000, 'no polynomial backtracking')
	assert.equal(ex.excluder(['a/***/b.ts'])(at('a', 'q', 'b.ts'), [W]), true, '*** works as **')
	assert.equal(ex.excluder(['**/**/**/a/b.ts'])(at('x', 'a', 'b.ts'), [W]), true)
})

test('excludablePattern: a folder whose name holds * or ? is refused, others are named relative to the root', () => {
	assert.equal(ex.excludablePattern(at('services', 'old'), [W]), 'services/old')
	assert.equal(ex.excludablePattern(at('we*ird'), [W]), undefined)
	assert.equal(ex.excludablePattern(at('a', 'what?'), [W]), undefined)
	assert.equal(ex.excludablePattern(W, [W]), undefined, 'the root itself')
})
