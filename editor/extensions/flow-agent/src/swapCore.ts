/*---------------------------------------------------------------------------------------------
 *  Insilode: the parts of moving a conversation between Claude Code and Codex that need no editor (swap.ts runs them).
 *  Claude to Codex goes through Codex's own importer (its app-server's externalAgentConfig/import, the one the Codex
 *  app uses for Claude sessions); this file speaks that JSON-RPC. Codex to Claude has no importer, so the Codex rollout
 *  is read here and written out as a Claude transcript that `claude --resume` opens. Both keep what Codex's importer
 *  keeps: what the user said and what the agent answered, not the tool calls, whose ids and shapes differ between the
 *  two CLIs. Nothing here deletes or rewrites the source conversation.
 *--------------------------------------------------------------------------------------------*/

/** One turn of a conversation, in the order it happened. */
export interface Turn {
	role: 'user' | 'assistant';
	text: string;
	/** ISO time, when the transcript had one. */
	at?: string;
}

/** A Codex rollout larger than this is refused rather than read whole into memory. */
export const MAX_ROLLOUT_BYTES = 64 << 20;

/** A turn's text over this many characters is cut, so one pasted log cannot fill the new session's context. */
export const MAX_TURN_CHARS = 32_000;

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The moved agent's name. A name Insilode gave ("Codex", "Claude 2") said which CLI it was, so it is dropped: '' lets
 * spawn name it as any new agent of the other CLI ("Claude"), rather than "Codex → Claude". A name of the user's or the
 * conversation's keeps one arrow, for the CLI it is in now: "Login page → Codex → Claude" is "Login page → Claude".
 */
export function swappedName(name: string, to: string): string {
	const base = name.replace(/ → (Claude|Codex)$/, '');
	return /^(Claude|Codex)( \d+)?$/.test(base) ? '' : `${base} → ${to}`;
}

function record(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function cut(text: string) {
	return text.length > MAX_TURN_CHARS ? `${text.slice(0, MAX_TURN_CHARS)}\n\n[… ${text.length - MAX_TURN_CHARS} more characters left out when the session moved]` : text;
}

/** The text blocks of a Codex message's content, joined (`output_text` in response items, `text`/`Text` in thread items). */
function outputText(content: unknown): string {
	if (!Array.isArray(content)) {
		return '';
	}
	return content.map(b => record(b)).filter(b => b && (b.type === 'output_text' || b.type === 'text' || b.type === 'Text') && typeof b.text === 'string').map(b => b!.text as string).join('\n\n');
}

/** Joins `t` onto the turns: two messages in a row from one side (a prompt sent while the agent worked, several answers in one turn) become one, so turns alternate, as Claude expects. */
function add(turns: Turn[], role: Turn['role'], t: string, at: string | undefined) {
	if (!t.trim()) {
		return;
	}
	const last = turns[turns.length - 1];
	if (last?.role === role) {
		last.text = `${last.text}\n\n${t}`;
	} else {
		turns.push({ role, text: t, at });
	}
}

/**
 * The conversation of a Codex rollout (~/.codex/sessions/…/rollout-*.jsonl). Codex has written it two ways. Newer
 * rollouts (thread history) record each finished item as an `item_completed` event: a `UserMessage` is what the user
 * typed, an `AgentMessage` an answer (progress notes and the final one alike). Older ones have a `user_message` event
 * per prompt and the answers as assistant response items. The `user` response items are never read: they also carry
 * the AGENTS.md, environment and skill blocks Codex adds. Lines that are not JSON are skipped.
 */
export function codexTurns(text: string): Turn[] {
	const items: Turn[] = [];
	const legacy: Turn[] = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		let e: Record<string, unknown> | undefined;
		try {
			e = record(JSON.parse(line));
		} catch {
			continue;
		}
		const p = record(e?.payload);
		const at = typeof e?.timestamp === 'string' ? e.timestamp : undefined;
		const item = record(p?.item);
		if (e?.type === 'event_msg' && p?.type === 'item_completed' && (item?.type === 'UserMessage' || item?.type === 'AgentMessage')) {
			add(items, item.type === 'UserMessage' ? 'user' : 'assistant', outputText(item.content), at);
		} else if (e?.type === 'event_msg' && p?.type === 'user_message' && typeof p.message === 'string') {
			add(legacy, 'user', p.message, at);
		} else if (e?.type === 'response_item' && p?.type === 'message' && p.role === 'assistant') {
			add(legacy, 'assistant', outputText(p.content), at);
		}
	}
	// Cut once each turn is whole, so the note counts what was left out of the whole turn.
	return (items.length ? items : legacy).map(t => ({ ...t, text: cut(t.text) }));
}

/** The session id of a Codex rollout, from its session_meta line, or from the file name (rollout-<time>-<id>.jsonl). */
export function codexRolloutId(fileName: string, firstLine?: string): string | undefined {
	if (firstLine) {
		try {
			const p = record(record(JSON.parse(firstLine))?.payload);
			if (typeof p?.id === 'string' && UUID.test(p.id)) {
				return p.id;
			}
		} catch {
			// fall back to the name
		}
	}
	const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(fileName);
	return m?.[1];
}

/**
 * Where Codex most likely put a session's rollout: its <year>/<month>/<day> folder, named by the local date the session
 * started. Codex's thread ids are uuidv7, whose first 48 bits are that start time in milliseconds, so the day is read
 * from the id; the days on either side cover a changed time zone. Empty for an id that is not a uuidv7.
 */
