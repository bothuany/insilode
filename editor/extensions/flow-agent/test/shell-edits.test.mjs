// Edits a shell command made during an agent's turn (src/shellEditsCore.ts, src/shellEdits.ts): git's porcelain output is
// parsed, two statuses are compared, tool-reported files are taken out, and a real sweep runs in a temporary repository.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let core
let sweep
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-shell-edits-'))
	for (const [name, file] of [['core', 'shellEditsCore.ts'], ['sweep', 'shellEdits.ts']]) {
		const outfile = join(tmp, `${name}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', file)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	}
	core = await import(pathToFileURL(join(tmp, 'core.mjs')).href)
	sweep = await import(pathToFileURL(join(tmp, 'sweep.mjs')).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const z = (...entries) => entries.join('\0') + '\0'

test('parsePorcelain: modified, deleted, untracked and added files, with spaces in the names', () => {
	const entries = core.parsePorcelain(z(' M src/a.ts', 'D  gone.ts', ' D worktree gone.ts', '?? new file.ts', 'A  added one.ts', 'MM both.ts'))
	assert.deepEqual(entries.map(e => [e.path, e.xy, e.untracked, e.deleted]), [
		['src/a.ts', ' M', false, false],
		['gone.ts', 'D ', false, true],
		['worktree gone.ts', ' D', false, true],
		['new file.ts', '??', true, false],
		['added one.ts', 'A ', false, false],
		['both.ts', 'MM', false, false],
	])
})

test('parsePorcelain: a rename in -z form is "XY new", then the old path as the next field', () => {
	const entries = core.parsePorcelain(z('R  new name.ts', 'old name.ts', ' M after.ts'))
	assert.deepEqual(entries.map(e => [e.path, e.from]), [['new name.ts', 'old name.ts'], ['after.ts', undefined]])
	// Delete plus create: both paths are named, the old one first only after the new one.
	assert.deepEqual(core.dirtyPaths(entries), ['new name.ts', 'old name.ts', 'after.ts'])
})

test('parsePorcelain: a name holding " -> " is a name, and a copy does not make its source dirty', () => {
	const entries = core.parsePorcelain(z('?? a -> b.txt', 'C  copy.ts', 'orig.ts'))
	assert.deepEqual(entries.map(e => e.path), ['a -> b.txt', 'copy.ts'])
	assert.deepEqual(core.dirtyPaths(entries), ['a -> b.txt', 'copy.ts'])
})

test('parsePorcelain: empty output, a trailing NUL and ignored entries give nothing', () => {
	assert.deepEqual(core.parsePorcelain(''), [])
	assert.deepEqual(core.parsePorcelain('\0'), [])
	assert.deepEqual(core.parsePorcelain(z('!! ignored.log')), [])
})

const sig = (size, mtimeMs, hash) => ({ exists: true, size, mtimeMs, ...(hash ? { hash } : {}) })
const gone = { exists: false, size: 0, mtimeMs: 0 }

test('diffStatus: a file that became dirty, or changed while dirty, is reported; an untouched one is not', () => {
	const before = new Map([['/r/kept.ts', sig(10, 1, 'aa')], ['/r/edited.ts', sig(10, 1, 'aa')], ['/r/big.bin', sig(5_000_000, 1)], ['/r/bigsame.bin', sig(5_000_000, 1)]])
	const after = new Map([['/r/kept.ts', sig(10, 1, 'aa')], ['/r/edited.ts', sig(12, 2, 'bb')], ['/r/new.ts', sig(3, 2, 'cc')], ['/r/big.bin', sig(5_000_001, 2)], ['/r/bigsame.bin', sig(5_000_000, 1)]])
	assert.deepEqual(core.diffStatus(before, after).sort(), ['/r/big.bin', '/r/edited.ts', '/r/new.ts'])
})

test('diffStatus: a touch alone is not a change when both sides have a hash; without a hash the mtime decides', () => {
	assert.deepEqual(core.diffStatus(new Map([['/r/a', sig(4, 1, 'h')]]), new Map([['/r/a', sig(4, 99, 'h')]])), [])
	assert.deepEqual(core.diffStatus(new Map([['/r/a', sig(4, 1)]]), new Map([['/r/a', sig(4, 99)]])), ['/r/a'])
})

test('diffStatus: a deleted file is reported once; one that stays deleted, or became clean, is not', () => {
	assert.deepEqual(core.diffStatus(new Map(), new Map([['/r/del.ts', gone]])), ['/r/del.ts'])
	assert.deepEqual(core.diffStatus(new Map([['/r/del.ts', gone]]), new Map([['/r/del.ts', gone]])), [])
	assert.deepEqual(core.diffStatus(new Map([['/r/was-dirty.ts', sig(1, 1, 'x')]]), new Map()), [], 'committed or reverted: same as HEAD again')
	assert.deepEqual(core.diffStatus(new Map([['/r/back.ts', gone]]), new Map([['/r/back.ts', sig(1, 1, 'x')]])), ['/r/back.ts'], 'deleted, then written again')
})

test('mergeIntoTurn: files an edit tool reported are taken out, however the path is spelled', () => {
	const reported = new Set(['C:\\shop\\a.ts', '/x/b.ts'])
	assert.deepEqual(core.mergeIntoTurn(reported, ['c:/shop/A.ts', '/x/b.ts', '/x/c.ts'], 40, true), ['/x/c.ts'])
	assert.deepEqual(core.mergeIntoTurn(reported, ['c:/shop/A.ts', '/x/c.ts'], 40, false), ['c:/shop/A.ts', '/x/c.ts'], 'case counts off Windows')
})

test('mergeIntoTurn: each file once, and no more than 40', () => {
	const found = Array.from({ length: 100 }, (_, i) => `/r/f${i}.ts`)
	assert.equal(core.mergeIntoTurn([], found).length, 40)
	assert.deepEqual(core.mergeIntoTurn([], ['/r/a', '/r/a', '/r/b']), ['/r/a', '/r/b'])
	assert.deepEqual(core.mergeIntoTurn([], found, 3), found.slice(0, 3))
})

test('isInsilodePath: the .insilode folder at any depth, nothing that only looks like it', () => {
	assert.ok(core.isInsilodePath('.insilode/timeline.json'))
	assert.ok(core.isInsilodePath('pkg/.insilode/x'))
	assert.ok(!core.isInsilodePath('src/insilode/x.ts'))
	assert.ok(!core.isInsilodePath('.insilode.json'))
})

// A real sweep in a temporary repository. The folder is resolved first: a Windows temp path may be an 8.3 short name,
// while git reports the long one.
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' })
function repo() {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-sweep-repo-')))
	git(dir, 'init', '-q')
	mkdirSync(join(dir, 'src'))
	writeFileSync(join(dir, 'src', 'a.ts'), 'one\n')
	writeFileSync(join(dir, 'src', 'b.ts'), 'two\n')
	writeFileSync(join(dir, 'src', 'dirty at start.ts'), 'three\n')
	writeFileSync(join(dir, '.gitignore'), 'ignored.log\n')
	git(dir, 'add', '.')
	git(dir, 'commit', '-q', '-m', 'init')
	return dir
}

test('ShellEditSweep: a file a command changed is returned; a tool-reported one is not', async t => {
	const dir = repo()
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const s = new sweep.ShellEditSweep()
	await s.begin('s1', dir)
	writeFileSync(join(dir, 'src', 'a.ts'), 'one, changed by sed\n')
	writeFileSync(join(dir, 'src', 'b.ts'), 'two, changed by the Edit tool\n')
	writeFileSync(join(dir, 'src', 'made by a command.ts'), 'new\n')
	unlinkSync(join(dir, 'src', 'dirty at start.ts'))
	writeFileSync(join(dir, 'ignored.log'), 'noise\n')
	mkdirSync(join(dir, '.insilode'))
	writeFileSync(join(dir, '.insilode', 'state.json'), '{}')
	const found = await s.end('s1', dir, new Set([join(dir, 'src', 'b.ts')]))
	assert.deepEqual(found.sort(), [join(dir, 'src', 'a.ts'), join(dir, 'src', 'dirty at start.ts'), join(dir, 'src', 'made by a command.ts')].sort())
})

test('ShellEditSweep: a file already dirty at the start is reported only when the command changed it again', async t => {
	const dir = repo()
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	writeFileSync(join(dir, 'src', 'a.ts'), 'edited by hand before the turn\n')
	writeFileSync(join(dir, 'src', 'b.ts'), 'also dirty\n')
	const s = new sweep.ShellEditSweep()
	await s.begin('s1', dir)
	writeFileSync(join(dir, 'src', 'b.ts'), 'a command rewrote it\n')
	assert.deepEqual(await s.end('s1', dir, new Set()), [join(dir, 'src', 'b.ts')])
})

test('ShellEditSweep: a session that never began, or began in a subfolder, gets paths against the repository root', async t => {
	const dir = repo()
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const s = new sweep.ShellEditSweep()
	assert.deepEqual(await s.end('nobody', dir, new Set()), [])
	await s.begin('s2', join(dir, 'src'))
	writeFileSync(join(dir, 'src', 'a.ts'), 'changed\n')
	assert.deepEqual(await s.end('s2', join(dir, 'src'), new Set()), [join(dir, 'src', 'a.ts')])
	assert.deepEqual(await s.end('s2', join(dir, 'src'), new Set()), [], 'a turn is swept once')
})

test('ShellEditSweep: a folder that is not a repository, or does not exist, gives [] and never throws', async t => {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-sweep-plain-')))
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const s = new sweep.ShellEditSweep()
	await s.begin('s1', dir)
	writeFileSync(join(dir, 'x.txt'), 'x')
	assert.deepEqual(await s.end('s1', dir, new Set()), [])
	await s.begin('s2', join(dir, 'missing'))
	assert.deepEqual(await s.end('s2', join(dir, 'missing'), new Set()), [])
	await s.begin('s3', undefined)
	assert.deepEqual(await s.end('s3', undefined, new Set()), [])
})

test('looksFromCommandEdits: a command-changed file is an edit look of the whole file, inside the roots only', async () => {
	const outfile = join(tmp, 'gaze.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'gaze.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	const g = await import(pathToFileURL(outfile).href)
	const ws = resolve('/ws/shop')
	assert.deepEqual(g.looksFromCommandEdits([join(ws, 'src', 'a.ts'), resolve('/elsewhere/b.ts'), join(ws, 'node_modules', 'x', 'c.js')], [ws]), [{ act: 'edit', file: join(ws, 'src', 'a.ts') }])
})
