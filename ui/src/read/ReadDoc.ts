// The pane's document: a read-only Monaco editor for the method at the top, and one more editor in a view zone under each call that
// is peeked. It is built once and then changed in place: opening a peek adds its zone and editor, closing one removes only those, so
// nothing already open is rebuilt, re-scrolled or loses its place. Where things sit is worked out in model.ts (zoneTops, lineTop).
import * as monaco from 'monaco-editor'
import { langOf, splitLabel } from '../nodes'
import { KIND_COLOR } from '../layout'
import type { FlowEdge, FlowNode } from '../types'
import { bindings, crossing } from './reading'
import { lineTop, pathDepth, within, zoneTops, type Index, type Path, type Pos, type Zone } from './model'

const editorFont = () => {
  const css = getComputedStyle(document.documentElement)
  const size = parseFloat(css.getPropertyValue('--vscode-editor-font-size'))
  return { fontFamily: css.getPropertyValue('--fl-mono').trim() || undefined, fontSize: Number.isFinite(size) && size > 0 ? size : 13 }
}

const PAD_TOP = 6
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
  wordWrap: 'off',
  padding: { top: PAD_TOP, bottom: 6 },
}
/** How far in a peek sits, the room under it, and the header's height until it is measured. */
const PEEK_INDENT = 18
const PEEK_GAP = 8
const PEEK_HEAD = 28
/** A peek taller than this scrolls inside itself, so a long method does not push the rest of the path away. */
const PEEK_MAX_H = 360

/** What the document needs from the pane around it; read at the moment of each click, so it is always the latest. */
export interface DocHooks {
  moveTo(pos: Pos): void
  /** A click on a call's note: opens or closes its peek; with `enter` the cursor goes in as well. */
  note(pos: Pos, enter: boolean): void
  closePeek(path: Path): void
  read(path: Path): void
  keep(path: Path): void
  undo(path: Path): void
  viewed(path: Path): void
}

export interface DocView {
  idx: Index
  /** The folder every file of the flow lies under: services are named relative to it (reading.ts serviceOf). */
  base: readonly string[]
  /** False for a caller card (its children are its callers, not its calls): no notes, no peeks. */
  downward: boolean
  hooks: DocHooks
  review(path: Path): { keepable: boolean; undoable: boolean; viewed: boolean }
}

let docs = 0
let methods = 0

class Peek {
  readonly dom = document.createElement('div')
  readonly head = document.createElement('div')
  readonly box = document.createElement('div')
  readonly zone: monaco.editor.IViewZone
  child?: MethodDoc
  zoneId = ''
  headH = PEEK_HEAD
  boxH = 24
  private seen?: ResizeObserver
  private readonly undo: monaco.IDisposable[] = []

  constructor(readonly owner: MethodDoc, readonly edge: FlowEdge, readonly path: Path, readonly line: number) {
    const callee = edge.node
    this.dom.className = `rp-peek${callee.diff ? ' changed' : ''}`
    this.dom.style.paddingLeft = `${PEEK_INDENT}px`
    this.dom.style.setProperty('--c', KIND_COLOR[callee.kind])
    this.head.className = 'rp-peek-head'
    this.dom.append(this.head, this.box)
    this.zone = { afterLineNumber: line, heightInPx: this.height(), domNode: this.dom, suppressMouseDown: true, ordinal: 1 }
    // The header can wrap on a narrow pane: its measured height, not a guess, decides how much room the peek takes.
    this.seen = new ResizeObserver(() => {
      const h = Math.ceil(this.head.getBoundingClientRect().height)
      if (h && h !== this.headH) {
        this.headH = h
        this.update()
      }
    })
    this.seen.observe(this.head)
  }

