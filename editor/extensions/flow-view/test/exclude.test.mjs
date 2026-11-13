// Which paths the index leaves out: the walk, the file watcher and the language server share isExcludedPath.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Index, ROOT } from './helpers.mjs'

const BS = String.fromCharCode(92)
let isExcludedPath
let tmp
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-exclude-'))
	const outfile = join(tmp, 'model.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'poly', 'model.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	;({ isExcludedPath } = await import(pathToFileURL(outfile).href))
})
after(() => rmSync(tmp, { recursive: true, force: true }))

/** A folder with the given files (a trailing slash makes a directory). */
function project(name, ...entries) {
	const root = join(tmp, name)
	for (const e of entries) {
		if (e.endsWith('/')) {
			mkdirSync(join(root, e), { recursive: true })
		} else {
			mkdirSync(join(root, e, '..'), { recursive: true })
			writeFileSync(join(root, e), '')
		}
	}
	return root
}

test('dependency and cache directories are excluded, with either path separator', () => {
	const root = project('deps', 'node_modules/lib/a.js', 'src/pkg/__pycache__/b.py', 'src/c.py')
	for (const rel of ['node_modules/lib/a.js', 'src/pkg/__pycache__/b.py']) {
		assert.equal(isExcludedPath(join(root, ...rel.split('/')), root), true, rel)
		assert.equal(isExcludedPath(`${root}/${rel}`, root), true, `${rel} with forward slashes`)
		if (process.platform === 'win32') {
			assert.equal(isExcludedPath(`${root}${BS}${rel.replaceAll('/', BS)}`, root), true, `${rel} with backslashes`)
		}
	}
	assert.equal(isExcludedPath(join(root, 'src', 'c.py'), root), false)
	assert.equal(isExcludedPath(join(root, 'top.py'), root), false)
})

test('build, out and target are excluded only beside the file that produces them', () => {
	const maven = project('maven', 'pom.xml', 'target/classes/A.java', 'src/main/java/com/acme/build/B.java', 'src/main/java/com/acme/out/C.java')
	assert.equal(isExcludedPath(join(maven, 'target', 'classes', 'A.java'), maven), true)
	assert.equal(isExcludedPath(join(maven, 'src', 'main', 'java', 'com', 'acme', 'build', 'B.java'), maven), false, 'a package called build')
	assert.equal(isExcludedPath(join(maven, 'src', 'main', 'java', 'com', 'acme', 'out', 'C.java'), maven), false, 'a package called out')
	const plain = project('plain', 'target/D.java', 'build/E.java')
	assert.equal(isExcludedPath(join(plain, 'target', 'D.java'), plain), false)
	assert.equal(isExcludedPath(join(plain, 'build', 'E.java'), plain), false)
	const node = project('node', 'package.json', 'build/F.js', 'out/G.js')
	assert.equal(isExcludedPath(join(node, 'build', 'F.js'), node), true)
	assert.equal(isExcludedPath(join(node, 'out', 'G.js'), node), true)
})

test('vendor, bin and env need their own markers; public, static and assets are never excluded', () => {
	const go = project('go', 'go.mod', 'vendor/x/x.go', 'public/p.js', 'static/s.js', 'assets/a.js')
	assert.equal(isExcludedPath(join(go, 'vendor', 'x', 'x.go'), go), true)
	for (const d of ['public', 'static', 'assets']) {
		assert.equal(isExcludedPath(join(go, d, `${d[0]}.js`), go), false, d)
	}
	const dotnet = project('dotnet', 'App.csproj', 'bin/x.js', 'obj/y.js')
	assert.equal(isExcludedPath(join(dotnet, 'bin', 'x.js'), dotnet), true)
	assert.equal(isExcludedPath(join(dotnet, 'obj', 'y.js'), dotnet), true)
	const py = project('py', 'env/pyvenv.cfg', 'env/lib/z.py', 'app/env/w.py')
	assert.equal(isExcludedPath(join(py, 'env', 'lib', 'z.py'), py), true, 'a virtualenv')
	assert.equal(isExcludedPath(join(py, 'app', 'env', 'w.py'), py), false, 'a package called env')
})

