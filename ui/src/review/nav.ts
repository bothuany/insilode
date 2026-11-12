// Moving through the changed cards outside the tour: the order of the Changes rail, next/previous, "viewed" ticks and the find box.
// Pure (no React, no type imports of the wire types), so it runs under plain Node (ui/test).

/** What navigation needs of a card: the `FlowNode` fields it reads. */
export interface NavCard {
  key: string
  label: string
  file?: string | null
  diff?: { plus: number; minus: number }
}

export interface NavRow {
  key: string
  owner: string
  member: string
  plus: number
  minus: number
}

export interface NavGroup {
  file: string
  /** The file's name without its folders (a Windows host sends backslash paths). */
  name: string
  rows: NavRow[]
}

/** "Class ▸ Method" as the card's title splits it: everything before the last dot is the owner. */
export function splitName(label: string): { owner: string; member: string } {
  const clean = label.replace(/\s*▸\s*/g, '.')
  const at = clean.lastIndexOf('.')
  return at > 0 ? { owner: clean.slice(0, at), member: clean.slice(at + 1) } : { owner: '', member: clean }
}

/** The rail's rows: the changed cards grouped by file, files in the order they first appear, cards in the order given. */
export function groupByFile(changed: readonly NavCard[]): NavGroup[] {
  const groups = new Map<string, NavGroup>()
  for (const c of changed) {
    const file = c.file ?? ''
    let g = groups.get(file)
    if (!g) groups.set(file, (g = { file, name: file.split(/[\\/]/).pop() || 'No file', rows: [] }))
    g.rows.push({ key: c.key, ...splitName(c.label), plus: c.diff?.plus ?? 0, minus: c.diff?.minus ?? 0 })
  }
  return [...groups.values()]
}

/** The next (`dir` 1) or previous (-1) key, wrapping at both ends. With no current one, next is the first and previous the last. */
export function stepKey(keys: readonly string[], current: string | null | undefined, dir: 1 | -1): string | undefined {
  if (!keys.length) return undefined
  const at = current == null ? -1 : keys.indexOf(current)
  if (at < 0) return dir === 1 ? keys[0] : keys[keys.length - 1]
  return keys[(at + dir + keys.length) % keys.length]
}

/** The key `v` moves on to: the next change after `current` that is not viewed yet, wrapping; nothing when every other one is viewed. */
export function nextUnviewed(keys: readonly string[], current: string | null | undefined, viewed: ReadonlySet<string>): string | undefined {
  let k = current
  for (let i = 0; i < keys.length; i++) {
    k = stepKey(keys, k, 1)
    if (k !== undefined && k !== current && !viewed.has(k)) return k
  }
  return undefined
}

/** A copy of `viewed` with `key` ticked, or unticked when it was. */
export function toggled(viewed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(viewed)
  if (!next.delete(key)) next.add(key)
  return next
}

/** Cards whose method or class name contains the query (case blind, spaces ignored); names that start with it come first, then the order given. */
export function findCards<T extends { key: string; label: string }>(cards: readonly T[], query: string): T[] {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return []
  const seen = new Set<string>()
  const hits: { card: T; rank: number }[] = []
  for (const card of cards) {
    if (seen.has(card.key)) continue
    const { owner, member } = splitName(card.label)
    const m = member.toLowerCase()
    const o = owner.toLowerCase()
    const rank = m.startsWith(q) ? 0 : o.startsWith(q) || o.split('.').some(p => p.startsWith(q)) ? 1 : m.includes(q) || o.includes(q) ? 2 : -1
    if (rank < 0) continue
    seen.add(card.key)
    hits.push({ card, rank })
  }
  return hits.sort((a, b) => a.rank - b.rank).map(h => h.card)
}

/** Index of the next (1) or previous (-1) of `length` matches, wrapping. */
export const cycle = (length: number, index: number, dir: 1 | -1) => (length ? (index + dir + length) % length : 0)

/** What the keys below do; the rail's header and the key list in tour/legend.ts say the same words. */
export const NAV_KEYS = [
  { keys: ']', short: 'next', label: 'Next change' },
  { keys: '[', short: 'prev', label: 'Previous change' },
  { keys: 'v', short: 'viewed', label: 'Mark viewed, go to the next' },
  { keys: '/', short: 'find', label: 'Find a card' },
] as const
