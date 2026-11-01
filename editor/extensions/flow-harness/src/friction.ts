/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the friction inbox. What keeps going wrong between you and your agents, turned
 *  into a fix you can review: a correction you keep typing ("don't use X", "always run Y", in
 *  English or Turkish) becomes a proposed CLAUDE.md / AGENTS.md line; a tool call that keeps
 *  failing the same way becomes a proposed guard hook. Each proposal carries its evidence: which
 *  prompts or failures, and how often. Pure (no vscode), so the clustering is tested on its own.
 *--------------------------------------------------------------------------------------------*/

export interface PromptRecord {
	text: string;
	at: number;
	cli: string;
	session?: string;
}

export interface FailureRecord {
	tool: string;
	/** The command (Bash) or the path, bounded. */
	subject: string;
	error: string;
	at: number;
	cli: string;
	session?: string;
}

export interface Evidence {
	text: string;
	at: number;
	session?: string;
}

export interface Proposal {
	/** Stable across runs, so a dismissed proposal stays dismissed. */
	id: string;
	kind: 'instruction' | 'hook';
	title: string;
	/** The line to add (instruction) or the reason the guard gives the agent (hook). */
	text: string;
	/** Which file it belongs in: CLAUDE.md for Claude sessions, AGENTS.md for Codex. */
	targets: ('CLAUDE.md' | 'AGENTS.md')[];
	evidence: Evidence[];
	/** Hooks: the tool and the command prefix the guard matches. */
	tool?: string;
	prefix?: string;
	/** Set when the instructions already say this: the line is there, yet the correction keeps coming. */
	covered?: boolean;
}

/** A sentence that tells the agent what (not) to do: imperatives, prohibitions and "instead of" corrections. */
const CORRECTION = [
	/\b(?:don'?t|do not|never|stop|avoid|no need to|quit|please don'?t|shouldn'?t|should not|must not|mustn'?t)\b/i,
	/\b(?:always|make sure(?: to| that)?|remember to|be sure to|use \S+ instead|instead of|rather than)\b/i,
	// Turkish: never / always / don't forget, and the common "don't …" verb forms.
	/(?:^|[\s,])(?:asla|hiçbir zaman|her zaman|daima|unutma|sakın|yerine)(?=[\s,.!]|$)/i,
	/(?:^|\s)\S+\s+(?:kullanma|yapma|etme|atma|silme|yazma|ekleme|değiştirme|çalıştırma|açma|bozma|dokunma|koyma|gönderme)(?=[\s,.!]|$)/i,
];
/** Prompts that only quote a correction back, or talk about the agent's last answer, are not standing instructions. */
const NOT_STANDING = /\?\s*$|^(?:why|neden|niye)\b/i;

const STOP = new Set(('the a an to of and or in on for with is are be it this that you your me my we our i please just also again here there now any ever do ' +
	'bir ve ile bu şu o da de mi mı için gibi daha çok lütfen ben sen biz siz ama fakat yani artık hep tekrar yine burada şimdi').split(' '));

