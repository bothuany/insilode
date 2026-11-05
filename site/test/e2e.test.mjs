// The site in a real browser (headless Chrome): the home page with its live canvas, tour and downloads, the Try page's stories and
// agents, and what search engines read. Run after `npm run build` (and `node scripts/site-data.mjs` before that): `npm run test:e2e`.
// It serves dist/ the way GitHub Pages does, at the root of the site (https://insilode.dev), and fails on any console error, 4xx/5xx response or page error. GitHub's
// API is answered from fixtures here (a rate-limited CI runner would otherwise get 403s), and one test makes it fail on purpose.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { preview } from 'vite'
import puppeteer from 'puppeteer-core'

// The address the build was made for (SITE_URL, as in vite.config.ts).
const SITE_URL = (process.env.SITE_URL || 'https://insilode.dev').replace(/\/$/, '')

const CHROMES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean)
const chrome = CHROMES.find(p => existsSync(p))
const skip = chrome ? false : 'no Chrome or Edge found (set CHROME_PATH)'
if (!chrome && process.env.CI) throw new Error('The end-to-end test needs Chrome in CI: none was found.')

const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'

/** What GitHub's API answers, in the shape it has. The asset names are the real ones of a release. */
const asset = (name, size) => ({ name, size, browser_download_url: `https://github.com/bothuany/insilode/releases/download/v9.9.9/${name}` })
const RELEASE = {
	tag_name: 'v9.9.9',
	published_at: '2026-10-20T10:00:00Z',
	html_url: 'https://github.com/bothuany/insilode/releases/tag/v9.9.9',
	assets: [asset('Insilode-Setup-9.9.9-x64.exe', 140_000_000), asset('Insilode-9.9.9-darwin-arm64.dmg', 160_000_000), asset('Insilode-9.9.9-darwin-x64.dmg', 165_000_000), asset('insilode_9.9.9_amd64.deb', 120_000_000), asset('insilode-9.9.9-1.x86_64.rpm', 121_000_000), asset('Insilode-9.9.9-linux-x64.tar.gz', 150_000_000), asset('SHA256SUMS.txt', 1000)],
}

let server
let browser
let url
const wait = ms => new Promise(r => setTimeout(r, ms))

before(async () => {
	if (skip) return
	server = await preview({ base: '/', preview: { port: 0, host: '127.0.0.1', strictPort: false } })
	url = `${server.resolvedUrls.local[0].replace(/\/$/, '')}/`
	browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-first-run', '--disable-gpu', '--no-sandbox'] })
})
after(async () => {
	await browser?.close()
	await server?.close()
})

/**
 * A page that remembers what went wrong in it: console errors, page errors, failed requests. GitHub's API answers from the fixtures,
 * or fails when `github` is false (then its failures are expected, not problems).
 */
async function open(path = '', { viewport = { width: 1440, height: 900 }, agent = WINDOWS, github = true } = {}) {
	// A context of its own: the page keeps GitHub's answers in localStorage, which must not carry over from one test to the next.
	const context = await browser.createBrowserContext()
	const page = await context.newPage()
	page.once('close', () => context.close())
	const problems = []
	await page.setUserAgent(agent)
	await page.setRequestInterception(true)
	page.on('request', r => {
		const u = r.url()
		if (!u.startsWith('https://api.github.com/')) return r.continue()
		if (!github) return r.respond({ status: 403, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"message":"API rate limit exceeded"}' })
		const body = u.endsWith('/releases/latest') ? RELEASE : { stargazers_count: 1234 }
		r.respond({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) })
	})
	page.on('console', m => m.type() === 'error' && !(github === false && /403|api\.github\.com/.test(m.text() + (m.location()?.url ?? ''))) && problems.push(`console: ${m.text()}`))
	page.on('pageerror', e => problems.push(`pageerror: ${e.message}`))
	page.on('response', r => r.status() >= 400 && !(github === false && r.url().startsWith('https://api.github.com/')) && problems.push(`${r.status()}: ${r.url()}`))
	await page.setViewport(viewport)
	await page.goto(url + path, { waitUntil: 'networkidle0', timeout: 120_000 })
	return { page, problems }
}

