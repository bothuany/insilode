// The scan on a folder the user owns (the harness map, `npm run harness:lint`) sees everything it saw before the scan was hardened for
// folders nobody trusted: no per-folder cap, links to folders followed (a loop by its real path), no cap on hooks, skills or findings.
// The same limits still apply to an untrusted scan (the Agents page's summary), and any scan that cuts or skips something says so.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = { timeout: 30000 }
let tmp
let S, H, SC, LI, LL
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
const timed = async f => {
	const started = Date.now()
	const value = await f()
	return { value, ms: Date.now() - started }
}
const folder = dir => ({ name: 'x', fsPath: dir })
/** The scan as the CLI runs it (trusted: the folder's own files) and as the summary runs it (nobody trusts the folder). */
const trusted = dir => SC.scanFolders([folder(dir)], H.fsScanHost([dir]), { user: false })
const untrusted = dir => SC.scanFolders([folder(dir)], H.fsScanHost([dir], Infinity, true), { user: false, untrusted: true })
/** Every message a scan shows about what it cut: its notes, and the info findings the map and the CLI print. */
const saidOf = harness => [...(harness.notes ?? []), ...harness.items.flatMap(i => i.issues.filter(x => x.code === 'scan-limited').map(x => x.message))]

before(async () => {
	tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'flow-trusted-')))
	process.env.CLAUDE_CONFIG_DIR = join(tmp, 'user-claude')
	process.env.CODEX_HOME = join(tmp, 'user-codex')
	process.env.HOME = tmp
	process.env.USERPROFILE = tmp
	;[S, H, SC, LI, LL] = await Promise.all(['summary', 'scanFsHost', 'scanCore', 'lint', 'harnessLint'].map(bundle))
})
after(() => rmSync(tmp, { recursive: true, force: true }))

// ---- 1: a folder of thousands of files -------------------------------------------------------------------------------------------
const bigFolder = (count, extra = {}) => {
	const dir = repo({
		'CLAUDE.md': '# x\n',
		'.claude/rules/a.md': '---\npaths:\n  - "gen/aa*.proto"\n---\nRule for the a files.\n',
		'.claude/rules/z.md': '---\npaths:\n  - "gen/zz*.proto"\n---\nRule for the z files.\n',
		'gen/aa1.proto': 'a\n', 'gen/zz1.proto': 'z\n',
		...extra,
	})
	for (let i = 0; i < count; i++) { writeFileSync(join(dir, 'gen', `f${i}.txt`), '') }
	return dir
}

test('a trusted listing has no per-folder cap: 12 000 files in one folder are all listed, so no rule is called dead and no nested CLAUDE.md is dropped', T, async () => {
	const extra = {}
	for (let i = 0; i < 60; i++) { extra[`gen/pkg${i}/CLAUDE.md`] = `# pkg ${i}\n` }
	const dir = bigFolder(12_000, extra)
	const host = H.fsScanHost([dir])
	const listed = await host.listing(folder(dir), 20_000)
	assert.equal(listed.filter(f => f.startsWith('gen/')).length, 12_000 + 2 + 60)
	assert.equal((await host.nested(folder(dir), 200)).length, 61, 'the 60 nested ones and the root one')
	const lines = await LL.lintFolder(dir)
	assert.deepEqual(lines.filter(l => l.rule === 'dead-glob'), [], 'a listing that was whole has no false verdict')
	assert.deepEqual(lines.filter(l => l.rule === 'scan-limited'), [])
})

test('an untrusted listing keeps its cap, says it was cut, and gives no "matches no file" verdict from it', T, async () => {
	const dir = bigFolder(6000)
	const r = await S.harnessSummary(dir)
	assert.equal(r.ok, true, JSON.stringify(r))
	assert.ok(r.summary.notes.some(x => /5000/.test(x)), 'the cut is in the notes: ' + JSON.stringify(r.summary.notes))
	assert.deepEqual(r.summary.findings.filter(f => f.code === 'dead-glob'), [], JSON.stringify(r.summary.findings))
	// The host itself tells what it left out, and a cut listing is padded to the limit (how callers tell a cut list).
	const host = H.fsScanHost([dir], Infinity, true)
	assert.equal((await host.listing(folder(dir), 20_000)).length, 20_000)
	assert.ok(host.limits?.().some(x => /5000/.test(x)))
})

