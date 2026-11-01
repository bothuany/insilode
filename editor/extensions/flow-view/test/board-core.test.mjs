// Boards: validation (parseBoard, kept in sync with the draw_board schema), the store, the mermaid and Markdown output.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, load } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let spec, tools, prompts, store, mermaid, markdown
before(async () => {
	spec = await load('src/board/spec.ts')
	tools = await load('src/mcp/tools.ts')
	prompts = await load('src/mcp/prompts.ts')
	store = await load('src/board/store.ts')
	mermaid = await load('src/board/mermaid.ts')
	markdown = await load('src/board/markdown.ts')
})
after(cleanup)

/** The members of a string-literal union in spec.ts: `export type X = 'a' | 'b'`, possibly across lines. */
function union(name) {
	const src = readFileSync(join(ROOT, 'src', 'board', 'spec.ts'), 'utf8')
	const m = new RegExp(`export type ${name}\\s*=([^;]+);`).exec(src)
	assert.ok(m, `${name} is declared in spec.ts`)
	return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1])
}

test('board-schema: the draw_board enums are the ones spec.ts accepts', () => {
	assert.deepEqual([...tools.BOARD_KINDS], union('BoardKind'))
	assert.deepEqual([...tools.NODE_KINDS], union('NodeKind'))
	assert.deepEqual([...tools.NODE_STATUSES], union('NodeStatus'))
	assert.deepEqual([...tools.EDGE_KINDS], union('EdgeKind'))
	const props = tools.BOARD_SCHEMA.properties
	assert.deepEqual(props.kind.enum, union('BoardKind'))
	assert.deepEqual(props.nodes.items.properties.kind.enum, union('NodeKind'))
	assert.deepEqual(props.nodes.items.properties.status.enum, union('NodeStatus'))
	assert.deepEqual(props.edges.items.properties.kind.enum, union('EdgeKind'))
	assert.deepEqual(props.direction.enum, ['LR', 'TB'])
	// every field of BoardNode / BoardEdge in spec.ts is in the schema, except skeleton first's host-only marks (parseBoard drops them)
	const src = readFileSync(join(ROOT, 'src', 'board', 'spec.ts'), 'utf8')
	const fields = name => [...new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src)[1].matchAll(/^\t(\w+)\??:/gm)].map(m => m[1])
	const HOST_ONLY = ['check', 'checkNote', 'warn', 'target']
	assert.deepEqual(fields('BoardNode').filter(f => !HOST_ONLY.includes(f)).sort(), Object.keys(props.nodes.items.properties).sort())
	assert.deepEqual(fields('BoardMember').filter(f => !HOST_ONLY.includes(f)).sort(), Object.keys(props.nodes.items.properties.members.items.properties).sort())
	assert.deepEqual(fields('BoardEdge').sort(), Object.keys(props.edges.items.properties).sort())
	assert.deepEqual(fields('BoardGroup').sort(), Object.keys(props.groups.items.properties).sort())
})

test('board-validate: the example in the draw_board description is a valid board', () => {
	// The example moved out of the (short) tool description into the diagram_guide prompt the description points at.
	const guide = prompts.getPrompt('diagram_guide', {}).messages[0].content.text
	assert.match(tools.TOOLS.find(t => t.name === 'draw_board').description, /diagram_guide/)
	const example = JSON.parse(/Example \(a flow board\):\s*(\{.*\}\})\s*\n/.exec(guide)[1])
	assert.equal(example.id, 'order-flow')
	const board = spec.parseBoard(example.board)
	assert.equal(board.kind, 'flow')
	assert.equal(board.nodes.length, 3)
	assert.equal(board.edges.length, 2)
	assert.equal(board.edges[1].kind, 'writes')
})

test('board-validate: bad input is cleaned or refused with a message the agent can act on', () => {
	assert.throws(() => spec.parseBoard('x'), /must be an object/)
	assert.throws(() => spec.parseBoard({ nodes: [] }), /non-empty "nodes"/)
	assert.throws(() => spec.parseBoard({ nodes: Array.from({ length: spec.MAX_NODES + 1 }, (_, i) => ({ id: `n${i}` })) }), /at most 400/)
	const b = spec.parseBoard({
		kind: 'nonsense', title: '  ', nodes: [{ id: 'a', kind: 'wizard', status: 'later', line: -4 }, { id: 'a', label: 'dup' }, 7, null],
		edges: [{ from: 'a', to: 'a_' }, { from: 'a', to: 'ghost' }, { from: 'a', to: 'a_', kind: 'weird' }],
	})
	assert.equal(b.kind, 'flow')
	assert.equal(b.title, 'Untitled')
	assert.deepEqual(b.nodes.map(n => n.id), ['a', 'a_'], 'duplicate ids are made unique, non-objects dropped')
	assert.equal(b.nodes[0].kind, undefined)
	assert.equal(b.nodes[0].status, undefined)
	assert.equal(b.nodes[0].line, 1)
	assert.equal(b.edges.length, 2, 'the edge to a missing node is dropped')
	assert.equal(b.edges[1].kind, undefined)
})

