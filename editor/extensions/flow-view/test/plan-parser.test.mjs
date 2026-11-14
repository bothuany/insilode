// Plans as boards: the Markdown an agent proposes in plan mode becomes a `plan` board.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { cleanup, load } from './bundle.mjs'

let plan, spec
before(async () => {
	plan = await load('src/board/plan.ts')
	spec = await load('../../../board-canvas/spec.ts')
})
after(cleanup)

const PLAN = `# Plan: Soft-delete users

## Context
Users are hard-deleted today, which breaks the audit log.

## Steps
1. **Add a migration**: add a \`deleted_at\` column to the users table in db/migrations/0042_users.sql
2. Update \`UserService.Remove\` to set the flag instead of deleting
   - keep the audit entry
   - emit UserRemoved
3. Change the DELETE /users/{id} endpoint in src/Controllers/UsersController.cs:48 to return 204
4. Add tests for the repository and the endpoint

## Verification
1. Run the unit tests
2. Decide whether the old rows need a backfill?
`

const resolvers = {
	file: m => m === 'src/Controllers/UsersController.cs' ? { file: 'C:\\app\\src\\Controllers\\UsersController.cs' } : m === 'db/migrations/0042_users.sql' ? { file: 'C:\\app\\db\\migrations\\0042_users.sql' } : undefined,
	symbol: n => n === 'UserService.Remove' ? { file: 'C:\\app\\src\\UserService.cs', line: 31 } : undefined,
}

test('plan-parse: numbered steps become step nodes in order, joined by next edges', () => {
	const b = plan.parsePlan(PLAN, resolvers)
	assert.equal(b.kind, 'plan')
	assert.equal(b.title, 'Soft-delete users', 'the first heading, without the Plan: prefix')
	assert.deepEqual(b.nodes.map(n => n.id), ['s1', 's2', 's3', 's4', 's5', 's6'])
	assert.deepEqual(b.edges.map(e => `${e.from}>${e.to}:${e.kind}`), ['s1>s2:next', 's2>s3:next', 's3>s4:next', 's4>s5:next', 's5>s6:next'])
	assert.ok(b.nodes.every(n => n.status === 'todo'))
	assert.equal(b.direction, 'TB')
	assert.deepEqual(spec.parseBoard(b).nodes.length, 6, 'the result is a valid board')
})

test('plan-parse: a "Title: rest" step splits into label and detail; sub-bullets become its note', () => {
	const b = plan.parsePlan(PLAN, resolvers)
	assert.equal(b.nodes[0].label, 'Add a migration')
	assert.match(b.nodes[0].detail, /^add a deleted_at column/)
	assert.match(b.nodes[1].note, /keep the audit entry emit UserRemoved/)
})

test('plan-parse: files and Class.method mentions link to code when they resolve, and only then', () => {
	const b = plan.parsePlan(PLAN, resolvers)
	assert.deepEqual([b.nodes[0].file, b.nodes[0].line], ['C:\\app\\db\\migrations\\0042_users.sql', undefined])
	assert.deepEqual([b.nodes[1].file, b.nodes[1].line], ['C:\\app\\src\\UserService.cs', 31])
	assert.deepEqual([b.nodes[2].file, b.nodes[2].line], ['C:\\app\\src\\Controllers\\UsersController.cs', 48], ':48 in the plan is the line')
	assert.equal(b.nodes[3].file, undefined)
	assert.equal(plan.parsePlan(PLAN).nodes[0].file, undefined, 'without resolvers nothing is linked')
})

test('plan-parse: steps about the API, the database or tests get a node kind', () => {
	const b = plan.parsePlan(PLAN, resolvers)
	assert.equal(b.nodes[0].kind, 'repository', 'migration / table')
	assert.equal(b.nodes[2].kind, 'controller', 'endpoint')
	assert.equal(b.nodes[3].kind, 'controller', 'api words win over test words in one step')
	assert.equal(b.nodes[4].kind, 'note', 'tests')
	assert.equal(b.nodes[5].kind, 'decision')
	assert.equal(plan.stepKind('Refactor the helper'), 'step')
	assert.equal(plan.stepKind('Extract an OrderService'), 'service')
})

test('plan-parse: sections group the steps; a single section does not', () => {
	const b = plan.parsePlan(PLAN, resolvers)
	assert.deepEqual(b.groups.map(g => g.label), ['Steps', 'Verification'], 'Context introduces the plan, it is not a group')
	assert.deepEqual(b.nodes.map(n => n.group), ['g1', 'g1', 'g1', 'g1', 'g2', 'g2'])
	const one = plan.parsePlan('# T\n## Steps\n1. a\n2. b')
	assert.equal(one.groups, undefined)
})

