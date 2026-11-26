import type { TerminalInfo, TerminalState } from '../../../shared/ipc'

/** Most urgent first: a session waiting on the user beats one that's busy, which beats one at its prompt. */
const URGENCY: readonly TerminalState[] = ['waiting', 'working', 'starting', 'idle']

/** The Claude state a context's sidebar row shows: its most urgent session's; null when none is running. */
export function rootState(terminals: TerminalInfo[], root: string): TerminalState | null {
  return mostUrgent(terminals.filter((t) => t.root === root))
}

/** The most urgent state among these terminals' Claude sessions; null when none is running. */
export function mostUrgent(terminals: TerminalInfo[]): TerminalState | null {
  const states = new Set(terminals.filter((t) => t.kind === 'claude').map((t) => t.state))
  return URGENCY.find((state) => states.has(state)) ?? null
}

const LABELS: Record<TerminalState, string> = {
  starting: 'Starting…',
  running: 'Running',
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'Ready',
  exited: 'Exited'
}

export function stateLabel(info: TerminalInfo): string {
  if (info.state !== 'exited') return LABELS[info.state]
  if (info.startedAt === null) return 'Ended when Manta quit'
  return info.exitCode === null || info.exitCode === 0 ? 'Exited' : `Exited with code ${info.exitCode}`
}
