// The Claude Code sessions that run on this machine (src/liveSessions.ts): the registry files are untrusted input, so every field is checked;
// dead pids drop out; the status, kind and entrypoint values of real files map to the page's states; and the merge into the sidebar's projects
// marks sessions that run outside this window without listing this window's own again.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let m
let tmp
let n = 0
before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-live-')))
	const outfile = join(tmp, 'liveSessions.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'liveSessions.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

/** The fields of a real file on this machine (a Claude Code CLI session); `extra` are other keys real files carry, which must never matter. */
const entry = (pid, over = {}) => ({
	pid, sessionId: randomUUID(), cwd: join(tmp, 'proj'), startedAt: 1794616475652, procStart: 'Sat Nov 14 00:34:24 2026', version: '2.1.325',
	kind: 'interactive', entrypoint: 'cli', name: 'tag-app-ae', status: 'idle', updatedAt: 1794616582587, statusUpdatedAt: 1794616582587,
	peerToken: 'SECRET-TOKEN', messagingSocketPath: '/tmp/secret.sock', ...over,
})
/** A sessions folder with these files (name -> object or raw text); every pid is alive unless it is in `dead`. */
function folder(files, dead = []) {
	const dir = join(tmp, 's' + n++)
	mkdirSync(dir, { recursive: true })
	for (const [name, v] of Object.entries(files)) writeFileSync(join(dir, name), typeof v === 'string' ? v : JSON.stringify(v))
	const io = { ...m.nodeIo, isAlive: pid => !dead.includes(pid) }
	return { dir, io }
}
const list = async (files, dead) => { const f = folder(files, dead); return m.listLive(f.io, f.dir) }

test('the values real files carry map to the page\'s states: busy works, idle is done, waiting needs you, anything else is unknown', T, () => {
	assert.deepEqual(['busy', 'idle', 'waiting', 'thinking', undefined, 7, null].map(m.statusOf), ['working', 'idle', 'needs', 'unknown', 'unknown', 'unknown', 'unknown'])
	assert.equal(m.sourceOf('cli', 'interactive'), 'Claude Code CLI')
	assert.equal(m.sourceOf('claude-desktop', 'interactive'), 'Claude desktop')
	assert.equal(m.sourceOf('sdk-ts', 'interactive'), 'Claude Code (sdk-ts)')
	assert.equal(m.sourceOf(undefined, undefined), 'Claude Code')
	assert.equal(m.sourceOf('cli', 'daemon'), 'Claude Code CLI, daemon')
	assert.equal(m.sourceOf('<script>alert(1)</script>', 'a b'), 'Claude Code', 'a value that is not a plain word is not echoed')
})

test('a running session is listed with the fields the page needs and nothing else (no token, socket or key)', T, async () => {
	const e = entry(4321, { entrypoint: 'claude-desktop', status: 'busy' })
	const [s] = await list({ '4321.json': e, ['4321.' + 'a'.repeat(64) + '.key']: 'KEYMATERIAL' })
	assert.deepEqual(s, { id: e.sessionId, cwd: e.cwd, pid: 4321, status: 'working', source: 'Claude desktop', name: 'tag-app-ae', startedAt: e.startedAt, updatedAt: e.statusUpdatedAt })
	assert.doesNotMatch(JSON.stringify(s), /SECRET|KEYMATERIAL|socket/)
})

test('sessions whose process is gone are dropped; one that exists but is another user\'s does not count (EPERM): the registry is this user\'s own', T, async () => {
	const a = entry(11), b = entry(12)
	assert.deepEqual((await list({ '11.json': a, '12.json': b }, [12])).map(s => s.pid), [11])
	const kill = process.kill
	try {
		process.kill = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }) }
		assert.equal(m.nodeIo.isAlive(1), false)
		process.kill = () => { throw Object.assign(new Error('x'), { code: 'ESRCH' }) }
		assert.equal(m.nodeIo.isAlive(1), false)
	} finally {
		process.kill = kill
	}
	assert.equal(m.nodeIo.isAlive(process.pid), true)
})

test('garbled, mistyped, oversized, linked and mis-named files are skipped; the good one beside them is listed', T, async () => {
	const good = entry(100)
	const dir = folder({
		'100.json': good,
		'101.json': '{not json',
		'102.json': entry(102, { sessionId: 'not-a-uuid' }),
		'103.json': entry(103, { cwd: 'relative/path' }),
		'104.json': entry(104, { pid: '104' }),
		'105.json': entry(999),                      // the pid in the file is not the file's own
		'106.json': entry(106, { cwd: '/a\0b' }),
		'107.json': '[1,2]',
		'108.json': JSON.stringify(entry(108, { name: 'x'.repeat(100_000) })),
		'notes.json': entry(109),
		'110.json.bak': entry(110),
	})
	symlinkSync(join(dir.dir, '100.json'), join(dir.dir, '111.json'))
	mkdirSync(join(dir.dir, '112.json'))
	assert.deepEqual((await m.listLive(dir.io, dir.dir)).map(s => s.pid), [100])
	assert.deepEqual(await m.listLive(dir.io, join(tmp, 'no-such-folder')), [])
})

