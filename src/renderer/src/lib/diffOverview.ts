import { getChunks, getOriginalDoc } from '@codemirror/merge'
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from '@codemirror/view'

/** One diff chunk in the unified view, in pixels from the top of the content: its deleted lines sit above its inserted ones. */
export interface ChunkGeometry {
  top: number
  deletedHeight: number
  insertedHeight: number
}

/** A mark in the overview strip, as fractions of the content's height. */
export interface OverviewMark {
  kind: 'added' | 'deleted'
  top: number
  height: number
}

/** Where each chunk's deleted and added lines sit in the document, scaled to the strip. */
export function overviewMarks(chunks: readonly ChunkGeometry[], contentHeight: number): OverviewMark[] {
  if (contentHeight <= 0) return []
  const fraction = (px: number): number => Math.min(1, Math.max(0, px / contentHeight))
  const marks: OverviewMark[] = []
  for (const chunk of chunks) {
    if (chunk.deletedHeight > 0) marks.push({ kind: 'deleted', top: fraction(chunk.top), height: fraction(chunk.deletedHeight) })
    if (chunk.insertedHeight > 0) {
      marks.push({ kind: 'added', top: fraction(chunk.top + chunk.deletedHeight), height: fraction(chunk.insertedHeight) })
    }
  }
  return marks
}

/** Reads each chunk's place from the view; off-screen heights are CodeMirror's estimates until they scroll into view. */
function measure(view: EditorView): ChunkGeometry[] {
  const chunks = getChunks(view.state)?.chunks ?? []
  const original = getOriginalDoc(view.state)
  return chunks.map((chunk) => {
    /** The deleted lines are a block widget at the start of the chunk's first line, so its line block starts with them. */
    const block = view.lineBlockAt(chunk.fromB)
    const deletedLines = chunk.toA > chunk.fromA ? original.lineAt(chunk.endA).number - original.lineAt(chunk.fromA).number + 1 : 0
    const deletedHeight = deletedLines * view.defaultLineHeight
    const insertedHeight = chunk.toB > chunk.fromB ? Math.max(0, view.lineBlockAt(chunk.endB).bottom - block.top - deletedHeight) : 0
    return { top: block.top, deletedHeight, insertedHeight }
  })
}

class Overview implements PluginValue {
  private readonly strip = document.createElement('div')

  constructor(private readonly view: EditorView) {
    this.strip.className = 'cm-diff-overview'
    view.dom.appendChild(this.strip)
    this.schedule()
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.geometryChanged || update.viewportChanged || getChunks(update.state) !== getChunks(update.startState)) this.schedule()
  }

  destroy(): void {
    this.strip.remove()
  }

  private schedule(): void {
    this.view.requestMeasure({
      key: this,
      read: (view) => overviewMarks(measure(view), view.contentHeight),
      write: (marks) => this.draw(marks)
    })
  }

  private draw(marks: OverviewMark[]): void {
    this.strip.replaceChildren(
      ...marks.map((mark) => {
        const el = document.createElement('div')
        el.className = `cm-diff-overview-mark ${mark.kind}`
        el.style.top = `${mark.top * 100}%`
        el.style.height = `${mark.height * 100}%`
        return el
      })
    )
  }
}

/**
 * Green and red marks over the scrollbar track where lines were added and deleted, for a unified merge view.
 * The strip ignores the pointer, so the scrollbar underneath still drags and pages.
 */
export const diffOverview = ViewPlugin.fromClass(Overview)
