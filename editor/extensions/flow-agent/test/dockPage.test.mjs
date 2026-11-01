// The Agents dock is one page built from strings in src/dockPage.ts; a quote lost in that string breaks the whole dock
// without a word. This builds the page, checks that its script parses and draws rows, and checks what a row is made of:
// a group of sibling buttons (never one inside another) that each name the agent they act on, in colours that read on both themes.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let html
let colors
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-dock-'))
	// The page lives in dockPage.ts, which has no `vscode` (the website renders it too): bundling it without a stub is the test that it stays so.
	const outfile = join(tmp, 'dockPage.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'dockPage.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	const mod = await import(pathToFileURL(outfile).href)
	html = mod.dockHtml()
	colors = mod.DOCK_COLORS
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const scriptOf = () => /<script>([\s\S]*)<\/script>/.exec(html)[1]

// A page with just enough of a DOM: the list, the menu and the start buttons, with the handlers the script installs kept for the test to call.
function boot() {
	const posted = []
	const list = { innerHTML: '', querySelectorAll: () => [], listeners: {}, addEventListener(type, f) { this.listeners[type] = f } }
	const focus = { on: undefined }
	const el = (dataset = {}) => ({ dataset, attrs: {}, setAttribute(k, v) { this.attrs[k] = v }, getBoundingClientRect: () => ({ left: 10, right: 120, bottom: 40 }), focus() { focus.on = this }, contains: () => false })
	const claude = el({ cli: 'claude' })
	const chev = el({ menu: 'claude' })
	const more = el({ cli: 'pick' })
	const items = [el({ how: 'worktree', cli: 'claude' }), el({ how: 'resume', cli: 'claude' })]
	for (const i of items) { i.closest = sel => sel === 'button[data-how]' ? i : null }
	const menu = { ...el(), hidden: true, style: {}, offsetWidth: 100, innerHTML: '', listeners: {}, addEventListener(type, f) { this.listeners[type] = f }, querySelectorAll: () => items, querySelector: () => items[0], contains: x => items.includes(x) }
	const byId = { list, menu }
	const docListeners = {}
	const document = {
		getElementById: id => byId[id],
		querySelectorAll: sel => sel === '.new button' ? [claude, chev, more] : [],
		addEventListener: (type, f) => { docListeners[type] = f },
		get activeElement() { return focus.on },
	}
	let onMessage
	const window = { addEventListener: (_type, f) => { onMessage = f }, innerWidth: 300, scrollY: 0 }
	window.window = window
	vm.runInNewContext(scriptOf(), { window, document, acquireVsCodeApi: () => ({ postMessage: m => posted.push(JSON.parse(JSON.stringify(m))) }), setInterval() { }, Math, Object, isFinite, Date, String, Number, Map })
	posted.length = 0
	return { list, menu, chev, claude, more, items, posted, focus, docListeners, send: (rows, extra = {}) => { onMessage({ data: { type: 'data', list: rows, now: Date.now(), avatar: 'pixel', ...extra } }); return list.innerHTML } }
}

const agent = (over = {}) => ({ id: 'a1', cli: 'claude', name: 'Claude 2', state: 'idle', since: Date.now(), todos: [], unread: false, done: 0, ...over })

test('the dock page script parses and draws an agent row with its avatar', () => {
	assert.doesNotThrow(() => new vm.Script(scriptOf()), 'the dock script is valid JavaScript')
	const { send } = boot()
	const out = send([agent({ state: 'blocked', attention: 'approval' })])
	assert.match(out, /class="agent blocked approval"/)
	assert.match(out, /<span class="av" data-k="[^"]+"><svg class="ax"/)
	assert.match(out, /Claude 2/)
})

test('the turn-impact line names a changed table and how many endpoints use it, with or without flows', () => {
	const { send } = boot()
	const draw = impact => send([agent({ state: 'done', attention: 'none', impact })])
	const both = draw({ files: 2, more: 0, flows: [{ label: 'GET /orders' }], tables: [{ table: 'orders', entity: 'Order', endpoints: 4 }] })
	assert.match(both, /This turn touched 1 flow and table orders \(4 endpoints\):/)
	assert.match(both, /data-flow="0"[^>]*>GET \/orders</)
	const only = draw({ files: 1, more: 0, flows: [], tables: [{ table: 'invoices', entity: 'Invoice', endpoints: 1, guess: true, partial: true }] })
	assert.match(only, /This turn touched table invoices\? \(1 endpoint, partial\)<\/b>/)
	assert.doesNotMatch(draw({ files: 1, more: 0, flows: [], tables: [] }), /class="impact"/)
})

test('a changed migration is named in the turn-impact line', () => {
	const { send } = boot()
	const out = send([agent({ state: 'done', attention: 'none', impact: { files: 1, more: 0, flows: [], tables: [{ table: 'orders', entity: 'Order', migration: '0007_orders_key', endpoints: 4 }] } })])
	assert.match(out, /This turn touched table orders \(migration 0007_orders_key, 4 endpoints\)<\/b>/)
})

// ---- the row is a group of sibling buttons ---------------------------------------------------------------------------

/** Every `<button>` of the markup with its attributes, and the deepest nesting of buttons (it must be 1: none inside another). */
function buttons(markup) {
	const found = []
	let depth = 0
	let deepest = 0
	for (const m of markup.matchAll(/<(\/?)button\b([^>]*)>/g)) {
		if (m[1]) { depth--; continue }
		depth++
		deepest = Math.max(deepest, depth)
		found.push(m[2])
	}
	assert.equal(depth, 0, 'every button is closed')
	return { found, deepest }
}
const label = attrs => /aria-label="([^"]*)"/.exec(attrs)?.[1]
const acts = attrs => /data-act="([^"]*)"/.exec(attrs)?.[1]

