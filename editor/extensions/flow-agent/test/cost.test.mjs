// Tokens and dollars per prompt and per session, read from the transcripts of both CLIs (src/cost.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let c
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-cost-'))
	const outfile = join(tmp, 'cost.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'cost.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	c = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

// The shape Claude Code 2.1.302 writes: one line per content block, each with the whole message's usage.
const assistant = (id, usage, model = 'claude-opus-5-5') => JSON.stringify({
	type: 'assistant', requestId: 'req_' + id,
	message: { id: 'msg_' + id, model, usage: { service_tier: 'standard', output_tokens_details: { thinking_tokens: 50 }, iterations: [{ ...usage, type: 'message' }], ...usage } },
})
const u1 = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300 }
const u2 = { input_tokens: 5, output_tokens: 100, cache_read_input_tokens: 1300, cache_creation_input_tokens: 50 }

test('each assistant message counts once, thinking and iterations are not added again', () => {
	const l = new c.ClaudeLedger()
	l.feed([
		JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
		assistant('a', u1), assistant('a', u1), // two content blocks of one message
		JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'usage of disk' }] } }),
		assistant('b', u2),
		'{"type":"assistant","message":{"usage":', // cut off mid-write
	])
	assert.deepEqual(l.tokens, { input: 15, output: 300, cacheRead: 2300, cacheWrite: 350 })
	assert.equal(l.model, 'claude-opus-5-5')
	l.feed([assistant('b', u2)]) // seen in an earlier read
	assert.equal(l.tokens.output, 300)
})

test('a synthetic error message does not change the model', () => {
	const l = new c.ClaudeLedger()
	l.feed([assistant('a', u1), assistant('z', { input_tokens: 0, output_tokens: 0 }, '<synthetic>')])
	assert.equal(l.model, 'claude-opus-5-5')
})

test('Codex: the newest running total, cached input split from fresh input', () => {
	const tc = total => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: {}, model_context_window: 272000 } } })
	const lines = [
		tc({ input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 }),
		JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'next' } }),
		tc({ input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 5300 }),
		JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
	]
	assert.deepEqual(c.codexTotals(lines), { input: 1000, output: 300, cacheRead: 4000, cacheWrite: 0 })
	assert.equal(c.codexTotals(['{}', 'not json']), undefined)
})

test('the dollars come only from what the status line reports', () => {
	assert.equal(c.statusUsd({ cost: { total_cost_usd: 1.2345, total_duration_ms: 10 } }), 1.2345)
	assert.equal(c.statusUsd({ cost: {} }), undefined)
	assert.equal(c.statusUsd({}), undefined)
	assert.equal(c.statusUsd({ cost: { total_cost_usd: 'x' } }), undefined)
})

test('a prompt is the total since its baseline; a restarted count starts over', () => {
	const t = (n, usd) => ({ tokens: { input: n, output: n, cacheRead: n, cacheWrite: n }, ...(usd !== undefined ? { usd } : {}) })
	assert.deepEqual(c.spendSince(t(10, 3), t(4, 1)), t(6, 2))
	assert.deepEqual(c.spendSince(t(10, 0.5), t(4, 1)), t(6, 0.5), 'the CLI restarted: its dollars count from zero')
	assert.deepEqual(c.spendSince(t(3), t(4)), t(3))
	assert.deepEqual(c.spendSince(t(10, 2), t(4)), t(6, 2))
})

test('the reader reads a growing transcript once, from where it stopped, keeping a cut line for later', async () => {
	const file = join(tmp, 'grow.jsonl')
	writeFileSync(file, 'one\ntwo\nthr')
	const r = new c.TranscriptReader(file, 4) // a tiny chunk: lines span chunk borders
	assert.deepEqual(await r.read(), ['one', 'two'])
	appendFileSync(file, 'ee\nfour ü\n')
	assert.deepEqual(await r.read(), ['three', 'four ü'])
	assert.deepEqual(await r.read(), [])
	writeFileSync(file, 'new\n') // replaced by a shorter file
	assert.deepEqual(await r.read(), ['new'])
	assert.deepEqual(await new c.TranscriptReader(join(tmp, 'missing.jsonl')).read(), [])
})

