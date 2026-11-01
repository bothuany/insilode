/*---------------------------------------------------------------------------------------------
 *  Insilode skeleton first: where each agent session is in the flow (design → skeleton → handover) and what `check_skeleton` answers at
 *  each stage. The developer drives the flow by talking to the agent, so every answer also says what to tell them next and which step
 *  their reply maps to. Kept in the window's memory; persist.ts writes the stage of each session to the workspace state so a reload keeps it. Pure: no vscode.
 *--------------------------------------------------------------------------------------------*/

import type { BoardSpec } from '../board/spec';
import type { Header, Warning } from './guard';
import { warningText } from './guard';
import { designSummary, designText, diffText, type Baseline, type DesignSummary, type SkeletonDiff } from './match';

export type Stage = 'design' | 'skeleton' | 'handover';

/** What the developer's reply in the chat asks for, as the agent passes it to `check_skeleton`. */
export const SKELETON_STEPS = ['handover', 'just', 'finish', 'accept'] as const;
export type SkeletonStep = typeof SKELETON_STEPS[number];

/** What the MCP tools need of skeleton first: the answer of `check_skeleton` (moving the stage when the developer asked), and a board an agent drew. */
export interface SkeletonTools {
	check(session: string | undefined, step?: SkeletonStep, warning?: number): Promise<string>;
	/** What the agent should know of the design it drew (new and existing types, types with no members), when it is a skeleton design. */
	drawn(id: string, spec: BoardSpec, session: string | undefined): Promise<string | undefined>;
	/** Whether a board id is another agent session's design, so no other session's draw_board replaces it. */
	claimed(id: string, session: string | undefined): boolean;
}

export interface SkeletonSession {
	/** The Insilode agent session (INSILODE_SESSION); '' for an agent Insilode did not start. */
	session: string;
	stage: Stage;
	/** The board the design is drawn on. */
	boardId: string;
	/** The design as the agent drew it (never the coloured copy). */
	plan?: BoardSpec;
	/** Files the developer saved since the design was drawn: a name two types share goes to the one in such a file. */
	recent: Set<string>;
	diff?: SkeletonDiff;
	/** The code when the design was first drawn (taken once the index is complete): what existed then is neutral on the board. */
	baseline?: Baseline;
	/** The developer's declarations, kept at the hand-over. */
	headers: Header[];
	warnings: Warning[];
	/** Warnings the agent marked as kept (step accept): they stay on the board as kept, so a keep is never silent. */
	accepted: Warning[];
	/** A design was turned down once for types without members: the next one is taken either way, so the agent is never stuck. */
	turnedDown?: boolean;
}

/** The board id a session's design goes on: letters and digits of the session only, so it is a valid board id. */
export const boardIdFor = (session: string) => session ? `skeleton-${session.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}` : 'skeleton';

export const newSession = (session: string): SkeletonSession => ({ session, stage: 'design', boardId: boardIdFor(session), recent: new Set(), headers: [], warnings: [], accepted: [] });

/** The members are what the developer writes from, so every answer asks for them with an example of the exact form. */
const SIGNATURES = 'and on EVERY type you add or change the members the developer is to write, as signatures: for a new type all its fields and methods, for an existing type only the members this change adds to it. Each member is an object: "members": [{"text": "findByStatus(status: BillStatus): List<Bill>"}, {"text": "amount: BigDecimal"}]';

/** The developer reads from the agent which types are new and which existing types get what, so a "matches" never looks like the agent wrote it. */
const TELL = 'tell the developer which types are new, the file path each new type goes in (draw_board lists them), and which existing types get which new members';

/** What draw_board adds to its answer for a skeleton design: what the design asks of the developer, or why it must be redrawn. */
/** `taken`: the board is the design even so (a redraw, or a second try with the same empty types). */
export function drawnAnswer(summary: DesignSummary | undefined, boardId: string, taken = false, rel: (file: string) => string = f => f): string {
	if (!summary) {
		return `Skeleton first: this is the design (board "${boardId}"). The code index is still loading, so the board colours it in a moment. Now STOP and ${TELL}, as you planned them.`;
	}
	if (summary.empty.length) {
		return [
			`Skeleton first: ${taken ? 'the board shows this design, but these' : 'NOT taken as the design yet. These'} new types have no members, so the developer has nothing to write from: ${summary.empty.join(', ')}.`,
			`Redraw now with draw_board and the same id "${boardId}", ${SIGNATURES}.`,
		].join('\n');
	}
	return [
		`Skeleton first: this is the design (board "${boardId}"). On the board, types that already exist stay neutral and only the members this change adds are marked; everything new is missing until the developer writes it.`,
		designText(summary, rel),
		`Now STOP: do not create or edit any file. In your reply ${TELL} (as listed above), then that they write them with empty bodies and say "check", "hand over" or "just do it".`,
	].filter(Boolean).join('\n');
}

