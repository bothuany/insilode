// The Agents page is one document built from strings in src/agentsPage.ts; a quote lost in them breaks the whole page without
// a word. This builds the page, checks its CSP and that nothing is loaded from outside, runs its script in a small fake DOM
// and checks what it draws from the host's messages and what it posts back.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let html
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-agents-page-'))
	// Bundled without a vscode stub: the page must stay free of `vscode` (the website renders it too).
	const outfile = join(tmp, 'agentsPage.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'agentsPage.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	html = (await import(pathToFileURL(outfile).href)).agentsHtml()
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const scriptOf = () => /<script>([\s\S]*)<\/script>/.exec(html)[1]

// ---- a DOM with just what the page uses ------------------------------------------------------------------------------------
class Node {
	constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = undefined; this.className = ''; this._text = ''; this.value = ''; this.hidden = false; this.innerHTML = ''; this.scrollTop = 0 }
	get firstChild() { return this.children[0] }
	get lastChild() { return this.children[this.children.length - 1] }
	appendChild(c) { if (c.parent) { c.parent.removeChild(c) } c.parent = this; this.children.push(c); return c }
	removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parent = undefined; return c }
	setAttribute(k, v) { this.attrs[k] = String(v) }
	getAttribute(k) { return this.attrs[k] }
	addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }
	contains(n) { return n === this || this.children.some(c => c.contains(n)) }
	focus() { Node.focused = this }
	blur() { if (Node.focused === this) { Node.focused = undefined } }
	get textContent() { return this.isText ? this._text : this.children.map(c => c.textContent).join('') }
	set textContent(v) { this.children = []; this._text = String(v) ; if (v !== '') { const t = new Node('#text'); t.isText = true; t._text = String(v); t.parent = this; this.children.push(t) } }
	fire(type, extra = {}) { const e = { type, target: this, key: undefined, preventDefault() {}, stopPropagation() {}, ...extra }; for (const f of this.listeners[type] || []) { f(e) } }
	walk(f) { f(this); this.children.forEach(c => c.walk(f)) }
	find(pred) { const out = []; this.walk(n => { if (!n.isText && pred(n)) { out.push(n) } }); return out }
	byClass(c) { return this.find(n => n.className.split(' ').includes(c)) }
	button(label) { return this.find(n => n.tagName === 'BUTTON' && n.textContent.trim() === label)[0] }
}

function boot({ vscodeApi = true } = {}) {
	const posted = []
	const parentPosted = []
	const body = new Node('body')
	const docListeners = {}
	Node.focused = undefined
	const document = {
		body,
		createElement: t => new Node(t),
		createTextNode: s => { const t = new Node('#text'); t.isText = true; t._text = String(s); return t },
		addEventListener: (t, f) => { (docListeners[t] ||= []).push(f) },
		get activeElement() { return Node.focused },
	}
	let onMessage
	let tick
	const timers = []
	const win = { addEventListener: (t, f) => { if (t === 'message') { onMessage = f } }, parent: { postMessage: (m, o) => parentPosted.push([JSON.parse(JSON.stringify(m)), o]) } }
	win.window = win
	const ctx = { window: win, document, setInterval: f => { tick = f }, setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length }, Math, Object, isFinite, Date, String, Number, Map, Set, Array, JSON }
	if (vscodeApi) { ctx.acquireVsCodeApi = () => ({ postMessage: m => posted.push(JSON.parse(JSON.stringify(m))) }) }
	vm.runInNewContext(scriptOf(), ctx)
	const page = {
		body, posted, parentPosted, timers, tick: () => tick(),
		send: m => onMessage({ data: m }),
		data: (rows, extra = {}) => page.send({ type: 'data', now: Date.now(), avatar: 'pixel', rows, kept: [], customs: [], ...extra }),
		key: (key, extra = {}) => { const e = { type: 'keydown', key, target: body, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...extra }; for (const f of docListeners.keydown || []) { f(e) } },
		text: () => body.textContent,
	}
	return page
}

