// The rules around the agents' numbers (src/usage.ts): Insilode's status-line script and its /status forward, when Compact
// may type, stale reports after a session ends, the user's own status line, the limits de-duplication, Codex details.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let u
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-usage-rules-'))
	const outfile = join(tmp, 'usage.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'usage.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	u = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const status = {
	session_id: 'abc',
	model: { id: 'claude-sonnet-5-5[1m]', display_name: 'Sonnet 5.5' },
	context_window: { total_input_tokens: 66_700, context_window_size: 1_000_000 },
	rate_limits: { five_hour: { used_percentage: 32.4, resets_at: 1_760_000_000 }, seven_day: { used_percentage: 61, resets_at: 1_760_400_000 } },
}

test('the status line text: only what Claude told', () => {
	assert.equal(u.statusText(status), 'Sonnet 5.5 · ctx 7% · 5h 32% · wk 61%')
	assert.equal(u.statusText({ model: { id: 'claude-x' }, context_window: { total_input_tokens: 66_700 } }), 'claude-x · ctx 66.7k')
	assert.equal(u.statusText({}), '')
	assert.equal(u.statusText(null), '')
})

test('the status-line script prints its line and forwards to /status only when the numbers changed', async () => {
	const dir = mkdtempSync(join(tmp, 'status-'))
	const portFile = join(dir, 'hook-port'), tokenFile = join(dir, 'hook-token')
	const script = join(dir, 'flow-status.js')
	writeFileSync(script, u.statusScript(portFile, tokenFile, dir))
	const got = []
	let reply = 200
	const server = http.createServer((req, res) => {
		let b = ''
		req.on('data', d => b += d).on('end', () => {
			got.push({ url: req.url, token: req.headers['x-flow-token'], agent: req.headers['x-flow-agent'], body: b })
			res.statusCode = reply
			res.end('{}')
		})
	})
	await new Promise(r => server.listen(0, '127.0.0.1', r))
	writeFileSync(portFile, String(server.address().port))
	writeFileSync(tokenFile, 'tok')
	const run = payload => new Promise((done, fail) => {
		const p = spawn(process.execPath, [script], { env: { ...process.env, FLOW_AGENT_SESSION: 'agent-1' } })
		let out = ''
		p.stdout.on('data', d => out += d)
		p.on('error', fail).on('exit', () => done(out))
		p.stdin.end(JSON.stringify(payload))
	})
	try {
		assert.equal(await run(status), 'Sonnet 5.5 · ctx 7% · 5h 32% · wk 61%\n')
		assert.equal(got.length, 1)
		assert.deepEqual([got[0].url, got[0].token, got[0].agent], ['/status', 'tok', 'agent-1'])
		assert.equal(JSON.parse(got[0].body).session_id, 'abc')
		await run(status) // the same numbers: printed, not forwarded
		assert.equal(got.length, 1)
		const more = { ...status, context_window: { ...status.context_window, total_input_tokens: 70_000 } }
		reply = 500 // Insilode did not take it: the next run must try again
		await run(more)
		reply = 200
		await run(more)
		await run(more)
		assert.equal(got.length, 3)
		// Nothing listening (the window is gone): the line still prints and the script exits.
		writeFileSync(portFile, '')
		assert.equal(await run({ ...more, context_window: { total_input_tokens: 1 } }), 'Sonnet 5.5 · ctx 1 · 5h 32% · wk 61%\n')
	} finally {
		server.close()
	}
})

test('usage: repeats are no news, an ended session takes nothing, a read from before the end is dropped', () => {
	const s = { state: 'done' }
	assert.equal(u.applyUsage(s, { used: 10, size: 100 }), true)
	assert.equal(u.applyUsage(s, { used: 10 }), false) // the same numbers (the window is kept)
	const epoch = s.usageEpoch ?? 0 // a transcript read starts here
	s.state = 'ended'
	u.endUsage(s)
	assert.equal(s.usage, undefined)
	assert.equal(u.applyUsage(s, { used: 20, size: 100 }), false) // a late status-line refresh
	s.state = 'starting' // resumed
	assert.equal(u.applyUsage(s, { used: 20 }, epoch), false) // the read that began before the end
	assert.equal(u.applyUsage(s, { used: 20 }), true)
	assert.deepEqual(s.usage, { used: 20 })
})

test('a status line of the user\'s own is found in the user settings or in any folder', () => {
	const dir = mkdtempSync(join(tmp, 'sl-'))
	const config = join(dir, 'config'), a = join(dir, 'a'), b = join(dir, 'b')
	for (const d of [config, join(a, '.claude'), join(b, '.claude')]) {
		mkdirSync(d, { recursive: true })
	}
	writeFileSync(join(a, '.claude', 'settings.json'), '{"hooks":{}}')
	assert.equal(u.hasOwnStatusLine(config, [a, b]), false)
	writeFileSync(join(b, '.claude', 'settings.local.json'), '{"statusLine":{"type":"command","command":"x"}}')
	assert.equal(u.hasOwnStatusLine(config, [a, b]), true) // the second folder counts too
	assert.equal(u.hasOwnStatusLine(config, [a]), false)
	writeFileSync(join(config, 'settings.json'), '{"statusLine":{"type":"command","command":"y"}}')
	assert.equal(u.hasOwnStatusLine(config, []), true)
	writeFileSync(join(config, 'settings.json'), '{ not json')
	assert.equal(u.hasOwnStatusLine(config, []), false)
})

test('findOnPath finds a program without starting anything', () => {
	const dir = mkdtempSync(join(tmp, 'path-'))
	writeFileSync(join(dir, 'node.exe'), '')
	writeFileSync(join(dir, 'node'), '', { mode: 0o755 })
	assert.equal(u.findOnPath('node', `/nowhere;${dir}`, 'win32'), join(dir, 'node.exe'))
	// A ':'-separated PATH cannot hold a Windows drive path, so that case runs where paths have no drive letter.
	if (process.platform !== 'win32') {
		assert.equal(u.findOnPath('node', `/nowhere:${dir}`, 'linux'), join(dir, 'node'))
		// A node that is on PATH but not executable does not count: the next entry is used, and none means no node.
		const stray = mkdtempSync(join(tmp, 'stray-'))
		writeFileSync(join(stray, 'node'), '', { mode: 0o644 })
		assert.equal(u.findOnPath('node', `${stray}:${dir}`, 'linux'), join(dir, 'node'))
		assert.equal(u.findOnPath('node', stray, 'linux'), undefined)
	}
	assert.equal(u.findOnPath('node', '/nowhere', 'linux'), undefined)
})

test('limits go once per change, and again after a send that failed', async () => {
	const sent = []
	let fail = true
	const sender = new u.LimitsSender(async l => {
		if (fail) {
			throw new Error('not registered yet')
		}
		sent.push(l)
	})
	const l = { harness: 'Claude Code', windows: [{ label: '5h', usedPercent: 3 }] }
	assert.equal(await sender.offer(l), 'failed') // flow-harness not up: lost
	fail = false
	assert.equal(await sender.offer(l), 'sent') // so the same report goes again
	assert.equal(await sender.offer(l), 'repeat') // a repeat of what went through does not
	assert.equal(await sender.offer({ ...l, windows: [{ label: '5h', usedPercent: 4 }] }), 'sent')
	assert.equal(sent.length, 2)
})

test('Codex: an older resets_in_seconds becomes an absolute time, dated by the line', () => {
	const line = JSON.stringify({ timestamp: '2026-10-17T12:00:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 9, window_minutes: 300, resets_in_seconds: 600 } } } })
	assert.deepEqual(u.codexRolloutUsage([line]).limits.windows, [{ label: '5h', usedPercent: 9, resetsAt: Date.parse('2026-10-17T12:10:00.000Z') }])
	// No timestamp: the time of reading stands in.
	const bare = JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 9, window_minutes: 300, resets_in_seconds: 60 } } } })
	assert.equal(u.codexRolloutUsage([bare], 1_000_000).limits.windows[0].resetsAt, 1_060_000)
})

test('Codex share with its baseline: nothing below it counts, a tiny window is full', () => {
	assert.equal(u.codexPercent(31_000, 272_000), 7)
	assert.equal(u.codexPercent(5_000, 272_000), 0)
	assert.equal(u.codexPercent(272_000, 272_000), 100)
	assert.equal(u.codexPercent(100, 10_000), 100)
})
