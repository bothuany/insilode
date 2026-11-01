/*---------------------------------------------------------------------------------------------
 *  Insilode: agents in terminals. Claude Code and Codex run as their real CLIs, each in its own
 *  terminal; Insilode only watches. Claude reports through hooks that Insilode hands to that one
 *  session with --settings (the user's own settings and hooks are untouched and still run), so
 *  every agent shows whether it is working, waiting for you or done, what it is doing, its to-do
 *  list and how full its context is. The hooks never answer a permission question: the CLI asks. The only thing
 *  they hand back is context for the agent (skeleton first's reminders, with each prompt and when a plan is approved).
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { existsSync, promises as fs, readFileSync, watch, writeFileSync, type FSWatcher } from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { crashNeed, nextAttention, startupNeed, type Attention, type Need } from './attention';
import { needsYouCount } from './desktopModel';
import { findConflicts, key, type Conflict, type SessionEdits } from './conflicts';
import { CODEX_HOOK_SCRIPT, CODEX_PROFILE, codexCommand, codexHookCommand, codexLaunch, codexProfile, codexProfileFile } from './codexHooks';
import { agentCwd, agentProcessEnv, inheritedAgentEnv } from './env';
import { CostTracker, statusUsd, type SessionCost } from './cost';
import { disposeGaze, gazeHook, gazeTurn } from './gazeHost';
import { parsePatch, patchFiles, patchText } from './patch';
import { PrWatcher, type PrState } from './prState';
import { shimScript } from './shim';
import { canExplain, explainPrompt } from './explain';
import { hookScript } from './hookScript';
import { SKELETON_GATE, SKELETON_PROMPT_GATE } from './skeleton';
import { canType, notReady, oneLine, slashRefusal, slashText, type AgentCli, type AgentState, type CustomCli, type SessionInfo, type SlashKind, type SlashResult } from './askTarget';
import { applyUsage, claudeTranscriptUsage, codexRolloutUsage, endUsage, findOnPath, hasOwnStatusLine, LimitsSender, parseClaudeStatus, statusScript, type ContextUsage, type UsageLimits } from './usage';
import { createWorktree, sameDir, validBranch, worktreeSlug, type Worktree } from './worktrees';

// Declared with the ask rules, which must not import this file (it needs vscode); every other file takes them from here.
export type { AgentCli, AgentState } from './askTarget';

export interface Todo {
	text: string;
	status: 'pending' | 'in_progress' | 'completed';
	/** Task id, for the Task tools that update one item at a time. */
	key?: string;
}

export interface AgentSession {
	id: string;
	cli: AgentCli;
	name: string;
	state: AgentState;
	since: number;
	prompt?: string;
	/** What it is doing right now, or what it waits for. */
	activity?: string;
	todos: Todo[];
	/** How full its context window is; `size` only when the CLI said (never a guess). */
	usage?: ContextUsage;
	/** Bumped when the session ends, so a transcript read that started before then is dropped. */
	usageEpoch?: number;
	/** Finished or blocked while you were looking elsewhere. */
	unread: boolean;
	pid?: number;
	transcript?: string;
	/** What a custom agent runs, e.g. `gemini` or `aider --model sonnet`. */
	command?: string;
	/** The flows the files edited in the last turn reach, worked out when the turn ended. */
	impact?: TurnImpact;
	/** Codex picks its own session id: learned from its first hook, it is what `codex resume` takes. */
	agentId?: string;
	/** Why it waits for you, when it does (attention.ts). */
	need?: Need;
	/** Tokens and, where the CLI says, dollars: the session and its current prompt (cost.ts). */
	cost?: SessionCost;
	/** The PR of the branch it works on, with its CI (prState.ts). */
	pr?: PrState;
	/** The folder it works in, as its hooks report it. */
	cwd?: string;
	/** The git worktree it was started in, when it has one of its own (see worktrees.ts). */
	worktree?: Worktree;
}

/** What flow-view answers to `flow.agent.turnImpact`. */
export interface TurnImpact {
	files: number;
	/** `via`: the changed methods the flow goes through, when the edits could be placed in methods. */
	flows: { id: string; label: string; name: string; source: 'roslyn' | 'poly'; via?: string[] }[];
	more: number;
	note?: string;
	/** The methods the turn's edits landed in, where their lines are known. */
	methods?: { file: string; name: string }[];
	/** The tables whose entity the turn's edits landed in, with how many endpoints read or write each (`guess`: the table name is a guess; `partial`: not every entry point was checked). */
	tables?: { table: string; entity?: string; entityChanged?: boolean; migration?: string; endpoints: number; guess?: boolean; partial?: boolean }[];
}

export interface CustomAgent {
	name: string;
	command: string;
	/** Text may be typed into its prompt (Ask, Home): off unless the user says so, since Insilode cannot see its state. */
	acceptsInput?: boolean;
}

interface Saved {
	token: string;
	sessions: Pick<AgentSession, 'id' | 'cli' | 'name' | 'pid' | 'prompt' | 'transcript' | 'command' | 'agentId' | 'worktree'>[];
	/** Worktrees of agents taken off the list whose folder the user kept: the only record of where they are. */
	kept?: KeptWorktree[];
}

/** A worktree kept after its agent left the dock, with the agent's name for the list. */
export interface KeptWorktree extends Worktree {
	agent: string;
}

interface HookPayload {
	session_id?: string;
	cwd?: string;
	hook_event_name?: string;
	transcript_path?: string;
	prompt?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: Record<string, unknown>;
	notification_type?: string;
	message?: string;
	/** StopFailure: the error code, and what the API said; PostToolUseFailure: what went wrong. */
	error?: string;
	error_details?: string;
	/** Stop: the reply the turn ended on. */
	last_assistant_message?: string;
	/** PostToolUseFailure: how long the tool ran. */
	duration_ms?: number;
	/** SubagentStop: which subagent finished; on other events, the subagent (or --agent) the hook fired in. */
	agent_type?: string;
	/** Set only when the hook fired inside a subagent or an in-process teammate: which one (Claude Code's common hook input). */
	agent_id?: string;
	/** The session's permission mode, on the events that carry it (default, plan, acceptEdits, auto, dontAsk, bypassPermissions). */
	permission_mode?: string;
}

const AGENT = 'Claude Code (terminal)';
const agentLabel = (s: AgentSession) => s.cli === 'codex' ? 'Codex (terminal)' : AGENT;
const EDIT_TOOLS = 'Edit|Write|MultiEdit|NotebookEdit';
/** Codex reports every file edit as this one tool, the patch in `tool_input.command` (see patch.ts). */
const PATCH_TOOL = 'apply_patch';
/** PreToolUse also sees the plan an agent proposes when it leaves plan mode (tool_input.plan, injected by Claude Code), and the questions it asks you. */
const PRE_TOOLS = `${EDIT_TOOLS}|ExitPlanMode|AskUserQuestion`;
/** The most files of one turn that are checked for the flows they affect. */
const MAX_TOUCHED = 40;
/** How long after a typed line the Enter that submits it is sent (see typeInto). */
const SUBMIT_DELAY_MS = 300;
/** The turn-end impact may take this long: Roslyn answers one request at a time. */
const IMPACT_WAIT_MS = 9000;
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SubagentStop', 'SessionEnd'];
/** The tool input fields the harness map counts by (which skill, which subagent) and keeps as evidence (the command, the file). flow-harness's live.ts keeps the same list: change both. */
const EVENT_INPUT = ['skill', 'subagent_type', 'command', 'file_path', 'path', 'url', 'pattern'];
/** Agents that never come back to a reloaded window (their terminal is gone) are dropped after this. */
const ORPHAN_TTL_MS = 90_000;
/** How long after a failing exit code a SessionEnd may still come, making it a quit rather than a crash. */
const CRASH_GRACE_MS = 1500;
/** The most a hook may wait for Insilode to snapshot a file: the edit must not stall on it. */
const SNAPSHOT_WAIT_MS = 2500;

const KIND: Record<string, string> = { Bash: 'execute', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Read: 'read', Grep: 'search', Glob: 'search', WebFetch: 'fetch', WebSearch: 'fetch', [PATCH_TOOL]: 'edit' };

