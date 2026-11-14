/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the harness lint. Mistakes agents never report, found without an LLM: `paths:`
 *  globs that match no file, frontmatter a YAML parser rejects (Claude Code then loads the rule
 *  for every file), lines duplicated or contradicted across CLAUDE.md / AGENTS.md / rules /
 *  .cursor/rules / copilot-instructions, hooks whose event or matcher can never fire, and
 *  permission rules that are overbroad, shadowed or never consulted. Every finding names the
 *  file, the line and a fix. Pure (no vscode), so every check is tested on its own.
 *--------------------------------------------------------------------------------------------*/

import { globIsBounded, globMatcher } from './effective';
import { KNOWN_TOOLS, parseRule, ruleProblem, simulate, type Rule, type RuleScope } from './permmatch';

export type LintSeverity = 'error' | 'warning' | 'info';

export interface Finding {
	file: string;
	/** 0-based. */
	line: number;
	severity: LintSeverity;
	/** A short, stable id: dead-glob, bad-frontmatter, duplicate, contradiction, … */
	code: string;
	message: string;
	fix: string;
}

export type InstructionKind = 'claude-md' | 'agents-md' | 'copilot' | 'claude-rule' | 'cursor-rule' | 'skill' | 'agent';

export interface LintFile {
	file: string;
	/** As shown to people: relative to the project, or ~/… */
	label: string;
	kind: InstructionKind;
	text: string;
}

export interface LintHook {
	event: string;
	matcher?: string;
	command: string;
	settingsFile: string;
	/** 0-based line of the hook in its settings file. */
	line: number;
}

export interface LintInput {
	files: readonly LintFile[];
	hooks: readonly LintHook[];
	/** Every permission rule with its file; `line` is where the pattern is written. */
	rules: readonly (Rule & { line: number })[];
	/** Project files relative to the root with `/`, bounded; undefined skips the glob check. */
	projectFiles?: readonly string[];
	/** True when `projectFiles` hit its bound: a glob that matches nothing may match a file not listed. */
	projectFilesTruncated?: boolean;
	cwd: string;
	home: string;
}

// ---------------------------------------------------------------------------------------------
// Frontmatter

interface Front {
	/** Lines of the block, without the --- fences, and where the block starts (the line after the first ---). */
	lines: string[];
	start: number;
	closed: boolean;
}

/** What is read of a file for its frontmatter, of one line of it, and of a key's value: a block that goes on for ever is not a frontmatter. */
const FRONT_BYTES = 256 * 1024;
const FRONT_LINE = 4096;
const FRONT_VALUE = 4096;
/** The longest line of prose compared with the others, and the most globs one rule is checked for. */
const MAX_STATEMENT = 1000;
const MAX_GLOBS = 100;
/** The most findings of one check in one file. */
const MAX_PER_CHECK = 50;

function frontBlock(text: string): Front | undefined {
	// Only the start of the file: a frontmatter that has not closed within it is read as one that never closes.
	const lines = text.slice(0, FRONT_BYTES).split(/\r?\n/).map(l => l.length > FRONT_LINE ? l.slice(0, FRONT_LINE) : l);
	if (lines[0]?.trim() !== '---') {
		return undefined;
	}
	const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
	return { lines: lines.slice(1, end < 0 ? Math.min(lines.length, 40) : end), start: 1, closed: end > 0 };
}

