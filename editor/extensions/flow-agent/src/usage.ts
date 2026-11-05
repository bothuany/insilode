/*---------------------------------------------------------------------------------------------
 *  Insilode: what an agent says about its context window and its plan's usage limits, read from what
 *  the CLI itself reports. Nothing here guesses a window size: a number the CLI did not give stays
 *  unknown, and the views show the tokens without a percentage.
 *
 *  - Claude Code hands its status-line command a JSON object on every refresh: `model`, a
 *    `context_window` with `context_window_size` and `total_input_tokens` (the last request's input,
 *    cached tokens included), and, on a claude.ai plan, `rate_limits.five_hour` / `seven_day` with a
 *    `used_percentage` (0-100) and `resets_at` (epoch seconds). Hooks get none of this.
 *  - Claude's transcript has the token counts but only the API model id (never a `[1m]` suffix), so it
 *    gives the used tokens and no window.
 *  - Codex writes `token_count` events into its rollout file (the hooks' `transcript_path`):
 *    `info.last_token_usage`, `info.model_context_window`, and `rate_limits.primary` / `secondary`
 *    with `used_percent`, `window_minutes` and `resets_at` (epoch seconds).
 *
 *  Also here: Insilode's status-line script for Claude, and the small rules around these numbers (when
 *  Compact may type into a terminal, when a report is stale, whether the user has a status line of
 *  their own). No vscode, so all of it is tested on its own.
 *--------------------------------------------------------------------------------------------*/

import { accessSync, constants, existsSync, readFileSync } from 'fs';
import * as path from 'path';

/** How full one agent's context window is. `size` is absent when the agent did not say. */
export interface ContextUsage {
	used: number;
	size?: number;
	model?: string;
	/** Share of the window in use (0-100) where the CLI counts it its own way (Codex); else used / size. */
	percent?: number;
}

/** One usage window of a plan: the 5-hour or the weekly limit, say. */
export interface LimitWindow {
	/** Short, for the status bar: `5h`, `wk`. */
	label: string;
	/** Share of the window used, 0-100. */
	usedPercent: number;
	/** When the window resets, in ms since the epoch. */
	resetsAt?: number;
}

/** A harness's usage limits as its CLI last reported them. Limits are per account, not per session. */
export interface UsageLimits {
	harness: string;
	windows: LimitWindow[];
}

const num = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const str = (v: unknown): string | undefined => typeof v === 'string' && v ? v : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;

/** A reset time as epoch seconds (what both CLIs send today) or an ISO string, as ms since the epoch. */
export function resetTime(v: unknown): number | undefined {
	const n = num(v);
	if (n !== undefined) {
		// Seconds today; a value already in milliseconds would be a date thousands of years out, so take it as it is.
		return n > 1e12 ? n : n * 1000;
	}
	const s = str(v);
	const t = s ? Date.parse(s) : NaN;
	return Number.isNaN(t) ? undefined : t;
}

/** A window length in minutes as a status bar label. */
export function windowLabel(minutes: number | undefined): string {
	if (minutes === undefined) {
		return '';
	}
	if (minutes === 7 * 24 * 60) {
		return 'wk';
	}
	return minutes % (24 * 60) === 0 ? `${minutes / (24 * 60)}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`;
}

/** `observedAt` dates a relative `resets_in_seconds` (what older Codex versions sent instead of `resets_at`). */
function window(label: string, w: unknown, percent: string, observedAt?: number): LimitWindow | undefined {
	const o = obj(w);
	const used = num(o?.[percent]);
	if (!o || used === undefined) {
		return undefined;
	}
	const inSeconds = num(o.resets_in_seconds);
	const resetsAt = resetTime(o.resets_at) ?? (inSeconds !== undefined && observedAt !== undefined ? observedAt + inSeconds * 1000 : undefined);
	return { label, usedPercent: Math.max(0, Math.min(100, used)), ...(resetsAt !== undefined ? { resetsAt } : {}) };
}

