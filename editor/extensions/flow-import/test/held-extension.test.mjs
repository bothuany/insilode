// The held back settings and the first-start offer end to end (src/extension.ts), against the stand-in for `vscode`:
// nothing held back is written without Review or Import anyway, the offer is marked answered only by an explicit
// answer, and with several editors it asks which one.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMMAND = 'flow.importFromVSCode'
const OFFERED = 'flowImport.offered'

const fake = globalThis.__vscodeFake = {}
let ext
let vscode
let tmp
let user
let state

before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-import-held-'))
	const outfile = join(tmp, 'extension.cjs')
	await build({ entryPoints: [join(ROOT, 'src', 'extension.ts')], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent', mainFields: ['module', 'main'], alias: { vscode: join(ROOT, 'test', 'vscode-fake.cjs') } })
	const require = createRequire(import.meta.url)
	ext = require(outfile)
	vscode = require('./vscode-fake.cjs')
	user = join(tmp, 'insilode', 'User')
})
after(() => {
	rmSync(tmp, { recursive: true, force: true })
	delete process.env.INSILODE_IMPORT_HOME
	delete process.env.VSCODE_EXTENSIONS
})

beforeEach(() => {
	rmSync(user, { recursive: true, force: true })
	mkdirSync(user, { recursive: true })
	for (const k of ['readHook', 'quickPick', 'install', 'onInfo', 'onWarning', 'remoteName', 'uiKind']) {
		delete fake[k]
	}
	fake.extensions = []
	fake.messages = []
	fake.log = []
	fake.appRoot = join(tmp, 'app')
	mkdirSync(fake.appRoot, { recursive: true })
	writeFileSync(join(fake.appRoot, 'product.json'), '{}')
	process.env.VSCODE_EXTENSIONS = join(tmp, 'no-extensions')
})

/** Starts the extension as a first start would, with `offered` as the stored answer. */
function activate(offered) {
	state = new Map(offered ? [[OFFERED, true]] : [])
	const context = {
		subscriptions: [],
		globalState: { get: k => state.get(k), update: async (k, v) => { state.set(k, v) } },
		globalStorageUri: vscode.Uri.file(join(user, 'globalStorage', 'flow.flow-import')),
		extension: { extensionKind: vscode.ExtensionKind.UI },
	}
	ext.activate(context)
	return context
}

const roots = { win32: ['AppData', 'Roaming'], darwin: ['Library', 'Application Support'] }
/** A home with one User folder per editor folder name (`Code`, `Cursor`, ...). */
function home(name, editors) {
	const dir = join(tmp, name)
	for (const [folder, settings] of Object.entries(editors)) {
		const userDir = join(dir, ...(roots[process.platform] ?? ['.config']), folder, 'User')
		mkdirSync(userDir, { recursive: true })
		if (settings !== undefined) {
			writeFileSync(join(userDir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, '\t'))
		}
	}
	process.env.INSILODE_IMPORT_HOME = dir
}

const read = () => JSON.parse(readFileSync(join(user, 'settings.json'), 'utf8'))
const infos = () => fake.messages.filter(m => m.level === 'info').map(m => m.message)
const until = async (check) => {
	for (let i = 0; i < 200 && !check(); i++) {
		await new Promise(r => setTimeout(r, 5))
	}
	assert.ok(check(), 'timed out')
}
const SETTINGS = {
	'editor.tabSize': 2,
	'git.path': 'C:\\git\\git.exe',
	'security.workspace.trust.enabled': false,
	'terminal.integrated.shell.linux': '/bin/zsh',
}
const answer = (...picks) => (message, items) => {
	if (/held back for review/.test(message)) {
		return picks.shift()
	}
	return undefined
}

test('held back settings are not written, and the notification says how many', async () => {
	home('held-1', { Code: SETTINGS })
	const context = activate(true)
	fake.onInfo = answer(undefined)
	await vscode.commands.executeCommand(COMMAND)
	await until(() => infos().some(m => /held back for review/.test(m)))
	assert.ok(infos().includes('Imported 1 settings; 3 held back for review'))
	assert.deepEqual(read(), { 'editor.tabSize': 2 })
	context.subscriptions.length = 0
})

test('Review imports only the checked settings', async () => {
	home('held-2', { Code: SETTINGS })
	activate(true)
	fake.onInfo = answer('Review')
	let shown
	fake.quickPick = (items, options) => {
		if (options?.canPickMany && items[0]?.key) {
			shown = items
			return items.filter(i => i.label === 'git.path')
		}
		return options?.canPickMany ? items : items[0]
	}
	await vscode.commands.executeCommand(COMMAND)
	await until(() => infos().some(m => /Imported 1 held back/.test(m)))
	assert.deepEqual(shown.map(i => i.label).sort(), ['git.path', 'security.workspace.trust.enabled', 'terminal.integrated.shell.linux'])
	assert.ok(shown.every(i => i.detail && i.description))
	assert.deepEqual(read(), { 'editor.tabSize': 2, 'git.path': 'C:\\git\\git.exe' })
})

