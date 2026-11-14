// The board's pure core: which nodes are visible (collapsed groups become one summary node), where each goes (a small
// layered layout, recursive for nested groups) and which edges connect what is visible. No DOM, no React: the renderer
// draws what this returns, the SVG export draws the same, and tests run it directly.
import type { BoardEdge, BoardGroup, BoardMember, BoardNode, BoardSpec, ChangeMark, EdgeKind, EdgeLine } from '../../../board-canvas/spec'

export interface Box { x: number; y: number; w: number; h: number }

export const HEADER_H = 44
export const DETAIL_H = 14
export const ROW_H = 18
export const CARD_PAD = 6
export const GROUP_HEAD = 28
export const GROUP_PAD = 14
export const SUMMARY_W = 210
export const SUMMARY_H = 66
/** Members shown on a card before "+N more". */
export const MAX_ROWS = 14

const GAP_MAIN = 84
const GAP_CROSS = 22
const WRAP = 2600
const LABEL_W = 7.4
const MEMBER_W = 6.7

export interface VNode {
  /** A board node id, or `group:<id>` for a collapsed group. */
  id: string
  node?: BoardNode
  group?: BoardGroup
  /** For a collapsed group: how many nodes it holds and of which kinds. */
  count?: number
  kinds?: Record<string, number>
  /** Absolute box. */
  box: Box
  /** Relative to the parent container (what React Flow wants). */
  rel: { x: number; y: number }
  parent?: string
  /** Members drawn (after the cap), and how many were cut. */
  rows: BoardMember[]
  more: number
}

export interface VGroup {
  id: string
  group: BoardGroup
  box: Box
  rel: { x: number; y: number }
  parent?: string
  count: number
  depth: number
}

export interface VEdge {
  key: string
  from: string
  to: string
  kind?: EdgeKind
  label?: string
  fromCard?: string
  toCard?: string
  order?: number
  style?: EdgeLine
  async?: boolean
  guard?: string
  change?: ChangeMark
  /** Edges merged into this one (more than 1 when they went through a collapsed group). */
  count: number
  /** Row of the source card's member list that holds this reference. */
  fromRow?: number
}

export interface Layout {
  nodes: VNode[]
  groups: VGroup[]
  edges: VEdge[]
  bounds: Box
  /** Visible id each board node is drawn as. */
  rep: Map<string, string>
  /** Notes pinned to a visible node or to an edge (its key), for the bubbles. */
  callouts: { text: string; node?: string; edge?: string }[]
}

export interface LayoutOptions {
  direction: 'LR' | 'TB'
  members: boolean
  /** Nodes whose full member list is shown. */
  expanded: ReadonlySet<string>
  isCollapsed: (group: BoardGroup) => boolean
}

export const groupNodeId = (id: string) => `group:${id}`

/** The line under a label: the C4 technology in brackets, then the detail. */
export const detailOf = (n: BoardNode): string => [n.tech ? `[${n.tech}]` : '', n.detail ?? ''].filter(Boolean).join(' ')

/** Pseudo-states of a state diagram: a dot, a ring with a dot, a diamond. They carry no text; the label is their tooltip. */
export const MARK_SIZE: Record<string, number> = { initial: 24, final: 28, choice: 34 }

/** Text → width in px with the fonts of the card. */
export function cardSize(n: BoardNode, rows: BoardMember[], more: number, members: boolean): { w: number; h: number } {
  const mark = n.shape ? MARK_SIZE[n.shape] : undefined
  if (mark) return { w: mark, h: mark }
  const detail = detailOf(n)
  let w = n.label.length * LABEL_W + 40
  if (detail) {
    w = Math.max(w, Math.min(detail.length, 44) * 6.2 + 28)
  }
  if (members) {
    for (const m of rows) {
      w = Math.max(w, m.text.length * MEMBER_W + 44)
    }
  }
  w = Math.min(380, Math.max(168, Math.ceil(w)))
  const head = HEADER_H + (detail ? DETAIL_H : 0)
  const rowCount = members ? rows.length + (more ? 1 : 0) : 0
  return { w, h: head + (rowCount ? rowCount * ROW_H + CARD_PAD * 2 : 0) }
}

/** Where, in a card, the centre of member row `i` is (relative to the card's top). */
export const rowCentre = (n: BoardNode, i: number) => HEADER_H + (detailOf(n) ? DETAIL_H : 0) + CARD_PAD + i * ROW_H + ROW_H / 2

