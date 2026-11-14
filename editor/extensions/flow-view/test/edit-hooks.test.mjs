// editHooks (src/editHooks.ts): the PostToolUse hooks of the Claude settings that the canvas shows as "n hooks" on an edited card.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { cleanup, temp } from './bundle.mjs'
import { ROOT } from './helpers.mjs'

let editHooks
before(async () => {
	const out = temp('flow-edit-hooks-')
	await build({ entryPoints: [join(ROOT, 'src', 'editHooks.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'editHooks.mjs'), logLevel: 'silent' })
	;({ editHooks } = await import(pathToFileURL(join(out, 'editHooks.mjs')).href))
})
after(cleanup)

const settings = (dir, name, hooks) => {
	mkdirSync(join(dir, '.claude'), { recursive: true })
	writeFileSync(join(dir, '.claude', name), JSON.stringify({ hooks }))
}
const cmd = command => [{ type: 'command', command }]

test('hooks after an edit are listed from the user\'s, the project\'s and the local settings, in that order, by what they run', async () => {
	const home = temp('flow-hooks-home-')
	const root = temp('flow-hooks-root-')
	settings(home, 'settings.json', { PostToolUse: [{ matcher: 'Edit|Write', hooks: cmd('bash ~/hooks/format.sh') }] })
	settings(root, 'settings.json', { PostToolUse: [{ matcher: '*', hooks: cmd('/usr/local/bin/blamely record claude') }] })
	settings(root, 'settings.local.json', { PostToolUse: [{ hooks: cmd('node check.mjs --all') }] })
	assert.deepEqual(await editHooks(root, home), ['format.sh', 'blamely record', 'check.mjs'])
})

test('hooks that do not run after an edit are left out: other events, other tools, a broken matcher, no command', async () => {
	const home = temp('flow-hooks-home-')
	const root = temp('flow-hooks-root-')
	settings(root, 'settings.json', {
		PreToolUse: [{ matcher: 'Edit', hooks: cmd('before.sh') }],
		Stop: [{ hooks: cmd('stop.sh') }],
		PostToolUse: [{ matcher: 'Bash', hooks: cmd('bash-only.sh') }, { matcher: '(', hooks: cmd('broken.sh') }, { matcher: 'Edit', hooks: [{ type: 'command' }] }, { matcher: 'MultiEdit', hooks: cmd('kept.sh') }],
	})
	assert.deepEqual(await editHooks(root, home), ['kept.sh'])
})

test('no settings, or settings that are not JSON, give no hooks', async () => {
	const home = temp('flow-hooks-home-')
	const root = temp('flow-hooks-root-')
	assert.deepEqual(await editHooks(root, home), [])
	mkdirSync(join(root, '.claude'), { recursive: true })
	writeFileSync(join(root, '.claude', 'settings.json'), '{ not json')
	assert.deepEqual(await editHooks(root, home), [])
})
