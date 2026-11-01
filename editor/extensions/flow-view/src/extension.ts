/*---------------------------------------------------------------------------------------------
 *  Flow: "◆ Flow" above methods, a command at the cursor, and the canvas tab. C# goes through the
 *  Roslyn analyzer, Java/Python/JS/TS and friends through the polyglot index, anything else through
 *  its language server.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { Analyzer, innermost } from './analyzer';
import { AgentChanges, GIT_AGENT } from './agentDiff';
import { askInDock } from './askAgent';
import { ChangeSetProvider } from './changeSet';
import { entryDisplay } from './entryLabel';
import { Endpoints, entryName, type Entry, type Source } from './backends';
import { flowToBoard } from './board/fromFlow';
import { nodesLinkedTo, parsePlan, statusAfterEdit } from './board/plan';
import { boardFromCodeMessage, kindChoices, scopeChoices, type ScopeSource } from './board/fromCode';
import { BoardStore, MAX_BOARDS } from './board/store';
import { MarkdownBoardViewer } from './board/viewer';
import { registerTypeViews } from './typeviews';
import { TypeService } from './types/typeService';
import { SkeletonHost } from './skeletonHost';
import { Command } from './commands';
import { EndpointsView } from './endpoints';
import { cursorNotice } from './cursorMessage';
import { playSampleTour } from './sampleTour';
import { FlowHome } from './home';
import { FlowSettings } from './settings';
import { ClaudeIdeBridge } from './ide';
import { legacySettingUpdates } from './legacySettings';
import { PolyLenses, RoslynLenses } from './lenses';
import { LspLenses, LspProvider } from './lsp';
import { AgentBridge } from './mcp/bridge';
import { planResolvers } from './mcp/planHost';
import { registerMcpCommands } from './mcp/register';
import { TableIndex } from './mcp/tableIndex';
import { turnImpact } from './mcp/turnImpact';
import { FlowPanel } from './panel';
import { PolyIndex, PolyProvider, POLY_LANGUAGES } from './poly/client';
import { RoslynProvider, type FlowProvider, type FlowTarget } from './providers';
import { registerHarnessFlow } from './harnessFlowPanel';
import { registerResolveNames } from './resolveNames';
import { registerSelectionActions } from './selectionAi';
import { playTourFile } from './tourFile';
import { parseFlowAsk } from './tour/ask';
import { FlowTrail } from './trail';

/** Everything the commands need, built once in `activate`. */
interface Flow {
	context: vscode.ExtensionContext;
	log: vscode.LogOutputChannel;
	analyzer: Analyzer;
	poly: PolyIndex;
	endpointList: Endpoints;
	/** Which endpoints read or write a table: asked of the code index and the analyzer, never starting the analyzer. */
	tables: TableIndex;
	panel: FlowPanel;
	home: FlowHome;
	endpointsView: EndpointsView;
	changes: AgentChanges;
	changeSet: ChangeSetProvider;
	boards: BoardStore;
	providerFor(target: FlowTarget): FlowProvider;
	/** The flow the canvas was last asked to show (what an agent calls "the flow on the canvas"). */
	currentFlow: { id: string; label: string } | undefined;
	showEntry(id: string, label: string, source?: Source): Promise<void>;
	showPoly(id: string, label: string): Promise<void>;
	showRoslyn(id: string, label: string): Promise<void>;
	fail(e: unknown): void;
}