test('field types are checked: a name is shortened and stripped of control characters, a time that is no number is left out', T, async () => {
	const [s] = await list({ '5.json': entry(5, { name: 'a\u0007b\nc' + 'z'.repeat(300), startedAt: 'yesterday', statusUpdatedAt: -1, updatedAt: 42, status: { x: 1 } }) })
	assert.equal(s.name.length <= 120, true)
	assert.match(s.name, /^a b c/)
	assert.equal(s.startedAt, undefined)
	assert.equal(s.updatedAt, 42)
	assert.equal(s.status, 'unknown')
})

test('at most 200 sessions are returned, and one session id listed twice is the newer file\'s', T, async () => {
	const files = {}
	for (let pid = 1; pid <= 230; pid++) files[pid + '.json'] = entry(pid)
	assert.equal((await list(files)).length, 200)
	const id = randomUUID()
	const two = await list({ '7.json': entry(7, { sessionId: id, statusUpdatedAt: 10 }), '8.json': entry(8, { sessionId: id, statusUpdatedAt: 20 }) })
	assert.deepEqual(two.map(s => s.pid), [8])
})

test('stale files with higher pids do not hide a live session: the cap is on what is returned, after liveness is known', T, async () => {
	const files = {}
	const dead = []
	for (let pid = 1; pid <= 230; pid++) { files[pid + '.json'] = entry(pid); if (pid > 3) dead.push(pid) }
	assert.deepEqual((await list(files, dead)).map(s => s.pid).sort((a, b) => a - b), [1, 2, 3])
	// The resume check looks one id up without the cap on what a page is shown.
	const f = folder(files, dead.filter(p => p > 100))
	const lowest = JSON.parse(JSON.stringify(files['4.json']))
	const found = await m.runningElsewhere([lowest.sessionId.toUpperCase(), undefined], f.io, f.dir)
	assert.equal(found?.pid, 4)
	assert.equal(await m.runningElsewhere(['not-running', undefined], f.io, f.dir), undefined)
})

test('a dead pid costs no file read: the name says the pid, so it is checked first', T, async () => {
	const f = folder({ '21.json': entry(21), '22.json': entry(22) }, [22])
	const read = []
	const io = { ...f.io, read: async (file, max) => { read.push(file); return f.io.read(file, max) } }
	assert.deepEqual((await m.listLive(io, f.dir)).map(s => s.pid), [21])
	assert.deepEqual(read.map(x => x.slice(-7)), ['21.json'])
})

test('a registry file that hangs does not hold the list up: at the time budget the sessions read so far are returned', T, async () => {
	const f = folder({ '31.json': entry(31), '32.json': entry(32) })
	const io = { ...f.io, read: (file, max) => file.endsWith('32.json') ? new Promise(() => undefined) : f.io.read(file, max) }
	const t0 = Date.now()
	assert.deepEqual((await m.listLive(io, f.dir, { budgetMs: 200 })).map(s => s.pid), [31])
	assert.equal(Date.now() - t0 < 2000, true)
	const hangs = { ...f.io, readdir: () => new Promise(() => undefined) }
	assert.deepEqual(await m.listLive(hangs, f.dir, { budgetMs: 100 }), [])
})

test('a FIFO swapped in after the directory listing is not waited for: reading it fails at once', { timeout: 5000, skip: process.platform === 'win32' && 'no FIFOs' }, async () => {
	const dir = join(tmp, 'fifo' + n++)
	mkdirSync(dir)
	const fifo = join(dir, '41.json')
	execFileSync('mkfifo', [fifo])
	const outcome = await Promise.race([m.nodeIo.read(fifo, 1000).then(() => 'read', () => 'refused'), new Promise(r => setTimeout(() => r('blocked'), 1500))])
	try { openSync(fifo, 'r+') } catch { /* nothing waits */ }
	assert.equal(outcome, 'refused')
})

test('a file that carries neither time takes its modification time: the same on every look, so the page is not sent the index again', T, async () => {
	const f = folder({ '51.json': entry(51, { startedAt: undefined, statusUpdatedAt: undefined, updatedAt: undefined }) })
	const [a] = await m.listLive(f.io, f.dir)
	const [b] = await m.listLive(f.io, f.dir)
	assert.equal(typeof a.updatedAt, 'number')
	assert.equal(a.updatedAt, b.updatedAt)
})

// ---- the merge into the sidebar's projects --------------------------------------------------------------------------------------

