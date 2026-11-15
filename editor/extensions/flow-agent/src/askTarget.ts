/*---------------------------------------------------------------------------------------------
 *  Insilode: which agent a question goes to. Home's prompt, "Ask about this flow" and anything else
 *  that hands text to "the agent" ask flow-agent, and this decides where it lands: a running
 *  session, a new one of some CLI, the chat panel or the clipboard. The choice is remembered per
 *  workspace, so the user picks once; the setting flow.agents.askTarget can fix it or always ask.
 *  Kept free of vscode so the rules can be tested in node (test/askTarget.test.mjs).
 *--------------------------------------------------------------------------------------------*/

/** claude and codex report through hooks (codex once its hooks are trusted); custom CLIs are plain terminals Insilode only lists. */
export type AgentCli = 'claude' | 'codex' | 'custom';
/** working: busy · blocked: waiting for you · done: finished a turn · idle: started, no prompt yet · unknown: no reports (custom CLIs, untrusted Codex hooks) · ended: the CLI exited. */
export type AgentState = 'starting' | 'working' | 'blocked' | 'done' | 'idle' | 'unknown' | 'ended';

/** A custom CLI from flow.agents.custom; `acceptsInput` says text may be typed into its prompt. */
export interface CustomCli {
	name: string;
	command: string;
	acceptsInput?: boolean;
}

/** What the picker needs to know about a running session. */
export interface SessionInfo {
	id: string;
	cli: AgentCli;
	name: string;
	state: AgentState;
	since: number;
	/** A hook has reported from it, so its state is the CLI's own word rather than a guess. */
	heard: boolean;
	/** Its terminal is still open in this window. */
	alive: boolean;
	/** What a custom session runs. */
	command?: string;
}

/** Where a question can go. `custom` names the entry of flow.agents.custom a session or new session belongs to. */
export type AskTarget =
	| { kind: 'session'; id: string; cli: AgentCli; custom?: string }
	| { kind: 'new'; cli: AgentCli; custom?: string }
	| { kind: 'chat' }
	| { kind: 'clipboard' };

/** flow.agents.askTarget: ask every time, remember the last choice, or always one kind of target. */
export type AskSetting = 'ask' | 'remember' | 'claude' | 'codex' | 'chat' | 'clipboard' | `custom:${string}`;

export function parseSetting(value: unknown): AskSetting {
	if (typeof value !== 'string') {
		return 'remember';
	}
	const v = value.trim();
	if (v === 'ask' || v === 'remember' || v === 'claude' || v === 'codex' || v === 'chat' || v === 'clipboard') {
		return v;
	}
	return /^custom:.+/.test(v) ? v as AskSetting : 'remember';
}

/** The custom CLI a session runs, matched by its command (the name is the user's to change). */
export function customOf(s: Pick<SessionInfo, 'cli' | 'command'>, customs: CustomCli[]): CustomCli | undefined {
	return s.cli === 'custom' ? customs.find(c => c.command === s.command) : undefined;
}

/**
 * Whether text may be typed into the session now. Claude and Codex only when a hook said they sit at their prompt
 * (idle or done), as for /compact: never while they work, and never while they wait on a permission or approval
 * menu, where a typed key can answer it. A custom CLI reports nothing, so only one the user marked as taking input.
 */
export function canType(s: SessionInfo, customs: CustomCli[]): boolean {
	if (!s.alive || s.state === 'ended') {
		return false;
	}
	if (s.cli === 'custom') {
		return customOf(s, customs)?.acceptsInput === true && s.state !== 'blocked';
	}
	return s.heard && (s.state === 'idle' || s.state === 'done');
}

/** What a target is told when a question asks it to plan first, in words, for one that has no /plan of its own. */
export const PLAN_FIRST = 'Plan this first and wait for my go-ahead before you change any file.';

/**
 * A question with "plan first" asked: Claude Code takes `/plan <task>` (its documented plan-mode command); every other
 * target (Codex, a custom CLI, the chat panel, the clipboard) gets the request in words instead of a command it may not know.
 */
export function planFirst(line: string, target: AskTarget): string {
	const claude = (target.kind === 'session' || target.kind === 'new') && target.cli === 'claude';
	return claude ? `/plan ${line}` : `${PLAN_FIRST} ${line}`;
}

/** The slash commands Insilode types into a session for the user (the dock's Compact): a kind, never text of its own. */
export type SlashKind = 'compact' | 'context';
/** Why a slash command was not typed, or `sent`. */
export type SlashResult = 'sent' | 'busy' | 'waiting' | 'not-ready' | 'unsupported' | 'no-terminal' | 'unknown';

