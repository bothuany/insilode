// The pen marks of a tour step: pure logic (no React, only type imports), so it runs under plain Node (ui/test). The marks are
// drawn by MarkLayer.tsx. Each mark appears with its caption sentence; there is no speech, so a sentence's time is estimated from
// its words.
import type { TourMark, TourStep } from '../types'
import type { Box, Pt } from './geometry'

export const MAX_MARKS = 6
export const MAX_LABEL = 40
export const MAX_SENTENCE = 6
/** Reading speed the sentence clock assumes, and the least time between two sentences, so a one-word sentence still gives the pen a beat. */
export const WORDS_PER_SECOND = 2.6
export const MIN_SENTENCE_MS = 250

const KINDS: readonly TourMark['kind'][] = ['ring', 'underline', 'strike', 'check', 'cross', 'badge', 'connect']
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** The marks the host sent, rebuilt field by field (kinds, ranges, lengths; at most 6), and nothing when none is left. */
export function sanitizeMarks(raw: unknown): TourMark[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: TourMark[] = []
  for (const m of raw) {
    if (out.length >= MAX_MARKS) break
    if (!obj(m)) continue
    const kind = KINDS.find(k => k === m.kind)
    if (!kind) continue
    const mark: TourMark = { kind }
    if (kind === 'connect') {
      const to = m.to
      if (!obj(to) || !whole(to.startLine, 1, 10_000_000) || !whole(to.endLine, 1, 10_000_000) || typeof to.file !== 'string' || !to.file) continue
      mark.to = { file: text(to.file, 1000), startLine: to.startLine, endLine: to.endLine, label: text(to.label, 200) }
    } else {
      const l = m.lines
      if (!Array.isArray(l) || l.length < 1 || l.length > 2) continue
      const [a, b = a] = l
      if (!whole(a, 1, 10_000_000) || !whole(b, 1, 10_000_000)) continue
      mark.lines = [Math.min(a, b), Math.max(a, b)]
      if (kind === 'badge') {
        if (!whole(m.n, 1, 99)) continue
        mark.n = m.n
      }
    }
    const label = text(m.label, MAX_LABEL).trim()
    if (label) mark.label = label
    if (whole(m.sentence, 1, MAX_SENTENCE)) mark.sentence = m.sentence
    out.push(mark)
  }
  return out.length ? out : undefined
}

// ---- the caption's sentences and the clock they run on ----------------------------------------------------------------

/** Words a reader does not stop at: a sentence ending after one of these goes on. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'mr', 'mrs', 'ms', 'dr', 'fig'])
const CLOSERS = '"\')]}”’'

/** The word a period ends: the letters and dots since the last space ("e.g" in "use it, e.g."). */
function wordBefore(s: string, end: number): string {
  let i = end
  while (i > 0 && !/\s/.test(s[i - 1])) i--
  return s.slice(i, end).replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase()
}

/**
 * The caption cut into sentences, at `.`, `!` and `?` followed by a space or the end, and at line breaks. An ellipsis followed by a
 * lower-case word, a number like 3.5, an abbreviation (e.g., i.e., etc., vs.) and anything inside a markdown code span or fence do
 * not end one. A caption with no sentence in it still gives one, so a mark always has a sentence to appear with.
 */
export function splitSentences(caption: string): string[] {
  const s = caption.replace(/\r\n?/g, '\n')
  const out: string[] = []
  let start = 0
  const cut = (end: number) => {
    const part = s.slice(start, end).trim()
    if (part) out.push(part)
    start = end
  }
  let fence = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '`') {
      let k = i
      while (s[k + 1] === '`') k++
      const len = k - i + 1
      if (!fence) fence = len
      else if (fence === len) fence = 0
      i = k
      continue
    }
    if (fence) continue
    if (c === '\n') {
      cut(i + 1)
      continue
    }
    if (c !== '.' && c !== '!' && c !== '?') continue
    let end = i
    while (/[.!?]/.test(s[end + 1] ?? '')) end++
    const run = s.slice(i, end + 1)
    while (end + 1 < s.length && CLOSERS.includes(s[end + 1])) end++
    const next = s[end + 1]
    const atEnd = next === undefined
    if (!atEnd && !/\s/.test(next)) {
      // 3.5, v1.2, a.b: no space follows, so the sentence goes on.
      i = end
      continue
    }
    const after = s.slice(end + 1).trimStart()
    const word = wordBefore(s, i)
    // "vs. the cache": an abbreviation goes on before a lower-case word; e.g. and i.e. always go on.
    if (!atEnd && run === '.' && ABBREVIATIONS.has(word) && (word === 'e.g' || word === 'i.e' || !/^\p{Lu}/u.test(after))) {
      i = end
      continue
    }
    if (!atEnd && /^\.{2,}$/.test(run) && /^\p{Ll}/u.test(after)) {
      // "wait... then": an ellipsis in the middle of a thought.
      i = end
      continue
    }
    cut(end + 1)
    i = end
  }
  cut(s.length)
  return out.length ? out : [caption.trim()]
}

