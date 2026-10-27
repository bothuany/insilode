/*---------------------------------------------------------------------------------------------
 *  Insilode: the pull request of the branch an agent works on, and its CI. Asked of the GitHub CLI
 *  (`gh pr view --json ...` in the agent's folder, an argument array, no shell), cached per folder
 *  and branch and asked again at most every couple of minutes. Without `gh`, signed out, outside a
 *  git repository or on a branch with no PR, a row simply shows nothing.
 *
 *  `statusCheckRollup` mixes two shapes: GitHub Actions and other check runs (`__typename: CheckRun`,
 *  `status` and `conclusion`) and commit statuses from older integrations (`StatusContext`, `state`).
 *
 *  Pure (no vscode; the process runner is passed in), so it is tested on its own.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';

export type Checks = 'pass' | 'fail' | 'pending' | 'none';

export interface PrState {
	number: number;
	/** `draft` is an open PR marked as draft. */
	state: 'open' | 'draft' | 'merged' | 'closed';
	title: string;
	url: string;
	checks: Checks;
	/** Checks by outcome, for the tooltip. */
	counts: { pass: number; fail: number; pending: number };
	/** The names of failing checks, the first few. */
	failing: string[];
	/** GitHub's review decision: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or empty. */
	reviewDecision: string;
	/** MERGEABLE, CONFLICTING or UNKNOWN (GitHub has not worked it out yet: not a conflict). */
	mergeable: string;
	/** The commit the PR's branch is at: a new push is a new commit. */
	headRefOid: string;
	comments: PrNote[];
	reviews: PrNote[];
	/** Login of whoever opened the PR. */
	author: string;
}

/** A comment or a review: `state` is the review's (CHANGES_REQUESTED, APPROVED, COMMENTED, ...), empty for a comment. */
export interface PrNote {
	id: string;
	author: string;
	body: string;
	state: string;
	/** GitHub's word for how the author relates to the repository: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, … */
	association: string;
}

export const PR_FIELDS = 'number,state,isDraft,title,url,statusCheckRollup,reviewDecision,mergeable,headRefOid,comments,reviews,author';

const FAIL = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const PASS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** One check's outcome, whichever of the two shapes it has. */
function outcome(c: Record<string, unknown>): 'pass' | 'fail' | 'pending' {
	const up = (v: unknown) => typeof v === 'string' ? v.toUpperCase() : '';
	if (c.__typename === 'StatusContext' || (c.state !== undefined && c.status === undefined)) {
		const s = up(c.state);
		return s === 'SUCCESS' ? 'pass' : FAIL.has(s) ? 'fail' : 'pending';
	}
	if (up(c.status) !== 'COMPLETED') {
		return 'pending';
	}
	const conclusion = up(c.conclusion);
	return FAIL.has(conclusion) ? 'fail' : PASS.has(conclusion) ? 'pass' : 'pending';
}

const str = (v: unknown) => typeof v === 'string' ? v : '';

function notes(v: unknown, review: boolean): PrNote[] {
	const out: PrNote[] = [];
	for (const n of Array.isArray(v) ? v : []) {
		const o = n && typeof n === 'object' ? n as Record<string, unknown> : undefined;
		const id = o && (typeof o.id === 'string' || typeof o.id === 'number') ? String(o.id) : '';
		if (o && id) {
			const a = o.author && typeof o.author === 'object' ? (o.author as Record<string, unknown>).login : undefined;
			out.push({ id, author: str(a), body: str(o.body).slice(0, 1000), state: review ? str(o.state).toUpperCase() : '', association: str(o.authorAssociation).toUpperCase() });
		}
	}
	return out;
}

