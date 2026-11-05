// What scripts/playground-data.mjs writes (public/data/demo.json) and what the page and the fake host read.
// The cards and entry points are the protocol types: the same ones flow-view sends the canvas.
import type { EntryPoint, FlowNode, ImpactResult, Tour } from '../../protocol/flow'

export interface Entry extends EntryPoint {
  source: 'poly'
}

/** What the canvas shows under "Affects N endpoints": the same rows flow-view sends. */
export type Impact = ImpactResult

/** One prompt to an agent that changed code (the canvas' timeline). */
export interface TurnSummary {
  id: number
  prompt: string
  agent: string
  at: number
  files: { file: string; plus: number; minus: number }[]
}

export interface FlowData {
  graph: FlowNode
  callers: FlowNode | null
  impact: Impact
  /** The same flow with the agent's change on its cards, when the change reaches it. */
  changed?: FlowNode
}

/** The endpoints and their flows for one state of the demo project. */
export interface Version {
  entries: Entry[]
  flows: Record<string, FlowData>
}

/** What flow-view answers the Agents dock after a turn (`flow.agent.turnImpact`): the flows and tables the edits reached. */
export interface AgentImpact {
  files: number
  flows: { id: string; label: string; name: string; source: 'roslyn' | 'poly'; via?: string[] }[]
  more: number
  note?: string
  methods?: { file: string; name: string }[]
  tables?: { table: string; entity?: string; entityChanged?: boolean; migration?: string; endpoints: number; guess?: boolean; partial?: boolean }[]
}

/** The overlay's palette (editor/patches/flow-desktop.patch), read from the patch. */
export interface IslandColors {
  background: string
  foreground: string
  muted: string
  border: string
  working: string
  approval: string
  question: string
  error: string
  done: string
  idle: string
}

/** One file the agent edits: its path in the demo project. */
export interface AgentEdit {
  path: string
}

/** One row of the harness map (flow-harness's HarnessItem, the fields the tree draws). Its file is a path in the demo project. */
export interface HarnessItem {
  kind: 'instructions' | 'rules' | 'skills' | 'agents' | 'hooks' | 'mcp' | 'permissions' | 'memory'
  scope: 'user' | 'project' | 'local' | 'directory'
  label: string
  detail: string
  agents: string[]
  tokens?: number
  onDemand?: number
  issues: { severity: 'error' | 'warning' | 'info'; message: string; fix?: string; line?: number }[]
  file: string
  rule?: { effect: 'allow' | 'ask' | 'deny' }
  hook?: { command: string }
  mcp?: { id: string; state?: string }
}

/** The result of flow-harness's scan of the demo project. */
export interface HarnessMap {
  root: string
  score: number
  counts: { error: number; warning: number; info: number }
  startupTokens: number
  gaps: { key: string; label: string }[]
  items: HarnessItem[]
}

export interface DemoData {
  /** The project as committed, and with the agent's change. The canvas draws the one its page is in. */
  before: Version
  after: Version
  changes: { label: string; root: FlowNode; impact: Impact; timeline: TurnSummary[] }
  agentImpact: AgentImpact
  edits: AgentEdit[]
  harness: HarnessMap
  islandColors: IslandColors
  /** The guided tours (demo/tours.json), resolved to the cards of the `before` flows. `entry` is the endpoint each one plays on. */
  tours: (Tour & { entry: string })[]
}

/** What the canvas is asked to show: an endpoint's flow, or the agent's change set. */
export type Target = { kind: 'poly'; id: string } | { kind: 'changes'; id: string }

/** How the canvas names an entry in its bar ("OrderController.place"). */
export const entryLabel = (e: EntryPoint) => `${e.controller}.${e.action}`

/** The service an entry lives in: the first folder under the demo project's root. */
export const serviceOf = (e: EntryPoint) => e.file.split('/')[2] ?? 'demo'

/** Messages the canvas page sends its parent, and the other way round (`show`, `cursor`). */
export type ToShell = { source: 'insilode-canvas'; type: 'note'; text: string } | { source: 'insilode-canvas'; type: 'ready' } | { source: 'insilode-canvas'; type: 'decided'; what: 'keep' | 'undo' } | { source: 'insilode-canvas'; type: 'open' | 'reveal'; file: string; line: number }
export type ToCanvas = { type: 'show'; target: Target; label: string } | { type: 'cursor'; file: string; line: number }
