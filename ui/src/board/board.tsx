// Insilode board webview: draws a BoardSpec (DTO relations, architecture, plans) on a pan/zoom canvas. The host
// (flow-view/src/boardPanel.ts) sends the spec and recomputes it when the user changes focus, search or filters:
// those controls only post a 'rebuild' with the new options, so big graphs stay a host-side computation.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MiniMap, ReactFlow, ReactFlowProvider, useReactFlow, useViewport, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './board.css'
import './emptyState.css'
import './tour.css'
import type { BoardNode, BoardSpec } from './spec'
import { adjacency, buildLayout, groupsHolding, groupDepth, matchNodes, type Layout } from './model'
import { countChanges, emptyActions, KIND_COLOR, ROLE_CHIPS, type BoardOpts, type BoardRef, type Bootstrap, type ExportFormat, type ToHost, type ToWebview } from './protocol'
import { ActionsCtx, nodeTypes, type Actions, type CardData, type GroupData } from './cards'
import { CalloutLayer } from './callouts'
import { EmptyState } from './emptyState'
import { EdgeLayer } from './edges'
import { sequenceSvg, toSvg, type Palette } from './svg'
import { SequenceView, type SequenceApi } from './SequenceView'
import type { Lit } from './sequence'
import { idle, reduce } from '../tour/player'
import { TourBar } from '../tour/TourBar'
import { Caption } from '../tour/Caption'
import { captionPlace, CAPTION_W } from '../tour/geometry'
import { highlightLit, litOf, litVisible, stepOpens, stepsOf, stepsSignature, tourOf, type StepLit } from './steps'
import { Legend } from './legend'

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void }
declare global {
  interface Window {
    __BOARD__: Bootstrap
  }
}

const vscode = acquireVsCodeApi()
const post = (m: ToHost) => vscode.postMessage(m)

const NO_NODES: ReadonlySet<string> = new Set()
const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'board'

/** The theme's colours as plain rgb(), for the SVG and PNG export (those cannot use CSS variables). */
function readPalette(): Palette {
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
  const root = document.querySelector('.bd') ?? document.body
  const resolve = (token: string, fallback: string) => {
    const el = document.createElement('div')
    el.style.cssText = `position:absolute;visibility:hidden;color:${fallback}`
    el.style.color = `var(${token}, ${fallback})`
    root.appendChild(el)
    const c = getComputedStyle(el).color
    el.remove()
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = '#000'
    probe.fillStyle = c
    probe.fillRect(0, 0, 1, 1)
    const d = probe.getImageData(0, 0, 1, 1).data
    return `rgb(${d[0]},${d[1]},${d[2]})`
  }
  return {
    canvas: resolve('--fl-canvas', '#181818'),
    card: resolve('--fl-card', '#1e1e1e'),
    line: resolve('--fl-line-strong', '#3a3a3a'),
    text: resolve('--fl-text', '#d4d4d4'),
    muted: resolve('--fl-muted', '#8b8b8b'),
    signal: resolve('--fl-signal', '#6f86ff'),
    add: resolve('--fl-add', '#5fe0a1'),
    del: resolve('--fl-del', '#ff6b7d'),
    warn: resolve('--fl-warn', '#e6a23c'),
    groupFill: resolve('--fl-line', '#262626'),
  }
}

async function pngOf(svg: string, width: number, height: number): Promise<string> {
  // Blob URLs are not allowed by the panel's CSP, data: URLs are.
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const scale = Math.min(2, 8000 / Math.max(width, height, 1))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, width, height)
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

const clean = (o: BoardOpts): BoardOpts => {
  const out: BoardOpts = {}
  if (o.query?.trim()) out.query = o.query.trim()
  if (o.focusId) out.focusId = o.focusId
  if (o.depth !== undefined) out.depth = o.depth
  if (o.includeEntities !== undefined) out.includeEntities = o.includeEntities
  if (o.includeEnums !== undefined) out.includeEnums = o.includeEnums
  if (o.hideRoles?.length) out.hideRoles = o.hideRoles
  if (o.collapseLevel !== undefined) out.collapseLevel = o.collapseLevel
  return out
}