/** True when following `parent` from this group comes back to it. */
function isCycle(groups: Map<string, BoardGroup>, g: BoardGroup): boolean {
  const seen = new Set<string>()
  for (let id = g.parent; id && groups.has(id); id = groups.get(id)!.parent) {
    if (id === g.id) return true
    if (seen.has(id)) return false
    seen.add(id)
  }
  return false
}

export function groupDepth(groups: Map<string, BoardGroup>, id: string): number {
  let d = 0
  const seen = new Set<string>()
  for (let g = groups.get(id); g?.parent && groups.has(g.parent) && !seen.has(g.id); g = groups.get(g.parent)) {
    seen.add(g.id)
    d++
  }
  return d
}

interface Item { id: string; w: number; h: number }

/**
 * Layered layout of one level: items placed in layers along the main axis (x for LR, y for TB), ordered inside a layer by
 * barycenter sweeps, then pulled towards their neighbours. Items with no edge at this level are packed into a grid below.
 * Returns the top-left of each item and the size of the whole.
 */
export function layoutLevel(items: Item[], edges: [string, string][], dir: 'LR' | 'TB'): { pos: Map<string, { x: number; y: number }>; w: number; h: number } {
  const lr = dir === 'LR'
  const index = new Map(items.map((it, i) => [it.id, i]))
  const out: number[][] = items.map(() => [])
  const inn: number[][] = items.map(() => [])
  const seenEdge = new Set<string>()
  for (const [a, b] of edges) {
    const i = index.get(a)
    const j = index.get(b)
    if (i === undefined || j === undefined || i === j || seenEdge.has(`${i}>${j}`)) {
      continue
    }
    seenEdge.add(`${i}>${j}`)
    out[i].push(j)
    inn[j].push(i)
  }
  const connected = items.map((_, i) => out[i].length + inn[i].length > 0)
  const nodes = items.map((_, i) => i).filter(i => connected[i])
  const pos = new Map<string, { x: number; y: number }>()
  const main = (i: number) => (lr ? items[i].w : items[i].h)
  const cross = (i: number) => (lr ? items[i].h : items[i].w)
  let width = 0
  let height = 0

  if (nodes.length) {
    // Break cycles: edges that close a cycle in a depth-first walk run backwards.
    const state = new Map<number, 0 | 1 | 2>()
    const back = new Set<string>()
    const visit = (root: number) => {
      const stack: [number, number][] = [[root, 0]]
      state.set(root, 1)
      while (stack.length) {
        const top = stack[stack.length - 1]
        const [v, k] = top
        if (k < out[v].length) {
          top[1]++
          const w = out[v][k]
          const s = state.get(w) ?? 0
          if (s === 1) {
            back.add(`${v}>${w}`)
          } else if (s === 0) {
            state.set(w, 1)
            stack.push([w, 0])
          }
        } else {
          state.set(v, 2)
          stack.pop()
        }
      }
    }
    // Start from sources so a cycle is cut at its entry, not in the middle.
    for (const i of nodes.filter(i => inn[i].length === 0)) {
      if (!state.get(i)) visit(i)
    }
    for (const i of nodes) {
      if (!state.get(i)) visit(i)
    }
    const succ: number[][] = items.map(() => [])
    const pred: number[][] = items.map(() => [])
    for (const v of nodes) {
      for (const w of out[v]) {
        const [a, b] = back.has(`${v}>${w}`) ? [w, v] : [v, w]
        succ[a].push(b)
        pred[b].push(a)
      }
    }
    // Longest-path layering over the acyclic graph (Kahn order).
    const layer = new Map<number, number>()
    const indeg = new Map(nodes.map(v => [v, pred[v].length]))
    const queue = nodes.filter(v => indeg.get(v) === 0)
    for (const v of queue) layer.set(v, 0)
    for (let q = 0; q < queue.length; q++) {
      const v = queue[q]
      for (const w of succ[v]) {
        layer.set(w, Math.max(layer.get(w) ?? 0, (layer.get(v) ?? 0) + 1))
        indeg.set(w, (indeg.get(w) ?? 1) - 1)
        if (indeg.get(w) === 0) queue.push(w)
      }
    }
    for (const v of nodes) if (!layer.has(v)) layer.set(v, 0)
    // Sinks sit next to what points at them, not at the far end.
    let layers: number[][] = []
    for (const v of nodes) (layers[layer.get(v)!] ??= []).push(v)
    layers = layers.filter(Boolean)
    // A layer too long for the screen wraps into several columns.
    const wrapped: number[][] = []
    for (const l of layers) {
      let run: number[] = []
      let len = 0
      for (const v of l) {
        if (run.length && len + cross(v) > WRAP) {
          wrapped.push(run)
          run = []
          len = 0
        }
        run.push(v)
        len += cross(v) + GAP_CROSS
      }
      wrapped.push(run)
    }
    layers = wrapped
    const layerOf = new Map<number, number>()
    layers.forEach((l, li) => l.forEach(v => layerOf.set(v, li)))
    const centre = new Map<number, number>()
    const place = (l: number[], desired: Map<number, number>) => {
      // Keep the order; shift each item as near its desired centre as the spacing allows (pool-adjacent-violators).
      let off = 0
      const a: number[] = []
      const s: number[] = []
      for (const v of l) {
        s.push(off)
        a.push((desired.get(v) ?? centre.get(v) ?? 0) - cross(v) / 2 - off)
        off += cross(v) + GAP_CROSS
      }
      const blocks: { sum: number; n: number }[] = []
      for (const x of a) {
        blocks.push({ sum: x, n: 1 })
        while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
          const b = blocks.pop()!
          const p = blocks[blocks.length - 1]
          p.sum += b.sum
          p.n += b.n
        }
      }
      let k = 0
      for (const b of blocks) {
        for (let i = 0; i < b.n; i++, k++) centre.set(l[k], b.sum / b.n + s[k] + cross(l[k]) / 2)
      }
    }
    // Initial positions: stacked in order.
    layers.forEach(l => place(l, new Map()))
    const neighbours = (v: number, li: number, side: 'up' | 'down') => {
      return (side === 'up' ? pred[v] : succ[v]).filter(w => layerOf.get(w) !== li)
    }
    const mean = (v: number, li: number, side: 'up' | 'down') => {
      const ns = neighbours(v, li, side)
      return ns.length ? ns.reduce((t, w) => t + (centre.get(w) ?? 0), 0) / ns.length : undefined
    }
    for (let sweep = 0; sweep < 6; sweep++) {
      const down = sweep % 2 === 0
      const order = down ? layers.map((_, i) => i) : layers.map((_, i) => layers.length - 1 - i)
      for (const li of order) {
        const l = layers[li]
        const bary = new Map<number, number>()
        l.forEach((v, i) => bary.set(v, mean(v, li, down ? 'up' : 'down') ?? (centre.get(v) ?? i)))
        // A stable sort by barycenter; items with no neighbour keep their place relative to each other.
        l.sort((p, q) => (bary.get(p)! - bary.get(q)!) || (index.get(items[p].id)! - index.get(items[q].id)!))
        place(l, bary)
      }
    }
    // Final pass: pull towards both sides.
    for (let pass = 0; pass < 3; pass++) {
      for (const li of layers.map((_, i) => i)) {
        const desired = new Map<number, number>()
        for (const v of layers[li]) {
          const ns = [...pred[v], ...succ[v]].filter(w => layerOf.get(w) !== li)
          if (ns.length) desired.set(v, ns.reduce((t, w) => t + (centre.get(w) ?? 0), 0) / ns.length)
        }
        place(layers[li], desired)
      }
    }
    let minC = Infinity
    for (const v of nodes) minC = Math.min(minC, centre.get(v)! - cross(v) / 2)
    let m = 0
    layers.forEach(l => {
      const thick = Math.max(...l.map(main))
      for (const v of l) {
        const c = centre.get(v)! - cross(v) / 2 - minC
        const mm = m + (thick - main(v)) / 2
        pos.set(items[v].id, lr ? { x: mm, y: c } : { x: c, y: mm })
        if (lr) height = Math.max(height, c + cross(v))
        else width = Math.max(width, c + cross(v))
      }
      m += thick + GAP_MAIN
    })
    if (lr) width = Math.max(0, m - GAP_MAIN)
    else height = Math.max(0, m - GAP_MAIN)
  }

  const loose = items.map((_, i) => i).filter(i => !connected[i])
  if (loose.length) {
    // A grid below the layered part, about as wide as it or a screen.
    const target = Math.max(width, 1100)
    let x = 0
    let y = nodes.length ? height + GAP_MAIN * 0.6 : 0
    let rowH = 0
    for (const i of loose) {
      if (x > 0 && x + items[i].w > target) {
        x = 0
        y += rowH + GAP_CROSS
        rowH = 0
      }
      pos.set(items[i].id, { x, y })
      x += items[i].w + GAP_CROSS
      rowH = Math.max(rowH, items[i].h)
      width = Math.max(width, x - GAP_CROSS)
    }
    height = y + rowH
  }
  return { pos, w: width, h: height }
}

