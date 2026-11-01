/*---------------------------------------------------------------------------------------------
 *  Insilode: hands-on tour steps (`steps[].wait`). The tool's `wait` is checked into a TourWait, a `command` only when it is on the
 *  allowlist below, and the canvas's `tourRun` message is answered here: the command to run is read from the host's own copy of the
 *  tour, never from the message, and checked against the allowlist again before it runs. Pure: no `vscode` (the caller passes the
 *  function that runs a command).
 *--------------------------------------------------------------------------------------------*/

import type { CanvasToHostTour, TourStep, TourWait } from '../../../../../protocol/flow';

/**
 * The commands a tour step may run for the reader: explicit, in this one place. Every id is registered by an extension of this
 * repository (test/tour-wait.test.mjs checks that), takes no argument and only opens a view the reader then looks at: nothing
 * here writes a file, starts a process, changes a setting or sends a prompt. A command that asks the reader to choose
 * (a quick pick) is left out on purpose: it would not answer until they chose, and the step would report a timeout.
 */
export const WAIT_COMMANDS: readonly string[] = [
	// Insilode's own pages.
	'flow.home',
	'flow.settings',
	// The harness flow diagram of the agent configuration.
	'flow.showHarnessFlow',
	// The type diagrams.
	'flow.types.showArchitecture',
	'flow.types.showDtoDiagram',
];

export const MAX_WAIT_PROMPT = 80;
export const MAX_WAIT_COMMAND = 100;
/** How long a command may take before the step says it did not answer. */
export const WAIT_TIMEOUT_MS = 10_000;
const TIMED_OUT = Symbol('timed out');

/** A `wait` the tool call got wrong: a plain Error (validate.ts's TourFileError cannot be imported here without a cycle), whose message reaches the agent as the tool error. */
export class WaitError extends Error {
	override name = 'WaitError';
}

export interface WaitContext {
	/** "steps[2]": names the step in an error. */
	where: string;
	/** A tool call rather than a tour file: a `command` wait is only taken from a tool call. */
	strict: boolean;
}

const KINDS: readonly string[] = ['click', 'command', 'continue'];
const KEYS: readonly string[] = ['kind', 'prompt', 'command'];
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/g;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Plain text: control characters become spaces, runs of spaces one. */
const plain = (v: unknown) => typeof v === 'string' ? v.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim() : '';

/**
 * `wait` as the tool sends it. A tool call that gets it wrong throws a WaitError naming the field; a tour file just loses the wait.
 * `note`: why a wait was refused and dropped (a command that is not allowed); it joins the step's line in the answer.
 */
export function parseWait(raw: unknown, ctx: WaitContext): { wait?: TourWait; note?: string } {
	const { where, strict } = ctx;
	const at = `${where}.wait`;
	const fail = (message: string) => {
		if (strict) {
			throw new WaitError(message);
		}
		return {};
	};
	if (!isObject(raw)) {
		return fail(`${at} must be an object with a kind: click, command or continue.`);
	}
	const kind = typeof raw.kind === 'string' ? raw.kind : '';
	if (!KINDS.includes(kind)) {
		return fail(`${at}.kind must be one of: ${KINDS.join(', ')}.`);
	}
	const strange = Object.keys(raw).filter(k => !KEYS.includes(k) || (k === 'command' && kind !== 'command'));
	if (strange.length) {
		return fail(`${at}.${strange[0]} is not a field of a ${kind} wait (allowed: ${kind === 'command' ? KEYS.join(', ') : 'kind, prompt'}).`);
	}
	let prompt = '';
	if (raw.prompt !== undefined) {
		if (typeof raw.prompt !== 'string') {
			return fail(`${at}.prompt must be text.`);
		}
		prompt = plain(raw.prompt);
		if (prompt.length > MAX_WAIT_PROMPT) {
			if (strict) {
				throw new WaitError(`${at}.prompt is ${prompt.length} characters long; at most ${MAX_WAIT_PROMPT} are shown.`);
			}
			prompt = prompt.slice(0, MAX_WAIT_PROMPT).trim();
		}
	}
	if (kind !== 'command') {
		return { wait: prompt ? { kind: kind as 'click' | 'continue', prompt } : { kind: kind as 'click' | 'continue' } };
	}
	if (typeof raw.command !== 'string' || !plain(raw.command)) {
		return fail(`${at}.command is required for a command wait: the id of a command to run (allowed: ${WAIT_COMMANDS.join(', ')}).`);
	}
	const command = plain(raw.command);
	if (command.length > MAX_WAIT_COMMAND) {
		return fail(`${at}.command is ${command.length} characters long; at most ${MAX_WAIT_COMMAND} are allowed.`);
	}
	// A tour file is somebody else's text: it never carries a command, whatever it names.
	if (!strict) {
		return { note: `${at}: a tour file cannot run commands, so the step does not wait` };
	}
	if (!WAIT_COMMANDS.includes(command)) {
		return { note: `${at}: command "${command}" is not allowed in a tour, so the step does not wait (allowed: ${WAIT_COMMANDS.join(', ')})` };
	}
	return { wait: { kind: 'command', command, prompt: prompt || 'Run it' } };
}

/** The step index a `tourRun` message asks for, when it is about the playing tour and names a step inside it that waits for a command. The message is the webview's: nothing in it is trusted. */
export function parseTourRun(playing: { id: string; tour: { steps: TourStep[] } } | undefined, m: Extract<CanvasToHostTour, { type: 'tourRun' }>): number | undefined {
	const msg: unknown = m;
	if (!playing || !isObject(msg) || msg.type !== 'tourRun' || msg.id !== playing.id) {
		return undefined;
	}
	const index = msg.index;
	if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= playing.tour.steps.length) {
		return undefined;
	}
	return playing.tour.steps[index].wait?.kind === 'command' ? index : undefined;
}

/** Runs the command of a step's wait through `execute` if it is allowed; says why when it is not or when it failed. Never throws. */
export async function runWait(step: TourStep | undefined, execute: (command: string) => PromiseLike<unknown>, timeoutMs = WAIT_TIMEOUT_MS): Promise<{ ok: boolean; reason?: string }> {
	const wait = step?.wait;
	if (wait?.kind !== 'command') {
		return { ok: false, reason: 'This step does not run a command.' };
	}
	// The host's own copy of the step is trusted, yet the list is checked once more, here, right before anything runs.
	if (!WAIT_COMMANDS.includes(wait.command)) {
		return { ok: false, reason: 'That command is not allowed in a tour.' };
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(TIMED_OUT), timeoutMs);
		});
		await Promise.race([Promise.resolve(execute(wait.command)), timedOut]);
		return { ok: true };
	} catch (e) {
		if (e === TIMED_OUT) {
			return { ok: false, reason: 'The command did not answer in time.' };
		}
		const message = plain(e instanceof Error ? e.message : String(e));
		return { ok: false, reason: `The command failed: ${message.slice(0, 200)}` };
	} finally {
		clearTimeout(timer);
	}
}
