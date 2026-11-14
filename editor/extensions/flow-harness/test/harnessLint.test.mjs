// The headless harness lint (cli/harness-lint.ts, built to out/harness-lint.js by esbuild.mjs) run as a process against small
// repositories: a clean one, one with a broken permission rule and a hook whose script is missing, malformed JSON, and the flags.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'out', 'harness-lint.js')
let tmp
let n = 0

before(() => {
	// The real build, so the entry and its esbuild settings are what is tested (no vscode module exists here).
	execFileSync(process.execPath, ['esbuild.mjs'], { cwd: ROOT, stdio: 'ignore' })
	tmp = realpathSync(mkdtempSync(join(tmpdir(), 'flow-harnesslint-')))
})
after(() => rmSync(tmp, { recursive: true, force: true }))

/** A repository with these files; no git, no home folder involved. */
function repo(files) {
	const dir = join(tmp, 'r' + n++)
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, name), text)
	}
	return dir
}
const lint = (args, env = {}) => {
	const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: tmp, USERPROFILE: tmp, CLAUDE_CONFIG_DIR: join(tmp, 'no-claude'), CODEX_HOME: join(tmp, 'no-codex'), ...env } })
	return { code: r.status, out: r.stdout, err: r.stderr }
}
const settings = obj => JSON.stringify(obj, null, 2)
const GOOD = {
	'CLAUDE.md': '# Project\nUse tabs.\n',
	'.claude/hooks/check.sh': '#!/bin/sh\nexit 0\n',
	'.claude/settings.json': settings({
		hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash .claude/hooks/check.sh' }] }] },
		permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(./.env)'] },
	}),
}
const BROKEN = {
	'.claude/settings.json': settings({
		hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash .claude/hooks/missing.sh' }] }] },
		permissions: { allow: ['Bash*'] },
	}),
}

test('a clean repository exits 0 and prints no finding', () => {
	const r = lint(['--cwd', repo(GOOD)])
	assert.deepEqual([r.code, r.out], [0, ''], r.err)
	assert.match(r.err, /0 errors, 0 warnings/)
})

test('a missing hook script and a broken permission rule exit 1 with a finding for each: path:line:col severity rule message', () => {
	const r = lint(['--cwd', repo(BROKEN)])
	assert.equal(r.code, 1)
	const lines = r.out.trim().split('\n')
	assert.match(lines.find(l => /missing-script/.test(l)), /^\.claude\/settings\.json:\d+:1 error missing-script Script \.claude\/hooks\/missing\.sh does not exist$/)
	assert.match(lines.find(l => /rule-never-applies/.test(l)), /^\.claude\/settings\.json:\d+:1 error rule-never-applies Bash\*:/)
})

test('a permission rule that never applies fails by default; one a stricter rule overrides, and advice, stay warnings', () => {
	const never = lint(['--cwd', repo({ '.claude/settings.json': settings({ permissions: { allow: ['Bash*'] } }) })])
	assert.equal(never.code, 1, never.out)
	assert.match(never.out, / error rule-never-applies /)
	for (const permissions of [{ allow: ['Bash(git push:*)'], deny: ['Bash(git push:*)'] }, { allow: ['Bash(npm run build)'], ask: ['Bash(npm run *)'] }]) {
		const r = lint(['--cwd', repo({ '.claude/settings.json': settings({ permissions }) })])
		assert.equal(r.code, 0, JSON.stringify(permissions) + '\n' + r.out)
		assert.match(r.out, / warning (shadowed|rule-conflict) /)
		assert.equal(lint(['--cwd', repo({ '.claude/settings.json': settings({ permissions }) }), '--max-warnings', '0']).code, 1)
	}
	const advice = lint(['--cwd', repo({ '.claude/settings.json': settings({ permissions: { allow: ['Bash(git *)'] } }) })])
	assert.deepEqual(advice.code, 0)
	assert.match(advice.out, / warning overbroad /)
})

test('warnings alone fail only past --max-warnings', () => {
	const dir = repo({ '.claude/settings.json': settings({ permissions: { allow: ['Bash(git *)'] } }) })
	assert.equal(lint(['--cwd', dir]).code, 0)
	assert.equal(lint(['--cwd', dir, '--max-warnings', '1']).code, 0)
	assert.equal(lint(['--cwd', dir, '--max-warnings=0']).code, 1)
})

