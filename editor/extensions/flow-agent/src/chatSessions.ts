/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page's own chat. Where sessionType.ts writes an ACP agent's turns into VS Code's chat, this keeps them as
 *  ChatEvents (chatCore.ts) for the page to draw, so the page can talk to the agents of every project on the machine: it opens
 *  an earlier session or starts a new one in that project's folder, through one adapter process per kind (the adapters take a
 *  `cwd` per session). The page names a project by its key, a session by an id from the host's own index, never a path; the
 *  folder comes from the index, and a folder outside this window's workspace is asked about once before an agent runs in it.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
import { AgentHost, explain, type AgentKind, type SessionSink } from './acp';
import type { Agents } from './agents';
import type { AgentsPageChatOpened, ChatEvent, ChatProject } from './agentsData';
import { ALLOW_WITH_UPDATES, appendEvent, autoAnswer, configAccepts, configView, currentValue, diffsOf, elevatingMode, isInside, MAX_EVENTS, permissionDecision, plainEditAnswer, plainPlanAnswer, toEvents } from './chatCore';
import { agentCwd } from './env';
import { gazeAcp, gazeTurn } from './gazeHost';
import { SessionIndex } from './sessionIndex';
import { folderKey } from './storageKey';

const LABEL: Record<AgentKind, string> = { claude: 'Claude', codex: 'Codex' };
/** Folders the user agreed to run agents in (their real paths), kept across windows and restarts. */
export const TRUSTED_FOLDERS = 'flow.agents.trustedFolders';
const MAX_TRUSTED = 200;

/** Takes back every folder the user agreed to run agents in (the palette command "Forget Folders Trusted for Agents"). */
export async function forgetTrustedFolders(context: vscode.ExtensionContext): Promise<void> {
	const n = context.globalState.get<string[]>(TRUSTED_FOLDERS, []).length;
	await context.globalState.update(TRUSTED_FOLDERS, undefined);
	void vscode.window.showInformationMessage(n ? `Insilode: forgot ${n} folder${n === 1 ? '' : 's'} trusted for agents. The next chat in one asks again.` : 'Insilode: no folder was trusted for agents.');
}
/** Chats kept in memory; the oldest idle one goes when a new one would be the ninth. */
const MAX_CHATS = 8;
/** An adapter exit this soon after a failed turn is that turn's own cause (the closed connection), not a second event. */
const FAILED_SAME_EVENT_MS = 1000;

type Option = RequestPermissionRequest['options'][number];
interface Ask {
	options: RequestPermissionRequest['options'];
	resolve: (o: Option | undefined) => void;
	/** An elevating answer is waiting for its modal: a second answer for the same question is ignored. */
	deciding?: boolean;
	/** The question is about an edit: `allow-with-updates` on it means `acceptEdits` for the session (see `elevatingMode`). */
	edit?: boolean;
}

interface Chat {
	id: string;
	kind: AgentKind;
	cwd: string;
	project: string;
	sessionId: string;
	title: string;
	host: AgentHost;
	/** This window's own folder, or one inside a folder of its workspace: only there do the canvas and editor hooks fire, and the Harness hears the questions. */
	own: boolean;
	config: SessionConfigOption[];
	/** The mode the user picked. The adapter itself stays in `default` (or `plan`), as in sessionType.ts, and Insilode answers per this mode. */
	mode: string;
	/** The mode Insilode last put the adapter in: a mode update that says otherwise is the adapter's own move (the plan dialog). */
	want: string;
	/** Modes the user confirmed for this session (see `confirmMode`), so each is asked about once. */
	confirmed: Set<string>;
	confirming: boolean;
	/** Counts every move of `mode`: a modal answered after the chat went elsewhere is stale and applies nothing. */
	gen: number;
	/** The elevated mode `adoptElevated` is deciding on: a repeat of the adapter's update (it sends two per change) is not a new move. */
	adopting?: string;
	busy: boolean;
	dead: boolean;
	/** When this turn's failure was shown (0: none): the adapter's exit right after it does not say it again, one long after it does. */
	failedAt: number;
	/** A history replay is arriving: it fills the transcript but is not a turn, so no hook fires for it. */
	replaying: boolean;
	events: ChatEvent[];
	asks: Map<number, Ask>;
	nextReq: number;
	tools: Map<string, { kind?: string; files: string[] }>;
}

