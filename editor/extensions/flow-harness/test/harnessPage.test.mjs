// The Harness page's pure parts (src/harnessPage.ts): the data it shows (sections, counts, muted and attention marks), what its
// messages may ask for, that nothing it shows has a credential in it, and its script run against a small fake DOM (the rail as a tab list,
// one section drawn). The panel itself (src/harnessPanel.ts) needs `vscode` and is not run here.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let hp
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-harness-page-'))
	const load = async name => {
		const outfile = join(tmp, `${name}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', mainFields: ['module', 'main'], outfile, logLevel: 'silent' })
		return import(pathToFileURL(outfile).href)
	}
	hp = await load('harnessPage')
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const PROJECT = '/work/app'
/** A summary as summaryCore builds it, with the lists a test wants filled. */
function summary(over = {}) {
	return {
		ok: true,
		summary: {
			root: PROJECT, score: 82, startupTokens: 1200,
			instructions: [
				{ name: 'CLAUDE.md', kind: 'instructions', scope: 'project', detail: 'Loaded in every session', tokens: 900, where: 'CLAUDE.md', file: `${PROJECT}/CLAUDE.md` },
				{ name: 'tests.md', kind: 'rules', scope: 'project', detail: 'Files matching test/**', where: '.claude/rules/tests.md', file: `${PROJECT}/.claude/rules/tests.md` },
			],
			hooks: [{ event: 'PreToolUse', matcher: 'Bash', command: 'node guard.js', scope: 'project', where: '.claude/settings.json', file: `${PROJECT}/.claude/settings.json`, line: 7 }],
			permissions: { mode: 'acceptEdits', modeWhere: '.claude/settings.json', counts: { allow: 1, ask: 0, deny: 1 }, allow: [{ pattern: 'Bash(npm test)', scope: 'project', where: '.claude/settings.json', file: `${PROJECT}/.claude/settings.json` }], ask: [], deny: [{ pattern: 'Bash(rm -rf *)', scope: 'user', where: '~/.claude/settings.json', file: '/home/me/.claude/settings.json' }] },
			mcp: [],
			skills: { count: 1, items: [{ name: 'deploy', scope: 'project', file: `${PROJECT}/.claude/skills/deploy/SKILL.md`, where: '.claude/skills/deploy/SKILL.md' }] },
			agents: { count: 0, items: [] },
			commands: { count: 0, items: [] },
			findings: [
				{ severity: 'error', message: 'A hook runs a script that does not exist', where: '.claude/settings.json', file: `${PROJECT}/.claude/settings.json`, line: 7, code: 'missing-script' },
				{ severity: 'warning', message: 'A long file: it costs many tokens in every session', where: 'CLAUDE.md', file: `${PROJECT}/CLAUDE.md`, line: 1, code: 'long-file' },
				{ severity: 'info', message: 'A path named here does not exist', where: '.claude/skills/deploy/SKILL.md', file: `${PROJECT}/.claude/skills/deploy/SKILL.md`, line: 3, code: 'broken-path' },
			],
			counts: { error: 1, warning: 1, info: 1 },
			notes: [],
			...over,
		},
	}
}
const server = (over = {}) => ({
	id: 'Claude|project|/work/app/.mcp.json|gh', name: 'gh', scope: 'project', transport: 'stdio', command: 'npx', args: ['-y', 'gh-mcp'], file: `${PROJECT}/.mcp.json`,
	state: 'on', stateWhy: 'Approved', shadowed: false, busy: false, issues: [], ...over,
})
const mcp = (servers = [server()], over = {}) => ({ servers, cli: { claude: true, codex: false }, trusted: true, problems: [], ...over })
const sectionOf = (d, id) => d.sections.find(s => s.id === id)

test('the sections come in the rail order with their counts, zero ones muted, and lint findings in the attention count', () => {
	const d = hp.buildPageData({ root: PROJECT, summary: summary(), mcp: mcp() })
	assert.deepEqual(d.sections.map(s => s.id), ['lint', 'instructions', 'hooks', 'permissions', 'mcp', 'skills', 'subagents', 'commands'])
	assert.deepEqual(d.sections.map(s => s.label), ['Lint', 'Instructions', 'Hooks', 'Permissions', 'MCP servers', 'Skills', 'Subagents', 'Slash commands'])
	const counts = Object.fromEntries(d.sections.map(s => [s.id, s.count]))
	assert.deepEqual(counts, { lint: 3, instructions: 2, hooks: 1, permissions: 2, mcp: 1, skills: 1, subagents: 0, commands: 0 })
	assert.deepEqual(d.sections.filter(s => s.muted).map(s => s.id), ['subagents', 'commands'], 'only the empty sections are muted')
	assert.equal(d.project, 'app')
	assert.equal(d.score, 82)
	assert.equal(d.attention, 2, 'errors and warnings, not the info line')
	// The hook finding goes to Hooks by its check, the long file to Instructions by its file; the info finding does not call for attention.
	const attention = Object.fromEntries(d.sections.map(s => [s.id, s.attention]))
	assert.deepEqual(attention, { lint: 2, instructions: 1, hooks: 1, permissions: 0, mcp: 0, skills: 0, subagents: 0, commands: 0 })
	assert.match(d.intro.permissions, /Default mode: acceptEdits/)
	assert.equal(d.lists.permissions[0].tag, 'allow')
	assert.equal(d.lists.hooks[0].name, 'PreToolUse · Bash')
	assert.equal(d.lists.instructions[1].tag, 'rule')
})

test('a folder with an empty harness has every list section muted and nothing to look at', () => {
	const empty = summary({ instructions: [], hooks: [], permissions: { counts: { allow: 0, ask: 0, deny: 0 }, allow: [], ask: [], deny: [] }, skills: { count: 0, items: [] }, findings: [], counts: { error: 0, warning: 0, info: 0 } })
	const d = hp.buildPageData({ root: PROJECT, summary: empty, mcp: mcp([]) })
	assert.ok(d.sections.every(s => s.count === 0 && s.muted && s.attention === 0))
	assert.equal(d.attention, 0)
	assert.equal(d.loading, false)
})

test('before the summary is read the page is loading, and a summary that failed says why while the servers still show', () => {
	const loading = hp.buildPageData({ root: PROJECT, mcp: mcp() })
	assert.equal(loading.loading, true)
	assert.equal(sectionOf(loading, 'mcp').count, 1)
	const failed = hp.buildPageData({ root: PROJECT, summary: { ok: false, message: 'Reading the harness took too long.' }, mcp: mcp() })
	assert.equal(failed.loading, false)
	assert.equal(failed.error, 'Reading the harness took too long.')
	assert.equal(sectionOf(failed, 'mcp').count, 1)
	const none = hp.buildPageData({})
	assert.equal(none.loading, false, 'no folder, nothing to wait for')
	assert.equal(none.project, '')
})

test('a finding is routed by its check first, then by the file it is in', () => {
	const files = { skills: new Set(['/a/SKILL.md']) }
	assert.equal(hp.sectionOfFinding({ code: 'shadowed', file: '/a/SKILL.md' }, files), 'permissions')
	assert.equal(hp.sectionOfFinding({ code: 'no-description', file: '/a/SKILL.md' }, files), 'skills')
	assert.equal(hp.sectionOfFinding({ code: 'no-description', file: '/elsewhere' }, files), undefined)
	assert.equal(hp.sectionOfFinding({ code: 'constructor', file: '/elsewhere' }, files), undefined, 'a code that is an Object property is not a section')
})

test('an open request is honoured only for a file the host sent, a line only as a positive whole number', () => {
	const d = hp.buildPageData({ root: PROJECT, summary: summary(), mcp: mcp() })
	const files = hp.openable(d)
	assert.ok(files.has(`${PROJECT}/CLAUDE.md`) && files.has('/home/me/.claude/settings.json') && files.has(`${PROJECT}/.claude/skills/deploy/SKILL.md`))
	assert.deepEqual(hp.parseMessage({ type: 'open', file: `${PROJECT}/CLAUDE.md`, line: 4 }, files), { kind: 'open', file: `${PROJECT}/CLAUDE.md`, line: 4 })
	assert.deepEqual(hp.parseMessage({ type: 'open', file: `${PROJECT}/CLAUDE.md`, line: -3 }, files), { kind: 'open', file: `${PROJECT}/CLAUDE.md` })
	assert.deepEqual(hp.parseMessage({ type: 'open', file: `${PROJECT}/CLAUDE.md`, line: 1.5 }, files), { kind: 'open', file: `${PROJECT}/CLAUDE.md` })
	for (const file of ['/etc/passwd', `${PROJECT}/../../etc/passwd`, '', undefined, 7, null, { toString: () => `${PROJECT}/CLAUDE.md` }, 'x'.repeat(5000)]) {
		assert.equal(hp.parseMessage({ type: 'open', file }, files), undefined, `refused: ${String(file).slice(0, 30)}`)
	}
	// With nothing sent yet, nothing may be opened.
	assert.equal(hp.parseMessage({ type: 'open', file: `${PROJECT}/CLAUDE.md` }, new Set()), undefined)
})

test('an unknown message, view or action is dropped, and a command id from the page means nothing', () => {
	const none = new Set()
	for (const m of [null, undefined, 'ready', 7, [], {}, { type: 7 }, { type: 'command', id: 'workbench.action.quit' }, { type: 'executeCommand', command: 'flowHarness.refresh' },
		{ type: 'view', view: 'workbench.action.quit' }, { type: 'view' }, { type: 'mcp' }, { type: 'mcp', action: 'run' }, { type: 'mcp', action: 7 },
		{ type: 'mcp', action: 'check' }, { type: 'mcp', action: 'remove', id: '' }, { type: 'mcp', action: 'edit', id: 5 }, { type: 'mcp', action: 'edit', id: 'x'.repeat(2000) },
		{ type: 'mcp', action: 'constructor', id: 'a' }, { type: '__proto__' }]) {
		assert.equal(hp.parseMessage(m, none), undefined, JSON.stringify(m))
	}
	assert.deepEqual(hp.parseMessage({ type: 'ready' }, none), { kind: 'ready' })
	assert.deepEqual(hp.parseMessage({ type: 'refresh' }, none), { kind: 'refresh' })
	assert.deepEqual(hp.parseMessage({ type: 'why', file: '/etc/passwd' }, none), { kind: 'why' }, 'the file for Why? is the host\'s to choose')
	assert.deepEqual(hp.parseMessage({ type: 'view', view: 'map' }, none), { kind: 'view', view: 'map' })
	assert.deepEqual(hp.parseMessage({ type: 'view', view: 'flow' }, none), { kind: 'view', view: 'flow' })
	assert.deepEqual(hp.parseMessage({ type: 'mcp', action: 'add', id: 'ignored' }, none), { kind: 'mcp', action: 'add' })
	assert.deepEqual(hp.parseMessage({ type: 'mcp', action: 'checkAll' }, none), { kind: 'mcp', action: 'checkAll' })
	for (const action of ['check', 'open', 'edit', 'toggle', 'remove']) {
		assert.deepEqual(hp.parseMessage({ type: 'mcp', action, id: 's1' }, none), { kind: 'mcp', action, id: 's1' })
	}
})

test('what the page shows stays redacted: an MCP command or URL, a hook command, a permission rule, a check status', () => {
	const KEY = 'sk-test-0123456789abcdefghij'
	const secrets = [KEY, 'hunter2hunter2', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789']
	const d = hp.buildPageData({
		root: PROJECT,
		summary: summary({
			hooks: [{ event: 'Stop', command: `curl -H "Authorization: Bearer ${secrets[2]}" https://x.test`, scope: 'project', where: 's', file: '/work/app/s' }],
			permissions: { counts: { allow: 1, ask: 0, deny: 0 }, allow: [{ pattern: `Bash(deploy --token ${secrets[1]})`, scope: 'project', where: 's', file: '/work/app/s' }], ask: [], deny: [] },
		}),
		mcp: mcp([
			server({ command: 'node', args: ['srv.js', '--api-key', KEY], stateWhy: `Approved with token=${secrets[1]}`, readOnly: `api_key=${secrets[1]}`, issues: [{ severity: 'error', message: `Bad line: "api_key": "${secrets[1]}"` }] }),
			server({ id: 'b', name: 'web', transport: 'http', url: `https://mcp.test/sse?token=${secrets[1]}&x=1`, command: undefined, args: [], check: { ok: false, status: `401 for ${secrets[2]}`, at: 1, ms: 5, how: 'handshake' } }),
		], { problems: [{ file: '~/.codex/config.toml', message: `invalid value at password = "${secrets[1]}"` }] }),
	})
	const shown = JSON.stringify(d)
	for (const secret of secrets) {
		assert.ok(!shown.includes(secret), `${secret} is not in the data the page gets`)
	}
	assert.match(d.mcp.servers[0].target, /srv\.js/, 'the shape of the line stays readable')
	assert.match(d.mcp.servers[1].target, /\*\*\*/)
})

