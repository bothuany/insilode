/*---------------------------------------------------------------------------------------------
 *  Insilode polyglot index: the project. Resolves every call to what it reaches (a method through the
 *  declared type of its receiver, an interface through its implementations, a table through the
 *  ORM or the SQL it runs), finds the entry points of each framework, and answers the canvas:
 *  the flow from a function, its callers, and the entry points a change would touch.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import type { DbSchema, EntryPoint, FlowNode, ImpactItem, ImpactResult } from '../../../../../protocol/flow';
import { isSpringRepo, isWrite, javaSchema, jsSchema, looksLikeSql, opsOf, pythonSchema, sqlTables, tableKey, unq, type PrismaModel, type SchemaFact } from './db';
import { baseType, callBefore, chainBefore, isConstructorName, Kind, paramLabels, recvText, signatureDetail, wordAt, type Place, type Seg, type Suggestion } from './assist';
import { joinPath, type CallFact, type FileFacts, type FuncFact, type Lang, type RouteFact, type TableEntity, type TablesFact, type TableUseFact, type TypeFact } from './model';
import { httpCallOf, matchEndpoints } from './links';
import { celeryTaskNames, listenerKeys, matchConsumers, messageSendOf } from './messages';

export interface Axis2Service {
	name: string;
	cls: string;
	/** SpringBeanName: the service object is a Spring bean. */
	bean?: string;
	operations: string[];
	file: string;
}

type Target =
	| { kind: 'fn'; fn: FuncFact; edge: 'call' | 'impl' | 'http' | 'message'; guess?: boolean }
	| { kind: 'ambiguous'; label: string; options: FuncFact[]; edge?: 'http' | 'message' }
	| { kind: 'db'; schema: DbSchema; label: string; file: string | null; line: number; guess?: boolean };

/** An entry point with the declared types of its parameters and result, for the type chips. */
export interface TypeEntry {
	id: string;
	controller: string;
	action: string;
	http: string;
	file: string;
	line: number;
	owner?: string;
	params: { name: string; typeText: string; anns: string[] }[];
	returns?: string;
}

/** Call sites from one class to another, for the architecture view. */
export interface TypeCall {
	fromFile: string;
	fromOwner: string;
	toFile: string;
	toOwner: string;
	count: number;
}

interface Entry extends EntryPoint {
	fn: FuncFact;
}

/** Names too common to link by name alone. */
const COMMON = new Set(['get', 'set', 'add', 'put', 'map', 'filter', 'find', 'push', 'pop', 'call', 'apply', 'bind', 'then', 'catch', 'log', 'info', 'warn', 'error', 'debug', 'toString', 'equals', 'hashCode', 'append', 'format', 'join', 'split', 'replace', 'trim', 'keys', 'values', 'items', 'update', 'remove', 'delete', 'clear', 'close', 'open', 'read', 'write', 'send', 'emit', 'on', 'off', 'run', 'start', 'stop', 'init', 'main', 'render', 'next', 'json', 'parse', 'stringify', 'length', 'size', 'isEmpty', 'contains', 'includes', 'indexOf', 'slice', 'sort', 'reduce', 'forEach', 'some', 'every', 'concat', 'execute', 'handle', 'process', 'validate', 'create', 'save', 'load', 'print', 'printf', 'println', 'valueOf', 'of', 'from', 'to', 'build', 'builder', 'getId', 'setId', 'getName', 'setName', '<init>', '__init__', 'constructor', 'super', 'require', 'isNull', 'isNotNull', 'notNull', 'assert', 'assertEquals', 'compareTo', 'iterator', 'stream', 'collect', 'getValue', 'setValue', 'getMessage', 'printStackTrace', 'currentTimeMillis', 'now', 'sleep', 'wait', 'notify', 'lock', 'unlock', 'exists', 'match', 'test', 'exec', 'query', 'fetch', 'request', 'response', 'status', 'text', 'redirect', 'append', 'appendChild', 'setAttribute', 'getAttribute', 'addEventListener', 'dispatch', 'subscribe', 'pipe', 'resolve', 'reject', 'all', 'any', 'race', 'is', 'has', 'hasNext', 'size', 'list', 'dict', 'len', 'str', 'int', 'float', 'bool', 'print', 'range', 'enumerate', 'zip', 'isinstance', 'getattr', 'setattr', 'hasattr', 'sorted', 'min', 'max', 'sum', 'abs', 'round', 'open', 'type', 'id']);

const HTTP_ANN: Record<string, string> = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH', GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE', PATCH: 'PATCH', HEAD: 'HEAD', OPTIONS: 'OPTIONS', Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', All: '*', Head: 'HEAD', Options: 'OPTIONS' };
const PY_VERBS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', delete: 'DELETE', patch: 'PATCH', head: 'HEAD', options: 'OPTIONS', websocket: 'WS' };
const MAX_NODES = 220;
/** The impact walk follows this many functions up the callers, then says how many it left unfollowed. */
const MAX_IMPACT_WALK = 5000;
/** The table walk looks at this many entry points and keeps this many uses: a repository of thousands of routes answers in parts. */
const MAX_TABLE_ENTRIES = 3000;
const MAX_TABLE_USES = 20_000;
/** Languages whose free functions live in a package/module of their own (see pkgFuncs). */
const PACKAGE_LANGS = new Set(['go', 'php', 'ruby', 'rust']);
// What a JS/TS import specifier may leave off. The index file is joined with the platform separator because the
// file map is keyed by native paths: `C:\app\lib` + '/index.ts' never matched on Windows, so a directory import
// (`from '../lib'`) resolved on Linux but fell back to a name-only guess on Windows.
const JS_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', ...['index.ts', 'index.tsx', 'index.js'].map(f => path.sep + f)];

/** A record lookup that ignores Object.prototype (an import named `toString` is not a function). */
function own<T>(rec: Record<string, T> | undefined, key: string): T | undefined {
	return rec && Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined;
}

export class Project {
	readonly files = new Map<string, FileFacts>();
	prisma: PrismaModel[] = [];
	axis2: Axis2Service[] = [];
	/** Page → the bean methods it triggers (JSF EL in .xhtml / .jsp). */
	readonly pageRefs = new Map<string, [string, string][]>();
	/** Spring XML: bean id → class FQN. */
	readonly xmlBeans = new Map<string, string>();
	private dirty = true;
	private typesByName = new Map<string, TypeFact[]>();
	private funcsById = new Map<string, FuncFact>();
	private methodsByOwner = new Map<string, FuncFact[]>();
	private funcsByName = new Map<string, FuncFact[]>();
	private fileByModule = new Map<string, string>();
	private impls = new Map<string, TypeFact[]>();
	private schemas = new Map<string, DbSchema & { orm: string }>();
	private schemaByTable = new Map<string, DbSchema & { orm: string }>();
	/** Every declaration of each entity name, in file order: two services may both have an `Order`. */
	private schemaList = new Map<string, (DbSchema & { orm: string })[]>();
	/** Entities (by file and line) whose table name is not written in the code (a naming default): a card for one says "table?". */
	private guessedTables = new Set<string>();
	/** Every entity or model class the readers found, one per declaration (two services may both have a `User`): what an edit is resolved against. */
	private entityFacts: TableEntity[] = [];
	/** The walk over the entry points that finds which tables they reach, built on first use and cleared with the index. */
	private tableWalk: { next: number; uses: TableUseFact[] } | undefined;
	private entries: Entry[] = [];
	private callersOf: Map<string, { from: string; line: number; link?: 'http' | 'message' }[]> | undefined;
	/** Message listeners and Celery tasks with the destinations they consume, built on first use. */
	private consumers: { fn: FuncFact; keys: string[]; celery?: boolean }[] | undefined;
	private resolved = new Map<string, Target[][]>();
	/** Go/PHP/Ruby/Rust free functions by directory and by module name, built on first use. */
	private pkgIndex: Map<string, FuncFact[]> | undefined;
	/** Go/Rust: a type made up from a method receiver → the type declared in another file of the same package. */
	private readonly canon = new Map<TypeFact, TypeFact>();
	/** Files some other file `include()`s (Django urls), computed once per build. */
	private included: Set<string> | undefined;
	private entryById = new Map<string, Entry>();
	/** Router prefixes set by another file's include (FastAPI/Flask) and `app.use` (Express), built once per build: first match wins. */
	private pyIncludes: Map<string, string | undefined> | undefined;
	private jsMounts: Map<string, string> | undefined;
	private sources = new Map<string, string[]>();

	constructor(private readonly roots: string[]) { }

	set(f: FileFacts) {
		this.files.set(f.file, f);
		this.dirty = true;
		this.sources.delete(f.file);
	}

	delete(file: string) {
		this.files.delete(file);
		this.pageRefs.delete(file);
		this.dirty = true;
		this.sources.delete(file);
	}

	touched() {
		this.dirty = true;
	}

	private build() {
		if (!this.dirty) {
			return;
		}
		this.dirty = false;
		try {
			this.rebuild();
		} catch (e) {
			// A half-built index must be built again, not trusted.
			this.dirty = true;
			throw e;
		}
	}

	private rebuild() {
		this.canon.clear();
		this.included = undefined;
		this.pyIncludes = undefined;
		this.jsMounts = undefined;
		this.typesByName.clear();
		this.funcsById.clear();
		this.methodsByOwner.clear();
		this.funcsByName.clear();
		this.fileByModule.clear();
		this.impls.clear();
		this.schemas.clear();
		this.schemaByTable.clear();
		this.guessedTables.clear();
		this.schemaList.clear();
		this.entityFacts = [];
		this.tableWalk = undefined;
		this.resolved.clear();
		this.pkgIndex = undefined;
		this.callersOf = undefined;
		this.consumers = undefined;
		this.mergeStubTypes();
		for (const f of this.files.values()) {
			if (f.module) {
				// Java: package → each type's FQN. Python: the dotted module and its suffixes.
				if (f.lang === 'java') {
					for (const t of f.types) {
						this.fileByModule.set(`${f.module}.${t.name}`, f.file);
					}
				} else {
					const parts = f.module.split('.');
					for (let i = 0; i < parts.length; i++) {
						const key = parts.slice(i).join('.');
						if (!this.fileByModule.has(key) || i === 0) {
							this.fileByModule.set(key, f.file);
						}
					}
				}
			}
			for (const t of f.types) {
				// A stub merged into its real type is listed through that type's merged copy.
				if (!t.stub || !this.canon.has(t)) {
					this.push(this.typesByName, t.name, this.canon.get(t) ?? t);
				}
			}
			for (const fn of f.funcs) {
				this.funcsById.set(fn.id, fn);
				this.push(this.funcsByName, fn.name, fn);
				if (fn.owner) {
					const declared = this.ownerOf(fn);
					this.push(this.methodsByOwner, `${declared?.file ?? fn.file}|${fn.owner}`, fn);
				}
			}
		}
		// Implementations: classes listing an interface (or abstract class) among their supers, transitively.
		for (const list of this.typesByName.values()) {
			for (const t of list) {
				const seen = new Set<string>();
				const queue = [...t.supers];
				while (queue.length) {
					const s = queue.shift()!;
					if (seen.has(s)) {
						continue;
					}
					seen.add(s);
					if (t.kind === 'class') {
						this.push(this.impls, s, t);
					}
					for (const st of this.typesByName.get(s) ?? []) {
						queue.push(...st.supers);
					}
				}
			}
		}
		this.buildSchemas();
		this.buildEntries();
	}

