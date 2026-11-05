/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the harness at runtime. flow-agent forwards each hook event of the agents it
 *  runs (`flowHarness.recordEvent`); this counts what they used, reads their transcripts for what
 *  no hook reports, and on first run reads the last 30 days of this project's Claude Code
 *  transcripts so "never used" is not a guess on day one. Counts, prompts and failures are kept
 *  in this workspace's extension storage, bounded.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { countEvent, countTranscript, coveredDays, coveredFrom, loadActivity, prune, summary, WINDOW_DAYS, type ActivityData, type AgentEvent, type HookLike, type Summary } from './activity';
import { frictionState, FRICTION_KEY, MAX_DISMISSED, MAX_FAILURES, MAX_PROMPTS, OLD_FRICTION_KEY, redact, sanitizeFriction, type FailureRecord, type FrictionData, type PromptRecord } from './friction';
import { isTranscriptPath, parseTranscript, readLines, type TranscriptFacts } from './transcript';
import { claudeDir, projectTranscripts } from './dirs';

const ACTIVITY = 'flowHarness.activity';
const BACKFILL_FILES = 200;
const DAY = 86_400_000;
/** Agents remembered by name, for the X-ray's session list. */
const MAX_SESSIONS = 50;

export type { FrictionData };

export interface LiveSession {
	/** flow-agent's id for the session, when it ran in the Agents dock: what Compact and Measure in the X-ray address. */
	id?: string;
	agent: string;
	/** The permission mode its hooks reported last (Claude Code sends it on most events). */
	mode?: string;
	cli: string;
	transcript?: string;
	at: number;
}

