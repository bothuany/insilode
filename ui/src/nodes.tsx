import { memo, useContext, useEffect, useRef, useState, createContext, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import { Handle, Position, useStore, type NodeProps, type Node } from '@xyflow/react'
import * as monaco from 'monaco-editor'
import { CODE_PAD, HEADER_H, KIND_COLOR, LINE_H, SCHEMA_MAX, SCHEMA_OPS_H, SCHEMA_ROW, type CardData, type FrameData } from './layout'
import { chipList, linkOf, ROW_H, STRIP_H, type CardChips, type ChipRow, type TypeLink } from './chips'
import { bindEditor, hoverCode, leaveCode, wordAtPoint } from './ide'
import { cardLabel, cutNote } from './impact/cardLabel'
import type { DbSchema, FlowNode, Kind } from './types'

/** Where a click on a card's code landed, in file coordinates (1-based), so editing starts right there. */
export interface Caret {
  line: number
  column: number
}

export interface CanvasActions {
  toggle: (childKey: string) => void
  toggleAll: (nodeKey: string) => void
  open: (nodeKey: string) => void
  toggleFull: (nodeKey: string) => void
  /** Inline editing on the card (VS Code webview). Absent in hosts that edit elsewhere. */
  edit?: (nodeKey: string, caret?: Caret) => void
  /** `session`: the editor that holds `code`, so the host can use the text it already showed the language servers. */
  save?: (nodeKey: string, code: string, session?: string) => Promise<string | undefined>
  cancelEdit?: () => void
  /** Show the method in the editor without leaving the canvas. */
  reveal?: (nodeKey: string) => void
  keep?: (nodeKey: string) => void
  undo?: (nodeKey: string) => void
  /** Zoomed out: bring this line to a readable size instead of editing it straight away. */
  focusLine?: (nodeKey: string, line: number) => void
  /** A call line is hovered: light the wire from `source` to `target` (null clears). */
  trace?: (source: string | null, target?: string) => void
  /** Hooks set to run after every agent edit in this workspace (shown on the review bar). */
  editHooks?: string[]
  /** Put this method into the prompt of a connected Claude Code terminal. */
  mention?: (nodeKey: string) => void
  /** Point at this card and ask the agent about it (the lines selected in it, else the whole method). */
  ask?: (nodeKey: string) => void
  /** Ctrl/Cmd+click on a symbol of a card that is only read: go to where it is defined (file position, 1-based). */
  definition?: (nodeKey: string, at: Caret) => void
  /** Type chips: open or close the fields under a chip (`path` names the chip in its card, see chips.ts). */
  chipToggle?: (nodeKey: string, path: string, typeId: string) => void
  /** Go to where a type is declared (file position, 1-based). */
  openType?: (file: string, line: number) => void
  /** Show a type in the DTO diagram. Absent when the editor has no such diagram. */
  typeDiagram?: (typeId: string) => void
  /** Where editing should put the cursor (set by `edit`). */
  caret?: Caret
}
export const ActionsCtx = createContext<CanvasActions>({ toggle() {}, toggleAll() {}, open() {}, toggleFull() {} })

export const LANG_BY_EXT: Record<string, string> = {
  cs: 'csharp', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  java: 'java', kt: 'kotlin', kts: 'kotlin', py: 'python', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', swift: 'swift', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'cpp', c: 'c',
  scala: 'scala', groovy: 'java', gradle: 'java', sql: 'sql', vb: 'vb', fs: 'fsharp', dart: 'dart', lua: 'lua', sh: 'shell', ps1: 'powershell',
  json: 'json', yml: 'yaml', yaml: 'yaml', xml: 'xml', html: 'html', css: 'css', scss: 'scss',
}
export function langOf(file: string | null | undefined) {
  return LANG_BY_EXT[file?.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext'
}

const KIND_NAME: Record<Kind, string> = {
  controller: 'entry point',
  handler: 'handler',
  method: 'method',
  db: 'database',
  ambiguous: 'several implementations',
  external: 'outside this workspace',
}

/** One shape per kind, so kinds stay readable without colour: ▶ entry, ◆ handler, ● method, cylinder db. */
function KindGlyph({ kind }: { kind: Kind }) {
  const c = KIND_COLOR[kind]
  const shape = {
    controller: <path d="M3 1.5 L10 6 L3 10.5 Z" fill={c} />,
    handler: <path d="M6 1 L11 6 L6 11 L1 6 Z" fill={c} />,
    method: <circle cx="6" cy="6" r="3.6" fill={c} />,
    db: (
      <g fill="none" stroke={c} strokeWidth="1.4">
        <ellipse cx="6" cy="3" rx="4" ry="1.6" fill={c} />
        <path d="M2 3 V9 C2 10.9 10 10.9 10 9 V3" />
      </g>
    ),
    ambiguous: <path d="M6 1.5 L10.5 6 L6 10.5 L1.5 6 Z" fill="none" stroke={c} strokeWidth="1.4" strokeDasharray="2 1.5" />,
    external: <circle cx="6" cy="6" r="3.6" fill="none" stroke={c} strokeWidth="1.4" />,
  }[kind]
  return (
    <svg className="glyph" width="12" height="12" viewBox="0 0 12 12" role="img" aria-label={KIND_NAME[kind]}>
      <title>{KIND_NAME[kind]}</title>
      {shape}
    </svg>
  )
}

/** "Orders.Service.Get" → owner "Orders.Service", member "Get": the member is what you read first. */
/** What a changed database card says after its entity: "· entity changed · migration 0007: adds key, drops legacy_ref". */
function changeNote(change: NonNullable<FlowNode['tableChange']> | undefined) {
  if (!change) return ''
  return `${change.entity ? ' · entity changed' : ''}${(change.migration ?? []).map(m => ` · migration ${m.name}: ${m.summary}`).join('')}`
}

function splitLabel(label: string) {
  const clean = label.replace(/\s*▸\s*/g, '.')
  const at = clean.lastIndexOf('.')
  return at > 0 ? { owner: clean.slice(0, at), member: clean.slice(at + 1) } : { owner: '', member: clean }
}

/**
 * Edits discarded with Esc or Discard, by card (file and first line), kept while the canvas lives: one Esc discards at
 * once, and opening the same card again offers them back, so a stray Esc costs a click instead of the work.
 */
const discarded = new Map<string, { code: string; text: string }>()

/** Monaco on the card. Lives in a fixed-zoom canvas (see webview) so clicks land where they look. */
function CardEditor({ nodeKey, code, file, startLine, endLine, caret, onSave, onCancel }: { nodeKey: string; code: string; file: string | null; startLine: number; endLine: number; caret?: Caret; onSave: (text: string, session: string) => Promise<string | undefined>; onCancel: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const editor = useRef<monaco.editor.IStandaloneCodeEditor>(undefined)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const keptKey = `${file}:${startLine}`
  // Only what was discarded from this same text: after a save or an outside change the old edit no longer applies.
  const [kept, setKept] = useState(() => (discarded.get(keptKey)?.code === code ? discarded.get(keptKey)!.text : undefined))
  const inFlight = useRef(false)
  // One id per opening of this editor: the host shows the card's text to the language servers under it, and puts the file back when it closes.
  const session = useRef(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).current
  const save = async () => {
    const ed = editor.current
    // One save at a time: a second Ctrl+S while the first is in flight would send the same original and fail.
    if (!ed || inFlight.current) return
    if (ed.getValue() === code) return onCancel()
    inFlight.current = true
    setSaving(true)
    try {
      const failed = await onSave(ed.getValue(), session)
      if (!failed) discarded.delete(keptKey)
      setError(failed)
    } catch (e) {
      // The host rejected the request (a failed write): say so instead of leaving "Saving…" on the button.
      setError(String((e as Error).message ?? e))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save
  const discard = () => {
    const text = editor.current?.getValue()
    if (text !== undefined && text !== code) discarded.set(keptKey, { code, text })
    onCancel()
  }
  const discardRef = useRef(discard)
  discardRef.current = discard
  const restore = () => {
    if (kept === undefined) return
    editor.current?.setValue(kept)
    editor.current?.focus()
    discarded.delete(keptKey)
    setKept(undefined)
  }

  useEffect(() => {
    // Suggestion, hover and parameter popups live outside the card: it is inside a transformed canvas, where fixed positions would be off.
    const overflow = document.createElement('div')
    overflow.className = `monaco-editor flow-overflow ${window.__FLOW__.dark ? 'vs-dark' : 'vs'}`
    document.body.appendChild(overflow)
    const ed = (editor.current = monaco.editor.create(host.current!, {
      value: code,
      language: langOf(file),
      minimap: { enabled: false },
      fontSize: 12,
      lineHeight: LINE_H,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--fl-mono') || undefined,
      lineNumbers: n => String(n + startLine - 1),
      lineNumbersMinChars: 4,
      glyphMargin: false,
      folding: false,
      scrollBeyondLastLine: false,
      automaticLayout: true,
      renderLineHighlight: 'line',
      overviewRulerLanes: 0,
      scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6 },
      padding: { top: CODE_PAD },
      // The host's answers (see ide.ts) with the words of the card under them: words are shown (showWords), and ide.ts merges them in
      // itself, because Monaco's own word provider only answers when nothing else does.
      quickSuggestions: { other: true, comments: false, strings: true },
      suggestOnTriggerCharacters: true,
      parameterHints: { enabled: true, cycle: true },
      acceptSuggestionOnEnter: 'smart',
      acceptSuggestionOnCommitCharacter: true,
      wordBasedSuggestions: 'currentDocument',
      snippetSuggestions: 'inline',
      suggest: { showIcons: true, showWords: true, preview: true },
      autoClosingBrackets: 'languageDefined',
      autoClosingQuotes: 'languageDefined',
      autoSurround: 'languageDefined',
      autoIndent: 'full',
      formatOnType: false,
      formatOnPaste: false,
      multiCursorModifier: 'alt',
      hover: { enabled: 'on' },
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflow,
    }))
    const unbind = bindEditor(ed, { session, key: nodeKey, file: file!, startLine, endLine, original: code })
    ed.onDidChangeModelContent(() => setDirty(ed.getValue() !== code))
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    // Esc leaves at once, discarding changes (kept, see `discarded`). Not while a suggest or find widget is open:
    // Esc closes that widget first.
    ed.addCommand(monaco.KeyCode.Escape, () => discardRef.current(), '!suggestWidgetVisible && !findWidgetVisible')
    if (caret) {
      const pos = { lineNumber: Math.max(1, caret.line - startLine + 1), column: caret.column }
      ed.setPosition(pos)
      ed.revealPositionInCenterIfOutsideViewport(pos)
    }
    // The click that opened the editor is still being handled by the canvas; take focus after it settles.
    ed.focus()
    const timers = [setTimeout(() => ed.focus(), 30), setTimeout(() => ed.focus(), 260)]
    return () => {
      timers.forEach(clearTimeout)
      unbind()
      ed.dispose()
      overflow.remove()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card-editor nodrag nowheel nopan">
      <div ref={host} className="card-editor-host" />
      <div className="card-editor-bar">
        {error ? (
          <span className="card-editor-msg err" title={error}>{error}</span>
        ) : kept !== undefined && !dirty ? (
          <>
            <span className="card-editor-msg warn" title="The edit you discarded here last time">Discarded edit kept</span>
            <button className="btn ghost" onClick={restore}>Restore</button>
          </>
        ) : (
          <span className="card-editor-msg hint">
            <kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S'}</kbd> save <kbd>Esc</kbd> {dirty ? 'discard' : 'close'}
          </span>
        )}
        <button className="btn ghost" onClick={discard}>{dirty ? 'Discard' : 'Close'}</button>
        <button className="btn solid" disabled={saving || !dirty} onClick={() => saveRef.current()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/** Operators that only shape a query and say nothing about what it does. */
const QUIET_OPS = new Set(['ConfigureAwait', 'AsQueryable', 'AsEnumerable'])

/**
 * A table as the query sees it: what the query does (its operators, in the order they run; reads in
 * teal, writes in coral), then the columns — key first, Oracle column names, type, nullability and
 * length — and the relations the entity can navigate.
 */
function SchemaBody({ schema, change }: { schema: DbSchema; change?: FlowNode['tableChange'] }) {
  // A migration marks the columns it drops (struck through) and the ones it adds (+), where the entity still has them.
  const names = (pick: 'added' | 'dropped') => new Set((change?.migration ?? []).flatMap(m => m[pick]).map(n => n.toLowerCase()))
  const added = names('added')
  const dropped = names('dropped')
  const ops = schema.ops.filter(o => !QUIET_OPS.has(o))
  const cols = schema.columns.slice(0, SCHEMA_MAX)
  const more = schema.columns.length - cols.length
  return (
    <div className="schema">
      <div className="schema-ops" style={{ height: SCHEMA_OPS_H }}>
        <span className={`schema-verb ${schema.writes ? 'write' : 'read'}`}>{schema.writes ? 'writes' : 'reads'}</span>
        <span className="schema-chain" title={schema.ops.join(' → ')}>{ops.join(' → ') || 'whole table'}</span>
      </div>
      {cols.map(c => (
        <div key={c.name} className={`schema-col${c.key ? ' key' : ''}${dropped.has(c.column.toLowerCase()) || dropped.has(c.name.toLowerCase()) ? ' dropped' : ''}${added.has(c.column.toLowerCase()) || added.has(c.name.toLowerCase()) ? ' added' : ''}`} style={{ height: SCHEMA_ROW }} title={c.column !== c.name ? `${c.name} → ${c.column}` : c.name}>
          <span className="schema-mark">{c.key ? 'PK' : added.has(c.column.toLowerCase()) ? '+' : ''}</span>
          <span className="schema-name">{c.column}</span>
          <span className="schema-type">{c.type}{c.nullable ? '?' : ''}{c.maxLength ? `(${c.maxLength})` : ''}</span>
        </div>
      ))}
      {more > 0 && <div className="schema-more" style={{ height: SCHEMA_ROW }}>{more} more columns</div>}
      {schema.relations.length > 0 && (
        <div className="schema-rel" title={schema.relations.join(', ')}>
          {schema.relations.map(r => {
            const [kind, name] = r.split(' ')
            return <span key={r}><i>{kind === 'many' ? '∗' : '1'}</i>{name}</span>
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Monaco's colorizer gives one HTML fragment per line; cached by language and text so re-layouts are cheap. A theme change
 * empties the cache (the token classes are per theme) and asks the cards to colour again (`recolor`).
 */
const colorCache = new Map<string, string[]>()
const recolorers = new Set<() => void>()
export function recolor(theme: string) {
  monaco.editor.setTheme(theme)
  colorCache.clear()
  recolorers.forEach(f => f())
}
export function useColorized(text: string, lang: string) {
  const key = `${lang} ${text}`
  const [version, setVersion] = useState(0)
  const [done, setDone] = useState<{ key: string; lines: string[] } | null>(() => (colorCache.has(key) ? { key, lines: colorCache.get(key)! } : null))
  useEffect(() => {
    const again = () => setVersion(v => v + 1)
    recolorers.add(again)
    return () => void recolorers.delete(again)
  }, [])
  useEffect(() => {
    if (colorCache.has(key)) return setDone({ key, lines: colorCache.get(key)! })
    let live = true
    monaco.editor.colorize(text, lang, { tabSize: 4 }).then(
      out => {
        const lines = out.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '').split('<br/>')
        colorCache.set(key, lines)
        if (live) setDone({ key, lines })
      },
      // A language Monaco cannot load leaves the plain text: never an unhandled rejection.
      () => {},
    )
    return () => {
      live = false
    }
  }, [key, version]) // eslint-disable-line react-hooks/exhaustive-deps
  // Colours made for other text (the card just changed, the colouring is on its way) are not applied to these lines: the cached ones are, at once.
  return colorCache.get(key) ?? (done?.key === key ? done.lines : null)
}

/** Character offset of a click inside a (colorized) line, counting text across its spans. */
function clickOffset(src: HTMLElement, e: MouseEvent) {
  const doc = document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
  const range = doc.caretRangeFromPoint?.(e.clientX, e.clientY)
  if (!range || !src.contains(range.startContainer)) return src.textContent?.length ?? 0
  return offsetIn(src, range.startContainer, range.startOffset)
}

/** The DOM's Node (`Node` here is the canvas library's). */
type DomNode = InstanceType<typeof globalThis.Node>

/** Offset of a point (a text node and a position in it) counted over all the text in `src`. */
function offsetIn(src: HTMLElement, container: DomNode, at: number) {
  let offset = 0
  const walker = document.createTreeWalker(src, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === container) return offset + at
    offset += n.textContent?.length ?? 0
  }
  return offset
}

/** A column (0-based) in a line whose tabs were shown as four spaces, as a column in the line as it is in the file (1-based). */
function fileColumn(original: string, shown: number) {
  let seen = 0
  let i = 0
  for (; i < original.length && seen < shown; i++) seen += original[i] === '\t' ? 4 : 1
  return i + 1
}

const MARK = { one: '', many: '[]', optional: '?' }
const typeClass = (t: TypeLink) => (t.kind === 'enum' || t.role === 'enum' ? 'enum' : t.role === 'entity' ? 'entity' : t.role === 'dto' ? 'dto' : 'other')

/** A type of the workspace: click to open its fields under the card, Ctrl/Cmd+click (or ↗) to go to it, ◫ to see it in the DTO diagram. */
function TypeChip({ type, mark = '', title, open, expandable, still, onToggle }: { type: TypeLink; mark?: string; title: string; open: boolean; expandable: boolean; still: (e: MouseEvent) => boolean; onToggle: () => void }) {
  const actions = useContext(ActionsCtx)
  const go = (e: MouseEvent) => {
    e.stopPropagation()
    if (still(e)) actions.openType?.(type.file, type.line)
  }
  return (
    <span className={`tc tc-${typeClass(type)}${open ? ' open' : ''}`}>
      <button
        className="tc-main nodrag"
        aria-expanded={expandable ? open : undefined}
        title={title}
        onClick={e => {
          e.stopPropagation()
          if (!still(e)) return
          if (e.ctrlKey || e.metaKey || !expandable) actions.openType?.(type.file, type.line)
          else onToggle()
        }}
      >
        {expandable && <i className="tc-caret">{open ? '▾' : '▸'}</i>}
        <span className="tc-name">{type.name}</span>
        {mark && <span className="tc-mark">{mark}</span>}
      </button>
      <span className="tc-acts nodrag">
        <button className="tc-act" title={`Go to ${type.name}`} aria-label={`Go to ${type.name}`} onClick={go}>↗</button>
        {actions.typeDiagram && (
          <button className="tc-act" title={`Show ${type.name} in the diagram`} aria-label={`Show ${type.name} in the diagram`} onClick={e => { e.stopPropagation(); actions.typeDiagram!(type.id) }}>◫</button>
        )}
      </span>
    </span>
  )
}

/** The workspace types of a method's signature under the card's header, and the fields of the ones that are opened. Below the zoom where text can be read it only keeps its room. */
function TypeChips({ nodeKey, chips, rows, open, height, zoomedOut, still }: { nodeKey: string; chips: CardChips; rows: ChipRow[]; open: ReadonlySet<string>; height: number; zoomedOut: boolean; still: (e: MouseEvent) => boolean }) {
  const actions = useContext(ActionsCtx)
  const toggle = (path: string, id: string) => actions.chipToggle?.(nodeKey, path, id)
  const hint = (name: string, ref: string) => `${name ? `${name}: ` : 'returns '}${ref}`
  return (
    <div className={`tc-block nodrag${rows.length ? ' with-rows' : ''}`} style={{ height }}>
      {!zoomedOut && (
        <>
          <div className="tc-strip" style={{ height: STRIP_H }}>
            {chipList(chips).map(({ path, item }) => (
              <span key={path} className="tc-slot">
                {path === 'r' && <span className="tc-arrow" aria-label="returns">→</span>}
                <TypeChip
                  type={linkOf(item)}
                  mark={MARK[item.collection]}
                  title={`${hint(item.name, item.ref)} (click to open its fields, Ctrl+click to go to it)`}
                  open={open.has(path)}
                  expandable
                  still={still}
                  onToggle={() => toggle(path, item.typeId)}
                />
              </span>
            ))}
          </div>
          {rows.map((r, i) => {
            if (r.kind === 'head')
              return (
                <div key={`h${r.path}`} className="tc-row tc-head" style={{ height: ROW_H }}>
                  <span className={`tc-dot tc-${typeClass(r.type)}`} />
                  <span className="tc-headname">{r.type.name}</span>
                  <span className="tc-faint">{r.type.role === r.type.kind ? r.type.kind : `${r.type.role} · ${r.type.kind}`}</span>
                  <span className="tc-space" />
                  <button className="tc-act on" title={`Go to ${r.type.name}`} aria-label={`Go to ${r.type.name}`} onClick={e => { e.stopPropagation(); if (still(e)) actions.openType?.(r.type.file, r.type.line) }}>↗</button>
                  {actions.typeDiagram && <button className="tc-act on" title={`Show ${r.type.name} in the diagram`} aria-label={`Show ${r.type.name} in the diagram`} onClick={e => { e.stopPropagation(); actions.typeDiagram!(r.type.id) }}>◫</button>}
                </div>
              )
            const pad = { height: ROW_H, paddingLeft: 12 + r.level * 12 }
            if (r.kind === 'const')
              return <div key={`c${i}`} className="tc-row" style={pad}><span className="tc-const">{r.name}</span></div>
            if (r.kind === 'note')
              return <div key={`n${i}`} className="tc-row tc-faint" style={pad}>{r.text}</div>
            if (r.kind === 'more')
              return (
                <div key={`m${i}`} className="tc-row" style={pad}>
                  <button className="tc-more" title={`Go to ${r.type.name}`} aria-label={`${r.count} more fields: go to ${r.type.name}`} onClick={e => { e.stopPropagation(); if (still(e)) actions.openType?.(r.type.file, r.type.line) }}>+{r.count} more</button>
                </div>
              )
            const f = r.field
            return (
              <div key={r.path} className="tc-row" style={pad}>
                <span className="tc-fname">{f.name}</span>
                {f.ref ? (
                  <>
                    <TypeChip
                      type={f.ref}
                      mark={MARK[f.card]}
                      title={`${f.name}: ${f.type}${r.cycle ? ' (already open above: click to go to it)' : r.limit ? ' (click to go to it)' : ' (click to open its fields, Ctrl+click to go to it)'}`}
                      open={r.open}
                      expandable={!r.cycle && !r.limit}
                      still={still}
                      onToggle={() => toggle(r.path, f.ref!.id)}
                    />
                    {r.cycle && <span className="tc-faint" title="This type is already open above">↻</span>}
                  </>
                ) : (
                  <span className="tc-ftype" title={f.type}>{f.type}</span>
                )}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

export const CardNode = memo(({ data }: NodeProps<Node<CardData>>) => {
  const { node, lines, rows, full, compactable, calls, selected, touched, editing, chips, chipRows, chipsOpen, chipsH } = data
  const actions = useContext(ActionsCtx)
  const color = KIND_COLOR[node.kind]
  const html = useColorized(lines.map(l => l.text).join('\n'), langOf(node.file))
  const callByLine = new Map<number, typeof calls>()
  for (const c of calls) callByLine.set(c.edge.callLine, [...(callByLine.get(c.edge.callLine) ?? []), c])
  const hiddenCount = calls.filter(c => c.hidden).length
  // A Windows host sends backslash paths: the card names the file either way, not the whole path.
  const file = node.file?.split(/[\\/]/).pop()
  const schema = node.schema
  // A database card is named after its table; the entity and context go underneath.
  const { owner, member } = schema ? { owner: schema.dbSchemaName ?? '', member: schema.table } : splitLabel(node.label)
  const rawLines = node.code?.replace(/\t/g, '    ').replace(/\r/g, '').split('\n') ?? []
  // A tour is read, not edited: the host of the canvas leaves `edit` out while one plays.
  const editable = !!(node.code && actions.edit)
  // Below this zoom the code is too small to aim at: the first click zooms in, the next one edits.
  const zoomedOut = useStore(st => st.transform[2] < 0.75)
  const changed = !!(touched || node.diff || node.tableChange)

  // A press that moved is a pan, not a click: only a still click starts editing.
  const press = useRef<{ x: number; y: number } | null>(null)
  const onDown = (e: PointerEvent) => (press.current = { x: e.clientX, y: e.clientY })
  const still = (e: MouseEvent) => !press.current || Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) < 4

  const fileLines = node.code?.replace(/\r/g, '').split('\n') ?? []
  const srcOf = (e: MouseEvent) => (e.currentTarget as HTMLElement).querySelector('.src') as HTMLElement | null
  /** Characters the card's dedenting took off this line (as shown: tabs are four spaces). */
  const indentOf = (no: number) => (rawLines[no - node.startLine]?.length ?? 0) - (lines[no - node.startLine]?.text.length ?? 0)
  const canGo = !!(node.file && node.code && actions.definition)

  // Ctrl/Cmd held: not editing but going to the definition of the identifier under the pointer.
  const definitionAt = (e: MouseEvent, no: number) => {
    const src = srcOf(e)
    const hit = src && wordAtPoint(src, e.clientX, e.clientY)
    if (!src || !hit) return
    const shown = indentOf(no) + offsetIn(src, hit.node, hit.start)
    actions.definition!(node.key, { line: no, column: fileColumn(fileLines[no - node.startLine] ?? '', shown) })
  }

  const editAt = (e: MouseEvent, no: number) => {
    if ((e.ctrlKey || e.metaKey) && canGo) {
      e.stopPropagation()
      if (still(e)) definitionAt(e, no)
      return
    }
    if (!editable || !still(e)) return
    if (zoomedOut && actions.focusLine) return actions.focusLine(node.key, no)
    const src = srcOf(e)
    const col = src ? clickOffset(src, e) : 0
    actions.edit!(node.key, { line: no, column: fileColumn(fileLines[no - node.startLine] ?? '', indentOf(no) + col) })
  }

  return (
    <div
      className={`card kind-${node.kind}${selected ? ' selected' : ''}${changed ? ' changed' : ''}${editing ? ' editing' : ''}${editable ? (zoomedOut ? ' zoomable' : ' editable') : ''}`}
      style={{ '--k': color } as CSSProperties}
      // A card is a stop for the keyboard and has a name for a screen reader; Enter on the card itself does what a click on its header does.
      tabIndex={0}
      role="group"
      aria-label={cardLabel(node, KIND_NAME[node.kind])}
      onKeyDown={e => {
        if (e.key === 'Enter' && e.target === e.currentTarget && (node.code || schema?.file)) {
          e.preventDefault()
          actions.reveal?.(node.key)
        }
      }}
      onPointerDown={onDown}
      onClickCapture={e => {
        // Alt+click anywhere on a card: point at it and ask.
        if (e.altKey && node.code && actions.ask) {
          e.preventDefault()
          e.stopPropagation()
          actions.ask(node.key)
        }
      }}
    >
      <Handle type="target" position={Position.Left} id="in" style={{ top: HEADER_H / 2 }} />
      <div
        className="card-head"
        style={{ height: HEADER_H }}
        onClick={e => still(e) && (node.code || schema?.file) && actions.reveal?.(node.key)}
        onDoubleClick={() => (node.code || schema?.file) && actions.open(node.key)}
        title={node.code ? 'Click to show in the editor, double-click to open it' : schema?.file ? 'Click to show the entity, double-click to open it' : undefined}
      >
        <KindGlyph kind={node.kind} />
        <div className="titles" title={node.tableChange ? [node.label, node.sub, changeNote(node.tableChange).replace(/^ · /, '')].filter(Boolean).join('\n') : undefined}>
          <div className="title">
            {owner && <span className="owner">{owner}.</span>}
            <span className="member">{member}</span>
          </div>
          <div className={`sub${node.truncated ? ' has-cut' : ''}`}>
            {/* A flow cut at its size limit says it on the cards that were cut, in words, so a short flow never passes for a whole one. */}
            {node.truncated ? <span className="cut" title="The flow was cut at its size limit: the calls below this card are not drawn.">{cutNote(node.truncated)}</span> : null}
            <span className="sub-text">{schema ? `${schema.entity} in ${schema.context}${changeNote(node.tableChange)}` : node.kind === 'db' && /SaveChanges/.test(node.label) ? 'Saves tracked changes' : file ? `${file}:${node.startLine}` : node.sub}</span>
          </div>
        </div>
        <div className="tools nodrag">
          {calls.length > 0 && (
            <button className="tool" title={hiddenCount ? `Show ${hiddenCount} hidden calls` : 'Hide all calls'} aria-label={hiddenCount ? `Show ${hiddenCount} hidden calls` : 'Hide all calls'} onClick={() => actions.toggleAll(node.key)}>
              {hiddenCount ? `+${hiddenCount}` : '−'}
            </button>
          )}
          {compactable && !node.diff && !editing && (
            <button className="tool" title={full ? 'Show only the flow lines' : 'Show every line'} aria-label={full ? 'Show only the flow lines' : 'Show every line'} onClick={() => actions.toggleFull(node.key)}>
              {full ? '⇤' : '⇥'}
            </button>
          )}
          {node.code && actions.ask && (
            <button className="tool" title="Ask the agent about this method (Alt+click the card; select lines first to ask about them)" aria-label="Ask the agent about this method" onMouseDown={e => e.preventDefault()} onClick={e => (e.stopPropagation(), actions.ask!(node.key))}>
              ?
            </button>
          )}
          {node.code && actions.mention && (
            <button className="tool" title="Mention this method in Claude Code (terminal)" aria-label="Mention this method in Claude Code" onClick={() => actions.mention!(node.key)}>
              @
            </button>
          )}
          {node.code && (
            <button className="tool" title="Open in the editor" aria-label="Open in the editor" onClick={() => actions.open(node.key)}>
              ↗
            </button>
          )}
        </div>
      </div>

      {chips && chipRows && chipsOpen && !editing && <TypeChips nodeKey={node.key} chips={chips} rows={chipRows} open={chipsOpen} height={chipsH ?? 0} zoomedOut={zoomedOut} still={still} />}
      {schema && <SchemaBody schema={schema} change={node.tableChange} />}
      {editing && node.code && actions.save && (
        <CardEditor nodeKey={node.key} code={node.code} file={node.file} startLine={node.startLine} endLine={node.endLine} caret={actions.caret} onSave={(t, session) => actions.save!(node.key, t, session)} onCancel={() => actions.cancelEdit?.()} />
      )}

      {!editing && rows.length > 0 && (
        <div className="code nodrag nopan" style={{ paddingTop: CODE_PAD, paddingBottom: CODE_PAD }}>
          {rows.map(r => {
            if ('del' in r)
              return (
                <div key={`d${r.after}-${r.i}`} className="ln del" style={{ height: LINE_H }}>
                  <span className="gutter" />
                  <span className="src">{r.del}</span>
                </div>
              )
            if (!('no' in r))
              return (
                <div key={`g${r.from}`} className="ln gap" style={{ height: LINE_H }} onClick={e => still(e) && actions.toggleFull(node.key)}>
                  <span className="gutter">⋯</span>
                  <span className="src">{r.gap} more lines</span>
                </div>
              )
            const l = r
            const lineCalls = callByLine.get(l.no)
            const i = l.no - node.startLine
            const callee = lineCalls?.[0].edge.node
            return (
              <div
                key={l.no}
                data-line={l.no}
                className={`ln${lineCalls ? ' call' : ''}${node.diff?.added.includes(l.no) ? ' add' : ''}`}
                style={{ height: LINE_H, ...(callee ? ({ '--c': KIND_COLOR[callee.kind] } as CSSProperties) : {}) }}
                onClick={e => editAt(e, l.no)}
                onMouseEnter={callee ? () => actions.trace?.(node.key, callee.key) : undefined}
                onMouseMove={canGo ? e => hoverCode(srcOf(e), e) : undefined}
                onMouseLeave={() => {
                  leaveCode()
                  if (callee) actions.trace?.(null)
                }}
              >
                <span className="gutter">{l.no}</span>
                {html ? <span className="src" dangerouslySetInnerHTML={{ __html: html[i] ?? '' }} /> : <span className="src">{l.text}</span>}
                {lineCalls && callee && (
                  <button
                    className={`port nodrag${lineCalls.some(c => c.hidden) ? ' folded' : ''}`}
                    title={lineCalls.some(c => c.hidden) ? `Show ${callee.label}` : `Hide ${callee.label}`}
                    onClick={e => {
                      e.stopPropagation()
                      lineCalls.forEach(c => actions.toggle(c.edge.node.key))
                    }}
                  >
                    {splitLabel(callee.label).member}
                    {lineCalls.length > 1 && <span className="port-more">+{lineCalls.length - 1}</span>}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      {node.diff && !editing && (
        <div className="review nodrag">
          <span className="review-what">{node.diff.base ? `Changed since ${node.diff.base}` : node.diff.source === 'git' ? 'Uncommitted change' : 'Agent edit'}</span>
          <span className="review-stat">
            <b className="plus">+{node.diff.plus}</b>
            <b className="minus">−{node.diff.minus}</b>
          </span>
          {!!actions.editHooks?.length && (
            <span className="review-hooks" title={`Set to run after every agent edit:\n${actions.editHooks.join('\n')}`}>
              {actions.editHooks.length} {actions.editHooks.length === 1 ? 'hook' : 'hooks'}
            </span>
          )}
          <span className="review-space" />
          {actions.undo && !node.diff.base && (
            <button className="btn ghost" onClick={() => actions.undo!(node.key)}>
              Undo
            </button>
          )}
          {actions.keep && (
            <button className="btn solid" onClick={() => actions.keep!(node.key)}>
              Keep
            </button>
          )}
        </div>
      )}

      {calls.map(c => (
        <Handle key={c.edge.node.key} type="source" position={Position.Right} id={`h-${c.edge.node.key}`} style={{ top: c.y, opacity: c.hidden ? 0 : 1, ['--c' as string]: KIND_COLOR[c.edge.node.kind] }} />
      ))}
    </div>
  )
})

export const FrameNode = memo(({ data }: NodeProps<Node<FrameData>>) => <div className="frame" style={{ '--k': KIND_COLOR[data.kind] } as CSSProperties} />)

export const nodeTypes = { card: CardNode, frame: FrameNode }
