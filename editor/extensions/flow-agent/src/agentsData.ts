/*---------------------------------------------------------------------------------------------
 *  Insilode: what the host sends the Agents page (the full-editor page behind the title bar's Agents button). Types only,
 *  no vscode, so the page module, the host and the website's demo data all agree on one shape.
 *  The dock's rows and the page's rows are built by the same function (agentRows.ts), so the two views never drift apart.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSession } from './agents';
import type { AttentionKind } from './attention';
import type { AvatarKind } from './desktopModel';
import type { AgentsPageHarnessData, AgentsPageHarnessFailed } from './harnessData';
import type { HarnessPanelState, SavedLayout } from './layoutStore';
import type { PaneLayout } from './paneLayout';
import type { UsageLimits } from './usage';
import type { WorktreeView } from './worktreeActions';

/** One agent as the dock and the page draw it: the session's own record plus what is worked out for the view (its impact slimmed to what the views draw). */
export type AgentRow = Omit<AgentSession, 'impact' | 'worktree'> & {
	attention?: AttentionKind;
	/** Todos completed. */
	done: number;
	/** The todo in progress. */
	current?: string;
	/** Whether "Explain this" can run for its last turn. */
	explain: boolean;
	impact?: {
		files: number;
		more: number;
		flows: { label: string; via?: string[] }[];
		tables?: NonNullable<AgentSession['impact']>['tables'];
	};
	worktree?: WorktreeView;
	skeletonOn: boolean;
	skeletonAvailable: boolean;
	skeletonStage?: { stage: string; skipped: boolean };
	clash?: { text: string; same: boolean; files: string[] }[];
	/** Text may be typed into its prompt from the page's reply box (agents.ts `canType`). */
	acceptsInput: boolean;
	/** Claude: the session ids the conversation went on under after /clear or /resume (agents.ts aliasesOf), which the machine's registry of running sessions names it by. */
	aliases?: string[];
};

/**
 * One session of another window, as that window published it (peersCore.ts slimRow) and as this one validated it (parseRow):
 * only what the sidebar and the detail draw. No transcript path, pid, token, port or markup travels in it.
 */
export interface PeerRow {
	id: string;
	/** The id the CLI itself gave the session (Codex's thread id), a uuid: what the machine's index lists it by, so the page does not offer it as running elsewhere. */
	agentId?: string;
	/** Claude: the ids the conversation went on under after /clear (AgentRow.aliases), so the page does not offer it as running elsewhere under its new id. */
	aliases?: string[];
	cli: AgentSession['cli'];
	name: string;
	state: AgentSession['state'];
	since: number;
	attention?: AttentionKind;
	activity?: string;
	prompt?: string;
	/** What it waits for, as one line. */
	need?: string;
	todos: { text: string; status: 'pending' | 'in_progress' | 'completed' }[];
	tokens?: number;
	usd?: number;
	contextPercent?: number;
	model?: string;
	pr?: { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; title: string };
	/** How many flows its last turn reaches: "Open flow" is offered when there is one. */
	flows: number;
}

/** Another open window's project. `key` names its storage folder: the page sends it back, never a path. */
export interface PeerProject {
	key: string;
	name: string;
	rows: PeerRow[];
}

/** A project with no open window: its sessions are listed as closed and choosing it opens the folder. */
export interface RecentProject {
	key: string;
	name: string;
	sessions: string[];
}

/** A worktree kept after its agent left the list. */
export interface KeptRow {
	agent: string;
	branch: string;
	base: string;
	/** The folder's base name, for the row: the full path stays with the host. */
	folder: string;
}

/** Host → page: everything the page draws. Sent on every change, coalesced. */
export interface AgentsPageData {
	type: 'data';
	now: number;
	avatar: AvatarKind;
	rows: AgentRow[];
	kept: KeptRow[];
	/** The plan's usage limits as the CLI last reported them (Claude's status line, Codex's rollout). */
	limits?: UsageLimits;
	/** The names of the user's own agents (flow.agents.custom), for the New menu. */
	customs: string[];
	/** flow.agents.claude.allowBypassPermissions, for the Claude start menu's bypass item. */
	bypass?: boolean;
	/** This window's project, for the sidebar's first group. */
	project?: { name: string; /** The folder's absolute path: a pane of this window's folder keeps it, so a saved layout applied in another project resumes there. */ cwd?: string };
	/** Other open windows' projects and sessions, and projects with no window (peers.ts). */
	peers?: PeerProject[];
	recent?: RecentProject[];
}

/** One message of a conversation's tail, read-only. */
export interface TailEntry {
	role: 'user' | 'assistant' | 'tool';
	/** Shortened text; a tool call is one line (`Edit src/a.ts`). */
	text: string;
	/** Epoch ms, when the transcript says. */
	at?: number;
}

/** Host → page: the last messages of one agent's conversation, after the page asked for them (for a transcript pane). */
export interface AgentsPageTail {
	type: 'tail';
	id: string;
	entries: TailEntry[];
	/** Why there is nothing to show (no transcript yet, a custom agent, unreadable). */
	note?: string;
}

