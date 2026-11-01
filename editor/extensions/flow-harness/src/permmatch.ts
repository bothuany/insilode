/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the permission simulator. Given the rules from every settings file and a tool
 *  call such as `Bash(git push --force)` or `Edit(src/x.ts)`, say what Claude Code would do
 *  (allow, ask or deny) and which rule decided it, following Claude Code's documented matching:
 *  deny, then ask across all scopes; then the checks no allow rule passes (protected paths,
 *  rm of a critical path, reads from a network path); then allow; then the read-only set and the
 *  permission mode. Bash compound commands are split (loop and if bodies too) and wrappers
 *  stripped; nested commands ($( ), backticks, <( ), subshells) are decided on their own and the
 *  most restrictive answer wins; a redirect to a file is never read-only; gitignore-style paths with the //, ~/, / and ./ anchors; parameter rules; WebFetch
 *  domains; MCP and Agent rules. Codex's approval policy and sandbox get a coarser answer. Pure
 *  (no vscode), so every case is tested on its own (test/permmatch.test.mjs).
 *--------------------------------------------------------------------------------------------*/

export type Effect = 'allow' | 'ask' | 'deny';
export type RuleScope = 'managed' | 'user' | 'project' | 'local' | 'session';

export interface Rule {
	pattern: string;
	effect: Effect;
	scope: RuleScope;
	/** The settings file the rule is in: `!` carve-outs only reach rules of the same file. */
	file: string;
}

export interface SimContext {
	/** The session's primary working directory (the project root). */
	cwd: string;
	home: string;
	/** The session's permission mode; `default` (Manual) when unset. */
	mode?: string;
	additionalDirs?: string[];
}

export interface Verdict {
	decision: Effect;
	/** The rule that decided, when one did. */
	rule?: Rule;
	/** One sentence for people: why this is the answer. */
	reason: string;
	/** What decided it: a rule, the permission mode, Claude Code's built-in read-only set, or a safety check no allow rule passes. */
	by: 'rule' | 'mode' | 'builtin' | 'invalid' | 'safety';
	/** Caveats worth knowing (rules that are never consulted, parts that could not be checked). */
	notes: string[];
	/** For a compound Bash command: each subcommand and how it fared. */
	parts?: { command: string; decision: Effect | 'none'; rule?: Rule }[];
}

export interface Call {
	tool: string;
	/** The primary input: the command, the path, the URL, the agent name; empty for a bare tool. */
	arg: string;
	/** The whole input, when the call was written as JSON (`Bash({"command":"x","run_in_background":true})`): what parameter rules match. */
	params?: Record<string, unknown>;
}

/** Claude Code's built-in tools, as hook matchers and permission rules name them. */
export const KNOWN_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'PowerShell', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch',
	'Task', 'Agent', 'TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'Skill', 'SlashCommand', 'ToolSearch', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskStop', 'TaskOutput',
	'AskUserQuestion', 'Monitor', 'SendMessage', 'CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'LSP', 'EndConversation'];

/** Each tool's primary input field: a parameter rule cannot name it, and a JSON call's `arg` is taken from it. */
const PRIMARY: Record<string, string> = {
	Bash: 'command', PowerShell: 'command', Read: 'file_path', Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path',
	NotebookEdit: 'notebook_path', Grep: 'path', Glob: 'path', LS: 'path', WebFetch: 'url', WebSearch: 'query', Agent: 'subagent_type', Task: 'subagent_type', Skill: 'skill',
};

/**
 * Whether a bare word names a tool rather than a command: a built-in tool (case as Claude Code writes it, so `ls` and
 * `grep` stay commands while `LS` and `Grep` are tools), an MCP tool, or a multi-word PascalCase name such as a newer
 * built-in this list does not know yet.
 */
const isToolName = (word: string) => KNOWN_TOOLS.includes(word) || word.startsWith('mcp__') || /^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(word);

/**
 * `Tool` or `Tool(arg)`: the tool name runs to the first `(`, the argument to the last `)`, so parentheses inside it are
 * literal. An argument that is a JSON object is the tool's whole input, so parameter rules can be checked against it.
 * Anything else (`git status`, a single word such as `pwd` or `make`) is a Bash command.
 */
