// The sequence board on screen: the shapes of sequence.ts in one SVG with its own pan (drag) and zoom (wheel). The layout is the pure
// buildSequence; nothing here decides where anything goes.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BoardNode, BoardSpec } from './spec'
import { buildSequence, sequenceShapes, type Lit, type SeqLayout, type Shape, type Tone } from './sequence'

export const TONE_VAR: Record<Tone, string> = {
  text: 'var(--fl-text)',
  muted: 'var(--fl-muted)',
  signal: 'var(--fl-signal)',
  add: 'var(--fl-add)',
  del: 'var(--fl-del)',
  warn: 'var(--fl-warn)',
  canvas: 'var(--fl-canvas)',
  card: 'var(--fl-card)',
  line: 'var(--fl-line-strong)',
  note: '#e6c15a',
}

interface View { x: number; y: number; k: number }

/**
 * The diagram as text, for a screen reader: the participants, then each message in the drawn order as "1. A calls B: text" (a reply
 * "replies to", an asynchronous one "sends to", one to itself "calls itself"), then the groups it is cut into. It covers what the
 * SVG shows (everything but where things sit), which is why the SVG itself is hidden from assistive technology.
 */
export function sequenceMessageList(layout: SeqLayout): string[] {
  const name = (i: number) => layout.lifelines[i]?.node.label ?? '?'
  const out = [`Participants: ${layout.lifelines.map(l => l.node.label).join(', ') || 'none'}.`]
  layout.messages.forEach((m, i) => {
    const text = (m.edge.guard ? `[${m.edge.guard}] ` : '') + (m.edge.label ?? '')
    const verb = m.self ? 'calls itself' : m.ret ? `replies to ${name(m.to)}` : m.async ? `sends to ${name(m.to)}` : `calls ${name(m.to)}`
    out.push(`${i + 1}. ${name(m.from)} ${verb}${text ? ': ' + text : ''}`)
  })
  const frames = layout.frames.filter(f => !f.isElse)
  if (frames.length) out.push(`Groups: ${frames.map(f => `${f.kind} ${f.label}`.trim()).join('; ')}.`)
  return out
}

export interface SequenceApi {
  fit(): void
}

