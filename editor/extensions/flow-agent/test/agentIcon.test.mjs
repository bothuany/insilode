// The Agents mark (media/agents*.svg): one drawing, in the three forms VS Code needs. The activity and secondary side bars and the view
// header draw an SVG as a mask (only its shape counts: media/agents.svg), a command's icon is an image per theme kind (light and dark files
// of the same drawing in fixed colours), and none of the Agents surfaces is the sparkle. The drawing is on a 16 grid with its lines on half
// pixels, as the codicons are, so a 1px stroke fills whole pixels at 16px instead of two grey ones.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const svg = name => readFileSync(join(ROOT, 'media', name), 'utf8')
/** The drawing without its colour. */
const shape = text => text.replace(/#[0-9A-Fa-f]{6}|currentColor/g, 'C')

test('the mask and the light and dark files are one drawing: a 16 grid, strokes only in the one colour', () => {
	const mask = svg('agents.svg')
	assert.match(mask, /viewBox="0 0 16 16"/)
	assert.match(mask, /width="16" height="16"/)
	assert.match(mask, /stroke-width="1"/)
	assert.match(mask, /stroke="currentColor"/)
	assert.equal(shape(svg('agents-light.svg')), shape(mask))
	assert.equal(shape(svg('agents-dark.svg')), shape(mask))
	assert.match(svg('agents-light.svg'), /#424242/, 'dark strokes for a light theme')
	assert.match(svg('agents-dark.svg'), /#C5C5C5/, 'light strokes for a dark theme')
	assert.doesNotMatch(mask, /<script|<image|href|style=|#[0-9a-f]{3,6}/i, 'nothing but shapes and the one colour')
})

test('every straight line of the drawing sits on a half pixel, so a 1px stroke is crisp at 16px', () => {
	const mask = svg('agents.svg')
	const half = n => Math.abs(n * 2 - Math.round(n * 2)) < 1e-9 && Math.round(n * 2) % 2 === 1
	// The frame: its edges are the rect's x, y, x+width and y+height.
	const rect = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(mask)
	assert.ok(rect, 'a rounded window')
	const [x, y, w, h] = rect.slice(1).map(Number)
	for (const edge of [x, y, x + w, y + h]) assert.equal(half(edge), true, 'frame edge ' + edge)
	// The divider and the prompt: every absolute coordinate of a straight segment (H and V values, and the x and y of M and L).
	for (const [, d] of mask.matchAll(/<path d="([^"]+)"/g)) {
		for (const [, cmd, args] of d.matchAll(/([MLHVhvl])\s*([-\d.\s,]+)/g)) {
			const nums = args.trim().split(/[\s,]+/).map(Number)
			if (cmd === 'h' || cmd === 'v' || cmd === 'l') continue
			for (const n of nums) assert.equal(half(n), true, cmd + ' ' + n + ' in ' + d)
		}
	}
	const dot = /<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(mask)
	assert.ok(dot, 'the status dot')
	assert.equal(Number(dot[3]) <= 1.5, true)
})

test('the Agents container, its view and the title bar button use the mark, not a codicon, and the files they name exist', () => {
	const container = pkg.contributes.viewsContainers.secondarySidebar.find(c => c.id === 'flowAgents')
	const view = pkg.contributes.views.flowAgents.find(v => v.id === 'flow.agents')
	const open = pkg.contributes.commands.find(c => c.command === 'flow.agents.openPage')
	assert.equal(container.icon, 'media/agents.svg')
	assert.equal(view.icon, 'media/agents.svg')
	assert.deepEqual(open.icon, { light: 'media/agents-light.svg', dark: 'media/agents-dark.svg' })
	for (const f of [container.icon, view.icon, open.icon.light, open.icon.dark]) {
		assert.equal(existsSync(join(ROOT, f)), true, f)
	}
	assert.ok(pkg.contributes.menus['titleBar/center'].some(m => m.command === 'flow.agents.openPage'), 'the button the icon is for')
})
