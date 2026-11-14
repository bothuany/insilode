// The decisions sessionType.ts (the native chat) takes about the permission mode, kept in src/chatCore.ts so they run without
// `vscode`: which mode the adapter is put in, when the chip follows the agent's own change, and that the folder rule of
// `autoAnswer` still holds for the mode the chip ends up in.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let c
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-sessiontype-'))
	const outfile = join(tmp, 'chatCore.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'chatCore.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	c = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

// What sessionType.ts keeps per session, driven by the same two steps: a prompt (applyInput) and an adapter report (followAgentMode).
function session(picked) {
	const s = { approval: picked, applied: undefined, sets: [], current: 'default' }
	s.prompt = pick => {
		if (pick) { s.approval = pick }
		const want = c.adapterMode(s.approval)
		s.applied = want
		if (s.current !== want) { s.sets.push(want); s.current = want }
	}
	// An elevated mode the adapter moved itself to is put back to default first; it is adopted only when the user's own answer asked for it (`granted`), bypass after a yes to the warning.
	s.report = (mode, confirmBypass = true, granted) => {
		const next = c.modeAfterAdapter(mode, s.applied, s.approval, granted)
		const moved = !!mode && s.applied !== undefined
		if (moved) { s.applied = mode }
		s.current = mode
		if (moved && c.isElevated(mode)) { s.applied = 'default'; s.current = 'default'; s.sets.push('default') }
		const adopted = next === 'bypassPermissions' && !confirmBypass ? 'default' : next
		if (adopted) { s.approval = adopted }
	}
	return s
}

test('the adapter itself only ever runs in plan or default', () => {
	assert.equal(c.adapterMode('plan'), 'plan')
	for (const m of ['default', 'acceptEdits', 'auto', 'bypassPermissions', undefined]) { assert.equal(c.adapterMode(m), 'default') }
})

test('the chip follows the agent out of plan mode, and the next prompt does not put plan back', () => {
	const s = session('plan')
	s.prompt()
	assert.deepEqual(s.sets, ['plan'])
	s.report('default')
	assert.equal(s.approval, 'default')
	s.prompt()
	assert.deepEqual(s.sets, ['plan'], 'the adapter is already in default: nothing is set again')
	assert.equal(s.current, 'default')
})

test('the chip follows the agent into plan mode too', () => {
	const s = session('default')
	s.prompt()
	s.report('plan')
	assert.equal(s.approval, 'plan')
})

test('the echo of Insilode\'s own change is not the agent\'s', () => {
	assert.equal(c.modeAfterAdapter('plan', 'plan', 'plan'), undefined)
	assert.equal(c.modeAfterAdapter('default', 'default', 'bypassPermissions'), undefined, 'the user\'s elevated mode survives the adapter reporting default')
	assert.equal(c.modeAfterAdapter('default', undefined, 'plan'), undefined, 'before any prompt there is nothing to follow')
	assert.equal(c.modeAfterAdapter(undefined, 'plan', 'plan'), undefined)
})

test('a pick in the chip wins from then on', () => {
	const s = session('plan')
	s.prompt()
	s.report('default')
	s.prompt('plan')
	assert.deepEqual(s.sets, ['plan', 'plan'], 'the agent had moved to default by itself, so only the pick is set')
	s.report('plan')
	assert.equal(s.approval, 'plan', 'the report of the mode the user just picked changes nothing')
	s.prompt()
	assert.equal(s.approval, 'plan')
})

test('an elevated mode is adopted only when the user\'s own gated answer asked for it, and is taken out of the adapter at once', () => {
	for (const m of ['acceptEdits', 'auto', 'bypassPermissions']) {
		assert.equal(c.modeAfterAdapter(m, 'plan', 'plan', m), m)
		assert.equal(c.modeAfterAdapter(m, 'plan', 'plan'), 'default', 'unsolicited: the chat goes to default')
		assert.equal(c.modeAfterAdapter(m, 'plan', 'plan', 'auto' === m ? 'acceptEdits' : 'auto'), 'default', 'another mode than the one granted')
		assert.equal(c.modeAfterAdapter(m, 'default', 'acceptEdits'), 'default', 'not only out of plan: any elevated report nobody asked for')
		const s = session('plan')
		s.prompt()
		s.report(m, true, m)
		assert.equal(s.approval, m)
		assert.equal(s.current, 'default', m + ': the adapter itself is back in default')
		assert.deepEqual(s.sets, ['plan', 'default'])
		s.report('default')
		assert.equal(s.approval, m, 'the echo of the reset changes nothing')
		s.prompt()
		assert.deepEqual(s.sets, ['plan', 'default'])
	}
	assert.equal(c.modeAfterAdapter('dontAsk', 'plan', 'plan', 'dontAsk'), undefined, 'a mode that is not elevated and not plan or default is left alone')
})

test('bypass granted by the user\'s answer still needs a yes to the warning; a no leaves the chat in default, the adapter too', () => {
	const s = session('plan')
	s.prompt()
	s.report('bypassPermissions', false, 'bypassPermissions')
	assert.equal(s.approval, 'default')
	assert.equal(s.current, 'default')
})

test('an elevated report nobody asked for resets the adapter and leaves the chat in default', () => {
	const s = session('bypassPermissions')
	s.prompt()
	s.sets.length = 0
	s.report('bypassPermissions')
	assert.equal(s.approval, 'default')
	assert.deepEqual(s.sets, ['default'])
	assert.equal(s.current, 'default')
})

test('a change event only counts as a pick for the picker whose own mode moved', () => {
	assert.equal(c.pickedMode('plan', 'default'), 'plan')
	assert.equal(c.pickedMode('default', 'default'), undefined)
	assert.equal(c.pickedMode('plan', undefined), 'plan', 'a picker never seen is taken as it shows')
	assert.equal(c.pickedMode(undefined, 'plan'), undefined)
	// Two sessions: A's agent leaves plan and writes A's picker; the change reaches B's picker too and must not touch B.
	const a = { approval: 'plan', seen: 'plan' }
	const b = { approval: 'plan', seen: 'plan' }
	const changed = (x, shown) => { const pick = c.pickedMode(shown, x.seen); x.seen = shown; if (pick) { x.approval = pick } }
	a.approval = 'default'; a.seen = 'default'
	changed(a, 'default')
	changed(b, 'plan')
	assert.deepEqual([a.approval, b.approval], ['default', 'plan'])
	// A real pick in B's chip still works.
	changed(b, 'acceptEdits')
	assert.equal(b.approval, 'acceptEdits')
})

test('the mode warning names the folder and says what is given up, with control characters shown as ?', () => {
	const w = c.modeWarning('Bypass Permissions', 'bypassPermissions', '/x/a\nb')
	assert.equal(w.message, 'Switch this chat to Bypass Permissions?')
	assert.match(w.detail, /^Folder: \/x\/a\?b\n\nThe agent will edit files and run commands without asking you\.$/)
	assert.match(c.modeWarning('Accept Edits', 'acceptEdits', '/x').detail, /commands and anything else still ask/)
})

test('the folder rule of autoAnswer still holds in the mode the chip ends up in', () => {
	const options = [{ optionId: 'allow', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' }]
	const cwd = join(tmp, 'work')
	const where = { cwd, files: [join(tmp, 'elsewhere', 'a.ts')] }
	const s = session('acceptEdits')
	s.sets.length = 0
	s.prompt()
	s.sets.length = 0
	s.report('acceptEdits', true, 'acceptEdits')
	assert.equal(s.approval, 'acceptEdits')
	assert.deepEqual(s.sets, ['default'], 'the adapter was reset all the same')
	assert.equal(c.autoAnswer(s.approval, 'edit', options, where), undefined, 'an edit outside the folder is still asked')
	assert.equal(c.autoAnswer(s.approval, 'edit', options, { cwd, files: [join(cwd, 'a.ts')] })?.optionId, 'allow')
	const planned = session('plan')
	planned.prompt()
	planned.report('default')
	assert.equal(c.autoAnswer(planned.approval, 'edit', options, { cwd, files: [join(cwd, 'a.ts')] }), undefined, 'default asks for every edit')
})

test('gateAnswer: the one decision both chats take about an answer that elevates', () => {
	const edit = [{ optionId: 'allow-with-updates', name: 'all', kind: 'allow_always' }, { optionId: 'allow-once', name: 'once', kind: 'allow_once' }]
	const plan = [{ optionId: 'exit-plan-bypass', name: 'b', kind: 'allow_always' }, { optionId: 'exit-plan-auto', name: 'a', kind: 'allow_always' }, { optionId: 'exit-plan-default', name: 'd', kind: 'allow_once' }, { optionId: 'plan', name: 'n', kind: 'reject_once' }]
	const none = new Set()
	let g = c.gateAnswer(edit[0], edit, { edit: true, own: true, confirmed: none })
	assert.deepEqual([g.mode, g.confirm, g.send?.optionId, g.viaAdapter], ['acceptEdits', false, 'allow-once', false])
	assert.equal(c.gateAnswer(edit[0], edit, { edit: true, own: false, confirmed: none }).confirm, true, 'foreign folder')
	assert.equal(c.gateAnswer(edit[0], edit, { edit: false, own: true, confirmed: none }).send, edit[0], 'on a command it only adds rules: forwarded as picked')
	g = c.gateAnswer(plan[0], plan, { edit: false, own: true, confirmed: none })
	assert.deepEqual([g.mode, g.confirm, g.send.optionId, g.decline.optionId, g.declineMode, g.viaAdapter], ['bypassPermissions', true, 'exit-plan-bypass', 'exit-plan-default', 'default', true])
	assert.equal(c.gateAnswer(plan[0], plan, { edit: false, own: true, confirmed: new Set(['bypassPermissions']) }).confirm, false)
	assert.equal(c.gateAnswer(plan[1], plan, { edit: false, own: true, confirmed: none }).confirm, false, 'auto in the own folder')
	assert.equal(c.gateAnswer(plan[1], plan, { edit: false, own: false, confirmed: none }).confirm, true)
	assert.equal(c.gateAnswer(plan[2], plan, { edit: false, own: true, confirmed: none }).mode, undefined)
	assert.deepEqual(c.settleGate(g, false), { option: plan[2], mode: 'default', viaAdapter: false })
	assert.equal(c.settleGate(c.gateAnswer(plan[0], plan.slice(0, 2), { edit: false, own: true, confirmed: none }), false).mode, undefined, 'no plain approval: keep planning, stay in plan')
})
