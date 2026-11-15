// The vscode side of the page's terminals (src/termHost.ts) against a stub `vscode`: output is routed to the session the terminal
// belongs to, a closing terminal ends it, and opening a terminal in a foreign folder needs the user's own earlier action (never a modal of ours) and spawns hidden.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }

const VSCODE = `
class EventEmitter { constructor() { this.l = [] } get event() { return f => { this.l.push(f); return { dispose: () => { this.l = this.l.filter(x => x !== f) } } } } fire(e) { for (const f of [...this.l]) f(e) } }
// Two bundles load this stub, so the first one's emitters are kept.
globalThis.__vs ??= { write: new EventEmitter(), close: new EventEmitter(), warnings: [], dialogs: [], picks: [], executed: [], answer: 'Run Agent Here' }
const { write, close } = globalThis.__vs
module.exports = {
	window: {
		onDidWriteTerminalData: write.event, onDidCloseTerminal: close.event,
		showWarningMessage: async (message, options) => { globalThis.__vs.warnings.push({ message, options }); globalThis.__vs.onWarn?.(); return globalThis.__vs.answer },
		showInformationMessage: async () => undefined,
		showOpenDialog: async options => { globalThis.__vs.dialogs.push(options); return globalThis.__vs.picks.shift() },
	},
	workspace: { get isTrusted() { return globalThis.__vs.trusted !== false }, workspaceFolders: [] },
	commands: { executeCommand: async (...a) => { globalThis.__vs.executed.push(a); return true } },
}`

let tmp
let TermHost
let trust
before(async () => {
	// Native, as the product's own realpath is: it expands a Windows runner's 8.3 short temp name (RUNNER~1), the JavaScript one does not.
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-termhost-')))
	const outfile = join(tmp, 'termHost.cjs')
	await build({
		entryPoints: [join(ROOT, 'src', 'termHost.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
		plugins: [{ name: 'stub-vscode', setup: b => {
			b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }))
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE, loader: 'js' }))
		} }],
	})
	TermHost = (await import(pathToFileURL(outfile).href).then(m => m.default ?? m)).TermHost
	// folderTrust.ts on its own, for what the host does not expose (it is a second module instance: its picked folders are its own).
	const trustFile = join(tmp, 'folderTrust.cjs')
	await build({
		entryPoints: [join(ROOT, 'src', 'folderTrust.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: trustFile, logLevel: 'silent',
		plugins: [{ name: 'stub-vscode', setup: b => {
			b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }))
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE, loader: 'js' }))
		} }],
	})
	trust = await import(pathToFileURL(trustFile).href).then(m => m.default ?? m)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const SID = '0a99a3dd-7db0-4ba0-882d-a4dd922189be'

