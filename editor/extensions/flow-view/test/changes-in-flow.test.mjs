// changesInFlow (src/mcp/handlers.ts) when everything that changed is hidden: it says what was hidden and opens nothing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { cleanup, temp } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let mod
const docs = {}
before(async () => {
	const out = temp('flow-changes-in-flow-')
	const stub = join(out, 'vscode.cjs')
	writeFileSync(stub, `module.exports = {
		workspace: {
			workspaceFolders: [],
			getConfiguration: () => ({ get: (k, d) => d }),
			asRelativePath: u => (u.fsPath ?? u).replace(/^[/\\\\]+/, ''),
			openTextDocument: async u => ({ getText: () => globalThis.__docs[u.fsPath] }),
		},
		Uri: { file: p => ({ fsPath: p, scheme: 'file' }) },
	}`)
	globalThis.__docs = docs
	await build({ stdin: { contents: "export { AgentTools } from './src/mcp/handlers.ts'", resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'mod.mjs'), logLevel: 'silent', alias: { vscode: stub }, external: ['bufferutil', 'utf-8-validate'] })
	mod = await import(pathToFileURL(join(out, 'mod.mjs')).href)
})
after(cleanup)

const row = (file, before, now) => {
	docs['orig:' + file] = before
	docs[file] = now
	return { uri: { fsPath: file, scheme: 'file' }, original: { fsPath: 'orig:' + file }, modified: { fsPath: file }, mark: 'M', repo: 'r' }
}

function run(list) {
	const calls = []
	const tools = new mod.AgentTools({ log: { warn() { } }, trackChanges: async () => calls.push('track'), showChanges: async () => { calls.push('show'); throw new Error('unreachable') } })
	return tools.changesInFlow({ list, since: undefined, notes: [] }).then(r => ({ ...r, calls }))
}

test('every changed file is a test: nothing is opened, and the message names flow.showTests', async () => {
	const r = await run([row('/w/src/a.test.ts', 'one()\n', 'two()\n')])
	assert.deepEqual([r.ok, r.opened, r.calls], [false, false, []])
	assert.match(r.message, /1 test file/)
	assert.match(r.message, /flow\.showTests/)
})

test('every changed file is a comment: nothing is opened, and the message says so', async () => {
	const r = await run([row('/w/src/a.ts', 'one()\n', 'one() // why\n')])
	assert.deepEqual([r.ok, r.opened, r.calls], [false, false, []])
	assert.match(r.message, /1 comment-only or whitespace-only file/)
})
