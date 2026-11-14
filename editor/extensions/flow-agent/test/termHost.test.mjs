// The vscode side of the page's terminals (src/termHost.ts) against a stub `vscode`: output is routed to the session the terminal
// belongs to, a closing terminal ends it, and opening a terminal asks about a foreign folder once and spawns hidden.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }

const VSCODE = `
class EventEmitter { constructor() { this.l = [] } get event() { return f => { this.l.push(f); return { dispose: () => { this.l = this.l.filter(x => x !== f) } } } } fire(e) { for (const f of [...this.l]) f(e) } }
const write = new EventEmitter(), close = new EventEmitter()
globalThis.__vs = { write, close, warnings: [], executed: [], answer: 'Run Agent Here' }
module.exports = {
	window: {
		onDidWriteTerminalData: write.event, onDidCloseTerminal: close.event,
		showWarningMessage: async (message, options) => { globalThis.__vs.warnings.push({ message, options }); return globalThis.__vs.answer },
		showInformationMessage: async () => undefined,
	},
	workspace: { isTrusted: true, workspaceFolders: [] },
	commands: { executeCommand: async (...a) => { globalThis.__vs.executed.push(a); return true } },
}`

let tmp
let TermHost
before(async () => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-termhost-')))
	const outfile = join(tmp, 'termHost.cjs')
	await build({
		entryPoints: [join(ROOT, 'src', 'termHost.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
		plugins: [{ name: 'stub-vscode', setup: b => {
			b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }))
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE, loader: 'js' }))
		} }],
	})
	TermHost = (await import(pathToFileURL(outfile).href).then(m => m.default ?? m)).TermHost
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const SID = '0a99a3dd-7db0-4ba0-882d-a4dd922189be'

/** A host over a fake Agents: `terminals` is its session → terminal map, `spawns` what spawn was asked. */
function setup() {
	const terminals = new Map()
	const sessions = new Map()
	const spawns = []
	const agents = {
		sessions,
		terminalOf: id => terminals.get(id),
		sessionOf: t => [...terminals].find(([, x]) => x === t)?.[0],
		spawn: async (...args) => {
			spawns.push(args)
			const id = args[1]?.id ?? 'fresh'
			const s = { id, cli: args[0], state: 'starting', todos: [] }
			sessions.set(id, s)
			terminals.set(id, { processId: Promise.resolve(7), sendText() {} })
			return s
		},
	}
	const store = {}
	const context = { globalState: { get: (k, d) => store[k] ?? d, update: async (k, v) => { store[k] = v } } }
	const host = new TermHost(agents, context)
	const vs = globalThis.__vs
	vs.warnings.length = 0
	vs.executed.length = 0
	vs.answer = 'Run Agent Here'
	return { host, agents, terminals, sessions, spawns, vs }
}

const sinkOf = () => { const got = []; return { got, data: (d, reset) => got.push(reset ? ['reset', d] : d), gone: () => got.push('gone') } }
const wait = ms => new Promise(r => setTimeout(r, ms))

test('a terminal\'s output goes to its session only, a terminal no agent owns is ignored, and closing it ends the session', T, async () => {
	const t = setup()
	const one = { processId: Promise.resolve(1), sendText() {} }
	const two = { processId: Promise.resolve(2), sendText() {} }
	t.terminals.set('a', one)
	t.terminals.set('b', two)
	t.vs.write.fire({ terminal: one, data: 'hello ' })
	t.vs.write.fire({ terminal: { stray: true }, data: 'LEAK' })
	const sink = sinkOf()
	assert.equal(t.host.attach('a', sink).replay, 'hello ')
	t.vs.write.fire({ terminal: two, data: 'LEAK2' })
	t.vs.write.fire({ terminal: one, data: 'world' })
	await wait(40)
	assert.deepEqual(sink.got, ['world'])
	// Agents forgets a closed terminal before this host hears of it.
	t.terminals.delete('a')
	t.vs.close.fire(one)
	assert.deepEqual(sink.got, ['world', 'gone'])
	assert.equal(t.host.attach('a', sinkOf()), undefined)
})

test('a terminal that never printed is still matched to its session when it closes', T, () => {
	const t = setup()
	const one = { processId: Promise.resolve(1), sendText() {} }
	t.terminals.set('a', one)
	const sink = sinkOf()
	t.host.attach('a', sink)
	t.terminals.delete('a')
	t.vs.close.fire(one)
	assert.deepEqual(sink.got, ['gone'])
})

