// The canvas does not take the host's word for the shape of a tour: whatever arrives (a whole tour, one late step, a note) is
// rebuilt field by field, with types, ranges and lengths checked, before anything renders it. Pure, with only type imports.
import type { Tour, TourNote, TourStep } from '../types'
import { sanitizeFollowUps } from './followUps.ts'
import { sanitizeMarks } from './marks.ts'
import { sanitizeWait } from './wait.ts'

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const whole = (v: unknown, min = 0, max = 10_000_000): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const STATES: readonly TourStep['state'][] = ['ok', 'moved', 'missing', 'offflow']
/** What the peek card shows at most: the host sends 40 short lines. */
const PEEK_CHARS = 20_000

export function sanitizeNote(raw: unknown): TourNote | null {
  if (!obj(raw) || typeof raw.text !== 'string') return null
  const note: TourNote = { text: text(raw.text, 2000), by: raw.by === 'user' ? 'user' : 'agent', at: whole(raw.at, 0, 1e15) ? raw.at : 0 }
  if (typeof raw.question === 'string') note.question = text(raw.question, 1000)
  return note
}

export function sanitizeStep(raw: unknown): TourStep | null {
  if (!obj(raw) || typeof raw.caption !== 'string') return null
  const step: TourStep = {
    title: text(raw.title, 120),
    caption: text(raw.caption, 2000),
    state: STATES.find(s => s === raw.state) ?? 'ok',
  }
  const at = raw.at
  if (obj(at) && whole(at.startLine) && whole(at.endLine)) {
    step.at = { file: text(at.file, 1000), startLine: at.startLine, endLine: at.endLine, label: text(at.label, 200) }
    if (typeof at.table === 'string') step.at.table = text(at.table, 200)
  }
  if (Array.isArray(raw.highlights)) {
    const out: [number, number][] = []
    for (const h of raw.highlights.slice(0, 3)) {
      if (Array.isArray(h) && whole(h[0], 1) && whole(h[1] ?? h[0], 1)) out.push([Math.min(h[0], h[1] ?? h[0]), Math.max(h[0], h[1] ?? h[0])])
    }
    if (out.length) step.highlights = out
  }
  if (raw.drift === true) step.drift = true
  const peek = raw.peek
  if (obj(peek) && typeof peek.code === 'string' && whole(peek.startLine, 1)) step.peek = { code: peek.code.slice(0, PEEK_CHARS), startLine: peek.startLine }
  if (Array.isArray(raw.notes)) {
    const notes = raw.notes.flatMap(n => sanitizeNote(n) ?? []).slice(-10)
    if (notes.length) step.notes = notes
  }
  const marks = sanitizeMarks(raw.marks)
  if (marks?.length) step.marks = marks
  const wait = sanitizeWait(raw.wait)
  if (wait) step.wait = wait
  return step
}

/** A tour with a step the canvas cannot make sense of plays nothing, rather than part of it. */
export function sanitizeTour(raw: unknown): Tour | null {
  if (!obj(raw) || typeof raw.id !== 'string' || !raw.id || !Array.isArray(raw.steps) || raw.steps.length > 100) return null
  const steps = raw.steps.map(sanitizeStep)
  if (steps.some(s => !s)) return null
  const tour: Tour = {
    id: raw.id.slice(0, 200),
    title: text(raw.title, 200) || 'Tour',
    origin: text(raw.origin, 100),
    source: raw.source === 'agent' || raw.source === 'review' || raw.source === 'gaze' ? raw.source : 'file',
    steps: steps as TourStep[],
    start: whole(raw.start) ? raw.start : 0,
  }
  const agent = raw.agent
  // The colour ends up in a CSS custom property: a colour literal only, nothing that could carry a url() or a second declaration.
  if (obj(agent) && typeof agent.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(agent.color)) tour.agent = { label: text(agent.label, 40), color: agent.color }
  const followUps = sanitizeFollowUps(raw.followUps)
  if (followUps?.length) tour.followUps = followUps
  return tour
}
