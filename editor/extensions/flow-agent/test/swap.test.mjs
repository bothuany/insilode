// Moving a conversation between Claude Code and Codex: reading a Codex rollout, writing a Claude transcript, and
// speaking to Codex's importer (src/swapCore.ts), plus how `codex` is run for it (codexCommand in src/codexHooks.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let c, h
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-swap-'))
	const load = async file => {
		const outfile = join(tmp, `${file}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${file}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		return import(pathToFileURL(outfile).href)
	}
	c = await load('swapCore')
	h = await load('codexHooks')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const line = o => JSON.stringify(o)
const ID = '01a19478-0233-77d1-ab0c-c038a5c2829e'

test('a thread-history rollout: user and agent messages, nothing else', () => {
	const text = [
		line({ type: 'session_meta', payload: { id: ID, cwd: 'C:\\repo' } }),
		line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions ...' }] } }),
		line({ timestamp: 't1', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'add a login page' }] } } }),
		line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'Reasoning', summary_text: ['thinking'] } } }),
		line({ timestamp: 't2', type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Looking at the routes.' }], phase: 'commentary' } } }),
		line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['ls'] } } }),
		line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Done: /login.' }], phase: 'final_answer' } } }),
		// The same answer as a response item: thread items win, so it is not counted twice.
		line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done: /login.' }] } }),
		'not json',
	].join('\n')
	assert.deepEqual(c.codexTurns(text), [
		{ role: 'user', text: 'add a login page', at: 't1' },
		{ role: 'assistant', text: 'Looking at the routes.\n\nDone: /login.', at: 't2' },
	])
})

test('an older rollout: user_message events and assistant response items; instruction blocks are never read', () => {
	const text = [
		line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>...</environment_context>' }] } }),
		line({ type: 'event_msg', payload: { type: 'user_message', message: 'first' } }),
		line({ type: 'event_msg', payload: { type: 'user_message', message: 'and second' } }),
		line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } }),
		line({ type: 'event_msg', payload: { type: 'user_message', message: '   ' } }),
	].join('\n')
	assert.deepEqual(c.codexTurns(text).map(t => [t.role, t.text]), [['user', 'first\n\nand second'], ['assistant', 'ok']])
})

test('a very long message is cut', () => {
	const big = 'x'.repeat(c.MAX_TURN_CHARS + 10)
	const [t] = c.codexTurns(line({ type: 'event_msg', payload: { type: 'user_message', message: big } }))
	assert.ok(t.text.length < big.length + 200 && t.text.startsWith('x'.repeat(100)))
	assert.match(t.text, /10 more characters left out/)
})

test('the rollout id comes from session_meta, else from the file name', () => {
	assert.equal(c.codexRolloutId('whatever.jsonl', line({ type: 'session_meta', payload: { id: ID } })), ID)
	assert.equal(c.codexRolloutId(`rollout-2026-11-01T03-17-35-${ID}.jsonl`), ID)
	assert.equal(c.codexRolloutId('rollout-x.jsonl'), undefined)
})

test('the Claude transcript: chained turns, the moved note on the first prompt, the title, no tool calls', () => {
	let n = 0
	const meta = { cwd: 'C:\\repo', sessionId: 'S', gitBranch: 'feat', title: 'Codex 2', newId: () => `u${++n}`, now: 'T0' }
	const text = c.claudeTranscript([{ role: 'user', text: 'hi', at: 'T1' }, { role: 'assistant', text: 'hello' }], meta)
	const lines = text.trimEnd().split('\n').map(l => JSON.parse(l))
	assert.equal(lines.length, 3)
	assert.equal(lines[0].type, 'user')
	assert.equal(lines[0].parentUuid, null)
	assert.equal(lines[0].sessionId, 'S')
	assert.equal(lines[0].gitBranch, 'feat')
	assert.equal(lines[0].timestamp, 'T1')
	assert.match(lines[0].message.content, /^\[Insilode: this conversation was moved here from Codex\./)
	assert.match(lines[0].message.content, /\n\nhi$/)
	assert.equal(lines[1].type, 'assistant')
	assert.equal(lines[1].parentUuid, lines[0].uuid)
	assert.deepEqual(lines[1].message.content, [{ type: 'text', text: 'hello' }])
	assert.equal(lines[1].timestamp, 'T1', 'a turn without a time takes the one before')
	assert.deepEqual(lines[2], { type: 'custom-title', customTitle: 'Codex 2', sessionId: 'S' })
})

test('no transcript without both a prompt and an answer', () => {
	const meta = { cwd: 'C:\\repo', sessionId: 'S', newId: () => 'u', now: 'T0' }
	assert.equal(c.claudeTranscript([], meta), undefined)
	assert.equal(c.claudeTranscript([{ role: 'user', text: 'hi' }], meta), undefined)
})

test('the import requests: initialize, initialized, one SESSIONS item for the transcript', () => {
	const [init, initialized, imp] = c.codexImportRequests('C:\\t.jsonl', 'C:\\repo', 'Claude 1').map(l => JSON.parse(l))
	assert.equal(init.method, 'initialize')
	assert.equal(initialized.method, 'initialized')
	assert.equal(initialized.id, undefined)
	assert.equal(imp.method, 'externalAgentConfig/import')
	assert.deepEqual(imp.params.migrationItems[0].details.sessions, [{ cwd: 'C:\\repo', path: 'C:\\t.jsonl', title: 'Claude 1' }])
	assert.equal(imp.params.migrationItems[0].itemType, 'SESSIONS')
})

test('the import answer: waits, then the new thread or the failure', () => {
	assert.deepEqual(c.codexImportStep('{"id":1,"result":{}}'), { wait: true })
	assert.deepEqual(c.codexImportStep('garbage'), { wait: true })
	assert.deepEqual(c.codexImportStep(line({ method: 'externalAgentConfig/import/progress', params: {} })), { wait: true })
	const done = r => line({ method: 'externalAgentConfig/import/completed', params: { importId: 'i', itemTypeResults: [r] } })
	assert.deepEqual(c.codexImportStep(done({ itemType: 'SESSIONS', successes: [{ target: ID }], failures: [] })), { thread: ID })
	assert.deepEqual(c.codexImportStep(done({ itemType: 'SESSIONS', successes: [], failures: [{ message: 'unreadable', failureStage: 'read' }] })), { error: 'unreadable' })
	assert.ok('error' in c.codexImportStep(done({ itemType: 'SESSIONS', successes: [], failures: [] })))
	assert.deepEqual(c.codexImportStep(line({ id: 2, error: { message: 'unknown method' } })), { error: 'unknown method' })
	// An error to a request that is not ours (a notification id) is not the import's.
	assert.deepEqual(c.codexImportStep(line({ id: 7, error: { message: 'x' } })), { wait: true })
})

test('codexCommand: an exe as it is, npm\'s script under Node, a batch wrapper through one fixed cmd.exe line', () => {
	assert.deepEqual(h.codexCommand({ file: 'C:\\c\\codex.exe' }, ['app-server'], undefined, 'E', false), { file: 'C:\\c\\codex.exe', argv: ['app-server'], verbatim: false, electronAsNode: false })
	assert.deepEqual(h.codexCommand({ script: 'C:\\n\\codex.js', node: 'C:\\n\\node.exe' }, ['app-server'], 'C:\\other\\node.exe', 'E', true).file, 'C:\\n\\node.exe')
	const self = h.codexCommand({ script: 'C:\\n\\codex.js' }, ['app-server'], undefined, 'E', true)
	assert.deepEqual(self, { file: 'E', argv: ['C:\\n\\codex.js', 'app-server'], verbatim: false, electronAsNode: true })
	assert.deepEqual(h.codexCommand({ batch: 'C:\\b\\codex.cmd' }, ['app-server'], undefined, 'E', false, 'cmd.exe'), { file: 'cmd.exe', argv: ['/d', '/s', '/c', '""C:\\b\\codex.cmd" app-server"'], verbatim: true, electronAsNode: false })
	assert.equal(h.codexCommand({ batch: 'C:\\b%x%\\codex.cmd' }, ['app-server'], undefined, 'E', false), undefined)
})
