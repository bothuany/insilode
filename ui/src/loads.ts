/**
 * Counts the canvas's loads, so an answer that arrives after a newer load started (another target, a refresh) is
 * dropped instead of landing on the newer flow. The canvas draws as soon as the graph is there and fills in the impact,
 * the timeline and the edit hooks afterwards: each of those answers goes through `whileCurrent`.
 */
export function loadCounter() {
  let n = 0
  return {
    /** Starts a load and returns its number. */
    start: () => ++n,
    /** The number of the newest load: a retry of one part of it (the callers, the impact) belongs to it. */
    current: () => n,
    isCurrent: (mine: number) => mine === n,
    /** Runs `apply` only while load `mine` is still the newest one. */
    whileCurrent: (mine: number) => (apply: () => void) => {
      if (mine === n) apply()
    },
  }
}
