/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: what fired and what never did. Counts per harness piece (a skill, a subagent,
 *  an MCP server, a hook, a path-scoped rule), bucketed by day for the last 30 days, so the map
 *  can say "used 12× this week" or "never used in 30 days". Fed by flow-agent's hook events and
 *  by the transcripts of past sessions. The data is plain JSON kept in the workspace's extension
 *  storage and stays bounded (30 days, a fixed number of keys). Pure (no vscode).
 *--------------------------------------------------------------------------------------------*/

import { isInsilodeHook, mcpServerOf, mcpToolPrefix, type TranscriptFacts } from './transcript';

export const WINDOW_DAYS = 30;
export const MAX_KEYS = 400;
export const MAX_TRANSCRIPTS = 300;
const DAY = 86_400_000;

export interface Counter {
	/** Uses per day, keyed by the day's start (UTC ms, as a string). */
	days: Record<string, number>;
	last: number;
	failures?: number;
	/** Measured durations (Stop hooks report theirs). */
	durTotal?: number;
	durCount?: number;
	/** Counted from an event and a matcher rather than reported: true for most hooks. */
	inferred?: boolean;
}

export interface ActivityData {
	version: 2;
	// Version 2: coverage counts only what was read in full (version 1 claimed the whole window).
	/** When counting began here: "never used" means nothing until the window is covered. */
	since: number;
	keys: Record<string, Counter>;
	/** Transcripts read so far, with how far, and whether hook events cover their tool calls (sessions Insilode started). */
	transcripts: Record<string, { offset: number; live: boolean; at: number; from?: number }>;
}

export const emptyActivity = (now: number): ActivityData => ({ version: 2, since: now, keys: {}, transcripts: {} });

/** A stored value of the wrong shape (an older version, a hand edit) starts over rather than breaking the map. */
export function loadActivity(raw: unknown, now: number): ActivityData {
	const d = raw as Partial<ActivityData> | undefined;
	if (!d || d.version !== 2 || typeof d.since !== 'number' || !d.keys || typeof d.keys !== 'object' || !d.transcripts || typeof d.transcripts !== 'object') {
		return emptyActivity(now);
	}
	return d as ActivityData;
}

const dayOf = (t: number) => String(Math.floor(t / DAY) * DAY);

export interface Bump {
	failure?: boolean;
	durationMs?: number;
	inferred?: boolean;
	count?: number;
}

export function bump(data: ActivityData, key: string, at: number, opts: Bump = {}) {
	const c = data.keys[key] ??= { days: {}, last: 0 };
	const day = dayOf(at);
	c.days[day] = (c.days[day] ?? 0) + (opts.count ?? 1);
	c.last = Math.max(c.last, at);
	if (opts.failure) {
		c.failures = (c.failures ?? 0) + 1;
	}
	if (opts.durationMs !== undefined) {
		c.durTotal = (c.durTotal ?? 0) + opts.durationMs;
		c.durCount = (c.durCount ?? 0) + 1;
	}
	if (opts.inferred) {
		c.inferred = true;
	}
}

/** Drops days older than the window, then the least recently used keys and transcripts past their caps. */
export function prune(data: ActivityData, now: number) {
	const oldest = now - WINDOW_DAYS * DAY;
	for (const [key, c] of Object.entries(data.keys)) {
		for (const day of Object.keys(c.days)) {
			if (Number(day) < oldest - DAY) {
				delete c.days[day];
			}
		}
		if (!Object.keys(c.days).length && c.last < oldest) {
			delete data.keys[key];
		}
	}
	const keys = Object.entries(data.keys);
	if (keys.length > MAX_KEYS) {
		keys.sort((a, b) => b[1].last - a[1].last).slice(MAX_KEYS).forEach(([k]) => delete data.keys[k]);
	}
	const ts = Object.entries(data.transcripts);
	if (ts.length > MAX_TRANSCRIPTS) {
		ts.sort((a, b) => b[1].at - a[1].at).slice(MAX_TRANSCRIPTS).forEach(([k]) => delete data.transcripts[k]);
	}
	data.since = Math.max(data.since, oldest);
}

export interface Summary {
	week: number;
	month: number;
	last?: number;
	failures: number;
	avgMs?: number;
	inferred: boolean;
}

export function summary(data: ActivityData, key: string, now: number): Summary {
	const c = data.keys[key];
	if (!c) {
		return { week: 0, month: 0, failures: 0, inferred: false };
	}
	let week = 0;
	let month = 0;
	for (const [day, n] of Object.entries(c.days)) {
		const age = now - Number(day);
		if (age < 7 * DAY) {
			week += n;
		}
		if (age < WINDOW_DAYS * DAY) {
			month += n;
		}
	}
	return { week, month, last: c.last, failures: c.failures ?? 0, avgMs: c.durCount ? Math.round((c.durTotal ?? 0) / c.durCount) : undefined, inferred: !!c.inferred };
}

/**
 * Where the counts start after reading a window's transcripts: at the window's start (`cutoff`), unless a transcript was
 * read only from `partial` on, or older transcripts (the newest of them last written at `skipped`) were left out.
 */
