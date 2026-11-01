// The pen marks over the step's card, in the step's ink, inside the flow's viewport (the same coordinates as the cursor).
// Each mark appears with an ink-reveal when its caption sentence starts; `prefers-reduced-motion` shows them at once.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useReactFlow, type Node } from '@xyflow/react'
import { CODE_PAD, HEADER_H, LINE_H, type CardData } from '../layout'
import type { FlowNode, TourMark, TourStep } from '../types'
import { cardAt, resolveStep } from './cards'
import type { Box } from './geometry'
import { curveBetween, curvePoint, lineSpan, peekSpan, revealTimes, roundRect, visibleMarks, wavyLine } from './marks'
import { PEEK_MAX_LINES } from './Peek'
import './marks.css'

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

/** The card's text starts after the line-number gutter; a character of its code font is this wide (layout.ts's CHAR_W, not exported). */
const GUTTER = 46
const CHAR_W = 7.25
const PAD = 3
/** The marks that sit beside a line, left of the card. */
const SIDE = 15
const GLYPH = 6

/** Where the step's code is on the canvas, and how to find a line range on it. */
interface Place {
  box: Box
  span(lines: readonly [number, number]): { y1: number; y2: number } | undefined
  /** How far the code of those lines runs to the right of the card's left edge. */
  reach(lines: readonly [number, number]): number
}

const nodeBox = (n: Node, fallback?: Box): Box => ({ x: n.position.x, y: n.position.y, w: Number(n.style?.width) || fallback?.w || 400, h: Number(n.style?.height) || fallback?.h || 200 })

function placeOf(step: TourStep, focus: Box, node: Node | undefined, peek: boolean): Place | null {
  if (!peek) {
    const data = node?.data as CardData | undefined
    if (!node || !data?.rows) return null
    const top = HEADER_H + (data.chipsH ?? 0) + CODE_PAD
    const text = new Map(data.lines.map(l => [l.no, l.text.length]))
    return {
      box: nodeBox(node, focus),
      span: lines => lineSpan(data.rows, lines, top, LINE_H),
      reach: lines => GUTTER + Math.max(1, ...[...text].filter(([no]) => no >= lines[0] && no <= lines[1]).map(([, n]) => n)) * CHAR_W,
    }
  }
  const p = step.peek
  if (!p) return null
  const rows = Math.min(PEEK_MAX_LINES, p.code.split('\n').length)
  const widths = p.code.replace(/\t/g, '    ').split('\n').slice(0, rows).map(l => Math.min(l.length, 300))
  return {
    box: focus,
    span: lines => peekSpan(p.startLine, rows, lines, HEADER_H + CODE_PAD, LINE_H),
    reach: lines => GUTTER + Math.max(1, ...widths.filter((_, i) => p.startLine + i >= lines[0] && p.startLine + i <= lines[1])) * CHAR_W,
  }
}

