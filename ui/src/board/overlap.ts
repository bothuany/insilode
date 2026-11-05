// Overlap nudging for the board canvas: boxes (cards, callout bubbles) that the layout put on top of each other are moved apart,
// deterministically, so the same board always draws the same. Pure: no React, no DOM, only type imports, so a test runs it under
// plain Node. The host has a copy (editor/extensions/flow-view/src/board/overlap.ts) because flow-view never imports ui/; a test
// bundles both and compares them, so change the two together.

export interface Box { id: string; x: number; y: number; w: number; h: number }

export interface Move {
  id: string
  dx: number
  dy: number
  /** The earlier box it was moved off. */
  off: string
}

export type Axis = 'right' | 'down' | 'up' | 'left'

export interface NudgeOptions {
  /** Overlap in px (on both axes) that is ignored: shadows and borders touch without anyone minding. Default 4. */
  tolerance?: number
  /** Air left between a moved box and the one it was moved off. Default 8. */
  gap?: number
  /** How many leading boxes are fixed (cards): they are obstacles and never move. Default 0. */
  fixed?: number
  /** The ways a box may move, the first one winning a tie. Default right and down; callout bubbles use right and up (they sit above what they note). */
  axes?: Axis[]
}

export interface Nudged {
  /** The boxes in the order given, moved ones at their new place (the input is never changed). */
  boxes: Box[]
  moves: Move[]
  /** Pairs [earlier, later] that still overlap because no free spot was found: the board needs more room. */
  stuck: [string, string][]
}

/** One box slid past a blocker at most this many times when a single move would land on another box. */
const HOPS = 4

const overlapW = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
const overlapH = (a: Box, b: Box) => Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)

/** The way each axis points. */
const VECTOR: Record<Axis, { x: number; y: number }> = { right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, down: { x: 0, y: 1 }, up: { x: 0, y: -1 } }

/** How far `b` must move along `axis` to sit clear of `o`, with `gap` between them. */
function clearance(b: Box, o: Box, axis: Axis, gap: number): number {
  const d = axis === 'right' ? o.x + o.w - b.x : axis === 'left' ? b.x + b.w - o.x : axis === 'down' ? o.y + o.h - b.y : b.y + b.h - o.y
  return Math.ceil(Math.max(d, 0) + gap)
}

/**
 * Moves each box that overlaps an earlier one (by more than `tolerance` on both axes) along the shortest of its `axes` that
 * clears the box it hit. A move only counts when the moved box then touches no other box, earlier or later; when a single move
 * would land on another box, the box is slid on past it (a few hops), and when no free spot is found the box stays and the pair
 * is reported in `stuck`. Boxes run in the given order, so put the ones that must not move (cards) first and pass `fixed`.
 */
export function nudgeApart(input: Box[], opts: NudgeOptions = {}): Nudged {
  const tolerance = opts.tolerance ?? 4
  const gap = opts.gap ?? 8
  const fixed = opts.fixed ?? 0
  const axes = opts.axes ?? ['right', 'down']
  const boxes = input.map(b => ({ ...b }))
  const moves: Move[] = []
  const stuck: [string, string][] = []
  const hits = (a: Box, b: Box) => overlapW(a, b) > tolerance && overlapH(a, b) > tolerance
  const blocker = (box: Box, self: number) => boxes.findIndex((o, k) => k !== self && hits(box, o))
  const shift = (b: Box, axis: Axis, d: number): Box => ({ ...b, x: b.x + VECTOR[axis].x * d, y: b.y + VECTOR[axis].y * d })

  for (let i = fixed; i < boxes.length; i++) {
    const b = boxes[i]
    const first = boxes.findIndex((o, k) => k < i && hits(b, o))
    if (first < 0) continue
    const hit = boxes[first]
    // The shortest way out of the box that was hit first; the axes given break a tie.
    const tries = axes.map((axis, n) => ({ axis, d: clearance(b, hit, axis, gap), n })).sort((p, q) => (p.d - q.d) || (p.n - q.n))
    let chosen = tries.find(t => blocker(shift(b, t.axis, t.d), i) < 0)
    let total = chosen?.d ?? 0
    if (!chosen) {
      // Every single move lands on something (a third bubble on the same spot, a card): slide further along each axis.
      const slid = tries.map(t => {
        let d = t.d
        for (let hop = 0; ; hop++) {
          const k = blocker(shift(b, t.axis, d), i)
          if (k < 0) return { axis: t.axis, d, n: t.n }
          if (hop === HOPS) return undefined
          d += clearance(shift(b, t.axis, d), boxes[k], t.axis, gap)
        }
      }).filter((m): m is { axis: Axis; d: number; n: number } => !!m)
      const best = slid.sort((p, q) => (p.d - q.d) || (p.n - q.n))[0]
      chosen = best && { axis: best.axis, d: best.d, n: best.n }
      total = best?.d ?? 0
    }
    if (!chosen) {
      stuck.push([hit.id, b.id])
      continue
    }
    const v = VECTOR[chosen.axis]
    b.x += v.x * total
    b.y += v.y * total
    moves.push({ id: b.id, dx: v.x * total, dy: v.y * total, off: hit.id })
  }
  return { boxes, moves, stuck }
}
