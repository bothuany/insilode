// Home's first run (src/home.ts) and the sample tour (src/sampleTour.ts): the pure helpers the page is built from (the agent
// sentence, when the strip shows, the indexing state, the churn cache that refuses a failure, the gaps), the page itself and
// the tour's steps. Bundled with esbuild and run under plain Node, with `vscode` stubbed (see bundle.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import vm from 'node:vm'
import { cleanup, load } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let home, tour, wait
before(async () => {
	[home, tour, wait] = await Promise.all(['src/home.ts', 'src/sampleTour.ts', 'src/tour/wait.ts'].map(load))
})
after(() => cleanup())

// ---- the agent sentence ----------------------------------------------------------------------------------

test('the setting flow.agents.askTarget becomes a sentence', () => {
	assert.equal(home.askTargetSentence('claude'), 'Prompts go to Claude Code')
	assert.equal(home.askTargetSentence('codex'), 'Prompts go to Codex')
	assert.equal(home.askTargetSentence('chat'), 'Prompts go to the chat panel')
	assert.equal(home.askTargetSentence('clipboard'), 'Prompts are copied to the clipboard')
	assert.equal(home.askTargetSentence('ask'), 'You pick the agent each time')
	assert.match(home.askTargetSentence('remember'), /first prompt.*remembers/)
	assert.equal(home.askTargetSentence('custom:Gemini'), 'Prompts go to Gemini')
})

test('a missing or odd setting (flow-agent is not installed) says "not available", never throws', () => {
	for (const bad of [undefined, null, '', 7, {}, 'custom:', 'custom:   ', 'something-else']) {
		assert.match(home.askTargetSentence(bad), /not available/, String(bad))
	}
	assert.ok(home.askTargetSentence('custom:' + 'x'.repeat(500)).length < 80, 'a long name is cut')
})

// ---- the strip -------------------------------------------------------------------------------------------

test('the first-run strip shows until it is hidden or a flow has been opened', () => {
	assert.equal(home.stripVisible({ hidden: false, openedFlow: false }), true)
	assert.equal(home.stripVisible({ hidden: true, openedFlow: false }), false)
	assert.equal(home.stripVisible({ hidden: false, openedFlow: true }), false)
	assert.equal(home.stripVisible({ hidden: true, openedFlow: true }), false)
})

// ---- the indexing state ----------------------------------------------------------------------------------

test('indexing, empty and ready are told apart', () => {
	const folder = { hasFolder: true }
	assert.deepEqual(home.indexView({ ...folder, ready: false, progress: { done: 1200, total: 34000 } }, 0), { state: 'indexing', text: 'Indexing… 1,200 of 34,000 files' })
	assert.deepEqual(home.indexView({ ...folder, ready: false }, 0), { state: 'indexing', text: 'Indexing…' })
	assert.deepEqual(home.indexView({ ...folder, ready: false, progress: { done: 0, total: 0 } }, 3), { state: 'indexing', text: 'Indexing…' }, 'cached endpoints do not end the first pass')
	assert.deepEqual(home.indexView({ ...folder, ready: true }, 0), { state: 'empty', text: 'No endpoints found' })
	assert.deepEqual(home.indexView({ ...folder, ready: true }, 4), { state: 'ready', text: '' })
	assert.equal(home.indexView({ hasFolder: false, ready: false }, 0).state, 'none')
})

test('an odd progress number does not reach the text', () => {
	assert.equal(home.indexView({ hasFolder: true, ready: false, progress: { done: NaN, total: 10 } }, 0).text, 'Indexing… 0 of 10 files')
})

// ---- git's churn -----------------------------------------------------------------------------------------

test('the churn cache keeps an answer but never a failure, and tries again next time', async () => {
	let calls = 0
	let answer = undefined
	const cache = new home.ChurnCache(async () => { calls++; return answer })
	assert.equal(cache.failed('/w'), false, 'nothing has been tried')
	assert.equal(await cache.get('/w'), undefined)
	assert.equal(cache.failed('/w'), true)
	assert.equal(cache.peek('/w'), undefined, 'a failure is not kept')
	assert.equal(await cache.get('/w'), undefined)
	assert.equal(calls, 2, 'asked again on the next show')
	answer = new Map([['a', 2]])
	assert.equal((await cache.get('/w')).get('a'), 2)
	assert.equal(cache.failed('/w'), false)
	assert.equal(await cache.get('/w'), answer)
	assert.equal(calls, 3, 'a good answer is kept for the window')
})