/** A timer that is cleared when the extension is disposed. */
const timer = (context: vscode.ExtensionContext, fn: () => void, ms: number) => {
	const t = setTimeout(fn, ms);
	context.subscriptions.push({ dispose: () => clearTimeout(t) });
};

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Insilode', { log: true });
	const analyzer = new Analyzer(context, log);
	const poly = new PolyIndex(context, log);
	// For the harness map: whether the code names an agent's memory mentions still exist.
	context.subscriptions.push(registerResolveNames(poly));
	const polyProvider = new PolyProvider(poly);
	const lsp = new LspProvider();
	const roslyn = new RoslynProvider(analyzer);
	const endpointList = new Endpoints(analyzer, poly, log);
	// Per-workspace: the timeline and Keep/Undo state outlive a restart.
	const changes = agentChanges = new AgentChanges(context.storageUri && vscode.Uri.joinPath(context.storageUri, 'agent-changes.json').fsPath);
	void changes.load();
	const providerFor = (t: FlowTarget) => providers[t.kind];
	const tables = new TableIndex({ entries: () => endpointList.cached(), poly, analyzer });
	const changeSet = new ChangeSetProvider({
		impactOf: (files, limits) => turnImpact(files, { analyzer, poly, endpoints: endpointList, providerFor, rangesOf: f => changes.changedRanges(f), tables }, limits),
		providerFor,
		annotate: root => changes.annotate(root),
	});
	const providers: Record<FlowTarget['kind'], FlowProvider> = { roslyn, poly: polyProvider, lsp, changes: changeSet };
	const panel = new FlowPanel(context, providerFor, changes);
	const boards = new BoardStore({ persist: context.workspaceState, warn: message => log.warn(message) });
	const home = new FlowHome(context, endpointList);
	const endpointsView = new EndpointsView(endpointList);
	context.subscriptions.push(log, analyzer, poly, polyProvider, endpointList, endpointsView, panel, home, changes, changes.onDidChange(() => panel.refreshSoon()));

	const flow: Flow = {
		context, log, analyzer, poly, endpointList, tables, panel, home, endpointsView, changes, changeSet, boards, providerFor, currentFlow: undefined,
		// Roslyn targets need the analyzer up first, so a load failure shows as an error, not an empty tab.
		async showRoslyn(id, label) {
			flow.currentFlow = { id, label };
			home.rememberFlow(id, label, 'roslyn');
			endpointsView.setCurrent(id);
			await analyzer.port();
			await panel.show({ kind: 'roslyn', id }, label);
		},
		async showPoly(id, label) {
			flow.currentFlow = { id, label };
			home.rememberFlow(id, label, 'poly');
			endpointsView.setCurrent(id);
			await panel.show({ kind: 'poly', id }, label);
		},
		showEntry: (id, label, source) => source === 'poly' ? flow.showPoly(id, label) : flow.showRoslyn(id, label),
		fail: e => void vscode.window.showErrorMessage(`Insilode: ${(e as Error)?.message ?? e}`),
	};

	analyzer.warmUp();
	context.subscriptions.push(new FlowTrail(analyzer));
	registerViews(flow);
	registerCommands(flow);
	registerAgentCommands(flow);
	registerLenses(flow);
	wireClaudeCode(flow);
	wireAgentBridge(flow);
	watchSources(flow);
	// A window with nothing open starts on Home instead of an empty editor; so does a folder just trusted (opened in
	// Restricted Mode, Insilode had nothing to show yet), once the trust tab is closed.
	const homeIfEmpty = () => {
		if (!vscode.window.tabGroups.all.some(g => g.tabs.length)) {
			void home.show();
		}
	};
	timer(context, homeIfEmpty, 1200);
	context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
		const sub = vscode.window.tabGroups.onDidChangeTabs(() => {
			if (!vscode.window.tabGroups.all.some(g => g.tabs.length)) {
				sub.dispose();
				homeIfEmpty();
			}
		});
		context.subscriptions.push(sub);
		timer(context, homeIfEmpty, 1200);
	}));
}

function registerViews({ context, home, endpointsView, panel }: Flow) {
	let cursorTimer: NodeJS.Timeout | undefined;
	const settings = new FlowSettings(context);
	context.subscriptions.push(
		settings,
		vscode.commands.registerCommand('flow.home', () => home.show()),
		// The optional argument is a category id or a setting key to open the page on (settingsModel.ts).
		vscode.commands.registerCommand('flow.settings', (target?: unknown) => settings.show(target)),
		vscode.window.registerWebviewViewProvider('flow.endpoints', endpointsView, { webviewOptions: { retainContextWhenHidden: true } }),
		// Editor → canvas sync (debounced: the canvas only needs to follow, not every keystroke).
		vscode.window.onDidChangeTextEditorSelection(e => {
			if (e.textEditor.document.uri.scheme !== 'file') {
				return;
			}
			clearTimeout(cursorTimer);
			cursorTimer = setTimeout(() => panel.cursorMoved(e.textEditor.document.uri.fsPath, e.selections[0].active.line + 1), 150);
		}),
		{ dispose: () => clearTimeout(cursorTimer) },
	);
}

