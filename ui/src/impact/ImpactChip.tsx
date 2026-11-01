// The impact chip on the bar and its popover: what changing this method reaches. The chip is a button that opens a list
// whose rows open that flow; the list closes on Escape (focus goes back to the chip) and on a press anywhere outside it.
import { useEffect, useRef } from 'react'
import type { ImpactItem, ImpactResult } from '../types'
import { barChip, type Fill } from './fill'
import { impactSummary } from './summary'

interface Props {
  fill: Fill<ImpactResult>
  /** The flow is drawn: before that the chip only says it will check. */
  ready: boolean
  /** The flow could not be traced, so the impact is never asked: the chip says it was not checked instead of waiting for good. */
  blocked?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onRetry: () => void
  /** A row that names a place was chosen: show the flow there. */
  onOpen: (item: ImpactItem) => void
}

const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file

export function ImpactChip({ fill, ready, blocked, open, onOpenChange, onRetry, onOpen }: Props) {
  const wrap = useRef<HTMLSpanElement>(null)
  const chip = useRef<HTMLButtonElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  const state = barChip(fill, ready, !!blocked)
  const summary = state === 'result' && fill.value ? impactSummary(fill.value) : null
  const listed = !!summary?.hasRows

  // The list takes the keyboard when it opens, and a press outside it closes it. Not focus: a click on a code line must keep the editor's.
  useEffect(() => {
    if (!open) return
    pop.current?.focus()
    const outside = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) onOpenChange(false)
    }
    // Capture phase: the canvas under the bar handles its own pointer events and would hide this one.
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // A refresh that fails or an answer without rows leaves nothing to list.
  useEffect(() => {
    if (open && !listed) onOpenChange(false)
  }, [open, listed]) // eslint-disable-line react-hooks/exhaustive-deps

  if (state === 'blocked') return <span className="chip ghosted" role="status" title="The flow could not be traced, so its impact was not checked.">Impact not checked</span>
  if (state === 'checking') return <span className="chip ghosted" role="status">Checking impact…</span>
  if (state === 'error') {
    return (
      <button className="chip impact err" onClick={onRetry} title={`Could not check the impact: ${fill.error}`}>
        Impact check failed · Retry
      </button>
    )
  }
  if (!summary) return null
  if (!listed) return <span className="chip impact none" role="status" title={summary.status}>{summary.chip}</span>
  return (
    <span
      className="impact-wrap"
      ref={wrap}
      onKeyDown={e => {
        if (open && e.key === 'Escape') {
          e.stopPropagation()
          onOpenChange(false)
          chip.current?.focus()
        }
      }}
    >
      <button ref={chip} className={`chip impact ${summary.tone}`} aria-expanded={open} aria-haspopup="dialog" title={summary.status} onClick={() => onOpenChange(!open)}>
        {summary.chip}
      </button>
      {open && fill.value && (
        <div className="impact-pop" role="dialog" aria-label="Impact" tabIndex={-1} ref={pop}>
          <p>{summary.title}</p>
          <ul>
            {fill.value.items.map(i => (
              <li key={`${i.label}|${i.file}|${i.line}`}>
                {i.file && i.line > 0 ? (
                  <button
                    className="impact-row"
                    title={`Show the flow of ${i.label}`}
                    onClick={() => {
                      onOpenChange(false)
                      onOpen(i)
                    }}
                  >
                    <span className="impact-label">{i.label}</span>
                    <span className="impact-where">{baseName(i.file)}:{i.line}</span>
                  </button>
                ) : (
                  <span className="impact-row plain">{i.label}</span>
                )}
              </li>
            ))}
          </ul>
          {summary.more && <p className="impact-more">{summary.more}</p>}
        </div>
      )}
    </span>
  )
}