export function parseCall(text: string): Call | undefined {
	const t = text.trim();
	if (!t) {
		return undefined;
	}
	const open = t.indexOf('(');
	// `echo $(date)` and `ls (a)` are commands: a call is a name directly followed by its parenthesis.
	if (open < 0 || !/^[\w*.-]+\(/.test(t)) {
		return isToolName(t) ? { tool: t, arg: '' } : { tool: 'Bash', arg: t };
	}
	const close = t.lastIndexOf(')');
	if (close < open) {
		return undefined;
	}
	const tool = t.slice(0, open).trim();
	if (!tool) {
		return undefined;
	}
	const arg = t.slice(open + 1, close);
	if (/^\s*\{/.test(arg)) {
		try {
			const params = JSON.parse(arg) as unknown;
			if (params && typeof params === 'object' && !Array.isArray(params)) {
				const p = params as Record<string, unknown>;
				const primary = p[PRIMARY[tool] ?? ''];
				return { tool, arg: typeof primary === 'string' ? primary : '', params: p };
			}
		} catch {
			// Not JSON after all: a command or path that starts with a brace.
		}
	}
	return { tool, arg };
}

interface ParsedRule { tool: string; spec?: string }

/** A rule's tool and specifier, by the same split as a call. */
export function parseRule(pattern: string): ParsedRule {
	const p = pattern.trim();
	const open = p.indexOf('(');
	const close = p.lastIndexOf(')');
	if (open < 0 || close < open) {
		return { tool: p };
	}
	return { tool: p.slice(0, open).trim(), spec: p.slice(open + 1, close) };
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
/** Path rules written for these tools are accepted by Claude Code but never consulted: only Edit(path) and Read(path) are. */
const UNCONSULTED_PATH_TOOLS = new Set(['Write', 'MultiEdit', 'NotebookEdit', 'Glob']);
/** Tools that never ask in any mode. */
const NO_PERMISSION = new Set(['TodoWrite', 'Task', 'Agent', 'ToolSearch', 'ExitPlanMode', 'EnterPlanMode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet']);
/** Parameters of Bash that a `Bash(param:value)` deny or ask rule can name; anything else before a colon is part of the command. */
const BASH_PARAMS = new Set(['run_in_background', 'timeout', 'description', 'dangerouslyDisableSandbox']);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A whole-string glob where `*` matches any text (tool names, agent names, parameter values). */
function globAll(pattern: string, flags = '') {
	return new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`, flags);
}

// ---------------------------------------------------------------------------------------------
// Bash

/** Splits a command at the shell operators Claude Code recognizes (&&, ||, ;, |, |&, &, newline), outside quotes. Undefined when an operator has nothing after it. */
export function splitCompound(command: string): string[] | undefined {
	const parts: string[] = [];
	let cur = '';
	let quote: string | undefined;
	let depth = 0;
	let dangling = false;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote) {
			cur += c;
			if (c === quote) {
				quote = undefined;
			} else if (c === '\\' && quote === '"') {
				cur += command[++i] ?? '';
			}
			continue;
		}
		if (c === '\\') {
			cur += c + (command[++i] ?? '');
			continue;
		}
		if (c === '"' || c === '\'') {
			quote = c;
			cur += c;
			continue;
		}
		// Operators inside $( ) or ( ) belong to the nested command, which is checked on its own for deny and ask.
		if (c === '(') {
			depth++;
		} else if (c === ')' && depth > 0) {
			depth--;
		}
		const two = command.slice(i, i + 2);
		const op = depth ? undefined : two === '&&' || two === '||' || two === '|&' ? two : c === ';' || c === '|' || c === '&' || c === '\n' ? c : undefined;
		// `2>&1`, `<&3` and `&>` are redirections, not operators, and so is the `|` of `>|` (write even with noclobber).
		if ((op === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) || (op === '|' && command[i - 1] === '>')) {
			cur += c;
			continue;
		}
		if (op) {
			if (cur.trim()) {
				parts.push(cur.trim());
			}
			cur = '';
			dangling = op === '&&' || op === '||';
			i += op.length - 1;
			continue;
		}
		cur += c;
		if (c.trim()) {
			dangling = false;
		}
	}
	if (cur.trim()) {
		parts.push(cur.trim());
	}
	return dangling ? undefined : parts;
}

/** The index of the `)` that closes the `(` at `open`, skipping quoted text and escapes; -1 when it is never closed. */
function closingParen(s: string, open: number, powershell: boolean): number {
	const esc = powershell ? '`' : '\\';
	let depth = 0;
	for (let i = open; i < s.length; i++) {
		const c = s[i];
		if (c === esc) {
			i++;
		} else if (c === '\'') {
			const end = s.indexOf('\'', i + 1);
			if (end < 0) {
				return -1;
			}
			i = end;
		} else if (c === '"') {
			for (i++; i < s.length && s[i] !== '"'; i++) {
				if (s[i] === esc) {
					i++;
				}
			}
			if (i >= s.length) {
				return -1;
			}
		} else if (c === '(') {
			depth++;
		} else if (c === ')' && --depth === 0) {
			return i;
		}
	}
	return -1;
}

/**
 * The commands a command runs inside itself, read the way the shell reads them: `$( )` and backtick substitutions
 * (outside single quotes; inside double quotes too), `<( )` and `>( )` process substitutions, and `( )` subshells that
 * start a command. Quoted text and escaped characters are literal, so `grep -E '(a|b)'` and `echo '$(x)'` run nothing
 * nested. `$(( ))` is arithmetic, not a command, but a substitution inside it still runs. In PowerShell `$( )` and
 * `@( )` are subexpressions and the backtick is the escape character. `ok` is false when a substitution is never
 * closed: the shell would not run it as written, and no allow rule may approve it.
 */
export function substitutions(command: string, powershell = false): { bodies: string[]; ok: boolean } {
	const bodies: string[] = [];
	const esc = powershell ? '`' : '\\';
	let quote: '"' | '\'' | undefined;
	/** Whether the last significant character starts a command, so a `(` there opens a subshell. */
	let atStart = true;
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === '\'') {
			if (c === '\'') {
				quote = undefined;
			}
			continue;
		}
		if (c === esc) {
			i++;
			atStart = false;
			continue;
		}
		if (c === '"') {
			quote = quote ? undefined : '"';
			atStart = false;
			continue;
		}
		if (c === '\'' && !quote) {
			quote = '\'';
			atStart = false;
			continue;
		}
		if (c === '`' && !powershell) {
			let end = i + 1;
			while (end < command.length && command[end] !== '`') {
				end += command[end] === '\\' ? 2 : 1;
			}
			if (end >= command.length) {
				return { bodies, ok: false };
			}
			bodies.push(command.slice(i + 1, end).replace(/\\`/g, '`'));
			i = end;
			atStart = false;
			continue;
		}
		const sub = (c === '$' || (powershell && c === '@')) && command[i + 1] === '(' ? i + 1
			: !quote && !powershell && (c === '<' || c === '>') && command[i + 1] === '(' ? i + 1
				: !quote && c === '(' && atStart ? i : -1;
		if (sub >= 0) {
			const end = closingParen(command, sub, powershell);
			if (end < 0) {
				return { bodies, ok: false };
			}
			const inner = command.slice(sub + 1, end);
			if (c === '$' && !powershell && inner.startsWith('(') && inner.endsWith(')')) {
				// Arithmetic: only the substitutions inside it run.
				const nested = substitutions(inner.slice(1, -1), powershell);
				if (!nested.ok) {
					return { bodies, ok: false };
				}
				bodies.push(...nested.bodies);
			} else if (inner.trim()) {
				bodies.push(inner);
			}
			i = end;
			atStart = false;
			continue;
		}
		if (!quote && /\s/.test(c)) {
			continue;
		}
		atStart = !quote && (c === ';' || c === '&' || c === '|' || c === '(' || c === '{' || c === '\n');
	}
	return { bodies: bodies.map(b => b.trim()).filter(Boolean), ok: !quote };
}

/** The `$( )` and backtick substitutions in a here-document's body, as written: everything else in it is text. */
function bodySubstitutions(body: string): string[] {
	const out: string[] = [];
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '\\') {
			i++;
		} else if (body[i] === '$' && body[i + 1] === '(') {
			const end = closingParen(body, i + 1, false);
			out.push(body.slice(i, end < 0 ? body.length : end + 1) + (end < 0 ? ')' : ''));
			i = end < 0 ? body.length : end;
		} else if (body[i] === '`') {
			const end = body.indexOf('`', i + 1);
			out.push(body.slice(i, end < 0 ? body.length : end + 1) + (end < 0 ? '`' : ''));
			i = end < 0 ? body.length : end;
		}
	}
	return out;
}

/**
 * A command with its here-document bodies taken out: they are data, not commands (Claude Code writes every commit
 * message as `git commit -m "$(cat <<'EOF' … EOF)"`), so their lines, quotes and parentheses must not be read as shell.
 * A body under a quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<\EOF`) expands nothing and is dropped; under a bare one
 * its substitutions still run, so they are kept, on the line that opened the here-document.
 */
export function stripHeredocs(command: string): string {
	if (!command.includes('<<')) {
		return command;
	}
	const lines = command.split('\n');
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const kept: string[] = [];
		for (const m of line.matchAll(/<<(?!<)(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?)([A-Za-z_][\w.-]*))/g)) {
			const word = m[2] ?? m[3] ?? m[5];
			const quoted = m[2] !== undefined || m[3] !== undefined || m[4] === '\\';
			const body: string[] = [];
			for (i++; i < lines.length && (m[1] ? lines[i].replace(/^\t+/, '') : lines[i]) !== word; i++) {
				body.push(lines[i]);
			}
			if (!quoted) {
				kept.push(...bodySubstitutions(body.join('\n')));
			}
		}
		out.push(kept.length ? `${line} ${kept.join(' ')}` : line);
	}
	return out.join('\n');
}

/**
 * Every command nested in `command`, at any depth, each split at its operators: what deny and ask rules must reach. Each
 * level is read past its keywords and wrappers first, so `time (git push)` and `$(if (git push); then …)` are reached.
 */
function allNested(command: string, powershell: boolean): string[] {
	const out: string[] = [];
	const cmd = stripWrappers(commandOfPart(command) ?? command, false).command;
	for (const body of substitutions(cmd, powershell).bodies) {
		for (const part of splitCompound(body) ?? [body]) {
			out.push(part, ...allNested(part, powershell));
		}
	}
	return out;
}

/**
 * Whether a command writes a file through a redirect. Only a redirect to /dev/null (`> /dev/null`, `2>/dev/null`,
 * `&>/dev/null`) and a file-descriptor duplication (`2>&1`, `>&2`, `3>&-`) leave no file behind; every other `>`,
 * `>>`, `>|`, `N>`, `&>`, `<>` or `>&word` writes the file it names. Quoted text is literal, so `grep '>' f` and
 * `echo "a > b"` write nothing, while `> "out"` does. A `>( )` process substitution is a nested command, not a file.
 */
export function redirectsToFile(command: string): boolean {
	// Quoted text and escaped characters become plain word characters: what was inside stays readable as a target.
	const plain = command
		.replace(/\\[\s\S]/g, '_')
		.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, q => q.slice(1, -1).replace(/[\s<>&|;()]/g, '_'));
	const re = /(&|\d+)?>(>|\||&)?[ \t]*/g;
	for (let m = re.exec(plain); m; m = re.exec(plain)) {
		const rest = plain.slice(m.index + m[0].length);
		if (m[0] === '>' && rest.startsWith('(')) {
			continue; // `>(cmd)`: process substitution
		}
		const target = /^[^\s;&|<>()]*/.exec(rest)![0];
		if (!target && /^[<>]\(/.test(rest)) {
			continue; // `> >(cmd)`: into a process substitution, which is checked as a nested command
		}
		if (m[2] === '&' && m[1] !== '&' && /^(?:\d+|-)$/.test(target)) {
			continue; // `2>&1`, `>&2`, `3>&-`
		}
		if (target === '/dev/null') {
			continue;
		}
		return true;
	}
	return false;
}

