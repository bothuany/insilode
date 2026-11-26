// The reading pane beside the canvas: the flow read as one document. The method you picked is at the top; a call opens its callee
// right under the line that makes it (a peek, two deep; deeper, the callee takes the top), so the path reads top to bottom
// without losing the caller. A cursor walks it like a debugger that runs nothing: step over to the next call, into a call, out to
// the line that called. A changed method shows its change in place (added lines marked, removed ones under the line they followed),
// so a review reads the path the same way, with Keep and Undo where the change is. The canvas follows the cursor.
// Keys work only while the pane has the focus: the webview passes every key on to the workbench too, so F10/F11/Alt+← stay VS Code's.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import * as monaco from 'monaco-editor'
import { KindGlyph, langOf, splitLabel, useColorized } from '../nodes'
import { KIND_COLOR } from '../layout'
import type { EdgeKind, FlowEdge, FlowNode } from '../types'
import { bindings, crossing, firstCall, type Binding } from './reading'

/** How the method at the top of the pane was reached: the caller, the line it called from and the kind of call. */
export interface Arrival {
  node: FlowNode
  line: number
  edgeKind: EdgeKind
}

interface Props {
  root: FlowNode
  /** False for a caller card (its children are its callers, not its calls): no peeks, no stepping. */
  downward: boolean
  arrival: Arrival | null
  /** Where the cursor starts (a step out of the top lands on the calling line); else the first call. */
  focusLine?: number
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  /** The cursor moved: the method it is in, the call it is on (if any), and the methods from the top down to it. */
  onCursor: (key: string, callee: string | null, stack: string[]) => void
  /** Step out of the method at the top: read its caller instead. */
  onOutOfRoot: () => void
  onCaller: () => void
  /** Read a method at the top of the pane (a peek's "Read", or a step deeper than peeks go). */
  onRead: (key: string, line?: number) => void
  /** Open a method's file in the editor, at a line of it. */
  onOpen: (key: string, line?: number) => void
  /** Keep or undo an agent's change to a method; absent where the canvas offers neither. */
  onKeep?: (key: string) => void
  onUndo?: (key: string) => void
  /** Escape at the top: the focus goes back to the canvas. */
  onLeave: () => void
  onClose: () => void
}

const editorFont = () => {
  const css = getComputedStyle(document.documentElement)
  const size = parseFloat(css.getPropertyValue('--vscode-editor-font-size'))
  return { fontFamily: css.getPropertyValue('--fl-mono').trim() || undefined, fontSize: Number.isFinite(size) && size > 0 ? size : 13 }
}

const READ_ONLY: monaco.editor.IEditorOptions = {
  readOnly: true,
  domReadOnly: true,
  readOnlyMessage: { value: '' },
  minimap: { enabled: false },
  glyphMargin: false,
  folding: false,
  scrollBeyondLastLine: false,
  renderLineHighlight: 'none',
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  lineNumbersMinChars: 4,
  contextmenu: false,
  occurrencesHighlight: 'off',
  selectionHighlight: false,
  matchBrackets: 'never',
  padding: { top: 6, bottom: 6 },
}
/** A peek's header above its code, and how far in it sits. */
const PEEK_HEAD = 28
const PEEK_INDENT = 18
/** Peeks go this deep; a step further puts the callee at the top of the pane, with its caller line above it. */
const MAX_DEPTH = 2
/** A peek taller than this scrolls inside itself, so a long method does not push the rest of the path away. */
const PEEK_MAX_H = 360

interface Mounted {
  editor: monaco.editor.ICodeEditor
  depth: number
  /** Top of this editor's first line in the pane's root editor, in pixels of its content (a peek's own scroll is not counted). */
  offset: () => number
  decorations: monaco.editor.IEditorDecorationsCollection
}

