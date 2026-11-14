/*---------------------------------------------------------------------------------------------
 *  Insilode: binds one ACP agent (Claude / Codex) to a native chat session type.
 *  Sessions, history and settings come from the agent itself (session/list, session/load,
 *  configOptions), so whatever the user does in the CLI shows up here and vice versa.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type {
	ClientSideConnection,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionConfigOption,
	SessionNotification,
} from '@agentclientprotocol/sdk';
import { AgentHost, explain, type AgentKind } from './acp';
import { autoAnswer, currentValue, diffsOf, permissionDecision, selectItems } from './chatCore';
import { agentCwd } from './env';
import { gazeAcp, gazeTurn } from './gazeHost';

type Update = SessionNotification['update'];

const LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };

/** Holds the chat's external-edit snapshot open while an agent tool writes files directly to disk. */
class EditTracker {
	private readonly open = new Map<string, () => void>();

	async track(id: string, files: string[], stream: vscode.ChatResponseStream): Promise<void> {
		if (this.open.has(id) || !files.length) {
			return;
		}
		let release!: () => void;
		const gate = new Promise<void>(r => release = r);
		this.open.set(id, release);
		const started = new Promise<void>(r => {
			stream.externalEdit(files.map(f => vscode.Uri.file(f)), async () => {
				r();
				await gate;
			});
		});
		// Never let a missing callback stall the agent.
		await Promise.race([started, new Promise(r => setTimeout(r, 2000))]);
	}

	complete(id: string) {
		this.open.get(id)?.();
		this.open.delete(id);
	}

	completeAll() {
		for (const id of [...this.open.keys()]) {
			this.complete(id);
		}
	}
}

const SKILL_GROUP = 'flow.skill';
/** Slash aliases for the permission modes the adapters report. */
const MODE_LOOK: Record<string, { icon: string; color: string }> = {
	default: { icon: 'shield', color: 'flowMode.manual' },
	acceptEdits: { icon: 'check-all', color: 'flowMode.accept' },
	plan: { icon: 'checklist', color: 'flowMode.plan' },
	auto: { icon: 'sparkle', color: 'flowMode.auto' },
	bypassPermissions: { icon: 'warning', color: 'flowMode.bypass' },
	dontAsk: { icon: 'circle-slash', color: 'flowMode.bypass' },
};
const MODE_SLASH: Record<string, string> = { default: 'manual', acceptEdits: 'accept', plan: 'plan', auto: 'auto', bypassPermissions: 'bypass', dontAsk: 'dontask' };

export class AgentSessionType implements vscode.Disposable {
	private readonly type: string;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly ctrl: vscode.ChatSessionItemController;
	/** ACP sessions that exist in the current adapter process (created or loaded). */
	private readonly live = new Set<string>();
	private readonly configs = new Map<string, SessionConfigOption[]>();
	/**
	 * The permission mode the user picked (bypassPermissions, acceptEdits, …). The agent itself always runs
	 * in `default` (or `plan`) so every write asks first; Insilode answers automatically per this mode, but only
	 * after snapshotting the files, which is what makes Keep/Undo work for every edit.
	 */
	private readonly approval = new Map<string, string>();
	private harnessMode: string | undefined;
	/** Slash commands the agent offers (skills, custom commands, built-ins), from `available_commands_update`. */
	private commands: { name: string; description: string }[] = [];
	private readonly states = new Set<vscode.ChatSessionInputState>();
	/** A fresh session created only to learn the config options; handed to the next new chat. */
	private spare: { id: string; config: SessionConfigOption[] } | undefined;
	/** The spare being created right now, so concurrent pickers share it instead of each making one. */
	private sparePending: Promise<{ id: string; config: SessionConfigOption[] }> | undefined;

