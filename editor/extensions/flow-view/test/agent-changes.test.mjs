// AgentChanges (src/agentDiff.ts) on a real temporary git repository, with a minimal `vscode`: files a shell command changed
// (baseline from the turn-start snapshot, else HEAD, else created), and per-card Keep with its effect on the rest of the file.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let mod
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agent-changes-'))
	const stub = join(tmp, 'vscode-stub.cjs')
	// Only what AgentChanges touches without an open editor: file URIs, an emitter, and no documents.
	writeFileSync(stub, `
		const path = require('path');
		class EventEmitter { constructor() { this.l = []; this.event = f => { this.l.push(f); return { dispose() {} }; }; } fire(v) { this.l.forEach(f => f(v)); } dispose() {} }
		module.exports = { Uri: { file: f => ({ fsPath: path.resolve(f), scheme: 'file' }) }, EventEmitter, workspace: { textDocuments: [], asRelativePath: f => f } };
	`)
	const outfile = join(tmp, 'agentDiff.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'agentDiff.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', alias: { vscode: stub }, banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } })
	mod = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { cwd, stdio: 'pipe' })
const lines = (...l) => l.join('\n') + '\n'

function repo(files) {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-changes-repo-')))
	git(dir, 'init', '-q')
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(join(dir, name), text)
	}
	git(dir, 'add', '.')
	git(dir, 'commit', '-q', '-m', 'init')
	return dir
}
/** A canvas card of the lines `start`..`end` of a file. */
const card = (file, startLine, endLine) => ({ key: `${file}:${startLine}`, file, startLine, endLine, label: 'm', children: [] })
const diffOf = async (changes, file, startLine, endLine) => {
	const root = card(file, startLine, endLine)
	await changes.annotate(root)
	return root.diff
}

