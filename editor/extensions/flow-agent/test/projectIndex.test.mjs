// The sidebar's earlier sessions (src/projectIndex.ts): this window's own project first and always listed, other projects with their
// newest sessions, the sessions running in a terminal left out, and a search over exactly what the list shows.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
const VSCODE = 'module.exports = { workspace: { isTrusted: true, workspaceFolders: [] }, window: {} }'
let mod
let tmp
let n = 0
before(async () => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-projectindex-')))
	const outfile = join(tmp, 'projectIndex.mjs')
	await build({
		entryPoints: [join(ROOT, 'src', 'projectIndex.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
		plugins: [{ name: 'stub-vscode', setup: b => {
			b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }))
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE, loader: 'js' }))
		} }],
	})
	mod = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const transcript = (cwd, text) => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } }) + '\n'
/** A machine with this window's folder and another, each with one Claude session. */
function machine() {
	const home = join(tmp, 'm' + n++)
	const own = join(home, 'own')
	const other = join(home, 'other')
	process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
	process.env.CODEX_HOME = join(home, 'codex')
	const ids = {}
	for (const [name, cwd] of Object.entries({ own, other })) {
		mkdirSync(cwd, { recursive: true })
		const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-' + name)
		mkdirSync(dir, { recursive: true })
		ids[name] = randomUUID()
		writeFileSync(join(dir, ids[name] + '.jsonl'), transcript(cwd, 'hello from ' + name))
	}
	return { own, other, ids }
}

test('this window\'s project comes first with its folder, the others follow; each carries the folder a session starts in', T, async () => {
	const m = machine()
	const index = new mod.ProjectIndex(() => m.own, () => [])
	const list = await index.projects()
	assert.deepEqual(list.map(p => [p.own, p.name]), [[true, 'own'], [false, 'other']])
	assert.equal(list[0].cwd, m.own)
	assert.equal(list[1].cwd, m.other)
	assert.deepEqual(list.map(p => p.sessions.map(s => s.id)), [[m.ids.own], [m.ids.other]])
	assert.match(list[1].key, /^[0-9a-f]{12}$/)
})

test('this window\'s project is listed even with no session and no folder opened lists none first', T, async () => {
	machine()
	const lone = join(tmp, 'lonely')
	mkdirSync(lone, { recursive: true })
	const list = await new mod.ProjectIndex(() => lone, () => []).projects()
	assert.equal(list[0].own, true)
	assert.equal(list[0].name, basename(lone))
	assert.deepEqual(list[0].sessions, [])
	assert.equal((await new mod.ProjectIndex(() => undefined, () => []).projects()).every(p => !p.own), true)
})

test('sessions running in a terminal of this window are left out of the list, by session id', T, async () => {
	const m = machine()
	const list = await new mod.ProjectIndex(() => m.own, () => [m.ids.own, '']).projects()
	assert.deepEqual(list[0].sessions, [])
	assert.equal(list.length, 2, 'a project that only had running sessions is dropped, unless it is this window\'s own')
	const gone = await new mod.ProjectIndex(() => m.own, () => [m.ids.other]).projects()
	assert.deepEqual(gone.map(p => p.name), ['own'])
})

test('a search covers the listed projects and its hits name a project by key and a session by id', T, async () => {
	const m = machine()
	const index = new mod.ProjectIndex(() => m.own, () => [])
	const { hits, cut } = await index.search('hello from other', new AbortController().signal)
	assert.equal(cut, false)
	assert.deepEqual(hits.map(h => [h.kind, h.session]), [['claude', m.ids.other]])
	const list = await index.projects()
	assert.equal(hits[0].project, list[1].key)
	assert.deepEqual((await index.search('no such words', new AbortController().signal)).hits, [])
})
