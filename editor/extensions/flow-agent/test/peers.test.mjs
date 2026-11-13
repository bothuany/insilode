// What the Agents windows share through files is read from files another process could have written: every snapshot and request is
// checked here (src/peersCore.ts) before anything draws or acts on it. Real files in a temp folder, no editor.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rename as renameAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let p
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-peers-'))
	const outfile = join(tmp, 'peersCore.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'peersCore.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	p = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const folder = () => resolve(tmp, 'project-a')
const row = (over = {}) => ({ id: 'a1', cli: 'claude', name: 'Claude', state: 'working', since: 1, todos: [], flows: 0, ...over })
const snap = (over = {}) => ({ folder: folder(), name: 'project-a', pid: process.pid, updatedAt: 1, rows: [row()], ...over })
const key = () => p.folderKey(folder())

test('a well-formed snapshot is accepted and rebuilt field by field', () => {
	const s = p.parseSnapshot(snap({ rows: [row({ evil: '<img>', todos: [{ text: 'a', status: 'completed', extra: 1 }], pr: { number: 3, state: 'open', title: 't', url: 'javascript:1' } })] }), key())
	assert.equal(s.rows.length, 1)
	assert.equal(s.rows[0].evil, undefined)
	assert.deepEqual(s.rows[0].todos, [{ text: 'a', status: 'completed' }])
	assert.deepEqual(s.rows[0].pr, { number: 3, state: 'open', title: 't' })
})

test('malformed, oversized and wrongly typed snapshots are rejected', () => {
	const k = key()
	assert.equal(p.parseSnapshot(null, k), undefined)
	assert.equal(p.parseSnapshot('rows', k), undefined)
	assert.equal(p.parseSnapshot([], k), undefined)
	assert.equal(p.parseSnapshot(snap({ rows: 'x' }), k), undefined)
	assert.equal(p.parseSnapshot(snap({ pid: '1' }), k), undefined)
	assert.equal(p.parseSnapshot(snap({ pid: 0 }), k), undefined)
	assert.equal(p.parseSnapshot(snap({ pid: 1.5 }), k), undefined)
	assert.equal(p.parseSnapshot(snap({ updatedAt: NaN }), k), undefined)
	assert.equal(p.parseSnapshot(snap({ name: 'x'.repeat(201) }), k), undefined)
	assert.equal(p.parseSnapshot(snap({ folder: 'relative/path' }), k), undefined)
	assert.equal(p.parseSnapshot(snap({ rows: Array.from({ length: p.MAX_ROWS + 1 }, (_, i) => row({ id: 'r' + i })) }), k), undefined)
	for (const bad of [{ id: 5 }, { id: '' }, { cli: 'vim' }, { state: 'exploding' }, { since: 'now' }, { name: 'n'.repeat(201) }, { activity: 'a'.repeat(p.MAX_TEXT + 1) }, { activity: 7 },
		{ attention: 'panic' }, { todos: 'none' }, { todos: [{ text: 'x', status: 'later' }] }, { todos: Array.from({ length: p.MAX_TODOS + 1 }, () => ({ text: 'x', status: 'pending' })) },
		{ pr: { number: 'x', state: 'open', title: 't' } }, { pr: { number: 1, state: 'weird', title: 't' } }, { tokens: 'many' }, { flows: undefined }]) {
		assert.equal(p.parseSnapshot(snap({ rows: [row(bad)] }), k), undefined, JSON.stringify(bad))
	}
	// One bad row in a hundred poisons the file.
	assert.equal(p.parseSnapshot(snap({ rows: [row(), row({ id: 'b', state: 'nope' })] }), k), undefined)
})

test('a snapshot must name the folder whose storage it sits in', () => {
	assert.equal(p.parseSnapshot(snap(), p.folderKey(resolve(tmp, 'other'))), undefined)
	assert.equal(p.parseSnapshot(snap({ folder: '' }), 'empty-0123456789ab').rows.length, 1)
	assert.equal(p.parseSnapshot(snap(), 'empty-0123456789ab'), undefined)
})

test('published rows are slimmed: no transcript, pid, path or token reaches the file', () => {
	const slim = p.slimRow({ ...row(), transcript: '/home/me/t.jsonl', pid: 99, cwd: '/home/me', token: 'secret', need: { kind: 'approval', source: 'permission', text: 'Run ls', at: 1 }, usage: { used: 50, size: 100 }, cost: { session: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, usd: 0.5 }, scope: 's' }, impact: { files: 1, more: 0, flows: [{ label: 'GET /' }] } })
	const text = JSON.stringify(slim)
	for (const leak of ['transcript', 'secret', '/home/me', '"pid"']) {
		assert.ok(!text.includes(leak), leak)
	}
	assert.equal(slim.need, 'Run ls')
	assert.equal(slim.tokens, 10)
	assert.equal(slim.contextPercent, 50)
	assert.equal(slim.flows, 1)
	assert.ok(p.parseRow(JSON.parse(text)), 'what is published is what is accepted')
})