/** The caption of the current step: beside what it lights (graph), or in the top right corner (sequence, which fits on one screen). */
function StepCaption({ step, layout, lit, sequence, stage }: { step: import('../types').TourStep; layout: Layout; lit?: StepLit; sequence: boolean; stage: { current: HTMLDivElement | null } }) {
  const vp = useViewport()
  const w = stage.current?.clientWidth ?? 800
  const h = stage.current?.clientHeight ?? 600
  let place: { left: number; top: number; side: string } | 'centre' = 'centre'
  if (sequence) {
    place = { left: Math.max(8, w - CAPTION_W - 16), top: 12, side: 'left' }
  } else if (lit) {
    const boxes = layout.nodes.filter(v => lit.nodes.has(v.id)).map(v => v.box)
    if (boxes.length) {
      const x1 = Math.min(...boxes.map(b => b.x))
      const y1 = Math.min(...boxes.map(b => b.y))
      const x2 = Math.max(...boxes.map(b => b.x + b.w))
      const y2 = Math.max(...boxes.map(b => b.y + b.h))
      place = captionPlace({ x: x1 * vp.zoom + vp.x, y: y1 * vp.zoom + vp.y, w: (x2 - x1) * vp.zoom, h: (y2 - y1) * vp.zoom }, { w, h })
    }
  }
  return <div className="tour-layer"><Caption step={step} place={place} /></div>
}

