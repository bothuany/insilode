// The tour player's state: one tour at a time, a step index and whether the reader paused. A pure reducer with only type
// imports, so it runs under plain Node (ui/test). The host's tours (an agent's, a file's), the canvas's own review of
// changes and later a replay of the agent's gaze all play through this one state.
import type { Tour, TourNote, TourStep } from '../types'

export interface PlayerState {
  tour: Tour | null
  /** 0-based. */
  index: number
  /** The reader looked away (clicked another card, started editing): the spotlight is lifted until they resume. */
  paused: boolean
  /** The reader asked a question about this step: `waiting` for the agent's note, `answered` once it came. Paused, but the step stays lit and its caption shown. */
  asking: 'waiting' | 'answered' | null
}

export const idle: PlayerState = { tour: null, index: 0, paused: false, asking: null }

export type PlayerAction =
  | { type: 'start'; tour: Tour }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; index: number }
  | { type: 'pause' }
  /** `id`: the host resumes a tour by name, and a late message for another tour is ignored. */
  | { type: 'resume'; id?: string }
  /** The reader asked about the current step: paused until the answer (a note) and a resume. */
  | { type: 'ask' }
  | { type: 'toggle' }
  | { type: 'exit' }
  /** The host ended the tour (`id` guards against ending a newer one that replaced it). */
  | { type: 'end'; id: string }
  /** `step` given: a lazily resolved step arrived, no jump. Without it: the agent moved the reader to `index`. */
  | { type: 'step'; id: string; index: number; step?: TourStep }
  | { type: 'note'; id: string; index: number; note: TourNote }
  /** The steps of the playing tour changed under it (the review of changes shrinks as cards are kept or undone). */
  | { type: 'steps'; steps: TourStep[] }
  /** The agent edited the tour while the reader was paused (`tourSteps`): the whole new list; the reader stays on `index` without restarting. */
  | { type: 'edit'; id: string; steps: TourStep[]; index: number }

const clamp = (i: number, length: number) => Math.max(0, Math.min(Number.isFinite(i) ? Math.trunc(i) : 0, length - 1))

/** At most this many notes hang on one step (docs/design/guided-tours.md, 1.4). */
export const MAX_NOTES = 10

export function reduce(s: PlayerState, a: PlayerAction): PlayerState {
  const tour = s.tour
  switch (a.type) {
    case 'start':
      // A new tour replaces the one playing; one without steps plays nothing.
      return a.tour.steps.length ? { tour: a.tour, index: clamp(a.tour.start, a.tour.steps.length), paused: false, asking: null } : idle
    case 'exit':
      return tour ? idle : s
    case 'end':
      return tour?.id === a.id ? idle : s
    case 'next':
    case 'back':
    case 'goto': {
      if (!tour) return s
      const to = clamp(a.type === 'next' ? s.index + 1 : a.type === 'back' ? s.index - 1 : a.index, tour.steps.length)
      // Moving on is looking again: the spotlight comes back, even from a pause.
      return to === s.index && !s.paused ? s : { ...s, index: to, paused: false, asking: null }
    }
    case 'pause':
      return tour && !s.paused ? { ...s, paused: true } : s
    case 'resume':
      return tour && (s.paused || s.asking) && (a.id === undefined || a.id === tour.id) ? { ...s, paused: false, asking: null } : s
    case 'ask':
      return tour ? { ...s, paused: true, asking: 'waiting' } : s
    case 'toggle':
      return tour ? { ...s, paused: !s.paused, asking: null } : s
    case 'step': {
      if (!tour || tour.id !== a.id || a.index < 0 || a.index >= tour.steps.length) return s
      const step = a.step
      if (!step) return a.index === s.index && !s.paused ? s : { ...s, index: a.index, paused: false, asking: null }
      return { ...s, tour: { ...tour, steps: tour.steps.map((st, i) => (i === a.index ? step : st)) } }
    }
    case 'note': {
      if (!tour || tour.id !== a.id || a.index < 0 || a.index >= tour.steps.length) return s
      const steps = tour.steps.map((st, i) => (i === a.index ? { ...st, notes: [...(st.notes ?? []), a.note].slice(-MAX_NOTES) } : st))
      // The answer to a question has come: the caption stops saying the agent is being asked.
      return { ...s, tour: { ...tour, steps }, asking: s.asking && a.index === s.index ? 'answered' : s.asking }
    }
    case 'steps':
      if (!tour) return s
      if (!a.steps.length) return idle
      return { ...s, tour: { ...tour, steps: a.steps }, index: clamp(s.index, a.steps.length) }
    case 'edit':
      // Not a restart: the reader is paused or waiting for an answer, and stays so (`paused` and `asking` are kept).
      if (!tour || tour.id !== a.id || !a.steps.length) return s
      return { ...s, tour: { ...tour, steps: a.steps }, index: clamp(a.index, a.steps.length) }
  }
}

/** What each state looks like in the step list. */
export function stepMark(step: TourStep): { glyph: string; label: string } {
  if (step.drift) return { glyph: 'Δ', label: 'The code changed since this tour was made' }
  switch (step.state) {
    case 'moved': return { glyph: '↪', label: 'The code moved: found at its new place' }
    case 'missing': return { glyph: '⚠', label: 'This code was not found' }
    case 'offflow': return { glyph: '⧉', label: 'Not on the drawn flow: shown as a side card' }
    default: return { glyph: '✓', label: 'Found' }
  }
}

/** "3 / 7" with no-break spaces: the counter is one word, so it never wraps between its numbers. */
export const counterText = (index: number, total: number) => `${index + 1} / ${total}`
