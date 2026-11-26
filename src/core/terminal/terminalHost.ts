import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal as Screen } from '@xterm/headless'
import { spawn, type IPty } from 'node-pty'
import type { MapLink, TerminalInfo, TerminalKind, TerminalLink, TerminalSnapshot, TerminalState } from '../../shared/ipc'
import { stateAfterHook } from './terminalState'

export interface TerminalSpec {
  id: string
  root: string
  kind: TerminalKind
  title: string
  sessionId: string | null
  resumable: boolean
  createdAt: string
  link: TerminalLink | null
  map: MapLink | null
  file: string
  args: string[]
  env: Record<string, string>
  cols: number
  rows: number
}

export interface TerminalHostOptions {
  /** Output, batched; `seq` increases by one per call for each terminal. */
  onData: (id: string, data: string, seq: number) => void
  /** State, exit code, session id or resumability changed. */
  onChange: (info: TerminalInfo) => void
  batchMs?: number
  scrollback?: number
  /** How long a killed terminal gets after SIGHUP before SIGKILL. */
  killGraceMs?: number
}

interface Session {
  info: TerminalInfo
  pty: IPty
  screen: Screen
  serializer: SerializeAddon
  /** Output the screen has processed but listeners haven't been sent yet. */
  pending: string
  seq: number
  timer: NodeJS.Timeout | null
  exited: Promise<void>
}

const SCROLLBACK = 5000

/**
 * Terminals as PTYs, each with a headless copy of its screen, so a tab that mounts later (context
 * switch, window reload) can draw what it missed. Output reaches listeners only after the screen
 * has processed it, which is what makes a snapshot plus later output exact.
 */
export class TerminalHost {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly options: TerminalHostOptions) {}

  create(spec: TerminalSpec): TerminalInfo {
    if (this.sessions.has(spec.id)) throw new Error(`Terminal ${spec.id} already exists`)
    const scrollback = this.options.scrollback ?? SCROLLBACK
    const screen = new Screen({ cols: spec.cols, rows: spec.rows, scrollback, allowProposedApi: true })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    const pty = spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cwd: spec.root,
      env: spec.env,
      cols: spec.cols,
      rows: spec.rows
    })
    const state: TerminalState = spec.kind === 'claude' ? 'starting' : 'running'
    const info: TerminalInfo = {
      id: spec.id,
      root: spec.root,
      kind: spec.kind,
      title: spec.title,
      sessionId: spec.sessionId,
      resumable: spec.resumable,
      createdAt: spec.createdAt,
      startedAt: new Date().toISOString(),
      state,
      exitCode: null,
      link: spec.link,
      map: spec.map
    }
    let exited = (): void => undefined
    const session: Session = {
      info,
      pty,
      screen,
      serializer,
      pending: '',
      seq: 0,
      timer: null,
      exited: new Promise((resolve) => (exited = resolve))
    }
    this.sessions.set(spec.id, session)
    /**
     * Answers to the program's terminal queries come from the tab's xterm when it is showing; the
     * headless copy stays silent so a query is never answered twice.
     */
    pty.onData((data) => screen.write(data, () => this.queue(session, data)))
    pty.onExit(({ exitCode }) => {
      screen.write('', () => {
        this.flush(session)
        session.info = { ...session.info, state: 'exited', exitCode }
        this.options.onChange(session.info)
        exited()
      })
    })
    return info
  }

  write(id: string, data: string): void {
    const session = this.session(id)
    if (session.info.state !== 'exited') session.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.session(id)
    if (session.info.state === 'exited') return
    session.pty.resize(cols, rows)
    session.screen.resize(cols, rows)
  }

  /** The screen and scrollback as of the last output sent to listeners. */
  snapshot(id: string): Promise<TerminalSnapshot> {
    const session = this.session(id)
    return new Promise((resolve) => {
      /** Runs once everything written before it is processed, and before anything after it is. */
      session.screen.write('', () => {
        this.flush(session)
        resolve({ data: session.serializer.serialize(), seq: session.seq })
      })
    })
  }

  /** Whether the program turned bracketed paste on (Claude Code does once its prompt is up), so a paste arrives as one input. */
  pasteReady(id: string): boolean {
    const session = this.sessions.get(id)
    return session !== undefined && session.info.state !== 'exited' && session.screen.modes.bracketedPasteMode
  }

  info(id: string): TerminalInfo | null {
    return this.sessions.get(id)?.info ?? null
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => s.info)
  }

  /** Changes a terminal's title. Null for an unknown terminal. */
  retitle(id: string, title: string): TerminalInfo | null {
    const session = this.sessions.get(id)
    if (!session) return null
    session.info = { ...session.info, title }
    this.options.onChange(session.info)
    return session.info
  }

  /** Applies a Claude Code hook event to a Claude terminal. Returns false for an unknown terminal. */
  applyHook(id: string, payload: unknown): boolean {
    const session = this.sessions.get(id)
    if (!session || session.info.kind !== 'claude') return false
    const before = session.info
    const next = { ...before, state: stateAfterHook(before.state, payload), ...sessionAfterHook(before, payload) }
    if (next.state !== before.state || next.sessionId !== before.sessionId || next.resumable !== before.resumable) {
      session.info = next
      this.options.onChange(next)
    }
    return true
  }

  /**
   * Hangs up the terminal's whole process group (the shell or Claude and what they started in the
   * foreground), then SIGKILLs it if it hasn't exited after the grace period. Resolves on exit.
   */
  async kill(id: string): Promise<void> {
    const session = this.session(id)
    if (session.info.state === 'exited') return
    signalGroup(session.pty.pid, 'SIGHUP')
    const timer = setTimeout(() => signalGroup(session.pty.pid, 'SIGKILL'), this.options.killGraceMs ?? 3000)
    await session.exited
    clearTimeout(timer)
  }

  /** Kills the terminal if it is running and forgets it. */
  async close(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    await this.kill(id)
    clearTimeout(session.timer ?? undefined)
    session.screen.dispose()
    this.sessions.delete(id)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)))
  }

  private queue(session: Session, data: string): void {
    session.pending += data
    session.timer ??= setTimeout(() => this.flush(session), this.options.batchMs ?? 16)
  }

  private flush(session: Session): void {
    clearTimeout(session.timer ?? undefined)
    session.timer = null
    if (!session.pending) return
    const data = session.pending
    session.pending = ''
    session.seq += 1
    this.options.onData(session.info.id, data, session.seq)
  }

  private session(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Unknown terminal ${id}`)
    return session
  }
}

/**
 * `/clear` starts a new Claude Code session in the same process: its `SessionStart` carries the new
 * id, which is the one to resume. A session is saved once it has had a prompt.
 */
function sessionAfterHook(info: TerminalInfo, payload: unknown): Pick<TerminalInfo, 'sessionId' | 'resumable'> {
  const unchanged = { sessionId: info.sessionId, resumable: info.resumable }
  if (typeof payload !== 'object' || payload === null || 'agent_id' in payload) return unchanged
  const event = 'hook_event_name' in payload ? payload.hook_event_name : undefined
  const sessionId = 'session_id' in payload && typeof payload.session_id === 'string' ? payload.session_id : null
  if (event === 'SessionStart' && sessionId && sessionId !== info.sessionId) {
    return { sessionId, resumable: 'source' in payload && payload.source === 'resume' }
  }
  if (event === 'UserPromptSubmit') return { ...unchanged, resumable: true }
  return unchanged
}

/** A PTY's child leads its own session and process group, so `-pid` reaches everything in it. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
}
