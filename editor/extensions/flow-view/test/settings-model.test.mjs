// The settings page (src/settingsModel.ts, src/settingsPage.ts): which settings it lists, how each is drawn, and which values
// it accepts. Pure, so it is bundled with esbuild and run under plain Node, like legacy-settings.test.mjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { ROOT } from './helpers.mjs'

let model
let page
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-settings-'))
	for (const [name, mod] of [['model', 'settingsModel'], ['page', 'settingsPage']]) {
		const outfile = join(tmp, `${mod}.mjs`)
		await build({ entryPoints: [join(ROOT, 'src', `${mod}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
		const loaded = await import(pathToFileURL(outfile).href)
		name === 'model' ? model = loaded : page = loaded
	}
})
after(() => rmSync(tmp, { recursive: true, force: true }))

/** Every property the Insilode extensions contribute, as the page reads them at run time. */
function contributed() {
	const out = {}
	const extensions = join(ROOT, '..')
	for (const dir of readdirSync(extensions)) {
		const pkg = JSON.parse(readFileSync(join(extensions, dir, 'package.json'), 'utf8'))
		const conf = pkg.contributes?.configuration
		for (const section of Array.isArray(conf) ? conf : conf ? [conf] : []) {
			Object.assign(out, section.properties)
		}
	}
	return out
}

test('every setting an Insilode extension contributes has a place on the page', () => {
	const all = contributed()
	const specs = model.buildSpecs(all)
	const listed = new Set(specs.map(s => s.key))
	const missing = Object.entries(all).filter(([k, p]) => !p.deprecationMessage && !listed.has(k)).map(([k]) => k)
	assert.deepEqual(missing, [])
	// "more" is where an unplaced setting lands: a new setting needs an entry in META (and a title), not a silent fallback.
	assert.deepEqual(specs.filter(s => s.category === 'more').map(s => s.key), [], 'give these a category, group and title in settingsModel.ts META')
	// The deprecated spelling is not offered next to the one that replaced it.
	assert.ok(!listed.has('axle.skeletonFirst.enabled'))
	assert.ok(listed.has('flow.agents.installAgentExtensions'))
	for (const s of specs) {
		assert.ok(model.CATEGORIES.some(c => c.id === s.category), `${s.key}: unknown category ${s.category}`)
		assert.ok(s.description, `${s.key} has no description`)
	}
})

test('a setting that depends on another points at one that is listed', () => {
	const specs = model.buildSpecs(contributed())
	const keys = new Set(specs.map(s => s.key))
	for (const s of specs.filter(s => s.needs)) {
		assert.ok(keys.has(s.needs), `${s.key} needs ${s.needs}`)
	}
})

test('controls follow the schema', () => {
	const by = Object.fromEntries(model.buildSpecs(contributed()).map(s => [s.key, s]))
	assert.equal(by['flow.codeLens'].kind, 'switch')
	assert.equal(by['flow.agents.desktop.overlay.size'].kind, 'segments')
	assert.equal(by['flow.agents.desktop.overlay.position'].kind, 'select')
	assert.equal(by['flow.agents.askTarget'].kind, 'text')
	assert.deepEqual(by['flow.agents.askTarget'].examples.slice(0, 2), ['remember', 'ask'])
	assert.equal(by['flow.types.dtoSuffixes'].kind, 'list')
	assert.equal(by['flow.agents.pr.events'].kind, 'flags')
	assert.deepEqual(by['flow.agents.pr.events'].flags.map(f => f.key), ['checkFailed', 'changesRequested', 'conflict', 'comment', 'review'])
	assert.equal(by['flow.agents.custom'].kind, 'json')
	assert.equal(by['flow.types.maxNodes'].step, 1)
	assert.equal(by['flow.agents.desktop.overlay.opacity'].step, 0.05)
	// a deprecated switch inside an object is not offered
	assert.ok(!by['flow.agents.desktop.overlay.autoHide'].flags.some(f => /axle/i.test(f.key)))
})

test('values are checked against the schema', () => {
	const by = Object.fromEntries(model.buildSpecs(contributed()).map(s => [s.key, s]))
	const ok = (key, v, cur) => model.checkValue(by[key], v, cur).ok
	assert.ok(ok('flow.codeLens', false))
	assert.ok(!ok('flow.codeLens', 'no'))
	assert.ok(ok('flow.agents.desktop.overlay.size', 'large'))
	assert.ok(!ok('flow.agents.desktop.overlay.size', 'huge'))
	assert.ok(ok('flow.types.maxNodes', 200))
	assert.ok(!ok('flow.types.maxNodes', 5), 'below the minimum')
	assert.ok(!ok('flow.types.maxNodes', 120.5), 'not whole')
	assert.ok(!ok('flow.types.maxNodes', NaN))
	assert.ok(!ok('flow.types.maxNodes', '200'))
	assert.ok(ok('flow.agents.desktop.overlay.opacity', 0.55))
	assert.ok(ok('flow.agents.askTarget', 'custom:Gemini'))
	assert.ok(!ok('flow.agents.askTarget', 'rm -rf'), 'does not fit the pattern')
	assert.ok(!ok('flow.agents.askTarget', 5))
	assert.ok(ok('flow.types.dtoSuffixes', ['Dto', 'Dto', 'Vm']))
	assert.deepEqual(model.checkValue(by['flow.types.dtoSuffixes'], ['Dto', 'Dto'], []).value, ['Dto'])
	assert.ok(!ok('flow.types.dtoSuffixes', ['Dto', 3]))
	assert.ok(!ok('flow.types.dtoSuffixes', 'Dto'))
	assert.ok(!ok('flow.agents.custom', [{ name: 'x', command: 'calc' }]), 'agent commands run in a terminal: only settings.json writes them')
})

test('one switch of a flags setting keeps the others', () => {
	const spec = model.buildSpecs(contributed()).find(s => s.key === 'flow.agents.pr.events')
	const current = { checkFailed: true, changesRequested: true, conflict: true, comment: false, review: false }
	assert.deepEqual(model.checkValue(spec, { comment: true }, current).value, { ...current, comment: true })
	assert.ok(!model.checkValue(spec, { comment: 'yes' }, current).ok)
	assert.ok(!model.checkValue(spec, { somethingElse: true }, current).ok, 'a key the schema does not have')
	assert.ok(!model.checkValue(spec, [true], current).ok)
})

test('the editor settings have a place and a range', () => {
	const by = Object.fromEntries(model.buildSpecs({}).map(s => [s.key, s]))
	assert.equal(by['editor.fontSize'].kind, 'number')
	assert.equal(by['editor.wordWrap'].kind, 'select')
	assert.ok(by['editor.fontSize'].editor)
	assert.ok(!model.checkValue(by['editor.fontSize'], 400, 14).ok)
	for (const key of Object.keys(model.EDITOR_SETTINGS)) {
		assert.equal(by[key].category, 'editor', key)
	}
})

test('the page sets a Content-Security-Policy with a nonce and its script parses', () => {
	const html = page.settingsHtml('abc123')
	assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-abc123';">/)
	const script = /<script nonce="abc123">([\s\S]*)<\/script>/.exec(html)?.[1]
	assert.ok(script)
	assert.doesNotThrow(() => new Script(script))
	// Regexes inside the page's template literal keep their backslashes (a lone \w there would become a plain w).
	assert.ok(script.includes(String.raw`#[\w.]+#`) && script.includes(String.raw`.replace(/^#([\w.]+)#$/`))
	// Settings text goes in with textContent, never as markup.
	assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(script))
	// Nothing in the page names a command: it asks for a place or a setting by key.
	assert.ok(!/executeCommand|command:/.test(script))
})