function Pen({ mark, place, to }: { mark: TourMark; place: Place; to?: Box }): ReactNode {
  const { box } = place
  if (mark.kind === 'connect') {
    if (!to) return null
    const c = curveBetween(box, to)
    const mid = curvePoint(c, 0.5)
    const before = curvePoint(c, 0.96)
    const angle = (Math.atan2(c.to.y - before.y, c.to.x - before.x) * 180) / Math.PI
    const w = mark.label ? Math.min(240, mark.label.length * 6.6 + 14) : 0
    return (
      <g className="pen pen-connect">
        <path className="pen-stroke pen-draw" pathLength={1} d={`M${c.from.x} ${c.from.y} C${c.c1.x} ${c.c1.y} ${c.c2.x} ${c.c2.y} ${c.to.x} ${c.to.y}`} />
        <path className="pen-fill pen-late" d="M0 0 L-10 -5 L-10 5 Z" transform={`translate(${c.to.x} ${c.to.y}) rotate(${angle})`} />
        {mark.label ? (
          <g className="pen-late" transform={`translate(${mid.x} ${mid.y})`}>
            <rect className="pen-pill" x={-w / 2} y={-10} width={w} height={20} rx={10} />
            <text className="pen-pill-text" y={0.5} textAnchor="middle" dominantBaseline="middle">{mark.label}</text>
          </g>
        ) : null}
      </g>
    )
  }
  const lines = mark.lines
  const span = lines && place.span(lines)
  if (!lines || !span) return null
  const left = box.x + 4
  const right = box.x + box.w - 4
  const x0 = box.x + GUTTER
  const x1 = Math.min(right, box.x + place.reach(lines))
  const mid = span.y1 + LINE_H / 2
  const side = box.x - SIDE
  const at = box.y
  switch (mark.kind) {
    case 'ring':
      return <path className="pen pen-stroke pen-draw" pathLength={1} d={roundRect(left, at + span.y1 - PAD, right - left, span.y2 - span.y1 + 2 * PAD, 7)} />
    case 'underline':
      return <path className="pen pen-stroke pen-draw" pathLength={1} d={wavyLine(x0, Math.max(x0 + 24, x1), at + span.y2 - 1)} />
    case 'strike':
      return <path className="pen pen-stroke pen-draw" pathLength={1} d={`M${x0 - 2} ${at + (span.y1 + span.y2) / 2} L${Math.max(x0 + 24, x1) + 2} ${at + (span.y1 + span.y2) / 2 - 1}`} />
    case 'check':
      return <path className="pen pen-stroke pen-pop" d={`M${side - GLYPH} ${at + mid} l${GLYPH * 0.7} ${GLYPH * 0.85} l${GLYPH * 1.7} ${-GLYPH * 1.9}`} />
    case 'cross':
      return <path className="pen pen-stroke pen-pop" d={`M${side - GLYPH + 1} ${at + mid - GLYPH + 1} l${GLYPH * 2 - 2} ${GLYPH * 2 - 2} m0 ${-(GLYPH * 2 - 2)} l${-(GLYPH * 2 - 2)} ${GLYPH * 2 - 2}`} />
    case 'badge':
      return (
        <g className="pen pen-pop" transform={`translate(${side} ${at + mid})`}>
          <circle className="pen-fill" r={10} />
          <text className="pen-badge" textAnchor="middle" dominantBaseline="central" y={0.5}>{mark.n}</text>
        </g>
      )
  }
  return null
}

function Layer({ step, focus, trees, reduced, visible }: MarkLayerProps & { focus: Box }) {
  const rf = useReactFlow()
  const t0 = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [all, setAll] = useState(false)

  // The clock starts the first time the step is lit. Lit again later (the reader paused and came back) it shows everything: the pen does not redraw.
  useEffect(() => {
    if (!visible) return
    if (t0.current === null) t0.current = performance.now()
    else setAll(true)
  }, [visible])

  // One wake-up per sentence that carries a mark, no polling.
  useEffect(() => {
    if (!visible || reduced || all || t0.current === null) return
    const now = performance.now() - t0.current
    const timers = revealTimes(step).filter(t => t > now).map(t => setTimeout(() => setElapsed(t), t - now))
    return () => timers.forEach(clearTimeout)
  }, [visible, reduced, all, step.caption, step.marks]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible) return null
  const target = resolveStep(trees, step)
  if (target.kind === 'none') return null
  const place = placeOf(step, focus, target.kind === 'card' ? rf.getNode(target.node.key) : undefined, target.kind === 'peek')
  if (!place) return null
  const shown = visibleMarks(step, elapsed, all || reduced)
  return (
    <svg className={`tour-pen${reduced ? ' reduced' : ''}`} width={1} height={1} aria-hidden="true">
      {shown.map(mark => {
        const i = step.marks?.indexOf(mark) ?? 0
        let to: Box | undefined
        if (mark.kind === 'connect' && mark.to) {
          // The other end must be drawn, and be another card: an arrow to nowhere is not shown.
          const end = cardAt(trees, mark.to.file, mark.to.startLine)
          const node = end ? rf.getNode(end.key) : undefined
          if (node && !(target.kind === 'card' && end?.key === target.node.key)) to = nodeBox(node)
        }
        return <Pen key={i} mark={mark} place={place} to={to} />
      })}
    </svg>
  )
}

export function MarkLayer(props: MarkLayerProps) {
  // Keyed on the step: the marks clear and the sentence clock restarts when the step changes.
  return props.focus && props.step.marks?.length ? <Layer key={props.stepKey} {...props} focus={props.focus} /> : null
}
