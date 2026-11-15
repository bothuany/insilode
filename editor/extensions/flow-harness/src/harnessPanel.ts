/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the "Harness" page (`flowHarness.open`). One place for what is spread over the Map, the MCP servers page, the Why?
 *  view and the Harness Flow page: the folder's lint, instructions, hooks, permissions, MCP servers, skills, subagents and commands.
 *  It reads the same data the Agents page's Harness panel gets (`harnessSummary`, read-only and redacted) and the MCP manager's servers,
 *  and every action goes to the code that already does it: the MCP manager for servers, `flowHarness.why`, the map and the flow page by
 *  their commands. The page's messages are parsed in harnessPage.ts: it never names a command or a file the host did not send.
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as vscode from 'vscode';
import { buildPageData, harnessHtml, openable, parseMessage, type McpInput, type PageAction } from './harnessPage';
import type { McpManager } from './mcpManager';
import { harnessSummary, type SummaryResult } from './summary';

/** The MCP manager's message type for each action the page may ask for: fixed here, never taken from the page. */
const MCP_TYPE = { add: 'add', checkAll: 'checkAll', check: 'check', open: 'open', edit: 'edit', toggle: 'toggle', remove: 'remove' } as const;
/** A page that comes back into view reads again only when what it shows is this old. */
const STALE_MS = 30_000;

export class HarnessPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	/** The page posts 'ready' once its listener is up; data sent before is lost. */
	private ready = false;
	private summary: SummaryResult | undefined;
	private mcpData: McpInput | undefined;
	/** What the page may ask to open: the files of the data last sent to it. */
	private files = new Set<string>();
	/** The last file in a text editor: a webview is not one, so the Why? button asks about this one. */
	private lastFile: string | undefined;
	private readAt = 0;
	private seq = 0;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly root: () => string | undefined, private readonly mcp: McpManager) {
		this.lastFile = vscode.window.activeTextEditor?.document.uri.scheme === 'file' ? vscode.window.activeTextEditor.document.uri.fsPath : undefined;
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(ed => {
				if (ed?.document.uri.scheme === 'file') {
					this.lastFile = ed.document.uri.fsPath;
					this.post();
				}
			}),
		);
	}

	dispose() {
		this.panel?.dispose();
		this.disposables.forEach(d => d.dispose());
	}

	/** Opens the page, or brings the open one forward (one per window). */
	async show() {
		if (this.panel) {
			this.panel.reveal();
			if (Date.now() - this.readAt > STALE_MS) {
				await this.refresh();
			}
			return;
		}
		this.panel = vscode.window.createWebviewPanel('flowHarness.harness', 'Harness', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
		this.ready = false;
		this.panel.webview.html = harnessHtml();
		// A check in progress, a finished edit or a rescan of the map: the servers show the same state as the MCP page. Watched only while this
		// page is open, so a rescan with no page open does not read the MCP configs.
		const watch = this.mcp.watch(data => {
			this.mcpData = data;
			this.post();
		});
		this.panel.onDidDispose(() => {
			watch.dispose();
			this.panel = undefined;
			this.files = new Set();
		}, null, this.disposables);
		this.panel.webview.onDidReceiveMessage(m => void this.message(m).catch(e => void vscode.window.showErrorMessage(`Harness: ${(e as Error).message}`)), null, this.disposables);
		this.panel.onDidChangeViewState(e => {
			if (e.webviewPanel.visible && Date.now() - this.readAt > STALE_MS) {
				void this.refresh();
			}
		}, null, this.disposables);
		await this.refresh();
	}

	/** Reads the servers and the summary again. The servers show first; the page keeps the last summary until the new one is in. */
	private async refresh() {
		const mine = ++this.seq;
		const root = this.root();
		this.mcpData = await this.mcp.view();
		this.post();
		const summary = root ? await harnessSummary(root) : undefined;
		if (mine !== this.seq) {
			return;
		}
		this.summary = summary;
		this.readAt = Date.now();
		this.post();
	}

	private post() {
		if (!this.panel || !this.ready) {
			return;
		}
		const root = this.root();
		const data = buildPageData({ root, summary: this.summary, mcp: this.mcpData, why: this.lastFile && baseName(this.lastFile), home: os.homedir() });
		this.files = openable(data);
		void this.panel.webview.postMessage({ type: 'data', data });
	}

	private async message(raw: unknown) {
		const action = parseMessage(raw, this.files);
		if (action) {
			await this.run(action);
		}
	}

	private async run(a: PageAction) {
		switch (a.kind) {
			case 'ready':
				this.ready = true;
				return this.post();
			case 'refresh':
				return this.refresh();
			case 'why':
				return this.why();
			case 'view':
				// The Map is the first view of the Harness container: opening the container shows it. The flow page is flow-view's.
				return this.guarded(() => a.view === 'map' ? vscode.commands.executeCommand('workbench.view.extension.flowHarness') : vscode.commands.executeCommand('flow.showHarnessFlow'));
			case 'open':
				await vscode.window.showTextDocument(vscode.Uri.file(a.file), { selection: a.line ? new vscode.Range(a.line - 1, 0, a.line - 1, 0) : undefined, preview: true, viewColumn: vscode.ViewColumn.One });
				return;
			case 'mcp':
				return this.mcp.handle({ type: MCP_TYPE[a.action], id: a.id });
		}
	}

	/** The existing Why? view, for the last file in an editor or, with none, one picked here. */
	private async why() {
		let file = this.lastFile;
		if (!file) {
			const root = this.root();
			const picked = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: root ? vscode.Uri.file(root) : undefined, title: 'Why? for which file' });
			file = picked?.[0]?.fsPath;
		}
		if (file) {
			await this.guarded(() => vscode.commands.executeCommand('flowHarness.why', vscode.Uri.file(file)));
		}
	}

	/** Runs one of the fixed commands above; a view from another extension that is not installed says so rather than failing silently. */
	private async guarded(run: () => Thenable<unknown>) {
		try {
			await run();
		} catch (e) {
			void vscode.window.showWarningMessage(`Harness: could not open that view (${(e as Error).message}).`);
		}
	}
}

const baseName = (file: string) => file.split(/[\\/]/).filter(Boolean).pop() ?? file;