const until = async (probe, what, ms = 60_000) => {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) {
		try {
			const v = await probe()
			if (v) return v
		} catch { /* the page is changing */ }
		await wait(150)
	}
	assert.fail(`timed out waiting for ${what}`)
}
/** The page inside the iframe that is in `selector`. */
const inside = async (page, selector) => {
	const handle = await until(() => page.$(selector), `${selector} to exist`)
	return until(() => handle.contentFrame(), `${selector} to load`)
}
const drawn = frame => until(() => frame.evaluate(() => !!document.querySelector('.react-flow__node')), 'the canvas to draw a card')
const textOf = frame => frame.evaluate(() => document.body.innerText)
/** The step the tour shows: its caption title, and whether the caption sits by a card (not centred for want of one). */
const caption = frame => frame.evaluate(() => {
	const c = document.querySelector('.tour-caption')
	return c && { title: c.querySelector('.tour-caption-head b')?.textContent, side: c.getAttribute('data-side') }
})
const tours = JSON.parse(readFileSync(new URL('../public/data/demo.json', import.meta.url), 'utf8')).tours

/** Plays a tour to its end with the tour bar's next button, checking that every step stands by its card. */
async function walk(frame, tour) {
	for (const [i, step] of tour.steps.entries()) {
		await until(async () => (await caption(frame))?.title === step.title, `step ${i + 1} of "${tour.title}" ("${step.title}")`)
		assert.notEqual((await caption(frame)).side, 'centre', `step ${i + 1} of "${tour.title}" stands by its card`)
		if (i < tour.steps.length - 1) await frame.click('.tour button[title^="Next step"]')
	}
}

