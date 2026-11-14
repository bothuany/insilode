/*---------------------------------------------------------------------------------------------
 *  Insilode: the Agents page's sidebar list of earlier sessions across the machine, and the search through them. It is what is left of
 *  the page's own chat once the page became a terminal workspace: the index (sessionIndex.ts) grouped by project, this window's own
 *  project first, and the search (sessionSearch.ts) over exactly the sessions that list shows. Opening one is a terminal (termHost.ts).
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import * as path from 'path';
import type { ChatProject } from './agentsData';
import { samePath } from './chatCore';
import { real } from './folderTrust';
import { listLive, mergeLive, type LiveSession } from './liveSessions';
import { SessionIndex, transcriptFile } from './sessionIndex';
import { searchSessions, type SessionHit } from './sessionSearch';
import { folderKey } from './storageKey';

const tilde = (p: string) => { const home = os.homedir(); return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p; };

export class ProjectIndex {
	private readonly index = new SessionIndex();
	/** What the last `projects()` returned: a search covers exactly that, so a slow scan never holds up a search of what the page already lists. */
	private listed: ChatProject[] = [];
	/** The transcript of each Claude session some other program runs, from the last `projects()`: the host reads a tail from it, the page never names a path. */
	private liveFiles = new Map<string, string>();

	/**
	 * `folder`: this window's own folder. `live`: the ids of the sessions running in a terminal of this window (they are listed as agents, not as past sessions).
	 * `peers`: the ids of the other Insilode windows' sessions, which are agents too. `running`: the Claude sessions that run on this machine now.
	 */
	constructor(private readonly folder: () => string | undefined, private readonly live: () => string[], private readonly peers: () => string[] = () => [], private readonly running: () => Promise<LiveSession[]> = () => listLive()) {}

	/** Projects on this machine with their sessions, this window's own first (always listed, so a session can start in it). Sessions that run outside this window are marked (liveSessions.ts). */
	async projects(): Promise<ChatProject[]> {
		const own = this.folder();
		const ownReal = own ? await real(own) : undefined;
		const live = new Set(this.live());
		const out: ChatProject[] = own ? [{ key: folderKey(own), name: path.basename(own) || own, where: tilde(own), cwd: own, own: true, sessions: [] }] : [];
		for (const p of await this.index.list()) {
			const mine = ownReal !== undefined && samePath(await real(p.cwd), ownReal);
			const into = mine ? out[0] : { key: p.key, name: p.name, where: tilde(p.cwd), cwd: p.cwd, own: false, sessions: [] as ChatProject['sessions'] };
			into.sessions.push(...p.sessions.filter(s => !live.has(s.id)));
			if (!mine && into.sessions.length) {
				out.push(into);
			}
		}
		if (out[0]?.own) {
			out[0].sessions.sort((a, b) => b.modified - a.modified);
		}
		const running = await this.running().catch(() => [] as LiveSession[]);
		const reals = new Map<string, string>();
		await Promise.all([...new Set([...out.map(p => p.cwd), ...running.map(l => l.cwd)])].map(async cwd => { reals.set(cwd, await real(cwd)); }));
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

	/** What the running sessions look like now, for a cheap "did anything change" (the index is built only when it did). */
	async runningSignature(): Promise<string> {
		return JSON.stringify((await this.running().catch(() => [] as LiveSession[])).map(l => [l.id, l.status, l.updatedAt, l.name]));
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
