// search_sessions: fixture Claude and Codex transcripts in a temp home; only this workspace's sessions, only what was said.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'

let t
const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'insilode-transcripts-')))
const work = join(home, 'work', 'app')
const other = join(home, 'work', 'other')
const save = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }

const jl = (...lines) => lines.map(l => JSON.stringify(l)).join('\n') + '\n'
const user = (content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra })
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })
const write = (file, body, age) => {
	mkdirSync(join(file, '..'), { recursive: true })
	writeFileSync(file, body)
	const when = new Date(Date.now() - age * 86_400_000)
	utimesSync(file, when, when)
}

before(async () => {
	t = await load('src/mcp/transcripts.ts')
	process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
	process.env.CODEX_HOME = join(home, 'codex')
	const proj = join(home, 'claude', 'projects', t.claudeKey(work))
	write(join(proj, 'aaaa.jsonl'), jl(
		user('<command-name>/clear</command-name>', { isMeta: true, cwd: work }),
		user('Add a rate limit alert to the budget panel'),
		assistant('I added the Rate Limit alert next to the 90% colour.'),
		user([{ type: 'tool_result', content: 'secret-token-xyz in a tool result' }]),
	), 3)
	write(join(proj, 'bbbb.jsonl'), jl(user('Fix the sidebar', { cwd: work }), assistant('Done, the sidebar is wider.')), 1)
	write(join(proj, 'aaaa', 'subagents', 'agent-1.jsonl'), jl(user('subagent only rate limit talk', { isSidechain: true })), 0)
	write(join(home, 'claude', 'projects', t.claudeKey(other), 'cccc.jsonl'), jl(user('rate limit in another workspace', { cwd: other })), 0)
	// The key is lossy: this file sits in this workspace's folder but says it belongs to another one.
	write(join(proj, 'dddd.jsonl'), jl(user('mismatch phrase from a lookalike folder', { cwd: other })), 0)
	const meta = cwd => ({ type: 'session_meta', payload: { id: 'sess-' + cwd.slice(-3), cwd } })
	const codex = (cwd, text) => jl(meta(cwd), { type: 'event_msg', payload: { type: 'user_message', message: 'Codex task: ' + text } }, { type: 'event_msg', payload: { type: 'agent_message', message: 'Handled ' + text } })
	write(join(home, 'codex', 'sessions', '2026', '10', '20', 'rollout-2026-10-20T10-00-00-d1.jsonl'), codex(work, 'migrate the legacy parser'), 2)
	write(join(home, 'codex', 'sessions', '2026', '10', '21', 'rollout-2026-10-21T10-00-00-d2.jsonl'), codex(other, 'migrate the legacy parser'), 0)
})
after(() => {
	for (const [k, v] of Object.entries(save)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
	cleanup()
})

const run = (query, extra = {}) => t.searchSessions({ folders: [work], query, limit: 10, ...extra })

test('transcripts: the Claude key replaces every non-alphanumeric character', () => {
	assert.equal(t.claudeKey(['C:', 'development', 'harness-flow'].join(String.fromCharCode(92))), 'C--development-harness-flow')
})

test('transcripts: all words match in any case, in prompts and answers, with the first prompt and a snippet', async () => {
	const r = await run('RATE limit')
	assert.equal(r.hits.length, 1)
	const [h] = r.hits
	assert.equal(h.agent, 'claude')
	assert.equal(h.id, 'aaaa')
	assert.equal(h.prompt, 'Add a rate limit alert to the budget panel', 'a meta line is not the first prompt')
	assert.match(h.snippet, /rate limit/i)
	assert.match(h.date, /^\d{4}-\d\d-\d\d$/)
	assert.equal((await run('rate wider')).hits.length, 0, 'words must share one message')
})

test('transcripts: tool results, subagent folders and other workspaces are not searched', async () => {
	assert.equal((await run('secret-token-xyz')).hits.length, 0)
	assert.equal((await run('subagent only')).hits.length, 0)
	assert.equal((await run('another workspace')).hits.length, 0)
})

test('transcripts: Codex sessions are kept by their session_meta cwd', async () => {
	const r = await run('legacy parser')
	assert.deepEqual(r.hits.map(h => [h.agent, h.id]), [['codex', 'sess-app']])
	assert.match(r.hits[0].prompt, /^Codex task: migrate/)
})

test('transcripts: newest first, limit and agent filter', async () => {
	const both = await run('the')
	assert.deepEqual(both.hits.map(h => h.id), ['bbbb', 'sess-app', 'aaaa'])
	assert.equal((await run('the', { limit: 1 })).hits.length, 1)
	assert.deepEqual((await run('the', { agent: 'codex' })).hits.map(h => h.agent), ['codex'])
})

test('transcripts: the text says when nothing matches', async () => {
	assert.match(t.formatSessions('zzz', await run('zzz')), /No past session .* mentions "zzz"/)
	assert.match(t.formatSessions('rate limit', await run('rate limit')), /\[claude\] .* session aaaa\n  first prompt: Add a rate limit/)
})

test('transcripts: a Claude transcript whose cwd is another folder is skipped, and not counted', async () => {
	assert.equal((await run('mismatch phrase')).hits.length, 0)
	assert.equal((await run('zzz', { agent: 'claude' })).scanned, 2)
})

test('transcripts: the file cap applies after the cwd filter and counts only this workspace', async () => {
	// The newest Codex rollout is another project's; a cap of one must still reach this workspace's.
	const r = await run('legacy parser', { agent: 'codex', maxFiles: 1 })
	assert.deepEqual(r.hits.map(h => h.id), ['sess-app'])
	assert.equal((await run('zzz', { agent: 'codex' })).scanned, 1)
})

test('transcripts: the byte budget cuts the search short and the text says so', async () => {
	const r = await run('zzz', { budgetBytes: 10 })
	assert.equal(r.truncated, true)
	assert.equal(r.scanned, 1)
	assert.match(t.formatSessions('zzz', r), /search stopped early/)
	assert.doesNotMatch(t.formatSessions('zzz', await run('zzz')), /stopped early/)
})
