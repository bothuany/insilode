// The reading pane beside the canvas: the flow read as one document. The method you picked is at the top; a call opens its callee
// right under the line that makes it (a peek, two deep; deeper, the callee takes the top and the methods above it stay as folded
// one-line headers), so the path reads top to bottom without losing the caller. A cursor walks it like a debugger that runs nothing:
// step over to the next call, into a call, out to the line that called. A changed method shows its change in place (added lines
// marked, removed ones under the line they followed), so a review reads the path the same way, with Keep and Undo where the change is.
// The canvas follows the cursor. What the pane does is model.ts; the editors are ReadDoc.ts; this is the frame around them.
// Keys work only while the pane has the focus: the webview passes every key on to the workbench too, so bare F10/F11 and Alt+←/→ stay VS Code's.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { KindGlyph, langOf, splitLabel, useColorized } from '../nodes'
import { KIND_COLOR } from '../layout'
import type { FlowNode } from '../types'
import { bindings, crossing, type Binding } from './reading'
import {
  chainOf,
  closePeek,
  escapeStep,
  into,
  isCaller,
  keepPlan,
  keepTarget,
  moveTo,
  out,
  over,
  paneKey,
  readAt,
  stepHistory,
  togglePeek,
  topOf,
  type Index,
  type KeepTarget,
  type Link,
  type PaneAction,
  type Reading,
} from './model'
import { ReadDoc, type DocHooks, type DocView } from './ReadDoc'

interface Props {
  idx: Index
  /** The folder every file of the flow lies under, for the service a call crosses into. */
  base: readonly string[]
  reading: Reading
  /** Changes the reading: every key and click of the pane is a move of the model. */
  update: (f: (r: Reading, idx: Index) => Reading) => void
  /** Every changed method known, so "Keep" follows the canvas's rule (the whole file only for a file's only change). */
  changed: readonly FlowNode[]
  /** The Changes rail's ticks, shared. */
  viewed: ReadonlySet<string>
  onViewed: (key: string) => void
  /** Keep what the plan says; absent where the canvas offers no Keep. */
  onKeep?: (targets: KeepTarget[]) => void
  onUndo?: (key: string) => void
  /** Open a method's file in the editor, at a line of it. */
  onOpen: (key: string, line?: number) => void
  /** Escape at the top: the focus goes back to the canvas. */
  onLeave: () => void
  onClose: () => void
}

const MOVES: Record<Exclude<PaneAction, 'escape'>, (r: Reading, idx: Index) => Reading> = {
  over,
  into,
  out,
  peek: togglePeek,
  back: (r, idx) => stepHistory(r, idx, -1),
  forward: (r, idx) => stepHistory(r, idx, 1),
}

