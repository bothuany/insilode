/*---------------------------------------------------------------------------------------------
 *  Insilode: why an agent needs you, and how urgently. The hooks say what happened (a permission
 *  question, an AskUserQuestion, an MCP elicitation, a failed turn); this module turns that into one
 *  "need" per session and ranks the sessions, so the Agents dock puts the one you must answer first
 *  on top: approval > question > error > done-and-unread > working > idle.
 *
 *  What each CLI reports (Claude Code 2.1.302, read from the CLI itself):
 *  - PermissionRequest (tool_name, tool_input): the CLI is about to ask "allow this?".
 *  - PreToolUse for AskUserQuestion (tool_input.questions[].question): the agent asks you something.
 *  - Notification with notification_type permission_prompt, elicitation_dialog or idle_prompt.
 *  - StopFailure (error, error_details): the turn ended on an API error (rate limit, auth, billing...).
 *  - PostToolUseFailure: a tool ran and failed; several in a row is a loop worth a look.
 *  - Stop (last_assistant_message): the turn is over; a reply ending in a question waits for you.
 *  Codex sends PermissionRequest and Stop the same way; it has no Notification or failure events.
 *
 *  Pure (no vscode), so it is tested on its own.
 *--------------------------------------------------------------------------------------------*/

export type NeedKind = 'approval' | 'question' | 'error';

/** Where a need came from: it decides which later event clears it. */
export type NeedSource = 'permission' | 'plan' | 'ask' | 'elicitation' | 'reply' | 'loop' | 'stop' | 'crash' | 'startup';

export interface Need {
	kind: NeedKind;
	source: NeedSource;
	/** The question, the permission asked for, or the error, as one line. */
	text: string;
	/** When it started, in ms: a new need is a new notification. */
	at: number;
	/** Set when the request comes from a subagent (or in-process teammate) of the session, not the session itself. */
	subagent?: { type?: string };
}

/** What one session carries between events. */
export interface Attention {
	need?: Need;
	/** Tool calls that failed in a row. */
	failures: number;
}

/** The parts of a hook event this module looks at. `described` is the one-line text of the tool call (agents.ts). */
export interface AttentionEvent {
	event: string;
	tool?: string;
	input?: Record<string, unknown>;
	described?: string;
	notificationType?: string;
	message?: string;
	error?: string;
	errorDetails?: string;
	lastMessage?: string;
	/** Claude Code's `agent_id`: set only when the hook fired inside a subagent. `agent_type` alone means `--agent`, not a subagent. */
	agentId?: string;
	agentType?: string;
}

/** This many failed tool calls in a row count as an error loop. */
export const FAILURE_LOOP = 3;

const MAX_TEXT = 240;
const line = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

/** The first question an AskUserQuestion call puts to you, and how many more follow it. */
export function askedQuestion(input: Record<string, unknown> | undefined): string | undefined {
	const qs = Array.isArray(input?.questions) ? input.questions as { question?: unknown }[] : [];
	const texts = qs.map(q => typeof q?.question === 'string' ? q.question.trim() : '').filter(Boolean);
	if (texts.length) {
		return line(texts[0] + (texts.length > 1 ? ` (+${texts.length - 1} more)` : ''));
	}
	return typeof input?.question === 'string' && input.question.trim() ? line(input.question) : undefined;
}

/**
 * The question a finished turn ends on, if it ends on one: the last non-empty line, when it ends with a
 * question mark. A question in the middle of a long answer is not one the agent is waiting on.
 */
