/*---------------------------------------------------------------------------------------------
 *  Insilode: the harness flow diagram (ui/src/harness, built to ui/dist-webview/harness.js) in an
 *  editor tab. The model comes from flow-harness through flowHarness.flowModel (protocol/harness.ts);
 *  a click on a piece opens the file it is written in. Like boardPanel.ts the page is one inlined script
 *  and a nonce CSP. The page never reads the workspace: it posts 'ready', 'request' and 'open', and this
 *  host checks each message. The only command this panel runs is flowHarness.flowModel.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HarnessCanvasToHost, HarnessFlowModel, HarnessFlowRequest, HostToHarnessCanvas } from '../../../../protocol/harness';
import { flowRoot } from './root';

const MODES = new Set(['static', 'preview', 'replay']);

/** A message from the page, checked: only these three shapes get through. */
export function toCanvasMessage(m: unknown): HarnessCanvasToHost | undefined {
	const o = m && typeof m === 'object' ? m as Record<string, unknown> : undefined;
	if (o?.type === 'ready') {
		return { type: 'ready' };
	}
	if (o?.type === 'open' && typeof o.itemId === 'string' && o.itemId.length <= 2000) {
		return { type: 'open', itemId: o.itemId };
	}
	const r = o?.request && typeof o.request === 'object' ? o.request as Record<string, unknown> : undefined;
	if (o?.type === 'request' && r && typeof r.mode === 'string' && MODES.has(r.mode)) {
		// flowHarness.flowModel checks the rest (agent, event, session) and drops what it does not know.
		return { type: 'request', request: r as unknown as HarnessFlowRequest };
	}
	return undefined;
}

/** JSON for an inline <script>: `</script>`, `<!--` and the JS line separators cannot end or alter the script. */
function inertJson(value: unknown) {
	return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

class HarnessFlowPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	private model: HarnessFlowModel | undefined;
	private readonly dist: string;

	constructor(context: vscode.ExtensionContext, private readonly log: vscode.LogOutputChannel) {
		this.dist = path.join(flowRoot(context.extensionPath), 'ui', 'dist-webview');
	}

	async show(): Promise<void> {
		if (this.panel) {
			this.panel.reveal(undefined, false);
			return;
		}
		const panel = vscode.window.createWebviewPanel('flow.harnessFlow', 'Harness Flow', { viewColumn: vscode.ViewColumn.Active, preserveFocus: false }, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		try {
			panel.webview.html = await this.html(panel.webview);
		} catch (e) {
			// The build is missing: no blank tab left behind.
			panel.dispose();
			throw new Error(`The harness flow canvas is not built (${(e as Error).message}). Run \`npm --prefix ui run build\`.`);
		}
		panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
		this.panel = panel;
		panel.onDidDispose(() => {
			if (this.panel === panel) {
				this.panel = undefined;
				this.model = undefined;
			}
		});
		panel.webview.onDidReceiveMessage(m => {
			this.onMessage(panel, m).catch(e => {
				this.log.warn(`harness flow: ${(e as Error).message ?? e}`);
				this.send(panel, { type: 'error', message: (e as Error).message ?? String(e) });
			});
		});
	}

	private send(panel: vscode.WebviewPanel, message: HostToHarnessCanvas) {
		void panel.webview.postMessage(message);
	}

	private async onMessage(panel: vscode.WebviewPanel, raw: unknown): Promise<void> {
		const m = toCanvasMessage(raw);
		if (!m) {
			return;
		}
		if (m.type === 'open') {
			await this.open(m.itemId);
			return;
		}
		const request: HarnessFlowRequest = m.type === 'request' ? m.request : { mode: 'static' };
		const model = await vscode.commands.executeCommand<HarnessFlowModel | undefined>('flowHarness.flowModel', request);
		if (!model) {
			this.send(panel, { type: 'error', message: 'The harness is not available: open a folder first.' });
			return;
		}
		this.model = model;
		this.send(panel, { type: 'model', request, model });
	}

	/** The file of a piece of the last model, at its line. The id is looked up, never used as a path. */
	private async open(itemId: string): Promise<void> {
		const item = this.model?.items.find(i => i.id === itemId);
		if (!item?.file) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(item.file));
		const line = Math.max(0, Math.min(doc.lineCount - 1, (item.line ?? 1) - 1));
		const at = new vscode.Position(line, 0);
		await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(at, at), preview: true, preserveFocus: false });
	}

	/** Everything inline, as in boardPanel.ts: no side files, a nonce for the one script. */
	private async html(webview: vscode.Webview): Promise<string> {
		const js = await fs.readFile(path.join(this.dist, 'harness.js'), 'utf8');
		const css = await fs.readFile(path.join(this.dist, 'harness.css'), 'utf8').catch(() => '');
		const kind = vscode.window.activeColorTheme.kind;
		const dark = kind !== vscode.ColorThemeKind.Light && kind !== vscode.ColorThemeKind.HighContrastLight;
		const nonce = randomBytes(16).toString('base64');
		const csp = [
			`default-src 'none'`,
			`script-src 'nonce-${nonce}'`,
			`style-src 'unsafe-inline'`,
			`font-src ${webview.cspSource} data:`,
			`img-src ${webview.cspSource} data:`,
		].join('; ');
		const safe = (text: string, tag: string) => text.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`).replace(/<!--/g, '\\x3C!--');
		return `<!doctype html><html><head><meta charset="utf-8">` +
			`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
			`<style>${safe(css, 'style')}</style>` +
			`<script nonce="${nonce}">window.__HARNESS__=${inertJson({ dark })}</script>` +
			`</head><body><div id="root"></div><script nonce="${nonce}">${safe(js, 'script')}</script></body></html>`;
	}

	dispose() {
		this.panel?.dispose();
	}
}

export function registerHarnessFlow(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): vscode.Disposable {
	const flow = new HarnessFlowPanel(context, log);
	const command = vscode.commands.registerCommand('flow.showHarnessFlow', () => flow.show().catch(e => void vscode.window.showErrorMessage(`Insilode: ${(e as Error).message ?? e}`)));
	return vscode.Disposable.from(command, flow);
}
