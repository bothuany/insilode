// The canvas board in the webview: the primitives board-canvas painted, drawn as one SVG you pan and zoom, with a drag to
// move an element, a note on any element, and a click that opens what an element links to. All geometry (layout, routing,
// widgets) is board-canvas's, the same code the host runs for the picture an agent gets; this file only draws it and turns
// pointer events into moves, notes and opens. No foreignObject: the SVG is also what the export and the PNG are made of.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as RPointerEvent } from 'react'
import type { CanvasElement, CanvasSpec, Link, Overrides } from '../../../board-canvas/canvas'
import { moveHash, rowBoxes, type Box } from '../../../board-canvas/layout'
import { textWidth } from '../../../board-canvas/measure'
import { paintCanvas, type Painted, type PaintOptions, type Palette, type Primitive } from '../../../board-canvas/paint'

export interface CanvasApi {
  fit(): void
}

interface Props {
  spec: CanvasSpec
  /** The picture of the board as the user's moves leave it. */
  painted: Painted
  palette: Palette
  /** What the painter needs besides the spec (scene, flips, overrides): the same options `painted` was made with. */
  options: PaintOptions
  selected?: string
  apiRef: MutableRefObject<CanvasApi | null>
  /** The reader panned or zoomed by hand. */
  onUserMove(): void
  onSelect(id: string | undefined): void
  onMove(id: string, x: number, y: number, hash: string): void
  onNote(id: string, text: string): void
  onToggleFrame(id: string): void
  onOpen(file: string, line: number): void
  onZoom(board: string): void
  notes: Overrides['notes']
}

const FONT = "'Segoe UI', system-ui, sans-serif"
const MONO = "Consolas, 'JetBrains Mono', Menlo, monospace"
const MIN_K = 0.1
const MAX_K = 3
const DRAG_PX = 4

/** One primitive, with the id of the element it belongs to so the page can find it. */
const Prim = memo(function Prim({ p }: { p: Primitive }) {
  switch (p.kind) {
    case 'rect':
      return <rect x={p.x} y={p.y} width={p.w} height={p.h} rx={p.rx ?? 0} fill={p.fill ?? 'none'} stroke={p.stroke ?? 'none'} strokeDasharray={p.dash} strokeWidth={p.sw} opacity={p.opacity} />
    case 'ellipse':
      return <ellipse cx={p.cx} cy={p.cy} rx={p.rx} ry={p.ry} fill={p.fill ?? 'none'} stroke={p.stroke ?? 'none'} strokeWidth={p.sw} opacity={p.opacity} />
    case 'path':
      return <path d={p.d} transform={p.at ? `translate(${p.at[0]} ${p.at[1]})` : undefined} fill={p.fill ?? 'none'} stroke={p.stroke} strokeWidth={p.sw ?? 1} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={p.dash} markerEnd={p.head ? `url(#${p.head === 'open' ? 'cv-o' : 'cv-a'})` : undefined} markerStart={p.tail ? 'url(#cv-a)' : undefined} opacity={p.opacity} />
    case 'text': {
      const w = textWidth(p.text, p.size, p.mono)
      const halo = p.halo ? <rect x={p.anchor === 'middle' ? p.x - w / 2 - 4 : p.anchor === 'end' ? p.x - w - 4 : p.x - 4} y={p.y - p.size} width={w + 8} height={p.size + 5} rx={3} fill={p.halo} opacity={p.opacity} /> : null
      return <>{halo}<text x={p.x} y={p.y} fontFamily={p.mono ? MONO : FONT} fontSize={p.size} fontWeight={p.weight} textAnchor={p.anchor} fill={p.fill} opacity={p.opacity} style={{ whiteSpace: 'pre' }}>{p.text}</text></>
    }
  }
})

/** The link an element or one of its port rows has: a click opens it. */
function linkAt(el: CanvasElement, box: Box, pt: { x: number; y: number }): Link | undefined {
  const row = rowBoxes(el, box).find(r => r.port.link && pt.x >= r.box.x && pt.x <= r.box.x + r.box.w && pt.y >= r.box.y && pt.y <= r.box.y + r.box.h)
  return row?.port.link ?? el.link
}

const describe = (el: CanvasElement, note?: string) => [el.label ?? el.id, el.origin ? `${el.origin}${el.source ? ` (${el.source})` : ''}` : '', el.detail ?? '', el.note ?? '', note ? `Your note: ${note}` : '', el.link?.file ? `${el.link.file}${el.link.line ? `:${el.link.line}` : ''}` : el.link?.symbol ?? el.link?.board ?? ''].filter(Boolean).join(' · ')

