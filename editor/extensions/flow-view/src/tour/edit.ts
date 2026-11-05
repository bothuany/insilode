// Editing a tour while it plays (tour_control edit): where the new steps go and where the reader ends up. Pure, so the
// rules run under plain Node without the editor. The reader never loses their place: steps that are not replaced keep
// their objects (and so their notes), and the index moves with the steps that came before it.
import type { TourStep } from '../../../../../protocol/flow';
import { MAX_STEPS } from './validate';

export interface EditPlan {
	steps: TourStep[];
	/** 0-based: where the reader is after the edit. */
	index: number;
	/** 0-based: the first new step, for the answer to the agent. */
	first: number;
	/** Where a step that was at 0-based `i` before the edit is after it (a question asked on a step has to follow it). */
	map: (i: number) => number;
	error?: string;
}

export function planEdit(args: { steps: TourStep[]; index: number | undefined; replace?: number; insert?: number; add: TourStep[] }): EditPlan {
	const { steps, add } = args;
	const reader = args.index ?? 0;
	const fail = (error: string): EditPlan => ({ steps, index: reader, first: 0, map: i => i, error });
	if ((args.replace === undefined) === (args.insert === undefined)) {
		return fail('Give either `replace` or `insert`, not both and not neither.');
	}
	if (args.replace !== undefined) {
		const r = args.replace;
		if (!Number.isInteger(r) || r < 1 || r > steps.length) {
			return fail(`\`replace\` must be between 1 and ${steps.length}.`);
		}
		const total = steps.length - 1 + add.length;
		if (total > MAX_STEPS) {
			return fail(`A tour has at most ${MAX_STEPS} steps; this edit would make ${total}.`);
		}
		// The reader on the replaced step stays on the same index, which is now the first new step.
		const map = (i: number) => (i > r - 1 ? i + add.length - 1 : i);
		return { steps: [...steps.slice(0, r - 1), ...add, ...steps.slice(r)], index: map(reader), first: r - 1, map };
	}
	const p = args.insert!;
	if (!Number.isInteger(p) || p < 1 || p > steps.length + 1) {
		return fail(`\`insert\` must be between 1 and ${steps.length + 1}.`);
	}
	const total = steps.length + add.length;
	if (total > MAX_STEPS) {
		return fail(`A tour has at most ${MAX_STEPS} steps; this edit would make ${total}.`);
	}
	const map = (i: number) => (i >= p - 1 ? i + add.length : i);
	return { steps: [...steps.slice(0, p - 1), ...add, ...steps.slice(p - 1)], index: map(reader), first: p - 1, map };
}