test('a row is a labelled group whose controls are sibling buttons, never a span or a button inside a button', () => {
	const { send } = boot()
	const out = send([agent({
		usage: { used: 80000, size: 200000, model: 'opus' }, explain: true, skeletonAvailable: true, skeletonOn: true,
		impact: { files: 1, more: 0, flows: [{ label: 'GET /orders' }], tables: [] },
		pr: { number: 7, title: 'T', state: 'open', checks: 'pass', counts: { pass: 1, fail: 0, pending: 0 }, failing: [] },
		worktree: { branch: 'insilode/x', base: 'main', ahead: 1, behind: 0 },
	})])
	assert.match(out, /<div class="agent idle" role="group" aria-label="Claude 2, Ready" data-id="a1">/)
	const { found, deepest } = buttons(out)
	assert.equal(deepest, 1, 'no button inside a button')
	assert.doesNotMatch(out, /role="button"/, 'no span pretending to be a button')
	// Every control is a button that says what it does; the main one is the row's text, the others name the agent.
	const named = found.filter(a => acts(a) !== 'open' && acts(a) !== 'sk' && acts(a) !== 'flow' && acts(a) !== 'pr' && acts(a) !== 'wt')
	for (const a of named) { assert.match(label(a) ?? '', /Claude 2|Context 40% full/, `${acts(a)} has an aria-label naming the agent`) }
	assert.equal(label(found.find(a => acts(a) === 'rename')), 'Rename Claude 2')
	assert.equal(label(found.find(a => acts(a) === 'swap')), 'Continue Claude 2 in Codex')
	assert.equal(label(found.find(a => acts(a) === 'compact')), 'Compact Claude 2')
	const wt = found.filter(a => acts(a) === 'wt')
	assert.equal(wt.length, 4, 'open, diff, merge and remove')
	for (const a of wt) { assert.match(label(a), /worktree of Claude 2/) }
	assert.match(found.find(a => acts(a) === 'sk'), /aria-pressed="true"/, 'the Skeleton toggle is a real button with aria-pressed')
	// Rename, swap and forget are in a strip of their own at the end (Tab order follows what the eye sees), after the content.
	assert.ok(out.indexOf('class="tools"') > out.indexOf('data-act="xray"'), 'the strip comes last')
	assert.ok(out.indexOf('class="tools"') > out.indexOf('data-act="open"'))
})

test('which controls a row has depends on the agent: an ended one forgets, a custom one has no skeleton or swap', () => {
	const { send } = boot()
	const actsOf = row => buttons(send([row])).found.map(acts)
	const live = actsOf(agent({ state: 'idle', skeletonAvailable: true, worktree: { branch: 'b', base: 'main' } }))
	assert.ok(live.includes('swap') && live.includes('rename') && live.includes('sk') && live.filter(a => a === 'wt').length === 4)
	assert.ok(!live.includes('forget'), 'a running agent is not forgotten from its row')
	const ended = actsOf(agent({ state: 'ended', worktree: { branch: 'b', base: 'main' } }))
	assert.ok(ended.includes('forget') && ended.includes('rename'))
	assert.ok(!ended.includes('swap') && !ended.includes('wt') && !ended.includes('sk'), 'an ended agent has no swap, worktree or skeleton button')
	assert.match(send([agent({ state: 'ended', worktree: { branch: 'b', base: 'main' } })]), /⎇ b/, 'its branch is still said')
	const custom = actsOf(agent({ cli: 'custom', state: 'idle', skeletonAvailable: false }))
	assert.ok(custom.includes('rename') && !custom.includes('sk') && !custom.includes('swap'))
	for (const state of ['working', 'blocked', 'starting']) {
		assert.ok(!actsOf(agent({ state })).includes('swap'), `no swap while ${state}`)
	}
})

