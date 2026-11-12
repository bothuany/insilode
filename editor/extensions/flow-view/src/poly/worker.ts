/*---------------------------------------------------------------------------------------------
 *  Insilode polyglot index: the worker. Walks the workspace, parses Java, Python and JS/TS with
 *  tree-sitter, keeps per-file facts (cached on disk by mtime) and answers the extension host.
 *  Runs off the extension host's thread: a first index of a large repo takes seconds.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { parsePrisma } from './db';
import { escapeRe, isMigrationPath, mentionPattern } from './migrations';
import type { Mention } from './model';
import { Project, type Axis2Service } from './graph';
import { extractJava } from './java';
import { gitIgnored, isIgnored } from './ignored';
import { extractJs } from './js';
import { isExcludedDir, langOf, type FileFacts } from './model';
import { extractGo, extractPhp, extractRuby, extractRust } from './others';
import { extractPython } from './python';
import type { TsNode } from './ts';
import { excluder } from './userExclude';

interface Init {
	roots: string[];
	wasmDir: string;
	cacheFile: string;
	/** `flow.exclude`: folders the user left out, even tracked ones. */
	exclude: string[];
}

const CACHE_VERSION = 5;
/** The cache holds facts the extractors made: a rebuilt worker (changed extractors) must not reuse them. */
const BUILD = (() => {
	try {
		return fs.statSync(__filename).mtimeMs;
	} catch {
		return 0;
	}
})();
const MAX_BYTES = 600_000;

const { roots, wasmDir, cacheFile, exclude } = workerData as Init;
const userExcluded = excluder(exclude ?? []);
const project = new Project(roots);
/** Untracked paths git ignores under the roots (build output, generated code, vendored checkouts): never indexed. */
let ignored: ReadonlySet<string> = new Set();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TreeSitter = require(path.join(wasmDir, 'tree-sitter.js'));
let parsers: Record<string, { parse(text: string): { rootNode: TsNode; delete(): void } }> = {};

async function initParsers() {
	await TreeSitter.Parser.init({ locateFile: (f: string) => path.join(wasmDir, f) });
	const make = async (grammar: string) => {
		const p = new TreeSitter.Parser();
		p.setLanguage(await TreeSitter.Language.load(path.join(wasmDir, `tree-sitter-${grammar}.wasm`)));
		return p;
	};
	parsers = { java: await make('java'), python: await make('python'), js: await make('javascript'), ts: await make('typescript'), tsx: await make('tsx'), go: await make('go'), php: await make('php'), ruby: await make('ruby'), rust: await make('rust') };
}

interface Found {
	code: string[];
	services: string[];
	prisma: string[];
	/** JSF/JSP pages, for the bean methods they call. */
	pages: string[];
	/** XML that may declare Spring beans. */
	xml: string[];
	/** C# files: not indexed, but searched for a column a migration drops. */
	cs: string[];
}

function walkDir(dir: string, out: Found, depth = 0) {
	if (depth > 25) {
		return;
	}
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	const names = entries.map(e => e.name);
	for (const e of entries) {
		if (e.name.startsWith('.') && e.name !== '.') {
			continue;
		}
		const full = path.join(dir, e.name);
		if (isIgnored(full, ignored) || userExcluded(full, roots)) {
			continue;
		}
		if (e.isDirectory()) {
			if (!isExcludedDir(e.name, full, () => names)) {
				walkDir(full, out, depth + 1);
			}
		} else if (e.isFile()) {
			if (e.name === 'services.xml') {
				out.services.push(full);
			} else if (/\.(xhtml|jsp|jspx|jsf)$/.test(e.name)) {
				out.pages.push(full);
			} else if (e.name.endsWith('.xml') && !/^(pom|build|web|log4j\d?|logback.*|persistence)\.xml$/.test(e.name)) {
				out.xml.push(full);
			} else if (e.name.endsWith('.prisma')) {
				out.prisma.push(full);
			} else if (/\.cs$/i.test(e.name) && !/[\\/](obj|bin)[\\/]/i.test(full)) {
				out.cs.push(full);
			} else if (langOf(full) && !/\.min\.(js|mjs)$|\.bundle\.js$|-min\.js$/.test(e.name)) {
				out.code.push(full);
			}
		}
	}
}

