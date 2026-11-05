// The editor host the canvas expects, played by a page: the canvas (ui/src/webview.tsx) talks to its host only through
// `acquireVsCodeApi().postMessage`, so this answers its requests from the demo data. The project is in one of two states (before the
// agent's change, and with it); `?mode=changed` starts with the change in, and Keep and Undo then act on this page's own state.
// Imported before the canvas: it sets the globals the canvas reads when it loads.
import type { FlowNode } from '../../protocol/flow'
import { NAME } from './brand'
import { entryLabel, type DemoData, type Impact, type Target, type ToShell, type TurnSummary } from './demo'

interface Request {
  type: 'request'
  id: number
  op: string
  target?: Target
  turn?: number
}

const data: DemoData = await fetch('./data/demo.json').then(r => r.json())
const say = (m: ToShell) => window.parent !== window && window.parent.postMessage(m, location.origin)

const params = new URLSearchParams(location.search)
let edited = params.get('mode') === 'changed'
let kept = false
const state = () => ({ edited, kept })

/** The flow for a target. While the agent's change is waiting for Keep or Undo, the endpoints it reaches draw it on their cards. */
function graphOf(t: Target): FlowNode {
  const { edited, kept } = state()
  if (t.kind === 'changes') {
    if (!edited || kept) throw new Error('There are no changes to show: ask an agent to change something, or run the demo from the Agents dock.')
    return data.changes.root
  }
  const flow = (edited ? data.after : data.before).flows[t.id]
  if (!flow) throw new Error('This endpoint is not part of the demo.')
  return edited && !kept && flow.changed ? flow.changed : flow.graph
}

/** What the real host answers each op with (flow-view's panel.ts): the fake must give the canvas the same shapes. */
interface Answers {
  graph: FlowNode
  callers: FlowNode | null
  impact: Impact
  timeline: TurnSummary[]
  editHooks: string[]
  typeChips: { chips: Record<string, never>; ready: boolean; diagramAvailable: boolean }
  typeDetail: undefined
  complete: { items: never[] }
  signature: null
  hover: null
  definition: { ok: boolean; message?: string }
  endEdit: { ok: boolean }
  save: { ok: boolean; message?: string }
  undo: { ok: boolean; message?: string }
  undoFrom: { ok: boolean; message?: string }
  keep: { ok: boolean }
  keepCard: { ok: boolean }
  keepAll: { ok: boolean }
  undoAll: { ok: boolean; message?: string }
}

const READ_ONLY = `The demo does not write files: in the ${NAME} app a save is applied to your code.`

/** Keep and Undo change this page's state, and the page around it hears of it; the canvas then asks for its flow again. */
function decide(what: 'keep' | 'undo') {
  if (what === 'keep') kept = true
  else {
    edited = false
    kept = false
  }
  say({ source: 'insilode-canvas', type: 'decided', what })
  setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'refresh' } })), 30)
}

const handlers: { [Op in keyof Answers]: (m: Request) => Answers[Op] } = {
  graph: m => graphOf(m.target!),
  callers: m => {
    if (m.target?.kind !== 'poly') return null
    graphOf(m.target)
    return (state().edited ? data.after : data.before).flows[m.target.id]?.callers ?? null
  },
  impact: m => {
    const { edited } = state()
    const impact = m.target?.kind === 'changes' ? data.changes.impact : (edited ? data.after : data.before).flows[m.target!.id]?.impact
    if (!impact) throw new Error('This endpoint is not part of the demo.')
    return impact
  },
  timeline: () => {
    const { edited, kept } = state()
    return edited && !kept ? data.changes.timeline : []
  },
  editHooks: () => [],
  // The demo has no type graph: cards draw without chips, and nothing to open.
  typeChips: () => ({ chips: {}, ready: true, diagramAvailable: false }),
  typeDetail: () => undefined,
  complete: () => ({ items: [] }),
  signature: () => null,
  hover: () => null,
  definition: () => ({ ok: false, message: `Go to definition works in the ${NAME} app, on your own code.` }),
  endEdit: () => ({ ok: true }),
  save: () => ({ ok: false, message: READ_ONLY }),
  undo: () => {
    decide('undo')
    return { ok: true }
  },
  undoFrom: () => {
    decide('undo')
    return { ok: true }
  },
  keep: () => {
    decide('keep')
    return { ok: true }
  },
  // The demo's change is one prompt in one card, so the card, the prompt and the whole change are the same thing.
  keepCard: () => {
    decide('keep')
    return { ok: true }
  },
  keepAll: () => {
    decide('keep')
    return { ok: true }
  },
  undoAll: () => {
    decide('undo')
    return { ok: true }
  },
}

function answer(m: Request): unknown {
  const handler = (handlers as Record<string, ((m: Request) => unknown) | undefined>)[m.op]
  if (!handler) throw new Error(`The demo does not answer "${m.op}".`)
  return handler(m)
}

const host = {
  postMessage(m: { type: string; [key: string]: unknown }) {
    if (m.type === 'request') {
      const req = m as unknown as Request
      let result: { data?: unknown; error?: string }
      try {
        result = { data: answer(req) }
      } catch (e) {
        result = { error: (e as Error).message }
      }
      // Asynchronous, like a real host: the canvas must cope with an answer arriving after it asked.
      setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'response', id: req.id, ...result } })), 0)
      return
    }
    // Opening a file or handing the flow to an agent needs the app, not the browser: the page around the canvas says so.
    if ((m.type === 'open' || m.type === 'reveal') && typeof m.file === 'string' && typeof m.line === 'number') {
      say({ source: 'insilode-canvas', type: m.type, file: m.file, line: m.line })
      return
    }
    const what: Record<string, string> = {
      ask: `In the ${NAME} app this hands the flow to the agent you picked (Claude Code, Codex, any CLI).`,
      mention: `In the ${NAME} app this @-mentions the card in your agent’s terminal.`,
      pointAsk: `In the ${NAME} app the agent you picked gets the selected lines: it answers with a tour, or its edit comes back as a change to keep or undo.`,
      answer: `In the ${NAME} app you accept or reject what an agent wants to edit here.`,
    }
    if (what[m.type]) say({ source: 'insilode-canvas', type: 'note', text: what[m.type] })
  },
}

;(window as unknown as { acquireVsCodeApi: () => typeof host }).acquireVsCodeApi = () => host

// Which flow opens first: `?t=<entry id>` or `?t=changes`, else the order flow.
const wanted = params.get('t')
const entries = (edited ? data.after : data.before).entries
const entry = entries.find(e => e.id === wanted) ?? entries.find(e => e.http === 'POST /orders') ?? entries[0]
const first: { target: Target; label: string } = wanted === 'changes' ? { target: { kind: 'changes', id: '1' }, label: data.changes.label } : { target: { kind: 'poly', id: entry.id }, label: entryLabel(entry) }
;(window as unknown as { __FLOW__: unknown }).__FLOW__ = { ...first, dark: true }
say({ source: 'insilode-canvas', type: 'ready' })