/** One line for what a tool call is about: the command, the file, the pattern. */
function describe(tool: string, input: Record<string, unknown> = {}) {
	if (tool === PATCH_TOOL) {
		const files = parsePatch(patchText(input)).map(o => path.basename(o.file));
		return files.length ? `Editing ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3}` : ''}` : 'Editing';
	}
	const file = typeof input.file_path === 'string' ? path.basename(input.file_path) : typeof input.notebook_path === 'string' ? path.basename(input.notebook_path) : undefined;
	const detail = typeof input.command === 'string' ? input.command
		: file ?? (typeof input.pattern === 'string' ? input.pattern : typeof input.url === 'string' ? input.url : typeof input.description === 'string' ? input.description : '');
	const verb: Record<string, string> = { Bash: 'Running', Edit: 'Editing', MultiEdit: 'Editing', Write: 'Writing', NotebookEdit: 'Editing', Read: 'Reading', Grep: 'Searching', Glob: 'Finding', WebFetch: 'Fetching', WebSearch: 'Searching the web', Task: 'Delegating', Agent: 'Delegating' };
	const head = verb[tool] ?? tool.replace(/^mcp__([\w-]+)__/, '$1 ');
	return detail ? `${head} ${String(detail).split('\n')[0].slice(0, 120)}` : head;
}

/** The files a tool call writes. `cwd` resolves the relative paths of a Codex patch. */
function filesOf(tool: string, input: Record<string, unknown> = {}, cwd?: string) {
	if (tool === PATCH_TOOL) {
		return patchFiles(input, cwd);
	}
	const f = input.file_path ?? input.notebook_path;
	return typeof f === 'string' ? [f] : [];
}

const isEdit = (tool: string) => tool === PATCH_TOOL || EDIT_TOOLS.split('|').includes(tool);

/** The setting is only the default for an agent nobody has switched yet: skeleton first is on or off per agent (Agents.skeletonOn). */
const skeletonFirstDefault = () => vscode.workspace.getConfiguration('insilode.skeletonFirst').get<boolean>('enabled', false) === true;

/** A skeleton-first click flow-view could not carry out: said, not swallowed, so the row never looks as if it did. */
function skeletonFailed(e: unknown) {
	const missing = /command .* not found/i.test(String((e as Error)?.message ?? e));
	void vscode.window.showWarningMessage(missing ? 'Insilode: skeleton first needs the Flow View extension, which is not running.' : `Insilode: skeleton first: ${(e as Error)?.message ?? e}`);
}

/** Resolves with undefined once `ms` have passed, whatever `p` is doing. */
function bounded<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([p, new Promise<undefined>(r => timer = setTimeout(() => r(undefined), ms))]).finally(() => clearTimeout(timer));
}

/** sessions.json is plain text on disk: take only what has the right shape, so a damaged file cannot throw at startup. */
function parseSaved(raw: unknown): Saved | undefined {
	const o = raw as { token?: unknown; sessions?: unknown } | null;
	if (!o || typeof o !== 'object') {
		return undefined;
	}
	const str = (v: unknown) => typeof v === 'string' ? v : undefined;
	const sessions: Saved['sessions'] = [];
	for (const e of Array.isArray(o.sessions) ? o.sessions as Record<string, unknown>[] : []) {
		if (e && typeof e === 'object' && typeof e.id === 'string' && (e.cli === 'claude' || e.cli === 'codex' || e.cli === 'custom')) {
			sessions.push({ id: e.id, cli: e.cli, name: str(e.name) ?? e.id, pid: typeof e.pid === 'number' ? e.pid : undefined, prompt: str(e.prompt), transcript: str(e.transcript), command: str(e.command), agentId: str(e.agentId), worktree: parseWorktree(e.worktree) });
		}
	}
	const kept: KeptWorktree[] = [];
	for (const k of Array.isArray((o as { kept?: unknown }).kept) ? (o as { kept: Record<string, unknown>[] }).kept : []) {
		const wt = k && typeof k === 'object' ? parseWorktree(k) : undefined;
		if (wt) {
			kept.push({ ...wt, agent: str(k.agent) ?? wt.branch });
		}
	}
	return { token: str(o.token) ?? '', sessions, kept };
}

/** A saved worktree, taken only when every part has the right shape: its branch names reach git when it is merged or removed. */
function parseWorktree(raw: unknown): Worktree | undefined {
	const w = raw as Partial<Record<keyof Worktree, unknown>> | null;
	if (!w || typeof w !== 'object' || typeof w.path !== 'string' || typeof w.root !== 'string' || typeof w.branch !== 'string' || typeof w.base !== 'string') {
		return undefined;
	}
	return path.isAbsolute(w.path) && path.isAbsolute(w.root) && validBranch(w.branch) && validBranch(w.base) ? { path: w.path, root: w.root, branch: w.branch, base: w.base } : undefined;
}

/** The newest /rename in these transcript lines. */
function lastTitle(lines: string[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes('"custom-title"')) {
			try {
				const title = (JSON.parse(lines[i]) as { customTitle?: string }).customTitle?.trim();
				if (title) {
					return title;
				}
			} catch {
				// partial line
			}
		}
	}
	return undefined;
}

/** Where Claude Code keeps a session's transcript: the cwd with every non-alphanumeric turned into '-'. */
export function projectDir(cwd: string | undefined) {
	const config = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
	return path.join(config, 'projects', (cwd ?? '').replace(/[^a-zA-Z0-9]/g, '-'));
}

function transcriptPath(id: string, cwd: string | undefined) {
	return path.join(projectDir(cwd), `${id}.jsonl`);
}

export class Agents implements vscode.Disposable {
	readonly sessions = new Map<string, AgentSession>();
	private readonly terminals = new Map<string, vscode.Terminal>();
	/** Sessions a hook has reported from: their CLI is up and past its own start screens, so typing reaches its prompt. */
	private readonly heard = new Set<string>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly turnEnded = new vscode.EventEmitter<AgentSession>();
	/** A session's turn ended (Stop, StopFailure, or Claude's idle prompt): the moment queued work can be typed into it (see deliver). */
	readonly onDidTurnEnd = this.turnEnded.event;
	/** When each session's turn last ended, and when you last brought its terminal up: see deliver. */
	private readonly turnEndedAt = new Map<string, number>();
	private readonly lookedAt = new Map<string, number>();
	private server: http.Server | undefined;
	private port = 0;
	private token = '';
	private dir = '';
	private readonly watchers = new Map<string, FSWatcher>();
	/** Debounce of the transcript watcher, per session. */
	private readonly titleTimers = new Map<string, NodeJS.Timeout>();
	/** Permission questions still open, so the answer can be recorded when the tool runs (or does not). */
	private readonly asked = new Map<string, { tool: string; input: Record<string, unknown>; cwd?: string; at: number }>();
	private readonly disposables: vscode.Disposable[] = [];
	/** Agents from before a reload, waiting for their terminal to come back. */
	private readonly orphans = new Map<number, Saved['sessions'][number]>();
	/** Worktrees kept after their agents were taken off the list (Agents: Kept Worktrees…). */
	private kept: KeptWorktree[] = [];
	private orphanTimer: NodeJS.Timeout | undefined;
	/** Claude session ids that continue a Insilode agent after /clear or /resume gave the conversation a new one. */
	private readonly aliases = new Map<string, string>();
	/** Set once start() has run: spawn waits on it so an agent never starts before the hook settings exist. */
	private ready: Promise<void> | undefined;
	private settingsOk = false;
	/** Whether Codex can take Insilode's profile (`-p insilode`): settled on the first Codex start of this window. */
	private codexHooks: Promise<boolean> | undefined;
	/** Files an agent edited since its last prompt, for the turn-end impact. */
	private readonly touched = new Map<string, Set<string>>();
	/** Sessions whose plan was drawn from PreToolUse this turn, so PostToolUse does not draw it twice. */
	private readonly planDrawn = new Set<string>();
	/** Why each session needs you, and its failure streak. */
	private readonly attention = new Map<string, Attention>();
	private readonly costs = new Map<string, CostTracker>();
	private readonly prs = new PrWatcher(cwd => this.prChanged(cwd));
	private prTimer: NodeJS.Timeout | undefined;
	/** What the turn-end check found for a session's last turn, for "Explain this" (the files are in `touched`); dropped with the next prompt. */
	private readonly turns = new Map<string, { impact?: TurnImpact }>();
	/** Everything a session has edited since it started (files, and the methods and flows once a turn's impact is known), for conflicts.ts. */
	private readonly edits = new Map<string, SessionEdits>();

	constructor(private readonly context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(
			vscode.window.onDidCloseTerminal(t => this.closed(t)),
			vscode.window.onDidChangeActiveTerminal(t => this.seen(t)),
			vscode.window.onDidChangeTerminalState(t => t.state.isInteractedWith && this.seen(t)),
			// The CLI runs in a shell, so a crash leaves the terminal open: shell integration still reports the command's exit code.
			vscode.window.onDidEndTerminalShellExecution(e => this.exited(e.terminal, e.exitCode)),
			// An untrusted workspace starts nothing; trusting it later starts the hook server and brings the agents back.
			vscode.workspace.onDidGrantWorkspaceTrust(() => void this.start()),
		);
		// The PR cache refreshes itself when asked after it went stale: ask for every live agent now and then.
		this.prTimer = setInterval(() => this.refreshPrs(), 60_000);
	}

	/** Safe to call again: the work happens once. Does nothing in an untrusted workspace until it is trusted. */
	start(): Promise<void> {
		if (!vscode.workspace.isTrusted) {
			this.log.info('Agents: workspace not trusted; agents stay off');
			return Promise.resolve();
		}
		this.ready ??= this.init().catch(e => this.log.error(`Agents: start failed: ${(e as Error).message}`));
		return this.ready;
	}

	private async init() {
		// Keyed by folder, not by window: a reloaded window can get a fresh storageUri while the old
		// extension host lingers, and the agents' hook settings must find the newest window either way.
		// A window without a folder has nothing to key on, and two of them would take each other's hook port
		// and agent list: it gets a directory of its own (its agents are not picked up again after a reload).
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const key = folder ?? `empty:${vscode.env.sessionId}:${process.pid}`;
		this.dir = path.join(this.context.globalStorageUri.fsPath, 'agents', (folder ? '' : 'empty-') + createHash('sha1').update(key).digest('hex').slice(0, 12));
		const saved = await fs.readFile(path.join(this.dir, 'sessions.json'), 'utf8').then(t => parseSaved(JSON.parse(t))).catch(() => undefined);
		this.token = saved?.token || randomBytes(16).toString('hex');
		this.kept = saved?.kept ?? [];
		try {
			await this.listen();
		} catch (e) {
			this.log.warn(`Agents: no port for hooks; agents run without status (${(e as Error).message})`);
		}
		try {
			await this.writeSettings();
			this.settingsOk = true;
		} catch (e) {
			this.log.warn(`Agents: could not write the hook settings; agents run without status (${(e as Error).message})`);
		}
		await this.installShim().catch(e => this.log.warn(`Agents: no claude shim (${(e as Error).message})`));
		await this.revive(saved);
		this.save();
	}

	/** Puts the `claude` shim first on PATH of Insilode's terminals (or takes it away), so a hand-typed `claude` gets the `insilode` tools too. */
	private async installShim() {
		const collection = this.context.environmentVariableCollection;
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const config = process.platform === 'win32' || !vscode.workspace.getConfiguration('flow.agents').get<boolean>('shim', true) ? undefined : await this.mcpConfig(cwd);
		if (!config) {
			collection.delete('PATH');
			return;
		}
		const bin = path.join(this.dir, 'bin');
		await fs.mkdir(bin, { recursive: true });
		const file = path.join(bin, 'claude');
		await fs.writeFile(file, shimScript(config), { mode: 0o755 });
		await fs.chmod(file, 0o755);
		collection.prepend('PATH', bin + path.delimiter);
	}

	private listen() {
		return new Promise<void>((resolve, reject) => {
			const server = http.createServer((req, res) => this.request(req, res));
			server.once('error', reject);
			server.listen(0, '127.0.0.1', () => {
				this.server = server;
				this.port = (server.address() as { port: number }).port;
				resolve();
			});
		});
	}

	private get settingsFile() {
		return path.join(this.dir, 'agent-hooks.json');
	}

	/** The same hooks plus Insilode's status line: for sessions where the user has no status line of their own. */
	private get statusSettingsFile() {
		return path.join(this.dir, 'agent-hooks-status.json');
	}

	/**
	 * The settings a new Claude session gets. Decided at each start, from every place Claude reads a status line
	 * for this workspace, so one the user added since Insilode started is never replaced by Insilode's.
	 */
	private claudeSettings() {
		const config = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
		const folders = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
		if (hasOwnStatusLine(config, folders)) {
			this.log.info('Agents: you have a status line of your own; context windows and usage limits come from the transcript only');
			return this.settingsFile;
		}
		return this.statusSettingsFile;
	}

	/**
	 * The hooks a Insilode agent gets on top of the user's own: read-only observers that print nothing,
	 * so they never decide anything. Each one posts the event to whichever Insilode window holds this
	 * workspace now: the port is read from a file at call time, because after a window reload the
	 * old extension host can linger on the old port while the agent keeps running.
	 */
	private async writeSettings() {
		await fs.mkdir(this.dir, { recursive: true });
		const portFile = path.join(this.dir, 'hook-port');
		const tokenFile = path.join(this.dir, 'hook-token');
		await fs.writeFile(tokenFile, this.token, { mode: 0o600 });
		await fs.writeFile(portFile, this.server ? String(this.port) : '', { mode: 0o600 });
		// A tiny Node script, run with the editor's own Node: the same on macOS, Linux and Windows.
		const script = path.join(this.dir, 'flow-hook.js');
		await fs.writeFile(script, hookScript(portFile, tokenFile));
		// On the desktop `process.execPath` is the Insilode executable itself: without ELECTRON_RUN_AS_NODE it would open
		// an editor window for the script on every hook event. Claude Code runs hooks through bash, which takes the prefix.
		const asNode = process.versions.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
		const command = `${asNode}"${process.execPath}" "${script}"`;
		const hook = { type: 'command', command, timeout: 5 };
		const hooks: Record<string, unknown[]> = {};
		for (const e of HOOK_EVENTS) {
			const matcher = e === 'PreToolUse' ? PRE_TOOLS : e === 'PostToolUse' || e === 'PostToolUseFailure' || e === 'PermissionRequest' ? '*' : undefined;
			hooks[e] = [{ ...(matcher ? { matcher } : {}), hooks: [hook] }];
		}
		await fs.writeFile(this.settingsFile, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
		// The status line is the one place Claude Code tells the real context window and the plan's 5-hour and weekly
		// limits. Claude runs it on every refresh, so it should start fast: a plain `node` on PATH starts several times
		// quicker than the editor in Node mode, which stays the fallback. It runs through the same shell as the hooks.
		const statusFile = path.join(this.dir, 'flow-status.js');
		await fs.writeFile(statusFile, statusScript(portFile, tokenFile, this.dir));
		const node = findOnPath('node');
		const statusCommand = node ? `"${node}" "${statusFile}"` : `${asNode}"${process.execPath}" "${statusFile}"`;
		const statusLine = { type: 'command', command: statusCommand, padding: 0 };
		await fs.writeFile(this.statusSettingsFile, JSON.stringify({ hooks, statusLine }, null, 2), { mode: 0o600 });
	}

	/**
	 * Codex's hooks, in Insilode's own Codex profile (see codexHooks.ts). One script for every window, outside the
	 * per-workspace folder, so the profile's text (and the trust Codex keeps for it) is the same everywhere.
	 * Written only when it changed: rewriting the same bytes is harmless, but a changed file asks for trust again.
	 */
	private async writeCodexProfile() {
		const shared = path.join(this.context.globalStorageUri.fsPath, 'agents');
		await fs.mkdir(shared, { recursive: true });
		const script = path.join(shared, 'codex-hook.js');
		if (await fs.readFile(script, 'utf8').catch(() => '') !== CODEX_HOOK_SCRIPT) {
			await fs.writeFile(script, CODEX_HOOK_SCRIPT);
		}
		const file = codexProfileFile();
		const text = codexProfile(codexHookCommand(process.platform, process.execPath, script, !!process.versions.electron));
		if (await fs.readFile(file, 'utf8').catch(() => '') !== text) {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(file, text);
			this.log.info(`Agents: wrote the Codex profile ${file}; Codex asks once to trust its hooks (/hooks)`);
		}
		// The profile of the same name before the rename (`codex -p axle`): ours only if it still says so.
		const legacy = path.join(path.dirname(file), 'axle.config.toml');
		if ((await fs.readFile(legacy, 'utf8').catch(() => '')).startsWith('# Written by Axle.')) {
			await fs.rm(legacy, { force: true }).catch(() => undefined);
		}
	}

	/**
	 * Codex gets `-p insilode` only once the profile is written and this `codex` takes it: an older Codex reads `-p` as a
	 * [profiles] name and would not start at all. `codex -p insilode mcp list` loads the profile without starting a
	 * session (a profile it cannot read fails it). Asked on the first Codex start, never at activation, so nothing
	 * is written to ~/.codex for someone who never runs Codex from Insilode. Any failure means plain `codex`.
	 */
	private codexTakesHooks(): Promise<boolean> {
		if (!this.server || !vscode.workspace.getConfiguration('flow.agents').get<boolean>('codexHooks', true)) {
			return Promise.resolve(false);
		}
		return this.codexHooks ??= this.writeCodexProfile().then(() => new Promise<boolean>(resolve => {
			// No `shell: true`: `codex` is looked up on PATH here. npm installs it on Windows as codex.cmd, which execFile
			// cannot start without cmd.exe, so the shim's script runs under Node instead (the node.exe beside it, a `node`
			// on PATH, or this editor in Node mode). A batch wrapper of the user's own runs under cmd.exe with this one
			// fixed command line (codexCommand), as the terminal would run it.
			const launch = codexLaunch(process.platform, process.env.PATH ?? '', process.env.PATHEXT, {
				exists: existsSync,
				read: file => {
					try {
						return readFileSync(file, 'utf8');
					} catch {
						return undefined;
					}
				},
			});
			if (!launch) {
				this.log.warn('Agents: Codex runs without status: no `codex` program found on PATH');
				resolve(false);
				return;
			}
			const run = codexCommand(launch, ['-p', CODEX_PROFILE, 'mcp', 'list'], 'script' in launch && !launch.node ? findOnPath('node') : undefined, process.execPath, !!process.versions.electron, process.env.ComSpec || 'cmd.exe');
			if (!run) {
				this.log.warn(`Agents: Codex runs without status: ${'batch' in launch ? launch.batch : 'codex'} cannot be started safely`);
				resolve(false);
				return;
			}
			execFile(run.file, run.argv, { timeout: 8000, windowsHide: true, windowsVerbatimArguments: run.verbatim, env: agentProcessEnv(run.electronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, (err, _out, stderr) => {
				if (err) {
					this.log.warn(`Agents: Codex runs without status: \`codex -p ${CODEX_PROFILE}\` failed (${String(stderr || err.message).trim().split('\n')[0]})`);
				}
				resolve(!err);
			});
		}), e => {
			this.log.warn(`Agents: Codex runs without status: no Codex profile (${(e as Error).message})`);
			return false;
		});
	}

	/** Terminals outlive a window reload; find ours again by their process (they may reattach after we start). */
	private async revive(saved: Saved | undefined) {
		// First, so nothing below can leave a reattaching terminal unnoticed.
		this.disposables.push(vscode.window.onDidOpenTerminal(t => void this.adopt(t)));
		for (const s of saved?.sessions ?? []) {
			let alive = false;
			try {
				process.kill(s.pid!, 0); // still running?
				alive = true;
			} catch (e) {
				alive = (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, just not ours to signal
			}
			if (alive) {
				this.orphans.set(s.pid!, s);
			} else {
				this.listEnded(s);
			}
		}
		await Promise.all(vscode.window.terminals.map(t => this.adopt(t)));
		// A terminal that has not come back by now is not coming back (or its pid now belongs to something else).
		if (this.orphans.size) {
			this.orphanTimer = setTimeout(() => this.expireOrphans(), ORPHAN_TTL_MS);
		}
	}

	/**
	 * Its terminal is gone (Insilode quit, or it was closed). A Claude conversation can be
	 * picked up again with --resume, so it stays listed; other CLIs are dropped.
	 */
	private listEnded(s: Saved['sessions'][number]) {
		if (s.cli === 'claude' && !this.sessions.has(s.id)) {
			const session: AgentSession = { ...s, pid: undefined, state: 'ended', since: Date.now(), todos: [], unread: false, activity: 'Closed · click to resume' };
			this.sessions.set(s.id, session);
			void this.readTitle(session, true);
		}
	}

	private expireOrphans() {
		this.orphanTimer = undefined;
		if (!this.orphans.size) {
			return;
		}
		for (const s of this.orphans.values()) {
			this.log.info(`Agents: ${s.name} did not reattach`);
			this.listEnded(s);
		}
		this.orphans.clear();
		this.save();
		this.changed.fire();
	}

	private async adopt(t: vscode.Terminal) {
		const pid = await Promise.resolve(t.processId).catch(() => undefined);
		const s = pid ? this.orphans.get(pid) : undefined;
		if (!s || this.sessions.has(s.id)) {
			return;
		}
		this.orphans.delete(pid!);
		const session: AgentSession = { ...s, state: s.cli === 'claude' ? 'idle' : 'unknown', since: Date.now(), todos: [], unread: false };
		this.sessions.set(s.id, session);
		this.terminals.set(s.id, t);
		this.log.info(`Agents: reattached ${s.name}`);
		void this.readUsage(session);
		this.refreshPrs();
		void this.readTitle(session, true);
		this.watchTranscript(session);
		this.changed.fire();
	}

	private save() {
		if (!this.dir) {
			return; // not started: there is no folder to write to (a relative path would land in the cwd)
		}
		const saved: Saved = {
			token: this.token,
			sessions: [...[...this.sessions.values()].map(({ id, cli, name, pid, prompt, transcript, command, agentId, worktree }) => ({ id, cli, name, pid, prompt, transcript, command, agentId, worktree })), ...this.orphans.values()],
			kept: this.kept,
		};
		// One write at a time, through a temp file: overlapping writes could interleave and lose every saved session.
		const file = path.join(this.dir, 'sessions.json');
		this.writing = this.writing.then(async () => {
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
			await fs.rename(tmp, file);
		}).catch(() => undefined);
	}

	private writing: Promise<void> = Promise.resolve();

	/**
	 * The MCP config that gives an Insilode agent the `insilode` tools (open files, show flows, draw boards): a file declaring the stdio
	 * server of the flow-view extension for this folder. Undefined, and the agent starts without it, when the setting is off,
	 * flow-view or its server script is missing, or the file cannot be written: the tools are a bonus, never a reason not to start.
	 */
	private async mcpConfig(cwd: string | undefined, session?: string): Promise<string | undefined> {
		if (!this.dir || !vscode.workspace.getConfiguration('flow.agents').get<boolean>('mcp', true)) {
			return undefined;
		}
		try {
			const view = vscode.extensions.getExtension('flow.flow-view');
			const script = view && path.join(view.extensionPath, 'out', 'insilode-mcp.js');
			if (!script || !existsSync(script)) {
				return undefined;
			}
			// Like the hooks: on the desktop process.execPath is the editor, which runs a script only as Node.
			const electron = !!process.versions.electron;
			const config = { mcpServers: { insilode: { command: process.execPath, args: [script], env: { ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), ...(cwd ? { INSILODE_WORKSPACE: cwd } : {}), ...(session ? { INSILODE_SESSION: session } : {}) } } } };
			// One file per agent session: the `insilode` tools then know which session a tour came from, and a question the reader asks about
			// it goes back to that session. The shared file is for the claude shim, which cannot know.
			const file = path.join(this.dir, session ? `insilode-mcp-${session}.json` : 'insilode-mcp.json');
			await fs.mkdir(this.dir, { recursive: true });
			await fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
			return file;
		} catch (e) {
			this.log.warn(`Agents: no MCP config for this agent (${(e as Error).message})`);
			return undefined;
		}
	}

	/**
	 * Starts a CLI in a new terminal. Claude gets a session id we chose, so every hook maps to its terminal. `place` puts a new
	 * agent in a git worktree of its own or in this checkout; left out, the flow.agents.worktree setting decides. A resumed
	 * agent goes back to where it ran.
	 */
	async spawn(cli: AgentCli, resume?: AgentSession, custom?: CustomAgent, place?: 'worktree' | 'here'): Promise<AgentSession | undefined> {
		if (!vscode.workspace.isTrusted) {
			void vscode.window.showWarningMessage('Agents run commands in your workspace: trust this folder to start one.', 'Manage Workspace Trust')
				.then(c => c && vscode.commands.executeCommand('workbench.trust.manage'));
			return undefined;
		}
		await this.start(); // the hook settings and the session list must exist before the first agent
		const id = resume?.id ?? randomUUID();
		const base = cli === 'claude' ? 'Claude' : cli === 'codex' ? 'Codex' : custom?.name ?? 'Agent';
		const same = [...this.sessions.values()].filter(s => s.state !== 'ended' && (s.cli === 'custom' ? s.command === custom?.command : s.cli === cli)).length;
		const name = resume?.name ?? base + (same ? ` ${same + 1}` : '');
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		let worktree = resume?.worktree && existsSync(resume.worktree.path) ? resume.worktree : undefined;
		if (resume?.worktree && !worktree) {
			void vscode.window.showErrorMessage(`Insilode: the worktree of ${resume.name} (${resume.worktree.path}) is gone; it cannot be resumed there.`);
			return undefined;
		}
		if (!resume && folder && (place ?? (vscode.workspace.getConfiguration('flow.agents').get<boolean>('worktree', false) ? 'worktree' : 'here')) === 'worktree') {
			try {
				const slug = worktreeSlug(cli === 'custom' ? custom?.name ?? 'agent' : cli, randomBytes(2).toString('hex'));
				worktree = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Insilode: creating a worktree for the agent' }, () => createWorktree(folder, slug));
			} catch (e) {
				// Never fall back to the shared checkout without saying so: the user asked for a checkout of the agent's own.
				void vscode.window.showErrorMessage(`Insilode: could not create a worktree for the agent: ${(e as Error).message}`);
				return undefined;
			}
		}
		const cwd = agentCwd(worktree?.path ?? folder);
		const terminal = vscode.window.createTerminal({
			name,
			cwd,
			iconPath: new vscode.ThemeIcon(cli === 'claude' ? 'sparkle' : cli === 'codex' ? 'hubot' : 'terminal'),
			color: new vscode.ThemeColor(cli === 'claude' ? 'terminal.ansiYellow' : cli === 'codex' ? 'terminal.ansiCyan' : 'terminal.ansiMagenta'),
			env: { ...inheritedAgentEnv(), FLOW_AGENT_SESSION: id, FLOW_HOOK_DIR: this.dir },
			isTransient: false,
		});
		// Double quotes work in bash, zsh, PowerShell and cmd alike.
		const quote = (x: string) => `"${x}"`;
		// --mcp-config takes any number of files, so it goes last; it adds to the user's own MCP servers (no --strict-mcp-config).
		// The `insilode` tools find this window by its folder, so a worktree agent gets the main folder's config.
		const mcp = cli === 'claude' ? await this.mcpConfig(folder, id) : undefined;
		const codexHooks = cli === 'codex' && await this.codexTakesHooks();
		const profile = codexHooks ? ` -p ${CODEX_PROFILE}` : '';
		const command = cli === 'claude'
			? `claude ${resume ? '--resume' : '--session-id'} ${id}${this.server && this.settingsOk ? ` --settings ${quote(this.claudeSettings())}` : ''}${mcp ? ` --mcp-config ${quote(mcp)}` : ''}`
			// Codex chose its session id; until a hook told us, `codex resume` without one opens its own picker.
			: cli === 'codex' ? (resume ? `codex resume${profile}${resume.agentId ? ` ${resume.agentId}` : ''}` : `codex${profile}`)
			: resume?.command ?? custom?.command ?? '';
		terminal.show();
		terminal.sendText(command);
		const session: AgentSession = {
			id, cli, name, state: cli === 'claude' ? 'starting' : 'unknown', since: Date.now(), todos: [], unread: false,
			prompt: resume?.prompt, command: cli === 'custom' ? command : undefined, agentId: resume?.agentId, worktree,
			cwd, pr: cwd ? this.prs.get(cwd) : undefined,
			transcript: cli === 'claude' ? resume?.transcript ?? transcriptPath(id, cwd) : undefined,
		};
		this.sessions.set(id, session);
		this.terminals.set(id, terminal);
		// The dollars Claude Code reports count from this start; a resumed transcript's earlier turns are kept apart.
		this.costs.delete(id);
		this.tracker(session)?.started(Date.now());
		this.watchTranscript(session);
		// No SessionStart yet: Claude runs no hook before the folder is trusted, so it likely waits on that question (or on
		// approving MCP servers). Say it may need you, rather than "Ready"; the first hook event clears it. (A missing Node
		// on the hook path looks the same, which is why the text says "may".)
		setTimeout(() => {
			if (session.state === 'starting') {
				session.state = 'idle';
				// Only when its hooks are wired: without them no event ever comes, and every session would say it needs you.
				if (cli === 'claude' && this.server && this.settingsOk && !this.heard.has(id)) {
					const need = startupNeed(Date.now());
					this.attention.set(id, { failures: 0, need });
					session.need = need;
				}
				this.changed.fire();
			}
		}, 8000);
		// Codex skips hooks the user has not trusted yet, without a word: say what brings the status in.
		if (codexHooks) {
			setTimeout(() => {
				if (session.state === 'unknown' && !session.activity) {
					session.activity = 'No status yet: run /hooks in Codex and trust Insilode\'s hooks';
					this.changed.fire();
				}
			}, 20_000);
		}
		session.pid = await terminal.processId;
		this.save();
		this.changed.fire();
		return session;
	}

	/** The sessions as the ask picker sees them (askTarget.ts): which have reported from a hook, which still have a terminal. */
	askSessions(): SessionInfo[] {
		return [...this.sessions.values()].map(s => ({ id: s.id, cli: s.cli, name: s.name, state: s.state, since: s.since, heard: this.heard.has(s.id), alive: this.terminals.has(s.id), command: s.command }));
	}

	/**
	 * Types one line into the session's prompt; `submit` presses Enter, else the text waits there to be finished. Checked
	 * here, at the moment of typing, not only when the target was chosen: a permission prompt may have come up meanwhile,
	 * and a typed key can answer one. False when the session cannot take it now.
	 */
	typeInto(id: string, line: string, submit: boolean, customs: CustomCli[], reveal = true): boolean {
		const t = this.terminals.get(id);
		const s = this.askSessions().find(x => x.id === id);
		// One line of plain characters, whoever built it: a file name or a method name may hold a line break or a terminal's escape or
		// control keys (Ctrl+C, Ctrl+D), and none of them may reach the prompt or the shell behind it.
		const typed = oneLine(line);
		if (!t || !s || !canType(s, customs) || !typed) {
			return false;
		}
		if (reveal) {
			t.show();
		}
		t.sendText(typed, false);
		if (submit) {
			// Claude Code takes a long line for a paste, and an Enter that arrives in the same write only adds a line to the draft
			// (found with a real session): the Enter goes on its own, a moment later.
			setTimeout(() => {
				try {
					t.sendText('', true);
				} catch {
					// the terminal was closed in between
				}
			}, SUBMIT_DELAY_MS);
		}
		return true;
	}

	/**
	 * Types work Insilode queued for an agent (pull request news) and submits it, without bringing its terminal up. Only into
	 * a Claude Code or Codex session that is at its prompt (done or idle), and never while you look at that terminal in the
	 * focused window: you may be typing there. False when it cannot take it now; the caller keeps the work for the next turn end.
	 */
	deliver(id: string, text: string): boolean {
		const s = this.sessions.get(id);
		if (!s || (s.cli !== 'claude' && s.cli !== 'codex') || (s.state !== 'done' && s.state !== 'idle')) {
			return false;
		}
		if (vscode.window.state.focused && vscode.window.activeTerminal === this.terminals.get(id)) {
			return false;
		}
		// You went to its terminal since the turn ended: a half-typed prompt of yours may wait there, and what is typed now
		// would be submitted with it. The work waits for the next turn end instead.
		if ((this.lookedAt.get(id) ?? 0) > (this.turnEndedAt.get(id) ?? 0)) {
			return false;
		}
		return this.typeInto(id, text, true, [], false);
	}

	/** Resolves true once the session can take typed text (its first hook said it is at its prompt), false after `ms`. */
	whenReady(id: string, customs: CustomCli[], ms = 30_000): Promise<boolean> {
		const ready = () => {
			const s = this.askSessions().find(x => x.id === id);
			return !!s && canType(s, customs);
		};
		if (ready()) {
			return Promise.resolve(true);
		}
		return new Promise(resolve => {
			const timer = setTimeout(() => done(false), ms);
			const sub = this.onDidChange(() => ready() && done(true));
			const done = (r: boolean) => {
				clearTimeout(timer);
				sub.dispose();
				resolve(r);
			};
		});
	}

	/** Brings the session's terminal forward without typing into it. */
	reveal(id: string) {
		this.terminals.get(id)?.show();
	}

	/** Types /compact into the agent's terminal (both CLIs take it): keeps a summary, frees most of the window. */
	compact(id: string) {
		const r = this.slash(id, 'compact', false, false);
		// The row may be older than the state, or a reloaded window has not heard from the session yet: say why nothing was typed.
		const name = this.sessions.get(id)?.name ?? 'The agent';
		const why: Partial<Record<SlashResult, string>> = {
			waiting: `${name} is waiting for your answer in its terminal: answer it first.`,
			busy: `${name} is working: compact when it is back at its prompt.`,
			'not-ready': `${name} has not said it is at its prompt since this window opened: type /compact in its terminal yourself.`,
		};
		if (why[r]) {
			void vscode.window.showInformationMessage(why[r]!);
		}
	}

	/**
	 * Types a known slash command into one session, found by id (a name can be renamed or shared by a user's shell).
	 * Checked here, at the moment of typing, not only in the page that asked: the row or the X-ray may be older than the
	 * state, and the Enter would answer a permission prompt that just came up. `check` only says whether it would be typed.
	 */
	slash(id: string, kind: SlashKind, check: boolean, preserveFocus = true): SlashResult {
		const t = this.terminals.get(id);
		const s = this.askSessions().find(x => x.id === id);
		const refused = slashRefusal(s && { ...s, alive: !!t }, kind);
		const text = s && slashText(kind, s.cli);
		if (refused || !t || !text) {
			return refused ?? 'no-terminal';
		}
		if (!check) {
			t.show(preserveFocus);
			t.sendText(text);
		}
		return 'sent';
	}

	show(id: string) {
		const t = this.terminals.get(id);
		const s = this.sessions.get(id);
		if (t) {
			t.show();
		} else if (s) {
			void this.spawn(s.cli, s);
			return;
		}
		if (s) {
			s.unread = false;
			this.changed.fire();
		}
	}

	/**
	 * Gives an agent a name of the user's choosing. Claude's own /rename is a `custom-title` line in the transcript, so one is
	 * appended: the new name then survives readTitle (which takes the newest title) and shows in Claude's own /resume list.
	 */
	async rename(id: string, name: string) {
		const s = this.sessions.get(id);
		const title = name.replace(/\s+/g, ' ').trim().slice(0, 80);
		if (!s || !title || title === s.name) {
			return;
		}
		s.name = title;
		this.save();
		this.changed.fire();
		if (s.cli === 'claude' && s.transcript && existsSync(s.transcript)) {
			const line = JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: path.basename(s.transcript, '.jsonl') });
			try {
				// Start on a fresh line only when the last one is unfinished: a blank line in the middle would be one more thing to parse.
				const h = await fs.open(s.transcript, 'a+');
				try {
					const { size } = await h.stat();
					const last = Buffer.alloc(1);
					if (size) {
						await h.read(last, 0, 1, size - 1);
					}
					await h.appendFile(`${size && last[0] !== 0x0a ? '\n' : ''}${line}\n`);
				} finally {
					await h.close();
				}
			} catch (e) {
				this.log.warn(`Agents: could not write the new name to the transcript (${(e as Error).message})`);
			}
		}
	}

	/** The worktrees kept after their agents left the list. */
	get keptWorktrees(): readonly KeptWorktree[] {
		return this.kept;
	}

	/** Keeps a record of a worktree whose agent leaves the list, or (`keep` false) drops it once it is merged or removed. */
	keepWorktree(wt: KeptWorktree, keep: boolean) {
		this.kept = this.kept.filter(k => !sameDir(k.path, wt.path));
		if (keep) {
			this.kept.push(wt);
		}
		this.save();
	}

	/** Removes a finished agent from the list (its terminal, if any, closes too). */
	forget(id: string) {
		if (this.dir) {
			void fs.rm(path.join(this.dir, `insilode-mcp-${id}.json`), { force: true }).catch(() => undefined);
		}
		this.terminals.get(id)?.dispose();
		this.terminals.delete(id);
		this.sessions.delete(id);
		this.skeletonSwitch.delete(id);
		this.touched.delete(id);
		this.turns.delete(id);
		this.planDrawn.delete(id);
		this.attention.delete(id);
		this.costs.delete(id);
		this.edits.delete(id);
		for (const [alias, owner] of this.aliases) {
			if (owner === id) {
				this.aliases.delete(alias);
			}
		}
		this.unwatch(id);
		this.save();
		this.changed.fire();
	}

	get needsYou() {
		return needsYouCount(this.sessions.values());
	}

	/** Whether you are looking at this agent now: the window has focus and its terminal is the active one. */
	isWatched(id: string) {
		const t = this.terminals.get(id);
		return !!t && vscode.window.state.focused && vscode.window.activeTerminal === t;
	}

	/** Opens the agent's PR in the browser. The page sends only the agent: the URL is the one `gh` gave. */
	openPr(id: string) {
		const url = this.sessions.get(id)?.pr?.url;
		if (url && /^https:\/\//.test(url)) {
			void vscode.env.openExternal(vscode.Uri.parse(url));
		}
	}

	private seen(t: vscode.Terminal | undefined) {
		for (const [id, term] of this.terminals) {
			if (term === t) {
				this.lookedAt.set(id, Date.now());
			}
			const s = this.sessions.get(id);
			if (term === t && s?.unread && s.state !== 'blocked') {
				s.unread = false;
				this.changed.fire();
			}
		}
	}

	/**
	 * The agent's command ended in its still open terminal. A clean exit is SessionEnd's to report; a failing code with no
	 * SessionEnd soon after is a crash. (Custom CLIs send no SessionEnd: their exit code alone decides.)
	 */
	private exited(t: vscode.Terminal, code: number | undefined) {
		if (code) {
			setTimeout(() => this.crashed(t, code), CRASH_GRACE_MS);
		}
	}

	private crashed(t: vscode.Terminal, code: number) {
		for (const [id, term] of this.terminals) {
			const s = this.sessions.get(id);
			const crash = term === t && s && s.state !== 'ended' ? crashNeed(code, Date.now()) : undefined;
			if (!s || !crash) {
				continue;
			}
			s.need = crash;
			this.attention.set(id, { failures: 0, need: crash });
			s.state = 'ended';
			s.since = Date.now();
			s.activity = s.cli === 'claude' ? 'Exited · click to show its terminal' : undefined;
			if (!this.isWatched(id)) {
				s.unread = true;
			}
			this.usageEnded(s);
			this.changed.fire();
		}
	}

	private closed(t: vscode.Terminal) {
		for (const [id, term] of this.terminals) {
			if (term === t) {
				this.terminals.delete(id);
				const s = this.sessions.get(id);
				if (s) {
					// Exited on its own with a failing code while it had work: a crash, worth a look.
					const crash = s.state !== 'ended' && s.state !== 'idle' && t.exitStatus?.reason !== vscode.TerminalExitReason.User ? crashNeed(t.exitStatus?.code, Date.now()) : undefined;
					s.need = crash;
					if (crash && !this.isWatched(id)) {
						s.unread = true;
					}
					s.state = 'ended';
					s.activity = s.cli === 'claude' ? 'Closed · click to resume' : undefined;
					s.since = Date.now();
					this.usageEnded(s);
				}
				this.unwatch(id);
				// No save here: a window being reloaded closes its terminals too (they live on in the
				// next window), and saving now would wipe them from the list. A terminal that really
				// closed is dropped on the next start, because its process is gone.
				this.changed.fire();
			}
		}
	}

	private request(req: http.IncomingMessage, res: http.ServerResponse) {
		const reply = (status: number, context?: { event: string; text: string }) => {
			res.statusCode = status;
			res.setHeader('content-type', 'application/json');
			// Never a decision: the CLI keeps asking the user itself. At most context for the agent to read.
			res.end(context ? JSON.stringify({ hookSpecificOutput: { hookEventName: context.event, additionalContext: context.text } }) : '{}');
		};
		if (req.method !== 'POST' || (req.url !== '/hook' && req.url !== '/status') || req.headers['x-flow-token'] !== this.token) {
			req.resume();
			return reply(403);
		}
		let body = '';
		req.setEncoding('utf8'); // chunks can split a multibyte character; the decoder joins them
		req.on('data', d => {
			body += d;
			if (body.length > 4_000_000) {
				req.destroy();
			}
		});
		const agent = String(req.headers['x-flow-agent'] ?? '');
		req.on('end', async () => {
			let context: { event: string; text: string } | undefined;
			try {
				if (req.url === '/status') {
					this.status(JSON.parse(body), agent);
				} else {
					context = await this.hook(JSON.parse(body) as HookPayload, agent);
				}
			} catch (e) {
				this.log.warn(`Agents: hook failed: ${(e as Error).message}`);
			}
			reply(200, context);
		});
	}

	/**
	 * The agent a hook event belongs to. /clear and /resume can give the conversation a new session id,
	 * but the terminal still carries the id Insilode chose (FLOW_AGENT_SESSION): remember the new one for it.
	 */
	private sessionFor(id: string | undefined, agent: string) {
		const known = id ? this.sessions.get(id) ?? this.sessions.get(this.aliases.get(id) ?? '') : undefined;
		if (known || !id) {
			return known;
		}
		const owner = agent ? this.sessions.get(agent) : undefined;
		if (owner?.cli === 'codex') {
			// Codex chose this id: it is the one `codex resume` takes from now on.
			this.aliases.set(id, owner.id);
			owner.agentId = id;
			return owner;
		}
		if (owner?.cli === 'claude') {
			this.aliases.set(id, owner.id);
			this.log.info(`Agents: ${owner.name} continues as session ${id}`);
			return owner;
		}
		return undefined;
	}

	/** Handles one hook event; what it returns is context the agent reads next (only skeleton first's reminder, today). */
	private async hook(p: HookPayload, agent = ''): Promise<{ event: string; text: string } | undefined> {
		const s = this.sessionFor(p.session_id, agent);
		let context: { event: string; text: string } | undefined;
		if (!s) {
			return; // a session Insilode did not start (or forgot): stay out of it
		}
		this.heard.add(s.id);
		if (p.cwd && p.cwd !== s.cwd) {
			s.cwd = p.cwd;
			s.pr = this.prs.get(p.cwd);
		}
		if (p.transcript_path && p.transcript_path !== s.transcript) {
			s.transcript = p.transcript_path;
			this.unwatch(s.id);
			this.watchTranscript(s);
		}
		this.forwardEvent(s, p);
		const was = s.state;
		const set = (state: AgentState, activity?: string) => {
			if (state !== s.state) {
				s.since = Date.now();
			}
			s.state = state;
			s.activity = activity;
		};
		const tool = p.tool_name ?? '';
		const event = p.hook_event_name ?? '';
		const att = nextAttention(this.attention.get(s.id) ?? { failures: 0 }, {
			event, tool, input: p.tool_input, described: tool ? describe(tool, p.tool_input) : undefined,
			notificationType: p.notification_type, message: p.message, error: p.error, errorDetails: p.error_details, lastMessage: p.last_assistant_message,
			agentId: p.agent_id, agentType: p.agent_type,
		}, Date.now());
		this.attention.set(s.id, att);
		const wasNeed = s.need;
		s.need = att.need;
		switch (event) {
			case 'SessionStart':
				if (s.state === 'starting' || s.state === 'unknown') {
					set(s.prompt ? 'done' : 'idle');
				}
				break;
			case 'UserPromptSubmit':
				// Skeleton first must hold outside plan mode too: the request itself may add types, so the reminder comes with every prompt.
				if (this.skeletonOn(s.id)) {
					context = { event: 'UserPromptSubmit', text: SKELETON_PROMPT_GATE };
				}
				this.settleAsked(s, 'denied');
				s.prompt = p.prompt?.trim().slice(0, 400);
				s.todos = [];
				s.impact = undefined;
				this.touched.delete(s.id);
				this.turns.delete(s.id);
				this.planDrawn.delete(s.id);
				gazeTurn(s.id);
				set('working', 'Thinking');
				void this.markPrompt(s);
				await Promise.resolve(vscode.commands.executeCommand('flow.agentTurn', s.prompt ?? 'Prompt', agentLabel(s))).catch(() => undefined);
				break;
			case 'PreToolUse': {
				if (tool === 'ExitPlanMode') {
					// The plan is proposed, not yet approved: draw it now, and never hold the prompt back for it.
					this.planProposed(s, p, 'before');
					break;
				}
				if (tool === 'AskUserQuestion') {
					set('blocked', s.need?.text);
					break;
				}
				// An edit: remember the files as they are, for the timeline and Undo.
				if (!isEdit(tool)) {
					break;
				}
				const files = filesOf(tool, p.tool_input, p.cwd);
				await bounded(Promise.resolve(vscode.commands.executeCommand('flow.agentWillEdit', files)).catch(() => undefined), SNAPSHOT_WAIT_MS);
				this.planEdit(s, files, 'before');
				this.recordEdits(s, files);
				break;
			}
			case 'PermissionRequest':
				this.asked.set(s.id, { tool, input: p.tool_input ?? {}, cwd: p.cwd, at: Date.now() });
				set('blocked', s.need?.kind === 'question' ? s.need.text : `Wants to: ${describe(tool, p.tool_input)}`);
				break;
			case 'PostToolUse':
			case 'PostToolUseFailure': {
				// A tool that ran and failed was still allowed: either way the question is over and the agent works on.
				this.settleAsked(s, 'allowed');
				set('working', describe(tool, p.tool_input));
				if (p.hook_event_name === 'PostToolUse') {
					gazeHook(s.id, s.name, s.cli, tool, p.tool_input, p.tool_response, p.cwd, s.worktree?.path);
					if (isEdit(tool)) {
						const files = filesOf(tool, p.tool_input, p.cwd);
						void Promise.resolve(vscode.commands.executeCommand('flow.agentDidEdit', files)).catch(() => undefined);
						this.touch(s, files);
						this.planEdit(s, files, 'after');
						this.recordEdits(s, files);
					} else if (tool === 'ExitPlanMode') {
						this.planProposed(s, p, 'after');
						// The plan was just approved and nothing is written yet: the one moment the reminder can come before the first edit.
						if (this.skeletonOn(s.id)) {
							context = { event: 'PostToolUse', text: SKELETON_GATE };
						}
					}
					this.todos(s, tool, p.tool_input ?? {}, p.tool_response ?? {});
				}
				void this.readUsage(s);
				break;
			}
			case 'Notification':
				if (p.notification_type === 'permission_prompt' || /permission/i.test(p.message ?? '')) {
					if (s.state !== 'blocked') {
						set('blocked', p.message);
					}
				} else if (p.notification_type === 'elicitation_dialog') {
					if (s.state !== 'blocked') {
						set('blocked', s.need?.text);
					}
				} else if (p.notification_type === 'idle_prompt' && s.state !== 'done') {
					set('done', undefined);
				}
				break;
			case 'Stop':
				this.settleAsked(s, 'denied');
				set('done', undefined);
				void this.readUsage(s);
				void this.turnImpact(s);
				break;
			case 'StopFailure':
				// The turn ended on an error: nothing is running, and the row says why (s.need).
				this.settleAsked(s, 'denied');
				set('done', undefined);
				void this.readUsage(s);
				break;
			case 'SessionEnd':
				set('ended', undefined);
				this.usageEnded(s);
				break;
		}
		const active = vscode.window.activeTerminal === this.terminals.get(s.id) && vscode.window.state.focused;
		if (((s.state === 'blocked' || s.state === 'done') && was !== s.state || (s.need && s.need.at !== wasNeed?.at)) && !active) {
			s.unread = true;
		}
		if (s.state === 'working') {
			s.unread = false;
		}
		this.save();
		this.changed.fire();
		if (event === 'Stop' || event === 'StopFailure' || (event === 'Notification' && p.notification_type === 'idle_prompt')) {
			this.turnEndedAt.set(s.id, Date.now());
			this.turnEnded.fire(s);
		}
		return context;
	}

	/**
	 * An agent left plan mode: its plan (Markdown) becomes a board in Insilode. Claude Code puts the plan into the hook input
	 * (`tool_input.plan` before approval, `tool_response.plan` after); older versions may give only a file path. Fire and
	 * forget: the hook runs before the approval prompt appears, so nothing here may delay it. One board per session, so a
	 * revised plan replaces the old one.
	 */
	private planProposed(s: AgentSession, p: HookPayload, phase: 'before' | 'after') {
		if (!vscode.workspace.getConfiguration('flow.agents').get<boolean>('planBoard', true) || (phase === 'after' && this.planDrawn.has(s.id))) {
			return;
		}
		const source = phase === 'before' ? p.tool_input : p.tool_response;
		const file = [source?.planFilePath, source?.filePath].find((f): f is string => typeof f === 'string' && /\.md$/i.test(f));
		void (async () => {
			let plan = typeof source?.plan === 'string' ? source.plan : undefined;
			if (!plan && file) {
				plan = await bounded(fs.readFile(file, 'utf8'), 2000).catch(() => undefined);
			}
			if (plan?.trim()) {
				this.planDrawn.add(s.id);
				await vscode.commands.executeCommand('flow.agent.plan', s.id, plan, file);
			}
		})().catch(e => this.log.warn(`Agents: plan board failed: ${(e as Error).message}`));
	}

	/** An edit of a file a plan step points at moves that step (doing before the edit, done after it). */
	private planEdit(s: AgentSession, files: string[], phase: 'before' | 'after') {
		if (files.length) {
			void Promise.resolve(vscode.commands.executeCommand('flow.agent.edited', s.id, files, phase)).catch(() => undefined);
		}
	}

	private touch(s: AgentSession, files: string[]) {
		const set = this.touched.get(s.id) ?? new Set<string>();
		files.forEach(f => set.size < MAX_TOUCHED && set.add(f));
		this.touched.set(s.id, set);
	}

	/** The turn is over: which flows did the edited files reach? Shown on the agent's row; clicking one opens it. */
	private async turnImpact(s: AgentSession) {
		const files = [...(this.touched.get(s.id) ?? [])];
		if (!files.length || !vscode.workspace.getConfiguration('flow.agents').get<boolean>('turnImpact', true)) {
			return;
		}
		const impact = await bounded(Promise.resolve(vscode.commands.executeCommand<TurnImpact>('flow.agent.turnImpact', files)).catch(() => undefined), IMPACT_WAIT_MS);
		// The methods and flows count for conflicts whatever the agent does next: it did change them.
		if (impact) {
			this.recordImpact(s, impact);
			if (s.state !== 'working' && this.touched.get(s.id)) {
				this.turns.set(s.id, { impact });
			}
		}
		// A new prompt may have started while this was computed: its answer no longer describes the turn on screen.
		if ((impact?.flows?.length || impact?.tables?.length) && s.state !== 'working' && this.touched.get(s.id)) {
			s.impact = impact;
			this.changed.fire();
		}
	}

	/** Whether the row offers "Explain this": the agent is at its prompt (a Claude or Codex session that is alive) and its last turn edited a file. */
	canExplain(s: AgentSession): boolean {
		return canExplain(this.touched.get(s.id)?.size ?? 0) && (s.state === 'done' || s.state === 'idle') && s.cli !== 'custom' && this.terminals.has(s.id);
	}

	/**
	 * "Explain this": asks the agent that made the last turn's change to explain it as a tour on the change set. It goes to that same
	 * session (the author explains its own change), typed only when it is at its prompt, never into one that is working or asking.
	 */
	explain(id: string, customs: CustomCli[]) {
		const s = this.sessions.get(id);
		const files = [...(this.touched.get(id) ?? [])];
		if (!s || !this.canExplain(s)) {
			void vscode.window.showInformationMessage(s && canExplain(files.length) ? `Insilode: ${s.name} is not at its prompt: choose Explain this again when it is.` : 'Insilode: nothing to explain: this agent has not edited a file since its last prompt.');
			return;
		}
		const text = explainPrompt(files, this.turns.get(id)?.impact, this.rootOf(s));
		if (!this.typeInto(id, text, true, customs)) {
			const now = this.askSessions().find(x => x.id === id);
			void vscode.window.showInformationMessage(`Insilode: ${now ? notReady(now) : `${s.name} has closed`}: choose Explain this again when it is back at its prompt.`);
		}
	}

	/** Agents switched on or off by hand; any other follows the setting `insilode.skeletonFirst.enabled`. In memory: a reload starts over. */
	private readonly skeletonSwitch = new Map<string, boolean>();

	/** Whether skeleton first is on for this agent. */
	skeletonOn(id: string): boolean {
		return this.skeletonSwitch.get(id) ?? skeletonFirstDefault();
	}

	/**
	 * The agent's Skeleton button. That is all the dock does: the stages are driven by the developer talking to the agent. Off ends this
	 * agent's change in skeleton first at once (the board loses its colours); other agents keep theirs.
	 */
	async setSkeletonOn(id: string, on: boolean) {
		if (!this.sessions.has(id)) {
			return;
		}
		this.skeletonSwitch.set(id, on);
		if (!on) {
			await Promise.resolve(vscode.commands.executeCommand('flow.skeleton.finish', id)).catch(skeletonFailed);
		}
		this.changed.fire();
	}

	/** The checkout a session works in: its worktree, or the window's folder. */
	rootOf(s: AgentSession): string | undefined {
		return s.worktree?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private editsOf(s: AgentSession): SessionEdits | undefined {
		const root = this.rootOf(s);
		if (!root) {
			return undefined;
		}
		let e = this.edits.get(s.id);
		if (!e || e.root !== root) {
			e = { id: s.id, name: s.name, root, files: new Set(), methods: new Map(), flows: new Map() };
			this.edits.set(s.id, e);
		}
		return e;
	}

	/** An edit is announced (PreToolUse: "is editing") or done (PostToolUse): either way the file is this session's now. */
	private recordEdits(s: AgentSession, files: string[]) {
		const e = this.editsOf(s);
		if (!e) {
			return;
		}
		const before = e.files.size;
		for (const f of files) {
			const k = key(f, e.root);
			if (k && e.files.size < 500) {
				e.files.add(k);
			}
		}
		if (e.files.size !== before) {
			this.changed.fire();
		}
	}

	private recordImpact(s: AgentSession, impact: TurnImpact) {
		const e = this.editsOf(s);
		if (!e) {
			return;
		}
		for (const m of Array.isArray(impact.methods) ? impact.methods : []) {
			const k = typeof m?.file === 'string' && typeof m.name === 'string' ? key(m.file, e.root) : undefined;
			if (k && e.methods.size < 500) {
				e.methods.set(`${k}#${m.name}`, m.name);
			}
		}
		for (const f of Array.isArray(impact.flows) ? impact.flows : []) {
			if (typeof f?.id === 'string' && typeof f.label === 'string' && e.flows.size < 200) {
				e.flows.set(f.id, f.label);
			}
		}
		this.changed.fire();
	}

	/** Which live sessions overlap with which: the files, methods and flows two of them both changed. */
	conflicts(): Map<string, Conflict[]> {
		const live = [...this.sessions.values()].filter(s => s.state !== 'ended' && this.edits.has(s.id));
		return findConflicts(live.map(s => ({ ...this.edits.get(s.id)!, name: s.name })));
	}

	/** Closes an agent's terminal (before its worktree is removed: a shell inside the folder keeps it busy on Windows). */
	closeTerminal(id: string) {
		this.terminals.get(id)?.dispose();
	}

	/**
	 * The harness map counts what agents use (skills, subagents, MCP servers, hooks) and learns from what you keep
	 * correcting and what keeps failing. It gets a bounded copy of each event, never waited for.
	 */
	private forwardEvent(s: AgentSession, p: HookPayload) {
		const input: Record<string, string> = {};
		for (const k of EVENT_INPUT) {
			const v = p.tool_input?.[k];
			if (typeof v === 'string') {
				input[k] = v.slice(0, 600);
			}
		}
		void Promise.resolve(vscode.commands.executeCommand('flowHarness.recordEvent', {
			at: Date.now(), agent: s.name, cli: s.cli, session: p.session_id, event: p.hook_event_name, tool: p.tool_name, input,
			error: typeof p.error === 'string' ? p.error.slice(0, 1000) : undefined, durationMs: p.duration_ms,
			prompt: p.hook_event_name === 'UserPromptSubmit' ? p.prompt?.slice(0, 2000) : undefined,
			agentType: p.agent_type, transcript: s.transcript, id: s.id, mode: p.permission_mode,
		})).catch(() => undefined);
	}

	/** The context X-ray of one agent, in the harness map: it reads the agent's transcript and the usage reported last. */
	xray(id: string) {
		const s = this.sessions.get(id);
		if (s) {
			// A click asked for it: if the harness map cannot answer, say so instead of doing nothing.
			void Promise.resolve(vscode.commands.executeCommand('flowHarness.contextXray', { id: s.id, agent: s.name, cli: s.cli, transcript: s.transcript, usage: s.usage }))
				.catch(e => void vscode.window.showWarningMessage(`The context X-ray is not available: ${(e as Error).message ?? e}`));
		}
	}

	/** Opens the flow at `index` of an agent's turn impact (the dock sends an index, never an id of its own making). */
	openImpactFlow(id: string, index: number) {
		const flow = this.sessions.get(id)?.impact?.flows[index];
		if (flow) {
			void Promise.resolve(vscode.commands.executeCommand('flow.showEntry', flow.id, flow.name, flow.source)).catch(() => undefined);
		}
	}

	/** The question was answered: the tool ran (allowed) or the turn moved on without it (denied). */
	private settleAsked(s: AgentSession, decision: 'allowed' | 'denied') {
		const q = this.asked.get(s.id);
		if (!q) {
			return;
		}
		this.asked.delete(s.id);
		if (s.cli !== 'claude') {
			return; // the permission inbox writes Claude Code rules; Codex keeps its own approvals
		}
		void Promise.resolve(vscode.commands.executeCommand('flowHarness.recordPermission', {
			at: q.at,
			agent: AGENT,
			kind: KIND[q.tool] ?? (q.tool.startsWith('mcp__') ? 'other' : undefined),
			title: q.tool.startsWith('mcp__') ? q.tool : describe(q.tool, q.input),
			files: filesOf(q.tool, q.input, q.cwd),
			rawInput: q.input,
			decision,
		})).catch(() => undefined);
	}

	/** TodoWrite replaces the list; the Task tools add and update one item at a time. */
	private todos(s: AgentSession, tool: string, input: Record<string, unknown>, response: Record<string, unknown>) {
		if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
			// The list comes from the model: only the three known statuses are kept (the dock puts the status in a class name).
			const STATUSES: Todo['status'][] = ['pending', 'in_progress', 'completed'];
			s.todos = (input.todos as { content?: string; activeForm?: string; status?: string }[])
				.map(t => ({ text: String((t.status === 'in_progress' ? t.activeForm : t.content) ?? t.content ?? ''), status: STATUSES.find(x => x === t.status) ?? 'pending' }));
		} else if (tool === 'TaskCreate') {
			const task = (response.task ?? response) as { id?: string | number };
			s.todos.push({ text: String(input.subject ?? input.description ?? 'Task'), status: 'pending', key: String(task.id ?? s.todos.length + 1) });
		} else if (tool === 'TaskUpdate') {
			const key = String(input.taskId ?? input.id ?? '');
			const t = s.todos.find(x => x.key === key);
			if (t && typeof input.status === 'string') {
				t.status = input.status === 'completed' ? 'completed' : input.status === 'in_progress' ? 'in_progress' : 'pending';
			}
		}
	}

	/**
	 * The transcript tells what no hook does: a /rename (a `custom-title` line), a "no" to a
	 * permission question, and the tokens of the message that ended a turn. Watch its folder, since the file only appears with the first message.
	 */
	private watchTranscript(s: AgentSession) {
		if (s.cli !== 'claude' || !s.transcript || this.watchers.has(s.id)) {
			return;
		}
		const dir = path.dirname(s.transcript);
		const file = path.basename(s.transcript);
		void fs.mkdir(dir, { recursive: true }).then(() => {
			if (this.watchers.has(s.id) || !this.sessions.has(s.id)) {
				return;
			}
			try {
				const w = watch(dir, (_e, name) => {
					if (name && name !== file) {
						return;
					}
					clearTimeout(this.titleTimers.get(s.id));
					this.titleTimers.set(s.id, setTimeout(() => {
						this.titleTimers.delete(s.id);
						void this.readTitle(s);
						void this.checkRefusal(s);
						// The last message of a turn lands after Stop: the transcript changing is what says it is there.
						void this.readCost(s);
					}, 250));
				});
				// A watched folder that goes away (EPERM on Windows) must not become an uncaught error.
				w.on('error', () => this.unwatch(s.id));
				this.watchers.set(s.id, w);
			} catch {
				// no folder: no rename tracking
			}
		}).catch(() => undefined);
	}

	/** Picks up /rename: the newest custom title in the transcript becomes the agent's name. */
	private async readTitle(s: AgentSession, whole = false) {
		if (!s.transcript) {
			return;
		}
		// A transcript can be hundreds of MB: only its ends are read, never the whole file. A title is written again
		// near the end when a session continues; at startup (`whole`) the beginning is looked at too.
		const tail = await this.tail(s.transcript, whole ? 1 << 20 : 16384).catch(() => [] as string[]);
		const title = lastTitle(tail) ?? (whole ? lastTitle(await this.head(s.transcript, 256 * 1024).catch(() => [] as string[])) : undefined);
		if (title && title !== s.name) {
			s.name = title;
			this.save();
			this.changed.fire();
		}
	}

	private unwatch(id: string) {
		this.watchers.get(id)?.close();
		this.watchers.delete(id);
		clearTimeout(this.titleTimers.get(id));
		this.titleTimers.delete(id);
	}

	private async head(file: string, bytes: number) {
		const h = await fs.open(file, 'r');
		try {
			const buf = Buffer.alloc(bytes);
			const { bytesRead } = await h.read(buf, 0, bytes, 0);
			const lines = buf.toString('utf8', 0, bytesRead).split('\n');
			return (bytesRead === bytes ? lines.slice(0, -1) : lines).filter(Boolean); // the last line of a full read may be cut
		} finally {
			await h.close();
		}
	}

	private async tail(file: string, bytes = 65536) {
		const h = await fs.open(file, 'r');
		try {
			const { size } = await h.stat();
			const start = Math.max(0, size - bytes);
			const buf = Buffer.alloc(size - start);
			await h.read(buf, 0, buf.length, start);
			return buf.toString('utf8').split('\n').slice(start ? 1 : 0).filter(Boolean);
		} finally {
			await h.close();
		}
	}

	private async checkRefusal(s: AgentSession) {
		if (s.state !== 'blocked' || !s.transcript) {
			return;
		}
		const lines = await this.tail(s.transcript, 16384).catch(() => [] as string[]);
		const last = lines.slice(-3).join('\n');
		if (/doesn't want to proceed|Request interrupted by user|tool use was rejected/i.test(last)) {
			this.settleAsked(s, 'denied');
			s.state = 'done';
			s.need = undefined;
			this.attention.set(s.id, { failures: 0 });
			s.activity = 'You said no';
			s.since = Date.now();
			this.save();
			this.changed.fire();
		}
	}

	/** Claude's status line spoke: the context window as the CLI knows it, and the plan's limits when it has them. */
	private status(payload: unknown, agent: string) {
		const st = parseClaudeStatus(payload);
		const s = this.sessionFor(st.sessionId, agent);
		if (s && st.usage) {
			this.setUsage(s, st.usage);
		}
		const usd = statusUsd(payload);
		if (s && usd !== undefined) {
			this.tracker(s)?.setUsd(usd);
			this.setCost(s);
		}
		if (st.limits) {
			this.reportLimits(st.limits);
		}
	}

	/**
	 * Context in use, from the end of the transcript: for Claude the last assistant message's input side (the
	 * window comes from the status line, never from a guess), for Codex its newest token_count event.
	 */
	private async readUsage(s: AgentSession) {
		if (!s.transcript) {
			return;
		}
		const epoch = s.usageEpoch ?? 0;
		void this.readCost(s);
		const lines = await this.tail(s.transcript).catch(() => [] as string[]);
		if (s.cli === 'codex') {
			const { usage, limits } = codexRolloutUsage(lines);
			if (usage) {
				this.setUsage(s, usage, epoch);
			}
			if (limits) {
				this.reportLimits(limits);
			}
			return;
		}
		const usage = claudeTranscriptUsage(lines);
		if (usage) {
			// The status line's display name (Sonnet 5.5) reads better than the transcript's API id: keep it once known.
			this.setUsage(s, s.usage?.model ? { used: usage.used } : usage, epoch);
		}
	}

	/** Only news reaches the dock: see applyUsage for what is dropped (ended sessions, stale reads, repeats). */
	private setUsage(s: AgentSession, next: ContextUsage, epoch?: number) {
		if (applyUsage(s, next, epoch)) {
			this.changed.fire();
		}
	}

	private tracker(s: AgentSession) {
		if (s.cli === 'custom') {
			return undefined;
		}
		let t = this.costs.get(s.id);
		if (!t) {
			t = new CostTracker(s.cli);
			this.costs.set(s.id, t);
		}
		return t;
	}

	/** Reads what the transcript gained (the first time, all of it) and shows the new totals. */
	private async readCost(s: AgentSession) {
		const t = this.tracker(s);
		await t?.update(s.transcript).catch(e => this.log.warn(`Agents: could not read the cost of ${s.name} (${(e as Error).message})`));
		this.setCost(s);
	}

	/** A prompt was sent: the tokens so far belong to the earlier ones. */
	private async markPrompt(s: AgentSession) {
		const t = this.tracker(s);
		await t?.update(s.transcript).catch(() => undefined);
		t?.markPrompt();
		this.setCost(s);
	}

	private setCost(s: AgentSession) {
		const next = this.tracker(s)?.snapshot();
		if (JSON.stringify(next) !== JSON.stringify(s.cost)) {
			s.cost = next;
			this.changed.fire();
		}
	}

	/** Asks for the PR of every live agent's folder; the watcher answers from its cache until that is a couple of minutes old. */
	private refreshPrs() {
		const fallback = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		for (const s of this.sessions.values()) {
			const cwd = s.cwd ?? fallback;
			if (cwd && s.state !== 'ended') {
				this.prs.get(cwd);
			}
		}
	}

	private prChanged(cwd: string) {
		const fallback = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		for (const s of this.sessions.values()) {
			if ((s.cwd ?? fallback) === cwd) {
				s.pr = this.prs.get(cwd);
			}
		}
		this.changed.fire();
	}

	/** The CLI exited or its terminal closed: its numbers say nothing any more, and a resumed session reports afresh. */
	private usageEnded(s: AgentSession) {
		endUsage(s);
		// The status line forwards only changes: forget what it last sent, so a resumed session reports its numbers again.
		if (this.dir) {
			void fs.rm(path.join(this.dir, `status-${s.id.replace(/[^\w-]/g, '')}.last`), { force: true }).catch(() => undefined);
		}
	}

	/** Each harness's limits go to flow-harness once per change, and again after a send that failed. */
	private readonly limits = new LimitsSender(l => Promise.resolve(vscode.commands.executeCommand('flowHarness.reportLimits', l)));
	private limitsRetry: NodeJS.Timeout | undefined;

	private reportLimits(limits: UsageLimits) {
		void this.limits.offer(limits).then(outcome => {
			// A failed send (flow-harness still starting) tries again shortly; a repeat of what went through does not.
			if (outcome === 'failed' && !this.limitsRetry) {
				this.limitsRetry = setTimeout(() => {
					this.limitsRetry = undefined;
					void this.limits.offer(limits);
				}, 30_000);
			}
		});
	}

	dispose() {
		disposeGaze();
		this.server?.close();
		// Hooks read the port at call time: leave it blank rather than pointing at a dead port, but not when a newer
		// window of this folder has already put its own there.
		if (this.server && this.dir) {
			try {
				const portFile = path.join(this.dir, 'hook-port');
				if (readFileSync(portFile, 'utf8').trim() === String(this.port)) {
					writeFileSync(portFile, '');
				}
			} catch {
				// already gone
			}
		}
		clearTimeout(this.orphanTimer);
		clearTimeout(this.limitsRetry);
		clearInterval(this.prTimer);
		this.watchers.forEach(w => w.close());
		this.titleTimers.forEach(clearTimeout);
		this.changed.dispose();
		this.turnEnded.dispose();
		this.disposables.forEach(d => d.dispose());
	}
}
