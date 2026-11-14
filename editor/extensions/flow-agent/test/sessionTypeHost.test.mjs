// The native chat's own session logic (src/sessionType.ts), built against a stub `vscode` and a stub adapter host (`./acp`): the gate
// on permission answers (an edit's "all edits", a plan's bypass), the adapter's duplicate mode report, a reset that fails, the mode
// being sent every turn, and an agent-driven change in one session not moving another. The pure decisions are in sessionType.test.mjs.
import { test, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const VSCODE = `
class EventEmitter { constructor() { this.l = [] } get event() { return f => { this.l.push(f); return { dispose: () => { this.l = this.l.filter(x => x !== f) } } } } fire(e) { for (const f of [...this.l]) f(e) } dispose() { this.l = [] } }
const S = () => globalThis.__stub
const disposable = () => ({ dispose() {} })
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color } }
class ThemeColor { constructor(id) { this.id = id } }
module.exports = {
	EventEmitter, ThemeIcon, ThemeColor,
	Disposable: class { constructor(f) { this.f = f } dispose() { this.f?.() } },
	Uri: { from: o => ({ ...o }), file: p => ({ scheme: 'file', path: p, fsPath: p }) },
	ChatSessionStatus: { Completed: 1, InProgress: 2, Failed: 3 },
	chat: {
		createChatSessionItemController: () => ({
			items: { replace() {}, add() {}, get() {} },
			createChatSessionItem: () => ({}),
			createChatSessionInputState: groups => { const l = []; return { groups, onDidChange: f => { l.push(f); return disposable() }, onDidDispose: () => disposable() } },
			dispose() {},
		}),
		createChatParticipant: () => ({ dispose() {} }),
		registerChatSessionContentProvider: disposable,
	},
	workspace: { workspaceFolders: [{ uri: { fsPath: '/work' } }], getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: disposable, asRelativePath: p => p },
	window: { showWarningMessage: (...a) => S().warn(...a), showInformationMessage: (...a) => S().info(...a) },
	commands: { registerCommand: disposable, executeCommand: async (id, ...args) => { S().commands.push([id, ...args]) } },
}`

// Only `explain` is used from ./acp at run time; the adapter host is the fake below.
const ACP = `module.exports = { AgentHost: class {}, explain: (k, e) => String(e?.message ?? e) }`

let tmp
let mod
before(async () => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-sessiontypehost-')))
	const outfile = join(tmp, 'sessionType.cjs')
	await build({
		entryPoints: [join(ROOT, 'src', 'sessionType.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent', external: ['@agentclientprotocol/sdk'],
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

const cfg = mode => [{ id: 'mode', name: 'Mode', type: 'select', currentValue: mode, options: ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'].map(v => ({ value: v, name: v })) }]
// A regression that leaves a promise pending must fail the test in seconds, not hang the file.
const T = { timeout: 5000 }
const tick = () => new Promise(r => setTimeout(r, 5))
const log = { warn() {}, info() {} }
const EDIT_OPTIONS = [
	{ optionId: 'allow-with-updates', name: 'Yes, allow all edits during this session', kind: 'allow_always' },
	{ optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
	{ optionId: 'reject', name: 'No', kind: 'reject_once' },
]
const PLAN_OPTIONS = [
	{ optionId: 'exit-plan-bypass', name: 'Yes, and bypass permissions', kind: 'allow_always' },
	{ optionId: 'exit-plan-accept-edits', name: 'Yes, and auto-accept edits', kind: 'allow_always' },
	{ optionId: 'exit-plan-default', name: 'Yes, and manually approve edits', kind: 'allow_once' },
	{ optionId: 'plan', name: 'No, keep planning', kind: 'reject_once' },
]

/** The adapter host: a `set` can be held (hold) to let a duplicate report arrive while the first is being decided. */
function fakeHost() {
	const listeners = () => ({ event: () => ({ dispose() {} }) })
	return {
		onDidExit: listeners().event,
		onAnyUpdate: listeners().event,
		setSink() {},
		async connection() {
			return {
				setSessionConfigOption: async ({ sessionId, configId, value }) => {
					S().calls.push(['set', sessionId, configId, value])
					if (S().hold) { await S().hold }
					if (S().failSet) { throw new Error('set failed') }
					return { configOptions: cfg(value) }
				},
				cancel: async p => { S().calls.push(['cancel', p.sessionId]) },
				closeSession: async p => { S().calls.push(['close', p.sessionId]) },
			}
		},
	}
}
const S = () => globalThis.__stub

/** A native chat with sessions already live in the adapter, each with the user mode given (the adapter itself is in plan or default). */
function make(sessions) {
	const st = new mod.AgentSessionType('claude', fakeHost(), log)
	for (const [id, user] of Object.entries(sessions)) {
		st.live.add(id)
		st.configs.set(id, cfg(user === 'plan' ? 'plan' : 'default'))
		st.approval.set(id, user)
		st.applied.set(id, user === 'plan' ? 'plan' : 'default')
	}
	return st
}
const asked = (st, id, toolKind, options, picked, token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }) => {
	globalThis.__stub.info = async () => picked
	const edits = { track: async () => { globalThis.__stub.tracked = true } }
	return st.askPermission({ sessionId: id, options, toolCall: { toolCallId: 't', kind: toolKind, title: 'Do it', locations: [{ path: '/work/a.ts' }] } }, edits, {}, token)
}
const sets = (value) => globalThis.__stub.calls.filter(c => c[0] === 'set' && c[3] === value).length

beforeEach(() => {
	globalThis.__stub = { calls: [], commands: [], warns: [], warnAnswer: undefined, failSet: false, hold: undefined, release: undefined, tracked: false }
	globalThis.__stub.warn = async (...a) => { globalThis.__stub.warns.push(a); return globalThis.__stub.warnAnswer }
})
// Whatever a test left held (a `set`, a modal) is let go, so nothing it started stays pending after it.
afterEach(() => { globalThis.__stub.release?.() })

test('"allow all edits" on an edit ask reaches the adapter as the plain allow-once, the chat takes acceptEdits, and the edit is still tracked', T, async () => {
	const st = make({ A: 'default' })
	const res = await asked(st, 'A', 'edit', EDIT_OPTIONS, EDIT_OPTIONS[0].name)
	assert.deepEqual(res, { outcome: { outcome: 'selected', optionId: 'allow-once' } })
	assert.equal(st.approval.get('A'), 'acceptEdits')
	assert.ok(globalThis.__stub.tracked, 'edits.track ran')
	assert.ok(globalThis.__stub.commands.some(c => c[0] === 'flow.agentWillEdit'), 'the canvas snapshot was taken')
	assert.equal(sets('acceptEdits'), 0, 'the adapter itself was never moved')
})

test('a plan answer of bypass asks first; a no sends the plain plan approval and the chat stays in default', T, async () => {
	const st = make({ A: 'plan' })
	globalThis.__stub.warnAnswer = undefined
	const res = await asked(st, 'A', 'switch_mode', PLAN_OPTIONS, PLAN_OPTIONS[0].name)
	assert.equal(globalThis.__stub.warns.length, 1)
	assert.deepEqual(res, { outcome: { outcome: 'selected', optionId: 'exit-plan-default' } })
	assert.equal(st.approval.get('A'), 'default')
	assert.equal(st.granted.has('A'), false)
})

test('a plan answer of bypass after a yes reaches the adapter, the report is adopted once, and the modal is not asked again', T, async () => {
	const st = make({ A: 'plan' })
	globalThis.__stub.warnAnswer = 'Switch Mode'
	const res = await asked(st, 'A', 'switch_mode', PLAN_OPTIONS, PLAN_OPTIONS[0].name)
	assert.equal(res.outcome.optionId, 'exit-plan-bypass')
	await st.followAgentMode('A', 'bypassPermissions')
	assert.equal(st.approval.get('A'), 'bypassPermissions')
	assert.equal(sets('default'), 1, 'the adapter was taken back to default')
	assert.equal(globalThis.__stub.warns.length, 1, 'confirmed once')
})

test('a plan answer that needs no warning (auto-accept edits in the own folder) is granted and adopted after the reset', T, async () => {
	const st = make({ A: 'plan' })
	await asked(st, 'A', 'switch_mode', PLAN_OPTIONS, PLAN_OPTIONS[1].name)
	assert.equal(globalThis.__stub.warns.length, 0)
	await st.followAgentMode('A', 'acceptEdits')
	assert.equal(st.approval.get('A'), 'acceptEdits')
})

test('an elevated report nobody asked for resets the adapter and leaves the chat in default', T, async () => {
	const st = make({ A: 'plan' })
	await st.followAgentMode('A', 'acceptEdits')
	assert.equal(st.approval.get('A'), 'default')
	assert.equal(sets('default'), 1)
})

test('the adapter\'s duplicate report does not overwrite the default the reset stored, so the echo of the reset changes nothing', T, async () => {
	const st = make({ A: 'plan' })
	st.granted.set('A', 'acceptEdits')
	let release
	globalThis.__stub.hold = new Promise(r => release = globalThis.__stub.release = r)
	const first = st.followAgentMode('A', 'acceptEdits')
	await tick()
	await st.followAgentMode('A', 'acceptEdits')
	assert.equal(st.applied.get('A'), 'default', 'the repeat left `applied` alone')
	release()
	await first
	await st.followAgentMode('A', 'default')
	assert.equal(st.approval.get('A'), 'acceptEdits')
	assert.equal(sets('default'), 1, 'one reset for two reports')
})

test('a reset that fails closes the session with a warning, and forgets it so it is loaded again', T, async () => {
	const st = make({ A: 'plan' })
	st.granted.set('A', 'bypassPermissions')
	globalThis.__stub.failSet = true
	await st.followAgentMode('A', 'bypassPermissions')
	const calls = globalThis.__stub.calls.map(c => c[0])
	assert.ok(calls.includes('cancel') && calls.includes('close'))
	assert.equal(st.live.has('A'), false)
	assert.equal(st.approval.has('A'), false)
})

test('every prompt sends the mode, even when the cached config already shows it', T, async () => {
	const st = make({ A: 'default' })
	await st.applyInput(await st.host.connection(), 'A', undefined, true)
	assert.equal(sets('default'), 1)
})

test('an agent leaving plan in session A does not move session B', T, async () => {
	const st = make({ A: 'plan', B: 'plan' })
	const uri = id => ({ scheme: 'flow-claude', path: '/' + id })
	const stateA = await st.inputState(uri('A'))
	const stateB = await st.inputState(uri('B'))
	await st.followAgentMode('A', 'default')
	assert.equal(st.approval.get('A'), 'default')
	assert.equal(stateA.groups.find(g => g.id === 'mode').selected.id, 'default')
	// The change event reaches B's picker too; its own selection did not move.
	await st.applyInput(await st.host.connection(), 'B', stateB)
	assert.equal(st.approval.get('B'), 'plan')
	assert.equal(stateB.groups.find(g => g.id === 'mode').selected.id, 'plan')
	assert.equal(sets('plan') + sets('default'), 0, 'B\'s adapter was sent nothing')
})

test('a chip write sends the mode only for the session whose own chip moved; a prompt sends it for its own session', async () => {
	const st = make({ A: 'default', B: 'default' })
	const uri = id => ({ scheme: 'flow-claude', path: '/' + id })
	const stateA = await st.inputState(uri('A'))
	const stateB = await st.inputState(uri('B'))
	const conn = await st.host.connection()
	// A's chip moves to plan: the change event reaches both pickers, and only A's adapter hears of it.
	const pick = state => { state.groups = state.groups.map(g => g.id === 'mode' ? { ...g, selected: g.items.find(i => i.id === 'plan') } : g) }
	pick(stateA)
	await st.applyInput(conn, 'A', stateA)
	await st.applyInput(conn, 'B', stateB)
	assert.deepEqual(globalThis.__stub.calls.filter(c => c[0] === 'set').map(c => c[1] + ':' + c[3]), ['A:plan'])
	assert.equal(st.approval.get('B'), 'default')
	// A prompt in B sends B's mode though its chip did not move.
	await st.applyInput(conn, 'B', stateB, true)
	assert.deepEqual(globalThis.__stub.calls.filter(c => c[0] === 'set').map(c => c[1] + ':' + c[3]), ['A:plan', 'B:default'])
})

test('a turn cancelled while the bypass modal is open leaves no grant: a later report of bypass is taken back to default without a modal', async () => {
	const st = make({ A: 'plan' })
	let answer
	globalThis.__stub.warn = (...a) => new Promise(r => { globalThis.__stub.warns.push(a); answer = r; globalThis.__stub.release = () => r(undefined) })
	const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
	const q = asked(st, 'A', 'switch_mode', PLAN_OPTIONS, PLAN_OPTIONS[0].name, token)
	await tick()
	assert.equal(globalThis.__stub.warns.length, 1)
	token.isCancellationRequested = true
	answer('Switch Mode')
	assert.deepEqual(await q, { outcome: { outcome: 'cancelled' } })
	assert.equal(st.granted.has('A'), false)
	globalThis.__stub.warns.length = 0
	await st.followAgentMode('A', 'bypassPermissions')
	assert.equal(st.approval.get('A'), 'default')
	assert.equal(globalThis.__stub.warns.length, 0, 'no modal for a report nobody asked for')
	assert.equal(sets('default'), 1)
})

test('a declined modal clears an earlier grant', async () => {
	const st = make({ A: 'plan' })
	st.granted.set('A', 'bypassPermissions')
	globalThis.__stub.warnAnswer = undefined
	await asked(st, 'A', 'switch_mode', PLAN_OPTIONS, PLAN_OPTIONS[0].name)
	assert.equal(st.granted.has('A'), false)
})
