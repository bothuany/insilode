// What the board webview and its host (flow-view/src/boardPanel.ts) say to each other, and the look-up tables both the
// renderer and the SVG export use. Pure: no DOM, no React.
import type { BoardSpec, ChangeMark, EdgeKind, EdgeLine, NodeKind } from './spec'

/** What a rebuild asks the host for. Mirrors flow-view's BoardOptions: the host recomputes the board from these. */
export interface BoardOpts {
  query?: string
  focusId?: string
  depth?: number
  includeEntities?: boolean
  includeEnums?: boolean
  hideRoles?: string[]
  collapseLevel?: number
}

export interface BoardRef {
  id: string
  title: string
  /** This board is the one the other board's box zooms into. */
  up: boolean
}

export type ExportFormat = 'mermaid' | 'plantuml' | 'png' | 'svg' | 'json'

export interface Bootstrap {
  spec: BoardSpec
  /** The board compared with its previous draw (changes marked), when something changed: the "since last draw" switch shows it. */
  since?: BoardSpec
  /** The host's name for the source that can rebuild this board ('dto', 'architecture'); absent: the board is fixed. */
  /** The other boards the host holds: which ones a box's `zoom` can open, and which ones zoom into this one. */
  boards?: BoardRef[]
  source?: string
  opts: BoardOpts
  dark: boolean
  /** 'local': the source ignores the query, so a search only highlights what is drawn (no rebuild). */
  search?: 'host' | 'local'
}

export type ToHost =
  | { type: 'ready' }
  | { type: 'open'; file: string; line: number }
  /** Skeleton first: the developer clicked a new type that has a target file; the host works out the path itself and offers to create it. */
  | { type: 'create'; node: string }
  | { type: 'rebuild'; seq: number; kind: string; opts: BoardOpts }
  | { type: 'export'; format: ExportFormat; data?: string; name?: string }
  /** C4: open the board a box zooms into (the host checks the id). */
  | { type: 'zoom'; board: string }
  /** An empty state's "Edit DTO suffixes": open this setting (the host opens only the ones on its own list). */
  | { type: 'settings'; setting: string }

export type ToWebview =
  /** `refresh`: the same board drawn again because the code changed: the search, selection and viewport stay as they are. */
  | { type: 'board'; spec: BoardSpec; since?: BoardSpec; boards?: BoardRef[]; opts?: BoardOpts; seq?: number; refresh?: boolean }
  | { type: 'error'; message: string; seq?: number }

/** Colour per node kind (the accent of a card). */
export const KIND_COLOR: Record<NodeKind, string> = {
  entry: '#ffb454',
  controller: '#ffb454',
  service: '#6f86ff',
  repository: '#4fd6d0',
  entity: '#e6c15a',
  dto: '#5fe0a1',
  enum: '#b88cff',
  interface: '#7cc4ff',
  class: '#8b93a1',
  external: '#5c6370',
  step: '#8b93a1',
  decision: '#ffb454',
  note: '#e6c15a',
  actor: '#b88cff',
}

export const STEREOTYPE: Partial<Record<NodeKind, string>> = {
  entry: 'handler',
  controller: 'controller',
  service: 'service',
  repository: 'repository',
  entity: 'entity',
  dto: 'dto',
  enum: 'enum',
  interface: 'interface',
  external: 'external',
}

export type Head = 'tri' | 'vee' | 'fill' | 'none'
export interface EdgeStyle {
  dash?: string
  head: Head
  /** One of the --fl-* colour names (text, muted, signal, add, del). */
  color: 'text' | 'muted' | 'signal' | 'add' | 'del' | 'warn'
}

export const EDGE_STYLE: Record<EdgeKind, EdgeStyle> = {
  extends: { head: 'tri', color: 'text' },
  implements: { head: 'tri', dash: '6 4', color: 'text' },
  has: { head: 'vee', color: 'signal' },
  'has-many': { head: 'vee', color: 'signal' },
  depends: { head: 'vee', dash: '6 4', color: 'muted' },
  uses: { head: 'vee', dash: '6 4', color: 'muted' },
  calls: { head: 'fill', color: 'muted' },
  next: { head: 'fill', color: 'muted' },
  yes: { head: 'fill', color: 'add' },
  no: { head: 'fill', color: 'del' },
  reads: { head: 'vee', dash: '3 3', color: 'muted' },
  writes: { head: 'fill', color: 'signal' },
  message: { head: 'fill', color: 'muted' },
}

