/*---------------------------------------------------------------------------------------------
 *  Insilode: what an agent changed, per card. flow-agent calls `flow.agentWillEdit` right before a
 *  write is allowed; we keep the file as it was ("baseline") until the user keeps or undoes it.
 *--------------------------------------------------------------------------------------------*/

import { structuredPatch } from 'diff';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { rangeOfHunk, rangesFromHunks, rangeTouches, spanDiff, undoEdit, type LineRange } from './mcp/changedMethods';
import type { FlowNode } from './providers';

/** Per-card agent change, in current-file line numbers. */
export interface CardDiff {
	added: number[];
	/** Lines the agent removed, shown in red after `after` (0 = before the first card line). */
	removed: { after: number; lines: string[] }[];
	plus: number;
	minus: number;
	/** 'git' when the change is only known from the Git-changes view: not necessarily an agent's. */
	source?: 'git';
	/** What a Git change is measured against when that is not HEAD ("main"): committed work, so the card offers no Undo. */
	base?: string;
}

interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: string[];
}

/** A file as VS Code spells it: agents say `C:\x`, documents and the canvas say `c:\x`; everything here is keyed by this. */
const fileKey = (f: string) => vscode.Uri.file(f).fsPath;

async function currentText(file: string): Promise<string> {
	const key = fileKey(file);
	const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === key);
	return open ? open.getText() : fs.readFile(key, 'utf8');
}

/** The file as it is now, and whether it does not exist yet (a file the agent is about to create). */
async function snapshot(file: string): Promise<{ text: string; created: boolean } | undefined> {
	try {
		return { text: norm(await currentText(file)), created: false };
	} catch (e) {
		// Only "not there" means a new file; a file that is merely locked or unreadable must not be recorded as empty.
		return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { text: '', created: true } : undefined;
	}
}

const norm = (s: string) => s.replace(/\r\n/g, '\n');

/** Files that hold secrets: tracked in memory for Keep/Undo, but never copied into the timeline file on disk. */
const SECRET = /(?:^|[\\/])(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)[^\\/]*|[^\\/]*\.(?:pem|key|p12|pfx|jks|keystore))$/i;
/** What the timeline file may hold per text, and in all: it is rewritten on every change. */
const MAX_SAVED_TEXT = 1_000_000;
const MAX_SAVED_TOTAL = 20_000_000;
/** More baselines than this are an agent that changed hundreds of files: the oldest are forgotten. */
const MAX_BASELINES = 300;

/** One prompt to an agent, and each file as it was right before that prompt first changed it. */
interface Turn {
	id: number;
	prompt: string;
	agent: string;
	at: number;
	before: Map<string, string>;
	/** Each file right after the agent's last write in this prompt: anything else later is someone else's edit. */
	after: Map<string, string>;
	/** Files this prompt created: undoing it deletes them instead of leaving them empty. */
	created: Set<string>;
	/** Started by a real prompt (chat or a terminal hook): it lasts until the next prompt, however long. */
	prompted?: boolean;
	/** The agent's last write or start of this prompt: edits that trail it by minutes belong to a new step. */
	lastActivity: number;
	/** A Git-changes step measured against a commit other than HEAD: its "before" holds committed work, which Undo must not write back. */
	base?: string;
}

/** On disk between sessions, so the timeline and Keep/Undo survive a restart. */
interface Saved {
	nextTurn: number;
	baselines: [string, string][];
	committed?: [string, string][];
	turns: { id: number; prompt: string; agent: string; at: number; before: [string, string][]; after: [string, string][]; created?: string[]; base?: string }[];
}

/** Older prompts are dropped first; a timeline is for the work in progress, not history. */
const MAX_TURNS = 30;

/** The agent name of the Git-changes view's step: uncommitted work, not an agent's. */
export const GIT_AGENT = 'Git';

/** What the canvas lists in its timeline. */
export interface TurnSummary {
	id: number;
	prompt: string;
	agent: string;
	at: number;
	files: { file: string; plus: number; minus: number }[];
}

