// Hands-on tour steps (src/tour/wait.ts): the `wait` of a step, the command allowlist, the `tourRun` message and running the
// command. Pure, so it is bundled with esbuild and run under plain Node, like tour-file.test.mjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT } from './helpers.mjs'

let m
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-tour-wait-'))
	const outfile = join(tmp, 'wait.mjs')
	// One bundle holds both modules, so the error classes are the same ones.
	await build({
		stdin: { contents: `export * from './wait.ts'; export * as validate from './validate.ts'`, resolveDir: join(ROOT, 'src', 'tour') },
		bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent',
	})
	m = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const STRICT = { where: 'steps[2]', strict: true }
const FILE = { where: 'steps[2]', strict: false }
const ALLOWED = () => m.WAIT_COMMANDS[0]
const refuses = (raw, pattern, ctx = STRICT) => assert.throws(() => m.parseWait(raw, ctx), e => e instanceof m.WaitError && pattern.test(e.message), String(pattern))

// ---- the allowlist -------------------------------------------------------------------------------------

test('every command on the allowlist is contributed by an extension of this repository, and the list stays short and unique', () => {
	const extensions = resolve(ROOT, '..')
	const contributed = new Set()
	for (const dir of readdirSync(extensions)) {
		try {
			const pkg = JSON.parse(readFileSync(join(extensions, dir, 'package.json'), 'utf8'))
			for (const c of pkg.contributes?.commands ?? []) {
				contributed.add(c.command)
			}
		} catch {
			// A folder without a package.json is not an extension.
		}
	}
	assert.ok(m.WAIT_COMMANDS.length >= 5 && m.WAIT_COMMANDS.length <= 12, `${m.WAIT_COMMANDS.length} commands`)
	assert.equal(new Set(m.WAIT_COMMANDS).size, m.WAIT_COMMANDS.length)
	for (const id of m.WAIT_COMMANDS) {
		assert.ok(contributed.has(id), `${id} is not in any extension's contributes.commands`)
		assert.match(id, /^(flow|flowHarness)\./)
	}
})

// ---- parseWait -----------------------------------------------------------------------------------------

test('click and continue pass through, with their prompt when there is one', () => {
	assert.deepEqual(m.parseWait({ kind: 'click' }, STRICT), { wait: { kind: 'click' } })
	assert.deepEqual(m.parseWait({ kind: 'click', prompt: 'Open the card' }, STRICT), { wait: { kind: 'click', prompt: 'Open the card' } })
	assert.deepEqual(m.parseWait({ kind: 'continue', prompt: '  Ready \n now ' }, STRICT), { wait: { kind: 'continue', prompt: 'Ready now' } })
	assert.deepEqual(m.parseWait({ kind: 'continue', prompt: '   ' }, STRICT), { wait: { kind: 'continue' } }, 'an empty prompt is no prompt')
	assert.deepEqual(m.parseWait({ kind: 'click', prompt: 'Open it' }, FILE), { wait: { kind: 'click', prompt: 'Open it' } }, 'a tour file may ask for a click')
})

test('a command wait on the allowlist keeps its command and defaults its prompt to "Run it"', () => {
	const command = ALLOWED()
	assert.deepEqual(m.parseWait({ kind: 'command', command }, STRICT), { wait: { kind: 'command', command, prompt: 'Run it' } })
	assert.deepEqual(m.parseWait({ kind: 'command', command, prompt: 'Open Home' }, STRICT), { wait: { kind: 'command', command, prompt: 'Open Home' } })
})

