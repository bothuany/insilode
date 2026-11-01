// Hands-on steps in the player: which steps are done, whether Next is blocked, the prompt and its button in the caption.
import type { ReactNode } from 'react'
import type { CanvasToHostTour, Tour } from '../types'

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

/** Contract stub: the hands-on part replaces this. `post` sends `tourRun`; the id and index are the tour's and the step's, the command is never sent. */
export function useTourWait(_args: { tour: Tour | null; index: number; post(msg: CanvasToHostTour): void }): TourWaitApi {
  return { blocked: false, allows: () => true, onCardClick: () => undefined, onDone: () => undefined, slot: null }
}
