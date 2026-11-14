// Mermaid in: sequence, state and flowchart text becomes a board; what cannot be read is said with line numbers; toMermaid -> import round-trips.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let imp, spec, mermaid
before(async () => {
	imp = await load('src/board/mermaidImport.ts')
	spec = await load('../../../board-canvas/spec.ts')
	mermaid = await load('src/board/mermaid.ts')
})
after(cleanup)

const read = text => imp.importMermaid(text)
const parsed = text => spec.parseBoardWithNotes({ title: 'T', ...read(text).board })

test('mermaid-import: a sequence diagram with participants, notes, fragments, replies and async messages', () => {
	const { board, notes } = read(`---
title: Pay an order
---
sequenceDiagram
  autonumber
  actor C as Client
  participant A as API
  participant D as DB
  %% a comment
  C->>+A: POST /pay
  A->>D: insert
  D-->>A: row id
  alt card valid
    A-)D: audit event
  else declined
    A-->>C: 402
  end
  opt has coupon
    loop retry 3
      A->>A: log
    end
  end
  Note over A,D: one transaction
  A-->>-C: 201
`)
	assert.equal(board.kind, 'sequence')
	assert.equal(board.title, 'Pay an order')
	assert.deepEqual(board.nodes.map(n => [n.id, n.label, n.kind]), [['C', 'Client', 'actor'], ['A', 'API', undefined], ['D', 'DB', undefined]])
	assert.deepEqual(board.edges.map(e => e.order), [1, 2, 3, 4, 5, 6, 7])
	assert.equal(board.edges[2].style, 'dashed')
	assert.equal(board.edges[3].async, true)
	assert.deepEqual(board.groups.map(g => [g.kind, g.label, g.parent]), [['alt', 'card valid', undefined], ['alt', 'declined', 'f1'], ['opt', 'has coupon', undefined], ['loop', 'retry 3', 'f3']])
	assert.deepEqual(board.edges.map(e => e.fragment), [undefined, undefined, undefined, 'f1', 'f2', 'f4', undefined])
	assert.deepEqual(board.callouts, [{ node: 'A', text: 'one transaction' }])
	assert.deepEqual(notes, [])
	const p = parsed(`sequenceDiagram\n  A->>B: hi\n  alt x\n    B-->>A: ok\n  end`)
	assert.deepEqual(p.notes, [])
	assert.equal(p.spec.edges[1].fragment, 'f1')
})

test('mermaid-import: an alt with three or more branches: every else is a sibling branch of the alt, nested blocks stay inside theirs', () => {
	const { board } = read(`sequenceDiagram
  A->>B: pay
  alt ok
    B-->>A: 200
  else retry
    opt backoff
      A->>A: wait
    end
    A->>B: pay again
  else fail
    B-->>A: 500
  end
  A->>B: done`)
	assert.deepEqual(board.groups.map(g => [g.id, g.kind, g.label, g.parent]), [
		['f1', 'alt', 'ok', undefined], ['f2', 'alt', 'retry', 'f1'], ['f3', 'opt', 'backoff', 'f2'], ['f4', 'alt', 'fail', 'f1'],
	])
	assert.deepEqual(board.edges.map(e => [e.label, e.fragment]), [['pay', undefined], ['200', 'f1'], ['wait', 'f3'], ['pay again', 'f2'], ['500', 'f4'], ['done', undefined]])
	assert.equal(parsed(`sequenceDiagram\n  alt a\n    A->>B: 1\n  else b\n    A->>B: 2\n  else c\n    A->>B: 3\n  else d\n    A->>B: 4\n  end`).spec.groups.length, 4)
	assert.throws(() => read('sequenceDiagram\n  alt a\n    A->>B: 1\n  end\n  else b'), /line 5: `else` outside an `alt`/, 'an else after the alt is closed is still refused')
	assert.throws(() => read('sequenceDiagram\n  opt a\n    A->>B: 1\n  else b\n  end'), /line 4: `else` outside an `alt`/)
})

test('mermaid-import: unsupported blocks are read through and said so; unknown lines fail with their number', () => {
	const ok = read('sequenceDiagram\n  A->>B: x\n  par one\n    B->>C: y\n  and two\n    B->>D: z\n  end\n  A--xB: lost')
	assert.equal(ok.board.edges.length, 4)
	assert.ok(ok.notes.some(n => /line 3: a `par` block is not drawn as a box/.test(n)))
	assert.ok(ok.notes.some(n => /lost-message arrow/.test(n)))
	assert.throws(() => read('sequenceDiagram\n  A->>B: ok\n  what is this\n  end'), /line 3: `what is this` is not a participant[\s\S]*line 4: `end` without an open/)
	assert.throws(() => read('sequenceDiagram\n  alt x\n  A->>B: hi'), /not closed with `end`/)
	assert.throws(() => read('sequenceDiagram\n  else x'), /line 2: `else` outside an `alt`/)
})

