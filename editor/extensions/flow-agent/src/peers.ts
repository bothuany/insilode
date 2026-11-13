/*---------------------------------------------------------------------------------------------
 *  Insilode: the other windows' agents. This window publishes its sanitised rows to rows.json in its own storage folder and
 *  reads its siblings' (peersCore.ts validates everything it reads). Two actions reach another window, both through a small
 *  request file its owner validates and deletes: reveal a session, open its flow. Nothing else travels through files.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, unlinkSync, watch, type FSWatcher } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildRows } from './agentRows';
import type { Agents } from './agents';
import type { PeerProject, RecentProject } from './agentsData';
import { isKey, mustRepublish, publishedAfter, readProjects, serial, slimRow, takeRequests, writeJson, writeRequest, type PeerFound, type RecentFound } from './peersCore';
import type { WorktreeRows } from './worktreeActions';

const POLL_MS = 5000;

export class Peers implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private peers: PeerFound[] = [];
	private recent: RecentFound[] = [];
	private readonly subs: vscode.Disposable[];
	private watcher: FSWatcher | undefined;
	private poll: NodeJS.Timeout | undefined;
	private publishTimer: NodeJS.Timeout | undefined;
	private scanTimer: NodeJS.Timeout | undefined;
	private root = '';
	private own = '';
	private rowsFile = '';
	private published = '';
	private seen = '';
	private disposed = false;

	constructor(private readonly agents: Agents, private readonly worktrees?: WorktreeRows) {
		// Granting trust later restarts the agents (start() is memoised) and gives the window its storage folder: begin then too.
		this.subs = [agents.onDidChange(() => this.schedulePublish()), vscode.workspace.onDidGrantWorkspaceTrust(() => void agents.start().then(() => this.begin()))];
		// The storage folder exists once the agents have started; an untrusted window has none until it is trusted.
		void agents.start().then(() => this.begin());
	}

	/** What the page and the dock are sent: no paths. */
	view(): { peers: PeerProject[]; recent: RecentProject[] } {
		return { peers: this.peers.map(({ key, name, rows }) => ({ key, name, rows })), recent: this.recent.map(({ key, name, sessions }) => ({ key, name, sessions })) };
	}

	private begin() {
		const dir = this.agents.storageDir;
		if (!dir || this.disposed || this.rowsFile) {
			return;
		}
		this.root = path.dirname(dir);
		this.own = path.basename(dir);
		this.rowsFile = path.join(dir, 'rows.json');
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (folder) {
			void writeJson(path.join(dir, 'project.json'), { folder, name: path.basename(folder) }).catch(() => undefined);
		}
		try {
			// Recursive watching works on Windows and macOS and on current Node on Linux; the poll below covers any place it does not.
			this.watcher = watch(this.root, { recursive: true }, () => this.schedule());
			this.watcher.on('error', () => undefined);
		} catch {
			// the poll alone then
		}
		this.poll = setInterval(() => this.schedule(), POLL_MS);
		this.schedulePublish();
		this.schedule();
	}

	private schedulePublish() {
		if (!this.rowsFile) {
			return;
		}
		clearTimeout(this.publishTimer);
		this.publishTimer = setTimeout(() => void this.publish(), 400);
	}

	/** One write at a time (see `serial`); `void this.publish()` stays the way to ask for one. */
	private readonly publish = serial(() => this.write());

	private async write() {
		const rows = buildRows(this.agents, this.worktrees, new Map(), []).map(slimRow);
		const body = JSON.stringify(rows);
		if (body === this.published || this.disposed) {
			return;
		}
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
		// Remembered only once written: after a failure nothing is remembered, so the poll (scan) publishes again, or the others keep a stale state such as "working".
		const written = await writeJson(this.rowsFile, { folder, name: folder ? path.basename(folder) : 'Window without a folder', pid: process.pid, updatedAt: Date.now(), rows }).then(() => true, () => false);
		this.published = publishedAfter(body, written);
	}

	private schedule() {
		clearTimeout(this.scanTimer);
		this.scanTimer = setTimeout(() => void this.scan(), 300);
	}

	private async scan() {
		const dir = path.join(this.root, this.own);
		for (const req of await takeRequests(dir, id => this.agents.sessions.has(id))) {
			if (req.type === 'flow') {
				this.agents.openImpactFlow(req.id, 0);
			} else if (this.agents.sessions.get(req.id)?.state !== 'ended') {
				this.agents.show(req.id);
			}
		}
		// Our own file went missing (a window on the same folder removed it) or failed to write: publish again.
		if (await mustRepublish(this.published, this.rowsFile)) {
			this.published = '';
			this.schedulePublish();
		}
		const found = await readProjects(this.root, this.own);
		const sig = JSON.stringify(found);
		if (sig !== this.seen && !this.disposed) {
			this.seen = sig;
			this.peers = found.peers;
			this.recent = found.recent;
			this.changed.fire();
		}
	}

	/**
	 * What the user chose on another project. The page names a storage key and a session id; both are looked up in what this window
	 * read, so only a project and session that were listed are acted on. Both actions bring the project's window up (an
	 * already-open folder is focused, not opened twice) after the request is written, so the window that comes up has it waiting.
	 */
	async act(action: 'ide' | 'flow', key: string, id?: string): Promise<void> {
		if (!isKey(key)) {
			return;
		}
		const open = this.peers.find(p => p.key === key);
		const project = open ?? this.recent.find(p => p.key === key);
		if (!project?.folder) {
			return;
		}
		const row = id && open ? open.rows.find(r => r.id === id) : undefined;
		if (action === 'flow' && !(row && row.flows > 0)) {
			return;
		}
		if (row) {
			await writeRequest(path.join(this.root, key), { type: action === 'flow' ? 'flow' : 'reveal', id: row.id }).catch(() => undefined);
		}
		// forceNewWindow: a folder that is not open opens beside this window instead of replacing it; one that is open is focused.
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(project.folder), { forceNewWindow: true });
	}

	dispose() {
		this.disposed = true;
		clearTimeout(this.publishTimer);
		clearTimeout(this.scanTimer);
		clearInterval(this.poll);
		this.watcher?.close();
		this.subs.forEach(d => d.dispose());
		this.changed.dispose();
		try {
			// Only our own file: a window on the same folder shares this folder and may have written its own just now.
			if (this.rowsFile && (JSON.parse(readFileSync(this.rowsFile, 'utf8')) as { pid?: unknown }).pid === process.pid) {
				unlinkSync(this.rowsFile);
			}
		} catch {
			// already gone
		}
	}
}