/** What each CLI types for a kind: both take /compact, only Claude Code has /context. */
export function slashText(kind: SlashKind, cli: AgentCli): string | undefined {
	if (kind === 'compact') {
		return cli === 'custom' ? undefined : '/compact';
	}
	return cli === 'claude' ? '/context' : undefined;
}

/**
 * Whether `kind` may be typed into the session now, by the same rule as any typed text (canType): only at its prompt,
 * since the Enter after the command would answer an open permission menu with "Yes". Undefined when it may.
 */
export function slashRefusal(s: SessionInfo | undefined, kind: SlashKind): Exclude<SlashResult, 'sent'> | undefined {
	if (!s) {
		return 'unknown';
	}
	if (!slashText(kind, s.cli)) {
		return 'unsupported';
	}
	if (!s.alive || s.state === 'ended') {
		return 'no-terminal';
	}
	if (canType(s, [])) {
		return undefined;
	}
	return s.state === 'working' ? 'busy' : s.state === 'blocked' ? 'waiting' : 'not-ready';
}

/** Sessions that can take the question now: those at their prompt first, then custom ones (state unknown), newest first. */
export function readySessions(sessions: SessionInfo[], customs: CustomCli[]): SessionInfo[] {
	const rank = (s: SessionInfo) => s.cli === 'custom' ? 1 : 0;
	return sessions.filter(s => canType(s, customs)).sort((a, b) => rank(a) - rank(b) || b.since - a.since);
}

export interface Choice {
	label: string;
	description?: string;
	target: AskTarget;
}

const CLI_NAME: Record<Exclude<AgentCli, 'custom'>, string> = { claude: 'Claude Code', codex: 'Codex' };

export function cliName(cli: AgentCli, custom?: string): string {
	return cli === 'custom' ? custom ?? 'Custom agent' : CLI_NAME[cli];
}

/** A short name for a target, for "Sent to …" and the picker's current mark. */
export function targetName(t: AskTarget, sessions: SessionInfo[] = []): string {
	switch (t.kind) {
		case 'session': return sessions.find(s => s.id === t.id)?.name ?? cliName(t.cli, t.custom);
		case 'new': return cliName(t.cli, t.custom);
		case 'chat': return 'the chat panel';
		case 'clipboard': return 'the clipboard';
	}
}

const STATE: Partial<Record<AgentState, string>> = { idle: 'ready', done: 'finished a turn', unknown: 'running' };

/**
 * The picker's items, in order: running sessions that can take the question, a new session of each CLI (custom ones
 * only when they take input; none when new sessions cannot start, as in an untrusted folder), the chat panel when a
 * chat provider is there, and the clipboard.
 */
export function choices(o: { sessions: SessionInfo[]; customs: CustomCli[]; chat: boolean; canStart: boolean }): Choice[] {
	const out: Choice[] = readySessions(o.sessions, o.customs).map(s => {
		const custom = customOf(s, o.customs)?.name;
		return { label: s.name, description: `${cliName(s.cli, custom)} · ${STATE[s.state] ?? s.state}`, target: { kind: 'session', id: s.id, cli: s.cli, custom } };
	});
	if (o.canStart) {
		out.push({ label: 'New Claude Code session', target: { kind: 'new', cli: 'claude' } });
		out.push({ label: 'New Codex session', target: { kind: 'new', cli: 'codex' } });
		for (const c of o.customs.filter(c => c.acceptsInput)) {
			out.push({ label: `New ${c.name} session`, description: c.command, target: { kind: 'new', cli: 'custom', custom: c.name } });
		}
	}
	if (o.chat) {
		out.push({ label: 'Chat panel', target: { kind: 'chat' } });
	}
	out.push({ label: 'Copy to clipboard', target: { kind: 'clipboard' } });
	return out;
}

export function sameTarget(a: AskTarget | undefined, b: AskTarget | undefined): boolean {
	if (!a || !b || a.kind !== b.kind) {
		return false;
	}
	if (a.kind === 'session' && b.kind === 'session') {
		return a.id === b.id;
	}
	if (a.kind === 'new' && b.kind === 'new') {
		return a.cli === b.cli && a.custom === b.custom;
	}
	return true;
}