const live = (over = {}) => ({ id: randomUUID(), cwd: join(tmp, 'proj'), pid: 1, status: 'working', source: 'Claude desktop', name: 'Fix login', updatedAt: 5000, ...over })
const project = (name, own, sessions) => ({ key: 'k' + name, name, where: '~/' + name, cwd: join(tmp, name), own, sessions })
const sess = (id, kind, modified, title = 't' + id) => ({ id, kind, title, modified })
const opts = (skip = [], now = 1_000_000) => ({ skip: new Set(skip), realOf: c => c, describe: cwd => ({ key: 'new:' + cwd, name: cwd.split('/').pop(), where: cwd }), now })

test('a live session in an indexed project is marked and moves to the top; the input is not changed', T, () => {
	const a = live({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', source: 'Claude Code CLI', status: 'needs' })
	const input = [project('own', true, []), project('proj', false, [sess('11111111-1111-4111-8111-111111111111', 'claude', 900), sess(a.id, 'claude', 100, 'Old title')])]
	const before = JSON.stringify(input)
	const { projects, files } = m.mergeLive(input, [a], opts())
	assert.equal(JSON.stringify(input), before)
	assert.deepEqual(projects[1].sessions.map(s => s.id), [a.id, '11111111-1111-4111-8111-111111111111'])
	assert.deepEqual(projects[1].sessions[0], { id: a.id, kind: 'claude', title: 'Old title', modified: 100, live: { status: 'needs', source: 'Claude Code CLI', basis: 'live' } })
	assert.equal(projects[1].sessions[1].live, undefined)
	assert.equal(files.get(a.id), join(process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || '', '.claude'), 'projects', join(tmp, 'proj').replace(/[^a-zA-Z0-9]/g, '-'), a.id + '.jsonl'))
})

test('a live session no project lists yet is added to its folder\'s project, or gets a project of its own named by the folder; projects with one come first after this window\'s', T, () => {
	const inOwn = live({ cwd: join(tmp, 'own'), name: '' })
	const alone = live({ cwd: join(tmp, 'brand-new'), name: 'Spike' })
	const { projects } = m.mergeLive([project('own', true, []), project('quiet', false, [sess('22222222-2222-4222-8222-222222222222', 'claude', 1)]), project('proj', false, [])], [inOwn, alone], opts())
	assert.deepEqual(projects.map(p => p.name), ['own', 'brand-new', 'quiet', 'proj'])
	assert.deepEqual(projects[0].sessions.map(s => [s.id, s.title, s.live.source]), [[inOwn.id, 'Untitled session', 'Claude desktop']])
	assert.deepEqual(projects[1].sessions.map(s => [s.title, s.modified]), [['Spike', 5000]])
	assert.equal(projects[1].key, 'new:' + join(tmp, 'brand-new'))
	assert.equal(projects[1].own, false)
})

test('this window\'s sessions and the other Insilode windows\' are not marked, and a folder is matched by its real path', T, () => {
	const mine = live(), theirs = live(), other = live({ cwd: '/link/proj' })
	const o = { ...opts([mine.id, theirs.id]), realOf: c => c === '/link/proj' ? join(tmp, 'proj') : c }
	const { projects, files } = m.mergeLive([project('proj', false, [])], [mine, theirs, other], o)
	assert.deepEqual(projects[0].sessions.map(s => s.id), [other.id], 'two spellings of one folder are one project')
	assert.equal(projects.length, 1)
	assert.deepEqual([...files.keys()], [other.id])
})

test('a Codex session is "recently active" for two minutes after its rollout changed, as an estimate; not before and not after', T, () => {
	const now = 10_000_000
	const c = (id, ago) => sess(id, 'codex', now - ago)
	const { projects } = m.mergeLive([project('proj', false, [c('c1', 5_000), c('c2', 119_000), c('c3', 121_000), c('c4', 3_600_000), sess('c1', 'claude', now - 1000)])], [], opts([], now))
	const byId = Object.fromEntries(projects[0].sessions.filter(s => s.kind === 'codex').map(s => [s.id, s.live]))
	assert.deepEqual(byId.c1, { status: 'unknown', source: 'Codex', basis: 'recent' })
	assert.deepEqual(byId.c2, { status: 'unknown', source: 'Codex', basis: 'recent' })
	assert.equal(byId.c3, undefined)
	assert.equal(byId.c4, undefined)
	assert.equal(projects[0].sessions.find(s => s.kind === 'claude').live, undefined, 'a Claude session is only live when a process says so')
	assert.deepEqual(projects[0].sessions.slice(0, 2).map(s => s.id), ['c1', 'c2'])
	const skipped = m.mergeLive([project('proj', false, [c('c1', 5_000)])], [], opts(['c1'], now))
	assert.equal(skipped.projects[0].sessions[0].live, undefined, 'this window\'s Codex session is an agent, not "recent"')
})
