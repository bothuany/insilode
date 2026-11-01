// The shapes the flow-view extension host sends to the canvas webview, declared once. Both sides import this file
// type-only (`import type` / `export type`), so it is erased from both bundles: it must stay types only and import
// nothing (checked by `npm run arch`).

export type Kind = 'controller' | 'handler' | 'method' | 'db' | 'ambiguous' | 'external';
export type EdgeKind = 'call' | 'mediator' | 'impl' | 'db' | 'http' | 'message';

export interface FlowNode {
	key: string;
	symbolId: string | null;
	label: string;
	sub: string;
	kind: Kind;
	file: string | null;
	startLine: number;
	endLine: number;
	code: string | null;
	children: FlowEdge[];
	/**
	 * Change inside this method (current-file line numbers), when Insilode is tracking one. `source` 'git' when only the
	 * Git-changes view tracks the file (a change by anyone), else an agent made it. `base`: what a Git change is measured
	 * against when that is not HEAD ("main", "the last commit"): committed work, which a card must not offer to undo.
	 */
	diff?: { added: number[]; removed: { after: number; lines: string[] }[]; plus: number; minus: number; source?: 'git'; base?: string };
	/** Database cards: the table a query touches, read from the entity and its ORM configuration. */
	schema?: DbSchema;
	/** Calls the static index could not resolve: the host asks the language server, then drops this field. */
	pending?: { line: number; name: string }[];
	/**
	 * Database cards in a change set: the entity behind this table was edited (`entity`, also its ORM configuration) or a migration
	 * alters the table (`migration`), so every endpoint that reaches the card may behave differently. `guess`: the table name is
	 * not written in the code. A migration says what it `added` and `dropped` and sums it up in `summary` ("adds key, drops legacy_ref").
	 */
	tableChange?: { entity?: string; table: string; guess?: boolean; migration?: { name: string; summary: string; added: string[]; dropped: string[] }[] };
	/** Calls below this card that were not drawn because the flow reached its size limit: the card says so, so a cut flow never looks whole. */
	truncated?: number;
}

/** One entry point or caller a method's change reaches, for the impact chip: a row the reader can open. */
export interface ImpactItem {
	label: string;
	file: string | null;
	line: number;
	kind?: string;
}

/** What changing a method affects. `truncated`: entries left out because the walk reached its limit (the chip says "at least"). */
export interface ImpactResult {
	label: string;
	items: ImpactItem[];
	truncated?: number;
}

export interface FlowEdge {
	callLine: number;
	edgeKind: EdgeKind;
	/**
	 * The link was made by name alone (the polyglot index found no declared type to follow), or by an HTTP route or message
	 * destination it matched. On a `db` edge: the table is a guess (a naming default or a raw SQL string, not ORM metadata).
	 */
	guess?: boolean;
	node: FlowNode;
}

export interface EntryPoint {
	id: string;
	controller: string;
	action: string;
	http: string;
	file: string;
	line: number;
}

export interface DbColumn {
	name: string;
	column: string;
	type: string;
	key: boolean;
	nullable: boolean;
	maxLength: number | null;
}

export interface DbSchema {
	entity: string;
	table: string;
	dbSchemaName: string | null;
	context: string;
	columns: DbColumn[];
	relations: string[];
	/** Query operators in the order they run: AsNoTracking, Where, Select, FirstOrDefaultAsync… */
	ops: string[];
	writes: boolean;
	file: string | null;
	line: number;
}

// ---- Guided tours and the agent's gaze (docs/design/guided-tours.md, section 2) ---------------------------------------
// The canvas plays a Tour step by step; the host sends it whole, with every step already resolved to current-file lines.
// Nothing here names a card: card keys are positional and change on every draw, so the canvas maps file+line to a card itself.

/** One resolved step, as the canvas receives it: current-file lines, never a card key. */
export interface TourStep {
	title: string;
	/** Plain text. `code` in backticks is shown as code; nothing else is formatted. */
	caption: string;
	/** Absent for an intro/outro step: the cursor stays put and the caption is centred. */
	at?: { file: string; startLine: number; endLine: number; label: string; table?: string };
	highlights?: [number, number][];
	state: 'ok' | 'moved' | 'missing' | 'offflow';
	/** The method changed since a saved tour was made. */
	drift?: boolean;
	/** The method's code, for a peek card when no drawn card holds it. */
	peek?: { code: string; startLine: number };
	notes?: TourNote[];
	/** Pen marks drawn on this step's card as the caption is read: each appears with its caption sentence. */
	marks?: TourMark[];
	/** A hands-on step: the tour does not go on by itself or by Next until the user has done this. */
	wait?: TourWait;
}