/** Whether a stored value is a target this version understands; anything else is treated as nothing remembered. */
export function isTarget(v: unknown): v is AskTarget {
	const t = v as AskTarget | undefined;
	if (!t || typeof t !== 'object') {
		return false;
	}
	const cli = (t as { cli?: unknown }).cli;
	const okCli = cli === 'claude' || cli === 'codex' || cli === 'custom';
	switch (t.kind) {
		case 'session': return typeof t.id === 'string' && okCli;
		case 'new': return okCli && (cli !== 'custom' || typeof t.custom === 'string');
		case 'chat':
		case 'clipboard': return true;
		default: return false;
	}
}

/** Why a session cannot take typed text now, in words that say what would change it. */
export function notReady(s: Pick<SessionInfo, 'name' | 'cli' | 'state'>): string {
	switch (s.state) {
		case 'working': return `${s.name} is busy`;
		case 'blocked': return `${s.name} is waiting for you`;
		default:
			// Codex reports nothing until its hooks are trusted, which looks the same as a session that never got going.
			return s.cli === 'codex' ? `${s.name} has not said it is at its prompt (if this lasts, trust Insilode's hooks with /hooks in Codex)` : `${s.name} has not said it is at its prompt yet`;
	}
}

/** What to do with a question: send it to `target`, or show the picker (`why` says why when it is not the first time). */
export type Resolution = { use: AskTarget; why?: string } | { pick: true; why?: string };

/**
 * Decides where a question goes without asking, when it can. A remembered session that is gone falls back to the
 * newest ready session of the same CLI, else a new one (what Insilode did for Claude before there was a choice); one that
 * is busy or waiting on a permission prompt is not typed into, so the picker comes up. A target that cannot be used
 * here any more (chat with no provider, a custom CLI removed from the settings) asks again.
 */
export function resolve(o: { setting: AskSetting; remembered?: AskTarget; sessions: SessionInfo[]; customs: CustomCli[]; chat: boolean; canStart: boolean }): Resolution {
	const { setting, sessions, customs } = o;
	if (setting === 'ask') {
		return { pick: true };
	}
	let target: AskTarget | undefined;
	if (setting === 'remember') {
		target = o.remembered;
	} else if (setting === 'chat' || setting === 'clipboard') {
		target = { kind: setting };
	} else if (setting === 'claude' || setting === 'codex') {
		target = { kind: 'new', cli: setting };
	} else {
		target = { kind: 'new', cli: 'custom', custom: setting.slice('custom:'.length) };
	}
	if (!target) {
		return { pick: true };
	}
	const ready = readySessions(sessions, customs);
	const ofKind = (cli: AgentCli, custom?: string) => ready.find(s => s.cli === cli && (cli !== 'custom' || customOf(s, customs)?.name === custom));
	const fresh = (cli: AgentCli, custom?: string, why?: string): Resolution => {
		if (cli === 'custom' && !customs.some(c => c.name === custom && c.acceptsInput)) {
			return { pick: true, why: `${custom ?? 'That agent'} is not a custom agent that takes input any more` };
		}
		if (!o.canStart) {
			return { pick: true, why: 'New agents cannot start in this folder' };
		}
		return { use: { kind: 'new', cli, custom }, why };
	};
	switch (target.kind) {
		case 'chat':
			return o.chat ? { use: target } : { pick: true, why: 'No chat provider is available' };
		case 'clipboard':
			return { use: target };
		case 'new': {
			// A fixed or remembered CLI reuses one of its sessions that waits at its prompt, as a person would.
			const s = ofKind(target.cli, target.custom);
			return s ? { use: { kind: 'session', id: s.id, cli: s.cli, custom: target.custom } } : fresh(target.cli, target.custom);
		}
		case 'session': {
			const s = sessions.find(x => x.id === target.id && x.alive && x.state !== 'ended');
			if (s) {
				return canType(s, customs) ? { use: target } : { pick: true, why: notReady(s) };
			}
			const other = ofKind(target.cli, target.custom);
			const gone = `The session you chose before has closed`;
			return other ? { use: { kind: 'session', id: other.id, cli: other.cli, custom: target.custom }, why: gone } : fresh(target.cli, target.custom, gone);
		}
	}
}

/** Strips what a terminal would act on: a newline or lone CR is Enter (it would send a draft), other control keys (Ctrl-C) as well. */
export function oneLine(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/** How files are referred to in the text for each target: Claude reads an @-mentioned file itself; Codex's @ opens a picker, so a plain path. */
export function withFiles(text: string, files: string[], cli?: AgentCli): string {
	if (!files.length) {
		return text;
	}
	const refs = files.map(f => cli === 'claude' ? `@${f}` : f).join(' ');
	return `${refs} ${text}`;
}
