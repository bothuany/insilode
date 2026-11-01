// The tour's keys: one table, read by the key handler in TourPlayer.tsx (`keyAction`) and by the legend the '?' button opens, so
// the legend can only say what the keys do. Pure (no React), so it runs under plain Node (ui/test).

export type KeyAction = 'next' | 'back' | 'toggle' | 'goto' | 'ask' | 'legend' | 'exit'

export interface KeyBinding {
  action: KeyAction
  /** The `KeyboardEvent.key` values that do it. */
  keys: readonly string[]
  /** How the legend writes them. */
  display: string
  label: string
  /** Only on a tour the reader can ask the agent about. */
  askOnly?: true
}

export const KEY_BINDINGS: readonly KeyBinding[] = [
  { action: 'next', keys: ['ArrowRight', ']'], display: '→  ]', label: 'Next step' },
  { action: 'back', keys: ['ArrowLeft', '['], display: '←  [', label: 'Previous step' },
  { action: 'toggle', keys: [' '], display: 'Space', label: 'Pause or play' },
  { action: 'goto', keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], display: '1 to 9', label: 'Go to that step' },
  { action: 'ask', keys: ['/'], display: '/', label: 'Ask about this step', askOnly: true },
  { action: 'legend', keys: ['?'], display: '?', label: 'Show these keys' },
  { action: 'exit', keys: ['Escape'], display: 'Esc', label: 'Close the list, then exit the tour' },
]

/** The one line under the first caption of a tour. */
export const KEY_HINT = 'Right arrow: next · ?: all keys · Esc: exit'

/** What a key does on a tour: the action, and for a number key the step to go to (0-based). Nothing for any other key. */
export function keyAction(key: string): { action: KeyAction; index?: number } | undefined {
  const hit = KEY_BINDINGS.find(b => b.keys.includes(key))
  if (!hit) return undefined
  return hit.action === 'goto' ? { action: 'goto', index: Number(key) - 1 } : { action: hit.action }
}

/** The legend's rows: the ask key only when there is somebody to ask. */
export const legendRows = (canAsk: boolean): readonly KeyBinding[] => KEY_BINDINGS.filter(b => canAsk || !b.askOnly)
