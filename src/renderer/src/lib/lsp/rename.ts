import { LSPPlugin } from '@codemirror/lsp-client'
import { showDialog, type Command, type EditorView } from '@codemirror/view'
import { applyWorkspaceEdit, type ClientRoot } from './applyEdit'

export type { ClientRoot } from './applyEdit'

async function rename({ view, pos, newName, clientRoot }: { view: EditorView; pos: number; newName: string; clientRoot: ClientRoot }): Promise<void> {
  const plugin = LSPPlugin.get(view)
  if (!plugin) return
  const { client } = plugin
  client.sync()
  try {
    await client.withMapping(async (mapping) => {
      const edit = await client.request('textDocument/rename', { textDocument: { uri: plugin.uri }, position: plugin.toPosition(pos), newName })
      await applyWorkspaceEdit({ client, edit, mapping, clientRoot, userEvent: 'rename' })
    })
  } catch (error) {
    plugin.reportError('Rename failed', error)
  }
}

/**
 * F2: renames the symbol at the cursor everywhere the server says, including files without an open
 * tab, which lsp-client's own rename skips.
 */
export function renameAcrossFiles(clientRoot: ClientRoot): Command {
  return (view) => {
    const plugin = LSPPlugin.get(view)
    const word = view.state.wordAt(view.state.selection.main.head)
    if (!plugin || !word || !plugin.client.serverCapabilities?.renameProvider) return false
    const current = view.state.sliceDoc(word.from, word.to)
    const { close, result } = showDialog(view, {
      label: 'New name',
      input: { name: 'name', value: current },
      focus: true,
      submitLabel: 'Rename',
      class: 'cm-lsp-rename-panel'
    })
    void result.then((form) => {
      view.dispatch({ effects: close })
      const field = form?.elements.namedItem('name')
      if (!(field instanceof HTMLInputElement) || !field.value.trim() || field.value === current) return
      return rename({ view, pos: word.from, newName: field.value.trim(), clientRoot })
    })
    return true
  }
}
