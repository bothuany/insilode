// Hands-on steps in the player: which steps are done, whether Next is blocked, the prompt and its button in the caption.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { CanvasToHostTour, Tour } from '../types'
import { movePermitted, stepBlocks, waitPrompt } from './wait.ts'
import './wait.css'

export interface TourWaitApi {
  /** The step the reader is on waits for them: Next is off. */
  blocked: boolean
  /** Whether the reader may move to step `to` (0-based): going on past a step that waits is not allowed; going back is. */
  allows(to: number): boolean
  /** A click inside the canvas: `spot` is the card the step points at, `clicked` the card that was clicked (`data-id`). A click wait on that card is done. */
  onCardClick(spot: string | undefined, clicked: string | undefined): void
  /** The host's answer to a command step (`tourWaitDone`): done, or the reason it failed with a way to skip. */
  onDone(m: { index: number; ok: boolean; reason?: string }): void
  /** The prompt and its button (a command's button sends `tourRun`, Continue completes it), shown in the caption; nothing on a step that does not wait. */
  slot: ReactNode
}

/** The host answers within 10 seconds; a canvas that heard nothing after this long lets the reader press the button again. */
const GIVE_UP_MS = 15_000

/** What the reader has done on one tour: the steps that are done (never asked twice), why a command failed, and the step whose command is running. */
interface Progress {
  id: string
  done: ReadonlySet<number>
  failed: Readonly<Record<number, string>>
  running: number | null
}

const fresh = (id: string): Progress => ({ id, done: new Set(), failed: {}, running: null })

/** `post` sends `tourRun`; the id and index are the tour's and the step's, the command is never sent (the host reads it from its own copy of the step). */
export function useTourWait({ tour, index, post }: { tour: Tour | null; index: number; post(msg: CanvasToHostTour): void }): TourWaitApi {
  const [stored, setStored] = useState<Progress>(() => fresh(''))
  // Progress belongs to one tour: another id starts clean, so a new tour never inherits steps that were done on the last one.
  const progress = tour && stored.id === tour.id ? stored : fresh(tour?.id ?? '')
  const id = tour?.id
  const wait = tour?.steps[index]?.wait
  const blocked = stepBlocks(wait, progress.done, index)
  const running = progress.running === index
  const failed = progress.failed[index]

  const update = (change: (p: Progress) => Progress) => {
    if (!id) return
    setStored(prev => change(prev.id === id ? prev : fresh(id)))
  }
  const complete = (at: number) => update(p => ({ ...p, done: new Set(p.done).add(at), running: p.running === at ? null : p.running }))

  // A command whose answer never came must not leave the button disabled for good.
  useEffect(() => {
    if (!running) return
    const timer = setTimeout(() => update(p => (p.running === index ? { ...p, running: null, failed: { ...p.failed, [index]: 'The command did not answer in time.' } } : p)), GIVE_UP_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, index, id])

  const run = () => {
    if (!tour || wait?.kind !== 'command' || running) return
    update(p => ({ ...p, running: index, failed: Object.fromEntries(Object.entries(p.failed).filter(([k]) => Number(k) !== index)) }))
    post({ type: 'tourRun', id: tour.id, index })
  }

  const done = !!wait && !blocked
  const label = wait ? waitPrompt(wait) : ''
  let slot: ReactNode = null
  if (wait) {
    slot = (
      <div className="tour-wait" data-kind={wait.kind} data-done={done || undefined}>
        {wait.kind === 'click' && !done && <p className="tour-wait-hint">{label}</p>}
        {wait.kind !== 'click' && !done && (
          <button type="button" className="btn solid tour-wait-go" disabled={running} onClick={wait.kind === 'command' ? run : () => complete(index)}>
            {label}
          </button>
        )}
        {/* A click wait also gets a way past it, so a reader who cannot click the card (keyboard, a card that is off the flow) is not stuck. */}
        {!done && (wait.kind === 'click' || failed) && (
          <button type="button" className="btn ghost tour-wait-skip" onClick={() => complete(index)}>
            Skip
          </button>
        )}
        {/* Always rendered, so a screen reader announces what changes in it: running, why it failed, done. */}
        <p className="tour-wait-status" role="status" aria-live="polite">
          {done ? 'Done' : running ? 'Running…' : failed ?? ''}
        </p>
      </div>
    )
  }

  return {
    blocked,
    allows: to => !tour || movePermitted(tour.steps, progress.done, index, to),
    onCardClick: (spot, clicked) => {
      if (wait?.kind === 'click' && blocked && spot !== undefined && clicked === spot) complete(index)
    },
    onDone: m => {
      if (!tour || !Number.isInteger(m.index) || tour.steps[m.index]?.wait?.kind !== 'command') return
      if (m.ok) complete(m.index)
      else update(p => ({ ...p, running: p.running === m.index ? null : p.running, failed: { ...p.failed, [m.index]: m.reason || 'The command failed.' } }))
    },
    slot,
  }
}
