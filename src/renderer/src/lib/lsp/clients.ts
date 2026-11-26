import { LSPClient, type LSPClientExtension } from '@codemirror/lsp-client'
import DOMPurify from 'dompurify'
import type { LanguageServerRole, LanguageServerSession, LanguageServerStatus } from '../../../../shared/ipc'
import { isServerDiagnostic, showDiagnostics, toDiagnostics } from './diagnosticSources'
import { MantaWorkspace } from './mantaWorkspace'
import { relativeTo } from './fileUris'
import { ipcTransport } from './ipcTransport'
import { LintServer, logServerMessage } from './lintClient'
import { showFile } from './navigation'
import { nameDiagnosticSource, refreshDiagnostics } from './pullDiagnostics'

const api = window.manta
/** A server loading a big project answers its first requests slowly; lsp-client's default is 3 s. */
const REQUEST_TIMEOUT_MS = 15_000
/** A crashed server is reconnected after this, unless it keeps crashing (main then refuses). */
const RECONNECT_DELAY_MS = 500

export interface ServerClient {
  client: LSPClient
  /** Set for a lint server, which isn't driven through lsp-client's editor plugin. */
  lint: LintServer | null
  role: LanguageServerRole
  root: string
  rootUri: string
  server: string
  /** Shown to the user, e.g. "TypeScript". */
  name: string
  /** A language id the server takes, to open it again after a crash. */
  languageId: string
  session: string
}

/**
 * Tells servers that Manta's own file watcher reports changed files, and that errors are asked
 * for (`textDocument/diagnostic`); TypeScript 7 otherwise starts watchers of its own.
 */
const mantaCapabilities: LSPClientExtension = {
  clientCapabilities: {
    workspace: { didChangeWatchedFiles: { dynamicRegistration: true }, diagnostics: { refreshSupport: true } },
    textDocument: { diagnostic: { dynamicRegistration: false } }
  }
}

const byServer = new Map<string, ServerClient>()
const opening = new Map<string, Promise<ServerClient[]>>()
let watchingStatus = false

/** Pushed diagnostics (servers that don't wait to be asked), shown under the server's name. */
function pushedDiagnostics(client: LSPClient, name: string, params: unknown): void {
  if (typeof params !== 'object' || params === null || !('uri' in params) || typeof params.uri !== 'string' || !('diagnostics' in params) || !Array.isArray(params.diagnostics)) return
  const view = client.workspace.getFile(params.uri)?.getView()
  if (!view) return
  showDiagnostics({ view, source: name, diagnostics: toDiagnostics({ doc: view.state.doc, items: params.diagnostics.filter(isServerDiagnostic) }) })
}

function primaryClient({ root, session }: { root: string; session: LanguageServerSession }): LSPClient {
  const client: LSPClient = new LSPClient({
    rootUri: session.rootUri,
    timeout: REQUEST_TIMEOUT_MS,
    initializationOptions: session.initializationOptions,
    sanitizeHTML: (html) => DOMPurify.sanitize(html),
    workspace: (c) =>
      new MantaWorkspace(c, {
        showFile: (absolutePath) => showFile(root, { relPath: relativeTo(session.rootUri, `file://${absolutePath}`), absolutePath }),
        readFile: (absolutePath) => api.readOnlyFile(root, absolutePath),
        onSynced: () => refreshDiagnostics(client)
      }),
    notificationHandlers: {
      'workspace/diagnostic/refresh': () => {
        refreshDiagnostics(client)
        return true
      },
      'textDocument/publishDiagnostics': (_client, params: unknown) => {
        pushedDiagnostics(client, session.name, params)
        return true
      },
      'window/logMessage': (_client, params: unknown) => logServerMessage(session.name, params)
    },
    extensions: [mantaCapabilities]
  })
  nameDiagnosticSource(client, session.name)
  return client
}

function connect({ root, languageId, session }: { root: string; languageId: string; session: LanguageServerSession }): ServerClient {
  const key = `${root}\0${session.server}`
  const existing = byServer.get(key)
  if (existing) {
    if (existing.session !== session.session || !existing.client.connected) {
      if (existing.client.connected) existing.client.disconnect()
      existing.client.connect(ipcTransport(session.session))
      existing.session = session.session
    }
    return existing
  }
  const lint = session.role === 'lint' ? new LintServer(session.name, { rootUri: session.rootUri, initializationOptions: session.initializationOptions, timeout: REQUEST_TIMEOUT_MS }) : null
  const client = lint ? lint.client : primaryClient({ root, session })
  client.connect(ipcTransport(session.session))
  const created: ServerClient = { client, lint, role: session.role, root, rootUri: session.rootUri, server: session.server, name: session.name, languageId, session: session.session }
  byServer.set(key, created)
  return created
}

function onStatus(status: LanguageServerStatus): void {
  const held = [...byServer.values()].find((c) => c.session === status.session)
  if (!held || (status.state !== 'crashed' && status.state !== 'stopped')) return
  if (held.client.connected) held.client.disconnect()
  for (const key of [...opening.keys()]) if (key.startsWith(`${held.root}\0`)) opening.delete(key)
  const hasFiles = held.lint ? held.lint.hasOpenFiles : held.client.workspace.files.length > 0
  if (status.state === 'crashed' && status.canRestart && hasFiles) setTimeout(() => void clientsFor(held.root, held.languageId), RECONNECT_DELAY_MS)
}

/**
 * The connected LSP clients for files of `languageId` in `root`, the primary server first, then lint
 * servers; empty when none takes the language. One client per root and server: `.ts` and `.tsx` share.
 */
export function clientsFor(root: string, languageId: string, force = false): Promise<ServerClient[]> {
  if (!watchingStatus) {
    watchingStatus = true
    api.onLspStatus(onStatus)
  }
  const key = `${root}\0${languageId}`
  const cached = force ? undefined : opening.get(key)
  if (cached) return cached
  const next = api
    .lspOpen(root, languageId, force)
    .then((sessions) => sessions.map((session) => connect({ root, languageId, session })))
    .catch((error: unknown) => {
      opening.delete(key)
      throw error
    })
  opening.set(key, next)
  return next
}

const changeListeners = new Set<() => void>()

/** Plugins were installed, removed or switched: open editors ask main again for their servers. */
export function forgetOpenedServers(): void {
  opening.clear()
  for (const listener of changeListeners) listener()
}

export function onServersChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

/** The root a client serves, for edits to files without an open tab. */
export function clientRoot(client: LSPClient): { root: string; rootUri: string } | null {
  const held = [...byServer.values()].find((c) => c.client === client)
  return held ? { root: held.root, rootUri: held.rootUri } : null
}

/** The status bar's Restart: a fresh server, even after repeated crashes. */
export function restartServer(status: LanguageServerStatus): Promise<ServerClient[]> {
  return clientsFor(status.root, status.languageId, true)
}