test('an MCP row names where the server is written with the home folder as ~, and says when it cannot be checked', () => {
	const d = hp.buildPageData({ root: PROJECT, home: '/home/me', mcp: mcp([server({ file: '/home/me/.claude.json', scope: 'user' }), server({ id: 'p', file: `${PROJECT}/.mcp.json` })], { trusted: false }) })
	assert.equal(d.mcp.servers[0].where, '~/.claude.json')
	assert.equal(d.mcp.servers[0].blocked, false)
	assert.equal(d.mcp.servers[1].blocked, true, "a repository's server is not started in an untrusted folder")
})

// ---------------------------------------------------------------------------------------------
// The page's own script, against a small fake DOM.

class Node_ {
	constructor(tag, byId) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.dataset = {}; this.byId = byId }
	setAttribute(k, v) {
		this.attrs[k] = v
		if (k === 'id') this.byId.set(v, this)
		if (k.startsWith('data-')) this.dataset[k.slice(5)] = v
	}
	addEventListener(t, f) { (this.listeners[t] ??= []).push(f) }
	append(...k) { this.children.push(...k) }
	replaceChildren(...k) { this.children = k }
	set textContent(v) { this.children = [String(v)] }
	get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join('') }
	walk() { return this.children.flatMap(c => typeof c === 'string' ? [] : [c, ...c.walk()]) }
	querySelectorAll(sel) {
		// Only the last part of a descendant selector (".menu [role=menuitem]"): enough for what the page asks.
		const attr = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(sel.split(' ').pop())
		return attr ? this.walk().filter(n => attr[2] === undefined ? attr[1] in n.attrs : n.attrs[attr[1]] === attr[2]) : []
	}
	closest() { return null }
	focus() { this.doc.activeElement = this }
}

