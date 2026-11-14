// The Agents mark (media/agents*.svg): one drawing, in the three forms VS Code needs. The activity and secondary side bars and the view
// header draw an SVG as a mask (only its shape counts: media/agents.svg), a command's icon is an image per theme kind (light and dark files
// of the same drawing in fixed colours), and none of the Agents surfaces is the sparkle.
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

test('the mask and the light and dark files are one drawing: a 24 grid, strokes only in the one colour', () => {
	const mask = svg('agents.svg')
	assert.match(mask, /viewBox="0 0 24 24"/)
	assert.match(mask, /stroke="currentColor"/)
	assert.equal(shape(svg('agents-light.svg')), shape(mask))
	assert.equal(shape(svg('agents-dark.svg')), shape(mask))
	assert.match(svg('agents-light.svg'), /#424242/, 'dark strokes for a light theme')
	assert.match(svg('agents-dark.svg'), /#C5C5C5/, 'light strokes for a dark theme')
	assert.doesNotMatch(mask, /<script|<image|href|style=|#[0-9a-f]{3,6}/i, 'nothing but shapes and the one colour')
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