  /** What a peek's editor may take of the row: the owner's room for code (its width less the line numbers and the scrollbar), less the indent. */
  get innerW() {
    return Math.max(200, this.owner.contentWidth() - PEEK_INDENT - 4)
  }
  height() {
    return this.headH + this.boxH + PEEK_GAP
  }
  /** The zone takes the room the header and the body now need. */
  update() {
    const h = this.height()
    if (!this.zoneId || this.zone.heightInPx === h) return
    this.zone.heightInPx = h
    this.owner.editor.changeViewZones(a => a.layoutZone(this.zoneId))
  }
  /** The peek's editor takes its content's height, up to the cap. */
  fit() {
    // The zone is as wide as the editor's longest line unless told otherwise: it stays within what is on screen.
    this.dom.style.maxWidth = `${this.owner.contentWidth()}px`
    if (!this.child) return
    const h = Math.min(PEEK_MAX_H, this.child.editor.getContentHeight() + 4)
    this.box.style.width = `${this.innerW}px`
    this.box.style.height = `${h}px`
    this.child.setWidth(this.innerW)
    this.child.editor.layout({ width: this.innerW, height: h })
    this.boxH = h
    this.update()
  }
  /** Something to undo when the peek goes. */
  own(d: monaco.IDisposable) {
    this.undo.push(d)
  }
  dispose() {
    this.seen?.disconnect()
    this.undo.forEach(d => d.dispose())
    this.child?.dispose()
  }
}

class MethodDoc {
  readonly editor: monaco.editor.IStandaloneCodeEditor
  readonly peeks = new Map<Path, Peek>()
  readonly lineH: number
  private readonly cursor: monaco.editor.IEditorDecorationsCollection
  private readonly notes: monaco.editor.IEditorDecorationsCollection
  private readonly style = document.createElement('style')
  private readonly byLine = new Map<number, FlowEdge[]>()
  private readonly dels: Zone[] = []
  private readonly all: monaco.IDisposable[] = []
  readonly id = ++methods
  width: number