/** Lowercased words that carry the meaning, accents and punctuation aside. */
export function signature(sentence: string): string[] {
	// "don't", "do not" and "never" say the same thing; the wording must not split one correction into two.
	const plain = sentence.toLocaleLowerCase('tr').replace(/\b(?:do\s+not|don'?t|dont|does\s+not|doesn'?t|never)\b/g, ' not ');
	return [...new Set(plain.replace(/[`'"“”‘’()[\]{}<>.,;:!?*]/g, ' ').split(/\s+/)
		.map(w => w.replace(/^-+|-+$/g, '')).filter(w => w.length > 1 && !STOP.has(w)))];
}

const jaccard = (a: string[], b: string[]) => {
	const sb = new Set(b);
	const inter = a.filter(x => sb.has(x)).length;
	return inter / (new Set([...a, ...b]).size || 1);
};

/** The corrections in one prompt: sentences that read as a standing instruction. */
export function corrections(prompt: string): string[] {
	// Pasted text, code and quoted lines are someone else's words (an agent's output, a log), not the person's instruction.
	const own = prompt
		.replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/g, '\n')
		.replace(/```[\s\S]*?(?:```|$)/g, '\n')
		.replace(/^\s*>.*$/gm, '');
	return own.split(/(?<=[.!?])\s+|\r?\n+/).map(s => s.trim().replace(/^[-*•]\s*/, ''))
		.filter(s => s.length >= 6 && s.length <= 220 && !NOT_STANDING.test(s) && CORRECTION.some(re => re.test(s)) && signature(s).length >= 2);
}

function hash(s: string) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	}
	return (h >>> 0).toString(36);
}

const targetsOf = (clis: string[]) => {
	const t: Proposal['targets'] = [];
	if (clis.some(c => c !== 'codex')) {
		t.push('CLAUDE.md');
	}
	if (clis.includes('codex')) {
		t.push('AGENTS.md');
	}
	return t;
};

/** A correction as a line for an instructions file: first letter up, a full stop at the end. */
export function asInstruction(sentence: string): string {
	const s = sentence.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '');
	return `${s.charAt(0).toLocaleUpperCase('tr')}${s.slice(1)}.`;
}

/**
 * Corrections that came back at least `min` times, in at least two separate prompts, grouped by meaning (word overlap).
 * `instructions` is the text the agents already read: a proposal it already covers is marked, not dropped.
 */
export function correctionProposals(prompts: readonly PromptRecord[], instructions = '', min = 2): Proposal[] {
	type Cluster = { sig: string[]; items: (Evidence & { sentence: string; cli: string; prompt: number })[] };
	const clusters: Cluster[] = [];
	// The same prompt twice (an event and its transcript, a resumed session) is one prompt, not a repeat.
	const unique = prompts.filter((p, i) => !prompts.slice(0, i).some(q => q.text === p.text && Math.abs(q.at - p.at) < 5000));
	unique.forEach((p, index) => {
		for (const sentence of corrections(p.text)) {
			const sig = signature(sentence);
			const home = clusters.find(c => jaccard(c.sig, sig) >= 0.5);
			const item = { text: p.text.slice(0, 400), at: p.at, session: p.session, sentence, cli: p.cli, prompt: index };
			if (home) {
				home.items.push(item);
				home.sig = [...new Set([...home.sig, ...sig])].filter(w => home.items.filter(i => signature(i.sentence).includes(w)).length * 2 >= home.items.length);
			} else {
				clusters.push({ sig, items: [item] });
			}
		}
	});
	const known = new Set(signature(instructions));
	return clusters
		.filter(c => c.items.length >= min && new Set(c.items.map(i => i.prompt)).size >= 2)
		.map(c => {
			// The wording closest to what the cluster shares, and of those the shortest, says it most plainly.
			const fit = (x: string) => jaccard(signature(x), c.sig);
			const best = [...c.items].sort((a, b) => fit(b.sentence) - fit(a.sentence) || a.sentence.length - b.sentence.length)[0].sentence;
			const sig = signature(best);
			return {
				id: `fix:${hash(sig.slice().sort().join(' '))}`,
				kind: 'instruction' as const,
				title: `You said this ${c.items.length} times: "${best.length > 70 ? `${best.slice(0, 67)}…` : best}"`,
				text: asInstruction(best),
				targets: targetsOf(c.items.map(i => i.cli)),
				evidence: c.items.map(i => ({ text: i.text, at: i.at, session: i.session })).sort((a, b) => b.at - a.at),
				covered: sig.length > 0 && sig.filter(w => known.has(w)).length / sig.length >= 0.8,
			};
		})
		.sort((a, b) => b.evidence.length - a.evidence.length);
}

/** An error reduced to what stays the same between two runs: no paths, numbers, quoted values or ids. */
export function errorShape(error: string): string {
	const first = error.split(/\r?\n/).map(l => l.trim()).find(l => l && !/^exit code \d+$/i.test(l)) ?? error.trim();
	return first.toLowerCase()
		.replace(/(?:[a-z]:)?[\\/][^\s'"`:]+/gi, '<path>')
		.replace(/(["'`]).*?\1/g, '<q>')
		.replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b/g, '<id>')
		.replace(/\d+/g, '<n>')
		.replace(/\s+/g, ' ')
		.slice(0, 120);
}

/** Shell operators that end one command and start the next: `a|b`, `a && b`, `a; b`. */
const OPERATOR = /\|\||&&|[|;&\n]/;

/**
 * The words of a command that say what it is: `npm test`, `git push`, `dotnet build`. Only the first command of a
 * pipeline or list counts, and the second word only when it is a plain word (a subcommand), never an argument with
 * an operator, a path or a quote in it: `cat foo|grep x` is `cat foo`, never `cat foo|grep`.
 */
export function commandHead(command: string): string {
	const first = command.trim().replace(/^(?:\w+=\S*\s+)+/, '').split(OPERATOR)[0].trim();
	const words = first.split(/\s+/);
	const program = (words[0] ?? '').replace(/^.*[\\/]/, '');
	// A loop or a condition is not a command a guard could stop: `for n in …` has no head.
	if (!/^[\w.+-]+$/.test(program) || /^(?:for|while|until|if|case|do|then|select|function)$/.test(program)) {
		return '';
	}
	const second = words[1] && /^[a-z][\w-]*$/i.test(words[1]) ? ` ${words[1]}` : '';
	return `${program}${second}`.trim();
}

/** A failure that says the person stopped it, not that the tool cannot work. */
const NOT_A_FAILURE = /doesn't want to proceed|rejected|interrupted|user denied|permission (?:to use .* |for this action )?(?:was|has been) denied|denied by the .*classifier|cancel+ed/i;

/** Tool calls that failed the same way at least `min` times: a guard hook for commands, an instruction line for other tools. */
export function failureProposals(failures: readonly FailureRecord[], min = 3): Proposal[] {
	const groups = new Map<string, FailureRecord[]>();
	for (const f of failures) {
		if (NOT_A_FAILURE.test(f.error) || !f.error.trim()) {
			continue;
		}
		const head = f.tool === 'Bash' ? commandHead(f.subject) : '';
		// JSON, not a joined string: a head may hold any character, a `|` included.
		const key = JSON.stringify([f.tool, head, errorShape(f.error)]);
		groups.set(key, [...(groups.get(key) ?? []), f]);
	}
	const out: Proposal[] = [];
	for (const [key, list] of groups) {
		if (list.length < min) {
			continue;
		}
		const [tool, head] = JSON.parse(key) as [string, string];
		const sample = list[list.length - 1].error.split(/\r?\n/).map(l => l.trim()).find(l => l && !/^exit code \d+$/i.test(l)) ?? list[0].error;
		const short = sample.length > 140 ? `${sample.slice(0, 137)}…` : sample;
		const evidence = list.map(f => ({ text: `${f.subject ? `${f.subject.slice(0, 200)}\n` : ''}${f.error.slice(0, 300)}`, at: f.at, session: f.session })).sort((a, b) => b.at - a.at);
		// A one-word head would stop every use of the program (`cat`, `ls -la`): a guard only when it failed run bare.
		const narrow = head.includes(' ') || list.every(f => f.subject.trim() === head);
		if (tool === 'Bash' && head && narrow) {
			out.push({
				id: `hook:${hash(key)}`, kind: 'hook', tool, prefix: head,
				title: `\`${head}\` failed ${list.length} times with the same error`,
				text: `\`${head}\` keeps failing in this project with "${short}". Before running it again, <say what to do instead>.`,
				targets: targetsOf(list.map(f => f.cli)), evidence,
			});
		} else {
			out.push({
				id: `fail:${hash(key)}`, kind: 'instruction', tool,
				title: `${tool} failed ${list.length} times with the same error`,
				text: `${tool} keeps failing here with "${short}": <say how to avoid it>.`,
				targets: targetsOf(list.map(f => f.cli)), evidence,
			});
		}
	}
	return out.sort((a, b) => b.evidence.length - a.evidence.length);
}

/** The guard hook script for a proposal: a PreToolUse hook that stops `prefix` commands and tells the agent why (exit 2). */
export function guardScript(prefix: string, reason: string): string {
	// The prefix and reason sit on lines of their own as JSON: scanGuards reads them back from here, so the list needs no state file.
	return `// PreToolUse (Bash): written by Insilode's friction inbox. Stops \`${prefix.replace(/[\r\n`]+/g, ' ')}\` before it fails the same way again; exit 2 sends the reason back to the agent.
let input = ''
process.stdin.on('data', d => input += d)
process.stdin.on('end', () => {
	let command = ''
	try {
		command = String(JSON.parse(input || '{}').tool_input?.command ?? '')
	} catch {
		process.exit(0)
	}
	const prefix = ${JSON.stringify(prefix)}
	const reason = ${JSON.stringify(reason)}
	// The words of one command, its leading VAR=value assignments taken off and its program name without the folder.
	const words = part => {
		const w = part.trim().replace(/^(?:\\w+=\\S*\\s+)+/, '').split(/\\s+/).filter(Boolean)
		if (w[0]) w[0] = w[0].replace(/^.*[\\\\/]/, '')
		return w
	}
	const wanted = words(prefix)
	// Every command of a pipeline or list. A bare program (\`git\`) stops only that program run bare, never \`git status\`;
	// a prefix of two or more words (\`git push\`) stops the commands that start with exactly those words.
	const hit = command.split(/\\|\\||&&|[|;&\\n]/).some(part => {
		const w = words(part)
		return wanted.length === 1 ? w.length === 1 && w[0] === wanted[0] : wanted.every((x, i) => w[i] === x)
	})
	if (hit) {
		process.stderr.write('Insilode guard stopped "' + prefix + '": ' + reason + '\\nRemove this guard in the Insilode Harness view (Friction inbox, Guards Insilode added).\\n')
		process.exit(2)
	}
})
`;
}

/** The command line that runs a guard script from the project's settings. */
export const guardCommand = (fileName: string) => `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${fileName}"`;

/**
 * Adds a PreToolUse Bash entry that runs `command` to `settings`, unless one runs it already: a second guard for the
 * same command replaces the script and keeps one entry. Throws, so the user is told, when `hooks` has another shape.
 */
export function addGuardHook(settings: Record<string, unknown>, command: string): void {
	const hooks = settings.hooks ?? (settings.hooks = {});
	if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
		throw new Error('"hooks" is not an object');
	}
	const h = hooks as Record<string, unknown>;
	const pre = h.PreToolUse ?? (h.PreToolUse = []);
	if (!Array.isArray(pre)) {
		throw new Error('"hooks.PreToolUse" is not a list');
	}
	const runs = pre.some(e => {
		const list = (e as { hooks?: unknown } | null)?.hooks;
		return Array.isArray(list) && list.some(x => (x as { command?: unknown } | null)?.command === command);
	});
	if (!runs) {
		pre.push({ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 10 }] });
	}
}

