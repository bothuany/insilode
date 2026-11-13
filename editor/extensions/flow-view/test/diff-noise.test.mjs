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
	for (const ext of ['java', 'kt', 'cs', 'go', 'ts', 'js']) {
		assert.equal(strip(ext, 'a(); // x\n/* one\ntwo */ b();\n'), 'a(); \n\n  b();\n', ext)
	}
})

test('stripComments: a comment marker inside a string is not a comment', () => {
	for (const ext of ['java', 'kt', 'cs', 'go', 'ts']) {
		const src = 'u = "http://x"; // real\nv = \'/*\' + "*/";\n'
		assert.equal(strip(ext, src), 'u = "http://x"; \nv = \'/*\' + "*/";\n', ext)
	}
})

test('stripComments: text blocks, verbatim, raw and template strings are strings', () => {
	assert.equal(strip('java', 's = """\n// not\n""";\n'), 's = """\n// not\n""";\n')
	assert.equal(strip('kt', 's = """\n// not\n"""\n'), 's = """\n// not\n"""\n')
	assert.equal(strip('cs', 's = @"C:\\x\\// not "" still";// gone\n'), 's = @"C:\\x\\// not "" still";\n')
	assert.equal(strip('go', 's := `// not\n/* nor */`; // gone\n'), 's := `// not\n/* nor */`; \n')
	assert.equal(strip('ts', 's = `a // ${ `b // ${x}` } // c`; // gone\n'), 's = `a // ${ `b // ${x}` } // c`; \n')
	assert.equal(strip('ts', 'r = /"\\/\\//.test(s); // gone\n'), 'r = /"\\/\\//.test(s); \n')
	assert.equal(strip('ts', 'q = a / b; // gone\n'), 'q = a / b; \n')
})

test('stripComments: Python has # comments and a docstring is a string', () => {
	assert.equal(strip('py', 'x = "#a"  # gone\n"""\n# doc\n"""\ny = 1\n'), 'x = "#a"  \n"""\n# doc\n"""\ny = 1\n')
	assert.equal(strip('py', "s = '''a ' # b'''\n# c\n"), "s = '''a ' # b'''\n\n")
})

test('stripComments: unsure is undefined, an unknown language is untouched', () => {
	assert.equal(strip('ts', 'a = <p>don\'t</p>\n'), undefined)
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

test('realHunks: a URL in JSX text is no comment, so its change is kept', () => {
	const a = 'const A = () => <p>See http://a.com</p>\n'
	assert.equal(real('a.tsx', a, a.replace('a.com', 'b.com')).length, 1)
	const t = text('const A = () => (', '  <p>a // b</p>', ')')
	assert.equal(real('a.jsx', t, t.replace('a //', 'c //')).length, 1, 'text with //')
	const m = text('const A = () => (', '  <p>', '    // not a comment', '  </p>', ')')
	assert.equal(real('a.tsx', m, m.replace('not', 'now')).length, 1, 'a text line that starts with //')
	const h = text('const A = () => <a href="http://x">k</a>')
	assert.equal(real('a.tsx', h, h.replace('http://x', 'http://y')).length, 1, 'a string')
})

test('realHunks: real comments in a JSX file are still noise', () => {
	const a = text('const x = 1;', '// note', 'const A = () => <br />;', 'const B = () => [', '  {/* why */}', '  <br />,', '];')
	assert.equal(real('a.tsx', a, a.replace('// note', '// other note')).length, 0, 'comment line')
	assert.equal(real('a.tsx', a, a.replace('x = 1;', 'x = 1; // c')).length, 0, 'after a statement')
	assert.equal(real('a.tsx', a, a.replace('{/* why */}', '{/* because */}')).length, 0, 'jsx comment')
})

test('realHunks: for an unknown language indentation is content, trailing whitespace is not', () => {
	const y = 'a:\n  b: 1\n  c: 2\n'
	assert.equal(real('db/changelog/c.yaml', y, y.replace('  c: 2', 'c: 2')).length, 1)
	assert.equal(real('c.rb', 'x = <<~E\n  a\n  b\nE\n', 'x = <<~E\n  a\n    b\nE\n').length, 1, 're-indented heredoc line')
	assert.equal(real('c.yaml', y, y.replace('b: 1', 'b: 1  ')).length, 0, 'trailing whitespace')
	assert.equal(real('c.yaml', y, y + '\n\n').length, 0, 'blank lines')
})