/** A path realpath cannot resolve in a second (a dead network mount) is taken as written: the caller then compares it with other paths as written. */
async function real(p: string): Promise<string> {
	let timer: NodeJS.Timeout | undefined;
	const slow = new Promise<string>(resolve => timer = setTimeout(() => resolve(path.resolve(p)), 1500));
	try {
		return await Promise.race([fs.realpath(p).catch(() => path.resolve(p)), slow]);
	} finally {
		clearTimeout(timer);
	}
}
/** A path as the dialogs show it: a folder name can hold a newline or an escape that would pass for text of the dialog itself. */
const shown = (p: string) => p.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
const tilde = (p: string) => { const home = os.homedir(); return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p; };

export class ChatSessions implements vscode.Disposable {
	private readonly hosts = new Map<AgentKind, AgentHost>();
	private readonly chats = new Map<string, Chat>();
	private readonly opening = new Map<string, Promise<Chat>>();
	/** The chat the page last drew (see `opened`). */
	private shown: string | undefined;
	private readonly index = new SessionIndex();
	/** project key → folder, from the last index: the only way a key becomes a path. */
	private known = new Map<string, string>();
	/** What the last `projects()` returned: an open is checked against it, so a slow scan never holds up opening what the page already lists. */
	private listed: ChatProject[] = [];
	private readonly disposables: vscode.Disposable[] = [];
	private readonly events = new vscode.EventEmitter<{ chat: string; event: ChatEvent }>();
	readonly onEvent = this.events.event;

	constructor(private readonly context: vscode.ExtensionContext, private readonly agents: Agents, private readonly log: vscode.LogOutputChannel) {
		this.disposables.push(this.events);
	}

	// ---- the sidebar's projects -----------------------------------------------------------------------------------------------

