import { Chunk } from '@codemirror/merge'
import { Text } from '@codemirror/state'

/** Lines removed from `before` and added in `after`, counted the way the merge view shows them. */
export function diffLineCounts(before: string, after: string): { added: number; removed: number } {
  const a = Text.of(before.split('\n'))
  const b = Text.of(after.split('\n'))
  let added = 0
  let removed = 0
  for (const chunk of Chunk.build(a, b)) {
    if (chunk.toA > chunk.fromA) removed += a.lineAt(chunk.endA).number - a.lineAt(chunk.fromA).number + 1
    if (chunk.toB > chunk.fromB) added += b.lineAt(chunk.endB).number - b.lineAt(chunk.fromB).number + 1
  }
  return { added, removed }
}

/** What changed between two texts, by line: everything between their common first and last lines. Null when they're the same. */
export function changedLines(before: string, after: string): { removed: string[]; added: string[] } | null {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  const removed = a.slice(start, a.length - end)
  const added = b.slice(start, b.length - end)
  return removed.length === 0 && added.length === 0 ? null : { removed, added }
}