/** `gh pr view --json` output as a PrState; undefined for anything without a PR number and a URL. */
export function parsePr(json: unknown): PrState | undefined {
	const o = json && typeof json === 'object' ? json as Record<string, unknown> : undefined;
	if (!o || typeof o.number !== 'number' || typeof o.url !== 'string' || !/^https:\/\//.test(o.url)) {
		return undefined;
	}
	const raw = typeof o.state === 'string' ? o.state.toUpperCase() : '';
	const state: PrState['state'] = raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : o.isDraft === true ? 'draft' : 'open';
	const counts = { pass: 0, fail: 0, pending: 0 };
	const failing: string[] = [];
	for (const c of Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup as Record<string, unknown>[] : []) {
		if (!c || typeof c !== 'object') {
			continue;
		}
		const r = outcome(c);
		counts[r]++;
		const name = typeof c.name === 'string' ? c.name : typeof c.context === 'string' ? c.context : undefined;
		// The same check runs for the push and for the PR: name it once.
		if (r === 'fail' && name && failing.length < 5 && !failing.includes(name)) {
			failing.push(name);
		}
	}
	const checks: Checks = counts.fail ? 'fail' : counts.pending ? 'pending' : counts.pass ? 'pass' : 'none';
	const author = o.author && typeof o.author === 'object' ? str((o.author as Record<string, unknown>).login) : '';
	return {
		number: o.number, state, title: typeof o.title === 'string' ? o.title.slice(0, 200) : '', url: o.url, checks, counts, failing,
		reviewDecision: str(o.reviewDecision).toUpperCase(), mergeable: str(o.mergeable).toUpperCase(), headRefOid: str(o.headRefOid),
		comments: notes(o.comments, false), reviews: notes(o.reviews, true), author,
	};
}

/** Runs a program with arguments (never a shell) and gives its stdout, or rejects with its stderr. */
export type Runner = (cmd: string, args: string[], cwd: string) => Promise<string>;

export const execRunner: Runner = (cmd, args, cwd) => new Promise((resolve, reject) => {
	execFile(cmd, args, { cwd, timeout: 15_000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
		if (err) {
			reject(Object.assign(err, { stderr: String(stderr ?? '') }));
		} else {
			resolve(String(stdout));
		}
	});
});

/** How often one folder's PR is asked for again. */
export const PR_TTL_MS = 120_000;
/** After `gh` said it is not signed in, it is left alone this long. */
export const SIGNED_OUT_MS = 10 * 60_000;

interface Entry {
	branch?: string;
	pr?: PrState;
	at: number;
	pending?: Promise<PrState | undefined>;
}

/**
 * The PR per folder. `get` answers from the cache at once and refreshes it in the background when it is
 * stale; `onChange` hears when an answer arrives that differs from the cached one.
 */
export class PrWatcher {
	private readonly cache = new Map<string, Entry>();
	/** `gh` is not installed: never asked again in this window. */
	private missing = false;
	private signedOutUntil = 0;

	constructor(private readonly onChange: (cwd: string) => void, private readonly run: Runner = execRunner, private readonly now = () => Date.now()) { }

	get(cwd: string): PrState | undefined {
		const e = this.cache.get(cwd);
		if (!e || (!e.pending && this.now() - e.at >= PR_TTL_MS)) {
			void this.refresh(cwd);
		}
		return e?.pr;
	}

	/** Asks again now (a turn just ended, say), unless an answer is less than `minAge` old or one is on its way. */
	refresh(cwd: string, minAge = PR_TTL_MS): Promise<PrState | undefined> {
		const e = this.cache.get(cwd);
		if (e?.pending) {
			return e.pending;
		}
		if (this.missing || this.now() < this.signedOutUntil || (e && this.now() - e.at < minAge)) {
			return Promise.resolve(e?.pr);
		}
		const entry: Entry = e ?? { at: 0 };
		this.cache.set(cwd, entry);
		entry.pending = this.fetch(cwd, entry).finally(() => entry.pending = undefined);
		return entry.pending;
	}

	private async fetch(cwd: string, entry: Entry): Promise<PrState | undefined> {
		const before = JSON.stringify(entry.pr);
		try {
			const branch = (await this.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
			if (!branch || branch === 'HEAD') {
				entry.pr = undefined; // detached: no branch, no PR
			} else {
				const out = await this.run('gh', ['pr', 'view', '--json', PR_FIELDS], cwd).catch(e => this.failed(e));
				entry.pr = out === undefined ? undefined : parsePr(JSON.parse(out));
			}
			entry.branch = branch;
		} catch {
			entry.pr = undefined; // not a git folder, or the answer did not parse
		}
		entry.at = this.now();
		if (JSON.stringify(entry.pr) !== before) {
			this.onChange(cwd);
		}
		return entry.pr;
	}

	/** Why `gh` failed decides whether to ask again: missing never, signed out in a while, "no PR" on the next turn. */
	private failed(e: NodeJS.ErrnoException & { stderr?: string }): undefined {
		if (e.code === 'ENOENT') {
			this.missing = true;
		} else if (/gh auth login|not logged in|authentication/i.test(e.stderr ?? '')) {
			this.signedOutUntil = this.now() + SIGNED_OUT_MS;
		}
		return undefined;
	}
}
