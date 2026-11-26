import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '../../../../shared/ipc'
import { mostUrgent, rootState, stateLabel } from '../terminalStatus'

const terminal = (extra: Partial<TerminalInfo>): TerminalInfo => ({
  id: 'term_1',
  root: '/repo',
  kind: 'claude',
  title: 'Claude',
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

describe('rootState', () => {
  it("shows the root's most urgent Claude session", () => {
    const terminals = [terminal({ state: 'idle' }), terminal({ state: 'waiting' }), terminal({ state: 'working' })]
    expect(rootState(terminals, '/repo')).toBe('waiting')
    expect(rootState([terminal({ state: 'idle' }), terminal({ state: 'working' })], '/repo')).toBe('working')
  })

  it('ignores shells, exited sessions and other roots', () => {
    expect(rootState([terminal({ kind: 'shell', state: 'running' })], '/repo')).toBeNull()
    expect(rootState([terminal({ state: 'exited' })], '/repo')).toBeNull()
    expect(rootState([terminal({ state: 'waiting', root: '/other' })], '/repo')).toBeNull()
    expect(rootState([], '/repo')).toBeNull()
  })
})

describe('mostUrgent', () => {
  it("picks the most urgent Claude state among any terminals, such as a map's sessions across roots", () => {
    const map = { docsRoot: '/docs', map: 'm_1', launch: null, ticket: null }
    expect(mostUrgent([terminal({ state: 'idle', map }), terminal({ state: 'working', root: '/worktree', map })])).toBe('working')
    expect(mostUrgent([terminal({ kind: 'shell', state: 'running' })])).toBeNull()
    expect(mostUrgent([])).toBeNull()
  })
})

describe('stateLabel', () => {
  it('names live states and how a terminal ended', () => {
    expect(stateLabel(terminal({ state: 'waiting' }))).toBe('Waiting for you')
    expect(stateLabel(terminal({ state: 'exited', exitCode: 0 }))).toBe('Exited')
    expect(stateLabel(terminal({ state: 'exited', exitCode: 130 }))).toBe('Exited with code 130')
    expect(stateLabel(terminal({ state: 'exited', startedAt: null }))).toBe('Ended when Manta quit')
  })
})
