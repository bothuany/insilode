// The Agents window on its own (plan docs/plans/agents-standalone.md, cards RC01-RC05): the editor window is hidden, not closed, while the
// Agents window is open; the Agents window asks before it closes when that would end agents; the hidden window comes back when it is needed;
// quick open, toasts and dialogs follow the Agents window; `--agents-only` never shows the editor window.
//   npm run docker:e2e -- --probe test/e2e-desktop/probes/agents-alone.mjs --out <dir>
// One step per example row it can drive, each named `agents-standalone/RCnn <row>`; the results go to <out>/agents-alone-results.json. Not driven
// here: the macOS rows (no macOS runner), more than one editor window beyond the one RC01 row, and the Windows hide itself.
// Written from the code, not run on this machine (nothing opens a window here): the first Docker run may need selectors adjusted.
//
// What stands in for the real thing:
//  - a fake `claude` on PATH that ticks once a second, so an agent is a live session without a login;
//  - the main process's `dialog.showMessageBox` (the confirmation, the save question and the crash dialog are native boxes Playwright cannot
//    click): it records the parent window and answers by button label, so "over the Agents window" is the recorded parent window id;
//  - a main-process recorder of every window's `show` event and of the editor windows' visibility every 100 ms. It starts when Playwright
//    attaches, not at the first instruction of the process: the first moments of a start are not covered.
// The focus rows depend on which window the OS says has the focus: every such step records `document.hasFocus()` of both pages, so a failure
// can be told apart as the environment (no window manager under xvfb) or the code.
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
const step = (name, pass, evidence) => {
	const full = `agents-standalone/${name}`
	results.steps.push({ name: full, pass: !!pass, evidence })
	console.log(`${pass ? 'PASS' : 'FAIL'} ${full}: ${evidence}`)
}
/** Runs a part of the probe; an exception is a failed step named after it, and the probe goes on with the next part. */
const part = async (name, fn) => {
	try {
		await fn()
	} catch (e) {
		step(name, false, String(e.stack ?? e).split('\n').slice(0, 3).join(' | '))
	}
}

