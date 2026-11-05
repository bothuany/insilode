// The board's React Flow node types: a UML-style class box, a collapsed group (one summary node) and an expanded
// group's container. They are memoized and take everything from `data`; clicks go through ActionsCtx.
import { createContext, memo, useContext, useState, type CSSProperties } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import type { BoardMember, BoardNode } from './spec'
import { DETAIL_H, detailOf, GROUP_HEAD, HEADER_H, MARK_SIZE, type VGroup, type VNode } from './model'
import { KIND_COLOR, STEREOTYPE, VISIBILITY_NAME } from './protocol'

export interface Actions {
  /** A click on a card's header: select it, open its file. */
  select(id: string, node?: BoardNode): void
  focus(id: string): void
  toggleGroup(id: string): void
  member(node: BoardNode, member: BoardMember, row: number): void
  more(id: string): void
  hover(id: string | null): void
  /** C4: open the board below this box. */
  zoom(board: string): void
}

export const ActionsCtx = createContext<Actions>({ select() {}, focus() {}, toggleGroup() {}, member() {}, more() {}, hover() {}, zoom() {} })

export interface CardData extends Record<string, unknown> {
  v: VNode
  selected: boolean
  focus: boolean
  match: boolean
  /** A search is active and this node is not a match. */
  dim: boolean
  activeRow?: number
  /** `canFocus`: the host can rebuild around this node. */
  canFocus: boolean
  /** The board the node's `zoom` names exists: a double click or the badge opens it. */
  zoomable?: boolean
}

export interface GroupData extends Record<string, unknown> {
  g: VGroup
  collapsedBy?: boolean
}

export type CardNodeT = Node<CardData, 'card'>
export type SummaryNodeT = Node<CardData, 'summary'>
export type GroupNodeT = Node<GroupData, 'frame'>

const cls = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ')

/** Skeleton first: the plan against the code, a mark per type and member (never "wrong": differs). */
const CHECK_MARK = { matches: '✓', missing: '○', differs: '◐', existing: '·' } as const
const CHECK_WORD = { matches: 'in the code as planned', missing: 'not in the code yet', differs: 'differs from the plan', existing: 'already in the code before the design' } as const
const checkTitle = (x: { check?: keyof typeof CHECK_MARK; checkNote?: string; warn?: string }) =>
  [x.check && `Plan vs code: ${CHECK_WORD[x.check]}`, x.checkNote, x.warn && `⚠ ${x.warn}`].filter(Boolean).join('\n')

const Kinds = ({ kinds }: { kinds?: Record<string, number> }) => (
  <div className="bs-kinds">
    {Object.entries(kinds ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => (
      <span key={k} title={`${n} ${k}`}><i style={{ background: KIND_COLOR[k as keyof typeof KIND_COLOR] ?? '#8b93a1' }} />{n}</span>
    ))}
  </div>
)

