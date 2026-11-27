// The Agents window on its own (plan docs/plans/agents-standalone.md, cards RC01-RC05): the editor window is hidden, not closed, while the
// Agents window is open; the Agents window asks before it closes when that would end agents; the hidden window comes back when it is needed
// and only then; quick open, toasts and dialogs follow the Agents window; `--agents-only` never shows an editor window.
//   npm run docker:e2e -- --probe test/e2e-desktop/probes/agents-alone.mjs --out <dir>
// One step per example row it can drive, each named `agents-standalone/RCnn <row>`; the results go to <out>/agents-alone-results.json. Not driven
// here: the macOS rows that need macOS (no macOS runner; the Dock click is driven by emitting Electron's `activate` event, which the code listens
// for on every platform), more than one editor window beyond the RC01 row and the restored-windows row, and the Windows hide itself.
// Written from the code, not run on this machine (nothing opens a window here): the first Docker run may need selectors adjusted.
//
// What stands in for the real thing:
//  - a fake `claude` on PATH that ticks once a second, so an agent is a live session without a login; every run has its own, with its own tick
//    log, so one run's agents never count in another's;
//  - the main process's `dialog.showMessageBox` (the confirmation, the save question, the crash and "not responding" dialogs are native boxes
//    Playwright cannot click): it records the parent window and answers by button label (a queue of answers, then a default), so "over the
//    Agents window" is the recorded parent window id;
//  - a main-process recorder of every window's `show` event and of the editor windows' visibility every 100 ms. It starts when Playwright
//    attaches, not at the first instruction of the process: the first moments of a start are not covered.
// The focus rows depend on which window the OS says has the focus: every such step records `document.hasFocus()` of both pages and the windows
// Electron says are focused, so a failure can be told apart as the environment (no window manager under xvfb) or the code.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { shot, runCommand, dismissWelcome, tabTitles, until, sleep } from '/work/insilode/test/e2e-desktop/lib/probe.mjs'
import { launchInsilode } from '/work/insilode/test/e2e-desktop/lib/app.mjs'
import { sourceElectron } from '/work/insilode/test/e2e-desktop/run.mjs'

const out = process.env.INSILODE_E2E_OUT ?? '/out'
const source = process.env.INSILODE_E2E_SOURCE
if (!source) {
	throw new Error('INSILODE_E2E_SOURCE is not set: run this script with `npm run docker:e2e -- --probe <file>`.')
}
mkdirSync(join(out, 'shots'), { recursive: true })

const results = { steps: [] }
// The names are written out in full at each call (`agents-standalone/RCnn <row>`), so a search for a card's name finds the step.
const step = (name, pass, evidence) => {
	results.steps.push({ name, pass: !!pass, evidence })
	console.log(`${pass ? 'PASS' : 'FAIL'} ${name}: ${evidence}`)
}
/** Runs a part of the probe; an exception is a failed step named after it, and the probe goes on with the next part. */
const part = async (name, fn) => {
	try {
		await fn()
	} catch (e) {
		step(name, false, String(e.stack ?? e).split('\n').slice(0, 3).join(' | '))
	}
}

// A fake `claude` (a real one needs a login) per run: ticks once a second into the terminal and into that run's own log.
const basePath = process.env.PATH
let fake
function useFake() {
	const bin = realpathSync(mkdtempSync(join(tmpdir(), 'fake-claude-')))
	const log = join(bin, 'ticks.log')
	writeFileSync(join(bin, 'claude'), `#!/bin/sh\ni=0\nwhile :; do echo "agent tick $i"; echo "$(date +%s) $i" >> ${log}; i=$((i+1)); sleep 1; done\n`)
	chmodSync(join(bin, 'claude'), 0o755)
	process.env.PATH = `${bin}:${basePath}` // the app started next inherits it
	fake = {
		ticks: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0,
		alive: () => { try { execFileSync('pgrep', ['-f', join(bin, 'claude')]); return true } catch { return false } },
	}
}
/** Ticks in the next `ms`: one per second per live agent. */
const ticksIn = async ms => { const before = fake.ticks(); await sleep(ms); return fake.ticks() - before }
/** Waits until `n` agents tick (about n per second), or throws: the rows that need live agents must not run without them. */
const needAgents = async n => { await until(`${n} agent(s) ticking`, async () => (await ticksIn(3000)) >= n * 2, { ms: 40000 }) }

// An extension that shows a toast on demand (a notification the user did not cause).
const toastExtension = join(realpathSync(mkdtempSync(join(tmpdir(), 'probe-toast-'))), 'ext')
mkdirSync(toastExtension)
writeFileSync(join(toastExtension, 'package.json'), JSON.stringify({ name: 'probe-toast', version: '0.0.1', publisher: 'probe', engines: { vscode: '^1.90.0' }, main: './extension.js', activationEvents: ['onStartupFinished'], contributes: { commands: [{ command: 'probe.toast', title: 'Probe: Toast' }] } }))
writeFileSync(join(toastExtension, 'extension.js'), "const vscode = require('vscode')\nexports.activate = c => c.subscriptions.push(vscode.commands.registerCommand('probe.toast', () => vscode.window.showInformationMessage('probe toast')))\n")