test('commandEdited: a tracked file a command changed is measured against HEAD, labelled as a command, and Undo is refused', async t => {
	const dir = repo({ 'a.ts': lines('one', 'two', 'three') })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const changes = new mod.AgentChanges()
	changes.startTurn('fix it', 'Claude')
	writeFileSync(join(dir, 'a.ts'), lines('one', 'TWO', 'three'))
	await changes.commandEdited([join(dir, 'a.ts')])
	const d = await diffOf(changes, join(dir, 'a.ts'), 1, 3)
	assert.deepEqual([d.plus, d.minus, d.source, d.base, d.added], [1, 1, 'command', 'the last commit', [2]])
	const undo = await changes.undo(join(dir, 'a.ts'), 1, 3)
	assert.equal(undo.ok, false)
	assert.match(undo.message, /includes committed work/)
	assert.equal((await changes.undoAll()).ok, false, 'Undo all skips it and says so')
	assert.match((await changes.undoAll()).message, /^Skipped 1 measured against a commit \(/)
	// The timeline's "undo this prompt" is guarded the same way: HEAD's text is not known to be what the file held before the turn.
	const [turn] = await changes.timeline()
	const prompt = await changes.undoFrom(turn.id)
	assert.equal(prompt.ok, false)
	assert.match(prompt.message, /changes a command made/)
})

test('commandEdited: a file untracked before the turn and changed by a command is not deleted by undoing the prompt', async t => {
	const dir = repo({ 'a.ts': 'x\n' })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	writeFileSync(join(dir, 'notes.md'), 'my own untracked notes\n')
	const changes = new mod.AgentChanges()
	changes.startTurn('format', 'Claude')
	writeFileSync(join(dir, 'notes.md'), 'my own untracked notes, reformatted by a command\n')
	await changes.commandEdited([join(dir, 'notes.md')])
	const [turn] = await changes.timeline()
	assert.equal((await changes.undoFrom(turn.id)).ok, false, 'created would have deleted it')
	assert.equal((await changes.undo(join(dir, 'notes.md'), 1, 1)).ok, false)
})

test('commandEdited: a new untracked file counts as created, with an empty baseline', async t => {
	const dir = repo({ 'a.ts': 'x\n' })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const changes = new mod.AgentChanges()
	changes.startTurn('generate', 'Claude')
	writeFileSync(join(dir, 'gen.ts'), lines('l1', 'l2'))
	await changes.commandEdited([join(dir, 'gen.ts')])
	const d = await diffOf(changes, join(dir, 'gen.ts'), 1, 2)
	assert.deepEqual([d.plus, d.minus, d.source], [2, 0, 'command'])
})

test('commandEdited: a file a command deleted shows as removed, measured against its HEAD text', async t => {
	const dir = repo({ 'gone.ts': lines('a', 'b') })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const changes = new mod.AgentChanges()
	changes.startTurn('clean up', 'Claude')
	unlinkSync(join(dir, 'gone.ts'))
	await changes.commandEdited([join(dir, 'gone.ts')])
	const d = await diffOf(changes, join(dir, 'gone.ts'), 0, 100)
	assert.deepEqual([d.plus, d.minus, d.source], [0, 2, 'command'])
})

test('commandEdited: binary files, files that did not change and files outside a repository are not recorded', async t => {
	const dir = repo({ 'a.ts': 'x\n', 'img.bin': 'GIF\0\u0001' })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const plain = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-changes-plain-')))
	t.after(() => rmSync(plain, { recursive: true, force: true }))
	const changes = new mod.AgentChanges()
	changes.startTurn('t', 'Claude')
	writeFileSync(join(dir, 'img.bin'), 'GIF\0\u0002')
	writeFileSync(join(plain, 'x.ts'), 'y\n')
	await changes.commandEdited([join(dir, 'img.bin'), join(dir, 'a.ts'), join(plain, 'x.ts')])
	assert.equal(await diffOf(changes, join(dir, 'img.bin'), 1, 1), undefined)
	assert.equal(await diffOf(changes, join(dir, 'a.ts'), 1, 1), undefined)
	assert.equal(await diffOf(changes, join(plain, 'x.ts'), 1, 1), undefined)
})

test('commandEdited: the baseline of a tool edit wins over a later command edit of the same file', async t => {
	const dir = repo({ 'a.ts': lines('one', 'two', 'three') })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const changes = new mod.AgentChanges()
	changes.startTurn('both', 'Claude')
	const file = join(dir, 'a.ts')
	writeFileSync(file, lines('one', 'dirty before the tool', 'three'))
	await changes.willEdit([file]) // the edit tool's snapshot: the file as it was just before the tool wrote
	writeFileSync(file, lines('one', 'tool wrote this', 'three'))
	await changes.didEdit([file])
	writeFileSync(file, lines('one', 'tool wrote this', 'three', 'sed appended'))
	await changes.commandEdited([file])
	const d = await diffOf(changes, file, 1, 4)
	assert.equal(d.source, undefined, 'a tool edit, not a command one')
	assert.equal(d.base, undefined, 'measured from the tool snapshot, not HEAD: Undo stays possible')
	assert.deepEqual([d.plus, d.minus], [2, 1])
})

test('commandEdited: when the tracker holds the turn-start snapshot of a file without a baseline, that is the baseline', async t => {
	const dir = repo({ 'a.ts': lines('one', 'two') })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const changes = new mod.AgentChanges()
	changes.startTurn('t', 'Claude')
	const file = join(dir, 'a.ts')
	writeFileSync(file, lines('one', 'uncommitted work of the user'))
	await changes.willEdit([file]) // snapshot taken, then the user keeps everything shown so far
	changes.keepAll()
	writeFileSync(file, lines('one', 'uncommitted work of the user', 'by a command'))
	await changes.commandEdited([file])
	const d = await diffOf(changes, file, 1, 3)
	assert.deepEqual([d.plus, d.minus, d.source, d.base], [1, 0, 'command', undefined], 'not against HEAD: Undo allowed, only the command line shows')
})

test('keepCard: the card keeps its hunks, the rest of the file still shows, and the last card empties the file', async t => {
	const dir = repo({ 'a.ts': lines('class A {', '  a() {', '    one', '  }', 'class B {', '  b() {', '    two', '  }') })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const changes = new mod.AgentChanges()
	changes.startTurn('edit both', 'Claude')
	const file = join(dir, 'a.ts')
	await changes.willEdit([file])
	writeFileSync(file, lines('class A {', '  a() {', '    one changed', '  }', 'class B {', '  b() {', '    two changed', '  }'))
	assert.equal((await diffOf(changes, file, 2, 4)).plus, 1)
	assert.equal((await diffOf(changes, file, 6, 8)).plus, 1)
	// The canvas redraws as soon as the request answers, so Keep is not awaited here either.
	void changes.keepCard(file, 2, 4)
	assert.equal(await diffOf(changes, file, 2, 4), undefined, 'a is kept')
	assert.equal((await diffOf(changes, file, 6, 8)).plus, 1, 'b still shows')
	// Lines added above the kept card do not bring it back.
	writeFileSync(file, lines('// header', 'class A {', '  a() {', '    one changed', '  }', 'class B {', '  b() {', '    two changed', '  }'))
	assert.equal(await diffOf(changes, file, 3, 5), undefined)
	assert.equal((await diffOf(changes, file, 1, 1)).plus, 1, 'the new line shows as a change of its own')
	await changes.keepCard(file, 0, 100)
	assert.equal(await diffOf(changes, file, 1, 9), undefined, 'nothing left: the file is no longer tracked')
	assert.equal((await changes.undoAll()).message, 'Nothing left to undo.')
})

test('keepAll forgets every tracked file', async t => {
	const dir = repo({ 'a.ts': 'one\n', 'b.ts': 'two\n' })
	t.after(() => rmSync(dir, { recursive: true, force: true }))
	const changes = new mod.AgentChanges()
	changes.startTurn('t', 'Claude')
	for (const f of ['a.ts', 'b.ts']) {
		await changes.willEdit([join(dir, f)])
		writeFileSync(join(dir, f), 'changed\n')
	}
	changes.keepAll()
	assert.equal(await diffOf(changes, join(dir, 'a.ts'), 1, 1), undefined)
	assert.equal(await diffOf(changes, join(dir, 'b.ts'), 1, 1), undefined)
})
