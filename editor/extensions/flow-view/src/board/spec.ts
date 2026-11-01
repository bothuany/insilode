/*---------------------------------------------------------------------------------------------
 *  Insilode board: one diagram format for everything that is drawn on its own canvas rather than
 *  traced from the code: the DTO relations, the architecture (UML) view, and flows or plans an
 *  agent draws. Hosts build a BoardSpec, the canvas renders it. Keep this file identical to
 *  ui/src/board/spec.ts (a test compares them).
 *--------------------------------------------------------------------------------------------*/

export type BoardKind = 'flow' | 'plan' | 'class' | 'er' | 'sequence' | 'architecture' | 'state';

/** C4 level of an architecture board: who uses the system, what it is made of, what one part is made of. */
export type BoardLevel = 'context' | 'container' | 'component';

export type NodeShape = 'rect' | 'round' | 'diamond' | 'cylinder' | 'actor' | 'cloud' | 'initial' | 'final' | 'choice';

/** Compare: what a node or edge is against the base board. The host fills it for a board with a `base`; an agent may set it on a proposed board. */
export type ChangeMark = 'added' | 'removed' | 'changed';

export type EdgeLine = 'solid' | 'dashed' | 'dotted';

/** boundary, lane and layer box nodes; alt, loop and opt are sequence fragments that box messages (edges with `fragment`). */
export type GroupKind = 'boundary' | 'lane' | 'layer' | 'alt' | 'loop' | 'opt';

export type NodeKind =
	| 'entry' | 'controller' | 'service' | 'repository' | 'entity' | 'dto' | 'enum' | 'interface' | 'class'
	| 'external' | 'step' | 'decision' | 'note' | 'actor';

export type NodeStatus = 'todo' | 'doing' | 'done' | 'skipped' | 'blocked';

/**
 * Skeleton first: how the code compares with a planned type or member. `existing` is a type or member that was in the code before
 * the design was drawn: neutral, so a type the change only adds to does not read as done. Set by the host only, never by an agent
 * (parseBoard drops it).
 */
export type CheckState = 'matches' | 'missing' | 'differs' | 'existing';

export type EdgeKind =
	| 'calls' | 'extends' | 'implements' | 'uses' | 'has' | 'has-many' | 'depends'
	| 'next' | 'yes' | 'no' | 'reads' | 'writes' | 'message';

export interface BoardMember {
	text: string;
	kind?: 'field' | 'method' | 'property';
	/** UML visibility: + public, - private, # protected, ~ package. */
	visibility?: '+' | '-' | '#' | '~';
	/** The type another node is drawn for, so the member can link to it (an ER or class edge starts here). */
	ref?: string;
	/** Host-only (skeleton first): the member in the code against the plan, why, and a warning that the agent changed it. */
	check?: CheckState;
	checkNote?: string;
	warn?: string;
}

export interface BoardNode {
	/** Unique in the board. */
	id: string;
	label: string;
	kind?: NodeKind;
	/** One line under the label. */
	detail?: string;
	/** Group id (a layer, a service, a package). */
	group?: string;
	/** Where it lives: clicking opens it. */
	file?: string;
	line?: number;
	status?: NodeStatus;
	members?: BoardMember[];
	/** For plans: what the step changes, as free text. */
	note?: string;
	/** A real code symbol ("OrderService.Place"): the host checks it against the index and fills `file` and `line`. */
	symbol?: string;
	/** C4: the technology, one line under the label. */
	tech?: string;
	shape?: NodeShape;
	change?: ChangeMark;
	/** Swimlane: the id of a group of kind `lane`. */
	lane?: string;
	/** C4 zoom: the id of a board that opens this box one level down. */
	zoom?: string;
	/** Host-only (skeleton first): the type in the code against the plan, why, and a warning that the agent changed it. */
	check?: CheckState;
	checkNote?: string;
	warn?: string;
	/** Host-only (skeleton first): the file a new type belongs in (workspace-relative), what that follows, and whether clicking offers to create it. */
	target?: { path: string; reason: string; create?: boolean };
}

