import { query, type CanUseTool, type HookCallback, type Options, type PermissionUpdate, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { AgentEvent, AgentTurn, MapTurnContext, ThreadAgent, ThreadTurnContext } from './threadAgent'

/** Built-in tools that write files. Each must stay inside the thread folder. */
export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

/** Read-only file tools: allowed anywhere without asking, so the agent can explore. */
const READ_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep']

const WRITE_PATH_FIELDS = ['file_path', 'notebook_path']

/**
 * Why a call must be denied, or null when it may go ahead. Only file writes are fenced here:
 * they must land inside the turn's folder, so the doc (or map) changes only through a reviewed proposal.
 * Bash is fenced by the OS sandbox instead. Paths are compared after resolving symlinks, so a
 * link inside the folder can't point a write outside it.
 */
export async function fenceDenial(root: string, toolName: string, input: unknown): Promise<string | null> {
  if (!WRITE_TOOLS.includes(toolName) || typeof input !== 'object' || input === null) return null
  for (const [key, value] of Object.entries(input)) {
    if (WRITE_PATH_FIELDS.includes(key) && typeof value === 'string' && !(await isInside(root, value))) {
      return `${value} is outside this thread's folder; a thread can only change its own copy of the doc`
    }
  }
  return null
}

async function isInside(root: string, target: string): Promise<boolean> {
  if (target.startsWith('~')) return false
  const realRoot = await realpath(root)
  let current = path.resolve(root, target)
  // A file the agent is about to create doesn't exist yet: check its nearest existing parent.
  for (;;) {
    try {
      const real = await realpath(current)
      return real === realRoot || real.startsWith(realRoot + path.sep)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return false
      current = parent
    }
  }
}

function systemPrompt(turn: AgentTurn): string {
  const { context } = turn
  return 'map' in context ? mapPrompt(turn, context) : threadPrompt(turn, context)
}

function threadPrompt(turn: AgentTurn, context: ThreadTurnContext): string {
  const file = path.basename(turn.file)
  return [
    `You are working on a thread in the doc "${context.doc}". The thread is titled "${context.title}" and is about this section:`,
    '',
    context.section,
    '',
    `Your working directory holds ${file}, a copy of the doc. To propose a change, edit ${file} directly: the user reviews your edits before anything is merged into the real doc.`,
    `The docs repo is at ${context.repoRoot}. You can read and search it, other files, and the web, and use your other tools, to research the thread.`,
    WRITE_FENCE_NOTE,
    ...parentsPrompt(turn, context)
  ].join('\n')
}

const WRITE_FENCE_NOTE = 'You can only write inside your working directory: file writes elsewhere are refused, and shell commands run in a sandbox that only allows writes there.'

function mapPrompt(_turn: AgentTurn, context: MapTurnContext): string {
  return [context.map.prompt, WRITE_FENCE_NOTE].join('\n')
}

function parentsPrompt(turn: AgentTurn, context: ThreadTurnContext): string[] {
  const { parents } = context
  if (!parents) return []
  const chain = parents.titles.map((title) => `"${title}"`).join(' → ')
  return [
    '',
    `This thread is a subthread of ${chain}. ${path.basename(turn.file)} is the parent thread's proposed version of the doc, and approving this thread merges your edits into that proposal, not straight into the doc.`,
    `${path.relative(turn.cwd, parents.file)} holds the parent threads' conversations, refreshed at the start of each of your turns. Read it whenever what was discussed or decided there matters.`
  ]
}

/**
 * Query options for a thread agent: a normal Claude Code session (all built-in tools, the
 * user's plugins, MCP servers, skills and login) whose writes are confined to the thread folder.
 */
export function claudeCodeOptions(turn: AgentTurn, abortController: AbortController, executable: string | null): Options {
  const fence: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {}
    const denial = await fenceDenial(turn.cwd, input.tool_name, input.tool_input)
    if (!denial) return {}
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denial } }
  }
  const mcp = 'map' in turn.context ? turn.context.mcp : null
  const canUseTool: CanUseTool = async (toolName, input, { signal, suggestions, title }) => {
    const denial = await fenceDenial(turn.cwd, toolName, input)
    if (denial) return { behavior: 'deny', message: denial }
    if (READ_TOOLS.includes(toolName) || mcp?.tools.includes(toolName)) return { behavior: 'allow', updatedInput: input }
    if (signal.aborted) return { behavior: 'deny', message: 'The turn was cancelled' }
    const decision = await turn.requestPermission({ tool: toolName, summary: summarize(input), title: title ?? null })
    if (decision === 'deny') return { behavior: 'deny', message: 'The user denied this' }
    // "Always" holds for this thread's session only, never written to the user's settings files.
    const always = decision === 'always' ? (suggestions ?? []).map((update): PermissionUpdate => ({ ...update, destination: 'session' })) : []
    return { behavior: 'allow', updatedInput: input, ...(always.length > 0 ? { updatedPermissions: always } : {}) }
  }
  return {
    cwd: turn.cwd,
    tools: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user'],
    hooks: { PreToolUse: [{ hooks: [fence] }] },
    // Explicit, because the SDK's default mode can be `auto`, which approves on its own.
    permissionMode: 'default',
    canUseTool,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      // Otherwise a failed command can be retried unsandboxed, and a matching allow rule approves it silently.
      allowUnsandboxedCommands: false
    },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt(turn) },
    abortController,
    // Text arrives as deltas so the reply streams in; `eventsFrom` skips the text in complete messages.
    includePartialMessages: true,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'manta/0.0.1' },
    ...(mcp ? { mcpServers: { manta: { type: 'http', url: mcp.url, headers: mcp.headers } }, allowedTools: mcp.tools } : {}),
    ...('map' in turn.context && turn.context.model ? { model: turn.context.model } : {}),
    ...(turn.session ? { resume: turn.session } : {}),
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {})
  }
}

