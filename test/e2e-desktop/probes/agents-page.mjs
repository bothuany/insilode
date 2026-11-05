// The title bar's Agents button: VS Code's own "Open in Agents" button is gone, Insilode's Agents page button stands in its place
// (editor/patches/flow-core.patch adds the `titleBar/center` menu, flow-agent contributes the button), and it opens the page.
//   npm run docker:e2e -- --probe test/e2e-desktop/probes/agents-page.mjs
import { startInsilode, shot, tabTitles, until, sleep } from '/work/insilode/test/e2e-desktop/lib/probe.mjs'

const { app, page } = await startInsilode()
const failures = []
try {
	const bar = page.locator('.titlebar .center-adjacent-toolbar-container')
	await until('the title bar buttons beside the command center', async () => (await bar.count()) > 0, { ms: 30000 })
	// Extensions activate after the workbench: give the contribution a moment to land.
	await sleep(5000)
	const labels = await bar.locator('.action-item a, .action-item .action-label').evaluateAll(els => els.map(e => e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || ''))
	console.log('title bar buttons:', JSON.stringify(labels))
	console.log('screenshot:', await shot(page, 'agents-titlebar'))
	if (labels.some(l => /open in agents/i.test(l))) {
		failures.push('VS Code\'s "Open in Agents" button is still in the title bar')
	}
	const ours = bar.locator('.action-item a[aria-label*="Agents Page"], .action-item .action-label[aria-label*="Agents Page"]').first()
	if (!(await ours.count())) {
		failures.push('no "Open Agents Page" button in the title bar')
	} else {
		await ours.click()
		await until('the Agents page tab', async () => (await tabTitles(page)).some(t => /^Agents\b/.test(t.trim())), { ms: 20000 }).catch(e => failures.push(e.message))
		await sleep(2000)
		console.log('tabs:', JSON.stringify(await tabTitles(page)))
		console.log('screenshot:', await shot(page, 'agents-page'))
	}
} finally {
	await app.close()
}
if (failures.length) {
	console.log('FAILED:\n- ' + failures.join('\n- '))
	process.exitCode = 1
} else {
	console.log('OK: the title bar has the Agents page button, not VS Code\'s, and it opens the page')
}
