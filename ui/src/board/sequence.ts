// The sequence board: lifelines side by side, messages top to bottom in `order`, activation bars, alt/loop/opt boxes. Pure: no DOM,
// no React. buildSequence places everything; sequenceShapes turns the placement into plain shapes that the canvas (React) and the
// SVG export both draw, so they cannot disagree.
import type { BoardEdge, BoardNode, BoardSpec, GroupKind } from '../../../board-canvas/spec'

export const SEQ_HEAD_W = 120
export const SEQ_HEAD_H = 40
const MARGIN = 48
const MIN_GAP = 190
const ROW = 44
const FRAME_HEAD = 24
const ELSE_HEAD = 22
const LABEL_W = 6.4
const SELF_W = 40
const BAR_W = 10

export interface Lifeline {
  id: string
  node: BoardNode
  /** Centre x of the lifeline. */
  x: number
  /** Width of the head box. */
  w: number
}

export interface Message {
  /** Position in the drawn order (0-based). */
  index: number
  edge: BoardEdge
  /** Lifeline indexes. */
  from: number
  to: number
  y: number
  self: boolean
  /** A reply (dashed): it closes an activation. */
  ret: boolean
  async: boolean
  /** The `from>to` key steps and highlights use. */
  key: string
}

export interface Activation { lifeline: number; y1: number; y2: number; depth: number }

export interface Frame {
  id: string
  kind: GroupKind
  label: string
  x1: number
  x2: number
  y1: number
  y2: number
  /** An else branch: drawn as a dashed divider with its condition, inside its parent's box. */
  isElse: boolean
  /** Nesting level, 0 for the outermost. */
  depth: number
}

export interface SeqLayout {
  lifelines: Lifeline[]
  messages: Message[]
  activations: Activation[]
  frames: Frame[]
  width: number
  height: number
  /** Bottom of the lifelines. */
  bottom: number
  /** Room above the heads for notes pinned to a lifeline; everything is drawn this far down. */
  padTop: number
  /** Some messages carry no `order`: they follow the numbered ones in array order. */
  unordered: boolean
}

const FRAME_KINDS = new Set<string>(['alt', 'loop', 'opt'])

/** The messages in the order they are drawn: by `order`, then the array position; those without `order` come last. */
export function orderedEdges(spec: BoardSpec): BoardEdge[] {
  return spec.edges
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.order ?? Infinity) - (b.e.order ?? Infinity) || a.i - b.i)
    .map(x => x.e)
}