export const CardNode = memo(function CardNode({ data }: NodeProps<CardNodeT>) {
  const a = useContext(ActionsCtx)
  // The note glyph opens the note over the card's header (it is only a tooltip otherwise, which a keyboard or a screen reader never gets).
  const [noteOpen, setNoteOpen] = useState(false)
  const { v } = data
  const n = v.node!
  const kind = n.kind ?? 'class'
  const st = STEREOTYPE[kind]
  const style = { '--k': KIND_COLOR[kind], height: '100%' } as CSSProperties
  const detail = detailOf(n)
  if (n.shape && MARK_SIZE[n.shape]) {
    // A pseudo-state (initial, final, choice) is a mark with no text: the label is its tooltip.
    return (
      <div
        className={cls('bc-mark', `sh-${n.shape}`, data.selected && 'sel', data.match && 'match', data.dim && 'dim', n.change && `ch-${n.change}`)}
        title={n.label}
        onMouseEnter={() => a.hover(v.id)}
        onMouseLeave={() => a.hover(null)}
        onClick={() => a.select(v.id, n)}
      />
    )
  }
  return (
    <div
      className={cls('bc', data.selected && 'sel', data.focus && 'foc', data.match && 'match', data.dim && 'dim', n.status && `s-${n.status}`, n.check && `c-${n.check}`, n.change && `ch-${n.change}`, n.shape && `sh-${n.shape}`, n.warn && 'warned', kind === 'enum' && 'enum')}
      style={style}
      onMouseEnter={() => a.hover(v.id)}
      onMouseLeave={() => a.hover(null)}
    >
      <div
        className="bc-head"
        style={{ height: HEADER_H + (detail ? DETAIL_H : 0) }}
        title={[n.label, n.target ? `${n.target.path}\n${n.target.reason}${n.target.create ? '\nClick to create this file or copy its path' : ''}` : detailOf(n), n.symbol, n.zoom && data.zoomable ? 'Double-click to zoom in' : '', n.file ? `${n.file}${n.line ? ':' + n.line : ''}` : '', n.note, checkTitle(n)].filter(Boolean).join('\n')}
        onClick={() => a.select(v.id, n)}
        onDoubleClick={() => (data.zoomable && n.zoom ? a.zoom(n.zoom) : data.canFocus && a.focus(v.id))}
      >
        {n.check && <span className={`bc-check c-${n.check}`}>{n.warn ? '⚠ ' : ''}{n.check}</span>}
        {!n.check && n.change && <span className={`bc-check ch-${n.change}`}>{n.change}</span>}
        {!n.check && !n.change && n.note && (
          <button type="button" className="bc-note" aria-label="Show note" aria-expanded={noteOpen} title={n.note} onKeyDown={e => { if (e.key === 'Escape' && noteOpen) { e.stopPropagation(); setNoteOpen(false) } }} onClick={e => { e.stopPropagation(); setNoteOpen(o => !o) }}>✎</button>
        )}
        {n.zoom && data.zoomable && (
          <button type="button" className="bc-zoom" aria-label={`Zoom into ${n.label}`} title="Zoom in: open the board below this box" onClick={e => { e.stopPropagation(); a.zoom(n.zoom!) }}>⤓</button>
        )}
        {noteOpen && n.note && (
          <div className="bc-notetext" role="note" onClick={e => e.stopPropagation()}>{n.note}</div>
        )}
        {st && <div className="bc-st">«{st}»</div>}
        <div className="bc-name">{n.label}</div>
        {detail && <div className="bc-detail">{detail}</div>}
      </div>
      {v.rows.length > 0 && (
        <div className="bc-rows">
          {v.rows.map((m, i) => (
            <div
              key={i}
              className={cls('bc-row', m.ref && 'link', data.activeRow === i && 'on', m.kind === 'method' && 'method', m.check && `c-${m.check}`, m.warn && 'warned')}
              title={[m.ref ? `${m.text}\n→ ${m.ref}` : m.text, checkTitle(m)].filter(Boolean).join('\n')}
              onClick={m.ref ? e => { e.stopPropagation(); a.member(n, m, i) } : undefined}
            >
              <span className={cls('vis', m.visibility && `v${VISIBILITY_NAME[m.visibility]}`)}>{m.visibility ?? ''}</span>
              <span className="txt">{m.text}</span>
              {m.ref && <span className="go">›</span>}
              {(m.check || m.warn) && <span className="mk">{m.warn ? '⚠' : CHECK_MARK[m.check!]}</span>}
            </div>
          ))}
          {v.more > 0 && <div className="bc-row more" onClick={e => { e.stopPropagation(); a.more(v.id) }}>+{v.more} more</div>}
        </div>
      )}
    </div>
  )
})

/** A collapsed group: one box with the count and the kinds inside; a click opens it. */
export const SummaryNode = memo(function SummaryNode({ data }: NodeProps<SummaryNodeT>) {
  const a = useContext(ActionsCtx)
  const { v } = data
  const g = v.group!
  return (
    <div
      className={cls('bs', data.selected && 'sel', data.match && 'match', data.dim && 'dim')}
      onMouseEnter={() => a.hover(v.id)}
      onMouseLeave={() => a.hover(null)}
      onClick={() => a.toggleGroup(g.id)}
      title={`${g.label}: ${v.count} types. Click to expand.`}
    >
      <div className="bs-name"><span className="chev">▸</span>{g.label}</div>
      <div className="bs-count">{v.count} {v.count === 1 ? 'type' : 'types'}</div>
      <Kinds kinds={v.kinds} />
    </div>
  )
})

/** An expanded group: the frame around its cards. Only the header takes clicks. */
export const GroupNode = memo(function GroupNode({ data }: NodeProps<GroupNodeT>) {
  const a = useContext(ActionsCtx)
  const { g } = data
  return (
    <div className={cls('bg', g.group.kind && `k-${g.group.kind}`)} style={{ '--d': Math.min(g.depth, 3) } as CSSProperties}>
      <div className="bg-head" style={{ height: GROUP_HEAD }} onClick={() => a.toggleGroup(g.group.id)} title="Collapse">
        <span className="chev">▾</span>
        <span className="bg-name">{g.group.label}</span>
        {g.group.tech && <span className="bg-tech">[{g.group.tech}]</span>}
        <span className="bg-count">{g.count}</span>
      </div>
    </div>
  )
})

export const nodeTypes = { card: CardNode, summary: SummaryNode, frame: GroupNode }