test('a command that is not allowed is refused with a note and the step does not wait', () => {
	const r = m.parseWait({ kind: 'command', command: 'workbench.action.terminal.new', prompt: 'Go' }, STRICT)
	assert.equal(r.wait, undefined)
	assert.match(r.note, /^steps\[2\]\.wait: command "workbench\.action\.terminal\.new" is not allowed in a tour, so the step does not wait \(allowed: flow\.home, /)
	for (const id of m.WAIT_COMMANDS) {
		assert.ok(r.note.includes(id))
	}
})

test('a tour file never keeps a command wait, even an allowed one, and says so', () => {
	const r = m.parseWait({ kind: 'command', command: ALLOWED(), prompt: 'Go' }, FILE)
	assert.equal(r.wait, undefined)
	assert.match(r.note, /steps\[2\]\.wait: .*cannot run commands/)
})

test('a tool call that gets a wait wrong hears which field; a file just loses the wait', () => {
	refuses('click', /steps\[2\]\.wait must be an object/)
	refuses(['click'], /steps\[2\]\.wait must be an object/)
	refuses({ kind: 'wait' }, /steps\[2\]\.wait\.kind must be one of: click, command, continue/)
	refuses({}, /steps\[2\]\.wait\.kind/)
	refuses({ kind: 'continue', extra: 1 }, /steps\[2\]\.wait\.extra is not a field/)
	refuses({ kind: 'click', command: ALLOWED() }, /steps\[2\]\.wait\.command is not a field of a click wait/)
	refuses({ kind: 'command', prompt: 'Go' }, /steps\[2\]\.wait\.command is required/)
	refuses({ kind: 'command', command: 5 }, /steps\[2\]\.wait\.command is required/)
	refuses({ kind: 'command', command: 'x'.repeat(101) }, /steps\[2\]\.wait\.command is 101 characters/)
	refuses({ kind: 'click', prompt: 7 }, /steps\[2\]\.wait\.prompt must be text/)
	for (const raw of ['click', { kind: 'wait' }, { kind: 'continue', extra: 1 }, { kind: 'click', prompt: 7 }]) {
		assert.deepEqual(m.parseWait(raw, FILE), {}, JSON.stringify(raw))
	}
})

test('the prompt is plain text of at most 80 characters: a tool call is told, a file is cut', () => {
	const long = 'a'.repeat(81)
	refuses({ kind: 'continue', prompt: long }, /steps\[2\]\.wait\.prompt is 81 characters long; at most 80/)
	assert.equal(m.parseWait({ kind: 'continue', prompt: 'a'.repeat(80) }, STRICT).wait.prompt.length, 80)
	assert.equal(m.parseWait({ kind: 'continue', prompt: long }, FILE).wait.prompt.length, 80)
	assert.equal(m.parseWait({ kind: 'continue', prompt: 'one\u0000\ttwo\u2028three' }, STRICT).wait.prompt, 'one two three')
})

test('through the tour tool: the step carries its wait, and a refused command shows in the notes', () => {
	const work = resolve(tmpdir(), 'insilode-wait-work')
	const host = { roots: [work], readText: () => undefined }
	const { tour, notes } = m.validate.parseTourArgs({
		title: 'Hands on',
		steps: [
			{ caption: 'Click it', wait: { kind: 'click' } },
			{ caption: 'Open home', wait: { kind: 'command', command: ALLOWED(), prompt: 'Open Home' } },
			{ caption: 'Terminal', wait: { kind: 'command', command: 'workbench.action.terminal.new' } },
			{ caption: 'No wait' },
		],
	}, host, 'Agent tour')
	assert.deepEqual(tour.steps.map(s => s.wait?.kind), ['click', 'command', undefined, undefined])
	assert.equal(tour.steps[1].wait.command, ALLOWED())
	assert.equal(notes[0], undefined)
	assert.match(notes[2], /steps\[2\]\.wait: command "workbench\.action\.terminal\.new" is not allowed in a tour/)
	assert.throws(() => m.validate.parseTourArgs({ title: 'T', steps: [{ caption: 'x', wait: { kind: 'nope' } }] }, host, 'Agent'), /steps\[0\]\.wait\.kind must be one of/)
})

test('through a tour file: a command wait is dropped, a click wait stays', () => {
	const host = { roots: [resolve(tmpdir(), 'insilode-wait-work')], readText: () => undefined }
	const { tour, notes } = m.validate.parseTourFile({
		insilodeTour: 1, id: 't', title: 'T',
		steps: [{ caption: 'a', wait: { kind: 'click' } }, { caption: 'b', wait: { kind: 'command', command: ALLOWED() } }],
	}, host)
	assert.deepEqual(tour.steps.map(s => s.wait?.kind), ['click', undefined])
	assert.match(notes[1], /cannot run commands/)
})

// ---- parseTourRun --------------------------------------------------------------------------------------

const step = (wait) => ({ title: 's', caption: 'c', state: 'ok', ...(wait ? { wait } : {}) })
const playing = () => ({ id: 'tour1', tour: { steps: [step({ kind: 'click' }), step({ kind: 'command', command: ALLOWED(), prompt: 'Go' }), step()] } })

test('tourRun is accepted only for the playing tour and a command step inside it', () => {
	assert.equal(m.parseTourRun(playing(), { type: 'tourRun', id: 'tour1', index: 1 }), 1)
	assert.equal(m.parseTourRun(playing(), { type: 'tourRun', id: 'other', index: 1 }), undefined, 'a made-up id')
	assert.equal(m.parseTourRun(playing(), { type: 'tourRun', id: 'tour1', index: 0 }), undefined, 'a click step')
	assert.equal(m.parseTourRun(playing(), { type: 'tourRun', id: 'tour1', index: 2 }), undefined, 'a step without a wait')
	for (const index of [-1, 3, 1.5, '1', null, undefined, NaN]) {
		assert.equal(m.parseTourRun(playing(), { type: 'tourRun', id: 'tour1', index }), undefined, String(index))
	}
	assert.equal(m.parseTourRun(undefined, { type: 'tourRun', id: 'tour1', index: 1 }), undefined, 'nothing is playing')
	assert.equal(m.parseTourRun(playing(), { type: 'tourState', id: 'tour1', index: 1 }), undefined, 'another message')
	assert.equal(m.parseTourRun(playing(), null), undefined)
	assert.equal(m.parseTourRun(playing(), 'tourRun'), undefined)
})

// ---- runWait -------------------------------------------------------------------------------------------

test('runWait runs the step\'s own command: the id comes from the step', async () => {
	const ran = []
	const done = await m.runWait(step({ kind: 'command', command: ALLOWED(), prompt: 'Go' }), async command => { ran.push(command) })
	assert.deepEqual(done, { ok: true })
	assert.deepEqual(ran, [ALLOWED()])
	assert.deepEqual(await m.runWait(step({ kind: 'command', command: ALLOWED(), prompt: 'Go' }), () => 5), { ok: true }, 'a plain return is an answer too')
})

test('runWait refuses a command that is not on the list and a step that has none, without calling execute', async () => {
	let calls = 0
	const execute = async () => { calls++ }
	assert.deepEqual(await m.runWait(step({ kind: 'command', command: 'workbench.action.terminal.new', prompt: 'Go' }), execute), { ok: false, reason: 'That command is not allowed in a tour.' })
	assert.equal((await m.runWait(step({ kind: 'click' }), execute)).ok, false)
	assert.equal((await m.runWait(step(), execute)).ok, false)
	assert.equal((await m.runWait(undefined, execute)).ok, false)
	assert.equal(calls, 0)
})

test('runWait reports a command that throws, rejects or hangs, and never throws itself', async () => {
	const wait = step({ kind: 'command', command: ALLOWED(), prompt: 'Go' })
	assert.deepEqual(await m.runWait(wait, async () => { throw new Error('no such view') }), { ok: false, reason: 'The command failed: no such view' })
	assert.deepEqual(await m.runWait(wait, () => { throw new Error('sync boom') }), { ok: false, reason: 'The command failed: sync boom' })
	assert.deepEqual(await m.runWait(wait, () => Promise.reject('plain text')), { ok: false, reason: 'The command failed: plain text' })
	const long = await m.runWait(wait, async () => { throw new Error('x'.repeat(500)) })
	assert.equal(long.reason, `The command failed: ${'x'.repeat(200)}`)
	const hang = await m.runWait(wait, () => new Promise(() => undefined), 20)
	assert.deepEqual(hang, { ok: false, reason: 'The command did not answer in time.' })
})
