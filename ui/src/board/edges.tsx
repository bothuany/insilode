// The board's edges, drawn as one SVG that follows the React Flow viewport and sits under the cards. They are not React
// Flow edges: the layout already knows the boxes and the member rows, so each line is routed from those (route.ts),
// leaving a member row for a field reference.
import { memo, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import type { Layout } from './model'
import { cardinalityAt, orderBadge, routeEdge, veeOf, type Route } from './route'
import { edgeText, lineStyle } from './protocol'
import type { ChangeMark, EdgeLine } from '../../../board-canvas/spec'

interface Drawn {
  key: string
  from: string
  to: string
  fromRow?: number
  route: Route
  kind?: string
  label?: string
  fromCard?: string
  toCard?: string
  order?: number
  guard?: string
  style?: EdgeLine
  async?: boolean
  change?: ChangeMark
  count: number
}

export function drawEdges(layout: Layout, direction: 'LR' | 'TB'): Drawn[] {
  const byId = new Map(layout.nodes.map(n => [n.id, n]))
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const total = new Map<string, number>()
  for (const e of layout.edges) total.set(key(e.from, e.to), (total.get(key(e.from, e.to)) ?? 0) + 1)
  const seen = new Map<string, number>()
  const out: Drawn[] = []
  for (const e of layout.edges) {
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to) continue
    const k = key(e.from, e.to)
    const i = seen.get(k) ?? 0
    seen.set(k, i + 1)
    out.push({ key: e.key, from: e.from, to: e.to, fromRow: e.fromRow, route: routeEdge({ from, to, edge: e }, direction, i, total.get(k) ?? 1), kind: e.kind, label: e.label, fromCard: e.fromCard, toCard: e.toCard, order: e.order, guard: e.guard, style: e.style, async: e.async, change: e.change, count: e.count })
  }
  return out
}

type State = 'hot' | 'dim' | 'active' | ''

const EdgePath = memo(function EdgePath({ e, state }: { e: Drawn; state: State }) {
  const st = lineStyle({ kind: e.kind as never, style: e.style, async: e.async, change: e.change })
  const r = e.route
  const card = e.fromCard || e.toCard ? cardinalityAt(r) : undefined
  const label = edgeText(e)
  const badge = e.order !== undefined ? orderBadge(r) : undefined
  return (
    <g className={`be be-${st.color} ${state ? 'be-' + state : ''}`} data-kind={e.kind ?? 'calls'} data-from={e.from} data-to={e.to} data-change={e.change} data-order={e.order}>
      <path className="be-line" d={r.d} strokeDasharray={st.dash} />
      {r.head && <path className={`be-head ${e.async && r.head.kind === 'fill' ? 'vee' : r.head.kind}`} d={e.async && r.head.kind === 'fill' ? veeOf(r) : r.head.d} />}
      {badge && (
        <g className="be-order" transform={`translate(${badge.x} ${badge.y})`}>
          <circle r="8" />
          <text y="3.5" textAnchor="middle">{e.order}</text>
        </g>
      )}
      {label && <text className="be-label" x={r.mid.x} y={r.mid.y - 4} textAnchor="middle">{label}</text>}
      {card && e.fromCard && <text className="be-card" x={card.from.x} y={card.from.y + 3} textAnchor="middle">{e.fromCard}</text>}
      {card && e.toCard && <text className="be-card" x={card.to.x} y={card.to.y + 3} textAnchor="middle">{e.toCard}</text>}
    </g>
  )
})

export function EdgeLayer({ layout, direction, hot, active, lit }: { layout: Layout; direction: 'LR' | 'TB'; hot?: string; active?: { from: string; row: number }; lit?: ReadonlySet<string> }) {
  const t = useStore(s => s.transform)
  const edges = useMemo(() => drawEdges(layout, direction), [layout, direction])
  return (
    <svg className="be-layer" aria-hidden="true">
      <g transform={`translate(${t[0]} ${t[1]}) scale(${t[2]})`}>
        {edges.map(e => {
          const isActive = !!active && e.from === active.from && e.fromRow === active.row
          const state: State = isActive ? 'active' : lit ? (lit.has(`${e.from}>${e.to}`) ? 'hot' : 'dim') : hot ? (e.from === hot || e.to === hot ? 'hot' : 'dim') : ''
          return <EdgePath key={e.key} e={e} state={state} />
        })}
      </g>
    </svg>
  )
}