const row = (over = {}) => ({ id: 'a1', cli: 'claude', name: 'Claude 2', state: 'idle', since: Date.now(), todos: [], unread: false, done: 0, explain: false, skeletonOn: false, skeletonAvailable: false, acceptsInput: true, ...over })
const tokens = n => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 })
const rows = () => [
	row({ id: 'n', name: 'Needy', state: 'blocked', attention: 'approval', need: { kind: 'approval', source: 'permission', text: 'Run rm -rf build', at: 1 } }),
	row({ id: 'w', name: 'Worker', state: 'working', prompt: 'Fix the login bug', activity: 'Editing src/login.ts', todos: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }], done: 1,
		usage: { used: 80_000, size: 200_000 }, cost: { session: { tokens: tokens(1500), usd: 0.42 }, scope: 'session' }, cwd: '/work/app',
		pr: { number: 12, state: 'open', title: 'Fix login', url: 'x', checks: 'fail', counts: { pass: 3, fail: 1, pending: 0 }, failing: ['lint'], reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', comments: [], reviews: [], author: 'me', headRefOid: 'abc' },
		worktree: { branch: 'insilode/w', base: 'main', ahead: 2, behind: 1, uncommitted: 3 },
		impact: { files: 2, more: 0, flows: [{ label: 'GET /login' }], tables: [{ table: 'users', endpoints: 2 }] },
		clash: [{ text: 'Needy also edits login.ts', same: false, files: ['login.ts'] }], skeletonAvailable: true }),
	row({ id: 'd', name: 'Finisher', cli: 'codex', state: 'done', attention: 'done', unread: true, explain: true }),
	row({ id: 'e', name: 'Gone', state: 'ended', acceptsInput: false }),
]

