// Writes one HyperFrames project per feature loop from the footage capture.mjs recorded: the footage full-bleed, a camera that pushes
// in so the code on the cards and in the reading pane reads, the keys pressed (keycaps) or one short label per beat, and a seam that
// dissolves back into the first frame so the loop has no cut.
//   node video/build.mjs [work dir] [loops]
// Reads <work>/capture/<shot>.mp4 and .json; writes <work>/build/<loop>/ (index.html, hyperframes.json, assets), ready for
// `hyperframes render` (deliver.mjs).
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const site = fileURLToPath(new URL('..', import.meta.url))
const work = resolve(process.argv[2] ?? join(tmpdir(), 'insilode-loops'))
const only = process.argv.slice(3)
const W = 1600
const H = 1000
const FPS = 30
// Every clip starts this far into its footage: frame 6 exactly, so the seam's still and the first frame are the same picture.
const FROM = 6 / FPS
const SEAM = 0.65

const shot = name => ({ name, ...JSON.parse(readFileSync(join(work, 'capture', `${name}.json`), 'utf8')) })
const ffmpeg = (...args) => {
	const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
	if (r.status !== 0) throw new Error(`ffmpeg ${args.join(' ')} failed`)
}

/**
 * A camera rect around what a step acts on (a box measured in the page, CSS px), at the loop's 16:10 and no tighter than `max`
 * times the page: the subject plus a margin, centred on it.
 */
function around(box, view, { pad = 40, max = 1.5 } = {}) {
	const w = Math.max(box.w + 2 * pad, (box.h + 2 * pad) * 1.6, view.width / max)
	const h = w / 1.6
	const cx = box.x + box.w / 2
	const cy = box.y + box.h / 2
	return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
}

/** The camera transform that fits `rect` (CSS px of the page, or 'full') to the frame, never showing past the page's edges. */
function fit(rect, view) {
	if (rect === 'full') return { scale: 1, x: 0, y: 0 }
	const k = W / view.width
	const [x0, y0, x1, y1] = rect
	const s = Math.max(1, Math.min(W / ((x1 - x0) * k), H / ((y1 - y0) * k)))
	const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
	return {
		scale: +s.toFixed(4),
		x: +clamp(W / 2 - (s * (x0 + x1) * k) / 2, W - s * W, 0).toFixed(2),
		y: +clamp(H / 2 - (s * (y0 + y1) * k) / 2, H - s * H, 0).toFixed(2),
	}
}

