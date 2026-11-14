/*---------------------------------------------------------------------------------------------
 *  Insilode: what both chat front ends share (sessionType.ts, VS Code's own chat, and chatSessions.ts, the Agents page's chat):
 *  reading an ACP agent's config options, the rule that answers a permission request for the user, and turning the session
 *  updates of a turn or of a history replay into the page's ChatEvents. Pure (no vscode): tested on its own (test/chatCore.test.mjs).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import type { SessionConfigOption, SessionNotification } from '@agentclientprotocol/sdk';
import type { ChatConfigOption, ChatEvent } from './agentsData';

type Update = SessionNotification['update'];

/** One select-type ACP config option, flattened (options may be grouped). */
export function selectItems(opt: SessionConfigOption): { value: string; name: string; description?: string }[] {
	const raw = (opt as { options?: unknown[] }).options ?? [];
	const out: { value: string; name: string; description?: string }[] = [];
	for (const o of raw as Array<{ value?: string; name?: string; description?: string; options?: unknown[] }>) {
		if (o.options) {
			out.push(...selectItems({ ...opt, options: o.options } as SessionConfigOption));
		} else if (o.value !== undefined) {
			out.push({ value: o.value, name: o.name ?? o.value, description: o.description ?? undefined });
		}
	}
	return out;
}

export function currentValue(opt: SessionConfigOption): string | undefined {
	const v = (opt as { currentValue?: unknown }).currentValue;
	return typeof v === 'string' ? v : undefined;
}

type PermissionOption = { optionId: string; name: string; kind: string };

/** Whether `child` is `parent` or inside it (path.relative: a sibling named like the parent plus a suffix is not). */
export function isInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Names an agent's own configuration or hooks live under: an edit there can change what runs next, so the user always sees it.
 * `.mcp.json` is the folder's MCP server list (the trust dialog says it runs code); other files stay out of this list on purpose.
 */
const PROTECTED = new Set(['.git', '.claude', '.vscode', '.mcp.json']);

/**
 * The real path of `p`, or of its deepest ancestor that exists plus the rest, so a symlink cannot hide where a new file lands.
 * Undefined when a link on the way leads nowhere (realpath fails but lstat finds a link): a write through it would create its
 * target, wherever that is, so the path cannot be vouched for.
 */
function realOf(p: string): string | undefined {
	const rest: string[] = [];
	let cur = p;
	for (;;) {
		try {
			return path.join(fs.realpathSync.native(cur), ...rest.reverse());
		} catch {
			try {
				if (fs.lstatSync(cur).isSymbolicLink()) {
					return undefined;
				}
			} catch {
				// Not there at all: a new file, so its parent decides.
			}
			const up = path.dirname(cur);
			if (up === cur) {
				return p;
			}
			rest.push(path.basename(cur));
			cur = up;
		}
	}
}

/** Inside `root` and under none of the protected names (lower-cased: a case-insensitive disk spells `.GIT` too). */
function plainInside(root: string, p: string): boolean {
	return isInside(root, p) && !path.relative(root, p).split(/[\\/]/).some(seg => PROTECTED.has(seg.toLowerCase()));
}

/**
 * Whether every file an edit names lies inside `cwd` (as written and after resolving symlinks) and outside .git, .claude, .vscode
 * and .mcp.json. No file at all, an empty one, a URI (`file://…`) or a link that leads nowhere is not "inside": when unsure, the
 * user is asked.
 */
export function editsInside(cwd: string, files: string[]): boolean {
	if (!cwd || !files.length) {
		return false;
	}
	const root = path.resolve(cwd);
	const realRoot = realOf(root);
	return !!realRoot && files.every(f => {
		// A scheme needs two letters, so a Windows drive (`C:\x`) is still a path.
		if (!f || /^[a-z][a-z0-9+.-]+:/i.test(f)) {
			return false;
		}
		const abs = path.resolve(root, f);
		const real = realOf(abs);
		return plainInside(root, abs) && real !== undefined && plainInside(realRoot, real);
	});
}

/**
 * Every write asks first (the agent runs in `default`); the user's own mode decides which questions Insilode answers for them.
 * Only bypassPermissions answers everything; acceptEdits and auto answer edits that stay inside the session's folder (editsInside)
 * and still ask for the rest (commands, MCP tools, edits elsewhere, …).
 */