export interface BoardEdge {
	from: string;
	to: string;
	label?: string;
	kind?: EdgeKind;
	/** ER cardinality at each end, e.g. '1' and '0..*'. */
	fromCard?: string;
	toCard?: string;
	/** Order of a message or step (1, 2, 3...): drawn as a number badge, the sequence's row order and the default step order. */
	order?: number;
	style?: EdgeLine;
	/** An asynchronous message (open arrow head). A return is `style: "dashed"`. */
	async?: boolean;
	/** A state transition's condition, shown as [guard]. */
	guard?: string;
	change?: ChangeMark;
	/** Sequence: the id of the alt, loop or opt group this message sits in. */
	fragment?: string;
}

export interface BoardGroup {
	id: string;
	label: string;
	parent?: string;
	/** Drawn collapsed until opened. */
	collapsed?: boolean;
	kind?: GroupKind;
	/** C4: the technology of a boundary. */
	tech?: string;
}

/** One step of the walk-through a board plays like a tour: what lights up and what is said. */
export interface BoardStep {
	title: string;
	caption: string;
	nodes?: string[];
	/** Edges as [from, to] node ids. */
	edges?: [string, string][];
	/** A group (or node) to open for this step. */
	focus?: string;
}

/** A route drawn bold with the rest dimmed. */
export interface BoardHighlight {
	path: string[];
	label?: string;
}

/** A note attached to a node or an edge, drawn as a bubble. */
export interface BoardCallout {
	node?: string;
	edge?: [string, string];
	text: string;
}

export interface BoardLegendEntry {
	key: string;
	text: string;
}

export interface BoardSpec {
	version: 1;
	kind: BoardKind;
	title: string;
	description?: string;
	direction?: 'LR' | 'TB';
	nodes: BoardNode[];
	edges: BoardEdge[];
	groups?: BoardGroup[];
	/** architecture only. */
	level?: BoardLevel;
	legend?: BoardLegendEntry[];
	/** The node or group opened first. */
	focus?: string;
	/** Compare against this board's id: the host marks what is added, removed or changed. */
	base?: string;
	steps?: BoardStep[];
	highlight?: BoardHighlight[];
	callouts?: BoardCallout[];
}

const NODE_KINDS = new Set<string>(['entry', 'controller', 'service', 'repository', 'entity', 'dto', 'enum', 'interface', 'class', 'external', 'step', 'decision', 'note', 'actor']);
const EDGE_KINDS = new Set<string>(['calls', 'extends', 'implements', 'uses', 'has', 'has-many', 'depends', 'next', 'yes', 'no', 'reads', 'writes', 'message']);
const STATUSES = new Set<string>(['todo', 'doing', 'done', 'skipped', 'blocked']);
const BOARD_KINDS = new Set<string>(['flow', 'plan', 'class', 'er', 'sequence', 'architecture', 'state']);
const LEVELS = new Set<string>(['context', 'container', 'component']);
const SHAPES = new Set<string>(['rect', 'round', 'diamond', 'cylinder', 'actor', 'cloud', 'initial', 'final', 'choice']);
const CHANGES = new Set<string>(['added', 'removed', 'changed']);
const LINES = new Set<string>(['solid', 'dashed', 'dotted']);
const GROUP_KINDS = new Set<string>(['boundary', 'lane', 'layer', 'alt', 'loop', 'opt']);
export const MAX_NODES = 400;
export const MAX_EDGES = 1200;
export const MAX_STEPS = 40;
export const MAX_CALLOUTS = 60;
export const MAX_HIGHLIGHTS = 10;

/** What parseBoard changed or dropped, in sentences an agent can act on (the lint of draw_board starts from these). */
export interface ParsedBoard {
	spec: BoardSpec;
	notes: string[];
}

