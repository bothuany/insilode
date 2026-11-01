/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the friction inbox view. Corrections you keep typing, tool calls that keep
 *  failing the same way, and permissions you keep granting, each with its evidence and a fix.
 *  A fix is applied only on a click, as a diff of every file it changes (instruction lines,
 *  hook scripts, settings), written when you say yes.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { appendLineReviewed } from './edits';
import { addGuardHook, correctionProposals, failureProposals, FRICTION_EMPTY, GUARD_TARGETS, GUARDS_EMPTY, guardCommand, guardFileName, guardScript, removeGuardFromText, scanGuards, type Evidence, type GuardInfo, type Proposal } from './friction';
import type { Live } from './live';
import { ruleFor, type PermissionInbox, type PermissionRequest } from './permissions';
import type { Harness } from './scan';
import { jsonChange, previewAndWriteFiles, type FileChange } from './settings';

type Group = 'corrections' | 'failures' | 'grants' | 'guards';
type Row =
	| { type: 'group'; group: Group }
	| { type: 'proposal'; p: Proposal }
	| { type: 'grant'; rule: string; requests: PermissionRequest[] }
	| { type: 'guard'; g: GuardInfo }
	| { type: 'evidence'; e: Evidence }
	| { type: 'empty'; group: Group };

/** `empty` is the row's text, `source` says where the rows would come from: an empty list must not look like a broken one. */
const GROUPS: Record<Group, { label: string; icon: string; empty: string; source: string }> = {
	corrections: { label: 'Corrections you repeat', icon: 'comment-discussion', empty: 'Nothing said twice yet', source: 'from prompts sent in the Agents dock' },
	failures: { label: 'Tool calls that keep failing', icon: 'error', empty: 'No repeated failures', source: 'from tool failures in the Agents dock' },
	grants: { label: 'Permissions you keep granting', icon: 'shield', empty: 'No permission granted twice', source: 'from requests in the Agents dock' },
	guards: { label: 'Guards Insilode added', icon: 'zap', empty: GUARDS_EMPTY, source: '' },
};

const GUARD_FILE = { local: '.claude/settings.local.json', shared: '.claude/settings.json' } as const;