/** How the developer's replies map to steps; said once the design is drawn, so the agent can drive the rest from the chat. */
const REPLIES = 'Map the developer\'s replies to check_skeleton steps: "hand over" / "fill it in" → step "handover"; "just do it" / "skip" → step "just"; "done" / "finish" → step "finish". "check" or a question → check_skeleton with no step.';

/** The new types of a design that have no members, as one list (none: nothing). */
const emptyTypes = (diff: SkeletonDiff | undefined): string[] => {
	const empty = diff ? designSummary(diff).empty : [];
	return empty.length ? [empty.join(', ')] : [];
};

/** What `check_skeleton` answers. `enabled` is this agent's switch; `s` is its stage, when it has one. */
export function toolAnswer(enabled: boolean, s: SkeletonSession | undefined, rel: (file: string) => string = f => f): string {
	if (!enabled) {
		return 'Skeleton first is off for you in Insilode: implement the plan as usual. Do not call check_skeleton again for this plan.';
	}
	if (!s || (s.stage === 'design' && !s.plan)) {
		const id = s?.boardId ?? 'skeleton';
		return [
			'Skeleton first is ON in Insilode: the developer writes the skeleton of this change (types, entities, interfaces, signatures, empty bodies) themselves, and you fill the bodies later.',
			'1. If the request or plan does NOT add or change types, entities or interfaces (a bug fix, a rename, a small edit), ignore this and do it as usual.',
			`2. Otherwise draw your target design now with draw_board: id "${id}", kind "class" (or "er" for tables), one node per type with kind interface / class / service / repository / entity / dto / enum and a "label" (its name), ${SIGNATURES}. Add edges for extends / implements / has / has-many / uses. Only the types this change adds or changes, and the ones they connect to.`,
			`3. Then STOP: do not create or edit any file. draw_board answers which types are new and which existing types get which members; in a few short lines ${TELL}, that the design is on the board in Insilode and they can ask you to change it, that they now write those types and signatures with empty bodies (the board colours them as they save), and that they say "check" for a review, "hand over" when you should fill the bodies, or "just do it" to have you write it all.`,
			`4. If they ask for a change ("make X an interface", "remove the repository"), redraw with draw_board and the same id "${id}", then stop again.`,
		].join('\n');
	}
	const title = s.plan?.title ?? 'the design';
	switch (s.stage) {
		case 'design':
		case 'skeleton':
			return [
				s.diff ? diffText(s.diff, title, rel) : 'The code index has not been read yet: try again in a few seconds.',
				...emptyTypes(s.diff).map(names => `The design has new types without members (${names}): redraw it with draw_board and the same id "${s.boardId}", ${SIGNATURES}.`),
				'',
				`The developer is writing this skeleton themselves (the design is board "${s.boardId}"). If they asked you to check it, explain each MISSING or DIFFERS line: what the plan intended and why, as a trade-off, not a verdict. Do NOT create or edit any file and do not write the code for them. If their message is another task (a fix, a question), do that as usual.`,
				`If they reply that theirs is better, argue your case with reasons, or, if they are right, redraw the plan with draw_board and the same id "${s.boardId}" so the board follows their design.`,
				REPLIES,
			].join('\n');
		case 'handover':
			return [
				s.diff ? diffText(s.diff, title, rel) : '',
				s.warnings.length ? `\nSignatures that changed after the hand-over:\n${s.warnings.map(w => `- warning ${w.id}: ${warningText(w)}`).join('\n')}` : '',
				'',
				'The developer handed the skeleton over: fill in the method bodies. Keep every type, signature, name and relation they wrote.',
				'When you have filled them, call check_skeleton once more. For every warning it lists, tell the developer in your reply what changed and why, before → after, and ask whether to keep it. If they say keep it, call check_skeleton with step "accept" and that warning number. If they say revert, put their declaration back exactly as it was before (the text before the arrow), keeping the body; they can also run "Insilode: Revert an Agent\'s Change to Your Declaration" themselves.',
				'Then play a closing tour with the tour tool, flow {"changes": true}: one step per method you filled, and a last caption-only step on what you did not test. When the developer says they are done, call check_skeleton with step "finish".',
			].filter(Boolean).join('\n');
	}
}
