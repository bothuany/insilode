/*---------------------------------------------------------------------------------------------
 *  Insilode skeleton first, in the window: each agent session's stage, the plan board recoloured from the type index after every
 *  save, and the warnings when an agent changes a declaration the developer wrote. The developer drives it by talking to the agent
 *  ("I'll write it", "check", "hand over", "just do it"); the agent moves the stage with `check_skeleton` steps. Whether it is on
 *  is the agent's switch in the dock (`flow.agents.skeletonOn`). Revert is the developer's own command, never the agent's tool.
 *  See docs/design/skeleton-first.md.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BoardSpec } from './board/spec';
import type { BoardStore } from './board/store';
import { ChangeBatcher } from './skeleton/changes';
import { stubFor } from './skeleton/paths';
import { goneIn, headersOf, locate, revertRange, stillThere, warningText, type Header, type Warning } from './skeleton/guard';
import { baselineOf, decorate, designSummary, extendBaseline, matchPlan, type DesignSummary } from './skeleton/match';
import { SessionMemory } from './skeleton/persist';
import { drawnAnswer, newSession, toolAnswer, type SkeletonSession, type SkeletonStep, type SkeletonTools } from './skeleton/sessions';
import type { TypeService } from './types/typeService';

/** Declared by flow-agent (the starting value of each agent's switch); without flow-agent it reads as its default, off. */
const SETTING = 'insilode.skeletonFirst';
/** Agent sessions with a stage at once: more is a caller making up ids. */
const MAX_SESSIONS = 20;
const RECOMPUTE_MS = 250;
/** Typing settles for this long before the buffer is read; a save or a file written outside the editor waits less. */
const TYPING_MS = 500;
const DISK_MS = 250;
/** The files the code index reads: a save of anything else changes no type. */
const CODE_FILE = /\.(cs|ts|tsx|js|jsx|mjs|cjs|java|kt|py|go|rs|php|rb)$/i;

/** Paths compared the way Windows and VS Code spell them differently (drive letter case, slashes). */
const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
const fileKey = (f: string) => f.replace(/\\/g, '/').toLowerCase();

/** The default for an agent nobody switched, and the answer for an agent Insilode did not start (it has no switch in the dock). */
export const skeletonDefault = () => vscode.workspace.getConfiguration(SETTING).get<boolean>('enabled', false) === true;

export class SkeletonHost implements SkeletonTools, vscode.Disposable {
	private readonly sessions = new Map<string, SkeletonSession>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private warningSeq = 0;
	private readonly disposables: vscode.Disposable[] = [];
	/** Buffers being typed in (latest document per file) and files written or created outside the editor: each burst is read once. */
	private readonly typing: ChangeBatcher<vscode.TextDocument>;
	private readonly onDisk: ChangeBatcher<string>;
	/** Files whose unsaved text the index read: closing them without saving puts the disk version back. */
	private readonly overlaid = new Set<string>();
	/** Each session's stage and "just do it" badge, kept in `state` so they survive a reload. */
	private readonly memory: SessionMemory;