	constructor(private readonly kind: AgentKind, private readonly host: AgentHost, private readonly log: vscode.LogOutputChannel) {
		this.type = `flow-${kind}`;
		this.ctrl = vscode.chat.createChatSessionItemController(this.type, () => this.refresh());
		this.ctrl.newChatSessionItemHandler = ctx => this.newSession(ctx);
		this.ctrl.getChatSessionInputState = resource => this.inputState(resource);

		this.disposables.push(vscode.commands.registerCommand(`flow-agent.pickSkill.${kind}`, () => this.pickSkill()));
		// A new adapter process knows none of the sessions the old one had: forget them so they are loaded again.
		this.disposables.push(this.host.onDidExit(() => {
			this.live.clear();
			this.configs.clear();
			this.spare = undefined;
			this.sparePending = undefined;
		}));
		this.disposables.push(this.host.onAnyUpdate(n => {
			const u = n.update as { sessionUpdate: string; availableCommands?: { name: string; description: string }[] };
			if (u.sessionUpdate === 'available_commands_update' && u.availableCommands) {
				this.commands = u.availableCommands.map(c => ({ name: c.name, description: c.description }));
				// Open pickers learn about the agent's skills without waiting for the next session.
				for (const st of this.states) {
					st.groups = [...st.groups.filter(g => g.id !== SKILL_GROUP), ...this.skillGroup()];
				}
			}
		}));
		const participant = vscode.chat.createChatParticipant(this.type, (req, ctx, stream, token) => this.handle(req, ctx, stream, token));
		participant.iconPath = new vscode.ThemeIcon(kind === 'claude' ? 'sparkle' : 'terminal');

		this.disposables.push(
			this.ctrl,
			participant,
			vscode.chat.registerChatSessionContentProvider(this.type, {
				provideChatSessionContent: resource => this.content(resource),
			}, participant),
		);
	}

	private get cwd(): string {
		// The same spelling a terminal agent gets (agentCwd), so chat sessions and terminal agents share one entry in .claude.json.
		return agentCwd(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath) ?? process.cwd();
	}

	private uri(sessionId: string) {
		return vscode.Uri.from({ scheme: this.type, path: `/${sessionId}` });
	}