/** Notes by category: a few of each are spelled out, the rest are counted. */
class Notes {
	private readonly by = new Map<string, { shown: string[]; more: number }>();
	add(category: string, message: string) {
		const e = this.by.get(category) ?? { shown: [], more: 0 };
		if (e.shown.length < 5) {
			e.shown.push(message);
		} else {
			e.more++;
		}
		this.by.set(category, e);
	}
	list(): string[] {
		return [...this.by.values()].flatMap(e => [...e.shown, ...(e.more ? [`...and ${e.more} more of that kind.`] : [])]);
	}
}

function editDistance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = row;
	}
	return prev[b.length];
}

/** An id of `ids` that looks like `id` (one inside the other, or a small edit apart), for "did you mean". */
export function nearestId(id: string, ids: Iterable<string>): string | undefined {
	const want = id.toLowerCase();
	let best: string | undefined;
	let bestScore = Infinity;
	for (const c of ids) {
		const have = c.toLowerCase();
		let score: number;
		if (have === want) {
			score = 0;
		} else if (have.includes(want) || want.includes(have)) {
			score = 1 + Math.abs(have.length - want.length) / 100;
		} else {
			score = editDistance(want.slice(0, 40), have.slice(0, 40));
			if (score > Math.max(2, want.length / 3)) {
				continue;
			}
			score += 2;
		}
		if (score < bestScore) {
			bestScore = score;
			best = c;
		}
	}
	return best;
}

const str = (v: unknown, max: number): string | undefined => typeof v === 'string' && v ? v.slice(0, max) : undefined;
const pair = (v: unknown): [string, string] | undefined => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'string' ? [v[0], v[1]] : undefined;
const boardId = (v: unknown): string | undefined => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v) ? v : undefined;

/**
 * Checks and cleans a board that came from outside (an agent's tool call): unknown enum values are dropped,
 * dangling edges removed, ids made unique, sizes capped. Throws with a message an agent can act on.
 */
export function parseBoard(input: unknown): BoardSpec {
	return parseBoardWithNotes(input).spec;
}

