// Home's Agents row (src/home.ts): drawn only when flow-agent says an agent waits, from data that is shaped and escaped first,
// and a chip can only ask to reveal an agent the host sent. Bundled with esbuild, `vscode` stubbed (see bundle.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { cleanup, load } from './bundle.mjs'

let home
before(async () => {
	home = await load('src/home.ts')
})
after(() => cleanup())

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
		Date, Math, Number, String, Set, Array,
	})
	onMessage({ data })
	return elements
}

const base = { type: 'data', repo: 'app', hour: 10, files: [], flows: [], endpoints: [], total: 0 }

test('the Agents row is absent with no agents and present with two, with a way to the Agents page', () => {
	for (const none of [undefined, [], null]) {
		assert.equal(renderHome({ ...base, agents: none }).get('agents').innerHTML, '', 'no row, no height')
	}
	const html = renderHome({ ...base, agents: [{ id: 'a1', name: 'Fix login', kind: 'approval' }, { id: 'a2', name: 'Refactor', kind: 'error' }] }).get('agents').innerHTML
	assert.match(html, /<span class="lbl">Agents<\/span>/)
	assert.match(html, /data-agent="a1"[^>]*><i><\/i><span class="an">Fix login<\/span><span class="ak">· needs you</)
	assert.match(html, /data-agent="a2"[^>]*><i><\/i><span class="an">Refactor<\/span><span class="ak">· error</)
	assert.match(html, /data-run="flow\.agents\.openPage"[^>]*>Open Agents</)
	assert.doesNotMatch(html, /more</)
})

test('the Agents row escapes names and ids, cuts long names and says how many more wait', () => {
	const agents = [{ id: '"><img src=x>', name: '<img src=x onerror=1>', kind: 'question' }, { id: 'b', name: 'x'.repeat(100), kind: 'question' }]
	const html = renderHome({ ...base, agents, agentsMore: 3 }).get('agents').innerHTML
	assert.doesNotMatch(html, /<img/)
	assert.ok(!html.includes('x'.repeat(41)), 'a long name is cut')
	assert.match(html, /\+3 more</)
	const six = Array.from({ length: 6 }, (_, i) => ({ id: 'i' + i, name: 'n' + i, kind: 'approval' }))
	assert.equal(renderHome({ ...base, agents: six }).get('agents').innerHTML.split('data-agent=').length - 1, 4, 'the page shows at most four')
})

test("flow-agent's answer is shaped before the page sees it: known kinds, short plain names, at most four", () => {
	const shaped = home.shapeAgents([
		{ id: 'a', name: '  Fix\n\tlogin  ', cli: 'claude', kind: 'approval' },
		{ id: 'b', name: 'y'.repeat(90), kind: 'error' },
		{ id: 'c', name: 'no kind' }, { id: 7, name: 'bad id', kind: 'error' }, { name: 'no id', kind: 'error' }, null, 'x',
		{ id: 'd', name: 5, kind: 'question' }, { id: 'e', name: 'e', kind: 'question' }, { id: 'f', name: 'f', kind: 'question' }, { id: 'g', name: 'g', kind: 'question' },
	])
	assert.deepEqual(shaped.list.map(a => a.id), ['a', 'b', 'd', 'e'])
	assert.equal(shaped.list[0].name, 'Fix login')
	assert.equal(shaped.list[1].name.length, 40)
	assert.equal(shaped.list[2].name, 'Agent')
	assert.equal(shaped.more, 2)
	for (const bad of [undefined, null, {}, 'a', 3]) {
		assert.deepEqual(home.shapeAgents(bad), { list: [], more: 0 })
	}
})

test('a reveal message is refused for an agent the host did not send, and flow.agents.openPage is on the allowlist', () => {
	const offered = new Set(['a1', 'a2'])
	assert.equal(home.canRevealAgent(offered, 'a1'), true)
	for (const bad of ['a3', '', undefined, 1, ['a1'], { id: 'a1' }, '__proto__']) {
		assert.equal(home.canRevealAgent(offered, bad), false, String(bad))
	}
	assert.equal(home.isHomeCommand('flow.agents.openPage'), true)
	assert.equal(home.isHomeCommand('flow.agents.reveal'), false, 'reveal goes by its own checked message, not as a command from the page')
})