export class AgentChanges implements vscode.Disposable {
	private readonly baselines = new Map<string, string>();
	/**
	 * Files whose baseline is committed work (a branch's fork point, HEAD~1), with what it is called. Undo writes the
	 * baseline back, so these never get one, whoever edits the file afterwards; it lasts as long as the baseline does.
	 */
	private readonly committed = new Map<string, string>();
	private readonly turns: Turn[] = [];
	private nextTurn = 1;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private saveTimer: NodeJS.Timeout | undefined;
	/** Settles when `load` is done: nothing is written before the stored timeline has been read. */
	private loading: Promise<void> = Promise.resolve();

	/** `storeFile`: where to keep the timeline for this workspace (none without a workspace). */
	constructor(private readonly storeFile?: string) { }

	load(): Promise<void> {
		this.loading = this.read();
		return this.loading;
	}

	private async read() {
		if (!this.storeFile) {
			return;
		}
		try {
			const saved = JSON.parse(await fs.readFile(this.storeFile, 'utf8')) as Saved;
			// Turns started before this load finished got ids that the stored ones may use too: number them after the stored ones.
			const early = this.turns.splice(0);
			early.forEach((t, i) => t.id = saved.nextTurn + i);
			this.nextTurn = saved.nextTurn + early.length;
			// Stored paths may be spelled `C:\x`; this window keys files by `c:\x`.
			const keyed = (list: [string, string][]) => new Map(list.map(([f, t]) => [fileKey(f), t] as const));
			keyed(saved.baselines).forEach((t, f) => this.baselines.set(f, t));
			keyed(saved.committed ?? []).forEach((base, f) => this.baselines.has(f) && this.committed.set(f, base));
			this.turns.push(...saved.turns.map(t => ({ ...t, before: keyed(t.before), after: keyed(t.after), created: new Set((t.created ?? []).map(fileKey)), lastActivity: t.at })), ...early);
			this.turns.splice(0, Math.max(0, this.turns.length - MAX_TURNS));
			this.changed.fire();
		} catch {
			// first run, or an unreadable file: start empty
		}
	}