/** `text` (an instruction file, empty when it does not exist yet) with `line` added at its end; a new file starts with a heading. */
export function appendInstruction(text: string, line: string): string {
	if (!text) {
		return `# Project instructions\n\n${line}\n`;
	}
	return `${text}${text.endsWith('\n') ? '' : '\n'}${line}\n`;
}

/** A file name for a guard script: `insilode-guard-npm-test.mjs`. */
export const guardFileName = (prefix: string) => `insilode-guard-${prefix.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'command'}.mjs`;

/**
 * Secrets that end up in prompts and commands (a pasted token, `export API_KEY=…`) are blanked before anything is stored,
 * so the inbox never keeps one on disk or shows one in a tooltip.
 */
export function redact(text: string): string {
	return text
		.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<secret>')
		.replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abpr])[-_][A-Za-z0-9_-]{16,}/g, '<secret>')
		.replace(/\bAKIA[0-9A-Z]{16}\b/g, '<secret>')
		.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<secret>')
		.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <secret>')
		.replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?))\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=<secret>')
		.replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=<secret>');
}

/** Said next to the shared choice: a guard in the committed settings reaches every clone, not only this machine. */
export const SHARED_GUARD_WARNING = 'Blocks the command for everyone who pulls this file';

export interface GuardTarget {
	id: 'local' | 'shared';
	label: string;
	detail: string;
	/** Relative to the project root. */
	file: string;
	/** Set when the choice affects more people than the user: shown with a warning. */
	warning?: string;
}