/** parseBoard, and what it silently changed or dropped, so the tool can say so. Old boards parse as before: every new field is optional. */
export function parseBoardWithNotes(input: unknown): ParsedBoard {
	if (typeof input !== 'object' || input === null) {
		throw new Error('A board must be an object: { kind, title, nodes, edges }.');
	}
	const raw = input as Record<string, unknown>;
	const notes = new Notes();
	// An enum value that is not one of the allowed: dropped (the default is drawn), and said.
	const pick = <T extends string>(set: Set<string>, value: unknown, where: string, what: string, fallback?: string): T | undefined => {
		if (typeof value !== 'string') {
			return undefined;
		}
		if (set.has(value)) {
			return value as T;
		}
		notes.add(`enum:${what}`, `${where}: ${what} \`${value.slice(0, 40)}\` is not one of ${[...set].join(', ')}${fallback ? `; drawn as ${fallback}` : '; ignored'}.`);
		return undefined;
	};
	let kind: BoardKind = 'flow';
	if (raw.kind !== undefined) {
		kind = pick<BoardKind>(BOARD_KINDS, raw.kind, 'board', 'kind', 'flow') ?? 'flow';
	}
	const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : 'Untitled';
	if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
		throw new Error('A board needs a non-empty "nodes" array: [{ id, label, kind?, detail?, file?, line?, status? }].');
	}
	if (raw.nodes.length > MAX_NODES) {
		throw new Error(`A board shows at most ${MAX_NODES} nodes; split it into several boards.`);
	}
	const seen = new Set<string>();
	const nodes: BoardNode[] = [];
	raw.nodes.forEach((entry, index) => {
		const n = entry as Record<string, unknown>;
		if (typeof n !== 'object' || n === null) {
			notes.add('node', `node #${index + 1} was dropped: it is not an object.`);
			return;
		}
		// Agents often write `name` for the label (a class's name), so it is read as one.
		const label = typeof n.label === 'string' ? n.label : typeof n.name === 'string' ? n.name : typeof n.id === 'string' ? n.id : '';
		let id = typeof n.id === 'string' && n.id ? n.id : label;
		if (!id) {
			notes.add('node', `node #${index + 1} was dropped: it has no id or label.`);
			return;
		}
		const asked = id;
		while (seen.has(id)) {
			id += '_';
		}
		if (id !== asked) {
			notes.add('dup', `node id \`${asked}\` is used twice: the second one became \`${id}\`, and edges to \`${asked}\` go to the first.`);
		}
		seen.add(id);
		const where = `node \`${id}\``;
		const members = Array.isArray(n.members)
			// A member may come as plain text ("getBill(id: UUID): Bill"), as agents tend to write it: dropping it would draw an empty type.
			? (n.members as unknown[]).map(m => typeof m === 'string' ? { text: m } : m as Record<string, unknown>).filter(m => typeof m?.text === 'string' && m.text.trim()).slice(0, 60).map((m): BoardMember => ({
				text: String(m.text).slice(0, 200),
				kind: m.kind === 'field' || m.kind === 'method' || m.kind === 'property' ? m.kind : undefined,
				visibility: m.visibility === '+' || m.visibility === '-' || m.visibility === '#' || m.visibility === '~' ? m.visibility : undefined,
				ref: typeof m.ref === 'string' ? m.ref : undefined,
			}))
			: undefined;
		const sentMembers = Array.isArray(n.members) ? n.members.length : 0;
		if (sentMembers > (members?.length ?? 0)) {
			notes.add('members', `${where}: ${sentMembers - (members?.length ?? 0)} member(s) were dropped; write each as {"text": "name(param: Type): Return"} or {"text": "field: Type"} (at most 60 per node).`);
		}
		nodes.push({
			id,
			label: (label || id).slice(0, 120),
			kind: pick<NodeKind>(NODE_KINDS, n.kind, where, 'kind'),
			detail: typeof n.detail === 'string' ? n.detail.slice(0, 200) : undefined,
			group: typeof n.group === 'string' ? n.group : undefined,
			file: typeof n.file === 'string' ? n.file : undefined,
			line: typeof n.line === 'number' && Number.isFinite(n.line) ? Math.max(1, Math.floor(n.line)) : undefined,
			status: pick<NodeStatus>(STATUSES, n.status, where, 'status'),
			members,
			note: typeof n.note === 'string' ? n.note.slice(0, 600) : undefined,
			symbol: str(n.symbol, 200),
			tech: str(n.tech, 60),
			shape: pick<NodeShape>(SHAPES, n.shape, where, 'shape'),
			change: pick<ChangeMark>(CHANGES, n.change, where, 'change'),
			lane: str(n.lane, 64),
			zoom: boardId(n.zoom),
		});
	});
	const ids = new Set(nodes.map(n => n.id));
	const groups = Array.isArray(raw.groups)
		? (raw.groups as Record<string, unknown>[]).filter(g => typeof g?.id === 'string' && typeof g?.label === 'string').map(g => ({
			id: String(g.id),
			label: String(g.label).slice(0, 80),
			parent: typeof g.parent === 'string' ? g.parent : undefined,
			collapsed: g.collapsed === true ? true : undefined,
			kind: pick<GroupKind>(GROUP_KINDS, g.kind, `group \`${String(g.id)}\``, 'kind'),
			tech: str(g.tech, 60),
		}))
		: undefined;
	const groupIds = new Set((groups ?? []).map(g => g.id));
	for (const n of nodes) {
		if (n.group !== undefined && !groupIds.has(n.group)) {
			const near = nearestId(n.group, groupIds);
			notes.add('group', `node \`${n.id}\`: group \`${n.group}\` is not in \`groups\`${near ? ` (did you mean \`${near}\`?)` : ''}; the node is drawn outside any group.`);
			n.group = undefined;
		}
	}
	const fragments = new Set((groups ?? []).filter(g => g.kind === 'alt' || g.kind === 'loop' || g.kind === 'opt').map(g => g.id));
	const edges: BoardEdge[] = [];
	const sentEdges = Array.isArray(raw.edges) ? raw.edges as Record<string, unknown>[] : [];
	for (const e of sentEdges) {
		const label = `edge \`${typeof e?.from === 'string' ? e.from : '?'}\` → \`${typeof e?.to === 'string' ? e.to : '?'}\``;
		if (typeof e?.from !== 'string' || typeof e?.to !== 'string') {
			notes.add('edge', `${label} was dropped: \`from\` and \`to\` must be node ids.`);
			continue;
		}
		const missing = [e.from, e.to].filter(x => !ids.has(x));
		if (missing.length) {
			const near = nearestId(missing[0], ids);
			notes.add('edge', `${label} was dropped: no node \`${missing[0]}\`${near ? ` (did you mean \`${near}\`?)` : ''}.`);
			continue;
		}
		if (edges.length >= MAX_EDGES) {
			notes.add('edge', `edges past the first ${MAX_EDGES} were dropped.`);
			break;
		}
		let fragment: string | undefined;
		if (typeof e.fragment === 'string') {
			if (fragments.has(e.fragment)) {
				fragment = e.fragment;
			} else {
				notes.add('fragment', `${label}: fragment \`${e.fragment}\` is not a group of kind alt, loop or opt; the message is drawn outside any fragment.`);
			}
		}
		edges.push({
			from: e.from,
			to: e.to,
			label: typeof e.label === 'string' ? e.label.slice(0, 80) : undefined,
			kind: pick<EdgeKind>(EDGE_KINDS, e.kind, label, 'kind'),
			fromCard: typeof e.fromCard === 'string' ? e.fromCard.slice(0, 12) : undefined,
			toCard: typeof e.toCard === 'string' ? e.toCard.slice(0, 12) : undefined,
			order: typeof e.order === 'number' && Number.isFinite(e.order) ? Math.max(1, Math.min(9999, Math.floor(e.order))) : undefined,
			style: pick<EdgeLine>(LINES, e.style, label, 'style'),
			async: e.async === true ? true : undefined,
			guard: str(e.guard, 80),
			change: pick<ChangeMark>(CHANGES, e.change, label, 'change'),
			fragment,
		});
	}
	const edgeKeys = new Set(edges.map(e => `${e.from}>${e.to}`));
	const known = (id: unknown): id is string => typeof id === 'string' && (ids.has(id) || groupIds.has(id));
	let focus: string | undefined;
	if (raw.focus !== undefined) {
		if (known(raw.focus)) {
			focus = raw.focus;
		} else {
			notes.add('focus', `focus \`${String(raw.focus).slice(0, 40)}\` is not a node or group id; ignored.`);
		}
	}
	const steps: BoardStep[] = [];
	let described = false;
	let listed = false;
	for (const [i, s] of (Array.isArray(raw.steps) ? raw.steps.slice(0, MAX_STEPS) : []).entries()) {
		const x = s as Record<string, unknown>;
		const stepTitle = str(x?.title, 80);
		// Agents other than Claude (Codex) have written a step's caption as `description` and its nodes as a `focus` list.
		// Both are read, so the step still says and lights what was meant, and the note tells the agent the right names.
		const caption = str(x?.caption, 600) ?? str(x?.description, 600);
		if (!stepTitle && !caption) {
			notes.add('step', `step #${i + 1} was dropped: it needs a title or a caption.`);
			continue;
		}
		described ||= x.caption === undefined && !!caption;
		listed ||= Array.isArray(x.focus);
		const focusList = Array.isArray(x.focus) ? x.focus.filter((id): id is string => typeof id === 'string') : [];
		const stepNodes = [...new Set([...(Array.isArray(x.nodes) ? x.nodes : []).filter((id): id is string => typeof id === 'string'), ...focusList])];
		const stepEdges = (Array.isArray(x.edges) ? x.edges : []).map(pair).filter((p): p is [string, string] => !!p);
		const badNode = stepNodes.find(id => !ids.has(id));
		const badEdge = stepEdges.find(([a, b]) => !edgeKeys.has(`${a}>${b}`));
		if (badNode) {
			const near = nearestId(badNode, ids);
			notes.add('step', `step #${i + 1}: node \`${badNode}\` does not exist${near ? ` (did you mean \`${near}\`?)` : ''}; it was left out.`);
		}
		if (badEdge) {
			notes.add('step', `step #${i + 1}: there is no edge \`${badEdge[0]}\` → \`${badEdge[1]}\`; it was left out.`);
		}
		const lit = stepNodes.filter(id => ids.has(id)).slice(0, 40);
		const litEdges = stepEdges.filter(([a, b]) => edgeKeys.has(`${a}>${b}`)).slice(0, 40);
		const step: BoardStep = {
			title: stepTitle ?? `Step ${i + 1}`,
			caption: caption ?? '',
			nodes: lit,
			edges: litEdges,
			focus: known(x.focus) ? x.focus : undefined,
		};
		if (!lit.length && !litEdges.length && !step.focus) {
			notes.add('step', `step #${i + 1} lights up nothing: give it \`nodes\` (ids) or \`edges\` ([from, to]) so the user sees what it is about.`);
		}
		steps.push(step);
	}
	// Once per board, not per step: a board that used the other names in every step would otherwise crowd out the rest.
	if (described) {
		notes.add('step names', 'steps: `description` was read as the caption; call it `caption`.');
	}
	if (listed) {
		notes.add('step names', 'steps: a `focus` list was read as `nodes`, the ids to light up; `focus` is one group or node id to open.');
	}
	const highlight: BoardHighlight[] = [];
	for (const h of (Array.isArray(raw.highlight) ? raw.highlight.slice(0, MAX_HIGHLIGHTS) : []) as Record<string, unknown>[]) {
		const path = (Array.isArray(h?.path) ? h.path : []).filter((id): id is string => typeof id === 'string');
		const absent = path.find(id => !ids.has(id));
		if (path.length < 2 || absent !== undefined) {
			notes.add('highlight', `a highlight path was dropped: it needs at least two existing node ids${absent !== undefined ? ` (no node \`${absent}\`)` : ''}.`);
			continue;
		}
		highlight.push({ path: path.slice(0, 40), label: str(h.label, 60) });
	}
	const callouts: BoardCallout[] = [];
	for (const c of (Array.isArray(raw.callouts) ? raw.callouts.slice(0, MAX_CALLOUTS) : []) as Record<string, unknown>[]) {
		const text = str(c?.text, 200);
		const edge = pair(c?.edge);
		const node = typeof c?.node === 'string' ? c.node : undefined;
		if (!text || (!node && !edge)) {
			notes.add('callout', 'a callout was dropped: it needs `text` and a `node` or an `edge` [from, to].');
			continue;
		}
		if (node ? !ids.has(node) : !edgeKeys.has(`${edge![0]}>${edge![1]}`)) {
			notes.add('callout', `a callout was dropped: ${node ? `no node \`${node}\`` : `no edge \`${edge![0]}\` → \`${edge![1]}\``}.`);
			continue;
		}
		callouts.push(node ? { node, text } : { edge, text });
	}
	const legend = (Array.isArray(raw.legend) ? raw.legend.slice(0, 12) : []).map(l => l as Record<string, unknown>).filter(l => typeof l?.key === 'string' && typeof l?.text === 'string').map((l): BoardLegendEntry => ({ key: String(l.key).slice(0, 40), text: String(l.text).slice(0, 120) }));
	const spec: BoardSpec = {
		version: 1,
		kind,
		title,
		description: typeof raw.description === 'string' ? raw.description.slice(0, 600) : undefined,
		direction: raw.direction === 'TB' ? 'TB' : raw.direction === 'LR' ? 'LR' : undefined,
		nodes,
		edges,
		groups,
		level: pick<BoardLevel>(LEVELS, raw.level, 'board', 'level'),
		legend: legend.length ? legend : undefined,
		focus,
		base: boardId(raw.base),
		steps: steps.length ? steps : undefined,
		highlight: highlight.length ? highlight : undefined,
		callouts: callouts.length ? callouts : undefined,
	};
	return { spec, notes: notes.list() };
}
