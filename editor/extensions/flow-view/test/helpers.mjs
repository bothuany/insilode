// Runs the polyglot index worker (the built out/polyWorker.js) on a folder and prints what it finds as plain text.
import { Worker } from 'node:worker_threads'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const READY_MS = 60_000

export class Index {
	#worker
	#seq = 0
	ready

	constructor(folder, exclude = []) {
		const cacheFile = join(mkdtempSync(join(tmpdir(), 'flow-test-')), 'cache.json')
		this.#worker = new Worker(join(ROOT, 'out', 'polyWorker.js'), { workerData: { roots: [resolve(folder)], wasmDir: join(ROOT, 'out', 'wasm'), cacheFile, exclude } })
		// Resolves when the index is built; fails when it cannot be (a crash, an index error, no answer in time) instead of hanging the test.
		this.ready = new Promise((ok, fail) => {
			const timer = setTimeout(() => fail(new Error(`the index was not ready after ${READY_MS} ms`)), READY_MS)
			const settle = (f, v) => { clearTimeout(timer); f(v) }
			this.#worker.on('message', m => {
				if (m.type === 'ready') {
					settle(ok)
				} else if (m.type === 'log' && /^index failed/.test(m.message)) {
					settle(fail, new Error(m.message))
				}
			})
			this.#worker.on('error', e => settle(fail, e))
			this.#worker.on('exit', code => settle(fail, new Error(`the index worker exited (${code}) before it was ready`)))
		})
		this.ready.catch(() => { }) // reported where it is awaited
	}

	request(op, ...args) {
		const id = ++this.#seq
		return new Promise((ok, fail) => {
			const onMessage = m => {
				if (m.id === id) {
					this.#worker.off('message', onMessage)
					m.error ? fail(new Error(m.error)) : ok(m.result)
				}
			}
			this.#worker.on('message', onMessage)
			this.#worker.postMessage({ id, op, args })
		})
	}

	functionAt(file, line) {
		return this.request('functionAt', file, line)
	}

	graph(id, depth) {
		return this.request('graph', id, depth)
	}

	close() {
		return this.#worker.terminate()
	}
}

const tree = (node, depth) => (node.children ?? []).map(c => `${'  '.repeat(depth)}${c.guess ? '(guess) ' : ''}${c.edgeKind}: ${c.node.label} [${c.node.kind}]\n${tree(c.node, depth + 1)}`).join('') + (node.pending?.length ? `${'  '.repeat(depth)}? ${node.pending.map(p => p.name).join(', ')}\n` : '')

/** Entry points with the calls under each, one line per node: the shape a snapshot can pin. */
export async function describe(folder) {
	const index = new Index(folder)
	try {
		await index.ready
		const key = e => `${e.http}${e.controller}${e.action}`
		// Code-unit order, not localeCompare: the snapshots must not depend on the machine's locale.
		const entries = (await index.request('entries')).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
		let out = ''
		for (const e of entries) {
			out += `${e.http.padEnd(18)}${e.controller}.${e.action}\n${tree(await index.graph(e.id), 1)}`
		}
		return out
	} finally {
		await index.close()
	}
}
