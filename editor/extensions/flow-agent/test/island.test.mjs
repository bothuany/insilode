// The desktop status island's own rules: where it may sit and when it shows. The code lives in the core patch
// (src/vs/platform/insilodeDesktop/common/insilodeIsland.ts has no imports), so this reads it from the added lines of
// editor/patches/flow-desktop.patch and runs exactly that.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PATCH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'patches', 'flow-desktop.patch')
const FILE = 'src/vs/platform/insilodeDesktop/common/insilodeIsland.ts'

/** The added lines of one file of the patch, which for a new file is the file. */
function added(file) {
	const lines = []
	let inside = false
	for (const line of readFileSync(PATCH, 'utf8').split(/\r?\n/)) {
		if (line.startsWith('diff --git ')) {
			inside = line.endsWith(` b/${file}`)
		} else if (inside && line.startsWith('+') && !line.startsWith('+++')) {
			lines.push(line.slice(1))
		}
	}
	return lines.join('\n')
}

let i
before(async () => {
	const source = added(FILE)
	assert.ok(source.split('\n').length > 50, 'the patch holds insilodeIsland.ts')
	const { code } = await transform(source, { loader: 'ts', format: 'esm' })
	i = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
})

const area = { x: 0, y: 0, width: 1920, height: 1040 }
const size = { width: 300, height: 40 }

test('clamp: a rectangle inside the area stays, one outside comes back whole', () => {
	assert.deepEqual(i.clampRect({ x: 100, y: 50, ...size }, area), { x: 100, y: 50, ...size })
	assert.deepEqual(i.clampRect({ x: -500, y: -20, ...size }, area), { x: 0, y: 0, ...size })
	assert.deepEqual(i.clampRect({ x: 5000, y: 5000, ...size }, area), { x: 1620, y: 1000, ...size })
	// An area with an offset (a second monitor to the left, a taskbar on top).
	const left = { x: -1280, y: 40, width: 1280, height: 984 }
	assert.deepEqual(i.clampRect({ x: -1400, y: 0, ...size }, left), { x: -1280, y: 40, ...size })
	// Bigger than the area: as much as fits, from the corner.
	assert.deepEqual(i.clampRect({ x: 50, y: 50, width: 3000, height: 40 }, area), { x: 0, y: 50, width: 1920, height: 40 })
})

test('spots: remembered as a fraction of the width and a distance from the top, so a new resolution keeps the place', () => {
	const rect = { x: 810, y: 100, ...size }
	const spot = i.rectToSpot(rect, area)
	assert.equal(spot.cx, 0.5)
	assert.equal(spot.y, 100)
	assert.deepEqual(i.spotToRect(spot, size, area), rect)
	const small = { x: 0, y: 0, width: 1280, height: 720 }
	assert.deepEqual(i.spotToRect(spot, size, small), { x: 490, y: 100, ...size })
	// A smaller display than the spot's y: pulled up so the island is still on it.
	assert.equal(i.spotToRect({ cx: 0.5, y: 900 }, size, small).y, 680)
	// Growing (the hover list) around the same centre stays on screen at the edge.
	assert.equal(i.spotToRect({ cx: 1, y: 0 }, { width: 400, height: 200 }, area).x, 1520)
})

test('spots: malformed stored values are no spot, extremes are limited', () => {
	assert.equal(i.readSpot(undefined), undefined)
	assert.equal(i.readSpot({ cx: 'a', y: 1 }), undefined)
	assert.equal(i.readSpot({ cx: NaN, y: 1 }), undefined)
	assert.deepEqual(i.readSpot({ cx: 4, y: -9 }), { cx: 1, y: 0 })
})

const d1 = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const d2 = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 1024 } }

test('placement: the last display the user dropped it on wins while it exists, else the chosen display', () => {
	const spots = { 1: { cx: 0.2, y: 10 }, 2: { cx: 0.8, y: 30 } }
	assert.deepEqual(i.resolvePlacement(spots, '2', [d1, d2], d1), { display: d2, spot: spots[2] })
	// Display 2 unplugged: back to the chosen display's own spot, clamped by the caller.
	assert.deepEqual(i.resolvePlacement(spots, '2', [d1], d1), { display: d1, spot: spots[1] })
	// Nothing remembered for the chosen display: the settings' own placement (no spot).
	assert.equal(i.resolvePlacement({}, undefined, [d1, d2], d1), undefined)
	assert.equal(i.resolvePlacement({ 2: spots[2] }, undefined, [d1, d2], d1), undefined)
})