/** Builds the visible model of a board: groups, cards, summaries, edges and their positions. */
export function buildLayout(spec: BoardSpec, o: LayoutOptions): Layout {
  const groups = new Map<string, BoardGroup>()
  for (const g of spec.groups ?? []) groups.set(g.id, g)
  // A group in a cycle of parents (or with an unknown parent) is drawn at the top: its cards must not be lost.
  const parents = new Map<string, string | undefined>()
  for (const g of groups.values()) {
    parents.set(g.id, g.parent && g.parent !== g.id && groups.has(g.parent) && !isCycle(groups, g) ? g.parent : undefined)
  }
  const parentOf = (g: BoardGroup | undefined) => (g ? parents.get(g.id) : undefined)
  const chainOf = (gid: string | undefined): string[] => {
    // From the outermost group down to gid; a cycle of parents is cut where it repeats.
    const chain: string[] = []
    const seen = new Set<string>()
    for (let id = gid && groups.has(gid) ? gid : undefined; id && !seen.has(id); id = parentOf(groups.get(id))) {
      seen.add(id)
      chain.unshift(id)
    }
    return chain
  }
  const nodeById = new Map(spec.nodes.map(n => [n.id, n]))
  const nodeChain = new Map<string, string[]>()
  for (const n of spec.nodes) nodeChain.set(n.id, chainOf(n.group))
  // Which group (if any) swallows a node: the outermost collapsed one on its chain.
  const swallowedBy = (chain: string[]) => chain.find(id => o.isCollapsed(groups.get(id)!))
  const counts = new Map<string, number>()
  const kindsIn = new Map<string, Record<string, number>>()
  for (const n of spec.nodes) {
    for (const id of nodeChain.get(n.id)!) {
      counts.set(id, (counts.get(id) ?? 0) + 1)
      const k = kindsIn.get(id) ?? {}
      k[n.kind ?? 'class'] = (k[n.kind ?? 'class'] ?? 0) + 1
      kindsIn.set(id, k)
    }
  }

  // Cards and summaries.
  const vnodes = new Map<string, VNode>()
  const rep = new Map<string, string>()
  const items = new Map<string, Item>()
  for (const n of spec.nodes) {
    const chain = nodeChain.get(n.id)!
    const sw = swallowedBy(chain)
    if (sw) {
      const id = groupNodeId(sw)
      rep.set(n.id, id)
      if (!vnodes.has(id)) {
        const g = groups.get(sw)!
        vnodes.set(id, { id, group: g, count: counts.get(sw), kinds: kindsIn.get(sw), box: { x: 0, y: 0, w: SUMMARY_W, h: SUMMARY_H }, rel: { x: 0, y: 0 }, rows: [], more: 0, parent: parentOf(g) })
        items.set(id, { id, w: SUMMARY_W, h: SUMMARY_H })
      }
      continue
    }
    rep.set(n.id, n.id)
    const all = o.members ? n.members ?? [] : []
    const cap = o.expanded.has(n.id) ? all.length : MAX_ROWS
    const rows = all.slice(0, cap)
    const more = all.length - rows.length
    const size = cardSize(n, rows, more, o.members)
    // The states of a state diagram are rounded unless the agent chose a shape.
    const drawn = spec.kind === 'state' && !n.shape ? { ...n, shape: 'round' as const } : n
    vnodes.set(n.id, { id: n.id, node: drawn, box: { x: 0, y: 0, ...size }, rel: { x: 0, y: 0 }, rows, more, parent: chain.length ? chain[chain.length - 1] : undefined })
    items.set(n.id, { id: n.id, w: size.w, h: size.h })
  }

  // Containers: the root ('') and every expanded group that holds something visible.
  const members = new Map<string, string[]>() // container -> child item ids (cards, summaries, subgroup containers)
  const add = (container: string, id: string) => {
    const l = members.get(container) ?? []
    if (!l.includes(id)) l.push(id)
    members.set(container, l)
  }
  const containerOf = new Map<string, string>() // visible card/summary/group-container id -> container it sits in
  const gid = (id: string) => ` g:${id}`
  const fromGid = (c: string) => c.slice(3)
  for (const v of vnodes.values()) {
    if (v.group) {
      // A summary sits in the container of the group's parent (the parent is expanded, or the summary would be swallowed).
      const parent = parentOf(v.group)
      const c = parent ? gid(parent) : ''
      add(c, v.id)
      containerOf.set(v.id, c)
    } else {
      const chain = nodeChain.get(v.id)!
      const c = chain.length ? gid(chain[chain.length - 1]) : ''
      add(c, v.id)
      containerOf.set(v.id, c)
    }
  }
  // Expanded groups that hold visible things get a container, linked up their parent chain.
  const containerIds = new Set<string>([''])
  const linkUp = (c: string) => {
    while (c && !containerIds.has(c)) {
      containerIds.add(c)
      const g = groups.get(fromGid(c))
      const p = parentOf(g)
      const pc = p ? gid(p) : ''
      add(pc, c)
      containerOf.set(c, pc)
      c = pc
    }
  }
  for (const c of [...members.keys()]) linkUp(c)

  // Edges, mapped to what is visible.
  const edges = new Map<string, VEdge>()
  const memberTaken = new Map<string, number>()
  for (const e of spec.edges) {
    const a = rep.get(e.from)
    const b = rep.get(e.to)
    if (!a || !b) continue
    const cardA = vnodes.get(a)
    if (a === b && (!cardA?.node || cardA.group)) continue // inside one collapsed group
    let fromRow: number | undefined
    if (cardA?.node && !cardA.group && o.members) {
      const cands = cardA.rows.map((m, i) => ({ m, i })).filter(x => x.m.ref !== undefined && (x.m.ref === e.to || x.m.ref === nodeById.get(e.to)?.label))
      if (cands.length) {
        const byLabel = e.label ? cands.find(x => new RegExp(`(^|[^\\w])${e.label!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`).test(x.m.text)) : undefined
        const takenKey = `${e.from}>${e.to}`
        const k = memberTaken.get(takenKey) ?? 0
        const pick = byLabel ?? cands[Math.min(k, cands.length - 1)]
        if (!byLabel) memberTaken.set(takenKey, k + 1)
        fromRow = pick.i
      }
    }
    const merged = a !== e.from || b !== e.to
    const key = `${a}|${b}|${e.kind ?? ''}|${merged ? '' : e.label ?? ''}|${fromRow ?? ''}|${merged ? '' : `${e.order ?? ''}|${e.guard ?? ''}|${e.style ?? ''}|${e.async ? 'a' : ''}|${e.change ?? ''}`}`
    const prev = edges.get(key)
    if (prev) {
      prev.count++
      continue
    }
    edges.set(key, { key, from: a, to: b, kind: e.kind, label: merged ? undefined : e.label, fromCard: merged ? undefined : e.fromCard, toCard: merged ? undefined : e.toCard, order: merged ? undefined : e.order, style: merged ? undefined : e.style, async: merged ? undefined : e.async, guard: merged ? undefined : e.guard, change: e.change, count: 1, fromRow })
  }
  const vedges = [...edges.values()]

  // Lift each edge to the level where its ends sit in different children of one container.
  const ancestors = (id: string) => {
    const path: string[] = []
    for (let c: string | undefined = id; c !== undefined; c = containerOf.get(c)) {
      path.unshift(c)
      if (c === '') break
    }
    return path // '' ... id
  }
  const levelEdges = new Map<string, [string, string][]>()
  for (const e of vedges) {
    const pa = ancestors(e.from)
    const pb = ancestors(e.to)
    let i = 0
    while (i < pa.length - 1 && i < pb.length - 1 && pa[i + 1] === pb[i + 1] && pa[i + 1] !== e.from && pb[i + 1] !== e.to) i++
    const lca = pa[i]
    const l = levelEdges.get(lca) ?? []
    l.push([pa[i + 1] ?? e.from, pb[i + 1] ?? e.to])
    levelEdges.set(lca, l)
  }

  // Lay out bottom-up.
  const placed = new Map<string, { pos: Map<string, { x: number; y: number }>; w: number; h: number }>()
  const sizeOf = new Map<string, Item>(items)
  const depthOfContainer = (c: string) => (c ? groupDepth(groups, fromGid(c)) + 1 : 0)
  const order = [...containerIds].sort((a, b) => depthOfContainer(b) - depthOfContainer(a))
  for (const c of order) {
    const kids = (members.get(c) ?? []).map(id => sizeOf.get(id)).filter((x): x is Item => !!x)
    const res = layoutLevel(kids, levelEdges.get(c) ?? [], o.direction)
    placed.set(c, res)
    if (c) {
      sizeOf.set(c, { id: c, w: Math.max(res.w + GROUP_PAD * 2, 200), h: res.h + GROUP_HEAD + GROUP_PAD * 2 })
    }
  }
  // Absolute positions, top-down.
  const vgroups: VGroup[] = []
  const abs = new Map<string, { x: number; y: number }>([['', { x: 0, y: 0 }]])
  const walk = (c: string, depth: number) => {
    const here = abs.get(c)!
    const res = placed.get(c)!
    const pad = c ? { x: GROUP_PAD, y: GROUP_HEAD + GROUP_PAD } : { x: 0, y: 0 }
    for (const id of members.get(c) ?? []) {
      const p = res.pos.get(id)
      const it = sizeOf.get(id)
      if (!p || !it) continue
      const rel = { x: p.x + pad.x, y: p.y + pad.y }
      const a = { x: here.x + rel.x, y: here.y + rel.y }
      abs.set(id, a)
      if (containerIds.has(id)) {
        const g = groups.get(fromGid(id))!
        vgroups.push({ id: g.id, group: g, box: { ...a, w: it.w, h: it.h }, rel, parent: c ? fromGid(c) : undefined, count: counts.get(g.id) ?? 0, depth })
        walk(id, depth + 1)
      } else {
        const v = vnodes.get(id)!
        v.box = { x: a.x, y: a.y, w: it.w, h: it.h }
        v.rel = rel
        v.parent = c ? fromGid(c) : undefined
      }
    }
  }
  walk('', 0)
  const root = placed.get('')!
  const nodes = [...vnodes.values()].filter(v => abs.has(v.id))
  const drawn = vedges.filter(e => abs.has(e.from) && abs.has(e.to))
  const callouts: Layout['callouts'] = []
  for (const c of spec.callouts ?? []) {
    if (c.node) {
      const id = rep.get(c.node)
      if (id && abs.has(id)) callouts.push({ text: c.text, node: id })
    } else if (c.edge) {
      const a = rep.get(c.edge[0])
      const b = rep.get(c.edge[1])
      const hit = drawn.find(e => e.from === a && e.to === b)
      if (hit) callouts.push({ text: c.text, edge: hit.key })
    }
  }
  return { nodes, groups: vgroups, edges: drawn, bounds: { x: 0, y: 0, w: root.w, h: root.h }, rep, callouts }
}