function storage() {
	const root = mkdtempSync(join(tmp, 'agents-'))
	const dir = k => { mkdirSync(join(root, k), { recursive: true }); return join(root, k) }
	return { root, dir }
}
const ownKey = 'aaaaaaaaaaaa'

test('a snapshot whose process is gone is not shown; a live one is', async () => {
	const { root, dir } = storage()
	writeFileSync(join(dir(key()), 'rows.json'), JSON.stringify(snap({ pid: 4242 })))
	const alive = await p.readProjects(root, ownKey, pid => pid === 4242)
	assert.equal(alive.peers.length, 1)
	assert.equal(alive.peers[0].key, key())
	assert.equal(alive.peers[0].rows[0].name, 'Claude')
	const dead = await p.readProjects(root, ownKey, () => false)
	assert.equal(dead.peers.length, 0)
	assert.equal(p.pidAlive(process.pid), true)
	assert.equal(p.pidAlive(2 ** 22 + 12345), false)
})

test('this window is skipped, and an oversized or garbled file is ignored', async () => {
	const { root, dir } = storage()
	writeFileSync(join(dir(key()), 'rows.json'), JSON.stringify(snap()))
	assert.equal((await p.readProjects(root, key(), () => true)).peers.length, 0, 'own folder')
	const other = p.folderKey(resolve(tmp, 'b'))
	writeFileSync(join(dir(other), 'rows.json'), '{not json')
	writeFileSync(join(dir('cccccccccccc'), 'rows.json'), 'x'.repeat(p.MAX_FILE_BYTES + 1))
	mkdirSync(join(root, 'not-a-key'))
	writeFileSync(join(root, 'not-a-key', 'rows.json'), JSON.stringify(snap()))
	const found = (await p.readProjects(root, ownKey, () => true)).peers
	assert.deepEqual(found.map(x => x.key), [key()], 'only the valid snapshot of a real key folder')
})

test('a closed project with a project.json and sessions is listed as recent; one without is not', async () => {
	const { root, dir } = storage()
	const d = dir(key())
	mkdirSync(folder(), { recursive: true })
	writeFileSync(join(d, 'project.json'), JSON.stringify({ folder: folder(), name: 'project-a' }))
	writeFileSync(join(d, 'sessions.json'), JSON.stringify({ token: 'secret', sessions: [{ id: '1', name: 'Fix login', transcript: '/x' }, { id: '2' }, { name: 5 }] }))
	const r = await p.readProjects(root, ownKey, () => true)
	assert.equal(r.recent.length, 1)
	assert.deepEqual(r.recent[0], { key: key(), name: 'project-a', folder: folder(), sessions: ['Fix login'] })
	// A project.json claiming another folder than the one it sits in is not believed.
	const liar = dir(p.folderKey(resolve(tmp, 'c')))
	writeFileSync(join(liar, 'project.json'), JSON.stringify({ folder: folder(), name: 'x' }))
	writeFileSync(join(liar, 'sessions.json'), JSON.stringify({ sessions: [{ name: 'a' }] }))
	assert.equal((await p.readProjects(root, ownKey, () => true)).recent.length, 1)
	// No sessions, nothing to list.
	writeFileSync(join(d, 'sessions.json'), JSON.stringify({ sessions: [] }))
	assert.equal((await p.readProjects(root, ownKey, () => true)).recent.length, 0)
})

