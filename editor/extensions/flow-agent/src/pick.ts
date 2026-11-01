/*---------------------------------------------------------------------------------------------
 *  Insilode: choosing which agent to start. Claude Code and Codex, any agent CLI found on PATH, and
 *  commands you saved yourself; a custom agent is just a command run in its own terminal.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Agents, CustomAgent } from './agents';
import { startOrResume } from './resume';

/** Agent CLIs worth offering when they are installed. */
const KNOWN: CustomAgent[] = [
	{ name: 'Gemini', command: 'gemini' },
	{ name: 'OpenCode', command: 'opencode' },
	{ name: 'Aider', command: 'aider' },
	{ name: 'Cursor Agent', command: 'cursor-agent' },
	{ name: 'Amp', command: 'amp' },
	{ name: 'Goose', command: 'goose' },
	{ name: 'Qwen Code', command: 'qwen' },
	{ name: 'Crush', command: 'crush' },
	{ name: 'Copilot CLI', command: 'copilot' },
];

/** Names a command can have on disk: on Windows `aider` is `aider.exe`, `aider.cmd` and so on (PATHEXT). */
function candidates(bin: string) {
	if (process.platform !== 'win32') {
		return [bin];
	}
	return [bin, ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map(ext => bin + ext.toLowerCase())];
}

async function onPath(bin: string) {
	for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
		for (const name of candidates(bin)) {
			try {
				await fs.access(path.join(dir, name), fs.constants.X_OK);
				return true;
			} catch {
				// not here
			}
		}
	}
	return false;
}

export function savedAgents(): CustomAgent[] {
	return vscode.workspace.getConfiguration('flow.agents').get<CustomAgent[]>('custom', []).filter(a => a?.name && a?.command);
}

type Item = vscode.QuickPickItem & { run?: () => unknown };

/** The part of an agent session the palette's quick pick shows. */
export interface AgentChoice {
	id: string;
	name: string;
	cli: string;
	state: string;
	worktree?: { branch: string };
}

export type AgentAction = 'rename' | 'swap' | 'remove';
export type AgentPickItem = vscode.QuickPickItem & { id: string };

const CLI_NAME: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', custom: 'Your command' };
/** The dock's words for a state (dockPage.ts LABEL), so the pick and the row say the same thing. */
const STATE_WORD: Record<string, string> = { working: 'Working', blocked: 'Needs you', done: 'Done', idle: 'Ready', starting: 'Starting', unknown: 'Running', ended: 'Closed' };

/**
 * The rows of the quick pick that rename, swap or remove an agent from the palette: name, which CLI and what it is doing, in the
 * order given (the dock's: the one that needs you first). Moving a conversation to the other CLI only exists between Claude and
 * Codex, so a custom command is not offered for it.
 */
export function agentPickItems(list: readonly AgentChoice[], action: AgentAction): AgentPickItem[] {
	return list
		.filter(s => action !== 'swap' || s.cli === 'claude' || s.cli === 'codex')
		.map(s => ({
			id: s.id,
			label: s.name,
			description: CLI_NAME[s.cli] ?? s.cli,
			detail: (STATE_WORD[s.state] ?? s.state) + (s.worktree ? ` · worktree ${s.worktree.branch}` : ''),
		}));
}

export async function pickAgent(agents: Agents) {
	const saved = savedAgents();
	const found = (await Promise.all(KNOWN.filter(k => !saved.some(s => s.command.split(/\s+/)[0] === k.command)).map(async k => (await onPath(k.command) ? k : undefined)))).filter((k): k is CustomAgent => !!k);
	const items: Item[] = [
		{ label: '$(sparkle) Claude Code', detail: 'Status, permissions, diffs and context show up in Insilode', run: () => agents.spawn('claude') },
		{ label: '$(history) Resume a Claude Session…', detail: 'Continue an earlier conversation of this folder (claude --resume)', run: () => startOrResume(agents, 'claude', false) },
		{ label: '$(history) Resume a Codex Session…', detail: 'Continue an earlier conversation of this folder (codex resume)', run: () => startOrResume(agents, 'codex', false) },
		{ label: '$(hubot) Codex', detail: 'Status and edits through read-only hooks (trust them once with /hooks)', run: () => agents.spawn('codex') },
		{ label: 'In a worktree', kind: vscode.QuickPickItemKind.Separator },
		{ label: '$(git-branch) Claude Code in a Worktree', detail: 'A checkout and branch of its own (.insilode/worktrees): agents working in parallel never write over each other', run: () => agents.spawn('claude', undefined, undefined, 'worktree') },
		{ label: '$(git-branch) Codex in a Worktree', detail: 'A checkout and branch of its own (.insilode/worktrees)', run: () => agents.spawn('codex', undefined, undefined, 'worktree') },
	];
	if (saved.length) {
		items.push({ label: 'Your agents', kind: vscode.QuickPickItemKind.Separator });
		items.push(...saved.map(a => ({ label: `$(terminal) ${a.name}`, description: a.command, run: () => agents.spawn('custom', undefined, a) })));
	}
	if (found.length) {
		items.push({ label: 'Installed', kind: vscode.QuickPickItemKind.Separator });
		items.push(...found.map(a => ({ label: `$(terminal) ${a.name}`, description: a.command, run: () => agents.spawn('custom', undefined, a) })));
	}
	items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
	items.push({ label: '$(add) Add a custom agent…', detail: 'Any command that runs an agent in a terminal', run: () => addAgent(agents) });
	const pick = await vscode.window.showQuickPick(items, { title: 'Start an agent', placeHolder: 'Each agent runs in its own terminal', ignoreFocusOut: true });
	await pick?.run?.();
}

async function addAgent(agents: Agents) {
	const command = await vscode.window.showInputBox({ title: 'Add a custom agent (1/2): command', placeHolder: 'gemini --yolo, aider --model sonnet, ./scripts/my-agent.sh', prompt: 'Runs in a new terminal in this folder' });
	if (!command?.trim()) {
		return;
	}
	const guess = command.trim().split(/\s+/)[0].split('/').pop() ?? 'Agent';
	const name = await vscode.window.showInputBox({ title: 'Add a custom agent (2/2): name', value: guess.charAt(0).toUpperCase() + guess.slice(1), prompt: 'How it appears in the Agents list' });
	if (!name?.trim()) {
		return;
	}
	const agent = { name: name.trim(), command: command.trim() };
	await vscode.workspace.getConfiguration('flow.agents').update('custom', [...savedAgents().filter(a => a.name !== agent.name), agent], vscode.ConfigurationTarget.Global);
	await agents.spawn('custom', undefined, agent);
}
