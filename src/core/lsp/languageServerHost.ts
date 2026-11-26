import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LanguageServerSession, LanguageServerState, LanguageServerStatus } from '../../shared/ipc'
import { frame, MessageReader } from './framing'
import type { LanguageServerSpec } from './serverCatalog'

/** With no file of its open for this long, a server is stopped; opening one starts it again. */
const IDLE_STOP_MS = 10 * 60_000
/** A server that crashes this often within the window isn't started again until the user asks. */
const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 3 * 60_000
/** How long a server gets to exit after `shutdown` and `exit` before it is killed. */
const EXIT_GRACE_MS = 1000
const STDERR_LINES = 20
/** Ids of requests the host sends itself, so their responses aren't passed to the renderer. */
const HOST_REQUEST = 'manta:'
/** `window/logMessage` types: 1 error, 2 warning, 3 info, 4 log. Servers log every request at info; those stay in main. */
const LOG_INFO = 3
/** `MANTA_LSP_TRACE=1` logs each message's direction and method (or id), to see what a server is sent and says. */
const TRACE = process.env.MANTA_LSP_TRACE === '1'

function trace(direction: '→' | '←', server: { spec: { id: string } }, message: string): void {
  if (!TRACE) return
  const method = /"method"\s*:\s*"([^"]+)"/.exec(message)?.[1]
  const id = /"id"\s*:\s*("?[^,}"]+"?)/.exec(message)?.[1]
  if (method === 'window/logMessage') return
  console.log(`manta:lsp ${direction} ${server.spec.id} ${method ?? 'response'}${id ? ` #${id}` : ''} ${message.slice(0, 400)}`)
}

export type FileChangeType = 'created' | 'changed' | 'deleted'

const FILE_CHANGE_TYPE: Record<FileChangeType, number> = { created: 1, changed: 2, deleted: 3 }

export interface LanguageServerHostOptions {
  /** Read on every open, since installing a plugin adds servers. */
  catalog: () => readonly LanguageServerSpec[]
  /** The environment servers start with: the user's login shell's, so project tools are on the PATH. */
  env: () => Promise<Record<string, string>>
  onMessage: (session: string, message: string) => void
  onStatus: (status: LanguageServerStatus) => void
  idleStopMs?: number
  now?: () => number
}