const ENV = { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }
const newFolder = label => {
	const folder = join(realpathSync(mkdtempSync(join(tmpdir(), `insilode-alone-${label}-`))), 'project')
	mkdirSync(folder)
	writeFileSync(join(folder, 'hello.txt'), 'hello from the probe\n')
	return folder
}

/**
 * Starts Insilode (with its own fake agents) and puts the main-process recorder in. `maximized`: the folder's window state is maximized.
 * `restore: n`: n folders are seeded as the last session's windows and restored (no folder is given on the command line).
 */
async function start(label, { args = [], settings, maximized, restore = 0 } = {}) {
	useFake()
	const folders = Array.from({ length: Math.max(1, restore) }, (_, i) => newFolder(`${label}${i}`))
	const folder = folders[0]
	const uiState = { mode: maximized ? 0 : 1, x: 0, y: 0, width: 1280, height: 800 }
	const windowsState = { openedWindows: folders.map(f => ({ folder: pathToFileURL(f).toString(), uiState })) }
	if (restore) {
		windowsState.lastActiveWindow = windowsState.openedWindows[0]
	}
	const files = maximized || restore ? { 'User/globalStorage/storage.json': { windowsState } } : undefined
	const app = await launchInsilode({ exe: sourceElectron(source), args: ['.', ...args], cwd: source, out, folder: restore ? undefined : folder, settings: restore ? { 'window.restoreWindows': 'all', ...settings } : settings, files, env: ENV, extensions: [toastExtension] })
	await app.main(({ app: electron, BrowserWindow, dialog }) => {
		const aa = globalThis.__aa = { samples: [], shows: [], dialogs: [], answer: '^Cancel', queue: [] }
		const ide = w => !w.isDestroyed() && /^vscode-file:/.test(w.webContents.getURL())
		const watch = w => w.on('show', () => aa.shows.push({ id: w.id, at: Date.now() }))
		// Every maximize() call: without a window manager (xvfb) `isMaximized()` never turns true, the call is what shows the state was applied.
		aa.maximizes = []
		const maximize = BrowserWindow.prototype.maximize
		BrowserWindow.prototype.maximize = function () { aa.maximizes.push({ id: this.id, at: Date.now() }); return maximize.apply(this, arguments) }
		BrowserWindow.getAllWindows().forEach(watch)
		electron.on('browser-window-created', (_event, w) => watch(w))
		setInterval(() => aa.samples.push(BrowserWindow.getAllWindows().filter(ide).map(w => w.isVisible())), 100)
		// The native boxes: record who asked and over which window, and answer by the label of a button (the next queued answer, else the default).
		dialog.showMessageBox = async (a, b) => {
			const parent = b ? a : undefined
			const options = b ?? a
			const live = parent && !parent.isDestroyed()
			aa.dialogs.push({ parent: live ? parent.id : null, parentVisible: live ? parent.isVisible() : null, parentMaximized: live ? parent.isMaximized() : null, message: options.message, buttons: options.buttons, ideVisible: BrowserWindow.getAllWindows().filter(ide).map(w => w.isVisible()) })
			const regex = aa.queue.length ? aa.queue.shift() : aa.answer
			const i = (options.buttons ?? []).findIndex(label => new RegExp(regex, 'i').test(label.replace(/&/g, '')))
			return { response: i >= 0 ? i : (options.cancelId ?? 0), checkboxChecked: false }
		}
	})
	return { app, folder, folders }
}

/** The default answer to a native box, and (`next`) answers for the next boxes in order. */
const answer = (app, regex, next = []) => app.main((_, a) => { globalThis.__aa.answer = a.regex; globalThis.__aa.queue = a.next }, { regex, next })
const recorded = app => app.main(() => ({ samples: globalThis.__aa.samples, shows: globalThis.__aa.shows, dialogs: globalThis.__aa.dialogs, maximizes: globalThis.__aa.maximizes }))
const windows = app => app.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => {
	const url = w.webContents.getURL()
	return { id: w.id, ide: /^vscode-file:/.test(url), overlay: url.startsWith('data:'), visible: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized(), maximized: w.isMaximized() }
}))
const ideWindows = async app => (await windows(app)).filter(w => w.ide)
const agentsWindow = async app => (await windows(app)).find(w => !w.ide && !w.overlay)
const closeWindow = (app, id) => app.main(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), id)
const gone = (app, ms = 25000) => until('the app to quit', async () => { try { await app.main(() => 1); return false } catch { return true } }, { ms }).then(() => true, () => false)
/** The question the app asks next, read as soon as it is recorded (before a Close answer ends the app). */
const awaitAsk = async (app, since, ms = 15000) => {
	const end = Date.now() + ms
	while (Date.now() < end) {
		try {
			const d = (await recorded(app)).dialogs
			if (d.length > since) { return d[since] }
		} catch { /* the app is going */ }
		await sleep(100)
	}
	return undefined
}
const asked = async app => (await recorded(app)).dialogs.length

