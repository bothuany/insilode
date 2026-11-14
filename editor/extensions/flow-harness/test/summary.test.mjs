// The harness summary that `flowHarness.summary` answers for the Agents page's panel (src/summary.ts, summaryCore.ts, redact.ts): the
// redaction of anything credential-like, the caps on every list and string, the refusal of a path that is not an existing absolute folder,
// and the summary of real folders that are not the open workspace (there is no `vscode` here at all).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 10000 }
let tmp
let S // summary.ts
let C // summaryCore.ts
let R // redact.ts
let H // scanFsHost.ts
let LL // harnessLint.ts
let CLI // cli/harness-lint.ts
let n = 0

const write = (file, text) => {
	mkdirSync(dirname(file), { recursive: true })
	writeFileSync(file, text)
}
const repo = files => {
	const dir = join(tmp, 'r' + n++)
	mkdirSync(dir, { recursive: true })
	for (const [name, text] of Object.entries(files)) { write(join(dir, name), text) }
	return dir
}
const bundle = async (name, dir = 'src') => {
	const outfile = join(tmp, name + '.mjs')
	await build({ entryPoints: [join(ROOT, dir, name + '.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', mainFields: ['module', 'main'] })
	return import(pathToFileURL(outfile).href)
}

before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-summary-')))
	// The user's own folders are the test's, never the real home of whoever runs it.
	process.env.CLAUDE_CONFIG_DIR = join(tmp, 'user-claude')
	process.env.CODEX_HOME = join(tmp, 'user-codex')
	process.env.HOME = tmp
	process.env.USERPROFILE = tmp
	write(join(tmp, 'user-claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Read'], deny: ['Bash(npm test:*)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }] } }))
	write(join(tmp, 'user-claude', 'commands', 'mine.md'), 'secret prompt body')
	;[S, C, R, H, LL] = await Promise.all(['summary', 'summaryCore', 'redact', 'scanFsHost', 'harnessLint'].map(n => bundle(n)))
	// The CLI is a CommonJS entry (it checks `require.main`): bundled as one.
	const cli = join(tmp, 'harness-lint.cjs')
	await build({ entryPoints: [join(ROOT, 'cli', 'harness-lint.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: cli, logLevel: 'silent', mainFields: ['module', 'main'] })
	CLI = await import(pathToFileURL(cli).href).then(m => m.main ? m : m.default)
})
after(() => rmSync(tmp, { recursive: true, force: true }))

// ---- redaction -------------------------------------------------------------------------------------------------------------
const SECRETS = ['hunter2', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'AKIAIOSFODNN7EXAMPLE', 's3cr3tV4lue', 'p4ssw0rd!', 'abc123token456']

test('environment assignments keep their name and lose their value, quoted or not, exported or not, at the start or after a pipe', T, () => {
	assert.equal(R.redact('API_KEY=hunter2 node run.js'), 'API_KEY=*** node run.js')
	assert.equal(R.redact('export TOKEN="s3cr3tV4lue with spaces" && npm test'), 'export TOKEN=*** && npm test')
	assert.equal(R.redact("A=1 B='two words' C= node x.js"), 'A=*** B=*** C=*** node x.js')
	assert.equal(R.redact('cat f | FOO=bar sh'), 'cat f | FOO=*** sh')
	assert.equal(R.redact('cd x; DEBUG=hunter2 make'), 'cd x; DEBUG=*** make')
	// Everything after the first `=` goes, including more `=` signs.
	assert.equal(R.redact('DB=postgres://u:p@h/db?a=b node x'), 'DB=*** node x')
})

test('URL credentials go (user and password, or a token alone), and so do secret-looking query values; the host stays', T, () => {
	assert.equal(R.redact('curl https://user:hunter2@example.com/path'), 'curl https://***@example.com/path')
	assert.equal(R.redact('git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r'), 'git clone https://***@github.com/o/r')
	assert.equal(R.redact('curl "https://api.example.com/v1?token=abc123token456&page=2&api_key=zzz"'), 'curl "https://api.example.com/v1?token=***&page=2&api_key=***"')
	assert.equal(R.redact('http://localhost:3000/health'), 'http://localhost:3000/health')
})

test('Authorization-like headers lose their value, in any case, in -H arguments and plain lines', T, () => {
	assert.equal(R.redact(`curl -H "Authorization: Bearer abc123token456" https://x.dev`), 'curl -H "Authorization: ***" https://x.dev')
	assert.equal(R.redact(`curl -H 'authorization: Basic dXNlcjpwYXNz' x`), `curl -H 'authorization: ***' x`)
	assert.equal(R.redact('X-Api-Key: abc123token456'), 'X-Api-Key: ***')
	assert.equal(R.redact(`curl -H "X-Auth-Token: p4ssw0rd!" -H "Accept: application/json" x`), 'curl -H "X-Auth-Token: ***" -H "Accept: application/json" x')
	assert.equal(R.redact('Proxy-Authorization: Basic abc'), 'Proxy-Authorization: ***')
	assert.equal(R.redact('Cookie: session=abc123token456; theme=dark'), 'Cookie: ***')
	assert.equal(R.redact('echo Bearer abc123token456'), 'echo Bearer ***')
})

test('flags that name a credential lose their value, joined by = or in the next word; other flags and the command stay', T, () => {
	assert.equal(R.redact('tool --token=hunter2 --port=3000 --verbose'), 'tool --token=*** --port=3000 --verbose')
	assert.equal(R.redact('tool --api-key hunter2 --out build'), 'tool --api-key *** --out build')
	assert.equal(R.redact(`tool --password 'p4ssw0rd!' --user admin`), 'tool --password *** --user ***')
	assert.equal(R.redact('curl -u admin:hunter2 https://x.dev'), 'curl -u *** https://x.dev')
	assert.equal(R.redact('npx -y @scope/server --path=/usr/bin --config ./c.json'), 'npx -y @scope/server --path=/usr/bin --config ./c.json')
})

test('keys by their make and long random-looking runs go wherever they stand; ordinary words, paths and short ids stay', T, () => {
	// A bare word cannot be known for a password: only what is shaped like a key is hidden standing alone (the rest is hidden by where it stands, above).
	for (const secret of SECRETS.filter(x => /^(ghp_|sk-|eyJ|AKIA)/.test(x))) {
		const out = R.redact(`run ${secret} now`)
		assert.ok(!out.includes(secret), `${secret} -> ${out}`)
	}
	assert.equal(R.redact('node /usr/local/lib/node_modules/some-package/bin/cli.js check --fix'), 'node /usr/local/lib/node_modules/some-package/bin/cli.js check --fix')
	assert.equal(R.redact('bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh'), 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh')
	assert.equal(R.redact('echo done in 3s on build-42'), 'echo done in 3s on build-42')
})

test('a redacted line is one line, cut at the cap with an ellipsis, and a huge input costs no more than a long one', T, () => {
	assert.equal(R.redact('a\n  b\r\n c'), 'a b c')
	const long = R.redact('echo ' + 'x'.repeat(5000), 50)
	assert.equal(long.length, 50)
	assert.ok(long.endsWith('…'))
	const started = Date.now()
	const out = R.redact('A=' + 'b'.repeat(2_000_000) + ' ' + 'c '.repeat(500_000), 200)
	assert.ok(out.length <= 200)
	assert.ok(Date.now() - started < 1000, 'bounded work for a huge line')
	assert.equal(R.redact(''), '')
})

// ---- the caps --------------------------------------------------------------------------------------------------------------
/** What the CLI would print: more lines than the cap, each with a long message. */
const manyLines = () => Array.from({ length: 300 }, (_, i) => ({ file: `.claude/agents/a${i}.md`, abs: `/p/.claude/agents/a${i}.md`, line: i + 1, column: 1, severity: i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warning' : 'info', rule: 'x', message: `bad ${'x'.repeat(5000)} TOKEN=hunter2` }))

/** A scan result with more of everything than any cap, and strings far longer than any cap. */
function huge() {
	const long = 'x'.repeat(5000)
	const item = (kind, i, over = {}) => ({ kind, scope: 'project', label: `${kind}-${i}-${long}`, detail: long, file: `/p/${kind}-${i}`, issues: [], agents: ['Claude'], ...over })
	const items = []
	for (let i = 0; i < 200; i++) { items.push(item('instructions', i, { tokens: 10 })) }
	for (let i = 0; i < 200; i++) { items.push(item('hooks', i, { hook: { event: 'PreToolUse', matcher: long, command: `TOKEN=hunter2 node ${long}`, settingsFile: '/p/s' }, line: i })) }
	for (const effect of ['allow', 'ask', 'deny']) { for (let i = 0; i < 300; i++) { items.push(item('permissions', i, { rule: { effect, pattern: `Bash(curl -H "Authorization: Bearer hunter2" ${long})` } })) } }
	for (let i = 0; i < 100; i++) { items.push(item('mcp', i, { mcp: { id: `m${i}`, toolPrefix: 'p', state: 'on', transport: 'stdio', target: `npx server --token=hunter2 ${long}` } })) }
	for (let i = 0; i < 300; i++) { items.push(item('skills', i)) }
	for (let i = 0; i < 300; i++) { items.push(item('agents', i)) }
	return { root: '/p', items, score: 77, counts: { error: 0, warning: 0, info: 0 }, gaps: [], startupTokens: 123 }
}

test('every list is capped and says how many there were; every string is cut; counts stay the true ones', T, () => {
	const s = C.buildSummary(huge(), { lint: manyLines(), commands: Array.from({ length: 400 }, (_, i) => ({ name: '/c' + i, scope: 'project', file: `/p/c${i}.md` })), home: '/home/u' }, '/p')
	const { CAPS } = C
	assert.equal(s.instructions.length, CAPS.instructions)
	assert.equal(s.hooks.length, CAPS.hooks)
	for (const e of ['allow', 'ask', 'deny']) {
		assert.equal(s.permissions[e].length, CAPS.rules)
		assert.equal(s.permissions.counts[e], 300, 'the count is the real one')
	}
	assert.equal(s.mcp.length, CAPS.mcp)
	assert.deepEqual([s.skills.items.length, s.skills.count, s.agents.items.length, s.agents.count, s.commands.items.length, s.commands.count], [CAPS.names, 300, CAPS.names, 300, CAPS.names, 400])
	assert.equal(s.findings.length, CAPS.findings)
	assert.deepEqual(s.counts, { error: 100, warning: 100, info: 100 }, 'counts are of all findings')
	assert.equal(s.findings[0].severity, 'error', 'errors first')
	// Every string is bounded.
	const walk = (v, f) => { if (typeof v === 'string') { f(v) } else if (Array.isArray(v)) { v.forEach(x => walk(x, f)) } else if (v && typeof v === 'object') { Object.values(v).forEach(x => walk(x, f)) } }
	let longest = 0
	walk(s, str => { longest = Math.max(longest, str.length) })
	assert.ok(longest <= CAPS.path, 'longest string: ' + longest)
	assert.ok(JSON.stringify(s).length < 300_000, 'a bounded answer: ' + JSON.stringify(s).length)
	assert.ok(s.notes.length >= 1 && s.notes.length <= 10)
	assert.ok(s.notes.some(x => /Showing 60 of 200 hooks/.test(x)))
	// And nothing credential-shaped came through the commands, rules, servers or messages.
	assert.ok(!JSON.stringify(s).includes('hunter2'))
	assert.ok(s.hooks.every(h => h.command.length <= CAPS.command))
	assert.equal(s.hooks[0].line, 1, 'lines are 1-based')
	assert.deepEqual(s.findings.slice(0, 2).map(f => [f.line, f.code]), [[1, 'x'], [4, 'x']], 'errors first, each severity in the CLI\'s order')
})

test('lint lines: a permission rule that is never consulted counts as an error, as the CLI counts it, and lines are ordered by file then line', T, () => {
	const issue = (severity, code, line, message = code) => ({ severity, code, line, message })
	const items = [
		{ kind: 'permissions', scope: 'project', label: 'x', detail: '', file: '/p/b.json', issues: [issue('warning', 'rule-never-applies', 4), issue('warning', 'overbroad', 1)], agents: [] },
		{ kind: 'instructions', scope: 'project', label: 'x', detail: '', file: '/p/a.md', issues: [{ severity: 'info', message: ' two\n lines ' }], agents: [] },
	]
	const lines = LL.lintLines({ items }, '/p')
	assert.deepEqual(lines.map(l => [l.file, l.line, l.severity, l.rule, l.message]), [['a.md', 1, 'info', 'harness', 'two lines'], ['b.json', 2, 'warning', 'overbroad', 'overbroad'], ['b.json', 5, 'error', 'rule-never-applies', 'rule-never-applies']])
	assert.equal(lines[2].abs, '/p/b.json')
	const s = C.buildSummary({ root: '/p', items: [], score: 1, counts: {}, gaps: [], startupTokens: 0 }, { lint: lines, commands: [], home: '/h' }, '/p')
	assert.deepEqual(s.findings.map(f => [f.severity, f.code, f.where, f.line, f.file]), [['error', 'rule-never-applies', 'b.json', 5, '/p/b.json'], ['warning', 'overbroad', 'b.json', 2, '/p/b.json'], ['info', 'harness', 'a.md', 1, '/p/a.md']])
	assert.deepEqual(s.counts, { error: 1, warning: 1, info: 1 })
})

test('files are shown relative to the folder, the home folder as ~, and the summary names every file the panel may open', T, () => {
	const item = (file, over = {}) => ({ kind: 'instructions', scope: 'project', label: 'x', detail: '', file, issues: [], agents: [], ...over })
	const root = resolve('/proj')
	const home = resolve('/home/u')
	const s = C.buildSummary({ root, items: [item(join(root, 'CLAUDE.md')), item(join(home, '.claude', 'CLAUDE.md'), { scope: 'user' }), item(resolve('/etc/elsewhere.md'))], score: 1, counts: {}, gaps: [], startupTokens: 0 }, { lint: [], commands: [{ name: '/a', scope: 'project', file: join(root, '.claude', 'commands', 'a.md') }], home }, root)
	assert.deepEqual(s.instructions.map(i => i.where), ['CLAUDE.md', '~/.claude/CLAUDE.md', resolve('/etc/elsewhere.md')])
	assert.deepEqual(C.filesOf(s).sort(), [join(root, 'CLAUDE.md'), join(home, '.claude', 'CLAUDE.md'), resolve('/etc/elsewhere.md'), join(root, '.claude', 'commands', 'a.md')].sort())
})

// ---- the command's argument ------------------------------------------------------------------------------------------------
test('only an existing absolute folder is summarised: anything else is refused with a sentence, and nothing throws', T, async () => {
	const dir = repo({ 'CLAUDE.md': '# x\n' })
	const file = join(dir, 'CLAUDE.md')
	const refused = [undefined, null, 5, {}, [], ['/tmp'], '', 'relative/path', '.', '..', '~', '~/x', 'CLAUDE.md', 'a\0b', join(dir, 'a\0b'), '/' + 'x'.repeat(1100), join(tmp, 'does-not-exist'), file]
	for (const raw of refused) {
		const r = await S.harnessSummary(raw)
		assert.equal(r.ok, false, JSON.stringify(raw)?.slice(0, 60))
		assert.equal(typeof r.message, 'string')
		assert.ok(r.message.length > 0 && r.message.length < 200)
	}
	assert.equal((await S.harnessSummary(dir)).ok, true)
	// A trailing separator and a path that goes round (a/../b) name the same folder.
	assert.equal((await S.harnessSummary(dir + '/')).summary.root, dir)
	assert.equal((await S.harnessSummary(join(dir, 'x', '..'))).summary.root, dir)
	assert.equal(S.folderOf('/'), '/')
})

// ---- real folders ----------------------------------------------------------------------------------------------------------
const SECRET_REPO = {
	'CLAUDE.md': '# Project\nUse tabs. The secret password is hunter2-in-a-file.\n',
	'AGENTS.md': '# Agents\n',
	'src/CLAUDE.md': '# Src\n',
	'.claude/rules/style.md': '---\npaths: ["src/**"]\n---\nStyle rules with TOKEN=file-secret.\n',
	'.claude/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Ship it\n---\nSteps\n',
	'.claude/agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews\n---\nBody\n',
	'.claude/commands/ship.md': 'body of ship',
	'.claude/commands/git/sync.md': 'body of sync',
	'.claude/hooks/check.sh': '#!/bin/sh\nexit 0\n',
	'.claude/settings.json': JSON.stringify({
		hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 bash .claude/hooks/check.sh --api-key s3cr3tV4lue' }] }, { matcher: 'Edit', hooks: [{ type: 'command', command: 'bash .claude/hooks/missing.sh' }] }] },
		permissions: { defaultMode: 'plan', allow: ['Bash(npm test:*)', 'Bash(curl -H "Authorization: Bearer abc123token456" *)'], ask: ['Bash(git push:*)'], deny: ['Read(./.env)'] },
	}),
	'.claude/settings.local.json': JSON.stringify({ permissions: { defaultMode: 'acceptEdits', allow: ['Bash(ls)'] } }),
	'.mcp.json': JSON.stringify({ mcpServers: { github: { command: 'npx', args: ['-y', 'server', '--token', 'ghp_abcdefghijklmnopqrstuvwxyz0123'], env: { GITHUB_TOKEN: 's3cr3tV4lue' } }, remote: { type: 'http', url: 'https://user:hunter2@mcp.example.com/mcp?api_key=abc123token456', headers: { Authorization: 'Bearer abc123token456' } } } }),
}

test('a folder that is not the open workspace is summarised: instructions, rules, hooks, permissions, servers, names and findings', T, async () => {
	const dir = repo(SECRET_REPO)
	const r = await S.harnessSummary(dir)
	assert.equal(r.ok, true, JSON.stringify(r))
	const s = r.summary
	assert.equal(s.root, dir)
	assert.ok(s.instructions.some(i => i.name === 'CLAUDE.md' && i.scope === 'project' && i.where === 'CLAUDE.md' && i.file === join(dir, 'CLAUDE.md')))
	assert.ok(s.instructions.some(i => i.name === 'AGENTS.md'))
	assert.ok(s.instructions.some(i => i.kind === 'rules' && i.name === 'style.md'))
	assert.ok(s.instructions.some(i => i.scope === 'directory' && /src/.test(i.name)))
	// Hooks: the project's two, with where each is defined, and the user's own.
	const events = s.hooks.map(h => [h.event, h.scope])
	assert.deepEqual(events.filter(e => e[1] === 'project'), [['PreToolUse', 'project'], ['PreToolUse', 'project']])
	assert.ok(s.hooks.some(h => h.scope === 'user' && h.command === 'echo user-stop' && h.event === 'Stop'), 'the user\'s hooks are listed as the user\'s')
	assert.equal(s.hooks.find(h => /check\.sh/.test(h.command)).file, join(dir, '.claude', 'settings.json'))
	// Permissions: counts and rules, and the mode of the first settings file that sets one (local before project before user).
	assert.equal(s.permissions.mode, 'acceptEdits')
	assert.equal(s.permissions.modeWhere, '.claude/settings.local.json')
	assert.deepEqual(s.permissions.counts, { allow: 4, ask: 1, deny: 2 }, 'allow: project 2 + local 1 + user 1; deny: project 1 + user 1')
	assert.ok(s.permissions.deny.some(x => x.pattern === 'Read(./.env)'))
	// Servers by name, transport and scope.
	assert.deepEqual(s.mcp.map(m => [m.name, m.transport, m.scope]).sort(), [['github', 'stdio', 'project'], ['remote', 'http', 'project']])
	// Names.
	assert.deepEqual(s.skills.items.map(x => x.name), ['deploy'])
	assert.deepEqual(s.agents.items.map(x => x.name), ['reviewer'])
	assert.deepEqual(s.commands.items.map(x => [x.name, x.scope]).sort(), [['/git:sync', 'project'], ['/mine', 'user'], ['/ship', 'project']])
	// Findings: the missing script, and nothing from the user's files.
	assert.ok(s.findings.some(f => f.code === 'missing-script' && f.severity === 'error' && f.where === '.claude/settings.json' && f.line >= 1))
	assert.ok(s.counts.error >= 1)
	assert.equal(typeof s.score, 'number')
})

test('nothing secret leaves in the summary: no file contents, no token, password or header value anywhere in the JSON', T, async () => {
	const dir = repo(SECRET_REPO)
	const json = JSON.stringify((await S.harnessSummary(dir)).summary)
	for (const secret of [...SECRETS, 'hunter2', 'file-secret', 'body of ship', 'body of sync', 'secret prompt body', 'Use tabs', 'dXNlcjpwYXNz']) {
		assert.ok(!json.includes(secret), `the summary contains ${secret}`)
	}
	// The shape of the commands is still there.
	assert.match(json, /GITHUB_TOKEN=\*\*\* bash \.claude\/hooks\/check\.sh --api-key \*\*\*/)
	assert.match(json, /npx -y server --token \*\*\*/)
})

test('two summaries at once, of two folders, each get their own folder\'s answer (the scan keeps state in the module: they take turns)', T, async () => {
	const a = repo({ 'CLAUDE.md': '# A\n', '.claude/skills/alpha/SKILL.md': '---\nname: alpha\ndescription: A\n---\n' })
	const b = repo({ 'CLAUDE.md': '# B\n', '.claude/skills/beta/SKILL.md': '---\nname: beta\ndescription: B\n---\n' })
	const results = await Promise.all([a, b, a, b, a, b].map(d => S.harnessSummary(d)))
	assert.deepEqual(results.map(r => r.summary.root), [a, b, a, b, a, b])
	assert.deepEqual(results.map(r => r.summary.skills.items[0].name), ['alpha', 'beta', 'alpha', 'beta', 'alpha', 'beta'])
})

test('the summary reads and writes nothing it was not asked: the folder is as it was, and a link out of it is not followed into the answer', T, async () => {
	const outside = join(tmp, 'outside-secret.json')
	write(outside, JSON.stringify({ permissions: { allow: ['Bash(LEAKED-RULE)'], defaultMode: 'bypassPermissions' } }))
	const dir = repo({ 'CLAUDE.md': '# x\n' })
	mkdirSync(join(dir, '.claude'), { recursive: true })
	let linked = true
	try { symlinkSync(outside, join(dir, '.claude', 'settings.json')) } catch { linked = false }
	const before = JSON.stringify(await listing(dir))
	const r = await S.harnessSummary(dir)
	assert.equal(r.ok, true)
	assert.equal(JSON.stringify(await listing(dir)), before, 'nothing was created or changed')
	// A settings file that is a link out of the folder is not read at all: neither its rules nor its mode come back, and the map says why.
	if (linked) {
		const json = JSON.stringify(r.summary)
		assert.ok(!json.includes('LEAKED-RULE') && !json.includes('bypassPermissions'))
		assert.ok(r.summary.instructions.some(i => /link to something outside|link to a file outside/i.test(i.detail) || /outside/i.test(i.detail)), 'reported once, as a finding of the folder')
	}
})

async function listing(dir) {
	const { readdirSync, statSync } = await import('node:fs')
	const out = []
	const visit = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); out.push([p, statSync(p, { throwIfNoEntry: false })?.mtimeMs]); if (e.isDirectory()) { visit(p) } } }
	visit(dir)
	return out
}

test('the findings are the ones npm run harness:lint prints for the folder, whatever the user\'s own settings say', T, async () => {
	// The user's settings deny a rule the project allows: a scan that reads them adds a rule-conflict to the project rule, a lint run never does.
	const dir = repo({
		...SECRET_REPO,
		'.claude/settings.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'bash .claude/hooks/missing.sh' }] }] }, permissions: { allow: ['Bash(npm test:*)', 'Bash*', 'Bash(git *)'] } }),
		'CLAUDE.md': '# x\nSee @~/not-there.md and `docs/nothing.md`.\n',
	})
	let out = ''
	const code = await CLI.main(['--json', '--cwd', dir], { stdout: t => { out += t }, stderr: () => undefined })
	assert.equal(code, 1)
	const cli = JSON.parse(out).map(l => [l.file, l.line, l.severity, l.rule, l.message])
	assert.ok(cli.length >= 3, JSON.stringify(cli))
	const summary = (await S.harnessSummary(dir)).summary
	const mine = summary.findings.map(f => [f.where, f.line, f.severity, f.code, f.message])
	const order = (a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1
	assert.deepEqual([...mine].sort(order), [...cli].sort(order))
	assert.ok(!mine.some(f => f[3] === 'rule-conflict' || f[3] === 'shadowed' && /user/.test(f[4])), 'nothing came from the user\'s own deny rule')
	assert.deepEqual(summary.counts, { error: cli.filter(l => l[2] === 'error').length, warning: cli.filter(l => l[2] === 'warning').length, info: cli.filter(l => l[2] === 'info').length })
	// The lists still include what the user's own files add: the panel shows the harness an agent here runs with.
	assert.ok(summary.hooks.some(h => h.scope === 'user'))
})

test('a file too big to be a setting, and one that is not a file at all, is skipped instead of read', T, async () => {
	const dir = repo({ 'CLAUDE.md': '# small\n', 'AGENTS.md': 'x'.repeat(2 * 1024 * 1024) })
	const s = (await S.harnessSummary(dir)).summary
	assert.deepEqual(s.instructions.filter(i => i.scope === 'project').map(i => i.name), ['CLAUDE.md'], 'the 2 MB file is left out')
	// A named pipe where a settings file should be would never be read to its end.
	const { execFileSync } = await import('node:child_process')
	const pipeDir = repo({ 'CLAUDE.md': '# x\n' })
	mkdirSync(join(pipeDir, '.claude'), { recursive: true })
	try { execFileSync('mkfifo', [join(pipeDir, '.claude', 'settings.json')]) } catch { return }
	const started = Date.now()
	const r = await S.harnessSummary(pipeDir)
	assert.equal(r.ok, true)
	assert.ok(Date.now() - started < 2000, 'answered at once')
})

// ---- the time budget -------------------------------------------------------------------------------------------------------
test('a walk past its deadline stops at once and answers a list that callers read as cut, so no finding is made from it', T, async () => {
	const dir = repo({ 'a/CLAUDE.md': '#', 'b/c/AGENTS.md': '#', 'd.txt': '' })
	const folder = { name: 'x', fsPath: dir }
	const late = H.fsScanHost([dir], Date.now() - 1000)
	assert.deepEqual(await late.nested(folder, 200), [], 'the nested search read nothing')
	const cut = await late.listing(folder, 20_000)
	assert.equal(cut.length, 20_000, 'a full-length list: it is how a cut one is told')
	assert.equal(await late.somewhere('anything.ts'), true, 'no verdict on a cut listing')
	const open = H.fsScanHost([dir])
	assert.deepEqual((await open.nested(folder, 200)).map(f => f.slice(dir.length + 1)).sort(), ['a/CLAUDE.md', 'b/c/AGENTS.md'])
	assert.equal(await open.somewhere('nope.ts'), false)
})

test('a folder with a very large tree is answered within the hard limit, with a note when the search was cut', { timeout: 20000 }, async () => {
	const dir = repo({ 'CLAUDE.md': '# x\n' })
	// A wide tree: enough directories for the walk to be a visible cost, not enough to make the test slow.
	for (let i = 0; i < 400; i++) { mkdirSync(join(dir, 'pkg' + i, 'sub'), { recursive: true }) }
	const started = Date.now()
	const r = await S.harnessSummary(dir)
	assert.equal(r.ok, true)
	assert.ok(Date.now() - started < S.HARD_MS + 1000, 'answered in time: ' + (Date.now() - started))
	assert.ok(r.summary.instructions.some(i => i.name === 'CLAUDE.md'))
})