test('plan-parse: without numbered steps, headings are the steps; then bullets', () => {
	const headings = plan.parsePlan('# Add caching\n## Context\nwhy\n## Add a cache layer\nuse Redis for UserService.Get\n## Wire it in\nin Startup.cs\n## Risks\nmaybe')
	assert.deepEqual(headings.nodes.map(n => n.label), ['Add a cache layer', 'Wire it in'])
	assert.match(headings.nodes[0].note, /use Redis/)
	assert.equal(headings.groups, undefined)
	const bullets = plan.parsePlan('Plan\n- first thing\n- second thing\n  - detail')
	assert.deepEqual(bullets.nodes.map(n => n.label), ['first thing', 'second thing'])
	assert.match(bullets.nodes[1].note, /detail/)
})

test('plan-parse: checkboxes carry their status', () => {
	const b = plan.parsePlan('- [x] done one\n- [ ] open one\n- [-] skipped one')
	assert.deepEqual(b.nodes.map(n => n.status), ['done', 'todo', 'skipped'])
})

test('plan-parse: markdown noise is stripped, code fences are not steps, long steps are cut', () => {
	const b = plan.parsePlan('1. Read [the docs](http://x) and **bold** `code`\n```\n1. not a step\n```\n2. ' + 'word '.repeat(60))
	assert.equal(b.nodes.length, 2)
	assert.equal(b.nodes[0].label, 'Read the docs and bold code')
	assert.ok(b.nodes[1].label.length <= 91)
	assert.ok(b.nodes[1].detail.length <= 200)
})

test('plan-parse: no structure at all is one step; empty input does not throw; the step cap holds', () => {
	const one = plan.parsePlan('Just do the thing carefully.')
	assert.equal(one.nodes.length, 1)
	assert.equal(one.edges.length, 0)
	assert.doesNotThrow(() => plan.parsePlan(''))
	assert.equal(plan.parsePlan('').nodes.length, 1)
	const many = plan.parsePlan(Array.from({ length: 100 }, (_, i) => `${i + 1}. step ${i}`).join('\n'))
	assert.equal(many.nodes.length, plan.MAX_STEPS)
	assert.match(many.description, /40 more steps/)
})

test('plan-parse: mentions lists the paths and symbols to look up', () => {
	const m = plan.mentions(PLAN)
	assert.ok(m.files.includes('src/Controllers/UsersController.cs'))
	assert.ok(m.files.includes('db/migrations/0042_users.sql'))
	assert.ok(m.symbols.includes('UserService.Remove'))
	assert.ok(!m.symbols.some(s => /\.cs$|\.sql$/.test(s)), 'file names are not symbols')
})

test('plan-edit: editing a file linked from a step moves that step', () => {
	const b = plan.parsePlan(PLAN, resolvers)
	const hits = plan.nodesLinkedTo(b, 'c:/app/src/Controllers/UsersController.cs', 'win32')
	assert.deepEqual(hits.map(n => n.id), ['s3'], 'drive letter case and slashes do not matter on Windows')
	assert.equal(plan.nodesLinkedTo(b, 'C:\\app\\src\\Other.cs', 'win32').length, 0)
	assert.equal(plan.statusAfterEdit('todo', 'before'), 'doing')
	assert.equal(plan.statusAfterEdit('doing', 'after'), 'done')
	assert.equal(plan.statusAfterEdit('done', 'before'), 'doing', 'editing a finished step again reopens it')
	assert.equal(plan.statusAfterEdit('skipped', 'before'), 'skipped')
	assert.equal(plan.statusAfterEdit('blocked', 'after'), 'blocked')
	assert.equal(plan.statusAfterEdit(undefined, 'after'), 'done')
})

test('plan-edit: the host applies before and then after to one edit; a blocked or skipped step keeps its status through both', () => {
	const edit = s => plan.statusAfterEdit(plan.statusAfterEdit(s, 'before'), 'after')
	assert.equal(plan.statusAfterEdit('blocked', 'before'), 'blocked')
	assert.equal(edit('blocked'), 'blocked')
	assert.equal(edit('skipped'), 'skipped')
	assert.equal(edit('todo'), 'done')
	assert.equal(edit('done'), 'done')
	assert.equal(edit(undefined), 'done')
})
