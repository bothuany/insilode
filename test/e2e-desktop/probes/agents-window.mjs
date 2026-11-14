// The Agents page in its own window (flow.agents.page.location = "window", the default): a compact auxiliary window that core makes for
// the page (_insilode.agents.openWindow, editor/patches/flow-core.patch) and that shows only the page. It checks that the window has no
// editor tabs, breadcrumbs, status bar or command centre, that the page is not a tab of the main window, that a file opened from inside
// the window opens in the main window, that the window is not left by the compact toggle, and that opening the page again makes no second window.
//   npm run docker:e2e -- --probe test/e2e-desktop/probes/agents-window.mjs
// Written from reading the core code, not yet run (nothing here opens a window on the developer's machine): the first run may need its selectors adjusted.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInsilode, shot, runCommand, tabTitles, until, sleep } from '/work/insilode/test/e2e-desktop/lib/probe.mjs'

const folder = join(realpathSync(mkdtempSync(join(tmpdir(), 'insilode-agents-window-'))), 'project')
mkdirSync(folder)
writeFileSync(join(folder, 'hello.txt'), 'hello from the probe\n')
const { app, page } = await startInsilode({ folder })
const failures = []
/** Every window except the main one and the status island's (a data: page). */
const others = () => app.pages().filter(p => p !== page && !p.url().startsWith('data:text/html'))
/** The frame of the Agents page: a webview nested in iframes, so look for the sidebar rather than depend on the depth. */
const pageFrame = async win => {
	for (const f of win.frames()) {
		try {
			if (await f.locator('nav.side').count()) {
				return f
			}
		} catch {
			// a frame that navigates while we ask
		}
	}
	return undefined
}
try {
	await sleep(5000) // the extensions activate after the workbench
	await runCommand(page, 'Open Agents Page')
	await until('the Agents window', async () => (await Promise.all(others().map(pageFrame))).some(Boolean), { ms: 30000 }).catch(e => failures.push(e.message))
	const win = others()[0]
	if (!win) {
		failures.push('no second window opened')
	} else {
		await win.waitForLoadState('domcontentloaded').catch(() => undefined)
		await sleep(2000)
		console.log('screenshot:', await shot(win, 'agents-window'))
		const visible = async selector => (await win.locator(selector).evaluateAll(els => els.filter(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).display !== 'none').length))
		for (const [what, selector] of [
			['editor tabs', '.tabs-container .tab'],
			['breadcrumbs', '.breadcrumbs-control'],
			['the status bar', '.part.statusbar'],
			['the command center', '.command-center'],
			['an editor title row', '.editor-group-container > .title'],
			['the compact toggle', '[aria-label*="Compact Mode"]'],
		]) {
			if (await visible(selector)) {
				failures.push(`the Agents window shows ${what} (${selector})`)
			}
		}
		if (!(await win.locator('.titlebar-container').count())) {
			failures.push('the Agents window has no title bar')
		}
		console.log('window title:', JSON.stringify(await win.title()))
		if ((await tabTitles(page)).some(t => /^Agents\b/.test(t.trim()))) {
			failures.push('the Agents page is also a tab of the main window')
		}
		// A file opened by a command that does not name a group must open in the main window, even with the focus in the Agents window.
		await win.bringToFront().catch(() => undefined)
		await win.keyboard.press('Control+P')
		const input = win.locator('.quick-input-widget .quick-input-box input')
		await input.waitFor({ state: 'visible', timeout: 15000 }).catch(e => failures.push('quick open did not show in the Agents window: ' + e.message))
		await input.fill('hello.txt').catch(() => undefined)
		await sleep(1000)
		await win.keyboard.press('Enter')
		await until('hello.txt in the main window', async () => (await tabTitles(page)).some(t => /hello\.txt/.test(t)), { ms: 15000 }).catch(e => failures.push(e.message))
		if (await visible('.tabs-container .tab, .monaco-editor')) {
			failures.push('hello.txt opened in the Agents window')
		}
		// The page again: the same window, not a second one. With an empty group added to the main window first (which shifts the groups'
		// indexes), the page must still be in its window and not be moved into the main one.
		await page.bringToFront().catch(() => undefined)
		await runCommand(page, 'View: Split Editor Right').catch(e => failures.push('could not split the main editor: ' + e.message))
		await sleep(1000)
		await runCommand(page, 'Open Agents Page')
		await sleep(2000)
		if (others().length !== 1) {
			failures.push(`opening the page again left ${others().length} extra windows (expected the one)`)
		}
		if (!(await pageFrame(others()[0] ?? win))) {
			failures.push('the Agents page is no longer in its window after it was opened again beside a new group')
		}
		if ((await tabTitles(page)).some(t => /^Agents\b/.test(t.trim()))) {
			failures.push('opening the page again moved it into the main window as a tab')
		}
		// Turning compact mode off by the command must change nothing.
		await win.keyboard.press('Control+Shift+P')
		await win.locator('.quick-input-widget .quick-input-box input').fill('>Toggle Window Compact Mode').catch(() => undefined)
		await sleep(500)
		await win.keyboard.press('Enter')
		await sleep(1000)
		if (await visible('.part.statusbar, .tabs-container .tab')) {
			failures.push('the compact toggle left compact mode in the Agents window')
		}
		console.log('screenshot:', await shot(win, 'agents-window-after'))
	}
} finally {
	await app.close()
}
if (failures.length) {
	console.log('FAILED:\n- ' + failures.join('\n- '))
	process.exitCode = 1
} else {
	console.log('OK: the Agents page is a chrome-less window of its own that other editors stay out of')
}