/** Top-level keys of a frontmatter block with their raw value and line. */
function frontKeys(f: Front): Map<string, { value: string; line: number; list: string[] }> {
	const keys = new Map<string, { value: string; line: number; list: string[] }>();
	let last: { value: string; line: number; list: string[] } | undefined;
	// `description: >` and `|`: the value is the indented lines that follow, read as one, quoted so no check mistakes it for plain YAML.
	// The lines are collected and joined once, when the value ends: a line at a time would copy the whole value for each of them.
	let block: string[] | undefined;
	let size = 0;
	const seal = () => {
		if (last && block?.length) {
			last.value = `"${block.join(' ').slice(0, FRONT_VALUE)}"`;
		}
		block = undefined;
	};
	f.lines.forEach((l, i) => {
		const kv = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(l);
		if (kv) {
			seal();
			const value = kv[2].trim();
			const isBlock = /^[>|][+-]?\d*$/.test(value);
			block = isBlock ? [] : undefined;
			size = 0;
			last = { value: isBlock ? '' : value, line: f.start + i, list: [] };
			keys.set(kv[1], last);
		} else if (last && block && /^\s+\S/.test(l)) {
			if (size < FRONT_VALUE) {
				block.push(l.trim());
				size += l.length;
			}
		} else if (last && /^\s+-\s+/.test(l) && last.list.length < MAX_GLOBS * 5) {
			last.list.push(l.replace(/^\s+-\s+/, '').trim());
		}
	});
	seal();
	return keys;
}

