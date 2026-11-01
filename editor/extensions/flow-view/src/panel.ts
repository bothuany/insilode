/*---------------------------------------------------------------------------------------------
 *  Insilode: the canvas (custom-ide/ui, webview build) in one reusable editor tab. The webview never
 *  talks to a backend itself: it asks this host, which routes to the provider for the target.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CanvasToHostTour, Tour } from '../../../../protocol/flow';
import type { AgentChanges } from './agentDiff';
import { askInDock } from './askAgent';
import { Command } from './commands';
import { agentContext } from './harness';
import { CardLanguage, cardQuery } from './language';
import { CardOverlays } from './overlay';
import type { FlowNode, FlowProvider, FlowTarget } from './providers';
import { flowRoot } from './root';
import { MAX_NOTES, noteText, parseFlowAsk, parsePointAsk, parseTourAsk, place, selectionPrompt, tourAskPrompt } from './tour/ask';
import { parseTourRun, runWait, WAIT_COMMANDS } from './tour/wait';
import { readTextIn } from './tour/files';
import { GazeLog, gazeTour, parseGaze } from './tour/gaze';
import { tourReport } from './tour/validate';
import { TypeService } from './types/typeService';

interface Request {
	type: 'request';
	id: number;
	op: 'graph' | 'callers' | 'save' | 'keep' | 'undo' | 'impact' | 'context' | 'timeline' | 'undoFrom' | 'editHooks' | 'complete' | 'signature' | 'hover' | 'definition' | 'endEdit' | 'typeChips' | 'typeDetail';
	turn?: number;
	target?: FlowTarget;
	file?: string;
	startLine?: number;
	endLine?: number;
	original?: string;
	code?: string;
	/** An open card editor (one id per opening): the document shows its text for the language servers, and gets the original back when it closes. */
	session?: string;
	trigger?: string;
	/** typeChips: the cards to find the types of, by the key the canvas gave each (`line` is where the method starts). */
	nodes?: { key: string; file: string; line: number; endLine?: number }[];
	/** typeDetail: a type id or a name as written in `fromFile`, and how many levels of the types its fields refer to to include. */
	ref?: string;
	fromFile?: string;
	depth?: number;
}

/** Registered by the type diagrams (typeviews.ts): the canvas offers "show in the diagram" only when it exists. */
const FOCUS_TYPE = 'flow.types.focusType';
/** The commands a hands-on tour step may run (tour/wait.ts); the id is checked against this set right where it runs. */
const WAIT_ALLOWED = new Set<string>(WAIT_COMMANDS);

const normalize = (s: string) => s.replace(/\r\n/g, '\n');

/** Test code: a test project folder (Foo.Tests, Foo.Test.Unit, tests/, __tests__/) or a test file name. */
const TEST_DIR = /[\\/](?:[^\\/]*[.-]tests?(?:[.-][^\\/]*)?|tests?|__tests__|spec)[\\/]/i;
const TEST_FILE = /(?:[a-z0-9_]Tests?|[.-](?:test|spec))\.\w+$/;
/** Judged by the path inside the workspace: a checkout that itself lives under `tests/` is not all test code. */
const isTest = (file: string) => TEST_DIR.test('/' + vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/')) || TEST_FILE.test(file);

/** A file the canvas may ask about: inside a workspace folder, spelled the way VS Code spells it. */
function workspaceFile(file: unknown): string | undefined {
	if (typeof file !== 'string' || !file) {
		return undefined;
	}
	// `..` and `.` are collapsed first: the folder check below is on the spelling, and `C:\ws\..\secret` is not inside C:\ws.
	const uri = vscode.Uri.file(path.resolve(file));
	return vscode.workspace.getWorkspaceFolder(uri) ? uri.fsPath : undefined;
}

const roots = () => vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) ?? [];

/**
 * A flow shows how the application runs; tests calling into it are noise there. Callers and callees in
 * test code are dropped (unless `flow.showTests` is on), together with everything only they reach.
 */