function registerCommands(flow: Flow) {
	const { context, analyzer, poly, endpointList, panel, fail } = flow;
	context.subscriptions.push(
		vscode.commands.registerCommand(Command.showMethod, (id: string, label: string) => flow.showRoslyn(id, label).catch(fail)),
		vscode.commands.registerCommand(Command.showEntry, (id: string, label: string, source?: Source) => flow.showEntry(id, label, source).catch(fail)),
		vscode.commands.registerCommand(Command.showTarget, (target: FlowTarget, label: string) => {
			flow.currentFlow = { id: target.kind === 'lsp' ? `${target.uri}#${target.line}` : target.id, label };
			return panel.show(target, label).catch(fail);
		}),
		vscode.commands.registerCommand('flow.pickSolution', () => analyzer.pickSolution().catch(fail)),
		// A hand-written tour file played on the canvas (guided tours, phase 0): the player an agent's tours will use too.
		vscode.commands.registerCommand('flow.tour.playFile', (file?: unknown) => playTourFile(flow, file).catch(fail)),
		// Home's "Take the tour": the bundled sample tour (sampleTour.ts).
		vscode.commands.registerCommand('flow.tour.playSample', () => playSampleTour(flow).catch(fail)),

		vscode.commands.registerCommand('flow.showAtCursor', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) {
				return;
			}
			const { document } = editor;
			const pos = editor.selection.active;
			const notice = (message: string | undefined) => {
				if (message) {
					void vscode.window.showInformationMessage(message);
				}
			};
			const viaLanguageServer = () => {
				// getText() of no range is the whole document: a cursor off any word must not title the tab with the file.
				const range = document.getWordRangeAtPosition(pos);
				const word = (range && document.getText(range).slice(0, 60)) || 'Flow';
				return panel.show({ kind: 'lsp', uri: document.uri.toString(), line: pos.line, character: pos.character }, word).catch(fail);
			};
			if (POLY_LANGUAGES.has(document.languageId)) {
				try {
					const hit = await poly.functionAt(document.uri.fsPath, pos.line + 1);
					if (hit) {
						await flow.showPoly(hit.id, hit.label);
						return;
					}
					notice(cursorNotice({ languageId: document.languageId, reason: 'outside-function', falling: true }));
				} catch {
					// the index is not up: fall back to the language server below
					notice(cursorNotice({ languageId: document.languageId, reason: 'index-not-ready', falling: true }));
				}
				await viaLanguageServer();
				return;
			}
			if (document.languageId !== 'csharp' || !await analyzer.hasSolution()) {
				// Any other language: ask its language server about the function under the cursor.
				notice(cursorNotice({ languageId: document.languageId, reason: 'no-solution', falling: true }));
				await viaLanguageServer();
				return;
			}
			try {
				const hit = innermost(await analyzer.methods(document.uri.fsPath), pos.line + 1);
				if (!hit) {
					notice(cursorNotice({ languageId: document.languageId, reason: 'outside-function', falling: false }));
					return;
				}
				await flow.showRoslyn(hit.id, hit.name);
			} catch (e) {
				fail(e);
			}
		}),

		vscode.commands.registerCommand('flow.pickEndpoint', async () => {
			// Show the cached list at once; swap in the fresh one when the backends answer.
			const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { e: Entry }>();
			qp.title = 'Insilode: open an endpoint';
			qp.matchOnDescription = true;
			qp.matchOnDetail = true;
			// The route first, as a developer reads it; the service and handler after it, the file on the second line.
			const toItems = (eps: Entry[]) => eps.map(e => {
				const rel = vscode.workspace.asRelativePath(e.file);
				return { label: e.http, description: entryDisplay(e, rel).detail, detail: rel, e };
			});
			qp.items = toItems(endpointList.cached());
			qp.busy = true;
			// An empty list says why: still indexing (and how far), or nothing found. A large first index takes a while.
			const waiting = () => {
				const p = poly.isReady ? undefined : poly.progress;
				qp.placeholder = qp.items.length ? undefined
					: p ? `Indexing the workspace: ${p.done.toLocaleString()} of ${p.total.toLocaleString()} files…`
						: 'Looking for endpoints…';
			};
			waiting();
			const progress = poly.onDidProgress(waiting);
			qp.onDidAccept(() => {
				const pick = qp.selectedItems[0];
				qp.hide();
				if (pick) {
					flow.showEntry(pick.e.id, entryName(pick.e), pick.e.source).catch(fail);
				}
			});
			qp.onDidHide(() => {
				progress.dispose();
				qp.dispose();
			});
			qp.show();
			try {
				const fresh = await endpointList.fresh(problem => fail(new Error(problem)));
				const filter = qp.value;
				qp.items = toItems(fresh);
				qp.value = filter;
			} catch (e) {
				fail(e);
			} finally {
				qp.busy = false;
				progress.dispose();
				qp.placeholder = qp.items.length ? undefined
					: 'No endpoints found in this folder. Put the cursor in any method and run "Show Flow at Cursor".';
			}
		}),
	);
}

