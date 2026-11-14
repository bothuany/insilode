// The machine-wide session index (src/sessionIndex.ts): the real folder comes from inside each transcript, never from the Claude
// directory's name; only the newest files are opened; a missing folder or a garbled file never breaks the listing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = join(ROOT, 'test', 'fixtures', 'index')
const key = cwd => createHash('sha1').update(cwd).digest('hex').slice(0, 12)
let s
let tmp
let n = 0
before(async () => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-sessionindex-')))
	const outfile = join(tmp, 'sessionIndex.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'sessionIndex.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	s = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

/** A fresh machine: empty Claude and Codex homes, and a folder maker. */
function machine() {
	const home = join(tmp, 'm' + n++)
	process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
	process.env.CODEX_HOME = join(home, 'codex')
	mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true })
	mkdirSync(join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01'), { recursive: true })
	const folder = name => { const d = join(home, 'work', name); mkdirSync(d, { recursive: true }); return d }
	const claude = (dirName, text, mtime, id = randomUUID()) => {
		const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', dirName)
		mkdirSync(dir, { recursive: true })
		const file = join(dir, id + '.jsonl')
		writeFileSync(file, text)
		if (mtime) { utimesSync(file, mtime / 1000, mtime / 1000) }
		return id
	}
	const codex = (text, name = 'rollout-2026-01-01T00-00-00-x.jsonl') => writeFileSync(join(process.env.CODEX_HOME, 'sessions', '2026', '01', '01', name), text)
	return { home, folder, claude, codex }
}
const fixture = (name, vars) => Object.entries(vars).reduce((t, [k, v]) => t.split(k).join(v), readFileSync(join(FIX, name), 'utf8'))
const user = (cwd, text) => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } }) + '\n'

test('the folder is the cwd inside the file, not the lossy directory name; the title is /rename, else the first prompt', async () => {
	const m = machine()
	const app = m.folder('real-app')
	const a = m.claude('-completely-different-name', fixture('claude-lossy.jsonl', { '@APP@': app }))
	const b = m.claude('-completely-different-name', fixture('claude-truncated.jsonl', { '@APP@': app }))
	const projects = await s.scan()
	assert.equal(projects.length, 1)
	assert.equal(projects[0].cwd, app)
	assert.equal(projects[0].key, key(app))
	assert.equal(projects[0].name, 'real-app')
	const byId = Object.fromEntries(projects[0].sessions.map(x => [x.id, x]))
	assert.equal(byId[a].title, 'Login work')
	assert.equal(byId[a].kind, 'claude')
	// The last line is cut off mid-JSON: the conversation is still listed, named by its first prompt.
	assert.equal(byId[b].title, 'Second conversation')
})

test('a Codex rollout is read from its session_meta line', async () => {
	const m = machine()
	const app = m.folder('codex-app')
	m.codex(fixture('codex-rollout.jsonl', { '@CODEX@': app }))
	const [p] = await s.scan()
	assert.equal(p.cwd, app)
	assert.deepEqual(p.sessions.map(x => [x.id, x.kind, x.title]), [['11111111-2222-3333-4444-555555555555', 'codex', 'Add a retry to the client']])
})

test('Claude and Codex sessions of one folder share one project, newest first', async () => {
	const m = machine()
	const app = m.folder('both')
	m.claude('-x', user(app, 'older claude'), Date.now() - 60_000)
	m.codex(fixture('codex-rollout.jsonl', { '@CODEX@': app }))
	const [p] = await s.scan()
	assert.deepEqual(p.sessions.map(x => x.kind), ['codex', 'claude'])
})

test('a folder that no longer exists is dropped, and a garbled file is ignored without a word', async () => {
	const m = machine()
	const app = m.folder('kept')
	m.claude('-a', fixture('claude-missing.jsonl', { '@GONE@': join(m.home, 'work', 'deleted') }))
	m.claude('-b', readFileSync(join(FIX, 'garbage.jsonl')))
	m.claude('-c', user(app, 'hello'))
	writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'not-a-uuid.jsonl'), user(app, 'ignored'))
	m.codex('{"type":"session_meta","payload":{"id":"nope","cwd":"relative/path"}}\n')
	const projects = await s.scan()
	assert.deepEqual(projects.map(p => p.cwd), [app])
	assert.equal(projects[0].sessions.length, 1)
})

test('a transcript with a relative cwd or no prompt is not listed', async () => {
	const m = machine()
	m.claude('-a', user('relative/dir', 'hi'))
	m.claude('-b', JSON.stringify({ type: 'summary', cwd: m.folder('empty') }) + '\n')
	assert.deepEqual(await s.scan(), [])
})

test('the caps: 20 sessions a project, 50 projects, and only the newest 300 files are opened at all', async () => {
	const m = machine()
	const base = Date.now() - 10_000_000
	const busy = m.folder('busy')
	for (let i = 0; i < 25; i++) { m.claude('-busy', user(busy, 'prompt ' + i), base + i * 1000) }
	for (let i = 0; i < 54; i++) { m.claude('-p' + i, user(m.folder('p' + i), 'p'), base + 100_000 + i * 1000) }
	// Beyond the 300 newest, a project is not known at all.
	const stale = m.folder('stale')
	for (let i = 0; i < 20; i++) { m.claude('-stale', user(stale, 'old'), base - 1_000_000 - i * 1000) }
	for (let i = 0; i < 220; i++) { m.claude('-filler', user(busy, 'filler ' + i), base + 1_000_000 + i) }
	const projects = await s.scan()
	assert.equal(projects.length, 50)
	assert.ok(projects.every(p => p.sessions.length <= 20))
	const mine = projects.find(p => p.cwd === busy)
	assert.equal(mine.sessions.length, 20)
	assert.ok(!projects.some(p => p.cwd === stale))
	// Newest project first.
	assert.equal(projects[0].cwd, busy)
})

test('the index scans at most once per 10 seconds, and overlapping asks share one scan', async () => {
	const m = machine()
	const app = m.folder('throttle')
	m.claude('-a', user(app, 'one'))
	const idx = new s.SessionIndex()
	const t0 = 1_000_000
	const [x, y] = await Promise.all([idx.list(t0), idx.list(t0)])
	assert.equal(x, y)
	m.claude('-a', user(app, 'two'))
	assert.equal(await idx.list(t0 + 9_999), x, 'the last answer, still fresh')
	const later = await idx.list(t0 + 10_001)
	assert.equal(later[0].sessions.length, 2)
})

test('a rollout with two session_meta lines before its first prompt is the one named by the last (as the resume list always read it)', async () => {
	const m = machine()
	const app = m.folder('forked')
	m.codex(fixture('codex-forked.jsonl', { '@CODEX@': app }))
	const [p] = await s.scan()
	assert.deepEqual(p.sessions.map(x => x.id), ['bbbbbbbb-2222-3333-4444-555555555555'])
	const head = s.codexHead(fixture('codex-forked.jsonl', { '@CODEX@': app }).split('\n').filter(Boolean))
	assert.equal(head.id, 'bbbbbbbb-2222-3333-4444-555555555555')
	assert.equal(head.prompt, 'Fork of an earlier turn')
})

test('a scan whose time is up returns what it has (here nothing) instead of waiting for the disk', async () => {
	const m = machine()
	m.claude('-a', user(m.folder('late'), 'hello'))
	assert.deepEqual(await s.scan(0), [])
	assert.equal((await s.scan()).length, 1)
})
