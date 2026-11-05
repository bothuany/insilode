/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: one merged picture of everything that shapes an agent in this workspace —
 *  instructions, rules, skills, subagents, hooks, MCP servers and permission rules — with the
 *  scope each comes from, what it costs in context, and what looks broken.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, statSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { globList } from './effective';
import { parseIndex, parseMemory, projectKey, type Memory } from './memory';
import { lint, ruleGlobs, type InstructionKind, type LintFile } from './lint';
import { projectGaps, type Gap } from './gaps';
import { gitIgnoredOf } from './ignored';
import { claudeDir, codexDir } from './dirs';
import { maskArgs, maskUrl, readMcp, type McpServer } from './mcpconfig';

export type Scope = 'user' | 'project' | 'local' | 'directory';
export type Kind = 'instructions' | 'rules' | 'skills' | 'agents' | 'hooks' | 'mcp' | 'permissions' | 'memory';
export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
	severity: Severity;
	message: string;
	/** 0-based line in `file`, when the problem is on a line. */
	line?: number;
	/** What to do about it, from the lint. */
	fix?: string;
}

export interface HarnessItem {
	kind: Kind;
	scope: Scope;
	label: string;
	detail: string;
	file: string;
	/** Tokens read only when they apply (a folder's CLAUDE.md, a path-scoped rule, a skill's or subagent's body). Estimates, like `tokens`. */
	onDemand?: number;
	/** Tokens this costs in every session (memory files, skill descriptions); undefined when unknown. */
	tokens?: number;
	issues: Issue[];
	/** Hooks: what to run and when. */
	hook?: { event: string; matcher?: string; command: string; settingsFile: string };
	/** Hooks and permission rules: the 0-based line they are written on in their settings file. */
	line?: number;
	/** Permission rules: allow / ask / deny. */
	rule?: { effect: 'allow' | 'ask' | 'deny'; pattern: string };
	/** Memory: the parsed topic file (its body is what the staleness check reads). */
	memory?: Memory;
	/** Path-scoped rules: the globs they apply to (empty for an always-on rule). */
	paths?: string[];
	/** MCP servers: the manager's id for it, the name its tool calls carry, and whether it is on. */
	mcp?: { id: string; toolPrefix: string; state: McpServer['state']; transport: McpServer['transport'] };
	agents: string[];
}

export interface Harness {
	root: string;
	items: HarnessItem[];
	score: number;
	counts: Record<Severity, number>;
	/** What this project has not set up (see gaps.ts); missing instructions also lower the score. */
	gaps: Gap[];
	/** Tokens loaded into every new session before the first prompt. */
	startupTokens: number;
	/** Limits the scan hit (more files than it lists): shown with the result, never silently. */
	notes?: string[];
}

const home = os.homedir();
const tokensOf = (text: string) => Math.round(text.length / 4);
const read = (p: string) => fs.readFile(p, 'utf8').catch(() => undefined);
const exists = (p: string) => fs.stat(p).then(() => true, () => false);
const show = (root: string, p: string) => p.startsWith(root + path.sep) ? path.relative(root, p) : p.replace(home, '~');

