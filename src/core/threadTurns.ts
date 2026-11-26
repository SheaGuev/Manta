import path from 'node:path'
import type { OpResult, PermissionDecision, ThreadEvent } from '../shared/ipc'
import type { AgentTurn, ThreadAgent } from './agent/threadAgent'
import { newThreadId, type ThreadMessage } from './threads/threads'

export type ThreadEventListener = (relPath: string, threadId: string, event: ThreadEvent) => void

export interface ThreadOptions {
  /** Where each thread's folder (the agent's working directory) is created. */
  threadsDir?: string
  agent?: ThreadAgent
  onThreadEvent?: ThreadEventListener
}

/** A thread checked out into its folder, ready for the agent. */
export interface PreparedTurn {
  file: string
  dir: string
  realDir: string
  session: string | null
  context: AgentTurn['context']
}

/** The parts of a turn that touch the thread's fork and record, each run on the workspace's serial queue. */
export interface TurnSteps {
  /** Validates the thread, checks out its fork into its folder, records the user's message. */
  begin(relPath: string, id: string, text: string, threadsDir: string): Promise<PreparedTurn>
  /** Absorbs the agent's edits into the fork; true when the proposal changed. */
  absorbCheckout(relPath: string, id: string, file: string): Promise<boolean>
  saveSession(id: string, session: string): Promise<void>
  /** Appends the turn's transcript to the thread's record. */
  finish(relPath: string, id: string, transcript: readonly ThreadMessage[]): Promise<void>
}

/** Running agent turns, one per thread at most, and the permission requests they're waiting on. */
export class ThreadTurns {
  private readonly turns = new Map<string, AbortController>()
  /** Permission requests waiting for the user, keyed by thread id, then request id. */
  private readonly permissions = new Map<string, Map<string, (decision: PermissionDecision) => void>>()

  constructor(
    private readonly steps: TurnSteps,
    private readonly options: ThreadOptions
  ) {}

  /**
   * Runs one agent turn on the thread: writes the thread's proposed doc to its folder, lets the
   * agent edit it there, and absorbs each edit back into the fork. The doc itself is untouched.
   * Setup and teardown run on the serial queue; the turn itself doesn't, so a long turn never
   * blocks commits or pulls. Resolves when the turn ends.
   */
  async send(relPath: string, id: string, text: string): Promise<OpResult> {
    const { agent, threadsDir } = this.options
    if (!agent || !threadsDir) return { ok: false, message: 'No agent is configured for threads' }
    if (this.turns.has(id)) return { ok: false, message: 'This thread is still answering the last message' }
    const controller = new AbortController()
    this.turns.set(id, controller)
    const emit = (event: ThreadEvent): void => this.options.onThreadEvent?.(relPath, id, event)
    const transcript: ThreadMessage[] = []
    const note = (role: ThreadMessage['role'], body: string): void => {
      const last = transcript.at(-1)
      if (role === 'assistant' && last?.role === 'assistant') last.text += body
      else transcript.push({ role, text: body, at: new Date().toISOString() })
    }

    let turn: PreparedTurn
    try {
      turn = await this.steps.begin(relPath, id, text, threadsDir)
    } catch (error) {
      this.turns.delete(id)
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }

    const pending = new Map<string, (decision: PermissionDecision) => void>()
    this.permissions.set(id, pending)
    const requestPermission = (request: { tool: string; summary: string; title: string | null }): Promise<PermissionDecision> =>
      new Promise((resolve) => {
        if (controller.signal.aborted) return resolve('deny')
        const requestId = newThreadId()
        const settle = (decision: PermissionDecision): void => {
          if (!pending.delete(requestId)) return
          note('status', `${decision === 'deny' ? 'Denied' : 'Allowed'}: ${request.tool} ${request.summary}`.trim())
          emit({ type: 'permission-resolved', id: requestId, decision })
          resolve(decision)
        }
        pending.set(requestId, settle)
        controller.signal.addEventListener('abort', () => settle('deny'), { once: true })
        emit({ type: 'permission', id: requestId, ...request })
      })

    emit({ type: 'turn-start' })
    try {
      const events = agent.run({
        prompt: text,
        cwd: turn.dir,
        file: turn.file,
        session: turn.session,
        context: turn.context,
        signal: controller.signal,
        requestPermission
      })
      for await (const event of events) {
        if (controller.signal.aborted) break
        if (event.type === 'session') await this.steps.saveSession(id, event.id)
        else if (event.type === 'text') {
          note('assistant', event.text)
          emit(event)
        } else if (event.type === 'tool') {
          // The thread folder is an implementation detail; show paths inside it relative to it.
          const inside = [turn.dir, turn.realDir].find((dir) => event.summary.startsWith(dir + path.sep))
          const summary = inside ? path.relative(inside, event.summary) : event.summary
          note('tool', `${event.name} ${summary}`.trim())
          emit({ ...event, summary })
        } else if (event.type === 'tool-done') {
          if (await this.steps.absorbCheckout(relPath, id, turn.file)) emit({ type: 'proposal-changed' })
        } else {
          note('status', `Error: ${event.message}`)
          emit(event)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      note('status', `Error: ${message}`)
      emit({ type: 'error', message })
    } finally {
      const cancelled = controller.signal.aborted
      if (cancelled) note('status', 'Cancelled')
      try {
        if (await this.steps.absorbCheckout(relPath, id, turn.file)) emit({ type: 'proposal-changed' })
        await this.steps.finish(relPath, id, transcript)
      } finally {
        for (const settle of [...pending.values()]) settle('deny')
        this.permissions.delete(id)
        this.turns.delete(id)
        emit({ type: 'turn-end', cancelled })
      }
    }
    return { ok: true, message: controller.signal.aborted ? 'Cancelled' : 'Done' }
  }

  /** Answers a permission request from the thread's running turn. False when it is no longer waiting. */
  answerPermission(threadId: string, requestId: string, decision: PermissionDecision): boolean {
    const settle = this.permissions.get(threadId)?.get(requestId)
    settle?.(decision)
    return settle !== undefined
  }

  /** Whether a turn is running for `id`. */
  running(id: string): boolean {
    return this.turns.has(id)
  }

  /** Stops the thread's running turn. Edits the agent already made stay in the proposal. */
  cancel(id: string): boolean {
    const turn = this.turns.get(id)
    turn?.abort()
    return turn !== undefined
  }

  /** Stops every running turn. */
  close(): void {
    for (const turn of this.turns.values()) turn.abort()
  }
}