/** Where a guard hook can be registered. The first one is the default: a guard that stops a command is no one else's decision until the user says so. */
export const GUARD_TARGETS: readonly GuardTarget[] = [
	{ id: 'local', label: 'This machine only (.claude/settings.local.json)', detail: 'Not shared and not committed: only you are affected', file: '.claude/settings.local.json' },
	{ id: 'shared', label: 'Share with the team (.claude/settings.json)', detail: 'Committed with the project', file: '.claude/settings.json', warning: SHARED_GUARD_WARNING },
];

export const defaultGuardTarget = (): GuardTarget => GUARD_TARGETS[0];

/** Matches the script a guard runs, wherever the settings entry's command puts the hooks folder. */
const GUARD_NAME = /insilode-guard-[A-Za-z0-9-]+\.mjs/;

/** The guard script a hook command runs, or undefined when the command is some other hook. */
export function guardNameOf(command: unknown): string | undefined {
	return typeof command === 'string' ? GUARD_NAME.exec(command)?.[0] : undefined;
}

export interface GuardInfo {
	/** The script's file name: what ties the settings entries to the script. */
	name: string;
	prefix: string;
	reason: string;
	/** The settings files that run it. */
	files: ('local' | 'shared')[];
	scriptExists: boolean;
}

/** The prefix and reason a guard script was written with, or undefined for a script that is not one of ours. */
export function parseGuardScript(source: string): { prefix: string; reason: string } | undefined {
	const read = (key: string) => {
		const m = new RegExp(`^\\s*const ${key} = (".*")\\s*$`, 'm').exec(source);
		try {
			return m ? JSON.parse(m[1]) as unknown : undefined;
		} catch {
			return undefined;
		}
	};
	const prefix = read('prefix');
	const reason = read('reason');
	// Scripts written before the reason had a line of its own only carry the prefix.
	return typeof prefix === 'string' ? { prefix, reason: typeof reason === 'string' ? reason : '' } : undefined;
}

