/*---------------------------------------------------------------------------------------------
 *  Insilode: any language with a language server, through VS Code's call hierarchy API
 *  (TypeScript/JavaScript built in; Java, Python, Go, … once their language extension is installed).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { noFlowReason } from './noFlow';
import { POLY_LANGUAGES } from './poly/client';
import type { FlowNode, FlowProvider, FlowTarget } from './providers';

const MAX_CHILDREN = 15;

function inWorkspace(uri: vscode.Uri) {
	return !!vscode.workspace.getWorkspaceFolder(uri) && !/[\\/]node_modules[\\/]/.test(uri.fsPath);
}

/** The language server may need a moment after a file opens; an empty answer is often just "not yet". */
async function prepare(uri: vscode.Uri, pos: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
	for (let attempt = 0; attempt < 6; attempt++) {
		const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.prepareCallHierarchy', uri, pos);
		if (items?.length) {
			return items[0];
		}
		await new Promise(r => setTimeout(r, 500));
	}
	return undefined;
}

/** Where a call happens (0-based line): a server may report a call without ranges. */
const callLine = (c: { fromRanges: vscode.Range[] }) => c.fromRanges?.[0]?.start.line ?? 0;

/** A flow is cut off after this many cards: call hierarchies of a big codebase fan out fast. */
const MAX_NODES = 250;

/** Keys for the cards of one `graph`/`callers` call: local to the call, so concurrent calls never share a counter. */
const keys = (prefix: string) => {
	let n = 0;
	return () => `${prefix}${n++}`;
};

export class LspProvider implements FlowProvider {
	private async root(t: FlowTarget) {
		if (t.kind !== 'lsp') {
			throw new Error('not an LSP target');
		}
		const uri = vscode.Uri.parse(t.uri);
		const item = await prepare(uri, new vscode.Position(t.line, t.character));
		if (!item) {
			const doc = await vscode.workspace.openTextDocument(uri);
			const errors = vscode.languages.getDiagnostics(uri).filter(d => d.severity === vscode.DiagnosticSeverity.Error);
			throw new Error(noFlowReason(doc.languageId, errors.map(d => d.range.start.line + 1)));
		}
		return item;
	}

	/** Card for one function: its full lines of source, located like the Roslyn nodes. */
	private async card(item: vscode.CallHierarchyItem, kind: FlowNode['kind'], nextKey: () => string): Promise<FlowNode> {
		const local = inWorkspace(item.uri);
		let code: string | null = null;
		let start = item.range.start.line + 1;
		let end = item.range.end.line + 1;
		if (local) {
			const doc = await vscode.workspace.openTextDocument(item.uri);
			// The server's range may be stale or past the end of the file: stay inside the document.
			const last = Math.max(0, doc.lineCount - 1);
			const from = Math.min(item.range.start.line, last);
			const to = Math.min(Math.max(item.range.end.line, from), last);
			code = doc.getText(new vscode.Range(from, 0, to, doc.lineAt(to).text.length));
			start = from + 1;
			end = to + 1;
		} else {
			start = end = 0;
		}
		return {
			key: nextKey(),
			symbolId: `${item.uri.toString()}#${item.range.start.line}`,
			label: item.detail ? `${item.detail.split(/[\\/]/).pop()}.${item.name}`.replace(/^\./, '') : item.name,
			sub: local ? vscode.workspace.asRelativePath(item.uri) : item.uri.fsPath.split(/[\\/]/).slice(-2).join('/'),
			kind: local ? kind : 'external',
			file: local ? item.uri.fsPath : null,
			startLine: start,
			endLine: end,
			code,
			children: [],
		};
	}

	private id(item: vscode.CallHierarchyItem) {
		return `${item.uri.toString()}#${item.range.start.line}:${item.range.start.character}`;
	}

