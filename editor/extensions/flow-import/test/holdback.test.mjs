// What the import holds back (src/merge.ts: security and executable-path settings), the review that writes only what
// was checked, and the first-start offer's answer rule and source pick items (src/sources.ts). Pure functions, on text.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let m
let s
let jsonc
let tmp
async function load(entry, name) {
	const outfile = join(tmp, name)
	await build({ entryPoints: [join(ROOT, 'src', entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', mainFields: ['module', 'main'] })
	return import(pathToFileURL(outfile).href)
}
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-import-holdback-'))
	m = await load('merge.ts', 'merge.mjs')
	s = await load('sources.ts', 'sources.mjs')
	const parser = join(tmp, 'jsonc.mjs')
	await build({ stdin: { contents: "export { parse } from 'jsonc-parser'", resolveDir: ROOT }, bundle: true, platform: 'node', format: 'esm', outfile: parser, logLevel: 'silent', mainFields: ['module', 'main'] })
	jsonc = await import(pathToFileURL(parser).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const HELD = [
	// security.*
	['security.workspace.trust.enabled', false],
	['security.workspace.trust.startupPrompt', 'never'],
	['security.allowedUNCHosts', ['server']],
	// executable paths
	['git.path', 'C:\\Program Files\\Git\\bin\\git.exe'],
	['php.validate.executablePath', '/usr/bin/php'],
	['python.defaultInterpreter.path', '/usr/bin/python3'],
	['go.alternateTools.path', 'go1.21'],
	['eslint.runtime.command', 'node'],
	['clang.commandPath', '/opt/clang'],
	// terminal shells and profiles
	['terminal.integrated.shell.windows', 'C:\\Windows\\System32\\cmd.exe'],
	['terminal.integrated.shell.osx', '/bin/zsh'],
	['terminal.integrated.shell.linux', '/bin/bash'],
	// the shells that tasks and agents run through are programs too, not only the interactive one
	['terminal.integrated.automationShell.linux', '/bin/sh'],
	['terminal.integrated.automationShell.windows', 'C:\\tools\\shell'],
	['terminal.integrated.automationProfile.windows', { path: 'C:\\tools\\shell.exe' }],
	['terminal.integrated.shellArgs.osx', ['-c', 'x']],
	['terminal.integrated.profiles.windows', { PowerShell: { source: 'PowerShell' } }],
	['terminal.integrated.profiles.linux', { zsh: { path: '/bin/zsh', args: ['-l'] } }],
	['terminal.integrated.defaultProfile.windows', 'C:\\tools\\shell.exe'],
	// a string value that names a program or script, under a key that is not allowlisted
	['my.tool.launcher', 'C:\\tools\\run.bat'],
	['custom.hook', './hooks/pre.sh'],
	['other.script', 'setup.ps1'],
	['other.cmd', 'x.CMD'],
]
const IMPORTED = [
	['editor.fontFamily', 'Fira Code, Consolas'],
	['editor.fontSize', 14],
	['files.exclude', { '**/.git': true, '**/*.sh': true }],
	['files.associations', { '*.sh': 'shellscript' }],
	['workbench.colorTheme', 'Dark Modern'],
	['terminal.integrated.defaultProfile.windows', 'PowerShell'],
	['terminal.integrated.fontSize', 13],
	['terminal.integrated.cwd', '/work'],
	['search.path', 'src'],
	['editor.tabSize', 4],
	['files.autoSave', 'afterDelay'],
	['security', 1],
	['gitpath', 'x'],
	['git.autofetch', true],
	['python.pathfinder', 'x'],
]

for (const [key, value] of HELD) {
	test(`held back: ${key}`, () => {
		assert.equal(m.isHeldBack(key, value), true)
		assert.ok(m.heldBackReason(key, value), 'a reason to show in the review')
	})
}
for (const [key, value] of IMPORTED) {
	test(`imported as usual: ${key}`, () => {
		assert.equal(m.isHeldBack(key, value), false)
		assert.equal(m.heldBackReason(key, value), undefined)
	})
}

const SETTINGS = `// VS Code, as it writes the file
{
	"editor.fontFamily": "Fira Code", // my font
	"security.workspace.trust.enabled": false,
	"git.path": "C:\\\\git\\\\git.exe",
	"terminal.integrated.profiles.windows": { "Git": { "path": "C:\\\\git\\\\bash.exe", "args": ["-l"] } },
	"files.exclude": { "**/.git": true },
	"[python]": {
		"editor.tabSize": 4,
		"python.formatting.blackPath": "black",
		"python.linting.pylintPath": "/usr/bin/pylint",
		"my.formatter.path": "/usr/bin/fmt"
	},
}
`

test('merge: the written result has none of the held back keys, and they come back as a separate list', () => {
	const plan = m.planSettings(undefined, SETTINGS)
	const written = jsonc.parse(m.writeSettings(undefined, plan.add))
	assert.deepEqual(Object.keys(written).sort(), ['[python]', 'editor.fontFamily', 'files.exclude'])
	assert.deepEqual(written['[python]'], { 'editor.tabSize': 4, 'python.formatting.blackPath': 'black', 'python.linting.pylintPath': '/usr/bin/pylint' })
	assert.deepEqual(plan.held.map(h => h.key).sort(), ['[python].my.formatter.path', 'git.path', 'security.workspace.trust.enabled', 'terminal.integrated.profiles.windows'])
	for (const h of plan.held) {
		assert.ok(h.reason)
		assert.ok(m.isHeldBack(h.path.at(-1), h.value))
	}
	// Whatever is in the file, no held back key is in what is written.
	const text = m.writeSettings(undefined, plan.add)
	assert.doesNotMatch(text, /security\.|git\.path|profiles|my\.formatter/)
})

test('merge: a held back key the user already has in Insilode is kept as theirs, not offered again', () => {
	const mine = '{ "git.path": "/mine/git", "[python]": { "my.formatter.path": "/mine/fmt" } }'
	const plan = m.planSettings(mine, SETTINGS)
	assert.deepEqual(plan.held.map(h => h.key).sort(), ['security.workspace.trust.enabled', 'terminal.integrated.profiles.windows'])
	assert.ok(plan.kept.includes('git.path'))
	assert.ok(plan.kept.includes('[python].my.formatter.path'))
})

test('merge: a settings file with only held back keys still reports them and adds nothing', () => {
	const plan = m.planSettings(undefined, '{ "security.workspace.trust.enabled": false }')
	assert.deepEqual(plan.add, [])
	assert.equal(plan.held.length, 1)
})

test('merge: a source with no settings.json holds nothing back', () => {
	assert.deepEqual(m.planSettings('{}', undefined).held, [])
})

test('review: only the checked keys are written, through the same writer, and a key the user has now stays theirs', () => {
	const { held } = m.planSettings(undefined, SETTINGS)
	assert.deepEqual(m.heldToImport(held, []), [])
	const entries = m.heldToImport(held, ['git.path', '[python].my.formatter.path'])
	assert.deepEqual(entries, [{ path: ['git.path'], value: 'C:\\git\\git.exe' }, { path: ['[python]', 'my.formatter.path'], value: '/usr/bin/fmt' }])
	assert.deepEqual(m.heldToImport(held, ['editor.fontFamily', 'unknown.key']), [], 'a key that was not held back is never written')
	const current = '// mine\n{ "git.path": "/mine/git" }\n'
	const text = m.writeSettings(current, m.heldToImport(held, ['git.path', 'security.workspace.trust.enabled'], current))
	assert.deepEqual(jsonc.parse(text), { 'git.path': '/mine/git', 'security.workspace.trust.enabled': false })
	assert.ok(text.startsWith('// mine'))
})

test('offer: only an explicit answer marks it answered (Never, or an import that worked)', () => {
	assert.equal(s.offerAnswered('never', false), true)
	assert.equal(s.offerAnswered('import', true), true)
	assert.equal(s.offerAnswered('import', false), false, 'an import that was cancelled or stopped comes back')
	assert.equal(s.offerAnswered('notNow', false), false)
	assert.equal(s.offerAnswered('notNow', true), false)
	assert.equal(s.offerAnswered(undefined, false), false, 'closing the notification is not an answer')
})

test('source pick items: name, folder and the date settings.json last changed, no file said so', () => {
	const sources = s.findSources({ platform: 'linux', home: join(ROOT, 'test', 'fixtures', 'linux') })
	const day = Date.UTC(2026, 2, 5, 23, 59)
	const items = s.sourcePickItems(sources, path => path.endsWith('settings.json') ? day : undefined)
	assert.equal(items.length, sources.length)
	assert.equal(items[0].label, sources[0].product.name)
	assert.equal(items[0].description, sources[0].userDir)
	assert.equal(items[0].detail, 'Settings last modified 2026-03-05')
	assert.equal(items[0].source, sources[0])
	assert.equal(s.sourcePickItems(sources, () => undefined)[0].detail, 'No settings.json (extensions only)')
})

test('sources: VSCodium and Windsurf are found beside VS Code and Cursor', () => {
	assert.deepEqual(s.PRODUCTS.map(p => p.name), ['VS Code', 'VS Code Insiders', 'VSCodium', 'Cursor', 'Windsurf'])
})