export function buildSequence(spec: BoardSpec): SeqLayout {
  const nodes = spec.nodes
  const idx = new Map(nodes.map((n, i) => [n.id, i]))
  const edges = orderedEdges(spec).filter(e => idx.has(e.from) && idx.has(e.to))
  const widths = nodes.map(n => Math.max(SEQ_HEAD_W, Math.min(260, n.label.length * 7.6 + 30)))

  // Gaps between neighbouring lifelines: wide enough for the heads, and for the longest message label across them.
  const gaps = nodes.map((_, i) => (i + 1 < nodes.length ? Math.max(MIN_GAP, (widths[i] + widths[i + 1]) / 2 + 28) : 0))
  const labelOf = (e: BoardEdge) => (e.guard ? `[${e.guard}] ` : '') + (e.label ?? '')
  const needs = edges.map(e => ({ a: Math.min(idx.get(e.from)!, idx.get(e.to)!), b: Math.max(idx.get(e.from)!, idx.get(e.to)!), w: labelOf(e).length * LABEL_W + 44, self: e.from === e.to }))
  for (const n of [...needs].sort((p, q) => (p.b - p.a) - (q.b - q.a))) {
    if (n.self) {
      // A message to itself is drawn to the right of the lifeline.
      if (n.a + 1 < nodes.length) gaps[n.a] = Math.max(gaps[n.a], n.w + SELF_W)
      continue
    }
    let have = 0
    for (let i = n.a; i < n.b; i++) have += gaps[i]
    if (have < n.w) {
      const add = (n.w - have) / (n.b - n.a)
      for (let i = n.a; i < n.b; i++) gaps[i] += add
    }
  }
  const xs: number[] = []
  nodes.forEach((_, i) => xs.push(i === 0 ? MARGIN + widths[0] / 2 : xs[i - 1] + gaps[i - 1]))
  const lifelines: Lifeline[] = nodes.map((n, i) => ({ id: n.id, node: n, x: xs[i], w: widths[i] }))

  // Fragments: groups of kind alt, loop or opt, with the rows their messages (and their sub-fragments') occupy.
  const groups = new Map((spec.groups ?? []).filter(g => g.kind && FRAME_KINDS.has(g.kind)).map(g => [g.id, g]))
  const parentOf = (id: string) => {
    const p = groups.get(id)?.parent
    return p && p !== id && groups.has(p) ? p : undefined
  }
  const depthOf = (id: string) => {
    let d = 0
    for (let p = parentOf(id); p && d < 8; p = parentOf(p)) d++
    return d
  }
  const inTree = (frag: string | undefined, root: string) => {
    for (let g = frag, n = 0; g && n < 9; g = parentOf(g), n++) if (g === root) return true
    return false
  }
  const rows = new Map<string, { lo: number; hi: number; min: number; max: number }>()
  for (const g of groups.values()) {
    let lo = Infinity
    let hi = -1
    let min = Infinity
    let max = -1
    edges.forEach((e, i) => {
      if (!inTree(e.fragment, g.id)) return
      lo = Math.min(lo, i)
      hi = Math.max(hi, i)
      min = Math.min(min, idx.get(e.from)!, idx.get(e.to)!)
      max = Math.max(max, idx.get(e.from)!, idx.get(e.to)!)
    })
    if (hi >= 0) rows.set(g.id, { lo, hi, min, max })
  }
  const isElse = (id: string) => {
    const g = groups.get(id)!
    const p = parentOf(id)
    return !!p && g.kind === 'alt' && groups.get(p)!.kind === 'alt'
  }
  // The band above a row for the boxes that open on it (the else dividers are slimmer).
  const gapAbove = (row: number) => [...rows].reduce((t, [id, r]) => (r.lo === row ? t + (isElse(id) ? ELSE_HEAD : FRAME_HEAD) : t), 0)

  const top = SEQ_HEAD_H + 30
  const messages: Message[] = []
  let y = top
  edges.forEach((e, i) => {
    y += gapAbove(i)
    const from = idx.get(e.from)!
    const to = idx.get(e.to)!
    messages.push({ index: i, edge: e, from, to, y: y + ROW / 2, self: from === to, ret: e.style === 'dashed' && from !== to, async: e.async === true, key: `${e.from}>${e.to}` })
    y += ROW + (from === to ? 16 : 0)
  })
  const bottom = y + 14

  // Activation bars: a synchronous call opens one on its target, the reply from the target to the caller closes it. A call that is
  // never answered lasts until the last message the target sends.
  const activations: Activation[] = []
  const open: { lifeline: number; caller: number; y1: number; depth: number }[] = []
  const depthAt = (l: number) => open.filter(o => o.lifeline === l).length
  for (const m of messages) {
    if (m.ret) {
      const at = open.map((o, k) => ({ o, k })).reverse().find(x => x.o.lifeline === m.from && x.o.caller === m.to)
      if (at) {
        open.splice(at.k, 1)
        activations.push({ lifeline: at.o.lifeline, y1: at.o.y1, y2: m.y, depth: at.o.depth })
      }
    } else if (!m.self && !m.async) {
      open.push({ lifeline: m.to, caller: m.from, y1: m.y - 8, depth: depthAt(m.to) })
    }
  }
  for (const o of open) {
    const lastSent = messages.filter(m => m.from === o.lifeline && m.y > o.y1).reduce((t, m) => Math.max(t, m.y), o.y1 + 16)
    activations.push({ lifeline: o.lifeline, y1: o.y1, y2: lastSent + 8, depth: o.depth })
  }

  const frames: Frame[] = [...rows].map(([id, r]): Frame => {
    const g = groups.get(id)!
    const depth = depthOf(id)
    const inner = Math.max(0, ...[...rows.keys()].filter(k => k !== id && inTree(k, id)).map(k => depthOf(k) - depth))
    const pad = 30 + 10 * inner
    // An else divider spans its whole alt box.
    const span = isElse(id) ? rows.get(parentOf(id)!)! : r
    const rank = [...rows].filter(([k, v]) => v.lo === r.lo && !isElse(k) && depthOf(k) < depth).length
    const same = [...rows].filter(([k, v]) => v.lo === r.lo && !isElse(k)).length
    const first = messages[r.lo]
    const last = messages[r.hi]
    const yTop = isElse(id) ? first.y - ROW / 2 - 6 : first.y - ROW / 2 - FRAME_HEAD * (same - rank) + 4
    return {
      id,
      kind: g.kind!,
      label: g.label,
      x1: xs[span.min] - pad,
      x2: xs[span.max] + pad + (messages.some(m => m.self && m.from === span.max && m.index >= span.lo && m.index <= span.hi) ? SELF_W : 0),
      y1: yTop,
      y2: last.y + ROW / 2 - 6 + 5 * inner + (last.self ? 16 : 0),
      isElse: isElse(id),
      depth,
    }
  })
  const noteLines = Math.max(0, ...(spec.callouts ?? []).filter(c => c.node && idx.has(c.node)).map(c => wrapNote(c.text).length))
  const padTop = noteLines ? noteLines * 13 + 12 + 14 : 0
  const width = Math.max(...lifelines.map(l => l.x + l.w / 2), ...frames.map(f => f.x2)) + MARGIN
  return { lifelines, messages, activations, frames, width: Math.ceil(width), height: Math.ceil(bottom + MARGIN / 2 + padTop), bottom, padTop, unordered: spec.edges.some(e => e.order === undefined) }
}