const pageFrame = async win => {
	for (const f of win.frames()) {
		try { if (await f.locator('nav.side').count()) { return f } } catch { /* navigating */ }
	}
	return undefined
}
const agentsPages = async app => {
	const found = []
	for (const p of app.pages().filter(p => !p.url().startsWith('data:') && !p.url().startsWith('vscode-file:'))) {
		if (await pageFrame(p)) { found.push(p) }
	}
	return found
}
const agentsPage = async app => (await agentsPages(app))[0]
const focusOf = async (app, ide, agents) => ({
	agentsDocument: agents ? await agents.evaluate(() => document.hasFocus()).catch(() => null) : null,
	ideDocument: ide ? await ide.evaluate(() => document.hasFocus()).catch(() => null) : null,
	osFocused: (await windows(app)).filter(w => w.focused).map(w => w.id),
})
const quickInput = p => p.locator('.quick-input-widget:visible').count()
const toasts = p => p.locator('.notifications-toasts .notification-toast').count()

/** Opens the Agents window from the editor window and waits for its page. */
async function openAgents(app, ide) {
	await runCommand(ide, 'Open Agents Page')
	await until('the Agents window', () => agentsPage(app), { ms: 30000 })
	return agentsPage(app)
}
/** Closes the editor window the way its X button does (BrowserWindow.close runs the lifecycle and its veto). */
async function closeIde(app, id) {
	await closeWindow(app, id)
	await until('the editor window to hide', async () => (await ideWindows(app)).some(w => w.id === id && !w.visible), { ms: 15000 })
}
/** A second `insilode` on the same profile, as typed in a shell: it hands its arguments to the running one and exits. */
function secondInstance(app, extra) {
	const env = { ...process.env, ...ENV, VSCODE_SKIP_PRELAUNCH: '1' }
	delete env.ELECTRON_RUN_AS_NODE
	const r = spawnSync(sourceElectron(source), ['.', '--user-data-dir', join(app.profile, 'user-data'), '--extensions-dir', join(app.profile, 'extensions'), '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--password-store=basic', ...extra], { cwd: source, env, timeout: 60000, encoding: 'utf8' })
	return `exit ${r.status}${r.error ? ` ${r.error.message}` : ''}`
}
const ideOnly = async app => { const w = await ideWindows(app); return w.length === 1 ? w[0] : undefined }
const sampleSummary = async (app, ids) => {
	const rec = await recorded(app)
	const visibleSamples = rec.samples.filter(s => s.some(v => v)).length
	return { samples: rec.samples.length, visibleSamples, ideShowEvents: rec.shows.filter(s => ids.includes(s.id)).length }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 1: hide on close (RC01), the UI in the Agents window (RC04), what brings the window back (RC03), the question (RC02).
await part('agents-standalone/RC01 open: close its IDE window', async () => {
	const { app } = await start('hide')
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000) // the extensions activate after the workbench
		let win = await openAgents(app, page)
		await runCommand(page, 'New Claude Agent')
		await needAgents(1)
		console.log('screenshot:', await shot(win, 'r1-agents-with-ide'))
		const ide = await ideOnly(app)

		// RC01: closing the editor window hides it, the Agents window and the agent go on.
		await closeIde(app, ide.id)
		const hidden = (await ideWindows(app)).find(w => w.id === ide.id)
		const per10s = await ticksIn(10000)
		step('agents-standalone/RC01 open: close its IDE window -> IDE hidden, Agents window open, agents running', !!hidden && !hidden.visible && !!(await agentsPage(app)) && per10s >= 8, `hidden: ${JSON.stringify(hidden)}, ${per10s} ticks in 10 s, fake agent alive: ${fake.alive()}`)
		win = await agentsPage(app)
		console.log('screenshot:', await shot(win, 'r1-agents-ide-hidden'))

		// RC04: quick open and the palette show in the Agents window, not in the hidden one.
		const focus0 = await focusOf(app, page, win)
		// The hidden page may still say it has the focus (no window manager under xvfb never tells it otherwise): what counts is that the Agents window has it and, next step, that quick open goes there.
		step('agents-standalone/RC04 hidden: the Agents window has the focus after the editor window hides (focus evidence)', focus0.agentsDocument === true && focus0.osFocused.includes((await agentsWindow(app)).id), JSON.stringify(focus0))
		const input = win.locator('.quick-input-widget .quick-input-box input')
		const where = []
		for (const key of ['Control+P', 'Control+Shift+P']) {
			await win.keyboard.press(key)
			const shown = await input.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
			where.push({ key, agents: shown, ide: await quickInput(page) })
			await win.keyboard.press('Escape')
			await sleep(500)
		}
		step('agents-standalone/RC04 hidden: Ctrl+P / Ctrl+Shift+P -> Agents window', where.every(w => w.agents && w.ide === 0), JSON.stringify({ where, focus: await focusOf(app, page, win) }))
		console.log('screenshot:', await shot(win, 'r1-palette-in-agents'))

		// RC04: a toast the user did not cause.
		await runCommand(win, 'Probe: Toast')
		await until('a toast', async () => (await toasts(win)) + (await toasts(page)) > 0, { ms: 15000 }).catch(() => undefined)
		step('agents-standalone/RC04 hidden: a notification toast -> Agents window', (await toasts(win)) >= 1 && (await toasts(page)) === 0, `toasts: agents window ${await toasts(win)}, editor window ${await toasts(page)}`)
		console.log('screenshot:', await shot(win, 'r1-toast-in-agents'))

		// RC02 with one agent: the question, over the Agents window; Cancel changes nothing.
		const agentsId = (await agentsWindow(app)).id
		let ask = await asked(app)
		await answer(app, '^Cancel')
		await closeWindow(app, agentsId)
		let q = await awaitAsk(app, ask)
		const after1 = await ticksIn(4000)
		step('agents-standalone/RC02 hidden, 1 agent: asks "1 agent running, close?"', q?.message === '1 agent running, close?' && q.buttons.some(b => /Close/.test(b)) && q.buttons.some(b => /Cancel/.test(b)) && !!(await agentsPage(app)) && after1 >= 3, JSON.stringify({ q, ticksIn4s: after1 }))
		step('agents-standalone/RC04 hidden: a confirmation dialog -> over the Agents window', q?.parent === agentsId && q.parentVisible === true && q.ideVisible.every(v => v === false), JSON.stringify({ agentsId, parent: q?.parent, parentVisible: q?.parentVisible, ideVisible: q?.ideVisible }))

		// RC03: an editor that opens in the hidden window shows it (Open in IDE, quick open).
		await win.keyboard.press('Control+P')
		await input.waitFor({ state: 'visible', timeout: 15000 })
		await input.fill('hello.txt')
		await sleep(1000)
		await win.keyboard.press('Enter')
		await until('the editor window to show', async () => (await ideWindows(app)).some(w => w.id === ide.id && w.visible), { ms: 15000 }).catch(() => undefined)
		await sleep(1500)
		step('agents-standalone/RC03 Ctrl+P in the Agents window, open hello.txt -> IDE shown with hello.txt', (await ideWindows(app)).some(w => w.id === ide.id && w.visible) && (await tabTitles(page)).some(t => /hello\.txt/.test(t)), `${JSON.stringify(await ideWindows(app))}, tabs: ${JSON.stringify(await tabTitles(page))}`)
		console.log('screenshot:', await shot(page, 'r1-open-in-ide'))

		// RC03: "Show IDE Window" (the window hides again first), and a second agent for the next rows.
		await closeIde(app, ide.id)
		win = await agentsPage(app)
		await runCommand(win, 'Show IDE Window')
		await until('the editor window to show', async () => (await ideWindows(app)).some(w => w.id === ide.id && w.visible), { ms: 15000 }).catch(() => undefined)
		await sleep(1000)
		const shown = (await ideWindows(app)).find(w => w.id === ide.id)
		step('agents-standalone/RC03 "Show IDE Window" -> IDE shown, focused', shown?.visible === true && (shown.focused === true || (await focusOf(app, page, undefined)).ideDocument === true), JSON.stringify({ shown, focus: await focusOf(app, page, win) }))
		await runCommand(page, 'New Claude Agent')
		await needAgents(2)
		await closeIde(app, ide.id)
		win = await agentsPage(app)
		const per5s = await ticksIn(5000)

		// RC02 with two agents: Cancel, and Ctrl+W on the Agents tab asks the same.
		ask = await asked(app)
		await closeWindow(app, agentsId)
		q = await awaitAsk(app, ask)
		const afterCancel = await ticksIn(4000)
		step('agents-standalone/RC02 hidden, 2 agents, Cancel: nothing changes', q?.message === '2 agents running, close?' && per5s >= 8 && afterCancel >= 6 && !!(await agentsPage(app)) && (await ideWindows(app)).every(w => !w.visible), JSON.stringify({ q, ticksIn5sBefore: per5s, ticksIn4sAfter: afterCancel }))
		ask = await asked(app)
		await win.keyboard.press('Control+W')
		q = await awaitAsk(app, ask)
		step('agents-standalone/RC02 hidden, 2 agents: Ctrl+W on the Agents tab asks the same', q?.message === '2 agents running, close?' && q.parent === agentsId && !!(await agentsPage(app)) && (await ideWindows(app)).every(w => !w.visible), JSON.stringify(q))

		// RC02 Close: with exactly these two agents, the question is answered Close and everything goes.
		await answer(app, '^Close')
		ask = await asked(app)
		await closeWindow(app, agentsId)
		q = await awaitAsk(app, ask)
		const quit = await gone(app)
		const ended = await until('the fake agents to end', async () => !fake.alive(), { ms: 15000 }).then(() => true, () => false)
		step('agents-standalone/RC02 hidden, 2 agents, Close: IDE window closes, agents end, app quits', q?.message === '2 agents running, close?' && q.parent === agentsId && quit && ended, `question: ${JSON.stringify(q)}, quit: ${quit}, fake agents ended within 15 s of the quit: ${ended}`)
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 2: `insilode --agents-only` (RC05), then Insilode started again from a shell (RC03), then no agents to end (RC02).
await part('agents-standalone/RC05 insilode --agents-only', async () => {
	const { app } = await start('agentsonly', { args: ['--agents-only'] })
	try {
		const t0 = Date.now()
		await until('the Agents window', () => agentsPage(app), { ms: 90000 })
		await sleep(Math.max(0, 15000 - (Date.now() - t0))) // 15 s of samples in all: a source build force-shows a hidden window after 10 s
		const ws = await windows(app)
		const summary = await sampleSummary(app, ws.filter(w => w.ide).map(w => w.id))
		const agents = await agentsPage(app)
		const focus = await focusOf(app, undefined, agents)
		step('agents-standalone/RC05 insilode --agents-only: IDE never visible (also after 10 s in a source build), Agents window open, focused', summary.samples >= 100 && summary.visibleSamples === 0 && summary.ideShowEvents === 0 && !!agents && focus.agentsDocument === true, JSON.stringify({ ...summary, windows: ws, focus }))
		console.log('screenshot:', await shot(agents, 'r2-agents-only'))

		// A second instance, as `insilode` or `insilode --agents-only` from a shell: it hands its arguments to this one.
		const second = extra => secondInstance(app, extra)
		const before = (await windows(app)).filter(w => !w.overlay).length
		const ran = second(['--agents-only'])
		await sleep(5000)
		const afterFlag = await windows(app)
		const focusFlag = await focusOf(app, undefined, await agentsPage(app))
		step('agents-standalone/RC03 insilode --agents-only from a shell -> IDE stays hidden, Agents window focused', afterFlag.filter(w => w.ide).every(w => !w.visible) && afterFlag.filter(w => !w.overlay).length === before && !!(await agentsPage(app)) && focusFlag.agentsDocument === true, JSON.stringify({ ran, windows: afterFlag, focus: focusFlag }))

		const ran2 = second([])
		await until('the editor window to show', async () => (await ideWindows(app)).some(w => w.visible), { ms: 20000 }).catch(() => undefined)
		await sleep(1500)
		const afterPlain = await windows(app)
		step('agents-standalone/RC03 insilode from a shell -> IDE shown', afterPlain.filter(w => w.ide).length === 1 && afterPlain.filter(w => w.ide).every(w => w.visible), JSON.stringify({ ran: ran2, windows: afterPlain }))
		console.log('screenshot:', await shot(app.pages().find(p => p.url().startsWith('vscode-file:')), 'r2-insilode-again'))

		// RC02: no agent runs, so closing the Agents window with the editor window hidden asks nothing and closes both.
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)
		await answer(app, '^Cancel') // a question here would hold the close: the step then fails
		const asks = await asked(app)
		await closeWindow(app, (await agentsWindow(app)).id)
		const quit = await gone(app)
		step('agents-standalone/RC02 hidden, 0 agents: IDE window closes without asking', quit, `quit: ${quit} (a question answered Cancel would have held it; asked before: ${asks})`)
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 3: `--agents-only` with a maximized window state (RC05), then a renderer crash while hidden (RC03).
await part('agents-standalone/RC05 insilode --agents-only, window state maximized', async () => {
	const { app } = await start('maximized', { args: ['--agents-only'], maximized: true })
	try {
		const t0 = Date.now()
		await until('the Agents window', () => agentsPage(app), { ms: 90000 })
		await sleep(Math.max(0, 15000 - (Date.now() - t0)))
		const ws = await windows(app)
		const ide = ws.find(w => w.ide)
		const summary = await sampleSummary(app, ws.filter(w => w.ide).map(w => w.id))
		step('agents-standalone/RC05 insilode --agents-only, window state maximized: IDE never visible, Agents window open', summary.samples >= 100 && summary.visibleSamples === 0 && summary.ideShowEvents === 0 && !!(await agentsPage(app)), JSON.stringify({ ...summary, windows: ws }))

		// The renderer of the hidden window dies: the window shows, and the state it was kept from is applied then.
		await answer(app, 'Reopen|New Window')
		const crashAt = Date.now()
		await app.main(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.forcefullyCrashRenderer(), ide.id)
		await until('an editor window to show', async () => (await ideWindows(app)).some(w => w.visible), { ms: 60000 }).catch(() => undefined)
		await sleep(3000)
		const afterCrash = await ideWindows(app)
		const after = await recorded(app)
		const boxes = after.dialogs // this run's only box is the crash one
		step('agents-standalone/RC03 Reload Window / renderer crash -> IDE shown (the Agents window is not restored): crash', afterCrash.some(w => w.visible) && boxes.length >= 1 && boxes[0].parentVisible === true && !(await agentsPage(app)), JSON.stringify({ afterCrash, boxes }))
		// The hidden window was kept from maximizing; shown by the crash, it must be maximized then, or the seeded state was not read. Under xvfb
		// isMaximized() cannot turn true (no window manager), so the maximize() call on this window after the crash is the evidence.
		const calls = (after.maximizes ?? []).filter(m => m.id === ide.id && m.at >= crashAt)
		step('agents-standalone/RC05 insilode --agents-only, window state maximized: the state is applied when the window shows (the seeded state was read)', calls.length >= 1 && boxes[0]?.parentVisible === true, JSON.stringify({ maximizeCallsOnTheWindowAfterTheCrash: calls.length, boxIsMaximized: boxes[0]?.parentMaximized, maximizeCalls: after.maximizes }))
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 4: `--agents-only` with two editor windows restored from the last session (RC05): neither shows.
await part('agents-standalone/RC05 insilode --agents-only, two IDE windows restored', async () => {
	const { app } = await start('restored', { args: ['--agents-only'], restore: 2 })
	try {
		const t0 = Date.now()
		await until('two editor windows', async () => (await ideWindows(app)).length >= 2, { ms: 90000 })
		await until('an Agents window', () => agentsPage(app), { ms: 90000 })
		await sleep(Math.max(0, 15000 - (Date.now() - t0)))
		const ws = await windows(app)
		const ideIds = ws.filter(w => w.ide).map(w => w.id)
		const summary = await sampleSummary(app, ideIds)
		const agents = await agentsPages(app)
		step('agents-standalone/RC05 insilode --agents-only, two IDE windows restored from the last session: never, neither of them; Agents window open', ideIds.length === 2 && summary.samples >= 100 && summary.visibleSamples === 0 && summary.ideShowEvents === 0 && agents.length >= 1, JSON.stringify({ ...summary, ideWindows: ideIds.length, agentsWindows: agents.length, windows: ws }))
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 5: a normal start (RC05), the IDE visible (RC04, RC02), a second editor window (RC01), no Agents window (RC01).
await part('agents-standalone/RC05 insilode', async () => {
	const { app } = await start('visible')
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		const rec = await recorded(app)
		const visible = rec.samples.filter(s => s.some(v => v)).length
		step('agents-standalone/RC05 insilode: IDE visible, as today', visible > 0, `${visible} of ${rec.samples.length} samples had a visible editor window`)
		await sleep(5000)
		const win = await openAgents(app, page)
		for (let i = 0; i < 3; i++) {
			await runCommand(page, 'New Claude Agent')
			await sleep(1500)
		}
		await needAgents(3)
		const ide = await ideOnly(app)
		const agentsId = (await agentsWindow(app)).id

		// RC04: with the editor window visible, everything stays where it was.
		await app.main(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), agentsId)
		await sleep(1000)
		const input = win.locator('.quick-input-widget .quick-input-box input')
		await win.keyboard.press('Control+P')
		const shown = await input.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
		step('agents-standalone/RC04 visible, Agents window focused: Ctrl+P -> Agents window (as today)', shown && (await quickInput(page)) === 0, JSON.stringify({ agents: shown, ide: await quickInput(page), focus: await focusOf(app, page, win) }))
		await win.keyboard.press('Escape')
		await runCommand(page, 'Probe: Toast')
		await until('a toast', async () => (await toasts(win)) + (await toasts(page)) > 0, { ms: 15000 }).catch(() => undefined)
		step('agents-standalone/RC04 visible: a notification -> IDE window (as today)', (await toasts(page)) >= 1 && (await toasts(win)) === 0, `toasts: editor window ${await toasts(page)}, agents window ${await toasts(win)}`)

		// RC01: the Agents window belongs to window 1; closing window 2 closes it as today.
		secondInstance(app, ['--new-window'])
		await until('a second editor window', async () => (await ideWindows(app)).length === 2, { ms: 60000 })
		const second = (await ideWindows(app)).find(w => w.id !== ide.id)
		await closeWindow(app, second.id)
		await until('window 2 to close', async () => (await ideWindows(app)).length === 1, { ms: 20000 }).catch(() => undefined)
		const left = await ideWindows(app)
		step('agents-standalone/RC01 open in IDE window 1: close IDE window 2 -> window 2 closes as today', left.length === 1 && left[0].id === ide.id && left[0].visible && !!(await agentsPage(app)), JSON.stringify(left))

		// RC02: the editor window is visible, so closing the Agents window asks nothing and the agents live on in the editor window.
		await answer(app, '^Cancel')
		const before = await asked(app)
		await closeWindow(app, agentsId)
		await until('the Agents window to close', async () => !(await agentsPage(app)), { ms: 15000 }).catch(() => undefined)
		const per4s = await ticksIn(4000)
		const questions = (await asked(app)) - before
		step('agents-standalone/RC02 visible, 3 agents: Agents window closes without asking; agents keep running in the IDE', !(await agentsPage(app)) && questions === 0 && per4s >= 8 && (await ideWindows(app)).every(w => w.visible), JSON.stringify({ questions, ticksIn4s: per4s, windows: await ideWindows(app) }))

		// RC01: no Agents window now, so closing the editor window is what it always was.
		await closeWindow(app, ide.id)
		const quit = await gone(app)
		step('agents-standalone/RC01 not open: close the IDE window -> closes as today', quit, `quit: ${quit}`)
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 6: Quit while the editor window is hidden and agents run (RC01): it asks nothing.
await part('agents-standalone/RC01 open, Quit', async () => {
	const { app } = await start('quit')
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000)
		const win = await openAgents(app, page)
		await runCommand(page, 'New Claude Agent')
		await needAgents(1)
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)
		await answer(app, '^Cancel') // a question here would hold the quit: the step then fails
		const before = await asked(app)
		await win.keyboard.press('Control+Q')
		let how = 'Ctrl+Q in the Agents window'
		let quit = await gone(app, 12000)
		if (!quit) {
			how = 'Ctrl+Q did not quit; app.quit() instead'
			await app.main(({ app: electron }) => electron.quit()).catch(() => undefined)
			quit = await gone(app, 12000)
		}
		// The terminals' processes end a moment after the app: wait for them before saying one outlived it.
		const ended = await until('the fake agent to end', async () => !fake.alive(), { ms: 15000 }).then(() => true, () => false)
		step('agents-standalone/RC01 open, Quit (Ctrl+Q / Exit), agents live: quits without asking', quit && ended, `${how}; quit: ${quit}; fake agent ended within 15 s of the quit: ${ended}${quit ? '' : `; questions asked: ${(await asked(app)) - before}`}`)
	} finally {
		await app.close()
	}
})

// Run 7: Quit with an unsaved file: the editor window shows and its save question asks there.
await part('agents-standalone/RC01 open, Quit, unsaved file', async () => {
	const { app } = await start('quit-dirty', { settings: { 'files.hotExit': 'off' } })
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000)
		await dirtyHello(page)
		const win = await openAgents(app, page)
		await runCommand(page, 'New Claude Agent')
		await needAgents(1)
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)
		await answer(app, "Don.t Save")
		const before = await asked(app)
		await win.keyboard.press('Control+Q')
		const q = await awaitAsk(app, before, 20000)
		const quit = await gone(app, 20000)
		step('agents-standalone/RC01 open, Quit (Ctrl+Q / Exit), agents live, unsaved files: the IDE shows and its save dialog asks there', !!q && q.parent === ide.id && q.parentVisible === true && q.ideVisible.every(v => v === true), JSON.stringify({ q, ideId: ide.id, quit }))
	} finally {
		await app.close()
	}
})

/** Types into hello.txt in the editor window, so it has an unsaved change. */
async function dirtyHello(page) {
	await page.keyboard.press('Control+P')
	const input = page.locator('.quick-input-widget .quick-input-box input')
	await input.waitFor({ state: 'visible', timeout: 15000 })
	await input.fill('hello.txt')
	await sleep(1000)
	await page.keyboard.press('Enter')
	await page.locator('.monaco-editor .view-lines').first().click({ timeout: 20000 })
	await page.keyboard.type('x')
	await sleep(500)
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 8: a close that is vetoed (the save question is cancelled) leaves nothing behind (RC02).
await part('agents-standalone/RC02 a cancelled close', async () => {
	const { app } = await start('cancelled', { settings: { 'files.hotExit': 'off' } })
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000)
		await dirtyHello(page)
		const win = await openAgents(app, page)
		await runCommand(page, 'New Claude Agent')
		await needAgents(1)
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)
		const agentsId = (await agentsWindow(app)).id

		// Close in the question, then Cancel in the save question: the window shows (it asked there) and nothing is closing any more.
		await answer(app, '^Cancel', ['^Close', '^Cancel'])
		let ask = await asked(app)
		await closeWindow(app, agentsId)
		const first = await awaitAsk(app, ask)
		const second = await awaitAsk(app, ask + 1)
		await sleep(2000)
		const afterCancel = await ideWindows(app)
		const stillThere = !!(await agentsPage(app))
		// The next close of the editor window must hide it again, and the Agents window must ask again.
		await closeWindow(app, ide.id)
		await until('the editor window to hide again', async () => (await ideWindows(app)).some(w => w.id === ide.id && !w.visible), { ms: 15000 }).catch(() => undefined)
		const hiddenAgain = (await ideWindows(app)).some(w => w.id === ide.id && !w.visible)
		ask = await asked(app)
		await closeWindow(app, agentsId)
		const third = await awaitAsk(app, ask)
		step('agents-standalone/RC02 hidden, Close, then the save question is cancelled: the IDE hides again on close and the Agents close asks again', first?.message === '1 agent running, close?' && /save|changes/i.test(second?.message ?? '') && second.parent === ide.id && afterCancel.some(w => w.visible) && stillThere && hiddenAgain && third?.message === '1 agent running, close?', JSON.stringify({ first, second, afterCancel, stillThere, hiddenAgain, third }))
		console.log('screenshot:', await shot(win, 'r8-after-cancelled-close'))
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 9: what shows the hidden window (RC03): the Dock, a reload; what does not: a renderer that stops responding.
await part('agents-standalone/RC03 the hidden window comes back', async () => {
	const { app } = await start('comesback')
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000)
		let win = await openAgents(app, page)
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)

		// macOS: a click on the Dock icon is Electron's `activate` event, which the code listens for on every platform.
		await app.main(({ app: electron }) => electron.emit('activate', {}, true))
		await until('the editor window to show', async () => (await ideWindows(app)).some(w => w.id === ide.id && w.visible), { ms: 15000 }).catch(() => undefined)
		step('agents-standalone/RC03 macOS: click the Dock icon -> IDE shown (the activate event, emitted by hand)', (await ideWindows(app)).some(w => w.id === ide.id && w.visible), JSON.stringify(await ideWindows(app)))

		// Reload Window from the Agents window: the editor window shows; the Agents window is not restored.
		await closeIde(app, ide.id)
		win = await agentsPage(app)
		await runCommand(win, 'Developer: Reload Window')
		await until('the editor window to show again', async () => (await ideWindows(app)).some(w => w.visible), { ms: 60000 }).catch(() => undefined)
		await page.waitForSelector('.monaco-workbench', { timeout: 90000 }).catch(() => undefined)
		await sleep(3000)
		step('agents-standalone/RC03 Reload Window / renderer crash -> IDE shown (the Agents window is not restored): reload', (await ideWindows(app)).some(w => w.visible) && !(await agentsPage(app)), JSON.stringify(await windows(app)))
		console.log('screenshot:', await shot(page, 'r9-after-reload'))

		// A renderer that stops responding: the box asks (and is answered Keep Waiting), but nothing shows the window. The page is hung for good.
		await sleep(5000)
		await openAgents(app, page)
		const agentsId = (await agentsWindow(app)).id
		const ide2 = await ideOnly(app)
		await closeIde(app, ide2.id)
		await answer(app, 'Keep Waiting')
		const before = await asked(app)
		await app.main(({ BrowserWindow }, id) => {
			const contents = BrowserWindow.fromId(id).webContents
			contents.executeJavaScript('for (;;) {}').catch(() => undefined)
			setTimeout(() => contents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }), 1000)
		}, ide2.id)
		const q = await awaitAsk(app, before, 90000)
		await sleep(3000)
		const hidden = (await ideWindows(app)).filter(w => w.id === ide2.id)
		// The box opens over the Agents window (the editor window is hidden, and a box over an invisible window is a sheet nobody sees).
		step('agents-standalone/RC03 the renderer stops responding for a while -> IDE stays hidden (no focus stealing)', !!q && q.parent === agentsId && q.parentVisible === true && hidden.length === 1 && !hidden[0].visible, JSON.stringify({ agentsId, question: q, hidden }))
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 10: a click on an agent in the status island while the editor window is hidden (RC03).
await part('agents-standalone/RC03 click an agent in the status island', async () => {
	const { app } = await start('island', { settings: { 'flow.agents.desktop.overlay.enabled': true, 'flow.agents.desktop.overlay.style': 'list', 'flow.agents.desktop.overlay.autoHide': { noAgents: true, insilodeFocused: false } } })
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000)
		// The agent first, the page after: the page then opens with no pane, and a pane in it afterwards is the click's doing.
		await runCommand(page, 'New Claude Agent')
		await needAgents(1)
		const win = await openAgents(app, page)
		const panesBefore = await (await pageFrame(win)).locator('.xterm').count().catch(() => -1)
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)
		const agentsId = (await agentsWindow(app)).id
		// The Agents window is sent away (minimized), so that "comes forward" is something the click must do.
		await app.main(({ BrowserWindow }, id) => BrowserWindow.fromId(id).minimize(), agentsId)
		await sleep(1000)
		const island = await until('the status island', async () => { const p = app.overlayPage(); return p && (await p.locator('.row').count()) > 0 ? p : undefined }, { ms: 40000 }).catch(() => undefined)
		if (!island) {
			step('agents-standalone/RC03 click an agent in the status island -> the agent opens in the Agents window, which comes forward; IDE stays hidden', false, `the island showed no agent row (windows: ${JSON.stringify(await windows(app))})`)
			return
		}
		await island.locator('.row').first().click()
		await sleep(4000)
		const ws = await windows(app)
		const agents = ws.find(w => w.id === agentsId)
		const frame = await pageFrame(win)
		const panes = frame ? await frame.locator('.xterm').count().catch(() => -1) : -1
		step('agents-standalone/RC03 click an agent in the status island -> the agent opens in the Agents window, which comes forward; IDE stays hidden', ws.filter(w => w.ide).every(w => !w.visible) && agents?.visible === true && agents.minimized === false && (agents.focused === true || (await focusOf(app, undefined, win)).agentsDocument === true) && panesBefore === 0 && panes >= 1, JSON.stringify({ windows: ws, terminalPanesBefore: panesBefore, terminalPanesAfter: panes }))
		console.log('screenshot:', await shot(win, 'r10-island-click'))
	} finally {
		await app.close()
	}
})

writeFileSync(join(out, 'agents-alone-results.json'), JSON.stringify(results, null, 2))
console.log(`${results.steps.filter(s => s.pass).length} of ${results.steps.length} steps passed`)
process.exit(results.steps.length > 0 && results.steps.every(s => s.pass) ? 0 : 1)
