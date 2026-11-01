// The one tour player on the canvas. Whoever made the tour (an agent, a file, the canvas's own review of changes) it plays
// the same way: a ghost cursor glides to the step's card, the rest dims, the lines it talks about are lit and a caption
// says why. The reader steps by hand. Everything that moves is skipped under reduced motion.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { ViewportPortal, useReactFlow, useStore, useViewport, type Edge, type Node } from '@xyflow/react'
import { CODE_PAD, HEADER_H, LINE_H, type CardData } from '../layout'
import type { CanvasToHostTour, FlowNode, Tour, TourStep } from '../types'
import { pathTo, resolveStep } from './cards'
import { Caption, type CaptionSlots, type StepAsk } from './Caption'
import { Cursor, GLIDE_MS } from './Cursor'
import { BAR_RESERVE, BUBBLE_MAX_H, CAPTION_H, CAPTION_W, captionPlace, firstLine, highlightedLines, lineY, type Box, type Pt } from './geometry'
import { FollowUps } from './FollowUpChips'
import { MarkLayer } from './MarkLayer'
import { Peek, PEEK_MAX_LINES, PEEK_W } from './Peek'
import { idle, reduce } from './player'
import { reviewSignature, tourFromChanges } from './review'
import { sanitizeNote, sanitizeStep, sanitizeTour } from './sanitize'
import { TourBar, type TourApi } from './TourBar'
import { useTourWait } from './WaitStep'

export interface TourEnv {
  down: FlowNode | null
  up: FlowNode | null
  showUp: boolean
  /** The graph of the flow the canvas shows now is drawn: a tour that arrived earlier waits for it. */
  ready: boolean
  /** Changes with the flow shown: a tour playing on another flow ends. */
  flowKey: string
  nodes: Node[]
  edges: Edge[]
  /** A card is being edited: the tour pauses itself and ignores keys. */
  editing: boolean
  setHidden: Dispatch<SetStateAction<Set<string>>>
  setFull: Dispatch<SetStateAction<Set<string>>>
  post(msg: CanvasToHostTour): void
}