export function autoAnswer<O extends PermissionOption>(mode: string, toolKind: string | null | undefined, options: O[], where: { cwd: string; files: string[] }): O | undefined {
	const auto = mode === 'bypassPermissions' || ((mode === 'acceptEdits' || mode === 'auto') && toolKind === 'edit' && editsInside(where.cwd, where.files));
	return auto ? options.find(o => o.kind === 'allow_once') ?? options.find(o => o.kind.startsWith('allow')) : undefined;
}

/** What Insilode Harness records for a question: nothing picked, a refusal, an answer it gave for the user, or the user's own. */
export function permissionDecision(option: { kind: string } | undefined, auto: boolean): 'cancelled' | 'denied' | 'auto' | 'allowed' {
	return !option ? 'cancelled' : !option.kind.startsWith('allow') ? 'denied' : auto ? 'auto' : 'allowed';
}

/**
 * The mode the plan question's (ExitPlanMode) answer puts the session in, by option id. Mirrors `exitPlanMode` and
 * `exitPlanClearContextMode` in @agentclientprotocol/claude-agent-acp (dist/permissions/effects.js; the ids are in
 * options/shared.js): the adapter acts on the id, never on the name or kind, so neither does this. `default` is not elevated.
 */
const EXIT_PLAN_MODE: Record<string, string> = {
	'exit-plan-bypass': 'bypassPermissions',
	'exit-plan-clear-bypass': 'bypassPermissions',
	'exit-plan-auto': 'auto',
	'exit-plan-clear-auto': 'auto',
	'exit-plan-accept-edits': 'acceptEdits',
	'exit-plan-clear-accept-edits': 'acceptEdits',
};
/**
 * On an Edit / Write / NotebookEdit question the adapter offers `allow-with-updates` ("Yes, allow all edits during this session"),
 * which applies `setMode acceptEdits` for the session and reports no mode change (options/filesystem.js, effects.js `applyCommonSelection`).
 * On other tools it only adds rules (a Bash prefix, a directory), so it is elevating only on an `edit` question.
 */
export const ALLOW_WITH_UPDATES = 'allow-with-updates';
export const elevatingMode = (option: { optionId: string }, toolKind?: string | null): string | undefined =>
	option.optionId === ALLOW_WITH_UPDATES ? (toolKind === 'edit' ? 'acceptEdits' : undefined) : EXIT_PLAN_MODE[option.optionId];

/** What replaces an elevating `allow-with-updates` answer the user did not confirm: the same question's plain "yes, this once". */
export function plainEditAnswer<O extends PermissionOption>(options: O[]): O | undefined {
	return options.find(o => o.optionId === 'allow-once') ?? options.find(o => o.kind === 'allow_once');
}

/** What replaces an elevating plan answer the user did not confirm: approve the plan and stay in `default`, else the plan's own "no". */
export function plainPlanAnswer<O extends PermissionOption>(options: O[]): O | undefined {
	return options.find(o => o.optionId === 'exit-plan-default') ?? options.find(o => o.kind.startsWith('reject'));
}

/** The diffs a tool call carries (an edit asking for permission), in the shape the canvas takes. */
export function diffsOf(content: unknown): { path: string; oldText: string | null; newText: string }[] {
	return ((content ?? []) as Array<{ type: string; path?: string; oldText?: string | null; newText?: string }>)
		.filter(c => c.type === 'diff' && c.path)
		.map(c => ({ path: c.path!, oldText: c.oldText ?? null, newText: c.newText ?? '' }));
}

/**
 * The chips of a chat: the select options (not the agent picker), the mode as the user chose it (the adapter itself stays in
 * `default` or `plan`), and a value the adapter does not list (bypassPermissions from the Claude settings) shown anyway.
 */
export function configView(options: SessionConfigOption[], userMode?: string): ChatConfigOption[] {
	return options.filter(o => (o as { type?: string }).type === 'select' && o.id !== 'agent').map(o => {
		const items = selectItems(o).map(i => ({ value: i.value, name: i.name }));
		const cur = o.id === 'mode' ? userMode ?? currentValue(o) : currentValue(o);
		if (o.id === 'mode' && cur && !items.some(i => i.value === cur)) {
			items.push({ value: cur, name: cur.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()) });
		}
		return { id: o.id, name: o.name, ...(cur === undefined ? {} : { value: cur }), items };
	});
}

/** Whether the page may set this option to this value: only what the host itself offered it. */
export const configAccepts = (view: ChatConfigOption[], id: string, value: string) => view.some(o => o.id === id && o.items.some(i => i.value === value));

