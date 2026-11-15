// The settings page shows one sentence of each description first (src/settingsPage.ts): where it is cut, that a code span or
// a link is never split, and that a search still reads the hidden part. The page's helpers are taken out of its script.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let model, page
before(async () => {
	[model, page] = await Promise.all(['src/settingsModel.ts', 'src/settingsPage.ts'].map(load))
})
after(() => cleanup())

const pageScript = () => /<script nonce="n">([\s\S]*)<\/script>/.exec(page.settingsHtml('n'))[1]

/** The helpers that touch no DOM (paintDesc, which does, is not taken). */
function descHelpers() {
	const script = pageScript()
	const code = [/const MD = .*;\n/, /function firstSentence[\s\S]*?\n}\n/, /function tailMatch[\s\S]*?\n}\n/].map(re => re.exec(script)[0]).join('\n')
	return new Function(`${code}\nreturn { firstSentence, tailMatch }`)()
}

function contributed() {
	const out = {}
	const extensions = join(ROOT, '..')
	for (const dir of readdirSync(extensions)) {
		const conf = JSON.parse(readFileSync(join(extensions, dir, 'package.json'), 'utf8')).contributes?.configuration
		for (const section of Array.isArray(conf) ? conf : conf ? [conf] : []) {
			Object.assign(out, section.properties)
		}
	}
	return out
}

test('a multi-sentence description is cut after its first sentence and gets a "more" button; one sentence gets none', () => {
	const { firstSentence } = descHelpers()
	const text = 'Show a badge on the dock icon. It counts the agents that wait for you, and goes away when none does.'
	assert.equal(text.slice(0, firstSentence(text)), 'Show a badge on the dock icon.')
	assert.equal(firstSentence('One sentence only.'), 0)
	assert.equal(firstSentence('No full stop at all'), 0)
	assert.equal(firstSentence('A trailing space is not more. '), 0)
	assert.equal(firstSentence('Use e.g. a path, i.e. an absolute one. Then restart.'), 'Use e.g. a path, i.e. an absolute one.'.length)
	const script = pageScript()
	assert.match(script, /el\('button', 'more'\)/)
	assert.match(script, /more\.type = 'button'/)
	assert.match(script, /setAttribute\('aria-expanded'/)
	assert.match(script, /'less' : 'more'/)
})

test('the first sentence is never cut inside a code span, a bold span, a link or a #setting# reference', () => {
	const { firstSentence } = descHelpers()
	const cases = [
		['Run `npm run build. now` first. Then more.', 'Run `npm run build. now` first.'],
		['Set **not. really** to go on. Later.', 'Set **not. really** to go on.'],
		['See [the docs. really](https://x.y/z). Then more.', 'See [the docs. really](https://x.y/z).'],
		['Needs #flow.agents.enabled# on. Then more.', 'Needs #flow.agents.enabled# on.'],
		['Use `files.exclude`. It is a map.', 'Use `files.exclude`.'],
	]
	for (const [text, head] of cases) {
		assert.equal(text.slice(0, firstSentence(text)), head)
	}
	// Over every real description: the cut leaves an even number of backticks and bold marks before it.
	for (const s of model.buildSpecs(contributed())) {
		const cut = firstSentence(s.description)
		const head = s.description.slice(0, cut || undefined)
		assert.equal((head.match(/`/g) || []).length % 2, 0, s.key)
		assert.equal((head.match(/\*\*/g) || []).length % 2, 0, s.key)
	}
})

test('a search word only in the hidden part opens the description, and the full text is searchable', () => {
	const { firstSentence, tailMatch } = descHelpers()
	const description = 'Show a badge on the dock icon. It counts the agents that wait, by their worktree.'
	const s = { title: 'Dock badge', key: 'flow.agents.badge', description }
	const r = { s, cut: firstSentence(description), text: (s.title + ' ' + s.description + ' ' + s.key).toLowerCase() }
	assert.ok(r.cut > 0)
	assert.ok(r.text.includes('worktree'), 'the row is found by the hidden part: its search text is the whole description')
	assert.equal(tailMatch(['worktree'], r), true)
	assert.equal(tailMatch(['badge'], r), false, 'a word that is already visible does not open it')
	assert.equal(tailMatch(['dock', 'wait'], r), true)
	assert.equal(tailMatch([], r), false)
	assert.match(pageScript(), /text: \(s\.title \+ ' ' \+ s\.description \+ ' ' \+ s\.key \+ ' ' \+ s\.group\)\.toLowerCase\(\)/)
})