test('home: the hero canvas loads on its own, a plain wheel scrolls the page past it, and the tour plays', { skip }, async () => {
	const { page, problems } = await open()
	assert.equal(await page.evaluate(() => !!document.querySelector('.stage-poster')), true, 'a poster stands in first')
	const canvas = await inside(page, '.stage-frame')
	await drawn(canvas)
	await until(() => page.evaluate(() => document.querySelector('[data-stage]').classList.contains('is-live')), 'the poster to give way to the canvas')
	assert.equal(await page.evaluate(() => document.querySelector('.stage-frame').tabIndex), -1, 'the hero canvas is not in the tab order')

	// The editor window comes first, the live canvas under it: bring the canvas on screen. A wheel over it scrolls the page, not the canvas.
	await page.evaluate(() => document.querySelector('[data-stage]').scrollIntoView({ block: 'center' }))
	await wait(300)
	const top = await page.evaluate(() => scrollY)
	const box = await (await page.$('.stage-frame')).boundingBox()
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
	const zoom = () => canvas.evaluate(() => getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
	const before = await zoom()
	await page.mouse.wheel({ deltaY: 400 })
	await until(() => page.evaluate(top => scrollY > top + 200, top), 'the page to scroll')
	assert.equal(await zoom(), before, 'the canvas did not zoom')
	await page.evaluate(() => document.querySelector('[data-stage]').scrollIntoView({ block: 'center' }))

	await page.click('[data-play="order"]')
	await walk(canvas, tours.find(t => t.id === 'order'))
	assert.deepEqual(problems, [])
	await page.close()
})

test('home: the first screen says it is a code editor built on VS Code, and the editor window leads to the demo', { skip }, async () => {
	const { page, problems } = await open()
	assert.equal(await page.$eval('h1', h => h.textContent.replace(/\s+/g, ' ')), 'Every code editor shows your files. Insilode shows how your code runs.')
	assert.equal(await page.$eval('h1 .accent', b => b.textContent), 'Insilode', 'the name stands out in the headline')
	// Both faces are self-hosted: loading them must find a face from the site itself.
	assert.deepEqual(await page.evaluate(async () => [(await document.fonts.load('650 40px "Instrument Sans"')).length > 0, (await document.fonts.load('14px "JetBrains Mono"')).length > 0]), [true, true], 'the self-hosted fonts load')
	assert.match(await page.$eval('.hero .lede', p => p.textContent), /Built on VS Code/)
	assert.equal(await page.$eval('.shot-window', a => new URL(a.href).pathname), '/try/')
	// The hero loop: muted and inline (so it may start on its own), playing once on screen, from files the site serves.
	const loop = await until(() => page.$eval('.shot video', v => !v.paused && v.readyState >= 2 && { muted: v.muted, inline: v.playsInline, loop: v.loop, src: v.currentSrc.split('/').pop() }), 'the hero loop to play')
	assert.deepEqual(loop, { muted: true, inline: true, loop: true, src: 'hero-loop.webm' })
	assert.match(await page.$eval('.works', l => l.textContent), /Claude Code.*Codex/s, 'the agents are named under the hero')
	assert.match(await page.$eval('#vscode', s => s.textContent), /fork of VS Code.*Open VSX/s)
	assert.deepEqual(problems, [])
	await page.close()
})

test('home: under reduced motion the hero loop stays on its poster and loads nothing', { skip }, async () => {
	const { page, problems } = await open()
	await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
	await page.reload({ waitUntil: 'networkidle0' })
	await wait(1200)
	assert.deepEqual(await page.$eval('.shot video', v => ({ paused: v.paused, poster: v.poster.split('/').pop(), loaded: v.readyState })), { paused: true, poster: 'hero-loop-poster.webp', loaded: 0 })
	assert.deepEqual(problems, [])
	await page.close()
})

test('home: the film plays with its sound only when asked, in a modal that Esc and a click outside close', { skip }, async () => {
	const { page, problems } = await open()
	const state = () => page.evaluate(() => {
		const d = document.querySelector('[data-film]')
		const v = d.querySelector('video')
		return { open: d.open, paused: v.paused, muted: v.muted, time: v.currentTime, loaded: v.readyState, focus: document.activeElement?.className ?? '' }
	})
	// Nothing of the film loads, let alone plays, until the visitor asks for it.
	assert.deepEqual(await state(), { open: false, paused: true, muted: false, time: 0, loaded: 0, focus: '' })
	await page.click('[data-film-open]')
	const playing = await until(async () => { const s = await state(); return s.open && !s.paused && s.time > 0.3 && s }, 'the film to play')
	assert.equal(playing.muted, false, 'with its sound, after the click')
	assert.equal(playing.focus, 'film-close', 'focus moves into the dialog')
	await page.keyboard.press('Escape')
	await until(async () => { const s = await state(); return !s.open && s.paused }, 'Esc to close it and stop the film')
	const closed = await state()
	assert.deepEqual({ ...closed, loaded: undefined }, { open: false, paused: true, muted: false, time: 0, loaded: undefined, focus: 'film-open' }, 'closing stops and rewinds it, and gives the focus back')
	// A click outside the player (on the backdrop) closes it too.
	await page.click('[data-film-open]')
	await until(async () => (await state()).open, 'the film to open again')
	// Selecting transcript text and letting go outside the player is not a click outside: it stays open.
	await page.click('.film-transcript summary')
	const text = await page.$eval('.film-transcript p', p => { p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 } })
	await page.mouse.move(text.x, text.y)
	await page.mouse.down()
	await page.mouse.move(4, 4, { steps: 8 })
	await page.mouse.up()
	await wait(300)
	assert.equal((await state()).open, true, 'a drag that ends on the backdrop does not close the film')
	await page.mouse.click(4, 4)
	await until(async () => { const s = await state(); return !s.open && s.paused }, 'a click outside to close it')
	assert.equal((await state()).paused, true)
	assert.deepEqual(problems, [])
	await page.close()
})