test('mermaid-import: a state diagram: start and end marks, guards, choice, descriptions, composite states, notes', () => {
	const { board, notes } = read(`stateDiagram-v2
  direction LR
  [*] --> Draft
  state "Waiting for payment" as Sent
  state check <<choice>>
  Draft --> Sent : send [has items]
  Sent --> check : payment received
  check --> Paid : yes [amount >= total]
  check --> Sent
  Draft : editable
  state Closing {
    [*] --> Archiving
    Archiving --> [*]
  }
  Paid --> Closing
  Paid --> [*]
  note right of Paid : books closed
`)
	assert.equal(board.kind, 'state')
	assert.equal(board.direction, 'LR')
	const node = id => board.nodes.find(n => n.id === id)
	assert.equal(node('__start').shape, 'initial')
	assert.equal(node('__end').shape, 'final')
	assert.equal(node('__start_Closing').group, 'Closing', 'each composite state has its own start')
	assert.equal(node('Sent').label, 'Waiting for payment')
	assert.equal(node('check').shape, 'choice')
	assert.equal(node('Draft').detail, 'editable')
	assert.deepEqual(board.groups, [{ id: 'Closing', label: 'Closing', kind: 'layer' }])
	const edge = (a, b) => board.edges.find(e => e.from === a && e.to === b)
	assert.deepEqual([edge('Draft', 'Sent').label, edge('Draft', 'Sent').guard], ['send', 'has items'])
	assert.deepEqual([edge('check', 'Paid').label, edge('check', 'Paid').guard], ['yes', 'amount >= total'])
	assert.equal(edge('check', 'Sent').label, undefined)
	assert.deepEqual(board.callouts, [{ node: 'Paid', text: 'books closed' }])
	assert.deepEqual(notes, [])
	assert.equal(parsed('stateDiagram\n  [*] --> A\n  A --> [*]').spec.nodes.length, 3)
	assert.throws(() => read('stateDiagram-v2\n  A --> B\n  state X {\n  nonsense here'), /line 4: `nonsense here` is not a transition/)
	assert.throws(() => read('stateDiagram-v2\n  }'), /line 2: `}` without an open composite/)
})

test('mermaid-import: a flowchart: shapes, link labels, chains, & lists, subgraphs, styling ignored', () => {
	const { board, notes } = read(`flowchart TD
  A[Start] --> B{Valid?}
  B -->|yes| C([Save])
  B -- no --> D[(orders)]
  C -.-> E((Done))
  C ==> F[[Mailer]]
  G & H --> I
  J["quoted <br/> text"] --- K
  subgraph core [Core domain]
    C
    subgraph inner
      F
    end
  end
  classDef green fill:#9f6
  class A green
  style B fill:#f9f
  linkStyle 0 stroke:red
`)
	assert.equal(board.kind, 'flow')
	assert.equal(board.direction, 'TB')
	const node = id => board.nodes.find(n => n.id === id)
	assert.deepEqual([node('A').label, node('B').kind, node('C').shape, node('D').shape, node('E').shape, node('F').kind], ['Start', 'decision', 'round', 'cylinder', 'round', 'external'])
	assert.equal(node('J').label, 'quoted text')
	const edge = (a, b) => board.edges.find(e => e.from === a && e.to === b)
	assert.equal(edge('B', 'C').label, 'yes')
	assert.equal(edge('B', 'D').label, 'no')
	assert.equal(edge('C', 'E').style, 'dashed')
	assert.equal(edge('C', 'F').kind, 'writes')
	assert.ok(edge('G', 'I') && edge('H', 'I'), 'a & b --> c makes two edges')
	assert.deepEqual(board.groups, [{ id: 'core', label: 'Core domain' }, { id: 'g2', label: 'inner', parent: 'core' }])
	assert.equal(node('C').group, 'core', 'a node named inside a subgraph moves in, even though an earlier line drew it')
	assert.equal(node('F').group, 'g2')
	assert.ok(notes.some(n => /4 styling line\(s\)/.test(n)))
	const chain = read('graph LR\n  A --> B --> C\n  C --> A')
	assert.equal(chain.board.edges.length, 3)
	assert.equal(chain.board.direction, 'LR')
	assert.throws(() => read('flowchart LR\n  A --> \n  ---'), /line 2: `-->`[\s\S]*line 3/)
})

test('mermaid-import: other diagrams, empty text and huge text are refused with a way forward', () => {
	assert.throws(() => read('classDiagram\n  A <|-- B'), /line 1: `classDiagram` is not a diagram type this reads\. Supported: sequenceDiagram/)
	assert.throws(() => read('   \n  '), /must be the text|no diagram/)
	assert.throws(() => read(''), /must be the text/)
	assert.throws(() => read('sequenceDiagram\n' + 'A->>B: x\n'.repeat(900)), /902 lines; at most 800/)
	assert.throws(() => read('x'.repeat(61_000)), /61000 characters; at most 60000/)
	assert.throws(() => read('sequenceDiagram'), /no participants/)
})

