// The canvas colours that are text or a badge read on a light theme as well as a dark one: 4.5:1 for text, 3:1 for a mark that is only
// drawn (WCAG 2.x). The card and edge accents are in src/layout.ts (KIND_PALETTE), the harness canvas's in src/harness/harness.css.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
let tmp
let layout
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ui-colors-'))
  const out = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    build: { ssr: join(root, 'src/layout.ts'), write: false, minify: false, rollupOptions: { output: { format: 'esm' } } },
  })
  writeFileSync(join(tmp, 'layout.mjs'), (Array.isArray(out) ? out[0] : out).output[0].code)
  layout = await import(pathToFileURL(join(tmp, 'layout.mjs')).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const lum = hex => {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
/** WCAG 2.x contrast ratio of two #rrggbb colours. */
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const full = hex => (hex.length === 4 ? '#' + [...hex.slice(1)].map(c => c + c).join('') : hex)
const mix = (a, pct, b) => '#' + [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * pct + parseInt(b.slice(i, i + 2), 16) * (1 - pct)).toString(16).padStart(2, '0')).join('')

// The editor backgrounds of the default dark and light themes, and the canvas card drawn over each (3.5% of the text colour).
const DARK = { canvas: '#181818', alt: '#1e1e1e', text: '#d4d4d4' }
const LIGHT = { canvas: '#ffffff', alt: '#f3f3f3', text: '#1f1f1f' }
const bgs = t => [t.canvas, t.alt, mix(t.text, 0.035, t.canvas)]

test('the helper is the WCAG ratio', () => {
  assert.equal(ratio('#000000', '#ffffff').toFixed(2), '21.00')
  assert.equal(ratio('#767676', '#ffffff').toFixed(2), '4.54')
})

test('card and edge accents: text-sized labels get 4.5:1 in both themes, and KIND_COLOR is a variable that follows the theme', () => {
  const { KIND_PALETTE, KIND_COLOR, KIND_CSS } = layout
  assert.deepEqual(Object.keys(KIND_PALETTE.dark), Object.keys(KIND_PALETTE.light))
  for (const [set, theme] of [[KIND_PALETTE.dark, DARK], [KIND_PALETTE.light, LIGHT]]) {
    for (const [kind, hex] of Object.entries(set)) {
      for (const bg of bgs(theme)) assert.ok(ratio(hex, bg) >= 4.5, `${kind} ${hex} on ${bg}: ${ratio(hex, bg).toFixed(2)}`)
    }
  }
  assert.equal(KIND_COLOR.controller, 'var(--kind-controller)')
  assert.match(KIND_CSS, /:root \{ --kind-controller: #ffb454;/)
  assert.match(KIND_CSS, /body\.vscode-light, body\.vscode-high-contrast-light \{ --kind-controller: #9a5b00;/)
  assert.doesNotMatch(readFileSync(join(root, 'src/layout.ts'), 'utf8').replace(/KIND_PALETTE[\s\S]*?\n}\n/, ''), /'#(ffb454|b88cff|8b93a1|4fd6d0|ff6b7d|5c6370)'/i, 'no literal accent left in the layouts')
})

/** The custom properties a CSS rule sets, by name. */
const vars = block => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map(m => [m[1], full(m[2])]))

test('the harness canvas: kind labels, verdict chips and badges read in both themes', () => {
  const css = readFileSync(join(root, 'src/harness/harness.css'), 'utf8')
  const dark = vars(/:root \{([\s\S]*?)\n\}/.exec(css)[1])
  const light = { ...dark, ...vars(/body\.vscode-light, body\.vscode-high-contrast-light \{([\s\S]*?)\n\}/.exec(css)[1]) }
  for (const [name, set, theme] of [['dark', dark, DARK], ['light', light, LIGHT]]) {
    for (const k of ['instructions', 'rules', 'skills', 'agents', 'hooks', 'mcp', 'permissions', 'memory']) {
      for (const bg of bgs(theme)) assert.ok(ratio(set[`--k-${k}`], bg) >= 4.5, `${name} kind ${k} ${set[`--k-${k}`]} on ${bg}: ${ratio(set[`--k-${k}`], bg).toFixed(2)}`)
    }
    for (const v of ['allow', 'ask', 'deny']) {
      // As text of a chip on the canvas, and as the background of a badge whose own text is --on-*.
      for (const bg of bgs(theme)) assert.ok(ratio(set[`--v-${v}`], bg) >= 4.5, `${name} ${v} text on ${bg}: ${ratio(set[`--v-${v}`], bg).toFixed(2)}`)
      assert.ok(ratio(set[`--on-${v}`], set[`--v-${v}`]) >= 4.5, `${name} ${v} badge text ${set[`--on-${v}`]} on ${set[`--v-${v}`]}: ${ratio(set[`--on-${v}`], set[`--v-${v}`]).toFixed(2)}`)
    }
    // The signal colour is a ring, a slider and a selected border (non-text): 3:1.
    for (const bg of bgs(theme)) assert.ok(ratio(set['--fl-signal'], bg) >= 3, `${name} signal on ${bg}`)
  }
  assert.doesNotMatch(css, /color: #fff;|color: #111;/, 'the badge text is a variable, not a literal that only suits one fill')
})
