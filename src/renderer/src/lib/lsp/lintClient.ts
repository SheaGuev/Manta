import { LSPClient, Workspace, type WorkspaceFile } from '@codemirror/lsp-client'
import type { Extension } from '@codemirror/state'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { isServerDiagnostic, showDiagnostics, toDiagnostics } from './diagnosticSources'
import { uriPath } from './fileUris'

/**
 * A server's log line, as a warning under its name. lsp-client logs a server's own "error" lines as
 * console errors, but they are the server's business (a missing optional file), not the app failing.
 */
export function logServerMessage(name: string, params: unknown): boolean {
  if (typeof params === 'object' && params !== null && 'type' in params && 'message' in params && typeof params.type === 'number' && params.type <= 2) {
    console.warn(`[${name}] ${String(params.message)}`)
  }
  return true
}

/** Typing pauses this long before a lint server gets the file's new text. */
const CHANGE_DELAY_MS = 300

/** lsp-client's workspace, unused: a lint server's files are tracked by `LintServer` itself. */
class LintWorkspace extends Workspace {
  files: WorkspaceFile[] = []

  constructor(
    client: LSPClient,
    private readonly onConnected: () => void
  ) {
    super(client)
  }

  syncFiles(): readonly never[] {
    return []
  }

  openFile(): void {}

  closeFile(): void {}

  override connected(): void {
    this.onConnected()
  }
}

interface OpenFile {
  uri: string
  languageId: string
  version: number
  views: EditorView[]
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * A lint server (ESLint, Biome, Ruff) beside a file's primary server. lsp-client drives one server
 * per editor, so this one gets its files directly: opened, sent in full after typing pauses, and its
 * diagnostics (pushed, or asked for when it only answers) shown beside the primary server's.
 */
export class LintServer {
  readonly client: LSPClient
  private readonly files = new Map<string, OpenFile>()

  constructor(
    readonly name: string,
    config: { rootUri: string; initializationOptions: unknown; timeout: number }
  ) {
    this.client = new LSPClient({
      rootUri: config.rootUri,
      timeout: config.timeout,
      initializationOptions: config.initializationOptions,
      workspace: (client) => new LintWorkspace(client, () => this.reopenAll()),
      notificationHandlers: {
        'textDocument/publishDiagnostics': (_client, params: unknown) => {
          this.pushed(params)
          return true
        },
        'window/logMessage': (_client, params: unknown) => logServerMessage(name, params),
        'workspace/diagnostic/refresh': () => {
          for (const file of this.files.values()) void this.pull(file)
          return true
        }
      },
      extensions: [
        {
          clientCapabilities: {
            workspace: { didChangeWatchedFiles: { dynamicRegistration: true }, diagnostics: { refreshSupport: true } },
            textDocument: { diagnostic: { dynamicRegistration: false }, publishDiagnostics: { versionSupport: false } }
          }
        }
      ]
    })
  }

  get hasOpenFiles(): boolean {
    return this.files.size > 0
  }

  /** The editor extension tying one view of `uri` to this server. */
  editorExtension({ uri, languageId }: { uri: string; languageId: string }): Extension {
    return ViewPlugin.define((view) => {
      void this.open({ uri, languageId, view })
      return {
        update: (update: ViewUpdate) => {
          if (update.docChanged) this.changed(uri)
        },
        destroy: () => this.close(uri, view)
      }
    })
  }

  private async open({ uri, languageId, view }: { uri: string; languageId: string; view: EditorView }): Promise<void> {
    const existing = this.files.get(uri)
    if (existing) {
      existing.views.push(view)
      return
    }
    const file: OpenFile = { uri, languageId, version: 0, views: [view], timer: null }
    this.files.set(uri, file)
    await this.client.initializing
    if (this.files.get(uri) !== file) return
    this.sendOpen(file)
  }

  private sendOpen(file: OpenFile): void {
    const view = file.views[0]
    if (!view || !this.client.connected) return
    this.client.notification('textDocument/didOpen', { textDocument: { uri: file.uri, languageId: file.languageId, version: file.version, text: view.state.doc.toString() } })
    void this.pull(file)
  }

  private changed(uri: string): void {
    const file = this.files.get(uri)
    if (!file) return
    if (file.timer) clearTimeout(file.timer)
    file.timer = setTimeout(() => {
      file.timer = null
      const view = file.views[0]
      if (!view || !this.client.connected) return
      file.version++
      this.client.notification('textDocument/didChange', { textDocument: { uri, version: file.version }, contentChanges: [{ text: view.state.doc.toString() }] })
      void this.pull(file)
    }, CHANGE_DELAY_MS)
  }

  private close(uri: string, view: EditorView): void {
    const file = this.files.get(uri)
    if (!file) return
    file.views.splice(file.views.indexOf(view), 1)
    if (file.views.length > 0) return
    if (file.timer) clearTimeout(file.timer)
    this.files.delete(uri)
    if (this.client.connected) this.client.notification('textDocument/didClose', { textDocument: { uri } })
  }

  /** After a reconnect the new server process knows no files. */
  private reopenAll(): void {
    for (const file of this.files.values()) this.sendOpen(file)
  }

  private async pull(file: OpenFile): Promise<void> {
    if (!this.client.serverCapabilities?.diagnosticProvider) return
    const view = file.views[0]
    if (!view) return
    const doc = view.state.doc
    try {
      const report: unknown = await this.client.request('textDocument/diagnostic', { textDocument: { uri: file.uri } })
      if (typeof report !== 'object' || report === null || !('kind' in report) || report.kind !== 'full' || !('items' in report) || !Array.isArray(report.items)) return
      if (view.state.doc !== doc) return
      showDiagnostics({ view, source: this.name, diagnostics: toDiagnostics({ doc, items: report.items.filter(isServerDiagnostic) }) })
    } catch {
      /** The next change asks again. */
    }
  }

  private pushed(params: unknown): void {
    if (typeof params !== 'object' || params === null || !('uri' in params) || typeof params.uri !== 'string' || !('diagnostics' in params) || !Array.isArray(params.diagnostics)) return
    const path = uriPath(params.uri)
    const file = [...this.files.values()].find((f) => uriPath(f.uri) === path)
    const items = params.diagnostics.filter(isServerDiagnostic)
    for (const view of file?.views ?? []) showDiagnostics({ view, source: this.name, diagnostics: toDiagnostics({ doc: view.state.doc, items }) })
  }
}