export function replyQuestion(message: string | undefined): string | undefined {
	const lines = (message ?? '').split('\n').map(l => l.trim()).filter(Boolean);
	const last = lines[lines.length - 1];
	if (!last || !/[?？]\**\s*$/.test(last)) {
		return undefined;
	}
	// The question itself, not the whole paragraph: the last sentence of the line.
	const sentences = last.split(/(?<=[.!?。])\s+/);
	// Bold and list marks are Markdown, not part of the question.
	return line(sentences[sentences.length - 1].replace(/\*\*|__/g, '').replace(/^[-*>#\s]+/, ''));
}

/** The error codes StopFailure sends, said the way a person would. */
const ERRORS: Record<string, string> = {
	rate_limit: 'Rate limited',
	authentication_failed: 'Not signed in',
	billing_error: 'Billing problem',
	invalid_request: 'Request rejected',
	server_error: 'API error',
	max_output_tokens: 'Output limit reached',
	overloaded: 'API overloaded',
	unknown: 'The turn failed',
};

export function errorText(error: string | undefined, details: string | undefined): string {
	const label = ERRORS[error ?? 'unknown'] ?? `The turn failed (${error})`;
	return line(details ? `${label}: ${details}` : label);
}

const clearsOnProgress = (n: Need | undefined) => !n || n.kind === 'approval' || n.kind === 'question';

/**
 * Claude Code said nothing since it started: no hook runs before you trust the folder, so it is most likely asking that
 * (or to approve the project's MCP servers) in its terminal. Hooks give no signal for these prompts, so this is a guess,
 * and says so; the first hook event clears it.
 */
export function startupNeed(now: number): Need {
	return { kind: 'question', source: 'startup', text: 'No word from it yet: it may be asking you to trust this folder or approve MCP servers in its terminal', at: now };
}

/** The attention after one hook event. Never mutates `prev`. */
export function nextAttention(prev: Attention, e: AttentionEvent, now: number): Attention {
	if (prev.need?.source === 'startup') {
		prev = { ...prev, need: undefined }; // it spoke, so it is past its startup questions
	}
	const need = (kind: NeedKind, source: NeedSource, text: string): Attention => ({ ...prev, need: { kind, source, text: line(text), at: now } });
	const sub = e.agentId ? { type: e.agentType } : undefined;
	/** "Explore (subagent)": who is asking, when it is not the session itself. */
	const who = sub ? `${sub.type || 'Agent'} (subagent)` : undefined;
	const needBy = (kind: NeedKind, source: NeedSource, text: string): Attention => {
		const n = need(kind, source, text);
		return sub && n.need ? { ...n, need: { ...n.need, subagent: sub } } : n;
	};
	const asks = (tool: string | undefined) => tool === 'AskUserQuestion';
	switch (e.event) {
		case 'SessionStart':
		case 'UserPromptSubmit':
		case 'SessionEnd':
			return { failures: 0 };
		case 'PreToolUse':
			if (asks(e.tool)) {
				return need('question', 'ask', askedQuestion(e.input) ?? 'The agent asks you something');
			}
			if (e.tool === 'ExitPlanMode') {
				return need('approval', 'plan', 'Review the plan');
			}
			return prev;
		case 'PermissionRequest':
			if (asks(e.tool)) {
				// The question may already be on screen from PreToolUse: keep its start time, so it is not news twice.
				return prev.need?.source === 'ask' ? prev : need('question', 'ask', askedQuestion(e.input) ?? 'The agent asks you something');
			}
			if (e.tool === 'ExitPlanMode') {
				return prev.need?.source === 'plan' ? prev : need('approval', 'plan', 'Review the plan');
			}
			return needBy('approval', 'permission', who ? (e.described ? `${who} wants to: ${e.described}` : `${who} wants permission`) : e.described ? `Wants to: ${e.described}` : 'Wants permission');
		case 'Notification':
			if (e.notificationType === 'permission_prompt' || (!e.notificationType && /permission/i.test(e.message ?? ''))) {
				// PermissionRequest came first and says more (the command itself): keep it. AskUserQuestion is shown
				// through the permission prompt too, and stays the question it is.
				return prev.need?.kind === 'approval' || prev.need?.source === 'ask' ? prev : needBy('approval', 'permission', who ? `${who}: ${e.message || 'wants permission'}` : e.message || 'Wants permission');
			}
			if (e.notificationType === 'elicitation_dialog') {
				return prev.need?.kind === 'question' ? prev : need('question', 'elicitation', e.message || 'A tool asks you for input');
			}
			return prev;
		case 'PostToolUse':
			// The tool ran: any question about it is answered, and a failure streak is over.
			return { failures: 0, need: clearsOnProgress(prev.need) || prev.need?.source === 'loop' ? undefined : prev.need };
		case 'PostToolUseFailure': {
			const failures = prev.failures + 1;
			const kept = clearsOnProgress(prev.need) ? undefined : prev.need;
			if (failures < FAILURE_LOOP) {
				return { failures, need: kept };
			}
			// The count goes up on the row, but the loop keeps the time it started: it is one error, not one per failure.
			const text = line(`${failures} tool calls failed in a row${e.tool ? ` (last: ${e.tool})` : ''}`);
			return { failures, need: { kind: 'error', source: 'loop', text, at: kept?.source === 'loop' ? kept.at : now } };
		}
		case 'Stop': {
			const question = replyQuestion(e.lastMessage);
			if (question) {
				return { failures: prev.failures, need: { kind: 'question', source: 'reply', text: question, at: now } };
			}
			// The turn is over, so nothing is waiting on a prompt any more; an error loop stays until the next prompt.
			return { failures: prev.failures, need: prev.need?.kind === 'error' ? prev.need : undefined };
		}
		case 'StopFailure':
			return { failures: prev.failures, need: { kind: 'error', source: 'stop', text: errorText(e.error, e.errorDetails), at: now } };
		default:
			return prev;
	}
}

/** The CLI exited on its own with a failing code: a crash, unless it was already done. */
export function crashNeed(code: number | undefined, now: number): Need | undefined {
	return typeof code === 'number' && code !== 0 ? { kind: 'error', source: 'crash', text: `Exited with code ${code}`, at: now } : undefined;
}

/** The fields of a session ranking looks at. */
export interface Rankable {
	state: 'starting' | 'working' | 'blocked' | 'done' | 'idle' | 'unknown' | 'ended';
	need?: Need;
	unread: boolean;
	since: number;
}

/** What a row is waiting for, for its chip and for notifications: a need, or a finished turn you have not looked at. */
export type AttentionKind = NeedKind | 'done';

export function attentionKind(s: Rankable): AttentionKind | undefined {
	// An approval or a question blocks the agent until you answer; an error only needs you to see it.
	if (s.need && (s.need.kind !== 'error' || s.unread)) {
		return s.need.kind;
	}
	if (s.state === 'blocked') {
		return 'approval';
	}
	return s.state === 'done' && s.unread ? 'done' : undefined;
}

/** Lower is more urgent. A done turn you have read waits like an idle one: below everything still working. */
export function urgency(s: Rankable): number {
	const kind = attentionKind(s);
	if (kind) {
		return { approval: 0, question: 1, error: 2, done: 3 }[kind];
	}
	return { working: 4, starting: 5, idle: 6, done: 6, blocked: 6, unknown: 7, ended: 8 }[s.state];
}

/** Most urgent first; within a rank the one waiting longest for you first, else the newest. */
export function rank<T extends Rankable>(list: T[]): T[] {
	return [...list].sort((a, b) => urgency(a) - urgency(b) || (attentionKind(a) ? (a.need?.at ?? a.since) - (b.need?.at ?? b.since) : b.since - a.since));
}

/** A key that changes exactly when a session starts needing you anew: notify once per key. */
export function attentionKey(s: Rankable): string | undefined {
	const kind = attentionKind(s);
	return kind && `${kind}:${s.need?.at ?? s.since}`;
}

const SAY: Record<AttentionKind, string> = {
	approval: 'needs your approval',
	question: 'asks you',
	error: 'hit an error',
	done: 'is done',
};

/**
 * The notification for a session that starts needing you anew (attentionKey changed), or undefined: none while the
 * user looks at it, with flow.agents.notify.quiet on, or with that kind turned off. Errors come as warnings.
 */
export function notification(s: Rankable & { name: string }, o: { quiet: boolean; enabled: (kind: AttentionKind) => boolean; watched: boolean }): { message: string; warn: boolean } | undefined {
	const kind = attentionKind(s);
	if (!kind || o.quiet || !o.enabled(kind) || o.watched) {
		return undefined;
	}
	const text = s.need?.text;
	return { message: `${s.name} ${SAY[kind]}${text ? `: ${text}` : ''}`, warn: kind === 'error' };
}

/** What one notification the notifier held back was about. */
export interface DigestEntry {
	session: string;
	kind: AttentionKind;
}

/**
 * One line for the notifications collected while the window was in the background: distinct sessions per kind, the
 * latest entry of a session counting (a session that asked and then finished is one finished). Approvals and questions
 * both block the agent, so they count together as "need you". Undefined when there is nothing to say.
 */
export function digestMessage(entries: DigestEntry[]): string | undefined {
	const latest = new Map<string, AttentionKind>();
	for (const e of entries) {
		latest.set(e.session, e.kind);
	}
	const count = { need: 0, error: 0, done: 0 };
	for (const kind of latest.values()) {
		count[kind === 'approval' || kind === 'question' ? 'need' : kind]++;
	}
	const parts: string[] = [];
	if (count.need) {
		parts.push(`${count.need} ${count.need === 1 ? 'agent needs' : 'agents need'} you`);
	}
	if (count.error) {
		parts.push(`${count.error} hit ${count.error === 1 ? 'an error' : 'errors'}`);
	}
	if (count.done) {
		parts.push(`${count.done} finished`);
	}
	return parts.length ? parts.join(', ') : undefined;
}