/** Commands flow-agent and the canvas call around an agent's writes. */
function registerAgentCommands({ context, panel, changes }: Flow) {
	context.subscriptions.push(
		// Called by flow-agent around agent writes (see extensions/flow-agent/src/sessionType.ts).
		vscode.commands.registerCommand('flow.agentWillEdit', (files: string[]) => changes.willEdit(files)),
		vscode.commands.registerCommand('flow.agentDidEdit', async (files?: string[]) => {
			await changes.didEdit(files ?? []);
			panel.refreshSoon();
		}),
		// Called by flow-agent at the end of a turn with the files a shell command changed (agent edit tools did not report them).
		vscode.commands.registerCommand('flow.agent.commandEdited', async (files?: unknown) => {
			await changes.commandEdited(Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string') : []);
			panel.refreshSoon();
		}),
		vscode.commands.registerCommand('flow.agentProposes', (p: Parameters<FlowPanel['propose']>[0]) => panel.propose(p)),
		vscode.commands.registerCommand('flow.agentProposalDone', () => panel.proposalDone()),
		vscode.commands.registerCommand('flow.agentTurn', (prompt: string, agent: string) => changes.startTurn(prompt, agent)),
		// flow-agent's gaze: where its agents read and edit, painted on an open canvas only (panel.ts).
		vscode.commands.registerCommand('flow.agent.gaze', (batch: unknown) => panel.gaze(batch)),

		// "Ask the agent about this flow": the flow as a markdown file handed to the chosen agent, so it reads
		// exact file:line spans instead of searching for them.
		vscode.commands.registerCommand(Command.askAgent, async (rawLabel: unknown, rawText: unknown) => {
			// Checked again here: any extension can run this command, and the label becomes a file name.
			const ask = parseFlowAsk(rawLabel, rawText);
			if (!ask) {
				return;
			}
			const { label, text: flowText } = ask;
			const dir = vscode.Uri.joinPath(context.globalStorageUri, 'flows');
			await vscode.workspace.fs.createDirectory(dir);
			const file = vscode.Uri.joinPath(dir, `${label.replace(/[^\w.-]+/g, '_')}.flow.md`);
			await vscode.workspace.fs.writeFile(file, Buffer.from(flowText, 'utf8'));
			// The file goes separately: flow-agent refers to it the way the chosen agent reads it. The question is left for the user to finish.
			if (await askInDock(`About this flow (${label}): `, false, 'Ask about this flow', [file.fsPath])) {
				return;
			}
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				query: `About the attached flow (${label}): `,
				isPartialQuery: true,
				attachFiles: [file],
			});
		}),
	);
}

