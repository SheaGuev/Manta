import { setDiagnostics, type Diagnostic } from '@codemirror/lint'
import { StateEffect, StateField, type Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** An LSP diagnostic, as servers push or return it. */
export interface ServerDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  message: string
  severity?: number
  source?: string
  code?: string | number
}

export function isServerDiagnostic(value: unknown): value is ServerDiagnostic {
  return typeof value === 'object' && value !== null && 'range' in value && 'message' in value && typeof value.message === 'string'
}

const SEVERITY: Record<number, Diagnostic['severity']> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' }

/** An LSP position as an offset, clamped: a server may report a position past the end of a line or the file. */
export function offsetIn(doc: Text, position: ServerDiagnostic['range']['start']): number {
  if (position.line >= doc.lines) return doc.length
  const line = doc.line(Math.max(1, position.line + 1))
  return Math.min(line.from + Math.max(0, position.character), line.to)
}

/** Server diagnostics as editor ones, positioned in `doc` and then through `mapPos` (edits made since). */
export function toDiagnostics({ doc, items, mapPos = (pos) => pos }: { doc: Text; items: readonly ServerDiagnostic[]; mapPos?: (pos: number) => number }): Diagnostic[] {
  return items.map((item) => {
    const from = mapPos(offsetIn(doc, item.range.start))
    const to = mapPos(offsetIn(doc, item.range.end))
    const code = item.code === undefined ? '' : ` (${item.code})`
    return { from, to: Math.max(from, to), severity: SEVERITY[item.severity ?? 1] ?? 'error', message: `${item.message}${code}`, ...(item.source ? { source: item.source } : {}) }
  })
}

const setSource = StateEffect.define<{ source: string; diagnostics: readonly Diagnostic[] }>()

/** Each server's diagnostics for the editor, kept in step with edits, so one server's report doesn't erase another's. */
const bySource = StateField.define<ReadonlyMap<string, readonly Diagnostic[]>>({
  create: () => new Map(),
  update(sources, tr) {
    let next = sources
    if (tr.docChanged) {
      next = new Map([...sources].map(([source, list]) => [source, list.map((d) => ({ ...d, from: tr.changes.mapPos(d.from), to: tr.changes.mapPos(d.to) }))]))
    }
    for (const effect of tr.effects) if (effect.is(setSource)) next = new Map(next).set(effect.value.source, effect.value.diagnostics)
    return next
  }
})

/** Shows one server's diagnostics in the editor, alongside every other server's. */
export function showDiagnostics({ view, source, diagnostics }: { view: EditorView; source: string; diagnostics: readonly Diagnostic[] }): void {
  const current = view.state.field(bySource, false)
  const others = current ? [...current].filter(([s]) => s !== source).flatMap(([, list]) => list) : []
  const lint = setDiagnostics(view.state, [...others, ...diagnostics])
  const lintEffects = lint.effects === undefined ? [] : Array.isArray(lint.effects) ? lint.effects : [lint.effects]
  const own = current === undefined ? StateEffect.appendConfig.of(bySource.init(() => new Map([[source, diagnostics]]))) : setSource.of({ source, diagnostics })
  view.dispatch({ effects: [own, ...lintEffects] })
}
