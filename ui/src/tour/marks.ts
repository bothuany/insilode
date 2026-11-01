// The pen marks of a tour step: pure logic (no React, only type imports), so it runs under plain Node (ui/test). The marks are
// drawn by MarkLayer.tsx. Each mark appears with its caption sentence; there is no speech, so a sentence's time is estimated from
// its words.
import type { TourMark } from '../types'

/** Contract stub: the pen-marks part rebuilds each mark field by field (kinds, ranges, lengths; at most 6) and returns nothing when none is left. */
export function sanitizeMarks(_raw: unknown): TourMark[] | undefined {
  return undefined
}
