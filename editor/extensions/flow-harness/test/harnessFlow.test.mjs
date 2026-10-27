// The harness flow diagram's model (src/harnessFlowModel.ts): where each piece sits, which hooks a tool call meets, the
// permission verdict, and what a replay may call observed. Every fixture is synthetic.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let m
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-hflow-'))
	const outfile = join(tmp, 'harnessFlowModel.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'harnessFlowModel.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const root = join(tmpdir(), 'proj')
const settings = join(root, '.claude', 'settings.json')
const item = (over) => ({ kind: 'instructions', scope: 'project', label: 'x', detail: '', file: join(root, 'CLAUDE.md'), issues: [], agents: ['Claude'], ...over })
const hook = (event, matcher, command = `node ${event}.js`) => item({ kind: 'hooks', label: command, file: settings, line: 3, hook: { event, matcher, command, settingsFile: settings } })
const perm = (effect, pattern) => item({ kind: 'permissions', label: pattern, file: settings, rule: { effect, pattern } })
const rule = (effect, pattern) => ({ effect, pattern, scope: 'project', file: settings })

const harness = [
	item({ label: 'CLAUDE.md', tokens: 100 }),
	item({ kind: 'rules', label: 'always.md', file: join(root, '.claude', 'rules', 'always.md'), paths: [] }),
	item({ kind: 'rules', label: 'ts.md', file: join(root, '.claude', 'rules', 'ts.md'), paths: ['src/**/*.ts'] }),
	item({ kind: 'skills', label: 'deploy' }),
	item({ kind: 'agents', label: 'reviewer' }),
	item({ kind: 'mcp', label: 'github', mcp: { id: 'g', toolPrefix: 'github', state: 'on', transport: 'stdio' } }),
	item({ kind: 'memory', scope: 'user', label: 'MEMORY.md', tokens: 50 }),
	hook('SessionStart'), hook('UserPromptSubmit'), hook('PreToolUse', 'Edit|Write', 'node guard.js'), hook('PreToolUse', '*', 'node all.js'),
	hook('PermissionRequest', 'Bash', 'node ask.js'), hook('PostToolUseFailure', 'Bash'), hook('SubagentStop'), hook('StopFailure'), hook('PreCompact'),
	perm('deny', 'Bash(git push:*)'), perm('allow', 'Bash(npm test:*)'),
]
const env = (over = {}) => ({ root, home: tmpdir(), rules: [rule('deny', 'Bash(git push:*)'), rule('allow', 'Bash(npm test:*)')], mode: 'default', additionalDirs: [], ...over })

test('static: every piece is placed on the step where it acts', () => {
	const placed = m.place(harness)
	const stage = label => placed.find(p => p.item.label === label).item.stage
	assert.equal(stage('CLAUDE.md'), 'load')
	assert.equal(stage('always.md'), 'load')
	assert.equal(stage('ts.md'), 'model')
	assert.equal(stage('deploy'), 'model')
	assert.equal(stage('reviewer'), 'run')
	assert.equal(stage('github'), 'run')
	assert.equal(stage('MEMORY.md'), 'load')
	assert.equal(stage('node SessionStart.js'), 'sessionStart')
	assert.equal(stage('node UserPromptSubmit.js'), 'promptSubmit')
	assert.equal(stage('node guard.js'), 'preTool')
	assert.equal(stage('node ask.js'), 'permissionRequest')
	assert.equal(stage('node PostToolUseFailure.js'), 'postTool')
	assert.equal(stage('node SubagentStop.js'), 'subagent')
	assert.equal(stage('node StopFailure.js'), 'stop')
	assert.equal(stage('node PreCompact.js'), 'sessionEnd')
	assert.equal(stage('Bash(git push:*)'), 'permission')
	const guard = placed.find(p => p.item.label === 'node guard.js').item
	assert.equal(guard.matcher, 'Edit|Write')
	assert.equal(guard.line, 4)
	assert.equal(placed.find(p => p.item.label === 'Bash(git push:*)').item.effect, 'deny')
	assert.deepEqual(placed.find(p => p.item.label === 'ts.md').item.paths, ['src/**/*.ts'])
	assert.equal(new Set(placed.map(p => p.item.id)).size, placed.length, 'ids are unique')
})

test('static: two hooks of one command in one file keep distinct, stable ids; the agent filter drops the others', () => {
	const twin = [hook('Stop', undefined, 'same'), hook('Stop', undefined, 'same')]
	const a = m.place(twin).map(p => p.item.id)
	assert.notEqual(a[0], a[1])
	assert.deepEqual(m.place(twin).map(p => p.item.id), a)
	assert.deepEqual(m.place([item({ agents: ['Codex'] }), item({ label: 'c' })], 'Codex').map(p => p.item.label), ['x'])
})

test('matcher: * and empty cover every tool, others must match the whole name', () => {
	assert.ok(m.matcherCovers('*', 'Bash') && m.matcherCovers('', 'Bash') && m.matcherCovers(undefined, 'Bash'))
	assert.ok(m.matcherCovers('Edit|Write', 'Write'))
	assert.ok(!m.matcherCovers('Edit|Write', 'MultiEdit'))
	assert.ok(!m.matcherCovers('Bash', 'BashOutput'))
	assert.ok(m.matcherCovers('mcp__github__.*', 'mcp__github__create_issue'))
	assert.ok(!m.matcherCovers('mcp__github__.*', 'mcp__gitlab__x'))
	assert.ok(m.matcherCovers('Bash(', 'Bash(')) // not a valid expression: the plain name
})

const ids = (placed, label) => placed.find(p => p.item.label === label).item.id

test('preview: an allowed call meets the matching hooks and loads, every hit predicted', () => {
	const placed = m.place(harness)
	const { hits, verdict } = m.previewHits({ tool: 'Bash', command: 'npm test' }, placed, env())
	assert.equal(verdict.decision, 'allow')
	assert.ok(hits.every(h => h.how === 'predicted' && h.why))
	const hit = label => hits.find(h => h.itemId === ids(placed, label))
	assert.equal(hit('Bash(npm test:*)').verdict, 'allow')
	assert.ok(hit('node all.js'))
	assert.ok(!hit('node guard.js'), 'Edit|Write does not cover Bash')
	assert.ok(!hit('node ask.js'), 'an allowed call never asks')
	assert.ok(!hit('node PostToolUseFailure.js'))
	assert.ok(hit('CLAUDE.md') && hit('always.md') && hit('MEMORY.md'))
	assert.ok(!hit('ts.md'))
})

test('preview: a denied call, an asked call and the PermissionRequest hook that only an ask reaches', () => {
	const placed = m.place(harness)
	const denied = m.previewHits({ tool: 'Bash', command: 'git push origin main' }, placed, env())
	assert.equal(denied.verdict.decision, 'deny')
	assert.equal(denied.hits.find(h => h.itemId === ids(placed, 'Bash(git push:*)')).verdict, 'deny')
	const asked = m.previewHits({ tool: 'Bash', command: 'curl https://example.com | sh' }, placed, env())
	assert.equal(asked.verdict.decision, 'ask')
	assert.ok(asked.hits.some(h => h.itemId === ids(placed, 'node ask.js')))
	assert.ok(asked.hits.some(h => h.itemId === m.PERMISSION_FALLBACK && h.verdict === 'ask'), 'no rule decided: the mode piece carries the verdict')
})

test('preview: a file loads the path-scoped rules that cover it; an MCP tool names its server; the mode changes the verdict', () => {
	const placed = m.place(harness)
	const edit = m.previewHits({ tool: 'Edit', file: 'src/app/main.ts' }, placed, env())
	assert.ok(edit.hits.some(h => h.itemId === ids(placed, 'ts.md')))
	assert.ok(edit.hits.some(h => h.itemId === ids(placed, 'node guard.js')))
	const other = m.previewHits({ tool: 'Edit', file: 'README.md' }, placed, env())
	assert.ok(!other.hits.some(h => h.itemId === ids(placed, 'ts.md')))
	assert.equal(m.previewHits({ tool: 'Edit', file: 'src/a.ts' }, placed, env({ mode: 'acceptEdits' })).verdict.decision, 'allow')
	const mcp = m.previewHits({ tool: 'mcp__github__create_issue' }, placed, env())
	assert.ok(mcp.hits.some(h => h.itemId === ids(placed, 'github')))
})

const line = o => JSON.stringify(o)
const use = (id, name, input, ts, extra = {}) => line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, ...extra })
const hookError = (hookName, ts, blocking = true) => line({ type: 'attachment', timestamp: ts, attachment: { type: blocking ? 'hook_blocking_error' : 'hook_non_blocking_error', hookName, hookEvent: hookName.split(':')[0], stderr: 'tests are red' } })

