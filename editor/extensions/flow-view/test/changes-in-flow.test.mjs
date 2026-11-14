// changesInFlow (src/mcp/handlers.ts) when everything that changed is hidden: it says what was hidden and opens nothing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { cleanup, temp } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let mod
const docs = {}
before(async () => {
	const out = temp('flow-changes-in-flow-')
	const stub = join(out, 'vscode.cjs')
	writeFileSync(stub, `module.exports = {
		workspace: {
			get workspaceFolders() { return (globalThis.__folders ?? []).map(f => ({ uri: { fsPath: f, scheme: 'file' } })) },
			getConfiguration: () => ({ get: (k, d) => d }),
			asRelativePath: u => (u.fsPath ?? u).replace(/^[/\\\\]+/, ''),
			openTextDocument: async u => ({ getText: () => globalThis.__docs[u.fsPath] }),
		},
		Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
		extensions: { getExtension: () => globalThis.__git && { isActive: true, exports: { getAPI: () => globalThis.__git } } },
	}`)
	globalThis.__docs = docs
	await build({ stdin: { contents: "export { AgentTools, isSafeRef } from './src/mcp/handlers.ts'", resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'mod.mjs'), logLevel: 'silent', alias: { vscode: stub }, external: ['bufferutil', 'utf-8-validate'] })
	mod = await import(pathToFileURL(join(out, 'mod.mjs')).href)
})
after(cleanup)

const row = (file, before, now) => {
	docs['orig:' + file] = before
	docs[file] = now
	return { uri: { fsPath: file, scheme: 'file' }, original: { fsPath: 'orig:' + file }, modified: { fsPath: file }, mark: 'M', repo: 'r' }
}

function run(list) {
	const calls = []
	const tools = new mod.AgentTools({ log: { warn() { } }, trackChanges: async () => calls.push('track'), showChanges: async () => { calls.push('show'); throw new Error('unreachable') } })
	return tools.changesInFlow({ list, since: undefined, notes: [] }).then(r => ({ ...r, calls }))
}

test('every changed file is a test: nothing is opened, and the message names flow.showTests', async () => {
	const r = await run([row('/w/src/a.test.ts', 'one()\n', 'two()\n')])
	assert.deepEqual([r.ok, r.opened, r.calls], [false, false, []])
	assert.match(r.message, /1 test file/)
	assert.match(r.message, /flow\.showTests/)
})

test('every changed file is a comment: nothing is opened, and the message says so', async () => {
	const r = await run([row('/w/src/A.java', 'one()\n', 'one() // why\n')])
	assert.deepEqual([r.ok, r.opened, r.calls], [false, false, []])
	assert.match(r.message, /1 comment-only or whitespace-only file/)
})

// open_diff with base "ref" or "session" (src/mcp/handlers.ts changeBase): what git is given, and what an agent is told when it cannot be used.
test('isSafeRef accepts commits and branch names, and refuses an option, a range and shell characters', () => {
	for (const ok of ['main', 'origin/main', 'feature/x-1.2', 'abc1234', 'a'.repeat(40)]) assert.ok(mod.isSafeRef(ok), ok)
	for (const bad of ['', '-x', '--output=/tmp/x', 'a..b', 'a b', 'a;b', '$(id)', 'a`id`', 'a|b', 'HEAD~1', 'a'.repeat(201)]) assert.ok(!mod.isSafeRef(bad), bad)
})

const diffTools = (extra = {}) => new mod.AgentTools({ log: { warn() { }, info() { } }, sessionStart: async () => undefined, ...extra })

test('open_diff base "ref" without a safe ref is an error, and git is never asked', async () => {
	const calls = []
	globalThis.__git = { repositories: [], openRepository: async () => { calls.push('open') } }
	for (const ref of [undefined, '--output=/tmp/x', 'a;b']) {
		const r = await diffTools().call('open_diff', { base: 'ref', ref })
		assert.equal(r.isError, true)
		assert.match(r.content[0].text, /base 'ref' needs `ref`/)
	}
	assert.deepEqual(calls, [])
})