const sample = () => spec.parseBoard({
	kind: 'flow', title: 'Order "flow" <b>', nodes: [
		{ id: 'api;x', label: 'POST /orders', kind: 'entry', status: 'done' },
		{ id: 'svc', label: 'Place|Order\nline2', kind: 'service', detail: 'does "things"', status: 'doing', group: 'g' },
		{ id: 'db', label: 'orders', kind: 'entity', group: 'g' },
		{ id: 'q', label: 'ok?', kind: 'decision' },
	],
	edges: [{ from: 'api;x', to: 'svc' }, { from: 'svc', to: 'db', kind: 'writes', label: 'insert' }, { from: 'svc', to: 'q' }, { from: 'q', to: 'api;x', kind: 'no' }],
	groups: [{ id: 'g', label: 'Domain' }],
})

test('board-mermaid: a flow becomes a flowchart with renamed ids, shapes, groups and status classes', () => {
	const m = mermaid.toMermaid(sample())
	assert.match(m, /^flowchart LR/)
	assert.match(m, /n0\(\["✓ POST \/orders"\]\)/)
	assert.match(m, /subgraph g0\["Domain"\]/)
	assert.match(m, /n2\[\("orders"\)\]/, 'an entity is a cylinder')
	assert.match(m, /n3\{"ok\?"\}/, 'a decision is a rhombus')
	assert.match(m, /n1 ==>\|"insert"\| n2/, 'writes are thick arrows')
	assert.match(m, /n3 -->\|"no"\| n0/)
	assert.match(m, /class n0 done/)
	assert.match(m, /class n1 doing/)
	assert.doesNotMatch(m, /api;x/, 'agent ids never reach the diagram')
})

