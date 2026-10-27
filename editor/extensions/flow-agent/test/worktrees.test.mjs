// Agent worktrees (src/worktrees.ts): the git argument arrays, git's output parsed, and the whole cycle on a real repository.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let w
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-worktrees-'))
	const outfile = join(tmp, 'worktrees.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'worktrees.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	w = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('slugs and branch names are safe to pass to git', () => {
	assert.equal(w.worktreeSlug('claude', '3F9A'), 'claude-3f9a')
	assert.equal(w.slugify('  Fix the Orders/Place bug!  '), 'fix-the-orders-place-bug')
	assert.equal(w.branchFor('claude-3f9a'), 'insilode/claude-3f9a')
	for (const ok of ['main', 'feature/x', 'insilode/claude-3f9a', 'release-1.2']) {
		assert.ok(w.validBranch(ok), ok)
	}
	for (const bad of ['-x', '--upload-pack=evil', 'a..b', 'a b', '.hidden', 'x/.y', 'x.lock', 'x/', '', 'a;b', 'a$(b)']) {
		assert.ok(!w.validBranch(bad), bad)
	}
})

test('argument arrays', () => {
	const dir = join('C:', 'repo', '.insilode', 'worktrees', 'claude-1')
	assert.deepEqual(w.addArgs(dir, 'insilode/claude-1', 'main'), ['worktree', 'add', '-b', 'insilode/claude-1', dir, 'main'])
	assert.deepEqual(w.removeArgs(dir, false), ['worktree', 'remove', dir])
	assert.deepEqual(w.removeArgs(dir, true), ['worktree', 'remove', '--force', dir])
	assert.deepEqual(w.aheadBehindArgs('main'), ['rev-list', '--left-right', '--count', 'main...HEAD'])
	assert.deepEqual(w.aheadBehindArgs('main', 'insilode/x'), ['rev-list', '--left-right', '--count', 'main...insilode/x'])
	assert.deepEqual(w.fastForwardArgs('insilode/x'), ['merge', '--ff-only', 'insilode/x'])
	assert.deepEqual(w.mergeArgs('insilode/x', 'msg'), ['merge', '--no-ff', '--no-edit', '-m', 'msg', 'insilode/x'])
	assert.deepEqual(w.mergeTreeArgs('main', 'insilode/x'), ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'main', 'insilode/x'])
	assert.throws(() => w.addArgs(dir, '--force', 'main'))
	assert.throws(() => w.mergeArgs('-oops', 'msg'))
	assert.equal(w.worktreePath(join('C:', 'repo'), 'claude-1'), dir)
})

test('ahead/behind: the base side comes first', () => {
	assert.deepEqual(w.parseAheadBehind('3\t5\n'), { behind: 3, ahead: 5 })
	assert.deepEqual(w.parseAheadBehind('0 0'), { behind: 0, ahead: 0 })
	assert.equal(w.parseAheadBehind('fatal: bad revision'), undefined)
})

test('status, merge-tree and worktree list output', () => {
	assert.deepEqual(w.parseStatus(' M src/a.ts\0?? new file.txt\0R  b.ts\0old b.ts\0'), ['src/a.ts', 'new file.txt', 'b.ts'])
	assert.deepEqual(w.parseStatus(''), [])
	assert.deepEqual(w.parseMergeTree(0, 'abc123\n'), { clean: true, conflicts: [] })
	assert.deepEqual(w.parseMergeTree(1, 'abc123\nsrc/a.ts\nsrc/a.ts\nb.ts\n'), { clean: false, conflicts: ['src/a.ts', 'b.ts'] })
	assert.equal(w.parseMergeTree(129, 'usage: ...'), undefined)
	const list = w.parseWorktreeList('worktree C:/repo\r\nHEAD aaa\r\nbranch refs/heads/main\r\n\r\nworktree C:/repo/.insilode/worktrees/x\r\nHEAD bbb\r\nbranch refs/heads/insilode/x\r\n\r\nworktree /d\r\nHEAD ccc\r\ndetached\r\n')
	assert.deepEqual(list, [
		{ path: 'C:/repo', head: 'aaa', branch: 'main' },
		{ path: 'C:/repo/.insilode/worktrees/x', head: 'bbb', branch: 'insilode/x' },
		{ path: '/d', head: 'ccc', detached: true },
	])
})