/** The guard scripts a settings file's PreToolUse hooks run; a file that is not a JSON object has none. */
export function guardNamesIn(settingsText: string): string[] {
	let data: unknown;
	try {
		data = JSON.parse(settingsText);
	} catch {
		return [];
	}
	const pre = (data as { hooks?: { PreToolUse?: unknown } } | null)?.hooks?.PreToolUse;
	if (!Array.isArray(pre)) {
		return [];
	}
	const names = new Set<string>();
	for (const entry of pre) {
		const list = (entry as { hooks?: unknown } | null)?.hooks;
		for (const h of Array.isArray(list) ? list : []) {
			const name = guardNameOf((h as { command?: unknown } | null)?.command);
			if (name) {
				names.add(name);
			}
		}
	}
	return [...names];
}

/** The command a guard script file name stands for, for a guard whose script is gone: `insilode-guard-npm-test.mjs` reads as `npm test`. */
const prefixFromName = (name: string) => name.replace(/^insilode-guard-/, '').replace(/\.mjs$/, '').replace(/-/g, ' ');

/**
 * Every guard Insilode added: the settings entries that run an `insilode-guard-*.mjs` script and the scripts in
 * `.claude/hooks`, joined by file name. A script nobody runs and an entry whose script is gone are listed too.
 */
