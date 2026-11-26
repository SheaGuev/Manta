/** Places visited, oldest first, and the one being shown. `index` is -1 while empty. */
export interface NavHistory<T> {
  readonly entries: readonly T[]
  readonly index: number
}

export type NavDirection = 'back' | 'forward'

const MAX_ENTRIES = 50

export function emptyHistory<T>(): NavHistory<T> {
  return { entries: [], index: -1 }
}

/**
 * Adds a visit after the current place, dropping any forward entries. Visiting the current place
 * again returns the history unchanged, so applying a step back or forward never records itself.
 * A visit that `supersedes` the current place replaces it, e.g. a context entered with no tab
 * open, then its first tab.
 */
export function recordVisit<T>(
  history: NavHistory<T>,
  entry: T,
  same: (a: T, b: T) => boolean,
  { max = MAX_ENTRIES, supersedes }: { max?: number; supersedes?: (current: T, next: T) => boolean } = {}
): NavHistory<T> {
  const current = history.entries[history.index]
  if (current !== undefined && same(current, entry)) return history
  const kept = current !== undefined && supersedes?.(current, entry) ? history.index : history.index + 1
  const entries = [...history.entries.slice(0, kept), entry].slice(-max)
  return { entries, index: entries.length - 1 }
}

/**
 * The nearest usable place in `direction`, with the history moved to it; null when there is none.
 * `shows` turns the entry into what applying it will display (a tabless place shows its context's
 * active tab), and that is stored, so recording the result is a no-op and Forward survives. A place
 * that would show what is showing now is passed over, so a step never looks like it did nothing.
 */
export function step<T>(
  history: NavHistory<T>,
  direction: NavDirection,
  usable: (entry: T) => boolean,
  shows: (entry: T) => T = (entry) => entry,
  same: (a: T, b: T) => boolean = (a, b) => a === b
): { history: NavHistory<T>; entry: T } | null {
  const delta = direction === 'back' ? -1 : 1
  const current = history.entries[history.index]
  for (let index = history.index + delta; index >= 0 && index < history.entries.length; index += delta) {
    const found = history.entries[index]
    if (found === undefined || !usable(found)) continue
    const entry = shows(found)
    if (current !== undefined && same(current, entry)) continue
    const entries = entry === found ? history.entries : history.entries.map((e, i) => (i === index ? entry : e))
    return { history: { entries, index }, entry }
  }
  return null
}

export function canStep<T>(
  history: NavHistory<T>,
  direction: NavDirection,
  usable: (entry: T) => boolean,
  shows?: (entry: T) => T,
  same?: (a: T, b: T) => boolean
): boolean {
  return step(history, direction, usable, shows, same) !== null
}

/**
 * Removes places that no longer exist (a removed worktree, a deleted map). The current place stays
 * current, or the nearest earlier survivor becomes it; neighbours left the same collapse into one.
 */
export function prune<T>(history: NavHistory<T>, keep: (entry: T) => boolean, same: (a: T, b: T) => boolean): NavHistory<T> {
  const entries: T[] = []
  let index = -1
  history.entries.forEach((entry, i) => {
    if (!keep(entry)) return
    const last = entries.at(-1)
    if (last === undefined || !same(last, entry)) entries.push(entry)
    if (i <= history.index) index = entries.length - 1
  })
  return { entries, index }
}
