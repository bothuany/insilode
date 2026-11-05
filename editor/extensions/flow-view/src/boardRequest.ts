/*---------------------------------------------------------------------------------------------
 *  Insilode board webview: what the canvas may ask of the host, cleaned, and how its options map onto the type
 *  boards' own options (src/types/boards.ts). The webview is not trusted (its page shows text from the code
 *  base), so every message is checked here. Pure: no `vscode`, unit-tested directly.
 *--------------------------------------------------------------------------------------------*/

import type { BoardSpec } from './board/spec';
import type { ArchitectureBoardOptions, DtoBoardOptions } from './types/boards';
import type { TypeRole } from './types/model';

/** What the board's toolbar controls: mirrors ui/src/board/protocol.ts BoardOpts. Roles are the canvas's node kinds. */
export interface BoardRequest {
	query?: string;
	focusId?: string;
	depth?: number;
	includeEntities?: boolean;
	includeEnums?: boolean;
	hideRoles?: string[];
	collapseLevel?: number;
}

export type ExportFormat = 'mermaid' | 'plantuml' | 'png' | 'svg' | 'json';

const FORMATS = new Set<string>(['mermaid', 'plantuml', 'png', 'svg', 'json']);
const NODE_KINDS = new Set<string>(['entry', 'controller', 'service', 'repository', 'entity', 'dto', 'enum', 'interface', 'class']);

const clampInt = (v: unknown, min: number, max: number): number | undefined =>
	typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : undefined;

/** Options from the webview, cleaned: unknown keys dropped, strings capped, numbers clamped. */
export function sanitizeRequest(raw: unknown): BoardRequest {
	const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
	const out: BoardRequest = {};
	if (typeof r.query === 'string' && r.query.trim()) {
		out.query = r.query.trim().slice(0, 200);
	}
	if (typeof r.focusId === 'string' && r.focusId.trim()) {
		out.focusId = r.focusId.trim().slice(0, 400);
	}
	const depth = clampInt(r.depth, 1, 3);
	if (depth !== undefined) {
		out.depth = depth;
	}
	if (typeof r.includeEntities === 'boolean') {
		out.includeEntities = r.includeEntities;
	}
	if (typeof r.includeEnums === 'boolean') {
		out.includeEnums = r.includeEnums;
	}
	if (Array.isArray(r.hideRoles)) {
		const roles = [...new Set(r.hideRoles.filter((x): x is string => typeof x === 'string' && NODE_KINDS.has(x)))];
		if (roles.length) {
			out.hideRoles = roles;
		}
	}
	const level = clampInt(r.collapseLevel, 0, 9);
	if (level !== undefined) {
		out.collapseLevel = level;
	}
	return out;
}

export const exportFormat = (v: unknown): ExportFormat | undefined => (typeof v === 'string' && FORMATS.has(v) ? (v as ExportFormat) : undefined);

/** Canvas node kind → the type roles it stands for (the architecture board draws handlers as services). */
const ROLES_OF: Record<string, TypeRole[]> = {
	controller: ['controller'],
	entry: ['handler'],
	service: ['service', 'handler'],
	repository: ['repository'],
	entity: ['entity'],
	dto: ['dto'],
	enum: ['enum'],
	interface: ['interface'],
	class: ['class'],
};

/** The DTO diagram: entities and enums have their own switches, the rest of the options pass through. */
export function dtoOptions(r: BoardRequest, defaults: { includeEntities?: boolean } = {}): DtoBoardOptions {
	return {
		query: r.query,
		focusId: r.focusId,
		depth: r.depth,
		includeEntities: r.includeEntities ?? defaults.includeEntities,
		includeEnums: r.includeEnums,
	};
}

