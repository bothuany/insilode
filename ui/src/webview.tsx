// Insilode canvas as a VS Code webview: callers on the left, the method in the middle, callees on the right.
// All data comes through the extension host (which picks Roslyn, LSP, … per language); edits are applied
// by the host to the real document, so undo and the agent's Keep/Undo stay consistent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Background, BackgroundVariant, ControlButton, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker&inline'
import '@xyflow/react/dist/style.css'
import './styles.css'
import './webview.css'
import { placeOf, type CardChips, type ChipsView, type Detail, type TypeTree } from './chips'
import { HEADER_H, initialHidden, layout, layoutCallers, setEditMaxWidth, type EditTarget } from './layout'
import { definitionInFile, notify, registerIde } from './ide'
import { ActionsCtx, LANG_BY_EXT, nodeTypes, recolor, type CanvasActions, type Caret } from './nodes'
import { cardAt, samePath } from './tour/cards'
import { PointAsk, selectedLines, type Pointing } from './tour/PointAsk'
import { SelectionBar, type Picked, type SelectionAction } from './tour/SelectionBar'
import { useTourPlayer } from './tour/TourPlayer'
import { useGaze } from './gaze/Gaze'
import { loadCounter } from './loads'
import { AgentEditActions } from './agentEdit/AgentEditActions'
import { ImpactChip } from './impact/ImpactChip'
import { answered, asked, emptyFill, failed, messageOf, type Fill } from './impact/fill'
import { cutNote } from './impact/cardLabel'
import type { FlowNode, ImpactItem, ImpactResult } from './types'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }
/** What to draw: opaque to the webview, interpreted by the host's provider for that language. */
type Target = Record<string, unknown>
/** The engine that traced the flow (the host names it from the target's kind); a hint when it is the weaker one. */
interface Engine {
  name: string
  /** Set when this engine stands in for a better one: a few words on the bar, and the longer sentence as its tooltip. */
  note?: string
  hint?: string
}
declare global {
  interface Window {
    __FLOW__: { target: Target; label: string; dark: boolean; engine?: Engine }
  }
}

self.MonacoEnvironment = { getWorker: () => new editorWorker() }
monaco.editor.setTheme(window.__FLOW__.dark ? 'vs-dark' : 'vs')
// VS Code tells a webview about a theme change through its body's class: the code on the cards takes the new colours.
new MutationObserver(() => recolor(document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'vs' : 'vs-dark')).observe(document.body, { attributes: true, attributeFilter: ['class'] })
const vscode = acquireVsCodeApi()

// ---- request/response over postMessage ------------------------------------------------------
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
/** A host that never answers (a crashed analyzer, a dropped message) must not leave a spinner or a pending Map entry forever. */
const REQUEST_TIMEOUT_MS = 120_000
/** Below this zoom a card's code is too small to read: a flow that only fits smaller opens at its start instead. */
const READABLE_ZOOM = 0.55
/** The agent name of the Git-changes view's step (flow-view's GIT_AGENT): uncommitted work, not an agent's. */
const GIT_AGENT = 'Git'
function request<T>(op: string, payload: Record<string, unknown>): Promise<T> {
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`The editor did not answer "${op}" in time.`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, {
      resolve: v => { clearTimeout(timer); resolve(v as T) },
      reject: e => { clearTimeout(timer); reject(e) },
    })
    vscode.postMessage({ type: 'request', id, op, ...payload })
  })
}
window.addEventListener('message', e => {
  const m = e.data
  if (m?.type !== 'response') return
  const p = pending.get(m.id)
  pending.delete(m.id)
  if (m.error) p?.reject(new Error(m.error))
  else p?.resolve(m.data)
})

// Completion, hover, signature help and go-to-definition in the card editor come from the editor host's language servers.
registerIde(Object.values(LANG_BY_EXT), { request })

function find(n: FlowNode | null, key: string): FlowNode | null {
  if (!n) return null
  if (n.key === key) return n
  for (const c of n.children) {
    const hit = find(c.node, key)
    if (hit) return hit
  }
  return null
}

