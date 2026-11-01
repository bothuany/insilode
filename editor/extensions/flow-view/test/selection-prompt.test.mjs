// The prompt of a selection ask (src/selectionPrompt.ts): the selected text goes along, fenced and capped, with the lines it
// covers, and the prompt says when the text comes from an unsaved buffer. Pure.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let s
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-selection-prompt-'))
	const outfile = join(tmp, 'selectionPrompt.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'selectionPrompt.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	s = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const sel = (text, startLine, endLine, unsaved = false) => ({ text, startLine, endLine, unsaved })

test('the prompt holds the usual ask, the file with its lines, and the selected text in a fence', () => {
	const p = s.selectionAskPrompt({ kind: 'ask', label: 'a.ts', file: 'src/a.ts', question: 'why is this here?', selected: sel('const x = 1\nconst y = 2', 10, 11) })
	assert.match(p, /src\/a\.ts:10-11/)
	assert.match(p, /"why is this here\?"/)
	assert.ok(p.includes('```\nconst x = 1\nconst y = 2\n```'), p)
	assert.match(p, /The selected lines of src\/a\.ts:10-11:/)
	assert.doesNotMatch(p, /unsaved/)
})

test('a dirty buffer says so: the lines are the buffer\'s and the disk may differ', () => {
	const p = s.selectionAskPrompt({ kind: 'edit', label: 'a.ts', file: 'src/a.ts', question: 'return early', selected: sel('x', 5, 5, true) })
	assert.match(p, /unsaved buffer/)
	assert.match(p, /line numbers are the buffer's/)
	assert.match(p, /src\/a\.ts:5/)
})

test('a long selection is cut at a line break near 6000 characters, marked, and the shown lines are named', () => {
	const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1} ${'x'.repeat(20)}`)
	const text = lines.join('\n')
	assert.ok(text.length > s.MAX_SELECTED_TEXT)
	const p = s.selectionAskPrompt({ kind: 'explain', label: 'a.ts', file: 'a.ts', question: '', selected: sel(text, 100, 499) })
	assert.match(p, /\[truncated\]/)
	const shown = p.split('\n').filter(l => /^line \d+ x+$/.test(l))
	assert.ok(shown.length > 100 && shown.length < 400)
	assert.ok(shown.join('\n').length <= s.MAX_SELECTED_TEXT)
	// The cut is whole lines, and the prompt says which lines of the selection are there: the range never overstates the text.
	assert.match(p, new RegExp(`Only lines 100-${99 + shown.length} of the selection are shown`))
	assert.match(p, /a\.ts:100-499/, 'the selection\'s own range stays')
})

test('a short selection is not marked; one very long line is cut where it stands', () => {
	assert.equal(s.limitSelected('abc', 7).truncated, false)
	assert.deepEqual(s.limitSelected('a\nb\nc', 7), { text: 'a\nb\nc', shownEndLine: 9, truncated: false })
	const one = s.limitSelected('y'.repeat(9000), 3)
	assert.deepEqual([one.text.length, one.shownEndLine, one.truncated], [s.MAX_SELECTED_TEXT, 3, true])
	const p = s.selectedBlock('a.ts', sel('y'.repeat(9000), 3, 3))
	assert.match(p, /Only line 3 of the selection is shown/)
})

test('limitSelected cuts at the last line break within the cap', () => {
	const r = s.limitSelected('aaa\nbbb\nccc', 1, 9)
	assert.deepEqual(r, { text: 'aaa\nbbb', shownEndLine: 2, truncated: true })
})

test('a fence in the text cannot close the prompt\'s fence; Windows line endings are plain breaks', () => {
	const p = s.selectedBlock('a.md', sel('```js\r\nlet a\r\n```', 1, 3))
	assert.ok(p.includes('````\n```js\nlet a\n```\n````'), p)
	assert.ok(!p.includes('\r'))
})

test('the question is still one plain line: only the selected block spans lines', () => {
	const p = s.selectionAskPrompt({ kind: 'ask', label: 'a.ts', file: 'a.ts', question: 'line one\nline two', selected: sel('x', 1, 1) })
	const [head] = p.split('\n\n')
	assert.ok(!head.includes('\n'))
	assert.match(head, /line one line two/)
})
