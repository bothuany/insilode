// What the reading pane does, with no Monaco and no DOM, so it runs under plain Node (ui/test/read-model.test.mjs): the pane's
// state (what is read at the top, which peeks are open, where the cursor is) as paths from the flow's entry, the debugger-like steps
// over / into / out, the pane's keys, what "Keep this path" keeps, where peeks sit in their editor and which cards the canvas fades.
//
// Everything is kept by path, not by card key: keys are positional (`p${n}` in the host's graph.ts), so a call added anywhere earlier
// renumbers every card after it, and line numbers move when a change is undone. A path names a method by the calls that lead to it.
import type { FlowEdge, FlowNode } from '../types'
import { firstCall } from './reading.ts'

/** A method by the calls from the flow's entry to it: each step is the callee's label, the text of the line that calls it and which of the calls that look the same it is. */
export type Path = string
/** The flow's entry method. */
export const ROOT: Path = ''
/** The entry's callers (the left side of the canvas) hang below this path instead. */
const UP: Path = '↑'
const STEP = '\u001f'
const NTH = '\u001e'
const TXT = '\u001d'

/** Peeks go this deep; a step further puts the callee at the top of the pane, with the chain above it. */
export const MAX_DEPTH = 2

/** How many calls from the entry. */
export const pathDepth = (p: Path) => (p === ROOT ? 0 : p.split(STEP).length)
const depthOf = pathDepth
/** `p` is `ancestor` or below it. */
export const within = (p: Path, ancestor: Path) => p === ancestor || p.startsWith(ancestor + STEP)
const isUnder = (p: Path, top: Path) => top === ROOT || p === top || p.startsWith(top + STEP)
const inCallers = (p: Path) => p === UP || p.startsWith(UP + STEP)
/** A method on the callers' side of the canvas: its pane has no peeks and no stepping, because its children are who calls it. */
export const isCaller = inCallers
/** The path with its last step off: the method that makes the call. */
const parentPath = (p: Path) => (p === ROOT ? undefined : p.includes(STEP) ? p.slice(0, p.lastIndexOf(STEP)) : ROOT)
const memberOf = (label: string) => label.replace(/\s*▸\s*/g, '.').split('.').pop() ?? label

// ---- the flow indexed by path ---------------------------------------------------------------------------------------------
export interface Index {
  node(p: Path): FlowNode | undefined
  pathOf(key: string): Path | undefined
  keyOf(p: Path): string | undefined
  /** The method that calls this one, and the call. Not for callers' cards (they are reached by the callers list). */
  parent(p: Path): { path: Path; edge: FlowEdge } | undefined
  /** The path of the callee a call reaches. */
  child(from: Path, edge: FlowEdge): Path
  /** The entry's first caller, when the canvas draws callers. */
  caller: { path: Path; edge: FlowEdge } | undefined
}

/** The trimmed text of a line of a method's code: what a call looks like, which survives the line moving and tells overloads apart. */
const textAt = (owner: FlowNode, line: number) => owner.code?.replace(/\r/g, '').split('\n')[line - owner.startLine]?.trim() ?? ''

/** Indexes the tree below `down`, and the callers tree `up` (whose root is the entry again) when there is one. */
export function indexFlow(down: FlowNode | null, up: FlowNode | null | undefined = null): Index {
  const nodes = new Map<Path, FlowNode>()
  const byKey = new Map<string, Path>()
  const parents = new Map<Path, { path: Path; edge: FlowEdge }>()
  const childPaths = new Map<FlowEdge, Path>()
  /** A call's step in a path: the callee's label, the text of the call line, and which of the calls that look the same this is. */
  const stepOf = (seen: Map<string, number>, e: FlowEdge, owner: FlowNode) => {
    const base = `${e.node.label}${TXT}${textAt(owner, e.callLine)}`
    const nth = seen.get(base) ?? 0
    seen.set(base, nth + 1)
    return `${base}${NTH}${nth}`
  }
  const walk = (n: FlowNode, p: Path) => {
    const seen = new Map<string, number>()
    for (const e of n.children) {
      const cp = `${p === ROOT ? '' : p + STEP}${stepOf(seen, e, n)}`
      childPaths.set(e, cp)
      nodes.set(cp, e.node)
      byKey.set(e.node.key, cp)
      parents.set(cp, { path: p, edge: e })
      walk(e.node, cp)
    }
  }
  if (down) {
    nodes.set(ROOT, down)
    byKey.set(down.key, ROOT)
    walk(down, ROOT)
  }
  let caller: Index['caller']
  // A caller's call line is in the caller's own code.
  const walkCallers = (n: FlowNode, p: Path) => {
    const seen = new Map<string, number>()
    for (const e of n.children) {
      const cp = `${p}${STEP}${stepOf(seen, e, e.node)}`
      childPaths.set(e, cp)
      nodes.set(cp, e.node)
      if (!byKey.has(e.node.key)) byKey.set(e.node.key, cp)
      if (p === UP) caller ??= { path: cp, edge: e }
      walkCallers(e.node, cp)
    }
  }
  // The callers' root is the entry itself: it takes no path of its own. Its children are the callers.
  if (up) walkCallers(up, UP)
  return {
    node: p => nodes.get(p),
    pathOf: key => byKey.get(key),
    keyOf: p => nodes.get(p)?.key,
    parent: p => parents.get(p),
    child: (_from, edge) => childPaths.get(edge)!,
    caller,
  }
}

