// The host side of the status island (src/desktop.ts) against a stub `vscode`: the context key that the menu entries read follows what
// the settings ask for at once, and then core's answer; a core that answers with nothing leaves it to the setting.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VSCODE = `
const S = () => globalThis.__stub
const none = () => ({ dispose() {} })
class EventEmitter { constructor() { this.l = [] } get event() { return f => { this.l.push(f); return none() } } fire(e) { for (const f of this.l) f(e) } dispose() {} }
module.exports = {
	EventEmitter,
	StatusBarAlignment: { Right: 2 },
	ConfigurationTarget: { Global: 1 },
	workspace: {
		getConfiguration: () => ({ get: k => S().settings[k], inspect: k => ({ globalValue: S().settings[k] }), update: async () => undefined }),
		onDidChangeConfiguration: none,
	},
	window: { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }), showInformationMessage: async () => undefined },
	commands: {
		getCommands: async () => ['flow.desktop.setBadge', 'flow.desktop.setOverlay'],
		registerCommand: none,
		executeCommand: async (id, ...args) => { if (id === 'setContext') { S().ctx.push(args[1]); return } if (id === 'flow.desktop.setOverlay') { return new Promise(r => { S().answer = r }) } },
	},
}`

let tmp
let DesktopStatus
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-desktopstatus-'))
	const outfile = join(tmp, 'desktop.cjs')
	await build({
		entryPoints: [join(ROOT, 'src', 'desktop.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent',
		plugins: [{ name: 'stub-vscode', setup: b => {
			b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }))
			b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: VSCODE, loader: 'js' }))
		} }],
	})
	DesktopStatus = (await import(pathToFileURL(outfile).href).then(m => m.default ?? m)).DesktopStatus
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const tick = () => new Promise(r => setTimeout(r, 10))

async function run(settings, reply) {
	globalThis.__stub = { settings, ctx: [], answer: undefined }
	const agents = { sessions: new Map(), needsYou: 0, onDidChange: () => ({ dispose() {} }) }
	const status = new DesktopStatus(agents, { warn() {} })
	await tick()
	const before = [...globalThis.__stub.ctx]
	globalThis.__stub.answer(reply)
	await tick()
	const out = { before, after: globalThis.__stub.ctx.at(-1) }
	status.dispose()
	return out
}

test('an island the setting turned on is on in the menus before core answers, so Show does not flash', async () => {
	const r = await run({ 'overlay.enabled': true }, true)
	assert.equal(r.before.at(-1), true)
	assert.equal(r.after, true)
})

test('core\'s answer wins once it comes: the island it does not draw turns the key off', async () => {
	assert.equal((await run({ 'overlay.enabled': true }, false)).after, false)
})

test('a core that answers with nothing (an older one) leaves it to the setting\'s own value', async () => {
	assert.equal((await run({ 'overlay.enabled': true }, undefined)).after, true)
	assert.equal((await run({ 'overlay.enabled': true }, 'yes')).after, true)
})
