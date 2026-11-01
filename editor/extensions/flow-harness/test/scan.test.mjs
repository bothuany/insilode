// The harness scan (src/scan.ts) over a workspace of several folders: every folder is read, the user's own files once, and a
// search that stopped at its file limit says so in the result. `vscode` is a small stub; the folders are real temp folders.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let tmp
let m
let a
let b
let userDir

const write = (file, text) => {
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, text)
}
const folder = (dir, name) => ({ name, uri: { fsPath: dir }, index: 0 })

/** What the stub's findFiles answers for the nested CLAUDE.md / AGENTS.md search, by folder, and what it was asked. */
let nested = new Map()
let asked = []

before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-scan-')))
	userDir = join(tmp, 'user-claude')
	a = join(tmp, 'a')
	b = join(tmp, 'b')
	write(join(userDir, 'CLAUDE.md'), '# Mine\nUse tabs.\n')
	write(join(a, 'CLAUDE.md'), '# A\nBuild with make.\n')
	write(join(b, 'CLAUDE.md'), '# B\nBuild with npm.\n')
	write(join(b, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship B\n---\nSteps\n')
	// The scan reads the user's folders from these, never from the real home of whoever runs the test.
	process.env.CLAUDE_CONFIG_DIR = userDir
	process.env.CODEX_HOME = join(tmp, 'user-codex')
	process.env.USERPROFILE = tmp
	process.env.HOME = tmp
	const stub = join(tmp, 'vscode-stub.cjs')
	writeFileSync(stub, `class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern } }
module.exports = {
	RelativePattern,
	get workspace() { return globalThis.__workspace },
}`)
	globalThis.__workspace = {
		workspaceFolders: [],
		findFiles: async (pattern, _exclude, limit) => {
			if (pattern && typeof pattern === 'object' && pattern.pattern.includes('{CLAUDE,AGENTS}')) {
				asked.push({ folder: pattern.base.name, limit })
				return nested.get(pattern.base.name) ?? []
			}
			return []
		},
	}
	const outfile = join(tmp, 'scan.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'scan.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', alias: { vscode: stub }, mainFields: ['module', 'main'] })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const labels = h => h.items.map(i => i.label)

test('every workspace folder is scanned, and the user\'s own files only once', async () => {
	nested = new Map()
	asked = []
	globalThis.__workspace.workspaceFolders = [folder(a, 'a'), folder(b, 'b')]
	const h = await m.scan()
	assert.equal(h.root, a, 'the first folder stays the root')
	assert.equal(h.items.filter(i => i.kind === 'instructions').length, 3, 'the user file, the first folder\'s and the second folder\'s, each once')
	assert.ok(labels(h).includes('CLAUDE.md'), 'the first folder keeps its plain label')
	assert.ok(labels(h).includes('b: CLAUDE.md'), 'the second folder\'s file is named after its folder')
	assert.ok(h.items.some(i => i.kind === 'skills' && i.label === 'b: deploy'), 'the second folder\'s skill is listed')
	assert.equal(h.items.filter(i => i.scope === 'user' && i.kind === 'instructions').length, 1)
	// Each folder is searched for nested files on its own, within the limit.
	assert.deepEqual(asked, [{ folder: 'a', limit: 200 }, { folder: 'b', limit: 200 }])
	assert.equal(h.notes, undefined, 'no limit was hit')
})

test('a folder with more nested files than the limit says so in the result and in the list', async () => {
	// 200 is the limit: a search that returns that many may have stopped there.
	nested = new Map([['b', Array.from({ length: 200 }, (_, i) => ({ fsPath: join(b, `pkg${i}`, 'CLAUDE.md') }))]])
	asked = []
	globalThis.__workspace.workspaceFolders = [folder(a, 'a'), folder(b, 'b')]
	const h = await m.scan()
	assert.equal(h.notes?.length, 1)
	assert.match(h.notes[0], /first 200 CLAUDE\.md and AGENTS\.md files in b/)
	const row = h.items.find(i => /More than 200/.test(i.label))
	assert.ok(row, 'an item in the list, so the tree shows it')
	assert.equal(row.issues[0].severity, 'info')
	assert.match(row.issues[0].message, /first 200/)
	assert.ok(!labels(h).some(l => /^a: /.test(l)) && !h.notes.some(n => /files in a\b/.test(n)), 'the folder under the limit says nothing')
})

test('a single folder behaves as before: no folder prefix, and the limit note when it is hit', async () => {
	nested = new Map([['a', Array.from({ length: 200 }, (_, i) => ({ fsPath: join(a, `pkg${i}`, 'AGENTS.md') }))]])
	globalThis.__workspace.workspaceFolders = [folder(a, 'a')]
	const h = await m.scan()
	assert.ok(labels(h).includes('CLAUDE.md'))
	assert.ok(labels(h).every(l => !l.startsWith('a: ')))
	assert.equal(h.notes?.length, 1)
	nested = new Map()
	assert.equal((await m.scan()).notes, undefined)
	globalThis.__workspace.workspaceFolders = []
	assert.equal(await m.scan(), undefined)
})