test('displays: a rectangle belongs to the display that holds most of it', () => {
	assert.equal(i.displayForRect({ x: 1800, y: 10, width: 300, height: 40 }, [d1, d2]).id, 2)
	assert.equal(i.displayForRect({ x: 1700, y: 10, width: 300, height: 40 }, [d1, d2]).id, 1)
	assert.equal(i.displayForRect({ x: 0, y: 0, width: 10, height: 10 }, []), undefined)
})

test('displays: a rectangle in the menu bar band of the second display (outside every work area) belongs to that display', () => {
	// A laptop's menu bar is above its work area: the island attached there overlaps nothing, and must not fall to the first display.
	const ext = { id: 1, workArea: { x: 0, y: -1080, width: 1920, height: 1080 }, bounds: { x: 0, y: -1080, width: 1920, height: 1080 } }
	const mac = { id: 2, workArea: { x: 100, y: 38, width: 1512, height: 944 }, bounds: { x: 100, y: 0, width: 1512, height: 982 } }
	assert.equal(i.displayForRect({ x: 700, y: 0, width: 300, height: 30 }, [ext, mac]).id, 2)
	assert.equal(i.displayForRect({ x: 700, y: 0, width: 300, height: 30 }, [mac, ext]).id, 2)
	assert.equal(i.displayForRect({ x: 700, y: -1070, width: 300, height: 30 }, [mac, ext]).id, 1)
})

test('visibility: no agents hides, by its setting', () => {
	assert.equal(i.islandVisible({ hasAgents: true, autoHide: { noAgents: true } }), true)
	assert.equal(i.islandVisible({ hasAgents: false, autoHide: { noAgents: true } }), false)
	assert.equal(i.islandVisible({ hasAgents: false, autoHide: { noAgents: false } }), true)
})

test('visibility: an island that is only for the others, with none to show, hides whatever no-agents says', () => {
	const off = { noAgents: false }
	assert.equal(i.islandVisible({ hasAgents: false, autoHide: off, othersOnly: true }), false)
	assert.equal(i.islandVisible({ hasAgents: false, autoHide: off, othersOnly: false }), true, 'no focus rule in play: the empty pill is what the user asked for')
	assert.equal(i.islandVisible({ hasAgents: true, autoHide: off, othersOnly: true }), true)
	assert.equal(i.islandVisible({ hasAgents: false, autoHide: { noAgents: true }, othersOnly: false }), false)
})

test('agents: with no Insilode window focused all show; with one focused only the others working or waiting do', () => {
	const a = (id, state) => ({ id, state })
	const windows = [
		{ windowId: 1, items: [a('own-working', 'working')] },
		{ windowId: 2, items: [a('other-working', 'working'), a('other-needs', 'needs'), a('other-done', 'done'), a('other-idle', 'idle')] },
		{ windowId: 3, items: [a('third-done', 'done')] },
	]
	assert.deepEqual(i.islandAgents(windows, undefined).map(x => x.item.id), ['own-working', 'other-working', 'other-needs', 'other-done', 'other-idle', 'third-done'])
	const others = i.islandAgents(windows, 1)
	assert.deepEqual(others.map(x => [x.windowId, x.item.id]), [[2, 'other-working'], [2, 'other-needs']])
	// Nothing left to show: the island hides.
	assert.deepEqual(i.islandAgents(windows, 3).map(x => x.item.id), ['own-working', 'other-working', 'other-needs'])
	assert.equal(i.islandAgents([windows[0], windows[2]], 1).length, 0)
	assert.equal(i.islandVisible({ hasAgents: false, autoHide: { noAgents: true } }), false)
	// A focused window that never pushed agents leaves everything of the others.
	assert.equal(i.islandAgents(windows, 9).length, 3)
})