// ---- a method's calls, by line ---------------------------------------------------------------------------------------------
interface CallLine {
  line: number
  edges: FlowEdge[]
}
const callCache = new WeakMap<FlowNode, CallLine[]>()
/** The lines of a method that call something, in order, each with its callees in the order they are written. */
export function callsOf(node: FlowNode): CallLine[] {
  let calls = callCache.get(node)
  if (!calls) {
    const byLine = new Map<number, FlowEdge[]>()
    for (const e of node.children) byLine.set(e.callLine, [...(byLine.get(e.callLine) ?? []), e])
    calls = [...byLine].sort((a, b) => a[0] - b[0]).map(([line, edges]) => ({ line, edges }))
    callCache.set(node, calls)
  }
  return calls
}

// ---- the pane's state -------------------------------------------------------------------------------------------------------
/** Where the cursor is: a method, a line of it, and which of that line's callees it stands on (a line can call several). */
export interface Pos {
  path: Path
  line: number
  k: number
}

export interface Reading {
  /** The methods read at the top of the pane, oldest first, and which one is shown (Back and Forward walk it). */
  history: readonly Path[]
  at: number
  /** Peeks open under the top method, by their callee's path. */
  open: readonly Path[]
  cursor: Pos
  /** Every method the cursor has been in since the flow opened: the canvas draws them as read. */
  walked: readonly Path[]
  /** Methods whose change "Keep this path" kept: they no longer carry a change, but they still count. */
  kept: readonly Path[]
}

export const topOf = (r: Reading): Path => r.history[r.at]
const down = (idx: Index, p: Path) => !inCallers(p) && idx.node(p) !== undefined

function fresh(idx: Index, p: Path, pos?: Partial<Pos>): Pos {
  const node = idx.node(p)
  return { path: p, line: pos?.line ?? (node ? firstCall(node) : 0), k: pos?.k ?? 0 }
}
const withWalked = (r: Reading, p: Path): Reading => (r.walked.includes(p) ? r : { ...r, walked: [...r.walked, p] })

/** A reading that starts at `entry` (the flow's entry, or the first changed method of a change set). */
export function startReading(idx: Index, entry: Path = ROOT): Reading {
  const p = idx.node(entry) ? entry : ROOT
  return { history: [p], at: 0, open: [], cursor: fresh(idx, p), walked: [p], kept: [] }
}

/** Reads a method at the top: a new step in the history, nothing peeked, the cursor on `pos.line` or the first call. */
export function readAt(r: Reading, idx: Index, path: Path, pos?: Partial<Pos>): Reading {
  const same = topOf(r) === path
  const history = same ? r.history : [...r.history.slice(0, r.at + 1), path]
  return withWalked({ ...r, history, at: same ? r.at : r.at + 1, open: [], cursor: fresh(idx, path, pos) }, path)
}

/** Back (-1) or forward (+1) in the history. */
export function stepHistory(r: Reading, idx: Index, d: -1 | 1): Reading {
  const at = r.at + d
  if (at < 0 || at >= r.history.length) return r
  return withWalked({ ...r, at, open: [], cursor: fresh(idx, r.history[at]) }, r.history[at])
}