	/**
	 * `func (h *Handler) List()` in routes.go and `type Handler struct{…}` in handler.go are one type. The merged type is a copy that both
	 * map to in `canon`: the facts of each file stay as parsed, so a method or impl deleted from routes.go leaves Handler with the next
	 * rebuild, and the merge never reaches the on-disk cache.
	 */
	private mergeStubTypes() {
		const declared = new Map<string, TypeFact>();
		const scope = (f: FileFacts, name: string) => `${f.lang}|${path.dirname(f.file)}|${name}`;
		const files = [...this.files.values()].filter(f => f.lang === 'go' || f.lang === 'rust');
		for (const f of files) {
			for (const t of f.types.filter(x => !x.stub)) {
				declared.set(scope(f, t.name), t);
			}
		}
		for (const f of files) {
			for (const t of f.types.filter(x => x.stub)) {
				const real = declared.get(scope(f, t.name));
				if (real) {
					let merged = this.canon.get(real);
					if (!merged) {
						merged = { ...real, methods: [...real.methods], supers: [...real.supers], superArgs: { ...real.superArgs } };
						this.canon.set(real, merged);
					}
					this.canon.set(t, merged);
					merged.methods.push(...t.methods.filter(m => !merged.methods.includes(m)));
					merged.supers.push(...t.supers.filter(x => !merged.supers.includes(x)));
				}
			}
		}
	}

	private push<K, V>(m: Map<K, V[]>, k: K, v: V) {
		const list = m.get(k);
		if (list) {
			list.push(v);
		} else {
			m.set(k, [v]);
		}
	}

	private buildSchemas() {
		const add = (read: SchemaFact | undefined, orm: string, endLine: number, declLine?: number) => {
			if (!read) {
				return;
			}
			const { guess, ...s } = read;
			const full = { ...s, ops: [], writes: false, context: orm, orm };
			if (guess) {
				this.guessedTables.add(`${s.file}|${s.line}`);
			}
			this.push(this.schemaList, s.entity, full);
			this.entityFacts.push({ entity: s.entity, table: s.table, schemaName: s.dbSchemaName, orm, guess: !!guess, spans: s.file ? [{ file: s.file, line: declLine ?? s.line, endLine }] : [] });
			this.schemas.set(s.entity, full);
			this.schemaByTable.set(s.table.toLowerCase(), full);
			this.schemaByTable.set(s.table.toLowerCase().split('.').pop()!, full);
		};
		for (const f of this.files.values()) {
			for (const t of f.types) {
				if (f.lang === 'java') {
					add(javaSchema(t, this.inheritedFields(t)), 'JPA', t.endLine);
				} else if (f.lang === 'python') {
					const s = pythonSchema(t, f.module);
					add(s, s?.orm ?? '', t.endLine);
				} else {
					add(jsSchema(t), 'TypeORM', t.endLine, t.declLine);
				}
			}
		}
		for (const m of this.prisma) {
			add({ entity: m.name, table: m.table, dbSchemaName: null, columns: m.columns, relations: m.relations, file: m.file, line: m.line, guess: false }, 'Prisma', m.endLine);
		}
	}

	private inheritedFields(t: TypeFact) {
		const out = [];
		let cur: TypeFact | undefined = t;
		for (let i = 0; i < 4 && cur; i++) {
			const sup: TypeFact | undefined = cur.supers.map(s => this.type(s, cur!.file)).find(x => x && x.kind === 'class');
			if (sup) {
				out.unshift(...sup.fields);
			}
			cur = sup;
		}
		return out;
	}

	/** The type a name means from a file: same file first, then an import, then the only one. */
	private type(name: string, from: string): TypeFact | undefined {
		const list = this.typesByName.get(name);
		if (!list?.length) {
			return undefined;
		}
		if (list.length === 1) {
			const imp = own(this.files.get(from)?.imports, name);
			if (imp && this.files.get(from)?.lang === 'java' && !this.fileByModule.has(imp)) {
				return undefined;
			}
			return list[0];
		}
		const local = list.find(t => t.file === from);
		if (local) {
			return local;
		}
		const facts = this.files.get(from);
		const imp = own(facts?.imports, name);
		if (imp) {
			const file = this.importFile(facts!, imp);
			const hit = file && list.find(t => t.file === file);
			if (hit) {
				return hit;
			}
		}
		if (facts?.lang === 'java' && imp && !this.fileByModule.has(imp)) {
			return undefined; // imported from a library (java.util.Locale), not the project's own type
		}
		// Java: same package
		const dir = path.dirname(from);
		return list.find(t => path.dirname(t.file) === dir) ?? list[0];
	}

	/**
	 * The type a name stands for where the code itself says so: declared in the same file, imported (and the import leads to a declaration of
	 * it), or, in Java, in the same package (a folder is a package). What `type` falls back to (a type of the same folder in Python or
	 * TypeScript, the first of several) is a guess and is not returned here.
	 */
	private typeStated(name: string, from: string): TypeFact | undefined {
		const list = this.typesByName.get(name) ?? [];
		const local = list.find(t => t.file === from);
		if (local) {
			return local;
		}
		const facts = this.files.get(from);
		const imp = own(facts?.imports, name);
		if (imp && facts) {
			const file = this.importFile(facts, imp);
			const hit = file && list.find(t => t.file === file);
			if (hit) {
				return hit;
			}
		}
		return facts?.lang === 'java' && !imp ? list.find(t => path.dirname(t.file) === path.dirname(from)) : undefined;
	}

	/** Where an import points: Java FQN, Python `module:name`, JS `./path:name`. */
	private importFile(facts: FileFacts, imp: string): string | undefined {
		if (facts.lang === 'java') {
			return this.fileByModule.get(imp);
		}
		const [mod] = imp.split(':');
		if (facts.lang === 'python') {
			return this.fileByModule.get(mod) ?? this.fileByModule.get(`${mod}.__init__`);
		}
		if (mod.startsWith('.') || mod.startsWith('@/') || mod.startsWith('~/')) {
			// ESM and NodeNext import a TypeScript file by its emitted name (`./user.service.js` for user.service.ts): a file of that very
			// name wins, else the name without the extension is read like any other specifier.
			const stripped = mod.replace(/\.[mc]?jsx?$/, '');
			for (const spec of stripped === mod ? [mod] : [mod, stripped]) {
				const base = spec.startsWith('.') ? path.resolve(path.dirname(facts.file), spec) : this.aliasPath(spec, facts.file);
				for (const ext of JS_SUFFIXES) {
					if (this.files.has(base + ext)) {
						return base + ext;
					}
				}
			}
		}
		return undefined;
	}