export function SequenceView({ spec, lit, selected, onSelect, apiRef }: {
  spec: BoardSpec
  /** Only these nodes and messages stay at full strength (a search, a step of the walk-through). */
  lit?: Lit
  selected?: string
  onSelect(node: BoardNode): void
  apiRef?: { current: SequenceApi | null }
}) {
  const box = useRef<SVGSVGElement>(null)
  const layout = useMemo(() => buildSequence(spec), [spec])
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const [hover, setHover] = useState<string>()
  const fitted = useRef(false)
  /** The reader panned or zoomed: a resize of the panel no longer re-fits the diagram. */
  const moved = useRef(false)

  const fit = useCallback(() => {
    const el = box.current
    if (!el) return
    const w = el.clientWidth
    const h = el.clientHeight
    const k = Math.min(1.1, Math.max(0.15, Math.min((w - 40) / layout.width, (h - 40) / layout.height)))
    setView({ k, x: Math.max(20, (w - layout.width * k) / 2), y: 20 })
  }, [layout])
  if (apiRef) apiRef.current = { fit }

  // Fit when the board changes shape (a redraw with other lifelines or messages), not on every highlight.
  const shapeKey = `${layout.lifelines.length}|${layout.messages.length}|${layout.width}|${layout.height}`
  useEffect(() => {
    fitted.current = false
    moved.current = false
  }, [shapeKey])
  useEffect(() => {
    if (!fitted.current) {
      fitted.current = true
      fit()
    }
  }, [fit, shapeKey])

  useEffect(() => {
    const el = box.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      moved.current = true
      const r = el.getBoundingClientRect()
      const px = e.clientX - r.left
      const py = e.clientY - r.top
      setView(v => {
        const k = Math.min(2.5, Math.max(0.1, v.k * Math.exp(-e.deltaY * 0.0015)))
        return { k, x: px - ((px - v.x) / v.k) * k, y: py - ((py - v.y) / v.k) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // The panel was resized (a side bar closed, the window made larger): the diagram follows until the reader takes over.
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (!moved.current) fit()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [fit])

  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean }>(undefined)
  const hoverLit = useMemo<Lit | undefined>(() => {
    if (lit || !hover) return lit
    return { nodes: new Set([hover]), edges: new Set(layout.messages.filter(m => layout.lifelines[m.from].id === hover || layout.lifelines[m.to].id === hover).map(m => m.key)) }
  }, [lit, hover, layout])
  const { shapes, dim } = useMemo(() => sequenceShapes(layout, spec, hoverLit), [layout, spec, hoverLit])
  const byId = useMemo(() => new Map(spec.nodes.map(n => [n.id, n])), [spec])
  const messages = useMemo(() => sequenceMessageList(layout), [layout])

  return (
    <>
    <ul className="sr-only" role="list" aria-label={`Sequence diagram: ${spec.title || 'untitled'}`}>
      {messages.map((m, i) => <li key={i}>{m}</li>)}
    </ul>
    <svg
      ref={box}
      className="sq"
      aria-hidden="true"
      onPointerDown={e => {
        if ((e.target as Element).closest('[data-node]')) return
        drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={e => {
        const d = drag.current
        if (!d) return
        d.moved = true
        moved.current = true
        setView(v => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
      }}
      onPointerUp={() => (drag.current = undefined)}
    >
      <g transform={`translate(${view.x} ${view.y + layout.padTop * view.k}) scale(${view.k})`}>
        {shapes.map((s, i) => (
          <ShapeEl
            key={i}
            s={s}
            faded={dim.has(s)}
            on={!!s.node && s.node === selected}
            onEnter={s.node ? () => setHover(s.node) : undefined}
            onLeave={s.node ? () => setHover(undefined) : undefined}
            onClick={s.node && byId.get(s.node) ? () => onSelect(byId.get(s.node!)!) : undefined}
          />
        ))}
      </g>
    </svg>
    </>
  )
}

function ShapeEl({ s, faded, on, onEnter, onLeave, onClick }: { s: Shape; faded: boolean; on: boolean; onEnter?: () => void; onLeave?: () => void; onClick?: () => void }) {
  const stroke = s.stroke ? TONE_VAR[s.stroke] : 'none'
  const fill = s.fill ? TONE_VAR[s.fill] : 'none'
  const common = {
    stroke,
    fill,
    strokeWidth: s.sw,
    strokeDasharray: s.dash,
    fillOpacity: s.fillOpacity,
    opacity: faded ? 0.2 : undefined,
    'data-node': s.node,
    'data-edge': s.edge,
    style: onClick ? { cursor: 'pointer' } : undefined,
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    onClick,
  }
  const title = s.title ? <title>{s.title}</title> : null
  switch (s.t) {
    case 'rect':
      return <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r} {...common} stroke={on ? 'var(--fl-signal)' : stroke} strokeWidth={on ? 2 : s.sw}>{title}</rect>
    case 'line':
      return <line x1={s.x} y1={s.y} x2={s.x2} y2={s.y2} {...common} fill="none">{title}</line>
    case 'path':
      return <path d={s.d} {...common}>{title}</path>
    case 'circle':
      return <circle cx={s.x} cy={s.y} r={s.r} {...common}>{title}</circle>
    case 'text':
      return (
        <text x={s.x} y={s.y} textAnchor={s.anchor} fontSize={s.size} fontWeight={s.bold ? 600 : 400} fontFamily={s.mono ? 'var(--fl-mono)' : 'var(--fl-ui)'} {...common} stroke="none" fill={s.fill ? TONE_VAR[s.fill] : 'var(--fl-text)'}>
          {s.text}
          {title}
        </text>
      )
  }
}