	/** `state`: where each session's stage is kept across a reload (the workspace state; without it a reload starts over). */
	constructor(private readonly boards: BoardStore, private readonly types: TypeService, private readonly log: vscode.LogOutputChannel, protected readonly state?: vscode.Memento) {
		// Built here, not as a field initializer: a field initializer may run before the parameter property `state` is set.
		this.memory = new SessionMemory(state, MAX_SESSIONS);
		this.typing = new ChangeBatcher(TYPING_MS, batch => this.typed(batch), e => this.warn(e));
		this.onDisk = new ChangeBatcher(DISK_MS, batch => this.written([...batch.values()]), e => this.warn(e));
		boards.setDecorator((id, spec) => {
			const s = this.byBoard(id);
			return s && s.stage !== 'design' && s.diff ? decorate(spec, s.diff, [
				...s.warnings.map(w => ({ owner: w.owner, name: w.name, text: `${warningText(w)}\nTo put yours back: ask the agent, or run "Insilode: Revert an Agent's Change to Your Declaration".` })),
				// A keep the agent passed on stays visible: the developer can see what was kept, not only what is still open.
				...s.accepted.map(w => ({ owner: w.owner, name: w.name, text: `Kept (the agent was told to keep it): ${warningText(w)}` })),
			], f => vscode.workspace.asRelativePath(f, false)) : spec;
		});
		this.disposables.push(
			{ dispose: () => boards.setDecorator(undefined) },
			// A redraw of the design ("make X an interface") is the new plan: the colours follow it at once.
			boards.onDidChange(e => {
				// Only once the design is taken: a first draw that is turned down (types without members) must not become the plan.
				const s = e.type === 'set' ? this.byBoard(e.id) : undefined;
				if (s?.stage === 'design') {
					return;
				}
				const board = s && this.boards.get(e.id);
				if (s && board && (board.spec.kind === 'class' || board.spec.kind === 'er')) {
					s.plan = board.spec;
					this.changed(s);
				}
			}),
			vscode.workspace.onDidSaveTextDocument(d => void this.saved(d)),
			// While typing: the buffer is read after a short pause, so a type turns from missing to written as it is written.
			vscode.workspace.onDidChangeTextDocument(e => {
				const d = e.document;
				if (e.contentChanges.length && d.uri.scheme === 'file' && CODE_FILE.test(d.uri.fsPath) && this.live()) {
					this.typing.add(fileKey(d.uri.fsPath), d);
				}
			}),
			vscode.workspace.onDidCloseTextDocument(d => {
				// A discarded buffer is usually reverted before it closes (not dirty any more), so the mark alone decides.
				if (this.overlaid.delete(fileKey(d.uri.fsPath))) {
					this.onDisk.add(fileKey(d.uri.fsPath), d.uri.fsPath);
				}
			}),
			// A file another tool wrote or created (IntelliJ, a formatter, git, the shell) never fires a save in this window.
			...this.watchDisk(),
			vscode.commands.registerCommand('flow.skeleton.createFile', (board: unknown, node: unknown) => this.createFile(board, node)),
			types.onDidChange(() => [...this.sessions.values()].forEach(s => s.stage !== 'design' && this.changed(s))),
			// flow-agent: the agent's switch went off, so its change leaves skeleton first.
			vscode.commands.registerCommand('flow.skeleton.finish', (session: unknown) => {
				const s = typeof session === 'string' ? this.sessions.get(session) : undefined;
				if (typeof session === 'string') {
					// The change is over, so a "just do it" badge goes with it.
					this.memory.forget(session);
				}
				if (s) {
					this.drop(s);
				} else {
					this.persist();
				}
			}),
			vscode.commands.registerCommand('flow.skeleton.revert', () => this.revertPicked()),
			// flow-agent's dock: where an agent is in skeleton first, for the stage indicator on its row.
			vscode.commands.registerCommand('flow.skeleton.stage', (session: unknown) => this.stageOf(session)),
		);
		this.restore();
	}

	/**
	 * After a reload: the sessions that were past the design stage come back at their stage, attached to their design board, as long as
	 * that board is still in the store (the board store keeps the plan boards itself). The comparison with the code is recomputed; the
	 * baseline is not kept, so a type the developer already wrote reads as existing code rather than as a match.
	 */
	private restore() {
		for (const e of this.memory.restore(id => this.boards.get(id) !== undefined)) {
			const board = this.boards.get(e.boardId);
			if (!board || (board.spec.kind !== 'class' && board.spec.kind !== 'er') || this.sessions.has(e.session) || this.sessions.size >= MAX_SESSIONS || e.stage === null) {
				continue;
			}
			const s = newSession(e.session);
			s.boardId = e.boardId;
			s.stage = e.stage;
			s.plan = board.spec;
			this.sessions.set(s.session, s);
			if (s.stage === 'handover') {
				// The declarations the developer handed over are read again from the code as it stands now.
				void this.handover(s).then(() => this.changed(s)).catch(err => this.warn(err));
			} else if (s.stage === 'skeleton') {
				this.changed(s);
			}
		}
	}

	/** Writes the stages and badges to the workspace state. */
	private persist() {
		this.memory.save(this.sessions.values());
	}

	/**
	 * The stage an agent session is in (design, skeleton or handover), or nothing when it is not in skeleton first. `skipped`: the
	 * developer chose "just do it" for this change, so the dock can show a badge; the session has no stage then (`stage` is undefined)
	 * until the agent's next design step or until it ends.
	 */
	stageOf(session: unknown): { stage: SkeletonSession['stage'] | undefined; skipped: boolean } | undefined {
		if (typeof session !== 'string') {
			return undefined;
		}
		const s = this.sessions.get(session);
		const skipped = this.memory.isSkipped(session);
		return s ? { stage: s.stage, skipped } : skipped ? { stage: undefined, skipped } : undefined;
	}