function frontMatter(text: string): Record<string, string> {
	const m = /^---\r?\n(?<body>[\s\S]*?)\r?\n---/.exec(text);
	const out: Record<string, string> = {};
	const lines = m?.groups?.body.split(/\r?\n/) ?? [];
	let key = '';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const kv = /^(?<k>[\w-]+):\s*(?<v>.*)$/.exec(line);
		if (!kv?.groups) {
			if (key && /^\s*-\s+/.test(line)) {
				out[key] = [out[key], line.replace(/^\s*-\s+/, '')].filter(Boolean).join(',');
			}
			continue;
		}
		key = kv.groups.k;
		const inline = kv.groups.v.trim();
		const next = () => lines[i + 1] ?? '';
		// `description: >` and `description: |`: the text is the indented lines below, shown as one line.
		if (/^[>|][+-]?\d*$/.test(inline)) {
			const parts: string[] = [];
			while (i + 1 < lines.length && (!next().trim() || /^\s/.test(next()))) {
				parts.push(lines[++i].trim());
			}
			out[key] = parts.join(' ').replace(/\s+/g, ' ').trim();
			continue;
		}
		// A value that goes on over indented lines (or starts on the next one); list items and nested keys are not part of it.
		const parts = inline ? [inline] : [];
		while (/^\s+\S/.test(next()) && !/^\s*-\s+/.test(next()) && (parts.length || !/^\s+[\w-]+:(\s|$)/.test(next()))) {
			parts.push(lines[++i].trim());
		}
		out[key] = parts.join(' ').replace(/^(["'])(.*)\1$/, '$2');
	}
	return out;
}

async function listDir(dir: string): Promise<string[]> {
	return (await fs.readdir(dir).catch(() => [] as string[])).map(n => path.join(dir, n));
}

/**
 * Prose often names a path relative to some project folder ("Data/Extensions/X.cs"): it is only
 * broken when nothing in the workspace ends with it.
 */
const somewhere = new Map<string, Promise<boolean>>();
/** Every distinct path costs a workspace search: past this many in one scan, the rest are given the benefit of the doubt. */
const MAX_LOOKUPS = 25;
function existsSomewhere(ref: string): Promise<boolean> {
	const clean = ref.replace(/^\.\//, '');
	if (!somewhere.has(clean)) {
		if (somewhere.size >= MAX_LOOKUPS) {
			return Promise.resolve(true);
		}
		somewhere.set(clean,Promise.resolve(vscode.workspace.findFiles(`**/${clean}`, '{**/node_modules/**,**/.git/**}', 1)).then(r => r.length > 0, () => true));
	}
	return somewhere.get(clean)!;
}

/**
 * Paths a memory file points at: `@imports` and backticked relative paths that look like files.
 * Only what is clearly meant as a path is checked, so prose never turns into false alarms.
 */
async function brokenPaths(file: string, text: string, root: string): Promise<Issue[]> {
	const issues: Issue[] = [];
	const lines = text.split(/\r?\n/);
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}
		const candidates: { ref: string; isImport: boolean }[] = [];
		for (const m of line.matchAll(/(?:^|\s)@(?<p>[~.\w/-]+\.\w+)/g)) {
			candidates.push({ ref: m.groups!.p, isImport: true });
		}
		for (const m of line.matchAll(/`(?<p>(?:\.{1,2}\/|[\w.-]+\/)[\w./-]+\.[a-zA-Z]{1,6})`/g)) {
			if (!/[*{}$<>]/.test(m.groups!.p)) {
				candidates.push({ ref: m.groups!.p, isImport: false });
			}
		}
		for (const c of candidates) {
			const target = c.ref.startsWith('~') ? path.join(home, c.ref.slice(1)) : path.resolve(c.ref.startsWith('.') ? path.dirname(file) : root, c.ref);
			if (!await exists(target) && !await exists(path.resolve(path.dirname(file), c.ref)) && !(!c.isImport && await existsSomewhere(c.ref))) {
				issues.push({ severity: c.isImport ? 'error' : 'warning', message: c.isImport ? `Import @${c.ref} does not exist` : `Mentions ${c.ref}, which does not exist`, line: i });
			}
		}
	}
	return issues;
}

async function memoryFile(items: HarnessItem[], root: string, file: string, scope: Scope, agents: string[], where: string) {
	const text = await read(file);
	if (text === undefined) {
		return;
	}
	const tokens = tokensOf(text);
	const issues = await brokenPaths(file, text, root);
	const lines = text.split(/\r?\n/).length;
	if (lines > 300) {
		issues.push({ severity: 'info', message: `${lines} lines: costs about ${tokens.toLocaleString()} tokens in every session` });
	}
	items.push({ kind: 'instructions', scope, label: show(root, file), detail: where, file, tokens: scope === 'directory' ? undefined : tokens, onDemand: scope === 'directory' ? tokens : undefined, issues, agents });
}

interface HookEntry { matcher?: string; hooks?: { type?: string; command?: string }[] }
interface Settings {
	hooks?: Record<string, HookEntry[]>;
	permissions?: { allow?: string[]; ask?: string[]; deny?: string[]; defaultMode?: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Valid JSON of the wrong shape (`"allow": "Bash"`, `"hooks": []`) must not break the scan of every other file. */
function settingsShape(raw: unknown): Settings {
	if (!isObject(raw)) {
		return {};
	}
	const hooks: Record<string, HookEntry[]> = {};
	for (const [event, entries] of Object.entries(isObject(raw.hooks) ? raw.hooks : {})) {
		hooks[event] = (Array.isArray(entries) ? entries : []).filter(isObject).map(e => ({
			matcher: typeof e.matcher === 'string' ? e.matcher : undefined,
			hooks: (Array.isArray(e.hooks) ? e.hooks : []).filter(isObject).map(h => ({ type: typeof h.type === 'string' ? h.type : undefined, command: typeof h.command === 'string' ? h.command : undefined })),
		}));
	}
	const perms = isObject(raw.permissions) ? raw.permissions : {};
	return {
		hooks,
		permissions: { allow: strings(perms.allow), ask: strings(perms.ask), deny: strings(perms.deny), defaultMode: typeof perms.defaultMode === 'string' ? perms.defaultMode : undefined },
	};
}

async function settingsFile(items: HarnessItem[], root: string, file: string, scope: Scope) {
	const text = await read(file);
	if (text === undefined) {
		return;
	}
	let s: Settings;
	try {
		s = settingsShape(JSON.parse(text));
	} catch (e) {
		items.push({ kind: 'hooks', scope, label: show(root, file), detail: 'Not valid JSON: the agent ignores this file', file, issues: [{ severity: 'error', message: `Invalid JSON: ${(e as Error).message}` }], agents: ['Claude'] });
		return;
	}
	const lines = text.split(/\r?\n/);
	const lineOf = (needle: string) => Math.max(0, lines.findIndex(l => l.includes(needle)));
	// Two hooks may run the same command: each takes the next line that holds it, in file order (the order JSON.parse
	// gives too), so a finding about the second one lands on the second one.
	const taken = new Map<string, number>();
	const nextLineOf = (needle: string) => {
		const i = lines.findIndex((l, n) => n > (taken.get(needle) ?? -1) && l.includes(needle));
		if (i >= 0) {
			taken.set(needle, i);
		}
		return i >= 0 ? i : lineOf(needle);
	};
	for (const [event, entries] of Object.entries(s.hooks ?? {})) {
		for (const entry of entries) {
			for (const h of entry.hooks ?? []) {
				if (!h.command) {
					continue;
				}
				const issues: Issue[] = [];
				// A script the hook runs must exist, or every matching tool call fails the hook.
				const script = /(?:bash|sh|node|python3?)\s+["']?(?<p>[^\s"']+\.(?:sh|js|mjs|py))/.exec(h.command)?.groups?.p
					?? /^["']?(?<p>[^\s"']+\.(?:sh|js|mjs|py))/.exec(h.command.trim())?.groups?.p;
				if (script) {
					const resolved = script
						.replace(/\$\{CLAUDE_PROJECT_DIR(?::-[^}]*)?\}|\$CLAUDE_PROJECT_DIR\b|%CLAUDE_PROJECT_DIR%/gi, () => root)
						.replace(/\$\{HOME\}|\$HOME\b|%USERPROFILE%/gi, () => home)
						.replace(/^~(?=[\\/]|$)/, () => home);
					// Whatever is still a variable (${CLAUDE_PLUGIN_ROOT}, say) is only known to Claude Code: no verdict, no penalty.
					if (!/[$%]/.test(resolved) && !await exists(path.resolve(root, resolved))) {
						issues.push({ severity: 'error', message: `Script ${script} does not exist`, line: lineOf(script) });
					}
				}
				// Inline shell gets a readable name from the variable it checks or the first program it runs.
				const inlineVar = /\$\{?(?<v>[A-Z][A-Z0-9_]{3,})/.exec(h.command)?.groups?.v;
				const name = script ? path.basename(script)
					: h.command.trim().startsWith('[') || h.command.includes(';') ? `inline script${inlineVar ? ` (${inlineVar})` : ''}`
						: h.command.split(/\s+/).slice(0, 2).map(t => path.basename(t)).join(' ');
				items.push({
					kind: 'hooks', scope, label: name,
					detail: `${event}${entry.matcher ? ` · ${entry.matcher}` : ''}`,
					file, issues, agents: ['Claude'],
					hook: { event, matcher: entry.matcher, command: h.command, settingsFile: file },
					line: nextLineOf(JSON.stringify(h.command).slice(1, 61)),
				});
			}
		}
	}
	for (const effect of ['allow', 'ask', 'deny'] as const) {
		for (const pattern of s.permissions?.[effect] ?? []) {
			items.push({ kind: 'permissions', scope, label: pattern, detail: effect, file, issues: [], agents: ['Claude'], rule: { effect, pattern }, line: lineOf(JSON.stringify(pattern)) });
		}
	}
}

async function skillsIn(items: HarnessItem[], dir: string, scope: Scope, agents: string[]) {
	for (const d of await listDir(dir)) {
		const file = path.join(d, 'SKILL.md');
		const text = await read(file);
		if (text === undefined) {
			continue;
		}
		const fm = frontMatter(text);
		const issues: Issue[] = [];
		if (!fm.description) {
			issues.push({ severity: 'warning', message: 'No description: the agent cannot tell when to use this skill', line: 0 });
		}
		// Only name + description sit in context until the skill is used.
		const listed = tokensOf(`${fm.name ?? ''} ${fm.description ?? ''}`);
		items.push({ kind: 'skills', scope, label: fm.name || path.basename(d), detail: fm.description ?? '', file, tokens: listed, onDemand: Math.max(0, tokensOf(text) - listed), issues, agents });
	}
}

async function agentsIn(items: HarnessItem[], dir: string, scope: Scope) {
	for (const file of (await listDir(dir)).filter(f => f.endsWith('.md'))) {
		const text = await read(file) ?? '';
		const fm = frontMatter(text);
		const listed = tokensOf(`${fm.name ?? ''} ${fm.description ?? ''}`);
		// The body is the subagent's own prompt: it fills the subagent's window when spawned, not the main one.
		items.push({ kind: 'agents', scope, label: fm.name || path.basename(file, '.md'), detail: fm.description ?? '', file, tokens: listed, onDemand: Math.max(0, tokensOf(text) - listed), issues: [], agents: ['Claude'] });
	}
}

async function rulesIn(items: HarnessItem[], root: string, dir: string, scope: Scope, agents: string[], globKey: string) {
	const walk = async (d: string): Promise<string[]> => (await Promise.all((await listDir(d)).map(async p => (await fs.stat(p).catch(() => undefined))?.isDirectory() ? walk(p) : [p]))).flat();
	for (const file of (await walk(dir)).filter(f => /\.mdc?$/.test(f))) {
		const text = await read(file) ?? '';
		const fm = frontMatter(text);
		const always = fm.alwaysApply === 'true' || !fm[globKey];
		items.push({ kind: 'rules', scope, label: path.relative(dir, file), detail: always ? 'Every file' : `Files matching ${fm[globKey]}`, file, tokens: always ? tokensOf(text) : undefined, onDemand: always ? undefined : tokensOf(text), issues: await brokenPaths(file, text, root), agents, paths: always ? [] : globList(fm[globKey]) });
	}
}

/**
 * Every MCP server either agent loads here (mcpconfig.ts reads the same files the MCP manager edits): user and local
 * servers in .claude.json, the project's .mcp.json, plugin and managed ones, and Codex's config.toml files.
 */
async function mcpServers(items: HarnessItem[], root: string) {
	const config = await readMcp({
		root, home, platform: process.platform, claudeDir: claudeDir(), codexDir: codexDir(), claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || undefined,
		read, list: d => fs.readdir(d).catch(() => [] as string[]),
	});
	const scopeOf = (s: McpServer): Scope => s.scope === 'local' || s.scope === 'project' ? s.scope : 'user';
	for (const s of config.servers) {
		const target = s.transport === 'stdio' ? [s.command ?? '', ...maskArgs(s.args)].join(' ') : maskUrl(s.url ?? '');
		const state = s.state === 'off' ? 'off' : s.state === 'pending' ? 'awaiting approval' : '';
		items.push({
			kind: 'mcp', scope: scopeOf(s), label: s.name,
			detail: [s.scope === 'user' || s.scope === 'local' || s.scope === 'project' ? '' : s.scope, s.transport, target, state].filter(Boolean).join(' · '),
			file: s.file, issues: s.issues.map(i => ({ ...i })), agents: [s.harness],
			mcp: { id: s.id, toolPrefix: s.toolPrefix, state: s.state, transport: s.transport },
		});
	}
	for (const p of config.problems) {
		items.push({ kind: 'mcp', scope: p.file.startsWith(root) ? 'project' : 'user', label: show(root, p.file), detail: 'Not readable: the agent ignores its MCP servers', file: p.file, issues: [{ severity: 'error', message: p.message }], agents: [p.file.endsWith('.toml') ? 'Codex' : 'Claude'] });
	}
}

/** Same rule allowed in one place and denied in another: the stricter one wins, which surprises people. */
function conflicts(items: HarnessItem[]) {
	const rules = items.filter(i => i.rule);
	for (const r of rules) {
		const clash = rules.find(o => o !== r && o.rule!.pattern === r.rule!.pattern && o.rule!.effect !== r.rule!.effect);
		if (clash && r.rule!.effect === 'allow') {
			r.issues.push({ severity: 'warning', message: `Also "${clash.rule!.effect}" in ${clash.scope} settings, which wins` });
		}
	}
	const seen = new Map<string, HarnessItem>();
	for (const s of items.filter(i => i.kind === 'skills')) {
		const first = seen.get(s.label);
		if (first && first.scope !== s.scope && first.agents.join() === s.agents.join()) {
			s.issues.push({ severity: 'info', message: `Same name as a ${first.scope} skill; one shadows the other` });
		}
		seen.set(s.label, s);
	}
}

/** Which lint rules apply to an item's file. */
function lintKind(i: HarnessItem): InstructionKind | undefined {
	const base = path.basename(i.file).toLowerCase();
	if (i.kind === 'instructions') {
		return base === 'agents.md' ? 'agents-md' : base === 'copilot-instructions.md' ? 'copilot' : 'claude-md';
	}
	if (i.kind === 'rules') {
		return i.agents.includes('Cursor') ? 'cursor-rule' : 'claude-rule';
	}
	return i.kind === 'skills' ? 'skill' : i.kind === 'agents' ? 'agent' : undefined;
}

/** The harness lint (lint.ts) over what the scan found; each finding becomes an issue on the item whose file (and line) it names. */
async function lintItems(items: HarnessItem[], root: string, folder: vscode.WorkspaceFolder) {
	const seen = new Set<string>();
	const files: LintFile[] = [];
	for (const i of items) {
		const kind = lintKind(i);
		if (kind && !seen.has(i.file)) {
			seen.add(i.file);
			files.push({ file: i.file, label: show(root, i.file), kind, text: await read(i.file) ?? '' });
		}
	}
	// Listing the project is only worth it when some rule is scoped to globs.
	const scoped = files.some(f => (f.kind === 'claude-rule' || f.kind === 'cursor-rule') && ruleGlobs(f).length);
	const limit = 20_000;
	// This folder's files only: a rule's globs are relative to the folder that holds it.
	const listed = scoped ? await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '{**/node_modules/**,**/.git/**,**/.claude/worktrees/**,**/.insilode/worktrees/**,**/.axle/worktrees/**}', limit) : [];
	const findings = lint({
		files,
		hooks: items.filter(i => i.hook).map(i => ({ ...i.hook!, line: i.line ?? 0 })),
		rules: items.filter(i => i.rule).map(i => ({ ...i.rule!, scope: i.scope === 'directory' ? 'project' : i.scope, file: i.file, line: i.line ?? 0 })),
		projectFiles: scoped ? listed.map(u => path.relative(root, u.fsPath).split(path.sep).join('/')) : undefined,
		projectFilesTruncated: listed.length >= limit,
		cwd: root, home,
	});
	for (const f of findings) {
		const here = items.filter(i => i.file === f.file);
		const item = here.find(i => i.line === f.line) ?? here[0];
		item?.issues.push({ severity: f.severity, message: f.message, line: f.line, fix: f.fix });
	}
}

/** Where Claude Code keeps its auto memory for a folder. */
export const claudeMemoryDir = (root: string) => path.join(claudeDir(), 'projects', projectKey(root), 'memory');

/**
 * The agents' own memory for this folder, read only: Claude Code's MEMORY.md (loaded in every session) and its topic files
 * (read when recalled), and Codex's ~/.codex/memories when there is one.
 */
async function memoryIn(items: HarnessItem[], root: string) {
	const dir = claudeMemoryDir(root);
	const indexFile = path.join(dir, 'MEMORY.md');
	const indexText = await read(indexFile);
	const index = indexText === undefined ? [] : parseIndex(indexText);
	if (indexText !== undefined) {
		const issues: Issue[] = index.filter(e => !/^https?:/.test(e.target)).map(e => ({ e, file: path.join(dir, e.target) }))
			.filter(x => !existsSyncSafe(x.file)).map(({ e }) => ({ severity: 'warning' as const, message: `Points at ${e.target}, which does not exist`, line: e.line, fix: 'Delete the line, or restore the file' }));
		items.push({ kind: 'memory', scope: 'user', label: 'MEMORY.md', detail: `Claude's memory index for this folder: ${index.length} entr${index.length === 1 ? 'y' : 'ies'}, loaded in every session`, file: indexFile, tokens: tokensOf(indexText), issues, agents: ['Claude'] });
	}
	for (const file of (await listDir(dir)).filter(f => /\.md$/i.test(f) && path.basename(f) !== 'MEMORY.md')) {
		const text = await read(file);
		if (text === undefined) {
			continue;
		}
		const st = await fs.stat(file).catch(() => undefined);
		const m = parseMemory(file, text);
		const entry = index.find(e => path.basename(e.target) === path.basename(file));
		m.indexLine = entry?.line;
		m.modified ??= st?.mtimeMs;
		const issues: Issue[] = entry || indexText === undefined ? [] : [{ severity: 'info', message: 'Not in MEMORY.md: Claude does not know it is there unless it lists the folder', fix: 'Add a line for it to MEMORY.md, or delete it' }];
		items.push({ kind: 'memory', scope: 'user', label: m.name, detail: [m.type ?? 'memory', m.description].filter(Boolean).join(' · '), file, onDemand: tokensOf(text), issues, agents: ['Claude'], memory: m });
	}
	const codex = path.join(codexDir(), 'memories');
	for (const file of (await listDir(codex)).filter(f => /\.(md|txt|json)$/i.test(f))) {
		const text = await read(file);
		if (text !== undefined) {
			const m = parseMemory(file, text);
			m.modified ??= (await fs.stat(file).catch(() => undefined))?.mtimeMs;
			items.push({ kind: 'memory', scope: 'user', label: m.name, detail: ['Codex', m.type, m.description].filter(Boolean).join(' · '), file, onDemand: tokensOf(text), issues: [], agents: ['Codex'], memory: m });
		}
	}
}

const existsSyncSafe = (p: string) => {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
};

/** Most nested CLAUDE.md / AGENTS.md files listed per folder: a monorepo can hold thousands, and the search stops here. */
const MAX_NESTED = 200;
const NESTED_EXCLUDE = '{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**,**/.claude/worktrees/**,**/.insilode/worktrees/**,**/.axle/worktrees/**}';

/**
 * What one workspace folder contributes. The user's own files (home folder) belong to no folder: `first` reads them once,
 * with the first folder, so a workspace of three folders does not list them three times.
 */
async function scanFolder(items: HarnessItem[], folder: vscode.WorkspaceFolder, first: boolean): Promise<string[]> {
	const root = folder.uri.fsPath;
	const notes: string[] = [];

	// Instructions: user, then project, then nested folders (more specific wins).
	if (first) {
		await memoryFile(items, root, path.join(claudeDir(), 'CLAUDE.md'), 'user', ['Claude'], 'Your instructions, every project');
		await memoryFile(items, root, path.join(codexDir(), 'AGENTS.md'), 'user', ['Codex'], 'Your instructions, every project');
	}
	await memoryFile(items, root, path.join(root, 'CLAUDE.md'), 'project', ['Claude'], 'Loaded in every session');
	await memoryFile(items, root, path.join(root, 'CLAUDE.local.md'), 'local', ['Claude'], 'Yours only, not committed');
	await memoryFile(items, root, path.join(root, 'AGENTS.md'), 'project', ['Codex', 'Cursor'], 'Loaded in every session');
	await memoryFile(items, root, path.join(root, '.github', 'copilot-instructions.md'), 'project', ['Copilot'], 'Copilot reads it in every chat');
	const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/{CLAUDE,AGENTS}.md'), NESTED_EXCLUDE, MAX_NESTED);
	// Git answers with the paths as it was given them.
	const ignored = await gitIgnoredOf(root, found.map(u => u.fsPath));
	const nested = found.filter(u => !ignored.has(u.fsPath));
	for (const uri of nested) {
		if (path.dirname(uri.fsPath) !== root) {
			await memoryFile(items, root, uri.fsPath, 'directory', path.basename(uri.fsPath) === 'CLAUDE.md' ? ['Claude'] : ['Codex', 'Cursor'], `When working under ${path.relative(root, path.dirname(uri.fsPath))}/`);
		}
	}
	if (found.length >= MAX_NESTED) {
		// The search stopped at its limit, so files past it are not listed: say so where the list is, never silently.
		const message = `Insilode listed the first ${MAX_NESTED} CLAUDE.md and AGENTS.md files in ${folder.name}; there may be more, and they are not checked or counted.`;
		notes.push(message);
		items.push({ kind: 'instructions', scope: 'directory', label: `More than ${MAX_NESTED} CLAUDE.md / AGENTS.md files`, detail: 'Only the first ones are listed', file: found[0].fsPath, issues: [{ severity: 'info', message, fix: 'Ignore build output and vendored folders in .gitignore, or open the part of the repository you work in as its own folder' }], agents: [] });
	}

	await rulesIn(items, root, path.join(root, '.claude', 'rules'), 'project', ['Claude'], 'paths');
	if (first) {
		await rulesIn(items, root, path.join(claudeDir(), 'rules'), 'user', ['Claude'], 'paths');
	}
	await rulesIn(items, root, path.join(root, '.cursor', 'rules'), 'project', ['Cursor'], 'globs');

	await skillsIn(items, path.join(root, '.claude', 'skills'), 'project', ['Claude']);
	await skillsIn(items, path.join(root, '.agents', 'skills'), 'project', ['Codex']);
	await skillsIn(items, path.join(root, '.cursor', 'skills'), 'project', ['Cursor']);
	if (first) {
		await skillsIn(items, path.join(claudeDir(), 'skills'), 'user', ['Claude']);
	}

	await agentsIn(items, path.join(root, '.claude', 'agents'), 'project');
	if (first) {
		await agentsIn(items, path.join(claudeDir(), 'agents'), 'user');
	}

	await memoryIn(items, root);

	if (first) {
		await settingsFile(items, root, path.join(claudeDir(), 'settings.json'), 'user');
	}
	await settingsFile(items, root, path.join(root, '.claude', 'settings.json'), 'project');
	await settingsFile(items, root, path.join(root, '.claude', 'settings.local.json'), 'local');
	await mcpServers(items, root);
	return notes;
}

/** What makes an item the same one found twice: the user's Codex memories and MCP servers are read again with every folder. */
const sameItem = (i: HarnessItem) => JSON.stringify([i.kind, i.scope, i.file, i.label, i.detail, i.line ?? null, i.mcp?.id ?? null]);

export async function scan(): Promise<Harness | undefined> {
	somewhere.clear();
	// Every folder of the workspace: a multi-root workspace has a harness in each.
	const folders = vscode.workspace.workspaceFolders ?? [];
	if (!folders.length) {
		return undefined;
	}
	const root = folders[0].uri.fsPath;
	const items: HarnessItem[] = [];
	const notes: string[] = [];
	for (const [n, folder] of folders.entries()) {
		const batch: HarnessItem[] = [];
		notes.push(...await scanFolder(batch, folder, n === 0));
		const known = new Set(items.map(sameItem));
		const mine = batch.filter(i => !known.has(sameItem(i)));
		if (n > 0) {
			// Two folders both have a CLAUDE.md: the label says whose.
			mine.forEach(i => (i.label = `${folder.name}: ${i.label}`));
		}
		await lintItems(mine, folder.uri.fsPath, folder);
		items.push(...mine);
	}

	conflicts(items);

	const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
	items.forEach(i => i.issues.forEach(x => counts[x.severity]++));
	const gaps = projectGaps(items);
	const score = Math.max(0, 100 - counts.error * 12 - counts.warning * 4 - counts.info - gaps.reduce((a, g) => a + g.cost, 0));
	const claudeStartup = items.filter(i => i.agents.includes('Claude') && i.tokens && (i.kind === 'instructions' || i.kind === 'skills' || i.kind === 'agents' || i.kind === 'rules' || i.kind === 'memory'));
	return { root, items, score, counts, gaps, startupTokens: claudeStartup.reduce((a, i) => a + (i.tokens ?? 0), 0), ...(notes.length ? { notes } : {}) };
}
