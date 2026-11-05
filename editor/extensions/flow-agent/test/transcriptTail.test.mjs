// The last messages of a conversation, read from a Claude Code or Codex transcript (src/transcriptTail.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = name => readFileSync(join(ROOT, 'test', 'fixtures', 'tail', name), 'utf8').split('\n')
let t
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-tail-'))
	const outfile = join(tmp, 'tail.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'transcriptTail.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	t = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('Claude: user text, merged assistant blocks, tool one-liners; meta, tool results, thinking and bad lines skipped', () => {
	const got = t.tailEntries(fixture('claude.jsonl'), 'claude', 50)
	assert.deepEqual(got.map(e => [e.role, e.text]), [
		['user', 'add a login page'],
		['assistant', 'Looking at the routes.\nThen the page.'],
		['tool', 'Edit src/a.ts'],
		['tool', 'Bash: npm test'],
		['tool', 'Read README.md'],
		['assistant', 'Done.'],
	])
	assert.equal(got[0].at, Date.parse('2026-11-01T10:00:00.000Z'))
	assert.equal(got[3].at, undefined)
})

test('Codex: messages and shell calls; injected context and duplicates skipped', () => {
	const got = t.tailEntries(fixture('codex.jsonl'), 'codex', 50)
	assert.deepEqual(got.map(e => [e.role, e.text]), [
		['user', 'fix the build'],
		['tool', 'shell: npm run build'],
		['assistant', 'Build fixed.'],
	])
	assert.equal(got[2].at, Date.parse('2026-11-01T10:00:03.000Z'))
})

test('max keeps the newest entries, oldest first', () => {
	const got = t.tailEntries(fixture('claude.jsonl'), 'claude', 2)
	assert.deepEqual(got.map(e => e.text), ['Read README.md', 'Done.'])
	assert.deepEqual(t.tailEntries(fixture('claude.jsonl'), 'claude', 0), [])
})

test('long text is cut with an ellipsis; tool lines are shorter; line count is limited', () => {
	const line = (role, content) => JSON.stringify({ type: role, message: { id: 'm' + Math.random(), content } })
	const got = t.tailEntries([
		line('user', 'x'.repeat(2000)),
		line('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'y'.repeat(500) } }]),
		line('assistant', [{ type: 'text', text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n\n\n') }]),
	], 'claude', 10)
	assert.equal(got[0].text.length, 601)
	assert.ok(got[0].text.endsWith('…'))
	assert.ok(got[1].text.length <= 141 && got[1].text.endsWith('…'))
	assert.equal(got[2].text.split('\n').length, 6)
	assert.ok(got[2].text.endsWith('…'))
})

test('readTail reads only the end of a file larger than the window, and a missing file is empty', async () => {
	const file = join(tmp, 'big.jsonl')
	const msg = (i, text) => JSON.stringify({ type: 'user', message: { content: text + i } })
	const filler = Array.from({ length: 3000 }, (_, i) => msg(i, 'old message padding '.repeat(15))).join('\n')
	writeFileSync(file, filler + '\n' + msg(1, 'newest') + '\n' + msg(2, 'last') + '\n')
	const got = await t.readTail(file, 'claude', 3)
	assert.deepEqual(got.map(e => e.text).slice(-2), ['newest1', 'last2'])
	assert.equal(got.length, 3)
	const all = await t.readTail(file, 'claude', 100000)
	assert.ok(all.length < 3002) // the head of the file was not read
	assert.ok(all.every(e => e.text.startsWith('old') || e.text.startsWith('newest') || e.text.startsWith('last')))
	assert.deepEqual(await t.readTail(join(tmp, 'nope.jsonl'), 'codex', 5), [])
})