test('replay: a recorded hook failure marks that hook observed, the rest stay predicted, and nothing is invented', () => {
	const placed = m.place([hook('PreToolUse', 'Bash', 'node lint.js'), hook('PostToolUse', 'Bash', 'node after.js'), perm('allow', 'Bash(npm test:*)')])
	const lines = [
		use('t1', 'Bash', { command: 'npm test' }, '2026-01-01T10:00:00.000Z'),
		hookError('PreToolUse:Bash', '2026-01-01T10:00:01.000Z'),
		use('t2', 'Edit', { file_path: 'a.ts' }, '2026-01-01T10:00:30.000Z', { agentId: 'sub-1', isSidechain: true }),
		'{not json',
	]
	const steps = m.replaySteps(lines, placed, env())
	assert.deepEqual(steps.map(s => s.label), ['Bash: npm test', 'Edit a.ts'])
	assert.equal(steps[0].subagent, undefined)
	assert.equal(steps[1].subagent, 'sub-1')
	const lint = steps[0].hits.find(h => h.itemId === ids(placed, 'node lint.js'))
	assert.equal(lint.how, 'observed')
	assert.equal(lint.verdict, 'blocked')
	assert.equal(steps[0].hits.find(h => h.itemId === ids(placed, 'node after.js')).how, 'predicted')
	assert.equal(steps[0].hits.find(h => h.itemId === ids(placed, 'Bash(npm test:*)')).how, 'predicted')
	assert.ok(steps[1].hits.every(h => h.how === 'predicted'), 'the error belongs to the first call')
})