export function scanGuards(settings: readonly { scope: 'local' | 'shared'; text: string }[], scripts: readonly { name: string; text: string }[]): GuardInfo[] {
	const byName = new Map<string, GuardInfo>();
	const entry = (name: string) => {
		let g = byName.get(name);
		if (!g) {
			const script = scripts.find(s => s.name === name);
			const parsed = script && parseGuardScript(script.text);
			g = { name, prefix: parsed?.prefix ?? prefixFromName(name), reason: parsed?.reason ?? '', files: [], scriptExists: !!script };
			byName.set(name, g);
		}
		return g;
	};
	for (const s of scripts) {
		if (GUARD_NAME.test(s.name)) {
			entry(s.name);
		}
	}
	for (const s of settings) {
		for (const name of guardNamesIn(s.text)) {
			entry(name).files.push(s.scope);
		}
	}
	return [...byName.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}

/**
 * Takes the hook entries that run guard script `name` out of `settings`, and the lists they leave empty. Returns whether
 * anything was removed; throws, so the user is told, when `hooks` has another shape. Other hooks stay as they are.
 */
export function removeGuardHook(settings: Record<string, unknown>, name: string): boolean {
	const hooks = settings.hooks;
	if (hooks === undefined || hooks === null) {
		return false;
	}
	if (typeof hooks !== 'object' || Array.isArray(hooks)) {
		throw new Error('"hooks" is not an object');
	}
	const h = hooks as Record<string, unknown>;
	const pre = h.PreToolUse;
	if (pre === undefined) {
		return false;
	}
	if (!Array.isArray(pre)) {
		throw new Error('"hooks.PreToolUse" is not a list');
	}
	let removed = false;
	const kept: unknown[] = [];
	for (const e of pre) {
		const list = (e as { hooks?: unknown } | null)?.hooks;
		if (!Array.isArray(list)) {
			kept.push(e);
			continue;
		}
		const rest = list.filter(x => guardNameOf((x as { command?: unknown } | null)?.command) !== name);
		if (rest.length === list.length) {
			kept.push(e);
			continue;
		}
		removed = true;
		// An entry that only ran the guard goes with it; one that runs other hooks too keeps them.
		if (rest.length) {
			kept.push({ ...(e as object), hooks: rest });
		}
	}
	if (removed) {
		if (kept.length) {
			h.PreToolUse = kept;
		} else {
			delete h.PreToolUse;
			if (!Object.keys(h).length) {
				delete settings.hooks;
			}
		}
	}
	return removed;
}

/** `source` (a settings file) without the entries that run guard `name`, written as the settings changes are; unchanged when it has none. Throws on JSON that is not an object. */
export function removeGuardFromText(source: string, name: string): string {
	if (!source.trim()) {
		return source;
	}
	const data = JSON.parse(source) as unknown;
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		throw new Error('not a JSON object');
	}
	return removeGuardHook(data as Record<string, unknown>, name) ? JSON.stringify(data, null, 2) + '\n' : source;
}

/** What the friction inbox says when it holds nothing: where its data comes from, so an empty list is not mistaken for a broken one. */
export const FRICTION_EMPTY = 'Nothing yet: Insilode only sees sessions started from its Agents dock (hook events). Past Claude transcripts are read when you open this view.';
export const PERMISSIONS_EMPTY = 'Permission requests appear here for agents started from the Agents dock';
export const GUARDS_EMPTY = 'No guards yet: they appear when you apply a failure fix';

export interface FrictionData {
	prompts: PromptRecord[];
	failures: FailureRecord[];
	dismissed: string[];
}

export interface PermissionRequest {
	at: number;
	agent: string;
	/** ACP tool kind: edit, execute, read, fetch, … */
	kind?: string;
	title: string;
	files: string[];
	rawInput?: Record<string, unknown>;
	decision: 'allowed' | 'denied' | 'auto' | 'cancelled';
}

export const FRICTION_KEY = 'flowHarness.friction.v1';
export const INBOX_KEY = 'flowHarness.inbox.v1';
/** The key friction data was kept under before it was versioned: read once, never written again. */
export const OLD_FRICTION_KEY = 'flowHarness.friction';
export const MAX_PROMPTS = 300;
export const MAX_FAILURES = 300;
export const MAX_DISMISSED = 500;
export const MAX_REQUESTS = 100;
/** Bytes of JSON one stored list may take: the oldest entries go first, so workspaceState does not grow without bound. */
const MAX_STORED = 400_000;

