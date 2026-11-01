import type { Edge, Node } from '@xyflow/react'
import { chipsFor, NO_CHIPS, type CardChips, type ChipRow, type ChipsView } from './chips'
import type { FlowEdge, FlowNode, Kind } from './types'

export const LINE_H = 18
export const HEADER_H = 44
export const CODE_PAD = 6
const CHAR_W = 7.25
const PAD = 16
const GAP = 90
const VGAP = 18

/**
 * The accent of each kind of card and edge. Edge labels are text in this colour, so a light theme gets a darker set: the pale
 * dark-theme amber is 1.7:1 on white. Both sets are at least 4.5:1 on their editor background (ui/test/colors.test.mjs).
 */
export const KIND_PALETTE: { dark: Record<Kind, string>; light: Record<Kind, string> } = {
  dark: { controller: '#ffb454', handler: '#b88cff', method: '#8b93a1', db: '#4fd6d0', ambiguous: '#ff6b7d', external: '#838b9a' },
  light: { controller: '#9a5b00', handler: '#7a3fd1', method: '#5c6470', db: '#0e7b76', ambiguous: '#b3261e', external: '#5a6270' },
}

const KINDS = Object.keys(KIND_PALETTE.dark) as Kind[]
const kindVars = (set: Record<Kind, string>) => KINDS.map(k => `--kind-${k}: ${set[k]};`).join(' ')

/** What KIND_COLOR names: the dark set by default, the light one under the light theme classes VS Code puts on <body>. */
export const KIND_CSS = `:root { ${kindVars(KIND_PALETTE.dark)} }\nbody.vscode-light, body.vscode-high-contrast-light { ${kindVars(KIND_PALETTE.light)} }`

// A variable, so the colour follows the theme without a layout pass; the rules above are added to the page once, here, because
// this page's own stylesheet is not where the canvas keeps its other colours.
export const KIND_COLOR = Object.fromEntries(KINDS.map(k => [k, `var(--kind-${k})`])) as Record<Kind, string>
if (typeof document !== 'undefined' && !document.getElementById('kind-colors')) {
  const style = document.createElement('style')
  style.id = 'kind-colors'
  style.textContent = KIND_CSS
  document.head.appendChild(style)
}

export interface CodeLine {
  no: number // absolute file line
  text: string // dedented
}

export type Row = CodeLine | { gap: number; from: number } | { del: string; after: number; i: number }

export interface CardData extends Record<string, unknown> {
  node: FlowNode
  lines: CodeLine[]
  rows: Row[]
  full: boolean
  compactable: boolean
  calls: { edge: FlowEdge; hidden: boolean; y: number }[]
  selected: boolean
  touched: boolean
  editing?: boolean
  /** Reverse view: how many callers this card has, and how many are folded away. */
  callers?: number
  callersHidden?: number
  /** Type chips under the header (see chips.ts): the chips, the rows of what is opened under them, which chips are opened, and the height all of it takes. */
  chips?: CardChips
  chipRows?: ChipRow[]
  chipsOpen?: ReadonlySet<string>
  chipsH?: number
}

export interface FrameData extends Record<string, unknown> {
  kind: Kind
  depth: number
}

/** Dedent method source so cards don't waste width on class-level indentation. */
export function toLines(node: FlowNode): CodeLine[] {
  if (!node.code) return []
  const raw = node.code.replace(/\t/g, '    ').replace(/\r/g, '').split('\n')
  const indent = Math.min(...raw.filter(l => l.trim()).map(l => l.length - l.trimStart().length))
  return raw.map((t, i) => ({ no: node.startLine + i, text: t.slice(Number.isFinite(indent) ? indent : 0) }))
}

const COMPACT_OVER = 18
const SKELETON = /^\s*(if|else|return|throw|foreach|for|while|switch|case|default|try|catch|finally|yield)\b/

/**
 * Long methods render as a flow skeleton: signature, every line that calls something,
 * and control-flow lines; everything between collapses into a "⋯ N lines" row.
 */
