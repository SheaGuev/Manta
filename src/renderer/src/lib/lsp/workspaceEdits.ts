/** An LSP text edit: replace `range` with `newText`. Positions are 0-based lines and UTF-16 columns. */
export interface TextEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  newText: string
}

export function isTextEdit(value: unknown): value is TextEdit {
  return typeof value === 'object' && value !== null && 'range' in value && 'newText' in value && typeof value.newText === 'string'
}

/** The edits per file URI in a `WorkspaceEdit`, from either `changes` or `documentChanges` (text edits only). */
export function editsByUri(edit: unknown): Map<string, TextEdit[]> {
  const byUri = new Map<string, TextEdit[]>()
  if (typeof edit !== 'object' || edit === null) return byUri
  const add = (uri: string, edits: unknown): void => {
    if (!Array.isArray(edits)) return
    byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits.filter(isTextEdit)])
  }
  if ('changes' in edit && typeof edit.changes === 'object' && edit.changes !== null) {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits)
  }
  if ('documentChanges' in edit && Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (typeof change !== 'object' || change === null || !('textDocument' in change) || !('edits' in change)) continue
      const document = change.textDocument
      if (typeof document === 'object' && document !== null && 'uri' in document && typeof document.uri === 'string') add(document.uri, change.edits)
    }
  }
  return byUri
}

function offsetOf(lineStarts: number[], text: string, position: TextEdit['range']['start']): number {
  if (position.line >= lineStarts.length) return text.length
  const line = Math.max(0, position.line)
  const start = lineStarts[line] ?? 0
  const end = line + 1 < lineStarts.length ? (lineStarts[line + 1] ?? text.length) - 1 : text.length
  return Math.min(start + Math.max(0, position.character), end)
}

/**
 * The edits as offsets into `text`, last first, so applying them in order never shifts one still to come.
 * Overlapping edits are invalid in LSP; the later of two is dropped rather than corrupting the text.
 */
export function editOffsets(text: string, edits: readonly TextEdit[]): { from: number; to: number; insert: string }[] {
  const lineStarts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1)
  const sorted = edits
    .map((edit) => ({ from: offsetOf(lineStarts, text, edit.range.start), to: offsetOf(lineStarts, text, edit.range.end), insert: edit.newText }))
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const kept: typeof sorted = []
  for (const edit of sorted) {
    const previous = kept.at(-1)
    if (previous && edit.from < previous.to) continue
    kept.push(edit)
  }
  return kept.reverse()
}
