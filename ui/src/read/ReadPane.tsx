// The reading pane beside the canvas: one method at a time in a read-only Monaco, the line that called it above, its calls to step
// into, and back/forward. The canvas keeps the shape of the flow; this is where its code is read. A changed method shows as a diff.
import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import { KindGlyph, langOf, splitLabel, useColorized } from '../nodes'
import { KIND_COLOR } from '../layout'
import type { FlowNode } from '../types'

export interface PaneCall {
  key: string
  line: number
  node: FlowNode
}

interface Props {
  node: FlowNode
  /** The method that called this one and the line it called from; none for the start of the flow. */
  caller: { node: FlowNode; line: number } | null
  calls: PaneCall[]
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  onEnter: (key: string) => void
  onCaller: () => void
  onOpen: (line?: number) => void
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
  folding: true,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: 'none',
  overviewRulerLanes: 0,
  lineNumbersMinChars: 4,
  contextmenu: false,
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, alwaysConsumeMouseWheel: false },
  padding: { top: 8, bottom: 8 },
}

export function ReadPane({ node, caller, calls, canBack, canForward, onBack, onForward, onEnter, onCaller, onOpen, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const enter = useRef(onEnter)
  enter.current = onEnter
  const { owner, member } = splitLabel(node.label)
  const file = node.file?.split(/[\\/]/).pop()
  const callerLine = caller?.node.code?.replace(/\r/g, '').split('\n')[caller.line - caller.node.startLine]?.trim() ?? ''
  const callerHtml = useColorized(callerLine, langOf(caller?.node.file))

  useEffect(() => {
    const el = host.current
    if (!el || node.code == null) return
    const lang = langOf(node.file)
    const lineNumbers = (n: number) => String(n + node.startLine - 1)
    if (node.diff) {
      // A change reads as a diff in one column: the pane is narrower than a side-by-side diff needs.
      const original = monaco.editor.createModel(originalOf(node), lang)
      const modified = monaco.editor.createModel(node.code, lang)
      const diff = monaco.editor.createDiffEditor(el, { ...READ_ONLY, ...editorFont(), renderSideBySide: false, originalEditable: false, renderOverviewRuler: false, lineNumbers })
      diff.setModel({ original, modified })
      return () => {
        diff.dispose()
        original.dispose()
        modified.dispose()
      }
    }
    const ed = monaco.editor.create(el, { ...READ_ONLY, ...editorFont(), value: node.code, language: lang, lineNumbers })
    // Each call line says where it goes, at its end; a click on that note steps into the callee.
    const byLine = new Map<number, PaneCall[]>()
    calls.forEach(c => byLine.set(c.line, [...(byLine.get(c.line) ?? []), c]))
    const model = ed.getModel()!
    // The note hangs off the end of the line, so it never covers the code. It is CSS content on a class per line: this Monaco build
    // drew no injected text (`after`), and a class is also what a click on the note is found by.
    const css: string[] = []
    const notes = [...byLine].flatMap(([line, cs]) => {
      const at = line - node.startLine + 1
      if (at < 1 || at > model.getLineCount()) return []
      const end = model.getLineMaxColumn(at)
      const text = `→ ${splitLabel(cs[0].node.label).member}${cs.length > 1 ? ` +${cs.length - 1}` : ''}`
      css.push(`.rp-note-${line}::after { content: ${JSON.stringify(text)}; }`)
      return [
        { range: new monaco.Range(at, 1, at, 1), options: { isWholeLine: true, className: 'rp-call-line' } },
        { range: new monaco.Range(at, end, at, end), options: { afterContentClassName: `rp-call-note rp-note-${line}` } },
      ]
    })
    const style = document.createElement('style')
    style.textContent = css.join('\n')
    document.head.appendChild(style)
    const decorations = ed.createDecorationsCollection(notes)
    const down = ed.onMouseDown(e => {
      const line = e.target.position?.lineNumber
      // The note is injected text, which Monaco's public API does not name: it is found by its class on the clicked element.
      const onNote = (e.event.browserEvent.target as HTMLElement | null)?.closest?.('.rp-call-note')
      if (!line || !onNote) return
      const hit = byLine.get(line + node.startLine - 1)
      if (hit) enter.current(hit[0].key)
    })
    return () => {
      down.dispose()
      style.remove()
      decorations.clear()
      ed.dispose()
    }
  }, [node, calls])

  return (
    <section className="rp" aria-label={`Reading ${node.label}`}>
      <header className="rp-head">
        <div className="rp-nav">
          <button className="tool" onClick={onBack} disabled={!canBack} title="Back (Alt+←)" aria-label="Back">←</button>
          <button className="tool" onClick={onForward} disabled={!canForward} title="Forward (Alt+→)" aria-label="Forward">→</button>
        </div>
        <KindGlyph kind={node.kind} />
        <div className="rp-title" title={node.label}>
          {owner && <span className="owner">{owner}.</span>}
          <span className="member">{member}</span>
        </div>
        <span className="rp-file">{file ? `${file}:${node.startLine}` : node.sub}</span>
        <span className="wv-spacer" />
        {node.file && <button className="tool" onClick={() => onOpen()} title="Open in the editor">Open in file ↗</button>}
        <button className="tool" onClick={onClose} title="Close the reading pane" aria-label="Close the reading pane">✕</button>
      </header>
      {caller && callerLine && (
        <button className="rp-caller" onClick={onCaller} title={`Back to ${caller.node.label}`}>
          <span className="rp-caller-name">{splitLabel(caller.node.label).member}:{caller.line}</span>
          {callerHtml ? <span className="rp-caller-src" dangerouslySetInnerHTML={{ __html: callerHtml[0] ?? '' }} /> : <span className="rp-caller-src">{callerLine}</span>}
        </button>
      )}
      {node.code != null ? <div className="rp-editor" ref={host} /> : <p className="rp-empty">{node.schema ? `Table ${node.schema.table}: its columns are on the card.` : 'No source for this card.'}</p>}
      {calls.length > 0 && (
        <nav className="rp-calls" aria-label="Calls in this method">
          {calls.map(c => (
            <button key={c.key} className="rp-call" style={{ ['--c' as string]: KIND_COLOR[c.node.kind] }} onClick={() => onEnter(c.key)}>
              <span className="rp-call-line-no">{c.line}</span>
              <span>{splitLabel(c.node.label).member}</span>
            </button>
          ))}
        </nav>
      )}
    </section>
  )
}
