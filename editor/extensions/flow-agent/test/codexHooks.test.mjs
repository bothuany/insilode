// Codex's observe-only hooks: the profile Insilode writes and the command it runs (src/codexHooks.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let c
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-codex-'))
	const outfile = join(tmp, 'codexHooks.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'codexHooks.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	c = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('codex home: CODEX_HOME wins, else ~/.codex; the profile sits in it', () => {
	assert.equal(c.codexHome({ CODEX_HOME: '/x/codex' }), '/x/codex')
	assert.equal(c.codexHome({}), join(homedir(), '.codex'))
	assert.equal(c.codexProfileFile({ CODEX_HOME: join('/x', 'codex') }), join('/x', 'codex', 'insilode.config.toml'))
})

test('windows command: PowerShell call with literal strings', () => {
	assert.equal(
		c.codexHookCommand('win32', 'C:\\Users\\A B\\Insilode\\Insilode.exe', 'C:\\data\\codex-hook.js', true),
		"$env:ELECTRON_RUN_AS_NODE=1; & 'C:\\Users\\A B\\Insilode\\Insilode.exe' 'C:\\data\\codex-hook.js'")
	assert.equal(c.codexHookCommand('win32', 'C:\\node.exe', 'C:\\h.js', false), "& 'C:\\node.exe' 'C:\\h.js'")
	assert.equal(c.codexHookCommand('win32', "C:\\O'Brien\\Insilode.exe", 'C:\\h.js', false), "& 'C:\\O''Brien\\Insilode.exe' 'C:\\h.js'")
})

test('posix command: sh with single quotes', () => {
	assert.equal(c.codexHookCommand('darwin', '/Applications/Insilode.app/Contents/MacOS/Insilode', '/home/a/h.js', true),
		"ELECTRON_RUN_AS_NODE=1 '/Applications/Insilode.app/Contents/MacOS/Insilode' '/home/a/h.js'")
	assert.equal(c.codexHookCommand('linux', "/opt/it's/node", '/h.js', false), "'/opt/it'\\''s/node' '/h.js'")
})

test('toml strings escape backslashes, quotes and control characters', () => {
	assert.equal(c.tomlString('C:\\a "b"'), '"C:\\\\a \\"b\\""')
	assert.equal(c.tomlString('a\nb\tc'), '"a\\u000ab\\u0009c"')
	assert.equal(c.tomlString("it's"), `"it's"`)
})

test('the profile has every event once, the edit matcher on PreToolUse only, and the same command everywhere', () => {
	const cmd = "$env:ELECTRON_RUN_AS_NODE=1; & 'C:\\Insilode\\Insilode.exe' 'C:\\g\\codex-hook.js'"
	const toml = c.codexProfile(cmd)
	for (const [event] of c.CODEX_EVENTS) {
		assert.equal(toml.split('\n').filter(l => l === `[[hooks.${event}]]`).length, 1, event)
		assert.equal(toml.split('\n').filter(l => l === `[[hooks.${event}.hooks]]`).length, 1, event)
	}
	assert.deepEqual(toml.split('\n').filter(l => l.startsWith('matcher')), ['matcher = "^apply_patch$"'])
	const commands = toml.split('\n').filter(l => l.startsWith('command = '))
	assert.equal(commands.length, c.CODEX_EVENTS.length)
	assert.ok(commands.every(l => l === `command = ${c.tomlString(cmd)}`))
	assert.ok(toml.endsWith('\n'))
})

test('the profile is deterministic, so trust given once keeps holding', () => {
	assert.equal(c.codexProfile('a'), c.codexProfile('a'))
	assert.notEqual(c.codexProfile('a'), c.codexProfile('b'))
})

test('the profile gives Codex the insilode server by name, its variables by name only, and holds no hooks when none are asked', () => {
	const mcp = { execPath: 'C:\\Insilode\\Insilode.exe', script: 'C:\\Insilode\\flow-view\\out\\insilode-mcp.js', electron: true }
	const toml = c.codexProfile(undefined, mcp)
	const lines = toml.split('\n')
	assert.ok(lines.includes('[mcp_servers.insilode]'))
	assert.ok(lines.includes(`command = ${c.tomlString(mcp.execPath)}`))
	assert.ok(lines.includes(`args = [${c.tomlString(mcp.script)}]`))
	assert.ok(lines.includes('env = { ELECTRON_RUN_AS_NODE = "1" }'))
	assert.ok(lines.includes('env_vars = ["INSILODE_WORKSPACE", "INSILODE_SESSION"]'))
	assert.ok(!toml.includes('[[hooks.'))
	assert.ok(!c.codexProfile(undefined, { ...mcp, electron: false }).includes('ELECTRON_RUN_AS_NODE'))
	assert.ok(!c.codexProfile('a').includes('mcp_servers'))
	const both = c.codexProfile('a', mcp)
	assert.equal(both, c.codexProfile('a', mcp))
	assert.equal(both.split('\n').filter(l => l.startsWith('[[hooks.') && !l.endsWith('.hooks]]')).length, c.CODEX_EVENTS.length)
})

test('the hook script names no workspace: it is the same file for every window', () => {
	assert.ok(c.CODEX_HOOK_SCRIPT.includes('process.env.FLOW_HOOK_DIR'))
	assert.ok(!/[A-Z]:\\|\/home\/|\/Users\//.test(c.CODEX_HOOK_SCRIPT))
})

// npm's cmd-shim, as `npm install -g @openai/codex` writes it on Windows.
const NPM_SHIM = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*
`
const fakeFs = files => ({ exists: f => f in files, read: f => files[f] })

test('codex launch, Windows: an npm codex.cmd runs its script under Node, never through a shell', () => {
	const npm = 'C:\\Users\\a\\AppData\\Roaming\\npm'
	const script = `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`
	const files = { [`${npm}\\codex.cmd`]: NPM_SHIM, [`${npm}\\codex`]: '#!/bin/sh', [script]: '' }
	assert.deepEqual(c.codexLaunch('win32', `C:\\Windows;"${npm}"`, '.COM;.EXE;.BAT;.CMD', fakeFs(files)), { script })
	// The shim prefers a node.exe in its own folder, and so does the launch.
	assert.deepEqual(c.codexLaunch('win32', npm, undefined, fakeFs({ ...files, [`${npm}\\node.exe`]: '' })), { script, node: `${npm}\\node.exe` })
	// A .cmd that is not npm's shim (or a shim whose script is gone) is a batch file only cmd.exe can run.
	assert.deepEqual(c.codexLaunch('win32', npm, undefined, fakeFs({ [`${npm}\\codex.cmd`]: NPM_SHIM })), { batch: `${npm}\\codex.cmd` })
})

test('codex launch, Windows: a wrapper of the user\'s own (the Codex desktop app\'s codex.exe) runs through cmd.exe, one fixed line', () => {
	const bin = 'C:\\Users\\a b\\.local\\bin'
	const wrapper = '@echo off\r\nset "ROOT=%LOCALAPPDATA%\\OpenAI\\Codex\\bin"\r\nendlocal & "%EXE%" %*\r\n'
	const launch = c.codexLaunch('win32', bin, '.COM;.EXE;.BAT;.CMD', fakeFs({ [`${bin}\\codex.cmd`]: wrapper }))
	assert.deepEqual(launch, { batch: `${bin}\\codex.cmd` })
	assert.deepEqual(c.batchCommandLine(launch.batch, ['-p', 'insilode', 'mcp', 'list']), ['/d', '/s', '/c', `""${bin}\\codex.cmd" -p insilode mcp list"`])
	// Nothing cmd.exe would expand or split, in the path or the arguments, is ever passed to it.
	assert.equal(c.batchCommandLine('C:\\%PATH%\\codex.cmd', ['mcp']), undefined)
	assert.equal(c.batchCommandLine('C:\\a"b\\codex.cmd', ['mcp']), undefined)
	assert.equal(c.batchCommandLine('C:\\bin\\codex.cmd', ['mcp & calc']), undefined)
	assert.equal(c.batchCommandLine('C:\\bin\\codex.cmd', ['!x!']), undefined)
})

test('codex launch, Windows: an earlier PATH folder wins, and an .exe runs as it is', () => {
	const own = 'C:\\Tools\\codex'
	const npm = 'C:\\npm'
	const files = { [`${own}\\codex.exe`]: '', [`${npm}\\codex.cmd`]: NPM_SHIM, [`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '' }
	assert.deepEqual(c.codexLaunch('win32', `${own};${npm}`, '.EXE;.CMD', fakeFs(files)), { file: `${own}\\codex.exe` })
	assert.equal(c.codexLaunch('win32', `${npm}`, '.EXE;.CMD', fakeFs(files)).script, `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`)
	assert.equal(c.codexLaunch('win32', 'C:\\Windows', undefined, fakeFs(files)), undefined)
})

test('codex launch, macOS and Linux: the first codex on PATH', () => {
	const files = { '/usr/local/bin/codex': '', '/opt/codex/codex': '' }
	assert.deepEqual(c.codexLaunch('linux', '/usr/bin:/usr/local/bin:/opt/codex', undefined, fakeFs(files)), { file: '/usr/local/bin/codex' })
	assert.equal(c.codexLaunch('darwin', '/usr/bin', undefined, fakeFs(files)), undefined)
})