test('malformed JSON is a finding, not a crash', () => {
	const r = lint(['--cwd', repo({ '.claude/settings.json': '{ "hooks": ', '.claude/settings.local.json': '[not json' })])
	assert.equal(r.code, 1)
	assert.match(r.out, /^\.claude\/settings\.json:1:1 error invalid-json Invalid JSON/m)
	assert.match(r.out, /^\.claude\/settings\.local\.json:1:1 error invalid-json/m)
	assert.doesNotMatch(r.err, /at .*\.js:\d+/, 'no stack trace')
})

test('--json prints an array of the same findings', () => {
	const r = lint(['--json', '--cwd', repo(BROKEN)])
	const found = JSON.parse(r.out)
	assert.equal(r.code, 1)
	assert.ok(Array.isArray(found))
	const script = found.find(f => f.rule === 'missing-script')
	assert.deepEqual({ ...script, line: undefined }, { file: '.claude/settings.json', line: undefined, column: 1, severity: 'error', rule: 'missing-script', message: 'Script .claude/hooks/missing.sh does not exist' })
	assert.ok(script.line >= 1)
	assert.deepEqual(JSON.parse(lint(['--json', '--cwd', repo(GOOD)]).out), [])
})

test('a page that is not JSON never has its text quoted: the finding says where, not what', () => {
	const r = lint(['--cwd', repo({ '.claude/settings.json': 'TOKEN=ghp_abcdefghijklmnop', '.claude/settings.local.json': '{ "a": 1,\n "b" 2 }' })])
	assert.equal(r.code, 1)
	assert.doesNotMatch(r.out + r.err, /ghp_|TOKEN/)
	assert.match(r.out, /^\.claude\/settings\.json:1:1 error invalid-json Invalid JSON$/m)
	assert.match(r.out, /^\.claude\/settings\.local\.json:2:1 error invalid-json Invalid JSON at line 2, column \d+$/m)
})

test('a link that leads out of the repository is reported and never read', { skip: process.platform === 'win32' && 'a symbolic link needs a privilege a Windows runner does not have' }, () => {
	const secret = repo({ 'secret.txt': 'TOKEN=ghp_abcdefghijklmnop', 'steal.md': '# Steal\n@~/nope.md\n' })
	const dir = repo({ 'CLAUDE.md': '# Project\n' })
	mkdirSync(join(dir, '.claude'))
	symlinkSync(join(secret, 'secret.txt'), join(dir, '.claude', 'settings.json'))
	symlinkSync(join(secret, 'steal.md'), join(dir, 'AGENTS.md'))
	const r = lint(['--cwd', dir])
	assert.doesNotMatch(r.out + r.err, /ghp_|TOKEN|nope/)
	assert.match(r.out, /^\.claude\/settings\.json:1:1 warning outside-repo /m)
	assert.match(r.out, /^AGENTS\.md:1:1 warning outside-repo /m)
	assert.equal(r.code, 0, 'a warning')
	assert.equal(lint(['--cwd', dir, '--max-warnings', '0']).code, 1)
	// A whole .claude folder that leads out is refused file by file: only outside-repo findings, no empty-file ones.
	const linked = repo({ 'CLAUDE.md': '# Project\n' })
	const away = repo({ 'agents/a.md': '# No frontmatter\n', 'rules/r.md': '# No frontmatter\n', 'skills/s/SKILL.md': '# s\n' })
	symlinkSync(away, join(linked, '.claude'))
	const out = lint(['--cwd', linked]).out
	assert.match(out, /outside-repo/)
	assert.doesNotMatch(out, /no-frontmatter/)
	for (const l of out.trim().split('\n').filter(Boolean)) {
		assert.match(l, / outside-repo /)
	}
	// A link that stays inside is read as any file.
	const inside = repo({ 'real.md': '# Real\n@missing-import.md\n' })
	symlinkSync(join(inside, 'real.md'), join(inside, 'CLAUDE.md'))
	assert.match(lint(['--cwd', inside]).out, /^CLAUDE\.md:\d+:1 error broken-import/m)
})

