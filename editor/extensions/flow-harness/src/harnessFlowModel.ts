/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the pure half of the harness flow diagram's model (protocol/harness.ts): where each
 *  harness piece is placed, which of them an event would meet, and the steps of a replayed session.
 *  No vscode, so it is tested on its own (test/harnessFlow.test.mjs); harnessFlow.ts reads the files.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { HarnessAgent, HarnessFlowItem, HarnessFlowRequest, HarnessStage, PathHit, PreviewEvent, ReplayStep } from '../../../../protocol/harness';
import { instructionsFor } from './effective';
import { simulate, type Call, type Rule, type Verdict } from './permmatch';
import type { HarnessItem } from './scan';
import { mcpServerOf, parseTranscript } from './transcript';

const AGENTS: HarnessAgent[] = ['Claude', 'Codex', 'Cursor'];
const MAX_STEPS = 300;
const MAX_TEXT = 4000;

const text = (v: unknown, max: number) => typeof v === 'string' && v ? v.slice(0, max) : undefined;

/** The request flowHarness.flowModel was given, checked: anything unexpected is dropped, and an unknown mode becomes the static diagram. */
export function toRequest(arg: unknown): HarnessFlowRequest {
	const o = arg && typeof arg === 'object' ? arg as Record<string, unknown> : {};
	const request: HarnessFlowRequest = { mode: o.mode === 'preview' || o.mode === 'replay' ? o.mode : 'static' };
	const agent = AGENTS.find(a => a === o.agent);
	if (agent) {
		request.agent = agent;
	}
	const e = o.event && typeof o.event === 'object' ? o.event as Record<string, unknown> : undefined;
	const tool = text(e?.tool, 200);
	if (e && tool) {
		const event: PreviewEvent = { tool };
		event.command = text(e.command, MAX_TEXT);
		event.file = text(e.file, 1000);
		if (e.input && typeof e.input === 'object' && !Array.isArray(e.input)) {
			// Scalars only, bounded: the input feeds the permission matcher, nothing else.
			const input: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(e.input as Record<string, unknown>).slice(0, 20)) {
				if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
					input[k.slice(0, 60)] = typeof v === 'string' ? v.slice(0, 1000) : v;
				}
			}
			event.input = input;
		}
		request.event = JSON.parse(JSON.stringify(event)) as PreviewEvent;
	}
	const session = text(o.session, 200);
	if (session) {
		request.session = session;
	}
	return request;
}

/** Hook events by the step of the turn they run at. Anything not listed (a newer event) sits with the last step. */
const HOOK_STAGE: Record<string, HarnessStage> = {
	SessionStart: 'sessionStart', UserPromptSubmit: 'promptSubmit', PreToolUse: 'preTool', PermissionRequest: 'permissionRequest',
	PostToolUse: 'postTool', PostToolUseFailure: 'postTool', SubagentStop: 'subagent', SubagentStart: 'subagent',
	Stop: 'stop', StopFailure: 'stop', SessionEnd: 'sessionEnd', Notification: 'sessionEnd', PreCompact: 'sessionEnd',
};

export function stageOf(item: HarnessItem): HarnessStage {
	switch (item.kind) {
		case 'hooks': return HOOK_STAGE[item.hook?.event ?? ''] ?? 'sessionEnd';
		case 'permissions': return 'permission';
		case 'rules': return item.paths?.some(Boolean) ? 'model' : 'load';
		case 'skills': return 'model';
		case 'agents':
		case 'mcp': return 'run';
		default: return 'load'; // instructions, memory
	}
}

/** A harness item with the diagram's view of it. The source stays beside it: matching needs the hook event, which the diagram's stage drops. */
export interface Placed {
	item: HarnessFlowItem;
	src: HarnessItem;
}

const agentsOf = (src: HarnessItem): HarnessAgent[] => src.agents.filter((a): a is HarnessAgent => AGENTS.includes(a as HarnessAgent));

