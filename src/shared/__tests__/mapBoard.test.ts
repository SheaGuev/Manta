import { describe, expect, it } from 'vitest'
import type { MapLaunch, SessionProgress, TerminalState } from '../ipc'
import { boardRows, boardText, signalOf, sortBoard, type BoardInput } from '../mapBoard'

function launch(id: string, extra: Partial<MapLaunch> = {}): MapLaunch {
  return {
    id,
    scope: { ticket: `tk_${id}` },
    project: '/c',
    worktree: '/w',
    branch: `manta/${id}`,
    base: null,
    sessions: [{ terminal: `term_${id}`, session: 's', ticket: null, startedAt: '', progress: null }],
    pr: null,
    landed: false,
    createdAt: '',
    wrappedUpAt: null,
    sweptAt: null,
    readyAt: null,
    wrapUp: null,
    health: null,
    landingSweptAt: null,
    batch: null,
    ...extra
  }
}

const progress = (extra: Partial<SessionProgress> = {}): SessionProgress => ({ phase: 'building', summary: 'Writing the store', needs: null, next: null, at: '', ...extra })

function input(launches: MapLaunch[], states: Record<string, TerminalState> = {}, extra: Partial<BoardInput> = {}): BoardInput {
  return { launches, states: new Map(Object.entries(states)), title: (l) => `Ticket ${l.id}`, blocked: () => null, unblocks: () => 0, ...extra }
}

describe('boardRows', () => {
  it('ranks what needs the user: waiting or blocked, a decision, finished work, PR fixes, ready to merge, then nothing', () => {
    const rows = boardRows(
      input(
        [
          launch('a'),
          launch('b', { sessions: [{ terminal: 'term_b', session: 's', ticket: null, startedAt: '', progress: progress({ needs: { kind: 'decision', ask: 'Which store?' } }) }] }),
          launch('c', { readyAt: 'now' }),
          launch('d', { pr: { number: 4, state: 'open', url: 'u' }, health: { checks: 'failed', failing: ['test'], review: 'none', unresolved: 0 } }),
          launch('e', { pr: { number: 5, state: 'open', url: 'u' }, health: { checks: 'passed', failing: [], review: 'approved', unresolved: 0 } }),
          launch('f'),
          launch('g', { landed: true })
        ],
        { term_a: 'waiting', term_b: 'idle', term_c: 'idle', term_d: 'idle', term_e: 'exited', term_f: 'working' }
      )
    )
    expect(rows.map((r) => [r.launch, r.rank, r.attention])).toEqual([
      ['a', 0, 'Waiting for you in its session'],
      ['b', 1, 'Which store?'],
      ['c', 2, 'Finished: open its pull request'],
      ['d', 3, 'Checks failing on #4'],
      ['e', 4, 'Approved: merge #5'],
      ['f', 5, null]
    ])
    expect(rows.find((r) => r.launch === 'e')?.state).toBe('exited')
  })

  it('gives a blocked ticket rank 0, shows a launch with no session yet as closed, and keeps one row per focused ticket', () => {
    const shared = launch('m', {
      scope: { milestone: 'ms_1' },
      sessions: [
        { terminal: 'term_1', session: 's1', ticket: 'tk_1', startedAt: '', progress: null },
        { terminal: 'term_2', session: 's2', ticket: 'tk_2', startedAt: '', progress: null },
        { terminal: 'term_3', session: 's3', ticket: 'tk_1', startedAt: '', progress: progress() }
      ]
    })
    const rows = boardRows(input([shared, launch('n', { sessions: [] })], { term_3: 'working' }, { blocked: (_l, ticket) => (ticket === 'tk_2' ? 'Needs the API' : null) }))
    expect(rows.map((r) => [r.ticket, r.terminal, r.state, r.attention])).toEqual([
      ['tk_1', 'term_3', 'working', null],
      ['tk_2', 'term_2', 'closed', 'Blocked: Needs the API'],
      [null, null, 'closed', null]
    ])
  })
})

describe('sortBoard and boardText', () => {
  it('puts the batch first, then urgency, then what unblocks most, in a line each', () => {
    const rows = boardRows(
      input(
        [launch('a', { batch: 'b_111111' }), launch('b'), launch('c', { readyAt: 'now' }), launch('d', { batch: 'b_111111', sessions: [{ terminal: 'term_d', session: 's', ticket: null, startedAt: '', progress: progress({ next: 'tests' }) }] })],
        { term_a: 'working', term_b: 'working', term_c: 'idle', term_d: 'working' },
        { unblocks: (l) => (l.id === 'd' ? 2 : 0) }
      )
    )
    expect(sortBoard(rows, 'b_111111').map((r) => r.launch)).toEqual(['d', 'a', 'c', 'b'])
    const text = boardText(rows, 'b_111111')
    expect(text.split('\n')[0]).toBe('- Ticket d [launch d; this batch, 2 wait for it] (building, working) “Writing the store” next: tests')
    expect(text).toContain('- Ticket c [launch c] (at its prompt) → NEEDS YOU: Finished: open its pull request')
    expect(boardText([])).toBe('Nothing is running on the map.')
  })

  it('signals change only when what the user is needed for, or whether the session is live, does', () => {
    const [working] = boardRows(input([launch('a')], { term_a: 'working' }))
    const [idle] = boardRows(input([launch('a', { sessions: [{ terminal: 'term_a', session: 's', ticket: null, startedAt: '', progress: progress({ summary: 'other' }) }] })], { term_a: 'idle' }))
    const [ended] = boardRows(input([launch('a')], { term_a: 'exited' }))
    if (!working || !idle || !ended) throw new Error('rows missing')
    expect(signalOf(working)).toBe(signalOf(idle))
    expect(signalOf(ended)).not.toBe(signalOf(working))
  })
})
