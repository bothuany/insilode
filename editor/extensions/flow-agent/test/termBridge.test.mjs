// The bridge between an agent's terminal and the Agents page (src/termBridge.ts) with the vscode pieces injected: replay and live
// output, batching, several attachments, input, and the size that is given and taken back.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
const sleep = ms => new Promise(r => setTimeout(r, ms))
let m
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-termbridge-'))
	const outfile = join(tmp, 'termBridge.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'termBridge.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

/** A bridge over fake terminals: `s1` has process 100, `s2` has 200, `s3` has a process that never starts; `gone` has no terminal. */
function setup() {
	const typed = []
	const dims = []
	const pids = { s1: 100, s2: 200, s3: undefined }
	const ended = new Set()
	let delay = {}
	const env = {
		terminalOf: id => id in pids ? { processId: (async () => { await sleep(delay[id] ?? 0); return pids[id] })(), sendText: (t, exec) => typed.push([id, t, exec]) } : undefined,
		typable: id => !ended.has(id),
		setDimensions: async (pid, cols, rows) => { dims.push([pid, cols, rows]); return true },
	}
	const bridge = new m.TermBridge(env)
	const sink = () => { const got = []; return { got, data: (d, reset) => got.push(reset ? ['reset', d] : d), gone: () => got.push('gone') } }
	return { bridge, typed, dims, ended, pids, sink, slow: (id, ms) => { delay[id] = ms } }
}

test('attach replays what the terminal printed, then streams the rest to the sink', T, async () => {
	const t = setup()
	t.bridge.write('s1', 'one ')
	t.bridge.write('s1', 'two ')
	const sink = t.sink()
	const a = t.bridge.attach('s1', sink)
	assert.equal(a.replay, 'one two ')
	t.bridge.write('s1', 'three')
	await sleep(40)
	assert.deepEqual(sink.got, ['three'])
})

test('attach to a session with no terminal is nothing, and so is every other call', T, async () => {
	const t = setup()
	assert.equal(t.bridge.attach('gone', t.sink()), undefined)
	assert.equal(t.bridge.input('gone', 'x'), false)
	assert.equal(await t.bridge.resize('gone', 80, 24), false)
	assert.deepEqual(t.typed, [])
	assert.deepEqual(t.dims, [])
})

test('live output is batched: a burst is one chunk, at most every 16 ms, or at once at 64 KB', T, async () => {
	const t = setup()
	const sink = t.sink()
	t.bridge.attach('s1', sink)
	for (const c of ['a', 'b', 'c', 'd']) {
		t.bridge.write('s1', c)
	}
	assert.deepEqual(sink.got, [], 'nothing before the timer')
	await sleep(60)
	assert.deepEqual(sink.got, ['abcd'])
	sink.got.length = 0
	const big = 'x'.repeat(m.FLUSH_BYTES)
	t.bridge.write('s1', big)
	assert.deepEqual(sink.got, [big], 'a full batch goes out at once')
	t.bridge.write('s1', 'y')
	await sleep(60)
	assert.deepEqual(sink.got, [big, 'y'])
})

test('a pane that attaches mid-batch gets the waiting output once, in the replay, and the first pane gets it too', T, async () => {
	const t = setup()
	const first = t.sink()
	t.bridge.attach('s1', first)
	t.bridge.write('s1', 'waiting')
	const second = t.sink()
	const a = t.bridge.attach('s1', second)
	assert.equal(a.replay, 'waiting')
	assert.deepEqual(first.got, ['waiting'])
	t.bridge.write('s1', '!')
	await sleep(60)
	assert.deepEqual(first.got, ['waiting', '!'])
	assert.deepEqual(second.got, ['!'])
})

test('output is kept for the replay when nobody is attached, and an output never reaches another session', T, async () => {
	const t = setup()
	t.bridge.write('s1', 'before')
	t.bridge.write('s2', 'other')
	const sink = t.sink()
	assert.equal(t.bridge.attach('s1', sink).replay, 'before')
	t.bridge.write('s2', 'LEAK')
	await sleep(40)
	assert.deepEqual(sink.got, [])
})

test('a detached sink gets nothing more, and detaching twice does no harm', T, async () => {
	const t = setup()
	const one = t.sink()
	const two = t.sink()
	const a = t.bridge.attach('s1', one)
	t.bridge.attach('s1', two)
	a.detach()
	a.detach()
	t.bridge.write('s1', 'x')
	await sleep(40)
	assert.deepEqual(one.got, [])
	assert.deepEqual(two.got, ['x'])
	assert.deepEqual(t.dims, [], 'a pane is still attached: the size stays')
})

test('input is typed as keys without Enter, and refused for a session that ended or for nothing', T, () => {
	const t = setup()
	assert.equal(t.bridge.input('s1', '\x1b[A'), true)
	assert.deepEqual(t.typed, [['s1', '\x1b[A', false]])
	assert.equal(t.bridge.input('s1', ''), false)
	t.ended.add('s1')
	assert.equal(t.bridge.input('s1', 'rm -rf /\r'), false)
	assert.equal(t.typed.length, 1)
})

test('a resize runs the core command with the terminal\'s process id; the last one wins; the last pane to leave gives the size back', T, async () => {
	const t = setup()
	const a = t.bridge.attach('s1', t.sink())
	const b = t.bridge.attach('s1', t.sink())
	assert.equal(await t.bridge.resize('s1', 100, 30), true)
	assert.equal(await t.bridge.resize('s1', 120, 40), true)
	assert.deepEqual(t.dims, [[100, 100, 30], [100, 120, 40]])
	a.detach()
	await sleep(10)
	assert.equal(t.dims.length, 2, 'one pane is left')
	b.detach()
	await sleep(10)
	assert.deepEqual(t.dims.at(-1), [100, undefined, undefined])
	// Nothing attached: a late resize from a closed pane changes nothing.
	assert.equal(await t.bridge.resize('s1', 90, 20), false)
	assert.equal(t.dims.length, 3)
})

test('a resize out of range, or for a session with no process yet, is refused', T, async () => {
	const t = setup()
	t.bridge.attach('s1', t.sink())
	t.bridge.attach('s3', t.sink())
	for (const [c, r] of [[1, 24], [501, 24], [80, 0], [80, 301], [80.5, 24], [NaN, 24], ['80', 24], [80, undefined]]) {
		assert.equal(await t.bridge.resize('s1', c, r), false, `${c}x${r}`)
	}
	assert.equal(await t.bridge.resize('s3', 80, 24), false)
	assert.deepEqual(t.dims, [])
	assert.equal(await t.bridge.resize('s1', 2, 1), true)
	assert.equal(await t.bridge.resize('s1', 500, 300), true)
})

test('a resize whose process id arrives after a newer one is dropped', T, async () => {
	const t = setup()
	t.bridge.attach('s1', t.sink())
	t.slow('s1', 40)
	const older = t.bridge.resize('s1', 100, 30)
	t.slow('s1', 0)
	const newer = t.bridge.resize('s1', 120, 40)
	assert.equal(await newer, true)
	assert.equal(await older, false)
	assert.deepEqual(t.dims, [[100, 120, 40]])
})

test('end frees the output, tells every attachment, and a later detach asks nothing of the closed terminal', T, async () => {
	const t = setup()
	const one = t.sink()
	const two = t.sink()
	const a = t.bridge.attach('s1', one)
	t.bridge.attach('s1', two)
	t.bridge.write('s1', 'pending')
	t.bridge.end('s1')
	assert.deepEqual(one.got, ['gone'])
	assert.deepEqual(two.got, ['gone'])
	a.detach()
	await sleep(40)
	assert.deepEqual(t.dims, [])
	assert.deepEqual(one.got, ['gone'], 'the waiting output was dropped, not sent after the end')
	assert.equal(t.bridge.attach('s1', t.sink()).replay, '', 'the buffer is gone')
})

test('restart empties the replay and tells the panes to clear', T, async () => {
	const t = setup()
	const sink = t.sink()
	t.bridge.write('s1', 'old')
	t.bridge.attach('s1', sink)
	t.bridge.restart('s1')
	t.bridge.write('s1', 'new')
	await sleep(40)
	assert.deepEqual(sink.got, [['reset', ''], 'new'])
	assert.equal(t.bridge.attach('s1', t.sink()).replay, 'new')
})

test('a resumed session\'s new terminal gets the pane\'s size, the old one gives it back, and a later detach touches only the new one', T, async () => {
	const t = setup()
	const sink = t.sink()
	const a = t.bridge.attach('s1', sink)
	assert.equal(await t.bridge.resize('s1', 100, 30), true)
	// Agents now answers with the new terminal (process 150); the old one (100) is handed over.
	t.pids.s1 = 150
	t.bridge.restart('s1', { processId: Promise.resolve(100), sendText() {} })
	await sleep(20)
	assert.deepEqual(t.dims.slice(1).sort((x, y) => x[0] - y[0]), [[100, undefined, undefined], [150, 100, 30]])
	a.detach()
	await sleep(20)
	assert.deepEqual(t.dims.at(-1), [150, undefined, undefined], 'the reset goes to the terminal that runs the session now')
	assert.equal(t.dims.length, 4)
})

test('a restart with no pane size to move does not touch either terminal', T, async () => {
	const t = setup()
	t.bridge.attach('s1', t.sink())
	t.bridge.restart('s1', { processId: Promise.resolve(100), sendText() {} })
	await sleep(20)
	assert.deepEqual(t.dims, [])
	// A size that was given back on the last detach is not remembered for the next terminal either.
	const b = t.bridge.attach('s2', t.sink())
	await t.bridge.resize('s2', 90, 20)
	b.detach()
	await sleep(10)
	t.bridge.restart('s2', { processId: Promise.resolve(200), sendText() {} })
	await sleep(20)
	assert.deepEqual(t.dims, [[200, 90, 20], [200, undefined, undefined]])
})