test('open_diff base "ref": a valid ref is resolved to a hash and the diff is taken against it; an unknown one is an error naming it', async () => {
	const dir = temp('flow-ref-')
	globalThis.__folders = [dir]
	const asked = []
	const repo = {
		rootUri: { fsPath: dir },
		state: { workingTreeChanges: [], indexChanges: [], mergeChanges: [] },
		status: async () => { },
		diffWith: async hash => { asked.push(['diffWith', hash]); return [] },
		getMergeBase: async () => undefined,
		getCommit: async ref => { asked.push(['getCommit', ref]); if (ref === 'nope') { throw new Error('bad revision') } return { hash: 'abc1234def5678' } },
	}
	globalThis.__git = { repositories: [repo], openRepository: async () => null, toGitUri: u => u }
	try {
		const ok = await diffTools().call('open_diff', { base: 'ref', ref: 'feature/x' })
		assert.notEqual(ok.isError, true)
		assert.match(ok.content[0].text, /No changes since feature\/x/)
		assert.deepEqual(asked, [['getCommit', 'feature/x'], ['diffWith', 'abc1234def5678']])
		const bad = await diffTools().call('open_diff', { base: 'ref', ref: 'nope' })
		assert.equal(bad.isError, true)
		assert.match(bad.content[0].text, /"nope" is not a commit or branch/)
	} finally {
		globalThis.__folders = undefined
		globalThis.__git = undefined
	}
})

test('open_diff base "session" with no session id, or one that is not known, says to pass a ref', async () => {
	const none = await diffTools().call('open_diff', { base: 'session' })
	assert.equal(none.isError, true)
	assert.match(none.content[0].text, /no agent session to diff against; pass base 'ref' with a commit/)
	const unknown = await diffTools().call('open_diff', { base: 'session' }, { session: 'gone' })
	assert.equal(unknown.isError, true)
	assert.match(unknown.content[0].text, /no agent session to diff against/)
})