	private sessionIdOf(resource: vscode.Uri): string | undefined {
		const id = resource.path.replace(/^\//, '');
		return id.startsWith('untitled-') ? undefined : id;
	}

	// ---- sessions list -------------------------------------------------------------------------

	private async refresh() {
		try {
			const conn = await this.host.connection();
			// The list comes in pages: follow them (bounded) so older sessions are not silently missing.
			const sessions: Awaited<ReturnType<ClientSideConnection['listSessions']>>['sessions'] = [];
			let cursor: string | undefined;
			for (let page = 0; page < 20; page++) {
				const res = await conn.listSessions({ cwd: this.cwd, cursor });
				sessions.push(...res.sessions);
				cursor = res.nextCursor ?? undefined;
				if (!cursor) {
					break;
				}
			}
			this.ctrl.items.replace(sessions.map(s => {
				const item = this.ctrl.createChatSessionItem(this.uri(s.sessionId), s.title || LABEL[this.kind]);
				const updated = s.updatedAt ? Date.parse(s.updatedAt) : undefined;
				if (updated) {
					item.timing = { created: updated, lastRequestEnded: updated };
				}
				item.status = vscode.ChatSessionStatus.Completed;
				return item;
			}));
		} catch (e) {
			this.log.warn(`[${this.kind}] list failed: ${explain(this.kind, e)}`);
		}
	}

	private async newSession(ctx: vscode.ChatSessionItemControllerNewItemHandlerContext) {
		const conn = await this.host.connection();
		let id: string;
		if (this.spare) {
			id = this.spare.id;
			this.configs.set(id, this.spare.config);
			this.spare = undefined;
		} else {
			const s = await conn.newSession({ cwd: this.cwd, mcpServers: [] }).catch(e => {
				throw new Error(explain(this.kind, e));
			});
			id = s.sessionId;
			this.configs.set(id, (s.configOptions ?? []) as SessionConfigOption[]);
		}
		this.live.add(id);
		await this.applyInput(conn, id, ctx.inputState);
		const item = this.ctrl.createChatSessionItem(this.uri(id), ctx.request.prompt.slice(0, 60) || LABEL[this.kind]);
		item.timing = { created: Date.now() };
		this.ctrl.items.add(item);
		return item;
	}

	// ---- pickers (model, mode, effort, …) --------------------------------------------------------

	private async configFor(sessionId: string | undefined): Promise<SessionConfigOption[]> {
		if (sessionId && this.configs.has(sessionId)) {
			return this.configs.get(sessionId)!;
		}
		if (this.spare) {
			return this.spare.config;
		}
		this.sparePending ??= this.createSpare().finally(() => this.sparePending = undefined);
		return (await this.sparePending).config;
	}

	private async createSpare() {
		const conn = await this.host.connection();
		const s = await conn.newSession({ cwd: this.cwd, mcpServers: [] });
		const spare = { id: s.sessionId, config: (s.configOptions ?? []) as SessionConfigOption[] };
		this.spare = spare;
		return spare;
	}

	private async inputState(resource: vscode.Uri | undefined) {
		let config: SessionConfigOption[] = [];
		try {
			config = await this.configFor(resource && this.sessionIdOf(resource));
			this.harnessMode ??= currentValue(config.find(o => o.id === 'mode') ?? ({} as SessionConfigOption));
		} catch (e) {
			this.log.warn(`[${this.kind}] config unavailable: ${explain(this.kind, e)}`);
		}
		const groups: vscode.ChatSessionProviderOptionGroup[] = config
			.filter(o => (o as { type?: string }).type === 'select' && o.id !== 'agent')
			.map(o => {
				const items = selectItems(o).map(i => ({ id: i.value, name: i.name, description: i.description }));
				const sid = resource && this.sessionIdOf(resource);
				const cur = o.id === 'mode' ? (sid && this.approval.get(sid)) || this.harnessMode || currentValue(o) : currentValue(o);
				// The harness can start in a mode the adapter does not list (e.g. bypassPermissions from
				// ~/.claude/settings.json); show it anyway, so the chip says what will really happen to edits.
				if (o.id === 'mode' && cur && !items.some(i => i.id === cur)) {
					items.push({ id: cur, name: cur.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()), description: 'From your Claude settings' });
				}
				// A plain chip next to model and effort: VS Code hides "permissions" pickers for agent sessions.
				// `/plan`, `/manual`, … switch the mode straight from the input, like the Claude Code CLI.
				// Each mode has its own small icon and colour, everywhere it is shown.
				const withSlash = o.id === 'mode'
					? items.map(i => ({ ...i, slashCommand: MODE_SLASH[i.id], icon: MODE_LOOK[i.id] && new vscode.ThemeIcon(MODE_LOOK[i.id].icon, new vscode.ThemeColor(MODE_LOOK[i.id].color)) }))
					: items;
				return {
					id: o.id,
					name: o.name,
					items: withSlash,
					selected: withSlash.find(i => i.id === cur),
				};
			});
		groups.push(...this.skillGroup());
		const state = this.ctrl.createChatSessionInputState(groups);
		this.states.add(state);
		// Picking a skill writes `/<skill> ` into the input and goes back to the label: it is a shortcut, not a setting.
		const skillSub = state.onDidChange(() => {
			const pick = state.groups.find(g => g.id === SKILL_GROUP)?.selected?.id;
			if (pick) {
				state.groups = [...state.groups.filter(g => g.id !== SKILL_GROUP), ...this.skillGroup()];
				void vscode.commands.executeCommand('workbench.action.chat.open', { query: `/${pick} `, isPartialQuery: true });
			}
		});
		state.onDidDispose(() => {
			skillSub.dispose();
			this.states.delete(state);
		});
		const id = resource && this.sessionIdOf(resource);
		if (id) {
			// Existing session: apply picker changes right away.
			const sub = state.onDidChange(async () => {
				try {
					await this.applyInput(await this.host.connection(), id, state);
				} catch (e) {
					vscode.window.showWarningMessage(explain(this.kind, e));
				}
			});
			state.onDidDispose(() => sub.dispose());
		}
		return state;
	}