/** Shell keywords that open a body or condition: what follows them is the command (`do git clean -f`, `if test -f x`). */
const LEADING_KEYWORDS = /^(?:do|then|else|elif|if|while|until|!|\{)\s+/;
/** Parts that run nothing themselves: a loop header's word list, and the words that close a body. */
const NEUTRAL = /^(?:(?:for|select)\s+\w+(?:\s+in\b.*)?|case\b.*|done|fi|esac|\}|\{|do|then|else)$/s;

/**
 * The command a compound part runs, with the keywords of loops and conditionals taken off, so deny and ask rules reach
 * the bodies and allow rules must cover them; undefined for a part that runs nothing (`for f in *`, `done`).
 */
export function commandOfPart(part: string): string | undefined {
	let p = part.trim();
	for (let prev = ''; prev !== p;) {
		prev = p;
		p = p.replace(LEADING_KEYWORDS, '').trim();
	}
	return !p || NEUTRAL.test(p) ? undefined : p;
}

/** Environment variables whose leading assignment does not stop an allow rule from matching. */
const SAFE_ENV = new Set(['NODE_ENV', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'DEBUG', 'LANG', 'LC_ALL', 'TZ', 'RUST_BACKTRACE', 'RUST_LOG', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'GOOS', 'GOARCH', 'TERM', 'COLUMNS']);
const WRAPPERS = new Set(['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob', 'xargs']);
/** Wrappers that run their argument but are never stripped: a prefix rule cannot approve them. */
const EXEC_WRAPPERS = new Set(['watch', 'setsid', 'ionice', 'flock']);

/** Words of a command, quotes kept, split at unquoted whitespace. */
function words(command: string): string[] {
	return command.match(/(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'[^']*')+/g) ?? [];
}

/**
 * The command a rule is matched against: leading environment assignments and the fixed wrapper list stripped.
 * For allow rules only known-safe assignments are stripped (`unsafeEnv` says one was left); deny and ask see past any.
 */
export function stripWrappers(command: string, forAllow: boolean): { command: string; unsafeEnv: boolean } {
	let w = words(command);
	let unsafeEnv = false;
	for (;;) {
		const head = w[0];
		if (!head) {
			break;
		}
		const env = /^([A-Za-z_]\w*)=/.exec(head);
		if (env) {
			if (forAllow && !SAFE_ENV.has(env[1])) {
				unsafeEnv = true;
				break;
			}
			w = w.slice(1);
			continue;
		}
		if (!WRAPPERS.has(head)) {
			break;
		}
		if (head === 'command' && w[1] === '-v') {
			break; // the query form looks a command up, it runs nothing
		}
		if (head === 'xargs' && w[1]?.startsWith('-')) {
			break; // xargs with flags is matched as xargs itself
		}
		let i = 1;
		// The wrapper's own options and, for timeout and nice, their values.
		while (w[i]?.startsWith('-')) {
			i += /^-(?:n|s|k|i|o|e)$/.test(w[i]) || /^--(?:signal|kill-after|adjustment)$/.test(w[i]) ? 2 : 1;
		}
		if (head === 'timeout' && /^\d/.test(w[i] ?? '')) {
			i++;
		}
		w = w.slice(i);
	}
	return { command: w.join(' '), unsafeEnv };
}

/** Whether a Bash rule's specifier matches one (stripped) command. */
export function bashMatches(spec: string | undefined, command: string): boolean {
	if (spec === undefined || spec.trim() === '*' || spec.trim() === '') {
		return true;
	}
	let s = spec.trim();
	// `:*` is a trailing wildcard only at the very end; elsewhere the colon is literal.
	if (s.endsWith(':*')) {
		s = `${s.slice(0, -2)} *`;
	}
	const cmd = command.trim().replace(/\s+/g, ' ');
	if (!s.includes('*')) {
		return cmd === s.replace(/\s+/g, ' ');
	}
	const stars = s.split('*').length - 1;
	// A trailing ` *` that is the rule's only wildcard also matches the bare command: `ls *` matches `ls`.
	if (stars === 1 && s.endsWith(' *')) {
		const prefix = s.slice(0, -2).replace(/\s+/g, ' ');
		return cmd === prefix || cmd.startsWith(`${prefix} `);
	}
	return new RegExp(`^${s.replace(/\s+/g, ' ').split('*').map(escapeRe).join('.*')}$`, 's').test(cmd);
}

const READ_ONLY_BASH = new Set(['ls', 'cat', 'echo', 'pwd', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'which', 'diff', 'stat', 'du', 'cd', 'tree', 'file', 'sort', 'uniq', 'less', 'more', 'type', 'whoami', 'date', 'basename', 'dirname', 'realpath', 'printf', 'true', 'false']);
const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'describe', 'shortlog', 'reflog', 'grep']);
const FIND_ACTIONS = /\s-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|files0-from)\b/;

