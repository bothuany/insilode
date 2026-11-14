/*---------------------------------------------------------------------------------------------
 *  Insilode: what the host sends the Agents page (the full-editor page behind the title bar's Agents button). Types only,
 *  no vscode, so the page module, the host and the website's demo data all agree on one shape.
 *  The dock's rows and the page's rows are built by the same function (agentRows.ts), so the two views never drift apart.
 *--------------------------------------------------------------------------------------------*/

import type { AgentSession } from './agents';
import type { AttentionKind } from './attention';
import type { AvatarKind } from './desktopModel';
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
};

/**
 * One session of another window, as that window published it (peersCore.ts slimRow) and as this one validated it (parseRow):
 * only what the sidebar and the detail draw. No transcript path, pid, token, port or markup travels in it.
 */
export interface PeerRow {
	id: string;
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
	project?: { name: string };
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

/** Host → page: the last messages of one agent's conversation, after the page asked for them. */
export interface AgentsPageTail {
	type: 'tail';
	id: string;
	entries: TailEntry[];
	/** Why there is nothing to show (no transcript yet, a custom agent, unreadable). */
	note?: string;
}

/** Host → page: the reply box's text could not be typed in (the agent is not at its prompt, or it is gone). */
export interface AgentsPageReplyFailed {
	type: 'replyFailed';
	id: string;
}

// ---- the page's own chat (chatSessions.ts) ------------------------------------------------------------------------------------

/** A past or open chat session of a project, as the host's index knows it. */
export interface ChatIndexSession {
	id: string;
	kind: 'claude' | 'codex';
	title: string;
	modified: number;
}

/** A folder some agent has worked in. `key` is folderKey(folder): the page sends it back, never the path. */
export interface ChatProject {
	key: string;
	name: string;
	/** The folder with the home directory shortened, for a tooltip. */
	where: string;
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

/** A chat is open: `chat` is the host's id for it, used in every later message. */
export interface AgentsPageChatOpened {
	type: 'chatOpened';
	chat: string;
	project: string;
	kind: 'claude' | 'codex';
	title: string;
	busy: boolean;
	config: ChatConfigOption[];
}

/** `reset` replaces the transcript (a replay); otherwise the events are appended (a tool event updates its card). */
export interface AgentsPageChatEvents {
	type: 'chatEvents';
	chat: string;
	reset?: true;
	events: ChatEvent[];
}

export interface AgentsPageChatFailed {
	type: 'chatFailed';
	project: string;
	text: string;
}

/** The answer to a `chatSearch`: `query` is the page's own, so a late answer to an earlier one can be told apart. `more`: the search was cut short or capped. `cut`: it was cut short (sessions not searched in full), so no hits does not mean no match. */
export interface AgentsPageChatFound {
	type: 'chatFound';
	query: string;
	hits: { project: string; kind: 'claude' | 'codex'; session: string; title: string; modified: number; snippet: string }[];
	more: boolean;
	cut: boolean;
}

export type AgentsPageMessage = AgentsPageData | AgentsPageTail | AgentsPageReplyFailed | AgentsPageChatIndex | AgentsPageChatOpened | AgentsPageChatEvents | AgentsPageChatFailed | AgentsPageChatFound;