// ---- shapes -------------------------------------------------------------------------------------------------

export type Tone = 'text' | 'muted' | 'signal' | 'add' | 'del' | 'warn' | 'canvas' | 'card' | 'line' | 'note'

export interface Shape {
  t: 'rect' | 'line' | 'path' | 'text' | 'circle'
  x?: number
  y?: number
  w?: number
  h?: number
  r?: number
  d?: string
  text?: string
  anchor?: 'start' | 'middle' | 'end'
  size?: number
  bold?: boolean
  mono?: boolean
  stroke?: Tone
  fill?: Tone
  fillOpacity?: number
  dash?: string
  sw?: number
  /** Node id (a lifeline head) or `from>to` key (a message) this shape belongs to: clicks, hover and highlights use it. */
  node?: string
  edge?: string
  title?: string
  /** x2, y2 of a line. */
  x2?: number
  y2?: number
}

export interface Lit {
  nodes: ReadonlySet<string>
  edges: ReadonlySet<string>
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const f = (n: number) => Math.round(n * 10) / 10

function arrow(x: number, y: number, dir: 1 | -1, open: boolean): Shape {
  const bx = x - dir * 10
  return open
    ? { t: 'path', d: `M${f(bx)} ${f(y - 5)} L${f(x)} ${f(y)} L${f(bx)} ${f(y + 5)}`, sw: 1.4 }
    : { t: 'path', d: `M${f(x)} ${f(y)} L${f(bx)} ${f(y - 4.5)} L${f(bx)} ${f(y + 4.5)} Z`, sw: 1.2 }
}

/** The drawing of a sequence layout as plain shapes. `lit`: only these nodes and messages stay at full strength. */
export function sequenceShapes(l: SeqLayout, spec: BoardSpec, lit?: Lit): { shapes: Shape[]; dim: Map<Shape, boolean> } {
  const out: Shape[] = []
  const dim = new Map<Shape, boolean>()
  const add = (s: Shape, faded = false) => {
    out.push(s)
    if (faded) dim.set(s, true)
  }
  const nodeDim = (id: string) => !!lit && !lit.nodes.has(id)
  const edgeDim = (m: Message) => !!lit && !lit.edges.has(m.key) && !(lit.nodes.has(l.lifelines[m.from].id) && lit.nodes.has(l.lifelines[m.to].id) && lit.edges.size === 0)

  // Fragment boxes first (behind everything), outermost first.
  for (const fr of [...l.frames].sort((a, b) => a.depth - b.depth)) {
    if (fr.isElse) {
      add({ t: 'line', x: fr.x1, y: fr.y1, x2: fr.x2, y2: fr.y1, stroke: 'muted', dash: '6 4', sw: 1 })
      add({ t: 'text', x: fr.x1 + 8, y: fr.y1 + 15, text: clip(`else ${fr.label}`, 60), size: 10.5, fill: 'muted', bold: true })
      continue
    }
    add({ t: 'rect', x: fr.x1, y: fr.y1, w: fr.x2 - fr.x1, h: fr.y2 - fr.y1, r: 4, stroke: 'muted', fill: 'text', fillOpacity: 0.025, sw: 1, title: `${fr.kind} ${fr.label}` })
    const tag = fr.kind
    add({ t: 'rect', x: fr.x1, y: fr.y1, w: tag.length * 7 + 14, h: 17, r: 3, fill: 'muted', fillOpacity: 0.22, stroke: 'muted', sw: 1 })
    add({ t: 'text', x: fr.x1 + 7, y: fr.y1 + 12.5, text: tag, size: 10.5, fill: 'text', bold: true })
    add({ t: 'text', x: fr.x1 + tag.length * 7 + 22, y: fr.y1 + 12.5, text: clip(fr.label, 70), size: 10.5, fill: 'muted' })
  }
  // Lifelines: a dashed line under a head box.
  for (const ll of l.lifelines) {
    const faded = nodeDim(ll.id)
    add({ t: 'line', x: ll.x, y: SEQ_HEAD_H, x2: ll.x, y2: l.bottom, stroke: 'line', dash: '4 5', sw: 1.2 }, faded)
    const n = ll.node
    const actor = n.kind === 'actor' || n.shape === 'actor'
    add({ t: 'rect', x: ll.x - ll.w / 2, y: 0, w: ll.w, h: SEQ_HEAD_H, r: actor ? 20 : 6, fill: 'card', stroke: 'line', sw: 1.2, node: ll.id, title: [n.label, n.tech, n.detail, n.symbol, n.file, n.note].filter(Boolean).join('\n') }, faded)
    add({ t: 'text', x: ll.x, y: n.tech || n.detail ? 17 : 24.5, text: clip(n.label, Math.floor(ll.w / 7.4)), anchor: 'middle', size: 13, bold: true, fill: 'text', node: ll.id }, faded)
    const sub = n.tech ? `[${n.tech}]` : n.detail
    if (sub) add({ t: 'text', x: ll.x, y: 31, text: clip(sub, Math.floor(ll.w / 6)), anchor: 'middle', size: 10, fill: 'muted', node: ll.id }, faded)
    if (n.status || n.change) {
      add({ t: 'circle', x: ll.x + ll.w / 2 - 6, y: 6, r: 3.5, fill: n.change === 'added' || n.status === 'done' ? 'add' : n.change === 'removed' || n.status === 'blocked' ? 'del' : n.change === 'changed' ? 'warn' : 'signal' }, faded)
    }
  }
  // Activation bars.
  for (const a of l.activations) {
    const ll = l.lifelines[a.lifeline]
    add({ t: 'rect', x: ll.x - BAR_W / 2 + a.depth * 5, y: a.y1, w: BAR_W, h: Math.max(10, a.y2 - a.y1), r: 1.5, fill: 'signal', fillOpacity: 0.28, stroke: 'signal', sw: 1 }, nodeDim(ll.id))
  }
  // Messages.
  for (const m of l.messages) {
    const e = m.edge
    const a = l.lifelines[m.from]
    const b = l.lifelines[m.to]
    const tone: Tone = e.change === 'added' ? 'add' : e.change === 'removed' ? 'del' : e.change === 'changed' ? 'warn' : e.kind === 'yes' ? 'add' : e.kind === 'no' ? 'del' : 'text'
    const faded = edgeDim(m)
    const dash = e.style === 'dashed' ? '6 4' : e.style === 'dotted' ? '2 3' : undefined
    const text = (e.guard ? `[${e.guard}] ` : '') + (e.label ?? '')
    const base: Partial<Shape> = { edge: m.key, title: [text, e.kind, e.order !== undefined ? `#${e.order}` : ''].filter(Boolean).join(' · ') }
    if (m.self) {
      const x = a.x + BAR_W / 2 + (depthOfActivation(l, m) ? 5 : 0)
      const d = `M${f(x)} ${f(m.y - 8)} H${f(x + SELF_W)} V${f(m.y + 10)} H${f(x + 10)}`
      add({ t: 'path', d, stroke: tone, dash, sw: 1.4, ...base })
      add({ ...arrow(x, m.y + 10, -1, e.async === true), stroke: tone, fill: e.async ? undefined : tone, ...base }, faded)
      if (text) add({ t: 'text', x: x + SELF_W + 8, y: m.y + 5, text: clip(text, 48), size: 11, fill: 'text', ...base }, faded)
      if (e.order !== undefined) badge(add, x - 14, m.y - 8, e.order, faded)
      continue
    }
    const dir: 1 | -1 = b.x > a.x ? 1 : -1
    const x1 = a.x + dir * (BAR_W / 2)
    const x2 = b.x - dir * (BAR_W / 2)
    add({ t: 'line', x: x1, y: m.y, x2: x2 - dir * (e.async ? 0 : 8), y2: m.y, stroke: tone, dash, sw: 1.4, ...base }, faded)
    add({ ...arrow(x2, m.y, dir, e.async === true || m.ret), stroke: tone, fill: e.async || m.ret ? undefined : tone, ...base }, faded)
    if (text) add({ t: 'text', x: (x1 + x2) / 2, y: m.y - 7, text: clip(text, Math.max(8, Math.floor(Math.abs(x2 - x1) / LABEL_W))), anchor: 'middle', size: 11, fill: 'text', ...base }, faded)
    if (e.order !== undefined) badge(add, x1 + dir * 20, m.y - 14, e.order, faded)
  }
  // Callouts: a note beside the lifeline head or beside the message it is about.
  for (const c of spec.callouts ?? []) {
    const lines = wrapNote(c.text)
    const h = lines.length * 13 + 12
    let x: number
    let y: number
    let key: Partial<Shape>
    if (c.node) {
      const ll = l.lifelines.find(x2 => x2.id === c.node)
      if (!ll) continue
      x = ll.x - 95
      y = -h - 12
      key = { node: c.node }
    } else if (c.edge) {
      const m = l.messages.find(x2 => x2.key === `${c.edge![0]}>${c.edge![1]}`)
      if (!m) continue
      x = Math.max(l.lifelines[m.from].x, l.lifelines[m.to].x) + 24 + (m.self ? SELF_W + 120 : 0)
      y = m.y - h / 2
      key = { edge: m.key }
    } else continue
    add(c.node ? { t: 'path', d: `M${f(x + 95)} ${f(y + h)} L${f(x + 95)} 0`, stroke: 'note', sw: 1 } : { t: 'path', d: `M${f(x - 10)} ${f(y + h / 2)} L${f(x)} ${f(y + h / 2)}`, stroke: 'note', sw: 1 })
    add({ t: 'rect', x, y, w: 190, h, r: 6, fill: 'note', fillOpacity: 0.16, stroke: 'note', sw: 1, ...key })
    lines.forEach((ln, i) => add({ t: 'text', x: x + 8, y: y + 15 + i * 13, text: ln, size: 11, fill: 'text', ...key }))
  }
  return { shapes: out, dim }
}

function depthOfActivation(l: SeqLayout, m: Message): boolean {
  return l.activations.some(a => a.lifeline === m.from && a.y1 <= m.y && a.y2 >= m.y)
}

function badge(add: (s: Shape, faded?: boolean) => void, x: number, y: number, order: number, faded: boolean) {
  add({ t: 'circle', x, y, r: 8, fill: 'canvas', stroke: 'muted', sw: 1.2 }, faded)
  add({ t: 'text', x, y: y + 3.5, text: String(order), anchor: 'middle', size: 10, bold: true, fill: 'text' }, faded)
}

function wrapNote(text: string, max = 30): string[] {
  const lines: string[] = []
  let line = ''
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const word = raw.length > max ? raw.slice(0, max - 1) + '…' : raw
    if (line && line.length + 1 + word.length > max) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 6)
}
