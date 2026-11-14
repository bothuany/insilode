/*---------------------------------------------------------------------------------------------
 *  Insilode: what the host does for the Agents page's Harness panel. The page is not trusted: it names a folder, never a command, and the
 *  host only answers for a folder the page was given (this window's folder, a session's folder, a project of the sessions index), asking
 *  flow-harness's `flowHarness.summary` through a command (extensions never import each other). A file is opened only if the summary the page
 *  was last sent for that folder named it. No `vscode`: everything it needs comes in as `HarnessDeps`, so it is tested on its own.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import type { AgentsPageHarnessData, AgentsPageHarnessFailed, HarnessSummary, HarnessSummaryResult } from './harnessData';

export interface HarnessDeps {
	/** The folders the page has been told about without asking anything slow: this window's and its sessions'. */
	near(): string[];
	/** The rest of what the page has been told about: the project folders of the machine's sessions index. Asked only when `near` does not name the folder. */
	indexed(): Promise<string[]>;
	/** flowHarness.summary. Rejects when flow-harness is not there. */
	summary(folder: string): PromiseLike<unknown>;
	open(file: string, line?: number): PromiseLike<unknown> | void;
}

/** The summaries kept so their files can be opened: the folders the page looked at most recently. */
const KEEP = 8;

/** A folder tidied: resolved (no `..`) and without a trailing separator. */
export function tidyFolder(folder: string, platform: NodeJS.Platform = process.platform): string {
	const p = platform === 'win32' ? path.win32 : path.posix;
	const resolved = p.resolve(folder);
	return resolved.length > p.parse(resolved).root.length && resolved.endsWith(p.sep) ? resolved.slice(0, -1) : resolved;
}

/** A folder as a key: tidied, and case folded where the file system does (Windows). */
export function folderKey(folder: string, platform: NodeJS.Platform = process.platform): string {
	const bare = tidyFolder(folder, platform);
	return platform === 'win32' ? bare.toLowerCase() : bare;
}

/** Whether `folder` is one of `known`. */
export function isKnownFolder(folder: string, known: Iterable<string>, platform: NodeJS.Platform = process.platform): boolean {
	const key = folderKey(folder, platform);
	for (const k of known) {
		if (folderKey(k, platform) === key) {
			return true;
		}
	}
	return false;
}

/** Every absolute file the summary names: what the page may ask to open. */
export function summaryFiles(s: HarnessSummary): Set<string> {
	const out = new Set<string>();
	const add = (list: { file?: string }[] | undefined) => (Array.isArray(list) ? list : []).forEach(x => typeof x?.file === 'string' && out.add(x.file));
	add(s.instructions); add(s.hooks); add(s.mcp); add(s.findings);
	add(s.permissions?.allow); add(s.permissions?.ask); add(s.permissions?.deny);
	add(s.skills?.items); add(s.agents?.items); add(s.commands?.items);
	return out;
}

const looksLikeSummary = (v: unknown): v is HarnessSummary => !!v && typeof v === 'object' && typeof (v as HarnessSummary).root === 'string' && typeof (v as HarnessSummary).permissions === 'object' && (v as HarnessSummary).permissions !== null;

export class HarnessBridge {
	/** folder key -> the files of the last summary sent for it. */
	private readonly files = new Map<string, Set<string>>();

	constructor(private readonly deps: HarnessDeps, private readonly platform: NodeJS.Platform = process.platform) {}

	/**
	 * The answer to the page's ask. `folder` is what the page sent: undefined means this window's folder (`fallback`). A folder the page was
	 * not given is refused without asking flow-harness anything.
	 */
	async load(folder: string | undefined, fallback: string | undefined): Promise<AgentsPageHarnessData | AgentsPageHarnessFailed> {
		const echo = folder === undefined ? {} : { cwd: folder };
		const given = folder ?? fallback;
		if (given === undefined) {
			return { type: 'harnessFailed', ...echo, message: 'This window has no folder open.' };
		}
		// What is asked of flow-harness is the folder tidied, not as the page wrote it.
		const target = tidyFolder(given, this.platform);
		if (!isKnownFolder(target, this.deps.near(), this.platform) && !isKnownFolder(target, await this.deps.indexed().catch(() => []), this.platform)) {
			return { type: 'harnessFailed', ...echo, message: 'That folder is not one of the projects listed here.' };
		}
		let result: unknown;
		try {
			result = await this.deps.summary(target);
		} catch {
			return { type: 'harnessFailed', ...echo, message: 'The harness extension is not available.' };
		}
		const r = result as Partial<HarnessSummaryResult> | undefined;
		if (r?.ok === true && looksLikeSummary(r.summary)) {
			const key = folderKey(target, this.platform);
			this.files.delete(key);
			this.files.set(key, summaryFiles(r.summary));
			for (const old of [...this.files.keys()].slice(0, Math.max(0, this.files.size - KEEP))) {
				this.files.delete(old);
			}
			return { type: 'harnessData', ...echo, summary: r.summary };
		}
		return { type: 'harnessFailed', ...echo, message: r?.ok === false && typeof r.message === 'string' ? r.message.slice(0, 200) : 'The harness could not be read.' };
	}

	/** Opens `file` when the last summary sent for `folder` named it; says whether it did. */
	open(folder: string | undefined, fallback: string | undefined, file: string, line?: number): boolean {
		const target = folder ?? fallback;
		const named = target === undefined ? undefined : this.files.get(folderKey(target, this.platform));
		if (!named?.has(file)) {
			return false;
		}
		void Promise.resolve(this.deps.open(file, line)).catch(() => undefined);
		return true;
	}
}
