// A tour's follow-up questions, as the canvas receives them: pure, only type imports, so it runs under plain Node (ui/test).

const MAX = 3
const MAX_LEN = 120

/** At most three distinct non-empty strings of at most 120 characters (whitespace squeezed); nothing when none is left. */
export function sanitizeFollowUps(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    // Control characters count as whitespace, so a question is a single line.
    // eslint-disable-next-line no-control-regex
    const text = entry.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN).trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  const kept = out.slice(0, MAX)
  return kept.length ? kept : undefined
}