/** Python module name from the nearest root: app/models/user.py → app.models.user. */
function pyModule(file: string) {
	const root = roots.find(r => file.startsWith(r + path.sep)) ?? path.dirname(file);
	return path.relative(root, file).replace(/\.py$/, '').split(path.sep).filter(p => p !== '__init__').join('.');
}

/** `source`: the text of an editor buffer that is not saved yet, parsed instead of the file. */
function parseFile(file: string, mtime: number, source?: string): FileFacts | undefined {
	const lang = langOf(file);
	if (!lang) {
		return undefined;
	}
	let text: string;
	try {
		if (source !== undefined) {
			if (source.length > MAX_BYTES) {
				return undefined;
			}
			text = source;
		} else {
			const st = fs.statSync(file);
			if (st.size > MAX_BYTES) {
				return undefined;
			}
			text = fs.readFileSync(file, 'utf8');
		}
	} catch {
		return undefined;
	}
	// Minified or generated: one enormous line.
	const firstBreak = text.indexOf('\n');
	if (lang === 'js' && (firstBreak > 2000 || (firstBreak < 0 && text.length > 2000))) {
		return undefined;
	}
	let tree: ReturnType<(typeof parsers)[string]['parse']> | null = null;
	try {
		tree = parsers[lang].parse(text);
		return tree ? EXTRACTORS[lang](tree.rootNode, file, mtime) : undefined;
	} catch (e) {
		post({ type: 'log', message: `parse failed ${file}: ${(e as Error).message}` });
		return undefined;
	} finally {
		tree?.delete();
	}
}

/** One extractor per parser key (`langOf`): a new language is a grammar, an extractor and a line here. */
const EXTRACTORS: Record<NonNullable<ReturnType<typeof langOf>>, (root: TsNode, file: string, mtime: number) => FileFacts> = {
	java: extractJava,
	python: (root, file, mtime) => extractPython(root, file, mtime, pyModule(file)),
	js: extractJs,
	ts: extractJs,
	tsx: extractJs,
	go: extractGo,
	php: extractPhp,
	ruby: extractRuby,
	rust: extractRust,
};

/** Axis2: <service name="X"><parameter name="ServiceClass">com.x.Impl</parameter><operation name="op"/> */
function parseServices(file: string): Axis2Service[] {
	const out: Axis2Service[] = [];
	let text = '';
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return out;
	}
	for (const m of text.matchAll(/<service\b[^>]*\bname\s*=\s*"([^"]+)"[\s\S]*?<\/service>/g)) {
		const block = m[0];
		const cls = block.match(/<parameter\s+name\s*=\s*"ServiceClass"[^>]*>\s*([\w.$]+)\s*</)?.[1];
		const bean = block.match(/<parameter\s+name\s*=\s*"SpringBeanName"[^>]*>\s*([\w.$]+)\s*</)?.[1];
		if (cls || bean) {
			out.push({ name: m[1], cls: cls ?? '', bean, operations: [...block.matchAll(/<operation\s+name\s*=\s*"([^"]+)"/g)].map(x => x[1]), file });
		}
	}
	return out;
}

/** `action="#{bean.method(...)}"` and friends in a page: the bean methods a user can trigger. */
function pageRefs(file: string) {
	let text = '';
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		// A page that is gone (deleted, or not readable any more) triggers nothing: what it named must leave the entry points too.
		project.pageRefs.delete(file);
		return;
	}
	const refs: [string, string][] = [];
	for (const m of text.matchAll(/\b(?:action|actionListener|listener|returnValue|onload|preRenderView)\s*=\s*["']#\{\s*([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)) {
		refs.push([m[1], m[2]]);
	}
	project.pageRefs.set(file, refs);
}

/** <bean id="orderService" class="com.example.OrderServiceImpl"/> in Spring XML. */
function xmlBeans(file: string) {
	let text = '';
	try {
		if (fs.statSync(file).size > 2_000_000) {
			return;
		}
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return;
	}
	if (!text.includes('<bean')) {
		return;
	}
	for (const m of text.matchAll(/<bean\b[^>]*?\b(?:id|name)\s*=\s*"([^"]+)"[^>]*?\bclass\s*=\s*"([\w.$]+)"/g)) {
		project.xmlBeans.set(m[1], m[2]);
	}
	for (const m of text.matchAll(/<bean\b[^>]*?\bclass\s*=\s*"([\w.$]+)"[^>]*?\b(?:id|name)\s*=\s*"([^"]+)"/g)) {
		project.xmlBeans.set(m[2], m[1]);
	}
}

