import { LSPPlugin } from '@codemirror/lsp-client'
import type { EditorView } from '@codemirror/view'
import { offsetIn } from './diagnosticSources'

/** A symbol in the file, flattened from the server's tree, in document order. */
export interface FileSymbol {
  name: string
  /** "function", "class" and so on. */
  kind: string
  /** The class or function it's inside, if any. */
  container: string | null
  /** Where its name starts. */
  from: number
}

/** LSP `SymbolKind`, 1-based. */
const KINDS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum member', 'struct', 'event', 'operator', 'type parameter']

type Range = { start: { line: number; character: number } }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

function rangeOf(value: unknown): Range | null {
  return isRecord(value) && isRecord(value.start) && typeof value.start.line === 'number' && typeof value.start.character === 'number'
    ? { start: { line: value.start.line, character: value.start.character } }
    : null
}

/**
 * The file's symbols from its language server (`textDocument/documentSymbol`), for Cmd+Shift+O; null when
 * the editor has no server or the server can't list them. Takes both answer shapes LSP allows.
 */
export async function fileSymbols(view: EditorView): Promise<FileSymbol[] | null> {
  const plugin = LSPPlugin.get(view)
  if (!plugin?.client.serverCapabilities?.documentSymbolProvider) return null
  plugin.client.sync()
  const doc = plugin.syncedDoc
  const response: unknown = await plugin.client.request('textDocument/documentSymbol', { textDocument: { uri: plugin.uri } })
  if (!Array.isArray(response)) return null
  const symbols: FileSymbol[] = []
  const walk = (items: unknown[], container: string | null): void => {
    for (const item of items) {
      if (!isRecord(item) || typeof item.name !== 'string') continue
      const location = isRecord(item.location) ? item.location.range : undefined
      const range = rangeOf(item.selectionRange) ?? rangeOf(item.range) ?? rangeOf(location)
      if (!range) continue
      const kind = typeof item.kind === 'number' ? (KINDS[item.kind - 1] ?? 'symbol') : 'symbol'
      const outer = typeof item.containerName === 'string' && item.containerName ? item.containerName : container
      symbols.push({ name: item.name, kind, container: outer, from: plugin.unsyncedChanges.mapPos(offsetIn(doc, range.start)) })
      if (Array.isArray(item.children)) walk(item.children, item.name)
    }
  }
  walk(response, null)
  return symbols.sort((a, b) => a.from - b.from)
}