	async graph(t: FlowTarget): Promise<FlowNode> {
		const nextKey = keys('l');
		let count = 0;
		const root = await this.root(t);
		const walk = async (item: vscode.CallHierarchyItem, depth: number, path: Set<string>): Promise<FlowNode> => {
			const node = await this.card(item, path.size === 0 ? 'controller' : 'method', nextKey);
			if (depth <= 0 || node.kind === 'external' || path.has(this.id(item)) || ++count > MAX_NODES) {
				return node;
			}
			path.add(this.id(item));
			const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.provideOutgoingCalls', item) ?? [];
			const seen = new Set<string>();
			const ordered = calls.sort((a, b) => callLine(a) - callLine(b)).slice(0, MAX_CHILDREN);
			for (const [at, call] of ordered.entries()) {
				if (seen.has(this.id(call.to))) {
					continue;
				}
				if (count >= MAX_NODES) {
					// The size limit: this card says how many of its calls were not drawn, so a cut flow never looks whole.
					node.truncated = new Set(ordered.slice(at).map(c => this.id(c.to)).filter(id => !seen.has(id))).size;
					break;
				}
				seen.add(this.id(call.to));
				// Library calls become leaves; only follow into our own code.
				const child = inWorkspace(call.to.uri) ? await walk(call.to, depth - 1, path) : await this.card(call.to, 'external', nextKey);
				node.children.push({ callLine: callLine(call) + 1, edgeKind: 'call', node: child });
			}
			path.delete(this.id(item));
			return node;
		};
		return walk(root, 4, new Set());
	}

	/** No framework knows the entry points here: report the outermost callers (nobody calls them). */
	async impact(t: FlowTarget) {
		const root = await this.root(t);
		const roots = new Set<string>();
		const seen = new Set<string>();
		let frontier = [root];
		for (let depth = 0; depth < 6 && frontier.length && seen.size < 300; depth++) {
			const next: vscode.CallHierarchyItem[] = [];
			for (const item of frontier) {
				if (seen.has(this.id(item))) {
					continue;
				}
				seen.add(this.id(item));
				const incoming = (await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item) ?? []).filter(c => inWorkspace(c.from.uri));
				if (!incoming.length && item !== root) {
					roots.add(`${vscode.workspace.asRelativePath(item.uri)} · ${item.name}`);
				}
				next.push(...incoming.map(c => c.from));
			}
			frontier = next;
		}
		return { label: 'root caller', items: [...roots].sort().map(label => ({ label, file: null, line: 0 })) };
	}

	async callers(t: FlowTarget): Promise<FlowNode | null> {
		const nextKey = keys('c');
		let count = 0;
		const root = await this.root(t);
		const walk = async (item: vscode.CallHierarchyItem, depth: number, path: Set<string>): Promise<FlowNode> => {
			const node = await this.card(item, 'method', nextKey);
			if (depth <= 0 || path.has(this.id(item)) || ++count > MAX_NODES) {
				return node;
			}
			path.add(this.id(item));
			const calls = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item) ?? [];
			for (const call of calls.filter(c => inWorkspace(c.from.uri)).slice(0, 12)) {
				const caller = await walk(call.from, depth - 1, path);
				node.children.push({ callLine: callLine(call) + 1, edgeKind: 'call', node: caller });
			}
			path.delete(this.id(item));
			return node;
		};
		return walk(root, 3, new Set());
	}
}


/** "◆ Flow" above every function/method the language server reports, for non-Roslyn languages. */
export class LspLenses implements vscode.CodeLensProvider {
	async provideCodeLenses(doc: vscode.TextDocument): Promise<vscode.CodeLens[]> {
		if (doc.languageId === 'csharp' || POLY_LANGUAGES.has(doc.languageId) || !vscode.workspace.getConfiguration('flow').get<boolean>('codeLens', true)) {
			return [];
		}
		// Servers answer with DocumentSymbol (nested, with a selection range) or the older flat SymbolInformation.
		let symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[];
		try {
			symbols = await vscode.commands.executeCommand<(vscode.DocumentSymbol | vscode.SymbolInformation)[]>('vscode.executeDocumentSymbolProvider', doc.uri) ?? [];
		} catch {
			return [];
		}
		const lenses: vscode.CodeLens[] = [];
		const visit = (list: (vscode.DocumentSymbol | vscode.SymbolInformation)[], parent?: string) => {
			for (const s of list) {
				const range = 'range' in s ? s.range : s.location.range;
				const selection = 'selectionRange' in s ? s.selectionRange : range;
				const name = 'containerName' in s && s.containerName && !parent ? `${s.containerName}.${s.name}` : parent ? `${parent}.${s.name}` : s.name;
				if (s.kind === vscode.SymbolKind.Function || s.kind === vscode.SymbolKind.Method || s.kind === vscode.SymbolKind.Constructor) {
					const target: FlowTarget = { kind: 'lsp', uri: doc.uri.toString(), line: selection.start.line, character: selection.start.character };
					lenses.push(new vscode.CodeLens(new vscode.Range(range.start, range.start), { title: '◆ Flow', command: 'flow.showTarget', arguments: [target, name] }));
				}
				if ('children' in s && s.children?.length) {
					visit(s.children, s.name);
				}
			}
		};
		visit(symbols);
		return lenses;
	}
}
