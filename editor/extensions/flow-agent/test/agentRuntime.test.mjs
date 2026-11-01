// The agent runtime's defaults: which program runs the hooks (src/hookScript.ts), whether pull request news is sent without
// asking (src/prEventsCore.ts) and the one notice after Insilode installed the agents' extensions (src/agentExtensionsCore.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let h, p, x
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-runtime-'))
	const load = async file => {
		const outfile = join(tmp, `${file}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${file}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		return import(pathToFileURL(outfile).href)
	}
	h = await load('hookScript')
	p = await load('prEventsCore')
	x = await load('agentExtensionsCore')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

// ── Hooks run with plain node ─────────────────────────────────────────────────────────────────────

test('a node on PATH runs the hooks; the editor in Node mode only stands in when there is none', () => {
	const editor = 'C:\\Program Files\\Insilode\\Insilode.exe'
	assert.deepEqual(h.hookRunner('C:\\node\\node.exe', editor, true), { exe: 'C:\\node\\node.exe', electron: false })
	assert.deepEqual(h.hookRunner(undefined, editor, true), { exe: editor, electron: true })
	// Server mode: execPath is plain node already, so no ELECTRON_RUN_AS_NODE.
	assert.deepEqual(h.hookRunner(undefined, '/usr/bin/node', false), { exe: '/usr/bin/node', electron: false })
})

test('the Claude hook command quotes paths with spaces and, on Windows, writes them with forward slashes', () => {
	const found = { exe: 'C:\\Program Files\\nodejs\\node.exe', electron: false }
	assert.equal(h.claudeHookCommand(found, 'C:\\Users\\Ada Lovelace\\hooks\\flow-hook.js', 'win32'), '"C:/Program Files/nodejs/node.exe" "C:/Users/Ada Lovelace/hooks/flow-hook.js"')
	const fallback = { exe: 'C:\\Program Files\\Insilode\\Insilode.exe', electron: true }
	assert.equal(h.claudeHookCommand(fallback, 'C:\\h\\flow-hook.js', 'win32'), 'ELECTRON_RUN_AS_NODE=1 "C:/Program Files/Insilode/Insilode.exe" "C:/h/flow-hook.js"')
	assert.equal(h.claudeHookCommand({ exe: '/opt/my tools/node', electron: false }, '/home/a b/flow-hook.js', 'linux'), '"/opt/my tools/node" "/home/a b/flow-hook.js"')
	// What bash would still read inside double quotes is escaped.
	assert.equal(h.claudeHookCommand({ exe: '/x/node', electron: false }, '/home/a$b/`c`/"d"/e\\f.js', 'linux'), '"/x/node" "/home/a\\$b/\\`c\\`/\\"d\\"/e\\\\f.js"')
})

// ── pr.autoSend asks once ─────────────────────────────────────────────────────────────────────────

test('the send decision: a remembered answer wins over the setting, a button always sends', () => {
	const d = p.sendDecision
	// No answer yet: off holds, on asks before the first automatic send.
	assert.equal(d({ setting: false }), 'hold')
	assert.equal(d({ setting: true }), 'ask')
	// Always sends whatever the setting says; Never holds even when the setting is turned on explicitly later.
	assert.equal(d({ setting: true, answer: 'always' }), 'send')
	assert.equal(d({ setting: false, answer: 'always' }), 'send')
	assert.equal(d({ setting: true, answer: 'never' }), 'hold')
	assert.equal(d({ setting: false, answer: 'never' }), 'hold')
	// A button the user pressed sends, answer or not.
	for (const setting of [true, false]) {
		for (const answer of [undefined, 'always', 'never']) {
			assert.equal(d({ setting, answer, force: true }), 'send')
		}
	}
})

test('only the two answers are remembered; a hand-edited value counts as no answer', () => {
	assert.equal(p.parseAutoSendAnswer('always'), 'always')
	assert.equal(p.parseAutoSendAnswer('never'), 'never')
	for (const bad of [undefined, null, '', 'Always', 'yes', true, 1]) {
		assert.equal(p.parseAutoSendAnswer(bad), undefined, String(bad))
	}
	assert.equal(p.AUTO_SEND_ANSWER_KEY, 'flow.agents.pr.autoSendAnswer')
})

test('the question is one line naming the agent and the PR, and says it uses tokens', () => {
	const q = p.autoSendQuestion('Claude', 42)
	assert.equal(q, 'Insilode wants to tell Claude that PR #42 has news; this uses tokens')
	assert.ok(!q.includes('\n'))
})

// ── The install notice ────────────────────────────────────────────────────────────────────────────

test('the install notice names what was installed and the setting that turns it off', () => {
	assert.equal(x.installNotice(['anthropic.claude-code', 'openai.chatgpt'], false), 'Insilode installed Claude Code and Codex for VS Code from Open VSX. Turn this off with the setting flow.agents.installAgentExtensions.')
	assert.match(x.installNotice(['anthropic.claude-code'], false), /^Insilode installed Claude Code for VS Code from Open VSX\./)
	assert.match(x.installNotice(['openai.chatgpt'], false), /^Insilode installed Codex for VS Code/)
	assert.match(x.installNotice(['a.b', 'anthropic.claude-code', 'openai.chatgpt'], false), /^Insilode installed a\.b, Claude Code and Codex for VS Code/)
})

test('the notice is shown once, and never when nothing was installed', () => {
	assert.equal(x.installNotice([], false), undefined)
	assert.equal(x.installNotice([], true), undefined)
	// A later install (the second extension) does not repeat it.
	assert.equal(x.installNotice(['openai.chatgpt'], true), undefined)
	assert.equal(x.INSTALL_NOTICE_KEY, 'flow.agents.installNoticeShown')
})