	private save() {
		if (!this.storeFile) {
			return;
		}
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void this.flush(), 500);
	}

	/** One write at a time, to a temp file renamed over the real one: a crash or a second save cannot leave half a file. */
	private writing: Promise<void> = Promise.resolve();

	/** The state as it goes to disk: without secret files, and without texts too big to be worth copying again on every change. */
	private snapshotForDisk(): Saved {
		let total = 0;
		const keep = (list: Iterable<[string, string]>): [string, string][] => {
			const out: [string, string][] = [];
			for (const [f, text] of list) {
				if (SECRET.test(f) || text.length > MAX_SAVED_TEXT || total + text.length > MAX_SAVED_TOTAL) {
					continue;
				}
				total += text.length;
				out.push([f, text]);
			}
			return out;
		};
		return {
			nextTurn: this.nextTurn,
			baselines: keep(this.baselines),
			committed: [...this.committed],
			turns: this.turns.map(t => ({ id: t.id, prompt: t.prompt, agent: t.agent, at: t.at, before: keep(t.before), after: keep(t.after), created: [...t.created].filter(f => !SECRET.test(f)), base: t.base })),
		};
	}

	private flush() {
		if (!this.storeFile) {
			return Promise.resolve();
		}
		const file = this.storeFile;
		this.writing = this.writing.then(async () => {
			await this.loading; // a save that beat the load must not replace the stored timeline with a nearly empty one
			const saved = this.snapshotForDisk();
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(tmp, JSON.stringify(saved));
			await fs.rename(tmp, file);
		}).catch(() => undefined);
		return this.writing;
	}

	/** Writes what is waiting for its delay now, and resolves when it is on disk: Keep/Undo state must survive a quit. */
	flushNow(): Promise<void> {
		if (!this.saveTimer) {
			return this.writing;
		}
		clearTimeout(this.saveTimer);
		this.saveTimer = undefined;
		return this.flush();
	}

	/** A new prompt went to an agent: its edits form one step of the timeline. */
	startTurn(prompt: string, agent: string, prompted = true) {
		const last = this.turns.at(-1);
		if (last && !last.before.size) {
			this.turns.pop(); // the previous prompt changed nothing
		}
		const now = Date.now();
		this.turns.push({ id: this.nextTurn++, prompt, agent, at: now, before: new Map(), after: new Map(), created: new Set(), prompted, lastActivity: now });
		this.turns.splice(0, Math.max(0, this.turns.length - MAX_TURNS));
		this.save();
	}

	/**
	 * Review Git changes on the canvas: each file counts as changed since `before` (its text at HEAD, or at `base` such as
	 * the branch's fork point; undefined for a new file), so the cards of the methods it touched show their diff like an
	 * agent's edit. Replaces the earlier set of the same agent, so asking again (or against another base) does not stack
	 * timeline steps.
	 */
	async trackAgainst(label: string, agent: string, entries: { file: string; before: string | undefined }[], base?: string) {
		await this.loading;
		for (let i = this.turns.length - 1; i >= 0; i--) {
			if (this.turns[i].agent === agent) {
				// Files only that step held go back to "not changed"; a later agent edit keeps its own baseline below.
				for (const f of this.turns[i].before.keys()) {
					if (!this.turns.some((t, j) => j !== i && t.before.has(f))) {
						this.forget(f);
					}
				}
				this.turns.splice(i, 1);
			}
		}
		this.startTurn(label, agent, true);
		const turn = this.turns.at(-1)!;
		turn.base = base;
		for (const { file, before } of entries) {
			const f = fileKey(file);
			const text = norm(before ?? '');
			turn.before.set(f, text);
			if (before === undefined) {
				turn.created.add(f);
			}
			turn.after.set(f, norm(await fs.readFile(f, 'utf8').catch(() => '')));
			this.baselines.set(f, text);
			if (base) {
				this.committed.set(f, base);
			} else {
				this.committed.delete(f);
			}
		}
		while (this.baselines.size > MAX_BASELINES) {
			this.forget(this.baselines.keys().next().value!);
		}
		this.save();
		this.changed.fire();
	}

	/** Edits from a CLI Insilode did not start come without prompts: group those arriving close together into one step. */
	ensureTurn(label: string, agent: string) {
		const last = this.turns.at(-1);
		if (!last || last.agent !== agent || (!last.prompted && Date.now() - last.lastActivity > 3 * 60_000)) {
			this.startTurn(label, agent, false);
		}
	}

	/** Called after an agent write finished: this is what the file should look like if nobody else touches it. */
	async didEdit(files: string[]) {
		await this.loading;
		const turn = this.turns.at(-1);
		if (!turn) {
			return;
		}
		for (const file of files) {
			const f = fileKey(file);
			if (turn.before.has(f)) {
				// The agent writes to disk; an open editor may not have reloaded yet, so read the file itself.
				turn.after.set(f, norm(await fs.readFile(f, 'utf8').catch(() => '')));
				turn.lastActivity = Date.now();
			}
		}
		this.save();
	}

	/**
	 * Files a shell command changed during a turn, that no edit tool named (flow-agent's turn-end sweep): they show as
	 * "changed by a command", measured against the snapshot taken at the turn's start when one exists, else against HEAD.
	 * A stub until the edits part fills it.
	 */
	async commandEdited(_files: string[]) { }

	/** Called before the agent writes: remember the file as it is now (first write of a change wins). */
	async willEdit(files: string[]) {
		await this.loading;
		const turn = this.turns.at(-1);
		for (const file of files) {
			const f = fileKey(file);
			const now = await snapshot(f);
			if (!now) {
				continue; // unreadable right now: record nothing rather than an empty file that Undo would then write back
			}
			if (turn && !turn.before.has(f)) {
				turn.before.set(f, now.text);
				if (now.created) {
					turn.created.add(f);
				}
			}
			if (turn) {
				turn.lastActivity = Date.now();
			}
			if (!this.baselines.has(f)) {
				this.baselines.set(f, now.text); // '' for a new file
				while (this.baselines.size > MAX_BASELINES) {
					this.forget(this.baselines.keys().next().value!);
				}
			}
		}
		this.save();
	}

	/** A file is no longer shown as changed. */
	private forget(file: string) {
		this.baselines.delete(file);
		this.committed.delete(file);
	}

	private async hunks(file: string): Promise<Hunk[]> {
		const base = this.baselines.get(file);
		if (base === undefined) {
			return [];
		}
		const now = norm(await currentText(file).catch(() => ''));
		if (now === base) {
			this.forget(file); // reverted elsewhere (chat Undo, git): nothing to show
			return [];
		}
		return structuredPatch('a', 'b', base, now, '', '', { context: 0 }).hunks;
	}

	/** A file's change during one prompt: from before that prompt to before the next one that touched it. */
	private async turnHunks(turnId: number, file: string): Promise<Hunk[]> {
		const i = this.turns.findIndex(t => t.id === turnId);
		const from = this.turns[i]?.before.get(file);
		if (from === undefined) {
			return [];
		}
		// Up to the next prompt that touched it, else the agent's own last write: edits made by hand after
		// the agent finished are not part of what this prompt did.
		const later = this.turns.slice(i + 1).find(t => t.before.has(file));
		const to = later ? later.before.get(file)! : this.turns[i].after.get(file) ?? norm(await currentText(file).catch(() => ''));
		return from === to ? [] : structuredPatch('a', 'b', from, to, '', '', { context: 0 }).hunks;
	}

	/**
	 * The lines of `file` the latest prompt that touched it changed, in the numbers of the file on disk: the index
	 * reads the disk too, and the turn impact matches these against its method spans. An editor that has not reloaded
	 * the agent's write yet, or holds unsaved edits, would number them differently. Undefined when no prompt holds
	 * the file as it was before.
	 */
	async changedRanges(file: string): Promise<LineRange[] | undefined> {
		await this.loading;
		const f = fileKey(file);
		const from = [...this.turns].reverse().find(t => t.before.has(f))?.before.get(f);
		if (from === undefined) {
			return undefined;
		}
		const now = norm(await fs.readFile(f, 'utf8').catch(() => ''));
		return rangesFromHunks(from === now ? [] : structuredPatch('a', 'b', from, now, '', '', { context: 0 }).hunks);
	}

	/** The prompts that changed something, oldest first, with what each changed. */
	async timeline(): Promise<TurnSummary[]> {
		const out: TurnSummary[] = [];
		for (const t of this.turns) {
			const files: TurnSummary['files'] = [];
			for (const f of t.before.keys()) {
				// Put back elsewhere (git, chat Undo) and not touched again: nothing left of this prompt here.
				const touchedLater = this.turns.some(x => x.id > t.id && x.before.has(f));
				if (!touchedLater && norm(await currentText(f).catch(() => '')) === t.before.get(f)) {
					continue;
				}
				const hunks = await this.turnHunks(t.id, f);
				const lines = hunks.flatMap(h => h.lines);
				const plus = lines.filter(l => l.startsWith('+')).length;
				const minus = lines.filter(l => l.startsWith('-')).length;
				if (plus || minus) {
					files.push({ file: f, plus, minus });
				}
			}
			if (files.length) {
				out.push({ id: t.id, prompt: t.prompt, agent: t.agent, at: t.at, files });
			}
		}
		return out;
	}

	/**
	 * Undo a prompt and every prompt after it: each file goes back to how it was before the first of
	 * those prompts touched it. Asks first; edits the documents, so the editor's own undo still works.
	 */
	async undoFrom(turnId: number): Promise<{ ok: boolean; message?: string }> {
		const i = this.turns.findIndex(t => t.id === turnId);
		if (i < 0) {
			return { ok: false, message: 'That prompt is no longer tracked.' };
		}
		const committed = this.turns.slice(i).find(t => t.base);
		if (committed) {
			return { ok: false, message: `"${committed.prompt}" includes committed work; Insilode does not undo commits. Use git (revert or reset) for that.` };
		}
		const restore = new Map<string, string>();
		for (const t of this.turns.slice(i)) {
			for (const [f, text] of t.before) {
				if (!restore.has(f)) {
					restore.set(f, text);
				}
			}
		}
		// A file that changed since the agent last wrote it holds someone else's work: say so before losing it.
		const touchedByOthers: string[] = [];
		for (const f of restore.keys()) {
			const lastWrite = [...this.turns].reverse().find(t => t.after.has(f))?.after.get(f);
			const now = norm(await currentText(f).catch(() => ''));
			if (lastWrite !== undefined && now !== lastWrite) {
				touchedByOthers.push(f);
			}
		}
		const later = this.turns.length - i - 1;
		const rel = (f: string) => vscode.workspace.asRelativePath(f);
		const detail = touchedByOthers.length
			? `These files changed after the agent wrote them, and those changes will be lost too:\n${touchedByOthers.map(rel).join('\n')}\n\nAll files that go back:\n${[...restore.keys()].map(rel).join('\n')}`
			: [...restore.keys()].map(rel).join('\n');
		const action = touchedByOthers.length ? 'Undo and Lose My Edits' : 'Undo Changes';
		const pick = await vscode.window.showWarningMessage(
			later ? `Undo this prompt and the ${later} after it?` : 'Undo the changes from this prompt?',
			{ modal: true, detail },
			action,
		);
		if (pick !== action) {
			return { ok: true };
		}
		const edit = new vscode.WorkspaceEdit();
		const docs: vscode.TextDocument[] = [];
		for (const [f, text] of restore) {
			const uri = vscode.Uri.file(f);
			// A file the agent created goes away again; the first prompt in the range that touched it says whether it did.
			if (this.turns.slice(i).find(t => t.before.has(f))?.created.has(f)) {
				edit.deleteFile(uri, { ignoreIfNotExists: true });
				continue;
			}
			let doc: vscode.TextDocument;
			try {
				doc = await vscode.workspace.openTextDocument(uri);
			} catch {
				// The agent deleted it (or it was moved): write it back as it was.
				const setting = vscode.workspace.getConfiguration('files', uri).get<string>('eol');
				const eol = setting === '\r\n' || setting === '\n' ? setting : process.platform === 'win32' ? '\r\n' : '\n';
				edit.createFile(uri, { overwrite: true, contents: Buffer.from(text.replace(/\n/g, eol), 'utf8') });
				continue;
			}
			const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
			edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), text.replace(/\n/g, eol));
			docs.push(doc);
		}
		if (!await vscode.workspace.applyEdit(edit)) {
			return { ok: false, message: 'Could not undo the changes.' };
		}
		await Promise.all(docs.map(d => d.save()));
		// Restored in the editor but not on disk: keep the history, so the prompt can still be undone or inspected.
		const unsaved = docs.filter(d => d.isDirty);
		if (unsaved.length) {
			return { ok: false, message: `The changes were undone in the editor but could not be saved: ${unsaved.map(d => rel(d.uri.fsPath)).join(', ')}. Save them to finish.` };
		}
		this.turns.splice(i);
		for (const f of restore.keys()) {
			if (this.baselines.get(f) === restore.get(f)) {
				this.forget(f);
			}
		}
		this.save();
		this.changed.fire();
		return { ok: true };
	}

	/** Adds `diff` to every card whose method the agent touched (or, with `turnId`, touched in that prompt). */
	async annotate(root: FlowNode | null, turnId?: number) {
		if (!root || (turnId === undefined ? !this.baselines.size : !this.turns.some(t => t.id === turnId))) {
			return;
		}
		const tracked = (f: string) => turnId === undefined ? this.baselines.has(f) : !!this.turns.find(t => t.id === turnId)?.before.has(f);
		// Only the Git-changes view (agent 'Git') holds the file: nobody known made the change, so it is not an "agent edit".
		const gitTurn = (f: string) => {
			const by = this.turns.filter(t => (turnId === undefined || t.id === turnId) && t.before.has(f));
			return by.length > 0 && by.every(t => t.agent === GIT_AGENT);
		};
		const cache = new Map<string, Hunk[]>();
		const visit = async (n: FlowNode) => {
			// Cards carry the path as their backend spells it; the tracker keys files as VS Code spells them.
			const file = n.file ? fileKey(n.file) : undefined;
			if (file && tracked(file)) {
				if (!cache.has(file)) {
					cache.set(file, turnId === undefined ? await this.hunks(file) : await this.turnHunks(turnId, file));
				}
				const d = this.cardDiff(cache.get(file)!, n.startLine, n.endLine);
				if (d && gitTurn(file)) {
					d.source = 'git';
				}
				// Measured against committed work: say against what, and the canvas offers no Undo.
				const base = turnId === undefined ? this.committed.get(file) : this.turns.find(t => t.id === turnId)?.base;
				if (d && base) {
					d.base = base;
				}
				if (d) {
					(n as FlowNode & { diff?: CardDiff }).diff = d;
				}
			}
			for (const c of n.children) {
				await visit(c.node);
			}
		};
		await visit(root);
	}

	private cardDiff(hunks: Hunk[], start: number, end: number): CardDiff | undefined {
		// Pure and shared with Undo's hunk filter (changedMethods.ts): a pure deletion's gap lies above jsdiff's newStart.
		return spanDiff(hunks, start, end);
	}

	/** Keep: the card's file no longer shows as an agent change. */
	keep(file: string) {
		this.forget(fileKey(file));
		this.save();
		this.changed.fire();
	}

	/** Keep the agent's changes inside one card. A stub until the edits part gives it its own state: for now it keeps the card's file, as Keep does. */
	keepCard(file: string, _start: number, _end: number) {
		this.keep(file);
	}

	/** Keep every change of the prompt: no file shows as an agent change any more. */
	keepAll() {
		for (const file of [...this.baselines.keys()]) {
			this.forget(file);
		}
		this.save();
		this.changed.fire();
	}

	/** Undo every change of the prompt. A stub until the edits part fills it. */
	async undoAll(): Promise<{ ok: boolean; message?: string }> {
		return { ok: false, message: 'Undo all is not built yet.' };
	}

	/** Undo the agent's changes inside one card (method), leaving the rest of the file alone. */
	async undo(file: string, start: number, end: number): Promise<{ ok: boolean; message?: string }> {
		file = fileKey(file);
		// Checked here, not only by the canvas hiding the button: the baseline is committed work, and Undo would write it back.
		if (this.committed.has(file)) {
			return { ok: false, message: `This change is measured against ${this.committed.get(file)} and includes committed work; Insilode does not undo commits.` };
		}
		// The same test the card's diff uses, so Undo restores exactly the hunks the card shows.
		const hunks = (await this.hunks(file)).filter(h => rangeTouches(rangeOfHunk(h), start, end));
		if (!hunks.length) {
			return { ok: true };
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const edit = new vscode.WorkspaceEdit();
		for (const h of hunks) {
			// A pure deletion is an empty range at the line after the gap: its old lines go back in above that line.
			const e = undoEdit(h);
			edit.replace(doc.uri, new vscode.Range(e.from, 0, e.to, 0), e.lines.map(l => l + eol).join(''));
		}
		if (!await vscode.workspace.applyEdit(edit)) {
			return { ok: false, message: 'Could not undo the change.' };
		}
		await doc.save();
		if (!(await this.hunks(file)).length) {
			this.forget(file);
		}
		this.save();
		this.changed.fire();
		return { ok: true };
	}

	dispose() {
		// A write still waiting for its delay is the user's Keep/Undo state: write it now.
		void this.flushNow();
		this.changed.dispose();
	}
}
