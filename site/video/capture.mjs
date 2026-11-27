// Records the footage of the home page's four feature loops (README.md): the site's real canvas (canvas.html, ui/ on the fake host)
// and the app's Agents page (on the Try page), driven headless the way a visitor drives them. Nothing here draws UI: every frame
// is the page itself, recorded with Chrome's screencast at 2x.
//   node video/capture.mjs [site build dir] [work dir]
// The build dir defaults to site/dist (`npm run build` first) and is served the way GitHub Pages serves it, at the root. Each shot
// goes to <work>/capture/<shot>.mp4 (30 fps, near lossless) with <shot>.json: when each key or click happened (seconds from the
// first frame) and the boxes of what it acted on, for the camera in build.mjs.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import { preview } from 'vite'

const site = fileURLToPath(new URL('..', import.meta.url))
const dist = resolve(process.argv[2] ?? join(site, 'dist'))
const work = resolve(process.argv[3] ?? join(tmpdir(), 'insilode-loops'))
const only = process.argv.slice(4)
const out = join(work, 'capture')
mkdirSync(out, { recursive: true })

// The pages are laid out at 1440x900 CSS px (16:10, the loops' shape; narrower, the canvas's title bar and the Agents page's wrap
// onto a second line) and painted at 2x, so the 1600x1000 loops can push in up to 1.8x without upscaling.
const VIEW = { width: 1440, height: 900, dpr: 2 }
const CHROMES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean)
const chrome = CHROMES.find(p => existsSync(p))
if (!chrome) throw new Error('No Chrome or Edge found: set CHROME_PATH.')