/** Claude Code's status-line JSON: the session it is about, its context fill, and the plan's limits when known. */
export function parseClaudeStatus(payload: unknown): { sessionId?: string; transcript?: string; usage?: ContextUsage; limits?: UsageLimits } {
	const p = obj(payload) ?? {};
	const model = obj(p.model);
	const name = str(model?.display_name) ?? str(model?.id);
	const cw = obj(p.context_window);
	const size = num(cw?.context_window_size);
	// total_input_tokens is the last request's input side (fresh + cache read + cache write): what fills the window now.
	// Before the first request it is 0, and the window is still worth showing.
	const used = num(cw?.total_input_tokens);
	const usage: ContextUsage | undefined = cw && (used !== undefined || size !== undefined)
		? { used: used ?? 0, ...(size ? { size } : {}), ...(name ? { model: name } : {}) }
		: undefined;
	const rl = obj(p.rate_limits);
	const windows = [window('5h', rl?.five_hour, 'used_percentage'), window('wk', rl?.seven_day, 'used_percentage')].filter((w): w is LimitWindow => !!w);
	return {
		sessionId: str(p.session_id),
		transcript: str(p.transcript_path),
		usage,
		limits: windows.length ? { harness: 'Claude Code', windows } : undefined,
	};
}

/**
 * Context in use from the end of a Claude transcript: the last assistant message's input side. The window
 * is left out on purpose: the transcript carries the API model id, which never says whether the session
 * runs with the 1M window.
 */
export function claudeTranscriptUsage(lines: string[]): ContextUsage | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry: { type?: string; message?: { model?: string; usage?: Record<string, number> } };
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const u = entry.type === 'assistant' ? entry.message?.usage : undefined;
		if (u) {
			const used = (num(u.input_tokens) ?? 0) + (num(u.cache_read_input_tokens) ?? 0) + (num(u.cache_creation_input_tokens) ?? 0);
			const model = str(entry.message?.model);
			return { used, ...(model ? { model } : {}) };
		}
	}
	return undefined;
}

/**
 * Codex leaves this many tokens out when it says how full the window is: the system prompt and tools that every
 * request carries and no compaction frees. Codex's own TUI computes the share as (used - baseline) / (window -
 * baseline) (`BASELINE_TOKENS` in codex-rs protocol), so Insilode shows the same figure the CLI does.
 */
export const CODEX_BASELINE_TOKENS = 12_000;

/** The share of a Codex window in use, the way Codex computes it. */
export function codexPercent(used: number, size: number): number {
	const room = size - CODEX_BASELINE_TOKENS;
	if (room <= 0) {
		return 100;
	}
	return Math.max(0, Math.min(100, Math.round(Math.max(0, used - CODEX_BASELINE_TOKENS) / room * 100)));
}