interface RunningServer {
  session: string
  owner: string
  languageId: string
  key: string
  root: string
  spec: LanguageServerSpec
  child: ChildProcess
  state: LanguageServerState
  stopping: boolean
  /** URIs the client has open, from its `didOpen` and `didClose`. */
  openFiles: Set<string>
  idleTimer: NodeJS.Timeout | null
  stderr: string[]
  /** The server registered for `workspace/didChangeWatchedFiles`, so file events from Manta's watcher go to it. */
  watchesFiles: boolean
  /** The id of the client's `initialize` request; its response means the server is ready. */
  initializeId: unknown
  exited: Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A `workspace/configuration` section such as `yaml` or `python.analysis`; the whole settings without one. */
function settingAt(settings: Record<string, unknown> | null, section: string | null): unknown {
  if (!settings) return null
  if (!section) return settings
  let value: unknown = settings
  for (const key of section.split('.')) value = isRecord(value) ? value[key] : undefined
  return value ?? null
}

function parse(message: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(message)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

/**
 * Language servers for the renderer's LSP clients, one process per root and server, talking JSON-RPC
 * over stdio. Main passes messages through untouched, except for a few requests from the server that
 * the client doesn't answer (configuration, capability registration, progress), which it answers here.
 */
export class LanguageServerHost {
  private readonly servers = new Map<string, RunningServer>()
  private readonly crashes = new Map<string, number[]>()
  private readonly opening = new Map<string, Promise<LanguageServerSession | null>>()
  /** The last status of servers that crashed, by key, until one starts there again. */
  private readonly crashed = new Map<string, LanguageServerStatus>()
  private readonly now: () => number

  constructor(private readonly options: LanguageServerHostOptions) {
    this.now = options.now ?? Date.now
  }

  /** The servers for a language, the primary one first. */
  specsFor(languageId: string): LanguageServerSpec[] {
    const specs = this.options.catalog().filter((spec) => spec.languages.includes(languageId))
    return [...specs.filter((s) => s.role === 'primary').slice(0, 1), ...specs.filter((s) => s.role === 'lint')]
  }

  /**
   * The server for `languageId` in `root`. `owner` identifies the client: the same owner gets the server
   * it already has (`.ts` and `.tsx` share one), another owner (a reloaded window) gets a fresh one,
   * since a server takes one `initialize`. `force` restarts it, even after repeated crashes.
   */
  async open({ root, languageId, owner, force }: { root: string; languageId: string; owner: string; force: boolean }): Promise<LanguageServerSession[]> {
    const real = await realpath(root)
    const sessions: LanguageServerSession[] = []
    for (const spec of this.specsFor(languageId)) {
      const session = await this.openSpec({ spec, root: real, languageId, owner, force })
      if (session) sessions.push(session)
    }
    return sessions
  }

  /**
   * One open at a time per root and server: two editors opening at once (a `.ts` and a `.tsx`) would
   * otherwise both start a process, and the one overwritten in `servers` would never be stopped.
   */
  private openSpec(options: { spec: LanguageServerSpec; root: string; languageId: string; owner: string; force: boolean }): Promise<LanguageServerSession | null> {
    const key = `${options.root}\0${options.spec.id}`
    const next = (this.opening.get(key) ?? Promise.resolve(null)).catch(() => null).then(() => this.openSpecNow(options))
    this.opening.set(key, next)
    void next.finally(() => {
      if (this.opening.get(key) === next) this.opening.delete(key)
    })
    return next
  }

  private async openSpecNow({ spec, root: real, languageId, owner, force }: { spec: LanguageServerSpec; root: string; languageId: string; owner: string; force: boolean }): Promise<LanguageServerSession | null> {
    const key = `${real}\0${spec.id}`
    if (!force && this.recentCrashes(key) >= MAX_CRASHES) return null
    const previous = this.servers.get(key)
    if (previous && previous.owner === owner && !force && !previous.stopping) return this.session(previous)
    if (force) this.crashes.delete(key)
    this.crashed.delete(key)
    if (previous) await this.stop(previous)
    const launch = await spec.launch(real)
    if (!launch) return null
    const env = { ...(await this.options.env()), ...launch.env }
    const child = spawn(launch.command, launch.args, { cwd: real, env, stdio: ['pipe', 'pipe', 'pipe'] })
    const server: RunningServer = {
      session: randomUUID(),
      owner,
      languageId,
      key,
      root: real,
      spec,
      child,
      state: 'starting',
      stopping: false,
      openFiles: new Set(),
      idleTimer: null,
      stderr: [],
      watchesFiles: false,
      initializeId: undefined,
      exited: new Promise((resolve) => child.once('exit', () => resolve()))
    }
    this.servers.set(key, server)
    const reader = new MessageReader()
    child.stdout?.on('data', (chunk: Buffer) => {
      for (const message of reader.push(chunk)) this.fromServer(server, message)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      server.stderr.push(...chunk.toString('utf8').split('\n').filter(Boolean))
      server.stderr.splice(0, Math.max(0, server.stderr.length - STDERR_LINES))
    })
    /** A failed spawn (missing binary) reports here, then as an exit. */
    child.on('error', (error) => server.stderr.push(error.message))
    child.stdin?.on('error', () => undefined)
    child.once('exit', (code, signal) => this.exited(server, code, signal))
    this.report(server)
    this.armIdle(server)
    return this.session(server)
  }

  private session(server: RunningServer): LanguageServerSession {
    const { spec } = server
    return { session: server.session, server: spec.id, name: spec.name, role: spec.role, initializationOptions: spec.initializationOptions ?? null, rootUri: pathToFileURL(server.root).href }
  }

  /** A message from the session's client. Messages for a session that has ended are dropped. */
  send(session: string, message: string): void {
    const server = this.bySession(session)
    if (!server || server.stopping) return
    this.track(server, message)
    this.write(server, message.includes('"initialize"') ? this.withWorkspace(server, message) : message)
    if (message.includes('"initialized"') && server.spec.settings && parse(message)?.method === 'initialized') {
      /** Servers like YAML's and JSON's take settings pushed this way, never asking for them. */
      this.write(server, JSON.stringify({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: server.spec.settings(server.root) } }))
    }
  }

  /**
   * lsp-client's `initialize` names only the root URI; some servers (GraphQL's, Bash's) need it as a
   * workspace folder, and only ask for their settings when the client says it answers them.
   */
  private withWorkspace(server: RunningServer, message: string): string {
    const value = parse(message)
    if (!value || value.method !== 'initialize' || !isRecord(value.params)) return message
    const params = value.params
    const capabilities = isRecord(params.capabilities) ? params.capabilities : {}
    const workspace = isRecord(capabilities.workspace) ? capabilities.workspace : {}
    return JSON.stringify({
      ...value,
      params: {
        ...params,
        workspaceFolders: Array.isArray(params.workspaceFolders) ? params.workspaceFolders : [this.workspaceFolder(server)],
        capabilities: { ...capabilities, workspace: { ...workspace, configuration: true, workspaceFolders: true } }
      }
    })
  }

  private workspaceFolder(server: RunningServer): { uri: string; name: string } {
    return { uri: pathToFileURL(server.root).href, name: path.basename(server.root) }
  }

  /** File events from Manta's watcher, for servers that asked to be told; paths are absolute. */
  filesChanged(root: string, changes: { path: string; type: FileChangeType }[]): void {
    if (changes.length === 0) return
    for (const server of this.servers.values()) {
      if (!server.watchesFiles || server.stopping || !(root === server.root || root.startsWith(`${server.root}/`))) continue
      const params = { changes: changes.map((change) => ({ uri: pathToFileURL(change.path).href, type: FILE_CHANGE_TYPE[change.type] })) }
      this.write(server, JSON.stringify({ jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles', params }))
    }
  }

  list(): LanguageServerStatus[] {
    return [...[...this.servers.values()].map((server) => this.status(server)), ...this.crashed.values()]
  }

  /** Stops every running server with one of these ids, in every root: a plugin removed or switched off. */
  async stopServers(ids: readonly string[]): Promise<void> {
    await Promise.all([...this.servers.values()].filter((s) => ids.includes(s.spec.id)).map((server) => this.stop(server)))
  }

  /** Stops every server in `root` or below it: a worktree or project going away. */
  async closeRoot(root: string): Promise<void> {
    const real = await realpath(root).catch(() => root)
    const closing = [...this.servers.values()].filter((s) => s.root === real || s.root.startsWith(`${real}/`))
    for (const [key, status] of this.crashed) if (status.root === real || status.root.startsWith(`${real}/`)) this.crashed.delete(key)
    await Promise.all(closing.map((server) => this.stop(server)))
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.servers.values()].map((server) => this.stop(server)))
  }

  private bySession(session: string): RunningServer | null {
    for (const server of this.servers.values()) if (server.session === session) return server
    return null
  }

  private track(server: RunningServer, message: string): void {
    /** Only these change what the host tracks; skip parsing every keystroke's `didChange`. */
    if (!message.includes('"initialize"') && !message.includes('textDocument/did')) return
    const value = parse(message)
    if (!value) return
    if (value.method === 'initialize') server.initializeId = value.id
    const params = isRecord(value.params) ? value.params : null
    const document = params && isRecord(params.textDocument) ? params.textDocument : null
    const uri = document && typeof document.uri === 'string' ? document.uri : null
    if (!uri) return
    if (value.method === 'textDocument/didOpen') server.openFiles.add(uri)
    else if (value.method === 'textDocument/didClose') server.openFiles.delete(uri)
    else return
    this.armIdle(server)
  }

  private armIdle(server: RunningServer): void {
    if (server.idleTimer) clearTimeout(server.idleTimer)
    server.idleTimer = null
    if (server.openFiles.size > 0) return
    server.idleTimer = setTimeout(() => void this.stop(server), this.options.idleStopMs ?? IDLE_STOP_MS)
    server.idleTimer.unref()
  }

  private fromServer(server: RunningServer, message: string): void {
    trace('←', server, message)
    /** Most messages are responses and notifications to pass on as they are; parse only those the host may act on. */
    const value = server.state === 'starting' || message.includes('"method"') || message.includes(HOST_REQUEST) ? parse(message) : null
    if (value) {
      if (typeof value.id === 'string' && value.id.startsWith(HOST_REQUEST)) return
      if (typeof value.method === 'string' && value.id !== undefined) return this.answer(server, value.id, value.method, value.params)
      if (value.method === 'window/logMessage' && isRecord(value.params) && typeof value.params.type === 'number' && value.params.type >= LOG_INFO) return
      if (server.state === 'starting' && server.initializeId !== undefined && value.id === server.initializeId && 'result' in value) {
        server.state = 'ready'
        this.report(server)
      }
    }
    this.options.onMessage(server.session, message)
  }

  /** Requests from the server that the renderer's client would refuse; refusing some makes servers stop working. */
  private answer(server: RunningServer, id: unknown, method: string, params: unknown): void {
    const respond = (result: unknown): void => this.write(server, JSON.stringify({ jsonrpc: '2.0', id, result }))
    switch (method) {
      case 'workspace/configuration': {
        const items = isRecord(params) && Array.isArray(params.items) ? params.items : []
        const settings = server.spec.settings?.(server.root) ?? null
        return respond(items.map((item: unknown) => settingAt(settings, isRecord(item) && typeof item.section === 'string' ? item.section : null)))
      }
      case 'client/registerCapability': {
        const registrations = isRecord(params) && Array.isArray(params.registrations) ? params.registrations : []
        if (registrations.some((r: unknown) => isRecord(r) && r.method === 'workspace/didChangeWatchedFiles')) server.watchesFiles = true
        return respond(null)
      }
      case 'workspace/workspaceFolders':
        return respond([this.workspaceFolder(server)])
      case 'client/unregisterCapability':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        return respond(null)
      case 'workspace/diagnostic/refresh':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/inlayHint/refresh':
      case 'workspace/codeLens/refresh':
        respond(null)
        /** The client re-asks for what's stale when it sees the same method as a notification. */
        return this.options.onMessage(server.session, JSON.stringify({ jsonrpc: '2.0', method }))
      case 'workspace/applyEdit':
        return respond({ applied: false, failureReason: 'Manta applies edits only from the editor' })
      default: {
        const handler = server.spec.requests?.[method]
        if (handler) {
          Promise.resolve()
            .then(() => handler(params))
            .then(respond, (error: unknown) => this.write(server, JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })))
          return
        }
        this.write(server, JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `${method} is not supported` } }))
      }
    }
  }

  private write(server: RunningServer, message: string): void {
    trace('→', server, message)
    if (server.child.stdin?.writable) server.child.stdin.write(frame(message))
  }

  private async stop(server: RunningServer): Promise<void> {
    if (this.servers.get(server.key) === server) this.servers.delete(server.key)
    if (server.idleTimer) clearTimeout(server.idleTimer)
    if (server.child.exitCode !== null || server.child.signalCode !== null) return
    if (!server.stopping) {
      server.stopping = true
      this.write(server, JSON.stringify({ jsonrpc: '2.0', id: `${HOST_REQUEST}shutdown`, method: 'shutdown', params: null }))
      this.write(server, JSON.stringify({ jsonrpc: '2.0', method: 'exit', params: null }))
      server.child.stdin?.end()
    }
    const killed = setTimeout(() => server.child.kill('SIGKILL'), EXIT_GRACE_MS)
    await server.exited
    clearTimeout(killed)
  }

  private exited(server: RunningServer, code: number | null, signal: NodeJS.Signals | null): void {
    if (server.idleTimer) clearTimeout(server.idleTimer)
    if (this.servers.get(server.key) === server) this.servers.delete(server.key)
    if (server.stopping) {
      server.state = 'stopped'
      return this.report(server)
    }
    server.state = 'crashed'
    const times = [...(this.crashes.get(server.key) ?? []), this.now()]
    this.crashes.set(server.key, times)
    const why = server.stderr.slice(-3).join('\n') || `exited with ${signal ?? `code ${code}`}`
    this.crashed.set(server.key, this.status(server, why))
    this.report(server, why)
  }

  private recentCrashes(key: string): number {
    const since = this.now() - CRASH_WINDOW_MS
    const recent = (this.crashes.get(key) ?? []).filter((t) => t >= since)
    this.crashes.set(key, recent)
    return recent.length
  }

  private status(server: RunningServer, message: string | null = null): LanguageServerStatus {
    return {
      session: server.session,
      root: server.root,
      server: server.spec.id,
      name: server.spec.name,
      languageId: server.languageId,
      state: server.state,
      message,
      canRestart: this.recentCrashes(server.key) < MAX_CRASHES
    }
  }

  private report(server: RunningServer, message: string | null = null): void {
    this.options.onStatus(this.status(server, message))
  }
}
