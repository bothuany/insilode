// What the host does for the Agents page's Harness panel (src/harnessBridge.ts): which folders it answers for, how it asks flow-harness,
// and which files it opens. The bridge has no `vscode`: everything it needs is handed in.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let B
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-harnessbridge-'))
	const outfile = join(tmp, 'harnessBridge.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'harnessBridge.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	B = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const summary = (root, files = []) => ({ root, score: 1, startupTokens: 0, instructions: files.map(file => ({ name: 'x', file })), hooks: [], mcp: [], findings: [], permissions: { counts: { allow: 0, ask: 0, deny: 0 }, allow: [], ask: [], deny: [] }, skills: { count: 0, items: [] }, agents: { count: 0, items: [] }, commands: { count: 0, items: [] }, counts: {}, notes: [] })
function bridge({ near = ['/work/app'], indexed = ['/work/indexed'], answer = root => ({ ok: true, summary: summary(root, [root + '/CLAUDE.md']) }), platform = 'linux' } = {}) {
	const calls = { summary: [], indexed: 0, open: [] }
	const b = new B.HarnessBridge({
		near: () => near,
		indexed: async () => { calls.indexed++; return indexed },
		summary: async folder => { calls.summary.push(folder); return answer(folder) },
		open: (file, line) => { calls.open.push([file, line]) },
	}, platform)
	return { b, calls }
}

test('folders compare resolved, without a trailing separator, and by case only where the file system ignores it', T, () => {
	// The platform is passed everywhere: the default is the runner's, and a POSIX path resolved on Windows gains a drive.
	assert.equal(B.folderKey('/work/app/', 'linux'), '/work/app')
	assert.equal(B.folderKey('/work/app/sub/..', 'linux'), '/work/app')
	assert.equal(B.folderKey('/', 'linux'), '/')
	assert.ok(B.isKnownFolder('/work/app/', ['/work/app'], 'linux'))
	assert.ok(!B.isKnownFolder('/work/App', ['/work/app'], 'linux'), 'case counts off Windows')
	assert.equal(B.folderKey('C:\\Work\\App\\', 'win32'), 'c:\\work\\app')
	assert.equal(B.folderKey('C:\\Work\\App\\Sub\\..', 'win32'), 'c:\\work\\app')
	assert.equal(B.folderKey('C:\\', 'win32'), 'c:\\', 'a drive root keeps its separator')
	assert.equal(B.folderKey('\\\\Srv\\Share\\', 'win32'), '\\\\srv\\share\\', 'so does a share')
	assert.ok(B.isKnownFolder('c:/work/app', ['C:\\Work\\App'], 'win32'), 'forward slashes are the same folder')
	assert.ok(!B.isKnownFolder('C:\\Work\\App2', ['C:\\Work\\App'], 'win32'))
	assert.ok(!B.isKnownFolder('D:\\Work\\App', ['C:\\Work\\App'], 'win32'), 'another drive is another folder')
	assert.ok(B.isKnownFolder('C:\\Work\\App\\', ['c:\\work\\app'], 'win32'), 'Windows folds case and separators')
	assert.ok(!B.isKnownFolder('/work/app2', ['/work/app']), 'a longer name is not the same folder')
	assert.ok(!B.isKnownFolder('/work', ['/work/app']), 'a parent is not the folder')
	assert.ok(!B.isKnownFolder('/work/app/sub', ['/work/app']), 'nor is a child')
	assert.ok(!B.isKnownFolder('/work/app/../secret', ['/work/app']))
})

test('the host answers for this window\'s folder, a folder a session works in, and a project of the sessions index; it asks the index only when the others do not name the folder', T, async () => {
	const { b, calls } = bridge({ near: ['/work/app', '/work/session'] })
	for (const cwd of [undefined, '/work/app', '/work/session']) {
		const r = await b.load(cwd, '/work/app')
		assert.equal(r.type, 'harnessData', String(cwd))
	}
	assert.equal(calls.indexed, 0, 'no slow look at the index for a folder that is already known')
	const r = await b.load('/work/indexed', '/work/app')
	assert.equal(r.type, 'harnessData')
	assert.equal(calls.indexed, 1)
	assert.deepEqual(calls.summary, ['/work/app', '/work/app', '/work/session', '/work/indexed'])
})

test('a folder the page was not given is refused with a sentence and flow-harness is never asked', T, async () => {
	const { b, calls } = bridge()
	for (const cwd of ['/', '/etc', '/work', '/work/app2', '/work/app/../secret', '/work/app/sub', '/home/u/.ssh', '/work/indexed/..']) {
		const r = await b.load(cwd, '/work/app')
		assert.deepEqual([r.type, r.cwd], ['harnessFailed', cwd], cwd)
		assert.match(r.message, /not one of the projects listed here/)
	}
	assert.deepEqual(calls.summary, [])
	// A failing index look is a refusal too, not an error.
	const broken = new B.HarnessBridge({ near: () => [], indexed: async () => { throw new Error('boom') }, summary: async () => { throw new Error('never') }, open() {} }, 'linux')
	assert.equal((await broken.load('/x', undefined)).type, 'harnessFailed')
})

test('no folder named and none open: the sentence for that; the answer echoes the page\'s own folder, or none', T, async () => {
	const { b } = bridge({ near: [] })
	assert.deepEqual(await b.load(undefined, undefined), { type: 'harnessFailed', message: 'This window has no folder open.' })
	const ok = bridge()
	const named = await ok.b.load('/work/app/', '/work/app')
	assert.equal(named.cwd, '/work/app/', 'echoed as the page wrote it, so the page can match the answer')
	assert.deepEqual(ok.calls.summary, ['/work/app'], 'asked of flow-harness tidied')
	assert.equal('cwd' in await ok.b.load(undefined, '/work/app'), false)
})

test('what flow-harness answers is passed on, or its sentence; anything else, and a missing extension, is a plain sentence', T, async () => {
	const ok = await bridge().b.load('/work/app', undefined)
	assert.equal(ok.summary.root, '/work/app')
	assert.deepEqual(await bridge({ answer: () => ({ ok: false, message: 'That folder does not exist.' }) }).b.load('/work/app', undefined), { type: 'harnessFailed', cwd: '/work/app', message: 'That folder does not exist.' })
	assert.equal((await bridge({ answer: () => ({ ok: false, message: 'x'.repeat(500) }) }).b.load('/work/app', undefined)).message.length, 200)
	for (const answer of [undefined, null, 5, 'x', {}, { ok: true }, { ok: true, summary: 5 }, { ok: true, summary: { root: 5 } }, { ok: true, summary: { root: '/x' } }, { ok: false, message: 5 }]) {
		const r = await bridge({ answer: () => answer }).b.load('/work/app', undefined)
		assert.deepEqual([r.type, r.message], ['harnessFailed', 'The harness could not be read.'], JSON.stringify(answer))
	}
	const gone = new B.HarnessBridge({ near: () => ['/work/app'], indexed: async () => [], summary: () => Promise.reject(new Error('command \'flowHarness.summary\' not found')), open() {} }, 'linux')
	assert.deepEqual(await gone.load('/work/app', undefined), { type: 'harnessFailed', cwd: '/work/app', message: 'The harness extension is not available.' })
})

test('a file opens only when the summary last sent for that folder named it', T, async () => {
	const { b, calls } = bridge({ near: ['/work/app', '/work/other'], answer: root => ({ ok: true, summary: summary(root, [root + '/CLAUDE.md', root + '/.claude/settings.json']) }) })
	assert.equal(b.open('/work/app', undefined, '/work/app/CLAUDE.md'), false, 'nothing was sent yet')
	await b.load('/work/app', undefined)
	assert.equal(b.open('/work/app', undefined, '/work/app/CLAUDE.md', 3), true)
	assert.equal(b.open('/work/app/', undefined, '/work/app/.claude/settings.json'), true, 'the folder is matched tidied')
	assert.equal(b.open(undefined, '/work/app', '/work/app/CLAUDE.md'), true, 'no folder named: this window\'s')
	assert.deepEqual(calls.open, [['/work/app/CLAUDE.md', 3], ['/work/app/.claude/settings.json', undefined], ['/work/app/CLAUDE.md', undefined]])
	calls.open.length = 0
	for (const [cwd, file] of [['/work/app', '/etc/passwd'], ['/work/app', '/work/app/other.md'], ['/work/other', '/work/app/CLAUDE.md'], ['/work/app', '/work/app/../../etc/passwd'], ['/work/app', 'CLAUDE.md'], ['/elsewhere', '/work/app/CLAUDE.md'], ['/work/app', '']]) {
		assert.equal(b.open(cwd, undefined, file), false, cwd + ' ' + file)
	}
	assert.equal(b.open(undefined, undefined, '/work/app/CLAUDE.md'), false, 'no folder at all')
	assert.deepEqual(calls.open, [])
	// A newer summary replaces the older one's files; a failed ask leaves them as they were.
	await bridge().b.load('/work/app', undefined)
	const again = bridge({ answer: root => ({ ok: true, summary: summary(root, [root + '/NEW.md']) }) })
	await again.b.load('/work/app', undefined)
	assert.equal(again.b.open('/work/app', undefined, '/work/app/CLAUDE.md'), false)
	assert.equal(again.b.open('/work/app', undefined, '/work/app/NEW.md'), true)
})

test('only the folders looked at most recently keep their files; the open of a file that throws is swallowed', T, async () => {
	const folders = Array.from({ length: 12 }, (_, i) => '/work/p' + i)
	const { b } = bridge({ near: folders })
	for (const f of folders) { await b.load(f, undefined) }
	assert.equal(b.open('/work/p0', undefined, '/work/p0/CLAUDE.md'), false, 'the oldest was let go')
	assert.equal(b.open('/work/p11', undefined, '/work/p11/CLAUDE.md'), true)
	const throwing = new B.HarnessBridge({ near: () => ['/work/app'], indexed: async () => [], summary: async r => ({ ok: true, summary: summary(r, [r + '/a.md']) }), open: () => Promise.reject(new Error('no editor')) }, 'linux')
	await throwing.load('/work/app', undefined)
	assert.equal(throwing.open('/work/app', undefined, '/work/app/a.md'), true)
	await new Promise(r => setTimeout(r, 5))
})

test('on Windows the whole flow works with drive letters, backslashes and any case', T, async () => {
	const { b, calls } = bridge({ platform: 'win32', near: ['C:\\Work\\App'], indexed: ['D:\\Other'], answer: root => ({ ok: true, summary: summary(root, [root + '\\CLAUDE.md']) }) })
	assert.equal((await b.load('c:/work/app/', undefined)).type, 'harnessData')
	assert.deepEqual(calls.summary, ['c:\\work\\app'], 'asked tidied, with the separators of the platform')
	assert.equal(b.open('C:\\WORK\\APP', undefined, 'c:\\work\\app\\CLAUDE.md', 2), true)
	assert.equal(b.open('C:\\Work\\App', undefined, 'c:\\work\\app\\..\\x.md'), false)
	assert.equal((await b.load('D:\\Other\\', undefined)).type, 'harnessData')
	assert.equal((await b.load('E:\\Work\\App', undefined)).type, 'harnessFailed')
	assert.equal((await b.load('\\\\attacker\\share', undefined)).type, 'harnessFailed', 'a share nobody listed is refused')
	assert.deepEqual(calls.open, [['c:\\work\\app\\CLAUDE.md', 2]])
})

test('summaryFiles reads a summary that is wrong in places without throwing', T, () => {
	assert.deepEqual([...B.summaryFiles({ instructions: [{ file: '/a' }, null, { file: 5 }, {}], hooks: 'x', permissions: null, skills: { items: [{ file: '/s' }] } })].sort(), ['/a', '/s'])
})