test('home: the download button names the visitor\'s system and points at its file; the stars are counted', { skip }, async () => {
	const { page, problems } = await open()
	const primary = () => page.$eval('.hero [data-download]', a => ({ text: a.textContent, href: a.href }))
	await until(async () => (await primary()).href.endsWith('.exe'), 'the button to point at the installer')
	assert.deepEqual(await primary(), { text: 'Download for Windows', href: RELEASE.assets[0].browser_download_url })
	assert.match(await page.$eval('.hero [data-platforms]', p => p.textContent), /^Version 9\.9\.9, free and open source\. Also for macOS and Linux\.$/)
	assert.equal(await page.$eval('.nav [data-stars]', s => (s.hidden ? '' : s.textContent)), '1,234')
	const list = await page.$$eval('[data-download-list] li a', as => as.map(a => a.href.split('/').pop()))
	assert.deepEqual(list, ['Insilode-Setup-9.9.9-x64.exe', 'Insilode-9.9.9-darwin-arm64.dmg', 'Insilode-9.9.9-darwin-x64.dmg', 'insilode_9.9.9_amd64.deb', 'insilode-9.9.9-1.x86_64.rpm', 'Insilode-9.9.9-linux-x64.tar.gz'])
	assert.match(await page.$eval('[data-release]', p => p.textContent), /^Version 9\.9\.9, released October 20, 2026\.$/)
	await page.close()

	// A Mac gets the Apple silicon image first.
	const mac = await open('', { agent: MAC })
	await until(async () => (await mac.page.$eval('.hero [data-download]', a => a.href)).endsWith('darwin-arm64.dmg'), 'the Mac button to point at the .dmg')
	assert.equal(await mac.page.$eval('.hero [data-download]', a => a.textContent), 'Download for macOS')
	await mac.page.close()
	assert.deepEqual([...problems, ...mac.problems], [])
})

test('home: when GitHub does not answer, the buttons lead to the releases page and no count is shown', { skip }, async () => {
	const { page, problems } = await open('', { github: false })
	await wait(1500)
	assert.equal(await page.$eval('.hero [data-download]', a => a.href), 'https://github.com/bothuany/insilode/releases/latest')
	assert.equal(await page.$eval('.nav [data-stars]', s => s.hidden), true)
	assert.ok((await page.$$eval('[data-download-list] li a', as => as.map(a => a.href))).every(h => h === 'https://github.com/bothuany/insilode/releases/latest'))
	assert.deepEqual(problems, [])
	await page.close()
})

test('home: the harness section is the real scan of the demo project, with its one warning', { skip }, async () => {
	const { page, problems } = await open()
	await page.evaluate(() => document.querySelector('[data-harness]').scrollIntoView())
	await until(() => page.$('.hx-table'), 'the harness scan')
	assert.equal(await page.$eval('.hx-score b', b => b.textContent), '96')
	assert.match(await page.$eval('.hx-issues', l => l.textContent), /graphql-schema\.md.*matches no file in the project/)
	assert.equal(await page.$$eval('[data-clip] img', imgs => imgs.length), 3, 'the three stills are in their slots')
	assert.deepEqual(problems, [])
	await page.close()
})

