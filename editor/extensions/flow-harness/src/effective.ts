/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the effective configuration for one file. Which instruction files and
 *  path-scoped rules an agent working on it reads, in the order they stack, and which value of
 *  each setting wins across managed / local / project / user. Instructions never override one
 *  another: they are all read, the more specific later. Scalar settings do override (managed,
 *  then local, then project, then user); permission lists merge, and a deny from any scope wins.
 *  Pure (no vscode), so it is tested on its own.
 *--------------------------------------------------------------------------------------------*/

import type { Effect, Rule, RuleScope } from './permmatch';

/** The fields of a harness item this needs (see scan.ts HarnessItem). */
export interface InstructionLike {
	kind: string;
	scope: string;
	label: string;
	file: string;
	agents: string[];
	tokens?: number;
	/** Rules: the `paths` (Claude) or `globs` (Cursor) they are scoped to; empty or undefined for an always-on rule. */
	paths?: string[];
}

export interface Applied<T extends InstructionLike = InstructionLike> {
	item: T;
	agent: string;
	/** When it is read: at the start of every session, or when the agent touches files here. */
	when: 'always' | 'on-demand' | 'not-loaded';
	why: string;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
const caseless = (p: string) => /^[A-Za-z]:/.test(p);
const same = (a: string, b: string) => caseless(a) ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Whether `file` is `dir` or inside it. */
export function under(file: string, dir: string) {
	const f = norm(file);
	const d = norm(dir);
	return same(f, d) || (caseless(f) ? f.toLowerCase().startsWith(`${d.toLowerCase()}/`) : f.startsWith(`${d}/`));
}
const rel = (file: string, root: string) => norm(file).slice(norm(root).length + 1);

/** `{a,b}` alternatives expanded, so `src/**\/*.{ts,tsx}` becomes two plain globs. */
function braces(glob: string): string[] {
	const m = /\{([^{}]*)\}/.exec(glob);
	if (!m) {
		return [glob];
	}
	return m[1].split(',').flatMap(alt => braces(glob.slice(0, m.index) + alt + glob.slice(m.index + m[0].length)));
}

/**
 * Whether a glob is small enough to be matched safely: a rule's globs are the text of a file, and a few dozen `{a,b}` groups expand to
 * billions of globs while `*a*a*a*a*b` makes the regular expression it becomes take minutes on one path. Longer or more starred globs are not matched at all.
 */
export function globIsBounded(pattern: string): boolean {
	if (pattern.length > 200 || (pattern.match(/\*\*/g)?.length ?? 0) > 2 || (pattern.match(/\*+/g)?.length ?? 0) > 6 || pattern.split('/').some(seg => (seg.match(/\*+/g)?.length ?? 0) > 2)) {
		return false;
	}
	let factor = 1;
	let s = pattern;
	for (let m = /\{([^{}]*)\}/.exec(s); m; m = /\{([^{}]*)\}/.exec(s)) {
		factor *= m[1].split(',').length;
		if (factor > 32) {
			return false;
		}
		s = s.slice(0, m.index) + 'x' + s.slice(m.index + m[0].length);
	}
	return true;
}

/** A rule's `paths` glob against a path relative to the project root: `**` across folders, `*` within one; a pattern without a slash matches the name at any depth. */
export function globMatch(pattern: string, relPath: string): boolean {
	return globMatcher(pattern)(relPath);
}

/** The glob compiled once, for matching it against many paths. A glob that is not bounded (globIsBounded) matches nothing. */
export function globMatcher(pattern: string): (relPath: string) => boolean {
	if (!globIsBounded(pattern)) {
		return () => false;
	}
	const regexes = braces(pattern.trim().replace(/^\.\//, '').replace(/^\//, '')).map(g => {
		let re = '';
		for (let i = 0; i < g.length; i++) {
			const c = g[i];
			if (c === '*' && g[i + 1] === '*') {
				re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
				i += g[i + 2] === '/' ? 2 : 1;
			} else if (c === '*') {
				re += '[^/]*';
			} else if (c === '?') {
				re += '[^/]';
			} else {
				re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			}
		}
		const anyDepth = !g.includes('/');
		return new RegExp(`^${anyDepth ? '(?:.*/)?' : ''}${re}(?:/.*)?$`, 'i');
	});
	return relPath => regexes.some(r => r.test(relPath));
}

/** `paths: src/**, "*.{ts,tsx}"` or a YAML list (joined with commas by frontMatter): the globs, split at commas outside braces. */
export function globList(value: string): string[] {
	const out: string[] = [];
	let cur = '';
	let depth = 0;
	for (const c of value.replace(/^\[|\]$/g, '')) {
		depth += c === '{' ? 1 : c === '}' ? -1 : 0;
		if (c === ',' && depth <= 0) {
			out.push(cur);
			cur = '';
		} else {
			cur += c;
		}
	}
	out.push(cur);
	return out.map(g => g.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean);
}

const SCOPE_ORDER: Record<string, number> = { user: 0, project: 1, local: 2, directory: 3 };
const WHEN_ORDER = { always: 0, 'on-demand': 1, 'not-loaded': 2 } as const;

/**
 * What an agent working on `file` reads, per agent, in the order it stacks (widest first: a later file is read later
 * and is the more specific). `root` is where the agent was started (Insilode starts agents at the workspace root).
 */
export function instructionsFor<T extends InstructionLike>(file: string, root: string, items: readonly T[]): Applied<T>[] {
	const out: Applied<T>[] = [];
	const inside = under(file, root);
	const relFile = inside ? rel(file, root) : '';
	for (const item of items) {
		const dir = norm(item.file).replace(/\/[^/]*$/, '');
		for (const agent of item.agents) {
			if (item.kind === 'instructions') {
				if (item.scope !== 'directory') {
					out.push({ item, agent, when: 'always', why: item.scope === 'user' ? 'Your own instructions, read in every project' : item.scope === 'local' ? 'Yours only (not committed), read in every session here' : 'Read at the start of every session in this project' });
				} else if (agent === 'Claude') {
					if (under(file, dir)) {
						out.push({ item, agent, when: 'on-demand', why: `Read when Claude works with files under ${rel(dir, root) || '.'}/, which this file is in` });
					}
				} else if (under(file, dir)) {
					// Codex merges AGENTS.md from the project root down to the folder it was started in, not the folder of a file it opens.
					out.push({ item, agent, when: 'not-loaded', why: `Codex reads this only when started in ${rel(dir, root) || '.'}/ (Insilode starts it at the root)` });
				}
			} else if (item.kind === 'rules') {
				const globs = item.paths?.filter(Boolean) ?? [];
				if (!globs.length) {
					out.push({ item, agent, when: 'always', why: 'A rule without paths: read in every session' });
				} else if (inside) {
					const hit = globs.find(g => globMatch(g, relFile));
					if (hit) {
						out.push({ item, agent, when: 'on-demand', why: `Its paths include ${hit}, which matches ${relFile}` });
					}
				}
			}
		}
	}
	return out.sort((a, b) => a.agent.localeCompare(b.agent)
		|| (a.item.kind === b.item.kind ? 0 : a.item.kind === 'instructions' ? -1 : 1)
		|| (SCOPE_ORDER[a.item.scope] ?? 9) - (SCOPE_ORDER[b.item.scope] ?? 9)
		|| WHEN_ORDER[a.when] - WHEN_ORDER[b.when]
		|| norm(a.item.file).length - norm(b.item.file).length);
}

export interface SettingsLayer {
	scope: RuleScope;
	file: string;
	/** The parsed settings file; undefined when it does not exist. */
	data?: Record<string, unknown>;
	/** Set when the file exists but could not be read as JSON: Claude Code ignores it. */
	error?: string;
}

export interface ScalarSetting {
	key: string;
	value: unknown;
	scope: RuleScope;
	file: string;
	/** The same key in lower-precedence files, which lose. */
	overridden: { scope: RuleScope; file: string; value: unknown }[];
}

/** Highest first: managed, then the command line (session), then local, project and user. */
export const PRECEDENCE: RuleScope[] = ['managed', 'session', 'local', 'project', 'user'];

/** Keys whose value is a list or an object of lists: they merge across files instead of overriding. */
const MERGED = new Set(['permissions.allow', 'permissions.ask', 'permissions.deny', 'permissions.additionalDirectories', 'hooks', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'env']);

function flatten(data: Record<string, unknown>, prefix = ''): [string, unknown][] {
	return Object.entries(data).flatMap(([k, v]) => {
		const key = prefix ? `${prefix}.${k}` : k;
		if (MERGED.has(key)) {
			return [[key, v] as [string, unknown]];
		}
		return v && typeof v === 'object' && !Array.isArray(v) && key === 'permissions' ? flatten(v as Record<string, unknown>, key) : [[key, v] as [string, unknown]];
	});
}

export interface Effective {
	/** Scalar settings set anywhere, each with the value that wins and what it overrides. */
	scalars: ScalarSetting[];
	/** Every permission rule from every file, for the simulator; deny from any scope wins, so none is dropped. */
	rules: Rule[];
	/** Environment variables merged across files (a higher scope wins per variable). */
	env: { key: string; value: unknown; scope: RuleScope }[];
	/** defaultMode as Claude Code applies it from these files; undefined when none decides. */
	mode?: string;
	/** Why a defaultMode in the files is not the one that applies. */
	modeNote?: string;
	additionalDirs: string[];
}

export function effectiveSettings(layers: readonly SettingsLayer[]): Effective {
	const ranked = [...layers].filter(l => l.data).sort((a, b) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope));
	const scalars = new Map<string, ScalarSetting>();
	const env = new Map<string, { key: string; value: unknown; scope: RuleScope }>();
	const rules: Rule[] = [];
	const additionalDirs: string[] = [];
	for (const layer of ranked) {
		for (const [key, value] of flatten(layer.data!)) {
			if (key === 'env' && value && typeof value === 'object') {
				for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
					if (!env.has(k)) {
						env.set(k, { key: k, value: v, scope: layer.scope });
					}
				}
				continue;
			}
			if (key === 'permissions.allow' || key === 'permissions.ask' || key === 'permissions.deny') {
				const effect = key.slice('permissions.'.length) as Effect;
				for (const pattern of Array.isArray(value) ? value : []) {
					if (typeof pattern === 'string') {
						rules.push({ pattern, effect, scope: layer.scope, file: layer.file });
					}
				}
				continue;
			}
			if (key === 'permissions.additionalDirectories') {
				additionalDirs.push(...(Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []));
				continue;
			}
			if (MERGED.has(key) || key === 'permissions') {
				continue;
			}
			const seen = scalars.get(key);
			if (seen) {
				seen.overridden.push({ scope: layer.scope, file: layer.file, value });
			} else {
				scalars.set(key, { key, value, scope: layer.scope, file: layer.file, overridden: [] });
			}
		}
	}
	return { scalars: [...scalars.values()], rules, env: [...env.values()], ...startMode(scalars.get('permissions.defaultMode')), additionalDirs };
}

/**
 * The mode a session starts in, by the settings: a project or local file cannot choose auto (Claude Code then uses its
 * built-in default, not a user setting) or bypassPermissions (the session starts in Manual mode). Undefined when no file
 * decides, which leaves Claude Code's built-in default.
 */
function startMode(set: ScalarSetting | undefined): { mode?: string; modeNote?: string } {
	const v = set?.value;
	if (typeof v !== 'string' || !set) {
		return {};
	}
	const mode = v === 'manual' ? 'default' : v;
	if ((set.scope === 'project' || set.scope === 'local') && (mode === 'auto' || mode === 'bypassPermissions')) {
		return mode === 'auto'
			? { modeNote: `defaultMode "auto" in ${set.scope} settings does not take effect` }
			: { mode: 'default', modeNote: `defaultMode "bypassPermissions" in ${set.scope} settings does not take effect: sessions start in Manual mode` };
	}
	return { mode };
}
