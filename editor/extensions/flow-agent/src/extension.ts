/*---------------------------------------------------------------------------------------------
 *  Insilode: Claude Code and Codex. Terminal-first: each agent is its real CLI in a terminal and the
 *  Agents dock shows their status. The chat-panel session types stay available behind a setting.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AgentHost, type AgentKind } from './acp';
import { agentLook } from './agentLook';
import { installAgentExtensions } from './agentExtensions';
import { Agents } from './agents';
import { AgentsPanel, OPEN_AGENTS_PAGE } from './agentsPanel';
import { forgetTrustedFolders } from './folderTrust';
import { LayoutStore } from './layoutStore';
import { AskRouter } from './ask';
import { DesktopStatus } from './desktop';
import { AgentsDock } from './dock';
import { watchGazeSetting } from './gazeHost';
import { registerPlaceholderModels } from './models';
import { attentionKind, nextWaiting, waitingForYou } from './attention';
import { AttentionNotifier } from './notify';
import { renameFromPalette, removeFromPalette, swapFromPalette } from './paletteActions';
import { Peers } from './peers';
import { pickAgent } from './pick';
import { PrEvents } from './prEvents';
import { runningElsewhere } from './liveSessions';
import { ProjectIndex } from './projectIndex';
import { startOrResume } from './resume';
import { toggleBypass } from './bypass';
import { sweepLeftoverCopies } from './swap';
import { TermHost } from './termHost';
import { settingMoves } from './legacySettings';
import { AgentSessionType } from './sessionType';
import { WorktreeRows } from './worktreeActions';
import { cleanupWorktrees, runWorktreeSetup } from './worktreeCleanup';

/** Moves the two settings that were named `flowAgent.*` to their `flow.agents.*` names, in the user's settings (see legacySettings.ts). */
async function migrateSettings(log: vscode.LogOutputChannel) {
	const config = vscode.workspace.getConfiguration();
	for (const m of settingMoves(key => config.inspect(key))) {
		try {
			await config.update(m.to, m.value, vscode.ConfigurationTarget.Global);
			await config.update(m.from, undefined, vscode.ConfigurationTarget.Global);
			log.info(`Moved the setting ${m.from} to ${m.to}.`);
		} catch (e) {
			log.warn(`Could not move the setting ${m.from} to ${m.to}: ${(e as Error).message}`);
		}
	}
}

/** The agents the "next agent that needs you" key showed in this round, so each press moves on to one not seen yet. */
const shownWaiting = new Set<string>();