test('the exclude line is added once, never twice', () => {
	const once = w.withExclude('# git ls-files --others --exclude-from=.git/info/exclude\n*.tmp')
	assert.match(once, /\*\.tmp\n# Insilode.*\n\/\.insilode\/worktrees\/\n$/)
	assert.equal(w.withExclude(once), undefined)
	assert.equal(w.withExclude('.insilode/\n'), undefined)
	assert.equal(w.withExclude(''), '# Insilode: agent worktrees (see flow-agent/src/worktrees.ts)\n/.insilode/worktrees/\n')
	// The line older versions wrote under Insilode's note (all of .insilode) is narrowed, so .insilode/worktree.json can be committed.
	assert.equal(w.withExclude('*.tmp\n# Insilode: agent worktrees (see flow-agent/src/worktrees.ts)\n/.insilode/\n'), '*.tmp\n# Insilode: agent worktrees (see flow-agent/src/worktrees.ts)\n/.insilode/worktrees/\n')
})

// ── A real repository: create, count, merge, refuse on a conflict, remove ─────────────────────────

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
function repo() {
	const dir = mkdtempSync(join(tmp, 'repo-'))
	run(dir, 'init', '-q', '-b', 'main')
	run(dir, 'config', 'user.email', 'insilode@example.com')
	run(dir, 'config', 'user.name', 'Insilode Test')
	run(dir, 'config', 'commit.gpgsign', 'false')
	run(dir, 'config', 'core.autocrlf', 'false')
	writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
	run(dir, 'add', '.')
	run(dir, 'commit', '-q', '-m', 'first')
	return dir
}
const commit = (cwd, file, text, msg) => {
	writeFileSync(join(cwd, file), text)
	run(cwd, 'add', file)
	run(cwd, 'commit', '-q', '-m', msg)
}

test('create a worktree, count ahead and behind, fast-forward back, remove', async () => {
	const dir = repo()
	const wt = await w.createWorktree(dir, 'claude-1')
	assert.equal(wt.branch, 'insilode/claude-1')
	assert.equal(wt.base, 'main')
	assert.ok(existsSync(join(wt.path, 'a.txt')))
	// By real path: the temp folder may be a short 8.3 name (Windows CI) or a link (/var on macOS), git prints the long one.
	assert.equal(realpathSync.native(wt.path), realpathSync.native(resolve(dir, '.insilode', 'worktrees', 'claude-1')))
	// Ignored through the shared exclude file: the main checkout stays clean.
	assert.match(readFileSync(join(dir, '.git', 'info', 'exclude'), 'utf8'), /^\/\.insilode\/worktrees\/$/m)
	assert.equal(run(dir, 'status', '--porcelain'), '')

	commit(wt.path, 'b.txt', 'b\n', 'agent work')
	commit(wt.path, 'c.txt', 'c\n', 'more agent work')
	assert.deepEqual(await w.aheadBehind(wt), { ahead: 2, behind: 0 })
	commit(dir, 'd.txt', 'd\n', 'someone else on main')
	assert.deepEqual(await w.aheadBehind(wt), { ahead: 2, behind: 1 })

	// main moved on, so this is a real merge (no conflict: different files).
	const plan = await w.planMerge(wt)
	assert.equal(plan.kind, 'merge')
	assert.equal(plan.ahead, 2)
	assert.deepEqual(await w.merge(wt, 'merge'), { ok: true })
	assert.ok(existsSync(join(dir, 'b.txt')))
	assert.equal((await w.planMerge(wt)).kind, 'nothing')

	// Uncommitted work in the worktree: a plain remove refuses, a forced one goes through.
	writeFileSync(join(wt.path, 'scratch.txt'), 'x')
	assert.deepEqual(await w.changedFiles(wt.path), ['scratch.txt'])
	assert.equal((await w.removeWorktree(wt, false)).ok, false)
	assert.deepEqual(await w.removeWorktree(wt, true), { ok: true })
	assert.ok(!existsSync(wt.path))
	// The branch stays.
	assert.match(run(dir, 'branch', '--list', 'insilode/claude-1'), /insilode\/claude-1/)
})

test('fast-forward when the base has not moved', async () => {
	const dir = repo()
	const wt = await w.createWorktree(dir, 'codex-2')
	commit(wt.path, 'b.txt', 'b\n', 'agent work')
	writeFileSync(join(wt.path, 'wip.txt'), 'not committed')
	const plan = await w.planMerge(wt)
	assert.deepEqual(plan, { kind: 'fast-forward', ahead: 1, uncommitted: 1 })
	assert.deepEqual(await w.merge(wt, 'fast-forward'), { ok: true })
	assert.equal(run(dir, 'rev-parse', 'main'), run(dir, 'rev-parse', 'insilode/codex-2'))
})

test('a conflict is refused before anything changes, and so is a dirty or switched main checkout', async () => {
	const dir = repo()
	const wt = await w.createWorktree(dir, 'claude-3')
	commit(wt.path, 'a.txt', 'one\nTWO by the agent\nthree\n', 'agent edit')
	commit(dir, 'a.txt', 'one\ntwo on main\nthree\n', 'main edit')
	const head = run(dir, 'rev-parse', 'HEAD')
	const plan = await w.planMerge(wt)
	assert.equal(plan.kind, 'refuse')
	assert.match(plan.reason, /conflicts with main in a\.txt/)
	assert.equal(run(dir, 'rev-parse', 'HEAD'), head)
	assert.equal(run(dir, 'status', '--porcelain'), '')

	writeFileSync(join(dir, 'a.txt'), 'dirty')
	assert.match((await w.planMerge(wt)).reason, /uncommitted changes \(1 file\)/)
	run(dir, 'checkout', '-q', '--', 'a.txt')
	run(dir, 'checkout', '-q', '-b', 'other')
	assert.match((await w.planMerge(wt)).reason, /on other, not main/)
})

test('no worktree outside a repository, from a folder below its top, or on a detached HEAD', async () => {
	await assert.rejects(w.createWorktree(mkdtempSync(join(tmp, 'plain-')), 'x'), /not a git repository/)
	const dir = repo()
	mkdirSync(join(dir, 'sub'))
	await assert.rejects(w.createWorktree(join(dir, 'sub'), 'x'), /inside the repository/)
	assert.ok(w.sameDir('C:/Repo/', 'c:\\repo', 'win32'))
	assert.ok(!w.sameDir('/a/Repo', '/a/repo', 'linux'))
	run(dir, 'checkout', '-q', '--detach')
	await assert.rejects(w.createWorktree(dir, 'x'), /detached/)
})
