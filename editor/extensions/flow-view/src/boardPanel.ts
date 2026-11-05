/*---------------------------------------------------------------------------------------------
 *  Insilode: the board canvas (ui/src/board, built to ui/dist-webview/board.js) in an editor tab: DTO relations, the
 *  architecture view, and later plans and agent boards. Like panel.ts the page is one inlined script, a nonce CSP
 *  and a JSON bootstrap, because the shell's webviews run without a service worker. The page never reads the
 *  workspace: it posts what the user did ('open', 'rebuild', 'export') and this host answers, checking each field.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exportFormat, exportPayload, fileStem, openableSetting, revealsExistingTab, sanitizeRequest, type BoardRequest, type ExportFormat } from './boardRequest';
import { moveHash } from '../../../../board-canvas/layout';
import { canvasSpecOf } from './board/canvas';
import { toMermaid } from './board/mermaid';
import { OverridesStore } from './board/overrides';
import { cleanBoardId, type BoardExtra, type BoardHost, type BoardRef } from './board/store';
import type { BoardSpec } from './board/spec';
import { flowRoot } from './root';

/** Something that can draw a board again for new options: what the canvas's focus, search and filter controls ask for. */
export interface BoardSource {
	/** Echoed by the canvas in 'rebuild'; a rebuild for another kind is refused. */
	readonly kind: string;
	build(request: BoardRequest): Promise<BoardSpec>;
	/** Mermaid or PlantUML text of a board; without it Mermaid comes from board/mermaid.ts and PlantUML is not offered. */
	exportText?(spec: BoardSpec, format: 'mermaid' | 'plantuml'): string | undefined;
	/** false: the source ignores `query`, so the canvas only highlights matches instead of asking again. Default true. */
	searchOnHost?: boolean;
}

export interface BoardShowOptions {
	/** One tab per key (default: the board's kind); showing the same key again redraws that tab. */
	key?: string;
	source?: BoardSource;
	/** The toolbar state to start with (a focused type, hidden roles). */
	request?: BoardRequest;
	viewColumn?: vscode.ViewColumn;
	preserveFocus?: boolean;
	since?: BoardSpec;
	boards?: BoardRef[];
	/** Bring the tab forward when it is already open: only for a request to show the board, never for a redraw (see revealsExistingTab). */
	reveal?: boolean;
}

interface Tab {
	panel: vscode.WebviewPanel;
	spec: BoardSpec;
	request: BoardRequest;
	source?: BoardSource;
	/** The board compared with its previous draw, for the switch that shows what changed. */
	since?: BoardSpec;
	boards?: BoardRef[];
	/** The webview has said it is listening. */
	ready: boolean;
	/** The state changed after the page was written: the webview is sent it when it is ready. */
	stale: boolean;
	/** Requests (a picture for an agent) that wait for the page to be ready. */
	onReady?: (() => void)[];
}

/** A file the canvas may ask to open: inside a workspace folder, spelled the way VS Code spells it. */
function workspaceFile(file: unknown): string | undefined {
	if (typeof file !== 'string' || !file) {
		return undefined;
	}
	const uri = vscode.Uri.file(file);
	return vscode.workspace.getWorkspaceFolder(uri) ? uri.fsPath : undefined;
}