export function toRows(node: FlowNode, lines: CodeLine[], full: boolean): Row[] {
  if (node.diff) {
    // An agent change is shown in full, with removed lines in place, so nothing is hidden in a gap.
    const rows: Row[] = []
    const removedAfter = new Map(node.diff.removed.map(r => [r.after, r.lines]))
    const pushRemoved = (after: number) => (removedAfter.get(after) ?? []).forEach((del, i) => rows.push({ del, after, i }))
    pushRemoved(node.startLine - 1)
    for (const l of lines) {
      rows.push(l)
      pushRemoved(l.no)
    }
    return rows
  }
  if (full || lines.length <= COMPACT_OVER) return lines
  const callLines = new Set(node.children.map(c => c.callLine))
  const sigEnd = Math.min(3, lines.findIndex(l => /[{]\s*$|=>/.test(l.text)))
  const rows: Row[] = []
  let gapFrom = -1
  lines.forEach((l, i) => {
    const keep = i <= Math.max(sigEnd, 0) || i === lines.length - 1 || callLines.has(l.no) || SKELETON.test(l.text)
    if (keep) {
      if (gapFrom >= 0) rows.push({ gap: i - gapFrom, from: lines[gapFrom].no })
      gapFrom = -1
      rows.push(l)
    } else if (gapFrom < 0) gapFrom = i
  })
  return rows
}

/** Extra room while a card is being edited: a few spare lines plus the save bar. */
export const EDIT_EXTRA = LINE_H * 6 + 34
/** The Keep/Undo bar under a card the agent changed. */
export const REVIEW_H = 32

/** Widest an editing card may be: the canvas is at 100% while editing and cannot pan, so it must fit. */
let editMaxW = 900
export function setEditMaxWidth(w: number) {
  editMaxW = Math.max(300, Math.min(900, w))
}

/** Database card body: the query line, up to SCHEMA_MAX columns, a "more" row and the relations line. */
export const SCHEMA_ROW = 20
export const SCHEMA_MAX = 10
export const SCHEMA_OPS_H = 30

function schemaSize(node: FlowNode) {
  const s = node.schema!
  const cols = Math.min(s.columns.length, SCHEMA_MAX) + (s.columns.length > SCHEMA_MAX ? 1 : 0)
  return { w: 360, h: HEADER_H + SCHEMA_OPS_H + cols * SCHEMA_ROW + (s.relations.length ? 26 : 0) + 8 }
}

function cardSize(lines: CodeLine[], rows: Row[], editing = false, review = false, node?: FlowNode, chipsH = 0) {
  if (node?.schema) return schemaSize(node)
  if (!lines.length) return { w: 260, h: HEADER_H }
  const longest = Math.max(...lines.map(l => l.text.length))
  return {
    w: editing ? Math.min(editMaxW, Math.max(560, longest * CHAR_W + 70)) : Math.min(720, Math.max(320, longest * CHAR_W + 70)),
    h: HEADER_H + chipsH + (editing ? lines.length : rows.length) * LINE_H + CODE_PAD * 2 + (editing ? EDIT_EXTRA : review ? REVIEW_H : 0),
  }
}

/** Which card is in edit mode: the one that was clicked, not every instance of the same method. Keys are renumbered on a reload, so file and start line guard against a reused key. */
export type EditTarget = { key: string; file: string; startLine: number } | null
const isEditing = (n: FlowNode, e: EditTarget) => !!e && n.key === e.key && n.file === e.file && n.startLine === e.startLine

/** Y offset (within the card) of the row that makes a call. Ambiguous/leaf parents use the header. `chipsH`: the type chips between the header and the code. */
export function callY(rows: Row[], callLine: number, chipsH = 0) {
  const idx = rows.findIndex(r => 'no' in r && (r as CodeLine).no === callLine)
  if (idx < 0) return HEADER_H / 2
  return HEADER_H + chipsH + CODE_PAD + idx * LINE_H + LINE_H / 2
}

/** The type chips a card shows: only a card with a method's source, and not while it is being edited (the editor takes the space). */
function cardChips(node: FlowNode, lines: CodeLine[], editing: boolean, view: ChipsView) {
  return lines.length && !editing && !node.schema ? chipsFor(node, view) : undefined
}

/**
 * Left-to-right containment layout: a method's card sits at the left of its frame,
 * its callees are laid out (recursively, each in their own frame) to the right,
 * so "what this calls" is literally inside "this".
 */
export function layout(root: FlowNode, hidden: Set<string>, full: Set<string>, selectedKey: string | null, touched: Set<string> = new Set(), editing: EditTarget = null, chips: ChipsView = NO_CHIPS) {
  const frames: Node[] = []
  const cards: Node[] = []
  const edges: Edge[] = []

  function place(node: FlowNode, x: number, y: number, depth: number): { w: number; h: number } {
    const lines = toLines(node)
    const ed = isEditing(node, editing)
    const rows = toRows(node, lines, full.has(node.key) || ed)
    const tc = cardChips(node, lines, ed, chips)
    const { w, h } = cardSize(lines, rows, ed, !!node.diff, node, tc?.h ?? 0)
    const visible = node.children.filter(c => !hidden.has(c.node.key))
    const hasFrame = visible.length > 0
    const cardX = hasFrame ? x + PAD : x
    const cardY = hasFrame ? y + PAD : y

    cards.push({
      id: node.key,
      type: 'card',
      position: { x: cardX, y: cardY },
      style: { width: w, height: h },
      zIndex: 1000,
      data: {
        node,
        lines,
        rows,
        full: full.has(node.key),
        compactable: lines.length > COMPACT_OVER,
        selected: node.key === selectedKey,
        touched: !!node.file && touched.has(node.file),
        editing: ed,
        calls: node.children.map(edge => ({ edge, hidden: hidden.has(edge.node.key), y: callY(rows, edge.callLine, tc?.h) })),
        chips: tc?.chips,
        chipRows: tc?.rows,
        chipsOpen: tc?.open,
        chipsH: tc?.h ?? 0,
      } satisfies CardData,
    })

    if (!hasFrame) return { w, h }

    let cy = cardY
    let right = cardX + w
    const cx = cardX + w + GAP
    for (const edge of visible) {
      // Pull each callee down to roughly the height of the line that calls it, so arrows stay flat.
      cy = Math.max(cy, cardY + callY(rows, edge.callLine, tc?.h) - HEADER_H / 2 - PAD)
      const s = place(edge.node, cx, cy, depth + 1)
      cy += s.h + VGAP
      right = Math.max(right, cx + s.w)

      const color = KIND_COLOR[edge.edgeKind === 'mediator' ? 'handler' : edge.edgeKind === 'db' ? 'db' : edge.node.kind]
      edges.push({
        id: `e-${node.key}-${edge.node.key}`,
        source: node.key,
        sourceHandle: `h-${edge.node.key}`,
        target: edge.node.key,
        targetHandle: 'in',
        type: 'smoothstep',
        zIndex: 1001,
        animated: edge.edgeKind === 'mediator' || edge.edgeKind === 'http' || edge.edgeKind === 'message',
        // A database edge is a guess when the table is named by a naming default or a raw SQL string, not by the ORM's metadata.
        label: edge.edgeKind === 'mediator' ? 'MediatR.Send' : edge.edgeKind === 'impl' ? 'impl' : edge.edgeKind === 'http' ? 'HTTP?' : edge.edgeKind === 'message' ? 'topic?' : edge.edgeKind === 'db' && edge.guess ? 'table?' : undefined,
        labelStyle: { fill: color, fontSize: 10.5, fontWeight: 500 },
        labelBgStyle: { fill: 'var(--fl-canvas)' },
        style: { stroke: color, strokeWidth: 1.4, strokeDasharray: edge.edgeKind === 'impl' || edge.edgeKind === 'http' || edge.edgeKind === 'message' || (edge.edgeKind === 'db' && edge.guess) ? '5 4' : undefined },
      })
    }

    const fw = right - x + PAD
    const fh = Math.max(cardY + h, cy - VGAP) - y + PAD
    frames.push({
      id: `f-${node.key}`,
      type: 'frame',
      position: { x, y },
      style: { width: fw, height: fh },
      zIndex: depth,
      selectable: false,
      data: { kind: node.kind, depth } satisfies FrameData,
    })
    return { w: fw, h: fh }
  }

  place(root, 0, 0, 0)
  return { nodes: [...frames, ...cards], edges }
}

/** Initially show controller → handler → service, keep deeper calls folded. */
export function initialHidden(root: FlowNode, openDepth = 2): Set<string> {
  const hidden = new Set<string>()
  const walk = (n: FlowNode, d: number) =>
    n.children.forEach(c => {
      if (d >= openDepth) hidden.add(c.node.key)
      walk(c.node, d + 1)
    })
  walk(root, 0)
  return hidden
}

/**
 * Reverse flow, drawn to the LEFT of the root card that `layout` placed at (0,0): each method's callers
 * stack in the column before it, with an arrow from the caller's call line into the method it calls.
 */
export function layoutCallers(up: FlowNode, rootKey: string, rootY: number, hidden: Set<string>, full: Set<string>, selectedKey: string | null, touched: Set<string> = new Set(), editing: EditTarget = null, chips: ChipsView = NO_CHIPS) {
  const cards: Node[] = []
  const edges: Edge[] = []

  function place(callee: FlowNode, calleeKey: string, calleeX: number, top: number): number {
    let cy = top
    for (const edge of callee.children) {
      if (hidden.has(edge.node.key)) continue
      const caller = edge.node
      const lines = toLines(caller)
      const ed = isEditing(caller, editing)
      const rows = toRows(caller, lines, full.has(caller.key) || ed)
      const tc = cardChips(caller, lines, ed, chips)
      const { w, h } = cardSize(lines, rows, ed, !!caller.diff, caller, tc?.h ?? 0)
      const x = calleeX - GAP - w
      const visibleCallers = caller.children.filter(c => !hidden.has(c.node.key)).length
      cards.push({
        id: caller.key,
        type: 'card',
        position: { x, y: cy },
        style: { width: w, height: h },
        zIndex: 1000,
        data: {
          node: { ...caller, children: [] },
          lines,
          rows,
          full: full.has(caller.key),
          compactable: lines.length > 18,
          selected: caller.key === selectedKey,
          touched: !!caller.file && touched.has(caller.file),
          editing: ed,
          // The only outgoing arrow of a caller card is the call into `callee`.
          calls: [{ edge: { ...edge, node: { ...callee, key: calleeKey } }, hidden: false, y: callY(rows, edge.callLine, tc?.h) }],
          callers: caller.children.length,
          callersHidden: caller.children.length - visibleCallers,
          chips: tc?.chips,
          chipRows: tc?.rows,
          chipsOpen: tc?.open,
          chipsH: tc?.h ?? 0,
        } satisfies CardData,
      })
      const color = KIND_COLOR[edge.edgeKind === 'mediator' ? 'handler' : caller.kind]
      edges.push({
        id: `u-${caller.key}-${calleeKey}`,
        source: caller.key,
        sourceHandle: `h-${calleeKey}`,
        target: calleeKey,
        targetHandle: 'in',
        type: 'smoothstep',
        zIndex: 1001,
        animated: edge.edgeKind === 'mediator' || edge.edgeKind === 'http' || edge.edgeKind === 'message',
        label: edge.edgeKind === 'mediator' ? 'MediatR.Send' : edge.edgeKind === 'impl' ? 'interface' : edge.edgeKind === 'http' ? 'HTTP?' : edge.edgeKind === 'message' ? 'topic?' : undefined,
        labelStyle: { fill: color, fontSize: 10.5, fontWeight: 500 },
        labelBgStyle: { fill: 'var(--fl-canvas)' },
        style: { stroke: color, strokeWidth: 1.4, strokeDasharray: '2 4' },
      })
      const below = place(caller, caller.key, x, cy)
      cy = Math.max(cy + h, below) + VGAP
    }
    return cy
  }

  place(up, rootKey, 0, rootY)
  return { nodes: cards, edges }
}