test('only the path below the workspace folder counts, not the folders above it', () => {
	const root = join(project('above', 'build/', 'package.json'), 'build', 'app')
	mkdirSync(join(root, 'src'), { recursive: true })
	assert.equal(isExcludedPath(join(root, 'src', 'x.py'), root), false)
	assert.equal(isExcludedPath(join(tmp, 'elsewhere', 'node_modules', 'y.js'), root), false, 'a file outside the folder is not this filter\'s business')
})

test("Insilode's agent worktrees are never indexed: each is a second copy of the project", () => {
	const root = project('wt', '.insilode/worktrees/claude-aae3/web/src/api.js', 'web/src/api.js')
	assert.equal(isExcludedPath(join(root, '.insilode', 'worktrees', 'claude-aae3', 'web', 'src', 'api.js'), root), true)
	assert.equal(isExcludedPath(join(root, 'web', 'src', 'api.js'), root), false)
})

// flow.exclude: the folders the user leaves out, tracked by git or not (src/poly/userExclude.ts).
let user
let grouping
before(async () => {
	const out = join(tmp, 'user.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'poly', 'userExclude.ts')], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'silent' })
	user = await import(pathToFileURL(out).href)
	const g = join(tmp, 'grouping.mjs')
	await build({ entryPoints: [join(ROOT, 'src', 'grouping.ts')], bundle: true, platform: 'node', format: 'esm', outfile: g, logLevel: 'silent' })
	grouping = await import(pathToFileURL(g).href)
})

test('flow.exclude: a folder relative to the workspace folder, with either slash, never a sibling that only shares its prefix', () => {
	const root = join(tmp, 'ws')
	const inside = (...p) => join(root, ...p)
	for (const pattern of ['legacy', 'legacy/', './legacy', '/legacy', 'legacy' + BS]) {
		const ex = user.excluder([pattern])
		assert.equal(ex(inside('legacy', 'A.java'), [root]), true, pattern)
		assert.equal(ex(inside('legacy', 'deep', 'B.java'), [root]), true, `${pattern} deep`)
		assert.equal(ex(inside('legacy-tools', 'C.java'), [root]), false, `${pattern}: legacy-tools`)
		assert.equal(ex(inside('app', 'legacy', 'D.java'), [root]), false, `${pattern}: only at the top`)
	}
	const nested = user.excluder(['services' + BS + 'old', 'services/older/'])
	assert.equal(nested(inside('services', 'old', 'x.java'), [root]), true)
	assert.equal(nested(inside('services', 'older', 'x.java'), [root]), true)
	assert.equal(nested(inside('services', 'new', 'x.java'), [root]), false)
	assert.equal(nested(inside('services', 'oldest', 'x.java'), [root]), false)
	assert.equal(nested(`${root.replaceAll(BS, '/')}/services/old/x.java`, [root]), true, 'a path with forward slashes')
	if (process.platform === 'win32') {
		assert.equal(nested(`${root}${BS}services${BS}old${BS}x.java`, [root]), true, 'a path with backslashes')
	}
})

test('flow.exclude: globs', () => {
	const root = join(tmp, 'ws')
	const ex = user.excluder(['**/legacy/**', 'apps/*/generated', 'tmp?'])
	assert.equal(ex(join(root, 'legacy', 'A.java'), [root]), true)
	assert.equal(ex(join(root, 'a', 'b', 'legacy', 'A.java'), [root]), true)
	assert.equal(ex(join(root, 'a', 'legacy'), [root]), true, 'the folder itself, so the walk skips it')
	assert.equal(ex(join(root, 'a', 'legacy-tools', 'A.java'), [root]), false)
	assert.equal(ex(join(root, 'apps', 'web', 'generated', 'x.ts'), [root]), true)
	assert.equal(ex(join(root, 'apps', 'web', 'src', 'x.ts'), [root]), false)
	assert.equal(ex(join(root, 'tmp1', 'x.ts'), [root]), true)
	assert.equal(ex(join(root, 'tmp12', 'x.ts'), [root]), false)
	assert.equal(user.excluder([])(join(root, 'a.ts'), [root]), false)
	assert.equal(ex(join(tmp, 'elsewhere', 'legacy', 'a.ts'), [root]), false, 'outside every root')
})

test('flow.exclude: the Exclude button only names a folder inside a workspace folder', () => {
	const root = join(tmp, 'ws')
	assert.equal(user.excludablePattern(join(root, 'services', 'old'), [root]), 'services/old')
	assert.equal(user.excludablePattern(root, [root]), undefined, 'the workspace folder itself')
	assert.equal(user.excludablePattern(join(root, '..', 'other'), [root]), undefined)
	assert.equal(user.excludablePattern(join(tmp, 'elsewhere'), [root]), undefined)
	assert.deepEqual(user.withPattern(['a'], 'b'), ['a', 'b'])
	assert.equal(user.withPattern(['b/'], 'b'), undefined, 'already there')
})

test('the index skips a folder git tracks when flow.exclude names it, and takes it back when it does not', async () => {
	const root = project('tracked', 'keep/Keep.java', 'legacy/Old.java', 'legacy-tools/Tools.java')
	const src = c => `@RestController class ${c} { @GetMapping("/${c}") String get() { return ""; } }`
	writeFileSync(join(root, 'keep', 'Keep.java'), src('Keep'))
	writeFileSync(join(root, 'legacy', 'Old.java'), src('Old'))
	writeFileSync(join(root, 'legacy-tools', 'Tools.java'), src('Tools'))
	const controllers = async exclude => {
		const index = new Index(root, exclude)
		try {
			await index.ready
			return (await index.request('entries')).map(e => e.controller).sort()
		} finally {
			await index.close()
		}
	}
	assert.deepEqual(await controllers([]), ['Keep', 'Old', 'Tools'])
	assert.deepEqual(await controllers(['legacy']), ['Keep', 'Tools'], 'legacy goes, legacy-tools stays')
	assert.deepEqual(await controllers(['**/legacy/**']), ['Keep', 'Tools'])
})

test('grouping: a submodule with a .git file, a nested repository, a plain folder, and a single group', () => {
	const root = join(tmp, 'super')
	const exists = p => [join(root, 'sub-a', '.git'), join(root, 'plain', 'inner', '.git')].includes(p)
	const resolve = grouping.repoResolver([root], exists)
	assert.equal(resolve(join(root, 'sub-a', 'src', 'A.java')).name, 'sub-a', 'a submodule: .git is a file')
	assert.equal(resolve(join(root, 'sub-a', 'src', 'A.java')).rel, 'sub-a')
	assert.equal(resolve(join(root, 'plain', 'inner', 'x', 'B.cs')).rel, 'plain/inner', 'a nested repository wins over its top-level folder')
	assert.equal(resolve(join(root, 'plain', 'C.go')).rel, 'plain', 'no .git: the top-level folder')
	assert.equal(resolve(join(root, 'D.py')).dir, root, 'a file at the root')
	const entry = (file, controller, http = 'GET /x') => ({ id: file + controller, controller, action: 'a', http, file, line: 1, source: 'poly' })
	const label = e => e.controller
	const two = grouping.sections([
		entry(join(root, 'sub-a', 'A.java'), 'Users'),
		entry(join(root, 'plain', 'inner', 'B.cs'), 'Users'),
		entry(join(root, 'plain', 'inner', 'E.ts'), 'Users'),
		entry(join(root, 'plain', 'C.go'), 'Orders'),
	], resolve, label)
	assert.deepEqual(two.map(s => [s.name, s.count, s.langs]), [['inner', 2, ['C#', 'TS/JS']], ['plain', 1, ['Go']], ['sub-a', 1, ['Java']]])
	assert.equal(two[0].groups.length + two[2].groups.length, 2, 'same-named controllers stay apart')
	const one = grouping.sections([entry(join(root, 'sub-a', 'A.java'), 'Users'), entry(join(root, 'sub-a', 'B.java'), 'Users')], resolve, label)
	assert.equal(one.length, 1, 'the view hides the outer level when there is one section')
	assert.equal(grouping.startsCollapsed(one), false)
	const many = Array.from({ length: 201 }, (_, i) => entry(join(root, i % 2 ? 'sub-a' : 'plain', `F${i}.java`), `C${i}`))
	assert.equal(grouping.startsCollapsed(grouping.sections(many, resolve, label)), true)
	assert.equal(grouping.languageOf('x.mjs'), 'TS/JS')
	assert.equal(grouping.languageOf('x.cs'), 'C#')
})