/** The cursor moved to a place (a click). */
export function moveTo(r: Reading, pos: Pos): Reading {
  return withWalked({ ...r, cursor: pos }, pos.path)
}

const dropPeek = (open: readonly Path[], p: Path) => open.filter(o => o !== p && !o.startsWith(p + STEP))
const addPeek = (open: readonly Path[], p: Path) => (open.includes(p) ? open : [...open, p])
const kOf = (idx: Index, from: Path, edge: FlowEdge) => Math.max(0, callsOf(idx.node(from)!).find(c => c.line === edge.callLine)?.edges.indexOf(edge) ?? 0)

/** The call the cursor stands on: its line's `k`-th callee. */
function calleeAt(idx: Index, pos: Pos) {
  const node = idx.node(pos.path)
  const here = node && !inCallers(pos.path) ? callsOf(node).find(c => c.line === pos.line) : undefined
  const edge = here?.edges[Math.min(pos.k, here.edges.length - 1)]
  return edge ? { edge, path: idx.child(pos.path, edge), here: here! } : undefined
}
export const calleeUnder = (idx: Index, r: Reading) => calleeAt(idx, r.cursor)

// ---- stepping: a debugger's three moves over code that does not run -------------------------------------------------------------
function overFrom(idx: Index, top: Path, open: readonly Path[], pos: Pos): { pos: Pos; open: readonly Path[] } {
  const node = idx.node(pos.path)
  if (!node || inCallers(pos.path)) return { pos, open }
  const calls = callsOf(node)
  const here = calls.find(c => c.line === pos.line)
  if (here && pos.k + 1 < here.edges.length) return { pos: { ...pos, k: pos.k + 1 }, open }
  const next = calls.find(c => c.line > pos.line)
  if (next) return { pos: { path: pos.path, line: next.line, k: 0 }, open }
  // Past the last call the method returns: its peek closes, and on to the next call of the method that called it. The top has no
  // caller to go back to in the pane, so there the cursor stays where it is.
  const up = pos.path !== top && isUnder(pos.path, top) ? idx.parent(pos.path) : undefined
  if (!up) return { pos, open }
  return overFrom(idx, top, dropPeek(open, pos.path), { path: up.path, line: up.edge.callLine, k: kOf(idx, up.path, up.edge) })
}

/** Step over: the next call of the cursor's method. */
export function over(r: Reading, idx: Index): Reading {
  const s = overFrom(idx, topOf(r), r.open, r.cursor)
  return s.pos === r.cursor && s.open === r.open ? r : withWalked({ ...r, cursor: s.pos, open: s.open }, s.pos.path)
}

/** Step into the call under the cursor: its callee opens as a peek (two deep, else it takes the top) and the cursor goes to its first call. */
export function into(r: Reading, idx: Index): Reading {
  const top = topOf(r)
  if (inCallers(top)) return r
  const call = calleeAt(idx, r.cursor)
  if (!call) return over(r, idx)
  const callee = call.edge.node
  // A table, or a node outside the workspace, has no code to step into: its peek shows what there is, and the cursor stays.
  if (callee.code == null) return { ...r, open: addPeek(r.open, call.path) }
  if (depthOf(r.cursor.path) - depthOf(top) >= MAX_DEPTH) return readAt(r, idx, call.path)
  return withWalked({ ...r, open: addPeek(r.open, call.path), cursor: fresh(idx, call.path) }, call.path)
}

/** Step out: from a peek back to the line that called it (closing it); from the top to the method that called the top, if any. */
export function out(r: Reading, idx: Index): Reading {
  const top = topOf(r)
  const here = r.cursor.path
  if (here !== top && isUnder(here, top)) {
    const up = idx.parent(here)
    if (!up) return r
    return { ...r, open: dropPeek(r.open, here), cursor: { path: up.path, line: up.edge.callLine, k: kOf(idx, up.path, up.edge) } }
  }
  const above = chainOf(idx, top).at(-1)
  return above ? readAt(r, idx, above.path, { line: above.line, k: above.k }) : r
}

/** Enter: opens the peek of the call under the cursor, or closes it. */
export function togglePeek(r: Reading, idx: Index): Reading {
  const call = calleeAt(idx, r.cursor)
  if (!call) return r
  if (r.open.includes(call.path)) return { ...r, open: dropPeek(r.open, call.path) }
  if (call.edge.node.code != null && depthOf(r.cursor.path) - depthOf(topOf(r)) >= MAX_DEPTH) return readAt(r, idx, call.path)
  return { ...r, open: addPeek(r.open, call.path) }
}

