// The tour bar: back, "3 / 7" (a step list), next, pause, the step's title, the source's own actions (Keep/Undo for a review of
// changes), save, the key legend and exit. The reader steps by hand; there is no autoplay timer.
import { useEffect, useReducer, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { Tour } from '../types'
import { legendRows } from './legend'
import { counterText, noPanels, panelsEscape, panelsReduce, stepMark, type PanelAction, type Panels, type PlayerState } from './player'
import './legend.css'

export interface TourApi {
  next(): void
  back(): void
  goto(index: number): void
  toggle(): void
  exit(): void
  /** Writes the tour to a file (the host does it, after this click): only the player of an agent's or gaze tour has it. */
  save?(): void
}

export interface AskBox {
  /** Sends the question; false when there is nothing to send. */
  ask(question: string): boolean
  inputRef: RefObject<HTMLInputElement | null>
}

/** What the disabled Next says, on the button and in the caption. */
export const BLOCKED_TEXT = 'Finish this step first'

/** A tour that was made (by an agent, or from the agent's gaze) and is not a file yet may be saved as one. */
export const canSaveTour = (tour: Tour) => tour.source === 'agent' || tour.source === 'gaze'

/**
 * `panels` and `onPanels`: the step list's and the legend's open state, kept by the player so its `?` key can open the legend.
 * Without them (the board's tour) the bar keeps its own.
 */
export function TourBar({ tour, state, api, extras, ask, nextBlocked, panels: given, onPanels }: { tour: Tour; state: PlayerState; api: TourApi; extras?: ReactNode; ask?: AskBox; nextBlocked?: boolean; panels?: Panels; onPanels?: (a: PanelAction) => void }) {
  const [own, ownAct] = useReducer(panelsReduce, noPanels)
  const panels = given ?? own
  const act = onPanels ?? ownAct
  const [question, setQuestion] = useState('')
  const [saving, setSaving] = useState(false)
  const listRoot = useRef<HTMLSpanElement>(null)
  const listBtn = useRef<HTMLButtonElement>(null)
  const legendRoot = useRef<HTMLSpanElement>(null)
  const legendBtn = useRef<HTMLButtonElement>(null)
  const legendBox = useRef<HTMLDivElement>(null)
  const { index, paused } = state
  const step = tour.steps[index]
  const last = tour.steps.length - 1
  const open = panels.list || panels.legend

  // Escape closes a pop-up first and the tour stays: this listener runs before the player's own key handler (capture) and keeps
  // the key from it. With nothing open it does nothing, and the second Escape reaches the player and exits.
  const panelsRef = useRef(panels)
  panelsRef.current = panels
  const actRef = useRef(act)
  actRef.current = act
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return
      if (!panelsEscape(panelsRef.current).handled) return
      actRef.current('outside')
      e.stopPropagation()
      e.stopImmediatePropagation()
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  // A click outside both pop-ups closes them. A click on a button of the bar is not outside: that button decides itself.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target
      if (t instanceof Node && (listRoot.current?.contains(t) || legendRoot.current?.contains(t))) return
      actRef.current('outside')
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  // A pop-up that closes gives focus back to its button, unless the reader has already put it somewhere else (a click on a field).
  const was = useRef(panels)
  useEffect(() => {
    const before = was.current
    was.current = panels
    const homeless = () => !document.activeElement || document.activeElement === document.body
    if (before.list && !panels.list && homeless()) listBtn.current?.focus()
    if (before.legend && !panels.legend && homeless()) legendBtn.current?.focus()
    // The legend is a dialog: focus moves into it when it opens.
    if (!before.legend && panels.legend) legendBox.current?.focus()
  }, [panels])

  useEffect(() => {
    if (!saving) return
    const t = setTimeout(() => setSaving(false), 1500)
    return () => clearTimeout(t)
  }, [saving])

  return (
    <div className={`tour${paused ? ' paused' : ''}`} role="toolbar" aria-label={tour.title} style={{ '--progress': `${((index + 1) / tour.steps.length) * 100}%` } as CSSProperties}>
      <button className="icon-btn" onClick={api.back} disabled={index === 0} title="Previous step (←)">‹</button>
      <span className="tour-steps" ref={listRoot}>
        <button ref={listBtn} className="tour-pos" onClick={() => act('toggleList')} aria-expanded={panels.list} title="All steps">{counterText(index, tour.steps.length)}</button>
        {panels.list && (
          <ol className="tour-list" aria-label={`Steps of ${tour.title}`}>
            <li className="tour-list-head" title={tour.origin}>{tour.title}</li>
            {tour.steps.map((s, i) => {
              const mark = stepMark(s)
              return (
                <li key={i}>
                  <button className={`tour-item${i === index ? ' on' : ''}`} onClick={() => { api.goto(i); act('closeList') }}>
                    <span className="tour-mark" title={mark.label}>{mark.glyph}</span>
                    <span className="tour-item-title">{s.title}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        )}
      </span>
      {/* Not `disabled` while the step waits: the click (or key) is then answered in the caption and focus goes to the step's own button. */}
      <button className="icon-btn" onClick={api.next} disabled={index === last} aria-disabled={nextBlocked || undefined} title={nextBlocked ? BLOCKED_TEXT : 'Next step (→)'}>›</button>
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
      {api.save && canSaveTour(tour) && (
        <button
          className="btn ghost tour-save"
          aria-busy={saving || undefined}
          title="Save this tour as a file in .insilode/tours"
          onClick={() => {
            setSaving(true)
            api.save?.()
          }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      <span className="tour-legend-wrap" ref={legendRoot}>
        <button ref={legendBtn} className="icon-btn" onClick={() => act('toggleLegend')} aria-expanded={panels.legend} aria-haspopup="dialog" title="Keys (?)" aria-label="Keys">?</button>
        {panels.legend && (
          <div ref={legendBox} className="tour-legend" role="dialog" aria-label="Tour keys" tabIndex={-1}>
            <dl>
              {legendRows(!!ask).map(r => (
                <div key={r.action} style={{ display: 'contents' }}>
                  <dt>{r.display}</dt>
                  <dd>{r.label}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </span>
      <button className="icon-btn" onClick={api.exit} title="Close the tour (Esc)">×</button>
    </div>
  )
}
