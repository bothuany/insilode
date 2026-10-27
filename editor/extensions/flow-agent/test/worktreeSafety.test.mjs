// Worktree cleanup safety (src/worktreeSafety.ts): link unlinking, classification and the guard re-check.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let s
let tmp
before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-wt-safety-')))
	const outfile = join(tmp, 'safety.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'worktreeSafety.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	s = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const facts = (over = {}) => ({ head: 'a1', merged: true, remoteGone: false, ahead: 0, unpushed: 0, dirty: 0, live: false, ageDays: 3, ...over })

test('a merged, clean, idle worktree is safe and pre-picked', () => {
	const k = s.classify(facts())
	assert.deepEqual([k.state, k.safe, k.blockers], ['merged', true, []])
})

test('a squash-merged branch shows as remote gone and is safe', () => {
	const k = s.classify(facts({ merged: false, remoteGone: true, ahead: 4, unpushed: 4 }))
	assert.equal(k.state, 'remote gone')
	assert.equal(k.safe, true)
})

test('an unmerged branch is never pre-picked, with or without commits', () => {
	assert.equal(s.classify(facts({ merged: false, ahead: 0 })).safe, false)
	const k = s.classify(facts({ merged: false, ahead: 2, unpushed: 2 }))
	assert.deepEqual([k.state, k.safe], ['unmerged', false])
	assert.match(k.blockers[0], /2 commits are not merged or pushed/)
})

test('dirty, live and unreadable worktrees are blocked whatever their branch state', () => {
	assert.equal(s.classify(facts({ dirty: 1 })).safe, false)
	assert.equal(s.classify(facts({ live: true })).safe, false)
	assert.equal(s.classify(facts({ dirty: undefined })).safe, false)
	assert.equal(s.classify(facts({ remoteGone: true, merged: false, dirty: 3 })).safe, false)
})

test('the re-check skips a worktree whose guards changed since the list', () => {
	const shown = facts()
	assert.deepEqual(s.recheck(shown, facts()), { ok: true })
	assert.match(s.recheck(shown, facts({ dirty: 2 })).reason, /2 uncommitted changes/)
	assert.match(s.recheck(shown, facts({ live: true })).reason, /session/)
	assert.match(s.recheck(shown, facts({ merged: false, unpushed: 1 })).reason, /not merged or pushed/)
	assert.match(s.recheck(shown, facts({ head: 'b2' })).reason, /commit was made/)
})

// A fake file system: a tree of names; 'link' is a link, an object is a folder.
const fake = tree => {
	const at = dir => dir.split(/[\\/]/).filter(Boolean).reduce((n, p) => n[p], tree)
	return {
		readdir: async dir => Object.entries(at(dir)).map(([name, v]) => ({ name, isLink: v === 'link', isDir: typeof v === 'object' })),
		unlinkLink: async file => {
			const parts = file.split(/[\\/]/).filter(Boolean)
			delete at(parts.slice(0, -1).join('/'))[parts.at(-1)]
		},
	}
}

test('findLinks reports links without descending into them', async () => {
	const fs = fake({ w: { node_modules: 'link', src: { a: {}, ui: { node_modules: 'link' } }, file: {} } })
	const found = await s.findLinks('/w', fs)
	assert.deepEqual(found.map(f => f.replace(/\\/g, '/')).sort(), ['/w/node_modules', '/w/src/ui/node_modules'])
})

test('findLinks leaves the top .git entry alone but reports a .git that is a link', async () => {
	const plain = await s.findLinks('/w', fake({ w: { '.git': {} } }))
	assert.deepEqual(plain, [])
	const link = await s.findLinks('/w', fake({ w: { '.git': 'link' } }))
	assert.equal(link.length, 1)
})

test('unlinkAll unlinks every link, then verifies none is left', async () => {
	const fs = fake({ w: { node_modules: 'link', sub: { deep: { x: 'link' } } } })
	assert.equal(await s.unlinkAll('/w', fs), 2)
	assert.deepEqual(await s.findLinks('/w', fs), [])
})

test('unlinkAll refuses (throws) when a link survives the unlink', async () => {
	const fs = fake({ w: { stubborn: 'link' } })
	fs.unlinkLink = async () => { /* removes nothing */ }
	await assert.rejects(() => s.unlinkAll('/w', fs), /still a link/)
})

test('real file system: links are removed and what they point at is untouched', async t => {
	const main = join(tmp, 'main')
	const wt = join(tmp, 'wt')
	mkdirSync(join(main, 'node_modules', 'pkg'), { recursive: true })
	writeFileSync(join(main, 'node_modules', 'pkg', 'index.js'), 'x')
	mkdirSync(join(wt, 'ui'), { recursive: true })
	writeFileSync(join(wt, 'keep.txt'), 'k')
	try {
		symlinkSync(join(main, 'node_modules'), join(wt, 'node_modules'), 'junction')
		symlinkSync(join(main, 'node_modules'), join(wt, 'ui', 'node_modules'), 'junction')
	} catch (e) {
		t.skip(`cannot create a link here: ${e.code}`)
		return
	}
	assert.equal((await s.findLinks(wt)).length, 2)
	assert.equal(await s.unlinkAll(wt), 2)
	assert.deepEqual(await s.findLinks(wt), [])
	assert.equal(existsSync(join(wt, 'node_modules')), false)
	assert.deepEqual(readdirSync(join(main, 'node_modules', 'pkg')), ['index.js'])
	assert.equal(existsSync(join(wt, 'keep.txt')), true)
})
