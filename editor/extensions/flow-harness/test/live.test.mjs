// What the harness learns at runtime: the transcript parser (src/transcript.ts), the usage counter (src/activity.ts) and
// the friction inbox's clustering (src/friction.ts). Every fixture here is synthetic: no real transcript is copied in.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let t, a, f
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-live-'))
	const load = async name => {
		const outfile = join(tmp, `${name}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		return import(pathToFileURL(outfile).href)
	}
	;[t, a, f] = await Promise.all([load('transcript'), load('activity'), load('friction')])
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const J = o => JSON.stringify(o)
const at = '2026-10-10T10:00:00.000Z'
const ESC = '\u001b'
const CONTEXT = `<local-command-stdout> ${ESC}[1mContext Usage${ESC}[22m
${ESC}[38;2;136;136;136m⛀ ⛁ ⛁ ${ESC}[39m  ${ESC}[38;2;153;153;153m66.7k/1m tokens (7%)${ESC}[39m
⛶ ⛶ ⛶   ${ESC}[3mEstimated usage by category${ESC}[23m
⛶ ⛶ ⛶   ⛁ System prompt: 2.1k tokens (0.2%)
⛶ ⛶ ⛶   ⛁ System tools: 21.4k tokens (2.1%)
⛶ ⛶ ⛶   ⛁ MCP tools: 2.4k tokens (0.2%)
⛶ ⛶ ⛶   ⛁ Memory files: 3.2k tokens (0.3%)
⛶ ⛶ ⛶   ⛁ Messages: 29.7k tokens (3.0%)
⛶ ⛶ ⛶   ⛶ Free space: 900.3k (90.0%)
MCP tools · /mcp
└ mcp__github__create_issue: 1.2k tokens
└ mcp__github__list_issues: 900 tokens
Memory files · /memory
└ CLAUDE.md: 3.2k tokens
</local-command-stdout>`

const LINES = [
	J({ type: 'attachment', timestamp: at, attachment: { type: 'instructions', files: [{ path: '/w/CLAUDE.md', type: 'Project', content: 'x'.repeat(400) }, { path: '/h/.claude/CLAUDE.md', type: 'User', content: 'y'.repeat(40) }] } }),
	J({ type: 'attachment', timestamp: at, attachment: { type: 'skill_listing', content: '- a: does a\n- b: does b' } }),
	J({ type: 'attachment', timestamp: at, attachment: { type: 'mcp_instructions_delta', addedNames: ['github'], addedBlocks: ['## github\nUse it well'] } }),
	J({ type: 'attachment', timestamp: at, attachment: { type: 'deferred_tools_delta', addedNames: ['WebFetch', 'mcp__github__create_issue', 'mcp__github__list_issues'] } }),
	J({ type: 'user', timestamp: at, message: { role: 'user', content: "Fix the build. Don't use yarn here, use npm." } }),
	J({ type: 'user', isMeta: true, timestamp: at, message: { role: 'user', content: '<system-reminder>ignore me</system-reminder>' } }),
	J({ type: 'assistant', timestamp: at, message: { model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 20000, cache_creation_input_tokens: 5000 }, content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'yarn test' } }, { type: 'tool_use', id: 'u2', name: 'Skill', input: { skill: 'probe' } }] } }),
	J({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: true, content: 'Exit code 127\nyarn: command not found' }] } }),
	J({ type: 'attachment', timestamp: at, attachment: { type: 'nested_memory', path: '/w/api/CLAUDE.md', content: { path: '/w/api/CLAUDE.md', content: 'z'.repeat(80) } } }),
	J({ type: 'attachment', timestamp: at, attachment: { type: 'hook_non_blocking_error', hookName: 'PreToolUse:Write', hookEvent: 'PreToolUse', stderr: 'guard-paths.mjs:5 TypeError' } }),
	J({ type: 'system', subtype: 'stop_hook_summary', timestamp: at, hookInfos: [{ command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/arch.mjs"', durationMs: 1500 }, { command: '"node" "C:/x/flow-hook.js"', durationMs: 90 }, { command: 'callback' }] }),
	'{"type":"assistant","message":{"usage":', // a line cut by a bounded read
	J({ type: 'system', subtype: 'compact_boundary', timestamp: at }),
	J({ type: 'assistant', timestamp: at, message: { usage: { input_tokens: 3, cache_read_input_tokens: 9000 } } }),
	J({ type: 'system', subtype: 'local_command', timestamp: at, content: CONTEXT }),
]

test('the transcript parser reads loaded memory, listings, MCP, usage, errors and hooks', () => {
	const x = t.parseTranscript(LINES)
	assert.deepEqual(x.memory.map(m => [m.path, m.chars]), [['/w/CLAUDE.md', 400], ['/h/.claude/CLAUDE.md', 40]])
	assert.equal(x.skillListingChars, 23)
	assert.deepEqual(x.mcpInstructions, [{ server: 'github', chars: 21 }])
	assert.deepEqual(x.mcpTools, ['mcp__github__create_issue', 'mcp__github__list_issues'])
	assert.equal(x.firstUsage.used, 25010, 'input + cache read + cache creation')
	assert.equal(x.lastUsage.used, 9003, 'the usage after the last compaction')
	assert.equal(x.compactions, 1)
	assert.deepEqual(x.prompts.map(p => p.text), ["Fix the build. Don't use yarn here, use npm."], 'meta lines and tool results are not prompts')
	assert.deepEqual(x.toolErrors.map(e => [e.tool, e.input.command, e.error]), [['Bash', 'yarn test', 'Exit code 127\nyarn: command not found']])
	assert.deepEqual(x.nested.map(n => n.path), ['/w/api/CLAUDE.md'])
	assert.equal(x.hookErrors[0].hookName, 'PreToolUse:Write')
	assert.equal(x.stopHooks.length, 3)
})

test('/context output becomes numbers, categories and per-item lines', () => {
	const c = t.parseTranscript(LINES).context
	assert.equal(c.used, 66700)
	assert.equal(c.size, 1000000)
	assert.deepEqual(c.categories.map(x => [x.name, x.tokens]), [['System prompt', 2100], ['System tools', 21400], ['MCP tools', 2400], ['Memory files', 3200], ['Messages', 29700]], 'free space is not a category')
	assert.deepEqual(c.items.map(x => [x.name, x.tokens]), [['mcp__github__create_issue', 1200], ['mcp__github__list_issues', 900], ['CLAUDE.md', 3200]])
	assert.equal(t.tokenCount('1.2m'), 1200000)
})

test('helpers: MCP server names and Insilode\'s own hooks', () => {
	assert.equal(t.mcpServerOf('mcp__github__create_issue'), 'github')
	assert.equal(t.mcpServerOf('mcp__plugin_x_db__query'), 'plugin_x_db')
	assert.equal(t.mcpServerOf('Bash'), undefined)
	assert.equal(t.mcpToolPrefix('my.server'), 'my_server')
	assert.ok(t.isInsilodeHook('callback') && t.isInsilodeHook('"node" "C:/x/flow-hook.js"') && !t.isInsilodeHook('node arch.mjs'))
})

test('hook matchers follow the documented rules', () => {
	assert.ok(a.hookMatches(undefined, 'Bash') && a.hookMatches('*', 'Bash') && a.hookMatches('', 'Edit'))
	assert.ok(a.hookMatches('Edit|Write', 'Write') && a.hookMatches('Edit, Write', 'Edit'))
	assert.ok(!a.hookMatches('Edit', 'NotebookEdit'), 'a plain name is exact')
	assert.ok(a.hookMatches('Edit.*', 'NotebookEdit'), 'a regex is unanchored')
	assert.ok(a.hookMatches('mcp__memory__.*', 'mcp__memory__save') && !a.hookMatches('^Notebook', 'Edit'))
	assert.ok(!a.hookMatches('(', 'x'), 'a broken regex matches nothing')
})

const DAY = 86400000
const NOW = Date.parse('2026-10-17T12:00:00Z')
const HOOKS = [
	{ event: 'PreToolUse', matcher: 'Edit|Write', command: 'node guard.mjs' },
	{ event: 'PostToolUse', matcher: 'Bash', command: 'node log.mjs' },
	{ event: 'PostToolUseFailure', command: 'node fail.mjs' },
	{ event: 'Stop', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/arch.mjs"' },
	{ event: 'UserPromptSubmit', command: 'node prompt.mjs' },
	{ event: 'PreToolUse', matcher: 'Write', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-paths.mjs"' },
]

test('events count skills, subagents, MCP servers and the hooks they fire', () => {
	const d = a.emptyActivity(NOW)
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'PostToolUse', tool: 'Skill', input: { skill: 'Probe' } }, HOOKS)
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'PostToolUse', tool: 'Agent', input: { subagent_type: 'Explore' } }, HOOKS)
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'PostToolUse', tool: 'mcp__github__create_issue' }, HOOKS)
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'PostToolUse', tool: 'Write' }, HOOKS)
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'PostToolUseFailure', tool: 'Bash', error: 'x' }, HOOKS)
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'UserPromptSubmit', prompt: 'hi' }, HOOKS)
	const s = k => a.summary(d, k, NOW)
	assert.equal(s(a.skillKey('probe')).week, 1)
	assert.equal(s(a.agentKey('explore')).week, 1)
	assert.equal(s(a.mcpKey('github')).week, 1)
	assert.equal(s(a.hookKey(HOOKS[0])).week, 1, 'PreToolUse Edit|Write fired for Write')
	assert.equal(s(a.hookKey(HOOKS[0])).inferred, true)
	assert.equal(s(a.hookKey(HOOKS[1])).week, 0, 'PostToolUse Bash does not run when Bash failed')
	assert.equal(s(a.hookKey(HOOKS[2])).week, 1, 'PostToolUseFailure did')
	assert.equal(s(a.hookKey(HOOKS[4])).week, 1)
})

test('a transcript adds measured Stop hook durations, hook failures, loaded files, and tool calls for sessions no hook saw', () => {
	const d = a.emptyActivity(NOW)
	const facts = t.parseTranscript(LINES)
	a.countTranscript(d, facts, HOOKS, NOW, false)
	const stop = a.summary(d, a.hookKey(HOOKS[3]), Date.parse(at) + 1000)
	assert.equal(stop.month, 1)
	assert.equal(stop.avgMs, 1500)
	assert.equal(stop.inferred, false)
	assert.equal(Object.keys(d.keys).filter(k => /flow-hook|callback/.test(k)).length, 0, "Insilode's observer is never counted")
	assert.equal(d.keys[a.hookKey(HOOKS[5])].failures, 1, 'the failure is put on the hook its stderr names')
	assert.equal(d.keys[a.hookKey(HOOKS[0])]?.failures, undefined)
	assert.ok(d.keys[a.ruleKey('/w/api/CLAUDE.md')])
	assert.equal(a.summary(d, a.skillKey('probe'), NOW).month, 0, 'tool calls are left to hook events for live sessions')
	a.countTranscript(d, facts, HOOKS, NOW, true)
	assert.equal(a.summary(d, a.skillKey('probe'), Date.parse(at)).month, 1, 'a past session counts its tool calls from the transcript')
})

test('labels: this week, this month, never, and not enough history yet', () => {
	assert.equal(a.usageLabel({ week: 12, month: 20 }, 40), 'used 12× this week')
	assert.equal(a.usageLabel({ week: 0, month: 3 }, 40), 'used 3× in 30 days')
	assert.equal(a.usageLabel({ week: 0, month: 0 }, 40), 'never used in 30 days')
	assert.equal(a.usageLabel({ week: 0, month: 0 }, 4), 'no use in 4 days', 'never claim 30 days before they are covered')
	assert.equal(a.usageLabel({ week: 0, month: 0 }, 40, 1), 'no use in 1 session', 'nor on one session')
	assert.equal(a.usageLabel({ week: 0, month: 0 }, 40, 0), 'no use seen yet')
})

test('storage stays bounded: old days, then old keys and transcripts, are dropped', () => {
	const d = a.emptyActivity(NOW - 90 * DAY)
	a.bump(d, 'skill:old', NOW - 60 * DAY)
	a.bump(d, 'skill:new', NOW - DAY)
	for (let i = 0; i < a.MAX_KEYS + 20; i++) {
		a.bump(d, `skill:k${i}`, NOW - (i % 20) * DAY)
	}
	for (let i = 0; i < a.MAX_TRANSCRIPTS + 5; i++) {
		d.transcripts[`/t/${i}.jsonl`] = { offset: 1, live: false, at: i }
	}
	a.prune(d, NOW)
	assert.equal(d.keys['skill:old'], undefined)
	assert.ok(d.keys['skill:new'])
	assert.ok(Object.keys(d.keys).length <= a.MAX_KEYS)
	assert.equal(Object.keys(d.transcripts).length, a.MAX_TRANSCRIPTS)
	assert.ok(!d.transcripts['/t/0.jsonl'], 'the oldest transcript is forgotten first')
	assert.equal(a.coveredDays(d, NOW), 30)
	assert.deepEqual(a.loadActivity({ version: 9 }, NOW).keys, {}, 'an unknown shape starts over')
})

const P = (text, at, cli = 'claude') => ({ text, at, cli, session: String(at) })

test('corrections: imperative and prohibitive sentences, in English and Turkish', () => {
	assert.deepEqual(f.corrections("Fix the build. Don't use yarn here, use npm."), ["Don't use yarn here, use npm."])
	assert.deepEqual(f.corrections('Always run npm run arch before committing'), ['Always run npm run arch before committing'])
	assert.deepEqual(f.corrections('Commit atma, ben atarım.'), ['Commit atma, ben atarım.'])
	assert.deepEqual(f.corrections('Asla editor/vscode altını düzenleme'), ['Asla editor/vscode altını düzenleme'])
	assert.deepEqual(f.corrections('Why did you not use npm?'), [], 'a question is not a standing instruction')
	assert.deepEqual(f.corrections('Add a button to the dock'), [])
	assert.deepEqual(f.corrections('Look at this:\n<pasted_content id="1">\nNever run the tests.\n</pasted_content>\n```\ndon\'t use x\n```\n> Always do y'), [], 'pasted text, code and quotes are not the person\'s own words')
})

test('a correction repeated in separate prompts becomes one proposed line, with its evidence', () => {
	const prompts = [
		P("Don't use yarn, use npm.", 1),
		P('Fix the tests', 2),
		P('Again: do not use yarn here, use npm', 3),
		P("Please don't use yarn. Use npm!", 4, 'codex'),
		P('Commit atma.', 5),
	]
	const [p, ...rest] = f.correctionProposals(prompts)
	assert.equal(rest.length, 0, 'a correction said once is not a pattern')
	assert.equal(p.kind, 'instruction')
	assert.equal(p.evidence.length, 3)
	assert.deepEqual(p.evidence.map(e => e.at), [4, 3, 1], 'newest first')
	assert.deepEqual(p.targets, ['CLAUDE.md', 'AGENTS.md'], 'Claude and Codex both heard it')
	assert.equal(p.text, "Don't use yarn, use npm.")
	assert.equal(f.correctionProposals(prompts)[0].id, p.id, 'the id is stable')
	assert.equal(f.correctionProposals([P("Don't use yarn. Don't use yarn!", 1)]).length, 0, 'twice in one prompt is one prompt')
	assert.equal(f.correctionProposals(prompts, '- Do not use yarn; use npm.')[0].covered, true)
})

test('the same failure three times becomes a guard hook for commands, a line for other tools', () => {
	const fail = (subject, error, at, tool = 'Bash') => ({ tool, subject, error, at, cli: 'claude' })
	const failures = [
		fail('yarn test', 'Exit code 127\n/bin/sh: yarn: command not found', 1),
		fail('yarn test --watch', 'Exit code 127\n/usr/bin/sh: yarn: command not found', 2),
		fail('yarn test src/a.test.ts', 'Exit code 127\n/bin/sh: yarn: command not found', 3),
		fail('npm test', 'Exit code 1\n3 failing', 4),
		fail('C:/w/a.ts', 'String to replace not found in file.\nString: foo', 5, 'Edit'),
		fail('C:/w/b.ts', 'String to replace not found in file.\nString: bar', 6, 'Edit'),
		fail('C:/w/c.ts', 'String to replace not found in file.\nString: baz', 7, 'Edit'),
		fail('rm -rf x', "The user doesn't want to proceed with this tool use.", 8),
		fail('rm -rf x', "The user doesn't want to proceed with this tool use.", 9),
		fail('rm -rf x', "The user doesn't want to proceed with this tool use.", 10),
		...[11, 12, 13].map(at => fail('', 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: x', at, 'mcp__browser__click')),
	]
	const props = f.failureProposals(failures)
	assert.deepEqual(props.map(p => [p.kind, p.prefix ?? p.tool, p.evidence.length]), [['hook', 'yarn test', 3], ['instruction', 'Edit', 3]], 'a refusal is not a failure')
	assert.equal(f.errorShape('Error: Cannot find module \'C:\\x\\y.js\' at line 12'), 'error: cannot find module <q> at line <n>')
	assert.equal(f.commandHead('NODE_ENV=x npx ./bin/run.js'), 'npx')
	assert.equal(f.commandHead('git push --force'), 'git push')
	assert.equal(f.commandHead('for n in 1 2 3; do echo $n; done'), '', 'a loop is not a command to guard')
	assert.equal(f.guardFileName('npm run build'), 'insilode-guard-npm-run-build.mjs')
})

test('the guard script stops the command and tells the agent why', async () => {
	const { spawnSync } = await import('node:child_process')
	const { writeFileSync } = await import('node:fs')
	const file = join(tmp, 'guard.mjs')
	writeFileSync(file, f.guardScript('yarn test', 'Use "npm test" here.'))
	const run = command => spawnSync(process.execPath, [file], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' })
	const hit = run('yarn test --watch')
	assert.equal(hit.status, 2)
	assert.match(hit.stderr, /"yarn test": Use "npm test" here\./, 'names the command and the reason')
	assert.match(hit.stderr, /Remove this guard in the Insilode Harness view/)
	assert.equal(run('yarn testify').status, 0, 'a longer word is another command')
	assert.equal(run('npm test').status, 0)
})

test('the X-ray labels what it knows: /context categories, else the first request split into estimates', async () => {
	const outfile = join(tmp, 'xraymodel.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'xraymodel.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	const x = await import(pathToFileURL(outfile).href)
	const items = [
		{ kind: 'mcp', scope: 'project', label: 'github', file: '/w/.mcp.json', agents: ['Claude'] },
		{ kind: 'mcp', scope: 'user', label: 'busy', file: '/h/.claude/settings.json', agents: ['Claude'] },
		{ kind: 'skills', scope: 'project', label: 'probe', file: '/w/.claude/skills/probe/SKILL.md', tokens: 60, agents: ['Claude'] },
		{ kind: 'skills', scope: 'project', label: 'used', file: '/w/.claude/skills/used/SKILL.md', tokens: 40, agents: ['Claude'] },
		{ kind: 'skills', scope: 'project', label: 'idle', file: '/w/.claude/skills/idle/SKILL.md', tokens: 30, agents: ['Claude'] },
		{ kind: 'instructions', scope: 'project', label: 'CLAUDE.md', file: '/w/CLAUDE.md', tokens: 6000, agents: ['Claude'] },
	]
	const usesOf = i => i.label === 'used' || i.label === 'busy' ? 3 : 0
	const withContext = x.xray({ agent: 'a', cli: 'claude', facts: t.parseTranscript(LINES), items, usesOf, covered: 40 })
	assert.equal(withContext.source, 'context')
	assert.equal(withContext.used, 9003)
	assert.equal(withContext.usedHow, 'measured')
	assert.equal(withContext.size, 1000000, 'the window /context reported')
	assert.ok(withContext.segments.every(s => s.how === 'claude-estimate'))
	const gh = withContext.waste.find(w => w.id === 'mcp:github')
	assert.equal(gh.tokens, 2100, 'the per-tool lines of /context all')
	assert.equal(gh.how, 'claude-estimate')
	assert.deepEqual(gh.action, { kind: 'disable-mcp', server: 'github' }, 'a .mcp.json server can be switched off here')
	assert.match(gh.title, /never called in 30 days/)
	assert.ok(!withContext.waste.some(w => w.id === 'mcp:busy'), 'a server in use is not waste')
	const idle = withContext.waste.find(w => w.id === 'skills')
	assert.match(idle.title, /^1 skill not used in 30 days: ~30 tokens/)
	assert.match(idle.detail, /^idle./, 'probe was called in this session, so it is not idle')
	assert.ok(withContext.waste.some(w => w.id === 'big:/w/CLAUDE.md'))

	const noContext = x.xray({ agent: 'a', cli: 'claude', facts: t.parseTranscript(LINES.slice(0, -1)), items, usesOf, covered: 5 })
	assert.equal(noContext.source, 'baseline')
	const rest = noContext.segments[0]
	assert.equal(rest.how, 'derived')
	assert.equal(noContext.segments.find(s => s.label.startsWith('Memory')).tokens, 110, '440 characters, about 4 per token')
	assert.equal(noContext.segments.find(s => s.label.startsWith('Memory')).how, 'estimate')
	assert.match(noContext.waste.find(w => w.id === 'mcp:github').title, /instructions, never called in 5 days in this project$/, 'never claims 30 days it has not seen')
	const oneSession = x.xray({ agent: 'a', cli: 'claude', facts: t.parseTranscript(LINES.slice(0, -1)), items, usesOf, covered: 40, sessions: 1 })
	assert.match(oneSession.waste.find(w => w.id === 'skills').title, /not used in 1 session:/, 'one session does not speak for a month')
	assert.ok(!oneSession.waste.some(w => w.id === 'skills' && /probe/.test(w.detail)), 'a skill this session called is not idle')

	const codex = x.xray({ agent: 'c', cli: 'codex', reported: { used: 50000, size: 200000 }, items: [{ kind: 'instructions', scope: 'project', label: 'AGENTS.md', file: '/w/AGENTS.md', tokens: 800, agents: ['Codex'] }], usesOf, covered: 0 })
	assert.equal(codex.source, 'harness')
	assert.deepEqual(codex.segments.map(s => [s.label, s.tokens, s.how]), [['Instructions (AGENTS.md)', 800, 'estimate'], ['System prompt, tools and conversation', 49200, 'derived']])
	assert.equal(x.xray({ agent: 'a', cli: 'claude', reported: { used: 180000, size: 200000 }, items: [], usesOf, covered: 0 }).waste[0].action.kind, 'compact')
})

test('only Claude Code transcripts are read: a .jsonl inside projects/ of the config folder, with .. resolved', () => {
	const home = String.raw`C:\Users\me`
	assert.ok(t.isTranscriptPath(String.raw`C:\Users\me\.claude\projects\C--w\a.jsonl`, home + '/.claude'))
	assert.ok(t.isTranscriptPath('c:/users/ME/.claude/projects/x/b.jsonl', home + '/.claude'), 'Windows paths compare without case')
	assert.ok(!t.isTranscriptPath(String.raw`C:\Users\me\.claude\projects\..\..\secret.jsonl`, home + '/.claude'), '.. out of the folder')
	assert.ok(!t.isTranscriptPath(String.raw`D:\x\.claude\projects\a.jsonl`, home + '/.claude'), 'another .claude/projects')
	assert.ok(!t.isTranscriptPath(String.raw`C:\Users\me\.claude\projects\a.txt`, home + '/.claude'))
	assert.ok(!t.isTranscriptPath('.claude/projects/a.jsonl', home + '/.claude'), 'a relative path')
	assert.ok(!t.isTranscriptPath(42, home + '/.claude'))
	assert.ok(t.isTranscriptPath('/home/me/.claude/projects/p/s.jsonl', '/home/me/.claude'))
	assert.ok(!t.isTranscriptPath('/home/ME/.claude/projects/p/s.jsonl', '/home/me/.claude'), 'POSIX paths keep their case')
})

test('secrets are blanked before a prompt or a command is stored', () => {
	assert.equal(f.redact('use sk-ant-REDACTED_TEST_KEY please'), 'use <secret> please')
	assert.equal(f.redact('export GITHUB_TOKEN=ghp_REDACTED_TEST_TOKEN && gh pr list'), 'export GITHUB_TOKEN=<secret> && gh pr list')
	assert.equal(f.redact('curl -H "Authorization: Bearer abcdefghijklmnop.qrst"'), 'curl -H "Authorization: Bearer <secret>"')
	assert.equal(f.redact('DB_PASSWORD="hunter2 x" npm start'), 'DB_PASSWORD=<secret> npm start')
	assert.equal(f.redact('login with password: hunter22'), 'login with password=<secret>')
	assert.equal(f.redact("Don't use yarn, use npm."), "Don't use yarn, use npm.", 'ordinary text is untouched')
})

test('coverage starts where reading did: a partly read or a left-out transcript moves it forward', () => {
	const cutoff = 1000
	assert.equal(a.coveredFrom(cutoff, []), 1000)
	assert.equal(a.coveredFrom(cutoff, [5000, 3000]), 5000, 'a transcript read only from 5000 on')
	assert.equal(a.coveredFrom(cutoff, [], 4000), 4000, 'older transcripts left out, the newest of them written at 4000')
	assert.equal(a.coveredFrom(cutoff, [500]), 1000, 'never before the window')
})

test("a Codex event fires none of Claude Code's hooks, but still counts its MCP server", () => {
	const d = a.emptyActivity(NOW)
	a.countEvent(d, { at: NOW, agent: 'x', cli: 'codex', event: 'PostToolUse', tool: 'mcp__github__get', input: {} }, [{ event: 'PreToolUse', matcher: '*', command: 'node a.mjs' }])
	a.countEvent(d, { at: NOW, agent: 'x', cli: 'codex', event: 'UserPromptSubmit', prompt: 'hi' }, [{ event: 'UserPromptSubmit', command: 'node b.mjs' }])
	assert.deepEqual(Object.keys(d.keys), ['mcp:github'])
})

test('an MCP server named with a dot is counted under the name its tools carry', () => {
	const d = a.emptyActivity(NOW)
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'PostToolUse', tool: 'mcp__my_server__go' }, [])
	assert.equal(a.summary(d, a.itemKey({ kind: 'mcp', label: 'my.server', file: '' }), NOW).week, 1)
})

test('the same prompt seen twice (an event and its transcript) is one prompt, not a repeat', () => {
	const twice = [P("Don't use yarn, use npm.", 1000), P("Don't use yarn, use npm.", 1500)]
	assert.equal(f.correctionProposals(twice).length, 0)
	assert.equal(f.correctionProposals([...twice, P("Don't use yarn, use npm.", 90000)]).length, 1)
})

test('reading a memory file counts as recalling it, from an event or a past transcript', () => {
	const d = a.emptyActivity(NOW)
	const file = String.raw`C:\Users\me\.claude\projects\C--w\memory\feedback_x.md`
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'PostToolUse', tool: 'Read', input: { file_path: file } }, [])
	a.countEvent(d, { at: NOW, agent: 'c', cli: 'claude', event: 'PostToolUse', tool: 'Read', input: { file_path: 'C:/w/src/a.ts' } }, [])
	a.countTranscript(d, { ...t.parseTranscript([]), toolUses: [{ name: 'Read', input: { file_path: file.toLowerCase() } }] }, [], NOW, true)
	const key = a.itemKey({ kind: 'memory', label: 'x', file })
	assert.equal(a.summary(d, key, NOW).week, 2)
	assert.equal(Object.keys(d.keys).length, 1, 'other reads are not memory')
	assert.ok(a.isTracked({ kind: 'memory', scope: 'user', memory: {} }))
	assert.ok(!a.isTracked({ kind: 'memory', scope: 'user' }), 'MEMORY.md is read every session; a count says nothing')
})

test('usage counts read the sessions of agent worktrees too', async () => {
	const outfile = join(tmp, 'dirs.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'dirs.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	const d = await import(pathToFileURL(outfile).href)
	const root = String.raw`c:\development\harness-flow`
	assert.ok(d.isProjectTranscriptDir('C--development-harness-flow', root, 'win32'), 'the drive letter in either case')
	assert.ok(d.isProjectTranscriptDir('C--development-harness-flow--claude-worktrees-happy-vaughan-1a2b', root, 'win32'))
	assert.ok(d.isProjectTranscriptDir('C--development-harness-flow--insilode-worktrees-claude-aae3', root, 'win32'))
	assert.ok(!d.isProjectTranscriptDir('C--development-harness-flow-other', root, 'win32'), 'another project with the same start')
	assert.ok(!d.isProjectTranscriptDir('C--development-harness-flow-src', root, 'win32'))
	assert.ok(!d.isProjectTranscriptDir('-Home-me-app', '/home/me/app', 'linux'), 'POSIX keeps case')
	assert.ok(d.isProjectTranscriptDir('-home-me-app--claude-worktrees-x', '/home/me/app', 'linux'))
})

test('a transcript line still being written is left for the next read, never skipped', async () => {
	const { appendFileSync, writeFileSync } = await import('node:fs')
	const file = join(tmp, 'growing.jsonl')
	const line = n => J({ type: 'user', n, pad: 'x'.repeat(10) }) + '\n'
	const read = async (offset, chunk) => {
		const got = []
		const r = await t.readLines(file, offset, lines => got.push(...lines.filter(Boolean)), { chunk })
		return { ...r, got: got.map(l => JSON.parse(l).n) }
	}
	// The newest line is half written when a Stop event triggers a read, in a read shorter than one chunk.
	writeFileSync(file, line(1) + line(2).slice(0, 12))
	const first = await read(0, 4096)
	assert.deepEqual(first.got, [1])
	assert.equal(first.end, line(1).length, 'the offset stays at the start of the unfinished line')
	// With only the partial line left, the read hands over nothing and keeps the offset.
	const again = await read(first.end, 4096)
	assert.deepEqual([again.got, again.end], [[], first.end])
	appendFileSync(file, line(2).slice(12) + line(3))
	assert.deepEqual((await read(first.end, 4096)).got, [2, 3], 'the finished line is read whole')
	// A line longer than a whole chunk is still skipped, so one huge pasted log cannot hold the reader up.
	writeFileSync(file, J({ type: 'user', n: 4, pad: 'y'.repeat(200) }) + '\n' + line(5))
	assert.deepEqual((await read(0, 64)).got, [5])
})