/** Values a YAML parser rejects or reads as something else: an unquoted `*` (an alias), `{`/`[` that do not close, `@` and backtick (reserved), a `: ` inside a plain value. */
function badYamlValue(v: string): string | undefined {
	const s = v.trim();
	if (!s || /^(["']).*\1$/.test(s)) {
		return undefined;
	}
	if (s.startsWith('*')) {
		return 'starts with *, which YAML reads as an alias';
	}
	if (s.startsWith('&') || s.startsWith('!')) {
		return `starts with ${s[0]}, which YAML reads as an anchor or a tag`;
	}
	if (s.startsWith('@') || s.startsWith('`')) {
		return `starts with ${s[0]}, a character YAML reserves`;
	}
	if (s.startsWith('{') && !/\}\s*$/.test(s)) {
		return 'opens a { mapping that does not close';
	}
	if (s.startsWith('[') && !/\]\s*$/.test(s)) {
		return 'opens a [ list that does not close';
	}
	if (/^\{[^:]*\}$/.test(s) && /,/.test(s)) {
		return 'is a {…} that YAML reads as a mapping, not a glob';
	}
	if (/:\s/.test(s) && !/^[[{]/.test(s)) {
		return 'holds ": ", which YAML reads as a nested mapping';
	}
	return undefined;
}

function lintFrontmatter(f: LintFile, out: Finding[]) {
	const front = frontBlock(f.text);
	const isRule = f.kind === 'claude-rule' || f.kind === 'cursor-rule';
	if (!front) {
		if (f.kind === 'skill' || f.kind === 'agent') {
			out.push({ file: f.file, line: 0, severity: 'warning', code: 'no-frontmatter', message: `${f.label} has no frontmatter, so it has no name or description`, fix: 'Start the file with ---, name: and description: lines, then ---' });
		}
		return;
	}
	if (!front.closed) {
		out.push({ file: f.file, line: 0, severity: 'error', code: 'bad-frontmatter', message: `The frontmatter of ${f.label} never closes with ---: the whole file is read as text${isRule ? ', and the rule loads for every file' : ''}`, fix: 'Add a --- line after the last key' });
		return;
	}
	front.lines.forEach((l, i) => {
		const line = front.start + i;
		if (/^\t/.test(l)) {
			out.push({ file: f.file, line, severity: 'error', code: 'bad-frontmatter', message: 'A tab indents this frontmatter line; YAML allows only spaces', fix: 'Indent with spaces' });
		} else if (l.trim() && !/^\s*#/.test(l) && !/^([A-Za-z_][\w-]*)\s*:/.test(l) && !/^\s+\S/.test(l)) {
			out.push({ file: f.file, line, severity: 'error', code: 'bad-frontmatter', message: `"${l.trim().slice(0, 60)}" is not a key: value line, so the frontmatter does not parse${isRule ? ' and the rule loads for every file' : ''}`, fix: 'Write it as key: value, or indent it under the key it continues' });
		}
	});
	const keys = frontKeys(front);
	for (const [key, { value, line }] of keys) {
		const bad = badYamlValue(value);
		if (bad && (key === 'paths' || key === 'globs' || key === 'description' || key === 'name')) {
			const scoped = isRule && (key === 'paths' || key === 'globs');
			out.push({
				file: f.file, line, severity: scoped ? 'error' : 'warning', code: 'bad-frontmatter',
				message: `${key}: ${value.slice(0, 50)} ${bad}${scoped ? '; the frontmatter fails to parse and the rule loads for every file' : ''}`,
				fix: `Quote it: ${key}: "${value.replace(/"/g, '\\"')}"${scoped ? ', or write the globs as a list of quoted items' : ''}`,
			});
		}
	}
	if (f.kind === 'claude-rule' && keys.has('globs') && !keys.has('paths')) {
		out.push({ file: f.file, line: keys.get('globs')!.line, severity: 'warning', code: 'wrong-key', message: 'globs: is Cursor\'s key; Claude Code reads paths:, so this rule loads for every file', fix: 'Rename globs: to paths:' });
	}
	if (f.kind === 'cursor-rule' && keys.has('paths') && !keys.has('globs')) {
		out.push({ file: f.file, line: keys.get('paths')!.line, severity: 'warning', code: 'wrong-key', message: 'paths: is Claude Code\'s key; Cursor reads globs:', fix: 'Rename paths: to globs:' });
	}
	if (f.kind === 'skill' || f.kind === 'agent') {
		const name = keys.get('name');
		// The scan already flags a skill without a description; a subagent's is checked here.
		if (f.kind === 'agent' && !keys.get('description')?.value && !keys.get('description')?.list.length) {
			out.push({ file: f.file, line: front.start - 1, severity: 'warning', code: 'no-description', message: `${f.label} has no description: the agent cannot tell when to use it`, fix: 'Add description: with what it does and when to use it' });
		}
		if (f.kind === 'skill' && name?.value && !/^["']?[a-z0-9][a-z0-9-]{0,63}["']?$/.test(name.value)) {
			out.push({ file: f.file, line: name.line, severity: 'warning', code: 'bad-name', message: `Skill name "${name.value}" is not lowercase letters, digits and hyphens (64 at most)`, fix: 'Rename it, e.g. to the folder name in lowercase with hyphens' });
		}
		const desc = keys.get('description')?.value ?? '';
		if (desc && desc.replace(/^["']|["']$/g, '').length < 20) {
			out.push({ file: f.file, line: keys.get('description')!.line, severity: 'info', code: 'vague-description', message: `The description "${desc}" is too short to tell the agent when to use this`, fix: 'Say what it does and when to reach for it, in a sentence or two' });
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Dead globs

/** The globs a rule is scoped to, with their lines, read from `paths:` (Claude) or `globs:` (Cursor). */
export function ruleGlobs(f: LintFile): { glob: string; line: number }[] {
	const front = frontBlock(f.text);
	if (!front?.closed) {
		return [];
	}
	const key = f.kind === 'cursor-rule' ? 'globs' : 'paths';
	const entry = frontKeys(front).get(key);
	if (!entry) {
		return [];
	}
	const inline = entry.value.replace(/^\[|\]$/g, '');
	const parts: string[] = [];
	let cur = '';
	let depth = 0;
	for (const c of inline) {
		depth += c === '{' ? 1 : c === '}' ? -1 : 0;
		if (c === ',' && depth <= 0) {
			parts.push(cur);
			cur = '';
		} else {
			cur += c;
		}
	}
	parts.push(cur);
	return [...parts, ...entry.list].map(g => g.trim().replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean).slice(0, MAX_GLOBS).map(glob => ({ glob, line: entry.line }));
}

/** How long all the glob checks of one lint run may take together, and the longest path they look at: rules are the text of files, and 500 rules of 100 globs against 20 000 files is a billion matches. */
const GLOB_MS = 500;
const MAX_PATH = 400;

function lintGlobs(f: LintFile, input: LintInput, out: Finding[], until: number, longPaths: boolean) {
	if (!input.projectFiles || (f.kind !== 'claude-rule' && f.kind !== 'cursor-rule')) {
		return;
	}
	for (const { glob, line } of ruleGlobs(f)) {
		// No verdict, so no finding, for a glob that is too elaborate to match safely, a listing with paths too long to look at, or a check that ran out of time.
		if (!globIsBounded(glob) || longPaths) {
			continue;
		}
		const match = globMatcher(glob);
		let found = false;
		let n = 0;
		for (const p of input.projectFiles) {
			if (found = match(p)) {
				break;
			}
			if (++n % 256 === 0 && Date.now() > until) {
				break;
			}
		}
		if (n < input.projectFiles.length && !found) {
			continue;
		}
		if (!found) {
			out.push({
				file: f.file, line, severity: input.projectFilesTruncated ? 'info' : 'warning', code: 'dead-glob',
				message: `${glob} matches no file in the project${input.projectFilesTruncated ? ' among the files Insilode listed' : ''}: the rule never loads`,
				fix: 'Point the glob at the folder you meant (globs are relative to the project root), or delete the rule',
			});
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Duplicates and contradictions

const NEGATION = /\b(?:do\s+not|don'?t|does\s+not|doesn'?t|never|must\s+not|mustn'?t|should\s+not|shouldn'?t|avoid|no\s+longer)\b|(?:^|\s)(?:asla|hiçbir\s+zaman)(?=\s|$)|\S+(?:ma|me)(?=\s*[.,!]?\s*$)/i;
const POLARITY_WORDS = new Set(['not', 'never', 'avoid', 'always', 'must', 'should', 'do', 'does', 'don\'t', 'dont', 'please', 'asla', 'daima', 'her', 'zaman']);
const STOP = new Set('the a an to of and or in on for with is are be it this that you your we our i all any when if by as at from'.split(' '));

/** A line's words without bullets, markup, case or punctuation; empty for lines too short or too generic to compare. */
function words(line: string): string[] {
	// "don't", "do not" and "never" are one word here, so the apostrophe cannot split them into "don" and "t".
	return line.toLowerCase().replace(/[’‘]/g, '\'').replace(/\b(?:do\s+not|don'?t|does\s+not|doesn'?t|never|must\s+not|mustn'?t|should\s+not|shouldn'?t)\b/g, ' not ')
		.replace(/[`*_>#()[\]{}"'“”.,;:!?]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w));
}

interface Statement {
	file: LintFile;
	line: number;
	text: string;
	norm: string;
	key: string;
	negative: boolean;
}

/** Instruction lines worth comparing: prose bullets and sentences outside code fences and frontmatter, of a useful length. */
function statements(f: LintFile): Statement[] {
	const out: Statement[] = [];
	const lines = f.text.split(/\r?\n/);
	let fence = false;
	const front = frontBlock(f.text);
	const skipTo = front?.closed ? front.start + front.lines.length + 1 : 0;
	lines.forEach((raw, i) => {
		if (/^\s*```/.test(raw)) {
			fence = !fence;
			return;
		}
		if (fence || i < skipTo || /^\s*#/.test(raw) || /^\s*\|/.test(raw) || /^\s*</.test(raw)) {
			return;
		}
		// A line longer than a sentence is not prose to compare (and the patterns below are not meant for a line of a million characters).
		const text = raw.slice(0, MAX_STATEMENT).trim().replace(/^[-*+]\s+|^\d+\.\s+/, '');
		const w = words(text);
		if (text.length < 25 || w.length < 4) {
			return;
		}
		const negative = NEGATION.test(text);
		const key = w.map(x => x.replace(/^(?:don'?t|never|avoid)$/, 'not')).filter(x => !POLARITY_WORDS.has(x) && x !== 'not').sort().join(' ');
		out.push({ file: f, line: i, text, norm: w.join(' '), key, negative });
	});
	return out;
}

const instructionKinds = new Set<InstructionKind>(['claude-md', 'agents-md', 'copilot', 'claude-rule', 'cursor-rule']);

/** Adds to a group of a map in place: copying the group for every addition costs the square of its size. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
	const list = map.get(key);
	if (list) {
		list.push(value);
	} else {
		map.set(key, [value]);
	}
}

function lintOverlap(input: LintInput, out: Finding[]) {
	const all = input.files.filter(f => instructionKinds.has(f.kind)).flatMap(statements);
	const byNorm = new Map<string, Statement[]>();
	for (const s of all) {
		push(byNorm, s.norm, s);
	}
	const pairs = new Map<string, { here: Statement; there: Statement }[]>();
	for (const group of byNorm.values()) {
		if (group.length < 2) {
			continue;
		}
		const [first, ...rest] = group;
		for (const s of rest) {
			if (s.file.file === first.file.file) {
				out.push({ file: s.file.file, line: s.line, severity: 'warning', code: 'duplicate', message: `Said twice in ${s.file.label} (also line ${first.line + 1})`, fix: 'Delete one of them' });
			} else {
				const key = `${s.file.file}\n${first.file.file}`;
				push(pairs, key, { here: s, there: first });
			}
		}
	}
	// One finding per pair of files, so a file that mirrors another (AGENTS.md copied from CLAUDE.md) is one item, not dozens.
	for (const list of pairs.values()) {
		const { here, there } = list[0];
		// The same line in two tools' files is often on purpose (each tool reads only its own); say so gently.
		const crossTool = toolOf(here.file.kind) !== toolOf(there.file.kind);
		const where = list.length === 1 ? `${there.file.label}:${there.line + 1}` : `${there.file.label} (lines ${list.slice(0, 5).map(x => x.there.line + 1).join(', ')}${list.length > 5 ? ', …' : ''})`;
		out.push({
			file: here.file.file, line: here.line, severity: crossTool ? 'info' : 'warning', code: 'duplicate',
			message: `${list.length === 1 ? 'Also' : `${list.length} lines here are also`} in ${where}${crossTool ? ' (another tool reads that file, so this may be on purpose)' : ''}: the agent reads ${list.length === 1 ? 'it' : 'them'} twice`,
			fix: crossTool ? 'Keep them in one file and import it from the other (Claude: @AGENTS.md), so the two cannot drift' : 'Keep each line in the more specific file and delete it here',
		});
	}
	const byKey = new Map<string, Statement[]>();
	for (const s of all.filter(x => x.key.split(' ').length >= 2)) {
		push(byKey, s.key, s);
	}
	for (const group of byKey.values()) {
		const pos = group.find(s => !s.negative);
		const neg = group.find(s => s.negative);
		if (pos && neg && pos.norm !== neg.norm) {
			out.push({
				file: neg.file.file, line: neg.line, severity: 'warning', code: 'contradiction',
				message: `Contradicts ${pos.file.label}:${pos.line + 1} ("${pos.text.slice(0, 60)}"): the agent gets both`,
				fix: 'Decide which one holds, delete the other, and say when the exception applies if there is one',
			});
		}
	}
}

const toolOf = (k: InstructionKind) => k === 'agents-md' ? 'codex' : k === 'copilot' ? 'copilot' : k === 'cursor-rule' ? 'cursor' : 'claude';

// ---------------------------------------------------------------------------------------------
// Hooks

/** Claude Code's hook events (code.claude.com/docs/en/hooks). */
export const HOOK_EVENTS = new Set(['SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreToolUse', 'PermissionRequest', 'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch',
	'Notification', 'MessageDisplay', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange', 'CwdChanged',
	'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch', 'Elicitation', 'ElicitationResult', 'SessionEnd']);
/** Events whose matcher is a tool name. */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);
/** Events that take no matcher: one written there is ignored. */
const NO_MATCHER = new Set(['UserPromptSubmit', 'UserPromptExpansion', 'Stop', 'TeammateIdle', 'TaskCreated', 'TaskCompleted', 'WorktreeCreate', 'WorktreeRemove', 'CwdChanged', 'PostToolBatch']);

function lintHooks(input: LintInput, out: Finding[]) {
	for (const h of input.hooks) {
		const at = { file: h.settingsFile, line: h.line };
		if (!HOOK_EVENTS.has(h.event)) {
			const near = [...HOOK_EVENTS].find(e => e.toLowerCase() === h.event.toLowerCase());
			out.push({ ...at, severity: 'error', code: 'unknown-event', message: `"${h.event}" is not a hook event: this hook never runs`, fix: near ? `Write it as ${near}` : 'Use one of the documented events, such as PreToolUse, PostToolUse or Stop' });
			continue;
		}
		const m = (h.matcher ?? '').trim();
		if (!m || m === '*') {
			continue;
		}
		if (NO_MATCHER.has(h.event)) {
			out.push({ ...at, severity: 'info', code: 'ignored-matcher', message: `${h.event} takes no matcher: "${m}" is ignored and the hook runs every time`, fix: 'Remove the matcher, or check the input inside the hook' });
			continue;
		}
		if (!TOOL_EVENTS.has(h.event)) {
			continue;
		}
		if (/^[\w\- ,|]+$/.test(m)) {
			for (const name of m.split(/[|,]/).map(s => s.trim()).filter(Boolean)) {
				if (KNOWN_TOOLS.includes(name) || name.startsWith('mcp__')) {
					continue;
				}
				const near = KNOWN_TOOLS.find(t => t.toLowerCase() === name.toLowerCase());
				out.push({
					...at, severity: near ? 'error' : 'info', code: 'dead-matcher',
					message: near ? `Matcher "${name}" never matches: tool names are case-sensitive` : `"${name}" is not a tool Claude Code is known to have; this part of the matcher may never match`,
					fix: near ? `Write it as ${near}` : 'Check the tool\'s exact name (MCP tools are mcp__<server>__<tool>)',
				});
			}
			continue;
		}
		let re: RegExp | undefined;
		try {
			re = new RegExp(m);
		} catch (e) {
			out.push({ ...at, severity: 'error', code: 'dead-matcher', message: `Matcher "${m}" is not a valid regular expression: the hook never runs (${(e as Error).message})`, fix: 'Fix the expression, or list exact names separated by |' });
			continue;
		}
		if (!KNOWN_TOOLS.some(t => re!.test(t)) && !re.test('mcp__server__tool') && !/mcp/.test(m)) {
			out.push({ ...at, severity: 'warning', code: 'dead-matcher', message: `Matcher /${m}/ matches none of Claude Code's tools`, fix: 'Check the tool names; matching is case-sensitive' });
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Permission rules

/** Allow rules that hand over much more than they look like: a whole tool, a shell or interpreter, or every domain. */
const BROAD_PROGRAMS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd', 'sudo', 'env', 'xargs', 'eval', 'node', 'python', 'python3', 'ruby', 'perl', 'npx', 'curl', 'wget', 'ssh', 'rm', 'git', 'docker', 'kubectl', 'find']);

function lintRules(input: LintInput, out: Finding[]) {
	const ctx = { cwd: input.cwd, home: input.home };
	const seen = new Map<string, Rule & { line: number }>();
	for (const r of input.rules) {
		const at = { file: r.file, line: r.line };
		const problem = ruleProblem(r);
		if (problem) {
			out.push({ ...at, severity: 'warning', code: 'rule-never-applies', message: problem, fix: 'Rewrite the rule as the message says, or delete it' });
			continue;
		}
		const dup = seen.get(`${r.effect}:${r.pattern}`);
		if (dup) {
			out.push({ ...at, severity: 'info', code: 'duplicate-rule', message: `${r.pattern} is already a ${r.effect} rule in ${dup.scope} settings`, fix: 'Delete one of them' });
		} else {
			seen.set(`${r.effect}:${r.pattern}`, r);
		}
		if (r.effect !== 'allow') {
			continue;
		}
		const p = parseRule(r.pattern);
		const spec = p.spec?.trim();
		const whole = spec === undefined || spec === '*';
		if (whole && (p.tool === 'Bash' || p.tool === 'PowerShell' || p.tool === 'Edit' || p.tool === 'Write' || p.tool === 'WebFetch')) {
			out.push({ ...at, severity: 'warning', code: 'overbroad', message: `${r.pattern} allows every ${p.tool === 'WebFetch' ? 'fetch' : p.tool === 'Edit' || p.tool === 'Write' ? 'file edit' : 'command'} without asking`, fix: p.tool === 'Bash' ? 'Allow the commands you run, e.g. Bash(npm test *), Bash(git status)' : p.tool === 'WebFetch' ? 'Allow the domains you need, e.g. WebFetch(domain:github.com)' : 'Allow the folders you mean, e.g. Edit(/src/**)' });
			continue;
		}
		if (p.tool === 'WebFetch' && /^domain:\s*\*$/.test(spec ?? '')) {
			out.push({ ...at, severity: 'warning', code: 'overbroad', message: `${r.pattern} allows fetching from any domain`, fix: 'List the domains you need' });
		}
		if ((p.tool === 'Read' || p.tool === 'Edit') && /^\/\/\*\*$|^~\/\*\*$/.test(spec ?? '')) {
			out.push({ ...at, severity: 'warning', code: 'overbroad', message: `${r.pattern} covers ${spec?.startsWith('~') ? 'your whole home folder' : 'the whole disk'}`, fix: 'Narrow it to the project, e.g. Read(/src/**)' });
		}
		if (p.tool === 'Bash' && spec) {
			const s = spec.replace(/:\*$/, ' *');
			const program = s.split(/\s+/)[0]?.replace(/^.*\//, '').toLowerCase() ?? '';
			if (s.includes('*') && BROAD_PROGRAMS.has(program) && /^\S+\s+\*$/.test(s)) {
				out.push({ ...at, severity: 'warning', code: 'overbroad', message: `${r.pattern} allows any ${program} command${program === 'git' ? ', including push --force and reset --hard' : ', which can run or delete anything'}`, fix: `Allow the subcommands you use, e.g. Bash(${program === 'git' ? 'git status' : `${program} --version`})` });
			} else if (/^\S+\s+\*\s+\S/.test(s)) {
				out.push({ ...at, severity: 'warning', code: 'wildcard-before-subcommand', message: `${r.pattern} puts * before the subcommand, so it allows every ${program} subcommand that ends this way`, fix: 'Put the * after the subcommand, e.g. Bash(git log *)' });
			}
		}
		// An allow rule that a deny or ask rule elsewhere always overrides does nothing.
		const sample = sampleCall(p.tool, spec);
		if (sample) {
			const v = simulate(sample, input.rules.filter(x => x !== r), ctx);
			if (v.rule && (v.decision === 'deny' || v.decision === 'ask') && v.rule.pattern !== r.pattern) {
				out.push({ ...at, severity: 'warning', code: 'shadowed', message: `${r.pattern} never takes effect where ${v.rule.pattern} (${v.rule.effect}, ${v.rule.scope} settings) matches: deny and ask win over allow`, fix: `Narrow ${v.rule.pattern}, or delete this allow rule` });
			}
		}
	}
}

/** A call the allow rule covers, with every wildcard filled in, to see what the other rules say about it. */
function sampleCall(tool: string, spec: string | undefined) {
	if (spec === undefined || tool.startsWith('mcp__') || tool.includes('*')) {
		return undefined;
	}
	const filled = spec.replace(/:\*$/, ' x').replace(/\*\*/g, 'x').replace(/\*/g, 'x');
	return { tool, arg: filled };
}

export function lint(input: LintInput): Finding[] {
	const all: Finding[] = [];
	const until = Date.now() + GLOB_MS;
	const longPaths = !!input.projectFiles?.some(p => p.length > MAX_PATH);
	for (const f of input.files) {
		lintFrontmatter(f, all);
		lintGlobs(f, input, all, until, longPaths);
	}
	lintOverlap(input, all);
	lintHooks(input, all);
	lintRules(input, all);
	// A file full of the same mistake is one list of it, not a hundred thousand lines.
	const seen = new Map<string, number>();
	const out = all.filter(x => {
		const key = `${x.file}\n${x.code}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
		return seen.get(key)! <= MAX_PER_CHECK;
	});
	const rank = { error: 0, warning: 1, info: 2 };
	return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

export type { RuleScope };
