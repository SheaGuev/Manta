import { getChunks, type Chunk } from '@codemirror/merge'
import { type Text } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'

/** Where every line of an insert-only chunk starts; with nothing on the other side, there are no words to compare. */
export function insertedOnlyLines(chunks: readonly Chunk[], doc: Text): number[] {
  const starts: number[] = []
  for (const chunk of chunks) {
    if (chunk.fromA !== chunk.toA || chunk.fromB === chunk.toB) continue
    const last = doc.lineAt(Math.min(chunk.endB, doc.length)).number
    for (let n = doc.lineAt(chunk.fromB).number; n <= last; n++) starts.push(doc.line(n).from)
  }
  return starts
}

const insertedOnly = Decoration.line({ class: 'cm-insertedOnly' })

function decorations(view: EditorView): DecorationSet {
  const chunks = getChunks(view.state)?.chunks ?? []
  return Decoration.set(insertedOnlyLines(chunks, view.state.doc).map((from) => insertedOnly.range(from)))
}

/**
 * Marks lines that were only added (a new file, or a new block) with `cm-insertedOnly`, so the CSS can drop
 * the word-by-word highlight there and keep just the line's green background.
 */
export const diffInsertions = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || getChunks(update.state) !== getChunks(update.startState)) this.decorations = decorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations }
)