test('home between a phone and a desktop: the canvas fills its frame, but never zooms out below readable cards', { skip }, async () => {
	const { page, problems } = await open('', { viewport: { width: 900, height: 900 } })
	const canvas = await inside(page, '.stage-frame')
	await drawn(canvas)
	await until(() => page.evaluate(() => document.querySelector('[data-stage]').classList.contains('is-live')), 'the canvas to be filled and shown')
	const zoom = await canvas.evaluate(() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.react-flow__viewport')).transform).a)
	// READABLE_ZOOM in site/src/stage.ts and ui/src/webview.tsx; a wheel step lands within a few percent of it.
	assert.ok(zoom >= 0.55 * 0.97, `zoom ${zoom} is readable`)
	// The flow's first card (its entry point) is in the frame.
	const first = await canvas.evaluate(() => {
		const area = document.querySelector('.react-flow').getBoundingClientRect()
		const cards = [...document.querySelectorAll('.react-flow__node-card')].map(n => n.getBoundingClientRect())
		const left = cards.sort((a, b) => a.left - b.left)[0]
		return left && left.left >= area.left - 1 && left.top >= area.top - 1 && left.left < area.right && left.top < area.bottom
	})
	assert.equal(first, true, 'the entry card is on screen')
	if (process.env.SITE_SHOTS) await page.screenshot({ path: `${process.env.SITE_SHOTS}/home-900px-canvas.png` })
	assert.deepEqual(problems, [])
	await page.close()
})

test('home on a phone: no canvas until asked, then full screen; the page has no sideways scroll', { skip }, async () => {
	const { page, problems } = await open('', { viewport: { width: 375, height: 812, isMobile: true, hasTouch: true }, agent: PHONE })
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 375)
	// Most of the hero loop is in the first screen of a 375x812 phone: at least 300 px of it above the fold (the loop is about 357 px tall).
	await page.evaluate(() => document.fonts.ready)
	const fold = await page.$eval('.shot video', v => ({ top: Math.round(v.getBoundingClientRect().top + scrollY), screen: innerHeight }))
	assert.equal(fold.screen, 812)
	assert.ok(fold.top + 300 <= fold.screen, `the hero loop starts at ${fold.top} px: too low for the first screen of a phone`)
	assert.equal(await page.$eval('.shot video', v => v.poster.split('/').pop()), 'hero-loop-narrow-poster.webp', 'a phone gets the crop of the window')
	await wait(1500)
	assert.equal(await page.$('.stage-frame'), null, 'the phone loads no canvas by itself')
	assert.equal(await page.$eval('.hero [data-download]', a => a.getAttribute('href')), '#download', 'a phone is sent to the list of files')
	await page.click('[data-explore]')
	const canvas = await inside(page, '.stage-frame')
	await drawn(canvas)
	assert.equal(await page.evaluate(() => document.querySelector('[data-stage]').classList.contains('is-full') && document.activeElement?.matches('[data-close]')), true)
	// Full screen is the whole screen, not the 3/4 box the stage has in the page.
	const box = await page.$eval('[data-stage]', s => { const r = s.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } })
	assert.deepEqual(box, { left: 0, top: 0, width: 375, height: 812 }, 'the full-screen canvas covers the phone\'s screen')
	if (process.env.SITE_SHOTS) await page.screenshot({ path: `${process.env.SITE_SHOTS}/phone-full-screen-canvas.png` })
	await page.keyboard.press('Escape')
	assert.equal(await page.evaluate(() => document.querySelector('[data-stage]').classList.contains('is-full')), false)
	assert.deepEqual(problems, [])
	await page.close()
})

test('try: the order tour, the agent\'s change with its review and Keep, and the invoice tour', { skip }, async () => {
	const { page, problems } = await open('try/')
	const canvas = async () => {
		const c = await inside(page, '.stage-frame')
		await drawn(c)
		return c
	}
	// Without a story in the address the canvas waits on the order flow; the button plays its tour.
	await canvas()
	assert.equal(await caption(await canvas()), null, 'no tour plays by itself')
	await page.click('[data-play-story]')
	await walk(await canvas(), tours.find(t => t.id === 'order'))

	await page.click('[data-story="changes"]')
	await until(async () => /Claude Code: discount codes on orders/.test(await textOf(await inside(page, '.stage-frame'))), 'the change set')
	const changes = await canvas()
	await until(() => changes.$('.tour'), 'the review of the changes to start')
	await until(() => changes.evaluate(() => {
		const keep = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Keep')
		keep?.click()
		return !!keep
	}), 'a Keep button')
	await until(async () => /^Kept\./.test(await page.$eval('[data-decision]', p => p.textContent)), 'the page to say it was kept')

	await page.click('[data-story="invoice"]')
	await until(async () => (await caption(await inside(page, '.stage-frame')))?.title === 'A Java endpoint', 'the invoice tour')
	await walk(await canvas(), tours.find(t => t.id === 'invoice'))
	assert.deepEqual(problems, [])
	await page.close()
})