test('a path under ~ is the user\'s, not the repository\'s: an import or a hook script there is not checked, whatever the home folder holds', () => {
	const files = {
		'CLAUDE.md': '# Project\n@~/.claude/personal.md\n',
		'.claude/settings.json': settings({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/bin/guard.sh' }, { type: 'command', command: 'bash $HOME/bin/other.sh' }] }] } }),
	}
	const empty = repo({})
	const r = lint(['--cwd', repo(files)], { HOME: empty, USERPROFILE: empty })
	assert.deepEqual([r.code, r.out], [0, ''], r.err)
	// The same on a machine whose home does hold them, and a repository's own broken import still counts.
	const home = repo({ '.claude/personal.md': 'x', 'bin/guard.sh': 'x', 'bin/other.sh': 'x' })
	assert.deepEqual(lint(['--cwd', repo(files)], { HOME: home, USERPROFILE: home }).out, '')
	assert.equal(lint(['--cwd', repo({ ...files, 'CLAUDE.local.md': '@gone.md\n' })], { HOME: empty, USERPROFILE: empty }).code, 1)
})

test('agent worktrees are skipped at any depth, and the CLI skips the very folders the editor\'s search excludes', () => {
	// Read from the editor's own excludes, so a worktree folder added there and not to the CLI fails here.
	const scan = readFileSync(join(ROOT, 'src', 'scan.ts'), 'utf8')
	const dirs = [...new Set([...scan.matchAll(/\*\*\/(\.[\w-]+\/worktrees)\/\*\*/g)].map(m => m[1]))].sort()
	assert.deepEqual(dirs, ['.axle/worktrees', '.claude/worktrees', '.insilode/worktrees'])
	const bad = '# Copy\n@broken-import.md\n'
	const files = { 'CLAUDE.md': '# Project\n', 'packages/app/CLAUDE.md': bad }
	for (const d of dirs) {
		files[`${d}/one/CLAUDE.md`] = bad
		files[`packages/app/${d}/two/CLAUDE.md`] = bad
	}
	const r = lint(['--cwd', repo(files)])
	assert.deepEqual(r.out.trim().split('\n').map(l => l.split(':')[0]), ['packages/app/CLAUDE.md'], r.out)
})

test('the user\'s own files are not read: a broken ~/.claude changes nothing', () => {
	const home = repo({ '.claude/settings.json': settings({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bash nope.sh' }] }] } }) })
	const r = lint(['--cwd', repo(GOOD)], { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') })
	assert.deepEqual([r.code, r.out], [0, ''])
})

test('usage and read errors exit 2, with the reason on stderr and nothing on stdout', () => {
	for (const args of [['--bogus'], ['extra'], ['--cwd'], ['--max-warnings', 'many'], ['--max-warnings'], ['--cwd', join(tmp, 'no-such-folder')]]) {
		const r = lint(args)
		assert.deepEqual([r.code, r.out], [2, ''], args.join(' '))
		assert.ok(r.err.length > 0)
	}
	assert.match(lint(['--bogus']).err, /Usage: harness-lint/)
	const file = repo({ 'a.txt': 'x' })
	assert.equal(lint(['--cwd', join(file, 'a.txt')]).code, 2, 'a file is not a folder')
})

// The CLI prints `/` on every platform; the Windows branch is run here through path.win32, whatever this machine is.
test('a finding\'s file is relative to the folder with forward slashes, whatever the platform\'s separator and drive letter case', () => {
	const { shownPath } = createRequire(import.meta.url)(CLI)
	assert.equal(shownPath('C:\\repo', 'C:\\repo\\.claude\\settings.json', win32), '.claude/settings.json')
	assert.equal(shownPath('c:\\repo', 'C:\\Repo\\packages\\app\\CLAUDE.md', win32), 'packages/app/CLAUDE.md')
	assert.equal(shownPath('C:\\repo', 'D:\\elsewhere\\a.md', win32), 'D:\\elsewhere\\a.md', 'another drive: as it is')
	assert.equal(shownPath('C:\\repo', 'C:\\other\\a.md', win32), 'C:\\other\\a.md', 'outside the folder: as it is')
	assert.equal(shownPath('/r', '/r/.claude/settings.json'), '.claude/settings.json')
})

test('--help prints the usage and exits 0', () => {
	const r = lint(['--help'])
	assert.deepEqual([r.code, /Usage: harness-lint/.test(r.out)], [0, true])
})