/** JSON for an inline <script>: `</script>`, `<!--` and the JS line separators cannot end or alter the script. */
function inertJson(value: unknown) {
	return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export class BoardPanel implements vscode.Disposable {
	private readonly dist: string;
	private readonly tabs = new Map<string, Tab>();
	private store: { present(id: string): Promise<boolean> } | undefined;
	private readonly changed = new vscode.EventEmitter<string | undefined>();
	/** Fires with the key of the tab that became the active one (undefined when none is). */
	readonly onDidChangeActive = this.changed.event;

	/** What the user moved or noted on canvas boards, kept per board id in the workspace's state. */
	private readonly overrides: OverridesStore;

	constructor(context: vscode.ExtensionContext, private readonly log?: vscode.LogOutputChannel) {
		this.dist = path.join(flowRoot(context.extensionPath), 'ui', 'dist-webview');
		this.overrides = new OverridesStore(context.workspaceState);
	}

	/** The board id a tab key stands for: agent boards are `board:<id>`. */
	private boardId(key: string) {
		return key.startsWith('board:') ? key.slice('board:'.length) : key;
	}

	/** Opens the board in its tab (or redraws the tab that is open). */
	async show(spec: BoardSpec, options: BoardShowOptions = {}): Promise<void> {
		const key = options.key ?? spec.kind;
		const request = sanitizeRequest(options.request);
		if (spec.kind === 'canvas') {
			// What belonged to an element the redraw no longer has is forgotten; the rest survives (a move whose frame changed is dropped by the layout).
			this.overrides.prune(this.boardId(key), (spec.elements ?? []).map(e => e.id));
		}
		const tab = this.tabs.get(key);
		if (tab) {
			Object.assign(tab, { spec, request, source: options.source ?? tab.source, since: options.since, boards: options.boards, stale: true });
			tab.panel.title = spec.title;
			if (revealsExistingTab(true, options.reveal)) {
				tab.panel.reveal(undefined, options.preserveFocus ?? true);
			}
			this.post(tab);
			return;
		}
		const panel = vscode.window.createWebviewPanel('flow.board', spec.title, { viewColumn: options.viewColumn ?? vscode.ViewColumn.Active, preserveFocus: options.preserveFocus ?? true }, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		const created: Tab = { panel, spec, request, source: options.source, since: options.since, boards: options.boards, ready: false, stale: false };
		try {
			panel.webview.html = await this.html(panel.webview, created, key);
		} catch (e) {
			// The board build is missing: no blank tab left behind.
			panel.dispose();
			throw new Error(`The board canvas is not built (${(e as Error).message}). Run \`npm --prefix ui run build\`.`);
		}
		panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
		this.tabs.set(key, created);
		panel.onDidDispose(() => {
			if (this.tabs.get(key) === created) {
				this.tabs.delete(key);
			}
			this.changed.fire(this.activeKey());
		});
		panel.onDidChangeViewState(() => this.changed.fire(this.activeKey()));
		panel.webview.onDidReceiveMessage(m => {
			this.onMessage(created, m).catch(e => {
				this.log?.warn(`board: ${(e as Error).message ?? e}`);
				void vscode.window.showErrorMessage(`Insilode: ${(e as Error).message ?? e}`);
			});
		});
		this.changed.fire(this.activeKey());
	}

	/** Redraws an open board from its source with the options it has now (the type graph changed). */
	async refresh(key: string): Promise<void> {
		const tab = this.tabs.get(key);
		if (!tab?.source) {
			return;
		}
		try {
			tab.spec = await tab.source.build(tab.request);
			tab.stale = true;
			this.post(tab, undefined, true);
		} catch (e) {
			this.log?.warn(`board refresh: ${(e as Error).message}`);
		}
	}

	/** The key of the visible, active board tab, if one is. */
	activeKey(): string | undefined {
		for (const [key, tab] of this.tabs) {
			if (tab.panel.active) {
				return key;
			}
		}
		return undefined;
	}

	/** The board a tab shows now. */
	specOf(key: string): BoardSpec | undefined {
		return this.tabs.get(key)?.spec;
	}

	sourceOf(key: string): BoardSource | undefined {
		return this.tabs.get(key)?.source;
	}

	isOpen(key: string) {
		return this.tabs.has(key);
	}

	/** The store's host interface: boards an agent draws or a plan becomes, one tab per board id. */
	/** The store the agent's boards live in: a click that zooms into another board asks it to show that one. */
	setStore(store: { present(id: string): Promise<boolean> }) {
		this.store = store;
	}

	/** Whether a board of the store is open in a tab (the store never evicts one that is). */
	isBoardOpen(id: string): boolean {
		return this.tabs.has(`board:${id}`);
	}

	asHost(): BoardHost {
		return {
			// A new tab opens without taking focus; an open one comes forward only when the store was asked to present it.
			show: (id, spec, extra?: BoardExtra) => this.show(spec, { key: `board:${id}`, preserveFocus: true, since: extra?.since, boards: extra?.boards, reveal: extra?.reveal }),
			// A redraw of an open tab: never reveals, so an agent updating a board does not pull it in front of the user's own tab.
			update: (id, spec, extra?: BoardExtra) => (this.tabs.has(`board:${id}`) ? this.show(spec, { key: `board:${id}`, preserveFocus: true, since: extra?.since, boards: extra?.boards }) : undefined),
			image: (id, timeoutMs, step) => this.image(`board:${id}`, timeoutMs, step),
			overrides: id => this.overrides.get(id),
			forgetOverrides: id => this.overrides.forget(id),
		};
	}

	/**
	 * Asks the tab for a picture of the board it shows (the webview renders its SVG and rasterises it) and answers with the
	 * base64 PNG, or nothing when there is no such tab or it does not answer in time. The panel is retained while hidden, so a
	 * tab behind another one still answers.
	 */
	image(key: string, timeoutMs = 10_000, step?: number): Promise<string | undefined> {
		const tab = this.tabs.get(key);
		if (!tab) {
			return Promise.resolve(undefined);
		}
		const seq = ++this.imageSeq;
		return new Promise<string | undefined>(resolve => {
			const timer = setTimeout(() => { this.images.delete(seq); resolve(undefined); }, timeoutMs);
			this.images.set(seq, png => { clearTimeout(timer); this.images.delete(seq); resolve(png); });
			const ask = () => void tab.panel.webview.postMessage({ type: 'render', seq, step });
			// A tab that was just created has not said 'ready' yet: the request waits for that (bounded by the same timer).
			if (tab.ready) {
				ask();
			} else {
				(tab.onReady ??= []).push(ask);
			}
		});
	}

	private readonly images = new Map<number, (png: string | undefined) => void>();
	private imageSeq = 0;

	private post(tab: Tab, seq?: number, refresh = false) {
		if (!tab.ready) {
			return; // it asks for the current state when it starts
		}
		tab.stale = false;
		void tab.panel.webview.postMessage({ type: 'board', spec: tab.spec, since: tab.since, boards: tab.boards, opts: tab.request, seq, refresh: refresh || undefined, overrides: this.overridesOf(tab) });
	}

	private keyOf(tab: Tab) {
		return [...this.tabs].find(([, t]) => t === tab)?.[0];
	}

	/** The user's moves and notes for the board a canvas tab shows (none for other kinds). */
	private overridesOf(tab: Tab, key = this.keyOf(tab)) {
		return tab.spec.kind === 'canvas' && key ? this.overrides.get(this.boardId(key)) : undefined;
	}

	private async onMessage(tab: Tab, m: Record<string, unknown> | undefined) {
		switch (m?.type) {
			case 'ready':
				tab.ready = true;
				if (tab.stale) {
					this.post(tab);
				}
				for (const fn of tab.onReady?.splice(0) ?? []) {
					fn();
				}
				return;
			case 'image': {
				// The picture a `render` asked for: base64 PNG, bounded (a 1600px-wide board is well under 2 MB), or nothing when the page could not draw it.
				const waiting = typeof m.seq === 'number' ? this.images.get(m.seq) : undefined;
				if (waiting) {
					const png = typeof m.png === 'string' && m.png.length < 4_000_000 && /^[A-Za-z0-9+/=]+$/.test(m.png) ? m.png : undefined;
					waiting(png);
				}
				return;
			}
			case 'move': {
				// A drag the user ended: the element must be on this canvas board and the place a number on the drawing. The hash is the host's own, from this tab's spec, never the page's.
				const key = this.keyOf(tab);
				const canvas = canvasSpecOf(tab.spec);
				const id = typeof m.id === 'string' ? m.id : undefined;
				const hash = canvas && id ? moveHash(canvas, id) : undefined;
				if (key && id && hash) {
					this.overrides.move(this.boardId(key), id, m.x, m.y, hash);
				}
				return;
			}
			case 'note': {
				const key = this.keyOf(tab);
				const id = typeof m.id === 'string' ? m.id : undefined;
				if (key && id && canvasSpecOf(tab.spec)?.elements.some(e => e.id === id)) {
					this.overrides.note(this.boardId(key), id, m.text);
				}
				return;
			}
			case 'resetMoves': {
				const key = this.keyOf(tab);
				if (key && tab.spec.kind === 'canvas') {
					this.overrides.resetMoves(this.boardId(key));
				}
				return;
			}
			case 'open': {
				const file = workspaceFile(m.file);
				if (!file) {
					return;
				}
				const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
				const line = Math.max(0, Math.min(doc.lineCount - 1, (Math.floor(Number(m.line)) || 1) - 1));
				const at = new vscode.Position(line, 0);
				// The board stays focused: browsing a diagram should not pull the keyboard into the editor.
				await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(at, at), preview: true, preserveFocus: true });
				return;
			}
			case 'create': {
				// Skeleton first: the node id only. The path, the folder check and the write are the skeleton host's own work.
				const id = this.keyOf(tab);
				if (id?.startsWith('board:') && typeof m.node === 'string') {
					await vscode.commands.executeCommand('flow.skeleton.createFile', id.slice('board:'.length), m.node);
				}
				return;
			}
			case 'zoom': {
				// A click on a C4 box that zooms into another board: the id is cleaned and must be a board the store holds.
				const id = cleanBoardId(m.board);
				if (!id || !this.store || !(await this.store.present(id))) {
					void vscode.window.showWarningMessage(`Insilode: there is no board "${String(m.board).slice(0, 64)}" to open.`);
				}
				return;
			}
			case 'rebuild': {
				const seq = typeof m.seq === 'number' ? m.seq : undefined;
				const source = tab.source;
				if (!source || m.kind !== source.kind) {
					await tab.panel.webview.postMessage({ type: 'error', message: 'This board cannot be redrawn.', seq });
					return;
				}
				const request = sanitizeRequest(m.opts);
				try {
					tab.spec = await source.build(request);
					tab.request = request;
					this.post(tab, seq);
				} catch (e) {
					await tab.panel.webview.postMessage({ type: 'error', message: (e as Error).message ?? String(e), seq });
				}
				return;
			}
			case 'export': {
				const format = exportFormat(m.format);
				if (format) {
					await this.export(tab, format, m.data, m.name);
				}
				return;
			}
			case 'settings': {
				// An empty state's "Edit DTO suffixes": the page names a setting, the host opens it only when it is on the fixed list.
				const setting = openableSetting(m.setting);
				if (setting) {
					await vscode.commands.executeCommand('workbench.action.openSettings', setting);
				}
				return;
			}
		}
	}

	private async export(tab: Tab, format: ExportFormat, data: unknown, name: unknown) {
		const stem = fileStem(name ?? tab.spec.title, 'board');
		if (format === 'mermaid') {
			const text = this.text(tab, 'mermaid');
			if (text) {
				await vscode.env.clipboard.writeText(text);
				void vscode.window.showInformationMessage('Insilode: the diagram is on the clipboard as Mermaid.');
			}
			return;
		}
		let content: string | Buffer | undefined;
		let filters: Record<string, string[]>;
		let ext: string;
		if (format === 'plantuml') {
			content = this.text(tab, 'plantuml');
			filters = { PlantUML: ['puml'] };
			ext = 'puml';
			if (!content) {
				void vscode.window.showWarningMessage('Insilode: PlantUML export is not available for this board.');
				return;
			}
		} else if (format === 'json') {
			// The host's own copy: what the page shows is what was last sent to it.
			content = JSON.stringify(tab.spec, null, 2);
			filters = { JSON: ['json'] };
			ext = 'json';
		} else {
			content = exportPayload(format, data);
			filters = format === 'svg' ? { SVG: ['svg'] } : { PNG: ['png'] };
			ext = format;
			if (content === undefined) {
				void vscode.window.showWarningMessage(`Insilode: the ${format.toUpperCase()} export did not work.`);
				return;
			}
		}
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(folder, `${stem}.${ext}`)), filters, saveLabel: 'Save' });
		if (!target) {
			return;
		}
		await fs.writeFile(target.fsPath, content);
		void vscode.window.showInformationMessage(`Insilode: saved ${path.basename(target.fsPath)}.`);
	}

	private text(tab: Tab, format: 'mermaid' | 'plantuml'): string | undefined {
		const own = tab.source?.exportText?.(tab.spec, format);
		return own ?? (format === 'mermaid' ? toMermaid(tab.spec) : undefined);
	}

	/** Everything inline, as in panel.ts: no side files, a nonce for the one script. */
	private async html(webview: vscode.Webview, tab: Tab, key: string) {
		const [js, css] = await Promise.all([
			fs.readFile(path.join(this.dist, 'board.js'), 'utf8'),
			fs.readFile(path.join(this.dist, 'board.css'), 'utf8'),
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
		const safe = (text: string, tag: string) => text.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`).replace(/<!--/g, '\\x3C!--');
		const boot = { spec: tab.spec, since: tab.since, boards: tab.boards, source: tab.source?.kind, search: tab.source?.searchOnHost === false ? 'local' : 'host', opts: tab.request, dark, overrides: this.overridesOf(tab, key) };
		return `<!doctype html><html><head><meta charset="utf-8">` +
			`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
			`<style>${safe(css, 'style')}</style>` +
			`<script nonce="${nonce}">window.__BOARD__=${inertJson(boot)}</script>` +
			`</head><body><div id="root"></div><script nonce="${nonce}">${safe(js, 'script')}</script></body></html>`;
	}

	dispose() {
		for (const tab of this.tabs.values()) {
			tab.panel.dispose();
		}
		this.tabs.clear();
		this.changed.dispose();
	}
}
