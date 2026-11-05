// Keep and Undo for the agent's change on the card a review tour stands on, and for the whole prompt. The canvas renders
// this where the tour bar's source actions go; the host runs the ops (`keep`, `keepCard`, `keepAll`, `undo`, `undoAll`).
// What each button shows and why one is off is `agentEditState` (state.ts), tested on its own.
import { useId, useState } from 'react'
import type { FlowNode } from '../types'
import { samePath } from '../tour/cards'
import { agentEditState, type ButtonState, type EditCard } from './state'
import '../agentEdit.css'

export interface AgentEditProps {
  /** The card the review stands on. */
  node: FlowNode
  /** The canvas's per-card Keep and Undo (they reload the flow afterwards). */
  actions: { keep?(key: string): void; undo?(key: string): void }
  /** Sends a request to the host and waits for its answer, as the canvas's own `request` does. */
  request<T>(op: string, payload: Record<string, unknown>): Promise<T>
  /** Redraws the flow after the host changed files. */
  reload(): Promise<void>
  /** Says something on the canvas status line. */
  setStatus(message: string): void
  /**
   * Every changed card that is drawn, when the canvas knows them: Keep of a card that is the only changed one of its file
   * keeps the whole file. Without it Keep stays on the card's own lines.
   */
  changed?: readonly FlowNode[]
}

interface Answer {
  ok: boolean
  message?: string
}

function ActionButton({ state, solid, onAct, busy }: { state: ButtonState; solid?: boolean; onAct(): void; busy: boolean }) {
  const reasonId = useId()
  // `aria-disabled`, not `disabled`: the button stays in the tab order, so the reason it is off can be read.
  const off = state.disabled || busy
  return (
    <>
      <button
        type="button"
        className={`btn ${solid ? 'solid' : 'ghost'} ae-btn`}
        aria-label={state.ariaLabel}
        aria-disabled={off || undefined}
        aria-describedby={state.reason ? reasonId : undefined}
        title={state.hint}
        onClick={() => !off && onAct()}
      >
        {state.label}
      </button>
      {state.reason && <span id={reasonId} className="ae-sr">{state.reason}</span>}
    </>
  )
}

export function AgentEditActions({ node, actions, request, reload, setStatus, changed }: AgentEditProps) {
  const [busy, setBusy] = useState(false)
  const others = changed && node.file ? changed.filter(n => n !== node && n.diff && n.file && samePath(n.file, node.file!)).length : undefined
  const state = agentEditState(node as EditCard, others)

  // One request at a time: a second click while the host is still writing would act on files that are changing.
  const run = async (work: () => Promise<Answer | void>) => {
    setBusy(true)
    try {
      const res = await work()
      await reload()
      // After the reload: a successful load clears the status line, and the host's message must stay readable.
      if (res?.message) setStatus(res.message)
    } catch (e) {
      setStatus(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const keep = () => {
    if (state.keep.via === 'file') return actions.keep?.(node.key)
    return run(async () => {
      await request('keepCard', { file: node.file, startLine: node.startLine, endLine: node.endLine })
    })
  }

  return (
    <>
      {state.badges.map(b => <span key={b} className="ae-badge">{b}</span>)}
      <ActionButton state={state.undo} busy={busy} onAct={() => actions.undo?.(node.key)} />
      <ActionButton state={state.keep} solid busy={busy} onAct={keep} />
      <span className="ae-sep" aria-hidden="true" />
      <ActionButton state={state.undoAll} busy={busy} onAct={() => run(() => request<Answer>('undoAll', {}))} />
      <ActionButton state={state.keepAll} busy={busy} onAct={() => run(async () => { await request('keepAll', {}) })} />
    </>
  )
}