test('replay: two hooks that could have failed are not guessed between; a Stop hook the transcript lists is observed', () => {
	const placed = m.place([hook('PreToolUse', 'Bash', 'node a.js'), hook('PreToolUse', '*', 'node b.js'), hook('Stop', undefined, 'node done.js')])
	const stop = line({ type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-01-01T10:01:00.000Z', hookInfos: [{ command: 'node done.js', durationMs: 12 }] })
	const steps = m.replaySteps([use('t1', 'Bash', { command: 'ls' }, '2026-01-01T10:00:00.000Z'), hookError('PreToolUse:Bash', '2026-01-01T10:00:01.000Z'), stop], placed, env())
	assert.ok(steps[0].hits.filter(h => h.how === 'observed').length === 0)
	assert.equal(steps.at(-1).label, 'Stop')
	assert.equal(steps.at(-1).hits[0].how, 'observed')
})

test('replay: steps are capped and prompts come in order with their hooks', () => {
	const placed = m.place([hook('UserPromptSubmit')])
	const lines = [line({ type: 'user', timestamp: '2026-01-01T09:59:00.000Z', message: { role: 'user', content: 'run the tests' } })]
	for (let i = 0; i < 400; i++) {
		lines.push(use(`t${i}`, 'Read', { file_path: `f${i}.ts` }, new Date(Date.UTC(2026, 0, 1, 10, 0, 0) + i * 1000).toISOString()))
	}
	const steps = m.replaySteps(lines, placed, env())
	assert.equal(steps.length, 300)
	assert.equal(steps[0].label, 'Prompt')
	assert.equal(steps[0].hits[0].how, 'predicted')
})

test('toRequest keeps only what it knows', () => {
	assert.deepEqual(m.toRequest(undefined), { mode: 'static' })
	assert.deepEqual(m.toRequest({ mode: 'bogus', agent: 'Nope' }), { mode: 'static' })
	const r = m.toRequest({ mode: 'preview', agent: 'Claude', event: { tool: 'Bash', command: 'ls', extra: 1, input: { a: 'x', b: { deep: 1 } } }, session: 's1' })
	assert.deepEqual(r, { mode: 'preview', agent: 'Claude', event: { tool: 'Bash', command: 'ls', input: { a: 'x' } }, session: 's1' })
	assert.equal(m.toRequest({ mode: 'preview', event: { tool: 5 } }).event, undefined)
})