test('try: the page and its canvas do not shift as they load (CLS under 0.1 on a phone and a desktop)', { skip }, async () => {
	for (const viewport of [{ width: 412, height: 823, isMobile: true, hasTouch: true }, { width: 1440, height: 900 }]) {
		const context = await browser.createBrowserContext()
		const page = await context.newPage()
		await page.setRequestInterception(true)
		page.on('request', r => (r.url().startsWith('https://api.github.com/') ? r.abort() : r.continue()))
		// Every document (the page and the canvas iframe) adds up its own layout shifts, as Lighthouse counts them.
		await page.evaluateOnNewDocument(() => {
			window.__cls = 0
			new PerformanceObserver(list => {
				for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value
			}).observe({ type: 'layout-shift', buffered: true })
		})
		await page.setViewport(viewport)
		await page.goto(`${url}try/`, { waitUntil: 'networkidle0' })
		await drawn(await inside(page, '.stage-frame'))
		// The bar fills in after the flow (impact, the status note that comes and goes): wait past that.
		await wait(5000)
		const shifts = {}
		for (const frame of page.frames()) {
			const cls = await frame.evaluate(() => window.__cls).catch(() => undefined)
			if (cls !== undefined) shifts[frame === page.mainFrame() ? 'page' : frame.url().split('/').pop().split('?')[0]] = Math.round(cls * 1000) / 1000
		}
		assert.ok(shifts.page !== undefined && shifts['canvas.html'] !== undefined, `both documents were measured: ${JSON.stringify(shifts)}`)
		for (const [doc, cls] of Object.entries(shifts)) assert.ok(cls < 0.1, `${doc} at ${viewport.width}px shifts by ${cls} as it loads`)
		await context.close()
	}
})

test('try: a link to a story plays it at once', { skip }, async () => {
	const { page, problems } = await open('try/#invoice')
	await until(async () => (await caption(await inside(page, '.stage-frame')))?.title === 'A Java endpoint', 'the invoice tour')
	assert.equal(await page.$eval('[data-story="invoice"]', b => b.getAttribute('aria-pressed')), 'true')
	assert.deepEqual(problems, [])
	await page.close()
})

test('try: the dock ranks the waiting agent first, and allowing it moves it on', { skip }, async () => {
	const { page, problems } = await open('try/')
	const dock = await inside(page, 'iframe.dock')
	await until(() => dock.evaluate(() => document.querySelectorAll('.agent').length === 3), 'three agents in the dock')
	assert.match(await dock.evaluate(() => document.querySelector('.agent').textContent), /Codex.*Run pytest billing-service\/tests/s)
	assert.match(await textOf(dock), /This turn touched 4 flows and table orders \(4 endpoints\)/)
	await until(async () => /Needs approval/.test(await textOf(await inside(page, 'iframe.island'))), 'the island to say an agent needs approval')
	await page.click('[data-allow]')
	await until(() => dock.evaluate(() => !/APPROVAL/i.test(document.querySelector('.agent.blocked')?.textContent ?? '') && !document.querySelector('.agent.approval')), 'the approval to be answered')
	assert.deepEqual(problems, [])
	await page.close()
})

