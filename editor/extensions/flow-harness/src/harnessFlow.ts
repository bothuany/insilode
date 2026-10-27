/*---------------------------------------------------------------------------------------------
 *  Insilode Harness: the harness flow diagram's model. Places every harness piece at the step of an
 *  agent turn where it acts, and for the preview and replay modes, the path one event takes through
 *  them (protocol/harness.ts). flow-view's panel asks for it through flowHarness.flowModel. The placing
 *  and matching are pure (harnessFlowModel.ts); this reads the settings and the transcripts.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HarnessFlowModel, HarnessFlowRequest, ReplaySession } from '../../../../protocol/harness';
import { effectiveSettings } from './effective';
import { decisionItem, PERMISSION_FALLBACK, place, previewHits, replaySteps, type PathEnv } from './harnessFlowModel';
import type { Live } from './live';
import type { Harness } from './scan';
import { projectTranscripts } from './dirs';
import { parseTranscript, readLines } from './transcript';
import { loadLayers } from './why';

export { toRequest } from './harnessFlowModel';

const MAX_SESSIONS = 20;
/** Only the newest part of a transcript this large is read: a replay is of what the session did lately. */
const MAX_TRANSCRIPT = 32 << 20;
const HEAD = 64 << 10;

/** The mode the verdicts assume: what the newest Claude session's hooks reported, else defaultMode in the settings, else Claude Code's built-in default (as Why? does). */
function modeOf(live: Live, settingsMode: string | undefined): string {
	const s = [...live.sessions.values()].filter(x => x.cli === 'claude' && x.mode).sort((a, b) => b.at - a.at)[0];
	return s?.mode ?? settingsMode ?? 'auto';
}

async function sessionsOf(root: string): Promise<{ list: ReplaySession[]; files: Map<string, string> }> {
	const stats = (await Promise.all((await projectTranscripts(root)).map(async file => {
		const st = await fs.stat(file).catch(() => undefined);
		return st ? { file, mtime: st.mtimeMs } : undefined;
	}))).filter((x): x is { file: string; mtime: number } => !!x).sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);
	const files = new Map<string, string>();
	const list = await Promise.all(stats.map(async ({ file, mtime }): Promise<ReplaySession> => {
		const id = path.basename(file, '.jsonl');
		files.set(id, file);
		let title = id.slice(0, 8);
		try {
			const h = await fs.open(file, 'r');
			try {
				const buf = Buffer.alloc(HEAD);
				const { bytesRead } = await h.read(buf, 0, HEAD, 0);
				const lines = buf.toString('utf8', 0, bytesRead).split('\n');
				lines.pop(); // cut by the read
				const first = parseTranscript(lines).prompts[0]?.text;
				if (first) {
					title = first.replace(/\s+/g, ' ').slice(0, 80);
				}
			} finally {
				await h.close();
			}
		} catch {
			// unreadable: the id is the title
		}
		return { id, agent: 'Claude', title, at: mtime };
	}));
	return { list, files };
}

export async function flowModel(request: HarnessFlowRequest, harness: Harness | undefined, live: Live): Promise<HarnessFlowModel> {
	const root = harness?.root ?? '';
	const placed = place(harness?.items ?? [], request.agent);
	const model: HarnessFlowModel = { root, items: placed.map(p => p.item) };
	if (!harness || request.mode === 'static' || (request.mode === 'preview' && !request.event)) {
		return model;
	}
	const eff = effectiveSettings(await loadLayers(root));
	const mode = modeOf(live, eff.mode);
	const env: PathEnv = { root, home: os.homedir(), rules: eff.rules, mode, additionalDirs: eff.additionalDirs.map(d => path.resolve(root, d)) };
	const withDecision = (used: boolean, effect?: 'allow' | 'ask' | 'deny', reason?: string) => {
		if (used) {
			model.items.push(decisionItem(mode, effect, reason));
		}
	};
	if (request.mode === 'preview') {
		const { hits, verdict } = previewHits(request.event!, placed, env);
		model.hits = hits;
		model.mode = mode;
		withDecision(hits.some(h => h.itemId === PERMISSION_FALLBACK), verdict?.decision, verdict?.reason);
		return model;
	}
	const { list, files } = await sessionsOf(root);
	model.sessions = list;
	model.mode = mode;
	const file = request.session ? files.get(request.session) : undefined;
	if (file) {
		const lines: string[] = [];
		await readLines(file, 0, chunk => { lines.push(...chunk); }, { maxFile: MAX_TRANSCRIPT });
		model.steps = replaySteps(lines, placed, env);
		// A step no rule decided points at the piece standing for the permission mode.
		withDecision(model.steps.some(st => st.hits.some(h => h.itemId === PERMISSION_FALLBACK)));
	}
	return model;
}
