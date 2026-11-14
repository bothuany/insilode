/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the map. One tree, grouped by what each piece does, every row saying where it
 *  comes from (user, project, local, folder), what it costs, and whether it looks broken.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
import type { Harness, HarnessItem, Kind, Severity } from './scan';

const GROUPS: { kind: Kind; label: string; icon: string; color: string; empty: string }[] = [
	{ kind: 'instructions', label: 'Instructions', icon: 'book', color: 'flowHarness.instructions', empty: 'No CLAUDE.md or AGENTS.md yet' },
	{ kind: 'rules', label: 'Rules', icon: 'law', color: 'flowHarness.rules', empty: 'No path-scoped rules' },
	{ kind: 'skills', label: 'Skills', icon: 'sparkle', color: 'flowHarness.skills', empty: 'No skills in this repo or your home folder' },
	{ kind: 'agents', label: 'Subagents', icon: 'organization', color: 'flowHarness.agents', empty: 'No subagents' },
	{ kind: 'hooks', label: 'Hooks', icon: 'zap', color: 'flowHarness.hooks', empty: 'No hooks' },
	{ kind: 'mcp', label: 'MCP servers', icon: 'plug', color: 'flowHarness.mcp', empty: 'No MCP servers in settings or .mcp.json' },
	{ kind: 'permissions', label: 'Permission rules', icon: 'shield', color: 'flowHarness.permissions', empty: 'No allow or deny rules' },
	{ kind: 'memory', label: 'Memory', icon: 'history', color: 'flowHarness.instructions', empty: 'No agent memory for this folder' },
];

const SCOPE_LABEL = { user: 'you', project: 'repo', local: 'local', directory: 'folder' } as const;
const tok = (n?: number) => n === undefined ? '' : n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
/** A file opens in the editor; a folder (where the scan hit a limit) is shown in the Explorer, `vscode.open` has no editor for it. */
const openCommand = (file: string, line?: number): vscode.Command => fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()
	? { title: 'Reveal', command: 'revealInExplorer', arguments: [vscode.Uri.file(file)] }
	: { title: 'Open', command: 'vscode.open', arguments: [vscode.Uri.file(file), { selection: new vscode.Range(line ?? 0, 0, line ?? 0, 0) }] };
const worst = (i: HarnessItem): Severity | undefined => i.issues.some(x => x.severity === 'error') ? 'error' : i.issues.some(x => x.severity === 'warning') ? 'warning' : i.issues.length ? 'info' : undefined;

type Node = { type: 'group'; kind: Kind } | { type: 'item'; item: HarnessItem } | { type: 'issue'; item: HarnessItem; index: number };

