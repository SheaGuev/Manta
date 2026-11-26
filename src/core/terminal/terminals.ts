import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MapLink, OpResult, TerminalInfo, TerminalKind, TerminalLink, TerminalSnapshot } from '../../shared/ipc'
import { ClaudeArgsStore } from './claudeArgs'
import { claudeHookSettings, HookServer } from './hookServer'
import { answerMcp, MCP_SERVER, mcpToolName, type McpSession, type McpTool } from './mcpEndpoint'
import { TerminalHost } from './terminalHost'
import { terminalEnv } from './terminalEnv'
import { TerminalRecordStore, type TerminalRecord } from './terminalRecords'

/** How to start Claude Code: the user's `claude`, or the fake one in tests and e2e runs. */
export interface ClaudeLaunch {
  file: string
  args: string[]
  env?: Record<string, string>
}

export interface TerminalSize {
  cols: number
  rows: number
}

/** What a Claude session can start with beyond a plain `claude`. */
export interface ClaudeSessionOptions {
  /** Sent as the session's first prompt, on this first start only. */
  prompt?: string
  title?: string
  link?: TerminalLink
  /** The context map the session starts from; its brief is rebuilt from the map before each start. */
  map?: MapLink
  /** A file appended to Claude Code's system prompt on every start (`--append-system-prompt-file`). */
  brief?: string
  /** Extra folders the session may use (`--add-dir`), on every start. */
  addDirs?: string[]
  /** An existing Claude Code session to resume rather than starting a new one. */
  resume?: string
  /** The id a new session gets, when the caller needs it before the session starts. */
  session?: string
}

export interface TerminalManagerOptions {
  recordsFile: string
  /** Where the user's extra `claude` arguments are kept. */
  settingsFile: string
  /** Where the `--settings` file with Manta's hooks is written. */
  hookSettingsFile: string
  /** Null when Claude Code isn't installed. */
  claude: () => ClaudeLaunch | null
  /** The user's login shell, started with `-l`. */
  shell: string
  /** The environment terminals start from, before Manta's own variables. */
  baseEnv: () => Promise<Record<string, string>>
  onData: (id: string, data: string, seq: number) => void
  onChange: (info: TerminalInfo) => void
  onRemoved: (id: string) => void
  /** Rewrites a linked session's brief before each start, so a resumed session sees the doc as it is now. */
  refreshBrief?: (link: TerminalLink, file: string) => Promise<void>
  /** The same for a session started from a context map; `terminal` is the session's terminal id. */
  refreshMapBrief?: (map: MapLink, file: string, terminal: string) => Promise<void>
  /** Context added to a map session's prompt as it is submitted (`UserPromptSubmit`); null for none. */
  promptContext?: (terminal: TerminalRecord) => Promise<string | null>
  /** Tools a session (or an agent given the endpoint) gets from Manta's MCP endpoint, allowed without asking. */
  mcpTools?: (session: McpSession) => readonly McpTool[]
  /** How `sendPrompt` paces a paste; tests widen it. */
  promptTiming?: PromptTiming
}

export interface PromptTiming {
  /** Between the paste and Enter. */
  submitDelayMs: number
  /** How long an idle session gets to start working after Enter before it's pressed once more. */
  submitConfirmMs: number
}

const TITLES: Record<TerminalKind, string> = { claude: 'Claude', shell: 'Shell' }
/** Ids that reach the MCP endpoint without a terminal: agents Manta runs itself (Ask the map, the sweep). */
const AGENT_PREFIX = 'agent_'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
/** Enter right after a paste can land before the TUI has taken the paste in; Orca waits 50 ms and retries Enter once for Claude. */
const PROMPT_TIMING: PromptTiming = { submitDelayMs: 50, submitConfirmMs: 1500 }

/**
 * Every terminal Manta has: running ones in the `TerminalHost`, and ones from before a relaunch,
 * which stay listed as exited (from their records) until closed, so a Claude tab can be resumed.
 */
export class TerminalManager {
  private readonly records = new Map<string, TerminalRecord>()
  private readonly host: TerminalHost
  /** Called with each state change of a terminal, for `sendPrompt` to see an idle session start working. */
  private readonly watchers = new Set<(info: TerminalInfo) => void>()