test('a resumed session in a new terminal starts the replay over; the old terminal closing later does not end it', T, async () => {
	const t = setup()
	const old = { processId: Promise.resolve(1), sendText() {} }
	const fresh = { processId: Promise.resolve(2), sendText() {} }
	t.terminals.set('a', old)
	t.vs.write.fire({ terminal: old, data: 'old output' })
	const sink = sinkOf()
	t.host.attach('a', sink)
	t.terminals.set('a', fresh)
	t.vs.write.fire({ terminal: fresh, data: 'new output' })
	await wait(40)
	assert.deepEqual(sink.got, [['reset', ''], 'new output'])
	t.vs.close.fire(old)
	assert.deepEqual(sink.got, [['reset', ''], 'new output'], 'the session lives on in the new terminal')
})

test('size goes through the core command with the process id', T, async () => {
	const t = setup()
	t.terminals.set('a', { processId: Promise.resolve(42), sendText() {} })
	t.host.attach('a', sinkOf())
	assert.equal(await t.host.resize('a', 100, 30), true)
	assert.deepEqual(t.vs.executed, [['_insilode.terminal.setDimensions', 42, 100, 30]])
})

test('input is refused for an agent that ended', T, () => {
	const t = setup()
	const typed = []
	t.terminals.set('a', { processId: Promise.resolve(1), sendText: (x, e) => typed.push([x, e]) })
	t.sessions.set('a', { id: 'a', state: 'idle' })
	assert.equal(t.host.input('a', 'x'), true)
	t.sessions.get('a').state = 'ended'
	assert.equal(t.host.input('a', 'y'), false)
	assert.deepEqual(typed, [['x', false]])
})

test('opening a session already running in this window spawns nothing', T, async () => {
	const t = setup()
	t.terminals.set(SID, {})
	t.sessions.set(SID, { id: SID, cli: 'claude', state: 'idle' })
	assert.equal(await t.host.open('claude', SID), SID)
	t.terminals.set('codex-record', {})
	t.sessions.set('codex-record', { id: 'codex-record', cli: 'codex', state: 'idle', agentId: SID })
	assert.equal(await t.host.open('codex', SID), 'codex-record', 'a Codex session is found by its own id too')
	assert.deepEqual(t.spawns, [])
})

test('a new session spawns hidden in this window\'s folder, with no question', T, async () => {
	const t = setup()
	assert.equal(await t.host.open('codex'), 'fresh')
	assert.deepEqual(t.spawns, [['codex', undefined, undefined, undefined, { cwd: undefined, quiet: true }]])
	assert.deepEqual(t.vs.warnings, [])
})

test('an ended session of this window is resumed from its own record, and an unknown one from a bare record', T, async () => {
	const t = setup()
	const ended = { id: SID, cli: 'claude', state: 'ended', name: 'Fix login', todos: [] }
	t.sessions.set(SID, ended)
	await t.host.open('claude', SID)
	assert.equal(t.spawns[0][1], ended)
	const other = '1b99a3dd-7db0-4ba0-882d-a4dd922189be'
	await t.host.open('codex', other)
	assert.deepEqual({ ...t.spawns[1][1], since: 0 }, { id: other, cli: 'codex', name: '', state: 'ended', since: 0, todos: [], unread: false, agentId: other })
})

test('a folder outside the workspace is asked about once and kept; refusing, or a path that is no folder, starts nothing', T, async () => {
	const t = setup()
	const folder = join(tmp, 'project-a')
	mkdirSync(folder)
	await t.host.open('claude', SID, folder)
	assert.equal(t.vs.warnings.length, 1)
	assert.ok(t.vs.warnings[0].message.includes(folder))
	assert.equal(t.vs.warnings[0].options.modal, true)
	assert.deepEqual(t.spawns[0].slice(4), [{ cwd: folder, quiet: true }])
	t.sessions.delete(SID)
	t.terminals.delete(SID)
	await t.host.open('claude', SID, folder)
	assert.equal(t.vs.warnings.length, 1, 'trusted by its real path: not asked again')
	assert.equal(t.spawns.length, 2)

	const other = join(tmp, 'project-b')
	mkdirSync(other)
	t.vs.answer = undefined
	await assert.rejects(t.host.open('claude', undefined, other), /not allowed to run in that folder/)
	await assert.rejects(t.host.open('claude', undefined, join(tmp, 'missing')), /not a folder/)
	assert.equal(t.spawns.length, 2)
})

test('two asks for the same session at once start one terminal', T, async () => {
	const t = setup()
	const [a, b] = await Promise.all([t.host.open('claude', SID), t.host.open('claude', SID)])
	assert.equal(a, b)
	assert.equal(t.spawns.length, 1)
})

test('a spawn that fails (a notice says why) is a sentence for the page', T, async () => {
	const t = setup()
	t.agents.spawn = async () => undefined
	await assert.rejects(t.host.open('claude'), /did not start/)
})