test('Review with nothing checked imports nothing', async () => {
	home('held-3', { Code: SETTINGS })
	activate(true)
	fake.onInfo = answer('Review')
	let asked = false
	fake.quickPick = (items, options) => {
		if (options?.canPickMany && items[0]?.key) {
			asked = true
			return []
		}
		return options?.canPickMany ? items : items[0]
	}
	await vscode.commands.executeCommand(COMMAND)
	await until(() => asked)
	await new Promise(r => setTimeout(r, 30))
	assert.deepEqual(read(), { 'editor.tabSize': 2 })
})

test('Import anyway asks in a modal naming the keys, and imports all only after Import', async () => {
	home('held-4', { Code: SETTINGS })
	activate(true)
	fake.onInfo = answer('Import anyway')
	const modals = []
	fake.onWarning = (message, options, items) => {
		modals.push({ message, options })
		return 'Import'
	}
	await vscode.commands.executeCommand(COMMAND)
	await until(() => infos().some(m => /Imported 3 held back/.test(m)))
	assert.equal(modals.length, 1)
	assert.equal(modals[0].options.modal, true)
	assert.match(modals[0].options.detail, /git\.path/)
	assert.deepEqual(read(), { 'editor.tabSize': 2, ...SETTINGS })
})

test('Import anyway declined in the modal imports nothing', async () => {
	home('held-5', { Code: SETTINGS })
	activate(true)
	fake.onInfo = answer('Import anyway')
	let asked = false
	fake.onWarning = () => { asked = true; return undefined }
	await vscode.commands.executeCommand(COMMAND)
	await until(() => asked)
	await new Promise(r => setTimeout(r, 30))
	assert.deepEqual(read(), { 'editor.tabSize': 2 })
})

test('a held back key that appeared in Insilode meanwhile is not overwritten by Review', async () => {
	home('held-6', { Code: SETTINGS })
	activate(true)
	fake.onInfo = answer('Review')
	fake.quickPick = (items, options) => {
		if (options?.canPickMany && items[0]?.key) {
			// The user sets it themselves while the list is open.
			writeFileSync(join(user, 'settings.json'), JSON.stringify({ ...read(), 'git.path': '/mine/git' }))
			return items.filter(i => i.label === 'git.path')
		}
		return options?.canPickMany ? items : items[0]
	}
	await vscode.commands.executeCommand(COMMAND)
	await until(() => infos().some(m => /Nothing was imported/.test(m)))
	assert.equal(read()['git.path'], '/mine/git')
})

test('the offer: Not now and a closed notification leave it open, Never closes it for good', async () => {
	home('offer-1', { Code: { 'editor.tabSize': 2 } })
	for (const [pick, marked] of [['Not now', false], [undefined, false], ['Never', true]]) {
		fake.onInfo = message => /Coming from/.test(message) ? pick : undefined
		const context = activate(false)
		await until(() => infos().some(m => /Coming from/.test(m)))
		await new Promise(r => setTimeout(r, 20))
		assert.equal(!!state.get(OFFERED), marked, String(pick))
		fake.messages = []
		context.subscriptions.length = 0
	}
	assert.equal(existsSync(join(user, 'settings.json')), false, 'nothing was imported')
})

test('the offer: a successful import marks it answered, one that was cancelled does not', async () => {
	home('offer-2', { Code: { 'editor.tabSize': 2 } })
	fake.onInfo = message => /Coming from/.test(message) ? 'Import from VS Code' : undefined
	fake.quickPick = (items, options) => options?.canPickMany ? [] : items[0]
	activate(false)
	await until(() => infos().some(m => /Coming from/.test(m)))
	await new Promise(r => setTimeout(r, 30))
	assert.equal(state.get(OFFERED), undefined, 'the list was closed with nothing chosen')

	fake.messages = []
	fake.quickPick = undefined
	activate(false)
	await until(() => state.get(OFFERED) === true)
	assert.deepEqual(read(), { 'editor.tabSize': 2 })
})

test('the offer with several editors asks which one, and imports the chosen one', async () => {
	home('offer-3', { Code: { 'editor.tabSize': 2 }, Cursor: { 'editor.tabSize': 8 }, Windsurf: undefined })
	fake.onInfo = message => /Coming from/.test(message) ? 'Import…' : undefined
	let sourceItems
	fake.quickPick = (items, options) => {
		if (items[0]?.source) {
			sourceItems = items
			return items.find(i => i.label === 'Cursor')
		}
		return options?.canPickMany ? items : items[0]
	}
	activate(false)
	await until(() => state.get(OFFERED) === true)
	assert.deepEqual(sourceItems.map(i => i.label), ['VS Code', 'Cursor', 'Windsurf'])
	assert.ok(sourceItems.every(i => i.description && i.detail))
	assert.deepEqual(read(), { 'editor.tabSize': 8 })
})

test('the offer with several editors: closing the source list is not an answer', async () => {
	home('offer-4', { Code: { 'editor.tabSize': 2 }, Cursor: { 'editor.tabSize': 8 } })
	fake.onInfo = message => /Coming from/.test(message) ? 'Import…' : undefined
	let asked = false
	fake.quickPick = items => { asked = !!items[0]?.source; return undefined }
	activate(false)
	await until(() => asked)
	await new Promise(r => setTimeout(r, 30))
	assert.equal(state.get(OFFERED), undefined)
	assert.equal(existsSync(join(user, 'settings.json')), false)
})