// ---- the sidebar's earlier sessions (projectIndex.ts) -------------------------------------------------------------------------

export type LiveStatus = 'working' | 'needs' | 'idle' | 'unknown';

/** What marks a session that runs outside this window (liveSessions.ts). `live`: a process that runs it was found (Claude); `recent`: only an estimate from the transcript's time (Codex has no list of running sessions). */
export interface LiveMark {
	status: LiveStatus;
	/** What runs it: "Claude Code CLI", "Claude desktop", "Codex". */
	source: string;
	basis: 'live' | 'recent';
}

/** A past session of a project, as the host's index knows it; `live` when something outside this window runs it. */
export interface ChatIndexSession {
	id: string;
	kind: 'claude' | 'codex';
	title: string;
	modified: number;
	live?: LiveMark;
}

/** A folder some agent has worked in. `key` is folderKey(folder): the page sends it back, never the path. */
export interface ChatProject {
	key: string;
	name: string;
	/** The folder with the home directory shortened, for a tooltip. */
	where: string;
	/** The folder itself: what a terminal that resumes one of its sessions starts in (the host asks before an agent runs outside this window's workspace). */
	cwd: string;
	/** This window's own folder. */
	own: boolean;
	sessions: ChatIndexSession[];
}

export interface ChatConfigOption {
	id: string;
	name: string;
	value?: string;
	items: { value: string; name: string }[];
}

export type ChatEvent =
	/** `mid` is the message id the agent gave the chunk: chunks join only within one message, and a user chunk without one never joins. */
	| { t: 'user'; text: string; mid?: string }
	| { t: 'text'; text: string; mid?: string }
	| { t: 'thought'; text: string; mid?: string }
	/** Upserted by `id`: later events of the same tool fill in what the first did not have. */
	| { t: 'tool'; id: string; kind?: string; title?: string; status?: string; files?: string[]; diffs?: { path: string; old: string; new: string }[]; out?: string }
	| { t: 'plan'; entries: { text: string; status: string }[] }
	| { t: 'ask'; req: number; title: string; files: string[]; options: { name: string; kind: string }[] }
	| { t: 'asked'; req: number }
	| { t: 'config'; config: ChatConfigOption[] }
	| { t: 'usage'; used: number; size: number }
	| { t: 'stop'; reason: string }
	/** `fatal`: the turn (or the agent process) is over. Any other error is only a line in the transcript. */
	| { t: 'error'; text: string; fatal?: true };

export interface AgentsPageChatIndex {
	type: 'chatIndex';
	projects: ChatProject[];
}

/** The answer to a `chatSearch`: `query` is the page's own, so a late answer to an earlier one can be told apart. `more`: the search was cut short or capped. `cut`: it was cut short (sessions not searched in full), so no hits does not mean no match. */
export interface AgentsPageChatFound {
	type: 'chatFound';
	query: string;
	hits: { project: string; kind: 'claude' | 'codex'; session: string; title: string; modified: number; snippet: string }[];
	more: boolean;
	cut: boolean;
}

// ---- the page's terminal panes (termBridge.ts, termHost.ts) -------------------------------------------------------------------

/** Output of an agent's terminal. With `reset` it is the replay of what the terminal already printed on attach (or empty: the terminal was replaced), and replaces what the pane drew. */
export interface AgentsPageTermData {
	type: 'termData';
	id: string;
	data: string;
	reset?: true;
}

/** The terminal is closed, or the session is not one this window has a terminal for: nothing more will come. */
export interface AgentsPageTermGone {
	type: 'termGone';
	id: string;
}

/** Answer to a `termOpen`: `id` is the agent session now running in a terminal, to attach to. */
export interface AgentsPageTermOpened {
	type: 'termOpened';
	id: string;
	requestId: string;
}

export interface AgentsPageTermFailed {
	type: 'termFailed';
	requestId: string;
	message: string;
	/** The refusal is that another process runs the session: the page may offer "Resume anyway" (a `termOpen` with `force`, which the host confirms with a modal of its own). */
	elsewhere?: true;
}

/** Host → page, once after `ready` and again when a layout is saved or deleted: the layout the page had on screen last (for the page to restore, once) and the layouts the user named. */
export interface AgentsPageLayouts {
	type: 'layouts';
	current?: PaneLayout;
	/** The Harness panel as the page left it (shown or not, how wide). */
	harness?: HarnessPanelState;
	saved: SavedLayout[];
}

/** Host → page: the answer to a `layoutSaveAs`, so the page says "Saved" only for a layout the host stored. `name` is the one the host read (trimmed); `reason` says why not: the 20-layout limit, or a layout or name the host's validation refused. */
export interface AgentsPageLayoutSaved {
	type: 'layoutSaved';
	name: string;
	ok: boolean;
	reason?: 'limit' | 'invalid';
}

export type AgentsPageMessage = AgentsPageData | AgentsPageTail | AgentsPageHarnessData | AgentsPageHarnessFailed | AgentsPageChatIndex | AgentsPageChatFound | AgentsPageLayouts | AgentsPageLayoutSaved | AgentsPageTermData | AgentsPageTermGone | AgentsPageTermOpened | AgentsPageTermFailed;