export function ReadPane(props: Props) {
  const { root, downward, arrival, focusLine, canBack, canForward, onBack, onForward, onCaller, onOpen, onClose } = props
  const host = useRef<HTMLDivElement>(null)
  const pane = useRef<HTMLElement>(null)
  const cb = useRef(props)
  cb.current = props
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [cur, setCur] = useState<{ key: string; line: number }>({ key: root.key, line: focusLine ?? firstCall(root) })
  const [built, setBuilt] = useState(0)
  const mounted = useRef(new Map<string, Mounted>())

  // Every method reachable from the top, how it is reached, and how deep its peek sits.
  const tree = useMemo(() => {
    const byKey = new Map<string, FlowNode>([[root.key, root]])
    const parent = new Map<string, { node: FlowNode; edge: FlowEdge }>()
    const depth = new Map<string, number>([[root.key, 0]])
    const walk = (n: FlowNode, d: number) =>
      downward &&
      n.children.forEach(e => {
        byKey.set(e.node.key, e.node)
        parent.set(e.node.key, { node: n, edge: e })
        depth.set(e.node.key, d + 1)
        walk(e.node, d + 1)
      })
    walk(root, 0)
    return { byKey, parent, depth }
  }, [root, downward])

  // A new method at the top starts a new reading: nothing peeked, the cursor on its first call (or where a step out landed).
  useEffect(() => {
    setOpen(new Set())
    setCur({ key: root.key, line: focusLine ?? firstCall(root) })
  }, [root.key, focusLine]) // eslint-disable-line react-hooks/exhaustive-deps

  const calleeAt = (key: string, line: number) => tree.byKey.get(key)?.children.find(e => e.callLine === line) ?? null
  const depthOf = (key: string) => tree.depth.get(key) ?? 0

  /** Opens the peek of a call; past the deepest peek the callee goes to the top of the pane instead. */
  const peek = (from: string, callee: FlowNode, enter: boolean) => {
    if (depthOf(from) >= MAX_DEPTH) return cb.current.onRead(callee.key, enter && callee.code ? firstCall(callee) : undefined)
    setOpen(o => new Set(o).add(callee.key))
    if (enter && callee.code) setCur({ key: callee.key, line: firstCall(callee) })
  }

  // ---- stepping: a debugger's three moves over code that does not run ---------------------------------------------------
  const stepOver = (from = cur): void => {
    const node = tree.byKey.get(from.key)
    if (!node) return
    const next = node.children.map(e => e.callLine).filter(l => l > from.line).sort((a, b) => a - b)[0]
    if (next !== undefined) return setCur({ key: from.key, line: next })
    // Past the last call the method returns: on to the next call of the method that called it.
    const up = tree.parent.get(from.key)
    if (!up) return
    setOpen(o => without(o, from.key))
    stepOver({ key: up.node.key, line: up.edge.callLine })
  }
  const stepInto = () => {
    const edge = calleeAt(cur.key, cur.line)
    if (!edge) return stepOver()
    // A table or a node outside the workspace has no code to step into: its peek shows what there is, the cursor stays.
    peek(cur.key, edge.node, true)
  }
  const stepOut = () => {
    const up = tree.parent.get(cur.key)
    if (!up) return cb.current.onOutOfRoot()
    setOpen(o => without(o, cur.key))
    setCur({ key: up.node.key, line: up.edge.callLine })
  }
  const togglePeek = () => {
    const edge = calleeAt(cur.key, cur.line)
    if (!edge) return
    if (open.has(edge.node.key)) setOpen(o => without(o, edge.node.key))
    else peek(cur.key, edge.node, false)
  }

  /** The pane's own keys, taken before the editors see them; only while the focus is in the pane. */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target as HTMLElement
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || (t.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' '))) return
    const act =
      e.key === 'j' ? stepOver : e.key === 'l' ? stepInto : e.key === 'h' ? stepOut : e.key === 'Enter' ? togglePeek
      : e.key === 'Escape' ? () => (tree.parent.has(cur.key) ? stepOut() : cb.current.onLeave())
      : e.key === '[' ? onBack : e.key === ']' ? onForward : null
    if (!act) return
    e.preventDefault()
    e.stopPropagation()
    act()
  }

  // The canvas shows where the cursor is: the card, the wire of the call it is on, and the path down to it.
  useEffect(() => {
    const stack: string[] = []
    for (let k: string | undefined = cur.key; k; k = tree.parent.get(k)?.node.key) stack.unshift(k)
    cb.current.onCursor(cur.key, calleeAt(cur.key, cur.line)?.node.key ?? null, stack)
  }, [cur.key, cur.line, tree]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the document: an editor for the top method, a nested editor in a view zone under each peeked call -------------------
  useEffect(() => {
    const el = host.current
    if (!el || root.code == null) return
    const all: monaco.IDisposable[] = []
    const css: string[] = []
    mounted.current = new Map()

    /** One method's editor: its change marked, its call notes, a click that moves the cursor or opens a peek, and its peeks. */
    const mount = (node: FlowNode, into: HTMLElement, width: number, offset: () => number, depth: number): monaco.editor.ICodeEditor => {
      const top = depth === 0
      const ed = monaco.editor.create(into, {
        ...READ_ONLY,
        ...editorFont(),
        value: node.code ?? '',
        language: langOf(node.file),
        lineNumbers: n => String(n + node.startLine - 1),
        automaticLayout: top,
        scrollbar: top ? { verticalScrollbarSize: 10, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false } : { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, alwaysConsumeMouseWheel: false },
        ariaLabel: `${node.label}${node.diff ? `, changed: ${node.diff.plus} added, ${node.diff.minus} removed` : ''}`,
      })
      all.push(ed)
      const model = ed.getModel()!
      const lineH = ed.getOption(monaco.editor.EditorOption.lineHeight)
      const decorations = ed.createDecorationsCollection()
      mounted.current.set(node.key, { editor: ed, depth, offset, decorations })
      const at = (fileLine: number) => fileLine - node.startLine + 1
      const marks: monaco.editor.IModelDeltaDecoration[] = []
      // A change in place: added lines tinted with a + in the margin, removed lines in a zone under the line they followed.
      for (const no of node.diff?.added ?? []) {
        const l = at(no)
        if (l >= 1 && l <= model.getLineCount()) marks.push({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rp-add', linesDecorationsClassName: 'rp-add-sign' } })
      }
      // Each call line says where it goes, hanging off its end so it never covers the code. CSS content on a class per line:
      // this Monaco build drew no injected text, and the class is also how a click on the note is found.
      const byLine = new Map<number, FlowEdge[]>()
      node.children.forEach(e => byLine.set(e.callLine, [...(byLine.get(e.callLine) ?? []), e]))
      for (const [line, es] of byLine) {
        const l = at(line)
        if (!downward || l < 1 || l > model.getLineCount()) continue
        const end = model.getLineMaxColumn(l)
        const peeked = es.some(e => open.has(e.node.key))
        const cls = `rp-note-${depth}-${node.key.replace(/[^\w-]/g, '_')}-${line}`
        const changed = es[0].node.diff ? ' · changed' : ''
        css.push(`.${cls}::after { content: ${JSON.stringify(`${peeked ? '▾' : '▸'} ${splitLabel(es[0].node.label).member}${es.length > 1 ? ` +${es.length - 1}` : ''}${changed}`)}; color: ${KIND_COLOR[es[0].node.kind]}; }`)
        marks.push({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rp-call-line' } })
        marks.push({ range: new monaco.Range(l, end, l, end), options: { afterContentClassName: `rp-call-note ${cls}` } })
      }
      ed.createDecorationsCollection(marks)
      all.push(
        ed.onMouseDown(e => {
          const line = e.target.position?.lineNumber
          if (!line) return
          const fileLine = line + node.startLine - 1
          const onNote = (e.event.browserEvent.target as HTMLElement | null)?.closest?.('.rp-call-note')
          const es = byLine.get(fileLine)
          setCur({ key: node.key, line: fileLine })
          if (!onNote || !es) return
          // A click on the note peeks into the call (or closes the peek); with Ctrl/Cmd it also steps the cursor in.
          const callee = es[0].node
          const into = e.event.ctrlKey || e.event.metaKey
          if (open.has(callee.key) && !into) setOpen(o => without(o, callee.key))
          else peek(node.key, callee, into)
        }),
      )

      ed.changeViewZones(zones => {
        for (const r of node.diff?.removed ?? []) {
          const dom = document.createElement('div')
          dom.className = 'rp-del'
          for (const text of r.lines) {
            const row = document.createElement('div')
            row.textContent = text.replace(/\t/g, '    ') || ' '
            dom.appendChild(row)
          }
          zones.addZone({ afterLineNumber: Math.max(0, at(r.after)), heightInPx: r.lines.length * lineH, domNode: dom })
        }
        if (!downward) return
        for (const edge of node.children) {
          if (!open.has(edge.node.key)) continue
          const l = at(edge.callLine)
          if (l < 1 || l > model.getLineCount()) continue
          const callee = edge.node
          const zone = document.createElement('div')
          zone.className = `rp-peek${callee.diff ? ' changed' : ''}`
          zone.style.paddingLeft = `${PEEK_INDENT}px`
          zone.style.setProperty('--c', KIND_COLOR[callee.kind])
          zone.appendChild(peekHead(callee, edge, node))
          const box = document.createElement('div')
          zone.appendChild(box)
          const innerW = Math.max(240, width - PEEK_INDENT - 10)
          const zoneTop = () => offset() + ed.getTopForLineNumber(l) + lineH
          let height: number
          if (callee.code) {
            box.style.width = `${innerW}px`
            const child = mount(callee, box, innerW, () => zoneTop() + PEEK_HEAD, depth + 1)
            const h = Math.min(PEEK_MAX_H, child.getContentHeight() + 4)
            child.layout({ width: innerW, height: h })
            box.style.height = `${h}px`
            height = PEEK_HEAD + h + 8
          } else {
            box.appendChild(tableBody(callee))
            height = PEEK_HEAD + (callee.schema ? Math.min(callee.schema.columns.length, 8) * 18 + 10 : 24) + 8
          }
          zones.addZone({ afterLineNumber: l, heightInPx: height, domNode: zone, suppressMouseDown: true })
        }
      })
      if (!top) ed.layout({ width, height: ed.getContentHeight() })
      return ed
    }

    const rootEd = mount(root, el, el.clientWidth || 600, () => 0, 0)
    const style = document.createElement('style')
    style.textContent = css.join('\n')
    document.head.appendChild(style)
    if (scrollKeep.current?.key === root.key) rootEd.setScrollTop(scrollKeep.current.top)
    const keep = rootEd.onDidScrollChange(e => (scrollKeep.current = { key: root.key, top: e.scrollTop }))
    // A rebuild removes the editor that had the focus: the focus stays in the pane, so the next key steps on.
    if (refocus.current) pane.current?.focus({ preventScroll: true })
    refocus.current = false
    setBuilt(b => b + 1)
    return () => {
      refocus.current = !!pane.current?.contains(document.activeElement)
      keep.dispose()
      style.remove()
      all.reverse().forEach(d => d.dispose())
      mounted.current = new Map()
    }
  }, [root, open, downward]) // eslint-disable-line react-hooks/exhaustive-deps
  const scrollKeep = useRef<{ key: string; top: number }>(undefined)
  const refocus = useRef(false)

  // The cursor: its line marked in whichever editor holds it, and scrolled into view in the pane.
  useEffect(() => {
    mounted.current.forEach(m => m.decorations.clear())
    const m = mounted.current.get(cur.key)
    const node = tree.byKey.get(cur.key)
    if (!m || !node) return
    const l = cur.line - node.startLine + 1
    m.decorations.set([{ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rp-cur', linesDecorationsClassName: 'rp-cur-mark' } }])
    if (m.depth > 0) m.editor.revealLineInCenterIfOutsideViewport(l)
    const rootEd = mounted.current.get(root.key)?.editor
    if (!rootEd) return
    const y = m.offset() + (m.depth > 0 ? 0 : m.editor.getTopForLineNumber(l))
    const view = rootEd.getLayoutInfo().height
    const top = rootEd.getScrollTop()
    if (y < top + 20 || y > top + view - 80) rootEd.setScrollTop(Math.max(0, y - view / 3))
  }, [cur, built]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the frame around the document -----------------------------------------------------------------------------------
  const { owner, member } = splitLabel(root.label)
  const file = root.file?.split(/[\\/]/).pop()
  const callerLine = arrival?.node.code?.replace(/\r/g, '').split('\n')[arrival.line - arrival.node.startLine]?.trim() ?? ''
  const callerHtml = useColorized(callerLine, langOf(arrival?.node.file))
  const hop = arrival ? crossing(arrival.edgeKind, arrival.node, root) : null
  const bound = arrival && arrival.edgeKind === 'call' ? bindings(callerLine, root) : []
  const stepping = downward && root.code != null

  return (
    <section ref={pane} className="rp" tabIndex={-1} aria-label={`Reading ${root.label}. j step over, l step into, h step out, Enter peek, Escape back.`} onKeyDownCapture={onKeyDown}>
      <header className="rp-head">
        <div className="rp-nav">
          <button className="tool" onClick={onBack} disabled={!canBack} title="Back ([)" aria-label="Back">←</button>
          <button className="tool" onClick={onForward} disabled={!canForward} title="Forward (])" aria-label="Forward">→</button>
        </div>
        <KindGlyph kind={root.kind} />
        <div className="rp-title" title={root.label}>
          {owner && <span className="owner">{owner}.</span>}
          <span className="member">{member}</span>
          {bound.length > 0 && <Bound items={bound} />}
        </div>
        <span className="rp-file">{file ? `${file}:${root.startLine}` : root.sub}</span>
        <span className="wv-spacer" />
        {root.diff && <ChangeActions node={root} onKeep={props.onKeep} onUndo={props.onUndo} />}
        {stepping && (
          <div className="rp-steps" role="group" aria-label="Step through the flow">
            <button className="tool" onClick={() => stepOver()} title="Step over: the next call (j)" aria-label="Step over">
              <StepIcon d="M2 9.5 A5 5 0 0 1 12 6.5 M12 3 v3.5 h-3.5" />
            </button>
            <button className="tool" onClick={stepInto} title="Step into the call (l)" aria-label="Step into">
              <StepIcon d="M7 1.5 v7 M4 5.5 l3 3 3-3" />
            </button>
            <button className="tool" onClick={stepOut} title="Step out to the line that called (h)" aria-label="Step out">
              <StepIcon d="M7 9 v-7 M4 5 l3-3 3 3" />
            </button>
          </div>
        )}
        {root.file && <button className="tool" onClick={() => onOpen(cur.key, cur.line)} title="Open the cursor's line in the editor">Open ↗</button>}
        <button className="tool" onClick={onClose} title="Close the reading pane" aria-label="Close the reading pane">✕</button>
      </header>
      {hop && <div className="rp-hop" style={{ ['--c' as string]: KIND_COLOR[root.kind] }}>{hop}</div>}
      {arrival && callerLine && (
        <button className="rp-caller" onClick={onCaller} title={`Back to ${arrival.node.label}`}>
          <span className="rp-caller-name">{splitLabel(arrival.node.label).member}:{arrival.line}</span>
          {callerHtml ? <span className="rp-caller-src" dangerouslySetInnerHTML={{ __html: callerHtml[0] ?? '' }} /> : <span className="rp-caller-src">{callerLine}</span>}
        </button>
      )}
      {root.code != null ? <div className="rp-editor" ref={host} /> : <p className="rp-empty">{root.schema ? `Table ${root.schema.table}: its columns are on the card.` : 'No source for this card.'}</p>}
    </section>
  )

  /** A peek's header: where the call goes, the values it passes, the service border it crosses, and Keep/Undo for a change. */
  function peekHead(callee: FlowNode, edge: FlowEdge, caller: FlowNode) {
    const head = document.createElement('div')
    head.className = 'rp-peek-head'
    const name = document.createElement('span')
    name.className = 'rp-peek-name'
    name.textContent = splitLabel(callee.label).member
    head.appendChild(name)
    const line = caller.code?.replace(/\r/g, '').split('\n')[edge.callLine - caller.startLine]?.trim() ?? ''
    const b = edge.edgeKind === 'call' ? bindings(line, callee) : []
    if (b.length) {
      const args = document.createElement('span')
      args.className = 'rp-bound'
      args.textContent = `(${b.map(x => (x.param === x.arg ? x.param : `${x.param} ← ${x.arg}`)).join(', ')})`
      head.appendChild(args)
    }
    const where = document.createElement('span')
    where.className = 'rp-peek-where'
    const hopText = crossing(edge.edgeKind, caller, callee)
    where.textContent = hopText ?? (callee.file ? `${callee.file.split(/[\\/]/).pop()}:${callee.startLine}` : callee.sub)
    where.title = where.textContent
    if (hopText) where.classList.add('hop')
    head.appendChild(where)
    const tools = document.createElement('span')
    tools.className = 'rp-peek-tools'
    const button = (text: string, title: string, run: () => void, cls = 'tool') => {
      const btn = document.createElement('button')
      btn.className = cls
      btn.textContent = text
      btn.title = title
      btn.setAttribute('aria-label', title)
      btn.onclick = run
      tools.appendChild(btn)
    }
    if (callee.diff) {
      const stat = document.createElement('span')
      stat.className = 'rp-stat'
      stat.innerHTML = `<b class="plus">+${callee.diff.plus}</b> <b class="minus">−${callee.diff.minus}</b>`
      tools.appendChild(stat)
      if (cb.current.onUndo && !callee.diff.base) button('Undo', `Undo the change to ${callee.label}`, () => cb.current.onUndo!(callee.key), 'btn ghost')
      if (cb.current.onKeep) button('Keep', `Keep the change to ${callee.label}`, () => cb.current.onKeep!(callee.key), 'btn solid')
    }
    button('Read ↗', 'Read this method at the top of the pane', () => cb.current.onRead(callee.key))
    button('✕', 'Close the peek', () => setOpen(o => without(o, callee.key)))
    head.appendChild(tools)
    return head
  }
}

function ChangeActions({ node, onKeep, onUndo }: { node: FlowNode; onKeep?: (key: string) => void; onUndo?: (key: string) => void }) {
  const d = node.diff!
  return (
    <div className="rp-change">
      <span className="rp-stat">
        <b className="plus">+{d.plus}</b> <b className="minus">−{d.minus}</b>
      </span>
      {onUndo && !d.base && <button className="btn ghost" onClick={() => onUndo(node.key)}>Undo</button>}
      {onKeep && <button className="btn solid" onClick={() => onKeep(node.key)}>Keep</button>}
    </div>
  )
}

function tableBody(node: FlowNode) {
  const body = document.createElement('div')
  body.className = 'rp-table'
  if (!node.schema) {
    body.textContent = node.sub || 'Outside this workspace: no code to read.'
    return body
  }
  for (const c of node.schema.columns.slice(0, 8)) {
    const row = document.createElement('div')
    const n = document.createElement('span')
    n.textContent = `${c.key ? 'PK ' : ''}${c.name}`
    const t = document.createElement('span')
    t.textContent = `${c.type}${c.nullable ? '?' : ''}`
    row.append(n, t)
    body.appendChild(row)
  }
  return body
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

function without(set: ReadonlySet<string>, key: string) {
  const next = new Set(set)
  next.delete(key)
  return next
}