test('board-mermaid: nothing in a label can break out of the quotes', () => {
	const m = mermaid.toMermaid(sample())
	assert.match(m, /Place#124;Order line2<br\/>does #quot;things#quot;/)
	const evil = spec.parseBoard({ title: 't', nodes: [{ id: 'a', label: '"]\nn9[(x)]\n%% <script>alert(1)</script> ; end' }] })
	const out = mermaid.toMermaid(evil)
	assert.equal(out.split('\n').length, 2, 'one header and one node line: the newline in the label did not start a new statement')
	assert.doesNotMatch(out, /<script>|"\]\n/)
	assert.doesNotMatch(out.replace(/#\w+;/g, ''), /;/, 'a raw semicolon would end the statement')
	assert.equal((out.match(/"/g) ?? []).length, 2, 'only the two quotes that delimit the label')
})

test('board-mermaid: plans run top to bottom; groups nest; a group cycle cannot lose nodes or loop', () => {
	const plan = spec.parseBoard({ kind: 'plan', title: 'p', nodes: [{ id: 'a', label: 'A', group: 'x' }, { id: 'b', label: 'B', group: 'y' }], edges: [{ from: 'a', to: 'b', kind: 'next' }], groups: [{ id: 'x', label: 'X', parent: 'y' }, { id: 'y', label: 'Y', parent: 'x' }] })
	const m = mermaid.toMermaid(plan)
	assert.match(m, /^flowchart TB/)
	assert.match(m, /n0\["A"\]/)
	assert.match(m, /n1\["B"\]/)
	assert.equal((m.match(/subgraph/g) ?? []).length, (m.match(/^\s*end$/gm) ?? []).length)
})

test('board-mermaid: er, class and sequence diagrams', () => {
	const er = mermaid.toMermaid(spec.parseBoard({
		kind: 'er', title: 'er', nodes: [{ id: 'u', label: 'User account', members: [{ text: 'id: Guid' }, { text: 'email string' }] }, { id: 'o', label: 'Order' }],
		edges: [{ from: 'u', to: 'o', kind: 'has-many', label: 'places', fromCard: '1', toCard: '0..*' }],
	}))
	assert.match(er, /^erDiagram/)
	assert.match(er, /User_account \{\n    Guid id\n    email string\n  \}/)
	assert.match(er, /User_account \|\|--o\{ Order : "places"/)
	const cls = mermaid.toMermaid(spec.parseBoard({
		kind: 'class', title: 'c', nodes: [{ id: 'i', label: 'IRepo', kind: 'interface', members: [{ text: 'Save(x): void', visibility: '+' }] }, { id: 'r', label: 'Repo' }],
		edges: [{ from: 'r', to: 'i', kind: 'implements' }],
	}))
	assert.match(cls, /^classDiagram/)
	assert.match(cls, /<<interface>>/)
	assert.match(cls, /n0 <\|\.\. n1|n0 <\|\.\. n1/)
	assert.match(cls, /n0 <\|\.\. n1/.test(cls) ? /n0/ : /n0 <\|\.\. n1/)
	const seq = mermaid.toMermaid(spec.parseBoard({ kind: 'sequence', title: 's', nodes: [{ id: 'a', label: 'Client', kind: 'actor' }, { id: 'b', label: 'API' }], edges: [{ from: 'a', to: 'b', label: 'POST /x' }] }))
	assert.match(seq, /^sequenceDiagram\n  actor n0 as Client\n  participant n1 as API\n  n0->>n1: POST \/x/)
})

test('board-markdown: the document holds the diagram, a node table with code links and statuses', () => {
	const b = spec.parseBoard({ kind: 'flow', title: 'T <x>', description: 'a <b>', nodes: [{ id: 'a', label: 'A|B', file: 'C:\\app\\a (1).cs', line: 12, status: 'blocked', note: 'n' }, { id: 'b', label: 'B' }], edges: [] })
	const md = markdown.boardMarkdown('my-board', b, { link: (f, l) => `file:///${f.replace(/\\/g, '/')}#L${l}`, display: f => 'a (1).cs' })
	assert.match(md, /^# T &lt;x>|^# T </m)
	assert.match(md, /```mermaid\nflowchart/)
	assert.match(md, /\| A\\\|B \| {2}\| \[a \(1\)\.cs:12\]\(<file:\/\/\/C:\/app\/a \(1\)\.cs#L12>\) \| \*\*blocked\*\* \| n \|/)
	assert.match(md, /Board `my-board`/)
	const plan = markdown.boardMarkdown('p', { ...b, kind: 'plan', nodes: [{ id: 'a', label: 'One', status: 'done' }, { id: 'b', label: 'Two' }] })
	assert.match(plan, /1 of 2 steps done/)
	assert.match(plan, /1\. \[x\] One/)
	assert.match(plan, /2\. \[ \] Two/)
})

test('board-store: set, replace by id, latest first, ids cleaned so they can never be paths', async () => {
	const s = new store.BoardStore()
	const shown = []
	s.setHost({ show: (id, sp) => { shown.push(['show', id, sp.title]) }, update: (id) => { shown.push(['update', id]) } })
	const a = await s.set(spec.parseBoard({ title: 'First', nodes: [{ id: 'a' }] }), { id: 'one' })
	await new Promise(r => setTimeout(r, 3))
	const b = await s.set(spec.parseBoard({ title: 'Second', nodes: [{ id: 'a' }] }))
	assert.equal(a, 'one')
	assert.match(b, /^second-\d+$/)
	assert.deepEqual(s.list().map(x => x.id), [b, 'one'], 'latest first')
	await s.set(spec.parseBoard({ title: 'First v2', nodes: [{ id: 'a' }, { id: 'b' }] }), { id: 'one' })
	assert.equal(s.list().length, 2, 'the same id replaces')
	assert.equal(s.get('one').spec.title, 'First v2')
	assert.deepEqual(shown.map(x => x[0]), ['show', 'show', 'show'], 'a replaced board is shown again')
	assert.equal(store.cleanBoardId('../../etc/passwd'), 'etc-passwd')
	assert.equal(store.cleanBoardId('C:\\x\\y'), 'C:-x-y')
	assert.equal(store.cleanBoardId('   '), undefined)
	assert.equal(store.cleanBoardId(42), undefined)
	assert.doesNotMatch(store.boardFileName('../../x'), /[\\/]/)
	assert.notEqual(store.boardFileName('a b'), store.boardFileName('a-b'), 'ids that clean alike still get different files')
})

test('board-store: node updates, with messages that name the valid ids', async () => {
	const s = new store.BoardStore()
	const updates = []
	s.setHost({ show() { }, update: (id, sp) => { updates.push(sp.nodes.map(n => n.status)) } })
	const events = []
	s.onDidChange(e => events.push(e.type))
	const id = await s.set(spec.parseBoard({ kind: 'plan', title: 'P', nodes: [{ id: 'one', label: '1' }, { id: 'two', label: '2' }] }), { id: 'plan:abc', origin: 'plan', session: 'sess' })
	await s.updateNode(id, 'two', { status: 'doing' })
	await s.updateNode(id, 'two', { note: 'half way' })
	assert.deepEqual(updates.at(-1), [undefined, 'doing'])
	assert.equal(s.get(id).spec.nodes[1].note, 'half way')
	assert.deepEqual(events, ['set', 'node', 'node'])
	await assert.rejects(s.updateNode('nope', 'one', {}), /No board "nope"\. Boards: plan:abc/)
	await assert.rejects(s.updateNode(id, 'zzz', {}), /no node "zzz"\. Nodes: one, two/)
	assert.equal(s.forSession('sess').length, 1)
	assert.equal(s.forSession('other').length, 0)
	s.delete(id)
	assert.equal(s.get(id), undefined)
})

test('board-store: only the newest boards are kept', async () => {
	const s = new store.BoardStore()
	for (let i = 0; i < store.MAX_BOARDS + 5; i++) {
		await s.set(spec.parseBoard({ title: `b${i}`, nodes: [{ id: 'a' }] }), { id: `b${i}`, present: false })
	}
	assert.equal(s.list().length, store.MAX_BOARDS)
	assert.equal(s.get('b0'), undefined)
	assert.ok(s.get(`b${store.MAX_BOARDS + 4}`))
})