/** Runs the page's script with the data it is sent; returns what it posted and the nodes it drew. */
function runPage() {
	const html = hp.harnessHtml()
	const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)[1]
	const byId = new Map()
	const doc = { activeElement: null, listeners: {} }
	const make = tag => { const n = new Node_(tag, byId); n.doc = doc; return n }
	doc.createElement = make
	doc.getElementById = id => { if (!byId.has(id)) byId.set(id, make('div')); return byId.get(id) }
	doc.addEventListener = (t, f) => { (doc.listeners[t] ??= []).push(f) }
	doc.querySelectorAll = sel => [...new Set([...byId.values()].flatMap(n => n.querySelectorAll(sel)))]
	doc.querySelector = sel => doc.querySelectorAll(sel)[0] ?? null
	const posted = []
	const win = { listeners: {}, addEventListener(t, f) { (this.listeners[t] ??= []).push(f) } }
	const ctx = vm.createContext({ acquireVsCodeApi: () => ({ postMessage: m => posted.push(JSON.parse(JSON.stringify(m))) }), document: doc, window: win, Node: Node_, setTimeout: () => 0, Object, String, Math, Date, JSON })
	vm.runInContext(script, ctx)
	const send = data => win.listeners.message[0]({ data: { type: 'data', data } })
	const go = id => byId.get('tab-' + id).listeners.click[0]()
	const key = (id, k) => { let stopped = false; byId.get('tab-' + id).listeners.keydown[0]({ key: k, preventDefault() { stopped = true } }); return stopped }
	return { html, posted, byId, doc, send, key, go }
}

