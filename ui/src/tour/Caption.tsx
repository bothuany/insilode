// The caption bubble. Its text and the notes pinned to the step are Markdown (Markdown.tsx), rendered as React elements: no
// HTML ever reaches the page. The bubble has a largest size and scrolls inside it, and ends in a box to ask about the step.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TourStep } from '../types'
import { Arrow } from './Arrow'
import { Markdown } from './Markdown'
import { BAR_RESERVE, CAPTION_W } from './geometry'
import { stepMark } from './player'

export interface StepAsk {
  /** Sends the question; false when there is nothing to send. */
  ask(question: string): boolean
  waiting: boolean
}

/** What the player adds under the caption: a hands-on step's prompt and button, the follow-up chips after the last step. */
export interface CaptionSlots {
  wait?: ReactNode
  followUps?: ReactNode
}

export function Caption({ step, place, asking, maxH, ask, slots, onSize }: { step: TourStep; place: { left: number; top: number; side: string } | 'centre'; asking?: string; maxH?: number; ask?: StepAsk; slots?: CaptionSlots; onSize?: (h: number) => void }) {
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(150)
  const [question, setQuestion] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const text = useRef<HTMLDivElement>(null)
  // Whether the caption really is longer than the three lines it is cut to: only then is there anything for "more" to show.
  const [overflows, setOverflows] = useState(false)
  const mark = stepMark(step)
  const notes = step.notes?.length ?? 0
  useLayoutEffect(() => {
    const el = text.current
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [step.caption, open])

  // The bubble's own height, so the layer can place it fully inside the canvas.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setHeight(el.offsetHeight)
      onSize?.(el.offsetHeight)
    })
    ro.observe(el)
    setHeight(el.offsetHeight)
    onSize?.(el.offsetHeight)
    return () => ro.disconnect()
  }, [onSize])

  // A new note (the answer to a question) comes into view.
  const seen = useRef(notes)
  useEffect(() => {
    const el = body.current
    if (el && notes > seen.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    seen.current = notes
  }, [notes])

  // The layer's own size is what counts: React Flow's measured width can lag a resize of the editor group, so the position is
  // clamped in CSS as well, against the real size of the layer. A canvas narrower than the bubble shrinks the bubble (max-width).
  const style: CSSProperties = {
    ...(place === 'centre'
      ? { left: 0, right: 0, top: `max(8px, min(18%, calc(100% - ${(maxH ?? 440) + 72}px)))`, margin: '0 auto' }
      : { left: `max(8px, min(${place.left}px, calc(100% - ${CAPTION_W + 8}px)))`, top: `max(8px, min(${place.top}px, calc(100% - ${height + BAR_RESERVE}px)))` }),
    ...(maxH ? { maxHeight: maxH } : {}),
  }
  return (
    <div ref={root} className={`tour-caption${step.state === 'missing' ? ' missing' : ''}`} data-side={place === 'centre' ? 'centre' : place.side} style={style} role="status" aria-live="polite">
      <div className="tour-caption-head">
        <Arrow size={11} className="tour-caption-arrow" />
        <b>{step.title}</b>
        {step.at && <span className="tour-mark" title={mark.label}>{mark.glyph}</span>}
      </div>
      <div ref={body} className="tour-caption-body">
        <div ref={text} className={`tour-caption-text${open ? '' : ` clamp${overflows ? ' cut' : ''}`}`}>
          <Markdown text={step.caption} />
        </div>
        {overflows && (
          <button type="button" className="tour-more" aria-expanded={open} onClick={() => setOpen(v => !v)}>
            {open ? 'less' : 'more'}
          </button>
        )}
        {asking && <p className="tour-asking">asking {asking}…</p>}
        {step.state === 'missing' && <p className="tour-warn">Can't find this code any more.</p>}
        {step.drift && step.state !== 'missing' && <p className="tour-warn">The code changed since this tour was made.</p>}
        {step.notes?.map((n, i) => (
          <div key={i} className="tour-note">
            {n.question && <p className="tour-q">{n.question}</p>}
            <Markdown text={n.text} />
            <span className="tour-from">{n.by === 'agent' ? 'from the agent' : 'your note'}</span>
          </div>
        ))}
        {slots?.wait}
        {slots?.followUps}
      </div>
      {ask && (
        <form
          className="tour-caption-ask"
          onSubmit={e => {
            e.preventDefault()
            if (ask.ask(question)) setQuestion('')
          }}
        >
          <input
            value={question}
            maxLength={1000}
            placeholder={ask.waiting ? 'Asking…' : 'Ask about this step…'}
            aria-label="Ask the agent about this step"
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && (e.stopPropagation(), e.currentTarget.blur())}
          />
        </form>
      )}
    </div>
  )
}