	private async applyInput(conn: ClientSideConnection, sessionId: string, state: vscode.ChatSessionInputState | undefined) {
		const config = this.configs.get(sessionId) ?? [];
		this.harnessMode ??= currentValue(config.find(o => o.id === 'mode') ?? ({} as SessionConfigOption));
		for (const group of state?.groups ?? []) {
			const want = group.selected?.id;
			if (want && group.id === 'mode') {
				this.approval.set(sessionId, want);
			} else if (want) {
				await this.setOption(conn, sessionId, group.id, want);
			}
		}
		const userMode = this.approval.get(sessionId) ?? this.harnessMode;
		if (userMode) {
			this.approval.set(sessionId, userMode);
		}
		await this.setOption(conn, sessionId, 'mode', userMode === 'plan' ? 'plan' : 'default');
	}

	private async setOption(conn: ClientSideConnection, sessionId: string, configId: string, value: string) {
		const config = this.configs.get(sessionId) ?? [];
		const opt = config.find(o => o.id === configId);
		if (!opt || currentValue(opt) === value) {
			return;
		}
		const res = await conn.setSessionConfigOption({ sessionId, configId, value } as Parameters<ClientSideConnection['setSessionConfigOption']>[0]);
		this.configs.set(sessionId, ((res as { configOptions?: SessionConfigOption[] }).configOptions ?? config) as SessionConfigOption[]);
	}

	/** The Skills chip: every slash command the agent offers, so they can be found without remembering names. */
	private skillGroup(): vscode.ChatSessionProviderOptionGroup[] {
		if (!this.commands.length) {
			return [];
		}
		// Agents can offer well over a hundred: a short menu here, the full searchable list one click away.
		const label = { id: '', name: `Skills (${this.commands.length})`, description: 'Insert a skill or command into the prompt' };
		const repo = this.commands.filter(c => !c.description.startsWith('(') && !c.name.includes(':')).slice(0, 6);
		return [{
			id: SKILL_GROUP,
			name: 'Skills',
			items: [label, ...repo.map(c => ({ id: c.name, name: `/${c.name}`, description: c.description.length > 80 ? `${c.description.slice(0, 80)}…` : c.description, tooltip: c.description }))],
			selected: label,
			commands: [{ title: `Search all ${this.commands.length} skills and commands…`, command: `flow-agent.pickSkill.${this.kind}` }],
		}];
	}

	/** Searchable list of every slash command the agent offers; the pick goes into the prompt. */
	private async pickSkill() {
		const pick = await vscode.window.showQuickPick(
			this.commands.map(c => ({ label: `/${c.name}`, detail: c.description, name: c.name })),
			{ title: `${LABEL[this.kind]}: skills and commands`, placeHolder: 'Type to filter by name or description', matchOnDetail: true },
		);
		if (pick) {
			await vscode.commands.executeCommand('workbench.action.chat.open', { query: `/${pick.name} `, isPartialQuery: true });
		}
	}

	// ---- history -------------------------------------------------------------------------------

	private async content(resource: vscode.Uri): Promise<vscode.ChatSession> {
		const id = this.sessionIdOf(resource);
		if (!id) {
			return { history: [], requestHandler: undefined };
		}
		const history = await this.ensureLoaded(id, true);
		// The pickers (mode, model, effort, …) only show for a reopened session when it reports its values.
		const options: Record<string, string> = {};
		for (const o of this.configs.get(id) ?? []) {
			const cur = o.id === 'mode' ? this.approval.get(id) ?? this.harnessMode ?? currentValue(o) : currentValue(o);
			if ((o as { type?: string }).type === 'select' && o.id !== 'agent' && cur) {
				options[o.id] = cur;
			}
		}
		return { history, requestHandler: undefined, options };
	}

	private readonly loading = new Map<string, Promise<Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2>>>();

