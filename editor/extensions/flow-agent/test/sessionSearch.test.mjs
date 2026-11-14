// The Agents page's session search (src/sessionSearch.ts): what counts as said (user and assistant text of Claude transcripts and
// Codex rollouts; not tool calls, tool results, thoughts, hook lines or sidechains), the snippet, the caps (hits, files, bytes per
// file, time), newest first, cancelling, and that nothing throws. The transcript of a listed session comes from sessionIndex.ts.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = join(ROOT, 'test', 'fixtures', 'index')
let s
let tmp
let n = 0
before(async () => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-sessionsearch-')))
	const outfile = join(tmp, 'search.mjs')
	await build({
		stdin: { contents: "export * from './src/sessionSearch'; export * from './src/sessionIndex'", resolveDir: ROOT, loader: 'ts' },
		bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
	})
	s = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const live = () => new AbortController().signal
const fixture = (name, vars) => Object.entries(vars).reduce((t, [k, v]) => t.split(k).join(v), readFileSync(join(FIX, name), 'utf8'))

/** A few sessions on disk, each written as one transcript; `fileOf` finds them the way the index does. */
function world() {
	const dir = join(tmp, 'w' + n++)
	mkdirSync(dir, { recursive: true })
	const files = new Map()
	const add = (kind, text, modified = Date.now(), title = 'A session') => {
		const id = randomUUID()
		const file = join(dir, id + '.jsonl')
		writeFileSync(file, text)
		files.set(`${kind}|${id}`, file)
		return { id, kind, title, modified }
	}
	return { add, fileOf: (kind, id) => files.get(`${kind}|${id}`) }
}
const user = text => JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'

test('a word in what the user wrote matches, ignoring case and runs of white space; the snippet is one tidy line around it', async () => {
	const w = world()
	const a = w.add('claude', fixture('claude-search.jsonl', { '@APP@': '/x' }))
	const r = await s.searchSessions([{ key: 'p1', sessions: [a] }], w.fileOf, 'fix the login  REDIRECT', live())
	assert.equal(r.hits.length, 1)
	assert.deepEqual({ ...r.hits[0], snippet: undefined }, { project: 'p1', kind: 'claude', session: a.id, title: 'A session', modified: a.modified, snippet: undefined })
	assert.equal(r.hits[0].snippet, 'Please fix the LOGIN redirect after the session expires')
	assert.equal(r.more, false)
})

test('a word only the assistant said matches', async () => {
	const w = world()
	const a = w.add('claude', fixture('claude-search.jsonl', { '@APP@': '/x' }))
	const r = await s.searchSessions([{ key: 'p1', sessions: [a] }], w.fileOf, 'marmot', live())
	assert.equal(r.hits.length, 1)
	assert.match(r.hits[0].snippet, /Marmot setting/)
})

test('tool results, tool calls, thoughts, hook lines and sidechains are not searched', async () => {
	const w = world()
	const a = w.add('claude', fixture('claude-search.jsonl', { '@APP@': '/x' }))
	for (const word of ['Pangolin', 'Narwhal', 'Quokka', 'Zebrafish', 'Wombat']) {
		assert.deepEqual((await s.searchSessions([{ key: 'p1', sessions: [a] }], w.fileOf, word, live())).hits, [], word)
	}
})

test('Codex rollouts: the user and agent messages and the assistant\'s response items match; tool calls and their output do not', async () => {
	const w = world()
	const a = w.add('codex', fixture('codex-search.jsonl', { '@CODEX@': '/x' }), Date.now(), 'Add a retry')
	const find = word => s.searchSessions([{ key: 'p2', sessions: [a] }], w.fileOf, word, live())
	assert.equal((await find('retry to the client')).hits[0].kind, 'codex')
	assert.match((await find('backoff helper')).hits[0].snippet, /Backoff helper with jitter/)
	assert.match((await find('capybara')).hits[0].snippet, /Capybara handling/)
	for (const word of ['Axolotl', 'Ocelot']) { assert.deepEqual((await find(word)).hits, [], word) }
})

test('a long text is cut to about 160 characters around the match, with ellipses where it goes on', async () => {
	const w = world()
	const text = 'a'.repeat(300) + ' NEEDLE ' + 'b'.repeat(300)
	const a = w.add('claude', user(text))
	const { hits } = await s.searchSessions([{ key: 'p', sessions: [a] }], w.fileOf, 'needle', live())
	const snip = hits[0].snippet
	assert.ok(snip.startsWith('…') && snip.endsWith('…'))
	assert.ok(snip.includes('NEEDLE'))
	assert.ok(snip.length <= 162, String(snip.length))
	assert.equal(s.snippetAround('short NEEDLE text', 6, 6), 'short NEEDLE text')
})

test('the query is two to two hundred characters once trimmed, or nothing is searched', async () => {
	const w = world()
	const a = w.add('claude', user('x'.repeat(10)))
	for (const q of ['', ' x ', 'x', 'x'.repeat(201)]) { assert.deepEqual(await s.searchSessions([{ key: 'p', sessions: [a] }], w.fileOf, q, live()), { hits: [], more: false, cut: false }) }
	assert.equal((await s.searchSessions([{ key: 'p', sessions: [a] }], w.fileOf, 'xx', live())).hits.length, 1)
})

test('the hit cap alone is more, not cut', async () => {
	const w = world()
	const list = [w.add('claude', user('shared word'), 1), w.add('claude', user('shared word'), 2)]
	const r = await s.searchSessions([{ key: 'p', sessions: list }], w.fileOf, 'shared word', live(), { hits: 1 })
	assert.deepEqual([r.hits.length, r.more, r.cut], [1, true, false])
})

// `İ` is two UTF-16 units in a lower-cased copy, `ß` and emoji are not: the match must still be cut out of the original at its own place.
test('the match is found at its own place after İ, ß and emoji, whatever the case', async () => {
	const w = world()
	// Long enough that the snippet is a window: a match index shifted by one per İ would put the window past the match.
	for (const unit of ['İ', 'ß', '😀', 'İ😀ß']) {
		const text = unit.repeat(80) + ' the NEEDLE here ' + 'z'.repeat(200)
		const a = w.add('claude', user(text))
		const r = await s.searchSessions([{ key: 'p', sessions: [a] }], w.fileOf, 'needle', live())
		const at = text.indexOf('NEEDLE')
		assert.equal(r.hits[0].snippet, s.snippetAround(text, at, 6), unit)
		assert.ok(r.hits[0].snippet.includes('the NEEDLE here'), unit)
	}
	assert.equal(s.fold('İSTANBUL ß 😀').length, 'İSTANBUL ß 😀'.length)
	assert.equal(s.fold('İSTANBUL'), 'istanbul')
	const at = s.fold('İİİİİİİİİİ needle').indexOf('needle')
	assert.equal('İİİİİİİİİİ needle'.slice(at, at + 6), 'needle')
})

// Turkish has two letters i: the dotless `ı` pairs with `I`, the dotted `İ` with `i`. A search finds either spelling of a word.
test('a dotless ı or a dotted İ finds the plain i and I, and the other way round', async () => {
	assert.equal(s.fold('Iğdır İSTANBUL ışık IŞIK'), 'iğdir istanbul işik işik')
	assert.equal(s.fold('ıİ').length, 2)
	const w = world()
	for (const [text, query] of [['Iğdır is far east', 'ığdır'], ['IŞIK is light', 'ışık'], ['ışık is light', 'IŞIK']]) {
		const r = await s.searchSessions([{ key: 'p', sessions: [w.add('claude', user(text))] }], w.fileOf, query, live())
		assert.equal(r.hits.length, 1, query + ' in ' + text)
	}
})

test('a snippet never cuts a surrogate pair in two', () => {
	const flat = '😀'.repeat(150) + 'needle' + '😀'.repeat(150)
	for (const lead of ['', 'a']) {
		const text = lead + flat
		const at = text.indexOf('needle')
		const snip = s.snippetAround(text, at, 6)
		assert.doesNotMatch(snip, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/, 'no lone surrogate (lead ' + JSON.stringify(lead) + ')')
		assert.ok(snip.includes('needle'))
	}
})

test('newest first across projects, and at most the hit cap: the rest is "more"', async () => {
	const w = world()
	const old = w.add('claude', user('shared word'), 1000, 'old')
	const mid = w.add('codex', JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'shared word' } }) + '\n', 2000, 'mid')
	const fresh = w.add('claude', user('shared word'), 3000, 'fresh')
	const projects = [{ key: 'a', sessions: [old, fresh] }, { key: 'b', sessions: [mid] }]
	const all = await s.searchSessions(projects, w.fileOf, 'shared word', live())
	assert.deepEqual(all.hits.map(h => [h.title, h.project]), [['fresh', 'a'], ['mid', 'b'], ['old', 'a']])
	assert.equal(all.more, false)
	const capped = await s.searchSessions(projects, w.fileOf, 'shared word', live(), { hits: 2 })
	assert.deepEqual(capped.hits.map(h => h.title), ['fresh', 'mid'])
	assert.equal(capped.more, true)
})

