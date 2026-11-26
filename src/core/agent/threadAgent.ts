import { readFile, writeFile } from 'node:fs/promises'
import type { PermissionDecision } from '../../shared/ipc'

export interface PermissionRequest {
  tool: string
  /** What the call would act on: a command, path, URL or query. */
  summary: string
  /** Claude Code's own prompt sentence, when it gives one. */
  title: string | null
}

/**
 * What a thread's agent is told. `repoRoot` is the docs repo, which the agent may read and explore
 * but never write. `parents` is set for a subthread: the threads it was started from, outermost
 * first, and the file in `cwd` holding their conversations as of the start of this turn.
 */
export interface ThreadTurnContext {
  title: string
  doc: string
  section: string
  repoRoot: string
  parents: { titles: string[]; file: string } | null
}

/** Manta's MCP endpoint as an agent reaches it, and the full names of the tools it may call without asking. */
export interface McpAccess {
  url: string
  headers: Record<string, string>
  tools: string[]
}

/**
 * What a context map's agent (Ask the map, or the  sweep) is told: its system prompt, and Manta's MCP
 * endpoint with the map tools. `model` overrides the user's default, for the sweep's small model.
 */
export interface MapTurnContext {
  repoRoot: string
  map: { id: string; title: string; prompt: string }
  mcp: McpAccess | null
  model?: string
}

/** One turn of a thread's or a map's agent: a user message, answered by editing the checkout. */
export interface AgentTurn {
  prompt: string
  /** The thread folder: the only place the agent may write. */
  cwd: string
  /** Absolute path of the doc's (or the map's) checkout inside `cwd`. */
  file: string
  /** Session to resume from earlier turns; null on the first turn. */
  session: string | null
  context: ThreadTurnContext | MapTurnContext
  signal: AbortSignal
  /** Asks the user to allow a tool call; resolves `deny` if the turn is cancelled first. */
  requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>
}

export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  /** A tool call finished; the checkout may have changed. */
  | { type: 'tool-done' }
  | { type: 'error'; message: string }

export interface ThreadAgent {
  run(turn: AgentTurn): AsyncIterable<AgentEvent>
}

export type ScriptStep =
  | { text: string }
  | { edit: { find: string; replace: string } }
  /** Replaces the whole checkout, as an agent writing a file from scratch does. */
  | { write: string }
  /** Waits until the turn is cancelled, for testing cancel. */
  | { waitForCancel: true }
  /** Asks permission the way Claude Code does, and says what it was told. */
  | { ask: { tool: string; summary: string } }
  /** Calls one of Manta's MCP tools through the turn's endpoint, as Claude Code would. */
  | { call: { tool: string; args: Record<string, unknown> } }

/**
 * A stand-in agent for tests and UI e2e runs: plays a script, making real edits to the checkout
 * file the way Claude Code would, so the absorb path is exercised for real.
 */
export class ScriptedAgent implements ThreadAgent {
  readonly turns: AgentTurn[] = []

  constructor(private readonly script: (turn: AgentTurn) => ScriptStep[]) { }

  async *run(turn: AgentTurn): AsyncIterable<AgentEvent> {
    this.turns.push(turn)
    yield { type: 'session', id: turn.session ?? `scripted-${this.turns.length}` }
    for (const step of this.script(turn)) {
      if (turn.signal.aborted) return
      if ('text' in step) yield { type: 'text', text: step.text }
      else if ('call' in step) {
        yield { type: 'tool', name: `mcp__manta__${step.call.tool}`, summary: '' }
        yield { type: 'text', text: await callMcpTool('map' in turn.context ? turn.context.mcp : null, step.call.tool, step.call.args) }
        yield { type: 'tool-done' }
      }
      else if ('ask' in step) {
        const decision = await turn.requestPermission({ ...step.ask, title: null })
        yield { type: 'text', text: `Permission for ${step.ask.tool}: ${decision}. ` }
      } else if ('write' in step) {
        yield { type: 'tool', name: 'Write', summary: turn.file }
        await writeFile(turn.file, step.write)
        yield { type: 'tool-done' }
      } else if ('edit' in step) {
        yield { type: 'tool', name: 'Edit', summary: turn.file }
        const text = await readFile(turn.file, 'utf8')
        if (!text.includes(step.edit.find)) {
          yield { type: 'error', message: `Scripted edit target not found: ${step.edit.find}` }
          return
        }
        await writeFile(turn.file, text.replace(step.edit.find, step.edit.replace))
        yield { type: 'tool-done' }
      } else {
        await new Promise<void>((resolve) => {
          if (turn.signal.aborted) resolve()
          else turn.signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
    }
  }
}

/** One `tools/call` to Manta's MCP endpoint; what the agent would read back. */
async function callMcpTool(mcp: McpAccess | null, tool: string, args: Record<string, unknown>): Promise<string> {
  if (!mcp) return 'Tool error: no MCP endpoint. '
  const response = await fetch(mcp.url, {
    method: 'POST',
    headers: { ...mcp.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } })
  })
  const answer: unknown = await response.json()
  const result = typeof answer === 'object' && answer !== null && 'result' in answer ? answer.result : null
  const content = typeof result === 'object' && result !== null && 'content' in result && Array.isArray(result.content) ? result.content[0] : null
  const text = typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string' ? content.text : `HTTP ${response.status}`
  const failed = typeof result === 'object' && result !== null && 'isError' in result && result.isError === true
  return `${failed ? 'Tool error' : 'Tool'}: ${text} `
}
