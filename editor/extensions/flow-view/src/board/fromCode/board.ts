/*---------------------------------------------------------------------------------------------
 *  Insilode boards generated from code: the board shape the generators build. It is BoardSpec plus exactly the optional
 *  fields of research section 7.3 (docs/research/agent-diagrams.md): node `symbol`, `tech`, `shape`; edge `order`,
 *  `style`, `async`, `guard`; group `kind`, `tech`; board `level`, `legend`, `focus`, and the `state` kind. When
 *  board/spec.ts declares these fields, this file shrinks to re-exports and nothing else changes. Pure: no `vscode`.
 *--------------------------------------------------------------------------------------------*/

import type { BoardEdge, BoardGroup, BoardNode, BoardSpec } from '../spec';

/** The kinds board_from_code generates. */
export const FROM_CODE_KINDS = ['sequence', 'er', 'architecture', 'state'] as const;
export type FromCodeKind = (typeof FROM_CODE_KINDS)[number];

export type GenKind = BoardSpec['kind'] | 'state';

export interface GenNode extends BoardNode {
	/** The code symbol the node stands for, as the index names it: `OrderService`, `OrderService.place`, `Status.PAID`. */
	symbol?: string;
	/** C4: the technology under the label. */
	tech?: string;
	shape?: 'rect' | 'round' | 'diamond' | 'cylinder' | 'actor' | 'cloud' | 'initial' | 'final';
}

export interface GenEdge extends BoardEdge {
	/** Order of a message in a sequence, from 1. */
	order?: number;
	/** dotted: a guess (the index linked it by name, an HTTP route or a topic); dashed: a return or an async call. */
	style?: 'solid' | 'dashed' | 'dotted';
	async?: boolean;
	/** A state transition's condition. */
	guard?: string;
}

export interface GenGroup extends BoardGroup {
	kind?: 'boundary' | 'lane' | 'layer';
	tech?: string;
}

export interface GenBoard {
	version: 1;
	kind: GenKind;
	title: string;
	description?: string;
	direction?: 'LR' | 'TB';
	/** Architecture boards only. */
	level?: 'context' | 'container' | 'component';
	legend?: { key: string; text: string }[];
	/** The node or group opened first. */
	focus?: string;
	nodes: GenNode[];
	edges: GenEdge[];
	groups?: GenGroup[];
}

/** What a generator answers: a board, or why there is none; `notes` are what the agent should know about the result (cuts, guesses, gaps). */
export interface Generated {
	board?: GenBoard;
	/** Set when the code does not make the diagram clear: no board was built. */
	skipped?: string;
	notes: string[];
}

/** Longest list a board or a note shows before it says "and N more". */
export const MAX_LIST = 12;

export const skip = (reason: string, notes: string[] = []): Generated => ({ skipped: reason, notes });

/** The legend entry every generator adds when it drew an edge as a guess. */
export const GUESS_LEGEND = { key: 'guess', text: 'dotted and marked "?": a guess (linked by name, an HTTP route or a topic), not read from the code' };

/** Strips a directory prefix so the id and the notes stay short. */
export const baseName = (file: string) => file.replace(/\\/g, '/').split('/').pop() ?? file;