/**
 * Where code mentions a column by name, in the files that also mention the table or its entity (`words`): what may still use a column a
 * migration drops or renames. Searches the indexed languages and C# within `budgetMs`; migration files themselves are left out.
 */
function findMentions(q: { columns: string[]; words: string[]; limit: number; budgetMs: number }): Mention[] {
	const found: Found = { code: [], services: [], prisma: [], pages: [], xml: [], cs: [] };
	for (const r of roots) {
		walkDir(r, found);
	}
	const deadline = Date.now() + q.budgetMs;
	const patterns = q.columns.map(column => ({ column, re: mentionPattern(column) }));
	const near = q.words.filter(Boolean).map(w => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(w)}`, 'i'));
	const out: Mention[] = [];
	let scanned = 0;
	for (const file of [...found.code, ...found.cs]) {
		if (out.length >= q.limit || Date.now() > deadline || ++scanned > 6000) {
			break;
		}
		if (isMigrationPath(file)) {
			continue;
		}
		let text: string;
		try {
			if (fs.statSync(file).size > MAX_BYTES) {
				continue;
			}
			text = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		if (near.length && !near.some(w => w.test(text))) {
			continue;
		}
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length && out.length < q.limit; i++) {
			for (const p of patterns) {
				if (p.re.test(lines[i])) {
					out.push({ file, line: i + 1, column: p.column, text: lines[i].trim().slice(0, 140) });
					break;
				}
			}
		}
	}
	return out;
}

function post(msg: object) {
	parentPort!.postMessage(msg);
}

async function index() {
	const started = Date.now();
	await initParsers();
	let cache: Record<string, FileFacts> = {};
	try {
		const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
		if (c.version === CACHE_VERSION && c.build === BUILD && JSON.stringify(c.roots) === JSON.stringify(roots)) {
			cache = c.files;
		}
	} catch {
		// first run
	}
	const found: Found = { code: [], services: [], prisma: [], pages: [], xml: [], cs: [] };
	ignored = new Set(roots.flatMap(r => [...gitIgnored(r)]));
	for (const r of roots) {
		walkDir(r, found);
	}
	let parsed = 0;
	let done = 0;
	const total = found.code.length;
	// How far the first index is, for the endpoint picker: a large repository takes a while before any endpoint is known.
	post({ type: 'progress', done, total });
	for (const file of found.code) {
		if (++done % 200 === 0) {
			post({ type: 'progress', done, total });
		}
		let mtime = 0;
		try {
			mtime = fs.statSync(file).mtimeMs;
		} catch {
			continue;
		}
		const hit = cache[file];
		if (hit && hit.mtime === mtime) {
			project.set(hit);
			continue;
		}
		const facts = parseFile(file, mtime);
		if (facts) {
			project.set(facts);
			parsed++;
		}
	}
	project.axis2 = found.services.flatMap(parseServices);
	for (const p of found.pages) {
		pageRefs(p);
	}
	for (const x of found.xml) {
		xmlBeans(x);
	}
	project.prisma = found.prisma.flatMap(f => {
		try {
			return parsePrisma(fs.readFileSync(f, 'utf8'), f);
		} catch {
			return [];
		}
	});
	project.touched();
	const stats = project.stats();
	post({ type: 'ready', stats, ms: Date.now() - started, parsed });
	saveSoon();
}

let saveTimer: NodeJS.Timeout | undefined;
function saveSoon() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		try {
			fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
			const files: Record<string, FileFacts> = {};
			for (const [k, v] of project.files) {
				files[k] = v;
			}
			fs.writeFileSync(cacheFile, JSON.stringify({ version: CACHE_VERSION, build: BUILD, roots, files }));
		} catch (e) {
			post({ type: 'log', message: `cache write failed: ${(e as Error).message}` });
		}
	}, 3000);
}

const ready = index().catch(e => post({ type: 'log', message: `index failed: ${(e as Error).stack}` }));

parentPort!.on('message', async (m: { id: number; op: string; args: unknown[] }) => {
	await ready;
	try {
		let result: unknown;
		switch (m.op) {
			case 'entries': result = project.entryPoints(); break;
			case 'graph': result = project.graph(m.args[0] as string, (m.args[1] as number | undefined) ?? 5); break;
			case 'callers': result = project.callers(m.args[0] as string); break;
			case 'impact': result = project.impact(m.args[0] as string); break;
			case 'functionAt': result = project.functionAt(m.args[0] as string, m.args[1] as number); break;
			case 'methods': result = project.methodsIn(m.args[0] as string); break;
			case 'entities': result = project.entities(); break;
			case 'schemas': result = project.schemaFacts(); break;
			case 'mentions': result = findMentions(m.args[0] as Parameters<typeof findMentions>[0]); break;
			case 'tables': result = project.tableUses(m.args[0] as number | undefined); break;
			case 'stats': result = project.stats(); break;
			case 'typeFacts': result = project.typeFacts(); break;
			case 'complete': result = project.completeAt(m.args[0] as Parameters<Project['completeAt']>[0]); break;
			case 'signature': result = project.signatureAt(m.args[0] as Parameters<Project['signatureAt']>[0]); break;
			case 'definition': result = project.definitionAt(m.args[0] as Parameters<Project['definitionAt']>[0]); break;
			case 'changed': {
				for (const file of m.args as string[]) {
					if (isIgnored(file, ignored) || userExcluded(file, roots)) {
						project.delete(file); // ignored since it was indexed, or never indexed: either way not part of the project
						continue;
					}
					if (file.endsWith('services.xml')) {
						project.axis2 = [...project.axis2.filter(s => s.file !== file), ...parseServices(file)];
						project.touched();
						continue;
					}
					if (/\.(xhtml|jsp|jspx|jsf)$/.test(file)) {
						pageRefs(file);
						project.touched();
						continue;
					}
					if (file.endsWith('.prisma')) {
						try {
							project.prisma = [...project.prisma.filter(p => p.file !== file), ...parsePrisma(fs.readFileSync(file, 'utf8'), file)];
						} catch {
							project.prisma = project.prisma.filter(p => p.file !== file);
						}
						project.touched();
						continue;
					}
					let mtime = 0;
					try {
						mtime = fs.statSync(file).mtimeMs;
					} catch {
						project.delete(file);
						continue;
					}
					const facts = parseFile(file, mtime);
					if (facts) {
						project.set(facts);
					} else {
						project.delete(file);
					}
				}
				saveSoon();
				result = true;
				break;
			}
			case 'overlay': {
				// An editor buffer the developer is still typing in: the index reads it as the file for now. The mtime never equals a
				// file's, so this is never taken for a cached parse; the next save (a 'changed') reads the disk again.
				const [file, text] = m.args as [string, string];
				const facts = isIgnored(file, ignored) || userExcluded(file, roots) ? undefined : parseFile(file, -1, text);
				if (facts) {
					project.set(facts);
				}
				result = !!facts;
				break;
			}
			case 'removedDir': {
				// A folder was deleted (a removed worktree, say): the watcher reports the folder, not each file in it.
				const fold = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
				const dir = fold(path.join(m.args[0] as string, path.sep));
				const gone = [...project.files.keys(), ...project.pageRefs.keys()].filter(f => fold(f).startsWith(dir) && !fs.existsSync(f));
				gone.forEach(f => project.delete(f));
				if (gone.length) {
					saveSoon();
				}
				result = gone.length;
				break;
			}
			default: throw new Error(`unknown op ${m.op}`);
		}
		post({ id: m.id, result });
	} catch (e) {
		post({ id: m.id, error: (e as Error).message });
	}
});