// A fake `claude` (a real one needs a login): ticks once a second into the terminal and into a log the probe counts.
const bin = realpathSync(mkdtempSync(join(tmpdir(), 'fake-claude-')))
const tickLog = join(bin, 'ticks.log')
writeFileSync(join(bin, 'claude'), `#!/bin/sh\ni=0\nwhile :; do echo "agent tick $i"; echo "$(date +%s) $i" >> ${tickLog}; i=$((i+1)); sleep 1; done\n`)
chmodSync(join(bin, 'claude'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`
const ticks = () => existsSync(tickLog) ? readFileSync(tickLog, 'utf8').trim().split('\n').length : 0
const fakeAlive = () => { try { execFileSync('pgrep', ['-f', join(bin, 'claude')]); return true } catch { return false } }
/** Ticks in the next `ms`: one per second per live agent. */
const ticksIn = async ms => { const before = ticks(); await sleep(ms); return ticks() - before }

// An extension that shows a toast on demand (a notification the user did not cause).
const toastExtension = join(realpathSync(mkdtempSync(join(tmpdir(), 'probe-toast-'))), 'ext')
mkdirSync(toastExtension)
writeFileSync(join(toastExtension, 'package.json'), JSON.stringify({ name: 'probe-toast', version: '0.0.1', publisher: 'probe', engines: { vscode: '^1.90.0' }, main: './extension.js', activationEvents: ['onStartupFinished'], contributes: { commands: [{ command: 'probe.toast', title: 'Probe: Toast' }] } }))
writeFileSync(join(toastExtension, 'extension.js'), "const vscode = require('vscode')\nexports.activate = c => c.subscriptions.push(vscode.commands.registerCommand('probe.toast', () => vscode.window.showInformationMessage('probe toast')))\n")

const ENV = { NODE_ENV: 'development', VSCODE_DEV: '1', VSCODE_CLI: '1' }

/** Starts Insilode on a fresh folder (hello.txt in it) and puts the main-process recorder in. */
async function start(label, { args = [], settings, maximized } = {}) {
	const folder = join(realpathSync(mkdtempSync(join(tmpdir(), `insilode-alone-${label}-`))), 'project')
	mkdirSync(folder)
	writeFileSync(join(folder, 'hello.txt'), 'hello from the probe\n')
	// A window state the main process reads at start: maximized, for the folder that is opened.
	const files = maximized ? { 'User/globalStorage/storage.json': { windowsState: { openedWindows: [{ folder: pathToFileURL(folder).toString(), uiState: { mode: 0, x: 0, y: 0, width: 1280, height: 800 } }] } } } : undefined
	const app = await launchInsilode({ exe: sourceElectron(source), args: ['.', ...args], cwd: source, out, folder, settings, files, env: ENV, extensions: [toastExtension] })
	await app.main(({ app: electron, BrowserWindow, dialog }) => {
		const aa = globalThis.__aa = { samples: [], shows: [], dialogs: [], answer: 'Cancel' }
		const ide = w => !w.isDestroyed() && /^vscode-file:/.test(w.webContents.getURL())
		const watch = w => w.on('show', () => aa.shows.push({ id: w.id, at: Date.now() }))
		BrowserWindow.getAllWindows().forEach(watch)
		electron.on('browser-window-created', (_event, w) => watch(w))
		setInterval(() => aa.samples.push(BrowserWindow.getAllWindows().filter(ide).map(w => w.isVisible())), 100)
		// The native boxes: record who asked and over which window, and answer by the label of a button.
		dialog.showMessageBox = async (a, b) => {
			const parent = b ? a : undefined
			const options = b ?? a
			aa.dialogs.push({ parent: parent && !parent.isDestroyed() ? parent.id : null, parentVisible: parent && !parent.isDestroyed() ? parent.isVisible() : null, parentMaximized: parent && !parent.isDestroyed() ? parent.isMaximized() : null, message: options.message, buttons: options.buttons, ideVisible: BrowserWindow.getAllWindows().filter(ide).map(w => w.isVisible()) })
			const i = (options.buttons ?? []).findIndex(label => new RegExp(aa.answer, 'i').test(label.replace(/&/g, '')))
			return { response: i >= 0 ? i : (options.cancelId ?? 0), checkboxChecked: false }
		}
	})
	return { app, folder }
}

const answer = (app, regex) => app.main((_, r) => { globalThis.__aa.answer = r }, regex)
const recorded = app => app.main(() => ({ samples: globalThis.__aa.samples, shows: globalThis.__aa.shows, dialogs: globalThis.__aa.dialogs }))
const windows = app => app.main(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => {
	const url = w.webContents.getURL()
	return { id: w.id, ide: /^vscode-file:/.test(url), overlay: url.startsWith('data:'), visible: w.isVisible(), focused: w.isFocused(), maximized: w.isMaximized() }
}))
const ideWindows = async app => (await windows(app)).filter(w => w.ide)
const agentsWindow = async app => (await windows(app)).find(w => !w.ide && !w.overlay)
const closeWindow = (app, id) => app.main(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), id)
const gone = (app, ms = 25000) => until('the app to quit', async () => { try { await app.main(() => 1); return false } catch { return true } }, { ms }).then(() => true, () => false)

const pageFrame = async win => {
	for (const f of win.frames()) {
		try { if (await f.locator('nav.side').count()) { return f } } catch { /* navigating */ }
	}
	return undefined
}
const agentsPage = async app => {
	for (const p of app.pages().filter(p => !p.url().startsWith('data:') && !p.url().startsWith('vscode-file:'))) {
		if (await pageFrame(p)) { return p }
	}
	return undefined
}
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
const ideOnly = async app => { const w = await ideWindows(app); return w.length === 1 ? w[0] : undefined }
const newestAsk = async (app, since) => (await recorded(app)).dialogs[since]

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 1: hide on close (RC01), the UI in the Agents window (RC04), what brings the window back (RC03), the question (RC02).
await part('RC01 open: close its IDE window', async () => {
	const { app } = await start('hide')
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000) // the extensions activate after the workbench
		let win = await openAgents(app, page)
		await runCommand(page, 'New Claude Agent')
		await until('the fake agent ticking', async () => ticks() > 2, { ms: 30000 })
		await sleep(1500)
		console.log('screenshot:', await shot(win, 'r1-agents-with-ide'))
		const ide = await ideOnly(app)

		// RC01: closing the editor window hides it, the Agents window and the agent go on.
		await closeIde(app, ide.id)
		const hidden = (await ideWindows(app)).find(w => w.id === ide.id)
		const per10s = await ticksIn(10000)
		step('RC01 open: close its IDE window -> IDE hidden, Agents window open, agents running', !!hidden && !hidden.visible && !!(await agentsPage(app)) && per10s >= 8, `hidden: ${JSON.stringify(hidden)}, ${per10s} ticks in 10 s, fake agent alive: ${fakeAlive()}`)
		win = await agentsPage(app)
		console.log('screenshot:', await shot(win, 'r1-agents-ide-hidden'))

		// RC04: quick open and the palette show in the Agents window, not in the hidden one.
		const focus0 = await focusOf(app, page, win)
		step('RC04 hidden: the Agents window has the focus after the editor window hides (focus evidence)', focus0.agentsDocument === true && focus0.ideDocument === false, JSON.stringify(focus0))
		const input = win.locator('.quick-input-widget .quick-input-box input')
		const where = []
		for (const key of ['Control+P', 'Control+Shift+P']) {
			await win.keyboard.press(key)
			const shown = await input.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
			where.push({ key, agents: shown, ide: await quickInput(page) })
			await win.keyboard.press('Escape')
			await sleep(500)
		}
		step('RC04 hidden: Ctrl+P / Ctrl+Shift+P -> Agents window', where.every(w => w.agents && w.ide === 0), JSON.stringify({ where, focus: await focusOf(app, page, win) }))
		console.log('screenshot:', await shot(win, 'r1-palette-in-agents'))

		// RC04: a toast the user did not cause.
		await runCommand(win, 'Probe: Toast')
		await until('a toast', async () => (await toasts(win)) + (await toasts(page)) > 0, { ms: 15000 }).catch(() => undefined)
		step('RC04 hidden: a notification toast -> Agents window', (await toasts(win)) >= 1 && (await toasts(page)) === 0, `toasts: agents window ${await toasts(win)}, editor window ${await toasts(page)} (the toast waits on requestAnimationFrame of the hidden page)`)
		console.log('screenshot:', await shot(win, 'r1-toast-in-agents'))

		// RC02 with one agent: the question, over the Agents window; Cancel changes nothing.
		const agentsId = (await agentsWindow(app)).id
		let ask = (await recorded(app)).dialogs.length
		await answer(app, '^Cancel')
		await closeWindow(app, agentsId)
		await until('the question', async () => (await recorded(app)).dialogs.length > ask, { ms: 15000 }).catch(() => undefined)
		let q = await newestAsk(app, ask)
		const after1 = await ticksIn(4000)
		step('RC02 hidden, 1 agent: asks "1 agent running, close?"', q?.message === '1 agent running, close?' && q.buttons.some(b => /Close/.test(b)) && q.buttons.some(b => /Cancel/.test(b)) && !!(await agentsPage(app)) && after1 >= 3, JSON.stringify({ q, ticksIn4s: after1 }))
		step('RC04 hidden: a confirmation dialog -> over the Agents window', q?.parent === agentsId && q.parentVisible === true && q.ideVisible.every(v => v === false), JSON.stringify({ agentsId, parent: q?.parent, parentVisible: q?.parentVisible, ideVisible: q?.ideVisible }))

		// RC03: an editor that opens in the hidden window shows it (Open in IDE, quick open).
		await win.keyboard.press('Control+P')
		await input.waitFor({ state: 'visible', timeout: 15000 })
		await input.fill('hello.txt')
		await sleep(1000)
		await win.keyboard.press('Enter')
		await until('the editor window to show', async () => (await ideWindows(app)).some(w => w.id === ide.id && w.visible), { ms: 15000 }).catch(() => undefined)
		await sleep(1500)
		step('RC03 Ctrl+P in the Agents window, open hello.txt -> IDE shown with hello.txt', (await ideWindows(app)).some(w => w.id === ide.id && w.visible) && (await tabTitles(page)).some(t => /hello\.txt/.test(t)), `${JSON.stringify(await ideWindows(app))}, tabs: ${JSON.stringify(await tabTitles(page))}`)
		console.log('screenshot:', await shot(page, 'r1-open-in-ide'))

		// RC03: "Show IDE Window" (the window hides again first), and a second agent for the next rows.
		await closeIde(app, ide.id)
		win = await agentsPage(app)
		await runCommand(win, 'Show IDE Window')
		await until('the editor window to show', async () => (await ideWindows(app)).some(w => w.id === ide.id && w.visible), { ms: 15000 }).catch(() => undefined)
		const shown = (await ideWindows(app)).find(w => w.id === ide.id)
		step('RC03 "Show IDE Window" -> IDE shown, focused', shown?.visible === true, JSON.stringify({ shown, focus: await focusOf(app, page, win) }))
		await runCommand(page, 'New Claude Agent')
		await sleep(4000)
		const per5s = await ticksIn(5000)
		await closeIde(app, ide.id)
		win = await agentsPage(app)

		// RC02 with two agents: Cancel, and Ctrl+W on the Agents tab asks the same.
		ask = (await recorded(app)).dialogs.length
		await closeWindow(app, agentsId)
		await until('the question', async () => (await recorded(app)).dialogs.length > ask, { ms: 15000 }).catch(() => undefined)
		q = await newestAsk(app, ask)
		step('RC02 hidden, 2 agents, Cancel: nothing changes', /^\d+ agents running, close\?$/.test(q?.message ?? '') && !!(await agentsPage(app)) && (await ideWindows(app)).every(w => !w.visible), JSON.stringify({ q, ticksIn5sWithTwo: per5s }))
		ask = (await recorded(app)).dialogs.length
		await win.keyboard.press('Control+W')
		await until('the question', async () => (await recorded(app)).dialogs.length > ask, { ms: 15000 }).catch(() => undefined)
		q = await newestAsk(app, ask)
		step('RC02 hidden, 2 agents: Ctrl+W on the Agents tab asks the same', /^\d+ agents running, close\?$/.test(q?.message ?? '') && q?.parent === agentsId && !!(await agentsPage(app)), JSON.stringify(q))

		// RC03: Reload Window shows the editor window; the Agents window is not restored.
		await runCommand(win, 'Developer: Reload Window')
		await until('the editor window to show again', async () => (await ideWindows(app)).some(w => w.visible), { ms: 60000 }).catch(() => undefined)
		await page.waitForSelector('.monaco-workbench', { timeout: 90000 }).catch(() => undefined)
		await sleep(3000)
		step('RC03 Reload Window / renderer crash -> IDE shown (the Agents window is not restored): reload', (await ideWindows(app)).some(w => w.visible) && !(await agentsPage(app)), JSON.stringify(await windows(app)))
		console.log('screenshot:', await shot(page, 'r1-after-reload'))

		// RC02 Close: the Agents window again, agents running, the editor window hidden; Close ends the lot.
		await sleep(5000)
		win = await openAgents(app, page)
		await runCommand(page, 'New Claude Agent')
		await sleep(3000)
		const ide2 = await ideOnly(app)
		await closeIde(app, ide2.id)
		await answer(app, '^Close')
		ask = (await recorded(app)).dialogs.length
		await closeWindow(app, (await agentsWindow(app)).id)
		const quit = await gone(app)
		await sleep(3000)
		q = await newestAsk(app, ask).catch(() => undefined)
		step('RC02 hidden, 2 agents, Close: IDE window closes, agents end, app quits', quit && !fakeAlive(), `quit: ${quit}, fake agent alive after quit: ${fakeAlive()}`)
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 2: `insilode --agents-only` (RC05), then Insilode started again from a shell (RC03), then no agents to end (RC02).
await part('RC05 insilode --agents-only', async () => {
	const { app } = await start('agentsonly', { args: ['--agents-only'] })
	try {
		const t0 = Date.now()
		await until('the Agents window', () => agentsPage(app), { ms: 90000 })
		await sleep(Math.max(0, 15000 - (Date.now() - t0))) // 15 s of samples in all: a source build force-shows a hidden window after 10 s
		const rec = await recorded(app)
		const ws = await windows(app)
		const ideIds = ws.filter(w => w.ide).map(w => w.id)
		const visibleSamples = rec.samples.filter(s => s.some(v => v)).length
		const ideShows = rec.shows.filter(s => ideIds.includes(s.id))
		const agents = await agentsPage(app)
		const focus = await focusOf(app, undefined, agents)
		step('RC05 insilode --agents-only: IDE never visible (also after 10 s in a source build), Agents window open, focused', rec.samples.length >= 100 && visibleSamples === 0 && ideShows.length === 0 && !!agents && focus.agentsDocument === true, JSON.stringify({ samples: rec.samples.length, visibleSamples, ideShowEvents: ideShows.length, windows: ws, focus }))
		console.log('screenshot:', await shot(agents, 'r2-agents-only'))

		// A second instance, as `insilode` or `insilode --agents-only` from a shell: it hands its arguments to this one.
		const userData = join(app.profile, 'user-data')
		const second = extra => {
			const env = { ...process.env, ...ENV, VSCODE_SKIP_PRELAUNCH: '1' }
			delete env.ELECTRON_RUN_AS_NODE
			const r = spawnSync(sourceElectron(source), ['.', '--user-data-dir', userData, '--extensions-dir', join(app.profile, 'extensions'), '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage', '--password-store=basic', ...extra], { cwd: source, env, timeout: 60000, encoding: 'utf8' })
			return `exit ${r.status}${r.error ? ` ${r.error.message}` : ''}`
		}
		const before = (await windows(app)).filter(w => !w.overlay).length
		const ran = second(['--agents-only'])
		await sleep(5000)
		const afterFlag = await windows(app)
		step('RC03 insilode --agents-only from a shell -> IDE stays hidden, Agents window focused', afterFlag.filter(w => w.ide).every(w => !w.visible) && afterFlag.filter(w => !w.overlay).length === before && !!(await agentsPage(app)), JSON.stringify({ ran, windows: afterFlag, focus: await focusOf(app, undefined, await agentsPage(app)) }))

		const ran2 = second([])
		await until('the editor window to show', async () => (await ideWindows(app)).some(w => w.visible), { ms: 20000 }).catch(() => undefined)
		await sleep(1500)
		const afterPlain = await windows(app)
		step('RC03 insilode from a shell -> IDE shown', afterPlain.filter(w => w.ide).length === 1 && afterPlain.filter(w => w.ide).every(w => w.visible), JSON.stringify({ ran: ran2, windows: afterPlain }))
		console.log('screenshot:', await shot(app.pages().find(p => p.url().startsWith('vscode-file:')), 'r2-insilode-again'))

		// RC02: no agent runs, so closing the Agents window with the editor window hidden asks nothing and closes both.
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)
		await answer(app, '^Cancel')
		await closeWindow(app, (await agentsWindow(app)).id)
		const quit = await gone(app)
		step('RC02 hidden, 0 agents: IDE window closes without asking', quit, `quit: ${quit} (a question answered Cancel would have held it)`)
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 3: `--agents-only` with a maximized window state (RC05), then a renderer crash while hidden (RC03).
await part('RC05 insilode --agents-only, window state maximized', async () => {
	const { app } = await start('maximized', { args: ['--agents-only'], maximized: true })
	try {
		const t0 = Date.now()
		await until('the Agents window', () => agentsPage(app), { ms: 90000 })
		await sleep(Math.max(0, 15000 - (Date.now() - t0)))
		const rec = await recorded(app)
		const ws = await windows(app)
		const ide = ws.find(w => w.ide)
		const visibleSamples = rec.samples.filter(s => s.some(v => v)).length
		step('RC05 insilode --agents-only, window state maximized: IDE never visible, Agents window open', rec.samples.length >= 100 && visibleSamples === 0 && !rec.shows.some(s => s.id === ide?.id) && !!(await agentsPage(app)), JSON.stringify({ samples: rec.samples.length, visibleSamples, ideShowEvents: rec.shows.filter(s => s.id === ide?.id).length, windows: ws }))

		// The renderer of the hidden window dies: the window shows, and the state it was kept from is applied then.
		await answer(app, 'Reopen|New Window')
		await app.main(({ BrowserWindow }, id) => BrowserWindow.fromId(id).webContents.forcefullyCrashRenderer(), ide.id)
		await until('an editor window to show', async () => (await ideWindows(app)).some(w => w.visible), { ms: 60000 }).catch(() => undefined)
		await sleep(3000)
		const afterCrash = await ideWindows(app)
		const asked = (await recorded(app)).dialogs
		step('RC03 Reload Window / renderer crash -> IDE shown (the Agents window is not restored): crash', afterCrash.some(w => w.visible) && asked.length >= 1 && !(await agentsPage(app)), JSON.stringify({ afterCrash, asked }))
		// The crash box is asked about the hidden window itself, after it was shown: that window must be maximized by then, or the seed was not read.
		step('RC05 insilode --agents-only, window state maximized: the state is applied when the window shows (the seeded state was read)', asked[0]?.parentVisible === true && asked[0]?.parentMaximized === true, JSON.stringify(asked))
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 4: a normal start (RC05), the IDE visible (RC04, RC02), a second editor window (RC01), no Agents window (RC01).
await part('RC05 insilode', async () => {
	const { app } = await start('visible')
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		const rec = await recorded(app)
		const visible = rec.samples.filter(s => s.some(v => v)).length
		step('RC05 insilode: IDE visible, as today', visible > 0, `${visible} of ${rec.samples.length} samples had a visible editor window`)
		await sleep(5000)
		const win = await openAgents(app, page)
		for (let i = 0; i < 3; i++) {
			await runCommand(page, 'New Claude Agent')
			await sleep(1500)
		}
		await until('three agents ticking', async () => (await ticksIn(3000)) >= 8, { ms: 30000 }).catch(() => undefined)
		const ide = await ideOnly(app)
		const agentsId = (await agentsWindow(app)).id

		// RC04: with the editor window visible, everything stays where it was.
		await app.main(({ BrowserWindow }, id) => BrowserWindow.fromId(id).focus(), agentsId)
		await sleep(1000)
		const input = win.locator('.quick-input-widget .quick-input-box input')
		await win.keyboard.press('Control+P')
		const shown = await input.waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false)
		step('RC04 visible, Agents window focused: Ctrl+P -> Agents window (as today)', shown && (await quickInput(page)) === 0, JSON.stringify({ agents: shown, ide: await quickInput(page), focus: await focusOf(app, page, win) }))
		await win.keyboard.press('Escape')
		await runCommand(page, 'Probe: Toast')
		await until('a toast', async () => (await toasts(win)) + (await toasts(page)) > 0, { ms: 15000 }).catch(() => undefined)
		step('RC04 visible: a notification -> IDE window (as today)', (await toasts(page)) >= 1 && (await toasts(win)) === 0, `toasts: editor window ${await toasts(page)}, agents window ${await toasts(win)}`)

		// RC01: the Agents window belongs to window 1; closing window 2 closes it as today.
		await runCommand(page, 'New Window')
		await until('a second editor window', async () => (await ideWindows(app)).length === 2, { ms: 60000 })
		const second = (await ideWindows(app)).find(w => w.id !== ide.id)
		await closeWindow(app, second.id)
		await until('window 2 to close', async () => (await ideWindows(app)).length === 1, { ms: 20000 }).catch(() => undefined)
		const left = await ideWindows(app)
		step('RC01 open in IDE window 1: close IDE window 2 -> window 2 closes as today', left.length === 1 && left[0].id === ide.id && left[0].visible && !!(await agentsPage(app)), JSON.stringify(left))

		// RC02: the editor window is visible, so closing the Agents window asks nothing and the agents live on in the editor window.
		await answer(app, '^Cancel')
		const asked = (await recorded(app)).dialogs.length
		await closeWindow(app, agentsId)
		await until('the Agents window to close', async () => !(await agentsPage(app)), { ms: 15000 }).catch(() => undefined)
		const per4s = await ticksIn(4000)
		const questions = (await recorded(app)).dialogs.length - asked
		step('RC02 visible, 3 agents: Agents window closes without asking; agents keep running in the IDE', !(await agentsPage(app)) && questions === 0 && per4s >= 8 && (await ideWindows(app)).every(w => w.visible), JSON.stringify({ questions, ticksIn4s: per4s, windows: await ideWindows(app) }))

		// RC01: no Agents window now, so closing the editor window is what it always was.
		await closeWindow(app, ide.id)
		const quit = await gone(app)
		step('RC01 not open: close the IDE window -> closes as today', quit, `quit: ${quit}`)
	} finally {
		await app.close()
	}
})

// ---------------------------------------------------------------------------------------------------------------------------------------
// Run 5: Quit while the editor window is hidden and agents run (RC01): it asks nothing.
await part('RC01 open, Quit', async () => {
	const { app } = await start('quit')
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000)
		const win = await openAgents(app, page)
		await runCommand(page, 'New Claude Agent')
		await until('the fake agent ticking', async () => ticks() > 2, { ms: 30000 })
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)
		await answer(app, '^Cancel') // a question here would hold the quit: the step then fails
		const asked = (await recorded(app)).dialogs.length
		await win.keyboard.press('Control+Q')
		let how = 'Ctrl+Q in the Agents window'
		let quit = await gone(app, 12000)
		if (!quit) {
			how = 'Ctrl+Q did not quit; app.quit() instead'
			await app.main(({ app: electron }) => electron.quit()).catch(() => undefined)
			quit = await gone(app, 12000)
		}
		step('RC01 open, Quit (Ctrl+Q / Exit), agents live: quits without asking', quit, `${how}; quit: ${quit}${quit ? '' : `; questions asked: ${(await recorded(app)).dialogs.length - asked}`}`)
	} finally {
		await app.close()
	}
})

// Run 6: Quit with an unsaved file: the editor window shows and its save question asks there.
await part('RC01 open, Quit, unsaved file', async () => {
	const { app } = await start('quit-dirty', { settings: { 'files.hotExit': 'off' } })
	try {
		const page = await app.workbench()
		await dismissWelcome(page)
		await sleep(5000)
		await page.keyboard.press('Control+P')
		const input = page.locator('.quick-input-widget .quick-input-box input')
		await input.waitFor({ state: 'visible', timeout: 15000 })
		await input.fill('hello.txt')
		await sleep(1000)
		await page.keyboard.press('Enter')
		await page.locator('.monaco-editor .view-lines').first().click({ timeout: 20000 })
		await page.keyboard.type('x')
		const win = await openAgents(app, page)
		await runCommand(page, 'New Claude Agent')
		await until('the fake agent ticking', async () => ticks() > 2, { ms: 30000 })
		const ide = await ideOnly(app)
		await closeIde(app, ide.id)
		await answer(app, "Don.t Save")
		const asked = (await recorded(app)).dialogs.length
		await win.keyboard.press('Control+Q')
		await until('the save question', async () => (await recorded(app)).dialogs.length > asked, { ms: 20000 }).catch(() => undefined)
		const q = await newestAsk(app, asked)
		const quit = await gone(app, 20000)
		step('RC01 open, Quit (Ctrl+Q / Exit), agents live, unsaved files: the IDE shows and its save dialog asks there', !!q && q.parent === ide.id && q.parentVisible === true, JSON.stringify({ q, ideId: ide.id, quit }))
	} finally {
		await app.close()
	}
})

writeFileSync(join(out, 'agents-alone-results.json'), JSON.stringify(results, null, 2))
console.log(`${results.steps.filter(s => s.pass).length} of ${results.steps.length} steps passed`)
process.exit(results.steps.length > 0 && results.steps.every(s => s.pass) ? 0 : 1)
