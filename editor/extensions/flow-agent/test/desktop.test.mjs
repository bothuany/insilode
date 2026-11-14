// What the app badge and the desktop status overlay show (src/desktopModel.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let d
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-desktop-'))
	const outfile = join(tmp, 'desktopModel.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'desktopModel.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	d = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const settings = (values = {}) => d.readSettings(key => values[key])
const agent = (id, o = {}) => ({ id, name: id, cli: 'claude', state: 'working', unread: false, since: 1, ...o })

test('settings: defaults are the badge on and the overlay off', () => {
	const s = settings()
	assert.equal(s.badge, true)
	assert.equal(s.overlay, false)
	assert.equal(s.position, 'top-center')
	assert.equal(s.display, 'insilode')
	assert.equal(s.style, 'pill')
	assert.equal(s.theme, 'black')
	assert.equal(s.opacity, 0.95)
	assert.equal(s.details, false)
	assert.deepEqual(s.show, d.DEFAULT_SHOW)
	assert.deepEqual(s.autoHide, { noAgents: true, insilodeFocused: true })
})

test('settings: an object-valued setting counts as written per key across scopes', () => {
	assert.deepEqual(d.writtenValue(undefined), undefined)
	assert.deepEqual(d.writtenValue({ globalValue: false, workspaceValue: true }), true, 'the narrower scope wins for a plain value')
	assert.deepEqual(d.writtenValue({ globalValue: false }), false)
	const merged = d.writtenValue({ globalValue: { insilodeFocused: true }, workspaceValue: { noAgents: false } })
	assert.deepEqual(merged, { insilodeFocused: true, noAgents: false })
	const set = key => key === 'overlay.autoHide' ? merged : undefined
	assert.deepEqual(d.readSettings(() => undefined, set).unset, { enabled: true, focused: false })
	assert.deepEqual(d.writtenValue({ globalValue: { noAgents: true, insilodeFocused: false }, workspaceFolderValue: { noAgents: false } }), { noAgents: false, insilodeFocused: false })
})

test('settings: the island is wanted when on, or when unset on a Mac; an explicit false never is', () => {
	const wanted = (values, platform) => d.overlayWanted(d.readSettings(key => values[key], key => values[key]), platform)
	assert.equal(wanted({}, 'darwin'), true, 'unset on a Mac: core decides by the notch')
	assert.equal(wanted({}, 'win32'), false)
	assert.equal(wanted({}, 'linux'), false)
	assert.equal(wanted({ 'overlay.enabled': false }, 'darwin'), false, 'explicit false, even with a notch')
	assert.equal(wanted({ 'overlay.enabled': true }, 'darwin'), true)
	assert.equal(wanted({ 'overlay.enabled': true }, 'win32'), true, 'explicit true, no notch')
})

test('settings: badge and overlay switch on and off independently', () => {
	for (const badge of [true, false]) {
		for (const overlay of [true, false]) {
			const s = settings({ badge, 'overlay.enabled': overlay })
			assert.deepEqual([s.badge, s.overlay], [badge, overlay])
		}
	}
})

test('settings: malformed values fall back, opacity is clamped, partial objects merge with the defaults', () => {
	const s = settings({ badge: 'yes', 'overlay.position': 'middle', 'overlay.style': 'list', 'overlay.opacity': 0.05, 'overlay.show': { idle: true, cost: 'no', elapsed: false }, 'overlay.autoHide': { insilodeFocused: true } })
	assert.equal(s.badge, true)
	assert.equal(s.position, 'top-center')
	assert.equal(s.style, 'list')
	assert.equal(s.opacity, 0.3)
	assert.equal(s.show.idle, true)
	assert.equal(s.show.cost, false)
	assert.equal(s.show.elapsed, false)
	assert.equal(s.show.working, true)
	assert.deepEqual(s.autoHide, { noAgents: true, insilodeFocused: true })
	assert.equal(settings({ 'overlay.opacity': 7 }).opacity, 1)
	assert.equal(settings({ 'overlay.opacity': Number.NaN }).opacity, 0.95)
})

test('badge count: approvals, questions, unread errors and unread finished turns, like the dock', () => {
	const sessions = [
		agent('working'),
		agent('blocked', { state: 'blocked' }),
		agent('asks', { state: 'done', need: { kind: 'question', source: 'reply', text: 'Which one?', at: 2 } }),
		agent('error-read', { state: 'idle', need: { kind: 'error', source: 'stop', text: 'API error', at: 2 } }),
		agent('error-unread', { state: 'idle', unread: true, need: { kind: 'error', source: 'stop', text: 'API error', at: 2 } }),
		agent('done-unread', { state: 'done', unread: true }),
		agent('done-read', { state: 'done' }),
		agent('idle', { state: 'idle' }),
	]
	assert.equal(d.needsYouCount(sessions), 4)
	assert.equal(d.needsYouCount([]), 0)
})

test('activity: only the verb unless details are on', () => {
	assert.equal(d.overlayActivity('Running npm test -- --secret', false), 'Running')
	assert.equal(d.overlayActivity('Editing payroll.ts', false), 'Editing')
	assert.equal(d.overlayActivity('Searching the web insilode notch', false), 'Searching the web')
	assert.equal(d.overlayActivity('Thinking', false), 'Thinking')
	assert.equal(d.overlayActivity('Wants to: Running rm -rf build', false), 'Wants approval')
	// A question, an MCP tool line or a message can quote anything: dropped.
	assert.equal(d.overlayActivity('Should I delete customers.csv?', false), undefined)
	assert.equal(d.overlayActivity('github create_issue', false), undefined)
	assert.equal(d.overlayActivity('Runningman.sh', false), undefined)
	assert.equal(d.overlayActivity(undefined, false), undefined)
	assert.equal(d.overlayActivity('Running npm test\nsecond line', true), 'Running npm test')
	assert.equal(d.overlayActivity('x'.repeat(200), true).length, 80)
})

test('overlay model: ranked like the dock, ended sessions never, states filtered by the show setting', () => {
	const sessions = [
		agent('idle', { state: 'idle' }),
		agent('working', { since: 5, activity: 'Editing secret-plan.md' }),
		agent('ended', { state: 'ended', unread: true }),
		agent('blocked', { state: 'blocked', activity: 'Wants to: Running deploy.sh' }),
		agent('done', { state: 'done', unread: true }),
	]
	const m = d.overlayModel(sessions, settings())
	assert.deepEqual(m.items.map(i => [i.id, i.state, i.attention]), [['blocked', 'needs', 'approval'], ['done', 'done', 'done'], ['working', 'working', undefined]])
	assert.deepEqual(m.items.map(i => i.activity), ['Wants approval', undefined, 'Editing'])
	assert.deepEqual(m.counts, { needs: 1, working: 1, done: 1 })
	assert.ok(!JSON.stringify(m).includes('secret'), 'no file names without details')

	const all = d.overlayModel(sessions, settings({ 'overlay.show': { idle: true, working: false, counts: false, activity: false } }))
	assert.deepEqual(all.items.map(i => i.id), ['blocked', 'done', 'idle'])
	assert.equal(all.counts, undefined)
	assert.ok(all.items.every(i => i.activity === undefined))

	const detailed = d.overlayModel(sessions, settings({ 'overlay.details': true }))
	assert.equal(detailed.items.find(i => i.id === 'working').activity, 'Editing secret-plan.md')
})

test('overlay model: prompts never travel, cost only when asked for, context and elapsed time by default', () => {
	const s = agent('a', { prompt: 'refactor the payroll module', usage: { used: 50_000, size: 200_000 }, cost: { session: { usd: 1.25, tokens: {} } } })
	const plain = d.overlayModel([s], settings())
	assert.ok(!JSON.stringify(plain).includes('payroll'))
	assert.equal(plain.items[0].context, 25)
	assert.equal(plain.items[0].since, 1)
	assert.equal(plain.items[0].usd, undefined)
	assert.equal(d.overlayModel([s], settings({ 'overlay.show': { context: false, elapsed: false } })).items[0].context, undefined)
	assert.equal(d.overlayModel([s], settings({ 'overlay.show': { elapsed: false } })).items[0].since, undefined)
	const more = d.overlayModel([s, agent('b', { usage: { used: 10, percent: 140 } })], settings({ 'overlay.show': { cost: true } }))
	assert.equal(more.items[0].context, 25)
	assert.equal(more.items[0].usd, 1.25)
	assert.equal(more.items[1].context, 100)
	assert.equal(more.items[1].usd, undefined)
})

test('settings: what the user never wrote is unset, so core can settle it by the screen', () => {
	const written = values => key => values[key]
	// Nothing written: both are left to core. Without a `set` reader (the site) nothing is.
	assert.deepEqual(d.readSettings(() => undefined, written({})).unset, { enabled: true, focused: true })
	assert.deepEqual(settings().unset, { enabled: false, focused: false })
	// A written value, true or false, is a choice; so is a written autoHide.insilodeFocused, but not a written noAgents alone.
	assert.deepEqual(d.readSettings(() => undefined, written({ 'overlay.enabled': false })).unset, { enabled: false, focused: true })
	assert.deepEqual(d.readSettings(() => undefined, written({ 'overlay.autoHide': { noAgents: false } })).unset, { enabled: true, focused: true })
	assert.deepEqual(d.readSettings(() => undefined, written({ 'overlay.enabled': true, 'overlay.autoHide': { insilodeFocused: true } })).unset, { enabled: false, focused: false })
	assert.deepEqual(d.overlayOptions(d.readSettings(() => undefined, written({}))).unset, { enabled: true, focused: true })
})

test('overlay options carry only where and how to draw', () => {
	assert.deepEqual(Object.keys(d.overlayOptions(settings())).sort(), ['autoHide', 'avatar', 'display', 'opacity', 'position', 'size', 'style', 'theme', 'unset'])
	assert.equal(d.overlayOptions(settings(), 'pixel').avatar, 'pixel')
	assert.equal(d.readAvatar('pixel'), 'pixel')
	assert.equal(d.readAvatar('robot'), 'gyro')
	assert.equal(d.readAvatar(undefined), 'gyro')
})
