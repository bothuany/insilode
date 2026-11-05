/*---------------------------------------------------------------------------------------------
 *  Insilode boards, commands and the Markdown stand-in: Show Board opens a board on the canvas (the store presents it), and
 *  the Markdown export writes one board as a file (mermaid diagram + node table) and opens it in VS Code's Markdown preview.
 *  The same Markdown path is the BoardHost the canvas falls back to when it cannot open a board. Each board has one file
 *  with a stable name, overwritten on every draw, so nothing piles up.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { boardMarkdown } from './markdown';
import { boardFileName, type BoardHost, type BoardStore, type StoredBoard } from './store';
import type { BoardSpec } from './spec';
import { isAlive } from '../mcp/registry';

const PREVIEW = 'vscode.markdown.preview.editor';

export class MarkdownBoardViewer implements BoardHost, vscode.Disposable {
	private readonly dir: string;
	private readonly disposables: vscode.Disposable[] = [];
	/** Boards this window already announced: a redraw of the same board is not announced again. */
	private readonly announced = new Set<string>();

	constructor(context: vscode.ExtensionContext, private readonly store: BoardStore, private readonly log: vscode.LogOutputChannel) {
		// One folder per workspace (a window without a folder shares the global one): files are named by board id, so a
		// board drawn again overwrites its file instead of leaving one per window.
		this.dir = path.join((context.storageUri ?? context.globalStorageUri).fsPath, 'boards');
		void this.sweep(path.join(context.globalStorageUri.fsPath, 'boards'));
		this.disposables.push(
			store.onDidChange(e => {
				if (e.type === 'delete') {
					this.announced.delete(e.id);
					void fs.rm(this.fileOf(e.id), { force: true }).catch(() => undefined);
				} else if (e.type === 'set') {
					this.announce(e.id);
				}
			}),
			// Show Board opens the canvas: the Markdown file is only an export.
			vscode.commands.registerCommand('flow.board.show', (id?: string) => this.showBoard(id)),
			vscode.commands.registerCommand('flow.board.exportMarkdown', (id?: string) => this.exportMarkdown(id)),
		);
	}

	/** Folders of windows that no longer run, left by the versions that kept one folder per window process. */
	private async sweep(root: string) {
		for (const name of await fs.readdir(root).catch(() => [] as string[])) {
			if (/^\d+$/.test(name) && Number(name) !== process.pid && !isAlive(Number(name))) {
				await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
			}
		}
	}

	/** A short toast for a board an agent drew for the first time: the title and a way to open it, no tool names. */
	private announce(id: string) {
		const board = this.store.get(id);
		if (!board || board.origin !== 'agent' || this.announced.has(id)) {
			return;
		}
		this.announced.add(id);
		void Promise.resolve(vscode.window.showInformationMessage(`Board drawn: ${board.spec.title}`, 'Open')).then(async pick => {
			if (pick === 'Open') {
				await this.store.present(id);
			}
		});
	}

	private fileOf(id: string) {
		return path.join(this.dir, boardFileName(id));
	}

	/** A `file:` link the Markdown preview opens at the line (`#L12`). */
	private link(file: string, line?: number) {
		return vscode.Uri.file(file).toString().replace(/\(/g, '%28').replace(/\)/g, '%29') + (line ? `#L${line}` : '');
	}

	private async write(id: string, spec: BoardSpec) {
		await fs.mkdir(this.dir, { recursive: true });
		const file = this.fileOf(id);
		await fs.writeFile(file, boardMarkdown(id, spec, { link: (f, l) => this.link(f, l), display: f => vscode.workspace.asRelativePath(f, false) }), 'utf8');
		return vscode.Uri.file(file);
	}

	private isOpen(uri: vscode.Uri) {
		return vscode.window.tabGroups.all.some(g => g.tabs.some(t => {
			const input = t.input as { uri?: vscode.Uri; viewType?: string } | undefined;
			return input?.uri?.toString() === uri.toString() && input.viewType === PREVIEW;
		}));
	}

	async show(id: string, spec: BoardSpec) {
		const uri = await this.write(id, spec);
		if (this.isOpen(uri)) {
			return; // the open preview follows the file
		}
		try {
			await vscode.commands.executeCommand('vscode.openWith', uri, PREVIEW, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
		} catch (e) {
			this.log.warn(`board: the preview editor did not open (${(e as Error).message}); trying the side preview`);
			await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
		}
	}

	async update(id: string, spec: BoardSpec) {
		await this.write(id, spec);
	}

	/** A board by id, else the one the user picks from the list (the only board is taken without asking). */
	private async choose(id: string | undefined, title: string): Promise<StoredBoard | undefined> {
		const known = typeof id === 'string' ? this.store.get(id) : undefined;
		if (known) {
			return known;
		}
		const boards = this.store.list();
		if (!boards.length) {
			void vscode.window.showInformationMessage('Insilode: no board yet. Open a flow and run "Pin Flow as Board", or ask an agent to draw one.');
			return undefined;
		}
		if (boards.length === 1) {
			return boards[0];
		}
		const chosen = await vscode.window.showQuickPick(boards.map(b => ({ label: b.spec.title, description: `${b.spec.kind} · ${b.spec.nodes.length} nodes`, detail: b.id, b })), { title });
		return chosen?.b;
	}

	/** `flow.board.show`: a board on the canvas, in its tab (opened if it was closed, brought forward if it is open). */
	private async showBoard(id?: string) {
		const board = await this.choose(id, 'Insilode: show a board');
		if (board && !(await this.store.present(board.id))) {
			void vscode.window.showInformationMessage(`Insilode: there is no board "${board.id}" to show.`);
		}
	}

	/** `flow.board.exportMarkdown`: the board as a Markdown file in the preview editor. */
	private async exportMarkdown(id?: string) {
		const board = await this.choose(id, 'Insilode: export a board as Markdown');
		if (board) {
			await this.show(board.id, board.spec);
		}
	}

	dispose() {
		this.disposables.forEach(d => d.dispose());
	}
}
