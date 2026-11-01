/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: harness engineering inside the editor. A merged map with a health score,
 *  the context budget, the plans' usage limits, a hook studio and a permission inbox that turns
 *  answers into rules.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { isTracked, itemKey, mcpKey, usageLabel, type HookLike } from './activity';
import { ContextBudget, UsageLimits } from './context';
import { costLabel, delta, loadCosts, tok, totals, totalsBefore, trackCosts, type Cost } from './cost';
import { FrictionView } from './frictionView';
import { flowModel, toRequest } from './harnessFlow';
import { HookStudio } from './hooks';
import { LimitAlerts } from './limitAlerts';
import { Live } from './live';
import { McpManager } from './mcpManager';
import { MemoryActions } from './memoryActions';
import { PermissionInbox, type PermissionRequest } from './permissions';
import { totalsBySource, unusedGap } from './gaps';
import { scan, type Harness, type HarnessItem } from './scan';
import { registerPreviewProvider } from './settings';
import { HarnessTree, itemOf } from './tree';
import { WhyView } from './why';
import { XrayView } from './xray';

/** The files that shape an agent, as watcher globs: instructions, settings, MCP servers, rules, skills, agents, hooks, commands. */
const WATCHED = ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md', '**/.mcp.json', '**/.codex/config.toml', '**/.claude/settings*.json', '**/.claude/{rules,skills,agents,hooks,commands}/**', '**/.cursor/rules/**', '**/.agents/skills/**'];

export function activate(context: vscode.ExtensionContext) {
	let harness: Harness | undefined;
	const budget = new ContextBudget();
	const limits = new UsageLimits();
	const alerts = new LimitAlerts();
	const tree = new HarnessTree();
	const view = vscode.window.createTreeView('flowHarness.map', { treeDataProvider: tree, showCollapseAll: true });
	const studio = new HookStudio(() => harness?.root);
	const inbox = new PermissionInbox(() => harness?.root, () => void refresh());
	const inboxView = vscode.window.createTreeView('flowHarness.permissions', { treeDataProvider: inbox });
	const diagnostics = vscode.languages.createDiagnosticCollection('harness');
	const live = new Live(context.workspaceState, () => (harness?.items ?? []).flatMap(i => i.hook ? [i.hook as HookLike] : []));
	const friction = new FrictionView(live, inbox, () => harness);
	const frictionView = vscode.window.createTreeView('flowHarness.friction', { treeDataProvider: friction });
	const xray = new XrayView(() => harness, live);
	const why = new WhyView(() => harness, live);
	const memories = new MemoryActions(() => harness, () => void refresh());
	const mcp = new McpManager(context.workspaceState, () => harness?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, prefix => {
		const s = live.summary(mcpKey(prefix));
		return live.sessionsSeen ? { label: usageLabel(s, live.covered, live.sessionsSeen), week: s.week, month: s.month, last: s.last || undefined } : undefined;
	}, () => refresh());
	/**
	 * What the last "Check" of each MCP server found: its tools and what their definitions cost. Claude Code defers MCP tool
	 * definitions behind tool search (https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search), so only the names load
	 * up front and the schemas count as on demand; Codex is given every tool's definition. A server that did not start
	 * at its last check says so on its row.
	 */
	const markChecked = (h: Harness) => {
		const checks = mcp.checks();
		for (const i of h.items.filter(x => x.mcp)) {
			const c = checks[i.mcp!.id];
			if (!c) {
				continue;
			}
			if (c.ok && c.toolCount !== undefined) {
				const names = Math.round((c.tools ?? []).reduce((a, t) => a + `mcp__${i.mcp!.toolPrefix}__${t}`.length + 1, 0) / 4);
				[i.tokens, i.onDemand] = i.agents.includes('Claude') ? [names, c.schemaTokens] : [c.schemaTokens, undefined];
				i.detail += ` · ${c.toolCount} tools`;
			} else if (!c.ok && i.mcp!.state !== 'off') {
				i.issues.push({ severity: 'warning', message: `Did not work at the last check (${new Date(c.at).toLocaleString()}): ${c.status}`, fix: 'Open the MCP manager, fix it and check again' });
			}
		}
	};
	const usageOf = (i: HarnessItem) => {
		if (!isTracked(i)) {
			return undefined;
		}
		const s = live.summary(itemKey(i));
		const covered = live.covered;
		const facts = [
			`${s.week} this week, ${s.month} in 30 days`,
			s.failures ? `${s.failures} failed` : '',
			s.avgMs !== undefined ? `${s.avgMs} ms on average (measured)` : '',
		].filter(Boolean).join(', ');
		// A memory is recalled, not used; with no transcripts at all there is nothing to count from.
		if (i.kind === 'memory') {
			return live.sessionsSeen
				? { label: usageLabel(s, covered, live.sessionsSeen).replace(/^used/, 'recalled').replace(/^never used/, 'never recalled').replace(/^no use/, 'not recalled'), detail: `Read by an agent ${s.week} times this week, ${s.month} in 30 days (Reads of the file in this folder's sessions, over ${covered} days).` }
				: { label: 'recalls unknown', detail: 'No transcripts of this folder to count recalls from.' };
		}
		return {
			label: usageLabel(s, covered, live.sessionsSeen) + (s.failures ? `, ${s.failures} failed` : ''),
			detail: `Used ${facts}.${s.inferred ? ' Hook runs are counted from the events and matchers that fire them.' : ''} The counts cover ${covered} days and ${live.sessionsSeen} sessions of this project.`,
		};
	};
	tree.setUsage(usageOf);
	// What each file costs, and the costs at the last scan, so an edit shows as before/after.
	let costs = loadCosts(context.workspaceState.get('flowHarness.costs'));
	const costKinds = new Set(['instructions', 'rules', 'skills', 'agents', 'memory']);
	const trackHarnessCosts = (h: Harness) => {
		const current: Record<string, Cost> = {};
		for (const i of h.items.filter(x => costKinds.has(x.kind) && x.agents.includes('Claude'))) {
			const c = current[i.file] ??= { always: 0, onDemand: 0 };
			c.always += i.tokens ?? 0;
			c.onDemand += i.onDemand ?? 0;
		}
		costs = trackCosts(costs, current, Date.now());
		void context.workspaceState.update('flowHarness.costs', costs);
	};
	tree.setCost(i => {
		const c = costs.files[i.file];
		if (!costKinds.has(i.kind) || !c || !(c.always || c.onDemand)) {
			return undefined;
		}
		const change = costs.changes[i.file];
		const when = i.kind === 'memory' ? 'when an agent recalls it' : i.kind === 'skills' ? 'when the skill is used' : i.kind === 'agents' ? "in the subagent's own window when it is spawned" : 'when the agent works on files it covers';
		return {
			label: costLabel(c, change),
			detail: [
				c.always ? `About ${c.always.toLocaleString()} tokens in every session (always-on).` : '',
				c.onDemand ? `About ${c.onDemand.toLocaleString()} more ${when} (on demand).` : '',
				change ? `Before the edit of ${new Date(change.at).toLocaleString()}: ${change.before.always.toLocaleString()} always-on, ${change.before.onDemand.toLocaleString()} on demand.` : '',
				'Estimates: about 4 characters per token.',
			].filter(Boolean).join(' '),
		};
	});
	/** Skills unused for the whole window: an info line on each, and a gap entry. Applied after the scan, so the health score does not change. */
	const markUnused = (h: Harness) => {
		const idle = h.items.filter(i => i.kind === 'skills' && live.summary(itemKey(i)).month === 0);
		const gap = unusedGap(idle.map(i => i.label), live.covered, live.sessionsSeen);
		h.gaps = h.gaps.filter(g => g.key !== 'unused');
		for (const i of h.items) {
			i.issues = i.issues.filter(x => !x.message.startsWith('Not used in 30 days'));
		}
		if (gap) {
			h.gaps.push(gap);
			idle.forEach(i => i.issues.push({ severity: 'info', message: 'Not used in 30 days: prune it, or sharpen its description so the agent knows when to use it' }));
		}
	};
	let liveTimer: NodeJS.Timeout | undefined;
	live.onDidChange(() => {
		clearTimeout(liveTimer);
		liveTimer = setTimeout(() => {
			if (harness) {
				const before = harness.gaps.find(g => g.key === 'unused')?.message;
				markUnused(harness);
				tree.set(harness);
				// The view's summary line names the gaps: when the unused-skills one comes or goes (the first backfill), say it there too.
				if (harness.gaps.find(g => g.key === 'unused')?.message !== before) {
					void refresh();
				}
			}
			const n = friction.count;
			frictionView.badge = n ? { value: n, tooltip: `${n} proposals from repeated friction` } : undefined;
		}, 800);
	});

	let running: Promise<void> | undefined;
	let dirty = false;
	let lastScan = 0;
	const rescan = async () => {
		try {
			harness = await scan();
			if (harness) {
				markUnused(harness);
				markChecked(harness);
				void live.backfill(harness.root);
				// Looking names up can take seconds (the index, the language servers): the map shows first, the stale marks follow.
				const scanned = harness;
				void memories.checkStale(scanned).then(changed => changed && harness === scanned && tree.set(scanned)).catch(e => console.warn('flow-harness: memory check failed', e));
			}
			tree.set(harness);
			void mcp.changed();
			budget.setHarness(harness);
			void friction.setHarness(harness);
			if (harness) {
				const { score, counts, startupTokens, gaps } = harness;
				trackHarnessCosts(harness);
				const now = totals(costs.files);
				const was = totalsBefore(costs);
				const problems = counts.error + counts.warning;
				const trimmed = was.always !== now.always ? ` (${delta(now.always - was.always)} after your recent edits)` : '';
				const tokens = `About ${(startupTokens / 1000).toFixed(1)}k tokens load before your first prompt${trimmed}${now.onDemand ? `, and about ${tok(now.onDemand)} more on demand` : ''}.`;
				// "Nothing broken" alone read as "all set" for a project with no harness at all: say what is missing too.
				const notSetUp = gaps.filter(g => g.key !== 'unused');
				const unused = gaps.find(g => g.key === 'unused');
				const missing = (notSetUp.length ? ` Not set up here: ${notSetUp.map(g => g.label).join(', ')}.` : '') + (unused ? ` ${unused.label.replace(/^\w/, c => c.toUpperCase())} in 30 days.` : '');
				view.description = `Health ${score} · ${tok(now.always)} always-on${now.onDemand ? ` · ${tok(now.onDemand)} on demand` : ''}`;
				view.message = problems
					? `${counts.error ? `${counts.error} broken, ` : ''}${counts.warning} to look at.${missing} ${tokens}`
					: `Nothing broken.${missing} ${tokens}`;
				view.badge = problems ? { value: problems, tooltip: `${problems} harness problems` } : undefined;
				// Line-level problems also show in the editor and the Problems panel.
				diagnostics.clear();
				const byFile = new Map<string, vscode.Diagnostic[]>();
				for (const i of harness.items) {
					for (const issue of i.issues.filter(x => x.line !== undefined)) {
						const d = new vscode.Diagnostic(new vscode.Range(issue.line!, 0, issue.line!, 999), issue.fix ? `${issue.message}. Fix: ${issue.fix}` : issue.message,
							issue.severity === 'error' ? vscode.DiagnosticSeverity.Error : issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
						d.source = 'Insilode harness';
						byFile.set(i.file, [...(byFile.get(i.file) ?? []), d]);
					}
				}
				byFile.forEach((d, f) => diagnostics.set(vscode.Uri.file(f), d));
			}
		} catch (e) {
			// A file that cannot be scanned must say so, not leave a stale map behind without a word.
			view.message = `The harness scan failed: ${(e as Error).message ?? e}`;
			console.error('flow-harness: scan failed', e);
		}
		lastScan = Date.now();
	};
	/** One scan at a time; a request that arrives while one runs (a file saved meanwhile) makes it run once more, so the map never ends up older than the last change. */
	const refresh = () => {
		if (running) {
			dirty = true;
			return running;
		}
		return running = (async () => {
			try {
				do {
					dirty = false;
					await rescan();
				} while (dirty);
			} finally {
				running = undefined;
			}
		})();
	};

	// Only files that shape an agent (not agent worktrees or session logs) mean a fresh look; home-folder files refresh on focus.
	// One watcher per pattern, with no brace group nested in another: the single nested pattern missed a new
	// .claude/settings.json and its later edits.
	const watchers = WATCHED.map(g => vscode.workspace.createFileSystemWatcher(g));
	const ignored = /[\\/](?:\.claude[\\/]worktrees|\.insilode[\\/]worktrees|\.axle[\\/]worktrees|node_modules|\.git)[\\/]/;
	let timer: NodeJS.Timeout | undefined;
	const soon = (uri?: vscode.Uri) => {
		if (uri && ignored.test(uri.fsPath)) {
			return;
		}
		clearTimeout(timer);
		timer = setTimeout(() => void refresh(), 600);
	};
	// Coming back to the window or the view: only worth a scan when the last one is a while old.
	const ifStale = () => Date.now() - lastScan > 30_000 && soon();

	context.subscriptions.push(
		view, inboxView, limits, studio, diagnostics, ...watchers, registerPreviewProvider(),
		live, frictionView, why, xray, mcp, { dispose: () => clearTimeout(liveTimer) },
		...watchers.flatMap(w => [w.onDidChange(soon), w.onDidCreate(soon), w.onDidDelete(soon)]),
		{ dispose: () => clearTimeout(timer) },
		vscode.window.onDidChangeWindowState(s => s.focused && ifStale()),
		view.onDidChangeVisibility(v => v.visible && ifStale()),
		vscode.commands.registerCommand('flowHarness.refresh', () => refresh()),
		// From the map: a server row opens the manager on that server; the group's action and the palette open it whole.
		vscode.commands.registerCommand('flowHarness.manageMcp', (arg?: unknown) => {
			const a = arg as { mcpId?: unknown; item?: HarnessItem } | undefined;
			const id = typeof a?.mcpId === 'string' ? a.mcpId : a?.item?.mcp?.id;
			return mcp.show(id);
		}),
		vscode.commands.registerCommand('flowHarness.testHook', (arg: unknown) => {
			const item = itemOf(arg);
			return item && studio.test(item);
		}),
		vscode.commands.registerCommand('flowHarness.addHook', async () => {
			await studio.add();
			await refresh();
		}),
		vscode.commands.registerCommand('flowHarness.promote', (arg: unknown) => inbox.promote(arg, 'allow')),
		vscode.commands.registerCommand('flowHarness.promoteDeny', (arg: unknown) => inbox.promote(arg, 'deny')),
		vscode.commands.registerCommand('flowHarness.showContext', () => budget.showDetails()),
		// Called by flow-agent: the plans' usage limits as the CLIs report them, and every permission question with its
		// answer. Each agent's context fill shows in flow-agent's own Agents dock.
		vscode.commands.registerCommand('flowHarness.reportLimits', (l: unknown) => {
			limits.report(l);
			alerts.report(l);
		}),
		// Called by flow-view's harness flow panel: the diagram's model for one mode (protocol/harness.ts).
		// The panel can open before the first scan is done (right after the window loads): wait for it rather than answer an empty diagram.
		vscode.commands.registerCommand('flowHarness.flowModel', async (request: unknown) => {
			if (!harness) {
				await refresh();
			}
			return flowModel(toRequest(request), harness, live);
		}),
		vscode.commands.registerCommand('flowHarness.recordPermission', (r: PermissionRequest) => inbox.record(r)),
		// Called by flow-agent with every hook event of the agents it runs: what they used, what failed, what you typed.
		vscode.commands.registerCommand('flowHarness.recordEvent', (e: unknown) => live.record(e)),
		// From the Agents dock (one agent's session) or the Harness view (asks which session).
		vscode.commands.registerCommand('flowHarness.contextXray', (s?: unknown) => xray.show(s)),
		vscode.commands.registerCommand('flowHarness.why', (uri?: unknown) => why.show(uri)),
		// Scripts and the MCP side pass the call; from the palette it is asked for here.
		vscode.commands.registerCommand('flowHarness.simulatePermission', async (call?: unknown, agent?: unknown) => {
			const asked = typeof call === 'string' ? call : await vscode.window.showInputBox({ title: 'Simulate a permission', prompt: 'A tool call as the agent would make it', placeHolder: 'Bash(git push origin main)', ignoreFocusOut: true });
			return asked?.trim() ? why.simulate(asked.trim(), agent === 'Codex' ? 'Codex' : 'Claude') : undefined;
		}),
		vscode.commands.registerCommand('flowHarness.applyProposal', (arg: unknown) => friction.apply(arg)),
		vscode.commands.registerCommand('flowHarness.dismissProposal', (arg: unknown) => friction.dismiss(arg)),
		vscode.commands.registerCommand('flowHarness.removeGuard', (arg: unknown) => friction.removeGuard(arg)),
		vscode.commands.registerCommand('flowHarness.deleteMemory', (arg: unknown) => memories.delete(arg)),
		vscode.commands.registerCommand('flowHarness.promoteMemory', (arg: unknown) => memories.promote(arg)),
		vscode.commands.registerCommand('flowHarness.clearFriction', async () => {
			const ok = await vscode.window.showWarningMessage('Forget the prompts and tool failures the friction inbox kept for this folder?', { modal: true, detail: 'Usage counts stay. Past transcripts are not read again unless they change.' }, 'Forget');
			if (ok === 'Forget') {
				live.clearFriction();
			}
		}),
		// For Insilode Home: the health summary in one call.
		vscode.commands.registerCommand('flowHarness.health', async () => {
			if (!harness) {
				await refresh();
			}
			const h = harness;
			return h && {
				score: h.score,
				counts: h.counts,
				startupTokens: h.startupTokens,
				totals: Object.fromEntries(['instructions', 'rules', 'skills', 'agents', 'hooks', 'mcp', 'permissions'].map(k => [k, h.items.filter(i => i.kind === k).length])),
				// Home says which counts are the project's and which are the user's own (~/.claude), and what is missing.
				bySource: totalsBySource(h.items, ['instructions', 'skills', 'hooks', 'mcp', 'permissions']),
				// Home lists these as "not set up here": unused skills are set up, so they stay in the map.
				gaps: h.gaps.filter(g => g.key !== 'unused').map(g => ({ label: g.label, message: g.message })),
				issues: h.items.flatMap(i => i.issues.filter(x => x.severity !== 'info').map(x => ({ ...x, label: i.label, file: i.file }))).slice(0, 6),
			};
		}),
	);
	void refresh();
}

export function deactivate() { }