	private get folder(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	/** Projects on this machine with their sessions, this window's own first (always listed, so a session can start in it). Sessions running in a terminal are left out. */
	async projects(): Promise<ChatProject[]> {
		const own = this.folder;
		const ownReal = own ? await real(own) : undefined;
		const live = new Set([...this.agents.sessions.values()].filter(s => s.state !== 'ended').flatMap(s => [s.id, s.agentId ?? '', path.basename(s.transcript ?? '', '.jsonl')]));
		const out: ChatProject[] = own ? [{ key: folderKey(own), name: path.basename(own) || own, where: tilde(own), own: true, sessions: [] }] : [];
		// Swapped in at the end: an open that arrives while the realpaths are read must still find its key.
		const known = new Map<string, string>(own ? [[folderKey(own), own]] : []);
		for (const p of await this.index.list()) {
			const mine = ownReal !== undefined && await real(p.cwd) === ownReal;
			const into = mine ? out[0] : { key: p.key, name: p.name, where: tilde(p.cwd), own: false, sessions: [] as ChatProject['sessions'] };
			into.sessions.push(...p.sessions.filter(s => !live.has(s.id)));
			if (!mine) {
				known.set(p.key, p.cwd);
				if (into.sessions.length) {
					out.push(into);
				}
			}
		}
		if (out[0]?.own) {
			out[0].sessions.sort((a, b) => b.modified - a.modified);
		}
		this.known = known;
		this.listed = out;
		return out;
	}

	// ---- opening ----------------------------------------------------------------------------------------------------------------

	private hostFor(kind: AgentKind): AgentHost {
		let host = this.hosts.get(kind);
		if (!host) {
			host = new AgentHost(kind, this.context.extensionPath, this.log);
			this.hosts.set(kind, host);
			this.disposables.push(host, host.onDidExit(() => this.hostGone(kind)));
		}
		return host;
	}

	/** An adapter that ended took its sessions with it: the transcripts stay readable, and the next message says what happened. */
	private hostGone(kind: AgentKind) {
		for (const c of this.chats.values()) {
			if (c.kind === kind && !c.dead) {
				c.dead = true;
				c.busy = false;
				this.cancelAsks(c);
				// A turn that was running already failed with the closed connection: one line is enough.
				if (Date.now() - c.failedAt > FAILED_SAME_EVENT_MS) {
					this.push(c, { t: 'error', fatal: true, text: `The ${LABEL[kind]} agent process ended. Open the session again to continue.` });
				}
			}
		}
	}

	/** The folder of a project key (and the check that the session is one the host listed), from the last list when it has the answer; a new chat in this window's own folder needs no list at all. */
	private async resolve(project: string, kind: AgentKind, session: string | undefined): Promise<string> {
		const own = this.folder;
		if (own && folderKey(own) === project && session === undefined) {
			return agentCwd(own) ?? own;
		}
		const has = (list: ChatProject[]) => this.known.has(project) && (session === undefined || list.find(p => p.key === project)?.sessions.some(s => s.id === session && s.kind === kind));
		const list = has(this.listed) ? this.listed : await this.projects();
		const found = this.known.get(project);
		if (!found) {
			throw new Error('That project is not one the agents have worked in.');
		}
		if (!has(list)) {
			throw new Error('That session is not in the list any more.');
		}
		return own && folderKey(own) === project ? agentCwd(own) ?? own : found;
	}

	/**
	 * A cwd inside this (trusted) window's workspace passes; any other folder needs the user's yes, once, kept by its real path.
	 * Returns that real path (what the user saw and confirmed) and whether the folder is inside the workspace.
	 */
	private async trust(cwd: string): Promise<{ where: string; inside: boolean }> {
		if (!vscode.workspace.isTrusted) {
			throw new Error('Trust this workspace to run agents.');
		}
		const where = await real(cwd);
		if (!(await fs.stat(where).then(s => s.isDirectory(), () => false))) {
			throw new Error(`${shown(cwd)} is not a folder any more.`);
		}
		for (const f of vscode.workspace.workspaceFolders ?? []) {
			if (isInside(await real(f.uri.fsPath), where)) {
				return { where, inside: true };
			}
		}
		const trusted = this.context.globalState.get<string[]>(TRUSTED_FOLDERS, []);
		if (trusted.includes(where)) {
			return { where, inside: false };
		}
		const yes = 'Run Agent Here';
		const answer = await vscode.window.showWarningMessage(`Run an agent in ${shown(where)}?`, {
			modal: true,
			detail: 'This folder is outside the project open in this window. The agent can read, edit and run commands there, and the folder\'s own Claude settings (hooks, permission rules) and its .mcp.json servers load too: a repository you do not trust can make them run code. You can take these folders back with "Insilode: Forget Folders Trusted for Agents".',
		}, yes);
		if (answer !== yes) {
			throw new Error('Not started: the agent was not allowed to run in that folder.');
		}
		await this.context.globalState.update(TRUSTED_FOLDERS, [...trusted, where].slice(-MAX_TRUSTED));
		return { where, inside: false };
	}

	/** Opens a session of a project (an earlier one, or a new one with no `session`) and returns its chat. Throws the sentence the page shows. */
	open(project: string, kind: AgentKind, session?: string): Promise<Chat> {
		const same = session && [...this.chats.values()].find(c => c.kind === kind && c.sessionId === session && c.project === project && !c.dead);
		if (same) {
			return Promise.resolve(same);
		}
		const token = `${project}|${kind}|${session ?? ''}`;
		let pending = this.opening.get(token);
		if (!pending) {
			pending = this.start(project, kind, session).finally(() => this.opening.delete(token));
			this.opening.set(token, pending);
		}
		return pending;
	}

	private async start(project: string, kind: AgentKind, session: string | undefined): Promise<Chat> {
		const cwd = await this.resolve(project, kind, session);
		const { where, inside: own } = await this.trust(cwd);
		const host = this.hostFor(kind);
		try {
			const conn = await host.connection();
			const chat: Chat = {
				id: '', kind, cwd, project, sessionId: session ?? '', title: LABEL[kind], host, own, config: [], mode: 'default', want: 'default', confirmed: new Set(), confirming: false, gen: 0,
				busy: false, dead: false, failedAt: 0, replaying: !!session, events: [], asks: new Map(), nextReq: 0, tools: new Map(),
			};
			const sink: SessionSink = {
				onUpdate: n => this.onUpdate(chat, n.update),
				onPermission: r => this.ask(chat, r),
			};
			// The agent keeps the folder as written (Claude finds a transcript by the folder's spelling), so the real path the user
			// confirmed is checked again right before it starts: a link swapped in since then must not point it somewhere else.
			const unchanged = async () => {
				if (await real(cwd) !== where) {
					throw new Error('Not started: the folder changed while it was being opened.');
				}
			};
			let configOptions: SessionConfigOption[];
			if (session) {
				// The sink first: the replay arrives while `loadSession` is still running.
				chat.id = `${kind}:${session}`;
				host.setSink(session, sink);
				try {
					await unchanged();
					const res = await conn.loadSession({ sessionId: session, cwd, mcpServers: [] });
					configOptions = ((res as { configOptions?: SessionConfigOption[] }).configOptions ?? []) as SessionConfigOption[];
				} catch (e) {
					host.setSink(session, undefined);
					throw e;
				} finally {
					chat.replaying = false;
				}
				chat.title = this.listed.find(p => p.key === project)?.sessions.find(s => s.id === session)?.title ?? LABEL[kind];
			} else {
				await unchanged();
				const res = await conn.newSession({ cwd, mcpServers: [] });
				chat.sessionId = res.sessionId;
				chat.id = `${kind}:${res.sessionId}`;
				host.setSink(res.sessionId, sink);
				configOptions = (res.configOptions ?? []) as SessionConfigOption[];
				chat.title = 'New chat';
			}
			try {
				chat.config = configOptions;
				// What the user's own Claude settings start in. Outside this window's workspace every session starts in `default`: a
				// folder's own settings must not pick the mode, and the user may choose another one (after a confirmation) but never gets it unasked.
				const inherited = currentValue(configOptions.find(o => o.id === 'mode') ?? ({} as SessionConfigOption)) ?? 'default';
				chat.mode = own ? inherited : 'default';
				await this.setAdapterOption(chat, 'mode', chat.mode === 'plan' ? 'plan' : 'default');
			} catch (e) {
				// The session exists in the adapter but nobody will hold it: let it go.
				host.setSink(chat.sessionId, undefined);
				void Promise.resolve().then(() => conn.closeSession({ sessionId: chat.sessionId })).catch(() => undefined);
				throw e;
			}
			this.chats.set(chat.id, chat);
			this.evict(chat.id);
			return chat;
		} catch (e) {
			throw new Error(explain(kind, e));
		}
	}

	private evict(keep: string) {
		for (const [id, c] of this.chats) {
			if (this.chats.size <= MAX_CHATS) {
				return;
			}
			// The shown chat stays even when an open the page has since given up on finishes late and fills the table.
			if (id !== keep && id !== this.shown && !c.busy && !c.asks.size) {
				this.chats.delete(id);
				c.host.setSink(c.sessionId, undefined);
			}
		}
	}

	/** What the page draws when it opens, or comes back to, a chat. */
	opened(chat: Chat): { opened: AgentsPageChatOpened; events: ChatEvent[] } {
		this.shown = chat.id;
		return {
			opened: { type: 'chatOpened', chat: chat.id, project: chat.project, kind: chat.kind, title: chat.title, busy: chat.busy, config: configView(chat.config, chat.mode) },
			events: chat.events,
		};
	}

	get(id: string): Chat | undefined {
		return this.chats.get(id);
	}

	// ---- a turn -----------------------------------------------------------------------------------------------------------------

	private push(c: Chat, event: ChatEvent) {
		appendEvent(c.events, event, MAX_EVENTS);
		if (!c.replaying) {
			this.events.fire({ chat: c.id, event });
		}
	}

	private onUpdate(c: Chat, u: Parameters<SessionSink['onUpdate']>[0]['update']) {
		for (const e of toEvents(u)) {
			this.push(c, e);
		}
		if (u.sessionUpdate === 'config_option_update') {
			c.config = ((u as { configOptions?: SessionConfigOption[] }).configOptions ?? c.config) as SessionConfigOption[];
			this.push(c, { t: 'config', config: configView(c.config, c.mode) });
		}
		if (!c.replaying) {
			this.followAdapterMode(c, u);
		}
		if (c.replaying || !c.own) {
			return;
		}
		// The canvas and the editor follow an agent only in this window's own folder.
		if (u.sessionUpdate === 'tool_call') {
			c.tools.set(u.toolCallId, { kind: u.kind ?? undefined, files: (u.locations ?? []).map(l => l.path) });
			gazeAcp(c.sessionId, LABEL[c.kind], c.kind, u.kind, u.locations);
		} else if (u.sessionUpdate === 'tool_call_update') {
			const t = c.tools.get(u.toolCallId);
			if (!t) {
				return;
			}
			if (u.locations?.length) {
				t.files = u.locations.map(l => l.path);
				gazeAcp(c.sessionId, LABEL[c.kind], c.kind, t.kind, u.locations);
			}
			if ((u.status === 'completed' || u.status === 'failed') && t.kind === 'edit') {
				void Promise.resolve(vscode.commands.executeCommand('flow.agentDidEdit', t.files)).catch(() => undefined);
			}
		}
	}

	/** Every change of the chat's mode goes through here, so a modal that was open meanwhile can tell. */
	private moved(c: Chat, mode: string) {
		if (c.mode !== mode) {
			c.gen++;
		}
		c.mode = mode;
	}

	/**
	 * The adapter moves itself to another mode when a plan is approved (ExitPlanMode). `answer` confirms an elevating answer before
	 * the adapter hears it, so this is the backstop for an elevated mode that arrives any other way: it goes through the same
	 * confirmation as the mode picker (`adoptElevated`); plan and default are taken as they are.
	 */
	private followAdapterMode(c: Chat, u: Parameters<SessionSink['onUpdate']>[0]['update']) {
		const mode = u.sessionUpdate === 'current_mode_update' ? (u as { currentModeId?: string }).currentModeId
			: u.sessionUpdate === 'config_option_update' ? currentValue(c.config.find(o => o.id === 'mode') ?? ({} as SessionConfigOption)) : undefined;
		if (!mode || mode === c.want || mode === c.adopting) {
			return;
		}
		if (mode === 'plan' || mode === 'default') {
			this.moved(c, mode);
			c.want = mode;
			this.push(c, { t: 'config', config: configView(c.config, c.mode) });
		} else {
			void this.adoptElevated(c, mode);
		}
	}

	/**
	 * Fail-safe order: the adapter is put back to `default` FIRST (in bypass it asks nothing, so every second the modal is open the
	 * agent would run unasked), then the user is asked, and only a yes gives the chat the elevated mode. The adapter itself stays in
	 * `default` so every write keeps coming through here (the canvas snapshot, the folder rule of `autoAnswer`).
	 */
	private async adoptElevated(c: Chat, mode: string) {
		// Before any await: a question arriving meanwhile is not answered by the mode, and a repeat of the update is not a new move.
		c.adopting = mode;
		this.moved(c, 'default');
		this.push(c, { t: 'config', config: configView(c.config, c.mode) });
		try {
			try {
				await this.setAdapterOption(c, 'mode', 'default', true);
			} catch {
				await this.abandon(c);
				return;
			}
			const gen = c.gen;
			const yes = await this.confirmMode(c, mode).catch(() => false);
			if (yes && gen === c.gen && !c.dead) {
				this.moved(c, mode);
			}
		} finally {
			if (c.adopting === mode) {
				c.adopting = undefined;
			}
		}
		this.push(c, { t: 'config', config: configView(c.config, c.mode) });
	}

	/** The adapter would not leave an elevated mode: nothing can vouch for what it runs now, so the turn and the session end. */
	private async abandon(c: Chat) {
		if (c.dead) {
			return;
		}
		c.dead = true;
		this.cancelAsks(c);
		const conn = await c.host.connection().catch(() => undefined);
		await Promise.resolve(conn?.cancel({ sessionId: c.sessionId })).catch(() => undefined);
		await Promise.resolve(conn?.closeSession({ sessionId: c.sessionId })).catch(() => undefined);
		c.host.setSink(c.sessionId, undefined);
		this.push(c, { t: 'error', fatal: true, text: 'This session was closed because its permission mode could not be restored. Open the session again to continue.' });
	}

	async prompt(id: string, text: string): Promise<void> {
		const c = this.chats.get(id);
		if (!c) {
			// The page is already busy with this turn: a fatal error is what lets it stop waiting.
			this.events.fire({ chat: id, event: { t: 'error', fatal: true, text: 'This chat is no longer open here. Open the session again to continue.' } });
			return;
		}
		if (c.dead || c.busy) {
			// A dead chat never starts the turn the page just began, so that line ends it; "still answering" leaves the running turn alone.
			this.push(c, c.dead ? { t: 'error', fatal: true, text: `The ${LABEL[c.kind]} agent process ended. Open the session again to continue.` } : { t: 'error', text: 'The agent is still answering. Stop it first.' });
			return;
		}
		c.busy = true;
		c.failedAt = 0;
		if (c.title === 'New chat') {
			c.title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
		}
		this.push(c, { t: 'user', text });
		try {
			if (c.own) {
				// A new trail for the gaze, and Insilode's timeline: every prompt is one step.
				gazeTurn(c.sessionId);
				await Promise.resolve(vscode.commands.executeCommand('flow.agentTurn', text, LABEL[c.kind])).catch(() => undefined);
			}
			const r = await (await c.host.connection()).prompt({ sessionId: c.sessionId, prompt: [{ type: 'text', text }] });
			this.push(c, { t: 'stop', reason: r.stopReason });
		} catch (e) {
			// Already said by hostGone when the adapter's exit came first.
			if (!c.dead) {
				c.failedAt = Date.now();
				this.push(c, { t: 'error', fatal: true, text: explain(c.kind, e) });
			}
		} finally {
			c.busy = false;
			this.cancelAsks(c);
		}
	}

	async cancel(id: string): Promise<void> {
		const c = this.chats.get(id);
		if (!c || c.dead) {
			return;
		}
		// A question nobody will answer must not hold the turn up.
		this.cancelAsks(c);
		await (await c.host.connection()).cancel({ sessionId: c.sessionId }).catch(() => undefined);
	}

	// ---- permission questions -------------------------------------------------------------------------------------------------

	private cancelAsks(c: Chat) {
		for (const [req, a] of [...c.asks]) {
			c.asks.delete(req);
			a.resolve(undefined);
		}
	}

	/** The user's mode answers what it covers; the rest becomes an `ask` event the page shows as buttons, answered by `answer`. */
	private async ask(c: Chat, r: RequestPermissionRequest): Promise<RequestPermissionResponse> {
		const files = (r.toolCall.locations ?? []).map(l => l.path);
		const isEdit = r.toolCall.kind === 'edit';
		const hooks = c.own && !c.replaying;
		let option = autoAnswer(c.mode, r.toolCall.kind, r.options, { cwd: c.cwd, files });
		const auto = !!option;
		if (!option) {
			const title = r.toolCall.title ?? 'Tool';
			if (hooks && isEdit) {
				await Promise.resolve(vscode.commands.executeCommand('flow.agentProposes', { agent: LABEL[c.kind], title, files, diffs: diffsOf(r.toolCall.content) })).catch(() => undefined);
			}
			const req = c.nextReq++;
			const answered = new Promise<Option | undefined>(resolve => c.asks.set(req, { options: r.options, resolve, edit: isEdit }));
			this.push(c, { t: 'ask', req, title, files: files.map(f => isInside(c.cwd, f) ? path.relative(c.cwd, f) || f : f), options: r.options.map(o => ({ name: o.name, kind: o.kind })) });
			option = await answered;
			this.push(c, { t: 'asked', req });
			if (hooks && isEdit) {
				void Promise.resolve(vscode.commands.executeCommand('flow.agentProposalDone')).catch(() => undefined);
			}
		}
		// Insilode Harness keeps every question and its answer, so one can be turned into a standing rule. Only this project's own:
		// another repository's commands do not belong in this workspace's inbox.
		if (c.own) {
			void Promise.resolve(vscode.commands.executeCommand('flowHarness.recordPermission', {
				at: Date.now(),
				agent: LABEL[c.kind],
				kind: r.toolCall.kind ?? undefined,
				title: r.toolCall.title ?? 'Tool',
				files,
				rawInput: (r.toolCall as { rawInput?: unknown }).rawInput ?? undefined,
				decision: permissionDecision(option, auto),
			})).catch(() => undefined);
		}
		if (!option) {
			return { outcome: { outcome: 'cancelled' } };
		}
		if (option.kind.startsWith('allow') && isEdit && hooks) {
			// Insilode's canvas keeps the pre-edit text so cards can show this change.
			await Promise.resolve(vscode.commands.executeCommand('flow.agentWillEdit', files)).catch(() => undefined);
		}
		// `allow-with-updates` on an edit puts the adapter in acceptEdits without saying so, so no mode update reaches followAdapterMode.
		// Take the same road it would (the picker and the chat follow, the adapter goes back to `default`, the folder rule answers from
		// here on), but only once this answer is on its way: a reset sent before it would be undone by the adapter applying it.
		const silent = isEdit ? elevatingMode(option, 'edit') : undefined;
		if (silent && option.optionId === ALLOW_WITH_UPDATES) {
			setTimeout(() => !c.dead && void this.adoptElevated(c, silent), 0);
		}
		return { outcome: { outcome: 'selected', optionId: option.optionId } };
	}

	/**
	 * `option` is an index into the options the host sent with that question; anything else is ignored. An answer that would elevate
	 * the session (the plan question's "bypass permissions", "auto", "auto-accept edits") is confirmed BEFORE the adapter hears it:
	 * once it does, Claude Code applies the mode and the turn goes on, and in bypass nothing asks any more. The question stays
	 * pending meanwhile, which holds the turn, and a no sends the plain approval instead.
	 */
	answer(id: string, req: number, option: number): void {
		const c = this.chats.get(id);
		const a = c?.asks.get(req);
		if (!c || !a || a.deciding || option >= a.options.length) {
			return;
		}
		const chosen = a.options[option];
		const mode = elevatingMode(chosen, a.edit ? 'edit' : undefined);
		if (!mode || !this.needsConfirm(c, mode)) {
			c.asks.delete(req);
			a.resolve(chosen);
			return;
		}
		a.deciding = true;
		void this.confirmAnswer(c, req, a, chosen, mode);
	}

	private async confirmAnswer(c: Chat, req: number, a: Ask, chosen: Option, mode: string) {
		const gen = c.gen;
		const yes = await this.confirmMode(c, mode).catch(() => false);
		// Cancelled (or the adapter ended) while the modal was open: that already answered it.
		if (c.asks.get(req) !== a) {
			return;
		}
		c.asks.delete(req);
		if (yes && gen === c.gen) {
			a.resolve(chosen);
			return;
		}
		if (chosen.optionId === ALLOW_WITH_UPDATES) {
			// Only this once: the mode stays as it was.
			a.resolve(plainEditAnswer(a.options));
			return;
		}
		const plain = plainPlanAnswer(a.options);
		// Only an approval that keeps `default` moves the chat there; "keep planning" leaves the adapter, and the picker, in plan.
		if (plain?.kind.startsWith('allow') && gen === c.gen) {
			this.moved(c, 'default');
			c.want = 'default';
		}
		this.push(c, { t: 'config', config: configView(c.config, c.mode) });
		a.resolve(plain);
	}

	// ---- the mode, model and the rest ---------------------------------------------------------------------------------------

	/** `force` sends the value even when the cached config already shows it: the adapter's own move may not have reached the cache. */
	private async setAdapterOption(c: Chat, configId: string, value: string, force = false) {
		if (configId === 'mode') {
			c.want = value;
		}
		const opt = c.config.find(o => o.id === configId);
		if (!opt || (!force && currentValue(opt) === value)) {
			return;
		}
		const res = await (await c.host.connection()).setSessionConfigOption({ sessionId: c.sessionId, configId, value } as Parameters<Awaited<ReturnType<AgentHost['connection']>>['setSessionConfigOption']>[0]);
		c.config = ((res as { configOptions?: SessionConfigOption[] }).configOptions ?? c.config) as SessionConfigOption[];
	}

	/**
	 * Bypass (anywhere) and acceptEdits/auto (in a folder outside this workspace) take the agent's questions away: the user confirms
	 * them in a modal of the editor itself, naming the folder, once per session and mode. False when they decline.
	 */
	private needsConfirm(c: Chat, mode: string): boolean {
		return (mode === 'bypassPermissions' || (!c.own && (mode === 'acceptEdits' || mode === 'auto'))) && !c.confirmed.has(mode);
	}

	private async confirmMode(c: Chat, mode: string): Promise<boolean> {
		if (!this.needsConfirm(c, mode)) {
			return true;
		}
		if (c.confirming) {
			return false;
		}
		c.confirming = true;
		try {
			const yes = 'Switch Mode';
			const what = mode === 'bypassPermissions'
				? 'The agent will edit files and run commands without asking you.'
				: 'The agent will edit files inside that folder without asking you; commands and anything else still ask.';
			const label = configView(c.config, c.mode).find(o => o.id === 'mode')?.items.find(i => i.value === mode)?.name ?? mode;
			const answer = await vscode.window.showWarningMessage(`Switch this chat to ${label}?`, { modal: true, detail: `Folder: ${shown(c.cwd)}\n\n${what}` }, yes);
			if (answer !== yes) {
				return false;
			}
			c.confirmed.add(mode);
			return true;
		} finally {
			c.confirming = false;
		}
	}

	/** Only an option the host itself offered, to a value it offered, is passed on; the mode is Insilode's own (see `Chat.mode`). */
	async setOption(id: string, configId: string, value: string): Promise<void> {
		const c = this.chats.get(id);
		if (!c || c.dead || !configAccepts(configView(c.config, c.mode), configId, value)) {
			return;
		}
		try {
			if (configId === 'mode') {
				// A "no" changes nothing, and the config event below makes the page's picker show the old mode again.
				if (await this.confirmMode(c, value)) {
					await this.setAdapterOption(c, 'mode', value === 'plan' ? 'plan' : 'default');
					this.moved(c, value);
				}
			} else {
				await this.setAdapterOption(c, configId, value);
			}
		} catch (e) {
			this.push(c, { t: 'error', text: explain(c.kind, e) });
		}
		this.push(c, { t: 'config', config: configView(c.config, c.mode) });
	}

	dispose() {
		for (const c of this.chats.values()) {
			this.cancelAsks(c);
		}
		this.disposables.forEach(d => d.dispose());
	}
}