interface TurnSummary {
  id: number
  prompt: string
  agent: string
  at: number
  files: { file: string; plus: number; minus: number }[]
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** Every prompt that changed code, oldest first. Pick one to see only its changes on the cards. */
function Timeline({ turns, active, onPick, onUndo }: { turns: TurnSummary[]; active?: number; onPick: (id?: number) => void; onUndo: (id: number) => void }) {
  return (
    <div className="tl" role="dialog" aria-label="Agent edits by prompt">
      <p className="tl-lead">Pick a prompt to see only what it changed.</p>
      <ol className="tl-list">
        {turns.map((t, i) => {
          const plus = t.files.reduce((a, f) => a + f.plus, 0)
          const minus = t.files.reduce((a, f) => a + f.minus, 0)
          return (
            <li key={t.id} className={`tl-turn${active === t.id ? ' on' : ''}`}>
              <button className="tl-pick" onClick={() => onPick(active === t.id ? undefined : t.id)} aria-pressed={active === t.id}>
                <span className="tl-meta">
                  <span className="tl-step">Prompt {i + 1}</span>
                  <span>{t.agent}</span>
                  <span>{clock(t.at)}</span>
                </span>
                <span className="tl-prompt">{t.prompt || 'No prompt text'}</span>
                <span className="tl-files">
                  {t.files.length} {t.files.length === 1 ? 'file' : 'files'} <b className="plus">+{plus}</b> <b className="minus">−{minus}</b>
                </span>
              </button>
              <button className="btn ghost tl-undo" onClick={() => onUndo(t.id)} title="Put the files back the way they were before this prompt">
                {i === turns.length - 1 ? 'Undo' : 'Undo from here'}
              </button>
            </li>
          )
        })}
      </ol>
      {active !== undefined && (
        <button className="btn ghost tl-all" onClick={() => onPick(undefined)}>
          Show all changes
        </button>
      )}
    </div>
  )
}

function Flow() {
  const [target, setTarget] = useState<{ target: Target; label: string; engine?: Engine }>({ target: window.__FLOW__.target, label: window.__FLOW__.label, engine: window.__FLOW__.engine })
  const [down, setDown] = useState<FlowNode | null>(null)
  const [up, setUp] = useState<FlowNode | null>(null)
  const [showUp, setShowUp] = useState(true)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [full, setFull] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<EditTarget>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [caret, setCaret] = useState<Caret>()
  const [trace, setTrace] = useState<{ source: string; target: string } | null>(null)
  const [impactOpen, setImpactOpen] = useState(false)
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [turn, setTurn] = useState<number>()
  const [timelineOpen, setTimelineOpen] = useState(false)
  /** The target whose graph `down` holds: a tour that arrives while another flow loads waits until it is this one. */
  const [drawnFor, setDrawnFor] = useState<Target | null>(null)
  /** The card the reader points at to ask the agent about it (tour/PointAsk.tsx). */
  const [pointing, setPointing] = useState<Pointing | null>(null)
  const [proposal, setProposal] = useState<{ id?: string; answerable?: boolean; agent: string; title: string; spans: { file: string; start: number; end: number }[]; files: string[] } | null>(null)
  const [editHooks, setEditHooks] = useState<string[]>([])
  const turnRef = useRef(turn)
  turnRef.current = turn
  /** Impact and callers fill in after the canvas, and each can fail on its own: its own state, its own Retry. */
  const [impactFill, setImpactFill] = useState<Fill<ImpactResult>>(emptyFill)
  const impact = impactFill.value
  const [callersError, setCallersError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const { fitView, setCenter, getNode, getNodes, getViewport } = useReactFlow()
  const editingRef = useRef(editing)
  const actionsRef = useRef<CanvasActions>({ toggle() {}, toggleAll() {}, open() {}, toggleFull() {} })
  editingRef.current = editing

  // `?` with lines selected in a card's code: ask the agent about them (without a selection, `?` is the tour's ask box).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || e.ctrlKey || e.altKey || e.metaKey || editingRef.current) return
      if (e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable)) return
      const sel = selectedLines(window.getSelection())
      if (sel) {
        e.preventDefault()
        actionsRef.current.ask?.(sel.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Short notes from the editor help (no definition found, completion paused): shown on the bar for a few seconds.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    notify.show = message => {
      setStatus(message)
      clearTimeout(timer)
      timer = setTimeout(() => setStatus(now => (now === message ? '' : now)), 4000)
    }
    return () => {
      clearTimeout(timer)
      notify.show = () => {}
    }
  }, [])

  /** Counts loads: an answer that arrives after a newer load started (another target, a refresh) is dropped. */
  const loads = useRef(loadCounter()).current
  /**
   * Asks for the impact. The answer lands only while load `mine` is the newest. A failure is kept next to the answer it replaces,
   * so the chip says it failed and offers Retry: "Checking impact…" always ends in a result or an error.
   */
  const askImpact = useCallback((t: Target, mine: number, keep: boolean) => {
    const live = loads.whileCurrent(mine)
    live(() => setImpactFill(f => asked(f, keep)))
    request<ImpactResult>('impact', { target: t }).then(
      v => live(() => setImpactFill(answered(v))),
      e => live(() => setImpactFill(f => failed(f, e))),
    )
  }, [])
  const load = useCallback(async (t: Target, keepFolds: boolean) => {
    const mine = loads.start()
    try {
      // The callees are the flow; callers are an addition: when only they fail, the flow still draws and says so.
      const [graph, callers] = await Promise.allSettled([request<FlowNode>('graph', { target: t, turn: turnRef.current }), request<FlowNode | null>('callers', { target: t, turn: turnRef.current })])
      if (!loads.isCurrent(mine)) return
      if (graph.status === 'rejected') throw graph.reason
      const d = graph.value
      // A refresh whose callers failed keeps the callers already drawn: they are stale, not gone.
      const u = callers.status === 'fulfilled' ? callers.value : keepFolds ? treesRef.current.up : null
      setCallersError(callers.status === 'rejected' ? messageOf(callers.reason) : '')
      // These fill in after the canvas: an answer for a load that a newer one replaced must not land on the newer flow.
      const live = loads.whileCurrent(mine)
      request<TurnSummary[]>('timeline', {}).then(v => live(() => setTurns(v)), () => live(() => setTurns([])))
      if (d.file) request<string[]>('editHooks', { file: d.file }).then(v => live(() => setEditHooks(v)), () => live(() => setEditHooks([])))
      else setEditHooks([])
      setDown(d)
      setUp(u)
      setDrawnFor(t)
      if (!keepFolds) {
        // Callees two levels deep, callers one level: enough to read, not enough to drown. A change set is already cut down
        // to the paths that lead to a change, so all of it is open.
        setHidden(new Set([...initialHidden(d, t.kind === 'changes' ? Infinity : 2), ...(u ? initialHidden(u, 1) : [])]))
        setFull(new Set())
        setChipOpen({})
        setEditing(null)
      }
      setStatus('')
      setError('')
      // Impact walks callers far up; it can take a moment, so it fills in after the canvas.
      askImpact(t, mine, keepFolds)
    } catch (e) {
      if (loads.isCurrent(mine)) setError(messageOf(e))
    }
  }, [])

  /** Callers alone, after they failed: the flow stays as it is. */
  const retryCallers = () => {
    const live = loads.whileCurrent(loads.current())
    setCallersError('')
    request<FlowNode | null>('callers', { target: target.target, turn: turnRef.current }).then(
      v => live(() => {
        // Callers that were not drawn before arrive folded the way a first load folds them, not all open.
        if (v && !treesRef.current.up) setHidden(h => new Set([...h, ...initialHidden(v, 1)]))
        setUp(v)
      }),
      e => live(() => setCallersError(messageOf(e))),
    )
  }

  useEffect(() => {
    setDown(null)
    setUp(null)
    setError('')
    setCallersError('')
    // The previous flow's impact must not stand over a flow that has not loaded, or that failed.
    setImpactFill(emptyFill())
    setImpactOpen(false)
    setPointing(null)
    load(target.target, false)
  }, [target, load])

  // Picking a prompt in the timeline re-draws the cards with only that prompt's changes.
  const firstTurn = useRef(true)
  useEffect(() => {
    if (firstTurn.current) {
      firstTurn.current = false
      return
    }
    load(target.target, true)
  }, [turn]) // eslint-disable-line react-hooks/exhaustive-deps

  // Host messages: show another method, or refresh after a change on disk (unless mid-edit).
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      if (m?.type === 'show') setTarget({ target: m.target, label: m.label, engine: m.engine })
      if (m?.type === 'refresh' && !editingRef.current) load(target.target, true)
      // Mid-edit the editor's own cursor moves (the card's text is shown to the language servers): the canvas stays put.
      if (m?.type === 'cursor' && !editingRef.current) followCursor(m.file, m.line)
      if (m?.type === 'proposal') setProposal(m.proposal)
      // The type graph was rebuilt (the code index finished, an edit): chips that were missing may exist now.
      if (m?.type === 'typesChanged') refreshTypes.current()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [load, target]) // eslint-disable-line react-hooks/exhaustive-deps

