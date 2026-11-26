// The reading pane beside the canvas: the flow read as one document. The method you picked is at the top; a call opens its callee
// right under the line that makes it (a peek, nested as deep as you go), so the path reads top to bottom without losing the caller.
// A cursor walks it like a debugger that runs nothing: step over to the next call, into a call, out to the line that called.
// The canvas follows the cursor (the card and the wire it is on). A changed method reads as a diff instead.
import { useEffect, useMemo, useRef, useState } from 'react'
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
  /** The cursor moved: the method it is in, and the call it is on (if any), for the canvas to show. */
  onCursor: (key: string, callee: string | null) => void
  /** Step out of the method at the top: read its caller instead. */
  onOutOfRoot: () => void
  onCaller: () => void
  /** Read a method at the top of the pane (a peek's "Read"). */
  onRead: (key: string) => void
  /** Open a method's file in the editor, at a line of it. */
  onOpen: (key: string, line?: number) => void
  onClose: () => void
}

/** The method as it was before the change: the added lines left out, the removed ones put back where they were. */
export function originalOf(node: FlowNode) {
  const diff = node.diff
  const lines = (node.code ?? '').replace(/\r/g, '').split('\n')
  if (!diff) return lines.join('\n')
  const removed = new Map(diff.removed.map(r => [r.after, r.lines]))
  const added = new Set(diff.added)
  const out: string[] = [...(removed.get(node.startLine - 1) ?? [])]
  lines.forEach((text, i) => {
    const no = node.startLine + i
    if (!added.has(no)) out.push(text)
    out.push(...(removed.get(no) ?? []))
  })
  return out.join('\n')
}

const editorFont = () => {
  const css = getComputedStyle(document.documentElement)
  const size = parseFloat(css.getPropertyValue('--vscode-editor-font-size'))
  return { fontFamily: css.getPropertyValue('--fl-mono').trim() || undefined, fontSize: Number.isFinite(size) && size > 0 ? size : 13 }
}

