/*---------------------------------------------------------------------------------------------
 *  Insilode boards generated from code (research roadmap #5, docs/research/agent-diagrams.md): the common diagrams an agent used to
 *  draw by hand and get wrong are built from the index instead. The agent chooses a scope and a kind and may add titles and
 *  notes; every node and every relation comes from the code. This file names the kinds and checks that a scope fits its kind;
 *  the generators are one file each. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import { FROM_CODE_KINDS, type FromCodeKind } from './board';

// Declared in board.ts, so the files that only need the kinds do not import this one back.
export { FROM_CODE_KINDS, type FromCodeKind };

/** The scope keys each kind takes. */
export const SCOPE_KEYS: Record<FromCodeKind, readonly string[]> = {
	sequence: ['id', 'file', 'method', 'line', 'symbol'],
	er: ['tables'],
	architecture: ['module'],
	state: ['enum'],
};

const WHAT: Record<FromCodeKind, string> = {
	sequence: 'an endpoint or method: scope.id (from find_entry_points), or scope.file with scope.method or scope.line, or scope.symbol ("OrderService.place")',
	er: 'a set of tables: scope.tables (table or entity names; omit for all tables, capped)',
	architecture: 'modules or packages: scope.module (a module or package name; omit for the whole workspace)',
	state: 'an enum: scope.enum ("OrderStatus" or "Order.status"; omit to let Insilode look for the one with clear transitions)',
};

export interface CheckedScope {
	kind: FromCodeKind;
	scope: Record<string, unknown>;
}

/** Throws a message an agent can act on when the kind is unknown or the scope does not fit it. */
export function checkScope(kind: unknown, scope: unknown): CheckedScope {
	if (typeof kind !== 'string' || !(FROM_CODE_KINDS as readonly string[]).includes(kind)) {
		throw new Error(`\`kind\` must be one of: ${FROM_CODE_KINDS.join(', ')}. (flow, plan and class boards are not generated: draw them with draw_board.)`);
	}
	const k = kind as FromCodeKind;
	const s = scope === undefined || scope === null ? {} : scope;
	if (typeof s !== 'object' || Array.isArray(s)) {
		throw new Error('`scope` must be an object, e.g. {"tables": ["orders"]}.');
	}
	const given = Object.entries(s as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([key]) => key);
	const wrong = given.filter(key => !SCOPE_KEYS[k].includes(key));
	if (wrong.length) {
		const fits = (Object.keys(SCOPE_KEYS) as FromCodeKind[]).filter(o => wrong.every(w => SCOPE_KEYS[o].includes(w)));
		throw new Error(`kind "${k}" takes ${WHAT[k]}; scope.${wrong.join(', scope.')} ${wrong.length > 1 ? 'do' : 'does'} not fit it${fits.length ? ` (it fits kind ${fits.map(f => `"${f}"`).join(' or ')})` : ''}.`);
	}
	if (k === 'sequence' && !given.length) {
		throw new Error(`kind "sequence" needs a scope: ${WHAT.sequence}.`);
	}
	return { kind: k, scope: s as Record<string, unknown> };
}

/** A scope value that must be a list of short strings. */
export function strings(v: unknown, what: string, max = 40): string[] {
	if (v === undefined) {
		return [];
	}
	const list = typeof v === 'string' ? [v] : v;
	if (!Array.isArray(list) || list.some(x => typeof x !== 'string')) {
		throw new Error(`${what} must be a list of strings.`);
	}
	return (list as string[]).map(x => x.trim().slice(0, 120)).filter(Boolean).slice(0, max);
}

export { sequenceFromFlow } from './sequence';
export { erFromTables } from './er';
export { architectureFromGraph } from './architecture';
export { stateFromEnum } from './state';
export { annotate } from './annotate';
export { partialIndexNotes, type PartialIndexInput } from './notes';
export { boardFromCodeMessage, kindChoices, scopeChoices, MAX_CHOICES, type KindChoice, type ScopeChoice, type ScopeSource } from './choices';
export type { GenBoard, GenEdge, GenGroup, GenNode, Generated } from './board';