export class HarnessTree implements vscode.TreeDataProvider<Node> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private harness: Harness | undefined;
	/** How often an item was used lately ("used 12× this week"), and the details for its tooltip; undefined where use cannot be seen. */
	private usage: ((i: HarnessItem) => { label: string; detail: string } | undefined) | undefined;

	/** What an item's file costs and how that changed ("710 tok (was 1.2k)"), and a sentence for its tooltip. */
	private cost: ((i: HarnessItem) => { label: string; detail: string } | undefined) | undefined;

	setCost(cost: (i: HarnessItem) => { label: string; detail: string } | undefined) {
		this.cost = cost;
		this.changed.fire();
	}

	setUsage(usage: (i: HarnessItem) => { label: string; detail: string } | undefined) {
		this.usage = usage;
		this.changed.fire();
	}

	set(h: Harness | undefined) {
		this.harness = h;
		this.changed.fire();
	}

	getChildren(node?: Node): Node[] {
		const h = this.harness;
		if (!h) {
			return [];
		}
		if (!node) {
			return GROUPS.map(g => ({ type: 'group', kind: g.kind }));
		}
		if (node.type === 'group') {
			// Problems first, then by scope from widest to narrowest (the order they are layered in).
			const order = { user: 0, project: 1, local: 2, directory: 3 };
			const rank = (i: HarnessItem) => ({ error: 0, warning: 1, info: 2, none: 3 })[worst(i) ?? 'none'];
			return h.items.filter(i => i.kind === node.kind)
				.sort((a, b) => rank(a) - rank(b) || order[a.scope] - order[b.scope] || a.label.localeCompare(b.label))
				.map(item => ({ type: 'item', item }));
		}
		if (node.type === 'item') {
			return node.item.issues.map((_, index) => ({ type: 'issue', item: node.item, index }));
		}
		return [];
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.type === 'group') {
			const g = GROUPS.find(x => x.kind === node.kind)!;
			const items = this.harness!.items.filter(i => i.kind === node.kind);
			const tokens = items.reduce((a, i) => a + (i.agents.includes('Claude') ? i.tokens ?? 0 : 0), 0);
			const onDemand = items.reduce((a, i) => a + (i.agents.includes('Claude') ? i.onDemand ?? 0 : 0), 0);
			const problems = items.reduce((a, i) => a + i.issues.filter(x => x.severity !== 'info').length, 0);
			const t = new vscode.TreeItem(g.label, items.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
			t.iconPath = new vscode.ThemeIcon(g.icon, new vscode.ThemeColor(g.color));
			t.description = items.length
				? [String(items.length), tokens ? tok(tokens) : '', onDemand ? `+${tok(onDemand).replace(' tok', '')} on demand` : '', problems ? `${problems} to fix` : ''].filter(Boolean).join('  ')
				: g.empty;
			t.contextValue = `group.${g.kind}`;
			if (problems) {
				t.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
			}
			return t;
		}
		if (node.type === 'issue') {
			const issue = node.item.issues[node.index];
			const t = new vscode.TreeItem(issue.message);
			if (issue.fix) {
				t.tooltip = new vscode.MarkdownString(`${issue.message}\n\n**Fix:** ${issue.fix}`);
			}
			t.iconPath = new vscode.ThemeIcon(issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
				new vscode.ThemeColor(issue.severity === 'error' ? 'errorForeground' : issue.severity === 'warning' ? 'editorWarning.foreground' : 'descriptionForeground'));
			t.command = openCommand(node.item.file, issue.line);
			return t;
		}
		const i = node.item;
		const t = new vscode.TreeItem(i.label, i.issues.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
		const sev = worst(i);
		const used = this.usage?.(i);
		const cost = this.cost?.(i);
		// The same name for two agents (a skill in .claude/skills and in .agents/skills) says whose each one is.
		const twin = this.harness!.items.some(x => x !== i && x.kind === i.kind && x.label === i.label && x.agents.join() !== i.agents.join());
		const mcpState = i.mcp?.state === 'off' ? 'off' : i.mcp?.state === 'pending' ? 'awaiting approval' : '';
		t.description = [twin ? i.agents.join(' + ') : '', SCOPE_LABEL[i.scope], mcpState, i.kind === 'hooks' || i.kind === 'permissions' ? i.detail : cost?.label ?? tok(i.tokens), used?.label].filter(Boolean).join('  ');
		const tip = new vscode.MarkdownString(`**${i.label}**  \n${i.detail}\n\n${i.agents.join(', ')} · ${i.scope} scope${!cost && i.tokens ? ` · about ${i.tokens.toLocaleString()} tokens per session` : ''}\n\n\`${i.file}\``);
		if (i.hook) {
			tip.appendMarkdown(`\n\n\`\`\`sh\n${i.hook.command}\n\`\`\``);
		}
		if (cost) {
			tip.appendMarkdown(`\n\n${cost.detail}`);
		}
		if (used) {
			tip.appendMarkdown(`\n\n${used.detail}`);
		}
		t.tooltip = tip;
		if (sev) {
			t.iconPath = new vscode.ThemeIcon(sev === 'error' ? 'error' : sev === 'warning' ? 'warning' : 'info', new vscode.ThemeColor(sev === 'error' ? 'errorForeground' : sev === 'warning' ? 'editorWarning.foreground' : 'descriptionForeground'));
		} else if (i.rule) {
			t.iconPath = new vscode.ThemeIcon(i.rule.effect === 'deny' ? 'circle-slash' : i.rule.effect === 'ask' ? 'question' : 'pass', new vscode.ThemeColor(i.rule.effect === 'deny' ? 'flowHarness.deny' : i.rule.effect === 'ask' ? 'flowHarness.ask' : 'flowHarness.allow'));
		} else {
			t.iconPath = new vscode.ThemeIcon('circle-small-filled', new vscode.ThemeColor(GROUPS.find(g => g.kind === i.kind)!.color));
		}
		// An MCP server opens in the manager, which shows it with its status and offers its edits; the file is one click from there.
		t.command = i.mcp
			? { title: 'Manage', command: 'flowHarness.manageMcp', arguments: [{ mcpId: i.mcp.id }] }
			: openCommand(i.file);
		t.contextValue = i.hook ? 'hook' : i.memory ? 'memory' : i.mcp ? 'mcp' : `item.${i.kind}`;
		t.resourceUri = undefined;
		(t as vscode.TreeItem & { item?: HarnessItem }).item = i;
		return t;
	}
}

/** A hook row carries its item, so commands run from the tree know what to act on. */
export function itemOf(arg: unknown): HarnessItem | undefined {
	const a = arg as { type?: string; item?: HarnessItem } | undefined;
	return a?.item;
}