test('a tracker gives the session and the prompt it is on', async () => {
	const file = join(tmp, 'session.jsonl')
	writeFileSync(file, assistant('a', u1) + '\n')
	const t = new c.CostTracker('claude')
	assert.equal(t.snapshot(), undefined)
	await t.update(file)
	assert.equal(t.snapshot().prompt, undefined, 'no baseline yet: the share of the prompt is unknown')
	t.setUsd(0.4)
	t.markPrompt()
	appendFileSync(file, assistant('b', u2) + '\n')
	await t.update(file)
	t.setUsd(0.5)
	const s = t.snapshot()
	assert.deepEqual(s.session.tokens, { input: 15, output: 300, cacheRead: 2300, cacheWrite: 350 })
	assert.deepEqual(s.prompt.tokens, { input: 5, output: 100, cacheRead: 1300, cacheWrite: 50 })
	assert.ok(Math.abs(s.prompt.usd - 0.1) < 1e-9)
	assert.match(s.usdSource, /estimate/)
	assert.match(s.scope, /main agent/)
})

test('without a reported price there are tokens and no dollars', async () => {
	const file = join(tmp, 'codex.jsonl')
	writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 } } } }) + '\n')
	const t = new c.CostTracker('codex')
	await t.update(file)
	const s = t.snapshot()
	assert.equal(s.session.usd, undefined)
	assert.equal(s.usdSource, undefined)
	assert.equal(c.totalTokens(s.session.tokens), 110)
})

test('a resumed conversation: the session line counts from this CLI start, like its dollars', async () => {
	const file = join(tmp, 'resumed.jsonl')
	const at = (line, iso) => JSON.stringify({ ...JSON.parse(line), timestamp: iso })
	writeFileSync(file, at(assistant('old', u1), '2026-10-16T10:00:00.000Z') + '\n')
	const t = new c.CostTracker('claude')
	t.started(Date.parse('2026-10-17T09:00:00.000Z'))
	await t.update(file)
	appendFileSync(file, at(assistant('new', u2), '2026-10-17T09:05:00.000Z') + '\n')
	await t.update(file)
	t.setUsd(0.2)
	const s = t.snapshot()
	assert.deepEqual(s.earlier, { input: 10, output: 200, cacheRead: 1000, cacheWrite: 300 }, 'the earlier run, kept apart')
	assert.deepEqual(s.session.tokens, { input: 5, output: 100, cacheRead: 1300, cacheWrite: 50 }, 'what the $0.20 is for')
	assert.equal(s.session.usd, 0.2)
	const fresh = new c.CostTracker('claude')
	fresh.started(Date.parse('2026-10-16T09:00:00.000Z'))
	await fresh.update(file)
	assert.equal(fresh.snapshot().earlier, undefined, 'a conversation that started with this CLI has no earlier part')
})

test('subagent transcripts are counted apart, each message once across lines and files, and read incrementally', async () => {
	const { mkdirSync } = await import('node:fs')
	const dir = mkdtempSync(join(tmp, 'sess-'))
	const transcript = join(dir, 'abc.jsonl')
	writeFileSync(transcript, assistant('main', u1) + '\n')
	const sub = join(dir, 'abc', 'subagents')
	mkdirSync(sub, { recursive: true })
	assert.equal(c.subagentDir(transcript), sub)
	const side = (id, usage, agentId) => assistant(id, usage).replace('{', `{"isSidechain":true,"agentId":"${agentId}",`)
	// the same message spans two lines; a second agent file; a non-agent file is ignored
	writeFileSync(join(sub, 'agent-a1.jsonl'), [side('s1', u1, 'a1'), side('s1', u1, 'a1'), side('s2', u2, 'a1')].join('\n') + '\n')
	writeFileSync(join(sub, 'agent-a2.jsonl'), side('s3', u2, 'a2') + '\n')
	writeFileSync(join(sub, 'notes.jsonl'), side('s9', u1, 'x') + '\n')
	const t = new c.CostTracker('claude')
	await t.update(transcript)
	let snap = t.snapshot()
	assert.deepEqual(snap.session.tokens, { input: 10, output: 200, cacheRead: 1000, cacheWrite: 300 })
	assert.deepEqual(snap.subagents, { input: 20, output: 400, cacheRead: 3600, cacheWrite: 400 })
	// a later line only adds what is new
	appendFileSync(join(sub, 'agent-a2.jsonl'), side('s4', u1, 'a2') + '\n')
	await t.update(transcript)
	assert.deepEqual(t.snapshot().subagents, { input: 30, output: 600, cacheRead: 4600, cacheWrite: 700 })
	// no subagents: the field is absent
	const solo = join(dir, 'solo.jsonl')
	writeFileSync(solo, assistant('m', u1) + '\n')
	const t2 = new c.CostTracker('claude')
	await t2.update(solo)
	assert.equal(t2.snapshot().subagents, undefined)
})