function registerLenses({ context, analyzer, poly }: Flow) {
	const roslynLenses = new RoslynLenses(analyzer);
	const polyLenses = new PolyLenses(poly);
	context.subscriptions.push(
		roslynLenses,
		polyLenses,
		vscode.languages.registerCodeLensProvider({ language: 'csharp', scheme: 'file' }, roslynLenses),
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new LspLenses()),
		vscode.languages.registerCodeLensProvider([...POLY_LANGUAGES].map(language => ({ language, scheme: 'file' })), polyLenses),
	);
}

/** Claude Code in a terminal connects to Insilode with /ide: its diffs open here and on the canvas. */
function wireClaudeCode({ context, log, panel, changes }: Flow) {
	const bridge = new ClaudeIdeBridge(context, {
		propose: p => panel.proposeSpans(p),
		proposalDone: id => panel.proposalDone(id),
		willEdit: async (file, prompt) => {
			changes.ensureTurn(prompt, 'Claude Code (terminal)');
			await changes.willEdit([file]);
		},
		didEdit: file => changes.didEdit([file]),
		refresh: () => panel.refreshSoon(),
	});
	panel.onAnswer = (id, accept) => bridge.answer(id, accept);
	panel.onMention = (file, start, end) => bridge.mention(file, start, end);
	context.subscriptions.push(bridge,
		...registerSelectionActions(),
		vscode.commands.registerCommand('flow.ide.accept', () => bridge.answer(undefined, true)),
		vscode.commands.registerCommand('flow.ide.reject', () => bridge.answer(undefined, false)),
		vscode.commands.registerCommand('flow.ide.mention', () => {
			const ed = vscode.window.activeTextEditor;
			if (ed) {
				bridge.mention(ed.document.uri.fsPath, ed.selection.start.line, ed.selection.end.line);
			}
		}),
		vscode.commands.registerCommand('flow.ide.howTo', async () => {
			const pick = await vscode.window.showQuickPick([
				{ label: '$(terminal) Run claude in an Insilode terminal', detail: 'Connects automatically: diffs open in Insilode, your selection is shared', run: 'term' },
				{ label: '$(plug) Already running claude elsewhere?', detail: 'Type /ide in it and pick "Insilode"', run: '' },
				{ label: '$(tools) Give every claude the Insilode tools (MCP)', detail: 'So it can open files and flows here and draw diagrams. Asks before changing anything', run: 'mcp' },
			], { title: bridge.isConnected ? 'Claude Code is connected' : 'Connect Claude Code to Insilode' });
			if (pick?.run === 'mcp') {
				void vscode.commands.executeCommand('flow.mcp.connect');
			} else if (pick?.run === 'term') {
				const t = vscode.window.createTerminal({ name: 'Claude' });
				t.show();
				t.sendText('claude');
			}
		}),
	);
	void bridge.start(log);
}

/** The tables, enums and modules the code index knows, for the Board from Code quick pick (what is not indexed yet is simply missing; `indexReady` says so). */
async function scopeSource({ poly, log }: Pick<Flow, 'poly' | 'log'>): Promise<ScopeSource> {
	const schemas = poly.isReady ? await poly.schemas().catch(() => []) : [];
	const graph = await TypeService.get(log).getGraph().catch(() => undefined);
	const types = graph?.types ?? [];
	return {
		tables: [
			...schemas.map(s => ({ name: s.table, detail: s.entity && s.entity !== s.table ? s.entity : undefined })),
			...types.filter(t => t.role === 'entity').map(t => ({ name: t.name, detail: 'entity' })),
		],
		enums: types.filter(t => t.kind === 'enum').map(t => ({ name: t.name, detail: t.module })),
		modules: [...new Set(types.map(t => t.module))],
		indexReady: poly.isReady,
	};
}

/**
 * Agents act on Insilode through the `insilode` MCP server (tools: open, find_entry_points, show_flow, flow_text, impact,
 * get_context, draw_board, update_board): this window serves them on a local port and lists itself in ~/.insilode/bridge.
 * Boards (diagrams and plans an agent drew) are held by a store (saved in the workspace state) and drawn on the board canvas; the Markdown viewer is the fallback and the export.
 */
