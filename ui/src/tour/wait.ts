// Hands-on tour steps: pure logic (no React, only type imports), so it runs under plain Node (ui/test). The host decides what
// may run; the canvas only shows the prompt, gates Next and says which step is done.
import type { TourWait } from '../types'

export const MAX_PROMPT = 80
export const MAX_COMMAND = 100

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Plain text on one line: control characters and runs of spaces become one space, then the text is cut. */
// eslint-disable-next-line no-control-regex
const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim().slice(0, max).trim() : '')

/**
 * A step's `wait`, rebuilt field by field: the kind, a command's text (command kind only) and the prompt cut to 80 characters.
 * Anything else, including a command wait without a command, is nothing: the step then simply does not wait.
 */
export function sanitizeWait(raw: unknown): TourWait | undefined {
  if (!obj(raw)) return undefined
  const prompt = line(raw.prompt, MAX_PROMPT)
  if (raw.kind === 'click' || raw.kind === 'continue') return prompt ? { kind: raw.kind, prompt } : { kind: raw.kind }
  if (raw.kind !== 'command' || typeof raw.command !== 'string') return undefined
  // The command is only ever shown to the host, which checks it against its own list; here it just has to be a sane id.
  const command = raw.command.trim()
  if (!command || command.length > MAX_COMMAND || /[\u0000-\u001f\u007f]/.test(command)) return undefined
  return { kind: 'command', command, prompt: prompt || 'Run it' }
}

/** What the caption says for a wait: a click's hint, a command's or a Continue step's button label. */
export function waitPrompt(wait: TourWait): string {
  if (wait.kind === 'command') return wait.prompt
  if (wait.kind === 'click') return wait.prompt || 'Click the highlighted card to go on'
  return wait.prompt || 'Continue'
}

/** The reader has to do something on this step before the tour goes on: it waits and has not been done yet. */
export function stepBlocks(wait: TourWait | undefined, doneIndexes: ReadonlySet<number> | readonly number[], index: number): boolean {
  if (!wait) return false
  return !(doneIndexes instanceof Set ? doneIndexes.has(index) : (doneIndexes as readonly number[]).includes(index))
}

/**
 * Whether the reader may move from step `index` to step `to`: going back, or staying, is always allowed; going on is when no step from
 * here up to (not including) `to` still waits for them, so a jump over a step that has not been done is refused too.
 */
export function movePermitted(steps: ReadonlyArray<{ wait?: TourWait }>, doneIndexes: ReadonlySet<number>, index: number, to: number): boolean {
  if (to <= index) return true
  for (let i = index; i < to && i < steps.length; i++) if (stepBlocks(steps[i].wait, doneIndexes, i)) return false
  return true
}
