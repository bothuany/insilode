// Compare boards: what is added, removed or changed between two versions of a design, a `base` board, and "since the last draw".
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let spec, compare, store
before(async () => {
	spec = await load('../../../board-canvas/spec.ts')
	compare = await load('src/board/compare.ts')
	store = await load('src/board/store.ts')
})
after(cleanup)

const board = raw => spec.parseBoard({ kind: 'architecture', title: 'T', ...raw })
const v1 = () => board({
	nodes: [{ id: 'api', label: 'API' }, { id: 'svc', label: 'OrderService', group: 'core', members: [{ text: 'place(): void' }] }, { id: 'db', label: 'orders' }, { id: 'old', label: 'LegacyQueue', group: 'gone' }],
	edges: [{ from: 'api', to: 'svc', label: 'calls' }, { from: 'svc', to: 'db', kind: 'writes' }, { from: 'svc', to: 'old' }],
	groups: [{ id: 'core', label: 'Core' }, { id: 'gone', label: 'Legacy' }],
})
const v2 = () => board({
	nodes: [{ id: 'api', label: 'API' }, { id: 'svc', label: 'OrderService', group: 'core', members: [{ text: 'place(): void' }, { text: 'cancel(): void' }] }, { id: 'db', label: 'orders' }, { id: 'bus', label: 'Kafka' }],
	edges: [{ from: 'api', to: 'svc', label: 'places' }, { from: 'svc', to: 'db', kind: 'writes' }, { from: 'svc', to: 'bus', label: 'OrderPlaced', async: true }],
	groups: [{ id: 'core', label: 'Core' }],
})
const byId = (s, id) => s.nodes.find(n => n.id === id)

test('board-compare: added, changed and removed nodes and edges are marked, removed ones are drawn again', () => {
	const c = compare.compareBoards(v1(), v2())
	assert.equal(byId(c, 'bus').change, 'added')
	assert.equal(byId(c, 'svc').change, 'changed', 'a new member changes the node')
	assert.equal(byId(c, 'api').change, undefined)
	assert.equal(byId(c, 'old').change, 'removed')
	assert.deepEqual(c.groups.map(g => g.id).sort(), ['core', 'gone'], 'the group of a removed node comes along')
	const edge = (a, b) => c.edges.find(e => e.from === a && e.to === b)
	assert.equal(edge('api', 'svc').change, 'changed', 'a new label changes the edge')
	assert.equal(edge('svc', 'db').change, undefined)
	assert.equal(edge('svc', 'bus').change, 'added')
	assert.equal(edge('svc', 'old').change, 'removed', 'a removed edge between kept nodes is kept as a ghost')
	assert.deepEqual(compare.countChanges(c), { added: 2, removed: 2, changed: 2 })
})

test('board-compare: progress is not a design change, an agent-set change is kept, inputs stay untouched', () => {
	const a = board({ nodes: [{ id: 'a', label: 'A', status: 'todo', note: 'x' }, { id: 'b', label: 'B' }], edges: [] })
	const b = board({ nodes: [{ id: 'a', label: 'A', status: 'done', note: 'y' }, { id: 'b', label: 'B', change: 'removed' }], edges: [] })
	const before = JSON.stringify(b)
	const c = compare.compareBoards(a, b)
	assert.equal(byId(c, 'a').change, undefined)
	assert.equal(byId(c, 'b').change, 'removed')
	assert.equal(JSON.stringify(b), before)
	assert.equal(compare.hasChanges(a), false)
	assert.equal(compare.hasChanges(c), true)
	assert.equal(compare.compareBoards(a, a).nodes.length, 2)
	assert.equal(compare.hasChanges(compare.compareBoards(a, a)), false)
})

test('board-compare: host-only marks of a removed node are not carried over', () => {
	const a = board({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] })
	a.nodes[1].check = 'matches'
	a.nodes[1].warn = 'x'
	const c = compare.compareBoards(a, board({ nodes: [{ id: 'a', label: 'A' }], edges: [] }))
	assert.equal(byId(c, 'b').check, undefined)
	assert.equal(byId(c, 'b').warn, undefined)
})

test('board-compare: repeated messages between the same two participants are told apart by label and order', () => {
	const seq = edges => spec.parseBoard({ kind: 'sequence', title: 'S', nodes: [{ id: 'api', label: 'API' }, { id: 'db', label: 'DB' }], edges })
	const msg = (label, order) => ({ from: 'api', to: 'db', label, order })
	const base = seq([msg('read user', 1), msg('read orders', 2), msg('write audit', 3)])
	// The middle message is deleted: the other two are unchanged (renumbered, same relative order), the deleted one is a ghost.
	const dropped = compare.compareBoards(base, seq([msg('read user', 1), msg('write audit', 2)]))
	assert.deepEqual(dropped.edges.map(e => [e.label, e.change]), [['read user', undefined], ['write audit', undefined], ['read orders', 'removed']])
	assert.deepEqual(compare.countChanges(dropped), { added: 0, removed: 1, changed: 0 })
	// Nothing changed: nothing is marked.
	assert.equal(compare.hasChanges(compare.compareBoards(base, base)), false)
	// A relabelled message is changed, not removed and added.
	const relabelled = compare.compareBoards(base, seq([msg('read user', 1), msg('read open orders', 2), msg('write audit', 3)]))
	assert.deepEqual(relabelled.edges.map(e => [e.label, e.change]), [['read user', undefined], ['read open orders', 'changed'], ['write audit', undefined]])
	// One message moved: it alone is marked, not the messages it moved past.
	const moved = compare.compareBoards(base, seq([msg('write audit', 1), msg('read user', 2), msg('read orders', 3)]))
	assert.deepEqual(moved.edges.map(e => [e.label, e.change]), [['write audit', 'changed'], ['read user', undefined], ['read orders', undefined]])
	const swapped = compare.compareBoards(base, seq([msg('read orders', 1), msg('read user', 2), msg('write audit', 3)]))
	assert.equal(swapped.edges.filter(e => e.change === 'changed').length, 1, 'of two swapped messages one moved')
	// One more message of the same pair is added, the rest stay.
	const added = compare.compareBoards(base, seq([msg('read user', 1), msg('read orders', 2), msg('read cart', 3), msg('write audit', 4)]))
	assert.deepEqual(added.edges.map(e => [e.label, e.change]), [['read user', undefined], ['read orders', undefined], ['read cart', 'added'], ['write audit', undefined]])
})

