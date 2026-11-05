// The words and tone of the impact chip and its popover, kept apart from the canvas so they are tested on their own
// (plain Node, `npm test` in ui/). No runtime imports: only erasable TypeScript.
import type { ImpactResult } from '../types'

/** hot: the result names entry points (the entry-point colour); neutral: it only names the callers at the top of the chain. */
export type ImpactTone = 'hot' | 'neutral'

export interface ImpactSummary {
  /** The chip's text. */
  chip: string
  /** What the popover says above the rows. */
  title: string
  /** A sentence for a screen reader and the tooltip: what the index found, never that nothing is affected. */
  status: string
  tone: ImpactTone
  /** True when there is at least one row to list. */
  hasRows: boolean
  /** A line under the rows when the walk was cut short, else empty. */
  more: string
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** "root caller" is a caller of the same kind: the chip and the popover say "caller". */
const nounOf = (label: string) => label.replace(/^root\s+/i, '')

/** A result that only lists callers does not say the change reaches an entry point: it gets the neutral tone and its own title. */
const isCallers = (label: string) => /caller/i.test(label)

export function impactSummary(result: ImpactResult): ImpactSummary {
  const n = result.items.length
  const cut = result.truncated ?? 0
  const callers = isCallers(result.label)
  const noun = nounOf(result.label)
  const tone: ImpactTone = callers ? 'neutral' : 'hot'
  const title = callers ? 'Callers at the top of the chain:' : 'Changing this method can change the behaviour of:'
  const more = cut > 0 ? `The walk stopped at its size limit with ${plural(cut, 'function')} left to follow: there may be more.` : ''
  if (n === 0) {
    // Zero rows is what the index found: it does not say the change reaches nothing (a caller the index cannot see, a call by reflection).
    const found = callers ? 'No callers found' : `No ${noun} found`
    return {
      chip: found,
      title,
      status: `${found} in the index${cut > 0 ? `, but the walk stopped at its size limit with ${plural(cut, 'function')} left to follow` : ''}`,
      tone,
      hasRows: false,
      more,
    }
  }
  const counted = (what: string) => (cut > 0 ? `at least ${plural(n, what)}` : plural(n, what))
  const chip = callers ? `${counted(`top ${noun}`)}` : `Affects ${counted(noun)}`
  return {
    chip: callers ? chip.charAt(0).toUpperCase() + chip.slice(1) : chip,
    title,
    status: `${callers ? `${counted(noun)} at the top of the chain` : chip}${cut > 0 ? ' (the walk stopped at its size limit)' : ''}`,
    tone,
    hasRows: true,
    more,
  }
}
