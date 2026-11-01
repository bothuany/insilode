/*---------------------------------------------------------------------------------------------
 *  Insilode boards, stand-in viewer: each board is a Markdown file (mermaid diagram + node table) shown
 *  in VS Code's Markdown preview editor beside the code, opened without taking focus. Rewriting the
 *  file refreshes an open preview. This is a BoardHost: a canvas renderer can replace it later
 *  without touching the store or the tools.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { boardMarkdown } from './markdown';
import { boardFileName, type BoardHost, type BoardStore } from './store';
import type { BoardSpec } from './spec';
import { isAlive } from '../mcp/registry';

const PREVIEW = 'vscode.markdown.preview.editor';

export class MarkdownBoardViewer implements BoardHost, vscode.Disposable {
	private readonly dir: string;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(context: vscode.ExtensionContext, private readonly store: BoardStore, private readonly log: vscode.LogOutputChannel) {
		// One folder per window: windows share the global storage, and one must not delete the boards another shows.
		const root = path.join(context.globalStorageUri.fsPath, 'boards');
		this.dir = path.join(root, String(process.pid));
		void this.sweep(root);
		this.disposables.push(
			store.onDidChange(e => e.type === 'delete' && void fs.rm(this.fileOf(e.id), { force: true }).catch(() => undefined)),
			vscode.commands.registerCommand('flow.board.show', (id?: string) => this.pick(id)),
			// The Markdown stand-in is an export: the canvas is where a board is shown (the board part moves Show Board there).
			vscode.commands.registerCommand('flow.board.exportMarkdown', (id?: string) => this.pick(id)),
		);
	}

	/** Board folders of windows that no longer run. */
	private async sweep(root: string) {
		for (const name of await fs.readdir(root).catch(() => [] as string[])) {
			if (/^\d+$/.test(name) && Number(name) !== process.pid && !isAlive(Number(name))) {
				await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => undefined);
			}
		}
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

	/** `flow.board.show`: reopen a board (the newest when asked without an id, or a pick from the list). */
	private async pick(id?: string) {
		let board = id ? this.store.get(id) : undefined;
		if (!board) {
			const boards = this.store.list();
			if (!boards.length) {
				void vscode.window.showInformationMessage('Insilode: no board yet. Open a flow and run "Pin Flow as Board", or an agent draws one (draw_board, or a plan it proposes).');
				return;
			}
			const chosen = await vscode.window.showQuickPick(boards.map(b => ({ label: b.spec.title, description: `${b.spec.kind} · ${b.spec.nodes.length} nodes`, detail: b.id, b })), { title: 'Insilode: show a board' });
			board = chosen?.b;
		}
		if (board) {
			await this.show(board.id, board.spec);
		}
	}

	dispose() {
		this.disposables.forEach(d => d.dispose());
	}
}