export function ReadPane(props: Props) {
  const { idx, base, reading, update, changed, viewed, onClose } = props
  const topPath = topOf(reading)
  const root = idx.node(topPath)!
  const downward = !isCaller(topPath)
  const host = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const cb = useRef(props)
  cb.current = props
  const [doc, setDoc] = useState<ReadDoc | null>(null)
  const scrollKeep = useRef<{ path: string; top: number }>(undefined)
  const refocus = useRef(false)

  // ---- the document: built once for the method at the top, then changed in place -------------------------------------------------
  useEffect(() => {
    const el = host.current
    if (!el || root.code == null) return
    const hooks: DocHooks = {
      moveTo: pos => cb.current.update(r => moveTo(r, pos)),
      note: (pos, enter) =>
        cb.current.update((r, i) => {
          const there = moveTo(r, pos)
          return enter ? into(there, i) : togglePeek(there, i)
        }),
      closePeek: p => cb.current.update((r, i) => closePeek(r, i, p)),
      read: p => cb.current.update((r, i) => readAt(r, i, p)),
      keep: p => {
        const node = idx.node(p)
        const t = node && keepTarget(p, node, cb.current.changed)
        if (t) cb.current.onKeep?.([t])
      },
      undo: p => {
        const key = idx.keyOf(p)
        if (key) cb.current.onUndo?.(key)
      },
      viewed: p => {
        const key = idx.keyOf(p)
        if (key) cb.current.onViewed(key)
      },
    }
    const view: DocView = {
      idx,
      base,
      downward,
      hooks,
      review: p => {
        const n = idx.node(p)
        return { keepable: !!cb.current.onKeep && !!n && !!keepTarget(p, n, cb.current.changed), undoable: !!cb.current.onUndo && !n?.diff?.base, viewed: !!n && cb.current.viewed.has(n.key) }
      },
    }
    const d = new ReadDoc(el, root, topPath, view)
    if (scrollKeep.current?.path === topPath) d.scrollTop = scrollKeep.current.top
    const keep = d.root.editor.onDidScrollChange(e => (scrollKeep.current = { path: topPath, top: e.scrollTop }))
    // A rebuild removes the editor that had the focus: the focus stays in the pane, so the next key steps on.
    if (refocus.current) pane.current?.focus({ preventScroll: true })
    refocus.current = false
    setDoc(d)
    return () => {
      refocus.current = !!pane.current?.contains(document.activeElement)
      keep.dispose()
      d.dispose()
      setDoc(null)
    }
  }, [root, idx, base, topPath, downward]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => doc?.sync(reading.open), [doc, reading.open])
  useEffect(() => doc?.setCursor(reading.cursor), [doc, reading.cursor, reading.open])
  useEffect(() => doc?.refreshHeads(), [doc, viewed, changed, reading.kept])

  // ---- keys ------------------------------------------------------------------------------------------------------------------
  const readingRef = useRef(reading)
  readingRef.current = reading
  const run = (a: PaneAction) => {
    const now = cb.current
    if (a === 'escape') {
      const r = escapeStep(readingRef.current, idx)
      return r === 'leave' ? now.onLeave() : now.update(() => r)
    }
    now.update(MOVES[a])
  }
  /** The pane's own keys, taken before the editors see them; only while the focus is in the pane (this handler is the pane's). */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement
    const act = paneKey({
      key: e.key,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      altGraph: e.getModifierState('AltGraph'),
      inPane: true,
      target: t.tagName,
      monaco: !!t.closest?.('.monaco-editor'),
    })
    if (!act) return
    e.preventDefault()
    e.stopPropagation()
    run(act)
  }

  // ---- the frame around the document ---------------------------------------------------------------------------------------------
  const { owner, member } = splitLabel(root.label)
  const file = root.file?.split(/[\\/]/).pop()
  const chain = useMemo(() => chainOf(idx, topPath), [idx, topPath])
  const parent = idx.parent(topPath) ?? (topPath === '' ? idx.caller : undefined)
  const above = chain.at(-1)
  const aboveNode = above && idx.node(above.path)
  const aboveLine = above && aboveNode ? (aboveNode.code?.replace(/\r/g, '').split('\n')[above.line - aboveNode.startLine]?.trim() ?? '') : ''
  const hop = aboveNode && parent ? crossing(parent.edge.edgeKind, aboveNode, root, base) : null
  const bound = aboveNode && parent?.edge.edgeKind === 'call' ? bindings(aboveLine, root) : []
  const stepping = downward && root.code != null
  const plan = useMemo(() => keepPlan(idx, reading, changed), [idx, reading, changed])
  const topTarget = root.diff ? keepTarget(topPath, root, changed) : undefined
  const go = (l: Link) => update((r, i) => readAt(r, i, l.path, { line: l.line, k: l.k }))

  return (
    <section ref={pane} className="rp" tabIndex={-1} aria-label={`Reading ${root.label}. j step over, l step into, h step out, Enter peek, Escape back.`} onKeyDownCapture={onKeyDown}>
      <header className="rp-head">
        <div className="rp-nav">
          <button className="tool" onClick={() => run('back')} disabled={reading.at <= 0} title="Back ([)" aria-label="Back">←</button>
          <button className="tool" onClick={() => run('forward')} disabled={reading.at >= reading.history.length - 1} title="Forward (])" aria-label="Forward">→</button>
        </div>
        <KindGlyph kind={root.kind} />
        <div className="rp-title" title={root.label}>
          {owner && <span className="owner">{owner}.</span>}
          <span className="member">{member}</span>
          {bound.length > 0 && <Bound items={bound} />}
        </div>
        <span className="rp-file">{file ? `${file}:${root.startLine}` : root.sub}</span>
        <span className="wv-spacer" />
        {stepping && (
          <div className="rp-steps" role="group" aria-label="Step through the flow">
            <button className="tool" onClick={() => run('over')} title="Step over: the next call (j, Alt+F10)" aria-label="Step over">
              <StepIcon d="M2 9.5 A5 5 0 0 1 12 6.5 M12 3 v3.5 h-3.5" />
            </button>
            <button className="tool" onClick={() => run('into')} title="Step into the call (l, Alt+F11)" aria-label="Step into">
              <StepIcon d="M7 1.5 v7 M4 5.5 l3 3 3-3" />
            </button>
            <button className="tool" onClick={() => run('out')} title="Step out to the line that called (h, Alt+Shift+F11)" aria-label="Step out">
              <StepIcon d="M7 9 v-7 M4 5 l3-3 3 3" />
            </button>
          </div>
        )}
        {root.file && <button className="tool" onClick={() => props.onOpen(idx.keyOf(reading.cursor.path) ?? root.key, reading.cursor.line)} title="Open the cursor's line in the editor">Open ↗</button>}
        <button className="tool" onClick={onClose} title="Close the reading pane" aria-label="Close the reading pane">✕</button>
      </header>
      {(root.diff || (props.onKeep && plan.total > 0)) && (
        <div className="rp-review">
          {root.diff && (
            <div className="rp-change">
              <span className="rp-stat">
                <b className="plus">+{root.diff.plus}</b> <b className="minus">−{root.diff.minus}</b>
              </span>
              <button className={`btn ${viewed.has(root.key) ? 'solid on' : 'ghost'}`} aria-pressed={viewed.has(root.key)} onClick={() => props.onViewed(root.key)} title="Mark this method as viewed (shared with the Changes rail)">Viewed</button>
              {props.onUndo && !root.diff.base && <button className="btn ghost" onClick={() => props.onUndo!(root.key)}>Undo</button>}
              {props.onKeep && topTarget && <button className="btn solid" onClick={() => props.onKeep!([topTarget])}>Keep</button>}
            </div>
          )}
          {props.onKeep && plan.total > 0 && (
            <div className="rp-path" role="group" aria-label="The changes on this path">
              <span className="rp-count" aria-live="polite">{plan.kept} of {plan.total} kept</span>
              {plan.targets.length > 0 && <button className="btn solid" onClick={() => props.onKeep!(plan.targets)} title="Keep every change on the methods open in this pane">Keep this path</button>}
            </div>
          )}
        </div>
      )}
      {hop && <div className="rp-hop" style={{ ['--c' as string]: KIND_COLOR[root.kind] }}>{hop}</div>}
      {chain.length > 0 && (
        <nav className="rp-chain" aria-label="The methods above this one">
          {chain.map(l => (
            <ChainRow key={l.path} link={l} node={idx.node(l.path)!} onGo={() => go(l)} />
          ))}
        </nav>
      )}
      {root.code != null ? <div className="rp-editor" ref={host} /> : <p className="rp-empty">{root.schema ? `Table ${root.schema.table}: its columns are on the card.` : 'No source for this card.'}</p>}
    </section>
  )
}

/** One folded method above the top: its name and the line it calls the next one from, a button back to it. */
function ChainRow({ link, node, onGo }: { link: Link; node: FlowNode; onGo: () => void }) {
  const text = node.code?.replace(/\r/g, '').split('\n')[link.line - node.startLine]?.trim() ?? ''
  const html = useColorized(text, langOf(node.file))
  return (
    <button className="rp-caller" onClick={onGo} title={`Back to ${node.label}`}>
      <span className="rp-caller-name">{link.name}:{link.line}</span>
      {html ? <span className="rp-caller-src" dangerouslySetInnerHTML={{ __html: html[0] ?? '' }} /> : <span className="rp-caller-src">{text}</span>}
    </button>
  )
}

function Bound({ items }: { items: Binding[] }) {
  return <span className="rp-bound">({items.map(x => (x.param === x.arg ? x.param : `${x.param} ← ${x.arg}`)).join(', ')})</span>
}

function StepIcon({ d }: { d: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
      <circle cx="7" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  )
}
