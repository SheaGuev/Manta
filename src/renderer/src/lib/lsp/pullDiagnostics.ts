import { LSPPlugin, type LSPClient } from '@codemirror/lsp-client'
import { ViewPlugin, type EditorView, type ViewUpdate } from '@codemirror/view'
import { isServerDiagnostic, showDiagnostics, toDiagnostics, type ServerDiagnostic } from './diagnosticSources'

/** Typing pauses this long before the server is asked for the file's errors again. */
const PULL_DELAY_MS = 400

type Pull = () => void

const pullsByClient = new Map<LSPClient, Set<Pull>>()
const sourceNames = new WeakMap<LSPClient, string>()
/** The last report's diagnostics as the server sent them, per editor: a quick fix request passes them back. */
const lastReport = new WeakMap<EditorView, ServerDiagnostic[]>()

/** The primary server's diagnostics touching a 0-based line, as it sent them. */
export function serverDiagnosticsAt(view: EditorView, line: number): ServerDiagnostic[] {
  return (lastReport.get(view) ?? []).filter((d) => d.range.start.line <= line && d.range.end.line >= line)
}

/** The name a client's diagnostics are kept under, e.g. "TypeScript". */
export function nameDiagnosticSource(client: LSPClient, name: string): void {
  sourceNames.set(client, name)
}

/** Asks again for every open file's errors: another file changed, or the server said they're stale. */
export function refreshDiagnostics(client: LSPClient): void {
  for (const pull of pullsByClient.get(client) ?? []) pull()
}

function reportItems(report: unknown): ServerDiagnostic[] | null {
  if (typeof report !== 'object' || report === null || !('kind' in report) || report.kind !== 'full') return null
  return 'items' in report && Array.isArray(report.items) ? report.items.filter(isServerDiagnostic) : []
}

/**
 * Errors from servers that report them when asked (`textDocument/diagnostic`), as TypeScript 7 does:
 * the client only handles servers that push them. Asks after the file opens and when typing pauses.
 */
export const pullDiagnostics = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null
    private readonly pull: Pull
    private client: LSPClient | null = null

    constructor(private readonly view: EditorView) {
      this.pull = () => this.schedule(PULL_DELAY_MS)
      this.schedule(0)
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.schedule(PULL_DELAY_MS)
    }

    destroy(): void {
      if (this.timer) clearTimeout(this.timer)
      if (this.client) pullsByClient.get(this.client)?.delete(this.pull)
    }

    private schedule(delay: number): void {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => void this.run(), delay)
    }

    private async run(): Promise<void> {
      const plugin = LSPPlugin.get(this.view)
      if (!plugin) return
      this.register(plugin.client)
      try {
        await plugin.client.initializing
        if (!plugin.client.serverCapabilities?.diagnosticProvider) return
        plugin.client.sync()
        const doc = plugin.syncedDoc
        const report = await plugin.client.request('textDocument/diagnostic', { textDocument: { uri: plugin.uri } })
        const items = reportItems(report)
        /** Edits made while the server answered make the positions stale; the pull those edits scheduled will replace them. */
        if (!items || plugin.syncedDoc !== doc) return
        lastReport.set(this.view, items)
        const diagnostics = toDiagnostics({ doc, items, mapPos: (pos) => plugin.unsyncedChanges.mapPos(pos) })
        showDiagnostics({ view: this.view, source: this.source(plugin.client), diagnostics })
      } catch {
        /** A server busy loading a big project can time out; the next edit or refresh asks again. */
      }
    }

    /** Diagnostics are kept per server, so this server's replace only its own. */
    private source(client: LSPClient): string {
      return sourceNames.get(client) ?? 'server'
    }

    private register(client: LSPClient): void {
      if (this.client === client) return
      this.client = client
      const pulls = pullsByClient.get(client) ?? new Set<Pull>()
      pulls.add(this.pull)
      pullsByClient.set(client, pulls)
    }
  }
)
