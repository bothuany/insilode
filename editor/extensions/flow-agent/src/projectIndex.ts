/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page's sidebar list of earlier sessions across the machine, and the search through them. It is what is left of
 *  the page's own chat once the page became a terminal workspace: the index (sessionIndex.ts) grouped by project, this window's own
 *  project first, and the search (sessionSearch.ts) over exactly the sessions that list shows. Opening one is a terminal (termHost.ts).
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ChatProject } from './agentsData';
import { Budgeted } from './budgeted';
import { samePath } from './chatCore';
import { real } from './folderTrust';
import { listLive, mergeLive, type LiveSession } from './liveSessions';
import { SessionIndex, transcriptFile, type IndexedProject } from './sessionIndex';
import { searchSessions, type SessionHit } from './sessionSearch';
import { folderKey } from './storageKey';

/** How many of the newest Codex sessions a cached look stats, and for how long: the poll must stay cheap, and a hung mount must not hold it up. */
const CODEX_STATS = 60;
const CODEX_STAT_MS = 500;

const tilde = (p: string) => { const home = os.homedir(); return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p; };

export class ProjectIndex {
	private readonly index = new SessionIndex();
	/** What the last `projects()` returned: a search covers exactly that, so a slow scan never holds up a search of what the page already lists. */
	private listed: ChatProject[] = [];
	/** The transcript of each Claude session some other program runs, from the last `projects()`: the host reads a tail from it, the page never names a path. */
	private liveFiles = new Map<string, string>();
	private fresh: { at: number; list: LiveSession[] } | undefined;
	/** The Codex rollout times of the last look: while its stat calls have not all come back (a hung mount), the poll does not start more (budgeted.ts). */
	private readonly rollouts = new Budgeted<Map<string, number>, Map<string, number>>(new Map());

	/**
	 * `folder`: this window's own folder. `live`: the ids of the sessions running in a terminal of this window (they are listed as agents, not as past sessions).
	 * `peers`: the ids of the other Insilode windows' sessions, which are agents too. `running`: the Claude sessions that run on this machine now.
	 */
	constructor(private readonly folder: () => string | undefined, private readonly live: () => string[], private readonly peers: () => string[] = () => [], private readonly running: () => Promise<LiveSession[]> = () => listLive(), private readonly stat: (file: string) => Promise<{ isFile(): boolean; mtimeMs: number } | undefined> = file => fs.stat(file).catch(() => undefined)) {}

	/**
	 * Projects on this machine with their sessions, this window's own first (always listed, so a session can start in it). Sessions that run outside this
	 * window are marked (liveSessions.ts). `cached`: from the last scan of the transcripts however old it is, so the page's poll re-reads only the registry.
	 */
	async projects(o: { cached?: boolean } = {}): Promise<ChatProject[]> {
		const own = this.folder();
		const live = new Set(this.live());
		const listed = await this.index.list(Date.now(), o.cached);
		const indexed = await this.freshCodex(listed);
		const running = await this.runningNow();
		// One real path per folder for the whole call: the project of this window, the indexed ones and the running ones share it.
		const reals = new Map<string, string>();
		await Promise.all([...new Set([...(own ? [own] : []), ...indexed.map(p => p.cwd), ...running.map(l => l.cwd)])].map(async cwd => { reals.set(cwd, await real(cwd)); }));
		const ownReal = own ? reals.get(own) : undefined;
		const out: ChatProject[] = own ? [{ key: folderKey(own), name: path.basename(own) || own, where: tilde(own), cwd: own, own: true, sessions: [] }] : [];
		for (const p of indexed) {
			const mine = ownReal !== undefined && samePath(reals.get(p.cwd) ?? p.cwd, ownReal);
			const into = mine ? out[0] : { key: p.key, name: p.name, where: tilde(p.cwd), cwd: p.cwd, own: false, sessions: [] as ChatProject['sessions'] };
			into.sessions.push(...p.sessions.filter(s => !live.has(s.id)));
			if (!mine && into.sessions.length) {
				out.push(into);
			}
		}
		if (out[0]?.own) {
			out[0].sessions.sort((a, b) => b.modified - a.modified);
		}
		const merged = mergeLive(out, running, {
			skip: new Set([...live, ...this.peers()]),
			realOf: cwd => reals.get(cwd) ?? cwd,
			describe: cwd => ({ key: folderKey(cwd), name: path.basename(cwd) || cwd, where: tilde(cwd) }),
			now: Date.now(),
		});
		this.liveFiles = merged.files;
		this.listed = merged.projects;
		return merged.projects;
	}

	/**
	 * Codex keeps no registry of running sessions: "recently active" is its rollout's modification time. An index is as old as its last
	 * scan (a cached look may be much older), so the rollouts it lists are stat'ed again (the newest few, within a short budget) and a newer time replaces the scanned one, on a copy.
	 */
	private async freshCodex(indexed: IndexedProject[]): Promise<IndexedProject[]> {
		const newest = indexed.flatMap(p => p.sessions).filter(s => s.kind === 'codex').sort((a, b) => b.modified - a.modified).slice(0, CODEX_STATS);
		const fresh = await this.rollouts.run(CODEX_STAT_MS, async into => {
			await Promise.all(newest.map(async s => {
				const file = transcriptFile('codex', s.id);
				const st = file ? await this.stat(file) : undefined;
				if (st?.isFile()) {
					into.set(s.id, st.mtimeMs);
				}
			}));
		}, () => new Map(), into => new Map(into));
		return fresh.size ? indexed.map(p => ({ ...p, sessions: p.sessions.map(s => s.kind === 'codex' && (fresh.get(s.id) ?? 0) > s.modified ? { ...s, modified: fresh.get(s.id)! } : s).sort((a, b) => b.modified - a.modified) })) : indexed;
	}

	/** The running sessions the last `runningSignature()` read a moment ago (the poll asks, then builds the index from the same answer), else a read now. */
	private async runningNow(): Promise<LiveSession[]> {
		const f = this.fresh;
		this.fresh = undefined;
		return f && Date.now() - f.at < 1000 ? f.list : this.running().catch(() => [] as LiveSession[]);
	}

	/** What the running sessions look like now, for a cheap "did anything change" (the index is built only when it did). */
	async runningSignature(): Promise<string> {
		const list = await this.running().catch(() => [] as LiveSession[]);
		this.fresh = { at: Date.now(), list };
		return JSON.stringify(list.map(l => [l.id, l.status, l.updatedAt, l.name]));
	}

	/** The transcript of a session the page lists, for its tail: nothing for an id the host does not list. */
	transcriptOf(kind: 'claude' | 'codex', id: string): string | undefined {
		const listed = this.listed.some(p => p.sessions.some(s => s.kind === kind && s.id === id));
		return listed ? transcriptFile(kind, id) ?? (kind === 'claude' ? this.liveFiles.get(id) : undefined) : undefined;
	}

	/** Past sessions of the projects the page lists whose conversation contains `query`. Nothing here is logged: a snippet is text from any project on the machine and goes to the page that asked. */
	async search(query: string, signal: AbortSignal): Promise<{ hits: SessionHit[]; more: boolean; cut: boolean }> {
		const projects = this.listed.length ? this.listed : await this.projects();
		return searchSessions(projects, (kind, id) => this.transcriptOf(kind, id), query, signal);
	}
}