/** Ids of the nodes a search matches: every word must appear in the label, detail, kind, group, file or a member. */
export function matchNodes(spec: BoardSpec, query: string): Set<string> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const out = new Set<string>()
  if (!words.length) return out
  const groupLabel = new Map((spec.groups ?? []).map(g => [g.id, g.label.toLowerCase()]))
  for (const n of spec.nodes) {
    const hay = [n.label, n.id, n.detail ?? '', n.kind ?? '', n.group ? groupLabel.get(n.group) ?? '' : '', ...(n.members ?? []).map(m => m.text)].join('\n').toLowerCase()
    if (words.every(w => hay.includes(w))) out.add(n.id)
  }
  return out
}

/** Neighbours (both directions) over the visible edges. */
export function adjacency(edges: VEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, new Set())
    if (!adj.has(e.to)) adj.set(e.to, new Set())
    adj.get(e.from)!.add(e.to)
    adj.get(e.to)!.add(e.from)
  }
  return adj
}

/** Groups to expand so that these nodes are visible (every ancestor of each). */
export function groupsHolding(spec: BoardSpec, ids: Iterable<string>): Set<string> {
  const groups = new Map((spec.groups ?? []).map(g => [g.id, g]))
  const byId = new Map(spec.nodes.map(n => [n.id, n]))
  const out = new Set<string>()
  for (const id of ids) {
    const seen = new Set<string>()
    for (let g = byId.get(id)?.group; g && groups.has(g) && !seen.has(g); g = groups.get(g)?.parent) {
      seen.add(g)
      out.add(g)
    }
  }
  return out
}
