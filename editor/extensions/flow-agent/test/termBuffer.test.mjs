// The replay buffer of an agent terminal (src/termBuffer.ts): bounded, drops whole chunks from the front, never cuts one.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
let b
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-termbuffer-'))
	const outfile = join(tmp, 'termBuffer.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'termBuffer.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	b = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('what is pushed comes back in order, and an empty chunk is nothing', T, () => {
	const buf = new b.TermBuffer(100)
	buf.push('ab')
	buf.push('')
	buf.push('\x1b[31mcd\x1b[0m')
	assert.equal(buf.text(), 'ab\x1b[31mcd\x1b[0m')
	assert.equal(buf.length, 2 + 'cd'.length + 9)
	buf.clear()
	assert.equal(buf.text(), '')
	assert.equal(buf.length, 0)
})

test('past the cap the oldest chunks go whole, and no chunk is ever cut', T, () => {
	const buf = new b.TermBuffer(10)
	for (const c of ['aaaa', 'bbbb', 'cccc']) {
		buf.push(c)
	}
	// 12 > 10: 'aaaa' goes, 'bbbbcccc' (8) stays.
	assert.equal(buf.text(), 'bbbbcccc')
	buf.push('dd')
	assert.equal(buf.text(), 'bbbbccccdd')
	buf.push('e')
	// 11 > 10: 'bbbb' goes.
	assert.equal(buf.text(), 'ccccdde')
	assert.ok(buf.length <= 10)
})

test('one chunk over the cap stays whole until a newer one arrives', T, () => {
	const buf = new b.TermBuffer(10)
	buf.push('x'.repeat(50))
	assert.equal(buf.text(), 'x'.repeat(50))
	buf.push('y')
	assert.equal(buf.text(), 'y')
})

test('the default cap is about a megabyte and a long run stays under it, in whole chunks', T, () => {
	assert.equal(b.MAX_TERM_BUFFER, 1 << 20)
	const buf = new b.TermBuffer()
	const chunk = 'line of output\r\n'
	for (let i = 0; i < 200_000; i++) {
		buf.push(chunk)
	}
	assert.ok(buf.length <= b.MAX_TERM_BUFFER)
	assert.ok(buf.length > b.MAX_TERM_BUFFER - chunk.length)
	const text = buf.text()
	assert.equal(text.length, buf.length)
	assert.equal(text.length % chunk.length, 0, 'only whole chunks')
})