test('docs: the documents of the repository are pages of the site, linked to each other, with the rest on GitHub', { skip }, async () => {
	const { page, problems } = await open()
	await page.click('.nav-links a[href="./docs/"]')
	await page.waitForSelector('.doc-body')
	assert.equal(await page.$eval('h1', h => h.textContent), 'Overview')
	assert.deepEqual(await page.$$eval('.doc-nav a', as => as.map(a => a.textContent)), ['Overview', 'Install and build', 'Languages', 'Agent tools', 'Boards', 'Privacy'])
	// A link between documents stays on the site; a link to another file of the repository goes to GitHub.
	const links = await page.$$eval('.doc-body a', as => as.map(a => a.href))
	assert.ok(links.some(h => h.endsWith('/docs/languages/')), 'the support table link opens the Languages page')
	assert.ok(links.some(h => h === 'https://github.com/bothuany/insilode/blob/main/CONTRIBUTING.md'))
	await page.click('.doc-nav a[href$="docs/languages/"]')
	await page.waitForFunction(() => document.querySelector('h1')?.textContent === 'Languages')
	assert.match(await page.$eval('.doc-body', b => b.textContent), /Tables and entities/)
	assert.equal(await page.$eval('#tables-and-entities', h => h.tagName), 'H2', 'headings carry their anchors')
	assert.deepEqual(problems, [])
	await page.close()
})

test('try: the agents can be drawn in either avatar style of the app', { skip }, async () => {
	const { page, problems } = await open('try/')
	const dock = await inside(page, 'iframe.dock')
	await until(() => dock.evaluate(() => document.querySelectorAll('.agent').length === 3), 'three agents in the dock')
	const avatars = () => dock.evaluate(() => [...document.querySelectorAll('.agent .av')].map(a => a.getAttribute('data-k')).join(' '))
	assert.match(await avatars(), /\|gyro\|/)
	await page.click('input[value="pixel"]')
	await until(async () => /\|pixel\|/.test(await avatars()), 'the dock to draw pixel avatars')
	assert.deepEqual(problems, [])
	await page.close()
})

test('the pages can be found: every page in the sitemap has its title, description, canonical address and social card; robots.txt points at the sitemap', { skip }, async () => {
	// The sitemap lists every page, and each of them is checked: a page missing from it, or missing a tag, fails here.
	const sitemap = await fetch(new URL('sitemap.xml', url))
	assert.equal(sitemap.status, 200, 'sitemap.xml is served')
	const listed = [...(await sitemap.text()).matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1])
	const pages = ['', 'try/', 'docs/', 'docs/agent-tools/', 'docs/boards/', 'docs/install/', 'docs/languages/', 'docs/privacy/']
	assert.deepEqual([...listed].sort(), pages.map(p => `${SITE_URL}/${p}`).sort())
	const robots = await fetch(new URL('robots.txt', url))
	assert.equal(robots.status, 200, 'robots.txt is served')
	const rules = await robots.text()
	assert.match(rules, /^User-agent: \*$/m)
	assert.doesNotMatch(rules, /^Disallow: \/$/m, 'nothing is shut out')
	assert.ok(rules.split('\n').includes(`Sitemap: ${SITE_URL}/sitemap.xml`), 'robots.txt names the sitemap')

	const titles = new Set()
	for (const path of pages) {
		const { page, problems } = await open(path)
		const head = await page.evaluate(() => {
			const meta = s => document.querySelector(s)?.getAttribute('content') ?? ''
			return {
				lang: document.documentElement.lang,
				title: document.title,
				description: meta('meta[name="description"]'),
				canonical: document.querySelector('link[rel="canonical"]')?.href,
				robots: meta('meta[name="robots"]'),
				csp: meta('meta[http-equiv="Content-Security-Policy"]'),
				ogUrl: meta('meta[property="og:url"]'),
				ogTitle: meta('meta[property="og:title"]'),
				ogDescription: meta('meta[property="og:description"]'),
				ogImage: meta('meta[property="og:image"]'),
				twitterCard: meta('meta[name="twitter:card"]'),
				twitterImage: meta('meta[name="twitter:image"]'),
				h1: document.querySelectorAll('h1').length,
			}
		})
		assert.equal(head.lang, 'en')
		assert.ok(head.title.length >= 20 && head.title.length <= 60, `"${head.title}" fits a search result`)
		assert.ok(!titles.has(head.title), `/${path} has a title of its own`)
		titles.add(head.title)
		assert.ok(head.description.length >= 70 && head.description.length <= 155, `the description of /${path} fits a search result (${head.description.length} characters)`)
		assert.equal(head.canonical, `${SITE_URL}/${path}`)
		assert.doesNotMatch(head.robots, /noindex/, `/${path} may be indexed`)
		assert.equal(head.ogUrl, head.canonical)
		assert.ok(head.ogTitle && head.ogDescription, `/${path} has an Open Graph title and description`)
		assert.equal(head.ogImage, `${SITE_URL}/media/og.jpg`)
		assert.equal(head.twitterCard, 'summary_large_image')
		assert.equal(head.twitterImage, head.ogImage)
		assert.match(head.csp, /default-src 'none'/)
		assert.equal(head.h1, 1)
		assert.doesNotMatch(await page.content(), /\{\{(name|site|repo|version)\}\}/, 'every placeholder is filled')
		assert.deepEqual(problems, [])
		await page.close()
	}
	// The social card is a 1200x630 JPEG the site serves: read its size from the JPEG's frame header.
	const card = Buffer.from(await (await fetch(new URL('media/og.jpg', url))).arrayBuffer())
	let i = 2
	while (i < card.length && !(card[i] === 0xff && card[i + 1] >= 0xc0 && card[i + 1] <= 0xc2)) i += 2 + card.readUInt16BE(i + 2)
	assert.deepEqual([card.readUInt16BE(i + 7), card.readUInt16BE(i + 5)], [1200, 630], 'og.jpg is 1200x630')
	for (const part of ['canvas.html', 'pages/dock.html', 'pages/agents.html', 'pages/island.html']) {
		assert.match(await (await fetch(new URL(part, url))).text(), /<meta name="robots" content="noindex"/, `${part} asks not to be indexed`)
	}
})