	private aliasPath(mod: string, from: string) {
		const root = this.roots.find(r => from.startsWith(r)) ?? this.roots[0];
		const rel = mod.replace(/^[@~]\//, '');
		for (const dir of ['src', 'app', '']) {
			const p = path.join(root, dir, rel);
			for (const ext of ['.ts', '.tsx', '.js', `${path.sep}index.ts`]) {
				if (this.files.has(p + ext)) {
					return p;
				}
			}
		}
		return path.join(root, 'src', rel);
	}

	// ── Resolution ──────────────────────────────────────────────────────────────

	/** Free functions of Go/PHP/Ruby/Rust by `dir` (same directory) or `mod` (a directory or file called so). */
	private pkgFuncs(facts: FileFacts, kind: 'dir' | 'mod', scope: string, name: string): FuncFact[] {
		if (!PACKAGE_LANGS.has(facts.lang)) {
			return [];
		}
		if (!this.pkgIndex) {
			const idx = new Map<string, FuncFact[]>();
			const put = (k: string, fn: FuncFact) => this.push(idx, k, fn);
			for (const f of this.files.values()) {
				if (!PACKAGE_LANGS.has(f.lang)) {
					continue;
				}
				const dir = path.dirname(f.file);
				for (const fn of f.funcs) {
					if (!fn.owner && !fn.inlineRoute) {
						put(`${f.lang}|dir|${dir}|${fn.name}`, fn);
						put(`${f.lang}|mod|${path.basename(dir)}|${fn.name}`, fn);
						if (f.lang !== 'go') {
							put(`${f.lang}|mod|${path.basename(f.file, path.extname(f.file))}|${fn.name}`, fn); // a Go package is its directory, not its file
						}
					}
				}
			}
			this.pkgIndex = idx;
		}
		return [...new Map((this.pkgIndex.get(`${facts.lang}|${kind}|${scope}|${name}`) ?? []).map(x => [x.id, x])).values()];
	}

	private methods(t: TypeFact, name: string): FuncFact[] {
		return (this.methodsByOwner.get(`${t.file}|${t.name}`) ?? []).filter(m => m.name === name);
	}

	/** A method by name on a type or its superclasses. */
	private lookup(t: TypeFact, name: string, depth = 0): FuncFact | undefined {
		const own = this.methods(t, name)[0];
		if (own || depth > 5) {
			return own;
		}
		for (const s of t.supers) {
			const st = this.type(s, t.file);
			const hit = st && this.lookup(st, name, depth + 1);
			if (hit) {
				return hit;
			}
		}
		return undefined;
	}

	private field(t: TypeFact, name: string, depth = 0): { type: string; args: string[] } | undefined {
		const f = t.fields.find(x => x.name === name);
		if (f) {
			return { type: f.type, args: f.typeArgs };
		}
		if (depth > 5) {
			return undefined;
		}
		for (const s of t.supers) {
			const st = this.type(s, t.file);
			const hit = st && this.field(st, name, depth + 1);
			if (hit) {
				return hit;
			}
		}
		return undefined;
	}

	private ownerOf(fn: FuncFact) {
		const t = fn.owner ? this.files.get(fn.file)?.types.find(x => x.name === fn.owner) : undefined;
		return t && (this.canon.get(t) ?? t);
	}

	/** The declared type of a receiver: local, parameter, field, module global; or the type itself (static call). */
	private recvType(fn: FuncFact, recv: string): { type: string; args: string[]; isType?: boolean } | undefined {
		const owner = this.ownerOf(fn);
		const facts = this.files.get(fn.file)!;
		const parts = recv.split('.');
		let head = parts[0];
		let rest = parts.slice(1);
		let cur: { type: string; args: string[]; isType?: boolean } | undefined;
		if ((head === 'this' || head === 'self') && owner) {
			if (!rest.length) {
				return { type: owner.name, args: [] };
			}
			head = rest[0];
			rest = rest.slice(1);
			cur = this.field(owner, head);
		} else {
			const local = own(fn.locals, head) ?? own(fn.params, head);
			if (local) {
				cur = { type: local, args: [] };
			} else if (owner && facts.lang === 'java') {
				cur = this.field(owner, head);
			}
			const global = own(facts.globals, head);
			if (!cur && global) {
				cur = { type: global, args: [] };
			}
			if (!cur && this.type(head, fn.file)) {
				cur = { type: head, args: [], isType: true };
			}
		}
		for (const seg of rest) {
			const t = cur && this.type(cur.type, fn.file);
			cur = t ? this.field(t, seg) : undefined;
		}
		return cur && cur.type ? cur : undefined;
	}

	private resolveCall(fn: FuncFact, c: CallFact): Target[] {
		const db = this.dbCall(fn, c);
		if (db) {
			return [db];
		}
		if (c.name === '<init>') {
			return [];
		}
		const facts = this.files.get(fn.file)!;
		const owner = this.ownerOf(fn);
		// Bare call: a method of this class (Java/self-less), a function in this module, or an imported one.
		if (!c.recv || c.recv === 'this' || c.recv === 'self' || c.recv === 'super') {
			if (owner && (facts.lang === 'java' || facts.lang === 'ruby' || c.recv)) {
				const start = c.recv === 'super' ? owner.supers.map(s => this.type(s, fn.file)).find(Boolean) : owner;
				const m = start && this.lookup(start, c.name);
				if (m) {
					return this.viaType(start!, m, c.name);
				}
			}
			if (!c.recv) {
				const local = facts.funcs.find(f => !f.owner && f.name === c.name);
				if (local) {
					return [{ kind: 'fn', fn: local, edge: 'call' }];
				}
				const imp = own(facts.imports, c.name);
				if (imp) {
					const file = this.importFile(facts, imp);
					const name = imp.split(':')[1];
					const target = file && this.files.get(file)?.funcs.find(f => !f.owner && (f.name === name || (name === 'default' && f.exported)));
					if (target) {
						return [{ kind: 'fn', fn: target, edge: 'call' }];
					}
				}
				const sibling = this.pkgFuncs(facts, 'dir', path.dirname(facts.file), c.name);
				if (sibling.length === 1) {
					return [{ kind: 'fn', fn: sibling[0], edge: 'call' }];
				}
			}
			return this.guess(fn, c);
		}
		// Module receiver (Python `import services`, JS `import * as svc`).
		const imp = own(facts.imports, c.recv);
		if (imp && (facts.lang !== 'java')) {
			const file = this.importFile(facts, imp);
			const target = file && this.files.get(file)?.funcs.find(f => f.name === c.name && (!f.owner || facts.lang === 'js'));
			if (target) {
				return [{ kind: 'fn', fn: target, edge: 'call' }];
			}
			// JS: imported instance/class (`import userService from './user.service'`)
			const t = file && this.files.get(file)?.types[0];
			if (t) {
				const m = this.lookup(t, c.name);
				if (m) {
					return this.viaType(t, m, c.name);
				}
			}
		}
		// `db::all()` (Rust), `store.Find()` (Go package): a free function of the module or package named like the receiver.
		if ((facts.lang === 'rust' || facts.lang === 'go') && /^[a-z_]\w*$/.test(c.recv) && !this.recvType(fn, c.recv)) {
			const hit = this.pkgFuncs(facts, 'mod', c.recv, c.name);
			if (hit.length === 1) {
				return [{ kind: 'fn', fn: hit[0], edge: 'call' }];
			}
		}
		const rt = this.recvType(fn, c.recv);
		const t = rt && this.type(rt.type, fn.file);
		if (t) {
			const m = this.lookup(t, c.name);
			if (m || t.kind === 'interface' || t.isAbstract) {
				return this.viaType(t, m, c.name);
			}
			return [];
		}
		return this.guess(fn, c);
	}

	/** A call through a type: an interface or abstract method resolves to its implementations. */
	private viaType(t: TypeFact, m: FuncFact | undefined, name: string): Target[] {
		const abstract = t.kind === 'interface' || (m && this.isAbstractMethod(m));
		if (!abstract) {
			return m ? [{ kind: 'fn', fn: m, edge: 'call' }] : [];
		}
		const impls = (this.impls.get(t.name) ?? []).map(i => this.lookup(i, name)).filter((x): x is FuncFact => !!x && !this.isAbstractMethod(x));
		const unique = [...new Map(impls.map(i => [i.id, i])).values()];
		if (unique.length === 1) {
			return [{ kind: 'fn', fn: unique[0], edge: 'impl' }];
		}
		if (unique.length > 1) {
			return [{ kind: 'ambiguous', label: `${t.name}.${name}`, options: unique }];
		}
		return m ? [{ kind: 'fn', fn: m, edge: 'call' }] : [];
	}

	private isAbstractMethod(m: FuncFact) {
		// No body: the extractor saw no calls and the declaration spans one line, or the owner is an interface.
		const owner = this.ownerOf(m);
		return owner?.kind === 'interface' || (m.endLine === m.line && m.calls.length === 0 && !!owner?.isAbstract);
	}

	/** Dynamic languages: link by a name found once in the whole project, and say it was a guess. */
	private guess(fn: FuncFact, c: CallFact): Target[] {
		// Java declares every type: a call we could not resolve is a library call, not a guess.
		if (this.files.get(fn.file)?.lang === 'java' || COMMON.has(c.name) || c.name.length < 4 || c.name.startsWith('_')) {
			return [];
		}
		const same = (this.funcsByName.get(c.name) ?? []).filter(f => f.id !== fn.id && !f.inlineRoute);
		if (same.length === 1) {
			return [{ kind: 'fn', fn: same[0], edge: 'call', guess: true }];
		}
		return [];
	}

	// ── Databases ───────────────────────────────────────────────────────────────

	/**
	 * The declaration an entity name stands for. A name one class has is that class; a name several have is resolved the way the
	 * code resolves it (the import, the same package or module) from the file that writes it; a Prisma model by the nearest schema
	 * file, which is only a guess. `unsure` is only false when the code does say which one it is.
	 */
	private pickSchema(entity: string, from: string | undefined, context: string): { s: DbSchema & { orm: string }; unsure: boolean } | undefined {
		const all = this.schemaList.get(entity) ?? [];
		const prisma = context === 'Prisma';
		const list = all.filter(x => (x.orm === 'Prisma') === prisma);
		if (!list.length) {
			return undefined;
		}
		if (list.length === 1) {
			return { s: list[0], unsure: false };
		}
		if (prisma && from) {
			const near = (f: string | null) => {
				const a = path.dirname(from).split(path.sep);
				const b = path.dirname(f ?? '').split(path.sep);
				let n = 0;
				while (n < a.length && n < b.length && a[n] === b[n]) {
					n++;
				}
				return n;
			};
			const best = Math.max(...list.map(x => near(x.file)));
			const closest = list.filter(x => near(x.file) === best);
			// Which schema a client was generated from is not in the call: the nearest one is the best guess, and is drawn as one.
			return { s: [...closest].sort((a, b) => (a.file ?? '') < (b.file ?? '') ? -1 : 1)[0], unsure: true };
		}
		const t = from ? this.typeStated(entity, from) : undefined;
		const hit = t && list.find(x => x.file === t.file && x.line === t.line);
		if (hit) {
			return { s: hit, unsure: false };
		}
		// The code does not say: the type of the same folder (or the first of several) is the best guess, and it is drawn as one.
		// (The same folder, else the first by path, so that the guess does not depend on the order files were read.)
		const sorted = [...list].sort((a, b) => (a.file ?? '') < (b.file ?? '') ? -1 : 1);
		const near = from ? sorted.find(x => path.dirname(x.file ?? '') === path.dirname(from)) : undefined;
		return { s: near ?? sorted[0], unsure: true };
	}

	private schema(entity: string | undefined, ops: string[], context: string, fn?: FuncFact, from?: string): Target | undefined {
		if (!entity) {
			return undefined;
		}
		const picked = this.pickSchema(entity, from ?? fn?.file, context);
		const s = picked?.s;
		const writes = isWrite(ops, fn);
		if (s) {
			return { kind: 'db', schema: { ...s, ops, writes, context: context || s.orm }, label: s.table, file: s.file, line: s.line, ...(picked!.unsure || this.guessedTables.has(`${s.file}|${s.line}`) ? { guess: true } : {}) };
		}
		// No entity of this name in the project: the repository's type argument stands in for the table.
		return { kind: 'db', schema: { entity, table: entity, dbSchemaName: null, context, columns: [], relations: [], ops, writes, file: null, line: 0 }, label: entity, file: null, line: 0, guess: true };
	}

	private sqlTarget(sql: string, ops: string[], context: string): Target | undefined {
		const { tables, writes, verb } = sqlTables(sql);
		if (!tables.length) {
			return undefined;
		}
		const name = tables[0];
		const known = this.schemaByTable.get(name.toLowerCase()) ?? this.schemaByTable.get(name.toLowerCase().split('.').pop()!) ?? this.schemas.get(name);
		// The SQL verb says what ran; prepareStatement / executeQuery / query are only how.
		const opList = [verb || ops[0], ...ops.slice(1)].filter(Boolean);
		const also = tables.slice(1).map(t => `joins ${t}`);
		if (known) {
			return { kind: 'db', schema: { ...known, ops: [...opList, ...also], writes: writes || isWrite(ops), context }, label: known.table, file: known.file, line: known.line, guess: true };
		}
		return { kind: 'db', schema: { entity: name, table: name, dbSchemaName: name.includes('.') ? name.split('.')[0] : null, context, columns: [], relations: [], ops: [...opList, ...also], writes: writes || isWrite(ops), file: null, line: 0 }, label: name, file: null, line: 0, guess: true };
	}

	private sqlOf(fn: FuncFact, c: CallFact): string | undefined {
		const owner = this.ownerOf(fn);
		const fromVar = (v: string | undefined) => {
			if (!v) {
				return undefined;
			}
			const name = v.replace(/^this\./, '');
			if (own(fn.consts, name)) {
				return own(fn.consts, name);
			}
			const f = owner?.fields.find(x => x.name === name);
			return f?.init ? unq(f.init.replace(/"\s*\+\s*"/g, '')) : undefined;
		};
		return [...c.strings, fromVar(c.arg0) ?? ''].find(s => looksLikeSql(s));
	}

	private dbCall(fn: FuncFact, c: CallFact): Target | undefined {
		const lang = this.files.get(fn.file)!.lang;
		const ops = opsOf(c);
		const rt = c.recv ? this.recvType(fn, c.recv) : undefined;
		const rtype = rt && this.type(rt.type, fn.file);
		// Spring Data: repository.findByEmail(...)
		const repoEntity = isSpringRepo(rtype);
		if (repoEntity) {
			const m = rtype && this.lookup(rtype, c.name);
			const q = m?.annotations.find(a => a.name === 'Query');
			if (q?.value && looksLikeSql(q.value)) {
				const native = /nativeQuery\s*=\s*true/.test(Object.entries(q.named).map(([k, v]) => `${k}=${v}`).join());
				const t = native ? this.sqlTarget(q.value, ops, rtype!.name) : undefined;
				if (t) {
					return t;
				}
			}
			// The repository's type argument is written in the repository's file: that is where its package and imports say which entity it is.
			return this.schema(repoEntity, ops, rtype!.name, m, rtype!.file);
		}
		const recvType = rt?.type ?? '';
		// TypeORM Repository<User> / MikroORM EntityRepository<User>
		if (/^(Repository|EntityRepository|MongoRepository|TreeRepository)$/.test(recvType)) {
			return this.schema(rt!.args[0] ?? this.fieldArg(fn, c.recv!), ops, 'TypeORM', fn);
		}
		if (c.name === 'getRepository' && c.arg0) {
			return this.schema(c.arg0.replace(/\.class$/, ''), ops.slice(1), 'TypeORM', fn);
		}
		// JPA / Hibernate / JDBC
		if (lang === 'java') {
			if (/^(EntityManager|Session|StatelessSession|HibernateTemplate|JdbcTemplate|NamedParameterJdbcTemplate|Connection|Statement|PreparedStatement|SqlSession|DSLContext|JdbcClient)$/.test(recvType) || /^(createQuery|createNativeQuery|createNamedQuery|prepareStatement|executeQuery|executeUpdate|queryForObject|queryForList|queryForMap|batchUpdate)$/.test(c.name)) {
				const sql = this.sqlOf(fn, c);
				if (sql) {
					if (c.name === 'createQuery' || c.name === 'createNamedQuery' || /^\s*(from|select\s+\w+\s+from)\s+[A-Z]/.test(sql)) {
						const entity = sql.match(/\b(?:from|join|update|delete\s+from)\s+([A-Z]\w*)/i)?.[1];
						if (entity && this.schemas.has(entity)) {
							return this.schema(entity, [sqlTables(sql).verb || 'SELECT', ...ops.slice(1)], recvType || 'JPA', fn);
						}
					}
					return this.sqlTarget(sql, ops, recvType || 'JDBC');
				}
				if (/^(find|getReference|persist|merge|remove|get|load|save|update|delete|saveOrUpdate|refresh|detach)$/.test(c.name) && c.arg0) {
					const entity = c.arg0.match(/^(\w+)\.class$/)?.[1] ?? (own(fn.locals, c.arg0) ?? own(fn.params, c.arg0));
					if (entity && this.schemas.has(entity)) {
						return this.schema(entity, ops, recvType || 'JPA', fn);
					}
				}
				if ((recvType === 'EntityManager' || recvType === 'Session') && !/^(getDelegate|unwrap|getMetamodel|getProperties|setProperty|isOpen|close|getTransaction|joinTransaction|contains|detach|clear|getEntityManagerFactory|setFlushMode|getFlushMode|getCriteriaBuilder|getSessionFactory)$/.test(c.name)) {
					return { kind: 'db', schema: { entity: '?', table: `${recvType}.${c.name}`, dbSchemaName: null, context: recvType, columns: [], relations: [], ops, writes: isWrite(ops), file: null, line: 0 }, label: `${recvType}.${c.name}`, file: null, line: 0 };
				}
			}
			return undefined;
		}
		if (lang === 'python') {
			// SQLAlchemy: session.query(User).filter(...).first() / select(User) / session.add(obj)
			if (c.name === 'query' && c.arg0 && this.schemas.has(c.arg0.split('.').pop()!)) {
				return this.schema(c.arg0.split('.').pop(), ops, 'SQLAlchemy', fn);
			}
			if ((c.name === 'select' || c.name === 'insert' || c.name === 'update' || c.name === 'delete') && !c.recv && c.arg0 && this.schemas.has(c.arg0)) {
				return this.schema(c.arg0, [c.name, ...(c.chain ?? [])], 'SQLAlchemy', fn);
			}
			if (/^(add|delete|merge)$/.test(c.name) && c.arg0 && /session|db/i.test(c.recv ?? '')) {
				const entity = own(fn.locals, c.arg0) ?? own(fn.params, c.arg0);
				if (entity && this.schemas.has(entity)) {
					return this.schema(entity, ops, 'SQLAlchemy', fn);
				}
			}
			// Django: User.objects.filter(...)
			const m = c.recv?.match(/^(\w+)\.objects$/);
			if (m && this.schemas.has(m[1])) {
				return this.schema(m[1], ops, 'Django ORM', fn);
			}
			if (c.recv && /^(save|delete|refresh_from_db)$/.test(c.name)) {
				const entity = own(fn.locals, c.recv) ?? own(fn.params, c.recv);
				if (entity && this.schemas.get(entity)?.orm === 'Django ORM') {
					return this.schema(entity, ops, 'Django ORM', fn);
				}
			}
			if (/^(execute|executemany|exec_driver_sql|raw|fetch|fetchrow|fetchval)$/.test(c.name)) {
				const sql = this.sqlOf(fn, c);
				return sql ? this.sqlTarget(sql, ops, 'SQL') : undefined;
			}
			return undefined;
		}
		// JS: prisma.user.findMany() / this.prisma.order.create()
		if (c.recv) {
			const seg = c.recv.split('.');
			const model = seg.at(-1)!;
			const p = this.prisma.find(x => x.name.toLowerCase() === model.toLowerCase());
			if (p && seg.length >= 2 && /prisma|db|client/i.test(seg.at(-2)!)) {
				return this.schema(p.name, ops, 'Prisma', fn);
			}
		}
		if (/^(query|execute|raw|run|all|get|prepare)$/.test(c.name) || c.name === 'sql') {
			const sql = this.sqlOf(fn, c);
			return sql ? this.sqlTarget(sql, ops, c.recv?.split('.').pop() ?? 'SQL') : undefined;
		}
		return undefined;
	}

	private fieldArg(fn: FuncFact, recv: string) {
		const owner = this.ownerOf(fn);
		const name = recv.replace(/^this\./, '');
		const f = owner?.fields.find(x => x.name === name);
		// @InjectRepository(User) private repo: Repository<User>
		return f?.typeArgs[0] ?? f?.annotations.find(a => a.name === 'InjectRepository')?.args[0];
	}

	// ── Entry points ────────────────────────────────────────────────────────────

	private buildEntries() {
		const out: Entry[] = [];
		const added = new Set<string>();
		const add = (fn: FuncFact, verb: string, route: string, controller?: string) => {
			out.push({ id: `poly:${fn.id}${added.has(fn.id) ? `|${verb}` : ''}`, controller: controller ?? fn.owner ?? path.basename(fn.file).replace(/\.\w+$/, ''), action: fn.inlineRoute ? route : fn.name, http: `${verb} ${route}`, file: fn.file, line: fn.line, fn });
			added.add(fn.id);
		};
		// Axis2 services and JSF pages name Spring/JSF beans; each becomes the class behind it.
		const axis2 = new Map<string, Axis2Service>();
		for (const s of this.axis2) {
			const t = s.cls ? this.typesByName.get(s.cls.split('.').pop()!)?.[0] : s.bean ? this.beanClass(s.bean) : undefined;
			if (t) {
				axis2.set(`${t.file}|${t.name}`, s);
			}
		}
		const seenJsf = new Set<string>();
		for (const [page, refs] of this.pageRefs) {
			for (const [bean, method] of refs) {
				const t = this.beanClass(bean);
				const m = t && this.lookup(t, method);
				if (m && !seenJsf.has(m.id)) {
					seenJsf.add(m.id);
					add(m, 'JSF', `#{${bean}.${method}}`, `${t!.name} · ${path.basename(page)}`);
				}
			}
		}
		for (const f of this.files.values()) {
			for (const t of f.types) {
				const anns = new Set(t.annotations.map(a => a.name));
				const methods = f.funcs.filter(fn => fn.owner === t.name);
				// The class's route prefix. In Java `@Controller("x")` names a bean, never a path, so only the mapping annotations count and
				// whichever of them carries a value wins over a bare one above it; in NestJS `@Controller('users')` is the prefix.
				const classRoute = f.lang === 'java'
					? ['RequestMapping', 'Path', 'Route'].map(n => t.annotations.find(a => a.name === n && a.value !== undefined)?.value).find(v => v !== undefined)
					: t.annotations.find(a => a.name === 'Controller' || a.name === 'Route' || a.name === 'RequestMapping' || a.name === 'Path')?.value;
				if (f.lang === 'java') {
					const spring = anns.has('RestController') || anns.has('Controller');
					const jaxrs = anns.has('Path');
					const soap = anns.has('WebService') && t.kind === 'class' ? t.name : undefined;
					const axis = axis2.get(`${t.file}|${t.name}`);
					const servlet = t.supers.includes('HttpServlet');
					for (const m of methods) {
						const ma = m.annotations;
						const verbAnn = ma.find(a => HTTP_ANN[a.name] && (spring ? /Mapping$/.test(a.name) : jaxrs ? /^[A-Z]+$/.test(a.name) : false));
						const reqMap = ma.find(a => a.name === 'RequestMapping');
						if (spring && (verbAnn || reqMap)) {
							const verb = verbAnn ? HTTP_ANN[verbAnn.name] : (reqMap!.named.method?.match(/(GET|POST|PUT|DELETE|PATCH)/)?.[1] ?? '*');
							add(m, verb, joinPath(classRoute, (verbAnn ?? reqMap)!.value));
						} else if (jaxrs && verbAnn) {
							add(m, HTTP_ANN[verbAnn.name], joinPath(classRoute, ma.find(a => a.name === 'Path')?.value));
						} else if (servlet && /^do(Get|Post|Put|Delete|Patch)$/.test(m.name)) {
							const ws = t.annotations.find(a => a.name === 'WebServlet');
							add(m, m.name.slice(2).toUpperCase(), ws?.value ?? `/${t.name}`);
						} else if ((axis || soap) && m.isPublic && !m.isStatic && m.name !== '<init>' && !/^(get|set|is)[A-Z]/.test(m.name) && (!axis?.operations.length || axis.operations.includes(m.name))) {
							add(m, 'SOAP', `${axis?.name ?? soap}/${m.name}`);
						} else if (ma.some(a => a.name === 'Scheduled')) {
							add(m, 'JOB', ma.find(a => a.name === 'Scheduled')!.named.cron ? unq(ma.find(a => a.name === 'Scheduled')!.named.cron)! : 'scheduled');
						} else if (ma.some(a => /^(KafkaListener|JmsListener|RabbitListener|SqsListener|StreamListener)$/.test(a.name))) {
							const l = ma.find(a => /Listener$/.test(a.name))!;
							add(m, 'MSG', unq(l.named.topics ?? l.named.destination ?? l.named.queues) ?? l.name);
						}
					}
				} else if (f.lang === 'js') {
					// NestJS: @Controller('users') + @Get(':id')
					if (anns.has('Controller')) {
						for (const m of methods) {
							const v = m.annotations.find(a => HTTP_ANN[a.name] && /^[A-Z][a-z]+$/.test(a.name));
							if (v) {
								add(m, HTTP_ANN[v.name], joinPath(classRoute, v.value));
							}
						}
					}
					for (const m of methods) {
						const l = m.annotations.find(a => /^(Cron|Interval|MessagePattern|EventPattern|Process|OnEvent)$/.test(a.name));
						if (l) {
							add(m, /Cron|Interval/.test(l.name) ? 'JOB' : 'MSG', l.value ?? l.name);
						}
					}
				}
			}
			if (f.lang === 'python') {
				for (const fn of f.funcs) {
					for (const a of fn.annotations) {
						const on = a.full.split('.')[0];
						const routerLike = /^(app|router|api|bp|blueprint|\w*_router|\w*_bp|\w*_app)$/i.test(on) || /^(FastAPI|APIRouter|Flask|Blueprint|Sanic|Quart)$/.test(own(f.globals, on) ?? '');
						if (routerLike && a.full.includes('.') && (PY_VERBS[a.name] || a.name === 'route' || a.name === 'api_route')) {
							const verbs = PY_VERBS[a.name] ? [PY_VERBS[a.name]] : (a.named.methods?.match(/[A-Z]+/g) ?? ['GET']);
							for (const v of verbs) {
								add(fn, v, joinPath(...this.pyPrefixes(f, on), a.value));
							}
						} else if (/^(shared_task|task|periodic_task|job|scheduled_job)$/.test(a.name)) {
							add(fn, 'JOB', a.full);
						}
					}
				}
			}
			for (const r of f.routes) {
				this.routeEntries(f, r, '', add, 0);
			}
			// Next.js app router: app/**/route.ts exports GET/POST…
			const rel = f.file.replace(/\\/g, '/');
			const appRoute = rel.match(/\/app\/(.*)\/route\.(m?[jt]sx?)$/);
			const pagesApi = rel.match(/\/pages\/api\/(.*)\.(m?[jt]sx?)$/);
			if (f.lang === 'js' && (appRoute || pagesApi)) {
				for (const fn of f.funcs.filter(x => x.exported && !x.owner)) {
					if (appRoute && /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/.test(fn.name)) {
						add(fn, fn.name, '/' + appRoute[1].replace(/\([^)]*\)\/?/g, '').replace(/\[([^\]]+)\]/g, ':$1'), 'route');
					} else if (pagesApi && fn.name === 'default') {
						add(fn, '*', '/api/' + pagesApi[1].replace(/\/index$/, '').replace(/\[([^\]]+)\]/g, ':$1'), 'api');
					}
				}
			}
		}
		this.entries = out;
		this.entryById = new Map();
		for (const e of out) {
			if (!this.entryById.has(e.fn.id)) {
				this.entryById.set(e.fn.id, e);
			}
		}
	}

	/** The class behind a bean name: Spring XML, @Service("x") / @Named("x") / @ManagedBean(name = "x"), or the class name. */
	private beanClass(bean: string): TypeFact | undefined {
		const fqn = this.xmlBeans.get(bean);
		if (fqn) {
			const file = this.fileByModule.get(fqn);
			const t = file && this.files.get(file)?.types.find(x => x.name === fqn.split('.').pop());
			if (t) {
				return t;
			}
		}
		const named = /^(Service|Component|Controller|RestController|Repository|ManagedBean|Named)$/;
		let byName: TypeFact | undefined;
		for (const list of this.typesByName.values()) {
			for (const t of list) {
				const a = t.annotations.find(x => named.test(x.name));
				if (a && (unq(a.named.name) ?? a.value) === bean) {
					return t;
				}
				if (!byName && t.kind === 'class' && t.name.charAt(0).toLowerCase() + t.name.slice(1) === bean) {
					byName = t;
				}
			}
		}
		if (byName) {
			return byName;
		}
		const cap = bean.charAt(0).toUpperCase() + bean.slice(1);
		return this.typesByName.get(`${cap}Impl`)?.[0] ?? (this.impls.get(cap) ?? [])[0];
	}

	/** FastAPI / Flask prefixes: the router's own (`APIRouter(prefix=)`) and where another file includes it. */
	private pyPrefixes(f: FileFacts, on: string): (string | undefined)[] {
		const mine = own(f.prefixes, on);
		if (!this.pyIncludes) {
			// Key: the file the included router lives in + its name there.
			const map = new Map<string, string | undefined>();
			for (const g of this.files.values()) {
				for (const [k, v] of Object.entries(g.prefixes)) {
					if (!k.startsWith('include:')) {
						continue;
					}
					const ref = k.slice(8);
					const [head, tail] = ref.includes('.') ? [ref.split('.')[0], ref.split('.').slice(1).join('.')] : [ref, undefined];
					const imp = own(g.imports, head);
					if (!imp) {
						continue;
					}
					const file = this.importFile(g, tail ? imp.replace(/:.*$/, '') + (imp.includes(':') ? '.' + imp.split(':')[1] : '') : imp);
					const name = tail ?? imp.split(':')[1];
					const key = file && name !== undefined ? `${file}|${name}` : undefined;
					if (key && !map.has(key)) {
						map.set(key, v);
					}
				}
			}
			this.pyIncludes = map;
		}
		const key = `${f.file}|${on}`;
		return this.pyIncludes.has(key) ? [this.pyIncludes.get(key), mine] : [mine];
	}

	private routeEntries(f: FileFacts, r: RouteFact, prefix: string, add: (fn: FuncFact, verb: string, route: string, controller?: string) => void, depth: number) {
		if (depth > 4) {
			return;
		}
		if (r.verb === 'INCLUDE') {
			const file = this.fileByModule.get(r.handler);
			const g = file ? this.files.get(file) : undefined;
			for (const sub of g?.routes ?? []) {
				this.routeEntries(g!, sub, joinPath(prefix, r.path), add, depth + 1);
			}
			return;
		}
		if (f.lang === 'python' && depth === 0 && this.isIncluded(f)) {
			return; // reached through the urls.py that includes it
		}
		const route = f.lang === 'js' || f.lang === 'go' ? joinPath(this.jsPrefix(f, r.on), r.path) : joinPath(prefix, r.path);
		const inline = this.funcsById.get(r.handler);
		const fn = inline ? [inline] : this.handlerFn(f, r.handler);
		if (fn.length === 0) {
			return;
		}
		for (const x of fn) {
			const verb = r.verb === '*' && f.lang === 'python' && x.owner && PY_VERBS[x.name] ? PY_VERBS[x.name] : r.verb;
			add(x, verb, route, x.owner);
		}
	}

	private isIncluded(f: FileFacts) {
		if (!this.included) {
			this.included = new Set();
			for (const g of this.files.values()) {
				for (const r of g.routes.filter(x => x.verb === 'INCLUDE')) {
					const file = this.fileByModule.get(r.handler);
					if (file) {
						this.included.add(file);
					}
				}
			}
		}
		return this.included.has(f.file);
	}

	private jsPrefix(f: FileFacts, on: string | undefined) {
		if (!on) {
			return '';
		}
		if (own(f.prefixes, on) !== undefined) {
			return own(f.prefixes, on);
		}
		// app.use('/api/users', usersRouter) in another file, where usersRouter is this file's export.
		if (!this.jsMounts) {
			const map = new Map<string, string>();
			for (const g of this.files.values()) {
				for (const [k, v] of Object.entries(g.prefixes)) {
					const imp = own(g.imports, k);
					const file = imp && this.importFile(g, imp);
					if (file && !map.has(file)) {
						map.set(file, v);
					}
				}
			}
			this.jsMounts = map;
		}
		return this.jsMounts.get(f.file) ?? '';
	}

	/** A route handler as written: fn, views.fn, ctrl.method, View.as_view(). */
	private handlerFn(f: FileFacts, handler: string): FuncFact[] {
		const h = handler.replace(/\.as_view\(.*\)$/, '').replace(/\.bind\(.*\)$/, '');
		const parts = h.split('.');
		const name = parts.at(-1)!;
		if (parts.length === 1) {
			const local = f.funcs.find(x => !x.owner && x.name === name);
			if (local) {
				return [local];
			}
			const t = f.types.find(x => x.name === name) ?? this.type(name, f.file);
			if (t) {
				// class-based view: its HTTP methods
				return f.lang === 'python' ? (this.methodsByOwner.get(`${t.file}|${t.name}`) ?? []).filter(m => PY_VERBS[m.name]) : [];
			}
			const imp = own(f.imports, name);
			const file = imp && this.importFile(f, imp);
			const target = file && this.files.get(file)?.funcs.find(x => !x.owner && (x.name === imp.split(':')[1] || (imp.endsWith(':default') && x.exported)));
			if (target) {
				return [target];
			}
			// Go, PHP, Ruby, Rust: a function of the same package (directory), else the only one with that name.
			const sibling = this.pkgFuncs(f, 'dir', path.dirname(f.file), name);
			const anywhere = (this.funcsByName.get(name) ?? []).filter(x => !x.owner && !x.inlineRoute);
			return !PACKAGE_LANGS.has(f.lang) ? [] : sibling.length === 1 ? sibling : anywhere.length === 1 ? anywhere : [];
		}
		const head = parts[0];
		// Controller.action / Type.method: a method of that type, by owner.
		const ownerType = parts.length === 2 ? this.type(head, f.file) : undefined;
		const viaOwner = ownerType && this.lookup(ownerType, name);
		if (viaOwner) {
			return [viaOwner];
		}
		const imp = own(f.imports, head);
		const file = imp ? this.importFile(f, imp) ?? this.fileByModule.get(imp.replace(':', '.')) : undefined;
		const g = file ? this.files.get(file) : f;
		if (!g) {
			return [];
		}
		const fn = g.funcs.find(x => x.name === name && (!x.owner || parts.length === 2));
		if (fn) {
			return [fn];
		}
		const t = g.types.find(x => x.name === name);
		if (t && f.lang === 'python') {
			return (this.methodsByOwner.get(`${t.file}|${t.name}`) ?? []).filter(m => PY_VERBS[m.name]);
		}
		return [];
	}

	// ── Queries from the canvas ─────────────────────────────────────────────────

	entryPoints(): EntryPoint[] {
		this.build();
		return this.entries.map(({ fn: _fn, ...e }) => e);
	}

	private fnFor(id: string): FuncFact | undefined {
		this.build();
		const raw = id.replace(/^poly:/, '').replace(/\|[A-Z*]+$/, '');
		return this.funcsById.get(raw) ?? this.relocate(raw);
	}

	/** An id from before an edit (its line moved): find the function by file, owner and name. */
	private relocate(id: string) {
		const m = id.match(/^(.*)#(?:(\w+)\.)?([^@]+)@\d+$/);
		if (!m) {
			return undefined;
		}
		const [, file, owner, name] = m;
		return this.files.get(file)?.funcs.find(f => f.name === name && (f.owner ?? undefined) === (owner ?? undefined));
	}

	/** getName() { return name; }: plumbing, not flow. */
	private isAccessor(fn: FuncFact) {
		// A declaration read from text that did not parse says so itself: its body was never read, so no call is missing from it.
		return fn.isAccessor ?? (/^(get|set|is|has)[A-Z]/.test(fn.name) && fn.calls.length === 0 && fn.endLine - fn.line <= 4);
	}

	private targets(fn: FuncFact): Target[][] {
		let t = this.resolved.get(fn.id);
		if (!t) {
			t = fn.calls.map(c => {
				const found = this.resolveCall(fn, c).filter(x => x.kind !== 'fn' || !this.isAccessor(x.fn));
				// A name guess (`post` → some function named post) must not hide the endpoint an HTTP client call names.
				if (found.length && !found.every(x => x.kind === 'fn' && x.guess)) {
					return found;
				}
				const http = this.httpLink(fn, c);
				const link = http.length ? http : this.messageLink(fn, c);
				return link.length ? link : found;
			});
			this.resolved.set(fn.id, t);
		}
		return t;
	}

	/**
	 * An HTTP client call into an endpoint of this index (a frontend calling its backend, one service calling
	 * another): always a guess, matched by the route's written segments (see links.ts). Several candidates
	 * (a verb the call does not say, a base path it does not write) become one ambiguous card.
	 */
	private httpLink(fn: FuncFact, c: CallFact): Target[] {
		const lang = this.files.get(fn.file)?.lang;
		// The receiver's declared type, when the index knows it: `RestTemplate rest` is a client whatever it is called.
		const call = lang && httpCallOf(lang, c, c.recv ? this.recvType(fn, c.recv)?.type : undefined);
		if (!call) {
			return [];
		}
		// Only HTTP routes: a listener's `MSG orders` or a job reads like a route but no request reaches it.
		const routes = this.entries.filter(e => !/^(MSG|JOB|SOAP|JSF|WS) /.test(e.http));
		const to = [...new Map(matchEndpoints(call, routes).map(e => [e.fn.id, e.fn] as const)).values()].filter(f => f.id !== fn.id);
		if (to.length === 1) {
			return [{ kind: 'fn', fn: to[0], edge: 'http', guess: true }];
		}
		return to.length ? [{ kind: 'ambiguous', label: `${call.verb ?? 'HTTP'} ${call.url.trim().replace(/\s+/g, '{…}')}`, options: to.slice(0, 6), edge: 'http' }] : [];
	}

	/**
	 * A message sent to a listener of this index (a Kafka topic, a Rabbit/JMS queue, a Celery task): always
	 * a guess, matched by the destination's exact name (see messages.ts). A topic with several listeners
	 * reaches each of them, so they become separate edges, not an ambiguous card.
	 */
	private messageLink(fn: FuncFact, c: CallFact): Target[] {
		const lang = this.files.get(fn.file)?.lang;
		const send = lang && messageSendOf(lang, c, recv => this.recvType(fn, recv)?.type, expr => this.constOf(fn, expr));
		if (!send) {
			return [];
		}
		const consumers = this.buildConsumers();
		let to: FuncFact[];
		if (send.task) {
			// `send_email.delay(…)`: the receiver is the task function itself, resolved like a call to it.
			const dot = send.task.lastIndexOf('.');
			const call: CallFact = dot < 0 ? { name: send.task, line: c.line, strings: [] } : { name: send.task.slice(dot + 1), recv: send.task.slice(0, dot), line: c.line, strings: [] };
			const tasks = new Set(consumers.filter(x => x.celery).map(x => x.fn.id));
			to = this.resolveCall(fn, call).flatMap(t => (t.kind === 'fn' ? [t.fn] : t.kind === 'ambiguous' ? t.options : [])).filter(f => tasks.has(f.id));
		} else {
			to = matchConsumers(send, consumers).map(x => x.fn);
		}
		return [...new Map(to.map(f => [f.id, f] as const)).values()].filter(f => f.id !== fn.id).slice(0, 6).map(f => ({ kind: 'fn', fn: f, edge: 'message', guess: true }));
	}

	/** A string constant an argument names: a local, a field of this class, or `Type.FIELD`. */
	private constOf(fn: FuncFact, expr: string): string | undefined {
		const parts = expr.replace(/^(this|self)\./, '').split('.');
		if (parts.length === 1 && own(fn.consts, parts[0])) {
			return own(fn.consts, parts[0]);
		}
		const t = parts.length === 1 ? this.ownerOf(fn) : parts.length === 2 ? this.type(parts[0], fn.file) : undefined;
		const f = t?.fields.find(x => x.name === parts[parts.length - 1]);
		return f?.init ? unq(f.init.replace(/"\s*\+\s*"/g, '')) : undefined;
	}

	private buildConsumers() {
		if (!this.consumers) {
			const out: { fn: FuncFact; keys: string[]; celery?: boolean }[] = [];
			for (const e of this.entries) {
				const lang = this.files.get(e.fn.file)?.lang;
				for (const a of e.fn.annotations) {
					if (lang === 'python' && /^(shared_task|task)$/.test(a.name)) {
						out.push({ fn: e.fn, keys: celeryTaskNames(a, this.files.get(e.fn.file)?.module, e.fn.name), celery: true });
					} else if ((lang === 'java' && /^(KafkaListener|JmsListener|RabbitListener|SqsListener|StreamListener)$/.test(a.name)) || (lang === 'js' && /^(MessagePattern|EventPattern)$/.test(a.name))) {
						// `topics = Topics.ORDERS` / `{A, B}`: the constants the producer side usually shares.
						const keys = listenerKeys(a, expr => this.constOf(e.fn, expr));
						if (keys.length) {
							out.push({ fn: e.fn, keys });
						}
					}
				}
			}
			this.consumers = out;
		}
		return this.consumers;
	}

	private code(fn: { file: string; line: number; endLine: number }) {
		let lines = this.sources.get(fn.file);
		if (!lines) {
			try {
				lines = fs.readFileSync(fn.file, 'utf8').split('\n');
			} catch {
				lines = [];
			}
			this.sources.set(fn.file, lines);
			if (this.sources.size > 300) {
				this.sources.delete(this.sources.keys().next().value!);
			}
		}
		return lines.slice(fn.line - 1, fn.endLine).join('\n');
	}

	private entryOf(fn: FuncFact) {
		return this.entryById.get(fn.id);
	}

	graph(id: string, depth = 5, withCode = true): FlowNode {
		const root = this.fnFor(id);
		if (!root) {
			throw new Error('This function is no longer in the index. Save the file and try again.');
		}
		let key = 0;
		let count = 0;
		const node = (fn: FuncFact, kind: FlowNode['kind'], d: number, trail: Set<string>): FlowNode => {
			count++;
			const entry = this.entryOf(fn);
			const n: FlowNode = {
				key: `p${key++}`,
				symbolId: `poly:${fn.id}`,
				label: fn.inlineRoute ? `${fn.inlineRoute.verb} ${fn.inlineRoute.path}` : fn.owner ? `${fn.owner}.${fn.name}` : fn.name,
				sub: entry ? entry.http : path.basename(fn.file),
				kind,
				file: fn.file,
				startLine: fn.line,
				endLine: fn.endLine,
				// Reading every file for its text is what makes a flow slow: a walk that only wants the tables skips it.
				code: withCode ? this.code(fn) : null,
				children: [],
			};
			if (d >= depth) {
				return n;
			}
			if (count > MAX_NODES) {
				// The size limit, not the depth limit: the card says how many calls below it were not drawn, so a cut flow never looks whole.
				const left = this.callsBelow(this.targets(fn), new Set(), trail);
				if (left) {
					n.truncated = left;
				}
				return n;
			}
			const seen = new Set<string>();
			const all = this.targets(fn);
			let skipped = 0;
			fn.calls.forEach((c, i) => {
				for (const t of all[i]) {
					if (count > MAX_NODES) {
						// Counted once per distinct callee, the way the walk draws them.
						skipped += this.callsBelow([[t]], seen, trail);
						continue;
					}
					if (t.kind === 'db') {
						const k = `db:${t.label}:${t.schema.ops.join('.')}`;
						if (seen.has(k)) {
							continue;
						}
						seen.add(k);
						count++;
						n.children.push({ callLine: c.line, edgeKind: 'db', ...(t.guess ? { guess: true } : {}), node: { key: `p${key++}`, symbolId: null, label: t.label, sub: t.schema.context, kind: 'db', file: t.file, startLine: t.line, endLine: t.line, code: null, children: [], schema: t.schema } });
					} else if (t.kind === 'ambiguous') {
						if (seen.has(t.label)) {
							continue;
						}
						seen.add(t.label);
						count++;
						const amb: FlowNode = { key: `p${key++}`, symbolId: null, label: t.label, sub: t.edge === 'http' ? `${t.options.length} matching endpoints` : t.edge === 'message' ? `${t.options.length} listeners` : `${t.options.length} implementations`, kind: 'ambiguous', file: null, startLine: 0, endLine: 0, code: null, children: [] };
						for (const o of t.options.slice(0, 6)) {
							if (!trail.has(o.id)) {
								amb.children.push({ callLine: c.line, edgeKind: t.edge ?? 'impl', ...(t.edge ? { guess: true } : {}), node: node(o, this.entryOf(o) ? 'controller' : 'method', d + 1, new Set([...trail, o.id])) });
							}
						}
						n.children.push({ callLine: c.line, edgeKind: t.edge ?? 'call', ...(t.edge ? { guess: true } : {}), node: amb });
					} else {
						if (seen.has(t.fn.id) || trail.has(t.fn.id)) {
							continue;
						}
						seen.add(t.fn.id);
						n.children.push({ callLine: c.line, edgeKind: t.edge, ...(t.guess ? { guess: true } : {}), node: node(t.fn, (t.edge === 'http' || t.edge === 'message') && this.entryOf(t.fn) ? 'controller' : 'method', d + 1, new Set([...trail, t.fn.id])) });
					}
				}
				// Nothing found: library call, or a link only a language server can make.
				if (all[i].length === 0 && c.name.length >= 3 && !COMMON.has(c.name) && !c.name.startsWith('_') && (n.pending?.length ?? 0) < 40 && !(n.pending ?? []).some(p => p.line === c.line && p.name === c.name)) {
					(n.pending ??= []).push({ line: c.line, name: c.name });
				}
			});
			if (skipped) {
				n.truncated = skipped;
			}
			return n;
		};
		return node(root, this.entryOf(root) ? 'controller' : 'method', 0, new Set([root.id]));
	}

	/**
	 * How many distinct callees `targets` holds that the walk has not drawn yet (not in `seen`, not an ancestor in `trail`),
	 * remembered in `seen`. The key is the one the walk itself dedupes by.
	 */
	private callsBelow(targets: Target[][], seen: Set<string>, trail: Set<string>): number {
		let left = 0;
		for (const list of targets) {
			for (const t of list) {
				const key = t.kind === 'db' ? `db:${t.label}:${t.schema.ops.join('.')}` : t.kind === 'ambiguous' ? t.label : t.fn.id;
				if (seen.has(key) || (t.kind === 'fn' && trail.has(t.fn.id))) {
					continue;
				}
				seen.add(key);
				left++;
			}
		}
		return left;
	}

	private buildCallers() {
		if (this.callersOf) {
			return this.callersOf;
		}
		const map = new Map<string, { from: string; line: number; link?: 'http' | 'message' }[]>();
		for (const fn of this.funcsById.values()) {
			const all = this.targets(fn);
			fn.calls.forEach((c, i) => {
				for (const t of all[i]) {
					const ids = t.kind === 'fn' ? [t.fn.id] : t.kind === 'ambiguous' ? t.options.map(o => o.id) : [];
					const link = t.kind !== 'db' && (t.edge === 'http' || t.edge === 'message') ? t.edge : undefined;
					for (const id of ids) {
						this.push(map, id, { from: fn.id, line: c.line, ...(link ? { link } : {}) });
					}
				}
			});
		}
		this.callersOf = map;
		return map;
	}

	callers(id: string, depth = 3): FlowNode | null {
		const root = this.fnFor(id);
		if (!root) {
			return null;
		}
		this.build();
		const map = this.buildCallers();
		let key = 0;
		const node = (fn: FuncFact, d: number, trail: Set<string>): FlowNode => {
			const entry = this.entryOf(fn);
			const n: FlowNode = { key: `c${key++}`, symbolId: `poly:${fn.id}`, label: fn.owner ? `${fn.owner}.${fn.name}` : fn.name, sub: entry?.http ?? path.basename(fn.file), kind: entry ? 'controller' : 'method', file: fn.file, startLine: fn.line, endLine: fn.endLine, code: this.code(fn), children: [] };
			if (d >= depth) {
				return n;
			}
			const seen = new Set<string>();
			for (const c of map.get(fn.id) ?? []) {
				const from = this.funcsById.get(c.from);
				if (!from || seen.has(from.id) || trail.has(from.id)) {
					continue;
				}
				seen.add(from.id);
				n.children.push({ callLine: c.line, edgeKind: c.link ?? 'call', ...(c.link ? { guess: true } : {}), node: node(from, d + 1, new Set([...trail, from.id])) });
			}
			return n;
		};
		return node(root, 0, new Set([root.id]));
	}

	/**
	 * Entry points that reach this function (or, when none do, the top-most callers), each with the file and line to open.
	 * `truncated`: functions the walk had found but not yet followed when it stopped at its size limit, so the answer is a lower bound.
	 */
	impact(id: string): ImpactResult {
		const root = this.fnFor(id);
		if (!root) {
			return { label: 'entry point', items: [] };
		}
		this.build();
		const map = this.buildCallers();
		const found = new Map<string, ImpactItem>();
		const tops = new Map<string, ImpactItem>();
		const seen = new Set<string>([root.id]);
		const queue = [root.id];
		while (queue.length && seen.size < MAX_IMPACT_WALK) {
			const cur = queue.shift()!;
			const fn = this.funcsById.get(cur)!;
			const e = this.entryOf(fn);
			if (e) {
				const label = `${e.http} ${e.controller}.${e.action}`;
				found.has(label) || found.set(label, { label, file: e.file, line: e.line, kind: 'entry' });
			}
			const up = map.get(cur) ?? [];
			if (!up.length && cur !== root.id) {
				const label = fn.owner ? `${fn.owner}.${fn.name}` : fn.name;
				tops.has(label) || tops.set(label, { label, file: fn.file, line: fn.line, kind: 'caller' });
			}
			for (const c of up) {
				if (!seen.has(c.from)) {
					seen.add(c.from);
					queue.push(c.from);
				}
			}
		}
		const rows = (m: Map<string, ImpactItem>) => [...m.values()].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
		const result: ImpactResult = found.size ? { label: 'entry point', items: rows(found) } : { label: 'caller', items: rows(tops) };
		return queue.length ? { ...result, truncated: queue.length } : result;
	}

	/** The innermost function around a line, for "flow at cursor" and follow mode. */
	functionAt(file: string, line: number): { id: string; label: string } | undefined {
		this.build();
		const f = this.files.get(file);
		const hit = f?.funcs.filter(fn => fn.line <= line && line <= fn.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
		return hit && { id: `poly:${hit.id}`, label: hit.inlineRoute ? `${hit.inlineRoute.verb} ${hit.inlineRoute.path}` : hit.owner ? `${hit.owner}.${hit.name}` : hit.name };
	}

	// ── Editing help: completion and go to definition in a card ─────────────────

	private factsFor(file: string): FileFacts | undefined {
		const hit = this.files.get(file);
		if (hit) {
			return hit;
		}
		const key = (p: string) => p.replace(/\\/g, '/').toLowerCase();
		const want = key(file);
		for (const f of this.files.values()) {
			if (key(f.file) === want) {
				return f;
			}
		}
		return undefined;
	}

	private funcAround(facts: FileFacts, line: number): FuncFact | undefined {
		return facts.funcs.filter(fn => fn.line <= line && line <= fn.endLine).sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
	}

	/** The type a class name stands for, from a file. */
	private typeNamed(name: string | undefined, from: string): TypeFact | undefined {
		return name ? this.type(name, from) : undefined;
	}

	/** What a receiver chain stands for: the project's type of the value (or the type itself, for `Foo.bar`). */
	private chainType(fn: FuncFact, segs: readonly Seg[]): { type: TypeFact; isType: boolean } | undefined {
		const owner = this.ownerOf(fn);
		const facts = this.files.get(fn.file)!;
		const first = segs[0];
		let cur: { type: TypeFact; isType: boolean } | undefined;
		if (first.isNew) {
			const t = this.typeNamed(first.name, fn.file);
			cur = t && { type: t, isType: false };
		} else if (first.call) {
			// `getRepo().` : a method of this class, or a function of this file.
			const m = (owner && this.lookup(owner, first.name)) ?? facts.funcs.find(f => !f.owner && f.name === first.name);
			const t = this.typeNamed(baseType(m?.returns), fn.file);
			cur = t && { type: t, isType: false };
		} else {
			const rt = this.recvType(fn, recvText([first]));
			const t = rt && this.typeNamed(baseType(rt.type), fn.file);
			cur = t && { type: t, isType: !!rt?.isType };
		}
		for (const seg of segs.slice(1)) {
			if (!cur) {
				return undefined;
			}
			const here: TypeFact = cur.type;
			if (seg.call) {
				const t = this.typeNamed(baseType(this.lookup(here, seg.name)?.returns), here.file);
				cur = t && { type: t, isType: false };
			} else {
				const f = this.field(here, seg.name);
				const t = f && this.typeNamed(baseType(f.type), here.file);
				cur = t && { type: t, isType: false };
			}
		}
		return cur;
	}

	/** The type and its superclasses and interfaces, nearest first. */
	private withSupers(t: TypeFact): TypeFact[] {
		const out: TypeFact[] = [];
		const queue = [t];
		while (queue.length && out.length < 12) {
			const x = queue.shift()!;
			if (out.includes(x)) {
				continue;
			}
			out.push(x);
			for (const s of x.supers) {
				const st = this.type(s, x.file);
				if (st) {
					queue.push(st);
				}
			}
		}
		return out;
	}

	/** The members of a type (its own, then its supers'), as completion items. */
	private memberItems(t: TypeFact, lang: Lang, from: TypeFact | undefined, staticOnly: boolean, ruby: boolean): Suggestion[] {
		const out: Suggestion[] = [];
		const seen = new Set<string>();
		const add = (s: Suggestion) => {
			if (!seen.has(s.label)) {
				seen.add(s.label);
				out.push(s);
			}
		};
		this.withSupers(t).forEach((st, depth) => {
			const same = !!from && st === from;
			const rank = depth === 0 ? '1' : '2';
			for (const f of st.fields) {
				if (!f.name || (staticOnly && f.isStatic === false && lang !== 'python') || (!same && f.visibility === '-')) {
					continue;
				}
				add({ label: f.name, kind: st.kind === 'enum' ? Kind.Constant : Kind.Field, detail: f.typeText ?? f.type, insertText: f.name, snippet: false, sortText: `${rank}${f.name}` });
			}
			for (const m of this.methodsByOwner.get(`${st.file}|${st.name}`) ?? []) {
				if (isConstructorName(m.name) || m.inlineRoute || (staticOnly && !m.isStatic && lang !== 'python' && lang !== 'go') || (!same && lang === 'java' && !m.isPublic) || (!same && m.visibility === '-')) {
					continue;
				}
				add({ label: m.name, kind: Kind.Method, detail: signatureDetail(m, lang), insertText: ruby ? m.name : `${m.name}($1)`, snippet: !ruby, sortText: `${rank}${m.name}` });
			}
		});
		return out;
	}

	/**
	 * What to offer at the cursor of a card: after `recv.` the members of the type the receiver has; otherwise what is in scope
	 * (parameters, locals, the class's own members where the language allows a bare name, imports, the file's functions and types).
	 * `startLine`: the card's first line in the file (it finds the function); `before`: the line up to the cursor.
	 */
	completeAt(q: { file: string; startLine: number; before: string }): { items: Suggestion[]; why?: string } {
		this.build();
		const facts = this.factsFor(q.file);
		if (!facts) {
			return { items: [], why: 'this file is not in the index' };
		}
		const fn = this.funcAround(facts, q.startLine);
		const lang = facts.lang;
		const owner = fn && this.ownerOf(fn);
		const chain = chainBefore(q.before);
		if (chain) {
			if (!fn) {
				return { items: [], why: 'the cursor is not in an indexed function' };
			}
			const hit = this.chainType(fn, chain.segs);
			if (!hit) {
				return { items: [], why: `the type of ${recvText(chain.segs)} is not known to the index` };
			}
			return { items: this.memberItems(hit.type, lang, owner, hit.isType, lang === 'ruby') };
		}
		const out: Suggestion[] = [];
		const seen = new Set<string>();
		const add = (s: Suggestion) => {
			if (!seen.has(s.label)) {
				seen.add(s.label);
				out.push(s);
			}
		};
		for (const [name, type] of Object.entries(fn?.locals ?? {})) {
			add({ label: name, kind: Kind.Variable, detail: type, insertText: name, snippet: false, sortText: `0${name}` });
		}
		for (const [name, type] of Object.entries(fn?.params ?? {})) {
			add({ label: name, kind: Kind.Variable, detail: type, insertText: name, snippet: false, sortText: `0${name}` });
		}
		if (owner && (lang === 'java' || lang === 'ruby')) {
			for (const s of this.memberItems(owner, lang, owner, false, lang === 'ruby')) {
				add({ ...s, sortText: `1${s.label}` });
			}
		}
		for (const [name, target] of Object.entries(facts.imports)) {
			add({ label: name, kind: /^[A-Z]/.test(name) ? Kind.Class : Kind.Module, detail: target, insertText: name, snippet: false, sortText: `2${name}` });
		}
		for (const [name, type] of Object.entries(facts.globals)) {
			add({ label: name, kind: Kind.Variable, detail: type, insertText: name, snippet: false, sortText: `2${name}` });
		}
		for (const f of facts.funcs) {
			if (!f.owner && !f.inlineRoute && f.name) {
				add({ label: f.name, kind: Kind.Function, detail: signatureDetail(f, lang), insertText: `${f.name}($1)`, snippet: true, sortText: `2${f.name}` });
			}
		}
		for (const t of facts.types) {
			add({ label: t.name, kind: t.kind === 'interface' ? Kind.Interface : t.kind === 'enum' ? Kind.Enum : Kind.Class, insertText: t.name, snippet: false, sortText: `2${t.name}` });
		}
		// Other types of the project last (a few hundred at most: the canvas filters as the user types).
		for (const name of [...this.typesByName.keys()].sort()) {
			if (out.length >= 600) {
				break;
			}
			const t = this.typesByName.get(name)![0];
			add({ label: name, kind: t.kind === 'interface' ? Kind.Interface : t.kind === 'enum' ? Kind.Enum : Kind.Class, detail: path.basename(t.file), insertText: name, snippet: false, sortText: `3${name}` });
		}
		return { items: out };
	}

	private placeOfFn(fn: FuncFact): Place {
		return { file: fn.file, line: fn.line, label: fn.owner ? `${fn.owner}.${fn.name}` : fn.name };
	}

	private placeOfType(t: TypeFact): Place {
		return { file: t.file, line: t.line, label: t.name };
	}

	private placesOf(targets: readonly Target[]): Place[] {
		const out: Place[] = [];
		for (const t of targets) {
			if (t.kind === 'fn') {
				out.push(this.placeOfFn(t.fn));
			} else if (t.kind === 'ambiguous') {
				out.push(...t.options.map(o => this.placeOfFn(o)));
			} else if (t.file) {
				out.push({ file: t.file, line: t.line, label: t.label });
			}
		}
		return out;
	}

	/**
	 * Where the identifier at a column of a card's line is defined: the function a call reaches (an interface call: its
	 * implementations), a type, a field, or a local or parameter (a place inside the card). `lineText` is the card line as typed now;
	 * `cardText` the whole card (a local's declaration is found in it); `cardLine` is the line's number in the card (1-based).
	 */
	definitionAt(q: { file: string; startLine: number; lineText: string; column: number; cardText: string; cardLine: number }): { places: Place[]; message?: string } {
		this.build();
		const facts = this.factsFor(q.file);
		const hit = wordAt(q.lineText, q.column);
		if (!facts || !hit) {
			return { places: [], message: hit ? 'This file is not in the index.' : undefined };
		}
		const fn = this.funcAround(facts, q.startLine);
		const owner = fn && this.ownerOf(fn);
		const word = hit.word;
		const chain = chainBefore(q.lineText.slice(0, hit.start));
		const after = q.lineText.slice(hit.end).trimStart();
		const isCall = after.startsWith('(');
		const places: Place[] = [];
		const push = (p: Place | undefined) => {
			if (p && !places.some(x => x.file === p.file && x.line === p.line && x.cardLine === p.cardLine)) {
				places.push(p);
			}
		};
		if (fn && (isCall || chain)) {
			// A call, or a member: resolved the way the flow resolves it (by the receiver's type).
			// A receiver that is only names (no calls in it) resolves like the flow's own call facts do.
			const plain = !chain || chain.segs.every(s => !s.call && !s.isNew);
			if (isCall && plain) {
				this.placesOf(this.resolveCall(fn, { name: word, recv: chain ? recvText(chain.segs) : undefined, line: q.startLine + q.cardLine - 1, strings: [] })).forEach(push);
			}
			if (!places.length && chain) {
				const t = this.chainType(fn, chain.segs);
				if (t) {
					const m = this.lookup(t.type, word);
					if (m) {
						push(this.placeOfFn(m));
					}
					const f = !m && this.withSupers(t.type).find(st => st.fields.some(x => x.name === word));
					if (f) {
						push({ file: f.file, line: f.fields.find(x => x.name === word)!.line, label: `${f.name}.${word}` });
					}
				}
			}
			if (places.length) {
				return { places };
			}
		}
		if (!chain) {
			// A local or a parameter: its first mention in the card (the declaration), when that is not this very place.
			if (fn && (word in fn.locals || word in fn.params)) {
				const lines = q.cardText.replace(/\r\n/g, '\n').split('\n');
				const mention = new RegExp(`(?<![\\p{L}\\p{N}_$])${word.replace(/\$/g, '\\$')}(?![\\p{L}\\p{N}_$])`, 'u');
				const at = lines.findIndex(l => mention.test(l));
				const col = at < 0 ? -1 : lines[at].search(mention);
				if (at >= 0 && (at + 1 < q.cardLine || (at + 1 === q.cardLine && col < hit.start))) {
					return { places: [{ file: facts.file, line: q.startLine + at, column: col + 1, cardLine: at + 1, cardColumn: col + 1, label: word }] };
				}
			}
			// A field of this class (or its supers).
			const field = owner && this.withSupers(owner).find(st => st.fields.some(f => f.name === word));
			if (field) {
				push({ file: field.file, line: field.fields.find(f => f.name === word)!.line, label: `${field.name}.${word}` });
			}
			// A type, an imported one included.
			const t = this.typeNamed(word, facts.file);
			if (t) {
				push(this.placeOfType(t));
			}
			const imp = own(facts.imports, word);
			if (!places.length && imp) {
				const file = this.importFile(facts, imp);
				const target = file && this.files.get(file);
				const name = imp.split(':')[1] ?? imp.split('.').pop();
				const ty = target && target.types.find(x => x.name === word || x.name === name);
				const func = target && target.funcs.find(f => !f.owner && (f.name === word || f.name === name));
				if (ty) {
					push(this.placeOfType(ty));
				} else if (func) {
					push(this.placeOfFn(func));
				} else if (file) {
					push({ file, line: 1, label: word });
				}
			}
			const free = facts.funcs.find(f => !f.owner && f.name === word);
			if (free) {
				push(this.placeOfFn(free));
			}
		}
		return places.length ? { places } : { places, message: `No definition of ${word} found in the index.` };
	}

	/** The function a call at the cursor reaches, for parameter hints: its parameters as written and which one the cursor is in. */
	signatureAt(q: { file: string; startLine: number; before: string }): { label: string; params: string[]; active: number } | undefined {
		this.build();
		const facts = this.factsFor(q.file);
		const call = callBefore(q.before);
		const fn = facts && this.funcAround(facts, q.startLine);
		if (!facts || !call || !fn) {
			return undefined;
		}
		const owner = this.ownerOf(fn);
		let target: FuncFact | undefined;
		if (call.segs.length) {
			const hit = this.chainType(fn, call.segs);
			target = hit && this.lookup(hit.type, call.name);
		} else {
			target = (owner && this.lookup(owner, call.name)) ?? facts.funcs.find(f => !f.owner && f.name === call.name);
		}
		if (!target || isConstructorName(target.name)) {
			return undefined;
		}
		return { label: `${target.name}${signatureDetail(target, facts.lang)}`, params: paramLabels(target, facts.lang), active: call.active };
	}

	/** Functions in a file, for the ◆ Flow lenses. */
	methodsIn(file: string): { id: string; name: string; line: number; startLine: number; endLine: number; isEntry: boolean }[] {
		this.build();
		return (this.files.get(file)?.funcs ?? []).map(fn => ({ id: `poly:${fn.id}`, name: fn.owner ? `${fn.owner}.${fn.name}` : fn.name, line: fn.line, startLine: fn.line, endLine: fn.endLine, isEntry: !!this.entryOf(fn) }));
	}

	/**
	 * What the type model is built from: every file's facts, and the resolved calls between classes (how many call sites go from one
	 * class to another, an interface call counted for the implementation it reaches), so the architecture view needs no resolver of its own.
	 */
	typeFacts(): { files: FileFacts[]; calls: TypeCall[]; entries: TypeEntry[] } {
		this.build();
		const counts = new Map<string, TypeCall>();
		for (const f of this.files.values()) {
			for (const fn of f.funcs) {
				if (!fn.owner || fn.inlineRoute) {
					continue;
				}
				for (const group of this.targets(fn)) {
					for (const t of group) {
						if (t.kind !== 'fn' || !t.fn.owner || (t.fn.file === fn.file && t.fn.owner === fn.owner) || t.fn.name === '<init>' || t.guess) {
							continue;
						}
						const key = `${fn.file}|${fn.owner}|${t.fn.file}|${t.fn.owner}`;
						const hit = counts.get(key);
						if (hit) {
							hit.count++;
						} else {
							counts.set(key, { fromFile: fn.file, fromOwner: fn.owner, toFile: t.fn.file, toOwner: t.fn.owner, count: 1 });
						}
					}
				}
			}
		}
		// The bodies are not part of the type model: leaving calls, locals and constants out keeps what crosses to the extension host small.
		const slim = (fn: FuncFact): FuncFact => ({ ...fn, calls: [], locals: {}, consts: {}, isAccessor: this.isAccessor(fn) });
		const entries = this.entries.map((e): TypeEntry => ({
			id: e.id, controller: e.controller, action: e.action, http: e.http, file: e.file, line: e.line, owner: e.fn.owner,
			params: e.fn.paramInfo?.length ? e.fn.paramInfo.map(p => ({ name: p.name, typeText: p.typeText, anns: p.anns })) : Object.entries(e.fn.params).map(([name, typeText]) => ({ name, typeText, anns: [] })),
			returns: e.fn.returns,
		}));
		// A Go or Rust type is sent merged with the methods and impls other files of its package add to it (see `mergeStubTypes`).
		return { files: [...this.files.values()].map(f => ({ ...f, types: f.types.map(t => t.stub ? t : this.canon.get(t) ?? t), funcs: f.funcs.map(slim) })), calls: [...counts.values()], entries };
	}

	/** Every schema the readers found, columns and relations included: what a generated ER board is drawn from. Sorted by table. */
	schemaFacts(): (DbSchema & { orm: string; guess: boolean })[] {
		this.build();
		return [...this.schemaList.values()].flat()
			.map(s => ({ ...s, ops: [], guess: this.guessedTables.has(`${s.file}|${s.line}`) }))
			.sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : 0));
	}

	/** Every entity or model class the schema readers found with its table: what an edit to an entity file is resolved against. */
	entities(): TableEntity[] {
		this.build();
		return this.entityFacts.slice();
	}

	/**
	 * The database cards the entry points' flows reach, with the method that makes each call: the table → endpoints index.
	 * Walked a few entry points at a time within `budgetMs` (this worker answers one request at a time), where it left off the
	 * last call; an edit that rebuilds the index starts it over. `done` says whether every entry point has been walked.
	 */
	tableUses(budgetMs = 4000): TablesFact {
		this.build();
		const walk = this.tableWalk ??= { next: 0, uses: [] };
		const total = Math.min(this.entries.length, MAX_TABLE_ENTRIES);
		const deadline = Date.now() + budgetMs;
		while (walk.next < total && Date.now() < deadline && walk.uses.length < MAX_TABLE_USES) {
			const entry = this.entries[walk.next++];
			try {
				this.collectTables(entry.id, this.graph(entry.id, 5, false), walk.uses);
			} catch {
				// one flow that cannot be traced must not lose the others
			}
		}
		const done = walk.next >= total || walk.uses.length >= MAX_TABLE_USES;
		return { uses: walk.uses.slice(), done, checked: walk.next, total: this.entries.length };
	}

	private collectTables(entry: string, root: FlowNode, out: TableUseFact[]) {
		const seen = new Set<string>();
		const visit = (n: FlowNode) => {
			for (const c of n.children) {
				const schema = c.node.schema;
				if (c.edgeKind === 'db' && schema && schema.entity !== '?') {
					const k = `${tableKey(schema.table)}|${schema.writes}|${c.node.label}|${n.label}`;
					if (!seen.has(k)) {
						seen.add(k);
						out.push({ entry, table: schema.table, schemaName: schema.dbSchemaName, entity: schema.entity, write: schema.writes, guess: !!c.guess, card: c.node.label, from: n.label, file: n.file, line: c.callLine, ops: schema.ops });
					}
				} else {
					visit(c.node);
				}
			}
		};
		visit(root);
	}

	stats() {
		this.build();
		let funcs = 0;
		for (const f of this.files.values()) {
			funcs += f.funcs.length;
		}
		return { files: this.files.size, funcs, entries: this.entries.length, tables: new Set([...this.schemas.values()].map(s => s.table)).size };
	}
}
