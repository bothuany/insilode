// Trust and truth in the friction inbox and the simulator: where a guard lives by default, what its script blocks and says,
// the list of guards Insilode added and their removal, the permission mode the simulator assumes, and what survives a reload.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let f, m
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-guards-'))
	const load = async name => {
		const outfile = join(tmp, `${name}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		return import(pathToFileURL(outfile).href)
	}
	;[f, m] = await Promise.all([load('friction'), load('permmatch')])
})
after(() => rmSync(tmp, { recursive: true, force: true }))

// What Live and PermissionInbox do with workspaceState, minus vscode: a Memento that keeps what was written as JSON, so a reload gets copies.
const memento = () => {
	const store = new Map()
	return {
		get: key => store.has(key) ? JSON.parse(store.get(key)) : undefined,
		update: (key, value) => { value === undefined ? store.delete(key) : store.set(key, JSON.stringify(value)) },
		store,
	}
}

test('a guard goes to this machine by default, and sharing it carries a warning', () => {
	assert.equal(f.defaultGuardTarget().file, '.claude/settings.local.json')
	assert.equal(f.GUARD_TARGETS[0].label, 'This machine only (.claude/settings.local.json)')
	assert.equal(f.GUARD_TARGETS[0].warning, undefined)
	const shared = f.GUARD_TARGETS[1]
	assert.equal(shared.label, 'Share with the team (.claude/settings.json)')
	assert.equal(shared.file, '.claude/settings.json')
	assert.equal(shared.warning, 'Blocks the command for everyone who pulls this file')
	assert.equal(f.SHARED_GUARD_WARNING, shared.warning)
})

const runGuard = (prefix, command, reason = 'Because.') => {
	const file = join(tmp, `guard-${prefix.replace(/\W+/g, '-')}.mjs`)
	writeFileSync(file, f.guardScript(prefix, reason))
	return spawnSync(process.execPath, [file], { input: JSON.stringify({ tool_input: { command } }), encoding: 'utf8' })
}

test('a bare-program guard stops that program run bare, never its subcommands', () => {
	assert.equal(runGuard('git', 'git').status, 2)
	assert.equal(runGuard('git', 'ls && git').status, 2)
	assert.equal(runGuard('git', 'git status').status, 0, 'a guard on bare `git` must not stop `git status`')
	assert.equal(runGuard('git', 'git push origin main').status, 0)
})

test('a guard on a subcommand stops that subcommand only, whatever the spacing or the program path', () => {
	assert.equal(runGuard('git push', 'git push origin main').status, 2)
	assert.equal(runGuard('git push', 'git  push').status, 2, 'extra spaces are the same command')
	assert.equal(runGuard('git push', '/usr/bin/git push').status, 2, 'a program path is the same program')
	assert.equal(runGuard('git push', 'FOO=1 git push').status, 2)
	assert.equal(runGuard('git push', 'git status').status, 0)
	assert.equal(runGuard('git push', 'git pushx').status, 0)
	assert.equal(runGuard('git push', 'git').status, 0, 'a shorter command than the prefix is not it')
	assert.equal(runGuard('git push', 'echo git push').status, 0)
})

test('a block says which command, why, and how to remove the guard', () => {
	const r = runGuard('npm test', 'npm test -- --watch', 'Run the suite with npm run ci instead.')
	assert.equal(r.status, 2)
	assert.match(r.stderr, /"npm test"/)
	assert.match(r.stderr, /Run the suite with npm run ci instead\./)
	assert.match(r.stderr, /Remove this guard in the Insilode Harness view/)
	assert.equal(runGuard('npm test', 'not json at all').status, 0, 'a call the script cannot read is let through, not blocked')
})

const settingsWith = (...names) => JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: names.map(n => ({ matcher: 'Bash', hooks: [{ type: 'command', command: f.guardCommand(n), timeout: 10 }] })) } }, null, 2)

test('the guards Insilode added are found in both settings files and the hooks folder, joined by script name', () => {
	const a = f.guardFileName('git push')
	const b = f.guardFileName('npm test')
	const c = f.guardFileName('make')
	const scripts = [
		{ name: a, text: f.guardScript('git push', 'Push from the release script.') },
		{ name: b, text: f.guardScript('npm test', 'Use npm run ci.') },
		{ name: 'other-hook.mjs', text: 'process.exit(0)' },
	]
	const guards = f.scanGuards([{ scope: 'local', text: settingsWith(a, b) }, { scope: 'shared', text: settingsWith(a, c) }], scripts)
	assert.deepEqual(guards.map(g => g.prefix), ['git push', 'make', 'npm test'])
	const push = guards.find(g => g.prefix === 'git push')
	assert.deepEqual(push.files, ['local', 'shared'])
	assert.equal(push.reason, 'Push from the release script.')
	assert.equal(push.scriptExists, true)
	const make = guards.find(g => g.prefix === 'make')
	assert.deepEqual(make.files, ['shared'])
	assert.equal(make.scriptExists, false, 'an entry whose script is gone is still listed')
	assert.equal(make.reason, '')
	assert.deepEqual(f.scanGuards([{ scope: 'local', text: '{}' }, { scope: 'shared', text: '{ not json' }], [{ name: b, text: f.guardScript('npm test', 'x') }]).map(g => [g.prefix, g.files]), [['npm test', []]], 'a script nobody runs is listed; a broken settings file is skipped')
	assert.deepEqual(f.scanGuards([], []), [])
})

test('removing a guard takes out its entry and keeps every other hook', () => {
	const a = f.guardFileName('git push')
	const b = f.guardFileName('npm test')
	const s = JSON.parse(settingsWith(a, b))
	s.hooks.PreToolUse.push({ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo hi' }] })
	s.hooks.Stop = [{ hooks: [{ type: 'command', command: 'echo done' }] }]
	assert.equal(f.removeGuardHook(s, a), true)
	assert.deepEqual(f.guardNamesIn(JSON.stringify(s)), [b])
	assert.equal(s.hooks.PreToolUse.length, 2)
	assert.equal(f.removeGuardHook(s, a), false, 'nothing left to remove')
	// An entry that runs the guard next to another hook keeps the other hook.
	const mixed = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: f.guardCommand(a) }, { type: 'command', command: 'echo keep' }] }] } }
	f.removeGuardHook(mixed, a)
	assert.deepEqual(mixed.hooks.PreToolUse[0].hooks, [{ type: 'command', command: 'echo keep' }])
	// The last guard takes the empty lists with it.
	const only = JSON.parse(settingsWith(a))
	f.removeGuardHook(only, a)
	assert.deepEqual(only, { permissions: { allow: ['Bash(ls)'] } })
	assert.throws(() => f.removeGuardHook({ hooks: [] }, a), /not an object/)
	assert.throws(() => f.removeGuardHook({ hooks: { PreToolUse: {} } }, a), /not a list/)
	assert.equal(f.removeGuardHook({}, a), false)
})

test('removing a guard from a settings text writes the file as the settings edits do, and leaves other text alone', () => {
	const a = f.guardFileName('git push')
	const text = settingsWith(a)
	assert.equal(f.removeGuardFromText(text, a), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }, null, 2) + '\n')
	assert.equal(f.removeGuardFromText(text, f.guardFileName('make')), text, 'no entry: unchanged')
	assert.equal(f.removeGuardFromText('', a), '')
	assert.throws(() => f.removeGuardFromText('[1]', a), /not a JSON object/)
	assert.throws(() => f.removeGuardFromText('{ // a comment\n}', a))
})

test('the mode a simulation assumes: the page choice, then the session, then the settings, then the built-in default', () => {
	const none = m.resolveMode(undefined, undefined)
	assert.deepEqual([none.mode, none.source, none.assumed], ['auto', 'builtin', true])
	assert.equal(none.text, 'Assuming mode: auto (built-in default since v2.1.283)')
	assert.match(m.resolveMode(undefined, undefined, undefined, 'defaultMode "auto" in project settings does not take effect').text, /since v2\.1\.283; defaultMode "auto" in project/)
	const settings = m.resolveMode(undefined, 'plan')
	assert.deepEqual([settings.mode, settings.source, settings.assumed], ['plan', 'settings', true])
	assert.equal(settings.text, 'Assuming mode: plan (settings defaultMode)')
	const session = m.resolveMode('acceptEdits', 'plan')
	assert.deepEqual([session.mode, session.source, session.assumed], ['acceptEdits', 'session', false])
	assert.equal(session.text, 'Session reported: acceptEdits')
	const over = m.resolveMode('acceptEdits', 'plan', 'dontAsk')
	assert.deepEqual([over.mode, over.source, over.assumed], ['dontAsk', 'override', true], 'the page choice beats a session that reported')
	assert.equal(m.resolveMode('acceptEdits', 'plan', 'sudo').mode, 'acceptEdits', 'an unknown override is ignored')
	assert.equal(m.resolveMode(undefined, undefined, '').source, 'builtin', 'an empty override is none')
	assert.deepEqual([...m.PERMISSION_MODES], ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'])
})

test('the override changes the verdict the simulator gives', () => {
	const call = m.parseCall('Edit(src/x.ts)')
	const run = mode => m.simulate(call, [], { cwd: '/work/app', home: '/home/me', mode }).decision
	assert.equal(run(m.resolveMode(undefined, undefined, 'default').mode), 'ask')
	assert.equal(run(m.resolveMode(undefined, undefined, 'acceptEdits').mode), 'allow')
})

const request = (n, extra = {}) => ({ at: 1000 + n, agent: 'agent', title: `Run command ${n}`, files: [], decision: 'allowed', kind: 'execute', rawInput: { command: `make ${n}` }, ...extra })

test('the permission inbox survives a reload, newest first, with secrets redacted and the cap kept', () => {
	const state = memento()
	const live = []
	for (let n = 0; n < 130; n++) {
		live.unshift(request(n))
		state.update(f.INBOX_KEY, f.inboxState(live.slice(0, f.MAX_REQUESTS)))
	}
	assert.equal(f.INBOX_KEY, 'flowHarness.inbox.v1')
	const back = f.sanitizeInbox(state.get(f.INBOX_KEY))
	assert.equal(back.length, 100)
	assert.equal(back[0].title, 'Run command 129', 'newest first')
	assert.equal(back[99].title, 'Run command 30')
	assert.deepEqual(back[0].rawInput, { command: 'make 129' })

	const secret = f.sanitizeInbox(f.inboxState([request(1, { title: 'Use sk-abcdefghijklmnopqrstuv', rawInput: { command: 'export API_KEY=hunter2hunter2 && make', other: 'dropped' }, files: ['/a/token=abcdef123456'] })]))[0]
	assert.doesNotMatch(JSON.stringify(secret), /sk-abcdef|hunter2|abcdef123456/)
	assert.match(secret.rawInput.command, /<secret>/)
	assert.equal(secret.rawInput.other, undefined, 'only the fields a rule is built from are kept')
})

test('damaged inbox data is ignored, entry by entry', () => {
	assert.deepEqual(f.sanitizeInbox(undefined), [])
	assert.deepEqual(f.sanitizeInbox('x'), [])
	assert.deepEqual(f.sanitizeInbox({ requests: 5 }), [])
	const good = request(1)
	const back = f.sanitizeInbox({ requests: [null, 7, { title: 'no time' }, { ...good, decision: 'maybe' }, { ...good, at: 'soon' }, good, { ...good, files: 'nope', rawInput: 'nope' }] })
	assert.equal(back.length, 2)
	assert.deepEqual(back[1].files, [])
	assert.equal(back[1].rawInput, undefined)
	assert.equal(f.sanitizeInbox({ requests: [{ ...good, title: 'x'.repeat(5000), files: Array.from({ length: 50 }, (_, i) => `/f${i}`) }] })[0].title.length, 300)
	assert.equal(f.sanitizeInbox({ requests: [{ ...good, files: Array.from({ length: 50 }, (_, i) => `/f${i}`) }] })[0].files.length, 10)
})

test('friction data survives a reload, redacted and capped, and damaged data gives an empty inbox', () => {
	const state = memento()
	const prompts = Array.from({ length: 350 }, (_, n) => ({ text: `Never use X ${n}`, at: n, cli: 'claude', session: 's' }))
	prompts.push({ text: 'Always export TOKEN=abcdefghijklmnop12345 first', at: 999, cli: 'claude' })
	const failures = Array.from({ length: 320 }, (_, n) => ({ tool: 'Bash', subject: `make ${n}`, error: 'Error: boom', at: n, cli: 'claude' }))
	failures.push({ tool: 'Bash', subject: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuv"', error: 'Error: 401', at: 1000, cli: 'claude' })
	state.update(f.FRICTION_KEY, f.frictionState({ prompts, failures, dismissed: ['fix:1', 'grant:Bash(ls:*)'] }))
	assert.equal(f.FRICTION_KEY, 'flowHarness.friction.v1')
	const back = f.sanitizeFriction(state.get(f.FRICTION_KEY))
	assert.equal(back.prompts.length, 300)
	assert.equal(back.failures.length, 300)
	assert.deepEqual(back.dismissed, ['fix:1', 'grant:Bash(ls:*)'])
	assert.doesNotMatch(JSON.stringify(back), /abcdefghijklmnop12345|Bearer abcdefghijklmnopqrstuv/)
	assert.equal(back.prompts.at(-1).at, 999, 'the newest stay')
	// What an earlier build stored under the unversioned key reads the same way.
	assert.equal(f.sanitizeFriction({ prompts: [{ text: 'Do not x', at: 1, cli: 'claude' }], failures: [], dismissed: [] }).prompts.length, 1)
	for (const bad of [undefined, null, 'x', 5, [], { prompts: 'a', failures: {}, dismissed: 3 }, { prompts: [null, { text: 1 }, { at: 1 }] }]) {
		assert.deepEqual(f.sanitizeFriction(bad), { prompts: [], failures: [], dismissed: [] })
	}
})

test('the stored lists stay inside their size limit by dropping the oldest', () => {
	const big = 'a '.repeat(500)
	const prompts = Array.from({ length: 300 }, (_, n) => ({ text: `${big}${n}`, at: n, cli: 'claude', session: 'x'.repeat(200) }))
	const back = f.sanitizeFriction({ prompts, failures: [], dismissed: [] })
	assert.ok(JSON.stringify(back.prompts).length <= 400_000)
	assert.ok(back.prompts.length > 100 && back.prompts.length <= 300)
	assert.equal(back.prompts.at(-1).at, 299)
})

test('every empty state names where its data comes from', () => {
	assert.equal(f.FRICTION_EMPTY, 'Nothing yet: Insilode only sees sessions started from its Agents dock (hook events). Past Claude transcripts are read when you open this view.')
	assert.equal(f.PERMISSIONS_EMPTY, 'Permission requests appear here for agents started from the Agents dock')
	assert.equal(f.GUARDS_EMPTY, 'No guards yet: they appear when you apply a failure fix')
	assert.match(f.FRICTION_EMPTY, /Agents dock/)
	assert.match(f.PERMISSIONS_EMPTY, /Agents dock/)
})