// ---- 2: links to folders ---------------------------------------------------------------------------------------------------------
test('trusted: a link to a folder in .claude/rules is followed (a loop by its real path, once), untrusted: skipped and said', T, async () => {
	const dir = repo({ 'CLAUDE.md': '# x\n', 'shared-src/team.md': 'A shared rule.\n', '.claude/rules/keep.md': 'A rule that stays.\n' })
	symlinkSync('../../shared-src', join(dir, '.claude', 'rules', 'shared'))
	symlinkSync('.', join(dir, '.claude', 'rules', 'a'))
	symlinkSync('.', join(dir, '.claude', 'rules', 'b'))
	symlinkSync('..', join(dir, '.claude', 'rules', 'up'))
	const own = await timed(() => trusted(dir))
	assert.ok(own.ms < 1500, 'took ' + own.ms)
	assert.deepEqual(own.value.items.filter(i => i.kind === 'rules').map(i => i.label).sort(), ['keep.md', 'shared/team.md'])
	assert.ok(saidOf(own.value).some(x => /link/i.test(x)), 'a link that loops back is said: ' + JSON.stringify(saidOf(own.value)))
	const theirs = await untrusted(dir)
	assert.deepEqual(theirs.items.filter(i => i.kind === 'rules').map(i => i.label), ['keep.md'])
	assert.ok(saidOf(theirs).some(x => /link/i.test(x)), JSON.stringify(saidOf(theirs)))
})