function withoutTests<T extends FlowNode | null>(node: T): T {
	if (!node || vscode.workspace.getConfiguration('flow').get<boolean>('showTests', false)) {
		return node;
	}
	const prune = (n: FlowNode): FlowNode => ({ ...n, children: n.children.filter(c => !(c.node.file && isTest(c.node.file))).map(c => ({ ...c, node: prune(c.node) })) });
	return prune(node) as T;
}

export class FlowPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private readonly dist: string;
	/** The card being edited, shown to the language servers (see overlay.ts). */
	private readonly overlays = new CardOverlays();
	private readonly language = new CardLanguage(this.overlays);
	private refreshTimer: NodeJS.Timeout | undefined;

	constructor(context: vscode.ExtensionContext, private readonly providerFor: (t: FlowTarget) => FlowProvider, private readonly changes: AgentChanges) {
		this.dist = path.join(flowRoot(context.extensionPath), 'ui', 'dist-webview');
	}

	/** The tab being created: a second `show` waits for it instead of posting to a webview that is not listening yet. */
	private opening: Promise<void> | undefined;
	/** The webview has sent its first message, so it is listening. */
	private webviewReady = false;
	/** Callers waiting for the webview to listen (a tour sent to a canvas that was just opened). */
	private readonly listening: (() => void)[] = [];
	/** The tour the canvas was last sent, and where the reader is in it: the canvas may only report on a tour that came from here. */
	private playing: { id: string; steps: number; tour: Tour; session?: string } | undefined;
	tourAt: { index: number; paused: boolean } | undefined;
	/** The reader's last question about a step, and whether the agent has answered it yet (an answer is a note and a resume). */
	private asked: { index: number; question: string } | undefined;
	private asking = false;
	/** Notes an agent pinned to each step of the playing tour. */
	private readonly noteCount = new Map<number, number>();
	/** A question the reader pointed at a card: the tour the agent answers it with starts with it as its first note. */
	private pointed: { question: string; at: number } | undefined;

	/** The flow the canvas was last asked to show: what "Pin Flow as Board" pins. */
	shown: { target: FlowTarget; label: string } | undefined;

	async show(target: FlowTarget, label: string) {
		this.shown = { target, label };
		if (this.opening) {
			await this.opening;
		}
		if (this.panel) {
			this.panel.title = `Flow: ${label}`;
			this.panel.reveal(undefined, true);
			await this.panel.webview.postMessage({ type: 'show', target, label });
			return;
		}
		this.opening = this.open(target, label).finally(() => { this.opening = undefined; });
		await this.opening;
	}

	private async open(target: FlowTarget, label: string) {
		// A tab in the group the user is in, not a new split: an agent's flow or tour must not feel like another window. preserveFocus keeps the caret where it was.
		const panel = vscode.window.createWebviewPanel('flow.canvas', `Flow: ${label}`, { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		try {
			panel.webview.html = await this.html(panel.webview, target, label);
		} catch (e) {
			// The canvas build is missing: no blank tab left behind, and the next `show` starts over.
			panel.dispose();
			throw new Error(`The canvas is not built (${(e as Error).message}). Run \`npm run setup\`.`);
		}
		panel.iconPath = new vscode.ThemeIcon('type-hierarchy-sub');
		this.webviewReady = false;
		panel.onDidDispose(() => {
			this.webviewReady = false;
			this.panel = undefined;
			this.playing = undefined;
			this.tourAt = undefined;
			this.asked = undefined;
			this.asking = false;
			this.listening.splice(0).forEach(done => done());
			// A card still being edited goes back to the file as it was: the canvas that would have saved it is gone.
			void this.overlays.closeAll();
		});
		panel.webview.onDidReceiveMessage(m => {
			// The canvas asks for its graph as soon as it runs: its first message means it listens, so a waiting proposal can go now.
			if (!this.webviewReady) {
				this.webviewReady = true;
				this.postWaiting();
				this.postRecentGaze();
				this.listening.splice(0).forEach(done => done());
			}
			this.onMessage(m).catch(e => vscode.window.showErrorMessage(`Insilode: ${(e as Error).message ?? e}`));
		});
		this.panel = panel;
	}

	/** Disk changed (user save, agent edit, git): providers re-read it; ask the canvas to re-fetch. */
	refreshSoon() {
		if (!this.panel) {
			return;
		}
		clearTimeout(this.refreshTimer);
		// The Roslyn analyzer debounces its own file watcher by 300 ms.
		this.refreshTimer = setTimeout(() => this.panel?.webview.postMessage({ type: 'refresh' }), 800);
	}

	/**
	 * An agent asks to edit: tell the canvas which lines each proposed diff replaces, so it can mark those
	 * methods while the user decides. `oldText` is located in the current file; a new file marks nothing.
	 */
	async propose(p: { agent: string; title: string; files: string[]; diffs: { path: string; oldText: string | null; newText: string }[] }) {
		if (!this.panel) {
			return;
		}
		const spans: { file: string; start: number; end: number }[] = [];
		for (const d of p.diffs) {
			if (!d.oldText) {
				continue;
			}
			const text = (await fs.readFile(d.path, 'utf8').catch(() => '')).replace(/\r\n/g, '\n');
			const at = text.indexOf(d.oldText.replace(/\r\n/g, '\n'));
			if (at < 0) {
				continue;
			}
			const start = text.slice(0, at).split('\n').length;
			spans.push({ file: d.path, start, end: start + d.oldText.split('\n').length - 1 });
		}
		// Without exact lines (no diff, or text not found), mark every card in the file.
		const files = p.files.filter(f => !spans.some(s => s.file === f));
		await this.panel.webview.postMessage({ type: 'proposal', proposal: { agent: p.agent, title: p.title, spans, files } });
	}

	/** A proposal from the Claude Code CLI: exact spans, and the canvas offers Accept / Reject for it. */
	proposeSpans(p: { id: string; agent: string; title: string; files: string[]; spans: { file: string; start: number; end: number }[] }) {
		this.waiting.set(p.id, { ...p, answerable: true });
		this.postWaiting();
	}

	/** CLI proposals still waiting for an answer, by id: a canvas opened later shows them too. */
	private readonly waiting = new Map<string, object>();

	/** The canvas shows one proposal at a time: the newest one still waiting, or none. */
	private postWaiting() {
		if (this.webviewReady) {
			void this.panel?.webview.postMessage({ type: 'proposal', proposal: [...this.waiting.values()].at(-1) ?? null });
		}
	}

	/** Set by the extension: the canvas answered a CLI proposal, or asked to @-mention a card in the CLI. */
	onAnswer: ((id: string, accept: boolean) => void) | undefined;
	onMention: ((file: string, start: number, end: number) => void) | undefined;

	/** `id`: a CLI proposal that was answered; without it (flow-agent's own proposal) only the marks are cleared. */
	proposalDone(id?: string) {
		if (id !== undefined) {
			this.waiting.delete(id);
		}
		this.postWaiting();
	}

	/**
	 * Plays a tour on the canvas that is open (or has just been asked to open: `show` first). It replaces the tour that was playing.
	 * The canvas starts it once the flow it shows is drawn; nothing here opens, reveals or focuses anything.
	 */
	async playTour(tour: Tour, session?: string) {
		if (this.opening) {
			await this.opening;
		}
		const panel = this.panel;
		if (!panel) {
			throw new Error('There is no flow canvas to play the tour on. Open a flow first.');
		}
		if (!this.webviewReady) {
			await new Promise<void>(done => this.listening.push(done));
		}
		if (this.panel !== panel) {
			throw new Error('The flow canvas was closed before the tour could start.');
		}
		// The question the reader pointed at a card is the first note of the tour that answers it.
		const pointed = this.pointed;
		this.pointed = undefined;
		if (pointed && Date.now() - pointed.at < 15 * 60_000 && tour.source === 'agent' && tour.steps[0]) {
			tour.steps[0].notes = [{ text: pointed.question, by: 'user' as const, at: pointed.at }, ...(tour.steps[0].notes ?? [])].slice(0, MAX_NOTES);
		}
		// The tour plays in its tab: bring it forward when another tab (a board, a file) is on top, without taking the keyboard.
		panel.reveal(undefined, true);
		this.playing = { id: tour.id, steps: tour.steps.length, tour, session };
		this.tourAt = undefined;
		this.asked = undefined;
		this.asking = false;
		this.noteCount.clear();
		await panel.webview.postMessage({ type: 'tour', tour });
	}

	/** The tour playing on the canvas and where the reader is in it (the canvas reports it), for an agent that asks. */
	tourState(): { id: string; steps: number; index: number | undefined; paused: boolean; asking: boolean; session?: string } | undefined {
		return this.playing && { id: this.playing.id, steps: this.playing.steps, index: this.tourAt?.index, paused: this.tourAt?.paused ?? false, asking: this.asking, session: this.playing.session };
	}

	/** Pins an agent's answer to a step (a note on its card, shown until the tour ends). A message names what is wrong, nothing when it was pinned. */
	async pinNote(index: number, text: string): Promise<string | undefined> {
		const playing = this.playing;
		const clean = noteText(text);
		if (!playing || !this.panel) {
			return 'No tour is playing.';
		}
		if (!clean) {
			return '`text` is required: the note to pin.';
		}
		if (!Number.isInteger(index) || index < 0 || index >= playing.steps) {
			return `step must be between 1 and ${playing.steps}.`;
		}
		const count = this.noteCount.get(index) ?? 0;
		if (count >= MAX_NOTES) {
			return `Step ${index + 1} already has ${MAX_NOTES} notes.`;
		}
		this.noteCount.set(index, count + 1);
		// The note answers the question that was asked about this step, when there was one: the bubble shows both.
		const question = this.asked?.index === index ? this.asked.question : undefined;
		await this.panel.webview.postMessage({ type: 'tourNote', id: playing.id, index, note: { text: clean, by: 'agent', at: Date.now(), ...(question ? { question } : {}) } });
		return undefined;
	}

	/** The agent answered: the tour goes on (the reader may also press play first). */
	async tourResume() {
		this.asking = false;
		if (this.playing && this.panel) {
			await this.panel.webview.postMessage({ type: 'tourResume', id: this.playing.id });
		}
	}

	/** The reader's question goes to the agent that made the tour when the host knows it, else to the agent the user chose for questions. */
	private async askAgent(prompt: string, origin: string, files: string[], session?: string) {
		if (await askInDock(prompt, true, origin, files, { session })) {
			return;
		}
		await vscode.commands.executeCommand('workbench.action.chat.open', { query: prompt, isPartialQuery: false, attachFiles: files.map(f => vscode.Uri.file(f)) });
	}

	private rel(file: string) {
		return vscode.workspace.asRelativePath(file, false).replace(/\\/g, '/');
	}

	/** Moves the reader of the playing tour to a step (the agent answers a question and points at the code that does). */
	async tourGo(index: number) {
		if (this.playing && this.panel && index >= 0 && index < this.playing.steps) {
			await this.panel.webview.postMessage({ type: 'tourStep', id: this.playing.id, index });
		}
	}

	/** The steps of the playing tour as the host holds them. */
	tourSteps() {
		return this.playing?.tour.steps;
	}

	/** An agent's edit of the playing tour: the new list replaces the steps and the reader stays where `index` says, paused or waiting as they were. */
	async editTour(steps: Tour['steps'], index: number) {
		const playing = this.playing;
		if (!playing || !this.panel || !steps.length) {
			return;
		}
		const tour = { ...playing.tour, steps };
		this.playing = { ...playing, steps: steps.length, tour };
		// The per-step note counts follow the steps: a kept step keeps its notes, a new one starts without.
		this.noteCount.clear();
		steps.forEach((s, i) => s.notes?.length && this.noteCount.set(i, s.notes.length));
		const at = Math.max(0, Math.min(index, steps.length - 1));
		if (this.tourAt) {
			this.tourAt = { index: at, paused: this.tourAt.paused };
		}
		if (this.asked && this.asked.index >= steps.length) {
			this.asked = undefined;
		}
		await this.panel.webview.postMessage({ type: 'tourSteps', id: playing.id, steps, index: at });
	}

	/** Closes the playing tour, from the agent's side. */
	async endTour() {
		const playing = this.playing;
		this.playing = undefined;
		this.tourAt = undefined;
		this.asked = undefined;
		this.asking = false;
		if (playing && this.panel) {
			await this.panel.webview.postMessage({ type: 'tourEnd', id: playing.id, reason: 'agent' });
		}
	}

	/** Where agents looked, in memory only: what a canvas opened later still shows, and what "Replay trail" plays. */
	private readonly gazeLog = new GazeLog();

	/**
	 * flow-agent's looks (`flow.agent.gaze`): checked, kept, and painted on the canvas when one is open. Gaze never opens,
	 * reveals or focuses anything: without a canvas the looks are only kept.
	 */
	gaze(batch: unknown) {
		// The setting was turned off: forget the trails, here and on the canvas.
		if ((batch as { clear?: unknown } | null)?.clear === true) {
			this.gazeLog.clear();
			void this.panel?.webview.postMessage({ type: 'gazeClear' });
			return;
		}
		const kept = parseGaze(batch, roots());
		this.gazeLog.add(kept);
		if (kept.length && this.panel && this.webviewReady) {
			// `burst`: flow-agent saw more than 20 looks in a second; the canvas then jumps instead of gliding.
			void this.panel.webview.postMessage({ type: 'gaze', events: kept.map(k => k.event), burst: (batch as { burst?: unknown }).burst === true });
		}
	}

	private postRecentGaze() {
		const events = this.gazeLog.recent(Date.now());
		if (events.length) {
			void this.panel?.webview.postMessage({ type: 'gaze', events });
		}
	}

	/** Editor → canvas: the canvas highlights the card holding this line. */
	cursorMoved(file: string, line: number) {
		void this.panel?.webview.postMessage({ type: 'cursor', file, line });
	}

	private async onMessage(m: Request | { type: 'open' | 'reveal'; file: string; line: number } | { type: 'ask'; label: string; context: string } | { type: 'answer'; id: string; accept: boolean } | { type: 'mention'; file: string; start: number; end: number } | { type: 'typeDiagram'; id: string } | Extract<CanvasToHostTour, { type: 'tourState' | 'tourExit' | 'tourAsk' | 'tourRun' | 'pointAsk' | 'gazeReplay' }>) {
		if (m.type === 'open' || m.type === 'reveal') {
			// open: jump there and type; reveal: show the line but keep the canvas focused.
			const file = workspaceFile(m.file);
			if (!file) {
				return;
			}
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
			const start = new vscode.Position(Math.max(0, Number(m.line) - 1 || 0), 0);
			await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(start, start), preview: true, preserveFocus: m.type === 'reveal' });
			return;
		}
		if (m.type === 'tourState' || m.type === 'tourExit') {
			// Only about the tour this host sent: an id the canvas made up, or a step that does not exist, is ignored.
			const report = tourReport(this.playing, m);
			if (report?.exit) {
				this.playing = undefined;
				this.tourAt = undefined;
				this.asked = undefined;
				this.asking = false;
			} else if (report) {
				this.tourAt = { index: report.index, paused: report.paused };
				// The reader pressed play (or moved on): the question is not waiting any more.
				if (!report.paused) {
					this.asking = false;
				}
			}
			return;
		}
		if (m.type === 'tourAsk') {
			const playing = this.playing;
			const ask = parseTourAsk(m, playing);
			const step = playing && ask && playing.tour.steps[ask.index];
			if (playing && ask && step) {
				this.asked = ask;
				this.asking = true;
				this.tourAt = { index: ask.index, paused: true };
				const where = step.at?.file ? place(this.rel(step.at.file), step.at.startLine, step.at.endLine) : undefined;
				await this.askAgent(tourAskPrompt(playing.tour, ask.index + 1, playing.steps, { label: step.at?.label || step.title, where }, ask.question), 'tour', step.at?.file ? [step.at.file] : [], playing.session);
			}
			return;
		}
		if (m.type === 'tourRun') {
			// The command is the one the host's own copy of the step carries (never one from the message), and only an allowlisted one runs.
			const playing = this.playing;
			const index = parseTourRun(playing, m);
			if (playing && this.panel && index !== undefined) {
				const done = await runWait(playing.tour.steps[index], command => WAIT_ALLOWED.has(command) ? vscode.commands.executeCommand(command) : Promise.reject(new Error('That command is not allowed in a tour.')));
				await this.panel.webview.postMessage({ type: 'tourWaitDone', id: playing.id, index, ok: done.ok, ...(done.reason ? { reason: done.reason } : {}) });
			}
			return;
		}
		if (m.type === 'pointAsk') {
			const p = parsePointAsk(m, f => workspaceFile(f));
			if (p) {
				// An edit is not answered with a tour; it comes back as a change on the canvas.
				if (p.kind !== 'edit') {
					this.pointed = { question: p.question || 'Explain this code.', at: Date.now() };
				}
				await this.askAgent(selectionPrompt({ kind: p.kind, label: p.label, where: place(this.rel(p.file), p.startLine, p.endLine), flow: this.shown?.label, question: p.question }), 'canvas', [p.file]);
			}
			return;
		}
		if (m.type === 'gazeReplay') {
			// Only a session the log holds: the canvas names it, the host builds the tour from its own record.
			if (this.gazeLog.has(m.session)) {
				const tour = gazeTour(this.gazeLog.lastTurn(m.session), roots(), readTextIn(roots()));
				if (tour) {
					await this.playTour(tour);
				}
			}
			return;
		}
		if (m.type === 'answer') {
			if (typeof m.id === 'string') {
				this.onAnswer?.(m.id, m.accept === true);
			}
			return;
		}
		if (m.type === 'mention') {
			const file = workspaceFile(m.file);
			if (file) {
				// Whole line numbers in order: the canvas is not trusted with what reaches the terminal.
				const [start, end] = [Number(m.start), Number(m.end)];
				if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start && end < 10_000_000) {
					this.onMention?.(file, start, end);
				}
			}
			return;
		}
		if (m.type === 'typeDiagram') {
			if (typeof m.id === 'string' && m.id.length < 400 && await this.diagramAvailable()) {
				await vscode.commands.executeCommand(FOCUS_TYPE, m.id);
			}
			return;
		}
		if (m.type === 'ask') {
			// The canvas is not trusted with what reaches the agent: text only, a short label, a bounded flow (tour/ask.ts).
			const ask = parseFlowAsk(m.label, m.context);
			if (ask) {
				await vscode.commands.executeCommand(Command.askAgent, ask.label, ask.text);
			}
			return;
		}
		if (m.type !== 'request') {
			return;
		}
		let data: unknown;
		let error: string | undefined;
		try {
			if (m.file !== undefined) {
				const file = workspaceFile(m.file);
				if (!file) {
					throw new Error('That file is not in this workspace.');
				}
				m.file = file;
			}
			switch (m.op) {
				case 'graph': {
					const g = withoutTests(await this.providerFor(m.target!).graph(m.target!));
					await this.changes.annotate(g, m.turn);
					data = g;
					break;
				}
				case 'callers': {
					const c = withoutTests(await this.providerFor(m.target!).callers(m.target!));
					await this.changes.annotate(c, m.turn);
					data = c;
					break;
				}
				case 'impact': data = await this.providerFor(m.target!).impact(m.target!); break;
				case 'timeline': data = await this.changes.timeline(); break;
				case 'editHooks': data = (await agentContext(m.file!)).items.filter(i => i.group === 'hooks' && i.detail.startsWith('After')).map(i => i.title); break;
				case 'undoFrom': data = await this.whileCardEdited() ?? await this.changes.undoFrom(m.turn!); break;
				case 'save': data = await this.save(m); break;
				case 'keep': this.changes.keep(m.file!); data = { ok: true }; break;
				case 'undo': data = await this.whileCardEdited(m.file) ?? await this.changes.undo(m.file!, m.startLine!, m.endLine!); break;
				case 'complete': data = await this.language.complete(cardQuery({ ...m }), triggerOf(m.trigger)); break;
				case 'signature': data = await this.language.signature(cardQuery({ ...m }), triggerOf(m.trigger)); break;
				case 'hover': data = await this.language.hover(cardQuery({ ...m })); break;
				case 'definition': data = await this.language.definition({ ...m }); break;
				case 'typeChips': data = await this.typeChips(m); break;
				case 'typeDetail': data = await this.typeDetail(m); break;
				case 'endEdit':
					if (typeof m.session === 'string') {
						const session = m.session;
						await this.overlays.run(() => this.overlays.close(session));
					}
					data = { ok: true };
					break;
			}
		} catch (e) {
			error = (e as Error)?.message ?? String(e);
		}
		await this.panel?.webview.postMessage({ type: 'response', id: m.id, data, error });
	}

	private typeChanges: vscode.Disposable | undefined;

	private diagramAvailable() {
		return Promise.resolve(vscode.commands.getCommands(true)).then(all => all.includes(FOCUS_TYPE), () => false);
	}

	/**
	 * The type chips of the cards, from the type graph (built on the first ask, not before: the canvas draws without it). A graph that
	 * was not complete (the code index still building, C# not loaded yet) says `ready: false`; the canvas asks again when this
	 * panel tells it the types changed.
	 */
	private async typeChips(m: Request) {
		const types = TypeService.get();
		this.typeChanges ??= types.onDidChange(() => void this.panel?.webview.postMessage({ type: 'typesChanged' }));
		const nodes = (Array.isArray(m.nodes) ? m.nodes : []).slice(0, 3000).flatMap(n => {
			const file = workspaceFile(n?.file);
			const line = Number(n?.line);
			const endLine = Number(n?.endLine);
			return file && typeof n.key === 'string' && Number.isInteger(line) && line > 0 ? [{ key: n.key, file, line, endLine: Number.isInteger(endLine) && endLine > 0 ? endLine : undefined }] : [];
		});
		const [found, diagramAvailable] = await Promise.all([types.chips(nodes), this.diagramAvailable()]);
		return { ...found, diagramAvailable };
	}

	/** The fields of one type, for a chip that was opened. */
	private async typeDetail(m: Request) {
		if (typeof m.ref !== 'string' || !m.ref || m.ref.length > 400) {
			return undefined;
		}
		const depth = Math.max(0, Math.min(3, Math.floor(Number(m.depth)) || 0));
		return TypeService.get().tree(m.ref, workspaceFile(m.fromFile), depth);
	}

	/**
	 * Undo works from the document and saves it: while a card's unsaved text is in it, that would write the text to the file.
	 * `file`: only that file matters (undo of one card); without it any edited card does (undo of a whole prompt).
	 */
	private async whileCardEdited(file?: string): Promise<{ ok: false; message: string } | undefined> {
		const open = await this.overlays.run(async () => this.overlays.activeUri());
		if (open && (!file || open.fsPath === vscode.Uri.file(file).fsPath)) {
			return { ok: false, message: 'Save or discard the card you are editing first.' };
		}
		return undefined;
	}

	/**
	 * Applies a card edit to the real document (not the file): editor buffers, undo and the agent's
	 * Keep/Undo snapshots all stay consistent. Refuses if the method changed since the card was drawn.
	 */
	private async save(m: Request): Promise<{ ok: boolean; message?: string }> {
		// A card that was shown to the language servers is already in the document: its lines are replaced where they are now.
		const session = m.session;
		if (typeof session === 'string') {
			const done = await this.overlays.run(() => this.overlays.commit(session, m.code!));
			if (done) {
				return done;
			}
		}
		return this.overlays.run(() => this.saveInDocument(m));
	}

	private async saveInDocument(m: Request): Promise<{ ok: boolean; message?: string }> {
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(m.file!));
		const last = m.endLine! - 1;
		if (last >= doc.lineCount) {
			return { ok: false, message: 'The file got shorter since this card was drawn. Refreshing the flow; try again.' };
		}
		const range = new vscode.Range(m.startLine! - 1, 0, last, doc.lineAt(last).text.length);
		if (normalize(doc.getText(range)) !== normalize(m.original!)) {
			this.refreshSoon();
			return { ok: false, message: 'This method changed somewhere else. Refreshing the flow; try again.' };
		}
		const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, range, normalize(m.code!).replace(/\n/g, eol));
		if (!await vscode.workspace.applyEdit(edit)) {
			return { ok: false, message: 'Could not apply the edit.' };
		}
		await doc.save();
		return { ok: true };
	}

	/**
	 * Everything inline: in the Insilode shell (WKWebView) webviews run without a service worker, so they
	 * cannot load side files. The canvas is built as one JS + one CSS file for exactly this.
	 */
	private async html(webview: vscode.Webview, target: FlowTarget, label: string) {
		const [js, css] = await Promise.all([
			fs.readFile(path.join(this.dist, 'webview.js'), 'utf8'),
			fs.readFile(path.join(this.dist, 'webview.css'), 'utf8'),
		]);
		const kind = vscode.window.activeColorTheme.kind;
		const dark = kind !== vscode.ColorThemeKind.Light && kind !== vscode.ColorThemeKind.HighContrastLight;
		const nonce = randomBytes(16).toString('base64');
		const csp = [
			`default-src 'none'`,
			`script-src 'nonce-${nonce}'`,
			`style-src 'unsafe-inline'`,
			`font-src ${webview.cspSource} data:`,
			`img-src ${webview.cspSource} data:`,
			`worker-src blob:`,
		].join('; ');
		// `</script` ends the element early and `<!--` can start the parser's "double escaped" state: neither may appear in inline code.
		const safe = (text: string, tag: string) => text.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`).replace(/<!--/g, '\\x3C!--');
		return `<!doctype html><html><head><meta charset="utf-8">` +
			`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
			`<style>${safe(css, 'style')}</style>` +
			`<script nonce="${nonce}">window.__FLOW__=${inertJson({ target, label, dark })}</script>` +
			`</head><body><div id="root"></div><script nonce="${nonce}">${safe(js, 'script')}</script></body></html>`;
	}

	dispose() {
		clearTimeout(this.refreshTimer);
		this.typeChanges?.dispose();
		this.panel?.dispose();
		this.overlays.dispose();
	}
}

/** The one character that opened a completion or signature popup, if the canvas says so. */
const triggerOf = (t: unknown) => (typeof t === 'string' && t.length === 1 ? t : undefined);

/** JSON for an inline <script>: `</script>`, `<!--` and the JS line separators cannot end or alter the script. */
function inertJson(value: unknown) {
	return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
