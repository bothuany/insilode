// Board steps: the walk-through an agent attaches to a board (`steps`), the route it highlights (`highlight`) and, when it sent
// neither, the walk that edge `order` already is. Played through the tour player's reducer and bar (ui/src/tour); this file only
// turns a board into a tour and says what is lit at each step. Pure: no DOM, no React.
import type { Scene } from '../../../board-canvas/canvas'
import type { Tour, TourStep } from '../types'
import type { BoardSpec, BoardStep } from '../../../board-canvas/spec'

/** What stays at full strength while a step (or a route) is showing; everything else fades. */
export interface StepLit {
  nodes: ReadonlySet<string>
  /** `from>to` keys of board edges. */
  edges: ReadonlySet<string>
}

export interface Steps {
  steps: BoardStep[]
  /** Made from edge `order`, not sent by the agent: offered, never started by itself. */
  derived: boolean
}

export const edgeKey = (from: string, to: string) => `${from}>${to}`

/** The agent's steps; else one step per ordered edge, in order, when at least two edges carry an `order`. */
export function stepsOf(spec: BoardSpec): Steps {
  if (spec.steps?.length) return { steps: spec.steps, derived: false }
  const ordered = spec.edges.filter(e => e.order !== undefined).sort((a, b) => a.order! - b.order!)
  if (ordered.length < 2) return { steps: [], derived: false }
  const label = new Map(spec.nodes.map(n => [n.id, n.label]))
  return {
    derived: true,
    steps: ordered.slice(0, 40).map((e): BoardStep => ({
      title: e.label || `${label.get(e.from) ?? e.from} → ${label.get(e.to) ?? e.to}`,
      caption: `${label.get(e.from) ?? e.from} → ${label.get(e.to) ?? e.to}${e.label ? `: ${e.label}` : ''}`,
      nodes: [e.from, e.to],
      edges: [[e.from, e.to]],
    })),
  }
}

/** A stable name for a set of steps: a redraw with the same steps does not restart the walk. A canvas step's scene (`show`, `open`, `lit`) is part of it: `show` absent (everything) is not `show: []` (nothing). */
export function stepsSignature(steps: BoardStep[]): string {
  return steps.map(s => `${s.title}\n${s.caption}\n${(s.nodes ?? []).join(',')}\n${(s.edges ?? []).map(e => e.join('>')).join(',')}\n${s.focus ?? ''}\n${s.show ? s.show.join(',') : '*'}\n${(s.open ?? []).join(',')}\n${(s.lit ?? []).join(',')}`).join('\u0001')
}

/** What a canvas step shows, as the sets the painter takes; a step with none of the three, or no step, is the whole board. */
export function sceneOf(step: BoardStep | undefined): Scene {
  return { show: step?.show ? new Set(step.show) : undefined, open: step?.open?.length ? new Set(step.open) : undefined, lit: step?.lit?.length ? new Set(step.lit) : undefined }
}

/** The steps as a tour for the shared player: captions only, the board does the pointing. */
export function tourOf(spec: BoardSpec, steps: BoardStep[], derived: boolean): Tour | undefined {
  if (!steps.length) return undefined
  return {
    id: 'board-steps',
    title: spec.title,
    origin: derived ? 'Message order' : 'Board steps',
    source: 'agent',
    start: 0,
    steps: steps.map((s): TourStep => ({ title: s.title, caption: s.caption, state: 'ok' })),
  }
}

/** What a step lights: its nodes, the ends of its edges, and those edges. A step with neither is an intro or outro: nothing is dimmed. */
export function litOf(step: BoardStep): StepLit | undefined {
  const nodes = new Set(step.nodes ?? [])
  const edges = new Set<string>()
  for (const [a, b] of step.edges ?? []) {
    nodes.add(a)
    nodes.add(b)
    edges.add(edgeKey(a, b))
  }
  return nodes.size ? { nodes, edges } : undefined
}

/** The routes of `highlight` together: their nodes, and the edges between neighbours on a path (either direction). */
export function highlightLit(spec: BoardSpec): StepLit | undefined {
  if (!spec.highlight?.length) return undefined
  const have = new Set(spec.edges.map(e => edgeKey(e.from, e.to)))
  const nodes = new Set<string>()
  const edges = new Set<string>()
  for (const h of spec.highlight) {
    h.path.forEach((id, i) => {
      nodes.add(id)
      const next = h.path[i + 1]
      if (next === undefined) return
      if (have.has(edgeKey(id, next))) edges.add(edgeKey(id, next))
      else if (have.has(edgeKey(next, id))) edges.add(edgeKey(next, id))
    })
  }
  return { nodes, edges }
}

/** The same lit set in the ids the layout draws (a node inside a collapsed group is lit as the group). */
export function litVisible(lit: StepLit, rep: ReadonlyMap<string, string>): StepLit {
  const r = (id: string) => rep.get(id) ?? id
  return {
    nodes: new Set([...lit.nodes].map(r)),
    edges: new Set([...lit.edges].map(k => {
      const i = k.indexOf('>')
      return edgeKey(r(k.slice(0, i)), r(k.slice(i + 1)))
    })),
  }
}

/** Groups to open so a step's nodes are visible: the step's `focus` (a group or a node) and every group around its nodes. */
export function stepOpens(spec: BoardSpec, step: BoardStep): string[] {
  const groups = new Map((spec.groups ?? []).map(g => [g.id, g]))
  const byId = new Map(spec.nodes.map(n => [n.id, n]))
  const out = new Set<string>()
  const climb = (g: string | undefined) => {
    for (const seen = new Set<string>(); g && groups.has(g) && !seen.has(g); g = groups.get(g)?.parent) {
      seen.add(g)
      out.add(g)
    }
  }
  const lit = litOf(step)
  for (const id of lit?.nodes ?? []) climb(byId.get(id)?.group)
  if (step.focus) climb(groups.has(step.focus) ? step.focus : byId.get(step.focus)?.group)
  return [...out]
}