export function coveredFrom(cutoff: number, partial: readonly number[], skipped?: number): number {
	return Math.max(cutoff, ...partial, ...(skipped !== undefined ? [skipped] : []));
}

/** How many days the counts cover. */
export const coveredDays = (data: ActivityData, now: number) => Math.max(0, Math.floor((now - data.since) / DAY));

/** Sessions the counts must rest on before "never used" is said: one session says little about a month. */
export const MIN_SESSIONS = 3;

/**
 * "used 12× this week", "used 3× in 30 days", "never used in 30 days", or, before 30 days and a few sessions are
 * covered, what was actually seen: "no use in 4 days", "no use in 1 session".
 */
export function usageLabel(s: Summary, covered: number, sessions = MIN_SESSIONS): string {
	const n = (x: number) => `${x}×`;
	if (s.week) {
		return `used ${n(s.week)} this week`;
	}
	if (s.month) {
		return `used ${n(s.month)} in ${WINDOW_DAYS} days`;
	}
	const span = noUseSpan(covered, sessions);
	return `${span.settled ? 'never used' : 'no use'} ${span.text}`;
}

/** The stretch "not used" speaks for: "in 30 days" once that and a few sessions are covered, else "in 1 session", "in 4 days" or "yet". */
export function noUseSpan(covered: number, sessions: number): { settled: boolean; text: string } {
	if (covered >= WINDOW_DAYS && sessions >= MIN_SESSIONS) {
		return { settled: true, text: `in ${WINDOW_DAYS} days` };
	}
	if (sessions < MIN_SESSIONS) {
		return { settled: false, text: sessions ? `in ${sessions} session${sessions === 1 ? '' : 's'}` : 'seen yet' };
	}
	return { settled: false, text: `in ${Math.max(1, covered)} day${covered === 1 ? '' : 's'}` };
}

// ---------------------------------------------------------------------------------------------
// Keys

export const skillKey = (name: string) => `skill:${name.toLowerCase()}`;
export const agentKey = (name: string) => `agent:${name.toLowerCase()}`;
export const mcpKey = (server: string) => `mcp:${server.toLowerCase()}`;
export const ruleKey = (file: string) => `file:${file.replace(/\\/g, '/').toLowerCase()}`;
export const hookKey = (h: HookLike) => `hook:${h.event}|${h.matcher ?? ''}|${h.command}`;

export interface HookLike {
	event: string;
	matcher?: string;
	command: string;
}

/** The counter of a harness item (see scan.ts HarnessItem): skills, subagents and MCP servers by name, hooks by what they run, files by path. */
export function itemKey(i: { kind: string; label: string; file: string; hook?: HookLike; mcp?: { toolPrefix: string } }): string {
	switch (i.kind) {
		case 'skills':
			return skillKey(i.label);
		case 'agents':
			return agentKey(i.label);
		case 'mcp':
			// Tool names carry the server's name with `.` and spaces as `_` (a plugin's as plugin_<plugin>_<server>): count it under that spelling.
			return mcpKey(i.mcp?.toolPrefix ?? mcpToolPrefix(i.label));
		case 'hooks':
			return i.hook ? hookKey(i.hook) : `hook:${i.file}`;
		default:
			return ruleKey(i.file);
	}
}

/** Items whose use can be seen: an always-on instruction file is read in every session, so a count says nothing about it. An item no agent reads is the scan's own finding (the scan limit), not a file. */
export function isTracked(i: { kind: string; scope: string; paths?: string[]; hook?: HookLike; memory?: unknown; agents?: string[] }): boolean {
	return (i.kind === 'memory' && !!i.memory) || i.kind === 'skills' || i.kind === 'agents' || i.kind === 'mcp' || (i.kind === 'hooks' && !!i.hook)
		|| (i.kind === 'rules' && !!i.paths?.length) || (i.kind === 'instructions' && i.scope === 'directory' && i.agents?.length !== 0);
}

/**
 * Whether a hook's matcher fires for `value` (a tool name, an agent type), as Claude Code documents it: `*`, empty or
 * none match everything; only letters, digits, `_`, `-`, spaces, `,` and `|` is a list of exact names; anything else is
 * an unanchored JavaScript regular expression.
 */
