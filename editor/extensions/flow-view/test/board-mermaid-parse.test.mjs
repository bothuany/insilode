// The mermaid text of every board kind is accepted by mermaid's own parser (the one the Markdown preview uses).
// Skipped when the editor checkout (editor/vscode) has no mermaid-markdown-features dependencies installed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { cleanup, load } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

const deps = join(ROOT, '..', '..', 'vscode', 'extensions', 'mermaid-markdown-features', 'node_modules')
const mermaidFile = join(deps, 'mermaid', 'dist', 'mermaid.core.mjs')
const purifyFile = join(deps, 'dompurify', 'dist', 'purify.es.mjs')
const available = existsSync(mermaidFile) && existsSync(purifyFile)

let mermaid, spec, plan, parse
before(async () => {
	if (!available) {
		return
	}
	spec = await load('../../../board-canvas/spec.ts')
	mermaid = await load('src/board/mermaid.ts')
	plan = await load('src/board/plan.ts')
	// Mermaid's parser sanitizes through DOMPurify, which needs a DOM: outside a browser it is replaced by a pass-through.
	const purify = (await import(pathToFileURL(purifyFile).href)).default
	Object.assign(purify, { addHook() { }, removeHook() { }, sanitize: s => s, isSupported: true })
	parse = (await import(pathToFileURL(mermaidFile).href)).default.parse
})
after(cleanup)

const BOARDS = {
	flow: { kind: 'flow', title: 't', nodes: [{ id: 'a', label: 'POST /orders "x"', kind: 'entry', status: 'done' }, { id: 'b', label: 'Svc', kind: 'service', group: 'g', detail: 'd;e' }, { id: 'c', label: 'orders', kind: 'entity', group: 'g' }, { id: 'd', label: 'ok?', kind: 'decision' }, { id: 'e', label: 'n', kind: 'note' }, { id: 'f', label: 'ext', kind: 'external', status: 'blocked' }, { id: 'g2', label: 'i', kind: 'interface' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', kind: 'writes', label: 'ins' }, { from: 'b', to: 'd' }, { from: 'd', to: 'a', kind: 'no' }, { from: 'c', to: 'e', kind: 'reads' }], groups: [{ id: 'g', label: 'Domain' }] },
	er: { kind: 'er', title: 'er', nodes: [{ id: 'u', label: 'User account', members: [{ text: 'id: Guid' }, { text: 'email string' }] }, { id: 'o', label: 'Order' }], edges: [{ from: 'u', to: 'o', kind: 'has-many', label: 'places', fromCard: '1', toCard: '0..*' }] },
	class: { kind: 'class', title: 'c', nodes: [{ id: 'i', label: 'IRepo', kind: 'interface', members: [{ text: 'Save(x): void', visibility: '+' }] }, { id: 'r', label: 'Repo', members: [{ text: 'id: Guid', visibility: '-' }] }, { id: 'z', label: 'Empty' }], edges: [{ from: 'r', to: 'i', kind: 'implements' }, { from: 'r', to: 'z', kind: 'has-many', label: 'x' }, { from: 'r', to: 'z', kind: 'uses' }] },
	sequence: { kind: 'sequence', title: 's', nodes: [{ id: 'a', label: 'Client', kind: 'actor' }, { id: 'b', label: 'API' }], edges: [{ from: 'a', to: 'b', label: 'POST /x' }, { from: 'b', to: 'a', label: 'ok; 200' }] },
	sequenceFull: { kind: 'sequence', title: 's', nodes: [{ id: 'a', label: 'Client', kind: 'actor' }, { id: 'b', label: 'API' }, { id: 'c', label: 'DB', shape: 'cylinder' }], groups: [{ id: 'f1', label: '[card valid]', kind: 'alt' }, { id: 'f2', label: '[declined]', kind: 'alt', parent: 'f1' }, { id: 'f3', label: 'retry 3', kind: 'loop' }], edges: [{ from: 'a', to: 'b', label: 'pay', order: 1 }, { from: 'b', to: 'c', label: 'insert', order: 2, fragment: 'f1' }, { from: 'c', to: 'b', label: 'ok', order: 3, style: 'dashed', fragment: 'f1' }, { from: 'b', to: 'a', label: 'declined; sorry', order: 4, fragment: 'f2' }, { from: 'b', to: 'c', label: 'audit event', order: 5, async: true, fragment: 'f3' }, { from: 'b', to: 'b', label: 'log', order: 6 }] },
	state: { kind: 'state', title: 'st', nodes: [{ id: 's', label: 'start', shape: 'initial' }, { id: 'd', label: 'Draft "x"' }, { id: 'c', label: 'ok?', shape: 'choice' }, { id: 'p', label: 'Paid; done' }, { id: 'e', label: 'end', shape: 'final' }], edges: [{ from: 's', to: 'd' }, { from: 'd', to: 'c', label: 'pay' }, { from: 'c', to: 'p', label: 'yes', guard: 'amount > 0' }, { from: 'c', to: 'd', label: 'no' }, { from: 'p', to: 'e' }] },
	evil: { title: 'e', nodes: [{ id: 'a', label: '"]\nn9[(x)]\n%% <script>alert(1)</script> ; end' }] },
}

for (const [name, board] of Object.entries(BOARDS)) {
	test(`board-mermaid-parse: ${name} is valid mermaid`, { skip: !available && 'mermaid is not installed in editor/vscode' }, async () => {
		await assert.doesNotReject(parse(mermaid.toMermaid(spec.parseBoard(board))))
	})
}

test('board-mermaid-parse: a parsed plan is valid mermaid', { skip: !available && 'mermaid is not installed in editor/vscode' }, async () => {
	await assert.doesNotReject(parse(mermaid.toMermaid(plan.parsePlan('# P\n## A\n1. one **x**\n2. two\n## B\n3. three'))))
})
