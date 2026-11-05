/*---------------------------------------------------------------------------------------------
 *  Insilode: the rows of the Agents dock and of the Agents page, built by one function so the two views never drift
 *  apart. Which agent needs you comes first (attention.ts), then what each row shows beside the session's own record.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { Agents } from './agents';
import type { AgentRow } from './agentsData';
import { attentionKind, rank } from './attention';
import { canType, type CustomCli } from './askTarget';
import { conflictText } from './conflicts';
import type { WorktreeRows } from './worktreeActions';

export type Stages = Map<string, { stage: string; skipped: boolean } | undefined>;

/**
 * Where an agent is in skeleton first, asked of flow-view (which owns the stage). Nothing when flow-view is not running, does not
 * know the session or answers anything but a stage: the row then shows no indicator.
 */
async function stageOf(id: string): Promise<{ stage: string; skipped: boolean } | undefined> {
	try {
		const r = await Promise.resolve(vscode.commands.executeCommand<{ stage?: unknown; skipped?: unknown } | undefined>('flow.skeleton.stage', id));
		return r && typeof r.stage === 'string' ? { stage: r.stage, skipped: r.skipped === true } : undefined;
	} catch {
		return undefined;
	}
}

/** One question per agent that can be in skeleton first, asked together so a repaint waits for the slowest once. */
export async function skeletonStages(agents: Agents): Promise<Stages> {
	return new Map(await Promise.all([...agents.sessions.values()].filter(s => s.state !== 'ended' && s.cli !== 'custom').map(async s => [s.id, await stageOf(s.id)] as const)));
}

/** The rows, the one that needs you first. `stages` comes from skeletonStages; `customs` decides which custom agents take typed text. */
export function buildRows(agents: Agents, worktrees: WorktreeRows | undefined, stages: Stages, customs: CustomCli[]): AgentRow[] {
	const conflicts = agents.conflicts();
	const asking = new Map(agents.askSessions().map(s => [s.id, s]));
	return rank([...agents.sessions.values()])
		// The transcript path and the process id stay with the host: neither view draws them.
		.map((s): AgentRow => ({ ...s, transcript: undefined, pid: undefined, attention: attentionKind(s), done: s.todos.filter(t => t.status === 'completed').length, current: s.todos.find(t => t.status === 'in_progress')?.text, explain: agents.canExplain(s), impact: s.impact && { files: s.impact.files, more: s.impact.more, flows: s.impact.flows.map(f => ({ label: f.label, via: f.via })), tables: s.impact.tables },
			// Worktree and conflicts are explicit fields: the session's own record (paths, the base branch) stays here.
			worktree: s.worktree ? worktrees?.view(s) : undefined,
			skeletonOn: agents.skeletonOn(s.id), skeletonAvailable: s.state !== 'ended' && s.cli !== 'custom', skeletonStage: stages.get(s.id),
			clash: s.state === 'ended' ? undefined : conflicts.get(s.id)?.map(c => ({ text: conflictText(c), same: c.sameCheckout, files: c.files.slice(0, 12) })),
			// The same rule typeInto applies at the moment of typing.
			acceptsInput: (() => { const a = asking.get(s.id); return !!a && canType(a, customs); })() }));
}
