/*---------------------------------------------------------------------------------------------
 *  Insilode: the life of agent worktrees around the agent: the repository's setup file
 *  (.insilode/worktree.json: files to copy, commands to run after checkout and before removal) and
 *  cleaning up worktrees whose branch was merged or whose remote is gone.
 *
 *  Stub of the shared contract (docs/design/xirp-plan.md, part B): the commands are registered and do nothing yet.
 *--------------------------------------------------------------------------------------------*/

import type { Agents } from './agents';

/** Flow.agents.cleanupWorktrees: offers the worktrees that look done, checks every guard again, removes the chosen ones. */
export async function cleanupWorktrees(_agents: Agents): Promise<void> { }

/** Flow.agents.runWorktreeSetup: runs the setup file again in the worktree of the active agent (or one picked). */
export async function runWorktreeSetup(_agents: Agents): Promise<void> { }