  constructor(readonly doc: ReadDoc, readonly node: FlowNode, readonly path: Path, into: HTMLElement, width: number, readonly depth: number, readonly via?: Peek) {
    const top = depth === 0
    this.width = width
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
    this.editor = ed
    this.lineH = ed.getOption(monaco.editor.EditorOption.lineHeight)
    this.cursor = ed.createDecorationsCollection()
    this.notes = ed.createDecorationsCollection()
    this.all.push(ed)
    const model = ed.getModel()!
    const at = (fileLine: number) => fileLine - node.startLine + 1

    // A change in place: added lines tinted with a + in the margin, removed lines in a zone under the line they followed.
    const marks: monaco.editor.IModelDeltaDecoration[] = []
    for (const no of node.diff?.added ?? []) {
      const l = at(no)
      if (l >= 1 && l <= model.getLineCount()) marks.push({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rp-add', linesDecorationsClassName: 'rp-add-sign' } })
    }
    ed.createDecorationsCollection(marks)
    ed.changeViewZones(zones => {
      node.diff?.removed.forEach((r, i) => {
        const dom = document.createElement('div')
        dom.className = 'rp-del'
        for (const text of r.lines) {
          const row = document.createElement('div')
          row.textContent = text.replace(/\t/g, '    ') || ' '
          dom.appendChild(row)
        }
        const height = r.lines.length * this.lineH
        const after = Math.max(0, at(r.after))
        this.dels.push({ id: `del${i}`, after, kind: 'del', height })
        zones.addZone({ afterLineNumber: after, heightInPx: height, domNode: dom, ordinal: 0 })
      })
    })

    if (doc.view.downward) for (const e of node.children) this.byLine.set(e.callLine, [...(this.byLine.get(e.callLine) ?? []), e])
    // Each call line says where it goes, hanging off its end so it never covers the code. CSS content on a class per line: this
    // Monaco build drew no injected text, and the class is also how a click on the note is found. The open or closed mark is a
    // second class (see refreshNotes), so opening a peek changes no stylesheet.
    const css: string[] = []
    for (const [line, es] of this.byLine) {
      const l = at(line)
      if (l < 1 || l > model.getLineCount()) continue
      const name = `${splitLabel(es[0].node.label).member}${es.length > 1 ? ` +${es.length - 1}` : ''}`
      css.push(`.${this.noteClass(line)}::before, .${this.noteClass(line)}::after { color: ${KIND_COLOR[es[0].node.kind]}; }`, `.${this.noteClass(line)}::after { content: ${JSON.stringify(name)}; }`)
    }
    this.style.textContent = css.join('\n')
    document.head.appendChild(this.style)
    this.refreshNotes()

    this.all.push(
      ed.onMouseDown(e => {
        const line = e.target.position?.lineNumber
        if (!line) return
        const fileLine = line + node.startLine - 1
        const onNote = (e.event.browserEvent.target as HTMLElement | null)?.closest?.('.rp-call-note')
        const pos: Pos = { path, line: fileLine, k: 0 }
        if (!onNote || !this.byLine.has(fileLine)) return doc.view.hooks.moveTo(pos)
        doc.view.hooks.note(pos, e.event.ctrlKey || e.event.metaKey)
      }),
    )
    if (!top) ed.layout({ width, height: ed.getContentHeight() })
  }

  private noteClass(line: number) {
    return `rp-note-${this.doc.id}-${this.id}-${line}`
  }

  /** The call lines and their notes: a ▸ or ▾ by whether the call's peek is open, a mark in the gutter where the callee changed. */
  refreshNotes() {
    const model = this.editor.getModel()!
    const marks: monaco.editor.IModelDeltaDecoration[] = []
    for (const [line, es] of this.byLine) {
      const l = line - this.node.startLine + 1
      if (l < 1 || l > model.getLineCount()) continue
      const open = es.some(e => this.peeks.has(this.doc.view.idx.child(this.path, e)))
      const end = model.getLineMaxColumn(l)
      marks.push({ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rp-call-line', linesDecorationsClassName: es.some(e => e.node.diff) ? 'rp-chg-sign' : undefined } })
      marks.push({ range: new monaco.Range(l, end, l, end), options: { afterContentClassName: `rp-call-note ${open ? 'rp-open' : 'rp-closed'} ${this.noteClass(line)}` } })
    }
    this.notes.set(marks)
  }

  /** The room for code in this editor's rows: its width less the line numbers and the scrollbar. */
  contentWidth() {
    return Math.max(0, this.width - this.editor.getLayoutInfo().contentLeft - (this.depth === 0 ? 10 : 6))
  }

  setWidth(w: number) {
    if (w === this.width) return
    this.width = w
    for (const p of this.peeks.values()) p.fit()
  }

  /** Every zone of this editor, in the order they stack. */
  zoneList(): Zone[] {
    const peeks = [...this.peeks.values()].sort((a, b) => a.line - b.line || this.node.children.indexOf(a.edge) - this.node.children.indexOf(b.edge))
    return [...this.dels, ...peeks.map(p => ({ id: p.path, after: p.line - this.node.startLine + 1, kind: 'peek' as const, height: p.height() }))]
  }

  /** Top of this editor's first line in the pane's scrolling document. */
  offset(): number {
    const v = this.via
    if (!v) return 0
    const own = zoneTops(v.owner.zoneList(), v.owner.lineH, PAD_TOP).find(z => z.id === v.path)
    return v.owner.offset() + (own?.top ?? 0) + v.headH
  }

  addPeek(edge: FlowEdge) {
    const path = this.doc.view.idx.child(this.path, edge)
    const l = edge.callLine - this.node.startLine + 1
    if (this.peeks.has(path) || l < 1 || l > this.editor.getModel()!.getLineCount()) return
    const peek = new Peek(this, edge, path, l)
    const callee = edge.node
    this.fillHead(peek)
    if (callee.code) {
      peek.child = new MethodDoc(this.doc, callee, path, peek.box, peek.innerW, this.depth + 1, peek)
      this.doc.docs.set(path, peek.child)
      peek.own(peek.child.editor.onDidContentSizeChange(() => peek.fit()))
      peek.fit()
    } else {
      const body = tableBody(callee)
      peek.box.appendChild(body)
      // A table's rows or a note: the box is as tall as what is in it, measured.
      const seen = new ResizeObserver(() => {
        const h = Math.ceil(body.getBoundingClientRect().height)
        if (h && h !== peek.boxH) {
          peek.boxH = h
          peek.update()
        }
      })
      seen.observe(body)
      peek.own({ dispose: () => seen.disconnect() })
      peek.boxH = body.getBoundingClientRect().height || 24
      peek.fit()
    }
    peek.zone.heightInPx = peek.height()
    this.peeks.set(path, peek)
    this.editor.changeViewZones(a => {
      peek.zoneId = a.addZone(peek.zone)
    })
    this.reorder()
    this.refreshNotes()
  }

  removePeek(path: Path) {
    const peek = this.peeks.get(path)
    if (!peek) return
    this.peeks.delete(path)
    // Everything inside goes with it.
    for (const p of [...this.doc.docs.keys()]) if (within(p, path)) this.doc.docs.delete(p)
    peek.dispose()
    this.editor.changeViewZones(a => a.removeZone(peek.zoneId))
    this.reorder()
    this.refreshNotes()
  }

  /** Zones below one line stack in the order of the calls on it: the ordinal is Monaco's tiebreaker. */
  private reorder() {
    const placed = zoneTops(this.zoneList(), this.lineH, PAD_TOP)
    const changed: Peek[] = []
    for (const z of placed) {
      const p = this.peeks.get(z.id)
      if (p && p.zone.ordinal !== z.ordinal + 1) {
        p.zone.ordinal = z.ordinal + 1
        changed.push(p)
      }
    }
    if (changed.length) this.editor.changeViewZones(a => changed.forEach(p => a.layoutZone(p.zoneId)))
  }

  /** A peek's header: where the call goes, the values it passes, the service border it crosses, and the review buttons for a change. */
  fillHead(peek: Peek) {
    const { edge, path } = peek
    const callee = edge.node
    const caller = this.node
    const view = this.doc.view
    const kids: HTMLElement[] = []
    const el = (tag: string, cls: string, text?: string) => {
      const e = document.createElement(tag)
      e.className = cls
      if (text !== undefined) e.textContent = text
      return e
    }
    kids.push(el('span', 'rp-peek-name', splitLabel(callee.label).member))
    const line = caller.code?.replace(/\r/g, '').split('\n')[edge.callLine - caller.startLine]?.trim() ?? ''
    const b = edge.edgeKind === 'call' ? bindings(line, callee) : []
    if (b.length) kids.push(el('span', 'rp-bound', `(${b.map(x => (x.param === x.arg ? x.param : `${x.param} ← ${x.arg}`)).join(', ')})`))
    const hopText = crossing(edge.edgeKind, caller, callee, view.base)
    const where = el('span', `rp-peek-where${hopText ? ' hop' : ''}`, hopText ?? (callee.file ? `${callee.file.split(/[\\/]/).pop()}:${callee.startLine}` : callee.sub))
    where.title = where.textContent ?? ''
    kids.push(where)
    const tools = el('span', 'rp-peek-tools')
    const button = (text: string, title: string, run: () => void, cls = 'tool', pressed?: boolean) => {
      const btn = el('button', cls, text) as HTMLButtonElement
      btn.title = title
      btn.setAttribute('aria-label', title)
      if (pressed !== undefined) btn.setAttribute('aria-pressed', String(pressed))
      btn.onclick = run
      tools.appendChild(btn)
    }
    if (callee.diff) {
      const stat = el('span', 'rp-stat')
      stat.innerHTML = `<b class="plus">+${callee.diff.plus}</b> <b class="minus">−${callee.diff.minus}</b>`
      tools.appendChild(stat)
      const r = view.review(path)
      button('Viewed', `Mark ${callee.label} as viewed (shared with the Changes rail)`, () => view.hooks.viewed(path), r.viewed ? 'btn solid on' : 'btn ghost', r.viewed)
      if (r.undoable) button('Undo', `Undo the change to ${callee.label}`, () => view.hooks.undo(path), 'btn ghost')
      if (r.keepable) button('Keep', `Keep the change to ${callee.label}`, () => view.hooks.keep(path), 'btn solid')
    }
    button('Read ↗', 'Read this method at the top of the pane', () => view.hooks.read(path))
    button('✕', 'Close the peek', () => view.hooks.closePeek(path))
    kids.push(tools)
    peek.head.replaceChildren(...kids)
  }

  refreshHeads() {
    for (const p of this.peeks.values()) {
      this.fillHead(p)
      p.child?.refreshHeads()
    }
  }

  setCursor(pos: Pos | null) {
    this.cursor.clear()
    if (!pos) return
    const l = pos.line - this.node.startLine + 1
    if (l < 1 || l > this.editor.getModel()!.getLineCount()) return
    this.cursor.set([{ range: new monaco.Range(l, 1, l, 1), options: { isWholeLine: true, className: 'rp-cur', linesDecorationsClassName: 'rp-cur-mark' } }])
  }

  dispose() {
    for (const p of this.peeks.values()) p.dispose()
    this.peeks.clear()
    this.style.remove()
    this.all.reverse().forEach(d => d.dispose())
  }
}

/** The pane's document. One per method at the top; peeks are added to and removed from it. */
export class ReadDoc {
  readonly id = ++docs
  readonly docs = new Map<Path, MethodDoc>()
  readonly root: MethodDoc
  readonly view: DocView
  private readonly seen: ResizeObserver

  constructor(host: HTMLElement, node: FlowNode, path: Path, v: DocView) {
    this.view = v
    this.root = new MethodDoc(this, node, path, host, host.clientWidth || 600, 0)
    this.docs.set(path, this.root)
    // Peeks follow the pane's width: its editors are sized by hand.
    this.seen = new ResizeObserver(() => this.root.setWidth(host.clientWidth || this.root.width))
    this.seen.observe(host)
  }

  /** Opens and closes peeks to match `open`: only the ones that changed. Parents are made before their children. */
  sync(open: readonly Path[]) {
    const want = new Set(open)
    for (const doc of [...this.docs.values()]) for (const p of [...doc.peeks.keys()]) if (!want.has(p)) doc.removePeek(p)
    const opened = (p: Path) => [...this.docs.values()].some(d => d.peeks.has(p))
    for (const p of [...open].sort((a, b) => pathDepth(a) - pathDepth(b))) {
      if (opened(p)) continue
      const up = this.view.idx.parent(p)
      const owner = up && this.docs.get(up.path)
      if (owner) owner.addPeek(up.edge)
    }
  }

  refreshHeads() {
    this.root.refreshHeads()
  }

  /** Marks the cursor's line in whichever editor holds it, and brings it into view in the pane. */
  setCursor(pos: Pos | null) {
    this.docs.forEach(d => d.setCursor(null))
    const d = pos && this.docs.get(pos.path)
    if (!pos || !d) return
    d.setCursor(pos)
    const l = pos.line - d.node.startLine + 1
    if (d.depth > 0) d.editor.revealLineInCenterIfOutsideViewport(l)
    const ed = this.root.editor
    const y = d.offset() + (d.depth > 0 ? Math.max(0, lineTop(d.zoneList(), l, d.lineH, PAD_TOP) - d.editor.getScrollTop()) : lineTop(d.zoneList(), l, d.lineH, PAD_TOP))
    const height = ed.getLayoutInfo().height
    const top = ed.getScrollTop()
    if (y < top + 20 || y > top + height - 80) ed.setScrollTop(Math.max(0, y - height / 3))
  }

  get scrollTop() {
    return this.root.editor.getScrollTop()
  }
  set scrollTop(v: number) {
    this.root.editor.setScrollTop(v)
  }

  dispose() {
    this.seen.disconnect()
    this.root.dispose()
    this.docs.clear()
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