	/**
	 * Makes the session live in this adapter process; returns its replayed history as chat turns.
	 * Callers that arrive while it loads share that one load (one sink per session, one `loadSession`).
	 */
	private async ensureLoaded(id: string, wantHistory: boolean): Promise<Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2>> {
		if (this.live.has(id)) {
			// Already live in this process: we can't replay without reloading; show nothing rather than duplicating.
			return [];
		}
		let load = this.loading.get(id);
		if (!load) {
			load = this.replay(id).finally(() => this.loading.delete(id));
			this.loading.set(id, load);
		}
		const turns = await load;
		return wantHistory ? turns : [];
	}

	private async replay(id: string): Promise<Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2>> {
		const turns: Array<vscode.ChatRequestTurn | vscode.ChatResponseTurn2> = [];
		let prompt = '';
		let parts: Array<vscode.ChatResponseMarkdownPart | vscode.ChatToolInvocationPart> = [];
		let text = '';
		const flushText = () => {
			if (text) {
				parts.push(new vscode.ChatResponseMarkdownPart(text));
				text = '';
			}
		};
		const flushTurn = () => {
			flushText();
			if (prompt || parts.length) {
				turns.push(new vscode.ChatRequestTurn2(prompt, undefined, [], this.type, [], undefined, undefined, undefined, undefined));
				turns.push(new vscode.ChatResponseTurn2(parts as never, {}, this.type));
			}
			prompt = '';
			parts = [];
		};

		const conn = await this.host.connection();
		this.host.setSink(id, {
			onUpdate: ({ update: u }) => {
				switch (u.sessionUpdate) {
					case 'user_message_chunk':
						if (parts.length || text) {
							flushTurn();
						}
						if (u.content.type === 'text') {
							prompt += u.content.text;
						}
						break;
					case 'agent_message_chunk':
						if (u.content.type === 'text') {
							text += u.content.text;
						}
						break;
					case 'tool_call': {
						flushText();
						const p = new vscode.ChatToolInvocationPart(u.kind ?? 'tool', u.toolCallId);
						// Replayed steps already ran: confirmed and done, not "rejected".
						p.isComplete = true;
						p.isConfirmed = true;
						p.isError = u.status === 'failed';
						p.pastTenseMessage = u.title;
						parts.push(p);
						break;
					}
					case 'tool_call_update': {
						// The readable title ("Read Demo/Svc.cs") often arrives in an update, not the first call.
						const p = parts.find(x => x instanceof vscode.ChatToolInvocationPart && x.toolCallId === u.toolCallId) as vscode.ChatToolInvocationPart | undefined;
						if (p && u.title) {
							p.pastTenseMessage = u.title;
						}
						if (p && u.status === 'failed') {
							p.isError = true;
						}
						break;
					}
				}
			},
			onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
		});
		try {
			const res = await conn.loadSession({ sessionId: id, cwd: this.cwd, mcpServers: [] });
			this.configs.set(id, ((res as { configOptions?: SessionConfigOption[] }).configOptions ?? []) as SessionConfigOption[]);
			this.live.add(id);
		} finally {
			this.host.setSink(id, undefined);
		}
		flushTurn();
		return turns;
	}

	// ---- a turn --------------------------------------------------------------------------------