  // Editor → canvas: highlight the innermost card holding the cursor; pan only if it is off-screen.
  const treesRef = useRef<{ down: FlowNode | null; up: FlowNode | null }>({ down: null, up: null })
  treesRef.current = { down, up }
  const followCursor = (file: string, line: number) => {
    const hit = cardAt([treesRef.current.down, treesRef.current.up], file, line)
    setSelected(hit?.key ?? null)
    const card = hit && getNode(hit.key)
    if (!card) return
    const { x, y, zoom } = getViewport()
    const el = document.querySelector('.wv-canvas') as HTMLElement
    const sx = card.position.x * zoom + x
    const sy = card.position.y * zoom + y
    if (sx < 0 || sy < 0 || sx > el.clientWidth - 40 || sy > el.clientHeight - 40) {
      setCenter(card.position.x + 200, card.position.y + 120, { zoom, duration: 250 })
    }
  }

  /** The flow as text with exact spans — what the agent gets when you ask it about this flow. */
  const flowText = () => {
    const lines = [`# Flow: ${target.label}`, '', 'This is the call flow the user is looking at on the Flow canvas. The file:line ranges are exact; read them directly instead of searching.', '']
    const walk = (n: FlowNode, d: number, via: string) => {
      const loc = n.file ? ` — \`${n.file}:${n.startLine}-${n.endLine}\`` : ''
      // A cut flow says so next to the card that was cut, so the agent does not take it for the whole flow.
      lines.push(`${'  '.repeat(d)}- ${via}**${n.label}** (${n.kind})${loc}${n.truncated ? ` [${cutNote(n.truncated).slice(1)}: the flow was cut at its size limit]` : ''}`)
      n.children.forEach(c => walk(c.node, d + 1, c.edgeKind === 'call' ? '' : `${c.edgeKind} → `))
    }
    if (up?.children.length) {
      lines.push('## Callers (upstream)')
      up.children.forEach(c => walk(c.node, 0, ''))
      lines.push('')
    }
    if (down) {
      lines.push('## Flow (downstream)')
      walk(down, 0, '')
    }
    if (impact?.items.length) lines.push('', `## Impact: ${impact.truncated ? 'at least ' : ''}${impact.items.length} ${impact.label}${impact.items.length === 1 ? '' : 's'}`, ...impact.items.map(i => `- ${i.label}`))
    return lines.join('\n')
  }