const q = (key: string) => key.replace(/["\\]/g, '\\$&')

function useReducedMotion() {
  const [reduced, set] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => set(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable || !!t.closest('.monaco-editor'))

interface Motion {
  /** Which step and card this move is for: the caption and the spotlight wait until the cursor arrived. */
  sig: string
  seq: number
  stops: Pt[]
  /** The card (or peek card) the step points at, in flow coordinates. */
  focus: Box | null
  peek?: { box: Box; step: TourStep }
}

export function useTourPlayer(env: TourEnv & { changed: FlowNode[] }) {
  const rf = useReactFlow()
  const [state, dispatch] = useReducer(reduce, idle)
  const [pending, setPending] = useState<Tour | null>(null)
  const reduced = useReducedMotion()
  const tour = state.tour
  const step = tour?.steps[state.index]
  const stepKey = tour ? `${tour.id}:${state.index}` : ''
  // Hands-on steps (WaitStep.tsx): the reader has to do something before the tour goes on.
  const wait = useTourWait({ tour, index: state.index, post: env.post })
  const waitRef = useRef(wait)
  waitRef.current = wait
  /** The cards a review's steps were made from, by index: when a method is drawn twice, the review stays on its copy. Never sent anywhere. */
  const reviewKeys = useRef<string[]>([])

  const trees = useMemo(() => [env.down, env.showUp ? env.up : null], [env.down, env.up, env.showUp])
  const target = useMemo(() => (step ? resolveStep(trees, step, tour?.source === 'review' ? reviewKeys.current[state.index] : undefined) : ({ kind: 'none' } as const)), [step, trees, tour?.source, state.index])
  const spot = target.kind === 'card' ? target.node.key : undefined

  // ---- the host's messages -------------------------------------------------------------------------------
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      // What the host sends is rebuilt field by field (sanitize.ts): a malformed tour, step or note is dropped, never rendered.
      if (m?.type === 'tour') {
        const t = sanitizeTour(m.tour)
        if (t) setPending(t)
      } else if (m?.type === 'tourStep' && typeof m.id === 'string') {
        const step = m.step === undefined ? undefined : sanitizeStep(m.step)
        if (m.step === undefined || step) dispatch({ type: 'step', id: m.id, index: m.index, step: step ?? undefined })
      } else if (m?.type === 'tourResume' && typeof m.id === 'string') {
        dispatch({ type: 'resume', id: m.id })
      } else if (m?.type === 'tourNote' && typeof m.id === 'string') {
        const note = sanitizeNote(m.note)
        if (note) dispatch({ type: 'note', id: m.id, index: m.index, note })
      } else if (m?.type === 'tourSteps' && typeof m.id === 'string' && Array.isArray(m.steps) && m.steps.length <= 100) {
        // The agent edited the tour while the reader was paused: every step is rebuilt like a late step, and a list with a bad one is dropped.
        const steps = (m.steps as unknown[]).map(sanitizeStep)
        if (typeof m.index === 'number' && steps.every((s: TourStep | null) => s)) dispatch({ type: 'edit', id: m.id, steps: steps as TourStep[], index: m.index })
      } else if (m?.type === 'tourWaitDone' && typeof m.id === 'string' && typeof m.index === 'number') {
        if (playing.current?.id === m.id) waitRef.current?.onDone({ index: m.index, ok: m.ok === true, reason: typeof m.reason === 'string' ? m.reason.slice(0, 300) : undefined })
      } else if (m?.type === 'tourEnd' && typeof m.id === 'string') {
        dispatch({ type: 'end', id: m.id })
        setPending(p => (p?.id === m.id ? null : p))
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // A tour that arrives while the flow is still loading (the host sent `show`, then `tour`) plays once that flow is drawn.
  useEffect(() => {
    if (pending && env.ready) {
      dispatch({ type: 'start', tour: pending })
      setPending(null)
    }
  }, [pending, env.ready])

  // Another flow replaced the one the tour was playing on: the tour is over, and the host that sent it is told (it is ignored when
  // the host has already moved on to a newer tour).
  const playing = useRef<Tour | null>(null)
  playing.current = tour
  const waiting = useRef<Tour | null>(null)
  waiting.current = pending
  useEffect(() => {
    const t = playing.current
    // Not when a tour of the same name is already on its way: the host would take it for the end of that one.
    if (t && t.source !== 'review' && waiting.current?.id !== t.id) env.post({ type: 'tourExit', id: t.id })
    dispatch({ type: 'exit' })
  }, [env.flowKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // A card opened for editing: look away until the reader comes back.
  useEffect(() => {
    if (env.editing) dispatch({ type: 'pause' })
  }, [env.editing])

  // The review of changes is a tour whose steps are the cards still marked as changed: keep or undo one and it leaves the list.
  const sig = reviewSignature(env.changed)
  useEffect(() => {
    if (tour?.source !== 'review') return
    const next = tourFromChanges(env.changed)
    reviewKeys.current = next.keys
    dispatch({ type: 'steps', steps: next.tour.steps })
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps

  const startReview = () => {
    const next = tourFromChanges(env.changed)
    reviewKeys.current = next.keys
    dispatch({ type: 'start', tour: next.tour })
  }

  // The host keeps where the reader is, to answer an agent that asks.
  useEffect(() => {
    if (tour && tour.source !== 'review') env.post({ type: 'tourState', id: tour.id, index: state.index, paused: state.paused })
  }, [tour?.id, state.index, state.paused]) // eslint-disable-line react-hooks/exhaustive-deps

  const exit = () => {
    if (tour && tour.source !== 'review') env.post({ type: 'tourExit', id: tour.id })
    dispatch({ type: 'exit' })
  }
  // The reader asks about the step they are on: the tour waits (paused, the step stays lit) and the host puts the question to the agent that made it.
  const ask = (question: string) => {
    const q = question.replace(/\s+/g, ' ').trim().slice(0, 1000)
    if (!tour || tour.source !== 'agent' || !q) return false
    dispatch({ type: 'ask' })
    env.post({ type: 'tourAsk', id: tour.id, index: state.index, question: q })
    return true
  }
  const askRef = useRef<HTMLInputElement>(null)
  // A step that waits for the reader holds the tour: going on past it is refused, going back is not.
  const api: TourApi = { next: () => wait.allows(state.index + 1) && dispatch({ type: 'next' }), back: () => dispatch({ type: 'back' }), goto: index => wait.allows(index) && dispatch({ type: 'goto', index }), toggle: () => dispatch({ type: 'toggle' }), exit }
  const apiRef = useRef(api)
  apiRef.current = api

  // ---- keys --------------------------------------------------------------------------------------------
  const editingRef = useRef(env.editing)
  editingRef.current = env.editing
  const active = !!tour
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (editingRef.current || typing(e.target) || e.ctrlKey || e.altKey || e.metaKey) return
      const a = apiRef.current
      const onButton = e.target instanceof HTMLElement && e.target.tagName === 'BUTTON'
      if (e.key === ']' || e.key === 'ArrowRight') a.next()
      else if (e.key === '[' || e.key === 'ArrowLeft') a.back()
      else if (e.key === 'Escape') a.exit()
      // Space on a focused button already presses it.
      else if (e.key === ' ' && !onButton) a.toggle()
      // The ask box (a review of changes has no author to ask).
      else if ((e.key === '/' || (e.key === '?' && window.getSelection()?.isCollapsed !== false)) && askRef.current) askRef.current.focus()
      else if (/^[1-9]$/.test(e.key)) a.goto(Number(e.key) - 1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])

  // ---- moving to a step ------------------------------------------------------------------------------------
  const [motion, setMotion] = useState<Motion>({ sig: '', seq: 0, stops: [], focus: null })
  const [arrived, setArrived] = useState('')
  const expanded = useRef(new Set<string>())
  const tried = useRef(new Set<string>())
  const lastSig = useRef('')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const seq = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])

  // A card opened wide for a step folds back when the step is left.
  useEffect(
    () => () => {
      if (!expanded.current.size) return
      const keys = [...expanded.current]
      expanded.current.clear()
      tried.current.clear()
      env.setFull(f => {
        const next = new Set(f)
        keys.forEach(k => next.delete(k))
        return next
      })
    },
    [stepKey], // eslint-disable-line react-hooks/exhaustive-deps
  )

  useEffect(() => {
    if (!tour || !step || state.paused) {
      lastSig.current = ''
      return
    }
    const instant = reduced || document.hidden
    const arrive = (sig: string, ms: number) => {
      clearTimeout(timer.current)
      if (ms <= 0) setArrived(sig)
      else timer.current = setTimeout(() => setArrived(sig), ms)
    }
    const canvas = document.querySelector('.wv-canvas') as HTMLElement | null
    const cw = canvas?.clientWidth ?? 900
    const ch = canvas?.clientHeight ?? 600
    const panMs = instant ? 0 : 450
    const at = step.at

    if (target.kind === 'none' || !at) {
      // An intro, an outro, or code that is gone: the cursor stays where it is and the caption speaks alone.
      const sig = `${stepKey}|none`
      if (lastSig.current === sig) return
      lastSig.current = sig
      setMotion(m => ({ ...m, sig, focus: null, peek: undefined }))
      // The step before may have left the view beside the flow (a side card): come back to the flow, so the caption is not over empty canvas.
      const cards = rf.getNodes().filter(n => n.type === 'card')
      const { x, y, zoom } = rf.getViewport()
      const seen = cards.some(n => {
        const w = Number(n.style?.width) || 0
        const h = Number(n.style?.height) || 0
        // A sliver at the edge does not count: the middle of the card has to be in view.
        const mx = (n.position.x + w / 2) * zoom + x
        const my = (n.position.y + h / 2) * zoom + y
        return mx > 0 && mx < cw && my > 0 && my < ch
      })
      if (cards.length && !seen) void rf.fitView({ nodes: cards, padding: 0.15, maxZoom: 1, duration: panMs })
      arrive(sig, seen || !cards.length ? 0 : panMs)
      return
    }

    let stops: Pt[]
    let focus: Box
    let center: Pt
    let peek: Motion['peek']
    let id: string
    if (target.kind === 'card') {
      const key = target.node.key
      // A card inside a folded subtree: unfold the way to it.
      const path = pathTo(env.down, key) ?? pathTo(env.up, key)
      const folded = path?.slice(1).map(n => n.key) ?? []
      env.setHidden(h => (folded.some(k => h.has(k)) ? new Set([...h].filter(k => !folded.includes(k))) : h))
      const card = rf.getNode(key)
      // Not laid out yet (the flow is still drawing, or the way to it was just unfolded): this runs again when the nodes change.
      if (!card) return
      const data = card.data as CardData
      const line = firstLine(step.highlights, at.startLine)
      const top = HEADER_H + (data.chipsH ?? 0) + CODE_PAD
      const y = lineY(data.rows, line, top, LINE_H)
      if (y === undefined && data.compactable && !data.full && !tried.current.has(key)) {
        // The line sits in a gap of the card's skeleton: show every line for this step.
        tried.current.add(key)
        expanded.current.add(key)
        env.setFull(f => new Set(f).add(key))
        return
      }
      const w = Number(card.style?.width) || 400
      const h = Number(card.style?.height) || 200
      focus = { x: card.position.x, y: card.position.y, w, h }
      const header = { x: focus.x + Math.min(w - 70, 230), y: focus.y + HEADER_H / 2 }
      stops = y === undefined ? [header] : [header, { x: focus.x + Math.min(w - 40, 110), y: focus.y + y }]
      // The card and its caption side by side fill the middle of the canvas when there is room for both.
      const group = w + 16 + CAPTION_W
      center = { x: focus.x + (group + 24 <= cw ? group / 2 : Math.min(w / 2, cw / 2 - 24)), y: y === undefined ? focus.y + Math.min(h / 2, ch / 2 - 60) : focus.y + y }
      id = `${key}|${Math.round(y ?? -1)}`
    } else {
      // Beside everything that is drawn, so it never covers the flow.
      const cards = rf.getNodes().filter(n => n.type === 'card')
      const right = cards.length ? Math.max(...cards.map(n => n.position.x + (Number(n.style?.width) || 0))) : -80
      const top = cards.length ? Math.min(...cards.map(n => n.position.y)) : 0
      const p = step.peek!
      const rows = Math.min(PEEK_MAX_LINES, p.code.split('\n').length)
      focus = { x: right + 80, y: top, w: PEEK_W, h: HEADER_H + rows * LINE_H + 2 * CODE_PAD }
      const index = firstLine(step.highlights, at.startLine) - p.startLine
      const header = { x: focus.x + PEEK_W - 120, y: focus.y + HEADER_H / 2 }
      stops = index >= 0 && index < rows ? [header, { x: focus.x + 110, y: focus.y + HEADER_H + CODE_PAD + (index + 0.5) * LINE_H }] : [header]
      center = { x: focus.x + Math.min(PEEK_W / 2 + (cw - PEEK_W - 16 - CAPTION_W > 24 ? (16 + CAPTION_W) / 2 : 0), cw / 2 - 24), y: focus.y + Math.min(focus.h / 2, ch / 2 - 60) }
      peek = { box: focus, step }
      id = `peek|${Math.round(focus.x)}`
    }
    const sig = `${stepKey}|${id}`
    if (lastSig.current === sig) return
    lastSig.current = sig
    setMotion({ sig, seq: ++seq.current, stops, focus, peek })
    rf.setCenter(center.x, center.y, { zoom: 1, duration: panMs })
    arrive(sig, instant ? 0 : panMs + GLIDE_MS + 100)
  }, [stepKey, target, state.paused, env.nodes, reduced]) // eslint-disable-line react-hooks/exhaustive-deps

  /** The motion on hand is the current step's (a step waiting for its card to be laid out still shows the last one). */
  const current = !!tour && motion.sig.startsWith(`${stepKey}|`)
  const here = current && arrived === motion.sig
  /** The step is lit: not paused, or paused because the reader asked about it (the answer comes onto it). */
  const lit = here && (!state.paused || !!state.asking)
  const touring = lit && target.kind !== 'none'

  // The whole tour wears its agent's colour (the cursor, the outline, the lit lines, the caption's mark, the bar's progress).
  // Set as a property on the page, never pasted into a style sheet: the colour comes from the dock.
  const ink = tour?.agent?.color
  useEffect(() => {
    const root = document.documentElement.style
    if (ink) root.setProperty('--tour-ink', ink)
    else root.removeProperty('--tour-ink')
    return () => { root.removeProperty('--tour-ink') }
  }, [ink])

  // ---- the spotlight: per-card CSS by data-id, so no card's layout is touched ---------------------------------
  const css = useMemo(() => {
    if (!touring || !step) return ''
    const rules = ['.wv-touring .react-flow__node, .wv-touring .react-flow__edge { opacity: .35; transition: opacity .15s }']
    if (spot) {
      const k = q(spot)
      rules.push(`.wv-touring .react-flow__node[data-id="${k}"] { opacity: 1 }`)
      rules.push(`.wv-touring .react-flow__node[data-id="${k}"] .card { outline: 2px solid var(--tour-ink); outline-offset: 3px }`)
      // The wires into and out of it stay readable, so the reader still sees where the card sits in the flow.
      for (const e of env.edges) if (e.source === spot || e.target === spot) rules.push(`.wv-touring .react-flow__edge[data-testid="rf__edge-${q(e.id)}"] { opacity: .75 }`)
      const lines = highlightedLines(step.highlights)
      if (lines.length) rules.push(`.wv-touring .react-flow__node[data-id="${k}"] .ln:is(${lines.map(n => `[data-line="${n}"]`).join(',')}) { background: color-mix(in srgb, var(--tour-ink) 20%, transparent); box-shadow: inset 2px 0 0 var(--tour-ink) }`)
    }
    return rules.join('\n')
  }, [touring, step, spot, env.edges])

  /** A click on a card the tour is not at: the reader looked away, so the spotlight lifts. The click itself goes on. */
  const onClickCapture = (e: React.MouseEvent) => {
    if (!touring) return
    const id = (e.target as Element).closest?.('.react-flow__node')?.getAttribute('data-id')
    // A click wait is done by a click on the step's own card.
    wait.onCardClick(spot, id ?? undefined)
    if (id && id !== spot) dispatch({ type: 'pause' })
  }

  const flowLayer = tour && (
    <ViewportPortal>
      {current && motion.peek && <Peek step={motion.peek.step} box={motion.peek.box} />}
      {step?.marks?.length ? <MarkLayer step={step} stepKey={stepKey} focus={current && target.kind !== 'none' ? motion.focus : null} trees={trees} reduced={reduced} visible={touring} /> : null}
      <Cursor seq={motion.seq} stops={motion.stops} agent={tour.agent} visible={(!state.paused || !!state.asking) && target.kind !== 'none'} instant={reduced || document.hidden} />
    </ViewportPortal>
  )

  // After the last step's caption: the follow-up questions as chips (an agent's tour only: the question goes to the agent that made it).
  const slots: CaptionSlots = {
    wait: wait.slot,
    followUps: tour?.source === 'agent' && tour.followUps?.length && state.index === tour.steps.length - 1 && !state.asking ? <FollowUps items={tour.followUps} ask={ask} /> : null,
  }
  const captionLayer = tour && step && lit ? <CaptionLayer asking={state.asking === 'waiting' ? tour.agent?.label ?? 'the agent' : undefined} step={target.kind === 'peek' && step.state === 'ok' ? { ...step, state: 'offflow' } : step} focus={target.kind === 'none' ? null : motion.focus} ask={tour.source === 'agent' ? { ask, waiting: state.asking === 'waiting' } : undefined} slots={slots} /> : null

  return {
    state,
    api,
    /** The card the current step points at, for a source's own actions (Keep/Undo on a review). */
    cardKey: spot,
    touring,
    css,
    startReview,
    onClickCapture,
    /** Rendered before the canvas, so it stays the first of its kind in the page. */
    bar: (extras?: ReactNode): ReactNode => tour && <TourBar tour={tour} state={state} api={api} extras={extras} ask={tour.source === 'agent' ? { ask, inputRef: askRef } : undefined} nextBlocked={wait.blocked} />,
    /** Rendered inside <ReactFlow>: the cursor and the peek card live in flow coordinates. */
    flowLayer,
    /** Rendered after <ReactFlow>, inside the canvas: the caption lives in screen coordinates, so it stays readable at any zoom. */
    captionLayer,
  }
}

/** The caption beside its card, in canvas pixels, whatever the zoom. */
function CaptionLayer({ step, focus, asking, ask, slots }: { step: TourStep; focus: Box | null; asking?: string; ask?: StepAsk; slots?: CaptionSlots }) {
  const { x, y, zoom } = useViewport()
  const w = useStore(s => s.width)
  const h = useStore(s => s.height)
  const [height, setHeight] = useState(CAPTION_H)
  const onSize = useCallback((n: number) => setHeight(n), [])
  // Never taller than the canvas above the tour bar; what does not fit scrolls inside the bubble.
  const maxH = Math.max(140, Math.min(BUBBLE_MAX_H, h - BAR_RESERVE - 16))
  const place = focus ? captionPlace({ x: focus.x * zoom + x, y: focus.y * zoom + y, w: focus.w * zoom, h: focus.h * zoom }, { w, h }, BAR_RESERVE, { w: CAPTION_W, h: Math.min(height, maxH) }) : 'centre'
  return (
    <div className="tour-layer">
      <Caption key={`${step.title}|${step.caption}`} step={step} place={place} asking={asking} maxH={maxH} ask={ask} slots={slots} onSize={onSize} />
    </div>
  )
}