test('an empty churn (a repository where nothing changed) is an answer, not a failure', async () => {
	const cache = new home.ChurnCache(async () => new Map())
	assert.equal((await cache.get('/w')).size, 0)
	assert.equal(cache.failed('/w'), false)
	assert.ok(cache.peek('/w'))
})

test('a throwing load is a failure, and two callers share one git call', async () => {
	const boom = new home.ChurnCache(async () => { throw new Error('spawn git ENOENT') })
	assert.equal(await boom.get('/w'), undefined)
	assert.equal(boom.failed('/w'), true)
	let calls = 0
	const slow = new home.ChurnCache(async () => { calls++; await new Promise(r => setTimeout(r, 10)); return new Map([['a', 1]]) })
	const [a, b] = await Promise.all([slow.get('/w'), slow.get('/w')])
	assert.equal(a, b)
	assert.equal(calls, 1)
})

test('gitChurnResult is undefined outside a repository, which gitChurn still reads as empty', async () => {
	const { mkdtempSync, rmSync } = await import('node:fs')
	const { tmpdir } = await import('node:os')
	const dir = mkdtempSync(join(tmpdir(), 'insilode-home-norepo-'))
	try {
		assert.equal(await home.gitChurnResult(dir), undefined)
		assert.equal((await home.gitChurn(dir)).size, 0)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

// ---- gaps and the health label ---------------------------------------------------------------------------

test('gaps are kept as short plain text, a few of them', () => {
	const gaps = home.shapeGaps([
		{ label: 'Hooks', message: 'No hooks yet.\n\nAdd one   to block risky commands.' },
		{ label: '', message: 'no label' }, null, 5, { label: 7 },
		{ label: 'Skills', message: 'x'.repeat(500) },
		...Array.from({ length: 10 }, (_, i) => ({ label: `Gap ${i}`, message: '' })),
	])
	assert.equal(gaps.length, 5)
	assert.deepEqual(gaps[0], { label: 'Hooks', message: 'No hooks yet. Add one to block risky commands.' })
	assert.equal(gaps[1].message.length, 200)
	assert.deepEqual(home.shapeGaps('nope'), [])
	assert.deepEqual(home.shapeGaps(undefined), [])
})

test('the health label counts the gaps', () => {
	assert.equal(home.healthLabel(72, 3), 'Harness health 72 / 100 · 3 gaps')
	assert.equal(home.healthLabel(72, 1), 'Harness health 72 / 100 · 1 gap')
	assert.equal(home.healthLabel(100, 0), 'Harness health 100 / 100')
	assert.equal(home.healthLabel('x', 0), 'Harness health 0 / 100')
})

// ---- the commands the page may run -----------------------------------------------------------------------

test('Home runs only its own shortcuts, and every one is a command an extension contributes', () => {
	const extensions = resolve(ROOT, '..')
	const contributed = new Set()
	for (const dir of readdirSync(extensions)) {
		try {
			for (const c of JSON.parse(readFileSync(join(extensions, dir, 'package.json'), 'utf8')).contributes?.commands ?? []) {
				contributed.add(c.command)
			}
		} catch {
			// not an extension
		}
	}
	for (const id of ['flow.tour.playSample', 'flow.importFromVSCode', 'flow.board.show', 'flow.board.fromCode']) {
		assert.equal(home.isHomeCommand(id), true, id)
	}
	for (const id of home.HOME_COMMANDS) {
		if (!id.startsWith('workbench.')) {
			assert.ok(contributed.has(id), `${id} is not contributed by any extension`)
		}
	}
	for (const bad of ['workbench.action.terminal.new', 'flow.agents.remove', '', undefined, 3, ['flow.home']]) {
		assert.equal(home.isHomeCommand(bad), false, String(bad))
	}
})

// ---- the page --------------------------------------------------------------------------------------------

function renderHome(data) {
	const html = home.homeHtml('TESTNONCE')
	const script = html.match(/<script nonce="TESTNONCE">([\s\S]*?)<\/script>/)[1]
	const elements = new Map()
	const el = () => ({ innerHTML: '', textContent: '', value: '', disabled: false, style: {}, dataset: {}, addEventListener() { }, setAttribute() { }, focus() { } })
	let onMessage
	vm.runInNewContext(script, {
		acquireVsCodeApi: () => ({ postMessage() { } }),
		navigator: { platform: 'Win32' },
		document: { getElementById: id => elements.get(id) ?? elements.set(id, el()).get(id), querySelectorAll: () => [] },
		window: { addEventListener: (type, fn) => { if (type === 'message') onMessage = fn } },
		Date, Math, Number, String, Set,
	})
	onMessage({ data })
	return elements
}

const base = { type: 'data', repo: 'app', hour: 10, files: [], flows: [], endpoints: [], total: 0 }

test('the strip says what Insilode is, where prompts go, and offers the tour', () => {
	const strip = renderHome({ ...base, strip: true, agent: 'Prompts go to Claude Code' }).get('strip').innerHTML
	assert.match(strip, /draws your code&#39;s call flow on a canvas and lets an agent point at it/)
	assert.match(strip, /Prompts go to Claude Code/)
	assert.match(strip, /data-run="flow\.tour\.playSample"[^>]*>Take the tour</)
	assert.match(strip, /data-run="flow\.agents\.chooseAskTarget"[^>]*>Change</)
	assert.match(strip, /data-hide="1"[^>]*>Hide</)
	assert.equal(renderHome({ ...base, strip: false, agent: 'x' }).get('strip').innerHTML, '', 'a hidden strip is not drawn')
	assert.equal(renderHome(base).get('strip').innerHTML, '', 'no word from the host, no strip')
})

test('the strip escapes the agent sentence', () => {
	const strip = renderHome({ ...base, strip: true, agent: '<img src=x onerror=alert(1)>' }).get('strip').innerHTML
	assert.doesNotMatch(strip, /<img/)
})

test('the page has rows for Import and Boards, each with a description', () => {
	const html = home.homeHtml('N')
	assert.match(html, /data-run="flow\.importFromVSCode"/)
	assert.match(html, /data-run="flow\.board\.show"/)
	assert.match(html, /data-run="flow\.board\.fromCode"/)
	assert.match(html, /<b>Import from VS Code<\/b><span>[^<]+<\/span>/)
	assert.match(html, /<b>Boards<\/b><span>[^<]+<\/span>/)
})

test('indexing is said in the header, and an empty list says why it is empty', () => {
	const indexing = renderHome({ ...base, index: { state: 'indexing', text: 'Indexing… 12 of 340 files' } })
	assert.equal(indexing.get('idx').textContent, 'Indexing… 12 of 340 files')
	assert.match(indexing.get('flows').innerHTML, /Indexing… 12 of 340 files/)
	assert.doesNotMatch(indexing.get('flows').innerHTML, /No endpoints found/)
	const empty = renderHome({ ...base, index: { state: 'empty', text: 'No endpoints found' } })
	assert.equal(empty.get('idx').textContent, '')
	assert.match(empty.get('flows').innerHTML, /No endpoints found\. Open a source file/)
	assert.match(renderHome({ ...base, index: { state: 'none', text: 'Open a folder to index its code.' } }).get('flows').innerHTML, /Open a folder to index/)
})

test('"churn unavailable" shows only when the last attempt failed', () => {
	const eps = [{ id: 'a', source: 'poly', label: 'A.b', http: 'GET', route: '/a', detail: 'd' }]
	const page = churn => renderHome({ ...base, endpoints: eps, total: 1, churn }).get('flows').innerHTML
	assert.match(page('unavailable'), /churn unavailable/)
	assert.doesNotMatch(page('pending'), /churn unavailable/)
	assert.doesNotMatch(page('ok'), /churn unavailable/)
	assert.doesNotMatch(page(undefined), /churn unavailable/)
})

test('the harness block is labelled and lists its gaps inline', () => {
	const health = {
		score: 72, label: 'Harness health 72 / 100 · 2 gaps', counts: { error: 0, warning: 1 }, startupTokens: 3000,
		totals: { instructions: 1, skills: 0, hooks: 0, mcp: 0 }, issues: [],
		gaps: [{ label: 'Hooks', message: 'No hooks yet.' }, { label: '<b>x</b>', message: '<i>y</i>' }],
	}
	const html = renderHome({ ...base, health, healthState: 'ok' }).get('health').innerHTML
	assert.match(html, /Harness health 72 \/ 100 · 2 gaps/)
	assert.match(html, /<li><b>Hooks<\/b> No hooks yet\.<\/li>/)
	assert.doesNotMatch(html, /<i>y/)
	assert.doesNotMatch(html, /title="/, 'the messages are in the page, not only in a tooltip')
})

test('without a health answer the page says why', () => {
	assert.match(renderHome({ ...base, healthState: 'pending' }).get('health').innerHTML, /Checking the harness/)
	assert.match(renderHome({ ...base, healthState: 'unavailable' }).get('health').innerHTML, /not available/)
	assert.match(renderHome({ ...base, healthState: 'nofolder' }).get('health').innerHTML, /Open a folder/)
})

test('the page takes its colours from the theme', () => {
	const html = home.homeHtml('N')
	// A hex colour is only a fallback inside var(--vscode-...): nothing is painted a fixed colour.
	const bare = html.replace(/var\(--vscode-[\w-]+,\s*#[0-9a-fA-F]{3,8}\)/g, '')
	assert.doesNotMatch(bare, /#[0-9a-fA-F]{6}\b/)
	assert.doesNotMatch(bare, /fill="#/)
})

// ---- the sample tour -------------------------------------------------------------------------------------

test('the sample tour has an intro, an outro and short, valid steps', () => {
	const t = tour.buildSampleTour('win32')
	assert.equal(t.source, 'agent')
	assert.equal(t.start, 0)
	assert.ok(t.id && t.title && t.origin)
	assert.ok(t.steps.length >= 4 && t.steps.length <= 8, `${t.steps.length} steps`)
	assert.deepEqual(t.steps.map(s => s.title), ['Welcome to Insilode', 'Home', 'Flow at Cursor', 'Boards', 'You are set'])
	for (const s of t.steps) {
		assert.ok(s.title.length > 0 && s.title.length <= 80, s.title)
		assert.ok(s.caption.length > 0 && s.caption.length <= 600, `${s.title}: ${s.caption.length}`)
		assert.equal(s.state, 'ok')
	}
	assert.equal(t.steps[0].at, undefined, 'an intro points at no code')
	assert.equal(t.steps.at(-1).at, undefined, 'an outro points at no code')
	assert.equal(t.steps[0].wait, undefined)
	assert.equal(t.steps.at(-1).wait, undefined)
})

test('every command wait of the sample tour is on the allowlist and passes the wait parser', () => {
	const t = tour.buildSampleTour('linux')
	const commands = t.steps.filter(s => s.wait?.kind === 'command')
	assert.ok(commands.length >= 1)
	for (const [i, s] of t.steps.entries()) {
		if (!s.wait) {
			continue
		}
		if (s.wait.kind === 'command') {
			assert.ok(wait.WAIT_COMMANDS.includes(s.wait.command), `${s.wait.command} is not in WAIT_COMMANDS`)
		}
		const { wait: parsed, note } = wait.parseWait(s.wait, { where: `steps[${i}]`, strict: true })
		assert.equal(note, undefined)
		assert.deepEqual(parsed, s.wait)
	}
	assert.ok(t.steps.some(s => s.wait?.kind === 'command' && s.wait.command === 'flow.home'), 'the Home step opens Home')
})

test('the Flow at Cursor step names the shortcut of the platform', () => {
	assert.match(tour.buildSampleTour('win32').steps[2].caption, /Ctrl\+Alt\+F/)
	assert.match(tour.buildSampleTour('darwin').steps[2].caption, /⌥⌘F/)
})

test('each tour gets its own id', () => {
	assert.notEqual(tour.buildSampleTour().id, tour.buildSampleTour().id)
})
