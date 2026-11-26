import type { LSPClient, WorkspaceMapping } from '@codemirror/lsp-client'
import * as Y from 'yjs'
import { relativeTo } from './fileUris'
import { editOffsets, editsByUri, type TextEdit } from './workspaceEdits'

const api = window.manta
/** The origin main's updates carry, so applying one doesn't echo it back (as in `Editor`). */
const MAIN_ORIGIN = 'main'
/** `FileChangeType.Changed` in LSP. */
const FILE_CHANGED = 2

/** Where a client's files live, so edits to files without an open tab can reach them. */
export type ClientRoot = (client: LSPClient) => { root: string; rootUri: string } | null

/**
 * Edits a file that has no open tab through its Yjs doc in main, as the editor would, and saves it
 * at once, so the server reads the new text when told the file changed rather than after the debounce.
 */
async function editClosedFile({ root, relPath, edits }: { root: string; relPath: string; edits: TextEdit[] }): Promise<void> {
  const doc = new Y.Doc()
  try {
    Y.applyUpdate(doc, await api.openDoc(root, relPath), MAIN_ORIGIN)
    const text = doc.getText('md')
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== MAIN_ORIGIN) api.pushUpdate(root, relPath, update)
    })
    doc.transact(() => {
      for (const { from, to, insert } of editOffsets(text.toString(), edits)) {
        text.delete(from, to - from)
        text.insert(from, insert)
      }
    })
    await api.saveFile(root, relPath)
  } finally {
    doc.destroy()
  }
}

/**
 * Applies a server's `WorkspaceEdit` (from a rename or a quick fix): files with a tab through their
 * editor, mapped past edits made since the request; files without one through their Yjs doc in main,
 * saved at once and the server told, so it reads the new text.
 */
export async function applyWorkspaceEdit({ client, edit, mapping, clientRoot, userEvent }: { client: LSPClient; edit: unknown; mapping: WorkspaceMapping; clientRoot: ClientRoot; userEvent: string }): Promise<void> {
  const where = clientRoot(client)
  for (const [uri, edits] of editsByUri(edit)) {
    const open = client.workspace.getFile(uri)
    if (open) {
      /** By the file's own URI: the mapping is keyed by it, and the server may encode the URI differently. */
      const changes = edits.map((e) => ({ from: mapping.mapPosition(open.uri, e.range.start), to: mapping.mapPosition(open.uri, e.range.end), insert: e.newText }))
      client.workspace.updateFile(open.uri, { changes, userEvent })
      continue
    }
    const relPath = where ? relativeTo(where.rootUri, uri) : null
    if (!where || !relPath) continue
    await editClosedFile({ root: where.root, relPath, edits })
    client.notification('workspace/didChangeWatchedFiles', { changes: [{ uri, type: FILE_CHANGED }] })
  }
}