test('the page is a webview with a nonce policy and no inline handler, and says it is ready', () => {
	const { html, posted } = runPage()
	assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-/)
	const markup = html.replace(/<script[\s\S]*<\/script>/, '').replace(/<style>[\s\S]*<\/style>/, '')
	assert.doesNotMatch(markup, /\son\w+\s*=/i, 'no inline handler')
	assert.doesNotMatch(html, /innerHTML|insertAdjacentHTML|document\.write/)
	assert.deepEqual(posted, [{ type: 'ready' }])
	for (const id of ['why', 'refresh', 'v-map', 'v-flow']) assert.match(markup, new RegExp(`id="${id}"`))
	assert.match(markup, /role="tablist"/)
})

test('the script draws the rail as a tab list: counts, selection, muted sections, attention counts', () => {
	const page = runPage()
	const d = hp.buildPageData({ root: PROJECT, summary: summary(), mcp: mcp(), why: 'index.ts' })
	page.send(d)
	const tabs = page.byId.get('tabs').children
	assert.equal(tabs.length, 8)
	assert.ok(tabs.every(t => t.attrs.role === 'tab' && t.attrs['aria-controls'] === 'main'))
	assert.deepEqual(tabs.map(t => t.attrs['aria-selected']), ['true', 'false', 'false', 'false', 'false', 'false', 'false', 'false'])
	assert.deepEqual(tabs.map(t => t.attrs.tabindex), ['0', '-1', '-1', '-1', '-1', '-1', '-1', '-1'], 'only the selected tab is in the Tab order')
	assert.equal(tabs[0].textContent, 'Lint3')
	assert.equal(tabs[6].textContent, 'Subagents0')
	assert.match(tabs[6].className, /\bmuted\b/)
	assert.doesNotMatch(tabs[1].className, /\bmuted\b/)
	const countOf = i => tabs[i].children[1]
	assert.match(countOf(0).className, /\battn\b/, 'Lint has findings to look at')
	assert.match(countOf(2).className, /\battn\b/, 'Hooks has the missing script')
	assert.doesNotMatch(countOf(3).className, /\battn\b/)
	assert.equal(page.byId.get('project').textContent, 'app')
	assert.equal(page.byId.get('health').textContent, 'Health 82 · 2 to look at')
	assert.equal(page.byId.get('whyfile').textContent, 'index.ts')
	assert.equal(page.byId.get('main').attrs['aria-labelledby'], 'tab-lint')
})