// base "session": only the repository the session ran in is diffed, against that session's HEAD (other repositories may not have the commit).
function sessionWorld() {
	const main = temp('flow-session-')
	const nested = join(main, 'nested')
	const wt = join(main, '.insilode', 'worktrees', 'claude-ab12')
	for (const d of [join(main, '.git', 'worktrees', 'claude-ab12'), join(nested, '.git'), join(nested, 'src'), wt]) mkdirSync(d, { recursive: true })
	writeFileSync(join(wt, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'claude-ab12')}\n`)
	const asked = []
	const repo = dir => ({
		rootUri: { fsPath: dir },
		state: { workingTreeChanges: [], indexChanges: [], mergeChanges: [] },
		status: async () => { },
		getMergeBase: async () => undefined,
		getCommit: async () => ({ hash: 'x' }),
		diffWith: async hash => { asked.push([dir.slice(main.length) || '/', hash]); return [] },
	})
	const repos = { main: repo(main), nested: repo(nested), wt: repo(wt) }
	globalThis.__folders = [main]
	globalThis.__git = { repositories: [repos.main, repos.nested], openRepository: async u => u.fsPath === wt ? repos.wt : null, toGitUri: u => u }
	return { main, nested, wt, asked }
}
const sessionDiff = root => diffTools({ sessionStart: async () => ({ root, head: 'abc1234def' }) }).call('open_diff', { base: 'session' }, { session: 's1' })
const reset = () => { globalThis.__folders = undefined; globalThis.__git = undefined }

test('open_diff base "session": an agent in a worktree is diffed there, not in the main checkout or a nested repository', async () => {
	const w = sessionWorld()
	try {
		const r = await sessionDiff(w.wt)
		assert.notEqual(r.isError, true)
		assert.deepEqual(w.asked, [['/.insilode/worktrees/claude-ab12', 'abc1234def']])
	} finally { reset() }
})

test('open_diff base "session": a session started in a subfolder diffs the repository that contains it, and only that one', async () => {
	const w = sessionWorld()
	try {
		const r = await sessionDiff(join(w.nested, 'src'))
		assert.notEqual(r.isError, true)
		assert.deepEqual(w.asked, [['/nested', 'abc1234def']])
	} finally { reset() }
})

test('open_diff base "session": a folder that is in no git repository is an error, and nothing is diffed', async () => {
	const w = sessionWorld()
	try {
		const r = await sessionDiff(join(w.main, '..', 'flow-session-nowhere'))
		assert.equal(r.isError, true)
		assert.match(r.content[0].text, /not in a git repository/)
		assert.deepEqual(w.asked, [])
	} finally { reset() }
})

test('open_diff: `ref` with any base but "ref" is an error', async () => {
	globalThis.__git = { repositories: [], openRepository: async () => null }
	try {
		for (const base of [undefined, 'branch', 'session']) {
			const r = await diffTools().call('open_diff', { base, ref: 'main' })
			assert.equal(r.isError, true)
			assert.match(r.content[0].text, /`ref` is only used with base 'ref'/)
		}
	} finally { reset() }
})

// The safety rule of base "session": a repository outside every workspace folder that this window has not open is never opened for an agent.
test('open_diff base "session": a session root in a repository outside the workspace is refused, and openRepository is never called', async () => {
	const w = sessionWorld()
	const outside = temp('flow-outside-')
	mkdirSync(join(outside, '.git'), { recursive: true })
	const opened = []
	globalThis.__git.openRepository = async u => { opened.push(u.fsPath); return null }
	try {
		const r = await sessionDiff(join(outside, 'sub'))
		assert.equal(r.isError, true)
		assert.match(r.content[0].text, /not one this window has open/)
		assert.deepEqual(opened, [])
		assert.deepEqual(w.asked, [])
	} finally { reset() }
})

test('open_diff base "session": a submodule inside a linked worktree is not taken for a worktree, and is diffed when Git has it open', async () => {
	const w = sessionWorld()
	const sub = join(w.wt, 'lib')
	mkdirSync(sub, { recursive: true })
	writeFileSync(join(sub, '.git'), `gitdir: ${join(w.main, '.git', 'worktrees', 'claude-ab12', 'modules', 'lib')}\n`)
	globalThis.__git.repositories.push({ rootUri: { fsPath: sub }, state: { workingTreeChanges: [], indexChanges: [], mergeChanges: [] }, status: async () => { }, diffWith: async hash => { w.asked.push(['/sub', hash]); return [] } })
	try {
		const r = await sessionDiff(sub)
		assert.notEqual(r.isError, true)
		assert.deepEqual(w.asked, [['/sub', 'abc1234def']])
	} finally { reset() }
})

// "No changes" counts the repositories that were diffed, names only a base that was found, and says how many were skipped and why.
function branchWorld(spec) {
	const dirs = Object.keys(spec).map(() => temp('flow-branch-'))
	const repo = (dir, s) => ({
		rootUri: { fsPath: dir },
		state: { workingTreeChanges: [], indexChanges: [], mergeChanges: [] },
		status: async () => { },
		getMergeBase: async () => s.base,
		getCommit: async () => ({ hash: 'abc1234' }),
		diffWith: async () => { if (s.diff === 'fails') { throw new Error('git diff failed') } return [] },
	})
	globalThis.__folders = dirs
	globalThis.__git = { repositories: Object.values(spec).map((s, i) => repo(dirs[i], s)), openRepository: async () => null, toGitUri: u => u }
	return dirs
}
const branchDiff = () => diffTools().call('open_diff', { base: 'branch' }).then(r => r.content[0].text)

test('open_diff base "branch": a repository with no base is not counted, and the message says it was skipped and why', async () => {
	const [, skippedDir] = branchWorld({ a: { base: 'abc1234def' }, b: {} })
	try {
		const msg = await branchDiff()
		assert.match(msg, /^No changes since main in 1 git repository of this workspace; 1 skipped \(.*: left out, no main or master branch to compare with\)\.$/)
		assert.ok(msg.includes(skippedDir.split(/[/\\]/).pop()))
	} finally { reset() }
})

test('open_diff base "branch": a failed diff is skipped too, with its reason', async () => {
	branchWorld({ a: { base: 'abc1234def' }, b: { base: 'abc1234def', diff: 'fails' } })
	try {
		assert.match(await branchDiff(), /^No changes since main in 1 git repository of this workspace; 1 skipped \(.*: git diff failed\)\.$/)
	} finally { reset() }
})

test('open_diff base "branch": when no repository has a base, no base is named and nothing is called "the main branch"', async () => {
	branchWorld({ a: {}, b: {} })
	try {
		const msg = await branchDiff()
		assert.match(msg, /^No git repository of this workspace could be diffed \(.*; .*\)\.$/)
		assert.doesNotMatch(msg, /main branch|since/)
	} finally { reset() }
})

test('open_diff: with no repository open at all, it says so instead of counting zero', async () => {
	branchWorld({})
	try {
		assert.equal(await branchDiff(), 'No git repository is open in this workspace.')
		assert.equal(await diffTools().call('open_diff', {}).then(r => r.content[0].text), 'No git repository is open in this workspace.')
	} finally { reset() }
})

test('open_diff: with nothing skipped the message is the plain count of repositories', async () => {
	branchWorld({ a: { base: 'abc1234def' }, b: { base: 'abc1234def' } })
	try {
		assert.equal(await branchDiff(), 'No changes since main in 2 git repositories of this workspace.')
	} finally { reset() }
})
