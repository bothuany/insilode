/*---------------------------------------------------------------------------------------------
 *  Insilode: hands-on tour steps (`steps[].wait`). The tool's `wait` is checked into a TourWait, a `command` only when it is on the
 *  allowlist below, and the canvas's `tourRun` message is answered here: the command to run is read from the host's own copy of the
 *  tour, never from the message, and checked against the allowlist again before it runs. Pure: no `vscode` (the caller passes the
 *  function that runs a command).
 *--------------------------------------------------------------------------------------------*/

import type { CanvasToHostTour, TourStep, TourWait } from '../../../../../protocol/flow';

/** The commands a tour step may run for the reader: explicit, in this one place. Contract stub: the hands-on part fills it in and tests it. */
export const WAIT_COMMANDS: readonly string[] = [];

export interface WaitContext {
	/** "steps[2]": names the step in an error. */
	where: string;
	/** A tool call rather than a tour file: a `command` wait is only taken from a tool call. */
	strict: boolean;
}

/** `wait` as the tool sends it. `note`: why a wait was refused and dropped (a command that is not allowed); it joins the step's line in the answer. Contract stub. */
export function parseWait(_raw: unknown, _ctx: WaitContext): { wait?: TourWait; note?: string } {
	return {};
}

/** The step index a `tourRun` message asks for, when it is about the playing tour and names a step inside it that waits for a command. Contract stub. */
export function parseTourRun(_playing: { id: string; tour: { steps: TourStep[] } } | undefined, _m: Extract<CanvasToHostTour, { type: 'tourRun' }>): number | undefined {
	return undefined;
}

/** Runs the command of a step's wait through `execute` if it is allowed; says why when it is not or when it failed. Contract stub. */
export async function runWait(_step: TourStep | undefined, _execute: (command: string) => PromiseLike<unknown>): Promise<{ ok: boolean; reason?: string }> {
	return { ok: false, reason: 'Hands-on command steps are not available yet.' };
}