const READ_ONLY: monaco.editor.IEditorOptions = {
  readOnly: true,
  domReadOnly: true,
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
/** A peek's header above its code. */
const PEEK_HEAD = 26
const PEEK_INDENT = 22

interface Mounted {
  key: string
  editor: monaco.editor.ICodeEditor
  /** Top of this editor's first line in the pane's root editor, in pixels of its content. */
  offset: () => number
  decorations: monaco.editor.IEditorDecorationsCollection
}

export function ReadPane(props: Props) {
  const { root, downward, arrival, focusLine, canBack, canForward, onBack, onForward, onCaller, onOpen, onClose } = props
  const host = useRef<HTMLDivElement>(null)
  const cb = useRef(props)
  cb.current = props
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const [cur, setCur] = useState<{ key: string; line: number }>({ key: root.key, line: focusLine ?? firstCall(root) })
  const [built, setBuilt] = useState(0)
  const mounted = useRef(new Map<string, Mounted>())

  // Every method reachable from the top, and how it is reached: what stepping out and the call stack walk.
  const tree = useMemo(() => {
    const byKey = new Map<string, FlowNode>([[root.key, root]])
    const parent = new Map<string, { node: FlowNode; edge: FlowEdge }>()
    const walk = (n: FlowNode) =>
      downward &&
      n.children.forEach(e => {
        byKey.set(e.node.key, e.node)
        parent.set(e.node.key, { node: n, edge: e })
        walk(e.node)
      })
    walk(root)
    return { byKey, parent }
  }, [root, downward])

  // A new method at the top starts a new reading: nothing peeked, the cursor on its first call (or where a step out landed).
  useEffect(() => {
    setOpen(new Set())
    setCur({ key: root.key, line: focusLine ?? firstCall(root) })
  }, [root.key, focusLine]) // eslint-disable-line react-hooks/exhaustive-deps

  const calleeAt = (key: string, line: number) => tree.byKey.get(key)?.children.find(e => e.callLine === line) ?? null

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
    const callee = edge.node
    // A table or a node outside the workspace has no code to step into: its peek shows what there is, the cursor stays.
    setOpen(o => new Set(o).add(callee.key))
    if (callee.code) setCur({ key: callee.key, line: firstCall(callee) })
  }
  const stepOut = () => {
    const up = tree.parent.get(cur.key)
    if (!up) return cb.current.onOutOfRoot()
    setOpen(o => without(o, cur.key))
    setCur({ key: up.node.key, line: up.edge.callLine })
  }
  const steps = useRef({ stepOver, stepInto, stepOut })
  steps.current = { stepOver, stepInto, stepOut }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'F10' && e.key !== 'F11') return
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      e.preventDefault()
      if (e.key === 'F10') steps.current.stepOver()
      else if (e.shiftKey) steps.current.stepOut()
      else steps.current.stepInto()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The canvas shows where the cursor is: the card, and the wire of the call it is on.
  useEffect(() => {
    cb.current.onCursor(cur.key, calleeAt(cur.key, cur.line)?.node.key ?? null)
  }, [cur.key, cur.line]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the document: an editor for the top method, a nested editor in a view zone under each peeked call -------------------
  useEffect(() => {
    const el = host.current
    if (!el || root.code == null) return
    const lang = langOf(root.file)
    const lineNumbers = (start: number) => (n: number) => String(n + start - 1)
    if (root.diff) {
      // A change reads as a diff in one column: the pane is narrower than a side-by-side diff needs.
      const original = monaco.editor.createModel(originalOf(root), lang)
      const modified = monaco.editor.createModel(root.code, lang)
      const diff = monaco.editor.createDiffEditor(el, { ...READ_ONLY, ...editorFont(), automaticLayout: true, renderSideBySide: false, originalEditable: false, renderOverviewRuler: false, lineNumbers: lineNumbers(root.startLine) })
      diff.setModel({ original, modified })
      return () => {
        diff.dispose()
        original.dispose()
        modified.dispose()
      }
    }

    const all: monaco.IDisposable[] = []
    const css: string[] = []
    mounted.current = new Map()

    /** One method's editor: its call notes, a click that moves the cursor or opens a peek, and its own peeks inside it. */
    const mount = (node: FlowNode, into: HTMLElement, width: number, offset: () => number, top: boolean): monaco.editor.ICodeEditor => {
      const ed = monaco.editor.create(into, {
        ...READ_ONLY,
        ...editorFont(),
        value: node.code ?? '',
        language: langOf(node.file),
        lineNumbers: lineNumbers(node.startLine),
        automaticLayout: top,
        scrollbar: top ? { verticalScrollbarSize: 10, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false } : { vertical: 'hidden', handleMouseWheel: false, horizontalScrollbarSize: 6, alwaysConsumeMouseWheel: false },
      })
      all.push(ed)
      const model = ed.getModel()!
      const decorations = ed.createDecorationsCollection()
      mounted.current.set(node.key, { key: node.key, editor: ed, offset, decorations })
      const at = (fileLine: number) => fileLine - node.startLine + 1
      // Each call line says where it goes, hanging off its end so it never covers the code. CSS content on a class per line:
      // this Monaco build drew no injected text, and the class is also how a click on the note is found.
      const byLine = new Map<number, FlowEdge[]>()
      node.children.forEach(e => byLine.set(e.callLine, [...(byLine.get(e.callLine) ?? []), e]))
      const notes = [...byLine].flatMap(([line, es]) => {
        const l = at(line)
        if (!downward || l < 1 || l > model.getLineCount()) return []
        const end = model.getLineMaxColumn(l)
        const peeked = es.some(e => open.has(e.node.key))
        const cls = `rp-note-${node.key.replace(/[^\w-]/g, '_')}-${line}`
        css.push(`.${cls}::after { content: ${JSON.stringify(`${peeked ? '▾' : '▸'} ${splitLabel(es[0].node.label).member}${es.length > 1 ? ` +${es.length - 1}` : ''}`)}; color: ${KIND_COLOR[es[0].node.kind]}; }`)
        return [
          { range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rp-call-line' } },
          { range: new monaco.Range(l, end, l, end), options: { afterContentClassName: `rp-call-note ${cls}` } },
        ]
      })
      ed.createDecorationsCollection(notes)
      all.push(
        ed.onMouseDown(e => {
          const line = e.target.position?.lineNumber
          if (!line) return
          const fileLine = line + node.startLine - 1
          const onNote = (e.event.browserEvent.target as HTMLElement | null)?.closest?.('.rp-call-note')
          const es = byLine.get(fileLine)
          if (onNote && es) {
            // A click on the note peeks into the call (or closes the peek); with Ctrl/Cmd it also steps the cursor in.
            const key = es[0].node.key
            setOpen(o => (o.has(key) && !(e.event.ctrlKey || e.event.metaKey) ? without(o, key) : new Set(o).add(key)))
            if ((e.event.ctrlKey || e.event.metaKey) && es[0].node.code) setCur({ key, line: firstCall(es[0].node) })
            else setCur({ key: node.key, line: fileLine })
            return
          }
          setCur({ key: node.key, line: fileLine })
        }),
      )

      // The peeks under this method's calls, each a nested editor in a view zone right under the line that calls it.
      if (downward) {
        ed.changeViewZones(zones => {
          for (const edge of node.children) {
            if (!open.has(edge.node.key)) continue
            const l = at(edge.callLine)
            if (l < 1 || l > model.getLineCount()) continue
            const callee = edge.node
            const zone = document.createElement('div')
            zone.className = 'rp-peek'
            zone.style.paddingLeft = `${PEEK_INDENT}px`
            zone.style.setProperty('--c', KIND_COLOR[callee.kind])
            zone.appendChild(peekHead(callee, edge, node))
            const box = document.createElement('div')
            zone.appendChild(box)
            const innerW = Math.max(200, width - PEEK_INDENT - 8)
            let height: number
            const zoneTop = () => offset() + ed.getTopForLineNumber(l) + ed.getOption(monaco.editor.EditorOption.lineHeight)
            if (callee.code) {
              box.style.width = `${innerW}px`
              const child = mount(callee, box, innerW, () => zoneTop() + PEEK_HEAD, false)
              const h = child.getContentHeight() + 8
              child.layout({ width: innerW, height: h })
              box.style.height = `${h}px`
              height = PEEK_HEAD + h + 6
            } else {
              const body = tableBody(callee)
              box.appendChild(body)
              height = PEEK_HEAD + (callee.schema ? Math.min(callee.schema.columns.length, 8) * 18 + 10 : 24) + 6
            }
            zones.addZone({ afterLineNumber: l, heightInPx: height, domNode: zone, suppressMouseDown: true })
          }
        })
      }
      if (!top) ed.layout({ width, height: ed.getContentHeight() })
      return ed
    }

    const rootEd = mount(root, el, el.clientWidth || 600, () => 0, true)
    const style = document.createElement('style')
    style.textContent = css.join('\n')
    document.head.appendChild(style)
    if (scrollKeep.current?.key === root.key) rootEd.setScrollTop(scrollKeep.current.top)
    const keep = rootEd.onDidScrollChange(e => (scrollKeep.current = { key: root.key, top: e.scrollTop }))
    setBuilt(b => b + 1)
    return () => {
      keep.dispose()
      style.remove()
      all.reverse().forEach(d => d.dispose())
      mounted.current = new Map()
    }
  }, [root, open, downward])
  const scrollKeep = useRef<{ key: string; top: number }>(undefined)

  // The cursor: its line marked in whichever editor holds it, and scrolled into view in the pane.
  useEffect(() => {
    mounted.current.forEach(m => m.decorations.clear())
    const m = mounted.current.get(cur.key)
    const node = tree.byKey.get(cur.key)
    if (!m || !node) return
    const l = cur.line - node.startLine + 1
    m.decorations.set([{ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rp-cur', linesDecorationsClassName: 'rp-cur-mark' } }])
    const rootEd = mounted.current.get(root.key)?.editor
    if (!rootEd) return
    const y = m.offset() + m.editor.getTopForLineNumber(l)
    const view = rootEd.getLayoutInfo().height
    const top = rootEd.getScrollTop()
    if (y < top + 20 || y > top + view - 60) rootEd.setScrollTop(Math.max(0, y - view / 3))
  }, [cur, built]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the frame around the document -----------------------------------------------------------------------------------
  const { owner, member } = splitLabel(root.label)
  const file = root.file?.split(/[\\/]/).pop()
  const callerLine = arrival?.node.code?.replace(/\r/g, '').split('\n')[arrival.line - arrival.node.startLine]?.trim() ?? ''
  const callerHtml = useColorized(callerLine, langOf(arrival?.node.file))
  const hop = arrival ? crossing(arrival.edgeKind, arrival.node, root) : null
  const bound = arrival && arrival.edgeKind === 'call' ? bindings(callerLine, root) : []
  const stack = useMemo(() => {
    const out: FlowNode[] = []
    for (let k: string | undefined = cur.key; k; k = tree.parent.get(k)?.node.key) out.unshift(tree.byKey.get(k)!)
    return out
  }, [cur.key, tree])
  const stepping = downward && !root.diff && root.code != null

  return (
    <section className="rp" aria-label={`Reading ${root.label}`}>
      <header className="rp-head">
        <div className="rp-nav">
          <button className="tool" onClick={onBack} disabled={!canBack} title="Back (Alt+←)" aria-label="Back">←</button>
          <button className="tool" onClick={onForward} disabled={!canForward} title="Forward (Alt+→)" aria-label="Forward">→</button>
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
            <button className="tool" onClick={() => stepOver()} title="Step over: the next call (F10)" aria-label="Step over">
              <StepIcon d="M2 9.5 A5 5 0 0 1 12 6.5 M12 3 v3.5 h-3.5" dot />
            </button>
            <button className="tool" onClick={stepInto} title="Step into the call (F11)" aria-label="Step into">
              <StepIcon d="M7 1.5 v7 M4 5.5 l3 3 3-3" dot />
            </button>
            <button className="tool" onClick={stepOut} title="Step out to the line that called (Shift+F11)" aria-label="Step out">
              <StepIcon d="M7 9 v-7 M4 5 l3-3 3 3" dot />
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
      {stepping && stack.length > 0 && (
        <nav className="rp-stack" aria-label="Call stack">
          <span className="rp-stack-label">Stack</span>
          {stack.map((n, i) => (
            <span key={n.key} className="rp-frame">
              {i > 0 && <span className="rp-frame-sep" aria-hidden="true">›</span>}
              <button className={n.key === cur.key ? 'here' : ''} aria-current={n.key === cur.key ? 'step' : undefined} onClick={() => setCur({ key: n.key, line: i < stack.length - 1 ? tree.parent.get(stack[i + 1].key)!.edge.callLine : cur.line })}>
                {splitLabel(n.label).member}
              </button>
            </span>
          ))}
          <span className="wv-spacer" />
          <span className="rp-keys"><kbd>F10</kbd> over <kbd>F11</kbd> into <kbd>⇧F11</kbd> out</span>
        </nav>
      )}
    </section>
  )

  /** A peek's header: where the call goes, the values it passes, and the service border it crosses. */
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
    if (hopText) where.classList.add('hop')
    head.appendChild(where)
    const go = document.createElement('button')
    go.className = 'tool'
    go.textContent = 'Read ↗'
    go.title = 'Read this method at the top of the pane'
    go.onclick = () => cb.current.onRead(callee.key)
    head.appendChild(go)
    const close = document.createElement('button')
    close.className = 'tool'
    close.textContent = '✕'
    close.title = 'Close the peek'
    close.setAttribute('aria-label', 'Close the peek')
    close.onclick = () => setOpen(o => without(o, callee.key))
    head.appendChild(close)
    return head
  }
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

function StepIcon({ d, dot }: { d: string; dot?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
      {dot && <circle cx="7" cy="12" r="1.3" fill="currentColor" stroke="none" />}
    </svg>
  )
}

function without(set: ReadonlySet<string>, key: string) {
  const next = new Set(set)
  next.delete(key)
  return next
}
