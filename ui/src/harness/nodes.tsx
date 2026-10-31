// The three node kinds of the harness diagram: a stage header, an item card, and the "nothing here" placeholder.
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { CardData, HeaderData } from './layout'
import { KIND_LABEL } from './layout'

const SCOPE_LABEL = { user: 'you', project: 'repo', local: 'local', directory: 'folder' } as const

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  )
}

function StageNode({ data }: NodeProps) {
  const d = data as HeaderData
  return (
    <div className={`hs-head${d.active ? ' active' : ''}${d.dim ? ' dim' : ''}`} title={d.hint}>
      <span className="hs-head-title">{d.title}</span>
      {d.mode ? <span className="hs-mode" title="The permission mode the verdict assumed">{d.mode}</span> : null}
      {d.empty ? null : <span className="hs-count">{d.count}</span>}
      <Handles />
    </div>
  )
}

function NoneNode() {
  return <div className="hs-none">nothing here</div>
}

function CardNode({ data }: NodeProps) {
  const { item, hit, dim, onOpen } = data as CardData
  const issues = item.issues ?? []
  const label = [`${KIND_LABEL[item.kind]}: ${item.label}`, item.detail, hit ? `On the path: ${hit.why}` : '', ...issues].filter(Boolean).join('. ')
  const cls = ['hs-card', `k-${item.kind}`]
  if (hit) cls.push('hit', hit.how)
  if (dim) cls.push('dim')
  if (issues.length) cls.push('has-issue')
  return (
    <button type="button" className={cls.join(' ')} aria-label={label} title={[hit?.why, ...issues].filter(Boolean).join('\n') || item.detail || item.label} onClick={() => onOpen(item.id)}>
      <span className="hs-row">
        <span className="hs-kind">{KIND_LABEL[item.kind]}</span>
        <span className="hs-label">{item.label}</span>
        {issues.length ? <span className="hs-issue" role="img" aria-label={`${issues.length} issue${issues.length === 1 ? '' : 's'}`}>!</span> : null}
      </span>
      <span className="hs-detail">{item.matcher ?? item.paths?.join(', ') ?? item.detail}</span>
      <span className="hs-row hs-meta">
        <span className="hs-chip">{SCOPE_LABEL[item.scope]}</span>
        {item.effect ? <span className={`hs-chip eff-${item.effect}`}>{item.effect}</span> : null}
        {item.tokens ? <span className="hs-chip">{item.tokens.toLocaleString()} tok</span> : null}
        {hit?.verdict ? <span className={`hs-verdict v-${hit.verdict}`}>{hit.verdict}</span> : null}
      </span>
      <Handles />
    </button>
  )
}

export const nodeTypes = { stage: StageNode, card: CardNode, none: NoneNode }