// Each loop: its clips of footage (`at` in the loop, `to` in the footage; every clip starts at FROM in its footage, and a later clip
// dissolves in over `fade`), the camera keys (`at`: when the move starts, `dur`: how long it eases), and the beats of the overlay
// (keys pressed with what they do, or a label) with when they show. Times are in the loop; `t(shot, mark)` turns a mark of the
// footage into loop time.
function loops() {
	const reading = shot('reading')
	const ra = shot('review-a')
	const rb = shot('review-b')
	const services = shot('services')
	const agents = shot('agents')
	const t = (s, mark, at = 0) => +(at + s.marks[mark] - FROM).toFixed(3)
	const B = 8.5
	return {
		// Stepping through POST /orders in the reading pane; the canvas follows as a trace. The camera holds on the pane and the cards.
		reading: {
			view: reading,
			clips: [{ shot: reading, at: 0, to: 13.2 }],
			keys: [
				{ at: 0.8, dur: 1.6, rect: [170, 12, 1440, 805.75] },
				{ at: 11.4, dur: 1.5, rect: 'full' },
			],
			beats: [
				{ at: t(reading, 'into'), until: t(reading, 'over') - 0.3, keys: ['l'], text: 'step into' },
				{ at: t(reading, 'over'), until: t(reading, 'into2') - 0.3, keys: ['j'], text: 'step over' },
				{ at: t(reading, 'into2'), until: t(reading, 'peek') - 0.3, keys: ['l'], text: 'step into' },
				{ at: t(reading, 'peek'), until: 12.1, keys: ['Enter'], text: 'peek across HTTP' },
			],
		},
		// The agent's change set fanning out to the endpoints it reaches, the canvas's review of its two changes, and Keep on one. The
		// second clip is the endpoint's own flow at the same step of the same review (capture.mjs says why), so the dissolve does not move.
		review: {
			view: ra,
			clips: [
				{ shot: ra, at: 0, to: 9.1 },
				{ shot: rb, at: B, to: 4.6, fade: 0.4 },
			],
			keys: [
				{ at: 0.5, dur: 2.8, rect: [80, 0, 1109, 643] },
				{ at: t(ra, 'review') + 0.35, dur: 1.3, rect: around(ra.rects.review, ra, { max: 1.38 }) },
				{ at: t(ra, 'next') + 0.35, dur: 1.1, rect: around(ra.rects.next, ra, { max: 1.38 }) },
				{ at: 11.3, dur: 1.55, rect: 'full' },
			],
			beats: [
				{ at: 0.7, until: t(ra, 'review') - 0.3, text: 'One prompt, four endpoints' },
				{ at: t(ra, 'review'), until: t(ra, 'next') - 0.3, text: 'The review, card by card' },
				{ at: t(ra, 'next'), until: B + rb.marks.keep - FROM - 0.6, keys: ['→'], text: 'next change' },
				{ at: t(rb, 'keep', B) - 0.25, until: 11.95, text: 'Keep: the card goes plain' },
			],
		},
		// A request across services: the invoice tour, from a Java endpoint over HTTP into a Python route, its service and its table.
		services: {
			view: services,
			clips: [{ shot: services, at: 0, to: 14.8 }],
			keys: [
				{ at: t(services, 's1') + 0.2, dur: 1.4, rect: [80, 100, 1360, 900] },
				{ at: 13.05, dur: 1.5, rect: 'full' },
			],
			beats: [
				{ at: t(services, 's1') + 0.1, until: t(services, 's2') - 0.3, entry: true, text: 'GET /orders/{id}/invoice' },
				...[2, 3, 4, 5].map(i => ({ at: t(services, `s${i}`), until: i < 5 ? t(services, `s${i + 1}`) - 0.3 : 13.6, keys: ['→'], text: 'next step' })),
			],
		},
		// The Agents page: what needs you, a session into a pane, then a split to the right and one below.
		agents: {
			view: agents,
			clips: [{ shot: agents, at: 0, to: 12.2 }],
			keys: [
				{ at: t(agents, 'next') + 0.15, dur: 1.3, rect: [120, 44, 1228, 736.5] },
				{ at: t(agents, 'split') + 0.9, dur: 1.3, rect: [220, 44, 1440, 806.5] },
				{ at: t(agents, 'split2') + 0.9, dur: 1.3, rect: [100, 44, 1440, 881.5] },
				{ at: 10.45, dur: 1.5, rect: 'full' },
			],
			beats: [
				{ at: t(agents, 'next'), until: t(agents, 'split') - 0.3, keys: ['Alt', 'Shift', 'N'], text: 'next that needs you' },
				{ at: t(agents, 'split'), until: t(agents, 'split2') - 0.3, text: 'Drop on an edge: split' },
				{ at: t(agents, 'split2'), until: 10.3, text: 'And again, below' },
			],
		},
	}
}