export async function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Insilode Agents', { log: true });
	context.subscriptions.push(log, registerPlaceholderModels());
	// Before anything reads a setting (the Agents page's location, the bypass toggle). Never throws: a failed move is only logged.
	await migrateSettings(log).catch(e => log.warn(`Could not move the renamed settings: ${(e as Error).message}`));
	// Claude Code's and Codex's own extensions, from Open VSX on the first start (agentExtensions.ts); after the window is
	// up, so the start is not slower for it.
	const installLater = setTimeout(() => void installAgentExtensions(context, log).catch(e => log.warn(`Agents: agent extensions: ${(e as Error).message}`)), 5000);
	context.subscriptions.push({ dispose: () => clearTimeout(installLater) });
	// A window that closed during a move to Codex left the transcript copy Codex was given (swap.ts); it goes now.
	sweepLeftoverCopies();
	// The chat session types are contributed only while flow.agents.showChat is on (their `when` in package.json), and VS Code
	// refuses a chat participant that is not contributed: registering them regardless logged two errors on every start.
	const showChat = () => vscode.workspace.getConfiguration('flow.agents').get<boolean>('showChat', false);
	if (showChat()) {
		for (const kind of ['claude', 'codex'] as AgentKind[]) {
			const host = new AgentHost(kind, context.extensionPath, log);
			context.subscriptions.push(host, new AgentSessionType(kind, host, log));
		}
	}
	const chatAtStart = showChat();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('flow.agents.showChat') && showChat() !== chatAtStart) {
			void vscode.window.showInformationMessage('Reload the window to apply the chat panel setting.', 'Reload Window')
				.then(pick => pick && vscode.commands.executeCommand('workbench.action.reloadWindow'));
		}
	}));

	// The gaze: turning flow.agents.gaze off stops it at once and clears what the canvas kept.
	context.subscriptions.push(watchGazeSetting());

	const agents = new Agents(context, log, ids => runningElsewhere(ids));
	agents.start().catch(e => log.error(`Agents: start failed: ${(e as Error).message}`));
	const worktrees = new WorktreeRows(agents);
	const peers = new Peers(agents, worktrees);
	const dock = new AgentsDock(agents, worktrees, peers);
	// The Agents page's sidebar of earlier sessions, its terminals and its pane layouts (none of it is VS Code's chat).
	const projects = new ProjectIndex(() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, () => [...agents.sessions.values()].filter(s => s.state !== 'ended').flatMap(s => [s.id, s.agentId ?? '', path.basename(s.transcript ?? '', '.jsonl'), ...agents.aliasesOf(s.id)]),
		() => peers.view().peers.flatMap(p => p.rows.flatMap(r => [r.id, r.agentId ?? '', ...(r.aliases ?? [])])));
	// A session another program runs must not be resumed here too: asked of the machine at the moment of the click, not of the page's last list.
	const term = new TermHost(agents, context, async id => (await runningElsewhere([id]))?.source);
	const page = new AgentsPanel(agents, worktrees, peers, projects, term, new LayoutStore(context.workspaceState, context.globalState));
	const router = new AskRouter(context, agents);
	context.subscriptions.push(
		agents,
		router,
		worktrees,
		peers,
		dock,
		term,
		page,
		vscode.commands.registerCommand(OPEN_AGENTS_PAGE, () => page.open()),
		vscode.commands.registerCommand('flow.agents.forgetTrustedFolders', () => forgetTrustedFolders(context)),
		new AttentionNotifier(agents),
		new PrEvents(agents, context.globalState),
		new DesktopStatus(agents, log),
		vscode.window.registerWebviewViewProvider('flow.agents', dock, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('flow.agents.newClaude', () => agents.spawn('claude')),
		vscode.commands.registerCommand('flow.agents.newCodex', () => agents.spawn('codex')),
		vscode.commands.registerCommand('flow.agents.new', () => pickAgent(agents)),
		vscode.commands.registerCommand('flow.agents.newClaudeWorktree', () => agents.spawn('claude', undefined, undefined, 'worktree')),
		vscode.commands.registerCommand('flow.agents.newCodexWorktree', () => agents.spawn('codex', undefined, undefined, 'worktree')),
		vscode.commands.registerCommand('flow.agents.resume', () => startOrResume(agents, 'claude', false)),
		vscode.commands.registerCommand('flow.agents.claudeBypass', () => toggleBypass()),
		// The dock's ⇄ on an agent row: the same conversation, continued in the other CLI (swap.ts).
		vscode.commands.registerCommand('flow.agents.swap', (id?: unknown) => swapFromPalette(agents, id)),
		vscode.commands.registerCommand('flow.agents.rename', (id?: unknown) => renameFromPalette(agents, id)),
		vscode.commands.registerCommand('flow.agents.remove', (id?: unknown) => removeFromPalette(agents, worktrees, id)),
		vscode.commands.registerCommand('flow.agents.start', (cli: unknown) => cli === 'claude' || cli === 'codex' ? startOrResume(agents, cli) : undefined),
		// Called by flow-view (Home, "Ask about this flow") and any other extension with text for "the agent": the user's
		// chosen agent gets it (ask.ts). `origin` names the feature for the picker; `files` are referred to as each target reads them;
		// `options.plan` asks it to plan first, in the form that target understands.
		vscode.commands.registerCommand('flow.agents.ask', (text: unknown, submit: unknown, origin: unknown, files: unknown, options: unknown) => typeof text === 'string'
			? router.ask(text, submit === true, typeof origin === 'string' ? origin : undefined, Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : [], (options as { plan?: unknown } | undefined)?.plan === true, typeof (options as { session?: unknown } | undefined)?.session === 'string' ? (options as { session: string }).session : undefined)
			: false),
		// Called by flow-view when an agent asks check_skeleton: on or off for that agent; nothing for a session this window does not know.
		vscode.commands.registerCommand('flow.agents.skeletonOn', (id: unknown) => typeof id === 'string' && agents.sessions.has(id) ? agents.skeletonOn(id) : undefined),
		// Called by flow-view when an agent's tour arrives with the session it came from (INSILODE_SESSION): the name and colour the ghost
		// cursor takes. Only a session this window knows; nothing for any other id.
		vscode.commands.registerCommand('flow.agent.describe', (id: unknown) => {
			const s = typeof id === 'string' ? agents.sessions.get(id) : undefined;
			return s && s.state !== 'ended' ? agentLook(s) : undefined;
		}),
		// Called by flow-view for the diff "since this session started": with a session id, the folder it works in and that folder's HEAD
		// when it began; with none, every session whose start is known (id and name), for the picker. Nothing for a session this window does not know.
		vscode.commands.registerCommand('flow.agent.sessionChanges', (id: unknown) => {
			if (id === undefined) {
				return [...agents.sessions.values()].filter(s => s.start).map(s => ({ id: s.id, name: s.name }));
			}
			return typeof id === 'string' ? agents.sessions.get(id)?.start : undefined;
		}),
		// Called by core when the user clicks an agent in the desktop status overlay (desktop.ts): only a live agent this
		// window knows is shown, so a stale or made-up id does nothing (and never resumes an ended session).
		vscode.commands.registerCommand('flow.agents.reveal', (id: unknown) => {
			const s = typeof id === 'string' ? agents.sessions.get(id) : undefined;
			if (s && s.state !== 'ended') {
				agents.show(s.id);
			}
		}),
		// Called by flow-view's Home: this window's agents that wait for the user (an approval, a question, an error), the one that needs
		// them first. Only what Home draws: a name, the CLI and why it waits; never a transcript or a path.
		vscode.commands.registerCommand('flow.agents.needsYou', () => waitingForYou([...agents.sessions.values()]).map(s => ({ id: s.id, name: s.name, cli: s.cli, kind: attentionKind(s) }))),
		// "Next agent that needs you": one key from anywhere takes you to the agent that waits, then to the one after it.
		vscode.commands.registerCommand('flow.agents.nextNeedsYou', () => {
			const next = nextWaiting([...agents.sessions.values()], shownWaiting);
			if (!next) {
				return void vscode.window.setStatusBarMessage('Insilode: no agent is waiting for you.', 3000);
			}
			if (shownWaiting.has(next.id)) {
				shownWaiting.clear();
			}
			shownWaiting.add(next.id);
			agents.show(next.id);
		}),
		vscode.commands.registerCommand('flow.agents.chooseAskTarget', () => router.choose()),
		vscode.commands.registerCommand('flow.agents.keptWorktrees', () => worktrees.showKept()),
		vscode.commands.registerCommand('flow.agents.cleanupWorktrees', () => cleanupWorktrees(agents)),
		vscode.commands.registerCommand('flow.agents.runWorktreeSetup', () => runWorktreeSetup(agents)),
	);
	// The dock is where Insilode's agents live: on the first start, show it rather than the chat panel (which needs ACP to reach them).
	if (!showChat() && !context.globalState.get<boolean>('flow.agents.dockShown')) {
		void context.globalState.update('flow.agents.dockShown', true);
		void vscode.commands.executeCommand('workbench.view.extension.flowAgents');
	}
	log.info('Insilode agents registered');
}

export function deactivate() { }
