/*---------------------------------------------------------------------------------------------
 *  Insilode: the life of agent worktrees around the agent: the repository's setup file
 *  (.insilode/worktree.json: files to copy, commands to run after checkout and before removal) and
 *  cleaning up worktrees whose branch was merged or whose remote is gone.
 *
 *  The setup steps are hooked into worktrees.ts (`worktreeHooks`) when this module loads, so agents.ts keeps calling
 *  createWorktree and removeWorktree as before. The pure parts live in worktreeSetup.ts and worktreeSafety.ts.
 *  No terminal is shown and no focus is taken: the output goes to the "Insilode Worktrees" log.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import type { Agents, AgentSession } from './agents';
import { classify, recheck, type WorktreeFacts } from './worktreeSafety';
import { readSetupConfig, runSetup, runTeardown } from './worktreeSetup';
import { changedFiles, git, parseWorktreeList, removeWorktree, repoInfo, sameDir, validBranch, worktreeHooks, WORKTREE_DIR, type Worktree } from './worktrees';

let channel: vscode.LogOutputChannel | undefined;
const log = (line: string) => (channel ??= vscode.window.createOutputChannel('Insilode Worktrees', { log: true })).info(line);

// ── Setup file hooks ─────────────────────────────────────────────────────────────────────────────

/** removeFlow retries a removal on Windows: the teardown must not run twice for it. */
const tornDown = new Map<string, number>();

worktreeHooks.created = async wt => {
	const found = await setupFor(wt);
	if (!found) {
		return;
	}
	log(`Setting up ${wt.path}`);
	const r = 'errors' in found ? { ok: false as const, reason: `.insilode/worktree.json: ${found.errors.join('; ')}` } : await runSetup(wt.root, wt.path, found.config, log);
	if (r.ok) {
		log('Setup finished');
		return;
	}
	log(`Setup failed: ${r.reason}`);
	const pick = await vscode.window.showWarningMessage(`Insilode: the worktree setup failed: ${r.reason}`, 'Start Agent Anyway', 'Stop');
	if (pick !== 'Start Agent Anyway') {
		throw new Error(`the worktree setup failed (${r.reason}) and the start was stopped; see the Insilode Worktrees log`);
	}
};

worktreeHooks.beforeRemove = async wt => {
	if (Date.now() - (tornDown.get(wt.path) ?? 0) < 120_000) {
		return;
	}
	tornDown.set(wt.path, Date.now());
	const found = await setupFor(wt);
	if (!found || 'errors' in found || !found.config.teardown.length) {
		return;
	}
	log(`Teardown in ${wt.path}`);
	const r = await runTeardown(wt.path, found.config, log);
	if (!r.ok) {
		log(`Teardown failed: ${r.reason}`);
		void vscode.window.showWarningMessage(`Insilode: the worktree teardown failed (${r.reason}); the worktree is removed anyway.`);
	}
};

/** The setup file of the worktree's main checkout; nothing in a workspace that is not trusted. */
async function setupFor(wt: Worktree) {
	return vscode.workspace.isTrusted ? readSetupConfig(wt.root) : undefined;
}

/** Flow.agents.runWorktreeSetup: runs the setup file again in the worktree of an agent (the only one, or one picked). */
export async function runWorktreeSetup(agents: Agents): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		void vscode.window.showWarningMessage('Insilode: trust this folder to run its worktree setup.');
		return;
	}
	const withTree = [...agents.sessions.values()].filter(s => s.worktree);
	if (!withTree.length) {
		void vscode.window.showInformationMessage('Insilode: no agent has a worktree.');
		return;
	}
	const s = withTree.length === 1 ? withTree[0] : (await vscode.window.showQuickPick(withTree.map(a => ({ label: a.name, description: a.worktree!.branch, detail: a.worktree!.path, a })), { title: 'Run the worktree setup for…' }))?.a;
	const wt = s?.worktree;
	if (!wt) {
		return;
	}
	const found = await readSetupConfig(wt.root);
	if (!found) {
		void vscode.window.showInformationMessage(`Insilode: ${path.join(wt.root, '.insilode', 'worktree.json')} does not exist.`);
		return;
	}
	if ('errors' in found) {
		void vscode.window.showErrorMessage(`Insilode: .insilode/worktree.json: ${found.errors.join('; ')}`);
		return;
	}
	const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Insilode: setting up ${wt.branch}` }, () => runSetup(wt.root, wt.path, found.config, log));
	void (r.ok ? vscode.window.showInformationMessage(`Insilode: the setup of ${wt.branch} finished.`) : vscode.window.showErrorMessage(`Insilode: the setup of ${wt.branch} failed: ${r.reason}`));
}

// ── Cleanup ──────────────────────────────────────────────────────────────────────────────────────

interface Candidate {
	wt: Worktree;
	facts: WorktreeFacts;
}

const count = async (cwd: string, args: string[]) => {
	const r = await git(cwd, args);
	return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
};

/** The branch the worktrees merge into: origin's default if it is known and exists here, else the main checkout's own. */
async function defaultBranch(root: string, current: string): Promise<string> {
	const head = await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
	const name = head.stdout.trim().replace(/^origin\//, '');
	if (head.code === 0 && validBranch(name) && (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])).code === 0) {
		return name;
	}
	return current;
}

/** Everything the guards look at, read now. */
async function gather(agents: Agents, wt: Worktree): Promise<WorktreeFacts> {
	const ref = `refs/heads/${wt.branch}`;
	const head = (await git(wt.root, ['rev-parse', '--verify', '--quiet', ref])).stdout.trim();
	const contained = async (base: string) => (await git(wt.root, ['merge-base', '--is-ancestor', ref, base])).code === 0;
	const remoteBase = (await git(wt.root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${wt.base}`])).code === 0;
	const merged = !!head && (await contained(wt.base) || remoteBase && await contained(`refs/remotes/origin/${wt.base}`));
	const track = (await git(wt.root, ['for-each-ref', '--format=%(upstream:track)', ref])).stdout;
	const ct = Number((await git(wt.root, ['log', '-1', '--format=%ct', ref])).stdout.trim()) || Date.now() / 1000;
	const files = await changedFiles(wt.path);
	return {
		head, merged, remoteGone: track.includes('gone'),
		ahead: await count(wt.root, ['rev-list', '--count', `${wt.base}..${ref}`]),
		unpushed: await count(wt.root, ['rev-list', '--count', ref, '--not', wt.base, '--remotes']),
		dirty: files?.length,
		live: liveSessions(agents, wt).length > 0,
		ageDays: Math.max(0, Math.floor((Date.now() / 1000 - ct) / 86400)),
	};
}

