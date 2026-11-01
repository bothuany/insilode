// Keep and Undo for the agent's change on the card a review tour stands on, and for the whole prompt. The canvas renders
// this where the tour bar's source actions go; the host runs the ops (`keep`, `keepCard`, `keepAll`, `undo`, `undoAll`).
// Today it is what the bar showed before the review fixes: one Undo and one Keep, both on the card.
import type { FlowNode } from '../types'

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
}

export function AgentEditActions({ node, actions }: AgentEditProps) {
  return (
    <>
      {!node.diff?.base && <button className="btn ghost" onClick={() => actions.undo?.(node.key)}>Undo</button>}
      <button className="btn solid" onClick={() => actions.keep?.(node.key)}>Keep</button>
    </>
  )
}