export function hookMatches(matcher: string | undefined, value: string): boolean {
	const m = (matcher ?? '').trim();
	if (!m || m === '*') {
		return true;
	}
	if (/^[\w\- ,|]+$/.test(m)) {
		return m.split(/[|,]/).map(s => s.trim()).filter(Boolean).includes(value);
	}
	try {
		return new RegExp(m).test(value);
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------------------------
// Feeding it

/** One hook event from flow-agent (see `flowHarness.recordEvent`). */
export interface AgentEvent {
	at: number;
	/** The agent's name in the dock, and its CLI. */
	agent: string;
	cli: 'claude' | 'codex' | string;
	session?: string;
	event: string;
	tool?: string;
	/** Selected, bounded fields of the tool input: skill, subagent_type, command, file_path, url. */
	input?: Record<string, string>;
	error?: string;
	durationMs?: number;
	prompt?: string;
	agentType?: string;
	transcript?: string;
	/** flow-agent's id for the session (stable across renames). */
	id?: string;
	/** The permission mode the hook reported. */
	mode?: string;
}

/** Counts one hook event: the skill, subagent or MCP server a tool call used, and the user's hooks its event and tool fire. */
export function countEvent(data: ActivityData, ev: AgentEvent, hooks: readonly HookLike[]) {
	// The hooks here are Claude Code's settings: a Codex event fires none of them.
	if (ev.cli !== 'claude') {
		hooks = [];
	}
	const tool = ev.tool ?? '';
	const failed = ev.event === 'PostToolUseFailure';
	if (ev.event === 'PostToolUse' || failed) {
		countTool(data, tool, ev.input ?? {}, ev.at, failed);
		// A tool that ran had its PreToolUse hooks run first; PostToolUse hooks run after a success, PostToolUseFailure ones after a failure.
		for (const h of hooks) {
			if ((h.event === 'PreToolUse' || h.event === (failed ? 'PostToolUseFailure' : 'PostToolUse')) && hookMatches(h.matcher, tool) && !isInsilodeHook(h.command)) {
				bump(data, hookKey(h), ev.at, { inferred: true });
			}
		}
		return;
	}
	// Stop hooks are counted from the transcript, which reports each one with its duration.
	if (ev.event === 'UserPromptSubmit' || ev.event === 'SessionStart' || ev.event === 'SubagentStop' || ev.event === 'SessionEnd') {
		for (const h of hooks) {
			if (h.event === ev.event && (ev.event !== 'SubagentStop' || hookMatches(h.matcher, ev.agentType ?? '')) && !isInsilodeHook(h.command)) {
				bump(data, hookKey(h), ev.at, { inferred: true });
			}
		}
	}
}

function countTool(data: ActivityData, tool: string, input: Record<string, unknown>, at: number, failed: boolean) {
	if (tool === 'Skill' && typeof input.skill === 'string') {
		bump(data, skillKey(input.skill.replace(/^\//, '')), at, { failure: failed });
	} else if ((tool === 'Task' || tool === 'Agent') && typeof input.subagent_type === 'string') {
		bump(data, agentKey(input.subagent_type), at, { failure: failed });
	}
	const server = mcpServerOf(tool);
	if (server) {
		bump(data, mcpKey(server), at, { failure: failed });
	}
	// Reading one of Claude Code's memory files is how a session recalls it.
	const file = typeof input.file_path === 'string' ? input.file_path : '';
	if (tool === 'Read' && /[\\/]\.claude[\\/]projects[\\/][^\\/]+[\\/]memory[\\/][^\\/]+\.md$/i.test(file) && !failed) {
		bump(data, ruleKey(file), at);
	}
}

const time = (iso: string | undefined, fallback: number) => {
	const t = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(t) ? t : fallback;
};

/**
 * Counts what a stretch of transcript shows: files loaded on demand, hook failures, Stop hooks with their durations, and,
 * for sessions no hook reported (`withTools`), the skills, subagents and MCP tools it called.
 */
export function countTranscript(data: ActivityData, facts: TranscriptFacts, hooks: readonly HookLike[], fallbackAt: number, withTools: boolean) {
	for (const n of facts.nested) {
		bump(data, ruleKey(n.path), time(n.at, fallbackAt));
	}
	for (const s of facts.stopHooks) {
		if (isInsilodeHook(s.command)) {
			continue;
		}
		for (const h of hooks.filter(x => (x.event === 'Stop' || x.event === 'SubagentStop') && x.command.trim() === s.command.trim())) {
			bump(data, hookKey(h), time(s.at, fallbackAt), { durationMs: s.durationMs });
		}
	}
	for (const e of facts.hookErrors) {
		// "PreToolUse:Write": the event and the tool it ran for. Every hook of that event whose matcher takes the tool may be the one that failed.
		const [event, tool = ''] = e.hookName.split(':');
		const candidates = hooks.filter(h => h.event === (e.event ?? event) && hookMatches(h.matcher, tool) && !isInsilodeHook(h.command));
		const named = candidates.filter(h => e.message.includes(h.command.split(/\s+/).pop()?.replace(/^.*[\\/]/, '').replace(/["']/g, '') ?? '\0'));
		for (const h of named.length ? named : candidates) {
			const c = data.keys[hookKey(h)] ??= { days: {}, last: 0, inferred: true };
			c.failures = (c.failures ?? 0) + 1;
		}
	}
	if (!withTools) {
		return;
	}
	for (const u of facts.toolUses) {
		const at = time(u.at, fallbackAt);
		countTool(data, u.name, u.input, at, false);
		for (const h of hooks) {
			if ((h.event === 'PreToolUse' || h.event === 'PostToolUse') && hookMatches(h.matcher, u.name) && !isInsilodeHook(h.command)) {
				bump(data, hookKey(h), at, { inferred: true });
			}
		}
	}
	for (const p of facts.prompts) {
		for (const h of hooks.filter(x => x.event === 'UserPromptSubmit' && !isInsilodeHook(x.command))) {
			bump(data, hookKey(h), time(p.at, fallbackAt), { inferred: true });
		}
	}
}