/** Every item placed on its stage, ids stable (kind, scope, file, label, and what tells two pieces of one file apart) and unique. */
export function place(items: readonly HarnessItem[], agent?: HarnessAgent): Placed[] {
	const seen = new Map<string, number>();
	const out: Placed[] = [];
	for (const src of items) {
		const agents = agentsOf(src);
		if (agent && !agents.includes(agent)) {
			continue;
		}
		const base = [src.kind, src.scope, src.file, src.label, src.hook ? `${src.hook.event}|${src.hook.matcher ?? ''}` : src.rule?.effect ?? ''].join(':');
		const n = seen.get(base) ?? 0;
		seen.set(base, n + 1);
		const item: HarnessFlowItem = {
			id: n ? `${base}#${n + 1}` : base, kind: src.kind, stage: stageOf(src), label: src.label, detail: src.detail, scope: src.scope, agents, file: src.file,
		};
		if (src.line !== undefined) {
			item.line = src.line + 1; // 1-based, like the board's open message
		}
		const matcher = src.hook ? src.hook.matcher ?? '' : src.rule?.pattern;
		if (matcher !== undefined && (src.hook || src.rule)) {
			item.matcher = matcher;
		}
		if (src.rule) {
			item.effect = src.rule.effect;
		}
		if (src.paths?.some(Boolean)) {
			item.paths = src.paths.filter(Boolean);
		}
		if (src.tokens !== undefined) {
			item.tokens = src.tokens;
		}
		if (src.issues.length) {
			item.issues = src.issues.map(i => i.message);
		}
		out.push({ item, src });
	}
	return out;
}

/** Whether a hook's matcher covers a tool: `*`, empty or none is every tool; otherwise a regular expression that must match the whole name (`Edit|Write`, `mcp__github__.*`). */
export function matcherCovers(matcher: string | undefined, tool: string): boolean {
	const m = matcher?.trim();
	if (!m || m === '*') {
		return true;
	}
	try {
		return new RegExp(`^(?:${m})$`).test(tool);
	} catch {
		return m === tool; // not a valid expression: Claude Code compares the plain name
	}
}

/** What a preview or replay reads besides the items: the settings' rules and the mode they are judged in. */
export interface PathEnv {
	root: string;
	home: string;
	rules: Rule[];
	mode: string;
	additionalDirs: string[];
}

const TOOL_HOOKS = ['PreToolUse', 'PermissionRequest', 'PostToolUse'];
export const PERMISSION_FALLBACK = 'permission:decision';

/** The call as the permission matcher takes it: the primary input in `arg`, the whole input for parameter rules. */
export function callOf(e: PreviewEvent, root: string): Call {
	const inp = e.input ?? {};
	const s = (k: string) => typeof inp[k] === 'string' ? inp[k] as string : undefined;
	const file = e.file ? path.resolve(root, e.file) : undefined;
	const arg = e.command ?? file ?? s('url') ?? s('subagent_type') ?? s('skill') ?? s('query') ?? s('pattern') ?? '';
	return { tool: e.tool, arg, params: Object.keys(inp).length ? inp : undefined };
}

/** The piece standing for the permission decision when no rule made it (the mode, or Claude Code's built-in read-only set). */
export function decisionItem(mode: string, effect?: Verdict['decision'], reason = "Decided by the permission mode or Claude Code's built-in rules, not by a rule you wrote"): HarnessFlowItem {
	const item: HarnessFlowItem = { id: PERMISSION_FALLBACK, kind: 'permissions', stage: 'permission', label: `Permission mode: ${mode}`, detail: reason, scope: 'user', agents: ['Claude'] };
	if (effect) {
		item.effect = effect;
	}
	return item;
}

const hookWhy = (src: HarnessItem, tool: string) => `${src.hook!.event} matcher ${src.hook!.matcher?.trim() || '*'} covers ${tool}`;

/**
 * The path one tool call takes through the harness, every hit predicted from the rules (a replay marks what a record shows
 * afterwards). Also returns the verdict, so the caller can place the permission piece.
 */