/** Escape: out of a peek; at the top there is nothing to close, and the focus goes back to the canvas. */
export function escapeStep(r: Reading, idx: Index): Reading | 'leave' {
  return r.cursor.path !== topOf(r) && isUnder(r.cursor.path, topOf(r)) ? out(r, idx) : 'leave'
}

/** The ✕ on a peek's header. A cursor inside it goes back to the line that called it. */
export function closePeek(r: Reading, idx: Index, p: Path): Reading {
  const open = dropPeek(r.open, p)
  const inside = r.cursor.path === p || r.cursor.path.startsWith(p + STEP)
  const up = inside ? idx.parent(p) : undefined
  return up ? { ...r, open, cursor: { path: up.path, line: up.edge.callLine, k: kOf(idx, up.path, up.edge) } } : { ...r, open }
}

/** What opened and what closed between two readings: a new top replaces the whole document, a peek is only its own add or remove. */
export function peekDiff(before: Reading, after: Reading): { add: Path[]; remove: Path[] } {
  if (topOf(before) !== topOf(after)) return { add: [...after.open], remove: [...before.open] }
  return { add: after.open.filter(p => !before.open.includes(p)), remove: before.open.filter(p => !after.open.includes(p)) }
}

// ---- the folded chain above a top that is not the entry --------------------------------------------------------------------
export interface Link {
  path: Path
  key: string
  /** The method's own name (no class). */
  name: string
  /** The line it calls the next link (or the top) from. */
  line: number
  k: number
}

/** The methods above `top`, outermost first, each with the line it calls the next from; above the entry, its first caller if callers are drawn. */
export function chainOf(idx: Index, top: Path): Link[] {
  if (inCallers(top) || !idx.node(top)) return []
  if (top === ROOT) {
    const c = idx.caller
    return c ? [{ path: c.path, key: c.edge.node.key, name: memberOf(c.edge.node.label), line: c.edge.callLine, k: 0 }] : []
  }
  const links: Link[] = []
  for (let p: Path = top; ; ) {
    const up = idx.parent(p)
    if (!up) break
    const node = idx.node(up.path)!
    p = up.path
    // The change set's own root card is no method: there is nothing to go back to.
    if (node.code == null) continue
    links.unshift({ path: up.path, key: node.key, name: memberOf(node.label), line: up.edge.callLine, k: kOf(idx, up.path, up.edge) })
  }
  return links
}

/** The methods the pane has open: the folded chain, the top and its peeks. */
export function openMethods(r: Reading, idx: Index): Path[] {
  return [...chainOf(idx, topOf(r)).map(c => c.path).filter(p => !inCallers(p)), topOf(r), ...r.open].filter((p, i, all) => all.indexOf(p) === i && idx.node(p))
}

/** The path from the entry down to `p`, entry first. */
export function pathDown(p: Path): Path[] {
  if (p === ROOT || inCallers(p)) return [p]
  const steps = p.split(STEP)
  return [ROOT, ...steps.map((_, i) => steps.slice(0, i + 1).join(STEP))]
}

// ---- a new graph: the reading follows its methods ---------------------------------------------------------------------------
/** Where a cursor line of `before` is in `after`: on the same call (by its place among the calls) if it was on one, else the same distance from the method's start. */
function remapLine(before: FlowNode, after: FlowNode, line: number) {
  const was = callsOf(before)
  const i = was.findIndex(c => c.line === line)
  if (i >= 0) {
    const now = callsOf(after)
    return now[i]?.line ?? firstCall(after)
  }
  return Math.max(after.startLine, Math.min(after.endLine, after.startLine + (line - before.startLine)))
}

