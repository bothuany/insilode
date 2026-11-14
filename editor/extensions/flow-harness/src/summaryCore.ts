/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the plain-JSON summary of one folder's harness that `flowHarness.summary` answers (summary.ts), for the Agents page's
 *  Harness panel. Built from the scan's own result (scanCore.ts), so it says what the map says. Pure: no `vscode`, no fs, tested on its own.
 *
 *  The summary is data for another extension, which copies these types (extensions never import each other's source): keep it small, capped
 *  in every list and every string, and free of what must not leave. It carries file names, paths and line numbers, the names of skills, subagents,
 *  commands and servers, the `description` and `paths:` lines of the instruction files as the lists show them (cut), and the commands, permission rules and
 *  server lines of the settings, each redacted (redact.ts). It carries no other text of a file: a finding is a fixed sentence for its check (`SAYS`), never a
 *  quotation, so a line of a CLAUDE.md or a frontmatter value is not in it. The absolute `file` paths are there so the panel can ask the host to open a file
 *  the summary named; they are locations, not contents, and never one whose real path lies outside the folder (`unsafe`).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { FoundLine } from './harnessLint';
import { redact } from './redact';
import type { Harness, HarnessItem, Scope, Severity } from './scanCore';

/** The most each list carries and the longest each string is. Past a cap the list says how many more there were (`notes`). */
export const CAPS = { instructions: 60, hooks: 60, rules: 100, mcp: 40, names: 100, findings: 100, command: 160, message: 240, name: 80, where: 160, path: 1024 };

export interface SummaryFile {
	/** The file as the panel shows it: relative to the folder, or `~/…` for the user's own. */
	where: string;
	/** Its absolute path, for the panel to ask the host to open it. */
	file: string;
}

export interface SummaryInstruction extends SummaryFile {
	name: string;
	kind: 'instructions' | 'rules';
	scope: Scope;
	/** What it is for: "Loaded in every session", "Files matching src/**". */
	detail: string;
	/** An estimate of what it costs in context: about a quarter of its characters. Undefined for a file read only when it applies. */
	tokens?: number;
}

export interface SummaryHook extends SummaryFile {
	event: string;
	matcher?: string;
	/** The command line, redacted and cut. */
	command: string;
	scope: Scope;
	/** 1-based line in the settings file. */
	line?: number;
}

export interface SummaryRule extends SummaryFile {
	/** The rule, redacted and cut. */
	pattern: string;
	scope: Scope;
}

export interface SummaryPermissions {
	/** `permissions.defaultMode` of the first settings file that sets it (local, then project, then the user's). */
	mode?: string;
	modeWhere?: string;
	/** How many rules each list has in all; the lists below hold at most CAPS.rules. */
	counts: { allow: number; ask: number; deny: number };
	allow: SummaryRule[];
	ask: SummaryRule[];
	deny: SummaryRule[];
}

export interface SummaryMcp extends SummaryFile {
	name: string;
	transport: string;
	scope: Scope;
	state: 'on' | 'off' | 'pending';
	/** The command line or URL with credentials hidden. */
	target: string;
}

export interface SummaryNamed {
	name: string;
	scope: Scope;
	/** Absent for a slash command, whose file is not part of the scan. */
	file?: string;
	where?: string;
}

export interface SummaryNames {
	/** How many there are in all; `items` holds at most CAPS.names. */
	count: number;
	items: SummaryNamed[];
}

export interface SummaryFinding extends SummaryFile {
	severity: Severity;
	/** The sentence for its check (`SAYS`), never a quotation of the file. */
	message: string;
	/** 1-based, as the CLI prints it. */
	line: number;
	/** The lint's stable id of the check ("missing-script"). */
	code: string;
}

export interface HarnessSummary {
	/** The folder this is the harness of. */
	root: string;
	/** The map's health score, 0 to 100. */
	score: number;
	/** What loads into every new session, in tokens (an estimate). */
	startupTokens: number;
	instructions: SummaryInstruction[];
	hooks: SummaryHook[];
	permissions: SummaryPermissions;
	mcp: SummaryMcp[];
	skills: SummaryNames;
	agents: SummaryNames;
	commands: SummaryNames;
	/** The findings `npm run harness:lint` prints for the folder, errors first (each severity in the CLI's order: by file, then line). */
	findings: SummaryFinding[];
	/** How many findings there are in all, by severity. */
	counts: Record<Severity, number>;
	/** What was cut or could not be done: lists past their cap, a scan that ran out of time. */
	notes: string[];
}

/** What each check of the lint says in a summary. The lint's own messages quote the file they are about (a line, a glob, a name): the CLI prints them, a summary of a folder nobody trusted does not. */
const SAYS: Record<string, string> = {
	'bad-frontmatter': 'The frontmatter does not parse as YAML',
	'bad-name': 'The skill name is not lowercase letters, digits and hyphens',
	'broken-import': 'An import points at a file that does not exist',
	'broken-path': 'A path named here does not exist',
	'contradiction': 'This line contradicts another instruction',
	'dead-glob': 'A glob of this rule matches no file in the project',
	'dead-matcher': 'A hook matcher matches no tool Claude Code is known to have',
	'duplicate': 'This repeats another instruction, so the agent reads it twice',
	'duplicate-rule': 'This permission rule is already set elsewhere',
	'ignored-matcher': 'This hook event takes no matcher, so the matcher is ignored',
	'invalid-json': 'Not valid JSON: the agent ignores this file',
	'long-file': 'A long file: it costs many tokens in every session',
	'mcp-config': 'An MCP server is misconfigured',
	'mcp-unreadable': 'An MCP config file cannot be read: the agent ignores its servers',
	'missing-script': 'A hook runs a script that does not exist',
	'no-description': 'No description: the agent cannot tell when to use it',
	'no-frontmatter': 'No frontmatter, so no name or description',
	'outside-repo': 'A link to something outside the folder: not read',
	'overbroad': 'A permission rule allows much more than it looks',
	'path-not-checked': 'A path named here is outside the project or on the network, so it was not checked',
	'rule-conflict': 'This permission rule is also set to another effect in other settings, which wins',
	'rule-never-applies': 'A permission rule that is never consulted',
	'scan-limited': 'Part of this folder was not read or listed, so this scan may be incomplete',
	'shadowed': 'A deny or ask rule overrides this allow rule',
	'skill-shadow': 'Another skill has the same name; one shadows the other',
	'unknown-event': 'Not a hook event: this hook never runs',
	'vague-description': 'The description is too short to tell the agent when to use this',
	'wildcard-before-subcommand': 'A permission rule puts * before the subcommand',
	'wrong-key': 'This key belongs to another tool',
};
const says = (code: string): string => Object.prototype.hasOwnProperty.call(SAYS, code) ? SAYS[code] : 'A problem the harness lint found here';

export type SummaryResult = { ok: true; summary: HarnessSummary } | { ok: false; message: string };

/** What the scan does not know and the summary asks the disk for. */
export interface SummaryExtras {
	/** What `npm run harness:lint` prints for the folder (harnessLint.ts): the findings are these, from a scan that does not read the user's own files, not from the scan the lists come from. */
	lint: FoundLine[];
	mode?: { mode: string; file: string };
	commands: { name: string; scope: Scope; file: string }[];
	/** The scan stopped early (see summary.ts): said in `notes`. */
	timedOut?: boolean;
	home: string;
	/** Files that lie in the folder as written but are, once their links are followed, somewhere else: left out of every list, said once in `notes`. */
	unsafe?: ReadonlySet<string>;
}

const clip = (text: string, max: number): string => text.length > max ? text.slice(0, max - 1) + '…' : text;
const RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

/** A file as the map shows it: inside the folder relative to it, otherwise with the home folder as `~`. */
export function shownPath(root: string, file: string, home: string): string {
	const rel = path.relative(root, file);
	return clip(!rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : home && (file === home || file.startsWith(home + path.sep)) ? '~' + file.slice(home.length).split(path.sep).join('/') : file, CAPS.where);
}

export function buildSummary(harness: Harness, extras: SummaryExtras, root: string): HarnessSummary {
	const notes: string[] = [];
	const where = (file: string) => shownPath(root, file, extras.home);
	const file = (f: string) => clip(f, CAPS.path);
	const base = (i: HarnessItem): SummaryFile => ({ where: where(i.file), file: file(i.file) });
	const capped = <T>(list: T[], max: number, what: string): T[] => {
		if (list.length > max) {
			notes.push(`Showing ${max} of ${list.length} ${what}.`);
		}
		return list.slice(0, max);
	};
	const unsafe = extras.unsafe ?? new Set<string>();
	const items = harness.items.filter(i => !unsafe.has(i.file));
	const of = (kind: HarnessItem['kind']) => items.filter(i => i.kind === kind);

	// What the scan cut is said as a finding and in `notes`; the limit item itself is no instruction file.
	const instructions = capped(items.filter(i => (i.kind === 'instructions' || i.kind === 'rules') && !i.issues.some(x => x.code === 'scan-limited')).map((i): SummaryInstruction => ({
		...base(i), name: clip(i.label, CAPS.name), kind: i.kind as 'instructions' | 'rules', scope: i.scope, detail: clip(i.detail, CAPS.where),
		...(i.tokens !== undefined || i.onDemand !== undefined ? { tokens: i.tokens ?? i.onDemand } : {}),
	})), CAPS.instructions, 'instruction files');

	const hooks = capped(of('hooks').filter(i => i.hook).map((i): SummaryHook => ({
		...base(i), event: clip(i.hook!.event, CAPS.name), ...(i.hook!.matcher ? { matcher: clip(i.hook!.matcher, CAPS.name) } : {}), command: redact(i.hook!.command, CAPS.command), scope: i.scope,
		...(i.line !== undefined ? { line: i.line + 1 } : {}),
	})), CAPS.hooks, 'hooks');

	const rules = (effect: 'allow' | 'ask' | 'deny') => of('permissions').filter(i => i.rule?.effect === effect);
	const permissions: SummaryPermissions = {
		...(extras.mode ? { mode: clip(extras.mode.mode, CAPS.name), modeWhere: where(extras.mode.file) } : {}),
		counts: { allow: rules('allow').length, ask: rules('ask').length, deny: rules('deny').length },
		allow: [], ask: [], deny: [],
	};
	for (const effect of ['allow', 'ask', 'deny'] as const) {
		permissions[effect] = capped(rules(effect).map((i): SummaryRule => ({ ...base(i), pattern: redact(i.rule!.pattern, CAPS.command), scope: i.scope })), CAPS.rules, `${effect} rules`);
	}

	const mcp = capped(of('mcp').filter(i => i.mcp).map((i): SummaryMcp => ({
		...base(i), name: clip(i.label, CAPS.name), transport: clip(i.mcp!.transport, 16), scope: i.scope, state: i.mcp!.state, target: redact(i.mcp!.target ?? '', CAPS.command),
	})), CAPS.mcp, 'MCP servers');

	const names = (items: { name: string; scope: Scope; file?: string; where?: string }[], what: string): SummaryNames => ({
		count: items.length,
		items: capped(items.map(n => ({ name: clip(n.name, CAPS.name), scope: n.scope, ...(n.file ? { file: file(n.file), where: where(n.file) } : {}) })), CAPS.names, what),
	});

	const found = extras.lint.filter(l => !unsafe.has(l.abs)).map((l): SummaryFinding => ({
		where: clip(l.file, CAPS.where), file: file(l.abs), severity: l.severity, message: says(l.rule), line: l.line, code: l.rule,
	}));
	const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
	found.forEach(f => counts[f.severity]++);
	found.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

	const hidden = new Set([...harness.items.map(i => i.file), ...extras.lint.map(l => l.abs), ...extras.commands.map(c => c.file)].filter(f => unsafe.has(f))).size;
	if (hidden) {
		notes.push(`${hidden} file${hidden === 1 ? ' is a link' : 's are links'} to something outside the folder, so ${hidden === 1 ? 'it was' : 'they were'} not read or shown.`);
	}
	if (extras.timedOut) {
		notes.push('The folder is large: the search stopped after a moment, so some lists may be incomplete.');
	}
	return {
		root: clip(root, CAPS.path), score: harness.score, startupTokens: harness.startupTokens, instructions, hooks, permissions, mcp,
		skills: names(of('skills').map(i => ({ name: i.label, scope: i.scope, file: i.file })), 'skills'), agents: names(of('agents').map(i => ({ name: i.label, scope: i.scope, file: i.file })), 'subagents'), commands: names(extras.commands.filter(c => !unsafe.has(c.file)), 'slash commands'),
		findings: capped(found, CAPS.findings, 'findings'), counts, notes: notes.concat((harness.notes ?? []).map(n => clip(n, CAPS.message))).slice(0, 10),
	};
}

/** Every absolute path a summary names: the files the panel may ask to have opened. */
export function filesOf(s: HarnessSummary): string[] {
	const out = new Set<string>();
	[...s.instructions, ...s.hooks, ...s.permissions.allow, ...s.permissions.ask, ...s.permissions.deny, ...s.mcp, ...s.findings].forEach(x => out.add(x.file));
	[...s.skills.items, ...s.agents.items, ...s.commands.items].forEach(x => x.file && out.add(x.file));
	return [...out];
}