  // Track the canvas width: an editing card is sized to fit inside it.
  const [canvasW, setCanvasW] = useState(900)
  useEffect(() => {
    const el = document.querySelector('.wv-canvas') as HTMLElement
    const ro = new ResizeObserver(() => setCanvasW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Type chips (see chips.ts): the workspace types in each card's signature. Asked from the host once the flow is drawn, so the first paint never waits for the type graph.
  const [typeChips, setTypeChips] = useState<Record<string, CardChips>>({})
  const [chipOpen, setChipOpen] = useState<Record<string, string[]>>({})
  const [details, setDetails] = useState<Map<string, Detail>>(new Map())
  const [diagramOk, setDiagramOk] = useState(false)
  const detailsRef = useRef(details)
  const chipLoads = useRef(0)

  const fetchChips = useCallback(() => {
    const keyOf = new Map<string, string>()
    const nodes: { key: string; file: string; line: number; endLine: number }[] = []
    const visit = (n: FlowNode | null) => {
      if (!n) return
      if (n.file && n.code && !n.schema && !keyOf.has(placeOf(n))) {
        keyOf.set(placeOf(n), n.key)
        nodes.push({ key: n.key, file: n.file, line: n.startLine, endLine: n.endLine })
      }
      n.children.forEach(c => visit(c.node))
    }
    visit(treesRef.current.down)
    visit(treesRef.current.up)
    if (!nodes.length) return
    const mine = ++chipLoads.current
    request<{ chips: Record<string, CardChips>; ready: boolean; diagramAvailable?: boolean }>('typeChips', { nodes }).then(
      res => {
        if (mine !== chipLoads.current || !res) return
        setDiagramOk(!!res.diagramAvailable)
        const byPlace: Record<string, CardChips> = {}
        for (const [place, key] of keyOf) if (res.chips?.[key]) byPlace[place] = res.chips[key]
        // A type graph still being built has no chips yet: what is shown stays until the host says the types changed.
        if (res.ready || Object.keys(byPlace).length) setTypeChips(byPlace)
      },
      () => {},
    )
  }, [])
  useEffect(() => {
    if (down) fetchChips()
  }, [down, up, fetchChips])

  const loadDetail = useCallback((id: string, refresh = false) => {
    if (!refresh && detailsRef.current.has(id)) return
    const put = (d: Detail) => {
      detailsRef.current = new Map(detailsRef.current).set(id, d)
      setDetails(detailsRef.current)
    }
    if (!refresh) put('loading')
    request<TypeTree | undefined>('typeDetail', { ref: id, depth: 0 }).then(
      tree => put(tree ?? 'missing'),
      () => put('missing'),
    )
  }, [])
  const refreshTypes = useRef(() => {})
  refreshTypes.current = () => {
    fetchChips()
    for (const id of detailsRef.current.keys()) loadDetail(id, true)
  }
  const chipsView = useMemo<ChipsView>(() => ({ byPlace: typeChips, open: chipOpen, details }), [typeChips, chipOpen, details])

  const { nodes, edges } = useMemo(() => {
    if (!down) return { nodes: [], edges: [] }
    setEditMaxWidth(canvasW - 48)
    const d = layout(down, hidden, full, selected, new Set(), editing, chipsView)
    if (!showUp || !up) return d
    const rootCard = d.nodes.find(n => n.id === down.key)
    const u = layoutCallers(up, down.key, rootCard?.position.y ?? 0, hidden, full, selected, new Set(), editing, chipsView)
    return { nodes: [...d.nodes, ...u.nodes], edges: [...d.edges, ...u.edges] }
  }, [down, up, hidden, full, showUp, editing, selected, canvasW, chipsView])

  // Fit the whole flow when it is still readable. A flow runs left to right, so a long one fitted whole is a strip of
  // unreadable cards: then show its start (the leftmost card, a caller when callers are on) at a zoom where code
  // can be read, and the rest is a pan to the right. The fit button does the same as opening a flow.
  const frame = useCallback(() => {
    const el = document.querySelector('.wv-canvas') as HTMLElement | null
    const cards = getNodes().filter(n => n.type === 'card')
    if (!el || !cards.length) return
    const minX = Math.min(...cards.map(n => n.position.x))
    const maxX = Math.max(...cards.map(n => n.position.x + (Number(n.style?.width) || 0)))
    const minY = Math.min(...cards.map(n => n.position.y))
    const maxY = Math.max(...cards.map(n => n.position.y + (Number(n.style?.height) || 0)))
    const fit = Math.min(el.clientWidth / (maxX - minX + 80), el.clientHeight / (maxY - minY + 80))
    if (fit >= READABLE_ZOOM) {
      fitView({ padding: 0.1, maxZoom: 1, duration: 250 })
      return
    }
    const zoom = 0.85
    setCenter(minX - 40 + el.clientWidth / zoom / 2, minY - 40 + el.clientHeight / zoom / 2, { zoom, duration: 250 })
  }, [getNodes, fitView, setCenter])

  useEffect(() => {
    if (!down) return
    const t = setTimeout(frame, 50)
    return () => clearTimeout(t)
  }, [down?.symbolId, showUp]) // eslint-disable-line react-hooks/exhaustive-deps

  // Callers turned on and there are none: say so, or the chip seems to do nothing.
  useEffect(() => {
    if (showUp && up && !up.children.length) notify.show('No callers: nothing in the index calls this method.')
  }, [showUp, up])

  const actions = useMemo<CanvasActions>(
    () => ({
      toggle: key =>
        setHidden(h => {
          const next = new Set(h)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        }),
      toggleAll: key =>
        setHidden(h => {
          const n = find(down, key) ?? find(up, key)
          if (!n) return h
          const next = new Set(h)
          const anyHidden = n.children.some(c => next.has(c.node.key))
          n.children.forEach(c => (anyHidden ? next.delete(c.node.key) : next.add(c.node.key)))
          return next
        }),
      toggleFull: key =>
        setFull(f => {
          const next = new Set(f)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        }),
      open: key => {
        const n = find(down, key) ?? find(up, key)
        if (n?.file) vscode.postMessage({ type: 'open', file: n.file, line: n.startLine })
      },
      reveal: key => {
        const n = find(down, key) ?? find(up, key)
        setSelected(key)
        if (n?.file) vscode.postMessage({ type: 'reveal', file: n.file, line: n.startLine })
      },
      edit: (key, at) => {
        const n = find(down, key) ?? find(up, key)
        if (!n?.file) return
        setCaret(at)
        setSelected(key)
        setTrace(null)
        setEditing({ key, file: n.file, startLine: n.startLine })
        // Monaco needs an untransformed canvas: put the card in view at 100% and keep it there while editing.
        // Keep the clicked line where it was on screen, so the jump to 100% feels like a zoom, not a move.
        setTimeout(() => {
          const card = getNode(key)
          if (!card) return
          const lineY = at ? HEADER_H + (at.line - n.startLine) * 18 : 160
          const el = document.querySelector('.wv-canvas') as HTMLElement
          // A card wider than the canvas keeps its left edge (line numbers, indentation) in view.
          const w = Number(card.style?.width) || 560
          setCenter(card.position.x + w / 2, card.position.y + Math.min(lineY, el.clientHeight / 2 - 40), { zoom: 1, duration: 220 })
        }, 30)
      },
      definition: (key, at) => {
        const n = find(down, key) ?? find(up, key)
        if (n?.file) void definitionInFile(n.file, at.line, at.column)
      },
      focusLine: (key, line) => {
        const n = find(down, key) ?? find(up, key)
        const card = getNode(key)
        if (!n || !card) return
        setSelected(key)
        const el = document.querySelector('.wv-canvas') as HTMLElement
        const w = Number(card.style?.width) || 400
        const chipsH = (card.data as { chipsH?: number }).chipsH ?? 0
        setCenter(card.position.x + Math.min(w / 2, el.clientWidth / 2 - 24), card.position.y + HEADER_H + chipsH + (line - n.startLine) * 18, { zoom: 1, duration: 260 })
      },
      chipToggle: (key, path, typeId) => {
        setChipOpen(o => {
          const cur = new Set(o[key] ?? [])
          // Closing a chip closes what was opened under it.
          if (cur.has(path)) [...cur].forEach(p => (p === path || p.startsWith(`${path}/`)) && cur.delete(p))
          else cur.add(path)
          return { ...o, [key]: [...cur] }
        })
        loadDetail(typeId)
      },
      openType: (file, line) => vscode.postMessage({ type: 'open', file, line }),
      typeDiagram: diagramOk ? id => vscode.postMessage({ type: 'typeDiagram', id }) : undefined,
      ask: key => {
        const n = find(down, key) ?? find(up, key)
        if (!n?.file) return
        // Lines selected in this card's code are what is asked about; without a selection, the whole method.
        const sel = selectedLines(window.getSelection())
        const lines = sel?.key === key ? sel : undefined
        setPointing({ key, file: n.file, startLine: lines?.startLine ?? n.startLine, endLine: lines?.endLine ?? n.endLine, label: n.label.replace(/\s*▸\s*/g, '.') })
      },
      mention: key => {
        const n = find(down, key) ?? find(up, key)
        if (n?.file) vscode.postMessage({ type: 'mention', file: n.file, start: n.startLine - 1, end: n.endLine - 1 })
      },
      trace: (source, target) => setTrace(source && target ? { source, target } : null),
      caret,
      cancelEdit: () => setEditing(null),
      keep: async key => {
        const n = find(down, key) ?? find(up, key)
        if (!n?.file) return
        try {
          await request('keep', { file: n.file })
        } catch (e) {
          setStatus(String((e as Error).message ?? e))
          return
        }
        await load(target.target, true)
      },
      undo: async key => {
        const n = find(down, key) ?? find(up, key)
        if (!n?.file) return
        let res: { ok: boolean; message?: string }
        try {
          res = await request<{ ok: boolean; message?: string }>('undo', { file: n.file, startLine: n.startLine, endLine: n.endLine })
        } catch (e) {
          setStatus(String((e as Error).message ?? e))
          return
        }
        await load(target.target, true)
        // After the load: a successful load clears the status line, and the reason must stay readable.
        if (!res.ok) setStatus(res.message ?? 'Could not undo the change.')
      },
      save: async (key, code, session) => {
        const n = find(down, key) ?? find(up, key)
        if (!n?.file || n.code == null) return 'This card is gone. Refresh the flow and try again.'
        const res = await request<{ ok: boolean; message?: string }>('save', { file: n.file, startLine: n.startLine, endLine: n.endLine, original: n.code, code, session })
        if (!res.ok) return res.message ?? 'Could not save.'
        setEditing(null)
        await load(target.target, true)
        return undefined
      },
    }),
    [down, up, getNode, setCenter, load, target, caret, loadDetail, diagramOk],
  )

  actionsRef.current = actions

  // The selection bar (tour/SelectionBar.tsx): the lines were captured when the bar showed, so the click cannot move them.
  const selectionAct = (action: SelectionAction, picked: Picked) => {
    const n = find(down, picked.key) ?? find(up, picked.key)
    if (!n?.file) return
    const label = n.label.replace(/\s*▸\s*/g, '.')
    if (action === 'mention') {
      vscode.postMessage({ type: 'mention', file: n.file, start: picked.startLine - 1, end: picked.endLine - 1 })
    } else if (action === 'explain') {
      vscode.postMessage({ type: 'pointAsk', kind: 'explain', file: n.file, startLine: picked.startLine, endLine: picked.endLine, label, question: '' })
      notify.show('Asked the agent to explain it: the answer plays here as a tour.')
    } else {
      setPointing({ key: picked.key, file: n.file, startLine: picked.startLine, endLine: picked.endLine, label, kind: action })
    }
    window.getSelection()?.removeAllRanges()
  }

  // Changed cards in call order: the outermost caller first, then down the flow as it runs.
  const changed = useMemo(() => {
    const ups: { n: FlowNode; depth: number }[] = []
    const walkUp = (n: FlowNode, depth: number) => n.children.forEach(c => {
      if (c.node.diff) ups.push({ n: c.node, depth })
      walkUp(c.node, depth + 1)
    })
    if (up && showUp) walkUp(up, 1)
    const downs: FlowNode[] = []
    const walkDown = (n: FlowNode) => {
      if (n.diff) downs.push(n)
      n.children.forEach(c => !hidden.has(c.node.key) && walkDown(c.node))
    }
    if (down) walkDown(down)
    // Only cards that are drawn (from the layout itself: the canvas store may not have them yet).
    const drawn = new Set(nodes.map(n => n.id))
    return [...ups.sort((a, b) => b.depth - a.depth).map(x => x.n), ...downs].filter(n => drawn.has(n.key))
  }, [down, up, showUp, hidden, nodes]) // eslint-disable-line react-hooks/exhaustive-deps

  // The tour player: the review of changes below, an agent's tour or a tour file all play through it (src/tour).
  const tour = useTourPlayer({
    down,
    up,
    showUp,
    ready: !!down && drawnFor === target.target,
    flowKey: JSON.stringify(target.target),
    nodes,
    edges,
    editing: !!editing,
    setHidden,
    setFull,
    post: msg => vscode.postMessage(msg),
    changed,
  })
  // Where agents are reading and editing (src/gaze): painted on this canvas only, never moving it.
  const gaze = useGaze({ down, up, showUp, nodes, quiet: !!tour.state.tour, post: msg => vscode.postMessage(msg) })
  const isReview = tour.state.tour?.source === 'review'
  const reviewNode = isReview && turn === undefined && tour.cardKey ? (find(down, tour.cardKey) ?? find(up, tour.cardKey)) : null

  const undoFrom = async (id: number) => {
    const res = await request<{ ok: boolean; message?: string }>('undoFrom', { turn: id })
    if (!res.ok) setStatus(res.message ?? 'Could not undo the changes.')
    setTurn(undefined)
    setTimelineOpen(false)
    await load(target.target, true)
  }

  // Cards an agent is asking to edit right now: the method holds a proposed diff span (or its whole file).
  const proposed = useMemo(() => {
    if (!proposal) return [] as FlowNode[]
    const drawn = new Set(nodes.map(n => n.id))
    const hits: FlowNode[] = []
    const visit = (n: FlowNode | null) => {
      if (!n) return
      if (n.file && (proposal.files.some(f => samePath(f, n.file!)) || proposal.spans.some(sp => samePath(sp.file, n.file!) && sp.start <= n.endLine && sp.end >= n.startLine)) && drawn.has(n.key)) hits.push(n)
      n.children.forEach(c => visit(c.node))
    }
    visit(down)
    visit(up)
    return hits
  }, [proposal, down, up, nodes]) // eslint-disable-line react-hooks/exhaustive-deps
  // The lines the reader points at to ask about them: a band, in the style of a tour's highlights.
  const pointCss = pointing && (pointing.startLine > 0 && pointing.endLine - pointing.startLine < 400)
    ? `.react-flow__node[data-id="${pointing.key.replace(/["\\]/g, '\\$&')}"] .ln:is(${Array.from({ length: pointing.endLine - pointing.startLine + 1 }, (_, i) => `[data-line="${pointing.startLine + i}"]`).join(',')}) { background: color-mix(in srgb, var(--fl-signal) 20%, transparent); box-shadow: inset 2px 0 0 var(--fl-signal) }`
    : ''
  const proposedCss = proposed.map(n => `.react-flow__node[data-id="${n.key}"] .card { outline: 1.5px dashed var(--fl-signal); outline-offset: 3px; }`).join('\n')

  // Bring the first marked card into view, so the question in the dialog has its answer on screen.
  useEffect(() => {
    const first = proposed[0]
    const card = first && getNode(first.key)
    if (!card) return
    const el = document.querySelector('.wv-canvas') as HTMLElement
    const { x, y, zoom } = getViewport()
    const sx = card.position.x * zoom + x
    const sy = card.position.y * zoom + y
    if (sx < 0 || sy < 0 || sx > el.clientWidth - 60 || sy > el.clientHeight - 60) {
      setCenter(card.position.x + (Number(card.style?.width) || 400) / 2, card.position.y + 120, { zoom: Math.max(zoom, 0.8), duration: 250 })
    }
  }, [proposed.map(n => n.key).join()]) // eslint-disable-line react-hooks/exhaustive-deps

  // While one prompt is picked, cards show that prompt's change only; Keep/Undo act on everything, so they wait.
  // Cards are read-only while a tour plays (their code is what the tour talks about); editing is back when it ends.
  const touring = tour.state.tour !== null
  const cardActions = useMemo(() => ({ ...(turn === undefined ? actions : { ...actions, keep: undefined, undo: undefined }), ...(touring ? { edit: undefined } : {}), editHooks }), [actions, turn, editHooks, touring])
  const locked = !!editing
  const { owner, member } = (() => {
    const clean = target.label.replace(/\s*▸\s*/g, '.')
    const at = clean.lastIndexOf('.')
    return at > 0 ? { owner: clean.slice(0, at + 1), member: clean.slice(at + 1) } : { owner: '', member: clean }
  })()
  // Hovering a call line lights its wire and the card it reaches; plain CSS, so nothing re-lays out.
  const traceCss = trace
    ? `[data-testid="rf__edge-e-${trace.source}-${trace.target}"] path, [data-testid="rf__edge-u-${trace.source}-${trace.target}"] path { stroke-width: 2.4 !important; filter: drop-shadow(0 0 4px currentColor); }
       .react-flow__edge:not([data-testid$="-${trace.source}-${trace.target}"]) { opacity: .35; }
       .react-flow__node[data-id="${trace.target}"] .card { box-shadow: 0 0 0 1.5px var(--k), var(--fl-lift); }`
    : ''
  // The timeline is the whole workspace's; the chip counts only the steps that changed a file of this flow.
  const flowFiles = useMemo(() => {
    const out: string[] = []
    const walk = (n: FlowNode | null) => {
      if (!n) return
      if (n.file) out.push(n.file)
      n.children.forEach(c => walk(c.node))
    }
    walk(down)
    walk(up)
    return out
  }, [down, up])
  /** What the Git changes on the canvas are measured against, when it is not HEAD ("main"). */
  const since = changed.find(n => n.diff?.base)?.diff?.base
  const flowTurns = useMemo(() => turns.filter(t => t.files.some(f => flowFiles.some(x => samePath(x, f.file)))), [turns, flowFiles])
  /** An impact row that names a place: the host shows the flow of the function there. */
  const openImpact = (item: ImpactItem) => {
    if (item.file && item.line > 0) vscode.postMessage({ type: 'showFlowAt', file: item.file, line: item.line })
  }
  return (
    <div className={`wv${tour.touring ? ' wv-touring' : ''}`}>
      <style>{traceCss + proposedCss + pointCss + tour.css}</style>
      <header className="wv-bar">
        <div className="wv-title" title={target.label}>
          <span className="owner">{owner}</span>
          <span className="member">{member}</span>
        </div>
        {target.engine && (
          <span className={`engine${target.engine.hint ? ' weaker' : ''}`} title={target.engine.hint ?? `Traced by ${target.engine.name}`}>
            {target.engine.name}
            {target.engine.note && <span className="engine-hint"> · {target.engine.note}</span>}
          </span>
        )}
        {/* Callers and the impact chip are on the bar from the first frame, before the flow arrives, so the bar keeps its lines: on a
            narrow canvas, chips appearing later wrapped it onto another line and moved the canvas below it (a layout shift). */}
        <button className="chip" aria-pressed={showUp} disabled={!down} onClick={() => setShowUp(v => !v)} title="Show who calls this method, to the left">
          Callers
        </button>
        <ImpactChip fill={impactFill} ready={!!down} blocked={!down && !!error} open={impactOpen} onOpenChange={setImpactOpen} onRetry={() => askImpact(target.target, loads.current(), true)} onOpen={openImpact} />
        {(flowTurns.length > 0 || turn !== undefined) && (
          <span className="impact-wrap">
            <button className={`chip${turn !== undefined ? ' agent' : ''}`} aria-expanded={timelineOpen} onClick={() => setTimelineOpen(v => !v)} title="Changes by prompt (all of them; Undo works across files)">
              {turn !== undefined
                ? `Prompt ${turns.findIndex(t => t.id === turn) + 1} of ${turns.length}`
                : flowTurns.every(t => t.agent === GIT_AGENT)
                  ? since ? `Changes since ${since}` : 'Uncommitted changes'
                  : `${flowTurns.length} ${flowTurns.length === 1 ? 'prompt' : 'prompts'} changed this flow`}
            </button>
            {timelineOpen && <Timeline turns={turns} active={turn} onPick={id => setTurn(id)} onUndo={undoFrom} />}
          </span>
        )}
        {changed.length > 0 && tour.state.tour === null && (
          <button className="chip agent" onClick={tour.startReview} title="Step through the changed cards in call order">
            Review {changed.length} {changed.length === 1 ? 'change' : 'changes'}
          </button>
        )}
        <span className="wv-spacer" />
        {status && <span className="wv-status" title={status}>{status}</span>}
        {gaze.toggle}
        <button className="icon-btn" onClick={() => load(target.target, true)} title="Trace the flow again" aria-label="Trace the flow again">
          ↻
        </button>
        <button className="ask" disabled={!down} onClick={() => vscode.postMessage({ type: 'ask', label: target.label, context: flowText() })} title="Hand this flow to the agent you chose">
          Ask about this flow
        </button>
      </header>
      <div className={`wv-canvas${locked ? ' locked' : ''}`} onClickCapture={tour.onClickCapture}>
        {!down && (
          <div className="wv-empty">
            {error ? (
              <>
                <p className="wv-empty-title">Could not trace this flow</p>
                <p className="wv-empty-body">{error}</p>
                <button className="btn solid" onClick={() => load(target.target, false)}>Try again</button>
              </>
            ) : (
              <>
                <span className="pulse" />
                <p className="wv-empty-body">Tracing calls from {member}…</p>
              </>
            )}
          </div>
        )}
        {down && (error || callersError) && (
          // The flow that is drawn stays; what failed to refresh or to load is said here, each with its own Retry.
          <div className="wv-notes">
            {error && (
              <div className="wv-note" role="alert">
                <span>Could not refresh the flow: {error}</span>
                <button className="btn ghost" onClick={() => load(target.target, true)}>Retry</button>
              </div>
            )}
            {callersError && (
              <div className="wv-note" role="alert">
                <span>Could not load the callers: {callersError}</span>
                <button className="btn ghost" onClick={retryCallers}>Retry</button>
              </div>
            )}
          </div>
        )}
        {proposal && (
          <div className="proposal" role="status">
            <span className="proposal-dot" />
            <span>
              {proposal.agent} wants to edit {proposed.length ? `${proposed.length} ${proposed.length === 1 ? 'method' : 'methods'} on this flow` : 'code outside this flow'}.{proposal.answerable ? '' : ' Answer in the dialog.'}
            </span>
            {proposal.answerable && (
              <>
                <button className="btn ghost" onClick={() => vscode.postMessage({ type: 'answer', id: proposal.id, accept: false })}>Reject</button>
                <button className="btn solid" onClick={() => vscode.postMessage({ type: 'answer', id: proposal.id, accept: true })}>Accept</button>
              </>
            )}
          </div>
        )}
        {tour.bar(
          reviewNode && <AgentEditActions node={reviewNode} actions={actions} request={request} reload={() => load(target.target, true)} setStatus={setStatus} />,
        )}
        <ActionsCtx.Provider value={cardActions}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            minZoom={0.1}
            maxZoom={2}
            panOnDrag={!locked}
            zoomOnScroll={!locked}
            zoomOnPinch={!locked}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
            {gaze.flowLayer}
            {tour.flowLayer}
            <Controls showInteractive={false} showFitView={false} position="bottom-left">
              <ControlButton onClick={frame} title="Fit view" aria-label="Fit view">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 30"><path d="M3.692 4.63c0-.53.4-.938.939-.938h5.215V0H4.708C2.13 0 0 2.054 0 4.63v5.216h3.692V4.631zM27.354 0h-5.2v3.692h5.17c.53 0 .984.4.984.939v5.215H32V4.631A4.624 4.624 0 0027.354 0zm.954 24.83c0 .532-.4.94-.939.94h-5.215v3.768h5.215c2.577 0 4.631-2.13 4.631-4.707v-5.139h-3.692v5.139zm-23.677.94c-.531 0-.939-.4-.939-.94v-5.138H0v5.139c0 2.577 2.13 4.707 4.708 4.707h5.138V25.77H4.631z" /></svg>
              </ControlButton>
            </Controls>
            <MiniMap pannable zoomable position="bottom-right" maskColor="var(--fl-mask)" nodeColor={n => (n.type === 'frame' ? 'transparent' : 'var(--fl-line-strong)')} nodeBorderRadius={3} />
          </ReactFlow>
        </ActionsCtx.Provider>
        {gaze.overlay}
        {tour.captionLayer}
        <SelectionBar hidden={!!pointing || !!editing} onAct={selectionAct} />
        {pointing && (
          <PointAsk
            pointing={pointing}
            onClose={() => setPointing(null)}
            onSend={question => {
              vscode.postMessage({ type: 'pointAsk', kind: pointing.kind ?? 'ask', file: pointing.file, startLine: pointing.startLine, endLine: pointing.endLine, label: pointing.label, question: question.replace(/\s+/g, ' ').trim().slice(0, 1000) })
              setPointing(null)
              notify.show(pointing.kind === 'edit' ? 'Sent to the agent: its change shows here to keep or undo.' : 'Question sent to the agent: its answer plays here as a tour.')
            }}
          />
        )}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <Flow />
  </ReactFlowProvider>,
)
