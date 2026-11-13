/*---------------------------------------------------------------------------------------------
 *  Insilode: what a change view should not show. Test files (they are not the application) and "noise" hunks, whose old
 *  and new lines are the same once comments are removed and whitespace is normalised. Pure (no vscode), so the panel, the
 *  MCP handlers and the diff tracker share it and it is tested on its own (test/diff-noise.test.mjs).
 *--------------------------------------------------------------------------------------------*/

// ── test files ──────────────────────────────────────────────────────────────

/** A test project folder (Foo.Tests, Foo.Test.Unit, tests/, src/test/, __tests__/). */
const TEST_DIR = /[\\/](?:[^\\/]*[.-]tests?(?:[.-][^\\/]*)?|tests?|__tests__|spec)[\\/]/i;
/** File names: FooTest.cs, foo.test.ts, foo-spec.ts, foo_test.go, test_foo.py, foo_test.py, conftest.py, FooIT.java, FooTestCase.kt. */
const TEST_FILE = /(?:[a-z0-9_]Tests?|[a-z0-9_]TestCase|[a-z0-9]IT(?=\.(?:java|kt)$)|[.-](?:test|spec)|_test)\.\w+$|(?:^|[\\/])(?:test_[^\\/]*\.py|conftest\.py)$/;

/** Whether a path (best given relative to the workspace: a checkout that lives under `tests/` is not all test code) is test code. */
export const isTestPath = (file: string): boolean => TEST_DIR.test('/' + file.replace(/\\/g, '/')) || TEST_FILE.test(file);

// ── comments ────────────────────────────────────────────────────────────────

interface Lang {
	line: '//' | '#';
	block?: boolean;
	/** Kotlin nests block comments. */
	nest?: boolean;
	/** A backtick opens a JS template literal (`${}` holds code) or a Go raw string. */
	backtick?: 'template' | 'raw';
	/** JS: a `/` where an expression starts opens a regular expression, which may hold quotes or `//`. */
	regex?: boolean;
	/** Triple-quoted strings, and whether a backslash escapes inside them. */
	triple?: string[];
	escapes?: boolean;
	/** C#: `@"..."` ends at a `"` not doubled. */
	verbatim?: boolean;
}

const JS: Lang = { line: '//', block: true, backtick: 'template', regex: true };
const LANGS: Record<string, Lang> = {
	java: { line: '//', block: true, triple: ['"""'], escapes: true },
	kt: { line: '//', block: true, nest: true, triple: ['"""'] },
	cs: { line: '//', block: true, triple: ['"""'], verbatim: true },
	go: { line: '//', block: true, backtick: 'raw' },
	js: JS, jsx: JS, ts: JS, tsx: JS,
	py: { line: '#', triple: ['"""', "'''"], escapes: true },
};

const extOf = (file: string) => /\.([A-Za-z0-9]+)$/.exec(file)?.[1].toLowerCase() ?? '';

/** The text without its comments, line for line, and the lines that hold (part of) a string or regex literal. */
export interface Stripped {
	text: string;
	literal: Set<number>;
}

const AFTER_KEYWORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)\s*$/;

/**
 * Removes comments with a scanner that knows the language's string literals (so `"http://x"` is no comment) and keeps every
 * newline, so line numbers stay those of the original. A block comment becomes one space. Undefined when the scanner is not
 * sure (an unterminated literal, an unclosed comment): the caller then treats nothing as noise. A language it does not know
 * is returned as it is.
 */