test('the arrow keys move through the tabs and select them, wrapping at both ends', () => {
	const page = runPage()
	page.send(hp.buildPageData({ root: PROJECT, summary: summary(), mcp: mcp() }))
	const selected = () => page.byId.get('tabs').children.findIndex(t => t.attrs['aria-selected'] === 'true')
	assert.equal(page.key('lint', 'ArrowDown'), true)
	assert.equal(selected(), 1)
	assert.equal(page.doc.activeElement, page.byId.get('tab-instructions'), 'focus follows')
	assert.equal(page.byId.get('main').attrs['aria-labelledby'], 'tab-instructions')
	page.key('instructions', 'ArrowUp')
	page.key('lint', 'ArrowUp')
	assert.equal(selected(), 7, 'up from the first wraps to the last')
	page.key('commands', 'ArrowDown')
	assert.equal(selected(), 0)
	page.key('lint', 'End')
	assert.equal(selected(), 7)
	page.key('commands', 'Home')
	assert.equal(selected(), 0)
	assert.equal(page.key('lint', 'a'), false, 'another key is left alone')
})

test('the script draws the selected section: lint findings that open the file at the line, a list with an empty line', () => {
	const page = runPage()
	page.send(hp.buildPageData({ root: PROJECT, summary: summary(), mcp: mcp() }))
	const main = page.byId.get('main')
	assert.match(main.textContent, /A hook runs a script that does not exist/)
	assert.match(main.textContent, /error/)
	const button = main.walk().find(n => n.tag === 'button' && n.textContent === '.claude/settings.json:7')
	assert.ok(button, 'the finding\'s place is a real button')
	button.listeners.click[0]()
	assert.deepEqual(page.posted.at(-1), { type: 'open', file: `${PROJECT}/.claude/settings.json`, line: 7 })
	page.key('lint', 'ArrowDown')
	assert.match(main.textContent, /CLAUDE\.md/)
	assert.match(main.textContent, /~900 tok/)
	page.key('instructions', 'ArrowDown')
	assert.match(main.textContent, /node guard\.js/)
	page.key('hooks', 'ArrowDown')
	assert.match(main.textContent, /Default mode: acceptEdits/)
	page.key('permissions', 'End')
	assert.equal(main.textContent, 'Slash commandsNo slash commands found.', 'an empty section says so in one line')
})

