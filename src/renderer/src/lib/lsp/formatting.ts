import { getIndentUnit, indentUnit } from '@codemirror/language'
import { LSPPlugin } from '@codemirror/lsp-client'
import type { EditorView } from '@codemirror/view'
import { editOffsets, isTextEdit } from './workspaceEdits'

/**
 * Formats the editor's file with its language server (`textDocument/formatting`), for projects without
 * a formatter of their own. False when there's no server, it can't format, or the text moved on meanwhile.
 */
export async function formatWithServer(view: EditorView): Promise<boolean> {
  const plugin = LSPPlugin.get(view)
  if (!plugin?.client.serverCapabilities?.documentFormattingProvider) return false
  plugin.client.sync()
  const doc = plugin.syncedDoc
  const options = { tabSize: getIndentUnit(view.state), insertSpaces: view.state.facet(indentUnit) !== '\t' }
  const response = await plugin.client.request('textDocument/formatting', { textDocument: { uri: plugin.uri }, options })
  if (!Array.isArray(response) || plugin.syncedDoc !== doc) return false
  const changes = editOffsets(doc.toString(), response.filter(isTextEdit))
    .reverse()
    .map(({ from, to, insert }) => ({ from: plugin.unsyncedChanges.mapPos(from), to: plugin.unsyncedChanges.mapPos(to), insert }))
  if (changes.length > 0) view.dispatch({ changes, userEvent: 'format' })
  return true
}
