// Test files and noise hunks (src/diffNoise.ts): comment-only and whitespace-only changes are not changes of a method, and
// the sites that hide them leave Keep and Undo their full hunk list.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { structuredPatch } from 'diff'
import { ROOT } from './helpers.mjs'

let n, k, m
let tmp
const bundle = async (name, entry) => {
	const outfile = join(tmp, name + '.mjs')
	await build({ entryPoints: [join(ROOT, 'src', ...entry)], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' })
	return import(pathToFileURL(outfile).href)
}
before(async () => {
	tmp = mkdtempSync(join(tmpdir(), 'flow-diff-noise-'))
	n = await bundle('noise', ['diffNoise.ts'])
	k = await bundle('keep', ['changedMethods.ts'])
	m = await bundle('methods', ['mcp', 'changedMethods.ts'])
})
after(() => rmSync(tmp, { recursive: true, force: true }))

const text = (...lines) => lines.join('\n') + '\n'
const hunks = (a, b) => structuredPatch('a', 'b', a, b, '', '', { context: 0 }).hunks
/** The hunks left once noise is dropped. */
const real = (file, a, b) => n.realHunks(file, a, b, hunks(a, b))

test('isTestPath: every kind of test file and folder', () => {
	for (const p of [
		'src/foo_test.go', 'pkg/test_foo.py', 'pkg/foo_test.py', 'pkg/conftest.py', 'a/b/FooIT.java', 'a/FooTest.java', 'a/FooTests.kt', 'a/FooTestCase.java',
		'src/test/java/A.java', 'Foo.Tests/Bar.cs', 'Foo.Test/Bar.cs', 'src/Foo.Tests.Unit/Bar.cs', 'BarTests.cs', 'BarTest.cs',
		'web/a.test.ts', 'web/a.spec.tsx', 'web/__tests__/a.ts', 'tests/x.py', 'web/a-spec.js', 'C:\\ws\\Foo.Tests\\Bar.cs',
	]) {
		assert.ok(n.isTestPath(p), p)
	}
})

test('isTestPath: ordinary names are not tests', () => {
	for (const p of ['src/Contest.java', 'LatestOrders.cs', 'src/attestation.go', 'web/testimonials.ts', 'src/Service.java', 'a/WaIT.ts', 'src/protest.py', 'pkg/latest.py', 'src/Detest.cs']) {
		assert.ok(!n.isTestPath(p), p)
	}
})

const strip = (ext, src) => n.stripComments(src, ext)?.text

test('stripComments: C-style languages drop // and /* */ but keep the line count', () => {
	for (const ext of ['java', 'kt', 'cs', 'go']) {
		assert.equal(strip(ext, 'a(); // x\n/* one\ntwo */ b();\n'), 'a(); \n\n  b();\n', ext)
	}
})

test('stripComments: a comment marker inside a string is not a comment', () => {
	for (const ext of ['java', 'kt', 'cs', 'go']) {
		const src = 'u = "http://x"; // real\nv = \'/*\' + "*/";\n'
		assert.equal(strip(ext, src), 'u = "http://x"; \nv = \'/*\' + "*/";\n', ext)
	}
})

test('stripComments: text blocks, verbatim and raw strings are strings', () => {
	assert.equal(strip('java', 's = """\n// not\n""";\n'), 's = """\n// not\n""";\n')
	assert.equal(strip('kt', 's = """\n// not\n"""\n'), 's = """\n// not\n"""\n')
	assert.equal(strip('cs', 's = @"C:\\x\\// not "" still";// gone\n'), 's = @"C:\\x\\// not "" still";\n')
	assert.equal(strip('go', 's := `// not\n/* nor */`; // gone\n'), 's := `// not\n/* nor */`; \n')
})

test('stripComments: Python has # comments and a docstring is a string', () => {
	assert.equal(strip('py', 'x = "#a"  # gone\n"""\n# doc\n"""\ny = 1\n'), 'x = "#a"  \n"""\n# doc\n"""\ny = 1\n')
	assert.equal(strip('py', "s = '''a ' # b'''\n# c\n"), "s = '''a ' # b'''\n\n")
})

test('stripComments: unsure is undefined, an unknown language is untouched', () => {
	assert.equal(strip('java', 'a = \'it\n'), undefined)
	assert.equal(strip('java', '/* never closed\n'), undefined)
	assert.equal(strip('cs', 'a = """"x"""";\n'), undefined)
	assert.equal(strip('rb', 'a # b\n'), 'a # b\n')
})

test('realHunks: a comment-only or whitespace-only change is noise, a real one is not', () => {
	const base = text('class A {', '  void a() {', '    one();', '  }', '}')
	assert.equal(real('A.java', base, base.replace('one();', 'one(); // why')).length, 0)
	assert.equal(real('A.java', base, base.replace('  }\n}', '  }\n\n\n}')).length, 0, 'blank lines')
	assert.equal(real('A.java', base, base.replace('    one();', '\tone( );')).length, 1, 'whitespace inside a call is not normalised away from tokens it separates')
	assert.equal(real('A.java', base, base.replace('    one();', '        one();')).length, 0, 're-indent')
	assert.equal(real('A.java', base, base.replace('one();', 'two();')).length, 1)
	assert.equal(real('A.java', base, base.replace('one();', '/* one(); */')).length, 1, 'commenting code out is a real change')
})

test('realHunks: a hunk inside a block comment is judged by the whole file', () => {
	const base = text('a();', '/*', ' * old', ' */', 'b();')
	assert.equal(real('A.java', base, base.replace('old', 'new')).length, 0)
	// Removing the opener turns the comment into code: not noise even if the hunk itself reads as a comment line.
	assert.equal(real('A.java', base, base.replace('/*\n', '')).length, 1)
})

test('realHunks: Python indentation and string contents are significant', () => {
	const base = text('def f():', '    x = 1', '    return x', '', 'y = "a  b"')
	assert.equal(real('a.py', base, base.replace('x = 1', 'x = 1  # why')).length, 0)
	assert.equal(real('a.py', base, base + '\n\n').length, 0, 'blank lines')
	assert.equal(real('a.py', base, base.replace('    x = 1', '  x = 1')).length, 1, 'indentation')
	assert.equal(real('a.py', base, base.replace('a  b', 'a b')).length, 1, 'string content')
	assert.equal(real('a.py', base, base.replace('x = 1', 'x = 1   ')).length, 0, 'trailing whitespace')
})

test('realHunks: string whitespace and docstring lines are never noise; other languages get the whitespace rule only', () => {
	const base = text('s = """', '  text', '"""')
	assert.equal(real('A.java', base, base.replace('  text', '    text')).length, 1)
	assert.equal(real('a.rb', 'x = 1\n', 'x = 1\n\n').length, 0)
	assert.equal(real('a.rb', 'x = 1\n', 'x = 1 # c\n').length, 1, 'comments are not recognised in an unknown language')
	assert.equal(real('A.java', "a = 'it\n", "a = 'it\n\n").length, 1, 'a scanner that is unsure hides nothing')
})

test('the three sites: a method whose every hunk is noise is no changed card, and a mixed card shows the real hunks only', () => {
	const base = text('class A {', '  void a() {', '    one();', '  }', '  void b() {', '    two();', '  }', '}')
	const now = text('class A {', '  void a() {', '    one(); // note', '  }', '  void b() {', '    three();', '  }', '}')
	const all = hunks(base, now)
	const shown = n.realHunks('A.java', base, now, all)
	assert.equal(all.length, 2)
	assert.equal(shown.length, 1)
	// changedRanges / turnImpact: only b has a range.
	assert.deepEqual(m.rangesFromHunks(shown), [{ start: 6, end: 6 }])
	// The card diff of a (lines 2-4) has nothing; b's (5-7) has the real line only.
	assert.equal(m.spanDiff(shown, 2, 4), undefined)
	assert.equal(m.spanDiff(shown, 5, 7).plus, 1)
	assert.equal(m.spanDiff(all, 2, 4).plus, 1, 'unfiltered, a still has its hunk')
})

test('Keep and Undo work on the unfiltered hunks', () => {
	const base = text('class A {', '  void a() {', '    one();', '  }', '}')
	const now = text('class A {', '  void a() {', '    one(); // note', '    two();', '  }', '}')
	assert.equal(real('A.java', base, now).length, 1)
	// Both changes are in the card: Keep takes both in, as the card's Undo would have reverted both.
	const kept = k.keepInRange(base, now, 2, 5)
	assert.equal(kept.kept, 1)
	assert.equal(k.hunksBetween(base, now).length, 1)
	assert.equal(k.revertHunks(now, k.hunksBetween(base, now)), base)
	// A comment-only change alone still has a hunk to Keep or Undo, though no card shows it.
	const note = base.replace('one();', 'one(); // note')
	assert.equal(real('A.java', base, note).length, 0)
	assert.equal(k.hunksBetween(base, note).length, 1)
	assert.equal(k.revertHunks(note, k.hunksBetween(base, note)), base)
})

// JavaScript and TypeScript have no comment scanner: telling a comment from JSX text or a regex literal needs a parser, so their
// hunks are kept unless they are whitespace-only.
test('realHunks: a comment-only change in a JS or TS file is kept', () => {
	const a = text('const x = 1;', '// note', 'const y = 2; // c', 'const z = a < b;')
	assert.equal(real('a.ts', a, a.replace('// note', '// other note')).length, 1, 'comment line')
	assert.equal(real('a.js', a, a.replace('// c', '// d')).length, 1, 'after a statement')
	assert.equal(real('a.ts', a, a.replace('y = 2', 'y = 3')).length, 1, 'code still counts')
	assert.equal(real('a.ts', a, a.replace('a < b;', 'a < b;   ')).length, 0, 'trailing whitespace')
	assert.equal(real('a.ts', a, a + '\n\n').length, 0, 'blank lines')
})

test('realHunks: blank lines and trailing whitespace inside a template literal are real changes', () => {
	const sql = text('const q = `', 'select 1', 'from t', '`;')
	assert.equal(real('a.ts', sql, sql.replace('select 1\n', 'select 1\n\n')).length, 1, 'blank line in the string')
	assert.equal(real('a.ts', sql, sql.replace('select 1', 'select 1  ')).length, 1, 'trailing whitespace in the string')
	assert.equal(real('a.mts', sql, sql.replace('select 1', 'select 1  ')).length, 1, 'mts is in the family')
	const plain = text('const x = 1;', 'const y = 2;')
	assert.equal(real('a.ts', plain, plain.replace('x = 1;', 'x = 1;  ')).length, 0, 'no backtick: trailing whitespace is still noise')
})

test('realHunks: JSX text and regex literals that look like comments are real changes', () => {
	const one = (file, from, to) => assert.equal(real(file, text(from), text(to)).length, 1, file)
	one('a.tsx', '<Btn label="C:\\" hint="//" onClick={save} / >', '<Btn label="C:\\" hint="//" onClick={deleteAll} / >')
	one('a.jsx', '<p>{home} // {page.title}< /p>', '<p>{home} // {user.password}< /p>')
	one('a.ts', 'if (ok) /[//]/.test(s) && save()', 'if (ok) /[//]/.test(s) && wipe()')
})

test('realHunks: for an unknown language indentation is content, trailing whitespace is not', () => {
	const y = 'a:\n  b: 1\n  c: 2\n'
	assert.equal(real('db/changelog/c.yaml', y, y.replace('  c: 2', 'c: 2')).length, 1)
	assert.equal(real('c.rb', 'x = <<~E\n  a\n  b\nE\n', 'x = <<~E\n  a\n    b\nE\n').length, 1, 're-indented heredoc line')
	assert.equal(real('c.yaml', y, y.replace('b: 1', 'b: 1  ')).length, 0, 'trailing whitespace')
	assert.equal(real('c.yaml', y, y + '\n\n').length, 0, 'blank lines')
})