const when = (t: number) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export class FrictionView implements vscode.TreeDataProvider<Row> {
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.changed.event;
	private cache: { corrections: Proposal[]; failures: Proposal[] } | undefined;
	private instructions = '';
	/** The guards Insilode wrote, as the last scan of the settings files and `.claude/hooks` found them. */
	private guards: GuardInfo[] = [];

	constructor(private readonly live: Live, private readonly inbox: PermissionInbox, private readonly harness: () => Harness | undefined) {
		live.onDidChange(() => this.refresh());
		inbox.onDidChangeTreeData(() => this.refresh());
	}

	/** The text agents read already, so a proposal it covers says so. */
	async setHarness(h: Harness | undefined) {
		const files = (h?.items ?? []).filter(i => i.kind === 'instructions' && i.scope !== 'directory').map(i => i.file);
		this.instructions = (await Promise.all(files.map(f => fs.readFile(f, 'utf8').catch(() => '')))).join('\n');
		await this.loadGuards(h?.root);
		this.refresh();
	}

	/** Reads both settings files and the guard scripts: the guard list is what is on disk, with no state file of its own. */
	private async loadGuards(root = this.harness()?.root) {
		if (!root) {
			this.guards = [];
			return;
		}
		const read = (file: string) => fs.readFile(file, 'utf8').catch(() => undefined);
		const settings = (await Promise.all((['local', 'shared'] as const).map(async scope => ({ scope, text: await read(path.join(root, GUARD_FILE[scope])) }))))
			.flatMap(s => s.text === undefined ? [] : [{ scope: s.scope, text: s.text }]);
		const dir = path.join(root, '.claude', 'hooks');
		const names = (await fs.readdir(dir).catch(() => [] as string[])).filter(n => /^insilode-guard-.+\.mjs$/.test(n));
		const scripts = (await Promise.all(names.map(async name => ({ name, text: await read(path.join(dir, name)) })))).flatMap(s => s.text === undefined ? [] : [{ name: s.name, text: s.text }]);
		this.guards = scanGuards(settings, scripts);
	}

	/** What the empty tree says (the view's message): set only while nothing at all has been seen, so it names the data source once. */
	get emptyMessage(): string | undefined {
		const d = this.live.frictionData;
		return d.prompts.length || d.failures.length || this.inbox.requests.length || this.guards.length ? undefined : FRICTION_EMPTY;
	}

	private refresh() {
		this.cache = undefined;
		this.changed.fire();
	}

	private proposals() {
		if (!this.cache) {
			const d = this.live.frictionData;
			const open = (p: Proposal) => !d.dismissed.includes(p.id);
			this.cache = { corrections: correctionProposals(d.prompts, this.instructions).filter(open), failures: failureProposals(d.failures).filter(open) };
		}
		return this.cache;
	}

	/** Rules you allowed at least twice and that no settings file holds yet. */
	private grants() {
		const h = this.harness();
		const have = new Set((h?.items ?? []).filter(i => i.rule).map(i => i.rule!.pattern));
		const by = new Map<string, PermissionRequest[]>();
		for (const r of this.inbox.requests.filter(x => x.decision === 'allowed')) {
			const rule = ruleFor(r, h?.root);
			if (rule && !have.has(rule) && !this.live.frictionData.dismissed.includes(`grant:${rule}`)) {
				by.set(rule, [...(by.get(rule) ?? []), r]);
			}
		}
		return [...by].filter(([, list]) => list.length >= 2).map(([rule, requests]) => ({ rule, requests }));
	}

	/** How many proposals are waiting, for the view's badge. */
	get count() {
		const p = this.proposals();
		return p.corrections.length + p.failures.length + this.grants().length;
	}

	getChildren(row?: Row): Row[] {
		if (!row) {
			return (['corrections', 'failures', 'grants', 'guards'] as Group[]).map(group => ({ type: 'group', group }));
		}
		if (row.type === 'group') {
			const list: Row[] = row.group === 'grants'
				? this.grants().map(g => ({ type: 'grant' as const, ...g }))
				: row.group === 'guards'
					? this.guards.map(g => ({ type: 'guard' as const, g }))
					: this.proposals()[row.group].map(p => ({ type: 'proposal' as const, p }));
			return list.length ? list : [{ type: 'empty', group: row.group }];
		}
		if (row.type === 'proposal') {
			return row.p.evidence.slice(0, 20).map(e => ({ type: 'evidence', e }));
		}
		if (row.type === 'grant') {
			return row.requests.slice(0, 20).map(r => ({ type: 'evidence', e: { text: r.title, at: r.at } }));
		}
		return [];
	}

	getTreeItem(row: Row): vscode.TreeItem {
		if (row.type === 'group') {
			const g = GROUPS[row.group];
			const n = row.group === 'grants' ? this.grants().length : row.group === 'guards' ? this.guards.length : this.proposals()[row.group].length;
			const t = new vscode.TreeItem(g.label, n ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
			t.iconPath = new vscode.ThemeIcon(g.icon);
			t.description = n ? String(n) : '';
			return t;
		}
		if (row.type === 'empty') {
			const g = GROUPS[row.group];
			const t = new vscode.TreeItem(g.empty);
			t.description = g.source;
			t.tooltip = row.group === 'guards' ? GUARDS_EMPTY : FRICTION_EMPTY;
			return t;
		}
		if (row.type === 'guard') {
			const g = row.g;
			const t = new vscode.TreeItem(g.prefix);
			const where = g.files.length ? g.files.join(' + ') : 'script only, no settings entry';
			t.description = [where, g.reason, g.scriptExists ? '' : 'script missing'].filter(Boolean).join(' · ');
			const tip = new vscode.MarkdownString(`**Guard for \`${g.prefix}\`**\n\n${g.reason ? `${g.reason}\n\n` : ''}Registered in: ${g.files.map(f => `\`${GUARD_FILE[f]}\``).join(', ') || 'no settings file'}\n\nScript: \`.claude/hooks/${g.name}\`${g.scriptExists ? '' : ' (already gone: Remove deletes the settings entry only)'}`);
			t.tooltip = tip;
			t.iconPath = new vscode.ThemeIcon('zap', new vscode.ThemeColor('flowHarness.hooks'));
			t.contextValue = 'friction.guard';
			(t as vscode.TreeItem & { row?: Row }).row = row;
			return t;
		}
		if (row.type === 'evidence') {
			const first = row.e.text.split('\n')[0];
			const t = new vscode.TreeItem(first.length > 90 ? `${first.slice(0, 87)}…` : first);
			t.description = when(row.e.at);
			t.tooltip = new vscode.MarkdownString().appendCodeblock(row.e.text, 'text');
			t.iconPath = new vscode.ThemeIcon('quote');
			return t;
		}
		if (row.type === 'grant') {
			const t = new vscode.TreeItem(row.rule, vscode.TreeItemCollapsibleState.Collapsed);
			t.description = `allowed ${row.requests.length}×`;
			t.tooltip = `You allowed this ${row.requests.length} times. As a standing rule it is never asked again.`;
			t.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('flowHarness.allow'));
			t.contextValue = 'friction.grant';
			(t as vscode.TreeItem & { row?: Row }).row = row;
			return t;
		}
		const p = row.p;
		const t = new vscode.TreeItem(p.title, vscode.TreeItemCollapsibleState.Collapsed);
		t.description = p.covered ? `already in ${p.targets.join(', ')}: consider a hook` : `→ ${p.kind === 'hook' ? 'guard hook' : p.targets.join(', ')}`;
		const tip = new vscode.MarkdownString(`**Proposed ${p.kind === 'hook' ? `PreToolUse guard for \`${p.prefix}\`` : `line for ${p.targets.join(' and ')}`}**\n\n`);
		tip.appendCodeblock(p.kind === 'hook' ? p.text : `- ${p.text}`, 'markdown');
		tip.appendMarkdown(`\n\nSeen ${p.evidence.length} times, last ${when(p.evidence[0].at)}. Nothing is written until you review the edit.`);
		t.tooltip = tip;
		t.iconPath = new vscode.ThemeIcon(p.kind === 'hook' ? 'zap' : 'book', new vscode.ThemeColor(p.kind === 'hook' ? 'flowHarness.hooks' : 'flowHarness.instructions'));
		t.contextValue = 'friction.proposal';
		(t as vscode.TreeItem & { row?: Row }).row = row;
		return t;
	}

	/**
	 * Removes a guard Insilode added: its entry in each settings file that runs it and its script, as one reviewed edit. The
	 * dialog of that preview is the confirmation. A script that is already gone leaves only the entry to remove.
	 */
	async removeGuard(arg: unknown): Promise<void> {
		const row = (arg as { row?: Row } | undefined)?.row ?? (arg as Row | undefined);
		const root = this.harness()?.root;
		if (row?.type !== 'guard' || !root) {
			return;
		}
		const g = row.g;
		const changes: FileChange[] = g.files.map(scope => ({
			file: path.join(root, GUARD_FILE[scope]),
			change: text => {
				try {
					return removeGuardFromText(text, g.name);
				} catch (e) {
					void vscode.window.showErrorMessage(`${GUARD_FILE[scope]} has an unexpected shape (${(e as Error).message}). Fix it first, then try again.`);
					return undefined;
				}
			},
		}));
		if (g.scriptExists) {
			changes.push({ file: path.join(root, '.claude', 'hooks', g.name), change: text => text, remove: true });
		}
		if (!changes.length) {
			await this.loadGuards();
			this.refresh();
			return;
		}
		const ok = await previewAndWriteFiles(`Remove the guard for "${g.prefix}"`, changes, 'Remove Guard');
		if (ok && !g.scriptExists) {
			void vscode.window.showInformationMessage(`The script ${g.name} was already gone: only the settings entry was removed.`);
		}
		await this.loadGuards();
		this.refresh();
	}

	dismiss(arg: unknown) {
		const row = (arg as { row?: Row } | undefined)?.row ?? (arg as Row | undefined);
		if (row?.type === 'proposal') {
			this.live.dismiss(row.p.id);
		} else if (row?.type === 'grant') {
			this.live.dismiss(`grant:${row.rule}`);
		}
	}

	/** Applies a proposal as a reviewed edit: the line (or the hook's reason) can be reworded first, then the refactor preview shows every change. */
	async apply(arg: unknown) {
		const row = (arg as { row?: Row } | undefined)?.row ?? (arg as Row | undefined);
		const h = this.harness();
		if (!row || !h) {
			return;
		}
		if (row.type === 'grant') {
			await this.inbox.promote({ r: row.requests[0] }, 'allow');
			return;
		}
		if (row.type !== 'proposal') {
			return;
		}
		const p = row.p;
		const text = await vscode.window.showInputBox({
			title: p.kind === 'hook' ? `Guard for ${p.prefix}: what the agent is told` : 'The line to add',
			value: p.text,
			valueSelection: p.text.includes('<') ? [p.text.indexOf('<'), p.text.indexOf('>') + 1] : undefined,
			prompt: p.kind === 'hook' ? 'The hook stops the command and sends this to the agent instead' : 'Edit it before it is added; the next step shows the change',
			validateInput: v => !v.trim() ? 'Write something' : /<say [^>]*>/.test(v) ? 'Replace the <…> part with what to do instead' : undefined,
		});
		if (!text) {
			return;
		}
		const ok = p.kind === 'hook' ? await this.applyHook(h.root, p, text.trim()) : await this.applyLine(h.root, p, text.trim());
		if (ok) {
			this.live.dismiss(p.id);
		}
	}

	private async applyLine(root: string, p: Proposal, line: string): Promise<boolean> {
		let target = p.targets[0];
		if (p.targets.length > 1) {
			const pick = await vscode.window.showQuickPick(p.targets.map(t => ({ label: t, description: t === 'CLAUDE.md' ? 'Claude Code reads it' : 'Codex reads it' })), { title: 'Add the line to which file?' });
			if (!pick) {
				return false;
			}
			target = pick.label as typeof target;
		}
		return appendLineReviewed(root, target, `- ${line}`, `Add an instruction to ${target}`);
	}

	private async applyHook(root: string, p: Proposal, reason: string): Promise<boolean> {
		// This machine first: a guard that blocks a command is the team's business only when the user says so, and that choice carries a warning.
		const where = await vscode.window.showQuickPick(GUARD_TARGETS.map(t => ({
			label: t.warning ? `$(warning) ${t.label}` : t.label,
			description: t.warning,
			detail: t.detail,
			file: t.file,
		})), { title: `Where should the guard for "${p.prefix}" live?` });
		const prefix = p.prefix;
		if (!where || !prefix) {
			return false;
		}
		const name = guardFileName(prefix);
		const script = path.join(root, '.claude', 'hooks', name);
		if (await fs.stat(script).then(() => true, () => false)) {
			// A guard for this command is there already: say so rather than fail, and offer to give it the new message.
			const pick = await vscode.window.showWarningMessage(`A guard for "${prefix}" exists already (${name}). Replace its message with the new one?`, { modal: true }, 'Replace');
			if (pick !== 'Replace') {
				return false;
			}
		}
		// A settings file that does not exist yet is created in this same edit (jsonChange starts from {}), so one diff shows everything.
		const written = await previewAndWriteFiles(`Guard ${prefix} with a PreToolUse hook`, [
			{ file: script, change: () => guardScript(prefix, reason) },
			jsonChange(path.join(root, where.file), (s: Record<string, unknown>) => addGuardHook(s, guardCommand(name))),
		], 'Add Guard');
		if (written) {
			await this.loadGuards(root);
			this.refresh();
		}
		return written;
	}
}