/** Claude Code's permission modes, as hooks report them: anything else is not kept. */
const MODES = new Set(['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);

const str = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : undefined;

/** The page or another extension sends this: only known fields of the right type, each bounded, are kept. */
export function eventOf(raw: unknown): AgentEvent | undefined {
	const r = raw as Record<string, unknown> | undefined;
	if (!r || typeof r !== 'object' || typeof r.event !== 'string' || typeof r.agent !== 'string') {
		return undefined;
	}
	const input: Record<string, string> = {};
	if (r.input && typeof r.input === 'object') {
		// The same fields flow-agent forwards (EVENT_INPUT in its agents.ts): keep the two lists in step.
		for (const k of ['skill', 'subagent_type', 'command', 'file_path', 'path', 'url', 'pattern']) {
			const v = str((r.input as Record<string, unknown>)[k], 600);
			if (v !== undefined) {
				input[k] = v;
			}
		}
	}
	return {
		at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : Date.now(),
		agent: r.agent.slice(0, 200), cli: str(r.cli, 20) ?? 'claude', session: str(r.session, 200), event: r.event.slice(0, 60),
		tool: str(r.tool, 200), input, error: str(r.error, 1000), durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : undefined,
		id: str(r.id, 200), mode: typeof r.mode === 'string' && MODES.has(r.mode) ? r.mode : undefined,
		prompt: str(r.prompt, 2000), agentType: str(r.agentType, 200), transcript: isTranscriptPath(r.transcript, claudeDir()) ? r.transcript : undefined,
	};
}

export class Live implements vscode.Disposable {
	private data: ActivityData;
	private friction: FrictionData;
	readonly sessions = new Map<string, LiveSession>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private saveTimer: NodeJS.Timeout | undefined;
	private readonly reading = new Map<string, Promise<void>>();
	private backfilled = false;

	constructor(private readonly state: vscode.Memento, private readonly hooks: () => HookLike[]) {
		this.data = loadActivity(state.get(ACTIVITY), Date.now());
		// The versioned key first, then what an earlier build stored: checked field by field either way, damaged data is ignored.
		this.friction = sanitizeFriction(state.get<unknown>(FRICTION_KEY) ?? state.get<unknown>(OLD_FRICTION_KEY));
	}

	get frictionData(): Readonly<FrictionData> {
		return this.friction;
	}

	summary(key: string): Summary {
		return summary(this.data, key, Date.now());
	}

	get covered() {
		return coveredDays(this.data, Date.now());
	}

	/** How many transcripts the counts come from: "never used" needs a few sessions behind it, not one. */
	get sessionsSeen() {
		return Object.keys(this.data.transcripts).length;
	}

	record(raw: unknown) {
		const ev = eventOf(raw);
		if (!ev) {
			return;
		}
		// By flow-agent's id when there is one: a renamed agent is the same session, and two agents may share a name.
		const key = ev.id ?? ev.agent;
		const seen = this.sessions.get(key);
		const transcript = ev.transcript ?? seen?.transcript;
		this.sessions.delete(key);
		this.sessions.set(key, { id: ev.id, agent: ev.agent, cli: ev.cli, transcript, at: ev.at, mode: ev.mode ?? seen?.mode });
		if (this.sessions.size > MAX_SESSIONS) {
			this.sessions.delete(this.sessions.keys().next().value!);
		}
		countEvent(this.data, ev, this.hooks());
		if (ev.event === 'UserPromptSubmit' && ev.prompt) {
			this.addPrompt({ text: ev.prompt, at: ev.at, cli: ev.cli, session: ev.session });
		}
		if (ev.event === 'PostToolUseFailure' && ev.tool && ev.error) {
			this.addFailure({ tool: ev.tool, subject: ev.input?.command ?? ev.input?.file_path ?? ev.input?.path ?? ev.input?.url ?? '', error: ev.error, at: ev.at, cli: ev.cli, session: ev.session });
		}
		// The turn is over: what the transcript adds (files loaded, hook failures, Stop hook times) is written by now.
		if (ev.transcript && ev.cli === 'claude' && (ev.event === 'Stop' || ev.event === 'SubagentStop' || ev.event === 'SessionEnd')) {
			void this.ingest(ev.transcript, true);
		}
		this.touch();
	}

	private addPrompt(p: PromptRecord) {
		// A prompt seen as an event and again in its transcript (or in a resumed one) is one prompt.
		if (this.friction.prompts.some(x => x.text === redact(p.text.slice(0, 1000)) && Math.abs(x.at - p.at) < 5000)) {
			return;
		}
		this.friction.prompts.push({ ...p, text: redact(p.text.slice(0, 1000)) });
		this.friction.prompts.splice(0, Math.max(0, this.friction.prompts.length - MAX_PROMPTS));
	}

	private addFailure(f: FailureRecord) {
		this.friction.failures.push({ ...f, subject: redact(f.subject.slice(0, 300)), error: redact(f.error.slice(0, 600)) });
		this.friction.failures.splice(0, Math.max(0, this.friction.failures.length - MAX_FAILURES));
	}

	/** Forgets every stored prompt, failure and dismissal (the usage counts stay). */
	clearFriction() {
		this.friction = { prompts: [], failures: [], dismissed: [] };
		this.touch();
	}

	dismiss(id: string) {
		if (!this.friction.dismissed.includes(id)) {
			this.friction.dismissed.push(id);
			this.friction.dismissed.splice(0, Math.max(0, this.friction.dismissed.length - MAX_DISMISSED));
			this.touch();
		}
	}

	/**
	 * Reads what is new in a transcript. For a session Insilode's hooks reported (`live`), tool calls, prompts and failures
	 * came as events already; for a past one they come from here.
	 */
	ingest(file: string, live: boolean): Promise<void> {
		if (!isTranscriptPath(file, claudeDir())) {
			return Promise.resolve();
		}
		const running = this.reading.get(file);
		if (running) {
			return running;
		}
		const job = (async () => {
			const seen = this.data.transcripts[file];
			const isLive = live || !!seen?.live;
			const { end, from } = await readLines(file, seen?.offset ?? 0, lines => this.take(file, parseTranscript(lines), isLive));
			this.data.transcripts[file] = { offset: end, live: isLive, at: Date.now(), from: from ?? seen?.from };
			this.touch();
		})().catch(e => console.warn(`flow-harness: could not read ${file}: ${(e as Error).message}`)).finally(() => this.reading.delete(file));
		this.reading.set(file, job);
		return job;
	}

	/** Counts one stretch of a transcript; for a past session also its prompts and failures. */
	private take(file: string, facts: TranscriptFacts, isLive: boolean) {
		countTranscript(this.data, facts, this.hooks(), Date.now(), !isLive);
		if (isLive) {
			return;
		}
		const cutoff = Date.now() - WINDOW_DAYS * DAY;
		for (const p of facts.prompts) {
			const at = Date.parse(p.at ?? '') || Date.now();
			if (at >= cutoff) {
				this.addPrompt({ text: p.text, at, cli: 'claude', session: path.basename(file, '.jsonl') });
			}
		}
		for (const e of facts.toolErrors) {
			const at = Date.parse(e.at ?? '') || Date.now();
			const subject = typeof e.input.command === 'string' ? e.input.command : typeof e.input.file_path === 'string' ? e.input.file_path : '';
			if (at >= cutoff) {
				this.addFailure({ tool: e.tool, subject, error: e.error, at, cli: 'claude', session: path.basename(file, '.jsonl') });
			}
		}
	}

	/** Once per window: the last 30 days of this folder's transcripts (its worktrees' too), newest first and bounded, read in the background. */
	async backfill(root: string) {
		if (this.backfilled) {
			return;
		}
		this.backfilled = true;
		// Sessions an agent ran in a worktree of this project count too: an editor built on a worktree per agent has most there.
		const transcripts = await projectTranscripts(root);
		const cutoff = Date.now() - WINDOW_DAYS * DAY;
		const inWindow = (await Promise.all(transcripts.map(async file => {
			const st = await fs.stat(file).catch(() => undefined);
			return st && st.mtimeMs >= cutoff ? { file, mtime: st.mtimeMs, size: st.size } : undefined;
		}))).filter((x): x is { file: string; mtime: number; size: number } => !!x).sort((a, b) => b.mtime - a.mtime);
		const files = inWindow.slice(0, BACKFILL_FILES);
		for (const f of files) {
			// A transcript read before and unchanged since needs no second look.
			if (this.data.transcripts[f.file]?.offset !== f.size) {
				await this.ingest(f.file, false);
			}
		}
		// The counts speak for the stretch that was read in full: the whole window, unless a transcript was too large to read
		// from its start or older ones were left out, in which case they begin where what was read begins.
		const partial = files.map(f => this.data.transcripts[f.file]?.from).filter((t): t is number => t !== undefined);
		const skipped = inWindow.length > files.length ? inWindow[files.length].mtime : undefined;
		const from = coveredFrom(cutoff, partial, skipped);
		this.data.since = Math.min(Math.max(this.data.since, cutoff), from);
		this.touch();
	}

	/** Everything one transcript says, for the X-ray: its start (listings, memory, the first request) and its newest part. */
	async facts(file: string): Promise<TranscriptFacts | undefined> {
		if (!isTranscriptPath(file, claudeDir())) {
			return undefined;
		}
		try {
			const h = await fs.open(file, 'r');
			let head: string;
			let tail = '';
			let partial = false;
			try {
				const size = (await h.stat()).size;
				partial = size > 4 << 20;
				const headLen = Math.min(size, 2 << 20);
				const hb = Buffer.alloc(headLen);
				await h.read(hb, 0, headLen, 0);
				head = hb.toString('utf8');
				if (size > headLen) {
					const tailLen = Math.min(size - headLen, 2 << 20);
					const tb = Buffer.alloc(tailLen);
					await h.read(tb, 0, tailLen, size - tailLen);
					tail = tb.toString('utf8');
				}
			} finally {
				await h.close();
			}
			const headLines = head.split('\n');
			headLines.pop();
			const tailLines = tail ? tail.split('\n').slice(1) : [];
			// The middle of a large transcript is not read: what is counted there (compactions) is a lower bound.
			return { ...parseTranscript([...headLines, ...tailLines]), partial };
		} catch {
			return undefined;
		}
	}

	private touch() {
		this.changed.fire();
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), 1500);
	}

	private save() {
		prune(this.data, Date.now());
		void this.state.update(ACTIVITY, this.data);
		// Redacted and bounded again on the way out; the unversioned key of earlier builds is dropped once the new one is written.
		void this.state.update(FRICTION_KEY, frictionState(this.friction));
		if (this.state.get(OLD_FRICTION_KEY) !== undefined) {
			void this.state.update(OLD_FRICTION_KEY, undefined);
		}
	}

	dispose() {
		clearTimeout(this.saveTimer);
		this.save();
		this.changed.dispose();
	}
}
