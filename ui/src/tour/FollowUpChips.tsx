// The follow-up questions as chips under the last step's caption; tapping one asks it like a typed question.
import { useRef, useState } from 'react'
import './followups.css'

/** `ask` is the player's own ask (the same path as the ask box): it sends `tourAsk` for the step the reader is on and returns false when it could not. */
export function FollowUps({ items, ask }: { items: string[]; ask(question: string): boolean }) {
  const [sent, setSent] = useState(false)
  // A ref as well as state: two taps in one frame must not send two questions before the re-render disables the chips.
  const locked = useRef(false)
  if (!items.length) return null
  const tap = (question: string) => {
    if (locked.current) return
    if (!ask(question)) return
    locked.current = true
    setSent(true)
  }
  return (
    <div className="tour-followups">
      <span className="tour-followup-label">Go deeper</span>
      <div className="tour-followup-row">
        {items.slice(0, 3).map(q => (
          <button key={q} type="button" className="tour-followup" title={q} disabled={sent} onClick={() => tap(q)}>{q}</button>
        ))}
      </div>
    </div>
  )
}
