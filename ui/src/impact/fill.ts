// The state of one answer that fills in after the canvas has drawn (the callers, the impact): asked, answered or failed.
// Plain data and pure transitions, so "Checking impact…" can be shown to always end in a result or an error, and is tested
// as such (plain Node, `npm test` in ui/). No runtime imports: only erasable TypeScript.

export interface Fill<T> {
  /** The last answer. A refresh keeps the old one on screen while the new one is asked, and when it fails. */
  value: T | null
  /** Why the last ask failed; empty when it did not. */
  error: string
  /** An ask is in flight. */
  pending: boolean
}

export const emptyFill = <T>(): Fill<T> => ({ value: null, error: '', pending: false })

/** The answer is being asked for. `keep`: a refresh, so the previous answer stays until the new one arrives. */
export const asked = <T>(prev: Fill<T>, keep: boolean): Fill<T> => ({ value: keep ? prev.value : null, error: '', pending: true })

export const answered = <T>(value: T): Fill<T> => ({ value, error: '', pending: false })

/** The ask failed: the error is kept with whatever answer was there before it. */
export const failed = <T>(prev: Fill<T>, reason: unknown): Fill<T> => ({ value: prev.value, error: messageOf(reason), pending: false })

export function messageOf(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : ''
  return text || 'The editor did not say why.'
}

/** What the impact chip shows. `checking` only while an ask is in flight (or none was made yet): never forever. */
export type ChipState = 'checking' | 'error' | 'result'

export function chipState<T>(fill: Fill<T>): ChipState {
  if (fill.error) return 'error'
  if (fill.value) return 'result'
  return 'checking'
}

/**
 * What the bar shows before and after the flow is drawn. `ready`: the flow is drawn, so the impact has been asked for.
 * `blocked`: it could not be drawn, so the impact is never asked: "not checked", not "checking" for good.
 */
export type BarChip = ChipState | 'blocked'

export function barChip<T>(fill: Fill<T>, ready: boolean, blocked: boolean): BarChip {
  if (!ready) return blocked ? 'blocked' : 'checking'
  return chipState(fill)
}
