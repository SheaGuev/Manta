import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '../../../../shared/ipc'
import { agentTargets } from '../agentTargets'

const terminal = (id: string, extra: Partial<TerminalInfo>): TerminalInfo => ({
  id,
  root: '/repo',
  kind: 'claude',
  title: id,
  sessionId: 's',
  resumable: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  startedAt: '2026-10-20T10:00:00.000Z',
  state: 'idle',
  exitCode: null,
  link: null,
  map: null,
  ...extra
})

describe('agentTargets', () => {
  it('lists Claude sessions in the same worktree first, then the newest', () => {
    const terminals = [
      terminal('other-old', { root: '/other', startedAt: '2026-10-20T09:00:00.000Z' }),
      terminal('here-old', { startedAt: '2026-10-20T08:00:00.000Z' }),
      terminal('other-new', { root: '/other', startedAt: '2026-10-20T11:00:00.000Z' }),
      terminal('here-new', { startedAt: null, createdAt: '2026-10-20T12:00:00.000Z' })
    ]
    expect(agentTargets(terminals, '/repo').map((t) => [t.terminal.id, t.sameRoot])).toEqual([
      ['here-new', true],
      ['here-old', true],
      ['other-new', false],
      ['other-old', false]
    ])
  })

  it('leaves out shells and exited sessions', () => {
    const terminals = [terminal('shell', { kind: 'shell', state: 'running' }), terminal('gone', { state: 'exited' }), terminal('live', {})]
    expect(agentTargets(terminals, '/repo').map((t) => t.terminal.id)).toEqual(['live'])
  })

  it("lists waiting and starting sessions but doesn't let them be sent to", () => {
    const terminals = [terminal('waiting', { state: 'waiting' }), terminal('starting', { state: 'starting' }), terminal('working', { state: 'working' })]
    expect(agentTargets(terminals, '/repo').map((t) => [t.terminal.id, t.sendable, t.reason])).toEqual([
      ['waiting', false, 'Waiting for you'],
      ['starting', false, 'Starting'],
      ['working', true, null]
    ])
  })
})