const clip = (v: unknown, max: number) => typeof v === 'string' ? redact(v.slice(0, max)) : undefined;
const time = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const records = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)) : [];

/** Drops entries from the front (the oldest) until the list's JSON fits `limit`. */
function fit<T>(list: T[], limit: number): T[] {
	let from = 0;
	let size = JSON.stringify(list).length;
	while (size > limit && from < list.length) {
		size -= JSON.stringify(list[from++]).length + 1;
	}
	return list.slice(from);
}

/** Friction data read from workspaceState: every field checked, secrets blanked again, lists bounded; damaged data gives an empty inbox. */
export function sanitizeFriction(raw: unknown): FrictionData {
	const r = raw as { prompts?: unknown; failures?: unknown; dismissed?: unknown } | undefined;
	const prompts: PromptRecord[] = [];
	for (const p of records(r?.prompts)) {
		const t = clip(p.text, 1000);
		const at = time(p.at);
		if (t && at !== undefined) {
			prompts.push({ text: t, at, cli: clip(p.cli, 20) ?? 'claude', session: clip(p.session, 200) });
		}
	}
	const failures: FailureRecord[] = [];
	for (const f of records(r?.failures)) {
		const tool = clip(f.tool, 200);
		const error = clip(f.error, 600);
		const at = time(f.at);
		if (tool && error && at !== undefined) {
			failures.push({ tool, subject: clip(f.subject, 300) ?? '', error, at, cli: clip(f.cli, 20) ?? 'claude', session: clip(f.session, 200) });
		}
	}
	const dismissed = Array.isArray(r?.dismissed) ? r.dismissed.filter((x): x is string => typeof x === 'string' && x.length <= 300) : [];
	return {
		prompts: fit(prompts.slice(-MAX_PROMPTS), MAX_STORED),
		failures: fit(failures.slice(-MAX_FAILURES), MAX_STORED),
		dismissed: dismissed.slice(-MAX_DISMISSED),
	};
}

/** The fields of a permission request's input the inbox uses (to suggest a rule), bounded and redacted: the rest is not kept. */
const INPUT_FIELDS = ['command', 'file_path', 'path', 'url'];

/** The permission inbox read from workspaceState (newest first), each entry checked, redacted and bounded. */
export function sanitizeInbox(raw: unknown): PermissionRequest[] {
	const out: PermissionRequest[] = [];
	for (const q of records((raw as { requests?: unknown } | undefined)?.requests)) {
		const title = clip(q.title, 300);
		const agent = clip(q.agent, 200);
		const at = time(q.at);
		const decision = q.decision;
		if (!title || !agent || at === undefined || (decision !== 'allowed' && decision !== 'denied' && decision !== 'auto' && decision !== 'cancelled')) {
			continue;
		}
		const files = (Array.isArray(q.files) ? q.files : []).flatMap(f => clip(f, 300) ?? []).slice(0, 10);
		const input = q.rawInput && typeof q.rawInput === 'object' ? q.rawInput as Record<string, unknown> : {};
		const rawInput: Record<string, unknown> = {};
		for (const k of INPUT_FIELDS) {
			const v = clip(input[k], 600);
			if (v !== undefined) {
				rawInput[k] = v;
			}
		}
		out.push({ at, agent, title, files, decision, kind: clip(q.kind, 40), ...Object.keys(rawInput).length ? { rawInput } : {} });
	}
	// Newest first: the cap keeps the head, the size limit drops from the tail.
	return fit(out.slice(0, MAX_REQUESTS).reverse(), MAX_STORED).reverse();
}

/** What is written to workspaceState: versioned, so a later format can tell itself apart. */
export const inboxState = (requests: readonly PermissionRequest[]) => ({ v: 1, requests: sanitizeInbox({ requests }) });
export const frictionState = (data: FrictionData) => ({ v: 1, ...sanitizeFriction(data) });
