// search_sessions: what it returns is redacted, and the tool says its text is verbatim.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'

after(cleanup)

const transcripts = await load('src/mcp/transcripts.ts')
const tools = await load('src/mcp/tools.ts')

test('mcp-sessions: the excerpts have their secrets blanked, and the tool says its text is verbatim', () => {
	const said = 'Please deploy with password=hunter2 and Authorization: Bearer abc123def456ghi789, the rate limit is 5.'
	const snippet = transcripts.snippetAround(said, ['rate'])
	assert.doesNotMatch(snippet, /hunter2|abc123def456/)
	assert.match(snippet, /password=\[redacted\]/)
	assert.match(snippet, /Bearer \[redacted\]/)
	const text = transcripts.formatSessions('rate', {
		scanned: 1,
		hits: [{ agent: 'claude', id: 'aaaa', date: '2026-10-01', prompt: 'my token=ghp_0123456789abcdefghij0123456789 is set', snippet: 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrSt here, the rate is fine' }],
	})
	assert.doesNotMatch(text, /ghp_0123|AbCdEfGh/)
	assert.match(text, /first prompt: my token=\[redacted\] is set/)
	assert.match(text, /the rate is fine/, 'the rest of the line stays readable')
	const d = tools.TOOLS.find(t => t.name === 'search_sessions').description
	assert.match(d, /verbatim from this machine's agent transcripts; it can contain secrets you typed/)
})

test('mcp-sessions: a secret in a transcript is never returned, also when the snippet would have cut it', async () => {
	const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'insilode-redact-')))
	const work = join(home, 'work', 'app')
	const keep = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME }
	process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
	process.env.CODEX_HOME = join(home, 'codex')
	try {
		const proj = join(home, 'claude', 'projects', transcripts.claudeKey(work))
		mkdirSync(proj, { recursive: true })
		const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
		const lines = [
			{ type: 'user', cwd: work, message: { role: 'user', content: `The deploy needs ${secret} and DB_PASSWORD=hunter2 for the migration run` } },
			// The match is early and the secret sits where the 200 character snippet ends.
			{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(30) + ' migration ' + 'y'.repeat(100) + ' ' + secret + ' end' }] } },
		]
		writeFileSync(join(proj, 'aaaa.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
		const r = await transcripts.searchSessions({ folders: [work], query: 'migration', limit: 5 })
		assert.equal(r.hits.length, 1)
		const text = transcripts.formatSessions('migration', r)
		assert.doesNotMatch(text, /AbCdEf|hunter2|sk-ant/)
		assert.match(text, /DB_PASSWORD=\[redacted\]/)
	} finally {
		for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
	}
})