/** The DTO board has no role filter of its own: the cards of the hidden kinds (and their edges) are taken out of the finished board. */
export function dropKinds(spec: BoardSpec, kinds: readonly string[] | undefined): BoardSpec {
	if (!kinds?.length) {
		return spec;
	}
	const nodes = spec.nodes.filter(n => !kinds.includes(n.kind ?? 'class'));
	if (nodes.length === spec.nodes.length) {
		return spec;
	}
	const ids = new Set(nodes.map(n => n.id));
	const used = new Set(nodes.map(n => n.group));
	return {
		...spec,
		nodes,
		edges: spec.edges.filter(e => ids.has(e.from) && ids.has(e.to)),
		groups: spec.groups?.filter(g => used.has(g.id) || spec.groups!.some(c => c.parent === g.id)),
		description: [spec.description, `Hidden: ${kinds.join(', ')}.`].filter(Boolean).join(' '),
	};
}

/**
 * The architecture diagram hides roles. Entities and enums have toolbar switches of their own: they hide those roles when off.
 * (The search is the canvas's own highlight there: the architecture board has no query.)
 */
export function archOptions(r: BoardRequest): ArchitectureBoardOptions {
	const hide = new Set<TypeRole>();
	for (const k of r.hideRoles ?? []) {
		(ROLES_OF[k] ?? []).forEach(role => hide.add(role));
	}
	if (r.includeEntities === false) {
		hide.add('entity');
	}
	if (r.includeEnums !== true) {
		hide.add('enum');
	}
	const level = r.collapseLevel;
	return {
		focusId: r.focusId,
		depth: r.depth,
		hideRoles: [...hide],
		collapse: level === undefined ? undefined : level <= 0 ? 'module' : level === 1 ? 'role' : 'none',
	};
}

/** What the architecture toolbar shows before anything is changed: the board hides DTOs and enums by default. */
export const ARCHITECTURE_DEFAULTS: BoardRequest = { includeEntities: true, includeEnums: false, hideRoles: ['dto'] };

/** A save-dialog file name that is safe on every OS. */
export function fileStem(name: unknown, fallback: string): string {
	const s = typeof name === 'string' ? name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) : '';
	return s || fallback;
}

/** `data` of an svg/png export, or undefined when it is not what the format says (the webview is not trusted). */
export function exportPayload(format: 'svg' | 'png', data: unknown): string | Buffer | undefined {
	if (typeof data !== 'string' || data.length > 60_000_000) {
		return undefined;
	}
	if (format === 'svg') {
		return /^<svg[\s>]/.test(data) ? data : undefined;
	}
	return /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? Buffer.from(data, 'base64') : undefined;
}

/** The type a file is named for (`OrderDto.java` is `OrderDto`): what the explorer's "Show Type in DTO Diagram" looks up; undefined when the name is no identifier. */
export function fileTypeName(file: string): string | undefined {
	const base = file.replace(/\\/g, '/').split('/').pop() ?? '';
	const stem = base.replace(/\.[^.]*$/, '').replace(/\.(d|test|spec)$/i, '');
	return /^[A-Za-z_$][\w$]*$/.test(stem) ? stem : undefined;
}

/**
 * Whether an open board's tab is brought to the front. A board that is drawn again (an agent's update_board, a redraw, the type
 * graph changing) must not pull itself in front of what the user is reading; only a request to show it (the Show Board command,
 * a zoom click, a type diagram command) does. A tab that does not exist yet is opened by the caller and needs no reveal.
 */
export function revealsExistingTab(existing: boolean, reveal: boolean | undefined): boolean {
	return existing && reveal === true;
}

/** The settings the canvas may ask to have opened (an empty state's "Edit DTO suffixes"): a fixed set, never an id taken from the message. */
export const OPENABLE_SETTINGS: ReadonlySet<string> = new Set(['flow.types.dtoSuffixes']);

/** What a `{ type: 'settings' }` message asks for, when the setting is one the host may open. */
export function openableSetting(raw: unknown): string | undefined {
	return typeof raw === 'string' && OPENABLE_SETTINGS.has(raw) ? raw : undefined;
}