export function rolloutDays(id: string): string[][] {
	if (!UUID.test(id) || id[14] !== '7') {
		return [];
	}
	const ms = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
	const pad = (n: number) => String(n).padStart(2, '0');
	return [0, -1, 1].map(d => {
		const t = new Date(ms + d * 86_400_000);
		return [String(t.getFullYear()), pad(t.getMonth() + 1), pad(t.getDate())];
	});
}

/** A copy of a Claude transcript made for Codex's importer: named so Insilode finds a leftover one (Codex takes any name). */
export const IMPORT_COPY = /^insilode-swap-[0-9a-f-]{36}\.jsonl$/i;

export interface ClaudeMeta {
	cwd: string;
	sessionId: string;
	gitBranch?: string;
	title?: string;
	/** A fresh uuid for each line (crypto.randomUUID). */
	newId: () => string;
	/** For lines without a time of their own. */
	now: string;
}

/**
 * A Claude Code transcript of `turns`: one line per turn, chained by parentUuid as Claude writes them, with a closing
 * note that says where the conversation came from, and the title (a custom-title line, what /rename writes) so the
 * session is named in Claude's /resume list and in Insilode's. Undefined when there is no conversation to carry.
 */
export function claudeTranscript(turns: Turn[], meta: ClaudeMeta, from = 'Codex'): string | undefined {
	if (!turns.some(t => t.role === 'user') || !turns.some(t => t.role === 'assistant')) {
		return undefined;
	}
	const base = { cwd: meta.cwd, sessionId: meta.sessionId, userType: 'external', entrypoint: 'cli', isSidechain: false, ...(meta.gitBranch ? { gitBranch: meta.gitBranch } : {}) };
	const lines: string[] = [];
	let parent: string | null = null;
	let at = meta.now;
	const push = (role: 'user' | 'assistant', text: string, time: string) => {
		const uuid = meta.newId();
		const message = role === 'user'
			? { role, content: text }
			: { role, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
		lines.push(JSON.stringify({ type: role, message, uuid, parentUuid: parent, timestamp: time, ...base }));
		parent = uuid;
	};
	// The resumed model should know the earlier answers were another agent's and that their tool results are not here.
	// It goes in front of the first message rather than as a turn of its own, so no answer is put in the model's mouth.
	const note = `[Insilode: this conversation was moved here from ${from}. The answers in it are ${from}'s; its tool calls and their output were not carried over, so check the files before relying on them.]\n\n`;
	let first = true;
	for (const t of turns) {
		at = t.at ?? at;
		push(t.role, first && t.role === 'user' ? note + t.text : t.text, at);
		first &&= t.role !== 'user';
	}
	if (meta.title) {
		lines.push(JSON.stringify({ type: 'custom-title', customTitle: meta.title, sessionId: meta.sessionId }));
	}
	return `${lines.join('\n')}\n`;
}

/** The two requests Codex's app-server takes for an import: initialize, then externalAgentConfig/import of one session. */
export function codexImportRequests(transcript: string, cwd: string, title: string | undefined): string[] {
	return [
		JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'insilode', version: '1' } } }),
		JSON.stringify({ method: 'initialized' }),
		JSON.stringify({
			id: 2,
			method: 'externalAgentConfig/import',
			params: {
				migrationItems: [{ itemType: 'SESSIONS', description: 'Insilode: continue a Claude session in Codex', cwd, details: { sessions: [{ cwd, path: transcript, title: title ?? null }] } }],
				source: 'insilode',
			},
		}),
	];
}

/** What a line from the app-server means for the import: still waiting, the new Codex thread, or why it failed. */
export type ImportStep = { wait: true } | { thread: string } | { error: string };

/**
 * Reads one line of the app-server's output. An error reply to either request ends the import; so does the
 * `externalAgentConfig/import/completed` notification, which names the new thread (its `target`) or the failure.
 */
export function codexImportStep(line: string): ImportStep {
	let m: Record<string, unknown> | undefined;
	try {
		m = record(JSON.parse(line));
	} catch {
		return { wait: true };
	}
	const err = record(m?.error);
	if (err && (m?.id === 1 || m?.id === 2)) {
		return { error: typeof err.message === 'string' ? err.message : 'Codex refused the request' };
	}
	if (m?.method !== 'externalAgentConfig/import/completed') {
		return { wait: true };
	}
	const results = record(m.params)?.itemTypeResults;
	for (const r of Array.isArray(results) ? results : []) {
		const rr = record(r);
		if (rr?.itemType !== 'SESSIONS') {
			continue;
		}
		const ok = Array.isArray(rr.successes) ? record(rr.successes[0]) : undefined;
		// The id is typed into a terminal (`codex resume <id>`): only a uuid, which no shell reads anything into, is taken.
		if (typeof ok?.target === 'string' && ok.target) {
			return UUID.test(ok.target) ? { thread: ok.target } : { error: 'Codex named the new session with an id that is not a uuid' };
		}
		const bad = Array.isArray(rr.failures) ? record(rr.failures[0]) : undefined;
		if (bad) {
			return { error: typeof bad.message === 'string' ? bad.message : 'Codex could not import the session' };
		}
	}
	return { error: 'Codex finished the import without a session' };
}