test('trusted: a real folder is entered once and a real file listed once, whatever number of links lead to them', T, async () => {
	// 12 folders, each with two links to the next: every file is reachable through 2^n paths, and the walk takes each real folder once.
	const files = { 'CLAUDE.md': '# x\n' }
	for (let i = 0; i <= 12; i++) { files[`.claude/rules/n${i}/r${i}.md`] = `Rule ${i}.\n` }
	const dir = repo(files)
	for (let i = 0; i < 12; i++) {
		symlinkSync(`../n${i + 1}`, join(dir, '.claude', 'rules', `n${i}`, 'a'))
		symlinkSync(`../n${i + 1}`, join(dir, '.claude', 'rules', `n${i}`, 'b'))
	}
	const own = await timed(() => trusted(dir))
	assert.ok(own.ms < 3000, 'took ' + own.ms)
	assert.equal(own.value.items.filter(i => i.kind === 'rules').length, 13, own.value.items.filter(i => i.kind === 'rules').map(i => i.label).join(' '))
	assert.ok(saidOf(own.value).some(x => /link/i.test(x)), JSON.stringify(saidOf(own.value)))
	// Two folders that link to each other, and two links to one file: each file once.
	const two = repo({ 'CLAUDE.md': '# x\n', '.claude/rules/x/ax.md': 'In x.\n', '.claude/rules/y/by.md': 'In y.\n', '.claude/rules/real.md': 'One file.\n' })
	symlinkSync('../y', join(two, '.claude', 'rules', 'x', 'toy'))
	symlinkSync('../x', join(two, '.claude', 'rules', 'y', 'tox'))
	symlinkSync('real.md', join(two, '.claude', 'rules', 'again.md'))
	const labels = (await trusted(two)).items.filter(i => i.kind === 'rules').map(i => i.label).sort()
	assert.equal(labels.length, 3, labels.join(' '))
	assert.equal(new Set(labels.map(l => l.replace(/^.*\//, ''))).size, 3, 'no file twice: ' + labels.join(' '))
})

test('a cut made in a folder is a finding of that folder: no line, and no instruction file stands in for it', T, async () => {
	const dir = repo({ 'CLAUDE.md': '# x\n', '.claude/rules/keep.md': 'A rule.\n' })
	symlinkSync('.', join(dir, '.claude', 'rules', 'a'))
	const harness = await trusted(dir)
	const limit = harness.items.find(i => i.issues.some(x => x.code === 'scan-limited'))
	assert.equal(limit.file, join(dir, '.claude', 'rules'))
	assert.equal(limit.issues[0].line, undefined)
	assert.equal(limit.agents.length, 0)
	const lines = await LL.lintFolder(dir)
	assert.equal(lines.find(l => l.rule === 'scan-limited').file, '.claude/rules')
	assert.equal(lines.filter(l => l.file === 'CLAUDE.md').length, 0, JSON.stringify(lines))
	const A = await bundle('activity')
	assert.equal(A.isTracked(limit), false)
})

test('the CLI still reports a rules folder that is a link out of the repository: outside-repo, and nothing of it is read', T, async () => {
	const outside = join(tmp, 'dotfiles-' + n++)
	write(join(outside, 'mine.md'), 'A rule of mine, elsewhere.\n')
	const dir = repo({ 'CLAUDE.md': '# x\n' })
	mkdirSync(join(dir, '.claude', 'rules'), { recursive: true })
	symlinkSync(outside, join(dir, '.claude', 'rules', 'shared'))
	const lines = await LL.lintFolder(dir)
	assert.ok(lines.some(l => l.rule === 'outside-repo' && l.severity === 'warning'), JSON.stringify(lines))
	const harness = await trusted(dir)
	assert.deepEqual(harness.items.filter(i => i.kind === 'rules'), [])
})

// ---- 3: caps that were silent ----------------------------------------------------------------------------------------------------
test('trusted: 600 hooks, 1100 skills and 60 repeated lines are all seen; untrusted: the caps stay and every one says so', T, async () => {
	const hooks = Array.from({ length: 600 }, (_, i) => ({ type: 'command', command: `bash .claude/h${i}.sh` }))
	const files = { 'CLAUDE.md': '# x\n', '.claude/settings.json': JSON.stringify({ hooks: { Stop: [{ hooks }] } }, null, 2) }
	for (let i = 0; i < 1100; i++) { files[`.claude/skills/s${i}/SKILL.md`] = `---\nname: s${i}\ndescription: Skill number ${i} that does one small thing well\n---\nBody\n` }
	const dir = repo(files)
	const lines = await LL.lintFolder(dir)
	assert.equal(lines.filter(l => l.rule === 'missing-script').length, 600)
	assert.equal(lines.filter(l => l.rule === 'scan-limited').length, 0)
	assert.equal((await trusted(dir)).items.filter(i => i.kind === 'skills').length, 1100)
	const theirs = await untrusted(dir)
	assert.ok(theirs.items.filter(i => i.kind === 'skills').length <= 1000)
	assert.ok(theirs.items.filter(i => i.kind === 'hooks').length <= 500)
	const said = saidOf(theirs).join('\n')
	assert.match(said, /first 1000/, said)
	assert.match(said, /hooks|500/i, said)
})

test('the lint cuts findings per check only for an untrusted scan, and says so', T, () => {
	const text = 'Always run the whole test suite before you push anything\n'.repeat(60)
	const input = { files: [{ file: '/p/CLAUDE.md', label: 'CLAUDE.md', kind: 'claude-md', text }], hooks: [], rules: [], cwd: '/p', home: '/h' }
	assert.equal(LI.lint(input).filter(f => f.code === 'duplicate').length, 59)
	const cut = LI.lint({ ...input, untrusted: true })
	assert.equal(cut.filter(f => f.code === 'duplicate').length, 50)
	assert.ok(cut.some(f => f.code === 'scan-limited' && /duplicate|more/i.test(f.message)), JSON.stringify(cut.filter(f => f.code !== 'duplicate')))
})

// ---- the lint's own guards -------------------------------------------------------------------------------------------------------
const ruleFile = glob => ({ file: '/p/.claude/rules/r.md', label: 'r.md', kind: 'claude-rule', text: `---\npaths:\n  - "${glob}"\n---\nbody text of the rule\n` })
const lintGlob = (glob, projectFiles, extra = {}) => LI.lint({ files: [ruleFile(glob)], hooks: [], rules: [], cwd: '/p', home: '/h', projectFiles, ...extra })

test('trusted: one very long path in the project does not switch the dead-glob check off; untrusted: it does, and says so', T, () => {
	const files = ['src/a.ts', 'x'.repeat(401) + '.txt']
	assert.equal(lintGlob('nothing/**/*.zz', files).filter(f => f.code === 'dead-glob').length, 1)
	assert.equal(lintGlob('nothing/**/*.zz', files, { untrusted: true }).filter(f => f.code === 'dead-glob').length, 0)
	assert.ok(lintGlob('nothing/**/*.zz', files, { untrusted: true }).some(f => f.code === 'scan-limited'))
})

test('a glob too elaborate to match safely gets no verdict, in either mode, and the lint says it skipped it', T, () => {
	for (const untrusted of [false, true]) {
		const out = lintGlob('*a*a*a*a*a*a*a*b', ['src/a.ts'], { untrusted })
		assert.equal(out.filter(f => f.code === 'dead-glob').length, 0)
		assert.equal(out.filter(f => f.code === 'scan-limited').length, 1, JSON.stringify(out))
	}
})

test('a project of more than 20 000 files: a listing that was cut never gives a "matches no file" finding, and the scan says it was cut', { timeout: 60000 }, async () => {
	const files = { 'CLAUDE.md': '# x\n', '.claude/rules/r.md': '---\npaths:\n  - "nothing/**/*.zz"\n---\nA rule.\n' }
	const dir = repo(files)
	mkdirSync(join(dir, 'many'), { recursive: true })
	for (let i = 0; i < 20_050; i++) { writeFileSync(join(dir, 'many', `f${i}.txt`), '') }
	const harness = await trusted(dir)
	assert.deepEqual(harness.items.flatMap(i => i.issues).filter(x => x.code === 'dead-glob'), [])
	assert.ok(saidOf(harness).some(x => /20000|20 000/.test(x)), JSON.stringify(saidOf(harness)))
})

test('what a scan says it cut does not hide that a project has no CLAUDE.md', T, async () => {
	const dir = repo({ '.claude/rules/keep.md': 'A rule.\n' })
	symlinkSync('.', join(dir, '.claude', 'rules', 'a'))
	const harness = await trusted(dir)
	assert.ok(saidOf(harness).length > 0)
	assert.ok(harness.gaps.some(g => g.key === 'instructions'), JSON.stringify(harness.gaps))
})