function BoardView() {
  const boot = window.__BOARD__
  const rf = useReactFlow()
  const root = useRef<HTMLDivElement>(null)
  const searchBox = useRef<HTMLInputElement>(null)
  const canRebuild = !!boot.source
  const seqApi = useRef<SequenceApi | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [pl, dispatchPl] = useReducer(reduce, idle)
  const [routeOn, setRouteOn] = useState(true)

  const [sent, setSpec] = useState<BoardSpec>(boot.spec)
  const [since, setSince] = useState<BoardSpec | undefined>(boot.since)
  const [showSince, setShowSince] = useState(false)
  const [refs, setRefs] = useState<BoardRef[]>(boot.boards ?? [])
  // "Since the last draw" swaps in the board with its changes marked; the layout is the same, so the picture only gets colours (and ghosts).
  const spec = showSince && since ? since : sent
  const [opts, setOpts] = useState<BoardOpts>(boot.opts ?? {})
  const optsRef = useRef(opts)
  const seq = useRef(0)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const [q, setQ] = useState(boot.opts?.query ?? '')
  const [direction, setDirection] = useState<'LR' | 'TB'>(boot.spec.direction ?? 'LR')
  const [members, setMembers] = useState(true)
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map())
  const [expandedNodes, setExpandedNodes] = useState<ReadonlySet<string>>(NO_NODES)
  const [selected, setSelected] = useState<string>()
  const [hover, setHover] = useState<string | null>(null)
  const [active, setActive] = useState<{ from: string; row: number }>()
  const [menu, setMenu] = useState<'export' | 'legend' | undefined>()
  const [notice, setNotice] = useState<string>()
  const fitNext = useRef(true)
  /** The user picked a direction: the host's default must not take it back. */
  const directionChosen = useRef(false)
  const centerNext = useRef<string | undefined>(undefined)
  /** The board's `focus` (a node or a group) opens first: the groups around it open and the view goes to it. */
  const focusFirst = (s: BoardSpec) => {
    if (!s.focus || s.kind === 'sequence') return
    const open = stepOpens(s, { title: '', caption: '', focus: s.focus })
    if (open.length) {
      setOverrides(prev => {
        const next = new Map(prev)
        open.forEach(g => next.set(g, false))
        return next
      })
    }
    centerNext.current = s.focus
    if (s.nodes.some(n => n.id === s.focus)) setSelected(s.focus)
  }
  useEffect(() => {
    if (boot.spec.focus && boot.spec.kind !== 'sequence') {
      fitNext.current = false
      focusFirst(boot.spec)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- messages from the host ------------------------------------------------------------------
  useEffect(() => {
    const onMessage = (e: MessageEvent<ToWebview>) => {
      const m = e.data
      if (m?.type === 'board') {
        // A rebuild answered late: a newer one is already on its way.
        if (m.seq !== undefined && m.seq < seq.current) return
        setSpec(m.spec)
        setSince(m.since)
        setRefs(m.boards ?? [])
        if (!m.since) setShowSince(false)
        setPending(false)
        setError(undefined)
        const exists = (id: string | undefined) => id !== undefined && m.spec.nodes.some(n => n.id === id)
        // What was selected stays selected when it is still on the board.
        setSelected(prev => (exists(prev) ? prev : undefined))
        setActive(prev => (exists(prev?.from) ? prev : undefined))
        if (m.refresh) return
        if (m.opts) {
          optsRef.current = m.opts
          setOpts(m.opts)
          if (m.seq === undefined) setQ(m.opts.query ?? '')
        }
        if (m.spec.direction && !directionChosen.current) setDirection(m.spec.direction)
        focusFirst(m.spec)
        // Not while a click on a field or Enter in the search is about to move the view to a card.
        if (!centerNext.current) fitNext.current = true
      } else if (m?.type === 'error') {
        if (m.seq !== undefined && m.seq < seq.current) return
        setPending(false)
        setError(m.message)
      }
    }
    window.addEventListener('message', onMessage)
    post({ type: 'ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const rebuild = useCallback((patch: Partial<BoardOpts>) => {
    const next = clean({ ...optsRef.current, ...patch })
    optsRef.current = next
    setOpts(next)
    if (!boot.source) return
    setPending(true)
    setError(undefined)
    post({ type: 'rebuild', seq: ++seq.current, kind: boot.source, opts: next })
  }, [boot.source])

  // Typing filters at once (the matches light up); the host recomputes the board a moment after the last key.
  useEffect(() => {
    if (boot.search === 'local' || q.trim() === (optsRef.current.query ?? '')) return
    const t = setTimeout(() => rebuild({ query: q.trim() || undefined }), 350)
    return () => clearTimeout(t)
  }, [q, rebuild, boot.search])

  // ---- what is drawn ---------------------------------------------------------------------------
  const matched = useMemo(() => matchNodes(spec, q), [spec, q])
  const searching = q.trim().length > 0
  const autoOpen = useMemo(() => {
    // Packages that hold a search match or the focused type open by themselves.
    const want = [...(searching ? matched : []), ...(opts.focusId && spec.nodes.some(n => n.id === opts.focusId) ? [opts.focusId] : [])]
    return want.length ? groupsHolding(spec, want) : NO_NODES
  }, [spec, matched, searching, opts.focusId])
  const layout: Layout = useMemo(
    () => buildLayout(spec, { direction, members, expanded: expandedNodes, isCollapsed: g => !autoOpen.has(g.id) && (overrides.get(g.id) ?? g.collapsed === true) }),
    [spec, direction, members, expandedNodes, overrides, autoOpen],
  )
  const sequence = spec.kind === 'sequence'
  const changes = useMemo(() => countChanges(spec), [spec])
  const walk = useMemo(() => stepsOf(spec), [spec])
  const walkSig = useMemo(() => stepsSignature(walk.steps), [walk])
  const curStep = pl.tour && !pl.paused ? walk.steps[pl.index] : undefined
  const stepLit = useMemo(() => (curStep ? litOf(curStep) : undefined), [curStep])
  const routeLit = useMemo(() => (!pl.tour && routeOn ? highlightLit(spec) : undefined), [spec, pl.tour, routeOn])
  const lit: StepLit | undefined = stepLit ?? routeLit
  const seqLit = useMemo<Lit | undefined>(() => (searching ? { nodes: matched, edges: new Set() } : undefined), [searching, matched])
  const adj = useMemo(() => adjacency(layout.edges), [layout])
  // The agent's steps start by themselves when a board arrives or its steps change; a walk made from message order waits to be asked for.
  useEffect(() => {
    const t = tourOf(spec, walk.steps, walk.derived)
    if (t && !walk.derived) dispatchPl({ type: 'start', tour: t })
    else dispatchPl({ type: 'exit' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkSig])
  // A step opens the groups its nodes sit in and takes the camera to them.
  useEffect(() => {
    if (!curStep) return
    const open = stepOpens(spec, curStep)
    if (open.length) {
      setOverrides(prev => {
        if (open.every(g => prev.get(g) === false)) return prev
        const next = new Map(prev)
        open.forEach(g => next.set(g, false))
        return next
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curStep])
  const hotId = hover ?? (selected ? layout.rep.get(selected) : undefined) ?? null

  const cache = useRef(new Map<string, { key: string; node: Node }>())
  const nodes = useMemo(() => {
    const next = new Map<string, { key: string; node: Node }>()
    const out: Node[] = []
    const pick = (id: string, key: string, make: () => Node) => {
      const hit = cache.current.get(id)
      const node = hit && hit.key === key && hit.node.data && (hit.node as { __l?: Layout }).__l === layout ? hit.node : make()
      ;(node as { __l?: Layout }).__l = layout
      next.set(id, { key, node })
      out.push(node)
    }
    for (const g of [...layout.groups].sort((a, b) => a.depth - b.depth)) {
      pick(`frame:${g.id}`, 'g', () => ({
        id: `frame:${g.id}`, type: 'frame', position: g.rel, parentId: g.parent ? `frame:${g.parent}` : undefined,
        data: { g } satisfies GroupData, width: g.box.w, height: g.box.h, style: { width: g.box.w, height: g.box.h }, draggable: false, selectable: false, focusable: false, zIndex: 0,
      }))
    }
    const focusRep = optsRef.current.focusId ? layout.rep.get(optsRef.current.focusId) : undefined
    for (const v of layout.nodes) {
      const isSel = selected !== undefined && layout.rep.get(selected) === v.id
      const isMatch = matched.has(v.id) || (v.group !== undefined && [...matched].some(id => layout.rep.get(id) === v.id))
      const activeRow = active?.from === v.id ? active.row : undefined
      const zoomable = !!v.node?.zoom && refs.some(b => b.id === v.node!.zoom)
      const key = `${isSel}|${focusRep === v.id}|${isMatch}|${searching && !isMatch}|${activeRow}|${canRebuild}|${zoomable}`
      pick(v.id, key, () => ({
        id: v.id, type: v.group ? 'summary' : 'card', position: v.rel, parentId: v.parent ? `frame:${v.parent}` : undefined,
        data: { v, selected: isSel, focus: focusRep === v.id, match: isMatch, dim: searching && !isMatch, activeRow, canFocus: canRebuild, zoomable } satisfies CardData,
        width: v.box.w, height: v.box.h, style: { width: v.box.w, height: v.box.h }, draggable: false, selectable: false, focusable: false, zIndex: 2,
      }))
    }
    cache.current = next
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, selected, matched, searching, active, canRebuild, opts.focusId, refs])

  // Neighbours of the hovered or selected card stay lit, the rest fades (DOM attributes: no React work per hover).
  useEffect(() => {
    const el = root.current
    if (!el) return
    el.querySelectorAll('[data-lit]').forEach(n => n.removeAttribute('data-lit'))
    el.toggleAttribute('data-hl', !!hotId)
    if (!hotId) return
    for (const id of [hotId, ...(adj.get(hotId) ?? [])]) {
      el.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.setAttribute('data-lit', '')
    }
  }, [hotId, adj, nodes])

  // A step (or a route) lights its nodes and fades the rest: DOM attributes again, no React work per node.
  const litView = useMemo(() => (lit ? litVisible(lit, layout.rep) : undefined), [lit, layout])
  useEffect(() => {
    const el = root.current
    if (!el) return
    el.querySelectorAll('[data-sl-lit]').forEach(n => n.removeAttribute('data-sl-lit'))
    el.toggleAttribute('data-sl', !!litView)
    if (!litView) return
    for (const id of litView.nodes) el.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.setAttribute('data-sl-lit', '')
  }, [litView, nodes])

  // ---- viewport --------------------------------------------------------------------------------
  const fit = useCallback(() => (seqApi.current ? seqApi.current.fit() : void rf.fitView({ padding: 0.12, duration: 0, maxZoom: 1.1 })), [rf])
  const centerOn = useCallback((id: string) => {
    const v = layout.nodes.find(n => n.id === (layout.rep.get(id) ?? id))
    const g = v ? undefined : layout.groups.find(x => x.id === id)
    const box = v?.box ?? g?.box
    if (!box) return
    void rf.setCenter(box.x + box.w / 2, box.y + Math.min(box.h / 2, 120), { zoom: Math.max(rf.getZoom(), 0.75), duration: 350 })
  }, [layout, rf])
  const viewport = useRef({ fit, centerOn })
  viewport.current = { fit, centerOn }
  // After a layout: fit the whole board, or go to the card a click on a field asked for. (Not cancelled by re-renders.)
  useEffect(() => {
    if (fitNext.current) {
      fitNext.current = false
      setTimeout(() => viewport.current.fit(), 40)
    } else if (centerNext.current) {
      const id = centerNext.current
      centerNext.current = undefined
      setTimeout(() => viewport.current.centerOn(id), 40)
    }
  }, [layout])

  // Each step takes the camera to what it lights (the graph view; a sequence fits on one screen).
  const stepLitKey = curStep && stepLit ? `${pl.index}|${[...stepLit.nodes].join(',')}` : ''
  const goStep = (duration: number) => {
    if (!litView) return
    const boxes = layout.nodes.filter(v => litView.nodes.has(v.id)).map(v => v.box)
    if (!boxes.length) return
    const x1 = Math.min(...boxes.map(b => b.x))
    const y1 = Math.min(...boxes.map(b => b.y))
    const x2 = Math.max(...boxes.map(b => b.x + b.w))
    const y2 = Math.max(...boxes.map(b => b.y + b.h))
    const cw = stage.current?.clientWidth ?? 800
    const ch = stage.current?.clientHeight ?? 600
    // Room around the nodes for the caption; never closer than 1.15x.
    const zoom = Math.max(0.1, Math.min(1.15, cw / ((x2 - x1) * 1.5 + 380), ch / ((y2 - y1) * 1.8 + 140)))
    void rf.setCenter((x1 + x2) / 2 + 80 / zoom, (y1 + y2) / 2, { zoom, duration })
  }
  const stepCamera = useRef({ key: '', go: goStep })
  stepCamera.current = { key: stepLitKey, go: goStep }
  /** The reader panned or zoomed by hand: a resize of the panel no longer moves the camera. */
  const userMoved = useRef(false)
  useEffect(() => {
    userMoved.current = false
    if (!stepLitKey || sequence || !litView) return
    const t = setTimeout(() => goStep(400), 60)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepLitKey, layout])
  // The panel was resized (a side bar closed, the window made larger): the view follows until the reader takes over.
  useEffect(() => {
    const el = stage.current
    if (!el || sequence || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (userMoved.current) return
        if (stepCamera.current.key) stepCamera.current.go(0)
        else viewport.current.fit()
      }, 120)
    })
    ro.observe(el)
    return () => {
      clearTimeout(timer)
      ro.disconnect()
    }
  }, [sequence])

  // ---- actions ---------------------------------------------------------------------------------
  const nodeOf = useMemo(() => new Map(spec.nodes.map(n => [n.id, n])), [spec])
  const focusNode = useCallback((id: string) => {
    if (canRebuild) rebuild({ focusId: id, depth: optsRef.current.depth ?? 1 })
  }, [canRebuild, rebuild])
  const revealGroups = useCallback((ids: string[]) => {
    const open = groupsHolding(spec, ids)
    setOverrides(prev => {
      const next = new Map(prev)
      open.forEach(g => next.set(g, false))
      return next
    })
  }, [spec])
  const actions = useMemo<Actions>(() => ({
    select(id, node) {
      setSelected(id)
      setActive(undefined)
      if (node?.target?.create) post({ type: 'create', node: id })
      else if (node?.file) post({ type: 'open', file: node.file, line: node.line ?? 1 })
    },
    focus: focusNode,
    toggleGroup(id) {
      setOverrides(prev => {
        const g = spec.groups?.find(x => x.id === id)
        const cur = prev.get(id) ?? g?.collapsed === true
        return new Map(prev).set(id, !cur)
      })
    },
    member(node, m, row) {
      const target = nodeOf.get(m.ref!) ?? spec.nodes.find(n => n.label === m.ref)
      if (!target) {
        // Not in this board (filtered out, or cut): let the host draw around it.
        if (canRebuild) rebuild({ focusId: m.ref, depth: optsRef.current.depth ?? 1 })
        return
      }
      revealGroups([target.id])
      setSelected(target.id)
      setActive({ from: node.id, row })
      centerNext.current = target.id
    },
    more(id) {
      setExpandedNodes(prev => new Set(prev).add(id))
    },
    hover: setHover,
    zoom: board => post({ type: 'zoom', board }),
  }), [focusNode, nodeOf, spec, canRebuild, rebuild, revealGroups])

  const setLevel = (level: number) => {
    const next = new Map<string, boolean>()
    const byId = new Map((spec.groups ?? []).map(g => [g.id, g]))
    for (const g of spec.groups ?? []) next.set(g.id, groupDepth(byId, g.id) >= level)
    setOverrides(next)
    fitNext.current = true
  }
  const levels = useMemo(() => {
    const byId = new Map((spec.groups ?? []).map(g => [g.id, g]))
    return (spec.groups ?? []).reduce((m, g) => Math.max(m, groupDepth(byId, g.id) + 1), 0)
  }, [spec])
  const collapsedCount = layout.nodes.filter(v => v.group).length

  const doExport = async (format: ExportFormat) => {
    setMenu(undefined)
    const name = slug(spec.title)
    try {
      if (format === 'json') {
        post({ type: 'export', format, data: JSON.stringify(spec, null, 2), name })
      } else if (format === 'svg' || format === 'png') {
        const svg = sequence ? sequenceSvg(spec, readPalette(), spec.title) : toSvg(layout, direction, readPalette(), spec.title)
        if (format === 'svg') {
          post({ type: 'export', format, data: svg, name })
        } else {
          const m = /width="(\d+)" height="(\d+)"/.exec(svg)!
          post({ type: 'export', format, data: await pngOf(svg, Number(m[1]), Number(m[2])), name })
        }
      } else {
        post({ type: 'export', format, name })
      }
    } catch (e) {
      setNotice(`Export failed: ${(e as Error).message}`)
    }
  }

  // ---- keyboard --------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea')
      if (pl.tour && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') {
          e.preventDefault()
          dispatchPl({ type: 'next' })
          return
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
          e.preventDefault()
          dispatchPl({ type: 'back' })
          return
        }
        if (e.key === ' ') {
          e.preventDefault()
          dispatchPl({ type: 'toggle' })
          return
        }
        if (e.key === 'Escape' && !q && !menu) {
          dispatchPl({ type: 'exit' })
          return
        }
      }
      if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        searchBox.current?.focus()
        searchBox.current?.select()
      } else if (e.key === 'Escape') {
        if (typing || q) {
          setQ('')
          ;(document.activeElement as HTMLElement | null)?.blur?.()
        } else if (menu) setMenu(undefined)
        else {
          setSelected(undefined)
          setActive(undefined)
        }
      } else if (e.key === 'f' && !typing && !e.ctrlKey && !e.metaKey && selected) {
        focusNode(selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [q, menu, selected, focusNode, pl.tour])

  const firstMatch = () => {
    const first = spec.nodes.find(n => matched.has(n.id))
    if (!first) return
    revealGroups([first.id])
    setSelected(first.id)
    setActive(undefined)
    // The board is about to be redrawn by the host (the search was just typed): go to the card when that has landed.
    const redrawing = boot.search !== 'local' && (pending || q.trim() !== (optsRef.current.query ?? ''))
    if (redrawing) centerNext.current = first.id
    else setTimeout(() => centerOn(first.id), 60)
  }

  // ---- toolbar state ---------------------------------------------------------------------------
  const hidden = opts.hideRoles ?? []
  const present = new Set(spec.nodes.map(n => n.kind ?? 'class'))
  const chips = ROLE_CHIPS.filter(c => present.has(c.role) || hidden.includes(c.role))
  const focusNodeSpec: BoardNode | undefined = opts.focusId ? nodeOf.get(opts.focusId) : undefined
  const typeBoard = spec.kind === 'er' || spec.kind === 'architecture' || spec.kind === 'class'
  const includeEntities = opts.includeEntities ?? false
  const includeEnums = opts.includeEnums ?? true

  return (
    <div className="bd" ref={root} onClick={() => menu && setMenu(undefined)}>
      <div className="bd-bar">
        <div className="bd-row">
          <div className="bd-title" title={spec.title}>{spec.title}</div>
          <span className="bd-status">{spec.nodes.length} {spec.nodes.length === 1 ? 'node' : 'nodes'} · {spec.edges.length} {spec.edges.length === 1 ? 'edge' : 'edges'}{pending ? ' · updating…' : ''}</span>
          <div className="bd-grow" />
          {walk.steps.length > 0 && !pl.tour && (
            <button className="chip steps" data-act="steps" title={walk.derived ? 'Walk through the messages in order' : 'Play the steps the agent wrote'} onClick={() => { const t = tourOf(spec, walk.steps, walk.derived); if (t) dispatchPl({ type: 'start', tour: t }) }}>▶ {walk.derived ? 'Walk through' : `Steps (${walk.steps.length})`}</button>
          )}
          {spec.level && <span className="bd-level" title="C4 level of this diagram">C4 · {spec.level}</span>}
          {refs.filter(b => b.up).map(b => (
            <button key={b.id} className="chip" data-act="up" title={`Zoom out: open ${b.title}`} onClick={() => post({ type: 'zoom', board: b.id })}>↑ {b.title}</button>
          ))}
          {since && (
            <button className="chip" data-act="since" aria-pressed={showSince} title="Colour what changed since the previous draw of this board" onClick={() => setShowSince(v => !v)}>Changes</button>
          )}
          {changes.added + changes.removed + changes.changed > 0 && (
            <span className="bd-status bd-changes" title="Against the base board or the previous draw"><b className="add">+{changes.added}</b> <b className="del">−{changes.removed}</b> <b className="warn">~{changes.changed}</b></span>
          )}
          {!pl.tour && spec.highlight && spec.highlight.length > 0 && (
            <button className="chip" data-act="route" aria-pressed={routeOn} title="Show or hide the highlighted route" onClick={() => setRouteOn(v => !v)}>{spec.highlight.length === 1 && spec.highlight[0].label ? spec.highlight[0].label : 'Route'}</button>
          )}
          <input
            ref={searchBox}
            className="bd-search"
            type="search"
            placeholder="Search ( / )"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') firstMatch() }}
            aria-label="Search the board"
          />
          {searching && <span className="bd-status">{matched.size} {matched.size === 1 ? 'match' : 'matches'}</span>}
          <div className="bd-menu">
            <button className="chip" aria-pressed={menu === 'export'} onClick={e => { e.stopPropagation(); setMenu(menu === 'export' ? undefined : 'export') }}>Export ▾</button>
            {menu === 'export' && (
              <div className="bd-pop" role="menu" onClick={e => e.stopPropagation()}>
                {([['mermaid', 'Copy as Mermaid'], ['plantuml', 'Save as PlantUML'], ['png', 'Save as PNG'], ['svg', 'Save as SVG'], ['json', 'Save as JSON']] as [ExportFormat, string][]).map(([f, label]) => (
                  <button key={f} role="menuitem" data-export={f} onClick={() => void doExport(f)}>{label}</button>
                ))}
              </div>
            )}
          </div>
          <div className="bd-menu">
            <button className="chip" aria-pressed={menu === 'legend'} title="Legend" onClick={e => { e.stopPropagation(); setMenu(menu === 'legend' ? undefined : 'legend') }}>?</button>
            {menu === 'legend' && <div className="bd-pop bd-legend" onClick={e => e.stopPropagation()}><Legend kinds={[...present]} changes={changes.added + changes.removed + changes.changed > 0} entries={spec.legend} /></div>}
          </div>
        </div>
        <div className="bd-row bd-row2">
          {canRebuild && (
            <div className="bd-group" title="Show one type and what it touches">
              {focusNodeSpec ? (
                <>
                  <span className="bd-status">Focus</span>
                  <b className="bd-focus" title={focusNodeSpec.id}>{focusNodeSpec.label}</b>
                  <button className="icon-btn" aria-label="Fewer levels" disabled={(opts.depth ?? 1) <= 1} onClick={() => rebuild({ depth: Math.max(1, (opts.depth ?? 1) - 1) })}>−</button>
                  <span className="bd-depth">depth {opts.depth ?? 1}</span>
                  <button className="icon-btn" aria-label="More levels" disabled={(opts.depth ?? 1) >= 3} onClick={() => rebuild({ depth: Math.min(3, (opts.depth ?? 1) + 1) })}>+</button>
                  <button className="chip" data-act="show-all" onClick={() => rebuild({ focusId: undefined, depth: undefined })}>Show all</button>
                </>
              ) : (
                <button className="chip" data-act="focus" disabled={!selected || !nodeOf.has(selected)} title="Focus on the selected type (f)" onClick={() => selected && focusNode(selected)}>Focus selected</button>
              )}
            </div>
          )}
          {canRebuild && chips.length > 0 && (
            <div className="bd-group">
              {chips.map(c => (
                <button
                  key={c.role}
                  className="chip role"
                  data-role={c.role}
                  aria-pressed={!hidden.includes(c.role)}
                  title={hidden.includes(c.role) ? `Show ${c.label}s` : `Hide ${c.label}s`}
                  style={{ '--k': KIND_COLOR[c.role] } as React.CSSProperties}
                  onClick={() => rebuild({ hideRoles: hidden.includes(c.role) ? hidden.filter(r => r !== c.role) : [...hidden, c.role] })}
                >{c.label}</button>
              ))}
            </div>
          )}
          <div className="bd-group">
            {canRebuild && typeBoard && <button className="chip" data-act="entities" aria-pressed={includeEntities} onClick={() => rebuild({ includeEntities: !includeEntities })}>Entities</button>}
            {canRebuild && typeBoard && <button className="chip" data-act="enums" aria-pressed={includeEnums} onClick={() => rebuild({ includeEnums: !includeEnums })}>Enums</button>}
            {!sequence && <button className="chip" data-act="members" aria-pressed={members} onClick={() => { setMembers(!members); fitNext.current = true }}>Members</button>}
            {!sequence && <button className="chip" data-act="direction" title="Layout direction" onClick={() => { directionChosen.current = true; setDirection(direction === 'LR' ? 'TB' : 'LR'); fitNext.current = true }}>{direction === 'LR' ? 'Left → right' : 'Top ↓ bottom'}</button>}
          </div>
          {!sequence && (spec.groups?.length ?? 0) > 0 && (
            <div className="bd-group" title="Packages">
              <span className="bd-status">Packages</span>
              <button className="chip" data-act="collapse-all" onClick={() => setLevel(0)}>Collapse</button>
              {levels > 1 && Array.from({ length: Math.min(levels - 1, 3) }, (_, i) => i + 1).map(l => (
                <button key={l} className="chip" data-act={`level-${l}`} title={`Expand to level ${l}`} onClick={() => setLevel(l)}>L{l}</button>
              ))}
              <button className="chip" data-act="expand-all" onClick={() => setLevel(99)}>Expand</button>
              {collapsedCount > 0 && <span className="bd-status">{collapsedCount} collapsed</span>}
            </div>
          )}
          <div className="bd-grow" />
          <button className="icon-btn" data-act="fit" title="Fit to view" aria-label="Fit to view" onClick={fit}>⤢</button>
        </div>
        {spec.description && <div className="bd-note" title={spec.description}>{spec.description}</div>}
        {error && <div className="bd-note bd-error" role="alert">{error}</div>}
        {notice && <div className="bd-note" onClick={() => setNotice(undefined)}>{notice}</div>}
      </div>
      <div className="bd-stage" ref={stage}>
        <ActionsCtx.Provider value={actions}>
          {sequence && <SequenceView spec={spec} lit={lit ?? seqLit} selected={selected} apiRef={seqApi} onSelect={n => { setSelected(n.id); if (n.file) post({ type: 'open', file: n.file, line: n.line ?? 1 }) }} />}
          {!sequence && <EdgeLayer layout={layout} direction={direction} hot={hotId ?? undefined} active={active} lit={litView?.edges} />}
          {!sequence && <ReactFlow
            nodes={nodes}
            edges={[]}
            nodeTypes={nodeTypes}
            minZoom={0.04}
            maxZoom={2}
            onlyRenderVisibleElements
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnDoubleClick={false}
            proOptions={{ hideAttribution: true }}
            onMoveStart={e => { if (e) userMoved.current = true }}
            onPaneClick={() => { setSelected(undefined); setActive(undefined) }}
          >
            {layout.nodes.length > 8 && <MiniMap pannable zoomable nodeStrokeWidth={0} nodeColor={n => ((n.data as CardData | undefined)?.v?.node ? KIND_COLOR[(n.data as CardData).v.node!.kind ?? 'class'] : 'var(--fl-line-strong)')} />}
          </ReactFlow>}
          {!sequence && <CalloutLayer layout={layout} direction={direction} />}
          {pl.tour && (
            <TourBar
              tour={pl.tour}
              state={pl}
              api={{ next: () => dispatchPl({ type: 'next' }), back: () => dispatchPl({ type: 'back' }), goto: i => dispatchPl({ type: 'goto', index: i }), toggle: () => dispatchPl({ type: 'toggle' }), exit: () => dispatchPl({ type: 'exit' }) }}
            />
          )}
          {pl.tour && !pl.paused && pl.tour.steps[pl.index] && (
            <StepCaption step={pl.tour.steps[pl.index]} layout={layout} lit={litView} sequence={sequence} stage={stage} />
          )}
        </ActionsCtx.Provider>
        {spec.nodes.length === 0 && (
          <EmptyState
            message={spec.description || 'There is nothing to draw here.'}
            actions={emptyActions(boot.source, opts, canRebuild)}
            onAction={a => {
              if (a.id === 'clear') setQ('')
              if (a.rebuild) rebuild(a.rebuild)
              if (a.setting) post({ type: 'settings', setting: a.setting })
            }}
          />
        )}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <ReactFlowProvider>
    <BoardView />
  </ReactFlowProvider>,
)