test('mermaid-import: what toMermaid writes reads back as the same diagram', () => {
	const seq = spec.parseBoard({
		kind: 'sequence', title: 's', nodes: [{ id: 'a', label: 'Client', kind: 'actor' }, { id: 'b', label: 'API' }, { id: 'c', label: 'DB' }],
		groups: [{ id: 'f1', label: '[ok]', kind: 'alt' }, { id: 'f2', label: '[bad]', kind: 'alt', parent: 'f1' }],
		edges: [{ from: 'a', to: 'b', label: 'pay', order: 1 }, { from: 'b', to: 'c', label: 'insert', order: 2, fragment: 'f1' }, { from: 'c', to: 'b', label: 'ok', order: 3, style: 'dashed', fragment: 'f1' }, { from: 'b', to: 'a', label: 'no', order: 4, fragment: 'f2' }, { from: 'b', to: 'c', label: 'audit', order: 5, async: true }],
	})
	const back = read(mermaid.toMermaid(seq)).board
	assert.deepEqual(back.nodes.map(n => n.label), ['Client', 'API', 'DB'])
	assert.deepEqual(back.edges.map(e => [e.label, e.style, e.async, e.fragment]), [['pay', undefined, undefined, undefined], ['insert', undefined, undefined, 'f1'], ['ok', 'dashed', undefined, 'f1'], ['no', undefined, undefined, 'f2'], ['audit', undefined, true, undefined]])
	assert.deepEqual(back.groups.map(g => [g.kind, g.parent]), [['alt', undefined], ['alt', 'f1']])

	const st = spec.parseBoard({
		kind: 'state', title: 'st', nodes: [{ id: 's', label: 'start', shape: 'initial' }, { id: 'd', label: 'Draft' }, { id: 'c', label: 'ok?', shape: 'choice' }, { id: 'p', label: 'Paid' }, { id: 'e', label: 'end', shape: 'final' }],
		edges: [{ from: 's', to: 'd' }, { from: 'd', to: 'c', label: 'pay' }, { from: 'c', to: 'p', label: 'yes', guard: 'amount > 0' }, { from: 'p', to: 'e' }],
	})
	const sb = read(mermaid.toMermaid(st)).board
	const sn = id => sb.nodes.find(n => n.id === id)
	assert.deepEqual([sn('__start').shape, sn('__end').shape], ['initial', 'final'])
	assert.equal(sb.nodes.filter(n => n.shape === 'choice').length, 1)
	assert.deepEqual(sb.nodes.filter(n => !n.shape).map(n => n.label).sort(), ['Draft', 'Paid'])
	assert.deepEqual(sb.edges.filter(e => e.guard).map(e => [e.label, e.guard]), [['yes', 'amount > 0']])
	assert.equal(sb.edges.length, 4)

	const fl = spec.parseBoard({ kind: 'flow', title: 'f', nodes: [{ id: 'a', label: 'POST /orders', kind: 'entry' }, { id: 'b', label: 'ok?', kind: 'decision' }, { id: 'c', label: 'orders', kind: 'entity' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', kind: 'writes', label: 'insert' }] })
	const fb = read(mermaid.toMermaid(fl)).board
	assert.equal(fb.nodes.length, 3)
	assert.deepEqual(fb.nodes.map(n => n.label), ['POST /orders', 'ok?', 'orders'])
	assert.equal(fb.nodes[1].kind, 'decision')
	assert.equal(fb.edges.length, 2)
	assert.equal(fb.edges[1].label, 'insert')
})

test('mermaid-import: the result is a valid board: ids, orders and fragments survive parseBoard without notes', () => {
	for (const text of ['sequenceDiagram\n  A->>B: x\n  B-->>A: y', 'stateDiagram-v2\n  [*] --> A\n  A --> B : go [ok]\n  B --> [*]', 'flowchart LR\n  A[One] -->|go| B{Two}\n  B --> C']) {
		const p = parsed(text)
		assert.deepEqual(p.notes, [], text)
		assert.ok(p.spec.nodes.length >= 2 && p.spec.edges.length >= 1)
	}
})

test('mermaid-import: a diagram bigger than a board is refused while it is read, not after millions of edges', () => {
	const ids = prefix => Array.from({ length: 2500 }, (_, i) => `${prefix}${i}`).join('&')
	const started = Date.now()
	assert.throws(() => read(`flowchart LR\n${ids('a')}-->${ids('b')}`), /more than a board holds \(400 nodes, 1200 edges, 100 groups\)/)
	assert.ok(Date.now() - started < 1500, 'it stops early')
	assert.throws(() => read('stateDiagram-v2\n' + Array.from({ length: 500 }, (_, i) => `S${i} --> S${i + 1}`).join('\n')), /more than a board holds/)
	const many = 'sequenceDiagram\n' + Array.from({ length: 700 }, (_, i) => `P${i}->>P${i + 1}: x`).join('\n')
	assert.throws(() => read(many), /more than a board holds/)
	assert.equal(read('flowchart LR\n' + Array.from({ length: 100 }, (_, i) => `N${i} --> N${i + 1}`).join('\n')).board.edges.length, 100, 'a big but fitting diagram still reads')
})