/**
 * One pen mark on a step. Lines are current-file 1-based, resolved by the host like `highlights`. `sentence` is the
 * 1-based caption sentence it appears with (default 1). ring, underline and strike mark lines of the step's card;
 * check and cross sit beside a line; badge puts the order number `n` beside a line; connect draws a curved arrow from
 * the step's card to another card (`to`, resolved like a step's `at`), labelled with `label`.
 */
export interface TourMark {
	kind: 'ring' | 'underline' | 'strike' | 'check' | 'cross' | 'badge' | 'connect';
	lines?: [number, number];
	n?: number;
	to?: { file: string; startLine: number; endLine: number; label: string };
	label?: string;
	sentence?: number;
}

/**
 * What a hands-on step waits for. click: the user clicks the step's card. command: the user presses the step's button,
 * which asks the host to run `command` (the host runs only commands on its own allowlist and reads the id from its
 * copy of the tour, never from the canvas message). continue: the user presses Continue after doing the work by hand.
 * `prompt` is the button or hint text.
 */
export type TourWait =
	| { kind: 'click'; prompt?: string }
	| { kind: 'command'; command: string; prompt: string }
	| { kind: 'continue'; prompt?: string };

export interface TourNote {
	question?: string;
	text: string;
	by: 'agent' | 'user';
	at: number;
}

export interface Tour {
	id: string;
	title: string;
	/** Who made it, shown in the toolbar: "Claude Code (terminal)", "Saved tour", "Review changes". */
	origin: string;
	source: 'agent' | 'file' | 'review' | 'gaze';
	steps: TourStep[];
	/** The step to open on, 0-based. */
	start: number;
	/** The agent that made it, when known: the ghost cursor takes its colour and name. A plain pointer otherwise. */
	agent?: { label: string; color: string };
	/** Up to three follow-up questions shown as chips after the last step; tapping one asks it like a question. */
	followUps?: string[];
}

/** One thing an agent looked at or changed, for the gaze. A file and lines only: never content or search text. */
export interface GazeEvent {
	session: string;
	/** The dock's colour and name for that agent. */
	agent: { label: string; color: string };
	act: 'read' | 'edit' | 'search';
	file: string;
	startLine?: number;
	endLine?: number;
	at: number;
}

export type HostToCanvasTour =
	| { type: 'tour'; tour: Tour }
	| { type: 'tourStep'; id: string; index: number; step?: TourStep } // the agent moved it, or a lazily resolved step arrived
	| { type: 'tourNote'; id: string; index: number; note: TourNote }
	| { type: 'tourEnd'; id: string; reason: 'agent' | 'replaced' }
	/** The agent answered the reader's question and the tour goes on (the reader may also press play). */
	| { type: 'tourResume'; id: string }
	/** The agent edited the tour while the reader was paused (tour_control edit): the whole new step list; the reader stays on `index`. */
	| { type: 'tourSteps'; id: string; steps: TourStep[]; index: number }
	/** The command a hands-on step waited for has run (ok) or was refused or failed (ok false, with why). */
	| { type: 'tourWaitDone'; id: string; index: number; ok: boolean; reason?: string }
	| { type: 'gaze'; events: GazeEvent[] }
	| { type: 'gazeClear'; session?: string };

export type CanvasToHostTour =
	| { type: 'tourState'; id: string; index: number; paused: boolean } // the host keeps this for tour_control's answer
	| { type: 'tourAsk'; id: string; index: number; question: string }
	| { type: 'tourSave'; id: string }
	| { type: 'tourExit'; id: string }
	/** The reader pressed a command step's button: the host runs that step's own `wait.command` if it is allowed, then answers tourWaitDone. */
	| { type: 'tourRun'; id: string; index: number }
	| { type: 'pointAsk'; kind?: 'ask' | 'explain' | 'edit'; file: string; startLine: number; endLine: number; label: string; question: string }
	| { type: 'gazeReplay'; session: string };