const wait = ms => new Promise(r => setTimeout(r, ms))
const pad = n => String(n).padStart(5, '0')
const ffmpeg = (...args) => {
	const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
	if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed`)
}
async function until(probe, what, ms = 20_000) {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) {
		const v = await probe()
		if (v) return v
		await wait(100)
	}
	throw new Error(`Timed out waiting for ${what}`)
}

const server = await preview({ root: site, base: '/', build: { outDir: dist }, preview: { port: 0, host: '127.0.0.1', strictPort: false } })
const base = `${server.resolvedUrls.local[0].replace(/\/$/, '')}/`
// The screencast sends frames at the window's own scale, not the page's emulated one: the window itself must paint at 2x.
const browser = await puppeteer.launch({
	executablePath: chrome,
	headless: true,
	defaultViewport: null,
	args: [`--window-size=${VIEW.width},${VIEW.height}`, `--force-device-scale-factor=${VIEW.dpr}`, '--hide-scrollbars', '--no-first-run', '--disable-gpu', '--no-sandbox'],
})
const data = JSON.parse(readFileSync(join(dist, 'data', 'demo.json'), 'utf8'))

/** A new page at the capture's size that reports its page errors. */
async function newPage() {
	const page = await browser.newPage()
	await page.setViewport({ width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.dpr })
	page.on('pageerror', e => console.warn(`page error: ${e.message}`))
	// GitHub's API (the Try page's star count) is not part of any shot: it is not asked, so the run needs no network.
	await page.setRequestInterception(true)
	page.on('request', r => (r.url().startsWith('https://api.github.com/') ? r.abort() : r.continue()))
	return page
}

/** canvas.html with a query, once its cards are drawn and its own fit (an animation) is over. */
async function canvas(query) {
	const page = await newPage()
	await page.goto(`${base}canvas.html${query}`, { waitUntil: 'networkidle0' })
	await page.waitForSelector('.react-flow__node')
	await wait(2500)
	return page
}

/**
 * Records `page` while `run` acts on it. Chrome sends a frame only when the page changes, stamped with the time it was painted, so
 * every frame lasts until the next one (the last until the recording stops) and ffmpeg makes 30 fps of that.
 */
async function record(page, name, run) {
	const dir = join(out, name)
	mkdirSync(dir, { recursive: true })
	const cdp = await page.createCDPSession()
	const stamps = []
	cdp.on('Page.screencastFrame', f => {
		const n = stamps.push(f.metadata.timestamp)
		writeFileSync(join(dir, `f${pad(n)}.jpg`), Buffer.from(f.data, 'base64'))
		cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
	})
	await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width * VIEW.dpr, maxHeight: VIEW.height * VIEW.dpr, everyNthFrame: 1 })
	await until(() => stamps.length, 'the first frame')
	const t0 = stamps[0]
	const marks = {}
	const rects = {}
	await run({
		// The frame stamps are wall-clock seconds, like Date.now().
		mark: what => (marks[what] = +(Date.now() / 1000 - t0).toFixed(3)),
		rect: async (what, frame, measure) => (rects[what] = await frame.evaluate(measure)),
	})
	const end = Date.now() / 1000
	await cdp.send('Page.stopScreencast')
	await cdp.detach()
	const list = stamps.map((t, i) => `file 'f${pad(i + 1)}.jpg'\nduration ${((stamps[i + 1] ?? end) - t).toFixed(4)}`).join('\n')
	writeFileSync(join(dir, 'frames.txt'), `${list}\nfile 'f${pad(stamps.length)}.jpg'\n`)
	ffmpeg('-f', 'concat', '-safe', '0', '-i', join(dir, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-an', join(out, `${name}.mp4`))
	writeFileSync(join(out, `${name}.json`), JSON.stringify({ ...VIEW, duration: +(end - t0).toFixed(3), marks, rects }, null, 1))
	console.log(name, stamps.length, 'frames over', (end - t0).toFixed(1), 's')
	await page.close()
}

// What the camera frames, measured in the page (CSS px). Each is self-contained: it runs in the page, not here.
/** The card a tour or a review stands at, with its caption. */
const tourSubject = () => {
	const lit = [...document.querySelectorAll('.wv-touring .react-flow__node')].filter(n => getComputedStyle(n).opacity === '1')
	const boxes = [...lit, document.querySelector('.tour-caption')].filter(Boolean).map(e => e.getBoundingClientRect())
	const x = Math.min(...boxes.map(b => b.left)), y = Math.min(...boxes.map(b => b.top))
	return { x, y, w: Math.max(...boxes.map(b => b.right)) - x, h: Math.max(...boxes.map(b => b.bottom)) - y }
}
/** Every card on the canvas. */
const cardsSubject = () => {
	const boxes = [...document.querySelectorAll('.react-flow__node')].map(e => e.getBoundingClientRect()).filter(b => b.width > 0)
	const x = Math.min(...boxes.map(b => b.left)), y = Math.min(...boxes.map(b => b.top))
	return { x, y, w: Math.max(...boxes.map(b => b.right)) - x, h: Math.max(...boxes.map(b => b.bottom)) - y }
}
/** The reading: the cards on the path to the cursor and the next call (on screen), with the pane's lines down to the cursor. */
const readingSubject = () => {
	const cards = [...document.querySelectorAll('.react-flow__node.tr-path, .react-flow__node.tr-next')].map(e => e.getBoundingClientRect()).filter(b => b.width > 0 && b.right > 0 && b.left < innerWidth && b.bottom > 0 && b.top < innerHeight)
	const pane = document.querySelector('.rp')?.getBoundingClientRect()
	const cursor = [...document.querySelectorAll('.rp .current-line, .rp .cursor')].map(e => e.getBoundingClientRect()).filter(b => b.height > 0).pop()
	const boxes = [...cards, ...(pane ? [{ left: pane.left, top: pane.top, right: pane.right, bottom: Math.max(pane.top + 240, (cursor?.bottom ?? 0) + 60) }] : [])]
	const x = Math.min(...boxes.map(b => b.left)), y = Math.min(...boxes.map(b => b.top))
	return { x, y, w: Math.max(...boxes.map(b => b.right)) - x, h: Math.max(...boxes.map(b => b.bottom)) - y }
}
/** The Agents page's panes. */
const panesSubject = () => {
	const boxes = [...document.querySelectorAll('.pane')].map(e => e.getBoundingClientRect())
	const x = Math.min(...boxes.map(b => b.left)), y = Math.min(...boxes.map(b => b.top))
	return { x, y, w: Math.max(...boxes.map(b => b.right)) - x, h: Math.max(...boxes.map(b => b.bottom)) - y }
}

// The pane's open or closed state outlives the page (the canvas keeps it in localStorage), so each shot sets the one it needs.
const closePane = async page => {
	if (!(await page.$('.rp'))) return
	await page.click('button[title="Close the reading pane"]')
	await wait(900)
}
const openPane = async page => {
	if (await page.$('.rp')) return
	await page.evaluate(() => [...document.querySelectorAll('button.chip')].find(b => b.textContent.trim() === 'Read')?.click())
	await page.waitForSelector('.rp .view-line')
	await wait(1500)
}

const SHOTS = {
	// The POST /orders flow with its reading pane: step into, over, into, then open the call across HTTP. The canvas follows.
	async reading() {
		const page = await canvas('')
		await openPane(page)
		// The pane's keys work while it has the focus: a click on the line its cursor already stands on, left of the call (a click on the
		// call's hint would open it).
		const line = await page.evaluate(() => {
			const l = [...document.querySelectorAll('.rp .view-line')].find(e => e.textContent.includes('service.place(order)'))
			const r = l?.getBoundingClientRect()
			return r && { x: r.left + 30, y: r.top + r.height / 2 }
		})
		if (!line) throw new Error('The reading pane does not show OrderController.place')
		await page.mouse.click(line.x, line.y)
		await page.mouse.move(VIEW.width - 2, VIEW.height - 2)
		await wait(1500)
		await record(page, 'reading', async ({ mark, rect }) => {
			await rect('start', page, readingSubject)
			await wait(1400)
			for (const [what, key, ms] of [['into', 'l', 2900], ['over', 'j', 2700], ['into2', 'l', 2900], ['peek', 'Enter', 3300]]) {
				mark(what)
				await page.keyboard.press(key)
				await wait(1100)
				await rect(what, page, readingSubject)
				await wait(ms - 1100)
			}
		})
	},
	// The agent's change set fanning out to the endpoints it reaches, then the canvas's own review of it, two changes.
	async 'review-a'() {
		const page = await canvas('?t=changes&mode=changed')
		await closePane(page)
		await page.click('.react-flow__controls-button[title="Fit view"]')
		await wait(1500)
		await record(page, 'review-a', async ({ mark, rect }) => {
			await rect('fan', page, cardsSubject)
			await wait(3600)
			mark('review')
			await page.click('button.chip.agent')
			await wait(1700)
			await rect('review', page, tourSubject)
			await wait(1300)
			mark('next')
			await page.keyboard.press('ArrowRight')
			await wait(1500)
			await rect('next', page, tourSubject)
			await wait(1000)
		})
	},
	// Keep, on the endpoint's own flow at the same step of the same review: on the change set itself the demo has nothing left to show
	// after a Keep (its one prompt is its whole change), so review-a ends before it and the loop crossfades here.
	async 'review-b'() {
		const page = await canvas('?mode=changed')
		await closePane(page)
		await page.click('button.chip.agent')
		await wait(2600)
		await page.keyboard.press('ArrowRight')
		await wait(2400)
		await record(page, 'review-b', async ({ mark, rect }) => {
			await rect('start', page, tourSubject)
			const keep = await page.evaluate(() => {
				const card = [...document.querySelectorAll('.wv-touring .react-flow__node')].find(n => getComputedStyle(n).opacity === '1')
				const b = [...(card?.querySelectorAll('button') ?? [])].find(e => e.textContent.trim() === 'Keep')?.getBoundingClientRect()
				return b && { x: b.left + b.width / 2, y: b.top + b.height / 2 }
			})
			if (!keep) throw new Error('No Keep on the card the review stands at')
			await wait(900)
			await page.mouse.move(keep.x, keep.y, { steps: 6 })
			await wait(500)
			mark('keep')
			await page.mouse.click(keep.x, keep.y)
			await page.mouse.move(VIEW.width - 2, VIEW.height - 2)
			await wait(1400)
			await rect('kept', page, cardsSubject)
			await wait(1600)
		})
	},
	// The invoice tour: a Java endpoint, HTTP into a Python route, its service, the table it reads. The canvas's own tour player,
	// started with the message the site's Stage sends it (stage.ts), stepped with the arrow key.
	async services() {
		const tour = data.tours.find(t => t.id === 'invoice')
		const page = await canvas(`?t=${encodeURIComponent(tour.entry)}`)
		await closePane(page)
		// The title bar's status note ("No callers: …") comes and goes after a load: the loop starts once it has gone.
		await until(() => page.evaluate(() => !document.body.innerText.includes('No callers')), 'the status note to go')
		await wait(500)
		await record(page, 'services', async ({ mark, rect }) => {
			await rect('start', page, cardsSubject)
			await wait(700)
			// Each step's caption shows once the tour's cursor has reached its card (about a second); then it is read for a moment more.
			for (let i = 1; i <= tour.steps.length; i++) {
				mark(`s${i}`)
				if (i === 1) await page.evaluate(tour => window.dispatchEvent(new MessageEvent('message', { data: { type: 'tour', tour } })), tour)
				else await page.keyboard.press('ArrowRight')
				await until(() => page.evaluate(title => document.querySelector('.tour-caption-head b')?.textContent === title, tour.steps[i - 1].title), `step ${i}`)
				await wait(900)
				await rect(`s${i}`, page, tourSubject)
				await wait(i === tour.steps.length ? 1700 : 500)
			}
		})
	},
	// The Agents page (the app's own page, mounted by the Try page): the needs-you strip, a session into a pane, then two splits.
	async agents() {
		const page = await newPage()
		await page.goto(`${base}try/`, { waitUntil: 'networkidle0' })
		// Only the Agents page, at the whole window: the Try page around it is hidden, not removed, so it still feeds the page.
		await page.addStyleTag({
			content: `body * { visibility: hidden !important; }
				iframe.agents-page { visibility: visible !important; position: fixed !important; inset: 0 !important; width: 100vw !important; height: 100vh !important; max-width: none !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; transform: none !important; z-index: 2147483647; }
				html, body { overflow: hidden !important; }`,
		})
		const frame = await (await page.$('iframe.agents-page')).contentFrame()
		await until(() => frame.evaluate(() => document.querySelectorAll('.qchip').length === 2), 'two agents in the needs-you strip')
		await wait(1500)
		// A real click on the empty workspace, so the page's keys reach the iframe.
		await page.mouse.click(VIEW.width * 0.6, VIEW.height * 0.85)
		await page.mouse.move(VIEW.width - 2, VIEW.height - 2)
		await wait(600)
		const chord = async key => {
			await page.keyboard.down('Alt')
			await page.keyboard.down('Shift')
			await page.keyboard.press(key)
			await page.keyboard.up('Shift')
			await page.keyboard.up('Alt')
		}
		// A session dragged from the list onto an edge of the last pane: the page's own drag handlers, with the drop zone shown while it is held.
		const drag = (row, edge) =>
			frame.evaluate(
				async (row, edge) => {
					const el = [...document.querySelectorAll('.srow')].find(r => r.innerText.replace(/\s+/g, ' ').trim() === row)
					const pane = [...document.querySelectorAll('.pane')].pop()
					if (!el || !pane) return false
					const r = pane.getBoundingClientRect()
					const dt = new DataTransfer()
					el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
					const [x, y] = edge === 'right' ? [r.right - 24, r.top + r.height / 2] : [r.left + r.width / 2, r.bottom - 24]
					for (let i = 0; i < 12; i++) {
						pane.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
						await new Promise(f => setTimeout(f, 80))
					}
					pane.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }))
					el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
					return true
				},
				row,
				edge,
			)
		await record(page, 'agents', async ({ mark, rect }) => {
			await wait(1600)
			mark('next')
			await chord('KeyN')
			await until(() => frame.evaluate(() => document.querySelectorAll('.pane').length === 1), 'Codex in a pane')
			await wait(1000)
			await rect('next', frame, panesSubject)
			await wait(1900)
			mark('split')
			if (!(await drag('Claude Code working', 'right'))) throw new Error('No working Claude Code row to drag')
			await until(() => frame.evaluate(() => document.querySelectorAll('.pane').length === 2), 'the split')
			await wait(900)
			await rect('split', frame, panesSubject)
			await wait(1700)
			mark('split2')
			if (!(await drag('Claude Code done', 'bottom'))) throw new Error('No finished Claude Code row to drag')
			await until(() => frame.evaluate(() => document.querySelectorAll('.pane').length === 3), 'the second split')
			await wait(900)
			await rect('split2', frame, panesSubject)
			await wait(2100)
		})
	},
}

try {
	for (const [name, shoot] of Object.entries(SHOTS)) if (!only.length || only.includes(name)) await shoot()
} finally {
	await browser.close()
	await server.close()
}
