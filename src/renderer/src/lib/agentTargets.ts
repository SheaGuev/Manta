import type { TerminalInfo } from '../../../shared/ipc'

export interface AgentTarget {
  terminal: TerminalInfo
  sameRoot: boolean
  sendable: boolean
  /** Why it can't be sent to; null when it can. */
  reason: string | null
}

/**
 * The Claude sessions review comments can go to: the worktree's own first, then the most recently
 * started. A session waiting on a permission prompt is listed but not sendable: the text would answer it.
 */
export function agentTargets(terminals: readonly TerminalInfo[], root: string): AgentTarget[] {
  const started = (t: TerminalInfo): string => t.startedAt ?? t.createdAt
  return terminals
    .filter((t) => t.kind === 'claude' && t.state !== 'exited')
    .map((terminal) => {
      const reason = terminal.state === 'waiting' ? 'Waiting for you' : terminal.state === 'starting' ? 'Starting' : null
      return { terminal, sameRoot: terminal.root === root, sendable: reason === null, reason }
    })
    .sort((a, b) => Number(b.sameRoot) - Number(a.sameRoot) || started(b.terminal).localeCompare(started(a.terminal)))
}
