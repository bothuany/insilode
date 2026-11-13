// The "Changes (N)" rail and the find box: the canvas's way around its changed cards when no tour is playing. What they do is
// nav.ts; the keys are bound in webview.tsx.
import { useEffect, useRef } from 'react'
import { NAV_KEYS, type NavGroup } from './nav'

export function ChangesRail({ groups, count, current, viewed, open, onToggle, onPick, onViewed }: {
  groups: NavGroup[]
  count: number
  current: string | null
  viewed: ReadonlySet<string>
  open: boolean
  onToggle: () => void
  onPick: (key: string) => void
  onViewed: (key: string) => void
}) {
  return (
    <aside className="rail" aria-label="Changed methods">
      <button className="rail-head" aria-expanded={open} onClick={onToggle}>
        <span className="rail-caret" aria-hidden>{open ? '▾' : '▸'}</span>
        <span className="rail-count">Changes ({count})</span>
        <span className="rail-faint">{groups.reduce((n, g) => n + g.rows.filter(r => viewed.has(r.key)).length, 0)}/{count} viewed</span>
      </button>
      {open && (
        <>
          <div className="rail-keys">
            {NAV_KEYS.map(k => (
              <span key={k.keys} title={k.label}>
                <kbd>{k.keys}</kbd>
                {k.short}
              </span>
            ))}
          </div>
          <div className="rail-list">
            {groups.map(g => (
              <div key={g.file}>
                <div className="rail-file" title={g.file}>{g.name}</div>
                {g.rows.map(r => (
                  <div key={r.key} className={`rail-row${current === r.key ? ' on' : ''}${viewed.has(r.key) ? ' viewed' : ''}`}>
                    <button className="rail-pick" aria-current={current === r.key} onClick={() => onPick(r.key)} title={r.owner ? `${r.owner}.${r.member}` : r.member}>
                      <span className="rail-name">{r.member}</span>
                      <span className="rail-stat">
                        <span className="plus">+{r.plus}</span>
                        <span className="minus">−{r.minus}</span>
                      </span>
                    </button>
                    <button className="rail-tick" role="checkbox" aria-checked={viewed.has(r.key)} aria-label={`Viewed: ${r.member}`} title="Mark as viewed" onClick={() => onViewed(r.key)}>✓</button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  )
}

/** The find box (the / key): live, so the first match is shown as you type; Enter and Shift+Enter cycle, Esc closes. */
export function FindBox({ query, total, index, onQuery, onStep, onClose }: {
  query: string
  total: number
  index: number
  onQuery: (q: string) => void
  onStep: (dir: 1 | -1) => void
  onClose: () => void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  return (
    <div className="find" role="search">
      <input
        ref={input}
        value={query}
        placeholder="Find a method or class"
        aria-label="Find a card by method or class name"
        onChange={e => onQuery(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            onStep(e.shiftKey ? -1 : 1)
          }
        }}
      />
      <span className="find-count">{query ? (total ? `${index + 1} of ${total}` : 'No match') : ''}</span>
    </div>
  )
}