test('a request is a reveal or a flow for a known session: anything else is dropped, and every file is deleted', async () => {
	const { dir } = storage()
	const d = dir(ownKey)
	const has = id => id === 'mine'
	await p.writeRequest(d, { type: 'reveal', id: 'mine' })
	await p.writeRequest(d, { type: 'flow', id: 'mine' })
	await p.writeRequest(d, { type: 'reveal', id: 'foreign' })
	await p.writeRequest(d, { type: 'forget', id: 'mine' })
	const raw = (name, v) => writeFileSync(join(d, name), typeof v === 'string' ? v : JSON.stringify(v))
	raw('request-0000000000000001.json', '{broken')
	raw('request-0000000000000002.json', { type: 'reveal', id: 'mine', at: Date.now() - p.REQUEST_TTL_MS - 1000 })
	raw('request-0000000000000003.json', { type: 'reveal', id: 'm'.repeat(5000), at: Date.now() })
	raw('request-0000000000000004.json', { type: 'reveal', id: 'mine', at: Date.now(), pad: 'x'.repeat(2000) })
	raw('request-zzzz.json', { type: 'reveal', id: 'mine', at: Date.now() })
	const got = await p.takeRequests(d, has)
	assert.deepEqual(got.map(r => r.type).sort(), ['flow', 'reveal'])
	assert.ok(got.every(r => r.id === 'mine'))
	assert.deepEqual(readdirSync(d).filter(n => n !== 'request-zzzz.json'), [], 'each request file is deleted once read')
	assert.deepEqual(await p.takeRequests(d, has), [])
})

test('the display name comes from the folder, never from the file; a UNC folder is refused', () => {
	assert.equal(p.parseSnapshot(snap({ name: 'my-app' }), key()).name, 'project-a')
	assert.equal(p.parseProject({ folder: folder(), name: 'my-app' }, key()).name, 'project-a')
	for (const unc of ['\\\\host\\share\\x', '//host/share/x']) {
		assert.equal(p.parseSnapshot(snap({ folder: unc }), p.folderKey(unc)), undefined, unc)
		assert.equal(p.parseProject({ folder: unc, name: 'x' }, p.folderKey(unc)), undefined, unc)
	}
})

test('a closed project whose folder is gone is not listed', async () => {
	const { root, dir } = storage()
	const gone = resolve(tmp, 'removed-project')
	const d = dir(p.folderKey(gone))
	writeFileSync(join(d, 'project.json'), JSON.stringify({ folder: gone, name: 'removed-project' }))
	writeFileSync(join(d, 'sessions.json'), JSON.stringify({ sessions: [{ name: 'a' }] }))
	assert.equal((await p.readProjects(root, ownKey, () => true)).recent.length, 0)
	mkdirSync(gone)
	assert.equal((await p.readProjects(root, ownKey, () => true)).recent.length, 1)
})

test('only the first 120 characters of a prompt are published', () => {
	assert.equal(p.slimRow(row({ prompt: 'x'.repeat(500) })).prompt.length, 120)
})

test('a rows.json whose process is gone is deleted; a live one stays', async () => {
	const { root, dir } = storage()
	const file = join(dir(key()), 'rows.json')
	writeFileSync(file, JSON.stringify(snap({ pid: 4242 })))
	await p.readProjects(root, ownKey, () => true)
	assert.ok(existsSync(file))
	await p.readProjects(root, ownKey, () => false)
	assert.ok(!existsSync(file))
})

test('a failed rename is retried; after the last try the error is let through and no temp file stays', async () => {
	const { dir } = storage()
	const d = dir(ownKey)
	let calls = 0
	const flaky = n => async (from, to) => {
		calls++
		if (calls <= n) {
			throw Object.assign(new Error('busy'), { code: 'EPERM' })
		}
		return renameAsync(from, to)
	}
	await p.writeJson(join(d, 'rows.json'), { a: 1 }, flaky(2), 1)
	assert.equal(calls, 3)
	assert.deepEqual(readdirSync(d), ['rows.json'])
	calls = 0
	await assert.rejects(p.writeJson(join(d, 'other.json'), { a: 1 }, flaky(99), 1), /busy/)
	assert.deepEqual(readdirSync(d), ['rows.json'], 'the temp file is removed')
	// A request is retried the same way, so a click is not lost.
	calls = 0
	await p.writeRequest(d, { type: 'reveal', id: 'mine' }, flaky(1))
	assert.equal((await p.takeRequests(d, id => id === 'mine')).length, 1)
})

test('the own file is rewritten when it is missing or left by a dead process, not when it is ours or another live window\'s', async () => {
	const { dir } = storage()
	const file = join(dir(ownKey), 'rows.json')
	assert.equal(await p.needsRepublish(file), true, 'missing')
	writeFileSync(file, JSON.stringify({ pid: process.pid }))
	assert.equal(await p.needsRepublish(file), false)
	writeFileSync(file, JSON.stringify({ pid: 4242 }))
	assert.equal(await p.needsRepublish(file, process.pid, () => true), false, 'another live window on the same folder')
	assert.equal(await p.needsRepublish(file, process.pid, () => false), true, 'a dead one')
	writeFileSync(file, '{garbled')
	assert.equal(await p.needsRepublish(file), true)
})
