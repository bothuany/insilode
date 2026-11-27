// The Agents page is not trusted: every message it sends is checked for its shape (src/agentsMessage.ts) before the
// host does anything with it.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let a
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agentsmsg-'))
	const outfile = join(tmp, 'agentsMessage.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'agentsMessage.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	a = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('the page-only messages become one action each', T, () => {
	assert.deepEqual(a.agentsAction({ type: 'tail', id: 'a1', extra: 1 }), { type: 'tail', id: 'a1' })
	const uuid = '0a99a3dd-7db0-4ba0-882d-a4dd922189be'
	assert.deepEqual(a.agentsAction({ type: 'tail', id: uuid, kind: 'codex' }), { type: 'tail', id: uuid, kind: 'codex' })
	// A session of the index is named by a uuid and its kind; never a path.
	for (const bad of [{ id: 'a1', kind: 'claude' }, { id: '/etc/passwd', kind: 'claude' }, { id: uuid, kind: 'custom' }, { id: uuid, kind: 7 }]) {
		assert.equal(a.agentsAction({ type: 'tail', ...bad }), undefined)
	}
	assert.deepEqual(a.agentsAction({ type: 'custom', index: 0, name: 'Gemini' }), { type: 'custom', index: 0, name: 'Gemini' })
	assert.equal(a.agentsAction({ type: 'custom', index: 0 }), undefined)
	assert.deepEqual(a.agentsAction({ type: 'kept' }), { type: 'kept' })
	assert.deepEqual(a.agentsAction({ type: 'ide' }), { type: 'ide' })
})

test('the dock\'s row and worktree actions pass', T, () => {
	for (const type of ['show', 'pr', 'forget', 'compact', 'rename', 'explain', 'swap']) {
		assert.deepEqual(a.agentsAction({ type, id: 'a1' }), { type, id: 'a1' }, type)
	}
	assert.deepEqual(a.agentsAction({ type: 'ready' }), { type: 'ready' })
	assert.deepEqual(a.agentsAction({ type: 'new', cli: 'claude' }), { type: 'new', cli: 'claude' })
	assert.deepEqual(a.agentsAction({ type: 'wt', id: 'a', action: 'merge' })?.type, 'wt')
})

test('bad indexes and ids are dropped; the page has no reply message any more', T, () => {
	assert.equal(a.agentsAction({ type: 'reply', id: 'a1', text: 'go on' }), undefined)
	for (const index of [-1, 1.5, '1', undefined, NaN, 100]) {
		assert.equal(a.agentsAction({ type: 'custom', index, name: 'Gemini' }), undefined, String(index))
	}
	assert.equal(a.agentsAction({ type: 'tail' }), undefined)
	assert.equal(a.agentsAction({ type: 'tail', id: '' }), undefined)
})

test('a peer message names a project by storage key and a session by id, never a path or a command', T, () => {
	const key = '0123456789ab'
	assert.deepEqual(a.agentsAction({ type: 'peer', action: 'ide', key }), { type: 'peer', action: 'ide', key })
	assert.deepEqual(a.agentsAction({ type: 'peer', action: 'ide', key, id: 's1', extra: 1 }), { type: 'peer', action: 'ide', key, id: 's1' })
	assert.deepEqual(a.agentsAction({ type: 'peer', action: 'flow', key, id: 's1' }), { type: 'peer', action: 'flow', key, id: 's1' })
	assert.equal(a.agentsAction({ type: 'peer', action: 'ide', key: 'empty-0123456789ab' }).key, 'empty-0123456789ab')
	for (const bad of [
		{ type: 'peer', action: 'flow', key }, // a flow needs a session
		{ type: 'peer', action: 'reply', key, id: 's1' }, // only two actions travel
		{ type: 'peer', action: 'ide', key: 'C:\\Users\\me\\project' },
		{ type: 'peer', action: 'ide', key: '../../etc' },
		{ type: 'peer', action: 'ide', key: '0123456789AB' },
		{ type: 'peer', action: 'ide', key: 5 },
		{ type: 'peer', action: 'ide', key, id: 5 },
		{ type: 'peer', action: 'ide', key, id: '' },
		{ type: 'peer', action: 'ide', key, id: 'x'.repeat(201) },
		{ type: 'peer', key },
	]) {
		assert.equal(a.agentsAction(bad), undefined, JSON.stringify(bad))
	}
})

test('the dock-only chat link, the removed X-ray and anything unknown are dropped', T, () => {
	assert.equal(a.agentsAction({ type: 'chat' }), undefined)
	assert.equal(a.agentsAction({ type: 'xray', id: 'a1' }), undefined, 'the context X-ray is gone from the product')
	for (const m of [null, undefined, 'tail', 42, [], {}, { type: 1 }, { type: 'runCommand', id: 'x' }, { type: 'constructor', id: 'a' }]) {
		assert.equal(a.agentsAction(m), undefined, JSON.stringify(m))
	}
})

// The sidebar's earlier sessions: the index list and the search. The page's own chat is gone: opening a session is a terminal now.
const PROJECT = 'a1b2c3d4e5f6'
const SESSION = '0a99a3dd-7db0-4ba0-882d-a4dd922189be'

test('chatList is accepted; the chat actions of the page that had a chat are gone', T, () => {
	assert.deepEqual(a.agentsAction({ type: 'chatList' }), { type: 'chatList' })
	for (const m of [{ type: 'chatOpen', project: PROJECT, kind: 'claude' }, { type: 'chatPrompt', chat: 'c1', text: 'hi' }, { type: 'chatCancel', chat: 'c1' }, { type: 'chatAnswer', chat: 'c1', req: 0, option: 1 }, { type: 'chatSet', chat: 'c1', config: 'mode', value: 'plan' }]) {
		assert.equal(a.agentsAction(m), undefined, m.type)
	}
})

test('chatSearch takes a text of two to two hundred characters (once trimmed) and nothing else', T, () => {
	assert.deepEqual(a.agentsAction({ type: 'chatSearch', query: 'login bug' }), { type: 'chatSearch', query: 'login bug' })
	assert.deepEqual(a.agentsAction({ type: 'chatSearch', query: 'x'.repeat(200) }), { type: 'chatSearch', query: 'x'.repeat(200) })
	assert.deepEqual(a.agentsAction({ type: 'chatSearch', query: 'ab', project: '/etc' }), { type: 'chatSearch', query: 'ab' }, 'extra fields are not carried over')
	for (const query of ['', 'a', '  a  ', 'x'.repeat(201), 5, null, undefined, ['ab']]) {
		assert.equal(a.agentsAction({ type: 'chatSearch', query }), undefined, String(query))
	}
})

// The page's terminal panes: ids are agent session ids from the rows; sizes and input are bounded; a termOpen path is absolute.
const TT = { timeout: 5000 }

test('the four pane messages are accepted and carry only their own fields', TT, () => {
	assert.deepEqual(a.agentsAction({ type: 'termAttach', id: 's1', x: 1 }), { type: 'termAttach', id: 's1' })
	assert.deepEqual(a.agentsAction({ type: 'termDetach', id: 's1' }), { type: 'termDetach', id: 's1' })
	assert.deepEqual(a.agentsAction({ type: 'termInput', id: 's1', data: '\x1b[A' }), { type: 'termInput', id: 's1', data: '\x1b[A' })
	assert.deepEqual(a.agentsAction({ type: 'termInput', id: 's1', data: 'x'.repeat(64 * 1024) }).type, 'termInput')
	assert.deepEqual(a.agentsAction({ type: 'termResize', id: 's1', cols: 2, rows: 1 }), { type: 'termResize', id: 's1', cols: 2, rows: 1 })
	assert.deepEqual(a.agentsAction({ type: 'termResize', id: 's1', cols: 500, rows: 300 }), { type: 'termResize', id: 's1', cols: 500, rows: 300 })
})

test('pane messages without an id, with oversize input or with a size out of range are dropped', TT, () => {
	for (const type of ['termAttach', 'termDetach', 'termInput', 'termResize']) {
		assert.equal(a.agentsAction({ type, data: 'x', cols: 80, rows: 24 }), undefined, type + ' without id')
		assert.equal(a.agentsAction({ type, id: '', data: 'x', cols: 80, rows: 24 }), undefined, type + ' empty id')
		assert.equal(a.agentsAction({ type, id: 'x'.repeat(201), data: 'x', cols: 80, rows: 24 }), undefined, type + ' long id')
	}
	for (const data of ['', 'x'.repeat(64 * 1024 + 1), 5, null, undefined, ['a']]) {
		assert.equal(a.agentsAction({ type: 'termInput', id: 's1', data }), undefined, String(data).slice(0, 10))
	}
	for (const [cols, rows] of [[1, 24], [501, 24], [80, 0], [80, 301], [80.5, 24], [80, 24.5], [NaN, 24], [80, Infinity], ['80', 24], [80, '24'], [undefined, 24], [80, undefined], [-80, 24]]) {
		assert.equal(a.agentsAction({ type: 'termResize', id: 's1', cols, rows }), undefined, `${cols}x${rows}`)
	}
})

test('pickFolder carries a request id and nothing else: no path, whatever the page adds', TT, () => {
	assert.deepEqual(a.agentsAction({ type: 'pickFolder', requestId: 'f1' }), { type: 'pickFolder', requestId: 'f1' })
	assert.deepEqual(a.agentsAction({ type: 'pickFolder', requestId: 'f1', path: '/etc', cwd: '/etc', folder: '/etc' }), { type: 'pickFolder', requestId: 'f1' }, 'a path in it is dropped')
	for (const bad of [{}, { requestId: '' }, { requestId: 7 }, { requestId: ['a'] }, { requestId: 'r'.repeat(101) }]) {
		assert.equal(a.agentsAction({ type: 'pickFolder', ...bad }), undefined, JSON.stringify(bad))
	}
})

test('termOpen names a CLI, optionally a session by uuid and an absolute folder, and always a request id', TT, () => {
	const cwd = process.platform === 'win32' ? 'C:\\work\\app' : '/work/app'
	assert.deepEqual(a.agentsAction({ type: 'termOpen', requestId: 'r1', kind: 'claude' }), { type: 'termOpen', requestId: 'r1', kind: 'claude' })
	assert.deepEqual(a.agentsAction({ type: 'termOpen', requestId: 'r1', kind: 'codex', sessionId: SESSION, cwd, extra: 1 }), { type: 'termOpen', requestId: 'r1', kind: 'codex', sessionId: SESSION, cwd })
	for (const bad of [
		{ kind: 'claude' }, // no request id
		{ requestId: '', kind: 'claude' },
		{ requestId: 'x'.repeat(101), kind: 'claude' },
		{ requestId: 5, kind: 'claude' },
		{ requestId: 'r1', kind: 'custom' },
		{ requestId: 'r1', kind: 'claude', sessionId: 'not-a-uuid' },
		{ requestId: 'r1', kind: 'claude', sessionId: '../../etc/passwd' },
		{ requestId: 'r1', kind: 'claude', sessionId: null },
		{ requestId: 'r1', kind: 'claude', cwd: 'relative/dir' },
		{ requestId: 'r1', kind: 'claude', cwd: '../up' },
		{ requestId: 'r1', kind: 'claude', cwd: '' },
		{ requestId: 'r1', kind: 'claude', cwd: 5 },
		{ requestId: 'r1', kind: 'claude', cwd: null },
		{ requestId: 'r1', kind: 'claude', cwd: '/a/\0/b' },
		{ requestId: 'r1', kind: 'claude', cwd: '/' + 'x'.repeat(1024) },
	]) {
		assert.equal(a.agentsAction({ type: 'termOpen', ...bad }), undefined, JSON.stringify(bad).slice(0, 80))
	}
})

test('termOpen carries `force` only when it is exactly true: the page asking to resume a session another process runs, which the host still confirms itself', TT, () => {
	assert.deepEqual(a.agentsAction({ type: 'termOpen', requestId: 'r1', kind: 'claude', sessionId: SESSION, force: true }), { type: 'termOpen', requestId: 'r1', kind: 'claude', sessionId: SESSION, force: true })
	for (const force of [false, 1, 'true', 'yes', null, {}, [true]]) {
		assert.deepEqual(a.agentsAction({ type: 'termOpen', requestId: 'r1', kind: 'claude', sessionId: SESSION, force }), { type: 'termOpen', requestId: 'r1', kind: 'claude', sessionId: SESSION }, JSON.stringify(force))
	}
	assert.equal(a.agentsAction({ type: 'termOpen', requestId: 'r1', kind: 'claude', force: true }).force, undefined, 'a new session has nothing to force')
	assert.equal(a.agentsAction({ type: 'termOpen', requestId: 'r1', kind: 'codex', sessionId: SESSION, force: true }).force, undefined, 'Codex keeps no registry to override')
})

// The pane layout: validated here, so what reaches storage is always a sound tree (paneLayout.ts has the rules).
const pane = (id, over = {}) => ({ type: 'pane', id, content: { kind: 'terminal', agent: 'claude', session: 's' + id, ...over } })
const layout = () => ({ seq: 3, focus: 'p1', root: { type: 'split', id: 's3', dir: 'row', sizes: [0.5, 0.5], children: [pane('p1'), pane('p2')] } })

test('layoutSave, layoutSaveAs and layoutDelete carry a validated layout and a trimmed name, nothing else', T, () => {
	assert.deepEqual(a.agentsAction({ type: 'layoutSave', layout: layout(), extra: 1 }), { type: 'layoutSave', layout: layout() })
	assert.deepEqual(a.agentsAction({ type: 'layoutSave', layout: { seq: 0 } }), { type: 'layoutSave', layout: { seq: 0 } }, 'an empty workspace is saved as empty')
	assert.deepEqual(a.agentsAction({ type: 'layoutSaveAs', name: '  Review ', layout: layout() }), { type: 'layoutSaveAs', name: 'Review', layout: layout() })
	assert.deepEqual(a.agentsAction({ type: 'layoutDelete', name: 'Review' }), { type: 'layoutDelete', name: 'Review' })
	const clean = a.agentsAction({ type: 'layoutSave', layout: { ...layout(), evil: '<x>' } })
	assert.equal('evil' in clean.layout, false)
})

test('an unsound layout, a layout with no panes under a name, or a bad name is dropped', T, () => {
	assert.equal(a.agentsAction({ type: 'layoutSave', layout: { seq: 1, root: pane('x') } }), undefined)
	assert.equal(a.agentsAction({ type: 'layoutSave', layout: 'nope' }), undefined)
	assert.equal(a.agentsAction({ type: 'layoutSave' }), undefined)
	assert.equal(a.agentsAction({ type: 'layoutSave', layout: { seq: 1, root: pane('p1', { kind: 'shell' }) } }), undefined)
	assert.equal(a.agentsAction({ type: 'layoutSaveAs', name: 'Empty', layout: { seq: 0 } }), undefined)
	for (const name of ['', '   ', 'x'.repeat(61), 'a\nb', 5, undefined]) {
		assert.equal(a.agentsAction({ type: 'layoutSaveAs', name, layout: layout() }), undefined, String(name))
		assert.equal(a.agentsAction({ type: 'layoutDelete', name }), undefined, String(name))
	}
	const many = Array.from({ length: 17 }, (_, i) => pane('p' + (i + 1)))
	assert.equal(a.agentsAction({ type: 'layoutSave', layout: { seq: 17, root: { type: 'split', id: 's18', dir: 'row', sizes: many.map(() => 1 / 17), children: many } } }), undefined, 'more than 16 panes')
})

test('the Harness panel\'s messages: an absolute folder or none, a file that is an absolute path, a line that is a whole number, and a target from a short list', T, () => {
	assert.deepEqual(a.agentsAction({ type: 'harness' }), { type: 'harness' })
	assert.deepEqual(a.agentsAction({ type: 'harness', cwd: '/work/app', extra: 1 }), { type: 'harness', cwd: '/work/app' })
	for (const cwd of ['', 'relative', '.', '~/x', 5, null, {}, 'a\0b', '/' + 'x'.repeat(1100)]) {
		assert.equal(a.agentsAction({ type: 'harness', cwd }), undefined, JSON.stringify(cwd)?.slice(0, 40))
	}
	assert.deepEqual(a.agentsAction({ type: 'harnessOpen', file: '/work/app/CLAUDE.md' }), { type: 'harnessOpen', file: '/work/app/CLAUDE.md' })
	assert.deepEqual(a.agentsAction({ type: 'harnessOpen', cwd: '/work/app', file: '/work/app/CLAUDE.md', line: 7 }), { type: 'harnessOpen', cwd: '/work/app', file: '/work/app/CLAUDE.md', line: 7 })
	for (const bad of [{}, { file: 'CLAUDE.md' }, { file: '' }, { file: 5 }, { file: 'a\0b' }, { file: '/a', cwd: 'rel' }, { file: '/a', line: 0 }, { file: '/a', line: 1.5 }, { file: '/a', line: 1e9 }, { file: '/a', line: '3' }, { file: '/a', line: null }]) {
		assert.equal(a.agentsAction({ type: 'harnessOpen', ...bad }), undefined, JSON.stringify(bad))
	}
	assert.deepEqual(a.agentsAction({ type: 'harnessGo', target: 'map' }), { type: 'harnessGo', target: 'map' })
	assert.deepEqual(a.agentsAction({ type: 'harnessGo', target: 'hook' }), { type: 'harnessGo', target: 'hook' })
	for (const target of ['workbench.action.quit', 'flowHarness.addHook', '', 5, undefined]) {
		assert.equal(a.agentsAction({ type: 'harnessGo', target }), undefined, String(target))
	}
})

test('a path the page names is absolute on the platform it runs on: drive and share paths on Windows, a leading slash elsewhere, run with both rule sets on any machine', T, () => {
	for (const ok of ['C:\\work\\app', 'c:/work/app', 'D:\\', '\\\\server\\share\\x', '\\work']) {
		assert.equal(a.isPagePath(ok, 'win32'), true, ok)
	}
	for (const bad of ['', 'work\\app', 'C:work', '..\\up', '.', 5, null, undefined, 'C:\\a\0b', 'C:\\' + 'x'.repeat(1100)]) {
		assert.equal(a.isPagePath(bad, 'win32'), false, String(bad).slice(0, 30))
	}
	assert.equal(a.isPagePath('/work/app', 'linux'), true)
	for (const bad of ['C:\\work\\app', 'work/app', '\\\\server\\share', '/a\0b']) {
		assert.equal(a.isPagePath(bad, 'linux'), false, bad)
	}
})

test('layoutSave carries the Harness panel\'s state only when it is sound; the layout is judged on its own', T, () => {
	assert.deepEqual(a.agentsAction({ type: 'layoutSave', layout: layout(), harness: { open: true, width: 340 } }), { type: 'layoutSave', layout: layout(), harness: { open: true, width: 340 } })
	for (const harness of [{ open: 'yes', width: 340 }, { open: true, width: 100 }, { open: true, width: 700 }, { open: true, width: 340.5 }, { open: true }, 'x', null]) {
		assert.deepEqual(a.agentsAction({ type: 'layoutSave', layout: layout(), harness }), { type: 'layoutSave', layout: layout() }, JSON.stringify(harness))
	}
	assert.equal(a.agentsAction({ type: 'layoutSave', layout: { seq: 'x' }, harness: { open: true, width: 340 } }), undefined)
})

test('a named save the validation refuses is told apart, for the host to answer it', T, () => {
	assert.equal(a.agentsAction({ type: 'layoutSaveAs', name: 'Bad', layout: { seq: 'x' } }), undefined)
	assert.equal(a.refusedSaveName({ type: 'layoutSaveAs', name: 'Bad', layout: { seq: 'x' } }), 'Bad')
	assert.equal(a.refusedSaveName({ type: 'layoutSaveAs', name: '  Bad  ', layout: 5 }), 'Bad')
	assert.equal(a.refusedSaveName({ type: 'layoutSaveAs', name: 'x'.repeat(100) }), 'x'.repeat(60), 'an unusable name is cut, not echoed whole')
	for (const raw of [null, 'x', { type: 'layoutSave', name: 'a' }, { type: 'layoutSaveAs', name: 5 }, { type: 'layoutSaveAs' }]) {
		assert.equal(a.refusedSaveName(raw), undefined, JSON.stringify(raw))
	}
})

test('a termOpen folder on a network share is refused on Windows: resolving it would reach the server before anyone is asked', { timeout: 5000 }, () => {
	for (const share of ['\\\\srv\\share\\x', '//srv/share/x', '\\\\?\\C:\\a', '\\\\.\\pipe\\x']) {
		assert.equal(a.isNetworkPath(share, 'win32'), true, share)
	}
	for (const local of ['C:\\work\\app', 'c:/work/app', '\\work']) {
		assert.equal(a.isNetworkPath(local, 'win32'), false, local)
	}
	assert.equal(a.isNetworkPath('//srv/share', 'linux'), false, 'a double slash is an ordinary path elsewhere')
})
