// Hands-on tour steps: pure logic (no React, only type imports), so it runs under plain Node (ui/test). The host decides what
// may run; the canvas only shows the prompt, gates Next and says which step is done.
import type { TourWait } from '../types'

/** Contract stub: the hands-on part rebuilds a step's `wait` (kind, a command text, the prompt cut to 80 characters) and returns nothing for anything else. */
export function sanitizeWait(_raw: unknown): TourWait | undefined {
  return undefined
}
