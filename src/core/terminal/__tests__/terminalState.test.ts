import { describe, expect, it } from 'vitest'
import type { TerminalState } from '../../../shared/ipc'
import { stateAfterHook } from '../terminalState'

const SESSION = '00000000-0000-4000-8000-000000000000'
const hook = (hook_event_name: string, fields: Record<string, unknown> = {}) => ({ session_id: SESSION, hook_event_name, ...fields })

function replay(start: TerminalState, events: unknown[]): TerminalState[] {
  const states: TerminalState[] = []
  let state = start
  for (const event of events) {
    state = stateAfterHook(state, event)
    states.push(state)
  }
  return states
}

describe('stateAfterHook', () => {
  it('goes idle at startup, working on a prompt, idle again when the turn stops', () => {
    expect(
      replay('starting', [
        hook('SessionStart', { source: 'startup' }),
        hook('UserPromptSubmit', { prompt: 'hi' }),
        hook('PreToolUse', { tool_name: 'Read' }),
        hook('PostToolUse', { tool_name: 'Read' }),
        hook('Stop')
      ])
    ).toEqual(['idle', 'working', 'working', 'working', 'idle'])
  })

  it('waits on a permission request and works again once the tool runs', () => {
    /** The order Claude Code 2.1 sends them in for an approved Bash call. */
    expect(
      replay('working', [
        hook('PreToolUse', { tool_name: 'Bash' }),
        hook('PermissionRequest', { tool_name: 'Bash' }),
        hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }),
        hook('PostToolUse', { tool_name: 'Bash' })
      ])
    ).toEqual(['working', 'waiting', 'waiting', 'working'])
  })

  it('waits on a question to the user', () => {
    expect(stateAfterHook('working', hook('PreToolUse', { tool_name: 'AskUserQuestion' }))).toBe('waiting')
  })

  it('ignores subagent activity unless the subagent needs the user', () => {
    expect(stateAfterHook('idle', hook('PreToolUse', { tool_name: 'Read', agent_id: 'a1' }))).toBe('idle')
    expect(stateAfterHook('working', hook('Stop', { agent_id: 'a1' }))).toBe('working')
    expect(stateAfterHook('working', hook('PermissionRequest', { tool_name: 'Bash', agent_id: 'a1' }))).toBe('waiting')
  })

  it('treats resume and clear as idle, and ignores a compaction restart', () => {
    expect(stateAfterHook('starting', hook('SessionStart', { source: 'resume' }))).toBe('idle')
    expect(stateAfterHook('working', hook('SessionStart', { source: 'clear' }))).toBe('idle')
    expect(stateAfterHook('working', hook('SessionStart', { source: 'compact' }))).toBe('working')
    expect(stateAfterHook('idle', hook('PostCompact', { trigger: 'manual' }))).toBe('idle')
    expect(stateAfterHook('working', hook('PostCompact', { trigger: 'auto' }))).toBe('working')
  })

  it('goes idle on the idle reminder after a cancelled turn, but not while waiting on the user', () => {
    expect(stateAfterHook('working', hook('Notification', { notification_type: 'idle_prompt' }))).toBe('idle')
    expect(stateAfterHook('waiting', hook('Notification', { notification_type: 'idle_prompt' }))).toBe('waiting')
  })

  it('treats a failed turn as ended', () => {
    expect(stateAfterHook('working', hook('StopFailure'))).toBe('idle')
  })

  it('never leaves exited, and ignores what it does not recognise', () => {
    expect(stateAfterHook('exited', hook('UserPromptSubmit'))).toBe('exited')
    expect(stateAfterHook('idle', hook('SessionEnd', { reason: 'prompt_input_exit' }))).toBe('idle')
    expect(stateAfterHook('idle', hook('SomethingNew'))).toBe('idle')
    expect(stateAfterHook('idle', { hook_event_name: 42 })).toBe('idle')
    expect(stateAfterHook('idle', null)).toBe('idle')
    expect(stateAfterHook('idle', 'Stop')).toBe('idle')
  })
})
