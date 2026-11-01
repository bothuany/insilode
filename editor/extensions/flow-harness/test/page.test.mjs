// The shell of the harness's webview pages (src/page.ts): keyboard reach, a status a screen reader hears, and colours that read on a
// light theme as well as a dark one. xray.ts and mcpManager.ts build their markup from strings, so they are read as source.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let p
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-page-'))
	const outfile = join(tmp, 'page.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'page.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	p = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const src = file => readFileSync(join(ROOT, 'src', file), 'utf8')
const PAGES = ['page.ts', 'xray.ts', 'mcpManager.ts']

test('no page of this part draws a link that is really a click handler', () => {
	for (const file of PAGES) {
		const text = src(file)
		assert.doesNotMatch(text, /<a\b[^>]*\bonclick/i, `${file}: <a onclick>`)
		assert.doesNotMatch(text, /el\('a',\s*\{[^}]*onclick/, `${file}: el('a', { onclick })`)
		assert.doesNotMatch(text, /el\('span',\s*\{[^}]*onclick/, `${file}: a span with a click handler`)
		assert.doesNotMatch(text, /role=["']button["']/, `${file}: a role=button stand-in`)
	}
	const html = p.page('T', '<button id="b" class="link">x</button>', '')
	assert.doesNotMatch(html, /<a\b[^>]*onclick/i)
})

test('the page shell has the link-style button, the focus ring and a polite status region', () => {
	const html = p.page('Title', '<p>body</p>', 'announce("x");')
	assert.match(html, /button\.link \{/)
	assert.match(html, /button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible \{ outline: 1px solid var\(--vscode-focusBorder/)
	assert.match(html, /\.sr-only \{ position: absolute; width: 1px; height: 1px;/)
	assert.match(html, /<div id="announce" class="sr-only" role="status" aria-live="polite"><\/div>/)
	assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-/)
	// announce() writes into that region and survives a page without one.
	const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)[1]
	const region = { textContent: 'old' }
	const timers = []
	const ctx = { acquireVsCodeApi: () => ({ postMessage() { } }), document: { getElementById: id => id === 'announce' ? region : null, createElement() { } }, setTimeout: f => timers.push(f), Node: class { }, Object, String, Math }
	vm.runInNewContext(script.replace('announce("x");', ''), ctx)
	vm.runInNewContext('announce("Saved")', ctx)
	assert.equal(region.textContent, '', 'cleared first, so the same text is heard again')
	timers.forEach(f => f())
	assert.equal(region.textContent, 'Saved')
	assert.doesNotThrow(() => vm.runInNewContext('announce("x")', { ...ctx, document: { getElementById: () => null } }))
})

test('the X-ray and the MCP page say their results to a screen reader and name each button for what it acts on', () => {
	const x = src('xray.ts')
	assert.match(x, /announce\('Refreshing\.'\)/)
	assert.match(x, /announce\('Context X-ray of '/)
	assert.match(x, /'aria-label': label\.replace/, 'the waste buttons say what they act on')
	assert.match(x, /id="bar" aria-hidden="true"/, 'the bar repeats the table below it')
	const m = src('mcpManager.ts')
	assert.match(m, /announce\(s\.name \+ ': '/, 'a finished check is announced')
	for (const act of ['check', 'edit', 'toggle', 'remove', 'open']) {
		assert.match(m, new RegExp(`'data-k': s\\.id \\+ ':${act}', 'aria-label': `), `${act} names the server`)
	}
	assert.match(m, /again\.focus\(\)/, 'focus returns to the button that was pressed after the rows are drawn again')
})

// ---- colours ---------------------------------------------------------------------------------------------------------

const lum = hex => {
	const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
/** WCAG 2.x contrast ratio of two #rrggbb colours. */
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05) }
const mix = (a, pct, b) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * pct + parseInt(b.slice(i, i + 2), 16) * (1 - pct)).toString(16).padStart(2, '0')).join('')

test('the helper is the WCAG ratio', () => {
	assert.equal(ratio('#000000', '#ffffff').toFixed(2), '21.00')
	assert.equal(ratio('#767676', '#ffffff').toFixed(2), '4.54')
	assert.equal(ratio('#ffb454', '#ffffff') < 2, true, 'the old amber is unreadable on white')
})

test('the status colours read on a light page and its card (4.5:1 for text) and on a dark one', () => {
	const lightBg = ['#ffffff', '#f3f3f3', mix('#ffffff', 0.95, '#000000')]
	const darkBg = ['#1e1e1e', '#181818', mix('#1e1e1e', 0.85, '#2a2c36')]
	for (const name of ['allow', 'ask', 'deny', 'accent']) {
		for (const bg of lightBg) { assert.ok(ratio(p.STATUS_COLORS.light[name], bg) >= 4.5, `light ${name} ${p.STATUS_COLORS.light[name]} on ${bg}: ${ratio(p.STATUS_COLORS.light[name], bg).toFixed(2)}`) }
		for (const bg of darkBg) { assert.ok(ratio(p.STATUS_COLORS.dark[name], bg) >= 4.5, `dark ${name} on ${bg}: ${ratio(p.STATUS_COLORS.dark[name], bg).toFixed(2)}`) }
	}
	const html = p.page('T', '', '')
	assert.match(html, /--allow: var\(--vscode-testing-iconPassed, #5fe0a1\)/)
	assert.match(html, /--ask: var\(--vscode-editorWarning-foreground, #ffb454\)/)
	assert.match(html, /--deny: var\(--vscode-errorForeground, #ff6b7d\)/)
	assert.match(html, /--accent: var\(--vscode-textLink-foreground, #6f86ff\)/)
	assert.match(html, /body\.vscode-light, body\.vscode-high-contrast-light \{ --allow: #146c3a; --ask: #8a5300; --deny: #b3261e; --accent: #0b5cad;/)
})

test('the X-ray segments are 3:1 against the page in both sets, and the page picks the set from the theme class', () => {
	assert.equal(p.SEGMENT_COLORS.dark.length, 8)
	assert.equal(p.SEGMENT_COLORS.light.length, 8)
	for (const c of p.SEGMENT_COLORS.light) { assert.ok(ratio(c, '#ffffff') >= 3, `light ${c}: ${ratio(c, '#ffffff').toFixed(2)}`) }
	for (const c of p.SEGMENT_COLORS.dark) { assert.ok(ratio(c, '#1e1e1e') >= 3, `dark ${c}: ${ratio(c, '#1e1e1e').toFixed(2)}`) }
	assert.equal(new Set(p.SEGMENT_COLORS.light).size, 8, 'distinct colours')
	const x = src('xray.ts')
	assert.match(x, /JSON\.stringify\(SEGMENT_COLORS\)\}\[document\.body\.classList\.contains\('vscode-light'\)/)
	assert.doesNotMatch(x, /const COLORS = \['#/, 'no hard-coded dark list any more')
})