function wireAgentBridge(flow: Flow) {
	const { context, log, boards, endpointList, analyzer, poly, panel } = flow;
	const viewer = new MarkdownBoardViewer(context, boards, log);
	// Boards (an agent's plans and diagrams, the DTO and architecture views) are drawn on the board canvas; the Markdown
	// viewer stays as the fallback when the canvas cannot open one.
	const boardPanel = registerTypeViews({ context, log });
	const canvas = boardPanel.asHost();
	boardPanel.setStore(boards);
	boards.setOpenCheck(id => boardPanel.isBoardOpen(id));
	// The limit pushed a board out: say it once (never a silent drop). Plan boards and open boards are kept.
	boards.setOnEvict(board => void vscode.window.showInformationMessage(`Insilode keeps the ${MAX_BOARDS} newest boards: "${board.spec.title}" was the oldest and was removed. Boards that are open in a tab or come from a plan are never removed.`));
	boards.setHost({
		show: async (id, spec, extra) => {
			try {
				await canvas.show(id, spec, extra);
			} catch (e) {
				log.warn(`Board canvas failed (${(e as Error).message}): showing the board as Markdown`);
				await viewer.show(id, spec);
			}
		},
		update: async (id, spec, extra) => {
			try {
				await canvas.update(id, spec, extra);
			} catch (e) {
				log.warn(`Board canvas update failed: ${(e as Error).message}`);
				await viewer.update(id, spec);
			}
		},
	});
	// Skeleton first: the plan board against the type index, the stages the dock drives (docs/design/skeleton-first.md).
	const skeleton = new SkeletonHost(boards, TypeService.get(log), log, context.workspaceState);
	const bridge = new AgentBridge({
		log, endpoints: endpointList, analyzer, poly, boards, tables: flow.tables, skeleton, types: TypeService.get(log),
		providerFor: flow.providerFor,
		showEntry: (id, label, source) => flow.showEntry(id, label, source),
		showTarget: async (target, label) => {
			flow.currentFlow = { id: target.kind === 'lsp' ? `${target.uri}#${target.line}` : target.id, label };
			await panel.show(target, label);
		},
		currentFlow: () => flow.currentFlow,
		shownTarget: () => panel.shown?.target,
		tours: { play: (tour, session) => panel.playTour(tour, session), state: () => panel.tourState(), go: index => panel.tourGo(index), steps: () => panel.tourSteps(), edit: (steps, index, map) => panel.editTour(steps, index, map), note: (index, text) => panel.pinNote(index, text), resume: () => panel.tourResume(), end: () => panel.endTour() },
		// The Agents dock (flow-agent) knows each session's name and colour; an agent it did not start is not known.
		describeAgent: async session => {
			const look = await Promise.resolve(vscode.commands.executeCommand<{ label?: unknown; color?: unknown } | undefined>('flow.agent.describe', session)).catch(() => undefined);
			return typeof look?.label === 'string' && typeof look.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(look.color) ? { label: look.label.slice(0, 40), color: look.color } : undefined;
		},
		trackChanges: async (entries, base) => {
			await flow.changes.trackAgainst(base ? `Changes since ${base}` : 'Git changes', GIT_AGENT, entries, base);
			panel.refreshSoon();
		},
		showChanges: async set => {
			const target = flow.changeSet.use(set);
			flow.currentFlow = { id: target.id, label: set.label };
			await panel.show(target, set.label);
			// The trace the canvas draws: what the agent is told comes from the same one.
			return flow.changeSet.latest()!;
		},
	}, log);
	context.subscriptions.push(
		viewer, bridge, boardPanel, TypeService.get(log), skeleton, registerHarnessFlow(context, log),
		// The boards are saved shortly after a change; the last change must reach the workspace state before the host exits.
		{ dispose: () => { boards.setHost(undefined); void boards.flush(); } },
		// flow-agent calls these around an agent's work (see extensions/flow-agent/src/agents.ts); they never throw into the hook.
		vscode.commands.registerCommand('flow.agent.plan', async (session: string, plan: string, planFile?: string) => {
			if (typeof session !== 'string' || typeof plan !== 'string' || !plan.trim()) {
				return;
			}
			const spec = parsePlan(plan.slice(0, 200_000), await planResolvers(plan, endpointList));
			await boards.set(spec, { id: `plan:${session}`, origin: 'plan', session, planFile });
		}),
		// Boards without an agent: the flow on the canvas, kept as a board (see board/fromFlow.ts).
		vscode.commands.registerCommand('flow.board.pinFlow', async () => {
			const shown = flow.panel.shown;
			if (!shown) {
				void vscode.window.showInformationMessage('Insilode: open a flow first (Open Endpoint Flow… or Show Flow at Cursor), then pin it.');
				return;
			}
			try {
				const graph = await flow.providerFor(shown.target).graph(shown.target);
				await boards.set(flowToBoard(graph, shown.label), { origin: 'user' });
			} catch (e) {
				flow.fail(e);
			}
		}),
		// The canvas action for board_from_code: the user picks the kind and then the scope from what the index has, and Insilode draws the board.
		vscode.commands.registerCommand('flow.board.fromCode', async () => {
			const target = flow.panel.shown?.target;
			const flowTarget = target && target.kind !== 'lsp' ? target : undefined;
			const kind = await vscode.window.showQuickPick(
				kindChoices(!!flowTarget).map(k => ({ label: k.label, description: k.description, choice: k })),
				{ title: 'Insilode: Board from Code', placeHolder: 'Which diagram, drawn from the code?' },
			);
			if (!kind) {
				return;
			}
			let scope: Record<string, unknown> = {};
			if (kind.choice.kind === 'sequence') {
				if (!flowTarget) {
					void vscode.window.showInformationMessage('Insilode: open a flow first (Open Endpoint Flow… or Show Flow at Cursor), then draw its sequence.');
					return;
				}
				scope = { id: flowTarget.id };
			} else {
				const source = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Insilode: reading the index…' }, () => scopeSource(flow));
				const items = scopeChoices(kind.choice.kind, source);
				const picked = await vscode.window.showQuickPick(
					items.map(i => ({ label: i.label, description: i.description, scope: i.scope })),
					{ title: `Insilode: ${kind.label} from Code`, placeHolder: { er: 'Which table? (type to search)', architecture: 'Which module? (type to search)', state: 'Which enum? (type to search)' }[kind.choice.kind] },
				);
				if (!picked) {
					return;
				}
				scope = picked.scope;
			}
			const answer = await bridge.boardFromCode({ kind: kind.choice.kind, scope });
			if (!answer.ok || /^No \w+ board was drawn/.test(answer.message)) {
				// The whole answer: its second line is usually the reason.
				void vscode.window.showWarningMessage(`Insilode: ${boardFromCodeMessage(answer.message)}`);
				return;
			}
			// A board built from a partial index or from guesses is drawn, but the user should know it may be incomplete.
			const partial = answer.message.split('\n').filter(l => /^- .*(still building|guesses)/.test(l)).map(l => l.slice(2));
			if (partial.length) {
				void vscode.window.showInformationMessage(`Insilode: ${partial.join(' ')}`);
			}
		}),
		vscode.commands.registerCommand('flow.agent.edited', async (session: string, files: string[], phase: 'before' | 'after') => {
			if (typeof session === 'string' && Array.isArray(files)) {
				void skeleton.agentEdited(session, files.filter(f => typeof f === 'string'), phase).catch(e => log.warn(`skeleton: ${(e as Error).message}`));
			}
			for (const board of boards.forSession(session)) {
				for (const file of files ?? []) {
					for (const node of nodesLinkedTo(board.spec, file)) {
						const status = statusAfterEdit(node.status, phase);
						if (status !== node.status) {
							await boards.updateNode(board.id, node.id, { status }).catch(() => undefined);
						}
					}
				}
			}
		}),
		// flow-agent's dock lists the flows; the changed methods' targets stay here. Their names and files go along, so the
		// dock can tell two agents that change the same method apart from two that only share a file.
		vscode.commands.registerCommand('flow.agent.turnImpact', async (files: string[]) => {
			const { changed, tables: changedTables, ...impact } = await turnImpact(Array.isArray(files) ? files.filter(f => typeof f === 'string') : [], { analyzer, poly, endpoints: endpointList, providerFor: flow.providerFor, rangesOf: f => flow.changes.changedRanges(f), tables: flow.tables });
			// The dock only says "and table orders (4 endpoints)": the endpoints themselves stay here.
			return { ...impact, methods: changed.slice(0, 40).map(m => ({ file: m.file, name: m.name })), tables: changedTables.map(t => ({ table: t.table, entity: t.entity ?? t.mapped, entityChanged: !!t.entity, migration: t.migrations[0]?.name, endpoints: t.endpoints, guess: t.guess, partial: t.checked < t.of })) };
		}),
	);
	context.subscriptions.push(
		// "Show the git changes on the flow canvas": from a diff editor's title (its resource, when it is a file, narrows it to that file),
		// the Source Control title, or the command palette. Asks what to compare with: the work since the branch began is
		// what a finished development is reviewed by.
		vscode.commands.registerCommand('flow.diff.showInFlow', async (resource?: unknown) => {
			const only = resource instanceof vscode.Uri && resource.scheme === 'file' ? [resource.fsPath] : undefined;
			const pick = await vscode.window.showQuickPick([
				{ label: 'Uncommitted changes', description: 'against HEAD', base: 'uncommitted' as const },
				{ label: 'This branch', description: 'everything since it left main, committed or not', base: 'branch' as const },
				{ label: 'Last commit', description: 'the last commit and anything uncommitted on top', base: 'last_commit' as const },
			], { title: 'Show Changes in Flow', placeHolder: 'Which changes?' });
			if (!pick) {
				return;
			}
			const r = await bridge.showChangesInFlow(only, pick.base);
			if (!r.opened) {
				void vscode.window.showInformationMessage(`Insilode: ${r.message}`);
			}
		}),
		// flow-agent's dock, on an agent worktree's row: its branch since it left `base`, as a diff and on the flow canvas.
		vscode.commands.registerCommand('flow.diff.showWorktree', async (root: unknown, base: unknown) => {
			if (typeof root !== 'string' || typeof base !== 'string') {
				return;
			}
			const r = await bridge.showWorktreeInFlow(root, base);
			if (!r.opened) {
				void vscode.window.showInformationMessage(`Insilode: ${r.message}`);
			}
		}),
	);
	registerMcpCommands(context, log);
	void migrateLegacySettings(log);
	void bridge.start();
}

