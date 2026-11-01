// What a keyboard and a screen reader get from the board: the note and zoom glyphs of a card are buttons with names, the callouts are
// notes, the sequence diagram is also a list of its messages. The components are JSX, so one bundle of them (vite, as board-overlap does)
// is rendered to static markup.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const need = createRequire(join(root, 'package.json'))
let tmp
let m
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ui-a11y-'))
  const entry = join(tmp, 'entry.tsx')
  const src = p => JSON.stringify(join(root, 'src', p).replace(/\\/g, '/'))
  writeFileSync(entry, [
    `import { createElement } from 'react'`,
    `import { renderToStaticMarkup } from 'react-dom/server'`,
    `export { CardNode } from ${src('board/cards.tsx')}`,
    `export { CalloutLayer } from ${src('board/callouts.tsx')}`,
    `export { sequenceMessageList } from ${src('board/SequenceView.tsx')}`,
    `export const html = (type, props) => renderToStaticMarkup(createElement(type, props))`,
  ].join('\n'))
  const out = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    // The entry sits in a temp folder, outside the ui/ install: only its own two imports need pointing at it (exact names, so react/jsx-runtime is untouched).
    resolve: { alias: [{ find: /^react-dom\/server$/, replacement: need.resolve('react-dom/server') }, { find: /^react$/, replacement: need.resolve('react') }] },
    ssr: { noExternal: true },
    build: { ssr: entry, write: false, minify: false, rollupOptions: { output: { format: 'esm' } } },
  })
  writeFileSync(join(tmp, 'entry.mjs'), (Array.isArray(out) ? out[0] : out).output[0].code)
  m = await import(pathToFileURL(join(tmp, 'entry.mjs')).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const card = (node, zoomable = false) => m.html(m.CardNode, { data: { v: { id: node.id, node, box: { x: 0, y: 0, w: 200, h: 60 }, rel: { x: 0, y: 0 }, rows: [], more: 0 }, selected: false, focus: false, match: false, dim: false, canFocus: false, zoomable } })

test('the note glyph of a card is a button named "Show note", with the note as its tooltip', () => {
  const out = card({ id: 'a', label: 'Orders', note: 'Retries twice' })
  assert.match(out, /<button type="button" class="bc-note" aria-label="Show note" aria-expanded="false" title="Retries twice">✎<\/button>/)
  assert.doesNotMatch(out, /<span class="bc-note"/)
  assert.doesNotMatch(out, /<button[^>]*>[^<]*<button/, 'no button inside a button')
})

test('the zoom glyph is a button that names the box it opens; without a board to open there is none', () => {
  const out = card({ id: 'a', label: 'Billing', zoom: 'b2' }, true)
  assert.match(out, /<button type="button" class="bc-zoom" aria-label="Zoom into Billing"[^>]*>⤓<\/button>/)
  assert.doesNotMatch(card({ id: 'a', label: 'Billing', zoom: 'b2' }, false), /bc-zoom/)
  assert.doesNotMatch(card({ id: 'a', label: 'Billing' }, true), /bc-zoom|bc-note/)
})

// A hand-built layout: the shape buildSequence returns, with the fields sequenceMessageList reads.
const lifeline = (id, label) => ({ id, node: { id, label }, x: 0, w: 100 })
const msg = (from, to, label, { edge, ...over } = {}) => ({ index: 0, edge: { from: 'x', to: 'y', label, ...edge }, from, to, y: 0, self: from === to, ret: false, async: false, key: from + '>' + to, ...over })
const layout = (messages, frames = []) => ({ lifelines: [lifeline('a', 'Client'), lifeline('b', 'Api'), lifeline('c', 'Db')], messages, activations: [], frames, width: 0, height: 0, bottom: 0, padTop: 0, unordered: false })

test('the sequence as text: participants, then each message as "1. A calls B: message"', () => {
  const list = m.sequenceMessageList(layout([msg(0, 1, 'POST /orders'), msg(1, 2, 'insert'), msg(2, 1, 'id', { ret: true }), msg(1, 1, 'validate'), msg(1, 0, 'created', { async: true }), msg(0, 1, undefined)]))
  assert.deepEqual(list, [
    'Participants: Client, Api, Db.',
    '1. Client calls Api: POST /orders',
    '2. Api calls Db: insert',
    '3. Db replies to Api: id',
    '4. Api calls itself: validate',
    '5. Api sends to Client: created',
    '6. Client calls Api',
  ])
})

test('a guard leads the message, groups are listed last and a lifeline-less diagram still reads', () => {
  const list = m.sequenceMessageList(layout([msg(0, 1, 'retry', { edge: { guard: 'failed' } })], [{ id: 'g', kind: 'alt', label: 'payment fails', isElse: false }, { id: 'e', kind: 'alt', label: 'else', isElse: true }, { id: 'l', kind: 'loop', label: '', isElse: false }]))
  assert.equal(list[1], '1. Client calls Api: [failed] retry')
  assert.equal(list.at(-1), 'Groups: alt payment fails; loop.')
  assert.deepEqual(m.sequenceMessageList({ ...layout([]), lifelines: [] }), ['Participants: none.'])
  assert.deepEqual(m.sequenceMessageList(layout([])), ['Participants: Client, Api, Db.'])
})

test('the sequence view hides its SVG only because the list covers it, and names the list', async () => {
  const { readFileSync } = await import('node:fs')
  const view = readFileSync(join(root, 'src/board/SequenceView.tsx'), 'utf8')
  assert.match(view, /<ul className="sr-only" role="list" aria-label=\{`Sequence diagram: /)
  assert.match(view, /className="sq"\s+aria-hidden="true"/)
  assert.doesNotMatch(view, /role="img"/)
  const co = readFileSync(join(root, 'src/board/callouts.tsx'), 'utf8')
  assert.match(co, /role="group" aria-label="Notes on the board"/)
  assert.match(co, /className="co" role="note" aria-label=\{b\.text\}/)
  const css = readFileSync(join(root, 'src/board/board.css'), 'utf8')
  assert.match(css, /\.sr-only \{ position: absolute; width: 1px; height: 1px;/)
  assert.match(css, /\.bc-note, \.bc-zoom \{[^}]*width: 24px; height: 24px/, 'a 24px hit area')
})