const host = () => {
	const shown = []
	return { shown, show: (id, s, extra) => void shown.push(['show', id, s, extra]), update: (id, s, extra) => void shown.push(['update', id, s, extra]) }
}

test('board-store: a board with a base is shown compared with that board', async () => {
	const s = new store.BoardStore()
	const h = host()
	s.setHost(h)
	await s.set(v1(), { id: 'before' })
	await s.set(board({ ...v2(), base: 'before' }), { id: 'after' })
	const shown = h.shown.at(-1)[2]
	assert.equal(byId(shown, 'bus').change, 'added')
	assert.equal(byId(shown, 'old').change, 'removed')
	assert.equal(s.get('after').spec.nodes.some(n => n.id === 'old'), false, 'the stored board is what was drawn')
	await s.set(board({ ...v2(), base: 'missing' }), { id: 'other' })
	assert.equal(byId(h.shown.at(-1)[2], 'bus').change, undefined, 'an unknown base compares nothing')
})

test('board-store: the previous draw is kept; a board that is its own base shows what changed, and the host is told for the switch', async () => {
	const s = new store.BoardStore()
	const h = host()
	s.setHost(h)
	await s.set(v1(), { id: 'design' })
	assert.equal(h.shown.at(-1)[3].since, undefined, 'nothing to compare with the first time')
	await s.set(v2(), { id: 'design' })
	assert.equal(s.get('design').previous.nodes.length, 4)
	const since = h.shown.at(-1)[3].since
	assert.equal(byId(since, 'bus').change, 'added')
	assert.equal(byId(h.shown.at(-1)[2], 'bus').change, undefined, 'the board itself is not coloured unless asked')
	await s.set(board({ ...v2(), base: 'design' }), { id: 'design' })
	assert.equal(byId(h.shown.at(-1)[2], 'old'), undefined, 'the previous draw was already v2: no change')
	await s.set(board({ ...v1(), base: 'design' }), { id: 'design' })
	assert.equal(byId(h.shown.at(-1)[2], 'bus').change, 'removed', 'v1 against its previous draw v2: Kafka is gone')
	await s.set(v1(), { id: 'same' })
	await s.set(v1(), { id: 'same' })
	assert.equal(h.shown.at(-1)[3].since, undefined, 'an identical redraw has no changes to show')
})

test('board-store: update_board redraws keep the since diff, and take several nodes and a highlight at once', async () => {
	const s = new store.BoardStore()
	const h = host()
	s.setHost(h)
	await s.set(v1(), { id: 'd' })
	await s.set(v2(), { id: 'd' })
	const touched = await s.update('d', { nodes: [{ nodeId: 'api', status: 'done' }, { nodeId: 'db', note: 'n', change: 'changed' }], highlight: [{ path: ['api', 'svc'], label: 'x' }] })
	assert.deepEqual(touched.map(n => [n.id, n.status ?? n.change]), [['api', 'done'], ['db', 'changed']])
	assert.equal(s.get('d').spec.highlight[0].label, 'x')
	assert.ok(h.shown.at(-1)[3].since, 'still comparable with the previous draw')
	await s.update('d', { highlight: [] })
	assert.equal(s.get('d').spec.highlight, undefined, 'an empty list clears the route')
	await assert.rejects(s.update('d', { nodes: [{ nodeId: 'ghost', status: 'done' }] }), /no node "ghost"/)
	await assert.rejects(s.update('nope', {}), /No board "nope"/)
})

test('board-store: C4 zoom: the host is told which boards exist and which ones zoom into this one, and a board can be presented again', async () => {
	const s = new store.BoardStore()
	const h = host()
	s.setHost(h)
	await s.set(board({ level: 'container', title: 'Containers', nodes: [{ id: 'api', label: 'API', zoom: 'components' }, { id: 'db', label: 'DB' }], edges: [] }), { id: 'containers' })
	assert.equal(h.shown.at(-1)[3].boards, undefined, 'no other board yet')
	await s.set(board({ level: 'component', title: 'API components', nodes: [{ id: 'ctl', label: 'Controller' }], edges: [] }), { id: 'components' })
	assert.deepEqual(h.shown.at(-1)[3].boards, [{ id: 'containers', title: 'Containers', up: true }], 'the container board zooms into this one')
	const before = h.shown.length
	assert.equal(await s.present('containers'), true)
	assert.equal(h.shown.length, before + 1)
	assert.deepEqual(h.shown.at(-1)[3].boards, [{ id: 'components', title: 'API components', up: false }])
	assert.equal(await s.present('nope'), false)
})
