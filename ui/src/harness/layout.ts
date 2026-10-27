// Turns a harness model into React Flow nodes and edges: stages as columns left to right, item cards stacked under each stage's header.
import type { Edge, Node } from '@xyflow/react'
import type { HarnessFlowItem, HarnessFlowKind, HarnessStage, PathHit } from '../../../protocol/harness'

export const STAGES: { id: HarnessStage; title: string; hint: string }[] = [
  { id: 'sessionStart', title: 'Session start', hint: 'SessionStart hooks' },
  { id: 'load', title: 'Load', hint: 'Instructions, always-on rules, memory, listings, MCP servers connecting' },
  { id: 'promptSubmit', title: 'Prompt', hint: 'UserPromptSubmit hooks' },
  { id: 'model', title: 'Model', hint: 'Path-scoped rules and skills read on demand' },
  { id: 'preTool', title: 'Before tool', hint: 'PreToolUse hooks' },
  { id: 'permission', title: 'Permission', hint: 'allow / ask / deny rules and the permission mode' },
  { id: 'permissionRequest', title: 'Ask', hint: 'PermissionRequest hooks' },
  { id: 'run', title: 'Run', hint: 'The tool itself: built-in, an MCP tool, a subagent' },
  { id: 'postTool', title: 'After tool', hint: 'PostToolUse and PostToolUseFailure hooks' },
  { id: 'subagent', title: 'Subagent', hint: 'SubagentStop hooks' },
  { id: 'stop', title: 'Stop', hint: 'Stop and StopFailure hooks' },
  { id: 'sessionEnd', title: 'Session end', hint: 'SessionEnd, Notification and PreCompact hooks' },
]

export const KIND_LABEL: Record<HarnessFlowKind, string> = {
  instructions: 'Instructions', rules: 'Rules', skills: 'Skills', agents: 'Agents', hooks: 'Hooks', mcp: 'MCP', permissions: 'Permissions', memory: 'Memory',
}

export const COL_W = 196
export const EMPTY_W = 104
export const GAP = 52
export const HEADER_H = 52
export const CARD_H = 74
const CARD_GAP = 8
const TOP = HEADER_H + 14

export interface CardData extends Record<string, unknown> {
  item: HarnessFlowItem
  /** The hit on the active path, when this card is on it. */
  hit?: PathHit
  dim: boolean
  onOpen: (id: string) => void
}
export interface HeaderData extends Record<string, unknown> {
  title: string
  hint: string
  count: number
  empty: boolean
  active: boolean
  dim: boolean
  /** The permission header shows the permission mode in preview and replay. */
  mode?: string
}
export interface EmptyData extends Record<string, unknown> { empty: true }

export interface Laid {
  nodes: Node[]
  edges: Edge[]
}

export function layout(items: HarnessFlowItem[], hits: PathHit[] | undefined, mode: string | undefined, onOpen: (id: string) => void): Laid {
  const hitBy = new Map<string, PathHit>()
  for (const h of hits ?? []) if (!hitBy.has(h.itemId)) hitBy.set(h.itemId, h)
  const live = hits !== undefined
  const byStage = new Map<HarnessStage, HarnessFlowItem[]>()
  for (const it of items) {
    const list = byStage.get(it.stage)
    if (list) list.push(it)
    else byStage.set(it.stage, [it])
  }
  const nodes: Node[] = []
  const edges: Edge[] = []
  let x = 0
  STAGES.forEach((s, i) => {
    const list = byStage.get(s.id) ?? []
    const empty = list.length === 0
    const w = empty ? EMPTY_W : COL_W
    const active = list.some(it => hitBy.has(it.id))
    const header: HeaderData = { title: s.title, hint: s.hint, count: list.length, empty, active, dim: live && !active, mode: live ? mode : undefined }
    if (s.id !== 'permission') header.mode = undefined
    nodes.push({ id: `stage:${s.id}`, type: 'stage', position: { x, y: 0 }, data: header, width: w, height: HEADER_H, draggable: false, selectable: false })
    if (empty) {
      const data: EmptyData = { empty: true }
      nodes.push({ id: `none:${s.id}`, type: 'none', position: { x, y: TOP }, data, width: w, height: 40, draggable: false, selectable: false })
    }
    list.forEach((it, row) => {
      const data: CardData = { item: it, hit: hitBy.get(it.id), dim: live && !hitBy.has(it.id), onOpen }
      nodes.push({ id: it.id, type: 'card', position: { x, y: TOP + row * (CARD_H + CARD_GAP) }, data, width: w, height: CARD_H, draggable: false, selectable: false })
    })
    if (i > 0) {
      const prev = STAGES[i - 1].id
      edges.push({ id: `spine:${prev}`, source: `stage:${prev}`, target: `stage:${s.id}`, type: 'straight', className: 'spine', markerEnd: { type: 'arrowclosed', width: 14, height: 14 }, selectable: false, focusable: false })
    }
    x += w + GAP
  })

  // The path: from every hit of one stage to every hit of the next stage that has any. Observed segments are solid, predicted dashed.
  const groups: PathHit[][] = []
  for (const s of STAGES) {
    const g = (byStage.get(s.id) ?? []).map(it => hitBy.get(it.id)).filter((h): h is PathHit => !!h)
    if (g.length) groups.push(g)
  }
  for (let i = 1; i < groups.length; i++) {
    for (const a of groups[i - 1]) {
      for (const b of groups[i]) {
        edges.push({
          id: `path:${a.itemId}>${b.itemId}`, source: a.itemId, target: b.itemId, type: 'default', className: `path ${a.how === 'observed' && b.how === 'observed' ? 'observed' : 'predicted'}`,
          zIndex: 5, selectable: false, focusable: false,
        })
      }
    }
  }
  return { nodes, edges }
}
