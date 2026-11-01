// Where a new worktree starts (src/worktrees.ts chooseBase, originDefaultBranch) with a fake git, once for real on a
// repository with an origin, and the offered .insilode/worktree.json (src/worktreeSetup.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let w, s
let tmp
before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-wt-base-')))
	const load = async file => {
		const outfile = join(tmp, `${file}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${file}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		return import(pathToFileURL(outfile).href)
	}
	w = await load('worktrees')
	s = await load('worktreeSetup')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

/** A git that answers from a table of what the repository has, and records every call. */
function fakeGit({ origin = true, head, remote = [], local = [], fetchFails = false } = {}) {
	const calls = []
	const run = async (_cwd, args) => {
		calls.push(args)
		const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
		const no = (stderr = '') => ({ code: 1, stdout: '', stderr })
		const key = args.join(' ')
		if (key === 'config --get remote.origin.url') {
			return origin ? ok('https://example.com/r.git\n') : no()
		}
		if (args[0] === 'fetch') {
			return fetchFails ? { code: 128, stdout: '', stderr: 'fatal: unable to access origin\nmore' } : ok()
		}
		if (key === 'symbolic-ref --quiet --short refs/remotes/origin/HEAD') {
			return head ? ok(`origin/${head}\n`) : no()
		}
		const verify = /^rev-parse --verify --quiet refs\/(remotes\/origin|heads)\/(.+)\^\{commit\}$/.exec(key)
		if (verify) {
			return (verify[1] === 'heads' ? local : remote).includes(verify[2]) ? ok('abc\n') : no()
		}
		throw new Error(`unexpected git call: ${key}`)
	}
	return { run, calls }
}

test('origin/HEAD names the default branch; main, then master, when it does not; a dangling HEAD is not trusted', async () => {
	assert.equal(await w.originDefaultBranch(fakeGit({ head: 'develop', remote: ['develop', 'main'] }).run, 'r'), 'develop')
	assert.equal(await w.originDefaultBranch(fakeGit({ remote: ['master', 'main'] }).run, 'r'), 'main')
	assert.equal(await w.originDefaultBranch(fakeGit({ remote: ['master'] }).run, 'r'), 'master')
	// origin/HEAD points at a branch that is not there: the next candidate is used.
	assert.equal(await w.originDefaultBranch(fakeGit({ head: 'gone', remote: ['main'] }).run, 'r'), 'main')
	assert.equal(await w.originDefaultBranch(fakeGit({ remote: ['trunk'] }).run, 'r'), undefined)
})

test('current: nothing is asked of git and the branch you are on is the start', async () => {
	const g = fakeGit()
	assert.deepEqual(await w.chooseBase(g.run, 'r', 'feature', 'current'), { start: 'feature', base: 'feature', notes: [] })
	assert.equal(g.calls.length, 0)
})

test('origin-default: cut from origin/<default>, merging back into the local branch of that name', async () => {
	const g = fakeGit({ head: 'main', remote: ['main'], local: ['main'] })
	assert.deepEqual(await w.chooseBase(g.run, 'r', 'feature', 'origin-default'), { start: 'origin/main', base: 'main', notes: [] })
	assert.deepEqual(g.calls[1], ['fetch', '--quiet', 'origin'])
	// No local main: the branch you are on stays the base; on a detached HEAD the remote ref is.
	assert.deepEqual(await w.chooseBase(fakeGit({ remote: ['main'] }).run, 'r', 'feature', 'origin-default'), { start: 'origin/main', base: 'feature', notes: [] })
	assert.deepEqual(await w.chooseBase(fakeGit({ remote: ['main'] }).run, 'r', '', 'origin-default'), { start: 'origin/main', base: 'origin/main', notes: [] })
})

test('a failed fetch is not fatal: the last known origin ref is used and the user is told', async () => {
	const c = await w.chooseBase(fakeGit({ head: 'main', remote: ['main'], local: ['main'], fetchFails: true }).run, 'r', 'feature', 'origin-default')
	assert.equal(c.start, 'origin/main')
	assert.deepEqual(c.notes, ['could not fetch origin (fatal: unable to access origin): using the last known state of it'])
})

test('no origin remote, or no default branch found: the current branch, with the reason', async () => {
	const none = fakeGit({ origin: false })
	const a = await w.chooseBase(none.run, 'r', 'feature', 'origin-default')
	assert.deepEqual(a, { start: 'feature', base: 'feature', notes: ['this repository has no origin remote: the worktree starts from feature'] })
	assert.ok(!none.calls.some(c => c[0] === 'fetch'), 'nothing is fetched without an origin')
	const b = await w.chooseBase(fakeGit({ remote: ['trunk'] }).run, 'r', 'feature', 'origin-default')
	assert.equal(b.start, 'feature')
	assert.match(b.notes[0], /no default branch Insilode can find/)
	// A detached HEAD has nothing to fall back to.
	await assert.rejects(w.chooseBase(fakeGit({ origin: false }).run, 'r', '', 'origin-default'), /no origin remote.*detached/)
})

test('the worktree of a remote start point does not track it', () => {
	assert.deepEqual(w.addArgs('d', 'insilode/x', 'origin/main', true), ['worktree', 'add', '--no-track', '-b', 'insilode/x', 'd', 'origin/main'])
	assert.deepEqual(w.addArgs('d', 'insilode/x', 'main'), ['worktree', 'add', '-b', 'insilode/x', 'd', 'main'])
	assert.throws(() => w.verifyOriginArgs('--evil'))
})

// ── For real: a repository with an origin ─────────────────────────────────────────────────────────

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
function configure(dir) {
	run(dir, 'config', 'user.email', 'insilode@example.com')
	run(dir, 'config', 'user.name', 'Insilode Test')
	run(dir, 'config', 'commit.gpgsign', 'false')
	run(dir, 'config', 'core.autocrlf', 'false')
}

test('createWorktree cuts from origin/main, not from your unpushed work, and also from a detached HEAD', async () => {
	const origin = mkdtempSync(join(tmp, 'origin-'))
	run(origin, 'init', '-q', '-b', 'main')
	configure(origin)
	writeFileSync(join(origin, 'a.txt'), 'shared\n')
	run(origin, 'add', '.')
	run(origin, 'commit', '-q', '-m', 'shared work')
	const clone = join(mkdtempSync(join(tmp, 'clone-')), 'work')
	execFileSync('git', ['clone', '-q', origin, clone], { windowsHide: true })
	configure(clone)
	run(clone, 'checkout', '-q', '-b', 'feature')
	writeFileSync(join(clone, 'mine.txt'), 'unpushed\n')
	run(clone, 'add', '.')
	run(clone, 'commit', '-q', '-m', 'unpushed work')

	const notes = []
	const wt = await w.createWorktree(clone, 'claude-1', { base: 'origin-default', onNote: n => notes.push(n) })
	assert.equal(wt.base, 'main')
	assert.equal(run(wt.path, 'rev-parse', 'HEAD'), run(clone, 'rev-parse', 'origin/main'))
	assert.equal(run(clone, 'ls-tree', '--name-only', 'insilode/claude-1').includes('mine.txt'), false)
	assert.throws(() => execFileSync('git', ['config', '--get', 'branch.insilode/claude-1.merge'], { cwd: clone, stdio: 'pipe' }), 'no upstream is set')
	assert.deepEqual(notes, [])

	const here = await w.createWorktree(clone, 'claude-2')
	assert.equal(here.base, 'feature')
	assert.ok(run(clone, 'ls-tree', '--name-only', 'insilode/claude-2').includes('mine.txt'))

	run(clone, 'checkout', '-q', '--detach')
	const detached = await w.createWorktree(clone, 'claude-3', { base: 'origin-default' })
	assert.equal(run(detached.path, 'rev-parse', 'HEAD'), run(clone, 'rev-parse', 'origin/main'))
	await assert.rejects(w.createWorktree(clone, 'claude-4'), /detached/)
})

test('a repository with no origin falls back to the current branch and says why', async () => {
	const dir = mkdtempSync(join(tmp, 'lonely-'))
	run(dir, 'init', '-q', '-b', 'main')
	configure(dir)
	writeFileSync(join(dir, 'a.txt'), 'x\n')
	run(dir, 'add', '.')
	run(dir, 'commit', '-q', '-m', 'first')
	const notes = []
	const wt = await w.createWorktree(dir, 'claude-1', { base: 'origin-default', onNote: n => notes.push(n) })
	assert.equal(wt.base, 'main')
	assert.deepEqual(notes, ['this repository has no origin remote: the worktree starts from main'])
})

// ── The offered .insilode/worktree.json ───────────────────────────────────────────────────────────

test('the package manager comes from the lockfile', () => {
	assert.deepEqual(s.detectInstallCommand(['package.json', 'package-lock.json']), ['npm', 'ci'])
	assert.deepEqual(s.detectInstallCommand(['pnpm-lock.yaml']), ['pnpm', 'install', '--frozen-lockfile'])
	assert.deepEqual(s.detectInstallCommand(['yarn.lock', 'package.json']), ['yarn', 'install', '--frozen-lockfile'])
	assert.equal(s.detectInstallCommand(['package.json', 'src']), undefined)
	assert.equal(s.detectInstallCommand([]), undefined)
})

test('the template is what worktreeSetup reads: env files that exist, the install command, an empty teardown', () => {
	const text = s.setupTemplate(['.env', 'package-lock.json', 'src'])
	assert.deepEqual(JSON.parse(text), { copy: ['.env'], setup: [['npm', 'ci']], teardown: [] })
	assert.ok(text.endsWith('\n'))
	assert.deepEqual(s.parseSetupConfig(text), { config: { copy: ['.env'], setup: [['npm', 'ci']], teardown: [] } })
	// No lockfile: an empty commands list, and no copy entry for a file the repository does not have.
	const bare = s.setupTemplate(['README.md'])
	assert.deepEqual(JSON.parse(bare), { copy: [], setup: [], teardown: [] })
	assert.ok('config' in s.parseSetupConfig(bare))
	assert.deepEqual(JSON.parse(s.setupTemplate(['.env', '.env.local', 'pnpm-lock.yaml'])).copy, ['.env', '.env.local'])
})

test('the offer is made once per repository, and never where the file exists', () => {
	assert.equal(s.shouldOfferSetup(false, undefined), true)
	assert.equal(s.shouldOfferSetup(true, undefined), false)
	assert.equal(s.shouldOfferSetup(false, 'offered'), false)
	assert.equal(s.shouldOfferSetup(false, 'never'), false)
	assert.equal(s.setupOfferKey('/r'), 'flow.agents.worktreeSetupOffer:/r')
})