/** A host over a fake Agents: `terminals` is its session → terminal map, `spawns` what spawn was asked. */
function setup(live, indexed) {
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
	const host = new TermHost(agents, context, live, indexed)
	const vs = globalThis.__vs
	vs.warnings.length = 0
	vs.executed.length = 0
	vs.answer = 'Run Agent Here'
	vs.onWarn = undefined
	vs.trusted = true
	vs.dialogs.length = 0
	vs.picks.length = 0
	return { host, agents, terminals, sessions, spawns, vs, store, context }
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

test('a session id that belongs to a session of another CLI is refused: nothing is spawned over it', T, async () => {
	const t = setup()
	const terminal = { processId: Promise.resolve(1), sendText() {} }
	t.terminals.set(SID, terminal)
	t.sessions.set(SID, { id: SID, cli: 'claude', state: 'idle', name: 'Fix login' })
	await assert.rejects(t.host.open('codex', SID), /belongs to a Claude session/)
	assert.deepEqual(t.spawns, [], 'no resume record was made from it')
	assert.equal(t.terminals.get(SID), terminal, 'the Claude session keeps its terminal')
	assert.equal(t.sessions.get(SID).cli, 'claude')
	// The same holds for an ended one and for a Codex id that is a Claude row's agentId.
	t.sessions.set(SID, { id: SID, cli: 'claude', state: 'ended', name: 'Fix login' })
	await assert.rejects(t.host.open('codex', SID), /belongs to a Claude session/)
	assert.deepEqual(t.spawns, [])
})

test('a session that is running in another program is not resumed here', T, async () => {
	const t = setup(async id => id === SID ? 'Claude desktop' : undefined)
	await assert.rejects(t.host.open('claude', SID), /running in Claude desktop/)
	assert.deepEqual(t.spawns, [])
	// Another session, and a Codex one (it has no registry to ask), are not held back.
	await t.host.open('claude', '1b99a3dd-7db0-4ba0-882d-a4dd922189be')
	await t.host.open('codex', SID)
	assert.equal(t.spawns.length, 2)
})

test('the pane\'s size moves with a resumed session: the old terminal is released and the new one sized', T, async () => {
	const t = setup()
	const old = { processId: Promise.resolve(1), sendText() {} }
	const fresh = { processId: Promise.resolve(2), sendText() {} }
	t.terminals.set('a', old)
	t.vs.write.fire({ terminal: old, data: 'old output' })
	t.host.attach('a', sinkOf())
	assert.equal(await t.host.resize('a', 100, 30), true)
	t.vs.executed.length = 0
	t.terminals.set('a', fresh)
	t.vs.write.fire({ terminal: fresh, data: 'new output' })
	await wait(40)
	assert.deepEqual(t.vs.executed.map(e => e.slice(1)).sort(), [[1, undefined, undefined], [2, 100, 30]])
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

const pick = (t, dir) => { t.vs.picks.push([{ fsPath: dir }]); return t.host.pickFolder() }

test('a path the page made up, outside the workspace, is refused: no dialog, no question, nothing starts', T, async () => {
	const t = setup()
	const folder = join(tmp, 'project-a')
	mkdirSync(folder)
	await assert.rejects(t.host.open('claude', SID, folder), /not one of your projects\. Choose that folder with Change… first\./)
	await assert.rejects(t.host.open('codex', undefined, folder), /Choose that folder/)
	await assert.rejects(t.host.open('claude', undefined, join(tmp, 'missing')), /not a folder/)
	assert.equal(t.vs.warnings.length, 0, 'Insilode asks no question of its own')
	assert.equal(t.vs.dialogs.length, 0)
	assert.equal(t.spawns.length, 0)
})

test('a folder the user picked in the host\'s own dialog is allowed, by its real path, for this window session only', { ...T, skip: process.platform === 'win32' && 'a symbolic link needs a privilege a Windows runner does not have' }, async () => {
	const t = setup()
	const folder = join(tmp, 'project-b')
	const link = join(tmp, 'link-to-b')
	mkdirSync(folder)
	symlinkSync(folder, link)
	const answer = await pick(t, folder)
	assert.deepEqual(answer, { path: folder, name: 'project-b' })
	assert.equal(t.vs.dialogs.length, 1)
	assert.deepEqual({ ...t.vs.dialogs[0], title: undefined, openLabel: undefined }, { canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: undefined, openLabel: undefined })
	await t.host.open('claude', undefined, folder)
	await t.host.open('claude', undefined, link)
	assert.equal(t.spawns.length, 2, 'the same folder by another spelling')
	assert.equal(t.vs.warnings.length, 0)
	assert.deepEqual(t.store, {}, 'nothing is persisted')
	// A cancelled dialog, a file and a folder that is gone allow nothing.
	assert.equal(await t.host.pickFolder(), undefined)
	const other = join(tmp, 'project-b2')
	mkdirSync(other)
	assert.equal(await pick(t, join(tmp, 'missing-b')), undefined)
	await assert.rejects(t.host.open('claude', undefined, other), /Choose that folder/)
})

test('a folder the project index lists (the user ran an agent there) and a stored earlier yes are allowed', T, async () => {
	const listed = join(tmp, 'project-c')
	const stored = join(tmp, 'project-d2')
	const stray = join(tmp, 'project-c2')
	for (const d of [listed, stored, stray]) { mkdirSync(d) }
	const t = setup(undefined, async () => [listed, join(tmp, 'gone-project')])
	t.store['flow.agents.trustedFolders'] = [stored]
	await t.host.open('claude', undefined, listed)
	await t.host.open('claude', undefined, stored)
	assert.equal(t.spawns.length, 2)
	await assert.rejects(t.host.open('claude', undefined, stray), /Choose that folder/)
	assert.equal(t.vs.warnings.length, 0)
	// An index that cannot be read allows nothing.
	const broken = setup(undefined, async () => { throw new Error('no index') })
	await assert.rejects(broken.host.open('claude', undefined, listed), /Choose that folder/)
})

test('a listed folder is matched by its real path, not its spelling', { ...T, skip: process.platform === 'win32' && 'a symbolic link needs a privilege a Windows runner does not have' }, async () => {
	const folder = join(tmp, 'project-c3')
	const link = join(tmp, 'link-to-c3')
	mkdirSync(folder)
	symlinkSync(folder, link)
	const t = setup(undefined, async () => [folder])
	await t.host.open('claude', undefined, link)
	assert.equal(t.spawns.length, 1)
})

test('forgetting takes back the folders picked in this window and the stored ones', T, async () => {
	const t = setup()
	const folder = join(tmp, 'project-f')
	const stored = join(tmp, 'project-f2')
	mkdirSync(folder)
	mkdirSync(stored)
	const context = { globalState: { get: (k, d) => t.store[k] ?? d, update: async (k, v) => { if (v === undefined) { delete t.store[k] } else { t.store[k] = v } } } }
	t.vs.picks.push([{ fsPath: folder }])
	await trust.pickFolder()
	t.store['flow.agents.trustedFolders'] = [stored]
	await trust.trustFolder(context, folder)
	await trust.trustFolder(context, stored)
	await trust.forgetTrustedFolders(context)
	await assert.rejects(trust.trustFolder(context, folder), /Choose that folder/)
	await assert.rejects(trust.trustFolder(context, stored), /Choose that folder/)
})

test('the folder is checked again right before the agent starts: a link pointed elsewhere while the session was being looked up is refused', { ...T, skip: process.platform === 'win32' && 'a symbolic link needs a privilege a Windows runner does not have' }, async () => {
	const real = join(tmp, 'real-folder')
	const elsewhere = join(tmp, 'elsewhere')
	const link = join(tmp, 'link-to-folder')
	mkdirSync(real)
	mkdirSync(elsewhere)
	symlinkSync(real, link)
	// The project index is read after the folder was resolved: the link moves in between.
	const t = setup(undefined, async () => { unlinkSync(link); symlinkSync(elsewhere, link); return [real] })
	await assert.rejects(t.host.open('claude', SID, link), /folder changed/)
	assert.equal(t.spawns.length, 0)
})

test('a session that started elsewhere while the folder was being checked is not resumed: the registry is asked again', T, async () => {
	let asks = 0
	const folder = join(tmp, 'project-e')
	mkdirSync(folder)
	const t = setup(async () => ++asks > 1 ? 'Claude Code CLI' : undefined, async () => [folder])
	await assert.rejects(t.host.open('claude', SID, folder), /running in Claude Code CLI/)
	assert.equal(asks, 2)
	assert.equal(t.vs.warnings.length, 0)
	assert.equal(t.spawns.length, 0)
})

test('control characters in a folder name never reach a sentence', { ...T, skip: process.platform === 'win32' && 'a Windows file name cannot hold a control character' }, async () => {
	const t = setup()
	const odd = join(tmp, 'bad\nname\u001b[31m')
	mkdirSync(odd)
	const refused = await t.host.open('claude', undefined, odd).then(() => undefined, e => e)
	assert.match(refused.message, /Choose that folder/)
	assert.doesNotMatch(refused.message, /[\u0000-\u001f]/)
})

test('in a workspace that is not trusted no agent starts in a folder, and nothing is asked', T, async () => {
	const t = setup()
	t.vs.trusted = false
	const folder = join(tmp, 'project-d')
	mkdirSync(folder)
	await assert.rejects(t.host.open('claude', undefined, folder), /Trust this workspace/)
	assert.equal(t.vs.warnings.length, 0)
	assert.equal(t.spawns.length, 0)
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

// A session another process runs (the registry): the plain request is refused with a sentence the page can offer "Resume anyway" for; a
// forced one is honoured only after this host has shown its own modal warning and the user chose it.
test('a session another program runs is refused with a flagged error; force asks the user in a modal first, and only a yes spawns, without a second registry check', T, async () => {
	const where = { source: 'Claude desktop', pid: 4242 }
	const lookups = []
	const t = setup(async id => { lookups.push(id); return where.source })
	const refused = await t.host.open('claude', SID).then(() => undefined, e => e)
	assert.match(refused.message, /running in Claude desktop.*Close it there first\./)
	assert.equal(refused.elsewhere, true)
	assert.equal(t.spawns.length, 0)
	assert.equal(t.vs.warnings.length, 0, 'the plain request shows no modal: the page shows its own button')
	// Declined: nothing starts, and the page keeps the offer.
	t.vs.answer = undefined
	const declined = await t.host.open('claude', SID, undefined, true).then(() => undefined, e => e)
	assert.equal(declined.elsewhere, true)
	assert.equal(t.vs.warnings.length, 1)
	assert.deepEqual(t.vs.warnings[0].options.modal, true)
	assert.match(t.vs.warnings[0].options.detail, /corrupt/i)
	assert.equal(t.spawns.length, 0)
	// Confirmed: starts, passing on that the user has been asked.
	t.vs.answer = 'Resume anyway'
	assert.equal(await t.host.open('claude', SID, undefined, true), SID)
	assert.equal(t.vs.warnings.length, 2)
	assert.equal(t.spawns.length, 1)
	assert.equal(t.spawns[0][4].confirmed, true)
})

test('force on a session nothing else runs shows no modal and is just an open; a forced and a plain request for one session are not merged', T, async () => {
	const t = setup(async () => undefined)
	assert.equal(await t.host.open('claude', SID, undefined, true), SID)
	assert.equal(t.vs.warnings.length, 0)
	assert.equal(t.spawns[0][4].confirmed, undefined)
	const gate = setup(async () => { await wait(30); return 'Claude desktop' })
	const plain = gate.host.open('claude', SID).then(() => 'opened', e => e.elsewhere ? 'refused' : 'other')
	gate.vs.answer = 'Resume anyway'
	const forced = gate.host.open('claude', SID, undefined, true).then(() => 'opened', () => 'failed')
	assert.deepEqual(await Promise.all([plain, forced]), ['refused', 'opened'])
})
