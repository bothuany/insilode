// Opening a file that came from a directory listing (src/safeFile.ts): a FIFO, a link, a directory or an oversized file is refused at once
// instead of blocking a thread of the extension host for ever.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 5000 }
const POSIX = { ...T, skip: process.platform === 'win32' && 'FIFOs and symbolic links are a POSIX thing' }
let m
let tmp
before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-safefile-')))
	const outfile = join(tmp, 'safeFile.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'safeFile.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('a regular file opens with its size; a bigger one than the limit, a directory and a missing file are refused', T, async () => {
	const file = join(tmp, 'a.json')
	writeFileSync(file, '12345')
	const { handle, size } = await m.openRegular(file, 10)
	assert.equal(size, 5)
	await handle.close()
	await assert.rejects(m.openRegular(file, 4))
	await assert.rejects(m.openRegular(tmp))
	await assert.rejects(m.openRegular(join(tmp, 'missing')))
})

test('a FIFO is refused at once (a plain open would wait for a writer for ever), and so is a link', POSIX, async () => {
	const fifo = join(tmp, 'f.jsonl')
	execFileSync('mkfifo', [fifo])
	await assert.rejects(m.openRegular(fifo), /regular file/)
	writeFileSync(join(tmp, 'real'), 'x')
	symlinkSync(join(tmp, 'real'), join(tmp, 'link'))
	await assert.rejects(m.openRegular(join(tmp, 'link')))
	mkdirSync(join(tmp, 'dir'), { recursive: true })
})