test('the MCP section: three actions per server with a menu for the rest, and Add and Check all on top', () => {
	const page = runPage()
	page.send(hp.buildPageData({ root: PROJECT, summary: summary(), mcp: mcp([server({ args: ['--api-key', 'sk-test-0123456789abcdefghij'] })]) }))
	page.go('mcp')
	const main = page.byId.get('main')
	assert.equal(page.byId.get('tab-mcp').attrs['aria-selected'], 'true')
	const buttons = () => main.walk().filter(n => n.tag === 'button')
	const label = n => n.attrs['aria-label'] || n.textContent
	assert.deepEqual(buttons().map(label), ['Add server…', 'Check all', 'Check gh', 'Open the file of gh', 'More actions for gh'])
	assert.ok(!main.textContent.includes('sk-test-0123456789abcdefghij'), 'the secret is not drawn')
	buttons().find(b => label(b) === 'Check gh').listeners.click[0]()
	buttons().find(b => b.textContent === 'Add server…').listeners.click[0]()
	buttons().find(b => b.textContent === 'Check all').listeners.click[0]()
	buttons().find(b => label(b) === 'Open the file of gh').listeners.click[0]()
	assert.deepEqual(page.posted.slice(-4), [
		{ type: 'mcp', action: 'check', id: server().id }, { type: 'mcp', action: 'add' }, { type: 'mcp', action: 'checkAll' }, { type: 'mcp', action: 'open', id: server().id },
	])
	// The menu holds the three that change something.
	const more = buttons().find(b => label(b) === 'More actions for gh')
	assert.equal(more.attrs['aria-haspopup'], 'menu')
	more.listeners.click[0]({ stopPropagation() { } })
	const items = main.walk().filter(n => n.attrs.role === 'menuitem')
	assert.deepEqual(items.map(n => n.textContent), ['Edit…', 'Turn off…', 'Remove…'])
	items[2].listeners.click[0]()
	assert.deepEqual(page.posted.at(-1), { type: 'mcp', action: 'remove', id: server().id })
	assert.equal(main.walk().filter(n => n.attrs.role === 'menuitem').length, 0, 'the menu closes after a choice')
})

test('a read-only server has no menu, an off server offers Turn on, and a server with no folder trust cannot be checked', () => {
	const page = runPage()
	page.send(hp.buildPageData({ root: PROJECT, summary: summary(), mcp: mcp([server({ readOnly: 'Set by a plugin', id: 'ro', name: 'plug' }), server({ state: 'off', id: 'off', name: 'old', scope: 'user' }), server({ id: 'p', name: 'repo' })], { trusted: false }) }))
	page.go('mcp')
	const main = page.byId.get('main')
	const buttons = main.walk().filter(n => n.tag === 'button')
	const names = buttons.map(b => b.attrs['aria-label'])
	assert.ok(!names.includes('More actions for plug'), 'a plugin\'s server is not editable')
	assert.ok(names.includes('More actions for old'))
	assert.ok('disabled' in buttons.find(b => b.attrs['aria-label'] === 'Check repo').attrs, 'a repository server in an untrusted folder')
	assert.ok(!('disabled' in buttons.find(b => b.attrs['aria-label'] === 'Check old').attrs))
	buttons.find(b => b.attrs['aria-label'] === 'More actions for old').listeners.click[0]({ stopPropagation() { } })
	assert.deepEqual(main.walk().filter(n => n.attrs.role === 'menuitem').map(n => n.textContent), ['Edit…', 'Turn on…', 'Remove…'])
})

test('the Views controls ask for the map and the flow page, and Why? and Refresh for themselves', () => {
	const page = runPage()
	page.byId.get('v-map').onclick()
	page.byId.get('v-flow').onclick()
	page.byId.get('why').onclick()
	page.byId.get('refresh').onclick()
	assert.deepEqual(page.posted.slice(1), [{ type: 'view', view: 'map' }, { type: 'view', view: 'flow' }, { type: 'why' }, { type: 'refresh' }])
})

test('the host only runs fixed commands for the page: no command id comes from a message', () => {
	const panel = readFileSync(join(ROOT, 'src', 'harnessPanel.ts'), 'utf8')
	const calls = [...panel.matchAll(/executeCommand\(([^)]*)\)/g)].map(m => m[1].split(',')[0].trim())
	assert.deepEqual(calls.sort(), ["'flow.showHarnessFlow'", "'flowHarness.why'", "'workbench.view.extension.flowHarness'"])
})