test('only the newest files are looked into (the rest is "more"), and only the first bytes of a file are read', async () => {
	const w = world()
	const newer = w.add('claude', user('nothing here'), 2000)
	const older = w.add('claude', user('the word is here'), 1000)
	const r = await s.searchSessions([{ key: 'p', sessions: [older, newer] }], w.fileOf, 'word is here', live(), { files: 1 })
	assert.deepEqual([r.hits, r.more, r.cut], [[], true, true], 'the older file was not opened')
	const far = w.add('claude', user('x'.repeat(5000)) + user('hidden needle'), 3000)
	const clipped = await s.searchSessions([{ key: 'p', sessions: [far] }], w.fileOf, 'hidden needle', live(), { fileBytes: 2000 })
	assert.deepEqual([clipped.hits, clipped.cut], [[], true], 'a file read only in part is a cut search')
	assert.equal((await s.searchSessions([{ key: 'p', sessions: [far] }], w.fileOf, 'hidden needle', live(), { fileBytes: 20000 })).cut, false)
	assert.equal((await s.searchSessions([{ key: 'p', sessions: [far] }], w.fileOf, 'hidden needle', live())).hits.length, 1)
})

test('the time budget ends the search with what it has, flagged as more', async () => {
	const w = world()
	// Far more rounds of reading than a millisecond holds.
	const list = Array.from({ length: 300 }, (_, i) => w.add('claude', user('late match'), i))
	const r = await s.searchSessions([{ key: 'p', sessions: list }], w.fileOf, 'late match', live(), { ms: 1, hits: 1000 })
	assert.equal(r.more, true)
	assert.equal(r.cut, true)
	assert.ok(r.hits.length < 300, String(r.hits.length))
})