function build(name, loop) {
	const out = join(work, 'build', name)
	mkdirSync(join(out, 'assets', 'fonts'), { recursive: true })
	const first = loop.clips[0]
	// The loop ends with its last clip; an earlier one runs until the next has dissolved in over it.
	const duration = +Math.max(...loop.clips.map(c => c.at + c.to - FROM)).toFixed(3)
	const view = loop.view
	const tl = []
	let cam = ''
	loop.clips.forEach((c, i) => {
		copyFileSync(join(work, 'capture', `${c.shot.name}.mp4`), join(out, 'assets', `${c.shot.name}.mp4`))
		const len = +Math.min(c.to - FROM, duration - c.at).toFixed(3)
		cam += `<div class="layer" id="w${i}"${c.fade ? ' style="opacity:0"' : ''}><video id="v${i}" class="clip" src="assets/${c.shot.name}.mp4" muted playsinline data-start="${c.at}" data-duration="${len}" data-media-start="${FROM.toFixed(4)}" data-track-index="${i}"></video></div>\n`
		if (c.fade) tl.push(`tl.fromTo('#w${i}', { opacity: 0 }, { opacity: 1, duration: ${c.fade}, ease: 'power1.inOut' }, ${c.at})`)
	})
	// The seam: the loop's own first frame, inside the camera, dissolving in over the last moments while the camera returns to its first key.
	ffmpeg('-i', join(work, 'capture', `${first.shot.name}.mp4`), '-vf', `select=eq(n\\,${Math.round(FROM * FPS)})`, '-frames:v', '1', join(out, 'assets', 'first.png'))
	cam += `<img id="seam" class="layer" src="assets/first.png" alt="" style="opacity:0">\n`
	tl.push(`tl.fromTo('#seam', { opacity: 0 }, { opacity: 1, duration: ${SEAM}, ease: 'power1.inOut' }, ${(duration - SEAM - 0.04).toFixed(3)})`)
	tl.unshift(`tl.set('#cam', ${JSON.stringify(fit('full', view))}, 0)`)
	for (const k of loop.keys) tl.push(`tl.to('#cam', { ...${JSON.stringify(fit(k.rect, view))}, duration: ${k.dur}, ease: 'power2.inOut' }, ${k.at.toFixed(3)})`)
	const last = loop.keys.at(-1)
	if (last.rect !== 'full' || last.at + last.dur > duration - 0.04) throw new Error(`${name}: the camera must be back on its first key before the loop ends`)

	let hud = ''
	loop.beats.forEach((b, i) => {
		const from = +(b.at - 0.15).toFixed(3)
		const len = +(b.until - from).toFixed(3)
		if (from <= 0.1 || b.until > duration - SEAM - 0.1) throw new Error(`${name}: beat ${i} must be off screen at the seam`)
		const keys = (b.keys ?? []).map((k, j) => `<span class="key" id="b${i}-k${j}">${k}</span>`).join('<span class="plus">+</span>')
		const body = b.keys ? `${keys}<span class="what">${b.text}</span>` : b.entry ? `<span class="entry"></span><span class="req">${b.text}</span>` : `<span class="label">${b.text}</span>`
		hud += `<div id="b${i}" class="clip beat" data-start="${from}" data-duration="${len}" data-track-index="5"><div class="pill" id="b${i}-in">${body}</div></div>\n`
		tl.push(`tl.fromTo('#b${i}-in', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power3.out' }, ${from})`)
		tl.push(`tl.to('#b${i}-in', { opacity: 0, y: -6, duration: 0.28, ease: 'power2.in' }, ${(b.until - 0.3).toFixed(3)})`)
		// The press: every key of the chord goes down together as the key reaches the page, and comes back up.
		;(b.keys ?? []).forEach((_, j) => {
			tl.push(`tl.to('#b${i}-k${j}', { scale: 0.9, backgroundColor: '#3f52c9', borderColor: '#9aa8ff', duration: 0.08, ease: 'power2.out' }, ${b.at.toFixed(3)})`)
			tl.push(`tl.to('#b${i}-k${j}', { scale: 1, backgroundColor: '#1a1f35', borderColor: 'rgba(154, 168, 255, 0.34)', duration: 0.32, ease: 'power2.out' }, ${(b.at + 0.12).toFixed(3)})`)
		})
	})

	const fonts = join(site, 'node_modules', '@fontsource-variable')
	copyFileSync(join(fonts, 'instrument-sans', 'files', 'instrument-sans-latin-wght-normal.woff2'), join(out, 'assets', 'fonts', 'instrument-sans.woff2'))
	copyFileSync(join(fonts, 'jetbrains-mono', 'files', 'jetbrains-mono-latin-wght-normal.woff2'), join(out, 'assets', 'fonts', 'jetbrains-mono.woff2'))
	writeFileSync(join(out, 'index.html'), page(duration, cam, hud, tl))
	writeFileSync(join(out, 'hyperframes.json'), `${JSON.stringify({ paths: { assets: 'assets' }, media: { autoProxy: true } }, null, 2)}\n`)
	console.log('wrote', out, `${duration} s`)
}