/** Limits of what one event carries, so a huge file or command output cannot fill the page's memory. */
export const MAX_DIFF_CHARS = 20 * 1024;
export const MAX_OUT_CHARS = 4 * 1024;
/** Events a session keeps for a page that reconnects. */
export const MAX_EVENTS = 3000;

const cut = (text: string, max: number) => text.length > max ? text.slice(0, max) + '\n… (' + (text.length - max) + ' more characters)' : text;

type ToolEvent = Extract<ChatEvent, { t: 'tool' }>;

function toolFields(u: { kind?: string | null; title?: string | null; status?: string | null; locations?: { path: string }[] | null; content?: unknown[] | null }): Omit<ToolEvent, 't' | 'id'> {
	const out: Omit<ToolEvent, 't' | 'id'> = {};
	if (u.kind) {
		out.kind = u.kind;
	}
	if (u.title) {
		out.title = u.title;
	}
	if (u.status) {
		out.status = u.status;
	}
	if (u.locations?.length) {
		out.files = u.locations.map(l => l.path);
	}
	const content = (u.content ?? []) as Array<{ type: string; path?: string; oldText?: string | null; newText?: string; content?: { type?: string; text?: string } }>;
	const diffs = diffsOf(content).map(d => ({ path: d.path, old: cut(d.oldText ?? '', MAX_DIFF_CHARS), new: cut(d.newText, MAX_DIFF_CHARS) }));
	if (diffs.length) {
		out.diffs = diffs;
	}
	const text = content.filter(c => c.type === 'content' && c.content?.type === 'text' && typeof c.content.text === 'string').map(c => c.content!.text).join('\n');
	if (text) {
		out.out = cut(text, MAX_OUT_CHARS);
	}
	return out;
}

/** One session update as page events: the same cases for a live turn and for the replay of an earlier one. */
export function toEvents(u: Update): ChatEvent[] {
	const m = (u as { messageId?: unknown }).messageId;
	const mid = typeof m === 'string' && m ? { mid: m } : {};
	switch (u.sessionUpdate) {
		case 'user_message_chunk':
			return u.content.type === 'text' ? [{ t: 'user', text: u.content.text, ...mid }] : [];
		case 'agent_message_chunk':
			return u.content.type === 'text' ? [{ t: 'text', text: u.content.text, ...mid }] : [];
		case 'agent_thought_chunk':
			return u.content.type === 'text' ? [{ t: 'thought', text: u.content.text, ...mid }] : [];
		case 'tool_call':
		case 'tool_call_update':
			return [{ t: 'tool', id: u.toolCallId, ...toolFields(u) }];
		case 'plan': {
			const entries = (u as { entries?: Array<{ content: string; status: string }> }).entries ?? [];
			return entries.length ? [{ t: 'plan', entries: entries.map(e => ({ text: e.content, status: e.status })) }] : [];
		}
		case 'usage_update': {
			const usage = u as unknown as { used?: number; size?: number };
			return typeof usage.used === 'number' && typeof usage.size === 'number' ? [{ t: 'usage', used: usage.used, size: usage.size }] : [];
		}
		default:
			return [];
	}
}

/**
 * Adds an event to a transcript: streamed chunks of one kind and one message id join the one before them (a user chunk with no id never does), a tool event fills in the card of the
 * same id, and a plan, the config and the usage replace their earlier copy. A replay therefore draws what the live stream drew,
 * and chunks do not use up the cap.
 */
export function appendEvent(buf: ChatEvent[], e: ChatEvent, max = MAX_EVENTS): void {
	const last = buf[buf.length - 1];
	if ((e.t === 'text' || e.t === 'thought' || e.t === 'user') && last?.t === e.t && last.mid === e.mid && !(e.t === 'user' && e.mid === undefined)) {
		last.text += e.text;
		return;
	}
	if (e.t === 'tool') {
		const at = buf.findIndex(x => x.t === 'tool' && x.id === e.id);
		if (at >= 0) {
			Object.assign(buf[at], e);
			return;
		}
	}
	if (e.t === 'plan' || e.t === 'config' || e.t === 'usage') {
		const at = buf.findIndex(x => x.t === e.t);
		if (at >= 0) {
			buf[at] = e;
			return;
		}
	}
	// A copy: a later chunk is added to the stored event, and `e` may be queued for the page as it is.
	buf.push({ ...e });
	if (buf.length > max) {
		buf.splice(0, buf.length - max);
	}
}