  private constructor(
    private readonly options: TerminalManagerOptions,
    private readonly store: TerminalRecordStore,
    private readonly hooks: HookServer,
    private readonly claudeArgs: ClaudeArgsStore,
    saved: TerminalRecord[]
  ) {
    for (const record of saved) this.records.set(record.id, record)
    this.host = new TerminalHost({
      onData: options.onData,
      onChange: (info) => {
        this.remember(info)
        for (const watcher of this.watchers) watcher(info)
        options.onChange(info)
      }
    })
  }

  static async open(options: TerminalManagerOptions): Promise<TerminalManager> {
    const store = new TerminalRecordStore(options.recordsFile)
    const saved = await store.list()
    let manager: TerminalManager | null = null
    const hooks = await HookServer.start(
      (id, payload) => manager?.host.applyHook(id, payload),
      async (id, message) => {
        const record = manager?.records.get(id)
        const session: McpSession | null = id.startsWith(AGENT_PREFIX) ? { agent: id } : record ? { terminal: record } : null
        return answerMcp(message, id, session ? (options.mcpTools?.(session) ?? []) : [])
      },
      async (id, payload) => {
        const record = manager?.records.get(id)
        if (!record?.map?.launch || !options.promptContext || !isPromptSubmit(payload)) return null
        const additionalContext = await options.promptContext(record)
        return additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } } : null
      }
    )
    await mkdir(path.dirname(options.hookSettingsFile), { recursive: true })
    await writeFile(`${options.hookSettingsFile}.tmp`, `${JSON.stringify(claudeHookSettings(), null, 2)}\n`)
    await rename(`${options.hookSettingsFile}.tmp`, options.hookSettingsFile)
    manager = new TerminalManager(options, store, hooks, await ClaudeArgsStore.open(options.settingsFile), saved)
    return manager
  }

  list(): TerminalInfo[] {
    return [...this.records.values()].map((record) => this.host.info(record.id) ?? dormant(record))
  }

  /** `options` only apply to Claude sessions. */
  async create(root: string, kind: TerminalKind, size: TerminalSize, options: ClaudeSessionOptions = {}): Promise<TerminalInfo> {
    const claude = kind === 'claude'
    const taken = [...this.records.values()].filter((r) => r.root === root && r.kind === kind).length
    const record: TerminalRecord = {
      id: `term_${randomBytes(6).toString('hex')}`,
      root,
      kind,
      title: (claude ? options.title : undefined) ?? (taken === 0 ? TITLES[kind] : `${TITLES[kind]} ${taken + 1}`),
      sessionId: claude ? (options.resume ?? options.session ?? randomUUID()) : null,
      resumable: claude && options.resume !== undefined,
      createdAt: new Date().toISOString(),
      link: (claude ? options.link : undefined) ?? null,
      map: (claude ? options.map : undefined) ?? null,
      brief: (claude ? options.brief : undefined) ?? null,
      addDirs: (claude ? options.addDirs : undefined) ?? []
    }
    return this.start(record, size, claude ? options.prompt : undefined)
  }

  /** Starts an exited terminal again: a Claude session resumes its conversation when it has one (with `prompt` as its next prompt), a shell starts fresh. */
  async restart(id: string, size: TerminalSize, prompt?: string): Promise<TerminalInfo> {
    const record = this.record(id)
    const running = this.host.info(id)
    if (running && running.state !== 'exited') throw new Error(`${record.title} is still running`)
    await this.host.close(id)
    const fresh = record.kind === 'claude' && !record.resumable ? { ...record, sessionId: randomUUID() } : record
    return this.start(fresh, size, record.kind === 'claude' ? prompt : undefined)
  }

  /**
   * Manta's MCP endpoint for an agent Manta runs itself, under `id` (`agent_<…>`): the tools it
   * gets are whatever `mcpTools` gives `{ agent: id }`. Null when it gets none.
   */
  agentMcp(id: string): { url: string; headers: Record<string, string>; tools: string[] } | null {
    if (!id.startsWith(AGENT_PREFIX)) throw new Error(`${id} is not an agent id`)
    const tools = this.options.mcpTools?.({ agent: id }) ?? []
    if (tools.length === 0) return null
    const { port, token } = this.hooks.address
    return { url: `http://127.0.0.1:${port}/mcp/${id}`, headers: { Authorization: `Bearer ${token}` }, tools: tools.map(mcpToolName) }
  }

  /** Claude Code is installed, so a Claude session can start. */
  claudeAvailable(): boolean {
    return this.options.claude() !== null
  }

  /** The extra arguments new and resumed Claude sessions start with, as the user typed them. */
  claudeArgsText(): string {
    return this.claudeArgs.get()
  }

  /** Running sessions keep the arguments they started with. */
  setClaudeArgs(text: string): Promise<OpResult> {
    return this.claudeArgs.set(text)
  }

  write(id: string, data: string): void {
    if (this.host.info(id)) this.host.write(id, data)
  }

  /**
   * Types a prompt into a Claude session and submits it: a bracketed paste, so a multi-line prompt
   * is one prompt, then Enter. Refused unless the session is at its prompt or working (Claude Code
   * queues it); one waiting on a permission prompt is refused, as the text would answer it. The state
   * is checked again before Enter, since a permission prompt can come up after the paste, and an idle
   * session that doesn't start working gets Enter once more: an Enter that lands too early is dropped.
   */
  async sendPrompt(id: string, text: string): Promise<OpResult> {
    const { kind, title } = this.record(id)
    if (kind !== 'claude') return { ok: false, message: 'Only Claude sessions take review comments' }
    const state = this.host.info(id)?.state ?? 'exited'
    if (state === 'exited') return { ok: false, message: `${title} isn't running` }
    if (state === 'waiting') return { ok: false, message: `${title} is waiting for you; answer it first` }
    if (state === 'starting' || !this.host.pasteReady(id)) return { ok: false, message: `${title} is still starting` }
    const timing = this.options.promptTiming ?? PROMPT_TIMING
    this.host.write(id, `${PASTE_START}${text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '')}${PASTE_END}`)
    await new Promise((resolve) => setTimeout(resolve, timing.submitDelayMs))
    const sent: OpResult = { ok: true, message: `Sent to ${title}` }
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = this.host.info(id)?.state
      if (now !== 'idle' && now !== 'working') return { ok: false, message: `${title} stopped before it was sent; the text is in its input, not submitted` }
      const started = now === 'idle' ? this.leavesIdle(id, timing.submitConfirmMs) : Promise.resolve(true)
      this.host.write(id, '\r')
      if (await started) return sent
    }
    return { ok: false, message: `${title} didn't submit it; the text is in its input, press Enter there` }
  }

  /** Whether the terminal reports a state other than idle within `ms`. */
  private leavesIdle(id: string, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const done = (left: boolean): void => {
        clearTimeout(timer)
        this.watchers.delete(watch)
        resolve(left)
      }
      const watch = (info: TerminalInfo): void => {
        if (info.id === id && info.state !== 'idle') done(true)
      }
      const timer = setTimeout(() => done(false), ms)
      this.watchers.add(watch)
    })
  }

  resize(id: string, size: TerminalSize): void {
    if (this.host.info(id)) this.host.resize(id, size.cols, size.rows)
  }

  /** An exited terminal from before a relaunch has nothing on screen. */
  snapshot(id: string): Promise<TerminalSnapshot> {
    this.record(id)
    return this.host.info(id) ? this.host.snapshot(id) : Promise.resolve({ data: '', seq: 0 })
  }

  /** Renames the terminal; the name is kept in its record, so it survives restarts and relaunches. */
  async rename(id: string, title: string): Promise<TerminalInfo> {
    const name = title.trim()
    if (!name) throw new Error('A terminal needs a name')
    const record = { ...this.record(id), title: name }
    this.records.set(id, record)
    await this.store.put(record)
    const running = this.host.retitle(id, name)
    if (running) return running
    const info = dormant(record)
    this.options.onChange(info)
    return info
  }

  /** Kills the terminal if it is running and forgets it for good. */
  async close(id: string): Promise<void> {
    if (!this.records.has(id)) return
    await this.host.close(id)
    this.records.delete(id)
    await this.store.remove(id)
    this.options.onRemoved(id)
  }

  /** Terminals in `root` with a process running. */
  runningIn(root: string): TerminalInfo[] {
    return this.list().filter((info) => info.root === root && info.state !== 'exited')
  }

  /** Closes every terminal in `root`, e.g. before its worktree is removed. */
  async closeRoot(root: string): Promise<void> {
    const ids = [...this.records.values()].filter((r) => r.root === root).map((r) => r.id)
    await Promise.all(ids.map((id) => this.close(id)))
  }

  /** Kills every terminal but keeps the records, so their tabs come back exited after a relaunch. */
  async shutdown(): Promise<void> {
    await this.host.closeAll()
    await this.hooks.stop()
  }

  private async start(record: TerminalRecord, size: TerminalSize, prompt?: string): Promise<TerminalInfo> {
    const launch = record.kind === 'claude' ? this.claudeLaunch(record, prompt) : { file: this.options.shell, args: ['-l'] }
    if (record.link && record.brief && this.options.refreshBrief) await this.options.refreshBrief(record.link, record.brief)
    else if (record.map && record.brief && this.options.refreshMapBrief) await this.options.refreshMapBrief(record.map, record.brief, record.id)
    const extra =
      record.kind === 'claude'
        ? { MANTA_HOOK_PORT: String(this.hooks.address.port), MANTA_HOOK_TOKEN: this.hooks.address.token, ...launch.env }
        : undefined
    const env = terminalEnv({ base: await this.options.baseEnv(), terminalId: record.id, root: record.root, ...(extra ? { extra } : {}) })
    this.records.set(record.id, record)
    await this.store.put(record)
    const info = this.host.create({ ...record, file: launch.file, args: launch.args, env, cols: size.cols, rows: size.rows })
    this.options.onChange(info)
    return info
  }

  private claudeLaunch(record: TerminalRecord, prompt?: string): ClaudeLaunch {
    const claude = this.options.claude()
    if (!claude) throw new Error('Claude Code is not installed: install it, then try again')
    if (!record.sessionId) throw new Error(`${record.title} has no Claude Code session`)
    const session = record.resumable ? ['--resume', record.sessionId] : ['--session-id', record.sessionId]
    const brief = record.brief ? ['--append-system-prompt-file', record.brief] : []
    const addDirs = record.addDirs.length > 0 ? ['--add-dir', ...record.addDirs] : []
    const tools = this.options.mcpTools?.({ terminal: record }) ?? []
    const mcp = tools.length > 0 ? ['--mcp-config', this.mcpConfig(record.id), '--allowedTools', ...tools.map(mcpToolName)] : []
    return {
      ...claude,
      args: [
        ...claude.args,
        ...(prompt ? [promptArgument(prompt)] : []),
        ...this.claudeArgs.args(),
        '--settings',
        this.options.hookSettingsFile,
        ...session,
        ...brief,
        ...mcp,
        ...addDirs
      ]
    }
  }

  /** Built on every start: the endpoint's port and token change with each run of Manta. */
  private mcpConfig(terminalId: string): string {
    const { port, token } = this.hooks.address
    const url = `http://127.0.0.1:${port}/mcp/${terminalId}`
    return JSON.stringify({ mcpServers: { [MCP_SERVER]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } })
  }

  /** Keeps the record's session id and resumability in step with what hooks reported. */
  private remember(info: TerminalInfo): void {
    const record = this.records.get(info.id)
    if (!record || (record.sessionId === info.sessionId && record.resumable === info.resumable)) return
    const next = { ...record, sessionId: info.sessionId, resumable: info.resumable }
    this.records.set(info.id, next)
    this.store.put(next).catch((error: unknown) => console.error('manta: saving terminal record', error))
  }

  private record(id: string): TerminalRecord {
    const record = this.records.get(id)
    if (!record) throw new Error(`Unknown terminal ${id}`)
    return record
  }
}

function dormant({ brief: _, addDirs: __, ...record }: TerminalRecord): TerminalInfo {
  return { ...record, startedAt: null, state: 'exited', exitCode: null }
}

/**
 * The prompt goes first: after a variadic option (`--add-dir`, or one among the user's extra
 * arguments) it would be taken as one more value and never sent. A leading space keeps a prompt
 * that starts with `-` from being read as an option.
 */
function promptArgument(prompt: string): string {
  return prompt.startsWith('-') ? ` ${prompt}` : prompt
}

/** A main-session prompt being submitted; a subagent's events carry `agent_id`. */
function isPromptSubmit(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && 'hook_event_name' in payload && payload.hook_event_name === 'UserPromptSubmit' && !('agent_id' in payload)
}