/** Claude Code's built-in read-only set (approximated): these run without a prompt when no rule says otherwise. */
export function isReadOnlyCommand(text: string): boolean {
	const command = stripHeredocs(text);
	const w = words(command);
	const program = (w[0] ?? '').replace(/^.*\//, '');
	// A redirect writes a file: the Edit rules decide that, so it is not read-only on its own.
	if (redirectsToFile(command) || /\btee\b/.test(command)) {
		return false;
	}
	// A nested command ($( ), backticks, <( ), a subshell) runs whatever it names: the read-only set never covers it.
	const nested = substitutions(command);
	if (!nested.ok || nested.bodies.length) {
		return false;
	}
	if (program === 'git') {
		return GIT_READ_ONLY.has(w[1] ?? '') && !/[*?]/.test(command.replace(/'[^']*'|"[^"]*"/g, ''));
	}
	if (!READ_ONLY_BASH.has(program)) {
		return false;
	}
	if (program === 'find' && FIND_ACTIONS.test(` ${command}`)) {
		return false;
	}
	// An unquoted glob could expand to a flag for commands with write-capable flags.
	if ((program === 'find' || program === 'sort') && /[*?]/.test(command.replace(/'[^']*'|"[^"]*"/g, ''))) {
		return false;
	}
	return true;
}

/** A prefix (wildcard) rule never approves exec wrappers or `find` with an action that runs, deletes or writes. */
function prefixCannotApprove(command: string) {
	const program = words(command)[0] ?? '';
	return EXEC_WRAPPERS.has(program) || (program === 'find' && FIND_ACTIONS.test(` ${command}`));
}

// ---------------------------------------------------------------------------------------------
// Paths

/** POSIX form, as Claude Code matches it: `C:\Users\a` becomes `/c/Users/a`. */
export function posixPath(p: string): string {
	let s = p.replace(/\\/g, '/');
	const drive = /^([A-Za-z]):(\/|$)/.exec(s);
	if (drive) {
		s = `/${drive[1].toLowerCase()}/${s.slice(drive[0].length)}`;
	}
	return s.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
}

function joinPosix(base: string, rel: string) {
	const out: string[] = [];
	for (const seg of `${base}/${rel}`.split('/')) {
		if (seg === '..') {
			out.pop();
		} else if (seg && seg !== '.') {
			out.push(seg);
		}
	}
	return `/${out.join('/')}`;
}

/** A gitignore glob as a regex over a path relative to its anchor: `*` within one segment, `**` across them. */
function globRegex(glob: string, caseInsensitive: boolean): RegExp {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '/' && glob.slice(i) === '/**') {
			// `dir/**` also names the directory itself: a search of `dir` reads what the rule guards.
			re += '(?:/.*)?';
			break;
		}
		if (c === '*' && glob[i + 1] === '*') {
			const slashAfter = glob[i + 2] === '/';
			re += slashAfter ? '(?:.*/)?' : '.*';
			i += slashAfter ? 2 : 1;
		} else if (c === '*') {
			re += '[^/]*';
		} else if (c === '?') {
			re += '[^/]';
		} else if (c === '[') {
			const end = glob.indexOf(']', i + 1);
			if (end > i) {
				re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
				i = end;
			} else {
				re += '\\[';
			}
		} else {
			re += escapeRe(c);
		}
	}
	// A directory pattern also covers what is inside it.
	return new RegExp(`^${re}(?:/.*)?$`, caseInsensitive ? 'i' : '');
}

/** The directory a `/path` pattern anchors at, by the settings source that defines it. */
function slashAnchor(rule: Rule, ctx: SimContext) {
	return rule.scope === 'user' ? joinPosix(posixPath(ctx.home), '.claude') : posixPath(ctx.cwd);
}

/** Whether a Read or Edit path specifier matches `file` (absolute, POSIX). */
export function pathMatches(spec: string, rule: Rule, file: string, ctx: SimContext): boolean {
	let s = spec.trim();
	if (s.startsWith('!')) {
		s = s.slice(1); // a carve-out is read relative to the current directory, whatever follows the `!`
	}
	const cwd = posixPath(ctx.cwd);
	let anchor: string;
	let glob: string;
	let anyDepth = false;
	if (s.startsWith('//')) {
		anchor = '';
		glob = s.slice(2);
	} else if (s.startsWith('~/')) {
		anchor = posixPath(ctx.home);
		glob = s.slice(2);
	} else if (s.startsWith('/')) {
		anchor = slashAnchor(rule, ctx);
		glob = s.slice(1);
	} else {
		anchor = cwd;
		glob = s.replace(/^\.\//, '');
		const segments = glob.replace(/\/\*\*$/, '').split('/');
		if (!s.startsWith('./') && !glob.startsWith('**')) {
			// A bare name matches at any depth (gitignore); a single directory segment like `src/**` does too, but only for deny and ask.
			anyDepth = !glob.includes('/') || (segments.length === 1 && glob.endsWith('/**') && rule.effect !== 'allow');
		}
	}
	// Windows file systems ignore case, and so does the match there: the anchor as much as the glob. Both sides are folded
	// before the prefix is cut off, so a character whose lower case is longer cannot shift where the relative part starts.
	const fold = sameCase(ctx) ? (p: string) => p.toLowerCase() : (p: string) => p;
	const target = fold(posixPath(file));
	anchor = fold(anchor);
	const base = anchor ? `${anchor}/` : '/';
	if (!target.startsWith(base) && target !== anchor) {
		return false;
	}
	const rel = target === anchor ? '' : target.slice(base.length);
	const re = globRegex(glob, sameCase(ctx));
	if (re.test(rel)) {
		return true;
	}
	if (anyDepth) {
		const segs = rel.split('/');
		for (let i = 1; i < segs.length; i++) {
			if (re.test(segs.slice(i).join('/'))) {
				return true;
			}
		}
	}
	return false;
}

const isRelativeSpec = (spec: string) => !/^(?:\/|~\/)/.test(spec.trim());

// ---------------------------------------------------------------------------------------------
// WebFetch

/** `domain:` rules: case-insensitive, trailing dots ignored; `*.x` is any subdomain depth (not x itself); other `*` stay inside one label. */
export function domainMatches(spec: string, host: string): boolean {
	const d = spec.replace(/^domain:\s*/i, '').trim().toLowerCase().replace(/\.$/, '');
	const h = host.toLowerCase().replace(/\.$/, '');
	if (d === '*') {
		return true;
	}
	if (d.startsWith('*.')) {
		return h.endsWith(d.slice(1)) && h.length > d.length - 1;
	}
	return new RegExp(`^${d.split('*').map(escapeRe).join('[^.]*')}$`).test(h);
}

function hostOf(arg: string): string | undefined {
	const a = arg.trim();
	if (/^domain:/i.test(a)) {
		return a.replace(/^domain:\s*/i, '');
	}
	try {
		return new URL(/^[a-z]+:\/\//i.test(a) ? a : `https://${a}`).hostname;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------------------------
// Rules against calls

/** Why a rule can never match anything here, for the notes; undefined for a working rule. */
export function ruleProblem(rule: Rule): string | undefined {
	const r = parseRule(rule.pattern);
	if (r.tool.startsWith('mcp__') && r.spec !== undefined) {
		return `${rule.pattern}: Claude Code skips mcp__ rules with parentheses`;
	}
	if (UNCONSULTED_PATH_TOOLS.has(r.tool) && r.spec !== undefined) {
		return `${rule.pattern}: path rules for ${r.tool} are never consulted; use ${r.tool === 'Glob' ? 'Read' : 'Edit'}(${r.spec})`;
	}
	if (rule.effect === 'allow' && /\*/.test(r.tool) && !/^mcp__[^*]+__/.test(r.tool)) {
		return `${rule.pattern}: an allow rule may glob tool names only after a literal mcp__<server>__ prefix`;
	}
	if (r.spec !== undefined && r.tool === 'Bash' && /^\s*command\s*:/.test(r.spec)) {
		return `${rule.pattern}: Claude Code ignores rules on Bash's command parameter`;
	}
	if (r.spec !== undefined && (r.tool === 'Read' || r.tool === 'Edit') && /^\s*!?[A-Za-z]:[\/]/.test(r.spec)) {
		const posix = posixPath(r.spec.trim().replace(/^!/, ''));
		return `${rule.pattern}: Claude Code matches Windows paths in POSIX form, and a pattern without a leading / is read relative to the current directory; the documented way to write this path is ${r.tool}(/${posix})`;
	}
	return undefined;
}

/**
 * `Tool(param:value)`: a top-level input parameter, for deny and ask rules. A drive letter (`Read(C:/x/.env)`) is a path,
 * not a parameter; for Bash and PowerShell only their known parameters count, since `git:*` is a command prefix.
 */
function paramOf(r: ParsedRule): { name: string; value: string } | undefined {
	if (r.spec === undefined || r.tool.startsWith('mcp__') || /^\s*[A-Za-z]:[\/]/.test(r.spec)) {
		return undefined;
	}
	const m = /^\s*([A-Za-z_]\w*)\s*:\s*(.*)$/s.exec(r.spec);
	if (!m) {
		return undefined;
	}
	if (r.tool === 'Bash' || r.tool === 'PowerShell' ? !BASH_PARAMS.has(m[1]) : r.tool === 'WebFetch' && m[1] === 'domain') {
		return undefined;
	}
	return { name: m[1], value: m[2].trim() };
}

const isParamRule = (r: ParsedRule) => !!paramOf(r);

/**
 * Whether a deny or ask parameter rule matches: the call sets that parameter to that exact value (`*` any text), as
 * written, before any normalization. A parameter the call leaves out is never matched, and allow rules never are.
 */
function paramMatches(rule: Rule, call: Call): boolean {
	const r = parseRule(rule.pattern);
	const p = paramOf(r);
	if (!p || rule.effect === 'allow' || !call.params || !toolNameMatches(r.tool, call.tool, rule.effect) || !(p.name in call.params)) {
		return false;
	}
	const v = call.params[p.name];
	return (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') && globAll(p.value).test(String(v));
}

/** The first deny or ask parameter rule that matches; a note when such rules exist but the call gave no parameters to check. */
function firstParamMatch(rules: Rule[], effect: Effect, call: Call): Rule | undefined {
	return rules.find(r => r.effect === effect && paramMatches(r, call));
}

function paramNotes(rules: Rule[], call: Call): string[] {
	const unchecked = rules.filter(r => r.effect !== 'allow' && isParamRule(parseRule(r.pattern)) && toolNameMatches(parseRule(r.pattern).tool, call.tool, r.effect));
	return unchecked.length && !call.params
		? [`${unchecked.map(r => r.pattern).join(', ')} ${unchecked.length > 1 ? 'match' : 'matches'} on a parameter: write the call as JSON, like ${call.tool}({"${PRIMARY[call.tool] ?? 'param'}": "…", "${paramOf(parseRule(unchecked[0].pattern))!.name}": …}), to check ${unchecked.length > 1 ? 'them' : 'it'}`]
		: [];
}

function toolNameMatches(ruleTool: string, tool: string, effect: Effect): boolean {
	if (ruleTool === tool) {
		return true;
	}
	// Agent was called Task before; rules written either way name the same tool.
	if ((ruleTool === 'Task' || ruleTool === 'Agent') && (tool === 'Task' || tool === 'Agent')) {
		return true;
	}
	if (ruleTool.startsWith('mcp__') && tool.startsWith('mcp__')) {
		// `mcp__server` covers every tool of that server.
		if (!ruleTool.slice(5).includes('__') && !ruleTool.includes('*')) {
			return tool.startsWith(`${ruleTool}__`);
		}
	}
	if (ruleTool.includes('*')) {
		if (effect === 'allow' && !/^mcp__[^*]+__/.test(ruleTool)) {
			return false;
		}
		return globAll(ruleTool).test(tool);
	}
	return false;
}

/** Whether `rule` matches the non-Bash `call`; `file` is the call's path made absolute (POSIX) for file tools. */
function matchesTool(rule: Rule, call: Call, ctx: SimContext, file: string | undefined): boolean {
	const r = parseRule(rule.pattern);
	if (ruleProblem(rule) || isParamRule(r)) {
		return false;
	}
	const fileRule = r.tool === 'Edit' || r.tool === 'Read';
	if (fileRule && file !== undefined) {
		// Edit rules cover every editing tool; Read rules cover the reading tools, and a Read deny also blocks Edit and Write.
		const covers = r.tool === 'Edit' ? EDIT_TOOLS.has(call.tool) : READ_TOOLS.has(call.tool) || (rule.effect === 'deny' && (call.tool === 'Edit' || call.tool === 'Write'));
		if (!covers) {
			return false;
		}
		return r.spec === undefined || r.spec.trim() === '*' || pathMatches(r.spec, rule, file, ctx);
	}
	if (!toolNameMatches(r.tool, call.tool, rule.effect)) {
		return false;
	}
	if (r.spec === undefined || r.spec.trim() === '*') {
		return true;
	}
	if (call.tool === 'WebFetch') {
		const host = hostOf(call.arg);
		return !!host && /^domain:/i.test(r.spec.trim()) && domainMatches(r.spec, host);
	}
	return globAll(r.spec.trim(), 'i').test(call.arg.trim());
}

/** The first rule of `effect` that matches a file-tool call, with `!` carve-outs applied within each settings file. */
function firstFileMatch(rules: Rule[], effect: Effect, call: Call, ctx: SimContext, file: string | undefined): Rule | undefined {
	const files = [...new Set(rules.filter(r => r.effect === effect).map(r => r.file))];
	for (const f of files) {
		let hit: Rule | undefined;
		for (const rule of rules.filter(r => r.effect === effect && r.file === f)) {
			const spec = parseRule(rule.pattern).spec?.trim() ?? '';
			if (spec.startsWith('!')) {
				// A carve-out cancels an earlier relative rule of this file, but cannot reopen a file inside a directory blocked as a whole.
				if (effect !== 'allow' && hit && isRelativeSpec(parseRule(hit.pattern).spec ?? '') && !/\/\*\*$/.test(parseRule(hit.pattern).spec ?? '') && matchesTool({ ...rule, pattern: `${parseRule(rule.pattern).tool}(${spec.slice(1)})` }, call, ctx, file)) {
					hit = undefined;
				}
				continue;
			}
			if (!hit && matchesTool(rule, call, ctx, file)) {
				hit = rule;
			}
		}
		if (hit) {
			return hit;
		}
	}
	return undefined;
}

function absolute(arg: string, ctx: SimContext): string {
	const a = arg.trim().replace(/^["']|["']$/g, '');
	if (/^[A-Za-z]:[\\/]/.test(a) || a.startsWith('/') || a.startsWith('\\\\')) {
		return posixPath(a);
	}
	if (a.startsWith('~/') || a === '~') {
		return joinPosix(posixPath(ctx.home), a.slice(2));
	}
	return joinPosix(posixPath(ctx.cwd), a);
}

/** Windows file systems ignore case, and so do the comparisons there. */
const sameCase = (ctx: SimContext) => /^[A-Za-z]:/.test(ctx.cwd);

function within(file: string, dir: string, ctx: SimContext) {
	const [f, d] = sameCase(ctx) ? [file.toLowerCase(), dir.toLowerCase()] : [file, dir];
	return f === d || f.startsWith(`${d === '/' ? '' : d}/`);
}

function inWorkingDirs(file: string, ctx: SimContext) {
	return [ctx.cwd, ...(ctx.additionalDirs ?? [])].map(posixPath).some(d => within(file, d, ctx));
}

/** The permission mode by its config name: `manual` is an alias of `default`. */
const modeOf = (ctx: SimContext) => ctx.mode === 'manual' || !ctx.mode ? 'default' : ctx.mode;
const MODE_LABEL: Record<string, string> = { default: 'Manual mode', acceptEdits: 'acceptEdits mode', plan: 'plan mode', auto: 'auto mode', dontAsk: 'dontAsk mode', bypassPermissions: 'bypassPermissions mode' };
const modeLabel = (ctx: SimContext) => MODE_LABEL[modeOf(ctx)] ?? `${modeOf(ctx)} mode`;

// ---------------------------------------------------------------------------------------------
// Checks no allow rule passes (Claude Code's permission-modes page: protected and critical paths; permissions: network paths)

const PROTECTED_DIRS = new Set(['.git', '.vscode', '.idea', '.husky', '.cargo', '.devcontainer', '.yarn', '.mvn', '.claude']);
const PROTECTED_FILES = new Set([
	'.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.bash_login', '.bash_aliases', '.bash_logout', '.zshrc', '.zprofile', '.zshenv', '.zlogin', '.zlogout', '.profile', '.envrc',
	'.npmrc', '.yarnrc', '.yarnrc.yml', '.pnp.cjs', '.pnp.loader.mjs', '.pnpmfile.cjs', 'bunfig.toml', '.bunfig.toml', '.bazelrc', '.bazelversion', '.bazeliskrc',
	'.pre-commit-config.yaml', 'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml', 'gradle-wrapper.properties', 'maven-wrapper.properties',
	'.devcontainer.json', '.ripgreprc', 'pyrightconfig.json', '.mcp.json', '.claude.json',
]);

/**
 * Why a write to `file` (absolute, POSIX) is never auto-approved, or undefined. The documented exceptions inside .claude
 * are kept: Claude's own worktrees, plan files, and the Markdown of auto memory and subagent memory.
 */
export function protectedWrite(file: string, ctx: SimContext): string | undefined {
	const segs = file.split('/').filter(Boolean);
	const lower = sameCase(ctx) ? segs.map(s => s.toLowerCase()) : segs;
	const name = lower[lower.length - 1] ?? '';
	if (PROTECTED_FILES.has(name)) {
		return name;
	}
	for (let i = 0; i < lower.length - 1; i++) {
		const s = lower[i];
		if (s === '.config' && lower[i + 1] === 'git') {
			return '.config/git';
		}
		if (!PROTECTED_DIRS.has(s)) {
			continue;
		}
		if (s === '.claude') {
			const rest = lower.slice(i + 1);
			const md = name.endsWith('.md');
			if (rest[0] === 'worktrees' || rest[0] === 'plans' || (rest[0] === 'agent-memory' && md) || (rest[0] === 'projects' && rest[2] === 'memory' && md)) {
				return undefined;
			}
		}
		return s;
	}
	return undefined;
}

/** What each mode does with a write to a protected path: the safety check runs before allow rules. */
function protectedVerdict(what: string, ctx: SimContext): Verdict {
	const v = (decision: Effect, reason: string): Verdict => ({ decision, reason, by: 'safety', notes: [] });
	const lead = `${what} is a protected path: no allow rule pre-approves writing it`;
	switch (modeOf(ctx)) {
		case 'bypassPermissions': return v('allow', `${what} is a protected path, but bypassPermissions mode skips the prompt`);
		case 'dontAsk': return v('deny', `${lead}, and dontAsk mode denies what would prompt`);
		case 'auto': return v('ask', `${lead}; in auto mode the classifier reviews it`);
		case 'plan': return v('ask', `${lead}; plan mode asks (it allows it only in a terminal session with bypass permissions available)`);
		default: return v('ask', `${lead}; ${modeLabel(ctx)} asks`);
	}
}

const unquote = (w: string) => w.replace(/^(["'])(.*)\1$/s, '$2');

/** The operands of a command: its words after the program, flags left out (everything after `--` is an operand). */
function operands(ws: string[]): string[] {
	const out: string[] = [];
	let flags = true;
	for (const w of ws.slice(1)) {
		if (flags && w === '--') {
			flags = false;
		} else if (!flags || !w.startsWith('-') || w === '-') {
			out.push(w);
		}
	}
	return out;
}

/** The POSIX path of a shell word, `~` and $HOME expanded; undefined when it depends on anything else the shell expands. */
function wordPath(word: string, ctx: SimContext, cwd = ctx.cwd): string | undefined {
	let w = unquote(word).replace(/^\$\{?HOME\}?(?=\/|$)/, '~');
	if (/[$`]/.test(w)) {
		return undefined;
	}
	if (w === '~' || w.startsWith('~/')) {
		w = `${posixPath(ctx.home)}/${w.slice(2)}`;
	}
	return absolute(w, { ...ctx, cwd });
}

/** `dir` and every directory above it, up to the root. */
function selfAndParents(dir: string): string[] {
	const out = [dir];
	for (let d = dir; d.lastIndexOf('/') > 0;) {
		d = d.slice(0, d.lastIndexOf('/'));
		out.push(d);
	}
	return [...out, '/'];
}

/**
 * The critical path an `rm` or `rmdir` targets, or undefined: the root, a top-level directory, the home directory, a
 * drive root or its top-level directories, the working directory or its parents, a glob under an additional directory
 * or its parents, and the shell forms that can expand to one of them (a glob under a variable, a substitution alone).
 */
export function criticalRemoval(command: string, ctx: SimContext): string | undefined {
	const w = words(command);
	const program = (w[0] ?? '').replace(/^.*\//, '');
	if (program !== 'rm' && program !== 'rmdir') {
		return undefined;
	}
	const recursive = w.some(x => /^-[a-zA-Z]*[rR]/.test(x) || x === '--recursive');
	const drives = sameCase(ctx);
	const home = posixPath(ctx.home);
	const cwd = posixPath(ctx.cwd);
	const eq = (a: string, b: string) => drives ? a.toLowerCase() === b.toLowerCase() : a === b;
	for (const raw of operands(w)) {
		const word = unquote(raw);
		if (/^\\+$/.test(word)) {
			return raw; // Git Bash reads a lone backslash as the current drive's root
		}
		// A glob or trailing slash right under a variable is a removal from the root when the variable expands empty.
		if (/^"?\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*|[0-9@*])"?\/(?:\*|$)/.test(raw)) {
			return raw;
		}
		if (recursive && /^"?\$\([^)]*\)"?$|^`[^`]*`$/.test(raw)) {
			return raw; // only the output of a substitution: what it names cannot be checked first
		}
		const glob = /\/\*$/.test(word);
		const target = wordPath(glob ? word.slice(0, -2) || '/' : word, ctx);
		if (target === undefined) {
			continue;
		}
		const depth = target.split('/').filter(Boolean).length;
		if (target === '/' || depth === 1 || eq(target, home) || (drives && depth === 2 && /^\/[a-z]\//i.test(target))) {
			return raw;
		}
		if (selfAndParents(cwd).some(d => eq(d, target))) {
			return raw;
		}
		if (glob && (ctx.additionalDirs ?? []).map(posixPath).some(dir => selfAndParents(dir).some(d => eq(d, target)))) {
			return raw;
		}
	}
	return undefined;
}

function criticalVerdict(target: string, ctx: SimContext): Verdict {
	const v = (decision: Effect, reason: string): Verdict => ({ decision, reason, by: 'safety', notes: [] });
	const lead = `Removes a critical path (${target}): no allow rule or hook approves that`;
	switch (modeOf(ctx)) {
		case 'dontAsk': return v('deny', `${lead}, and dontAsk mode denies it`);
		case 'auto': return v('ask', `${lead}; auto mode asks you in the terminal with a two-minute limit, and denies it where it cannot ask`);
		case 'bypassPermissions': return v('ask', `${lead}; even bypassPermissions mode asks`);
		default: return v('ask', `${lead}; ${modeLabel(ctx)} asks`);
	}
}

/** A path that can reach another computer: a UNC path, or a /net automount. Looking one up can send it your credentials. */
function isNetworkPath(arg: string): boolean {
	const a = arg.trim().replace(/^["']/, '');
	return (/^(?:\\\\|\/\/)[^\\/]/.test(a) && !/^\/\/[a-z]\//i.test(a)) || a.startsWith('/net/');
}

function networkVerdict(ctx: SimContext): Verdict {
	const v = (decision: Effect, reason: string): Verdict => ({ decision, reason, by: 'safety', notes: [] });
	switch (modeOf(ctx)) {
		case 'dontAsk': return v('deny', 'A read from a network path: dontAsk mode denies it');
		case 'bypassPermissions': return v('allow', 'A read from a network path: bypassPermissions mode skips the prompt');
		default: return v('ask', 'A read from a network path always asks: no allow rule (not even a bare Read) or hook pre-approves it, and auto mode leaves it to you');
	}
}

// ---------------------------------------------------------------------------------------------
// The permission mode

/** What the permission mode does with a call no rule decided. */
function byMode(call: Call, ctx: SimContext, file: string | undefined, readOnly: boolean): Verdict {
	const mode = modeOf(ctx);
	const v = (decision: Effect, reason: string, by: Verdict['by'] = 'mode'): Verdict => ({ decision, reason, by, notes: [] });
	const isEdit = EDIT_TOOLS.has(call.tool);
	const isRead = READ_TOOLS.has(call.tool);
	if (NO_PERMISSION.has(call.tool)) {
		return v('allow', `${call.tool} never asks for permission`, 'builtin');
	}
	if (isRead && file !== undefined && inWorkingDirs(file, ctx)) {
		return v('allow', 'Reads inside the working directories need no approval', 'builtin');
	}
	if (call.tool === 'Bash' && readOnly) {
		return v('allow', 'Built-in read-only command: runs without a prompt', 'builtin');
	}
	switch (mode) {
		case 'bypassPermissions':
			return v('allow', 'bypassPermissions mode skips the prompt');
		case 'dontAsk':
			return v('deny', 'dontAsk mode denies every call that would otherwise prompt');
		case 'plan':
			return isEdit ? v('deny', 'Plan mode does not edit files') : v('ask', 'No rule matches: plan mode asks');
		case 'acceptEdits':
			if (isEdit && file !== undefined && inWorkingDirs(file, ctx)) {
				return v('allow', 'acceptEdits mode accepts edits inside the working directories');
			}
			return v('ask', isEdit ? 'acceptEdits mode accepts edits only inside the working directories: this one asks' : 'No rule matches: acceptEdits mode asks for this');
		case 'auto':
			return v('ask', 'No rule matches: in auto mode a classifier reviews it instead of a prompt');
		default:
			return v('ask', `No rule matches: Claude Code asks (${modeLabel(ctx)})`);
	}
}

/** The filesystem commands acceptEdits mode accepts, for paths inside the working directories. */
const ACCEPT_EDITS_BASH = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'sed']);

/**
 * Whether acceptEdits mode runs this (stripped) command without asking: one of its filesystem commands, every path it
 * names inside the working directories, none protected, and no removal of a critical path. `cwd` follows a `cd` before it.
 */
function acceptEditsRuns(command: string, ctx: SimContext, cwd: string): boolean {
	const w = words(command);
	const program = w[0] ?? '';
	if (!ACCEPT_EDITS_BASH.has(program) || criticalRemoval(command, { ...ctx, cwd })) {
		return false;
	}
	let paths = operands(w);
	if (program === 'sed' && !w.some(x => x === '-e' || x === '-f' || /^--(?:expression|file)/.test(x))) {
		paths = paths.slice(1); // the first operand is the script
	}
	return paths.length > 0 && paths.every(p => {
		const abs = wordPath(p, ctx, cwd);
		return abs !== undefined && inWorkingDirs(abs, ctx) && !protectedWrite(abs, ctx);
	});
}

// ---------------------------------------------------------------------------------------------
// Deciding

const ruleReason = (rule: Rule, effect: Effect) => `${rule.pattern} in ${rule.scope} settings ${effect === 'deny' ? 'denies it; no allow rule can override a deny' : effect === 'ask' ? 'asks, even where an allow rule also matches' : 'allows it'}`;

/**
 * What Claude Code decides for `call` under `rules` (from every settings file) and the mode in `ctx`: deny, then ask,
 * then the checks no allow rule passes, then allow, then the read-only set and the mode.
 */
export function simulate(call: Call, rules: Rule[], ctx: SimContext): Verdict {
	const notes = [...new Set(rules.map(ruleProblem).filter((x): x is string => !!x)), ...paramNotes(rules, call)];
	if (call.tool === 'Bash' || call.tool === 'PowerShell') {
		return simulateBash(call, rules, ctx, notes);
	}
	const fileTool = EDIT_TOOLS.has(call.tool) || READ_TOOLS.has(call.tool);
	const file = fileTool && call.arg.trim() ? absolute(call.arg, ctx) : undefined;
	const match = (effect: Effect) => firstParamMatch(rules, effect, call)
		?? (fileTool ? firstFileMatch(rules, effect, call, ctx, file) : rules.find(r => r.effect === effect && matchesTool(r, call, ctx, file)));
	for (const effect of ['deny', 'ask'] as const) {
		const rule = match(effect);
		if (rule) {
			return { decision: effect, rule, by: 'rule', notes, reason: ruleReason(rule, effect) };
		}
	}
	const guarded = file !== undefined && EDIT_TOOLS.has(call.tool) ? protectedWrite(file, ctx) : undefined;
	const safety = guarded ? protectedVerdict(guarded, ctx)
		: READ_TOOLS.has(call.tool) && isNetworkPath(call.arg) ? networkVerdict(ctx) : undefined;
	if (safety) {
		return { ...safety, notes };
	}
	const rule = match('allow');
	if (rule) {
		return { decision: 'allow', rule, by: 'rule', notes, reason: ruleReason(rule, 'allow') };
	}
	const v = byMode(call, ctx, file, false);
	return { ...v, notes: [...notes, ...v.notes] };
}

const programOf = (command: string) => (words(command)[0] ?? '').replace(/^.*\//, '');

function simulateBash(call: Call, rules: Rule[], ctx: SimContext, notes: string[]): Verdict {
	const tool = call.tool;
	// Here-document bodies are data: their lines are not commands (PowerShell has none).
	const text = tool === 'Bash' ? stripHeredocs(call.arg) : call.arg;
	const split = splitCompound(text);
	// The parts that run something, loop and conditional keywords taken off; a loop header or `done` runs nothing.
	const parts = (split ?? [text.trim()]).map(commandOfPart).filter((x): x is string => !!x);
	if (!parts.length) {
		parts.push(text.trim());
	}
	const bashRules = rules.filter(r => {
		const p = parseRule(r.pattern);
		return (p.tool === tool || (p.tool.includes('*') && r.effect !== 'allow' && globAll(p.tool).test(tool))) && !isParamRule(p) && !ruleProblem(r);
	});
	const spec = (r: Rule) => parseRule(r.pattern).tool.includes('*') ? undefined : parseRule(r.pattern).spec;
	// Deny and ask reach every subcommand, nested ones and loop bodies included, past any environment assignment.
	const powershell = tool === 'PowerShell';
	const reach = [...new Set([...parts, ...parts.flatMap(p => allNested(p, powershell)).map(commandOfPart).filter((x): x is string => !!x)])];
	for (const effect of ['deny', 'ask'] as const) {
		const param = firstParamMatch(rules, effect, call);
		if (param) {
			return { decision: effect, rule: param, by: 'rule', notes, reason: ruleReason(param, effect) };
		}
		for (const part of reach) {
			const cmd = stripWrappers(part, false).command;
			const rule = bashRules.find(r => r.effect === effect && bashMatches(spec(r), cmd));
			if (rule) {
				return {
					decision: effect, rule, by: 'rule', notes,
					reason: `${rule.pattern} in ${rule.scope} settings ${effect === 'deny' ? 'denies' : 'asks for'} ${parts.length > 1 || part !== parts[0] ? `the part "${part}"` : 'it'}${effect === 'deny' ? '; no allow rule can override a deny' : ''}`,
					parts: parts.map(p => ({ command: p, decision: p === part ? effect : 'none' })),
				};
			}
		}
	}
	// No allow rule, hook or mode approves removing a critical path, wherever in the command the removal sits.
	for (const part of reach) {
		const target = criticalRemoval(stripWrappers(part, false).command, ctx);
		if (target) {
			const v = criticalVerdict(target, ctx);
			return { ...v, notes, parts: parts.map(p => ({ command: p, decision: p === part ? v.decision : 'none' })) };
		}
	}
	if (!split) {
		notes.push('An operator with nothing after it (like a trailing &&) makes the command unparseable: no allow rule approves it');
	}
	// A `cd` moves where the parts after it run. Into a working directory it is read-only on its own; combined with git it
	// asks when it changes directory (git there can run that directory's hooks); outside the working directories it asks.
	let dir = posixPath(ctx.cwd);
	let moved = false;
	const cwdOf: string[] = [];
	const cdOk: boolean[] = [];
	for (const part of parts) {
		cwdOf.push(dir);
		const w = words(stripWrappers(part, true).command);
		if (w[0] !== 'cd') {
			cdOk.push(true);
			continue;
		}
		const target = w[1] === undefined ? posixPath(ctx.home) : wordPath(w[1], ctx, dir);
		cdOk.push(target !== undefined && inWorkingDirs(target, ctx));
		if (target === undefined || !within(target, dir, ctx) || !within(dir, target, ctx)) {
			moved = true;
		}
		dir = target ?? dir;
	}
	const gitAfterCd = moved && parts.some(p => programOf(stripWrappers(p, true).command) === 'git');
	if (gitAfterCd) {
		notes.push('A cd into another directory combined with git asks even when each part is read-only: git there can run that directory\'s hooks');
	}
	const acceptEdits = modeOf(ctx) === 'acceptEdits';
	const nestedRows: NonNullable<Verdict['parts']> = [];
	const results = parts.map((part, i) => {
		const { command, unsafeEnv } = stripWrappers(part, true);
		// A part that runs nested commands is approved only by an allow rule for the part itself, and only when every nested
		// command is allowed on its own: each one goes through the whole decision (rules, safety checks, read-only set,
		// mode), and the most restrictive answer wins. The read-only set and acceptEdits never cover such a part.
		// Read past wrappers and keywords, so `time (npm publish)` counts as running a subshell.
		const subs = substitutions(stripWrappers(part, false).command, powershell);
		const hasNested = !subs.ok || subs.bodies.length > 0;
		let nestedOk = subs.ok;
		for (const body of subs.bodies) {
			const v = simulateBash({ tool, arg: body }, rules, ctx, []);
			nestedRows.push({ command: `↳ ${body}`, decision: v.decision, rule: v.rule });
			nestedOk &&= v.decision === 'allow';
		}
		const rule = !split || unsafeEnv || !nestedOk ? undefined : bashRules.find(r => r.effect === 'allow' && bashMatches(spec(r), command)
			&& !(prefixCannotApprove(command) && (spec(r) ?? '*').includes('*')));
		const program = programOf(command);
		const readOnly = !!split && !unsafeEnv && !hasNested && tool === 'Bash' && isReadOnlyCommand(command) && cdOk[i] && !(gitAfterCd && (program === 'git' || program === 'cd'));
		const edit = !!split && !unsafeEnv && !hasNested && tool === 'Bash' && acceptEdits && acceptEditsRuns(command, ctx, cwdOf[i]);
		if (hasNested) {
			notes.push(subs.ok
				? `"${part}" runs nested commands: an allow rule must cover it and each nested command must be allowed on its own; the built-in read-only set never covers it`
				: `"${part}" has a substitution that is never closed: no allow rule approves it`);
		}
		if (unsafeEnv) {
			notes.push(`"${part}" starts with an environment assignment that is not on Claude Code's safe list, so allow rules do not match it`);
		}
		if (prefixCannotApprove(command) && !rule) {
			notes.push(`"${command}" runs other commands (an exec wrapper or find with an action): only an exact rule can approve it`);
		}
		if (program === 'cd' && !cdOk[i]) {
			notes.push(`"${part}" moves outside the working directories: it asks (approving it adds a Read rule for that path)`);
		}
		return { command: part, rule, readOnly, edit };
	});
	if (results.every(r => r.rule || r.readOnly || r.edit)) {
		const decided = results.find(r => r.rule);
		if (decided?.rule && results.every(r => r.rule || r.readOnly)) {
			return {
				decision: 'allow', rule: decided.rule, by: 'rule', notes,
				reason: results.length > 1 ? `Every part is allowed (${[...new Set(results.map(r => r.rule?.pattern ?? 'read-only'))].join(', ')})` : `${decided.rule.pattern} in ${decided.rule.scope} settings allows it`,
				parts: [...results.map(r => ({ command: r.command, decision: 'allow' as const, rule: r.rule })), ...nestedRows],
			};
		}
		if (results.some(r => r.edit && !r.rule && !r.readOnly)) {
			return {
				decision: 'allow', by: 'mode', notes, rule: decided?.rule,
				reason: 'acceptEdits mode accepts its filesystem commands (mkdir, touch, rm, rmdir, mv, cp, sed) for paths inside the working directories',
				parts: results.map(r => ({ command: r.command, decision: 'allow', rule: r.rule })),
			};
		}
		const v = byMode(call, ctx, undefined, true);
		return { ...v, notes: [...notes, ...v.notes], parts: results.map(r => ({ command: r.command, decision: 'allow' })) };
	}
	const missing = results.filter(r => !r.rule && !r.readOnly && !r.edit);
	const v = byMode(call, ctx, undefined, false);
	const blockedNested = nestedRows.find(r => r.decision !== 'allow');
	return {
		...v,
		reason: blockedNested ? `${v.reason} (the nested command "${blockedNested.command.slice(2)}" is not allowed on its own, so nothing approves the command around it)`
			: results.length > 1 ? `${v.reason} (no allow rule covers "${missing[0].command}"; each part must be allowed on its own)` : v.reason,
		notes: [...notes, ...v.notes],
		parts: [...results.map(r => ({ command: r.command, decision: r.rule || r.readOnly || r.edit ? 'allow' as const : 'none' as const, rule: r.rule })), ...nestedRows],
	};
}

// ---------------------------------------------------------------------------------------------
// Codex

export interface CodexConfig {
	approval_policy?: string;
	sandbox_mode?: string;
}

/** Top-level `approval_policy` and `sandbox_mode` from a Codex config.toml (profiles are not followed). */
export function codexConfig(toml: string): CodexConfig {
	const out: CodexConfig = {};
	for (const line of toml.split(/\r?\n/)) {
		if (/^\s*\[/.test(line)) {
			break; // the first table ends the top-level keys
		}
		const m = /^\s*(approval_policy|sandbox_mode)\s*=\s*["']([^"']+)["']/.exec(line);
		if (m) {
			out[m[1] as keyof CodexConfig] = m[2];
		}
	}
	return out;
}

/** Codex's coarser model: the sandbox bounds what runs, the approval policy when it asks. Approximate by design. */
export function simulateCodex(call: Call, cfg: CodexConfig, ctx: SimContext): Verdict {
	const approval = cfg.approval_policy ?? 'on-request';
	const sandbox = cfg.sandbox_mode ?? 'workspace-write';
	const notes = [`Codex: approval_policy ${approval}${cfg.approval_policy ? '' : ' (default)'}, sandbox_mode ${sandbox}${cfg.sandbox_mode ? '' : ' (default)'}. Codex decides per command at run time; this is an approximation.`];
	const v = (decision: Effect, reason: string): Verdict => ({ decision, reason, by: 'mode', notes });
	const isEdit = EDIT_TOOLS.has(call.tool);
	const writes = isEdit || (call.tool === 'Bash' && !isReadOnlyCommand(call.arg));
	const inside = !isEdit || inWorkingDirs(absolute(call.arg, ctx), ctx);
	if (READ_TOOLS.has(call.tool) || (call.tool === 'Bash' && isReadOnlyCommand(call.arg) && approval !== 'untrusted')) {
		return v('allow', 'Reads run inside every sandbox mode without asking');
	}
	if (sandbox === 'danger-full-access') {
		return approval === 'untrusted' ? v('ask', 'untrusted: Codex asks before any command it does not know to be safe') : v('allow', 'danger-full-access: no sandbox, and this approval policy does not ask');
	}
	if (approval === 'never') {
		return writes && (sandbox === 'read-only' || !inside) ? v('deny', `never asks, so a write the ${sandbox} sandbox blocks simply fails`) : v('allow', `Runs inside the ${sandbox} sandbox without asking`);
	}
	if (approval === 'untrusted') {
		return v('ask', 'untrusted: Codex asks before any command it does not know to be safe');
	}
	if (sandbox === 'read-only' && writes) {
		return v('ask', 'The read-only sandbox blocks writes: Codex asks to run it outside the sandbox');
	}
	if (!inside) {
		return v('ask', 'Outside the workspace the workspace-write sandbox blocks it: Codex asks');
	}
	return approval === 'on-failure'
		? v('allow', 'Runs in the sandbox; Codex asks only if it fails there')
		: v('allow', 'Runs in the workspace-write sandbox (no network); Codex asks only when it wants to leave it');
}

/** Claude Code's permission modes, in the order the simulator's selector lists them. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;

export interface ResolvedMode {
	mode: string;
	/** Who said so: the person on the page, a running session, the settings, or Claude Code's own default. */
	source: 'override' | 'session' | 'settings' | 'builtin';
	/** The line shown above the simulator. */
	text: string;
	/** False when a session reported the mode: the verdict is then not an assumption. */
	assumed: boolean;
}

/**
 * The permission mode the simulator runs in. A mode chosen on the page wins, then the one the newest session reported
 * (a session can start in another mode or switch with Shift+Tab), then `defaultMode` as the settings apply it, then
 * Claude Code's built-in default. An override that is not a known mode is ignored, so a message from the page cannot
 * put the simulator in a mode that does not exist.
 */
export function resolveMode(sessionMode: string | undefined, defaultMode: string | undefined, override?: string, builtinNote?: string): ResolvedMode {
	if (override && (PERMISSION_MODES as readonly string[]).includes(override)) {
		return { mode: override, source: 'override', text: `Assuming mode: ${override} (chosen on this page)`, assumed: true };
	}
	if (sessionMode) {
		return { mode: sessionMode, source: 'session', text: `Session reported: ${sessionMode}`, assumed: false };
	}
	if (defaultMode) {
		return { mode: defaultMode, source: 'settings', text: `Assuming mode: ${defaultMode} (settings defaultMode)`, assumed: true };
	}
	return { mode: 'auto', source: 'builtin', text: `Assuming mode: auto (built-in default since v2.1.283${builtinNote ? `; ${builtinNote}` : ''})`, assumed: true };
}