	/** Whether any agent session is comparing a design with the code now. */
	private live() {
		return [...this.sessions.values()].some(s => s.stage !== 'design');
	}

	private warn(e: unknown) {
		this.log.warn(`skeleton: ${(e as Error).message ?? e}`);
	}

	private watchDisk(): vscode.Disposable[] {
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.{cs,ts,tsx,js,jsx,mjs,cjs,java,kt,py,go,rs,php,rb}');
		const seen = (u: vscode.Uri) => {
			if (u.scheme === 'file' && this.live() && vscode.workspace.getWorkspaceFolder(u)) {
				this.onDisk.add(fileKey(u.fsPath), u.fsPath);
			}
		};
		return [watcher, watcher.onDidCreate(seen), watcher.onDidChange(seen), watcher.onDidDelete(seen)];
	}

	/** The pause after typing: the index reads these buffers, then the boards recolour. */
	private async typed(batch: Map<string, vscode.TextDocument>) {
		const active = [...this.sessions.values()].filter(s => s.stage !== 'design');
		if (!active.length) {
			return;
		}
		const buffers = [...batch.values()].filter(d => !d.isClosed).map(d => ({ file: d.uri.fsPath, text: d.getText() }));
		buffers.forEach(b => {
			this.overlaid.add(fileKey(b.file));
			active.forEach(s => s.recent.add(fileKey(b.file)));
		});
		await this.types.refreshBuffers(buffers);
		active.forEach(s => this.changed(s));
	}

	/** Files that changed on disk outside this window's saves (or were created or deleted): the index re-reads them, the boards recolour. */
	private async written(files: string[]) {
		const active = [...this.sessions.values()].filter(s => s.stage !== 'design');
		if (!active.length) {
			return;
		}
		files.forEach(f => active.forEach(s => s.recent.add(fileKey(f))));
		await this.types.refreshFiles(files);
		active.forEach(s => this.changed(s));
	}

	private byBoard(id: string) {
		return [...this.sessions.values()].find(s => s.boardId === id);
	}

	// ── MCP ─────────────────────────────────────────────────────────────────

	async check(session: string | undefined, step?: SkeletonStep, warning?: number): Promise<string> {
		// Skeleton first is on or off per agent, in the dock. Only a session the dock knows is that agent: an id the bridge was handed but
		// the dock never started counts as no session, and follows the setting's default.
		const on = session ? await this.switchOf(session) : undefined;
		const id = on === undefined ? '' : session!;
		const rel = (f: string) => vscode.workspace.asRelativePath(f, false);
		if (!(on ?? skeletonDefault())) {
			const old = this.sessions.get(id);
			if (id) {
				this.memory.forget(id);
			}
			if (old) {
				this.drop(old);
			} else {
				this.persist();
			}
			return toolAnswer(false, undefined);
		}
		if (step && !id) {
			// An agent Insilode did not start has no switch and no row of its own: it may check, but not move a stage that others share.
			return 'Skeleton first steps are only for agents started from the Insilode Agents dock: do what the developer asks as usual.';
		}
		if (step) {
			this.log.info(`skeleton: agent ${id} asked for step ${step}${warning ? ` (warning ${warning})` : ''}`);
		}
		let s = this.sessions.get(id);
		if (step === 'just' || step === 'finish') {
			// "Just do it" is remembered for the session, so the dock can show that the developer skipped the skeleton; "finish" ends it.
			if (step === 'just') {
				this.memory.skip(id);
			} else {
				this.memory.forget(id);
			}
			if (s) {
				this.drop(s);
			} else {
				this.persist();
			}
			return step === 'just'
				? 'Skeleton first is skipped for this change: implement the approved plan now, as usual.'
				: 'Skeleton first is finished for this change: the board keeps the design without colours.';
		}
		if (!s) {
			if (this.sessions.size >= MAX_SESSIONS) {
				return 'Skeleton first: too many agent sessions are in the middle of it in this window. Implement the plan as usual.';
			}
			s = newSession(id);
			this.sessions.set(id, s);
			// A new design step: the earlier "just do it" no longer describes this change.
			this.memory.forget(id);
			this.persist();
		}
		if (step === 'handover') {
			if (s.stage !== 'skeleton') {
				return s.stage === 'handover' ? toolAnswer(true, s, rel) : 'There is no skeleton to hand over yet: draw the design first (call check_skeleton without a step).';
			}
			await this.handover(s);
		} else if (step === 'accept') {
			const w = s.warnings.find(x => x.id === warning);
			if (!w) {
				return `No warning ${warning ?? ''} in this change. ${toolAnswer(true, s, rel)}`;
			}
			this.accept(s, w);
		}
		if (s.stage !== 'design') {
			await this.recompute(s);
		}
		return toolAnswer(true, s, rel);
	}

