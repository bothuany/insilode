// The rule behind Agents.spawn's refusal to take over a live session's id (src/spawnGuard.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

test('the refusal names where the session runs and what to do', T, () => {
	assert.match(m.elsewhereMessage('Fix login', { source: 'Claude Code CLI', pid: 4321 }), /^Fix login is running in Claude Code CLI \(process 4321\).*Close it there first\.$/)
	assert.match(m.elsewhereMessage('', { source: 'Claude desktop', pid: 7 }), /^That session is running in Claude desktop/)
})

// Agents reaches vscode, so it is not run here: this keeps the one place every way of resuming a Claude session goes through (the palette,
// the page, a click on an ended row all end in spawn) from losing its check against the registry of running sessions.
test('Agents.spawn asks the registry before it opens a terminal for a resumed Claude session, and the extension wires the real one in', T, () => {
	const src = readFileSync(join(ROOT, 'src', 'agents.ts'), 'utf8')
	const spawn = src.slice(src.indexOf('async spawn('))
	const check = spawn.indexOf('this.elsewhere?.(')
	assert.ok(check > 0 && check < spawn.indexOf('vscode.window.createTerminal('), 'the check comes before the terminal')
	assert.match(spawn.slice(check - 200, check), /cli === 'claude' && resume/)
	assert.match(readFileSync(join(ROOT, 'src', 'extension.ts'), 'utf8'), /new Agents\(context, log, ids => runningElsewhere\(ids\)\)/)
})