function page(duration, cam, hud, tl) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${W}, height=${H}">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
/* The site's type, self-hosted (the fontsource variable files the site itself uses). */
@font-face { font-family: "Instrument Sans"; font-weight: 400 700; src: url(assets/fonts/instrument-sans.woff2) format("woff2"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 100 800; src: url(assets/fonts/jetbrains-mono.woff2) format("woff2"); }
/* The site's dark page, its accent and signal blues and the entry amber (site/src/site.css). */
:root { --page: #0c1020; --ink: #e9ecf5; --accent: #9aa8ff; --signal: #3f52c9; --entry: #e3a23b; }
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: var(--page); }
#root { position: relative; width: 100%; height: 100%; overflow: hidden; background: var(--page); }
.cam { position: absolute; left: 0; top: 0; width: ${W}px; height: ${H}px; transform-origin: 0 0; }
.layer { position: absolute; inset: 0; width: ${W}px; height: ${H}px; }
.layer video, img.layer { display: block; width: ${W}px; height: ${H}px; }
/* The overlay: one pill at the bottom left, over the canvas's empty corner and clear of the tour bar, plainly not part of the app. */
.beat { position: absolute; inset: 0; pointer-events: none; }
.pill { position: absolute; left: 44px; bottom: 44px; display: flex; align-items: center; gap: 12px; padding: 12px 22px 12px 12px; border-radius: 16px; background: rgba(12, 16, 32, 0.9); border: 1px solid rgba(154, 168, 255, 0.26); box-shadow: 0 22px 60px rgba(0, 0, 0, 0.55); white-space: nowrap; }
.key { display: inline-flex; align-items: center; justify-content: center; min-width: 50px; height: 50px; padding: 0 14px; border-radius: 10px; background: #1a1f35; border: 1px solid rgba(154, 168, 255, 0.34); box-shadow: inset 0 -3px 0 rgba(0, 0, 0, 0.35); font: 600 27px/1 "JetBrains Mono", monospace; color: var(--ink); }
.plus { font: 500 22px/1 "JetBrains Mono", monospace; color: rgba(154, 168, 255, 0.85); margin: 0 -4px; }
.what { margin-left: 6px; font: 500 26px/1 "JetBrains Mono", monospace; color: var(--accent); letter-spacing: -0.01em; }
.label { padding-left: 10px; font: 650 27px/1.1 "Instrument Sans", sans-serif; color: var(--ink); letter-spacing: -0.01em; }
.entry { width: 0; height: 0; margin-left: 12px; border-top: 9px solid transparent; border-bottom: 9px solid transparent; border-left: 14px solid var(--entry); }
.req { font: 600 26px/1 "JetBrains Mono", monospace; color: var(--ink); }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}">
<div class="cam" id="cam">
${cam}</div>
${hud}</div>
<script>
const tl = gsap.timeline({ paused: true });
${tl.join(';\n')};
window.__timelines["main"] = tl;
</script>
</body>
</html>
`
}

for (const [name, loop] of Object.entries(loops())) if (!only.length || only.includes(name)) build(name, loop)
