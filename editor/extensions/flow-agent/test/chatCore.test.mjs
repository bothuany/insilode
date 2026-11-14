// What the two chat front ends share (src/chatCore.ts): config options, the rule that answers a permission request for the user, and
// the page events a session update becomes.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let c
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-chatcore-'))
	const outfile = join(tmp, 'chatCore.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'chatCore.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	c = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const text = (kind, t) => ({ sessionUpdate: kind, content: { type: 'text', text: t } })

test('message and thought chunks become text, thought and user events; an image chunk becomes nothing', () => {
	assert.deepEqual(c.toEvents(text('agent_message_chunk', 'hi')), [{ t: 'text', text: 'hi' }])
	assert.deepEqual(c.toEvents(text('agent_thought_chunk', 'hm')), [{ t: 'thought', text: 'hm' }])
	assert.deepEqual(c.toEvents(text('user_message_chunk', 'go')), [{ t: 'user', text: 'go' }])
	assert.deepEqual(c.toEvents({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } }), [])
})

test('a tool call carries its title, kind, files and diffs; an update carries only what it changes', () => {
	const first = c.toEvents({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.ts', kind: 'edit', status: 'pending', locations: [{ path: '/w/a.ts' }], content: [{ type: 'diff', path: '/w/a.ts', oldText: 'one', newText: 'two' }] })
	assert.deepEqual(first, [{ t: 'tool', id: 't1', kind: 'edit', title: 'Edit a.ts', status: 'pending', files: ['/w/a.ts'], diffs: [{ path: '/w/a.ts', old: 'one', new: 'two' }] }])
	assert.deepEqual(c.toEvents({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }), [{ t: 'tool', id: 't1', status: 'completed' }])
	const out = c.toEvents({ sessionUpdate: 'tool_call_update', toolCallId: 't2', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }, { type: 'terminal', terminalId: 'x' }] })
	assert.deepEqual(out, [{ t: 'tool', id: 't2', out: 'ok' }])
	// A new file has no old text.
	assert.equal(c.toEvents({ sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Write', content: [{ type: 'diff', path: '/w/n.ts', oldText: null, newText: 'x' }] })[0].diffs[0].old, '')
})

test('plan, usage and the updates the page has no use for', () => {
	assert.deepEqual(c.toEvents({ sessionUpdate: 'plan', entries: [{ content: 'a', status: 'completed', priority: 'high' }] }), [{ t: 'plan', entries: [{ text: 'a', status: 'completed' }] }])
	assert.deepEqual(c.toEvents({ sessionUpdate: 'plan', entries: [] }), [])
	assert.deepEqual(c.toEvents({ sessionUpdate: 'usage_update', used: 10, size: 100 }), [{ t: 'usage', used: 10, size: 100 }])
	assert.deepEqual(c.toEvents({ sessionUpdate: 'available_commands_update', availableCommands: [] }), [])
	assert.deepEqual(c.toEvents({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' }), [])
})

test('a diff is cut at 20 KB and a tool output at 4 KB, and the cut says so', () => {
	const big = 'x'.repeat(c.MAX_DIFF_CHARS + 500)
	const [e] = c.toEvents({ sessionUpdate: 'tool_call', toolCallId: 't', title: 'W', content: [{ type: 'diff', path: '/a', oldText: big, newText: big }, { type: 'content', content: { type: 'text', text: 'y'.repeat(c.MAX_OUT_CHARS + 10) } }] })
	assert.ok(e.diffs[0].old.length < c.MAX_DIFF_CHARS + 60 && e.diffs[0].new.length < c.MAX_DIFF_CHARS + 60)
	assert.match(e.diffs[0].new, /… \(500 more characters\)$/)
	assert.ok(e.out.length < c.MAX_OUT_CHARS + 60)
	assert.match(e.out, /… \(10 more characters\)$/)
})

const opts = [{ optionId: 'a', name: 'Allow', kind: 'allow_always' }, { optionId: 'o', name: 'Once', kind: 'allow_once' }, { optionId: 'r', name: 'Reject', kind: 'reject_once' }]

// A session folder with a .git, a .claude and a link that points out of it.
const cwdOf = () => {
	const base = realpathSync(mkdtempSync(join(tmp, 'cwd-')))
	const root = join(base, 'proj')
	for (const d of ['src', '.git/hooks', '.claude', 'src/.vscode']) { mkdirSync(join(root, d), { recursive: true }) }
	mkdirSync(join(base, 'outside'))
	if (process.platform !== 'win32') { symlinkSync(join(base, 'outside'), join(root, 'src', 'escape')) }
	return { base, root }
}

test('auto-answer: bypass answers everything, acceptEdits and auto only edits inside the folder, default and plan nothing', () => {
	const { root } = cwdOf()
	const where = { cwd: root, files: [join(root, 'src', 'a.ts')] }
	const pick = (mode, kind, options = opts, w = where) => c.autoAnswer(mode, kind, options, w)?.optionId
	// bypass is the user's explicit "everything", wherever and whatever.
	for (const kind of ['edit', 'execute', 'read', undefined, null]) { assert.equal(pick('bypassPermissions', kind, opts, { cwd: root, files: [] }), 'o', kind) }
	for (const mode of ['acceptEdits', 'auto']) {
		assert.equal(pick(mode, 'edit'), 'o', mode)
		for (const kind of ['execute', 'read', 'fetch', undefined]) { assert.equal(pick(mode, kind), undefined, mode + kind) }
	}
	for (const mode of ['default', 'plan', 'dontAsk', '']) { assert.equal(pick(mode, 'edit'), undefined, mode) }
	// allow_once is preferred, any allow_* is the fallback, and a question with only rejections is never answered.
	assert.equal(pick('bypassPermissions', 'edit', [opts[0], opts[2]]), 'a')
	assert.equal(pick('bypassPermissions', 'edit', [opts[2]]), undefined)
})

test('an edit is answered for the user only when every file is inside the folder and outside .git, .claude and .vscode', () => {
	const { base, root } = cwdOf()
	const inside = f => c.editsInside(root, [f])
	assert.equal(inside(join(root, 'src', 'a.ts')), true)
	assert.equal(inside(join(root, 'src', 'new', 'deep', 'b.ts')), true, 'a file that does not exist yet')
	assert.equal(inside('src/a.ts'), true, 'a relative path is the session folder\'s')
	assert.equal(inside(join(root, '..', 'proj', 'src', 'a.ts')), true, 'a .. that comes back in is fine')
	// Outside, and traversal.
	assert.equal(inside(join(base, 'outside', 'x.ts')), false)
	assert.equal(inside(join(root, '..', 'outside', 'x.ts')), false)
	assert.equal(inside(join(root + '-sibling', 'x.ts')), false, 'a sibling named like the folder plus a suffix')
	assert.equal(inside('../x.ts'), false)
	// The folders that decide what runs next.
	assert.equal(inside(join(root, '.git', 'hooks', 'pre-commit')), false)
	assert.equal(inside(join(root, '.claude', 'settings.json')), false)
	assert.equal(inside(join(root, 'src', '.vscode', 'tasks.json')), false)
	assert.equal(inside(join(root, '.GIT', 'config')), false, 'a case-insensitive disk spells it any way')
	assert.equal(inside(join(root, '.Claude', 'settings.json')), false)
	assert.equal(inside(join(root, '.mcp.json')), false, 'the folder\'s MCP servers run code')
	assert.equal(inside(join(root, '.MCP.json')), false)
	// Windows drops trailing dots and spaces and reads `name:stream` as the name: a folder that does not exist yet is created as the protected one.
	for (const name of ['.vscode.', '.claude ', '.git. .', '.mcp.json.', '.vscode::$INDEX_ALLOCATION']) { assert.equal(inside(join(root, 'src', name, 'x')), false, name) }
	assert.equal(inside(join(root, 'src', '.mcp.jsonl')), true, 'only that name')
	// No location, no folder, or one bad file among good ones: ask.
	assert.equal(c.editsInside(root, []), false)
	assert.equal(c.editsInside('', [join(root, 'src', 'a.ts')]), false)
	assert.equal(c.editsInside(root, [join(root, 'src', 'a.ts'), join(base, 'outside', 'x.ts')]), false)
	// An empty location would resolve to the folder itself; a URI is not a path this check can follow.
	assert.equal(inside(''), false)
	assert.equal(c.editsInside(root, [join(root, 'src', 'a.ts'), '']), false)
	assert.equal(inside('file://' + join(base, 'outside', 'x.ts')), false)
	assert.equal(inside('file://' + join(root, 'src', 'a.ts')), false)
	assert.equal(inside('vscode-remote://host/src/a.ts'), false)
	// A link inside the folder that points out of it.
	if (process.platform !== 'win32') { assert.equal(inside(join(root, 'src', 'escape', 'x.ts')), false) }
	// Through the answer rule: an edit outside is not answered even in acceptEdits and auto.
	for (const mode of ['acceptEdits', 'auto']) {
		assert.equal(c.autoAnswer(mode, 'edit', opts, { cwd: root, files: [join(base, 'outside', 'x.ts')] }), undefined)
		assert.equal(c.autoAnswer(mode, 'edit', opts, { cwd: root, files: [] }), undefined)
		assert.equal(c.autoAnswer(mode, 'edit', opts, { cwd: root, files: [join(root, '.git', 'hooks', 'x')] }), undefined)
	}
})

// A repository can ship a link whose target does not exist yet: a write through it creates the target wherever it points.
test('a link that leads nowhere is never answered for the user, however it dangles', { skip: process.platform === 'win32' && 'a symbolic link needs a privilege a Windows runner does not have' }, () => {
	const { base, root } = cwdOf()
	const link = (name, target) => { symlinkSync(target, join(root, name)); return join(root, name) }
	const inside = f => c.editsInside(root, [f])
	assert.equal(inside(link('notes.md', '../outside/evil.plist')), false, 'out of the folder')
	assert.equal(inside(link('readme2.md', '.claude/settings.local.json')), false, 'into a protected folder')
	assert.equal(inside(link('plain.md', 'missing.md')), false, 'even into the folder: the target is not the file that was named')
	assert.equal(inside(link('loop.md', 'loop.md')), false, 'a loop')
	// A dangling link as a folder on the way, however deep.
	link('gone', join(base, 'outside', 'nothing'))
	assert.equal(inside(join(root, 'gone', 'x.ts')), false)
	assert.equal(inside(join(root, 'gone', 'a', 'b', 'x.ts')), false)
	assert.equal(c.editsInside(root, [join(root, 'src', 'a.ts'), join(root, 'notes.md')]), false, 'one bad file among good ones')
	// A link to something that exists is judged by where it lands, as before.
	writeFileSync(join(root, 'src', 'real.ts'), '')
	assert.equal(inside(link('ok.ts', 'src/real.ts')), true)
	assert.equal(inside(link('esc.md', '../outside')), false)
	assert.equal(c.autoAnswer('acceptEdits', 'edit', opts, { cwd: root, files: [join(root, 'notes.md')] }), undefined)
})

// The window's own folder is told from a transcript's cwd by this: VS Code spells a Windows drive letter in lower case, Claude Code in capitals.
test('samePath: Windows ignores case, every other platform does not', () => {
	assert.equal(c.samePath('c:\\Users\\me\\app', 'C:\\Users\\me\\App', 'win32'), true)
	assert.equal(c.samePath('c:\\Users\\me\\app', 'c:\\Users\\me\\app2', 'win32'), false)
	for (const platform of ['darwin', 'linux']) { assert.equal(c.samePath('/Users/me/app', '/users/me/app', platform), false, platform) }
	assert.equal(c.samePath('/Users/me/app', '/Users/me/app', 'linux'), true)
})

test('the recorded decision', () => {
	assert.equal(c.permissionDecision(undefined, false), 'cancelled')
	assert.equal(c.permissionDecision(opts[2], false), 'denied')
	assert.equal(c.permissionDecision(opts[1], true), 'auto')
	assert.equal(c.permissionDecision(opts[1], false), 'allowed')
})

test('diffsOf keeps only diffs that name a file', () => {
	assert.deepEqual(c.diffsOf([{ type: 'diff', path: '/a', newText: 'x' }, { type: 'diff', newText: 'y' }, { type: 'content' }]), [{ path: '/a', oldText: null, newText: 'x' }])
	assert.deepEqual(c.diffsOf(undefined), [])
})

const mode = { id: 'mode', name: 'Mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Manual' }, { value: 'plan', name: 'Plan' }] }
const model = { id: 'model', name: 'Model', type: 'select', currentValue: 'a', options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }] }

test('config chips: grouped options are flattened, the user\'s mode wins and is listed even when the adapter does not offer it', () => {
	const view = c.configView([mode, model, { id: 'agent', name: 'Agent', type: 'select', currentValue: 'x', options: [] }, { id: 'flag', name: 'F', type: 'boolean', currentValue: true }], 'bypassPermissions')
	assert.deepEqual(view.map(o => o.id), ['mode', 'model'])
	assert.equal(view[0].value, 'bypassPermissions')
	assert.deepEqual(view[0].items.map(i => i.value), ['default', 'plan', 'bypassPermissions'])
	assert.equal(view[0].items[2].name, 'Bypass Permissions')
	assert.deepEqual(view[1].items, [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }])
	assert.equal(c.configAccepts(view, 'mode', 'bypassPermissions'), true)
	assert.equal(c.configAccepts(view, 'model', 'b'), true)
	assert.equal(c.configAccepts(view, 'model', 'zzz'), false)
	assert.equal(c.configAccepts(view, 'agent', 'x'), false)
	assert.equal(c.configAccepts(view, 'nope', 'a'), false)
})

test('appendEvent: chunks join, a tool card is filled in by id, a plan replaces its earlier copy, and the cap drops the oldest', () => {
	const buf = []
	const sent = { t: 'text', text: 'he' }
	c.appendEvent(buf, sent)
	c.appendEvent(buf, { t: 'text', text: 'llo' })
	assert.equal(sent.text, 'he', 'the event that was passed in is not changed by a later chunk')
	c.appendEvent(buf, { t: 'thought', text: 'x' })
	c.appendEvent(buf, { t: 'tool', id: 't', title: 'Read', status: 'pending' })
	c.appendEvent(buf, { t: 'text', text: 'after' })
	c.appendEvent(buf, { t: 'tool', id: 't', status: 'completed' })
	c.appendEvent(buf, { t: 'plan', entries: [{ text: 'a', status: 'pending' }] })
	c.appendEvent(buf, { t: 'plan', entries: [{ text: 'a', status: 'completed' }] })
	assert.deepEqual(buf, [
		{ t: 'text', text: 'hello' }, { t: 'thought', text: 'x' }, { t: 'tool', id: 't', title: 'Read', status: 'completed' }, { t: 'text', text: 'after' },
		{ t: 'plan', entries: [{ text: 'a', status: 'completed' }] },
	])
	const capped = []
	for (let i = 0; i < 12; i++) { c.appendEvent(capped, { t: 'error', text: String(i) }, 5) }
	assert.deepEqual(capped.map(e => e.text), ['7', '8', '9', '10', '11'])
})

test('chunks join within one message id; a user chunk without an id is a message of its own', () => {
	assert.deepEqual(c.toEvents({ sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'hi' } }), [{ t: 'user', text: 'hi', mid: 'u1' }])
	assert.deepEqual(c.toEvents({ sessionUpdate: 'agent_message_chunk', messageId: null, content: { type: 'text', text: 'hi' } }), [{ t: 'text', text: 'hi' }])
	const buf = []
	for (const e of [{ t: 'user', text: 'a' }, { t: 'user', text: 'b' }, { t: 'user', text: 'c', mid: 'u1' }, { t: 'user', text: 'd', mid: 'u1' }, { t: 'user', text: 'e', mid: 'u2' },
		{ t: 'text', text: 'x', mid: 'm1' }, { t: 'text', text: 'y', mid: 'm1' }, { t: 'text', text: 'z', mid: 'm2' }, { t: 'text', text: 'p' }, { t: 'text', text: 'q' }]) { c.appendEvent(buf, e) }
	assert.deepEqual(buf.map(e => e.text), ['a', 'b', 'cd', 'e', 'xy', 'z', 'pq'])
})

test('allow-with-updates elevates to acceptEdits on an edit question only; the plan ids keep their modes', () => {
	assert.equal(c.elevatingMode({ optionId: 'allow-with-updates' }, 'edit'), 'acceptEdits')
	for (const kind of ['execute', 'read', 'fetch', undefined, null]) {
		assert.equal(c.elevatingMode({ optionId: 'allow-with-updates' }, kind), undefined, String(kind))
	}
	assert.equal(c.elevatingMode({ optionId: 'allow-once' }, 'edit'), undefined)
	assert.equal(c.elevatingMode({ optionId: 'exit-plan-bypass' }), 'bypassPermissions')
	assert.equal(c.elevatingMode({ optionId: 'exit-plan-default' }), undefined)
})

test('the plain answer to an edit question is its allow-once option', () => {
	const options = [{ optionId: 'allow-with-updates', kind: 'allow_always' }, { optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }]
	assert.equal(c.plainEditAnswer(options).optionId, 'allow-once')
	assert.equal(c.plainEditAnswer([{ optionId: 'x', kind: 'allow_once' }]).optionId, 'x')
	assert.equal(c.plainEditAnswer([{ optionId: 'allow-with-updates', kind: 'allow_always' }]), undefined)
})
