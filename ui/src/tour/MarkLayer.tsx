// The pen marks over the step's card, in the step's ink, inside the flow's viewport (the same coordinates as the cursor).
// Each mark appears with an ink-reveal when its caption sentence starts; `prefers-reduced-motion` shows them at once.
import type { FlowNode, TourStep } from '../types'
import type { Box } from './geometry'

export interface MarkLayerProps {
  step: TourStep
  /** `${tour.id}:${index}`: changes with the step, so the marks clear and the sentence clock restarts. */
  stepKey: string
  /** The card (or peek card) the step points at, in flow coordinates; nothing for a caption-only step. */
  focus: Box | null
  /** The drawn flow, to find the card a `connect` mark ends at (`resolveStep`, cards.ts). */
  trees: (FlowNode | null)[]
  reduced: boolean
  /** The step is lit and its caption is shown: the sentence clock runs from the moment this turns true. */
  visible: boolean
}

/** Contract stub: the pen-marks part draws the marks. */
export function MarkLayer(_props: MarkLayerProps) {
  return null
}