test('unset: pushed options keep it as two strict booleans, and core reads it from there', () => {
	assert.deepEqual(i.readUnset({ enabled: true, focused: true }), { enabled: true, focused: true })
	assert.deepEqual(i.readUnset({ enabled: true }), { enabled: true, focused: false })
	assert.deepEqual(i.readUnset({ enabled: 'yes', focused: 1 }), { enabled: false, focused: false })
	for (const none of [undefined, null, 'x', 3]) {
		assert.equal(i.readUnset(none), undefined)
	}
	// sanitizeState is in a file that needs Electron, so it cannot run here: it must at least build `unset` with readUnset,
	// or the main process never sees it (the island would then show on every Mac).
	const service = added('src/vs/platform/insilodeDesktop/electron-main/insilodeOverlayMainService.ts')
	// Anchored to the start of a code line, so the same words in a comment do not pass.
	assert.match(service, /^\s*unset: readUnset\(o\?\.unset\),\s*$/m)
	assert.match(service, /^\s*return \[\.\.\.this\.windows\]\.filter\(.*islandWanted\(w\.state\.options\.unset, this\.notches\.has\(this\.display\(w\.state\.options\.display, id\)\.id\)\)/m)
})

test('unset: a window whose enabled setting is unset gets the island only where a display has a camera housing', () => {
	const unset = { enabled: true, focused: true }
	const chosen = { enabled: false, focused: true }
	assert.equal(i.islandWanted(unset, false), false, 'unset, no notch')
	assert.equal(i.islandWanted(unset, true), true, 'unset, notch')
	assert.equal(i.islandWanted(chosen, false), true, 'explicitly on, no notch')
	assert.equal(i.islandWanted(chosen, true), true, 'explicitly on, notch')
	assert.equal(i.islandWanted(undefined, false), true, 'options without unset are all chosen')
})

const probe = name => i.parseNotchProbe(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8'))
const attach = (o) => i.islandRect({ spot: undefined, attached: true, position: 'top-center', ...o })

test('probe: what osascript printed on a real 16" MacBook Pro gives its notch, 185 points wide and 32 tall', () => {
	// fixtures/notch-probe-real.json is the real output of the script in insilodeOverlayMainService.ts.
	assert.deepEqual([...probe('notch-probe-real.json')], [[1, { left: 771, right: 956, height: 32 }]])
})

test('probe: a 14" with an external screen beside it (SYNTHETIC fixture, hand written to the real output\'s shape) has one notch, on display 1', () => {
	assert.deepEqual([...probe('notch-probe-14in-synthetic.json')], [[1, { left: 663, right: 848, height: 32 }]])
})

test('probe: a screen is placed relative to its own frame, wherever the frame is', () => {
	const out = JSON.stringify([{ id: 7, frame: { x: -1512, y: 0, width: 1512, height: 982 }, top: 38, auxiliaryTopLeftArea: { x: -1512, y: 944, width: 600, height: 38 }, auxiliaryTopRightArea: { x: -700, y: 944, width: 700, height: 38 } }])
	assert.deepEqual([...i.parseNotchProbe(out)], [[7, { left: 600, right: 812, height: 38 }]])
})

test('probe: strips given in another coordinate space than the frame (a display left of the main one) give the same notch', () => {
	const screen = (frameX, leftX, rightX) => JSON.stringify([{ id: 7, frame: { x: frameX, y: 0, width: 1512, height: 982 }, top: 38, auxiliaryTopLeftArea: { x: leftX, y: 944, width: 600, height: 38 }, auxiliaryTopRightArea: { x: rightX, y: 944, width: 700, height: 38 } }])
	const notch = [[7, { left: 600, right: 812, height: 38 }]]
	assert.deepEqual([...i.parseNotchProbe(screen(-1512, -1512, -700))], notch, 'global, negative origin')
	assert.deepEqual([...i.parseNotchProbe(screen(-1512, 0, 812))], notch, 'relative to the frame')
	assert.deepEqual([...i.parseNotchProbe(screen(-1512, 40, 852))], notch, 'some other origin')
})

test('probe: malformed output is no notch', () => {
	const aux = (x, width) => ({ x, y: 0, width, height: 32 })
	const screen = (extra = {}) => ({ id: 1, frame: { x: 0, y: 0, width: 1512, height: 982 }, top: 32, auxiliaryTopLeftArea: aux(0, 663), auxiliaryTopRightArea: aux(848, 664), ...extra })
	assert.equal(i.parseNotchProbe(JSON.stringify([screen()])).size, 1, 'the control: this shape is a notch')
	for (const bad of ['', 'not json', '{}', 'null', '[null, 3, "x"]', '[{}]']) {
		assert.equal(i.parseNotchProbe(bad).size, 0, bad)
	}
	for (const extra of [
		{ top: 0 }, { top: -4 }, { top: 'x' }, { id: 'a' }, { id: NaN },
		{ auxiliaryTopLeftArea: undefined }, { auxiliaryTopRightArea: undefined },
		{ auxiliaryTopLeftArea: aux(0, 0), auxiliaryTopRightArea: aux(0, 0) },
		{ auxiliaryTopLeftArea: aux(0, 900), auxiliaryTopRightArea: aux(848, 664) },
		{ auxiliaryTopRightArea: aux(1512, 0) },
		{ frame: undefined }, { frame: { x: 0, width: 'wide' } },
		{ auxiliaryTopLeftArea: aux(0, Infinity) },
	]) {
		assert.equal(i.parseNotchProbe(JSON.stringify([screen(extra)])).size, 0, JSON.stringify(extra))
	}
	// One bad screen does not hide a good one.
	assert.deepEqual([...i.parseNotchProbe(JSON.stringify([{ id: 5 }, screen()]))].map(([id]) => id), [1])
})

// Wings around the housing: the page reports how wide each wing wants to be.
const wings = (left, right) => ({ width: left + 185 + right, height: 38, left, right })

test('notch: the left wing ends where the housing starts, the right one starts where it ends, as tall as the housing, on the top edge', () => {
	for (const [name, display, notch] of [
		['14"', { x: 0, y: 0, width: 1512, height: 982 }, { left: 663, right: 848, height: 32 }],
		['16"', { x: 0, y: 0, width: 1728, height: 1117 }, { left: 771, right: 956, height: 32 }],
	]) {
		const work = { ...display, y: 32, height: display.height - 32 }
		const rect = attach({ size: wings(120, 340), bounds: display, workArea: work, notch })
		assert.deepEqual(rect, { x: notch.left - 120, y: 0, width: 120 + 185 + 340, height: 32 }, name)
		assert.equal(rect.x + 120, notch.left, `${name}: the left wing ends at the housing`)
		assert.equal(rect.x + rect.width - 340, notch.right, `${name}: the right wing starts where it ends`)
	}
})

test('notch: the minimized dot is the right wing alone: the window starts at the housing and the dot ends up just right of it', () => {
	const display = { x: 0, y: 0, width: 1728, height: 1117 }
	const notch = { left: 771, right: 956, height: 32 }
	const dot = 30
	const rect = attach({ size: { width: dot, height: 32, left: 0, right: dot }, bounds: display, workArea: display, notch })
	assert.deepEqual(rect, { x: 771, y: 0, width: 185 + dot, height: 32 })
	// The page keeps the housing's width empty before the dot, or the dot would sit at x 771, under the camera.
	const page = added('src/vs/platform/insilodeDesktop/electron-main/insilodeOverlayMainService.ts')
	const mini = page.slice(page.indexOf('if (data.minimized) {'), page.indexOf('if (list) {'))
	assert.match(mini, /gap\.style\.width = data\.gap/)
	assert.match(mini, /shell\.append\(gap, box\)/)
	assert.match(mini, /root\.replaceChildren\(shell\)/)
})

test('notch: an asymmetric housing, on a display that does not start at 0,0', () => {
	const display = { x: -1512, y: -982, width: 1512, height: 982 }
	const notch = { left: 600, right: 812, height: 38 }
	const rect = attach({ size: wings(80, 200), bounds: display, workArea: { ...display, y: -944, height: 944 }, notch })
	assert.deepEqual(rect, { x: -1512 + 600 - 80, y: -982, width: 80 + 212 + 200, height: 38 })
	assert.equal(rect.x + 80, display.x + notch.left)
	assert.equal(rect.x + rect.width - 200, display.x + notch.right)
})

test('notch: an auto-hidden menu bar (the work area starts at the top) still attaches to the housing', () => {
	const display = { x: 0, y: 0, width: 1512, height: 982 }
	const rect = attach({ size: wings(100, 100), bounds: display, workArea: display, notch: { left: 663, right: 848, height: 32 } })
	assert.deepEqual(rect, { x: 563, y: 0, width: 385, height: 32 })
})

test('notch: wings are kept on the display and never reach under the housing', () => {
	const display = { x: 100, y: 0, width: 1000, height: 700 }
	const notch = { left: 400, right: 585, height: 32 }
	const rect = attach({ size: wings(900, 900), bounds: display, workArea: display, notch })
	assert.deepEqual(rect, { x: 100, y: 0, width: 1000, height: 32 }, 'the whole display width at most')
	assert.deepEqual(attach({ size: wings(900, 50), bounds: display, workArea: display, notch }), { x: 100, y: 0, width: 400 + 185 + 50, height: 32 })
	// A wing is never narrower than nothing: a bad report leaves the housing alone.
	assert.deepEqual(attach({ size: wings(-20, 0), bounds: display, workArea: display, notch }), { x: 500, y: 0, width: 185, height: 32 })
})

test('notch: the hover list is one block centred on the housing, kept on the display', () => {
	const display = { x: 0, y: 0, width: 1512, height: 982 }
	const notch = { left: 663, right: 848, height: 32 }
	const list = { width: 340, height: 220 }
	assert.deepEqual(attach({ size: list, bounds: display, workArea: display, notch }), { x: 586, y: 0, width: 340, height: 220 })
	const edge = { left: 20, right: 205, height: 32 }
	assert.equal(attach({ size: list, bounds: display, workArea: display, notch: edge }).x, 0, 'not off the left edge')
})

test('notch: with none (external screen, probe failed, a Mac without one) the island is one centred pill under the menu bar', () => {
	const display = { x: 1728, y: -300, width: 2560, height: 1440 }
	const work = { x: 1728, y: -275, width: 2560, height: 1415 }
	assert.deepEqual(attach({ size, bounds: display, workArea: work }), { x: 2858, y: -275, ...size }, 'centred, at the work area: never over the menu bar')
	// And the other corners still float inside the work area.
	assert.deepEqual(i.islandRect({ spot: undefined, attached: false, position: 'bottom-right', size, bounds: display, workArea: work }), { x: 1728 + 2560 - 300 - 10, y: -275 + 1415 - 40 - 10, ...size })
})

test('notch: a remembered spot wins over the housing, and the corners ignore it', () => {
	const display = { x: 0, y: 0, width: 1512, height: 982 }
	const work = { ...display, y: 32, height: 950 }
	const notch = { left: 663, right: 848, height: 32 }
	const dropped = i.islandRect({ spot: { cx: 0.2, y: 100 }, attached: false, position: 'top-center', size, bounds: display, workArea: work, notch })
	assert.equal(dropped.y, 132)
	assert.deepEqual(i.islandRect({ spot: undefined, attached: false, position: 'top-left', size, bounds: display, workArea: work, notch }), { x: 10, y: 42, ...size })
})

test('drop: within about 40 points of the housing snaps back to it, farther does not', () => {
	const display = { x: 0, y: 0, width: 1512, height: 982 }
	const notch = { left: 663, right: 848, height: 32 }
	const pill = { width: 300, height: 38 }
	// Dropped under the menu bar (clamped to the work area, y 32), centred on the housing.
	assert.equal(i.nearNotch({ x: 606, y: 32, ...pill }, notch, display), true)
	// Its centre 30 points left of the housing's edge.
	assert.equal(i.nearNotch({ x: 663 - 30 - 150, y: 32, ...pill }, notch, display), true)
	// Its centre 100 points left of it, or half way down the screen.
	assert.equal(i.nearNotch({ x: 663 - 100 - 150, y: 32, ...pill }, notch, display), false)
	assert.equal(i.nearNotch({ x: 606, y: 400, ...pill }, notch, display), false)
	// A display that does not start at 0,0.
	assert.equal(i.nearNotch({ x: 1728 + 606, y: -300 + 32, ...pill }, notch, { x: 1728, y: -300, width: 1512, height: 982 }), true)
})

test('spot: a drop lower on the screen stays there on every later push, even from a window with other settings', () => {
	const display = { x: 0, y: 0, width: 1512, height: 982 }
	const work = { x: 0, y: 38, width: 1512, height: 944 }
	const dropped = { x: 500, y: 400, ...size }
	const d = { id: 1, workArea: work }
	const spots = { 1: i.rectToSpot(dropped, work) }
	const keys = {}
	for (const [windowId, key] of [[1, 'top-center/insilode'], [2, 'bottom-left/primary'], [1, 'top-center/insilode'], [2, 'bottom-left/primary']]) {
		assert.equal(i.layoutChanged(keys, windowId, key), false, 'two windows with their own settings clear nothing')
		const placed = i.resolvePlacement(spots, '1', [d], d)
		const rect = i.islandRect({ spot: placed.spot, attached: false, position: 'top-center', size, bounds: display, workArea: work })
		assert.deepEqual(rect, dropped)
	}
	// The user changing the setting in a window is the one thing that clears it.
	assert.equal(i.layoutChanged(keys, 1, 'top-left/insilode'), true)
	assert.equal(i.layoutChanged(keys, 1, 'top-left/insilode'), false)
	// Dragged all the way down: the bottom edge keeps it whole on the display.
	assert.equal(i.clampRect({ x: 500, y: 5000, ...size }, work).y, 982 - size.height)
})

test('reset: the click that ends a drag is not half of a double-click, a true double-click is', () => {
	assert.equal(i.resetAllowed(undefined, 5000), true, 'never dragged')
	assert.equal(i.resetAllowed(1000, 1200), false, 'a quick click right after the drop')
	assert.equal(i.resetAllowed(1000, 1000 + i.RESET_AFTER_DROP_MS - 1), false)
	assert.equal(i.resetAllowed(1000, 1000 + i.RESET_AFTER_DROP_MS), true, 'a double-click later, with no movement')
})

/** Drives the gate like the main process: events at times, and a settle at each moment something is due. */
function run(events, delays = i.FOCUS_DELAYS) {
	let gate = i.INITIAL_GATE
	const shown = []
	let now = 0
	for (const [at, focused] of events) {
		// Anything due before this event settles first.
		for (let wait = i.focusWait(gate, now, delays); wait !== undefined && now + wait <= at; wait = i.focusWait(gate, now, delays)) {
			now += wait
			gate = i.settleFocus(gate, now, delays)
			shown.push([now, gate.focused])
		}
		now = at
		gate = i.settleFocus(i.observeFocus(gate, focused, now), now, delays)
		shown.push([now, gate.focused])
	}
	for (let wait = i.focusWait(gate, now, delays); wait !== undefined; wait = i.focusWait(gate, now, delays)) {
		now += wait
		gate = i.settleFocus(gate, now, delays)
		shown.push([now, gate.focused])
	}
	return { gate, shown }
}

test('focus: focusing Insilode hides after the short delay, leaving it shows after the longer one', () => {
	const { gate, shown } = run([[0, true], [1000, false]])
	assert.deepEqual(shown.filter(([, f], k, a) => k === 0 || f !== a[k - 1][1]), [[0, false], [120, true], [1400, false]])
	assert.equal(gate.focused, false)
	assert.equal(gate.pending, undefined)
})

test('focus: alt-tabbing through Insilode does not flicker', () => {
	// Away from Insilode (settled), then focus lands on Insilode for 60 ms and goes again: it never hides.
	let gate = i.settleFocus(i.observeFocus(i.INITIAL_GATE, false, 0), 0)
	gate = i.observeFocus(gate, true, 1000)
	assert.equal(gate.focused, false)
	gate = i.settleFocus(gate, 1060)
	assert.equal(gate.focused, false, 'not yet')
	gate = i.observeFocus(gate, false, 1060)
	assert.equal(gate.pending, undefined, 'the blip is forgotten')
	assert.equal(i.focusWait(gate, 1060), undefined)
	// And the other way: Insilode is focused, a switcher blurs it for 200 ms, it comes back: the island stays hidden.
	const focused = { focused: true }
	let g = i.observeFocus(focused, false, 5000)
	g = i.settleFocus(g, 5200)
	assert.equal(g.focused, true)
	g = i.observeFocus(g, true, 5200)
	assert.deepEqual(g, focused)
})

test('focus: a blur then a focus on another Insilode window is one unbroken focus', () => {
	// Blur at 0 and focus at 30 ms: the settled value never moved.
	let g = i.observeFocus({ focused: true }, false, 0)
	g = i.observeFocus(g, true, 30)
	assert.deepEqual(g, { focused: true })
})

test('focus: the wait is what is left of the delay, and nothing is due when nothing changed', () => {
	assert.equal(i.focusWait(i.INITIAL_GATE, 0), undefined)
	const g = i.observeFocus(i.INITIAL_GATE, true, 1000)
	assert.equal(i.focusWait(g, 1000), i.FOCUS_DELAYS.hideMs)
	assert.equal(i.focusWait(g, 1100), i.FOCUS_DELAYS.hideMs - 100)
	assert.equal(i.focusWait(g, 5000), 0)
	// A repeated report of the same change keeps its start.
	assert.equal(i.observeFocus(g, true, 1090), g)
})
