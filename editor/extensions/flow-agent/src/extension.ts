/*---------------------------------------------------------------------------------------------
 *  Insilode: Claude Code and Codex. Terminal-first: each agent is its real CLI in a terminal and the
 *  Agents dock shows their status. The chat-panel session types stay available behind a setting.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AgentHost, type AgentKind } from './acp';
import { agentLook } from './agentLook';
import { Agents } from './agents';
import { AskRouter } from './ask';
import { DesktopStatus } from './desktop';
import { AgentsDock } from './dock';
import { watchGazeSetting } from './gazeHost';
import { registerPlaceholderModels } from './models';
import { AttentionNotifier } from './notify';
import { pickAgent } from './pick';
import { PrEvents } from './prEvents';
import { startOrResume } from './resume';
import { swapAgent } from './swap';
import { AgentSessionType } from './sessionType';
import { WorktreeRows } from './worktreeActions';
import { cleanupWorktrees, runWorktreeSetup } from './worktreeCleanup';

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Insilode Agents', { log: true });
	context.subscriptions.push(log, registerPlaceholderModels());
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

	const agents = new Agents(context, log);
	agents.start().catch(e => log.error(`Agents: start failed: ${(e as Error).message}`));
	const worktrees = new WorktreeRows(agents);
	const dock = new AgentsDock(agents, worktrees);
	const router = new AskRouter(context, agents);
	context.subscriptions.push(
		agents,
		router,
		worktrees,
		dock,
		new AttentionNotifier(agents),
		new PrEvents(agents),
		new DesktopStatus(agents, log),
		vscode.window.registerWebviewViewProvider('flow.agents', dock, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('flow.agents.newClaude', () => agents.spawn('claude')),
		vscode.commands.registerCommand('flow.agents.newCodex', () => agents.spawn('codex')),
		vscode.commands.registerCommand('flow.agents.new', () => pickAgent(agents)),
		vscode.commands.registerCommand('flow.agents.newClaudeWorktree', () => agents.spawn('claude', undefined, undefined, 'worktree')),
		vscode.commands.registerCommand('flow.agents.newCodexWorktree', () => agents.spawn('codex', undefined, undefined, 'worktree')),
		vscode.commands.registerCommand('flow.agents.resume', () => startOrResume(agents, 'claude', false)),
		// The dock's ⇄ on an agent row: the same conversation, continued in the other CLI (swap.ts).
		vscode.commands.registerCommand('flow.agents.swap', (id: unknown) => swapAgent(agents, id)),
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
		// Called by core when the user clicks an agent in the desktop status overlay (desktop.ts): only a live agent this
		// window knows is shown, so a stale or made-up id does nothing (and never resumes an ended session).
		vscode.commands.registerCommand('flow.agents.reveal', (id: unknown) => {
			const s = typeof id === 'string' ? agents.sessions.get(id) : undefined;
			if (s && s.state !== 'ended') {
				agents.show(s.id);
			}
		}),
		vscode.commands.registerCommand('flow.agents.chooseAskTarget', () => router.choose()),
		vscode.commands.registerCommand('flow.agents.keptWorktrees', () => worktrees.showKept()),
		vscode.commands.registerCommand('flow.agents.cleanupWorktrees', () => cleanupWorktrees(agents)),
		vscode.commands.registerCommand('flow.agents.runWorktreeSetup', () => runWorktreeSetup(agents)),
		// Called by the harness map's context X-ray (Compact, Measure): it names a session by id and a kind, never text, and
		// the session's own state decides (Agents.slash), so an Enter never lands on a permission prompt. `check` types nothing.
		vscode.commands.registerCommand('flow.agents.slash', (id: unknown, kind: unknown, check: unknown) => typeof id === 'string' && (kind === 'compact' || kind === 'context')
			? agents.slash(id, kind, check === true)
			: 'unknown'),
	);
	// The dock is where Insilode's agents live: on the first start, show it rather than the chat panel (which needs ACP to reach them).
	if (!showChat() && !context.globalState.get<boolean>('flow.agents.dockShown')) {
		void context.globalState.update('flow.agents.dockShown', true);
		void vscode.commands.executeCommand('workbench.view.extension.flowAgents');
	}
	log.info('Insilode agents registered');
}

export function deactivate() { }