export function previewHits(event: PreviewEvent, placed: readonly Placed[], env: PathEnv): { hits: PathHit[]; verdict?: Verdict } {
	const hits: PathHit[] = [];
	const have = new Set<string>();
	const add = (hit: PathHit) => {
		if (!have.has(hit.itemId)) {
			have.add(hit.itemId);
			hits.push(hit);
		}
	};
	const claude = placed.some(p => p.item.agents.includes('Claude'));
	const items = placed.map(p => p.src);
	const byId = new Map(items.map((s, i) => [s, placed[i].item.id]));

	// What loads whatever the call is: instructions, memory and rules without paths; path-scoped rules when the call names a file.
	const file = event.file ? path.resolve(env.root, event.file) : typeof event.input?.file_path === 'string' ? path.resolve(env.root, event.input.file_path) : env.root;
	const likes = items.filter(s => s.kind === 'instructions' || s.kind === 'rules');
	for (const a of instructionsFor(file, env.root, likes)) {
		if (a.when !== 'not-loaded') {
			add({ itemId: byId.get(a.item as HarnessItem)!, how: 'predicted', why: a.why });
		}
	}
	for (const s of items) {
		if (s.kind === 'memory' && s.tokens !== undefined) {
			add({ itemId: byId.get(s)!, how: 'predicted', why: 'Memory the agent loads in every session' });
		}
	}

	// The permission verdict (Claude Code's rules; Codex has its own policy, which this does not predict).
	let verdict: Verdict | undefined;
	if (claude) {
		verdict = simulate(callOf(event, env.root), env.rules, { cwd: env.root, home: env.home, mode: env.mode, additionalDirs: env.additionalDirs });
		const rule = verdict.rule;
		const decided = rule && placed.find(p => p.src.rule && p.src.file === rule.file && p.src.rule.pattern === rule.pattern && p.src.rule.effect === rule.effect);
		add({ itemId: decided ? decided.item.id : PERMISSION_FALLBACK, how: 'predicted', verdict: verdict.decision, why: verdict.reason });
	}

	for (const s of items) {
		const ev = s.hook?.event;
		if (!ev || !TOOL_HOOKS.includes(ev) || !matcherCovers(s.hook!.matcher, event.tool)) {
			continue;
		}
		// A PermissionRequest hook runs only when the call would otherwise ask.
		if (ev === 'PermissionRequest' && verdict && verdict.decision !== 'ask') {
			continue;
		}
		add({ itemId: byId.get(s)!, how: 'predicted', why: hookWhy(s, event.tool) });
	}

	const server = mcpServerOf(event.tool);
	if (server) {
		for (const s of items.filter(x => x.kind === 'mcp' && (x.mcp?.toolPrefix === server || x.label === server))) {
			add({ itemId: byId.get(s)!, how: 'predicted', why: `${event.tool} is a tool of the ${server} MCP server` });
		}
	}
	const sub = typeof event.input?.subagent_type === 'string' ? event.input.subagent_type : undefined;
	if (sub && (event.tool === 'Task' || event.tool === 'Agent')) {
		for (const s of items.filter(x => x.kind === 'agents' && x.label === sub)) {
			add({ itemId: byId.get(s)!, how: 'predicted', why: `Starts the ${sub} subagent` });
		}
	}
	const skill = typeof event.input?.skill === 'string' ? event.input.skill : undefined;
	if (skill && event.tool === 'Skill') {
		for (const s of items.filter(x => x.kind === 'skills' && x.label === skill)) {
			add({ itemId: byId.get(s)!, how: 'predicted', why: `Reads the ${skill} skill` });
		}
	}
	return { hits, verdict };
}