test('the page has a locked-down CSP and loads nothing from outside', () => {
	assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">/)
	assert.doesNotMatch(html, /\b(?:src|href)\s*=\s*["']?https?:/i)
	assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i)
	assert.doesNotMatch(html, /require\(|\bimport\s+[\w{]/)
})

test('the page stays hidden until its first rows, so nothing jumps when they arrive; without a host it shows itself', () => {
	const app = p => p.body.find(n => n.attrs && n.attrs.id === 'app')[0]
	const p = boot()
	assert.equal(app(p).hidden, true)
	p.data([])
	assert.equal(app(p).hidden, false)
	const lone = boot({ vscodeApi: false })
	assert.equal(app(lone).hidden, true)
	for (const t of lone.timers) { t.f() }
	assert.equal(app(lone).hidden, false)
})

test('the inline script parses and posts ready', () => {
	assert.doesNotThrow(() => new vm.Script(scriptOf()))
	const p = boot()
	assert.deepEqual(p.posted, [{ type: 'ready' }])
})

test('without acquireVsCodeApi it posts to no window at all', () => {
	const p = boot({ vscodeApi: false })
	assert.deepEqual(p.parentPosted, [])
})

test('an empty list shows the friendly prompt with both start buttons', () => {
	const p = boot()
	p.data([])
	assert.match(p.text(), /No agents running/)
	p.posted.length = 0
	p.body.button('New Codex').fire('click')
	p.body.button('New Claude').fire('click')
	assert.deepEqual(p.posted, [{ type: 'new', cli: 'codex' }, { type: 'new', cli: 'claude' }])
})

test('the board sorts agents into columns and the header counts them', () => {
	const p = boot()
	p.data(rows(), { limits: { harness: 'claude', windows: [{ label: '5h', usedPercent: 40, resetsAt: Date.now() + 3_600_000 }] } })
	const cols = Object.fromEntries(p.body.find(n => n.tagName === 'SECTION').map(c => [c.attrs['aria-label'], c]))
	assert.match(cols['Needs you'].textContent, /Needy/)
	assert.match(cols['Needs you'].textContent, /Run rm -rf build/)
	assert.match(cols['Working'].textContent, /Worker/)
	assert.match(cols['Working'].textContent, /Fix the login bug/)
	assert.match(cols['Working'].textContent, /1\/3/)
	assert.match(cols['Working'].textContent, /ctx 40%/)
	assert.match(cols['Working'].textContent, /1\.5k tok · \$0\.42 est\./)
	assert.match(cols['Working'].textContent, /#12 open ✗ checks/)
	assert.match(cols['Working'].textContent, /⎇ insilode\/w ↑2 ↓1/)
	assert.match(cols['Done'].textContent, /Finisher/)
	assert.doesNotMatch(cols['Ended'].textContent, /Gone/, 'the Ended column is collapsed')
	const head = p.body.byClass('head')[0].textContent
	assert.match(head, /1Needs you/)
	assert.match(head, /1Working/)
	assert.match(head, /5h/)
	assert.match(head, /resets in 1h 0m/)
	assert.match(head, /1\.5k tokens/)
})

test('row text never becomes markup', () => {
	const p = boot()
	p.data([row({ name: '<img src=x onerror=alert(1)>', prompt: '<b>bold</b>' })])
	assert.match(p.text(), /<img src=x onerror=alert\(1\)>/)
	assert.equal(p.body.find(n => n.tagName === 'IMG' || (n.tagName === 'B' && n.textContent === 'bold')).length, 0)
})

test('selecting a card asks for its tail, shows it, and double-click opens the agent', () => {
	const p = boot()
	p.data(rows())
	const card = p.body.byClass('card').find(c => /Worker/.test(c.textContent))
	p.posted.length = 0
	card.fire('click')
	assert.deepEqual(p.posted, [{ type: 'tail', id: 'w' }])
	assert.match(p.body.byClass('detail')[0].textContent, /Loading/)
	p.send({ type: 'tail', id: 'w', entries: [{ role: 'user', text: 'hello agent' }, { role: 'assistant', text: 'on it' }, { role: 'tool', text: 'Edit src/login.ts' }] })
	const detail = p.body.byClass('detail')[0].textContent
	assert.match(detail, /hello agent/)
	assert.match(detail, /Edit src\/login\.ts/)
	assert.match(detail, /Fix login \(open\)/)
	assert.match(detail, /lint/)
	assert.match(detail, /Approved/)
	assert.match(detail, /table users \(2 endpoints\)/)
	assert.match(detail, /Needy also edits login\.ts/)
	card.fire('dblclick')
	assert.deepEqual(p.posted.at(-1), { type: 'show', id: 'w' })
	p.send({ type: 'tail', id: 'n', entries: [] })
	assert.doesNotMatch(p.body.byClass('detail')[0].textContent, /No messages/, 'a tail for another agent is not drawn')
	p.send({ type: 'tail', id: 'w', entries: [], note: 'No transcript yet' })
	assert.match(p.body.byClass('detail')[0].textContent, /No transcript yet/)
})

test('the detail panel posts the dock actions with the row id', () => {
	const p = boot()
	p.data(rows())
	p.body.byClass('card').find(c => /Worker/.test(c.textContent)).fire('click')
	const d = p.body.byClass('detail')[0]
	p.posted.length = 0
	d.button('Open PR').fire('click')
	d.button('X-ray').fire('click')
	d.button('Open').fire('click')
	d.button('GET /login').fire('click')
	d.button('Off').fire('click')
	d.button('Show').fire('click')
	assert.deepEqual(p.posted, [{ type: 'pr', id: 'w' }, { type: 'xray', id: 'w' }, { type: 'wt', id: 'w', action: 'open' }, { type: 'flow', id: 'w', index: 0 }, { type: 'sk', id: 'w', on: true }, { type: 'show', id: 'w' }])
})

test('merge and remove go straight to the host, which asks first', () => {
	const p = boot()
	p.data(rows())
	p.body.byClass('card').find(c => /Worker/.test(c.textContent)).fire('click')
	p.posted.length = 0
	const d = () => p.body.byClass('detail')[0]
	// The host asks before it merges or removes (worktreeFlow.ts): the page asks nothing of its own, so nobody confirms twice.
	d().button('Remove…').fire('click')
	d().button('Merge…').fire('click')
	assert.deepEqual(p.posted, [{ type: 'wt', id: 'w', action: 'remove' }, { type: 'wt', id: 'w', action: 'merge' }])
})

test('the reply box sends on Ctrl+Enter, keeps its text across repaints, and shows a failure', () => {
	const p = boot()
	p.data(rows())
	p.body.byClass('card').find(c => /Needy/.test(c.textContent)).fire('click')
	const box = p.body.find(n => n.tagName === 'TEXTAREA')[0]
	assert.ok(!p.body.byClass('reply')[0].className.includes('hidden'))
	box.value = 'yes, go on'
	box.fire('input')
	p.data(rows())
	assert.equal(box.value, 'yes, go on', 'a repaint leaves the textarea alone')
	p.posted.length = 0
	box.fire('keydown', { key: 'Enter', ctrlKey: true })
	assert.deepEqual(p.posted, [{ type: 'reply', id: 'n', text: 'yes, go on' }])
	assert.equal(box.value, '')
	p.send({ type: 'replyFailed', id: 'n' })
	assert.match(p.body.byClass('reply')[0].textContent, /could not be typed in/)
	assert.equal(box.value, 'yes, go on', 'the text comes back')
	box.value = ''
	box.fire('keydown', { key: 'Enter', ctrlKey: true })
	assert.equal(p.posted.filter(m => m.type === 'reply').length, 1, 'an empty reply is not sent')
})

test('the reply box is hidden for an agent that takes no input or has ended', () => {
	const p = boot()
	p.data(rows())
	p.body.byClass('card').find(c => /Finisher/.test(c.textContent)).fire('click')
	assert.ok(!p.body.byClass('reply')[0].className.includes('hidden'))
	p.data(rows().map(r => r.id === 'd' ? { ...r, acceptsInput: false } : r))
	assert.ok(p.body.byClass('reply')[0].className.includes('hidden'))
})

test('the keyboard moves the selection, opens the agent and clears with Escape; not while typing', () => {
	const p = boot()
	p.data(rows())
	p.posted.length = 0
	p.key('j')
	assert.match(p.body.byClass('detail')[0].textContent, /Needy/, 'the first card in board order is the one that needs you')
	p.key('j')
	assert.match(p.body.byClass('detail')[0].textContent, /Worker/)
	p.key('k')
	assert.match(p.body.byClass('detail')[0].textContent, /Needy/)
	p.posted.length = 0
	p.key('Enter')
	assert.deepEqual(p.posted, [{ type: 'show', id: 'n' }])
	p.key('/')
	assert.equal(Node.focused.tagName, 'INPUT')
	p.key('j', { target: Node.focused })
	assert.match(p.body.byClass('detail')[0].textContent, /Needy/, 'j typed into the search box does not move the selection')
	p.key('Escape', { target: body0() })
	p.key('Escape')
	assert.match(p.body.byClass('detail')[0].textContent, /Select an agent/)
	function body0() { return p.body }
})

test('filters narrow the board, the list view shows a dense row per agent, and ended can be shown', () => {
	const p = boot()
	p.data(rows())
	const search = p.body.find(n => n.tagName === 'INPUT')[0]
	search.value = 'login'
	search.fire('input')
	assert.doesNotMatch(p.body.byClass('main')[0].textContent, /Needy|Finisher/)
	assert.match(p.body.byClass('main')[0].textContent, /Worker/)
	search.value = ''
	search.fire('input')
	p.body.button('Unread').fire('click')
	assert.match(p.body.byClass('main')[0].textContent, /Finisher/)
	assert.doesNotMatch(p.body.byClass('main')[0].textContent, /Worker/)
	p.body.button('Unread').fire('click')
	p.body.button('Show ended').fire('click')
	assert.match(p.body.byClass('main')[0].textContent, /Gone/)
	p.body.button('List').fire('click')
	assert.equal(p.body.byClass('lrow').length, 4)
	assert.match(p.body.byClass('lhead')[0].textContent, /Agent.*CLI.*State/)
})

test('the New menu offers worktree, resume, custom agents and the picker', () => {
	const p = boot()
	p.data(rows(), { customs: ['Gemini', 'Aider'] })
	p.posted.length = 0
	p.body.button('More ▾').fire('click', { stopPropagation() {} })
	const menu = p.body.byClass('menu')[0]
	menu.button('Claude in a worktree').fire('click')
	p.body.button('More ▾').fire('click', { stopPropagation() {} })
	menu.button('Resume a Codex session…').fire('click')
	p.body.button('More ▾').fire('click', { stopPropagation() {} })
	menu.button('Aider').fire('click')
	p.body.button('More ▾').fire('click', { stopPropagation() {} })
	menu.button('Start an Agent…').fire('click')
	assert.deepEqual(p.posted, [{ type: 'start', cli: 'claude', how: 'worktree' }, { type: 'start', cli: 'codex', how: 'resume' }, { type: 'custom', index: 1, name: 'Aider' }, { type: 'pick' }])
})

test('kept worktrees get their own section with a Manage button', () => {
	const p = boot()
	p.data(rows(), { kept: [{ agent: 'Old agent', branch: 'insilode/old', base: 'main', folder: 'old-wt' }] })
	assert.match(p.body.byClass('kept')[0].textContent, /Old agent.*insilode\/old.*main.*old-wt/)
	p.posted.length = 0
	p.body.button('Manage…').fire('click')
	assert.deepEqual(p.posted, [{ type: 'kept' }])
	p.data(rows())
	assert.equal(p.body.byClass('kept').length, 0)
})

test('elapsed time ticks locally from the host clock', () => {
	const p = boot()
	const t0 = Date.now()
	p.data([row({ id: 'w', state: 'working', since: t0 - 65_000 })], { now: t0 })
	assert.match(p.body.byClass('state')[0].textContent, /Working · 1m 5s/)
})

// Writes the page and a sample of what it draws to the temp folder, for a person to open; nothing here opens a window.
test('the page renders a sample board', () => {
	const p = boot()
	p.data(rows())
	writeFileSync(join(tmp, 'agents.html'), html)
	writeFileSync(join(tmp, 'agents.txt'), p.text())
	assert.ok(p.text().length > 200)
})
