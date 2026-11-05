// Skeleton first in the dock: one Skeleton button per agent (pressed or not, its explanation in the tooltip) and nothing else on the
// row; the page asks only for that agent's on or off. The reminders the hooks hand Claude stay short and name the tool.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let k
let d
let page
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-skeleton-'))
	const mods = {}
	for (const name of ['skeleton', 'dockMessage', 'dockPage']) {
		const outfile = join(tmp, `${name}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		mods[name] = await import(pathToFileURL(outfile).href)
	}
	k = mods.skeleton
	d = mods.dockMessage
	page = mods.dockPage.dockHtml()
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('the page asks for one agent\'s Skeleton on or off, and nothing else', () => {
	assert.deepEqual(d.dockAction({ type: 'sk', id: 'a1', on: true }), { type: 'sk', id: 'a1', on: true })
	assert.deepEqual(d.dockAction({ type: 'sk', id: 'a1', on: false, extra: 1 }), { type: 'sk', id: 'a1', on: false })
	assert.equal(d.dockAction({ type: 'sk', id: 'a1', on: 'yes' }), undefined)
	assert.equal(d.dockAction({ type: 'sk', on: true }), undefined)
	assert.equal(d.dockAction({ type: 'sk', id: 'a1', action: 'handover' }), undefined, 'no stage buttons: the stages are talked through with the agent')
	assert.equal(d.dockAction({ type: 'skw', id: 'a1', warning: 1, action: 'revert' }), undefined, 'no warning buttons on the row')
	assert.equal(d.dockAction({ type: 'skeletonFirst', on: true }), undefined, 'no window-wide switch')
})

test('the row shows only the Skeleton button: pressed or not, explained in its tooltip, keyboard reachable', () => {
	const script = /<script>([\s\S]*)<\/script>/.exec(page)[1]
	const list = { innerHTML: '', querySelectorAll: () => [], addEventListener() { } }
	const document = { getElementById: () => list, querySelectorAll: () => [], addEventListener() { } }
	let onMessage
	const window = { addEventListener: (_type, f) => { onMessage = f } }
	vm.runInNewContext(script, { window, document, acquireVsCodeApi: () => ({ postMessage() { } }), setInterval() { }, Math, Object, isFinite, Date, String, Number, Map })
	const row = { id: 'a1', cli: 'claude', name: 'Claude', state: 'done', since: Date.now(), todos: [], unread: false, done: 0, skeletonAvailable: true }
	onMessage({ data: { type: 'data', list: [{ ...row, skeletonOn: false }, { ...row, id: 'c', cli: 'custom', skeletonAvailable: false }], now: Date.now(), avatar: 'pixel' } })
	assert.match(list.innerHTML, /<button type="button" class="act" aria-pressed="false" data-act="sk" data-on="on" data-tip="Skeleton first for this agent.[^"]*Off: click to turn it on." aria-description="[^"]*">Skeleton<\/button>/)
	assert.equal(list.innerHTML.match(/data-act="sk"/g).length, 1, 'a custom agent has no button')
	onMessage({ data: { type: 'data', list: [{ ...row, skeletonOn: true }], now: Date.now(), avatar: 'pixel' } })
	assert.match(list.innerHTML, /aria-pressed="true" data-act="sk" data-on="off"[^>]*On: click to turn it off.[^>]*>Skeleton<\/button>/)
	assert.equal(/Write the skeleton|Hand over|Just do it|Plan vs code|data-skw/.test(list.innerHTML), false, 'nothing else on the row')
	// A real button: Enter and Space press it with no key handler of the page's own (it was a span inside the row's button before).
	assert.doesNotMatch(list.innerHTML, /role="button"/)
})

test('the reminders stay short, name the tool, and say how chat replies map to steps', () => {
	assert.ok(k.SKELETON_PROMPT_GATE.length < 400)
	assert.match(k.SKELETON_PROMPT_GATE, /check_skeleton/)
	assert.match(k.SKELETON_PROMPT_GATE, /"hand over", "just do it" or "done"/)
	assert.match(k.SKELETON_GATE, /Before you create or edit any file/)
	for (const t of Object.values(k.HOOK_CONTEXT)) {
		assert.equal(/[\r\n]/.test(t), false)
	}
})
