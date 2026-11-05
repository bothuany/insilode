// Rename, swap and remove an agent from the command palette: the quick pick lists this window's agents (pick.ts agentPickItems)
// and the name is checked by the rule the dock's Rename always had (paletteActions.ts). Both files import `vscode`, so they are
// bundled with an empty stand-in for it: the pure parts never touch it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let m
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-palette-'))
	const outfile = join(tmp, 'palette.mjs')
	const stubVscode = { name: 'stub-vscode', setup: b => { b.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = {};', loader: 'js' })) } }
	await build({ stdin: { contents: "export { agentPickItems } from './src/pick'; export { validateAgentName } from './src/paletteActions'", resolveDir: ROOT, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', plugins: [stubVscode] })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const a = (id, name, cli, state, worktree) => ({ id, name, cli, state, ...(worktree ? { worktree: { branch: worktree } } : {}) })

test('the pick shows each agent by name, which CLI it is and what it is doing, in the order given', () => {
	const items = m.agentPickItems([a('1', 'Claude 2', 'claude', 'blocked'), a('2', 'Codex', 'codex', 'working', 'insilode/x'), a('3', 'Aider', 'custom', 'ended')], 'rename')
	assert.deepEqual(items.map(i => ({ ...i })), [
		{ id: '1', label: 'Claude 2', description: 'Claude Code', detail: 'Needs you' },
		{ id: '2', label: 'Codex', description: 'Codex', detail: 'Working · worktree insilode/x' },
		{ id: '3', label: 'Aider', description: 'Your command', detail: 'Closed' },
	])
})

test('only Claude and Codex agents can be continued in the other CLI; rename and remove take every agent', () => {
	const all = [a('1', 'A', 'claude', 'idle'), a('2', 'B', 'custom', 'idle'), a('3', 'C', 'codex', 'ended')]
	assert.deepEqual(m.agentPickItems(all, 'swap').map(i => i.id), ['1', '3'])
	assert.deepEqual(m.agentPickItems(all, 'rename').map(i => i.id), ['1', '2', '3'])
	assert.deepEqual(m.agentPickItems(all, 'remove').map(i => i.id), ['1', '2', '3'])
	assert.deepEqual(m.agentPickItems([], 'swap'), [], 'no agents: nothing to pick, and the command says so')
	assert.deepEqual(m.agentPickItems([a('2', 'B', 'custom', 'idle')], 'swap'), [])
})

test('an unknown state or CLI is shown as it came, not hidden', () => {
	const [i] = m.agentPickItems([a('1', 'X', 'newcli', 'paused')], 'rename')
	assert.equal(i.description, 'newcli')
	assert.equal(i.detail, 'paused')
})

test('a name is required, as the dock\'s Rename has always asked', () => {
	assert.equal(m.validateAgentName(''), 'A name is required')
	assert.equal(m.validateAgentName('   '), 'A name is required')
	assert.equal(m.validateAgentName(' Reviewer '), undefined)
})
