// What a screen reader says for a card: its name, where it is, and that its flow was cut. Pure (plain Node tests in ui/).
// No runtime imports: only erasable TypeScript.
import type { FlowNode } from '../types'

/** "+3 more calls not drawn": the card's note when the host cut the flow at its size limit; empty for a whole flow. */
export function cutNote(truncated: number | undefined): string {
  return truncated && truncated > 0 ? `+${truncated} more ${truncated === 1 ? 'call' : 'calls'} not drawn` : ''
}

/** "Orders.Service.Get, method, OrdersService.cs:12, +3 more calls not drawn". A Windows path is shortened to its file name. */
export function cardLabel(node: Pick<FlowNode, 'label' | 'kind' | 'file' | 'startLine' | 'truncated'>, kindName: string): string {
  const name = node.label.replace(/\s*▸\s*/g, '.')
  const file = node.file?.split(/[\\/]/).pop()
  return [name, kindName, file ? `${file}${node.startLine > 0 ? `:${node.startLine}` : ''}` : '', cutNote(node.truncated)].filter(Boolean).join(', ')
}