const liveSessions = (agents: Agents, wt: Worktree): AgentSession[] =>
	[...agents.sessions.values()].filter(s => s.state !== 'ended' && s.worktree && sameDir(s.worktree.path, wt.path));

/** Flow.agents.cleanupWorktrees: offers the worktrees that look done, checks every guard again, removes the chosen ones. */
export async function cleanupWorktrees(agents: Agents): Promise<void> {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const info = folder ? await repoInfo(folder) : 'no folder is open';
	if (typeof info === 'string') {
		void vscode.window.showInformationMessage(`Insilode: cannot clean up worktrees: ${info}.`);
		return;
	}
	const candidates = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Insilode: looking at the agent worktrees' }, async () => {
		const fetched = await git(info.root, ['fetch', '--prune'], 120_000); // so a branch whose PR was merged shows as "remote gone"
		if (fetched.code !== 0) {
			log(`git fetch --prune failed (the list may miss merged PRs): ${(fetched.stderr || fetched.stdout).trim()}`);
		}
		const base = await defaultBranch(info.root, info.branch);
		const listed = await git(info.root, ['worktree', 'list', '--porcelain']);
		const dir = path.join(info.root, WORKTREE_DIR);
		const out: Candidate[] = [];
		for (const e of parseWorktreeList(listed.stdout)) {
			const rel = path.relative(path.resolve(dir), path.resolve(e.path));
			if (!e.branch || !validBranch(e.branch) || !rel || rel.startsWith('..') || path.isAbsolute(rel)) {
				continue;
			}
			const wt: Worktree = { path: path.resolve(e.path), branch: e.branch, base, root: info.root };
			out.push({ wt, facts: await gather(agents, wt) });
		}
		return out;
	});
	if (!candidates.length) {
		void vscode.window.showInformationMessage('Insilode: no agent worktrees in this repository.');
		return;
	}
	const items = candidates.map(c => {
		const k = classify(c.facts);
		return {
			label: `$(git-branch) ${c.wt.branch}`,
			description: `${k.state}${c.facts.ahead ? ` · ${c.facts.ahead} ahead` : ''} · ${c.facts.ageDays} d`,
			detail: `${c.wt.path}${k.blockers.length ? `  (kept: ${k.blockers.join(', ')})` : ''}`,
			picked: k.safe,
			c,
		};
	}).sort((a, b) => Number(b.picked) - Number(a.picked));
	const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Clean up agent worktrees', placeHolder: `Merged into ${candidates[0].wt.base} or remote gone are pre-picked; the branches stay` });
	if (!chosen?.length) {
		return;
	}
	let removed = 0;
	const skipped: string[] = [];
	for (const { c } of chosen) {
		// Time has passed since the list was read (the picker, the other removals): look at every guard again.
		const now = await gather(agents, c.wt);
		const ok = recheck(c.facts, now);
		if (!ok.ok) {
			skipped.push(`${c.wt.branch}: ${ok.reason}`);
			continue;
		}
		const r = await removeWorktree(c.wt, false);
		if (!r.ok) {
			skipped.push(`${c.wt.branch}: ${r.reason}`);
			continue;
		}
		removed++;
		for (const s of agents.sessions.values()) {
			if (s.worktree && sameDir(s.worktree.path, c.wt.path)) {
				agents.forget(s.id); // an ended row without its folder cannot be resumed
			}
		}
		for (const k of agents.keptWorktrees.filter(k => sameDir(k.path, c.wt.path))) {
			agents.keepWorktree(k, false);
		}
	}
	for (const line of skipped) {
		log(`Not removed, ${line}`);
	}
	const summary = `Insilode: removed ${removed} worktree${removed === 1 ? '' : 's'}; the branches stay.`;
	void (skipped.length ? vscode.window.showWarningMessage(`${summary} Skipped: ${skipped.join('; ')}`) : vscode.window.showInformationMessage(summary));
}