/** Moves settings written under the old name (Axle) to the new ones, in the scope they were set in (see legacySettings.ts). */
async function migrateLegacySettings(log: vscode.LogOutputChannel) {
	const targets = { global: vscode.ConfigurationTarget.Global, workspace: vscode.ConfigurationTarget.Workspace, folder: vscode.ConfigurationTarget.WorkspaceFolder };
	const config = vscode.workspace.getConfiguration();
	for (const u of legacySettingUpdates(key => config.inspect(key))) {
		try {
			await config.update(u.key, u.value, targets[u.scope]);
			log.info(`Moved the setting ${u.key} (${u.scope}) from its name before the rename.`);
		} catch (e) {
			log.warn(`Could not move the setting ${u.key} (${u.scope}): ${(e as Error).message}`);
		}
	}
}

/** Any change on disk (editor save, agent edit, git checkout) re-draws the open flow. */
function watchSources({ context, panel }: Flow) {
	const watcher = vscode.workspace.createFileSystemWatcher('**/*.{cs,ts,tsx,js,jsx,java,kt,py,go,rs,php,rb}');
	context.subscriptions.push(
		watcher,
		watcher.onDidChange(() => panel.refreshSoon()),
		watcher.onDidCreate(() => panel.refreshSoon()),
		// LSP flows read documents directly, so a save is enough to refresh them.
		vscode.workspace.onDidSaveTextDocument(() => panel.refreshSoon()),
	);
}

/** Kept for `deactivate`: the timeline must be on disk before the extension host exits. */
let agentChanges: AgentChanges | undefined;

export function deactivate() {
	return agentChanges?.flushNow();
}
