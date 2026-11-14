// The sidebar's earlier sessions (src/projectIndex.ts): this window's own project first and always listed, other projects with their
// newest sessions, the sessions running in a terminal left out, and a search over exactly what the list shows.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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

const running = (m, over = {}) => ({ id: randomUUID(), cwd: m.other, pid: 1, status: 'working', source: 'Claude desktop', name: 'Elsewhere', updatedAt: Date.now(), ...over })

test('sessions that run outside this window are marked on the projects, and this window\'s and the peers\' are not', T, async () => {
	const m = machine()
	const outside = running(m, { id: m.ids.other, status: 'needs' })
	const peer = running(m, { cwd: m.own })
	const mine = running(m, { cwd: m.own })
	const stranger = running(m, { cwd: join(tmp, 'elsewhere-folder'), name: 'Spike' })
	const list = await new mod.ProjectIndex(() => m.own, () => [mine.id], () => [peer.id], async () => [outside, peer, mine, stranger]).projects()
	assert.deepEqual(list.map(p => p.name), ['own', 'other', 'elsewhere-folder'])
	assert.deepEqual(list[0].sessions.map(s => [s.id, s.live]), [[m.ids.own, undefined]], 'neither this window\'s session nor a peer\'s is listed as running elsewhere')
	assert.deepEqual(list[1].sessions.map(s => [s.id, s.live]), [[m.ids.other, { status: 'needs', source: 'Claude desktop', basis: 'live' }]])
	assert.deepEqual(list[2].sessions.map(s => [s.title, s.live.status]), [['Spike', 'working']])
	assert.equal(list[2].cwd, join(tmp, 'elsewhere-folder'))
})

test('a tail is read from a transcript the host lists: an indexed one, or the live one it works out; any other id has none', T, async () => {
	const m = machine()
	const outside = running(m, { cwd: join(tmp, 'elsewhere-folder') })
	const index = new mod.ProjectIndex(() => m.own, () => [], () => [], async () => [outside])
	assert.equal(index.transcriptOf('claude', m.ids.other), undefined, 'nothing is listed before the first projects()')
	await index.projects()
	assert.match(index.transcriptOf('claude', m.ids.other), new RegExp(m.ids.other + '\\.jsonl$'))
	assert.match(index.transcriptOf('claude', outside.id), new RegExp(outside.id + '\\.jsonl$'))
	assert.equal(index.transcriptOf('claude', randomUUID()), undefined)
	assert.equal(index.transcriptOf('codex', outside.id), undefined, 'the kind must match')
	assert.notEqual(await index.runningSignature(), await new mod.ProjectIndex(() => m.own, () => [], () => [], async () => []).runningSignature())
})

test('the poll\'s read asks the registry once, and a cached index never scans the transcripts again', T, async () => {
	const m = machine()
	let asked = 0
	const index = new mod.ProjectIndex(() => m.own, () => [], () => [], async () => { asked++; return [] })
	await index.projects()
	assert.equal(asked, 1)
	// A new transcript appears: only a scan sees it.
	const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-own')
	const late = randomUUID()
	writeFileSync(join(dir, late + '.jsonl'), transcript(m.own, 'written later'))
	asked = 0
	await index.runningSignature()
	const cached = await index.projects({ cached: true })
	assert.equal(asked, 1, 'the signature and the index it led to share one look at the registry')
	assert.equal(cached[0].sessions.some(s => s.id === late), false, 'the cached index does not know the new transcript')
	await index.projects({ cached: true })
	assert.equal(asked, 2, 'a look of its own when the signature was not asked first')
})

test('a Codex rollout that changed after the last scan is "recently active" in a cached look too: its time is read again, on a copy', T, async () => {
	const m = machine()
	const id = '11111111-2222-3333-4444-555555555555'
	const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01')
	mkdirSync(dir, { recursive: true })
	const file = join(dir, 'rollout-2026-01-01T00-00-00-x.jsonl')
	writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id, cwd: m.other } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Add a retry' } }) + '\n')
	const old = Date.now() / 1000 - 3600
	utimesSync(file, old, old)
	const index = new mod.ProjectIndex(() => m.own, () => [])
	const codexOf = list => list.flatMap(p => p.sessions).find(s => s.kind === 'codex')
	assert.equal(codexOf(await index.projects()).live, undefined, 'an hour old: not active')
	const now = Date.now() / 1000
	utimesSync(file, now, now)
	// The scan is not repeated (a cached look), yet the file's new time is seen.
	const cached = codexOf(await index.projects({ cached: true }))
	assert.deepEqual(cached.live, { status: 'unknown', source: 'Codex', basis: 'recent' })
	assert.equal(codexOf(await index.projects()).live?.basis, 'recent', 'and so is a look that is free to scan but reuses a scan under ten seconds old')
})

test('the poll does not start more Codex stat calls while the last ones have not come back (a hung mount)', T, async () => {
	const m = machine()
	const dir = join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, 'rollout-2026-01-01T00-00-00-x.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: '11111111-2222-3333-4444-555555555555', cwd: m.other } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Add a retry' } }) + '\n')
	let calls = 0
	const index = new mod.ProjectIndex(() => m.own, () => [], () => [], async () => [], () => { calls++; return new Promise(() => undefined) })
	await index.projects()
	const first = calls
	assert.equal(first >= 1, true, 'the rollout\'s time was asked for')
	await index.projects({ cached: true })
	await index.projects({ cached: true })
	assert.equal(calls, first, 'nothing more while those are stuck')
})
