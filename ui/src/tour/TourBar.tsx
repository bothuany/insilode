// The tour bar: back, "3 / 7" (a step list), next, pause, the step's title, the source's own actions (Keep/Undo for a review of
// changes) and exit. The reader steps by hand; there is no autoplay timer.
import { useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { Tour } from '../types'
import { counterText, stepMark, type PlayerState } from './player'

export interface TourApi {
  next(): void
  back(): void
  goto(index: number): void
  toggle(): void
  exit(): void
}

export interface AskBox {
  /** Sends the question; false when there is nothing to send. */
  ask(question: string): boolean
  inputRef: RefObject<HTMLInputElement | null>
}

export function TourBar({ tour, state, api, extras, ask, nextBlocked }: { tour: Tour; state: PlayerState; api: TourApi; extras?: ReactNode; ask?: AskBox; nextBlocked?: boolean }) {
  const [list, setList] = useState(false)
  const [question, setQuestion] = useState('')
  const { index, paused } = state
  const step = tour.steps[index]
  const last = tour.steps.length - 1
  return (
    <div className={`tour${paused ? ' paused' : ''}`} role="toolbar" aria-label={tour.title} style={{ '--progress': `${((index + 1) / tour.steps.length) * 100}%` } as CSSProperties}>
      <button className="icon-btn" onClick={api.back} disabled={index === 0} title="Previous step (←)">‹</button>
      <span className="tour-steps">
        <button className="tour-pos" onClick={() => setList(v => !v)} aria-expanded={list} title="All steps">{counterText(index, tour.steps.length)}</button>
        {list && (
          <ol className="tour-list" aria-label={`Steps of ${tour.title}`}>
            <li className="tour-list-head" title={tour.origin}>{tour.title}</li>
            {tour.steps.map((s, i) => {
              const mark = stepMark(s)
              return (
                <li key={i}>
                  <button className={`tour-item${i === index ? ' on' : ''}`} onClick={() => { api.goto(i); setList(false) }}>
                    <span className="tour-mark" title={mark.label}>{mark.glyph}</span>
                    <span className="tour-item-title">{s.title}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </span>
      <button className="icon-btn" onClick={api.next} disabled={index === last || nextBlocked} title={nextBlocked ? 'Do this step first' : 'Next step (→)'}>›</button>
      <button className="icon-btn" onClick={api.toggle} title={paused ? 'Resume the tour (Space)' : 'Pause: lift the spotlight (Space)'}>{paused ? '▶' : '⏸'}</button>
      <span className="tour-label" title={`${tour.title} · ${tour.origin}`}>
        {step?.title}
        {paused && <span className="tour-paused"> · paused</span>}
      </span>
      {ask && (
        <form
          className="tour-ask"
          onSubmit={e => {
            e.preventDefault()
            if (ask.ask(question)) setQuestion('')
          }}
        >
          <input
            ref={ask.inputRef}
            value={question}
            maxLength={1000}
            placeholder={state.asking === 'waiting' ? 'Asking…' : 'Ask about this step… (/)'}
            aria-label="Ask the agent about this step"
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Escape' && (e.stopPropagation(), e.currentTarget.blur())}
          />
        </form>
      )}
      {extras}
      <button className="icon-btn" onClick={api.exit} title="Close the tour (Esc)">×</button>
    </div>
  )
}