test('the home page describes the product for search engines: structured data and crawlable text', { skip }, async () => {
	const { page, problems } = await open()
	const graph = await page.$eval('script[type="application/ld+json"]', s => JSON.parse(s.textContent)['@graph'])
	const local = address => address.replace(SITE_URL + '/', url)
	const app = graph.find(n => n['@type'] === 'SoftwareApplication')
	assert.equal(app.applicationCategory, 'DeveloperApplication')
	assert.match(app.softwareVersion, /^\d+\.\d+\.\d+$/)
	assert.match(app.license, /agpl/)
	assert.equal(app.offers.price, '0')
	assert.equal((await fetch(local(app.screenshot))).status, 200, 'the screenshot is served')
	const org = graph.find(n => n['@type'] === 'Organization')
	assert.equal((await fetch(local(org.logo))).status, 200, 'the logo is served')
	assert.ok(graph.some(n => n['@type'] === 'WebSite'))
	// What it is, in the HTML itself, not only in the video or the scripts.
	const text = await page.evaluate(() => document.querySelector('main').innerText)
	for (const term of ['code editor', 'VS Code', 'Code - OSS', 'Open VSX', 'call-flow canvas', 'Claude Code', 'Codex', 'Spring', 'FastAPI', 'NestJS', 'Go', 'Rust', 'PHP', 'Ruby', '.NET']) {
		assert.ok(text.includes(term), `the home page says "${term}"`)
	}
	assert.deepEqual(problems, [])
	await page.close()
})

test('a keyboard user can skip to the content, and every image says what it shows', { skip }, async () => {
	const { page, problems } = await open()
	await page.keyboard.press('Tab')
	assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to the content')
	await page.evaluate(() => document.querySelector('[data-clip]').scrollIntoView())
	await wait(300)
	const unnamed = await page.$$eval('img', imgs => imgs.filter(i => !i.hasAttribute('alt')).map(i => i.src))
	assert.deepEqual(unnamed, [])
	assert.deepEqual(problems, [])
	await page.close()
})