export const edgeStyle = (kind: EdgeKind | undefined): EdgeStyle => EDGE_STYLE[kind ?? 'calls']

const LINE_DASH: Record<EdgeLine, string | undefined> = { solid: undefined, dashed: '6 4', dotted: '2 3' }

/** Compare colours, shared with the skeleton-first language: added is green, removed red, changed amber. */
export const CHANGE_COLOR: Record<ChangeMark, EdgeStyle['color']> = { added: 'add', removed: 'del', changed: 'warn' }

/** The look of an edge: its kind's style, then what the edge itself says (a dashed return, an async open head, a change mark). */
export function lineStyle(e: { kind?: EdgeKind; style?: EdgeLine; async?: boolean; change?: ChangeMark }): EdgeStyle {
  const base = edgeStyle(e.kind)
  return {
    dash: e.style ? LINE_DASH[e.style] : base.dash,
    head: e.async && base.head === 'fill' ? 'vee' : base.head,
    color: e.change ? CHANGE_COLOR[e.change] : base.color,
  }
}

/** The text on an edge: "[guard] label ×N". The order is a badge of its own. */
export const edgeText = (e: { label?: string; guard?: string; count?: number }): string => [e.guard ? `[${e.guard}]` : '', e.label ?? '', (e.count ?? 1) > 1 ? `×${e.count}` : ''].filter(Boolean).join(' ')

/** An action under an empty board's message: it either draws the board again with other options or opens a setting. */
export interface EmptyAction {
  id: 'clear' | 'entities' | 'suffixes'
  label: string
  hint?: string
  /** Ask the host for the board again with these options (merged into the current ones). */
  rebuild?: Partial<BoardOpts>
  /** Ask the host to open this setting. */
  setting?: string
}

/**
 * What an empty board offers. With filters on (a search, a focus, hidden kinds) the way out is clearing them. A DTO diagram with
 * nothing filtered has two causes the user can fix: entities are left out by default, and a type is a DTO by its name suffix.
 * Only a board the host can redraw offers anything, since a fixed board has no options to change.
 */
export function emptyActions(source: string | undefined, opts: BoardOpts, canRebuild: boolean): EmptyAction[] {
  if (!canRebuild) return []
  if (opts.query || opts.focusId || (opts.hideRoles?.length ?? 0) > 0) {
    return [{ id: 'clear', label: 'Clear filters', rebuild: { query: undefined, focusId: undefined, depth: undefined, hideRoles: undefined } }]
  }
  if (source !== 'dto') return []
  const actions: EmptyAction[] = []
  if (!opts.includeEntities) actions.push({ id: 'entities', label: 'Include entities', hint: 'Draw entities (JPA, EF Core, Django models) too', rebuild: { includeEntities: true } })
  actions.push({ id: 'suffixes', label: 'Edit DTO suffixes', hint: 'Open the setting that says which names are DTOs', setting: 'flow.types.dtoSuffixes' })
  return actions
}

/** The kinds a role chip can hide, in the order they are shown. Entities and enums have their own toggles. */
export const ROLE_CHIPS: { role: NodeKind; label: string }[] = [
  { role: 'controller', label: 'controller' },
  { role: 'entry', label: 'handler' },
  { role: 'service', label: 'service' },
  { role: 'repository', label: 'repository' },
  { role: 'dto', label: 'dto' },
  { role: 'interface', label: 'interface' },
  { role: 'class', label: 'class' },
]

export const VISIBILITY_NAME = { '+': 'public', '-': 'private', '#': 'protected', '~': 'package' } as const

/** How many nodes and edges carry each change mark: the summary on the toolbar. */
export function countChanges(spec: BoardSpec): { added: number; removed: number; changed: number } {
  const out = { added: 0, removed: 0, changed: 0 }
  for (const x of [...spec.nodes, ...spec.edges]) if (x.change) out[x.change]++
  return out
}