	private async handle(req: vscode.ChatRequest, ctx: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
		const resource = (req as { sessionResource?: vscode.Uri }).sessionResource ?? ctx.chatSessionContext?.chatSessionItem.resource;
		const id = resource && this.sessionIdOf(resource);
		if (!id) {
			stream.markdown(`No ${LABEL[this.kind]} session for this chat.`);
			return {};
		}

		let conn: ClientSideConnection;
		try {
			conn = await this.host.connection();
			await this.ensureLoaded(id, false);
			await this.applyInput(conn, id, ctx.chatSessionContext?.inputState);
		} catch (e) {
			stream.markdown(explain(this.kind, e));
			return { errorDetails: { message: explain(this.kind, e) } };
		}

		// A new trail for the gaze, before anything the agent looks at during this prompt.
		gazeTurn(id);
		// Insilode's timeline: every prompt is one step, so its edits can be shown and undone on their own.
		await Promise.resolve(vscode.commands.executeCommand('flow.agentTurn', req.prompt, LABEL[this.kind])).catch(() => undefined);
		const edits = new EditTracker();
		const tools = new Map<string, { part: vscode.ChatToolInvocationPart; kind?: string; files: string[] }>();
		const item = this.ctrl.items.get(this.uri(id));
		if (item) {
			item.status = vscode.ChatSessionStatus.InProgress;
			item.timing = { created: item.timing?.created ?? Date.now(), lastRequestStarted: Date.now() };
		}

		const onUpdate = (u: Update) => {
			switch (u.sessionUpdate) {
				case 'agent_message_chunk':
					if (u.content.type === 'text') {
						stream.markdown(u.content.text);
					}
					break;
				case 'agent_thought_chunk':
					break;
				case 'usage_update': {
					// How full the context window is: VS Code shows it next to the input.
					const usage = u as unknown as { used: number; size: number };
					(stream as unknown as { usage?(x: { promptTokens: number; completionTokens: number }): void }).usage?.({ promptTokens: usage.used, completionTokens: 0 });
					break;
				}
				case 'tool_call': {
					const part = new vscode.ChatToolInvocationPart(u.kind ?? 'tool', u.toolCallId);
					part.invocationMessage = u.title;
					part.enablePartialUpdate = true;
					const files = (u.locations ?? []).map(l => l.path);
					tools.set(u.toolCallId, { part, kind: u.kind ?? undefined, files });
					gazeAcp(id, LABEL[this.kind], this.kind, u.kind, u.locations);
					stream.push(part);
					break;
				}
				case 'tool_call_update': {
					const t = tools.get(u.toolCallId);
					if (!t) {
						break;
					}
					if (u.locations?.length) {
						t.files = u.locations.map(l => l.path);
						gazeAcp(id, LABEL[this.kind], this.kind, t.kind, u.locations);
					}
					if (u.title) {
						t.part.invocationMessage = u.title;
					}
					if (u.status === 'completed' || u.status === 'failed') {
						t.part.isComplete = true;
						t.part.isError = u.status === 'failed';
						t.part.pastTenseMessage = u.title ?? (t.part.invocationMessage as string);
						edits.complete(u.toolCallId);
						if (t.kind === 'edit') {
							void Promise.resolve(vscode.commands.executeCommand('flow.agentDidEdit', t.files)).catch(() => undefined);
						}
					}
					stream.push(t.part);
					break;
				}
				case 'plan': {
					const entries = (u as { entries?: Array<{ content: string; status: string }> }).entries ?? [];
					if (entries.length) {
						stream.markdown('\n\n' + entries.map(e => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`).join('\n') + '\n\n');
					}
					break;
				}
				case 'config_option_update':
					this.configs.set(id, ((u as { configOptions?: SessionConfigOption[] }).configOptions ?? []) as SessionConfigOption[]);
					break;
			}
		};

		this.host.setSink(id, {
			onUpdate: n => onUpdate(n.update),
			onPermission: r => this.askPermission(r, edits, stream, token),
		});
		const cancel = token.onCancellationRequested(() => void conn.cancel({ sessionId: id }).catch(() => undefined));
		try {
			const r = await conn.prompt({ sessionId: id, prompt: this.promptBlocks(req) });
			if (r.stopReason !== 'end_turn' && r.stopReason !== 'cancelled') {
				stream.markdown(`\n\n_Stopped: ${r.stopReason}_`);
			}
			if (item) {
				item.status = vscode.ChatSessionStatus.Completed;
			}
			return {};
		} catch (e) {
			if (item) {
				item.status = vscode.ChatSessionStatus.Failed;
			}
			return { errorDetails: { message: explain(this.kind, e) } };
		} finally {
			cancel.dispose();
			edits.completeAll();
			this.host.setSink(id, undefined);
			if (item) {
				item.timing = { ...item.timing!, lastRequestEnded: Date.now() };
			}
		}
	}

	private promptBlocks(req: vscode.ChatRequest) {
		const blocks: Array<{ type: 'text'; text: string } | { type: 'resource_link'; uri: string; name: string }> = [{ type: 'text', text: req.prompt }];
		for (const ref of req.references) {
			const v = ref.value;
			const uri = v instanceof vscode.Uri ? v : v instanceof vscode.Location ? v.uri : undefined;
			if (uri) {
				blocks.push({ type: 'resource_link', uri: uri.toString(), name: path.basename(uri.fsPath) });
			} else if (typeof v === 'string') {
				blocks.push({ type: 'text', text: v });
			}
		}
		return blocks;
	}

	/**
	 * Every write asks first (the agent runs in `default`). Snapshot the files it will touch, then either
	 * answer for the user (their mode says so) or ask them. Only bypassPermissions answers everything;
	 * acceptEdits and auto answer edits and still ask for the rest (commands, MCP tools, …).
	 */
	private async askPermission(r: RequestPermissionRequest, edits: EditTracker, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<RequestPermissionResponse> {
		const files = (r.toolCall.locations ?? []).map(l => l.path);
		const isEdit = r.toolCall.kind === 'edit';
		const mode = this.approval.get(r.sessionId) ?? this.harnessMode ?? 'default';
		let option = autoAnswer(mode, r.toolCall.kind, r.options, { cwd: this.cwd, files });
		const auto = !!option;
		if (!option) {
			const title = r.toolCall.title ?? 'Tool';
			// Insilode's canvas marks the methods this edit would touch while the user decides.
			const diffs = diffsOf(r.toolCall.content);
			if (isEdit) {
				await Promise.resolve(vscode.commands.executeCommand('flow.agentProposes', { agent: LABEL[this.kind], title, files, diffs })).catch(() => undefined);
			}
			// A cancelled turn must not wait for an answer nobody will read. The modal itself cannot be closed
			// from here; whatever is picked in it afterwards is ignored.
			const pick = await new Promise<string | undefined>(resolve => {
				const sub = token.onCancellationRequested(() => resolve(undefined));
				if (token.isCancellationRequested) {
					sub.dispose();
					return resolve(undefined);
				}
				Promise.resolve(vscode.window.showInformationMessage(
					`${LABEL[this.kind]}: ${title}`,
					{ modal: true, detail: files.map(f => vscode.workspace.asRelativePath(f)).join('\n') || undefined },
					...r.options.map(o => o.name),
				)).then(resolve, () => resolve(undefined)).finally(() => sub.dispose());
			});
			option = r.options.find(o => o.name === pick);
			if (isEdit) {
				void Promise.resolve(vscode.commands.executeCommand('flow.agentProposalDone')).catch(() => undefined);
			}
		}
		// Insilode Harness keeps every question and its answer, so one can be turned into a standing rule.
		void Promise.resolve(vscode.commands.executeCommand('flowHarness.recordPermission', {
			at: Date.now(),
			agent: LABEL[this.kind],
			kind: r.toolCall.kind ?? undefined,
			title: r.toolCall.title ?? 'Tool',
			files,
			rawInput: (r.toolCall as { rawInput?: unknown }).rawInput ?? undefined,
			decision: permissionDecision(option, auto),
		})).catch(() => undefined);
		if (!option) {
			return { outcome: { outcome: 'cancelled' } };
		}
		if (option.kind.startsWith('allow') && isEdit) {
			// Insilode's canvas keeps the pre-edit text so cards can show this change (and undo it per method).
			await Promise.resolve(vscode.commands.executeCommand('flow.agentWillEdit', files)).catch(() => undefined);
			await edits.track(r.toolCall.toolCallId, files, stream);
		}
		return { outcome: { outcome: 'selected', optionId: option.optionId } };
	}

	dispose() {
		this.disposables.forEach(d => d.dispose());
	}
}