/** The user's own Claude Code, run through the Agent SDK on their existing login. */
export class ClaudeCodeAgent implements ThreadAgent {
  private executable: string | null | undefined

  /** `findExecutable`: locates the user's `claude`, or null for the copy bundled with the SDK. Called once, on the first turn. */
  constructor(private readonly findExecutable: () => string | null) {}

  async *run(turn: AgentTurn): AsyncIterable<AgentEvent> {
    const abortController = new AbortController()
    const abort = (): void => abortController.abort()
    turn.signal.addEventListener('abort', abort, { once: true })
    let session: string | null = null
    if (this.executable === undefined) this.executable = this.findExecutable()
    try {
      for await (const message of query({ prompt: turn.prompt, options: claudeCodeOptions(turn, abortController, this.executable) })) {
        if (session === null && 'session_id' in message && typeof message.session_id === 'string') {
          session = message.session_id
          yield { type: 'session', id: session }
        }
        yield* eventsFrom(message)
      }
    } catch (error) {
      if (!turn.signal.aborted) yield { type: 'error', message: error instanceof Error ? error.message : String(error) }
    } finally {
      turn.signal.removeEventListener('abort', abort)
    }
  }
}

export function* eventsFrom(message: SDKMessage): Iterable<AgentEvent> {
  if (message.type === 'stream_event' && message.parent_tool_use_id === null) {
    const { event } = message
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield { type: 'text', text: event.delta.text }
  } else if (message.type === 'assistant' && message.parent_tool_use_id === null) {
    for (const block of message.message.content) {
      if (block.type === 'tool_use') yield { type: 'tool', name: block.name, summary: summarize(block.input) }
    }
  } else if (message.type === 'user' && Array.isArray(message.message.content)) {
    if (message.message.content.some((block) => block.type === 'tool_result')) yield { type: 'tool-done' }
  } else if (message.type === 'result' && message.subtype !== 'success') {
    yield { type: 'error', message: message.errors.join('\n') || message.subtype }
  }
}

const SUMMARY_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'pattern', 'path', 'description']

function summarize(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = Object.entries(input)
  for (const name of SUMMARY_FIELDS) {
    const value = fields.find(([key]) => key === name)?.[1]
    if (typeof value === 'string') return value.length > 160 ? `${value.slice(0, 157)}…` : value
  }
  return ''
}
