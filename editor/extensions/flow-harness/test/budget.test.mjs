// How the usage-limit status bar items read, and what a report from flow-agent must hold (src/budget.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let b
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-budget-'))
	const outfile = join(tmp, 'budget.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'budget.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	b = await import(pathToFileURL(outfile).href)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

test('reports that are not reports are dropped', () => {
	assert.equal(b.toLimits(undefined), undefined)
	assert.equal(b.toLimits({ harness: 'Claude Code', windows: [] }), undefined)
	assert.equal(b.toLimits({ harness: 'Claude Code', windows: [{ label: '5h' }] }), undefined)
	assert.equal(b.toLimits({ windows: [{ label: '5h', usedPercent: 3 }] }), undefined)
})

test('the status bar text: one compact item per harness', () => {
	const l = b.toLimits({ harness: 'Claude Code', windows: [{ label: '5h', usedPercent: 32.4, resetsAt: 1 }, { label: 'wk', usedPercent: 61 }] })
	assert.equal(b.limitsText(l), 'Claude 5h 32% · wk 61%')
	assert.equal(b.limitsText(b.toLimits({ harness: 'Codex', windows: [{ label: '5h', usedPercent: 140 }] })), 'Codex 5h 100%')
})

test('the tooltip says what is used, what is left and when it resets', () => {
	const now = Date.UTC(2026, 9, 17, 12, 0)
	const l = b.toLimits({ harness: 'Claude Code', windows: [{ label: '5h', usedPercent: 32, resetsAt: now + 95 * 60_000 }, { label: 'wk', usedPercent: 61, resetsAt: now + 3 * 24 * 3_600_000 + 2 * 3_600_000 }, { label: '1d', usedPercent: 1 }] })
	assert.deepEqual(b.limitLines(l, now, () => 'T'), [
		'5-hour limit: 32% used, 68% left, resets T (in 1 h 35 min)',
		'Weekly limit: 61% used, 39% left, resets T (in 3 days 2 h)',
		'1d limit: 1% used, 99% left',
	])
})

test('the colour follows the fullest window', () => {
	assert.equal(b.limitLevel({ harness: 'x', windows: [{ label: '5h', usedPercent: 10 }, { label: 'wk', usedPercent: 92 }] }), 'high')
	assert.equal(b.limitLevel({ harness: 'x', windows: [{ label: '5h', usedPercent: 80 }] }), 'warn')
	assert.equal(b.limitLevel({ harness: 'x', windows: [{ label: '5h', usedPercent: 10 }] }), 'ok')
})

test('token amounts', () => {
	assert.equal(b.fmtTokens(950), '950')
	assert.equal(b.fmtTokens(66_700), '66.7k')
	assert.equal(b.fmtTokens(272_000), '272k')
	assert.equal(b.fmtTokens(1_000_000), '1M')
	assert.equal(b.fmtTokens(1_500_000), '1.5M')
})

test('a window past its reset goes; one with no reset time goes once its report is old', () => {
	const now = 10_000_000
	const l = { harness: 'Codex', windows: [{ label: '5h', usedPercent: 1, resetsAt: now - 1 }, { label: 'wk', usedPercent: 2, resetsAt: now + 1 }, { label: 'long', usedPercent: 3 }] }
	assert.deepEqual(b.liveWindows(l, now - 60_000, now).map(w => w.label), ['wk', 'long'])
	assert.deepEqual(b.liveWindows(l, now - b.UNDATED_TTL_MS, now).map(w => w.label), ['wk'])
})

test('limit alerts: once per level and window, keyed by the reset time', () => {
	const now = 1_000_000
	const rep = (pct, resetsAt = now + 80 * 60_000, label = '5h') => b.toLimits({ harness: 'Claude Code', windows: [{ label, usedPercent: pct, resetsAt }] })
	const seen = new Map()
	assert.deepEqual(b.dueAlerts(rep(60), seen, now), [])
	const first = b.dueAlerts(rep(78), seen, now)
	assert.equal(first.length, 1)
	assert.equal(first[0].level, 'warn')
	assert.equal(first[0].message, 'Claude: 5-hour limit at 78%, resets in 1 h 20 min')
	assert.deepEqual(b.dueAlerts(rep(80), seen, now), [])
	const high = b.dueAlerts(rep(91), seen, now)
	assert.deepEqual(high.map(a => a.level), ['high'])
	assert.deepEqual(b.dueAlerts(rep(99), seen, now), [])
	// a new window (new reset time) alerts again, and the old keys are dropped once their reset passed
	assert.equal(b.dueAlerts(rep(80, now + 6 * 3600_000), seen, now).length, 1)
	b.dueAlerts(rep(10, now + 9 * 3600_000), seen, now + 2 * 3600_000)
	assert.ok([...seen.keys()].every(k => !k.endsWith(`|${now + 80 * 60_000}|warn`)))
	// the weekly window is its own key
	assert.equal(b.dueAlerts(rep(80, now + 80 * 60_000, 'wk'), seen, now).length, 1)
})

test('limit alerts: a jump past 90% counts the 75% alert as told; a passed window says nothing', () => {
	const now = 5_000
	const seen = new Map()
	const l = b.toLimits({ harness: 'Codex', windows: [{ label: '5h', usedPercent: 95, resetsAt: now + 60_000 }] })
	assert.deepEqual(b.dueAlerts(l, seen, now).map(a => a.level), ['high'])
	assert.deepEqual(b.dueAlerts(l, seen, now), [])
	assert.deepEqual(b.dueAlerts(b.toLimits({ harness: 'Codex', windows: [{ label: '5h', usedPercent: 95, resetsAt: now - 1 }] }), new Map(), now), [])
	assert.equal(b.windowLevel(74.9), 'ok')
	assert.equal(b.windowLevel(75), 'warn')
	assert.equal(b.windowLevel(90), 'high')
})