/** The reading after the flow was traced again: methods stay by their path, the rest is dropped, and a top that is gone sends the pane to the entry. */
export function retrace(r: Reading, before: Index, after: Index, entry: Path = ROOT): Reading {
  const top = topOf(r)
  if (!after.node(top)) return startReading(after, entry)
  const live = (p: Path) => after.node(p) !== undefined
  const history = r.history.filter(live)
  // The shown step is the last kept one at or before the old position (the top is live, so it is that very step).
  const at = Math.max(0, r.history.slice(0, r.at + 1).filter(live).length - 1)
  let cursor = r.cursor
  const was = before.node(cursor.path)
  const now = after.node(cursor.path)
  if (was && now) cursor = { path: cursor.path, line: remapLine(was, now, cursor.line), k: cursor.k }
  else {
    // The method the cursor was in is gone (its call was removed): the cursor goes back to the nearest one that is still there.
    let p = cursor.path
    while (!live(p) || !isUnder(p, top)) p = parentPath(p) ?? top
    cursor = fresh(after, p)
  }
  return { history, at, open: r.open.filter(live), cursor, walked: r.walked.filter(live), kept: r.kept.filter(live) }
}

// ---- Keep this path -------------------------------------------------------------------------------------------------------------
export interface KeepTarget {
  path: Path
  key: string
  file: string
  startLine: number
  endLine: number
}

export interface KeepPlan {
  targets: KeepTarget[]
  /** Open changed methods kept, of open changed methods. */
  kept: number
  total: number
}

/**
 * What "Keep this path" keeps: each changed method open in the pane (the top, its open peeks and the folded chain above), always by its
 * own lines (the host's `keepCard`), never the whole file: the canvas knows only the methods it draws, so a whole-file keep could keep
 * a change nobody read. A method that is not open is never kept.
 */
export function keepPlan(idx: Index, r: Reading): KeepPlan {
  const targets: KeepTarget[] = []
  let kept = 0
  let total = 0
  for (const path of openMethods(r, idx)) {
    const node = idx.node(path)!
    if (!node.diff) {
      if (r.kept.includes(path)) {
        kept++
        total++
      }
      continue
    }
    total++
    const t = keepTarget(path, node)
    if (t) targets.push(t)
  }
  return { targets, kept, total }
}

/** What Keep does for one changed method; nothing for a method that has no file. */
export function keepTarget(path: Path, node: FlowNode): KeepTarget | undefined {
  if (!node.file) return undefined
  return { path, key: node.key, file: node.file, startLine: node.startLine, endLine: node.endLine }
}

/** Remembers that these methods were kept: after the flow is traced again they carry no change, and still count. */
export function markKept(r: Reading, paths: readonly Path[]): Reading {
  return { ...r, kept: [...new Set([...r.kept, ...paths])] }
}

// ---- the pane's keys -------------------------------------------------------------------------------------------------------------
/** The editor's own hidden input, how Monaco takes keys (read-only here, so the pane's keys still work). Its find widget's inputs are not it. */
export const isEditorInput = (tag: string, className: string) => tag === 'TEXTAREA' && /\binputarea\b/.test(className)

export type PaneAction = 'over' | 'into' | 'out' | 'peek' | 'escape' | 'back' | 'forward'

export interface PaneKeyEvent {
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  /** `getModifierState('AltGraph')`: Chromium on Windows reports AltGr as Ctrl+Alt, and `[` and `]` are typed with it on many layouts. */
  altGraph: boolean
  /** The focus is inside the pane. */
  inPane: boolean
  /** The tag name of the element that has the focus. */
  target: string
  /** The focus is in a Monaco editor's own hidden input (`isEditorInput`). */
  monaco?: boolean
}

/**
 * What the pane does with a key, or nothing: then the key goes on to the editor and the workbench untouched. Only while the focus is
 * inside the pane. Bare F10 and F11 and Alt+←/→ stay VS Code's; Alt+F10 (menu bar) and Alt+F11 (step into on web+Windows) are the pane's
 * while it has the focus.
 */
export function paneKey(e: PaneKeyEvent): PaneAction | undefined {
  if (!e.inPane || e.metaKey) return undefined
  // A text field keeps its keys; Enter and Space on a button press it.
  if (!e.monaco && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target)) return undefined
  if (e.target === 'BUTTON' && (e.key === 'Enter' || e.key === ' ')) return undefined
  const plain = !e.ctrlKey && !e.altKey && !e.shiftKey
  if (e.key === '[' || e.key === ']') {
    // AltGr reaches us as Ctrl+Alt (with the AltGraph state): then it is the bracket. Ctrl or Alt alone is a shortcut.
    if ((e.ctrlKey || e.altKey) && !(e.ctrlKey && e.altKey && e.altGraph)) return undefined
    return e.key === '[' ? 'back' : 'forward'
  }
  if (e.altKey && !e.ctrlKey) {
    if (e.key === 'F10' && !e.shiftKey) return 'over'
    if (e.key === 'F11') return e.shiftKey ? 'out' : 'into'
    return undefined
  }
  if (!plain) return undefined
  return e.key === 'j' ? 'over' : e.key === 'l' ? 'into' : e.key === 'h' ? 'out' : e.key === 'Enter' ? 'peek' : e.key === 'Escape' ? 'escape' : undefined
}

