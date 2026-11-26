import type { TerminalState } from '../../shared/ipc'

/** A resumed or cleared session is at its prompt; a compaction restart fires mid-turn, so it says nothing. */
const IDLE_SESSION_SOURCES: readonly string[] = ['startup', 'resume', 'clear']

function field(payload: object, key: string): string | undefined {
  const value: unknown = key in payload ? Reflect.get(payload, key) : undefined
  return typeof value === 'string' ? value : undefined
}

/**
 * A Claude terminal's state after one hook event (`hook_event_name` plus its fields, as Claude Code
 * sends them on stdin). Anything unrecognised leaves the state as it was.
 */
export function stateAfterHook(current: TerminalState, payload: unknown): TerminalState {
  if (current === 'exited' || typeof payload !== 'object' || payload === null) return current
  const event = field(payload, 'hook_event_name')
  const needsUser =
    event === 'PermissionRequest' ||
    (event === 'PreToolUse' && field(payload, 'tool_name') === 'AskUserQuestion') ||
    (event === 'Notification' && field(payload, 'notification_type') === 'permission_prompt')
  if (needsUser) return 'waiting'
  /** Subagents report their own tool calls; only the main agent's events move the session. */
  if (field(payload, 'agent_id') !== undefined) return current
  switch (event) {
    case 'SessionStart':
      return IDLE_SESSION_SOURCES.includes(field(payload, 'source') ?? '') ? 'idle' : current
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return 'working'
    case 'Stop':
    case 'StopFailure':
      return 'idle'
    /** A manual /compact ends at the prompt without a Stop. */
    case 'PostCompact':
      return field(payload, 'trigger') === 'manual' ? 'idle' : current
    /** Cancelling a turn (Esc) sends no hook; Claude's idle reminder is the only sign it ended. */
    case 'Notification':
      return field(payload, 'notification_type') === 'idle_prompt' && current === 'working' ? 'idle' : current
    default:
      return current
  }
}
