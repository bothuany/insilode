// A small stand-in for the `vscode` module, enough to run src/extension.ts in Node: files go to the real disk, and
// everything a person or the workbench would answer (quick picks, installs, file errors) is up to the test, through
// `globalThis.__vscodeFake`. Bundled in place of `vscode` by test/extension.test.mjs.
const fs = require('node:fs')
const path = require('node:path')

const state = globalThis.__vscodeFake ??= {}

class FileSystemError extends Error {
	constructor(message, code = 'Unknown') {
		super(message)
		this.code = code
		this.name = `${code} (FileSystemError)`
	}
	static FileNotFound(m) { return new FileSystemError(String(m), 'FileNotFound') }
	static NoPermissions(m) { return new FileSystemError(String(m), 'NoPermissions') }
	static Unavailable(m) { return new FileSystemError(String(m), 'Unavailable') }
}

class Uri {
	constructor(scheme, p) {
		this.scheme = scheme
		this.path = p
	}
	get fsPath() { return this.path }
	static file(p) { return new Uri('file', p) }
	static from({ scheme, path: p }) { return new Uri(scheme, p) }
	static joinPath(u, ...parts) { return new Uri(u.scheme, path.join(u.path, ...parts)) }
	toString() { return `${this.scheme}://${this.path}` }
}

// Kept in the shared state: the bundle under test and the test itself each load their own copy of this file.
const commands = state.commands ??= new Map()
// The test throws the fake's own error class, so `instanceof` and `code` hold as in the editor.
state.FileSystemError = FileSystemError

module.exports = {
	FileSystemError,
	Uri,
	UIKind: { Desktop: 1, Web: 2 },
	ExtensionKind: { UI: 1, Workspace: 2 },
	ProgressLocation: { Notification: 15 },
	env: {
		get uiKind() { return state.uiKind ?? 1 },
		get remoteName() { return state.remoteName },
		get appRoot() { return state.appRoot ?? '/nowhere' },
	},
	workspace: {
		fs: {
			async readFile(uri) {
				// The test may make a read fail the way a locked file does (EBUSY, EPERM).
				state.readHook?.(uri)
				try {
					return fs.readFileSync(uri.fsPath)
				} catch (e) {
					throw e.code === 'ENOENT' ? FileSystemError.FileNotFound(e.message) : new FileSystemError(e.message)
				}
			},
			async writeFile(uri, bytes) {
				fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true })
				fs.writeFileSync(uri.fsPath, bytes)
			},
		},
	},
	window: {
		createOutputChannel() {
			const log = (level) => (line) => (state.log ??= []).push(`${level} ${line}`)
			return { info: log('info'), warn: log('warn'), error: log('error'), show() { }, dispose() { } }
		},
		showInformationMessage(message, ...items) {
			(state.messages ??= []).push({ level: 'info', message })
			return Promise.resolve(state.onInfo?.(message, items))
		},
		showWarningMessage(message, ...rest) {
			(state.messages ??= []).push({ level: 'warning', message })
			return Promise.resolve(state.onWarning?.(message, ...rest))
		},
		showErrorMessage(message) {
			(state.messages ??= []).push({ level: 'error', message })
			return Promise.resolve(undefined)
		},
		showQuickPick(items, options) {
			return Promise.resolve(state.quickPick ? state.quickPick(items, options) : options?.canPickMany ? items : items[0])
		},
		withProgress(_options, task) {
			return task({ report() { } }, { isCancellationRequested: false })
		},
	},
	commands: {
		registerCommand(id, fn) {
			commands.set(id, fn)
			return { dispose() { commands.delete(id) } }
		},
		async executeCommand(id, ...args) {
			if (id === 'workbench.extensions.installExtension') {
				return state.install(...args)
			}
			return commands.get(id)(...args)
		},
	},
	extensions: {
		get all() { return state.extensions ?? [] },
		get allAcrossExtensionHosts() { return state.extensions ?? [] },
		onDidChange() { return { dispose() { } } },
	},
}
