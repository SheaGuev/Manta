import { LSPPlugin, Workspace, type LSPClient, type WorkspaceFile } from '@codemirror/lsp-client'
import { Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { uriPath } from './fileUris'

/** lsp-client doesn't export this type, only the method returning it. */
type WorkspaceFileUpdate = ReturnType<Workspace['syncFiles']>[number]

/** Puts a file in front of the user for a jump to it; resolves with its editor once that has mounted. */
export type ShowFile = (absolutePath: string) => Promise<EditorView | null>

class MantaFile implements WorkspaceFile {
  readonly views: EditorView[] = []

  constructor(
    readonly uri: string,
    readonly languageId: string,
    public version: number,
    public doc: Text
  ) {}

  getView(main?: EditorView): EditorView | null {
    return main && this.views.includes(main) ? main : (this.views[0] ?? null)
  }
}

/**
 * The files an LSP client has open: one per editor tab of a code file in the client's root. Unlike
 * the default workspace it allows several views of a file, matches URIs by path (servers encode them
 * their own way), and opens other files' tabs for a jump to definition.
 */
export class MantaWorkspace extends Workspace {
  files: MantaFile[] = []
  private readonly versions = new Map<string, number>()

  constructor(
    client: LSPClient,
    private readonly options: {
      showFile: ShowFile
      /** A file's text from disk, for files without a tab (a references list shows their lines). */
      readFile: (absolutePath: string) => Promise<string | null>
      onSynced: () => void
    }
  ) {
    super(client)
  }

  override getFile(uri: string): MantaFile | null {
    const path = uriPath(uri)
    return this.files.find((file) => uriPath(file.uri) === path) ?? null
  }

  syncFiles(): readonly WorkspaceFileUpdate[] {
    const updates: WorkspaceFileUpdate[] = []
    for (const file of this.files) {
      const [main, ...others] = file.views
      const plugin = main ? LSPPlugin.get(main) : null
      /** Every view of a file shows the same Yjs text, so the first view's changes stand for all of them. */
      for (const other of others) LSPPlugin.get(other)?.clear()
      if (!main || !plugin || plugin.unsyncedChanges.empty) continue
      updates.push({ file, prevDoc: file.doc, changes: plugin.unsyncedChanges })
      file.doc = main.state.doc
      file.version = this.nextVersion(file.uri)
      plugin.clear()
    }
    if (updates.length > 0) this.options.onSynced()
    return updates
  }

  openFile(uri: string, languageId: string, view: EditorView): void {
    const open = this.getFile(uri)
    if (open) {
      open.views.push(view)
      return
    }
    const file = new MantaFile(uri, languageId, this.nextVersion(uri), view.state.doc)
    file.views.push(view)
    this.files.push(file)
    this.client.didOpen(file)
  }

  closeFile(uri: string, view: EditorView): void {
    const file = this.getFile(uri)
    if (!file) return
    file.views.splice(file.views.indexOf(view), 1)
    if (file.views.length > 0) return
    this.files = this.files.filter((f) => f !== file)
    this.client.didClose(file.uri)
  }

  /** After a reconnect: the server gets each file as it is now, not as it was last synced. */
  override connected(): void {
    for (const file of this.files) {
      const main = file.views[0]
      if (main) {
        file.doc = main.state.doc
        LSPPlugin.get(main)?.clear()
      }
      file.version = this.nextVersion(file.uri)
      this.client.didOpen(file)
    }
  }

  /** A file without a tab comes back as its text on disk, with no view; lsp-client's default returns nothing for it. */
  override async requestFile(uri: string): Promise<WorkspaceFile | null> {
    const open = this.getFile(uri)
    if (open) return open
    const text = await this.options.readFile(uriPath(uri)).catch(() => null)
    if (text === null) return null
    return { uri, languageId: '', version: 0, doc: Text.of(text.split('\n')), getView: () => null }
  }

  override displayFile(uri: string): Promise<EditorView | null> {
    return this.options.showFile(uriPath(uri))
  }

  private nextVersion(uri: string): number {
    const version = (this.versions.get(uri) ?? -1) + 1
    this.versions.set(uri, version)
    return version
  }
}