	/** The agent's switch in the dock; nothing when the dock does not know the session. */
	private async switchOf(session: string): Promise<boolean | undefined> {
		const on = await Promise.resolve(vscode.commands.executeCommand<unknown>('flow.agents.skeletonOn', session)).catch(() => undefined);
		return typeof on === 'boolean' ? on : undefined;
	}

	/**
	 * draw_board ran: a class or ER board drawn by a session waiting for its design becomes that design, whatever id it used, and the
	 * board starts comparing it with the code at once (everything missing until the developer writes it).
	 */
	async drawn(id: string, spec: BoardSpec, session: string | undefined): Promise<string | undefined> {
		const s = this.sessions.get(session ?? '');
		// The first design, or a redraw of it while the developer writes the skeleton (onDidChange has made it the plan already).
		const redraw = s?.stage === 'skeleton' && s.boardId === id;
		if (!s || (s.stage !== 'design' && !redraw) || (spec.kind !== 'class' && spec.kind !== 'er')) {
			return undefined;
		}
		const plan = this.boards.get(id)?.spec ?? spec;
		let summary: DesignSummary | undefined;
		try {
			const graph = await this.types.getGraph();
			const ready = this.types.complete;
			// What exists now is the baseline: taken once, on the first design, so a redraw never turns the developer's new types into old ones.
			if (ready) {
				s.baseline = s.baseline ? extendBaseline(s.baseline, graph.types, plan) : baselineOf(graph.types, plan);
				summary = designSummary(matchPlan(plan, graph, { ready, baseline: s.baseline, hintModule: this.hintModule(graph.types) }));
			}
		} catch (e) {
			// The board is drawn either way: an index that failed only means no summary, never a failed draw the agent would repeat.
			this.log.warn(`skeleton: ${(e as Error).message}`);
		}
		// A first design with a new type without members is no design to write from: the agent redraws it, and the board waits. Turned
		// down once already, it is taken (a marker interface may be empty on purpose), and the answer still names the empty types.
		const empty = !!summary?.empty.length;
		if (empty) {
			this.log.info(`skeleton: design "${plan.title}" has new types without members (${summary!.empty.join(', ')})${s.turnedDown ? '' : '; asked for a redraw'}`);
		}
		const take = !redraw && (!empty || !!s.turnedDown);
		s.turnedDown = s.turnedDown || (!redraw && empty);
		if (take) {
			s.boardId = id;
			s.plan = plan;
			s.stage = 'skeleton';
			this.persist();
			this.changed(s);
		}
		return drawnAnswer(summary, id, redraw || take, f => vscode.workspace.asRelativePath(f, false));
	}

	/** Whether a board id is another agent session's skeleton design: draw_board then draws a new board instead of replacing it. */
	claimed(id: string, session: string | undefined): boolean {
		return [...this.sessions.values()].some(s => s.session !== (session ?? '') && s.stage !== 'design' && s.boardId === id);
	}

	/** Keeps the developer's declarations as they are now, then the agent may fill the bodies. */
	private async handover(s: SkeletonSession) {
		await this.recompute(s);
		const graph = await this.types.getGraph();
		const texts = new Map<string, string>();
		for (const r of s.diff?.nodes ?? []) {
			if (r.file && !texts.has(r.file)) {
				const text = await this.read(r.file);
				if (text !== undefined) {
					texts.set(r.file, text);
				}
			}
		}
		s.headers = s.diff ? headersOf(s.diff, graph.types, f => texts.get(f)) : [];
		s.warnings = [];
		s.stage = 'handover';
		this.persist();
		this.log.info(`skeleton: handed over ${s.headers.length} declarations of "${s.plan?.title}"`);
	}

	/** The developer keeps the agent's version: later edits are measured against it. */
	private accept(s: SkeletonSession, w: Warning) {
		const kept = s.headers.findIndex(h => h.owner === w.owner && h.name === w.name && h.kind === w.kind && same(h.file, w.file));
		if (kept >= 0) {
			if (w.after !== undefined && w.line) {
				s.headers[kept] = { ...s.headers[kept], text: w.after, line: w.line };
			} else {
				s.headers.splice(kept, 1);
			}
		}
		s.warnings = s.warnings.filter(x => x !== w);
		s.accepted.push(w);
	}

