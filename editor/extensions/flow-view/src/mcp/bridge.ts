/*---------------------------------------------------------------------------------------------
 *  Insilode agent bridge, window side: a local HTTP server (127.0.0.1, random port, random token) that
 *  runs the `insilode` MCP server's tool calls, advertised in ~/.insilode/bridge/<pid>.json while the window
 *  lives. The file is removed when the window closes; files of windows that were killed are cleaned
 *  up by whoever starts next. Claude's /ide lock files (~/.claude/ide) are not touched.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { startBridgeServer, type BridgeServer } from './http';
import { AgentTools, type DiffBase, type ToolDeps } from './handlers';
import { bridgeDir, cleanStale, removeBridgeFileSync, writeBridgeFile } from './registry';

export class AgentBridge implements vscode.Disposable {
	private server: BridgeServer | undefined;
	private disposed = false;
	private readonly startedAt = Date.now();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly tools: AgentTools;

	constructor(deps: ToolDeps, private readonly log: vscode.LogOutputChannel) {
		this.tools = new AgentTools(deps);
	}

	/** The canvas action "Board from Code": the same generator the `board_from_code` tool runs, answered as text for a message. */
	async boardFromCode(args: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
		const result = await this.tools.call('board_from_code', args);
		return { ok: !result.isError, message: result.content.map(c => c.type === 'text' ? c.text : '').filter(Boolean).join('\n') };
	}

	/** The changes since `base` on the flow canvas (one canvas for all of them); `only` narrows them to files or folders. */
	async showChangesInFlow(only?: string[], base: DiffBase = 'uncommitted', ref?: string, session?: string) {
		const tools = this.tools;
		try {
			return await tools.changesInFlow(await tools.changesOf(only, base, ref, session));
		} catch (e) {
			return { ok: false, opened: false, message: (e as Error).message };
		}
	}

	/** An agent worktree's changes since it left `base`: the diff editor and the flow canvas. */
	async showWorktreeInFlow(root: string, base: string) {
		const tools = this.tools;
		try {
			const changes = await tools.worktreeChanges(root, base);
			await tools.openChanges(changes, `Insilode: ${changes.since ? `Changes since ${changes.since}` : 'Changes'}`);
			return await tools.changesInFlow(changes);
		} catch (e) {
			return { ok: false, opened: false, message: (e as Error).message };
		}
	}

	/** A failure (no port, an unwritable home folder) is logged and leaves Insilode working without the bridge. */
	async start() {
		try {
			const server = await startBridgeServer((tool, args, ctx) => this.tools.call(tool, args, ctx), { log: m => this.log.warn(m), info: () => ({ pid: process.pid }) });
			if (this.disposed) {
				await server.close();
				return;
			}
			this.server = server;
			await cleanStale(bridgeDir(), undefined, process.pid);
			await this.write();
			// Folders opened or closed later change which agents belong to this window.
			this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.write().catch(() => undefined)));
			this.log.info(`Agent bridge listening on 127.0.0.1:${server.port}`);
		} catch (e) {
			this.log.error(`Agent bridge did not start: ${(e as Error)?.stack ?? e}`);
			await this.server?.close().catch(() => undefined);
			this.server = undefined;
		}
	}

	private async write() {
		if (!this.server || this.disposed) {
			return;
		}
		await writeBridgeFile({
			pid: process.pid,
			port: this.server.port,
			token: this.server.token,
			workspaceFolders: (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath),
			createdAt: this.startedAt,
		});
	}

	dispose() {
		this.disposed = true;
		this.disposables.forEach(d => d.dispose());
		removeBridgeFileSync(process.pid);
		void this.server?.close();
		this.server = undefined;
	}
}
