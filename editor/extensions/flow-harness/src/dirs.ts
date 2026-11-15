/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: where the agents keep their own files. Claude Code reads CLAUDE_CONFIG_DIR in
 *  place of ~/.claude (as flow-agent does), and Codex CODEX_HOME in place of ~/.codex, so the
 *  map and the usage counts look where the agents themselves write.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Claude Code's configuration folder: settings, CLAUDE.md, skills, agents, and the transcripts under projects/. */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Codex's home folder: config.toml, AGENTS.md, memories. */
export const codexDir = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/** Where Claude Code keeps this folder's transcripts: the path with every character that is not a letter or digit turned into '-'. */
export const projectTranscriptDir = (root: string) => path.join(claudeDir(), 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));

/**
 * Whether a folder of Claude Code's projects/ holds sessions of this project: its own, or those of the agent worktrees
 * inside it (.claude/worktrees/<name> and Insilode's .insilode/worktrees/<name>, each a project folder of its own to Claude).
 */
export function isProjectTranscriptDir(name: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
	// Windows paths ignore case, and the drive letter comes either way (VS Code says c:, Claude Code's folder C--).
	const fold = (s: string) => platform === 'win32' ? s.toLowerCase() : s;
	const key = fold(root.replace(/[^A-Za-z0-9]/g, '-'));
	const n = fold(name);
	return n === key || n.startsWith(`${key}--claude-worktrees-`) || n.startsWith(`${key}--insilode-worktrees-`) || n.startsWith(`${key}--axle-worktrees-`);
}

/** The transcripts of this project and of its agent worktrees. */
export async function projectTranscripts(root: string): Promise<string[]> {
	const base = path.join(claudeDir(), 'projects');
	const dirs = (await fs.readdir(base).catch(() => [] as string[])).filter(n => isProjectTranscriptDir(n, root));
	const lists = await Promise.all(dirs.map(async d => (await fs.readdir(path.join(base, d)).catch(() => [] as string[])).filter(n => n.endsWith('.jsonl')).map(n => path.join(base, d, n))));
	return lists.flat();
}