// ---- where peeks sit in their editor ---------------------------------------------------------------------------------------------
export interface Zone {
  id: string
  /** Below this line of the editor (0: above the first). */
  after: number
  kind: 'del' | 'peek'
  height: number
}

export interface PlacedZone extends Zone {
  /** Monaco's tiebreaker for zones after the same line. */
  ordinal: number
  /** Top of the zone, in pixels from the top of the editor's content. */
  top: number
}

/**
 * The zones in the order they stack, with their tops. Zones below the same line stack removed lines first, then the peeks in the order
 * given; each sits under every zone above it. Line wrapping is off in the pane, so a line is as tall as `lineH`.
 */
export function zoneTops(zones: readonly Zone[], lineH: number, padTop: number): PlacedZone[] {
  const order = zones.map((z, i) => ({ z, i })).sort((a, b) => a.z.after - b.z.after || (a.z.kind === b.z.kind ? 0 : a.z.kind === 'del' ? -1 : 1) || a.i - b.i)
  let above = 0
  return order.map(({ z }, n) => {
    const top = padTop + z.after * lineH + above
    above += z.height
    return { ...z, ordinal: n, top }
  })
}

/** Top of a line, with every zone above it counted. */
export function lineTop(zones: readonly Zone[], line: number, lineH: number, padTop: number) {
  return padTop + (line - 1) * lineH + zones.filter(z => z.after < line).reduce((sum, z) => sum + z.height, 0)
}

// ---- the canvas as a trace of the reading ---------------------------------------------------------------------------------------
export type TraceClass = 'path' | 'next' | 'read' | 'dim'

/**
 * Which class each card and wire of the canvas gets while the pane is open: the path from the entry to the cursor solid, the callee
 * under the cursor (and its wire) next, cards the cursor has been in plain, the rest faded. Data for the canvas's stylesheet: no CSS is generated.
 */
export function traceOf(idx: Index, r: Reading) {
  const stack = pathDown(r.cursor.path).map(p => idx.keyOf(p)).filter((k): k is string => !!k)
  const path = new Set(stack)
  const read = new Set(r.walked.map(p => idx.keyOf(p)).filter((k): k is string => !!k))
  const next = calleeAt(idx, r.cursor)?.edge.node.key
  const onPath = (a: string, b: string) => stack.some((k, i) => i > 0 && stack[i - 1] === a && k === b)
  return {
    node: (key: string): TraceClass => (path.has(key) ? 'path' : key === next ? 'next' : read.has(key) ? 'read' : 'dim'),
    edge: (source: string, target: string): TraceClass => (onPath(source, target) ? 'path' : next && target === next && source === stack.at(-1) ? 'next' : 'dim'),
  }
}

// ---- whether the pane is there ------------------------------------------------------------------------------------------------------
/** The pane opens unless the user closed it last time; storage that is missing or throws leaves it open; the home page's hero never opens it. */
export function initialPane(read: (() => string | null) | undefined, hero: boolean) {
  if (hero) return false
  try {
    return read?.() !== 'closed'
  } catch {
    return true
  }
}

/** The least the pane is wide, and the least it leaves the canvas. */
export const PANE_MIN = 340
export const CANVAS_MIN = 320

/**
 * How the pane sits in a body `bodyW` wide when the reader wants it `want` wide: never narrower than PANE_MIN, never leaving the canvas
 * less than CANVAS_MIN. A body that holds both minimums at most is too narrow (a phone): the pane steps aside, and comes back when there is room.
 */
export function paneFit(bodyW: number, want: number) {
  const max = bodyW - CANVAS_MIN
  return { show: max >= PANE_MIN, width: Math.max(PANE_MIN, Math.min(max, want)) }
}

/** The pane is drawn when it is open and no tour plays: a tour talks about the cards' code, so they show it. */
export const paneShown = (open: boolean, touring: boolean) => open && !touring
