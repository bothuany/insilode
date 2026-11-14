// The legend popover: node colours for the kinds on the board, and what each line style means.
import { EDGE_STYLE, KIND_COLOR, STEREOTYPE } from './protocol'
import type { EdgeKind, NodeKind } from '../../../board-canvas/spec'

const LINES: { kind: EdgeKind; text: string }[] = [
  { kind: 'extends', text: 'extends' },
  { kind: 'implements', text: 'implements' },
  { kind: 'has', text: 'field (1, 0..1)' },
  { kind: 'has-many', text: 'collection (0..*)' },
  { kind: 'depends', text: 'depends on / uses' },
]

export function Legend({ kinds, changes, entries }: { kinds: string[]; changes?: boolean; entries?: { key: string; text: string }[] }) {
  return (
    <div>
      <div className="lg-title">Nodes</div>
      {kinds.map(k => (
        <div key={k} className="lg-row"><i style={{ background: KIND_COLOR[k as NodeKind] ?? '#8b93a1' }} />{STEREOTYPE[k as NodeKind] ?? k}</div>
      ))}
      <div className="lg-title">Lines</div>
      {LINES.map(l => {
        const st = EDGE_STYLE[l.kind]
        return (
          <div key={l.kind} className="lg-row">
            <svg width="38" height="12" className={`be be-${st.color}`}>
              <path className="be-line" d={`M1 6 H${st.head === 'tri' ? 25 : 36}`} strokeDasharray={st.dash} />
              <path className={`be-head ${st.head}`} d={st.head === 'tri' ? 'M36 6 L25 0.5 V11.5 Z' : 'M29 1 L36 6 L29 11'} />
            </svg>
            {l.text}
          </div>
        )
      })}
      {changes && (
        <>
          <div className="lg-title">Changes</div>
          <div className="lg-row"><i style={{ background: 'var(--fl-add)' }} />added</div>
          <div className="lg-row"><i style={{ background: 'var(--fl-warn)' }} />changed</div>
          <div className="lg-row"><i style={{ background: 'var(--fl-del)' }} />removed (struck through)</div>
        </>
      )}
      {entries && entries.length > 0 && (
        <>
          <div className="lg-title">This board</div>
          {entries.map(e => <div key={e.key} className="lg-row"><b>{e.key}</b> {e.text}</div>)}
        </>
      )}
      <div className="lg-title">Keys</div>
      <div className="lg-row"><kbd>/</kbd> search <kbd>f</kbd> focus selected <kbd>Esc</kbd> clear</div>
      <div className="lg-row">Click a header: open · double-click: focus · click a field: go to its type</div>
    </div>
  )
}