test('the swap button names the other CLI, between turns only', () => {
	const { send } = boot()
	const draw = (cli, state) => send([agent({ cli, state })])
	assert.match(draw('claude', 'idle'), /data-act="swap" aria-label="Continue Claude 2 in Codex" title="Continue in Codex with this conversation"/)
	assert.match(draw('codex', 'done'), /data-act="swap" aria-label="Continue Claude 2 in Claude" title="Continue in Claude with this conversation"/)
	assert.doesNotMatch(draw('claude', 'ended'), /data-act="swap"/)
	assert.doesNotMatch(draw('custom', 'idle'), /data-act="swap"/)
})

test('the controls show on hover and on focus inside, stay out of the way of the state label and are at least 24px', () => {
	const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1]
	assert.match(css, /\.agent:hover \.tools, \.agent:focus-within \.tools \{[^}]*opacity: 1/)
	assert.match(css, /\.tools \{[^}]*max-height: 0/, 'the strip takes no room until it is shown')
	assert.doesNotMatch(css, /\.agent:hover \.state \{ visibility: hidden/, 'the state label is no longer hidden under the controls')
	assert.doesNotMatch(css, /\.ren, \.swp \{ position: absolute/, 'no control is placed over the label')
	for (const sel of ['.tools button', '.wt .act', '.explain .act', '.cmp', '.pr', '.impact .flow']) {
		const rule = new RegExp('(^|\\n)' + sel.replace(/[.]/g, '\\.') + ' \\{([^}]*)\\}').exec(css)
		assert.ok(rule && /min-height: 24px/.test(rule[2]), `${sel} is at least 24px high`)
	}
	assert.match(css, /\.tools button \{[^}]*min-width: 24px/)
	// A very long name is cut with an ellipsis inside its own cell, so the state label and the strip keep their place.
	assert.match(css, /\.name \{[^}]*min-width: 0[^}]*text-overflow: ellipsis/)
})

test('a click goes to the control that was pressed, with the id of its row; the row\'s text opens the agent', () => {
	const { send, list, posted } = boot()
	send([agent()])
	const row = { dataset: { id: 'a1' }, contains: () => true }
	const click = (act, extra = {}) => list.listeners.click({ target: { closest: sel => sel === '.agent' ? row : sel === 'button[data-act]' && act ? { dataset: { act, ...extra } } : null } })
	click('rename'); click('swap'); click('forget'); click('compact'); click('explain'); click('pr'); click('xray')
	click('wt', { wt: 'merge' }); click('flow', { flow: '2' }); click('sk', { on: 'on' }); click('sk', { on: 'off' }); click('open'); click(undefined)
	assert.deepEqual(posted.slice(0, 7), ['rename', 'swap', 'forget', 'compact', 'explain', 'pr', 'xray'].map(type => ({ type, id: 'a1' })))
	assert.deepEqual(posted.slice(7), [
		{ type: 'wt', id: 'a1', action: 'merge' }, { type: 'flow', id: 'a1', index: 2 }, { type: 'sk', id: 'a1', on: true }, { type: 'sk', id: 'a1', on: false },
		{ type: 'show', id: 'a1' }, { type: 'show', id: 'a1' },
	])
})

// ---- the start buttons and their menu --------------------------------------------------------------------------------

test('Claude and Codex are split buttons with a chevron that has a menu; the last one is "More agents…"', () => {
	const start = /<div class="new">([\s\S]*?)<div id="menu"/.exec(html)[1]
	const { found, deepest } = buttons(start)
	assert.equal(deepest, 1)
	const chevrons = found.filter(a => /class="chev"/.test(a))
	assert.equal(chevrons.length, 2)
	for (const a of chevrons) {
		assert.match(a, /aria-haspopup="menu"/)
		assert.match(a, /aria-expanded="false"/)
		assert.match(a, /aria-label="More ways to start (Claude Code|Codex)"/)
	}
	assert.match(start, /More agents…<\/button>/)
	assert.doesNotMatch(start, /Other…/)
	assert.match(html, /<div id="menu" class="menu" role="menu" hidden>/)
})

