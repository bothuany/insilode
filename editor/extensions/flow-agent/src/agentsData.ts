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

export type AgentsPageMessage = AgentsPageData | AgentsPageTail | AgentsPageReplyFailed;
