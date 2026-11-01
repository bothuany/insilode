// What the Keep and Undo buttons of a review card show and do: which buttons, their labels, and why one is off. Pure, with
// only type imports, so it is tested under plain Node (ui/test).
import type { FlowNode } from '../types'

/** The card as this needs it: `source` is wider than the wire type's ('command' is added by the host's turn-end sweep). */
export type EditCard = Pick<FlowNode, 'key' | 'label' | 'file' | 'startLine' | 'endLine'> & {
  diff?: { source?: string; base?: string; plus?: number; minus?: number }
}

export interface ButtonState {
  label: string
  /** Names the card (or the prompt), so a screen reader hears what the button acts on. */
  ariaLabel: string
  /** Shown as the tooltip and read after the label. */
  hint: string
  /** Off for a reason: the button stays focusable (`aria-disabled`) so the reason can be read, and a click does nothing. */
  disabled: boolean
  reason?: string
}

export interface AgentEditState {
  keep: ButtonState & {
    /** 'file': the card is the only changed card of its file, so Keep takes the whole file. 'card': only the hunks inside it. */
    via: 'file' | 'card'
  }
  undo: ButtonState
  keepAll: ButtonState
  undoAll: ButtonState
  /** Short labels for how the change got here. */
  badges: string[]
}

/** `Class ▸ Method` as `Class.Method`, the way the tour names a card. */
export const cardName = (label: string) => label.replace(/\s*▸\s*/g, '.')

export const UNDO_OFF = 'Undo is off: this change includes committed work'

/**
 * `othersInFile`: how many other changed cards of the same file are drawn; unknown (undefined) is treated as some, since
 * Keep of the whole file would then drop changes the reader has not looked at.
 */
export function agentEditState(node: EditCard, othersInFile?: number): AgentEditState {
  const name = cardName(node.label)
  const base = node.diff?.base
  const source = node.diff?.source
  const button = (label: string, ariaLabel: string, hint: string, reason?: string): ButtonState => ({ label, ariaLabel, hint: reason ?? hint, disabled: !!reason, reason })
  const badges: string[] = []
  if (source === 'git') badges.push('Already on disk')
  if (source === 'command') badges.push('changed by a command')
  return {
    keep: {
      ...button('Keep', `Keep the change to ${name}`, "Keep this card's change: it stops showing as an agent change"),
      via: othersInFile === 0 ? 'file' : 'card',
    },
    undo: base
      ? button('Undo', `Undo the change to ${name}`, '', UNDO_OFF)
      : button('Undo', `Undo the change to ${name}`, 'Put this card back the way it was before the agent changed it'),
    keepAll: button('Keep all', 'Keep every change of this prompt', 'Keep every change of this prompt, in every file'),
    undoAll: button('Undo all', 'Undo every change of this prompt', 'Undo every change of this prompt, in every file; files measured against a commit are skipped'),
    badges,
  }
}