	/** "Insilode: Revert an Agent's Change to Your Declaration": the developer picks a warning and their declaration goes back; the body stays. */
	private async revertPicked() {
		const all = [...this.sessions.values()].flatMap(s => s.warnings.filter(w => w.reason !== 'removed' && w.after !== undefined).map(w => ({ s, w })));
		if (!all.length) {
			void vscode.window.showInformationMessage('Insilode: no declaration of yours was changed by an agent.');
			return;
		}
		const pick = await vscode.window.showQuickPick(all.map(x => ({ label: x.w.name ? `${x.w.owner}.${x.w.name}` : x.w.owner, detail: warningText(x.w), description: vscode.workspace.asRelativePath(x.w.file), x })), { title: 'Revert an agent\'s change to your declaration', placeHolder: 'The declaration goes back to what you wrote; the body the agent filled stays' });
		if (!pick) {
			return;
		}
		const { s, w } = pick.x;
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(w.file));
		if (doc.isDirty) {
			// Saving after the revert would also save the developer's unsaved work in that file.
			void vscode.window.showWarningMessage(`Insilode: ${vscode.workspace.asRelativePath(doc.uri)} has unsaved changes: save or undo them, then revert.`);
			return;
		}
		const range = revertRange(doc.getText(), w);
		if (!range) {
			void vscode.window.showWarningMessage('Insilode: that declaration changed again since the warning; revert it by hand.');
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(range.startLine - 1, 0, range.endLine - 1, doc.lineAt(range.endLine - 1).text.length), range.text);
		if (await vscode.workspace.applyEdit(edit)) {
			await doc.save();
			s.warnings = s.warnings.filter(x => x !== w);
			await this.recompute(s);
		}
	}

	// ── edits ───────────────────────────────────────────────────────────────

	/** The developer saved: the board recolours, and in the hand-over their own changes to their declarations are kept as theirs. */
	private async saved(doc: vscode.TextDocument) {
		const file = doc.uri.fsPath;
		const active = [...this.sessions.values()].filter(s => s.stage !== 'design');
		if (doc.uri.scheme !== 'file' || !CODE_FILE.test(file) || !active.length) {
			return;
		}
		active.forEach(s => s.recent.add(fileKey(file)));
		this.overlaid.delete(fileKey(file));
		await this.types.refreshFiles([file]);
		const text = doc.getText();
		for (const s of active.filter(x => x.stage === 'handover')) {
			const warned = (h: Header) => s.warnings.some(w => w.owner === h.owner && w.name === h.name && same(w.file, h.file));
			const mine = goneIn(s.headers, file, text, same).filter(h => !warned(h));
			if (mine.length) {
				const graph = await this.types.getGraph();
				for (const h of mine) {
					const now = locate(h, graph.types, text, s.headers);
					const i = s.headers.indexOf(h);
					if (now.after !== undefined && now.line) {
						s.headers[i] = { ...h, text: now.after, line: now.line };
					} else {
						s.headers.splice(i, 1);
					}
				}
			}
		}
		active.forEach(s => this.changed(s));
	}

	/** flow-agent saw an agent edit files (`phase` after the tool ran): in the hand-over, a declaration of the developer's that is gone is a warning. */
	async agentEdited(session: string, files: string[], phase: 'before' | 'after') {
		const s = this.sessions.get(session);
		if (!s || phase !== 'after' || s.stage === 'design') {
			return;
		}
		// The paths come from the agent's hook: only code files inside an open workspace folder are read or indexed.
		const code = files.filter(f => CODE_FILE.test(f) && !!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(f)));
		if (!code.length) {
			return;
		}
		await this.types.refreshFiles(code);
		if (s.stage === 'handover' && s.headers.length) {
			const graph = await this.types.getGraph();
			for (const file of code) {
				const text = await this.read(file);
				if (text === undefined) {
					continue;
				}
				for (const h of goneIn(s.headers, file, text, same)) {
					if (!s.warnings.some(w => w.owner === h.owner && w.name === h.name && w.kind === h.kind && same(w.file, h.file))) {
						s.warnings.push({ ...locate(h, graph.types, text, s.headers), id: ++this.warningSeq });
					}
				}
			}
			// A warning whose header came back (the agent undid it) is over.
			for (let i = s.warnings.length - 1; i >= 0; i--) {
				const w = s.warnings[i];
				const text = code.some(f => same(f, w.file)) ? await this.read(w.file) : undefined;
				if (text !== undefined && stillThere(text, { owner: w.owner, name: w.name, kind: w.kind, file: w.file, line: 0, text: w.before })) {
					s.warnings.splice(i, 1);
				}
			}
		}
		this.changed(s);
	}

	// ── recompute and show ──────────────────────────────────────────────────

	private changed(s: SkeletonSession) {
		if (s.stage === 'design') {
			return;
		}
		clearTimeout(this.timers.get(s.session));
		this.timers.set(s.session, setTimeout(() => void this.recompute(s).catch(e => this.log.warn(`skeleton: ${(e as Error).message}`)), RECOMPUTE_MS));
	}

	private async recompute(s: SkeletonSession) {
		if (!s.plan || this.sessions.get(s.session) !== s) {
			return;
		}
		const graph = await this.types.getGraph();
		const recent = (f: string) => s.recent.has(fileKey(f));
		if (this.types.complete) {
			// The index was still loading when the design was drawn: what is there now, but for the files saved since, is the baseline.
			// A redraw that names more types adds their members.
			s.baseline = s.baseline ? extendBaseline(s.baseline, graph.types, s.plan) : baselineOf(graph.types, s.plan, recent);
		}
		s.diff = matchPlan(s.plan, graph, { recent, ready: this.types.complete, baseline: s.baseline, hintModule: this.hintModule(graph.types) });
		await this.boards.redraw(s.boardId);
	}

	/** The module of the file the developer has open: where a plan that names no module is probably about. */
	private hintModule(types: { file: string; module: string }[]): string | undefined {
		const open = vscode.window.activeTextEditor?.document.uri;
		return open?.scheme === 'file' ? types.find(t => same(t.file, open.fsPath))?.module : undefined;
	}

	/** The board's "create this file": the webview names the node, the host works out the path itself, inside a workspace folder, never over a file. */
	private async createFile(board: unknown, nodeId: unknown) {
		const s = typeof board === 'string' ? this.byBoard(board) : undefined;
		const r = typeof nodeId === 'string' ? s?.diff?.nodes.find(n => n.id === nodeId) : undefined;
		const node = r && s?.plan?.nodes.find(n => n.id === r.id);
		// Only a type that is not written yet is offered its file; the label the path was derived for is the one the stub is made from (a redraw may have changed the plan since).
		if (!s || !r || !node?.label || !r.target || r.file || node.label !== r.label) {
			return;
		}
		const uri = vscode.Uri.file(r.target.file);
		const shown = vscode.workspace.asRelativePath(uri, false);
		if (!vscode.workspace.getWorkspaceFolder(uri)) {
			void vscode.window.showWarningMessage(`Insilode: ${shown} is outside the open folders, so it is not created.`);
			return;
		}
		const exists = await Promise.resolve(vscode.workspace.fs.stat(uri)).then(() => true, () => false);
		if (exists) {
			await vscode.window.showTextDocument(uri, { preview: true });
			return;
		}
		const stub = stubFor(node, r.target.packageName, r.target.file);
		const choice = await vscode.window.showInformationMessage(`${node.label} belongs in ${shown}`, ...(stub === undefined ? [] : ['Create file']), 'Copy path');
		if (choice === 'Copy path') {
			await vscode.env.clipboard.writeText(shown);
		} else if (choice === 'Create file' && stub !== undefined) {
			await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(r.target.file)));
			// 'wx': a prompt left open while another tool wrote the file must not overwrite it.
			await fs.writeFile(r.target.file, stub, { encoding: 'utf8', flag: 'wx' }).catch(e => {
				if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw e;
				}
			});
			await vscode.window.showTextDocument(uri, { preview: false });
		}
	}

	private async read(file: string): Promise<string | undefined> {
		const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && same(d.uri.fsPath, file));
		return open ? open.getText() : fs.readFile(file, 'utf8').catch(() => undefined);
	}

	private drop(s: SkeletonSession) {
		clearTimeout(this.timers.get(s.session));
		this.sessions.delete(s.session);
		this.persist();
		void this.boards.redraw(s.boardId);
	}

	dispose() {
		this.typing.dispose();
		this.onDisk.dispose();
		this.timers.forEach(t => clearTimeout(t));
		this.disposables.forEach(d => d.dispose());
	}
}