/** The tool calls and prompts of a transcript, in order, as replay steps: each with its predicted path, marked observed where the transcript records it. */
export function replaySteps(lines: readonly string[], placed: readonly Placed[], env: PathEnv): ReplayStep[] {
	const facts = parseTranscript(lines);
	const sub = subagentOf(lines);
	const items = placed.map(p => p.src);
	const byId = new Map(items.map((s, i) => [s, placed[i].item.id]));
	const srcOf = new Map(placed.map(p => [p.item.id, p.src]));
	const time = (at: string | undefined, fallback: number) => Date.parse(at ?? '') || fallback;

	interface Raw { at: number; label: string; event: PreviewEvent; subagent?: string; prompt?: boolean }
	const raw: Raw[] = [];
	facts.toolUses.forEach((u, i) => raw.push({ at: time(u.at, i), label: labelOf(u.name, u.input), event: eventOf(u.name, u.input), subagent: u.id ? sub.get(u.id) : undefined }));
	facts.prompts.forEach((p, i) => raw.push({ at: time(p.at, i), label: 'Prompt', event: { tool: 'Prompt' }, prompt: true }));
	raw.sort((a, b) => a.at - b.at);
	const kept = raw.slice(0, MAX_STEPS);

	const steps: ReplayStep[] = kept.map(r => {
		if (r.prompt) {
			const hits: PathHit[] = items.filter(s => s.hook?.event === 'UserPromptSubmit').map(s => ({ itemId: byId.get(s)!, how: 'predicted', why: 'UserPromptSubmit hooks run on every prompt' }));
			return { at: r.at, label: r.label, event: r.event, hits };
		}
		return { at: r.at, label: r.label, event: r.event, subagent: r.subagent, hits: previewHits(r.event, placed, env).hits };
	});

	// What the transcript records. A hook error names its event and tool and sits after the call that ran it, before the next.
	const toolSteps = steps.filter(s => s.event.tool !== 'Prompt');
	for (const err of facts.hookErrors) {
		const [event, tool] = (err.hookName || '').split(':');
		const ev = event || err.event;
		const when = Date.parse(err.at ?? '');
		if (!ev || !Number.isFinite(when)) {
			continue;
		}
		let step: ReplayStep | undefined;
		for (const s of toolSteps) {
			if (s.at <= when) {
				step = s;
			}
		}
		if (!step || (tool && step.event.tool !== tool)) {
			continue;
		}
		const candidates = step.hits.filter(h => srcOf.get(h.itemId)?.hook?.event === ev);
		const named = candidates.filter(h => srcOf.get(h.itemId)!.hook!.command.includes(err.hookName));
		const one = candidates.length === 1 ? candidates : named.length === 1 ? named : [];
		for (const h of one) {
			h.how = 'observed';
			h.why = `The transcript records ${ev} hook output: ${err.message.split('\n')[0] || 'no message'}`.slice(0, 300);
			if (err.blocking) {
				h.verdict = 'blocked';
			}
		}
	}
	// Path-scoped rules the transcript says were loaded for a file the session touched.
	const nested = new Set(facts.nested.map(n => n.path.replace(/\\/g, '/').toLowerCase()));
	for (const step of toolSteps) {
		for (const h of step.hits) {
			const s = srcOf.get(h.itemId);
			if (s && (s.kind === 'rules' || s.kind === 'instructions') && s.scope !== 'user' && nested.has(s.file.replace(/\\/g, '/').toLowerCase()) && h.why.startsWith('Its paths')) {
				h.how = 'observed';
				h.why = `The transcript records this rule loading: ${h.why}`;
			}
		}
	}
	// Stop hooks the transcript lists, with how long they took.
	if (facts.stopHooks.length && steps.length < MAX_STEPS) {
		const hits: PathHit[] = [];
		for (const sh of facts.stopHooks) {
			const s = items.find(x => x.hook?.event === 'Stop' && x.hook.command === sh.command);
			if (s && !hits.some(h => h.itemId === byId.get(s))) {
				hits.push({ itemId: byId.get(s)!, how: 'observed', why: `The transcript records this Stop hook running${sh.durationMs !== undefined ? ` (${sh.durationMs} ms)` : ''}` });
			}
		}
		if (hits.length) {
			steps.push({ at: Date.parse(facts.stopHooks[facts.stopHooks.length - 1].at ?? '') || steps[steps.length - 1]?.at || 0, label: 'Stop', event: { tool: 'Stop' }, hits });
		}
	}
	return steps;
}

/** The agent that made each tool call, for calls made inside a subagent: `agentId` on the line (sidechain entries of the same file). */
function subagentOf(lines: readonly string[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of lines) {
		if (!line.includes('"tool_use"') || !(line.includes('"agentId"') || line.includes('"isSidechain":true'))) {
			continue;
		}
		try {
			const e = JSON.parse(line) as { agentId?: string; isSidechain?: boolean; message?: { content?: unknown } };
			if (!e.agentId && !e.isSidechain) {
				continue;
			}
			for (const b of Array.isArray(e.message?.content) ? e.message!.content as { type?: string; id?: string }[] : []) {
				if (b.type === 'tool_use' && b.id) {
					out.set(b.id, e.agentId ?? 'subagent');
				}
			}
		} catch {
			// a line cut by a bounded read
		}
	}
	return out;
}

const FILE_KEYS = ['file_path', 'path', 'notebook_path'];
const KEEP_INPUT = ['url', 'subagent_type', 'skill', 'pattern', 'query'];

export function eventOf(name: string, input: Record<string, unknown>): PreviewEvent {
	const event: PreviewEvent = { tool: name };
	const command = text(input.command, MAX_TEXT);
	if (command) {
		event.command = command;
	}
	const file = FILE_KEYS.map(k => text(input[k], 1000)).find(Boolean);
	if (file) {
		event.file = file;
	}
	const kept: Record<string, unknown> = {};
	for (const k of KEEP_INPUT) {
		const v = text(input[k], 300);
		if (v) {
			kept[k] = v;
		}
	}
	if (Object.keys(kept).length) {
		event.input = kept;
	}
	return event;
}

export function labelOf(name: string, input: Record<string, unknown>): string {
	const e = eventOf(name, input);
	const detail = e.command?.split('\n')[0] ?? e.file ?? e.input?.subagent_type ?? e.input?.skill ?? e.input?.url ?? e.input?.pattern ?? e.input?.query;
	const clip = (s: string) => s.length > 80 ? `${s.slice(0, 79)}…` : s;
	return detail ? `${name}${e.command ? ':' : ''} ${clip(String(detail))}` : name;
}
