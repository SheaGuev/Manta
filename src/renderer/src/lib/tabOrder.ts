/**
 * `tabs` with the one keyed `moving` placed just `side` of the one keyed `target`, as a tab dragged
 * and dropped there. The same array when nothing would move or either key is unknown.
 */
export function reorder<T>(tabs: readonly T[], moving: string, target: string, side: 'before' | 'after', key: (tab: T) => string): readonly T[] {
  const from = tabs.findIndex((tab) => key(tab) === moving)
  const moved = tabs[from]
  if (moved === undefined || moving === target) return tabs
  const rest = tabs.filter((_, i) => i !== from)
  const at = rest.findIndex((tab) => key(tab) === target)
  if (at === -1) return tabs
  const next = [...rest.slice(0, side === 'after' ? at + 1 : at), moved, ...rest.slice(side === 'after' ? at + 1 : at)]
  return next.every((tab, i) => tab === tabs[i]) ? tabs : next
}