/** Words as a reader counts them: tokens with something to read in them, markdown marks left out. */
export function wordCount(sentence: string): number {
  return sentence
    .replace(/`+/g, ' ')
    .replace(/[*_#>~]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/\s+/)
    .filter(w => /[\p{L}\p{N}]/u.test(w)).length
}

/** When each sentence of the caption starts, in ms from the step's start: the first at 0, the next after the time to read the one before. */
export function sentenceStarts(caption: string): number[] {
  const starts: number[] = []
  let at = 0
  for (const sentence of splitSentences(caption)) {
    starts.push(Math.round(at))
    at += Math.max(MIN_SENTENCE_MS, (wordCount(sentence) / WORDS_PER_SECOND) * 1000)
  }
  return starts
}

/** The sentence a mark appears with, counted from 1 and never past the last one. */
const sentenceOf = (m: TourMark, count: number) => Math.min(Math.max(m.sentence ?? 1, 1), Math.max(count, 1))

/** The marks to draw `elapsedMs` after the step began: those whose sentence has started. `showAll`: every mark (a step reached by a jump, or reduced motion). */
export function visibleMarks(step: Pick<TourStep, 'caption' | 'marks'>, elapsedMs: number, showAll: boolean): TourMark[] {
  const marks = step.marks ?? []
  if (showAll) return marks
  const starts = sentenceStarts(step.caption)
  return marks.filter(m => starts[sentenceOf(m, starts.length) - 1] <= elapsedMs)
}

/** The moments (ms from the step's start, after 0) at which another mark appears: the layer wakes up at these and no other time. */
export function revealTimes(step: Pick<TourStep, 'caption' | 'marks'>): number[] {
  const starts = sentenceStarts(step.caption)
  return [...new Set((step.marks ?? []).map(m => starts[sentenceOf(m, starts.length) - 1]))].filter(t => t > 0).sort((a, b) => a - b)
}

// ---- the marks in words, for a screen reader ------------------------------------------------------------------------

/** The longest summary: a caption's status region is read aloud in one go, so the marks must not drown the caption. */
export const MAX_SUMMARY = 240

const lineText = (m: TourMark) => {
  const [a, b] = m.lines ?? [0, 0]
  return a === b ? `line ${a}` : `lines ${a} to ${b}`
}
const shorten = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)
const baseName = (file: string) => file.split(/[\\/]/).pop() || file

/** One mark as a phrase: "ring lines 12 to 14", "check beside line 20", "arrow to Foo.bar labelled calls". */
function markPhrase(m: TourMark): string {
  let phrase: string
  switch (m.kind) {
    case 'ring': phrase = `ring ${lineText(m)}`; break
    case 'underline': phrase = `underline ${lineText(m)}`; break
    case 'strike': phrase = `strike through ${lineText(m)}`; break
    case 'check': phrase = `check beside ${lineText(m)}`; break
    case 'cross': phrase = `cross beside ${lineText(m)}`; break
    case 'badge': phrase = m.n === undefined ? `number beside ${lineText(m)}` : `number ${m.n} beside ${lineText(m)}`; break
    case 'connect': phrase = `arrow to ${shorten(m.to?.label || (m.to ? baseName(m.to.file) : 'another card'), MAX_LABEL)}`; break
  }
  return m.label ? `${phrase} labelled ${shorten(m.label, MAX_LABEL)}` : phrase
}

/**
 * What the step's pen marks say, for a screen reader (the drawing is hidden from it): "Marked on this card: ring lines 12 to 14;
 * check beside line 20; arrow to Foo.bar labelled calls". In the order the caption brings them in (by sentence, then as listed).
 * Cut at MAX_SUMMARY characters, with how many more there are. Nothing when there are no marks.
 */
export function markSummary(marks: readonly TourMark[] | undefined): string {
  if (!marks?.length) return ''
  const phrases = marks
    .map((m, i) => ({ s: Math.max(m.sentence ?? 1, 1), i, text: markPhrase(m) }))
    .sort((x, y) => x.s - y.s || x.i - y.i)
    .map(p => p.text)
  const head = 'Marked on this card: '
  let out = head
  let used = 0
  for (const p of phrases) {
    const next = `${used ? '; ' : ''}${p}`
    // Always say the first mark, even a long one; the rest only while they fit.
    if (used && (out + next).length > MAX_SUMMARY) break
    out += next
    used++
  }
  const more = phrases.length - used
  return more > 0 ? `${out}; and ${more} more` : out
}

// ---- where a mark sits ---------------------------------------------------------------------------------------------

/**
 * The vertical extent of lines `[from, to]` on a card whose code rows start at `top` (card coordinates): from the first drawn row
 * in the range to the last. A card shows a long method as a skeleton with gaps, so a range may be drawn in part; none of it drawn is nothing.
 */
export function lineSpan(rows: readonly object[], lines: readonly [number, number], top: number, lineH: number): { y1: number; y2: number } | undefined {
  let first = -1
  let last = -1
  rows.forEach((r, i) => {
    const no = (r as { no?: number }).no
    if (typeof no === 'number' && no >= lines[0] && no <= lines[1]) {
      if (first < 0) first = i
      last = i
    }
  })
  return first < 0 ? undefined : { y1: top + first * lineH, y2: top + (last + 1) * lineH }
}

/** The same for a peek card: its rows are the lines `startLine` onward, at most `rowCount` of them. */
export function peekSpan(startLine: number, rowCount: number, lines: readonly [number, number], top: number, lineH: number): { y1: number; y2: number } | undefined {
  const a = Math.max(lines[0], startLine)
  const b = Math.min(lines[1], startLine + rowCount - 1)
  return a > b ? undefined : { y1: top + (a - startLine) * lineH, y2: top + (b - startLine + 1) * lineH }
}

export interface Curve { from: Pt; c1: Pt; c2: Pt; to: Pt }

/** A curve from the nearest edges of one card to the other's: side to side when they sit apart horizontally, else top to bottom. */
export function curveBetween(a: Box, b: Box): Curve {
  const mid = (box: Box) => ({ x: box.x + box.w / 2, y: box.y + box.h / 2 })
  const ma = mid(a)
  const mb = mid(b)
  if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
    const right = a.x + a.w <= b.x
    const from = { x: right ? a.x + a.w : a.x, y: ma.y }
    const to = { x: right ? b.x : b.x + b.w, y: mb.y }
    const bend = Math.max(40, Math.abs(to.x - from.x) / 2)
    const dir = right ? 1 : -1
    return { from, to, c1: { x: from.x + dir * bend, y: from.y }, c2: { x: to.x - dir * bend, y: to.y } }
  }
  const down = ma.y <= mb.y
  const from = { x: ma.x, y: down ? a.y + a.h : a.y }
  const to = { x: mb.x, y: down ? b.y : b.y + b.h }
  const bend = Math.max(40, Math.abs(to.y - from.y) / 2)
  const dir = down ? 1 : -1
  return { from, to, c1: { x: from.x, y: from.y + dir * bend }, c2: { x: to.x, y: to.y - dir * bend } }
}

/** A point on the cubic at t (0..1): where the label sits (t = .5) and which way the arrowhead points (the end of the curve). */
export function curvePoint(c: Curve, t: number): Pt {
  const u = 1 - t
  return {
    x: u ** 3 * c.from.x + 3 * u * u * t * c.c1.x + 3 * u * t * t * c.c2.x + t ** 3 * c.to.x,
    y: u ** 3 * c.from.y + 3 * u * u * t * c.c1.y + 3 * u * t * t * c.c2.y + t ** 3 * c.to.y,
  }
}

/** A line that wobbles a little, like a hand-drawn underline: `x1` to `x2` at height `y`, with a small wave every `step` pixels. */
export function wavyLine(x1: number, x2: number, y: number, amp = 1.6, step = 14): string {
  const n = Math.max(1, Math.round((x2 - x1) / step))
  const dx = (x2 - x1) / n
  let d = `M${x1.toFixed(1)} ${y.toFixed(1)}`
  for (let i = 0; i < n; i++) d += ` q${(dx / 2).toFixed(1)} ${(i % 2 ? amp : -amp).toFixed(1)} ${dx.toFixed(1)} 0`
  return d
}

/** A rounded rectangle outline as a path. */
export function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const k = Math.min(r, w / 2, h / 2)
  return `M${x + k} ${y} H${x + w - k} Q${x + w} ${y} ${x + w} ${y + k} V${y + h - k} Q${x + w} ${y + h} ${x + w - k} ${y + h} H${x + k} Q${x} ${y + h} ${x} ${y + h - k} V${y + k} Q${x} ${y} ${x + k} ${y} Z`
}