/** The newest context fill and limits in the end of a Codex rollout file. Either can be missing. `now` dates lines without a timestamp. */
export function codexRolloutUsage(lines: string[], now = Date.now()): { usage?: ContextUsage; limits?: UsageLimits } {
	let usage: ContextUsage | undefined;
	let limits: UsageLimits | undefined;
	let model: string | undefined;
	for (let i = lines.length - 1; i >= 0 && (!usage || !limits || !model); i--) {
		let entry: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
		try {
			entry = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		const p = obj(entry.payload);
		if (!p) {
			continue;
		}
		if (entry.type === 'turn_context') {
			model ??= str(p.model);
			continue;
		}
		if (entry.type !== 'event_msg' || p.type !== 'token_count') {
			continue;
		}
		const info = obj(p.info);
		const last = obj(info?.last_token_usage);
		if (!usage && last) {
			// The last request's tokens are what the window holds now; the running total counts every turn again.
			const used = num(last.total_tokens) ?? (num(last.input_tokens) ?? 0) + (num(last.output_tokens) ?? 0);
			const size = num(info?.model_context_window);
			usage = { used, ...(size ? { size, percent: codexPercent(used, size) } : {}) };
		}
		const rl = obj(p.rate_limits);
		if (!limits && rl) {
			const stamp = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
			const observedAt = Number.isNaN(stamp) ? now : stamp;
			const windows = ['primary', 'secondary']
				.map(k => window(windowLabel(num(obj(rl[k])?.window_minutes)) || (k === 'primary' ? 'short' : 'long'), rl[k], 'used_percent', observedAt))
				.filter((w): w is LimitWindow => !!w);
			if (windows.length) {
				limits = { harness: 'Codex', windows };
			}
		}
	}
	if (usage && model) {
		usage.model = model;
	}
	return { usage, limits };
}

/** A new report merged into what is known: a report without a window never forgets the window an earlier one gave. */
export function mergeUsage(before: ContextUsage | undefined, next: ContextUsage): ContextUsage {
	const size = next.size ?? before?.size;
	const model = next.model ?? before?.model;
	// A CLI-computed share belongs to the numbers it came with: it is never carried over to a newer report.
	return { used: next.used, ...(size ? { size } : {}), ...(model ? { model } : {}), ...(next.percent !== undefined ? { percent: next.percent } : {}) };
}

/** What the usage rules need of a session. */
export interface UsageHolder {
	state: string;
	usage?: ContextUsage;
	/** Bumped when the session ends: a read that started before then is stale. */
	usageEpoch?: number;
}

/**
 * Takes a report into the session when it is still news: not for a session that has ended (a late status-line
 * refresh or a transcript read that finished after the end would put dropped numbers back), not from a read
 * that started before the session ended (`epoch`), and not when nothing changed. Says whether it took it.
 */
export function applyUsage(s: UsageHolder, next: ContextUsage, epoch = s.usageEpoch ?? 0): boolean {
	if (s.state === 'ended' || epoch !== (s.usageEpoch ?? 0)) {
		return false;
	}
	const usage = mergeUsage(s.usage, next);
	const u = s.usage;
	if (u && u.used === usage.used && u.size === usage.size && u.model === usage.model && u.percent === usage.percent) {
		return false;
	}
	s.usage = usage;
	return true;
}

/** The session ended: its numbers go, and any read still running for it is now stale. */
export function endUsage(s: UsageHolder) {
	s.usage = undefined;
	s.usageEpoch = (s.usageEpoch ?? 0) + 1;
}

/**
 * Whether the user set a status line of their own anywhere Claude reads it for this workspace: their user settings
 * and every folder's project and local settings. Insilode's status line would take its place, so Insilode adds none then.
 * A file that cannot be read or parsed counts as having none.
 */
export function hasOwnStatusLine(configDir: string, folders: string[]): boolean {
	const files = [path.join(configDir, 'settings.json'), ...folders.flatMap(f => [path.join(f, '.claude', 'settings.json'), path.join(f, '.claude', 'settings.local.json')])];
	return files.some(file => {
		try {
			return !!(JSON.parse(readFileSync(file, 'utf8')) as { statusLine?: unknown }).statusLine;
		} catch {
			return false;
		}
	});
}

/**
 * A program on PATH (`node`), or undefined. No process is started to find it. Off Windows a file that is not executable
 * does not count, so a stray `node` without the execute bit falls through to the next PATH entry (or to no result).
 */
export function findOnPath(name: string, envPath = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform): string | undefined {
	const file = platform === 'win32' ? `${name}.exe` : name;
	for (const dir of envPath.split(platform === 'win32' ? ';' : ':')) {
		const p = dir && path.join(dir.replace(/^"|"$/g, ''), file);
		if (p && existsSync(p) && (platform === 'win32' || executable(p))) {
			return p;
		}
	}
	return undefined;
}

function executable(file: string): boolean {
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Sends a harness's limits once per change. The marker is set only once the send went through, so a report lost
 * because flow-harness was not up yet goes again with the next one.
 */
export class LimitsSender {
	private readonly sent = new Map<string, string>();
	private readonly sending = new Map<string, string>();

	constructor(private readonly send: (limits: UsageLimits) => PromiseLike<unknown>) { }

	/** Whether this report went out now, was a repeat of one that went through (or is going), or failed to go. */
	async offer(limits: UsageLimits): Promise<'sent' | 'repeat' | 'failed'> {
		const key = JSON.stringify(limits.windows);
		if (this.sent.get(limits.harness) === key || this.sending.get(limits.harness) === key) {
			return 'repeat';
		}
		this.sending.set(limits.harness, key);
		try {
			await this.send(limits);
			this.sent.set(limits.harness, key);
			return 'sent';
		} catch {
			return 'failed';
		} finally {
			if (this.sending.get(limits.harness) === key) {
				this.sending.delete(limits.harness);
			}
		}
	}
}

/**
 * The line Insilode's status line shows under Claude's prompt: `Sonnet 5.5 · ctx 7% · 5h 32% · wk 61%`, only what
 * the CLI told (the tokens, not a share, when there is no window). Self-contained: its source is copied into the
 * status-line script as it is, so it may use nothing from outside.
 */
export function statusText(p: unknown): string {
	const o = (v: unknown) => v && typeof v === 'object' ? v as Record<string, unknown> : {};
	const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
	const k = (t: number) => t >= 1e6 ? `${+(t / 1e6).toFixed(1)}M` : t >= 1000 ? `${(t / 1000).toFixed(t >= 1e5 ? 0 : 1)}k` : String(t);
	const root = o(p);
	const model = o(root.model);
	const name = typeof model.display_name === 'string' ? model.display_name : typeof model.id === 'string' ? model.id : '';
	const cw = o(root.context_window);
	const used = n(cw.total_input_tokens);
	const size = n(cw.context_window_size);
	const ctx = used === undefined ? '' : size ? `ctx ${Math.min(100, Math.round(used / size * 100))}%` : `ctx ${k(used)}`;
	const rl = o(root.rate_limits);
	const lim = (label: string, w: unknown) => {
		const u = n(o(w).used_percentage);
		return u === undefined ? '' : `${label} ${Math.round(u)}%`;
	};
	return [name, ctx, lim('5h', rl.five_hour), lim('wk', rl.seven_day)].filter(Boolean).join(' · ');
}

/**
 * Insilode's status-line command for Claude. It prints `statusText` (Claude shows a custom status line in place of its
 * own footer hints, so the line should be worth its place), then forwards the JSON to the Insilode window that owns the
 * folder now, but only when the numbers changed since the last forward that went through: Claude runs the command on
 * every refresh, and most refreshes change nothing. The marker sits in `stateDir`, per agent, and holds the port, so
 * a reloaded window (a new port) hears the current numbers again.
 */
export function statusScript(portFile: string, tokenFile: string, stateDir: string): string {
	return `// Written by Insilode: the status line of an Insilode agent. Prints a short line and forwards the status JSON to Insilode (observe only).
const fs = require('fs'), http = require('http'), path = require('path');
const statusText = ${statusText.toString()};
const done = () => process.exit(0);
let body = '';
process.stdin.on('data', d => body += d).on('end', () => {
	let p = {};
	try { p = JSON.parse(body); } catch {}
	try { process.stdout.write(statusText(p) + '\\n'); } catch {}
	let port, token;
	try { port = fs.readFileSync(${JSON.stringify(portFile)}, 'utf8').trim(); token = fs.readFileSync(${JSON.stringify(tokenFile)}, 'utf8').trim(); } catch { return done(); }
	if (!port) return done();
	const cw = p.context_window || {}, rl = p.rate_limits || {};
	const key = JSON.stringify([port, p.session_id, p.model && p.model.id, cw.total_input_tokens, cw.context_window_size, rl.five_hour, rl.seven_day]);
	const agent = String(process.env.FLOW_AGENT_SESSION || p.session_id || 'agent').replace(/[^\\w-]/g, '');
	const mark = path.join(${JSON.stringify(stateDir)}, 'status-' + agent + '.last');
	let last = '';
	try { last = fs.readFileSync(mark, 'utf8'); } catch {}
	if (last === key) return done();
	const req = http.request({ host: '127.0.0.1', port, path: '/status', method: 'POST', timeout: 3000, headers: { 'Content-Type': 'application/json', 'X-Flow-Token': token, 'X-Flow-Agent': process.env.FLOW_AGENT_SESSION || '' } }, res => {
		res.resume();
		res.on('end', () => { if (res.statusCode === 200) { try { fs.writeFileSync(mark, key); } catch {} } done(); });
	});
	req.on('error', done).on('timeout', () => { req.destroy(); done(); });
	req.end(body);
});
setTimeout(done, 4000);
`;
}