interface Drag { id: string; hash: string; sx: number; sy: number; rel: { x: number; y: number }; moved: boolean; x: number; y: number }

export function CanvasView({ spec, painted, palette, options, selected, apiRef, onUserMove, onSelect, onMove, onNote, onToggleFrame, onOpen, onZoom, notes }: Props) {
  const wrap = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ x: 24, y: 24, k: 1 })
  const viewRef = useRef(view)
  viewRef.current = view
  const [hover, setHover] = useState<string>()
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [drag, setDrag] = useState<Drag>()
  const dragRef = useRef<Drag | undefined>(undefined)
  const pan = useRef<{ sx: number; sy: number; x: number; y: number } | undefined>(undefined)
  const [editing, setEditing] = useState<string>()
  const [draft, setDraft] = useState('')

  // While a drag is going, the board is laid out again with the element where the pointer has it (the frame hash is the one the host will store).
  const live = useMemo(() => {
    if (!drag?.moved) return painted
    const moves = { ...options.overrides?.moves, [drag.id]: { x: drag.x, y: drag.y, hash: drag.hash } }
    return paintCanvas(spec, palette, { ...options, overrides: { ...options.overrides, moves } })
  }, [drag, painted, spec, palette, options])

  const fit = useCallback(() => {
    const el = wrap.current
    if (!el) return
    const w = el.clientWidth, h = el.clientHeight
    const bw = Math.max(1, painted.layout.w), bh = Math.max(1, painted.layout.h)
    const k = Math.max(MIN_K, Math.min(1.1, (w - 48) / bw, (h - 48) / bh))
    setView({ k, x: Math.max(12, (w - bw * k) / 2), y: Math.max(12, (h - bh * k) / 2) })
  }, [painted.layout.w, painted.layout.h])
  const fitRef = useRef(fit)
  fitRef.current = fit
  useEffect(() => {
    apiRef.current = { fit: () => fitRef.current() }
    return () => { apiRef.current = null }
  }, [apiRef])

  // The wheel zooms around the pointer. A native listener: React's is passive and could not stop the page from scrolling.
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const v = viewRef.current
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016))))
      const px = e.clientX - r.left, py = e.clientY - r.top
      setView({ k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) })
      onUserMove()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [onUserMove])

  const toBoard = (e: { clientX: number; clientY: number }) => {
    const r = wrap.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left - viewRef.current.x) / viewRef.current.k, y: (e.clientY - r.top - viewRef.current.y) / viewRef.current.k }
  }

  const placed = useMemo(() => [...live.layout.boxes.values()].sort((a, b) => a.depth - b.depth), [live])
  const elOf = useMemo(() => new Map(spec.elements.map(e => [e.id, e])), [spec])

  const onHitDown = (e: RPointerEvent, id: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const pl = painted.layout.boxes.get(id)
    const hash = moveHash(spec, id)
    if (!pl || !hash) return
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    const d: Drag = { id, hash, sx: e.clientX, sy: e.clientY, rel: pl.rel, moved: false, x: pl.rel.x, y: pl.rel.y }
    dragRef.current = d
    setDrag(d)
  }
  const onHitMove = (e: RPointerEvent) => {
    const d = dragRef.current
    if (!d) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) < DRAG_PX) return
    const k = viewRef.current.k
    const next = { ...d, moved: true, x: Math.max(0, Math.round(d.rel.x + dx / k)), y: Math.max(0, Math.round(d.rel.y + dy / k)) }
    dragRef.current = next
    setDrag(next)
  }
  const onHitUp = (e: RPointerEvent) => {
    const d = dragRef.current
    dragRef.current = undefined
    setDrag(undefined)
    if (!d) return
    if (d.moved) {
      onMove(d.id, d.x, d.y, d.hash)
      return
    }
    // A click: select it, and open what it links to (a port row has its own link).
    onSelect(d.id)
    const el = elOf.get(d.id)
    const pl = painted.layout.boxes.get(d.id)
    const link = el && pl ? linkAt(el, pl.box, toBoard(e)) : undefined
    if (link?.file) onOpen(link.file, link.line ?? 1)
    else if (link?.board) onZoom(link.board)
  }

  const onBgDown = (e: RPointerEvent) => {
    if (e.button !== 0) return
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    pan.current = { sx: e.clientX, sy: e.clientY, x: viewRef.current.x, y: viewRef.current.y }
  }
  const onBgMove = (e: RPointerEvent) => {
    const p = pan.current
    if (!p) return
    setView(v => ({ ...v, x: p.x + e.clientX - p.sx, y: p.y + e.clientY - p.sy }))
    if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > DRAG_PX) onUserMove()
  }
  const onBgUp = (e: RPointerEvent) => {
    const p = pan.current
    pan.current = undefined
    if (p && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) <= DRAG_PX) onSelect(undefined)
  }

  const enter = (id: string) => {
    clearTimeout(hoverTimer.current)
    setHover(id)
  }
  const leave = () => {
    clearTimeout(hoverTimer.current)
    hoverTimer.current = setTimeout(() => setHover(undefined), 260)
  }
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  const noteTarget = editing ?? (drag ? undefined : hover ?? selected)
  const noteBox = noteTarget ? live.layout.boxes.get(noteTarget)?.box : undefined
  const openNote = (id: string) => {
    setDraft(notes?.[id] ?? '')
    setEditing(id)
  }
  const saveNote = () => {
    if (editing) onNote(editing, draft)
    setEditing(undefined)
  }
  const openKey = [...(options.open ?? [])].sort().join(',') + '|' + [...(options.flip ?? [])].sort().join(',')

  return (
    <div className="cv" ref={wrap} data-dragging={drag?.moved || undefined}>
      <svg className="cv-svg" width="100%" height="100%" onPointerDown={onBgDown} onPointerMove={onBgMove} onPointerUp={onBgUp} role="img" aria-label="Canvas board">
        <defs>
          <marker id="cv-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill={palette.muted} /></marker>
          <marker id="cv-o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke={palette.muted} strokeWidth="1.4" /></marker>
        </defs>
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {/* A frame that opens or closes fades in (250ms): the only animation, and nothing moves. */}
          <g key={openKey} className="cv-fade">
            {live.primitives.map((p, i) => <g key={i} data-el={p.id}><Prim p={p} /></g>)}
          </g>
          {selected && live.layout.boxes.get(selected) && <rect className="cv-sel" x={live.layout.boxes.get(selected)!.box.x - 3} y={live.layout.boxes.get(selected)!.box.y - 3} width={live.layout.boxes.get(selected)!.box.w + 6} height={live.layout.boxes.get(selected)!.box.h + 6} rx={9} fill="none" />}
          {placed.map(pl => {
            const el = pl.el
            const header = el.type === 'frame' && !pl.collapsed
            return (
              <rect
                key={el.id}
                className="cv-hit"
                data-hit={el.id}
                data-link={el.link ? '' : undefined}
                x={pl.box.x}
                y={pl.box.y}
                width={pl.box.w}
                height={pl.box.h}
                fill="transparent"
                style={header ? { pointerEvents: 'visibleStroke' } : undefined}
                onPointerDown={e => onHitDown(e, el.id)}
                onPointerMove={onHitMove}
                onPointerUp={onHitUp}
                onPointerEnter={() => enter(el.id)}
                onPointerLeave={leave}
                onDoubleClick={e => {
                  if (el.type !== 'frame') return
                  if (pl.collapsed || toBoard(e).y - pl.box.y < 28) onToggleFrame(el.id)
                }}
              ><title>{describe(el, notes?.[el.id])}</title></rect>
            )
          })}
        </g>
      </svg>
      {noteBox && noteTarget && !editing && (
        <button
          className="cv-note-btn"
          style={{ left: view.x + (noteBox.x + noteBox.w) * view.k - 4, top: view.y + noteBox.y * view.k - 20 }}
          onPointerEnter={() => enter(noteTarget)}
          onPointerLeave={leave}
          onClick={() => openNote(noteTarget)}
          title={notes?.[noteTarget] ? 'Edit your note' : 'Pin a note to this element'}
        >{notes?.[noteTarget] ? '✎ note' : '+ note'}</button>
      )}
      {noteBox && editing && (
        <div className="cv-pop" style={{ left: Math.max(8, view.x + noteBox.x * view.k), top: view.y + (noteBox.y + noteBox.h) * view.k + 10 }} onPointerDown={e => e.stopPropagation()}>
          <div className="cv-pop-title">Note on {elOf.get(editing)?.label ?? editing}</div>
          <textarea
            autoFocus
            value={draft}
            maxLength={600}
            rows={4}
            placeholder="What should the agent know or change here?"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.stopPropagation(); setEditing(undefined) }
              else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveNote()
            }}
          />
          <div className="cv-pop-row">
            <button className="chip" onClick={saveNote}>Save</button>
            {notes?.[editing] && <button className="chip" onClick={() => { onNote(editing, ''); setEditing(undefined) }}>Remove</button>}
            <button className="chip" onClick={() => setEditing(undefined)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