export function stripComments(text: string, ext: string): Stripped | undefined {
	const lang = LANGS[ext];
	const literal = new Set<number>();
	if (!lang) {
		return { text, literal };
	}
	const n = text.length;
	// JSX text is not a string literal, so `http://a.com` in it would read as a comment: in a file that has JSX tags a
	// `//` or `/*` only counts as a comment where it clearly is one (`clearComment`), else the scanner is unsure.
	const out: string[] = [];
	const jsx = (ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') && /<\/|\/>/.test(text);
	const clearComment = (at: number): boolean => {
		if (!jsx) {
			return true;
		}
		const eol = text.indexOf('\n', at);
		if (/<\/|\/>/.test(text.slice(at, eol < 0 ? n : eol))) {
			return false; // a tag closes on the same line: this is JSX text
		}
		// A comment after code that ended a statement or opened a block (earlier comments do not count), not after what may be JSX text.
		for (let k = out.length - 1; k >= 0; k--) {
			const seen = out[k].trimEnd();
			if (seen) {
				return ';{}'.includes(seen[seen.length - 1]);
			}
		}
		return true;
	};
	const templates: number[] = []; // per open `${`: how many `{` are open inside it
	let i = 0;
	let line = 0;
	/** Copies text[i..j) as it is; the lines a literal spans are marked. */
	const copy = (j: number) => {
		for (let k = i; k < j; k++) {
			if (text[k] === '\n') {
				literal.add(++line);
			}
		}
		out.push(text.slice(i, j));
		i = j;
	};
	/** A template literal whose body starts at `from`: up to its closing backtick, or the `${` that opens code. */
	const template = (from: number): boolean => {
		let j = from;
		while (j < n && text[j] !== '`') {
			if (text[j] === '\\') {
				j += 2;
			} else if (text[j] === '$' && text[j + 1] === '{') {
				copy(j + 2);
				templates.push(0);
				return true;
			} else {
				j++;
			}
		}
		if (j >= n) {
			return false;
		}
		copy(j + 1);
		return true;
	};
	while (i < n) {
		const c = text[i];
		if (c === '\n') {
			out.push(c);
			line++;
			i++;
			continue;
		}
		if (lang.line === '#' ? c === '#' : c === '/' && text[i + 1] === '/') {
			if (!clearComment(i)) {
				return undefined;
			}
			while (i < n && text[i] !== '\n') {
				i++;
			}
			continue;
		}
		if (lang.block && c === '/' && text[i + 1] === '*') {
			if (!clearComment(i)) {
				return undefined;
			}
			let depth = 1;
			i += 2;
			while (i < n && depth) {
				if (lang.nest && text.startsWith('/*', i)) {
					depth++;
					i += 2;
				} else if (text.startsWith('*/', i)) {
					depth--;
					i += 2;
				} else {
					if (text[i] === '\n') {
						out.push('\n');
						line++;
					}
					i++;
				}
			}
			if (depth) {
				return undefined;
			}
			out.push(' ');
			continue;
		}
		if (c === '"' || c === "'" || (c === '`' && lang.backtick)) {
			literal.add(line);
			if (c === '`') {
				if (lang.backtick === 'raw') {
					const j = text.indexOf('`', i + 1);
					if (j < 0) {
						return undefined;
					}
					copy(j + 1);
				} else if (!template(i + 1)) {
					return undefined;
				}
				continue;
			}
			const verbatim = lang.verbatim && c === '"' && (text[i - 1] === '@' || (text[i - 1] === '$' && text[i - 2] === '@'));
			const triple = verbatim ? undefined : lang.triple?.find(t => text.startsWith(t, i));
			if (triple) {
				if (text[i + 3] === c) {
					return undefined; // C# raw strings with more quotes: not worth a scanner
				}
				let j = i + 3;
				while (j < n && !text.startsWith(triple, j)) {
					j += lang.escapes && text[j] === '\\' ? 2 : 1;
				}
				if (j >= n) {
					return undefined;
				}
				copy(j + 3);
				continue;
			}
			let j = i + 1;
			if (verbatim) {
				while (j < n && (text[j] !== '"' || text[j + 1] === '"')) {
					j += text[j] === '"' ? 2 : 1;
				}
			} else {
				while (j < n && text[j] !== c) {
					if (text[j] === '\n') {
						return undefined; // a string that runs past its line: JSX text, a lifetime, something not understood
					}
					j += text[j] === '\\' ? 2 : 1;
				}
			}
			if (j >= n) {
				return undefined;
			}
			copy(j + 1);
			continue;
		}
		if (lang.regex && c === '/') {
			const before = text.slice(Math.max(0, i - 16), i).replace(/\s+$/, '');
			if (!before || '(,=:[!&|?{};+-*%<>~^'.includes(before[before.length - 1]) || AFTER_KEYWORD.test(before)) {
				let j = i + 1;
				let inClass = false;
				while (j < n && (inClass || text[j] !== '/')) {
					if (text[j] === '\n') {
						return undefined;
					}
					if (text[j] === '\\') {
						j++;
					} else if (text[j] === '[') {
						inClass = true;
					} else if (text[j] === ']') {
						inClass = false;
					}
					j++;
				}
				if (j >= n) {
					return undefined;
				}
				literal.add(line);
				copy(j + 1);
				continue;
			}
		}
		if (templates.length && (c === '{' || c === '}')) {
			if (c === '{') {
				templates[templates.length - 1]++;
			} else if (templates[templates.length - 1] === 0) {
				templates.pop();
				literal.add(line);
				if (!template(i + 1)) {
					return undefined;
				}
				continue;
			} else {
				templates[templates.length - 1]--;
			}
		}
		out.push(c);
		i++;
	}
	return templates.length ? undefined : { text: out.join(''), literal };
}

// ── noise hunks ─────────────────────────────────────────────────────────────

/** The part of a jsdiff hunk this module reads. */
interface HunkRange {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
}

/**
 * `count` lines from `from` (0-based), each normalised so that only a real difference remains: blank lines are dropped,
 * and so is whitespace around and (outside Python and languages the scanner does not know, where indentation counts) inside a line. A line holding a literal is
 * compared exactly: a string's whitespace is its content.
 */
function normalised(s: Stripped, ext: string, from: number, count: number): string[] {
	const lines = s.text.split('\n');
	const out: string[] = [];
	for (let k = from; k < from + count; k++) {
		const raw = lines[k] ?? '';
		const literal = s.literal.has(k);
		const l = literal ? raw : ext === 'py' || !(ext in LANGS) ? raw.trimEnd() : raw.trim().replace(/\s+/g, ' ');
		if (literal || l) {
			out.push(l);
		}
	}
	return out;
}

/**
 * The hunks that change something real: those whose old and new lines differ once comments are gone and whitespace is
 * normalised. Comment-only, whitespace-only and blank-line-only hunks are dropped. When anything is unclear (a literal
 * the scanner does not understand, or a comment that opens or closes in a line no hunk covers, which would change what the
 * lines between mean) all hunks are kept: a real change must never be hidden.
 */
export function realHunks<H extends HunkRange>(file: string, base: string, now: string, hunks: H[]): H[] {
	if (!hunks.length) {
		return hunks;
	}
	const ext = extOf(file);
	const a = stripComments(base, ext);
	const b = stripComments(now, ext);
	if (!a || !b) {
		return hunks;
	}
	// The lines outside the hunks pair up one to one; they must read the same without comments.
	const A = a.text.split('\n');
	const B = b.text.split('\n');
	let oi = 0;
	let ni = 0;
	const ordered = [...hunks].sort((x, y) => x.newStart - y.newStart);
	for (const h of ordered) {
		// jsdiff numbers an empty side by the line after it, so the lines before a hunk are always start - 1.
		const os = h.oldStart - 1;
		const ns = h.newStart - 1;
		if (os - oi !== ns - ni || A.slice(oi, os).some((l, k) => l !== B[ni + k])) {
			return hunks;
		}
		oi = os + h.oldLines;
		ni = ns + h.newLines;
	}
	if (A.length - oi !== B.length - ni || A.slice(oi).some((l, k) => l !== B[ni + k])) {
		return hunks;
	}
	return hunks.filter(h => {
		const x = normalised(a, ext, h.oldStart - 1, h.oldLines);
		const y = normalised(b, ext, h.newStart - 1, h.newLines);
		return x.length !== y.length || x.some((l, k) => l !== y[k]);
	});
}
