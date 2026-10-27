// The worktree setup file (src/worktreeSetup.ts): parsing, copy path validation, copying and how commands are launched.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let s
let tmp
before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-wt-setup-')))
	const outfile = join(tmp, 'setup.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'worktreeSetup.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	s = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('copy entries must be relative paths inside the repository', () => {
	for (const ok of ['.env', 'config/local.json', 'a\\b.txt', './x']) {
		assert.equal(s.copyPathProblem(ok), undefined, ok)
	}
	for (const bad of ['../x', 'a/../../x', '..\\x', '/etc/passwd', 'C:\\x', 'C:x', '\\\\server\\share', '~/x', '', '  ', '.', '.git/config', 'a\0b', 42, null]) {
		assert.ok(s.copyPathProblem(bad), String(bad))
	}
})

test('the file parses to commands as argument arrays, and any problem refuses the whole file', () => {
	const ok = s.parseSetupConfig('{"copy":[".env"],"setup":[["npm","ci"]],"teardown":[["npm","run","clean"]]}')
	assert.deepEqual(ok.config, { copy: ['.env'], setup: [['npm', 'ci']], teardown: [['npm', 'run', 'clean']] })
	assert.deepEqual(s.parseSetupConfig('{}').config, { copy: [], setup: [], teardown: [] })
	assert.match(s.parseSetupConfig('{"setup":["npm ci"]}').errors[0], /argument list/)
	assert.match(s.parseSetupConfig('{"copy":["../x"]}').errors[0], /\.\./)
	assert.match(s.parseSetupConfig('{"setup":[[]]}').errors[0], /argument list/)
	assert.ok(s.parseSetupConfig('nope').errors)
	assert.ok(s.parseSetupConfig('[]').errors)
})

test('commands start without a shell: as they are elsewhere, through PATH and PATHEXT on Windows', () => {
	assert.deepEqual(s.launchPlan(['npm', 'ci'], 'linux', '/usr/bin', undefined, () => true), { file: 'npm', args: ['ci'] })
	const exists = f => ['C:\\nodejs\\npm.cmd', 'C:\\git\\git.exe'].includes(f)
	assert.deepEqual(s.launchPlan(['git', 'status'], 'win32', 'C:\\nodejs;C:\\git', '.EXE;.CMD', exists), { file: 'C:\\git\\git.exe', args: ['status'] })
	assert.deepEqual(s.launchPlan(['npm', 'run', 'clean'], 'win32', 'C:\\nodejs;C:\\git', '.EXE;.CMD', exists, 'cmd.exe'),
		{ file: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\nodejs\\npm.cmd" run clean"'], verbatim: true })
	assert.match(s.launchPlan(['npm', 'run', 'a&calc'], 'win32', 'C:\\nodejs', '.CMD', exists), /may only hold/)
	assert.match(s.launchPlan(['npm', '%PATH%'], 'win32', 'C:\\nodejs', '.CMD', exists), /may only hold/)
	assert.match(s.launchPlan(['nothing'], 'win32', 'C:\\nodejs', '.CMD', exists), /not found/)
})

test('copy takes only regular files into the worktree and never overwrites or leaves it', async () => {
	const main = join(tmp, 'c-main')
	const wt = join(tmp, 'c-wt')
	mkdirSync(join(main, 'config'), { recursive: true })
	mkdirSync(wt, { recursive: true })
	writeFileSync(join(main, '.env'), 'SECRET=1')
	writeFileSync(join(main, 'config', 'local.json'), '{}')
	writeFileSync(join(main, 'tracked.txt'), 'main')
	writeFileSync(join(wt, 'tracked.txt'), 'worktree')
	const log = await s.copyIntoWorktree(main, wt, ['.env', 'config/local.json', 'tracked.txt', 'missing.txt', 'config', '../escape', '/abs'])
	assert.equal(readFileSync(join(wt, '.env'), 'utf8'), 'SECRET=1')
	assert.equal(readFileSync(join(wt, 'config', 'local.json'), 'utf8'), '{}')
	assert.equal(readFileSync(join(wt, 'tracked.txt'), 'utf8'), 'worktree')
	assert.equal(existsSync(join(tmp, 'escape')), false)
	assert.equal(log.filter(l => /skipped/.test(l)).length, 5)
})

test('copy does not write through a folder in the worktree that is a link out of it', async t => {
	const main = join(tmp, 'l-main')
	const wt = join(tmp, 'l-wt')
	const outside = join(tmp, 'l-outside')
	for (const d of [main, wt, outside]) {
		mkdirSync(d, { recursive: true })
	}
	mkdirSync(join(main, 'cfg'))
	writeFileSync(join(main, 'cfg', 'a.json'), '{}')
	try {
		symlinkSync(outside, join(wt, 'cfg'), 'junction')
	} catch (e) {
		t.skip(`cannot create a link here: ${e.code}`)
		return
	}
	const log = await s.copyIntoWorktree(main, wt, ['cfg/a.json'])
	assert.equal(existsSync(join(outside, 'a.json')), false)
	assert.match(log[0], /leads out of the worktree/)
})
