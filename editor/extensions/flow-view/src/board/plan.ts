/*---------------------------------------------------------------------------------------------
 *  Insilode boards from a plan: the Markdown an agent proposes when it leaves plan mode becomes a
 *  `plan` board. Numbered steps (or, without them, section headings or bullets) become step nodes in
 *  order, joined by `next` edges; file paths and `Class.method` mentions become links to code when the
 *  index knows them; steps that talk about tests, the database or an API get a node kind. The same
 *  parser serves any agent: the plan is just Markdown. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import { normalizePath } from '../mcp/registry';
import type { BoardEdge, BoardGroup, BoardNode, BoardSpec, NodeKind, NodeStatus } from '../../../../../board-canvas/spec';

export interface PlanLink { file: string; line?: number }

export interface PlanResolvers {
	/** A path mentioned in the plan ("src/Orders/OrderService.cs"): where it is in the workspace, or undefined. */
	file?: (mention: string) => PlanLink | undefined;
	/** `Class.method` or a bare symbol: where the index has it, or undefined. */
	symbol?: (name: string) => PlanLink | undefined;
}

export const MAX_STEPS = 60;

const EXT = 'cs|csproj|ts|tsx|js|jsx|mjs|cjs|java|kt|py|go|rs|php|rb|sql|json|yml|yaml|xml|md|razor|vue|svelte|html|css|scss|prisma|gradle';
const PATH_RE = new RegExp(`(?:[A-Za-z]:)?[\\w@.\\-/\\\\]+\\.(?:${EXT})\\b(?::(\\d+)(?:-\\d+)?)?`, 'g');
const SYMBOL_RE = /\b([A-Z][A-Za-z0-9_]*)(?:\.|#|::)([A-Za-z_][A-Za-z0-9_]*)\b/g;
/** Section headings that introduce a plan rather than being a step of it. */
const INTRO = /^(context|background|summary|overview|goal|goals|problem|approach|notes?|assumptions?|open questions?|risks?|out of scope|references?)\b/i;

/** Plain text: Markdown emphasis, code ticks, links and tags removed. */
export function plain(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/(\*\*|__)(.*?)\1/g, '$2')
		// Italics only around whole words: snake_case names keep their underscores.
		.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s).,;:!?])/g, '$1$2')
		.replace(/`+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The kind of node a step reads like: API first (an endpoint change), then database, then tests. */
export function stepKind(text: string): NodeKind {
	const t = text.toLowerCase();
	if (/^(decide|choose|if\b|whether|check whether)|\?\s*$/.test(plain(text).toLowerCase())) {
		return 'decision';
	}
	// "controller", "handler", "repository" and "service" also end class names (UsersController): no word boundary before them.
	if (/\b(endpoint|route|rest|http|api)s?\b|(controller|handler)s?\b/.test(t)) {
		return 'controller';
	}
	if (/\b(migration|schema|database|db|sql|table|column|index|entity|orm)s?\b|repositor(y|ies)\b/.test(t)) {
		return 'repository';
	}
	if (/\b(tests?|specs?|unit|integration|assert|verify|verification|e2e)\b/.test(t)) {
		return 'note';
	}
	if (/services?\b|\b(manager|use ?case|domain)\b/.test(t)) {
		return 'service';
	}
	return 'step';
}

interface Item { list?: boolean; text: string; sub: string[]; indent: number; group?: number; status?: NodeStatus; level?: number }

const indentOf = (s: string) => s.replace(/\t/g, '    ').length - s.replace(/\t/g, '    ').trimStart().length;

/** Splits "Title: rest", "**Title** - rest" into a short label and its detail; long single sentences are cut. */
function labelOf(text: string): { label: string; detail?: string } {
	const t = plain(text);
	const head = /^(.{3,60}?)\s*(?::|\s[-–—]\s)\s+(.+)$/.exec(t);
	if (head && (/^\s*(\*\*|__)/.test(text) || head[1].split(' ').length <= 8)) {
		return { label: head[1], detail: head[2].slice(0, 200) };
	}
	if (t.length <= 90) {
		return { label: t };
	}
	const cut = t.lastIndexOf(' ', 90);
	return { label: t.slice(0, cut > 40 ? cut : 90) + '…', detail: t.slice(cut > 40 ? cut + 1 : 90).slice(0, 200) };
}

/** The first mention that resolves wins: a path before a `Class.method`. */
function linkOf(text: string, r: PlanResolvers): PlanLink | undefined {
	const raw = text.slice(0, 4000);
	const extensions = new RegExp(`\\.(?:${EXT})$`);
	if (r.file) {
		for (const m of raw.matchAll(PATH_RE)) {
			const hit = r.file(m[0].replace(/:\d+(?:-\d+)?$/, ''));
			if (hit) {
				return { file: hit.file, line: m[1] ? Number(m[1]) : hit.line };
			}
		}
	}
	if (r.symbol) {
		for (const m of raw.matchAll(SYMBOL_RE)) {
			if (extensions.test(m[0])) {
				continue;
			}
			const hit = r.symbol(`${m[1]}.${m[2]}`);
			if (hit) {
				return hit;
			}
		}
	}
	return undefined;
}

/** The paths and `Class.method` names a plan mentions, so a host can look them up (asynchronously) before parsing. */
export function mentions(markdown: string, max = 40): { files: string[]; symbols: string[] } {
	const raw = markdown.slice(0, 60_000);
	const extensions = new RegExp(`\\.(?:${EXT})$`);
	const files = new Set<string>();
	for (const m of raw.matchAll(PATH_RE)) {
		files.add(m[0].replace(/:\d+(?:-\d+)?$/, ''));
	}
	const symbols = new Set<string>();
	for (const m of raw.matchAll(SYMBOL_RE)) {
		if (!extensions.test(m[0])) {
			symbols.add(`${m[1]}.${m[2]}`);
		}
	}
	return { files: [...files].slice(0, max), symbols: [...symbols].slice(0, max) };
}

/** Turns plan Markdown into a `plan` board. Never throws; a plan with no structure becomes one step. */
export function parsePlan(markdown: string, resolvers: PlanResolvers = {}): BoardSpec {
	const headings: { text: string; level: number }[] = [];
	const numbered: Item[] = [];
	const bullets: Item[] = [];
	const sections: Item[] = [];
	let last: Item | undefined;
	let fence = false;
	let title: string | undefined;
	for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence || !line.trim()) {
			continue;
		}
		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			const text = plain(h[2]);
			headings.push({ text, level: h[1].length });
			title ??= text.replace(/^plan\s*[:\-–—]\s*/i, '');
			if (!INTRO.test(text) && !(headings.length === 1 && h[1].length === 1)) {
				last = { text: h[2], sub: [], indent: 0, level: h[1].length };
				sections.push(last);
			} else {
				last = undefined;
			}
			continue;
		}
		const n = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
		const b = /^(\s*)[-*+]\s+(.*)$/.exec(line);
		const m = n ?? b;
		if (m) {
			// An indented item under a list item is part of that item, not a step of its own.
			if (last?.list && indentOf(m[1]) > last.indent) {
				last.sub.push(m[2]);
				continue;
			}
			const box =/^\[([ xX-])\]\s+/.exec(m[2]);
			const item: Item = { list: true, text: box ? m[2].slice(box[0].length) : m[2], sub: [], indent: indentOf(m[1]), group: headings.length - 1, status: box ? (box[1] === ' ' ? 'todo' : box[1] === '-' ? 'skipped' : 'done') : undefined };
			(n ? numbered : bullets).push(item);
			last = item;
			continue;
		}
		if (last) {
			last.sub.push(line.trim());
		}
	}
	// Sub-items are text of their step, not steps: only the outermost level counts.
	const outer = (items: Item[]) => {
		if (!items.length) {
			return items;
		}
		const min = Math.min(...items.map(i => i.indent));
		const steps: Item[] = [];
		for (const i of items) {
			if (i.indent <= min) {
				steps.push(i);
			} else if (steps.length) {
				steps[steps.length - 1].sub.push(i.text, ...i.sub);
			}
		}
		return steps;
	};
	let steps = outer(numbered);
	if (!steps.length) {
		steps = sections.length ? sections : outer(bullets);
	}
	const total = steps.length;
	steps = steps.slice(0, MAX_STEPS);

	const nodes: BoardNode[] = [];
	const groupIds = new Map<number, string>();
	const groups: BoardGroup[] = [];
	const groupable = new Set(steps.map(s => s.group).filter((g): g is number => g !== undefined && g >= 0 && !INTRO.test(headings[g].text) && !(g === 0 && headings[g].level === 1)));
	for (const g of [...groupable].sort((a, b) => a - b)) {
		// A single group around everything says nothing.
		if (groupable.size > 1) {
			const id = `g${groups.length + 1}`;
			groupIds.set(g, id);
			groups.push({ id, label: headings[g].text.slice(0, 80) });
		}
	}
	steps.forEach((s, i) => {
		const { label, detail } = labelOf(s.text);
		const all = [s.text, ...s.sub].join(' ');
		const link = linkOf(all, resolvers);
		const note = s.sub.length ? plain(s.sub.join(' ')).slice(0, 600) : undefined;
		nodes.push({
			id: `s${i + 1}`,
			label: label || `Step ${i + 1}`,
			kind: stepKind(all),
			detail: detail && detail !== note ? detail : undefined,
			note,
			group: s.group !== undefined ? groupIds.get(s.group) : undefined,
			file: link?.file,
			line: link?.line,
			status: s.status ?? 'todo',
		});
	});
	if (!nodes.length) {
		const text = plain(markdown).slice(0, 600);
		nodes.push({ id: 's1', label: title?.slice(0, 90) || 'Plan', kind: 'step', note: text || undefined, status: 'todo' });
	}
	const edges: BoardEdge[] = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id, kind: 'next' }));
	return {
		version: 1,
		kind: 'plan',
		title: (title ?? nodes[0].label).slice(0, 120) || 'Plan',
		description: total > nodes.length ? `${total - nodes.length} more steps are not shown.` : undefined,
		direction: 'TB',
		nodes,
		edges,
		groups: groups.length ? groups : undefined,
	};
}

/** Nodes of a plan board that stand for this file (compared as the file system does). */
export function nodesLinkedTo(spec: BoardSpec, file: string, platform: NodeJS.Platform = process.platform): BoardNode[] {
	const want = normalizePath(file, platform);
	return spec.nodes.filter(n => n.file && normalizePath(n.file, platform) === want);
}

/**
 * The status a node moves to when the agent is about to edit its file ('before') or has edited it ('after').
 * A skipped step stays skipped, a blocked one stays blocked after an edit; editing a done step again reopens it.
 */
export function statusAfterEdit(current: NodeStatus | undefined, phase: 'before' | 'after'): NodeStatus {
	if (phase === 'before') {
		// The host applies 'before' and then 'after' to the same edit: a blocked step must survive both, not pass through 'doing' to 'done'.
		return current === 'skipped' || current === 'blocked' ? current : 'doing';
	}
	return current === 'skipped' || current === 'blocked' ? current : 'done';
}