test('a newer query cancels: an aborted search returns nothing, before or while it runs', async () => {
	const w = world()
	const list = Array.from({ length: 30 }, (_, i) => w.add('claude', user('needle ' + i), i))
	const gone = new AbortController()
	gone.abort()
	assert.deepEqual(await s.searchSessions([{ key: 'p', sessions: list }], w.fileOf, 'needle', gone.signal), { hits: [], more: false, cut: false })
	const mid = new AbortController()
	const running = s.searchSessions([{ key: 'p', sessions: list }], w.fileOf, 'needle', mid.signal)
	mid.abort()
	assert.deepEqual((await running).hits, [])
})

test('a missing file, an unknown session and a garbled line never throw', async () => {
	const w = world()
	const garbled = w.add('claude', '{"type":"user","message":\nnot json at all\n' + user('still found'))
	const ghost = { id: randomUUID(), kind: 'claude', title: 'ghost', modified: 5 }
	const r = await s.searchSessions([{ key: 'p', sessions: [ghost, garbled, { id: 'unknown', kind: 'codex', title: 'u', modified: 1 }] }], w.fileOf, 'still found', live())
	assert.deepEqual(r.hits.map(h => h.session), [garbled.id])
})

test('the index remembers each listed session\'s transcript for the search, and only the host can ask for it', async () => {
	const home = join(tmp, 'm' + n++)
	process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
	process.env.CODEX_HOME = join(home, 'codex')
	const folder = join(home, 'work', 'app')
	mkdirSync(folder, { recursive: true })
	mkdirSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'x'), { recursive: true })
	const id = randomUUID()
	const file = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'x', id + '.jsonl')
	writeFileSync(file, fixture('claude-search.jsonl', { '@APP@': folder }))
	const projects = await s.scan()
	assert.equal(s.transcriptFile('claude', id), file)
	assert.equal(s.transcriptFile('codex', id), undefined)
	assert.equal(JSON.stringify(projects).includes(file), false, 'the file path is not part of what the page is sent')
	const r = await s.searchSessions(projects, s.transcriptFile, 'marmot', live())
	assert.equal(r.hits[0].session, id)
})