test('the menu opens with the keyboard, moves with the arrows, closes on Escape and gives focus back', () => {
	const { chev, menu, items, posted, focus } = boot()
	// Enter or Space on the chevron arrive as a click with no pointer: the menu opens and focus moves into it.
	chev.onclick({ detail: 0 })
	assert.equal(menu.hidden, false)
	assert.equal(chev.attrs['aria-expanded'], 'true')
	assert.match(menu.innerHTML, /data-how="worktree"[^>]*>In a worktree</)
	assert.match(menu.innerHTML, /role="menuitem"[^>]*>Resume a session…</)
	assert.equal(focus.on, items[0])
	menu.listeners.keydown({ key: 'ArrowDown', preventDefault() { } })
	assert.equal(focus.on, items[1])
	menu.listeners.keydown({ key: 'ArrowDown', preventDefault() { } })
	assert.equal(focus.on, items[0], 'wraps')
	menu.listeners.keydown({ key: 'ArrowUp', preventDefault() { } })
	assert.equal(focus.on, items[1])
	menu.listeners.keydown({ key: 'Escape', preventDefault() { } })
	assert.equal(menu.hidden, true)
	assert.equal(chev.attrs['aria-expanded'], 'false')
	assert.equal(focus.on, chev, 'focus returns to the chevron')
	// A mouse click opens it without stealing focus; an item sends the validated pair; ArrowDown on the chevron opens and enters it.
	chev.onclick({ detail: 1 })
	assert.equal(menu.hidden, false)
	assert.notEqual(focus.on, items[0])
	menu.listeners.click({ target: items[0] })
	assert.deepEqual(posted.at(-1), { type: 'start', cli: 'claude', how: 'worktree' })
	assert.equal(menu.hidden, true)
	chev.onkeydown({ key: 'ArrowDown', preventDefault() { } })
	assert.equal(focus.on, items[0])
})

// ---- the skeleton-first stage ----------------------------------------------------------------------------------------

test('the stage of skeleton first is a word on the agent\'s row, with a "skipped" badge when the developer skipped it', () => {
	const { send } = boot()
	const row = skeletonStage => agent({ skeletonAvailable: true, skeletonOn: true, skeletonStage })
	for (const [stage, word] of [['design', 'Design'], ['skeleton', 'Skeleton'], ['handover', 'Handover']]) {
		const out = send([row({ stage, skipped: false })])
		assert.match(out, new RegExp(`class="stage" title="[^"]+">Stage <b>${word}</b></span>`))
		assert.doesNotMatch(out, /skipped/)
	}
	const skipped = send([row({ stage: 'handover', skipped: true })])
	assert.match(skipped, /<b>Handover<\/b><span class="skipped">skipped<\/span>/)
	assert.match(skipped, /title="Handover: [^"]*You chose to go without the design/, 'the tooltip says what skipped means')
	assert.match(skipped, /data-act="sk"/, 'the toggle keeps working beside it')
	assert.doesNotMatch(send([row(undefined)]), /class="stage"/, 'flow-view missing: no indicator')
	assert.doesNotMatch(send([row({ stage: '<img>', skipped: false })]), /class="stage"/, 'a stage the page does not know is not drawn')
})

// ---- colours ---------------------------------------------------------------------------------------------------------

const lum = hex => {
	const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
/** WCAG 2.x contrast ratio of two #rrggbb colours. */
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const mix = (a, pct, b) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * pct + parseInt(b.slice(i, i + 2), 16) * (1 - pct)).toString(16).padStart(2, '0')).join('')

test('the status colours read on the light and the dark side bar and on the cards drawn over them', () => {
	assert.ok(ratio('#000000', '#ffffff') > 20 && ratio('#777777', '#777777') === 1, 'the helper computes the WCAG ratio')
	// The default Dark+ and Light+ side bars, with the card of each (the dock's own mix): the worst backgrounds a status colour sits on.
	const dark = ['#252526', mix('#252526', 0.7, '#2a2c36')]
	const light = ['#f3f3f3', '#ffffff', mix('#f3f3f3', 0.4, '#ffffff')]
	for (const [theme, bgs] of [['dark', dark], ['light', light]]) {
		const c = colors[theme]
		for (const name of ['working', 'blocked', 'done', 'idle', 'dangerText', 'custom']) {
			for (const bg of bgs) { assert.ok(ratio(c[name], bg) >= 4.5, `${theme} ${name} ${c[name]} on ${bg}: ${ratio(c[name], bg).toFixed(2)}`) }
		}
		// The marks of the two CLIs are icons (non-text): 3:1.
		for (const name of ['claude', 'codex']) {
			for (const bg of bgs) { assert.ok(ratio(c[name], bg) >= 3, `${theme} ${name} ${ratio(c[name], bg).toFixed(2)}`) }
		}
		assert.ok(ratio(c.on, c.working) >= 4.5, `${theme}: the text on a pressed Skeleton button`)
	}
	// The page takes the dark set by default and the light one under body.vscode-light; no status colour is a literal in a rule any more.
	const css = /<style>([\s\S]*?)<\/style>/.exec(html)[1]
	assert.match(css, /body\.vscode-light, body\.vscode-high-contrast-light \{[^}]*--blocked: #8a5300/)
	assert.doesNotMatch(css.replace(/--[a-z-]+: #[0-9a-f]{6}/gi, ''), /#(ff6b7d|ff8c99|0c0f1f)/i)
})
