import { describe, expect, it } from 'vitest'
import type { MapBatch, MapDetail, MapLaunch, MapTicket, TerminalInfo } from '../../../../shared/ipc'
import { boardGroups, coordinatorState, needsYou } from '../mapBoard'

function ticket(id: string, extra: Partial<MapTicket> = {}): MapTicket {
  return { id, number: 1, title: `T ${id}`, description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status: 'in-progress', blocked: null, cancelled: null, ...extra }
}

function launch(id: string, ticketId: string, batch: string | null): MapLaunch {
  return {
    id,
    scope: { ticket: ticketId },
    project: '/c',
    worktree: '/w',
    branch: 'b',
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
    batch
  }
}

function terminal(id: string, state: TerminalInfo['state']): TerminalInfo {
  return { id, root: '/w', kind: 'claude', title: id, sessionId: 's', resumable: true, createdAt: '', startedAt: '', state, exitCode: null, link: null, map: null }
}

const batch = (id: string, createdAt: string, extra: Partial<MapBatch> = {}): MapBatch => ({ id, createdAt, coordinator: null, declined: false, ...extra })

function map(launches: MapLaunch[], batches: MapBatch[], tickets: MapTicket[]): Pick<MapDetail, 'milestones' | 'launches' | 'batches'> {
  return { launches, batches, milestones: [{ id: 'ms_1', title: 'M', description: '', doneWhen: [], tickets, landed: false, manual: null, status: 'in-progress' }] }
}

describe('boardGroups', () => {
  it('groups rows by batch, newest batch first, then the rest, with titles, blocks and what each unblocks', () => {
    const tickets = [ticket('tk_1'), ticket('tk_2', { status: 'blocked', blocked: 'Needs keys' }), ticket('tk_3'), ticket('tk_4', { status: 'todo', after: ['tk_1'] })]
    const detail = map([launch('l_1', 'tk_1', 'b_old111'), launch('l_2', 'tk_2', 'b_new111'), launch('l_3', 'tk_3', null)], [batch('b_old111', '1'), batch('b_new111', '2'), batch('b_empty1', '3')], tickets)
    const groups = boardGroups({ ...base, ...detail }, [terminal('term_l_1', 'working'), terminal('term_l_2', 'idle'), terminal('term_l_3', 'idle')])
    expect(groups.map((g) => [g.batch?.id ?? null, g.rows.map((r) => r.title)])).toEqual([
      ['b_new111', ['T tk_2']],
      ['b_old111', ['T tk_1']],
      [null, ['T tk_3']]
    ])
    expect(groups[0]?.rows[0]?.attention).toBe('Blocked: Needs keys')
    expect(groups[1]?.rows[0]?.unblocks).toBe(1)
    expect(needsYou(groups)).toBe(1)
  })

  it('says whether a batch has a coordinator running, stopped, or none', () => {
    const coordinator = { terminal: 'term_c', session: 's', startedAt: '' }
    expect(coordinatorState(batch('b_111111', ''), [])).toBe('none')
    expect(coordinatorState(batch('b_111111', '', { coordinator }), [terminal('term_c', 'idle')])).toBe('running')
    expect(coordinatorState(batch('b_111111', '', { coordinator }), [terminal('term_c', 'exited')])).toBe('stopped')
    expect(coordinatorState(batch('b_111111', '', { coordinator }), [])).toBe('stopped')
  })
})

const base: MapDetail = {
  id: 'm_1',
  title: 'Map',
  description: '',
  createdAt: '',
  current: null,
  waiting: 0,
  running: false,
  key: 'MAP',
  stage: 'building',
  stageSet: null,
  lastVisitedAt: null,
    seenAt: null,
    activity: [],
  projects: [],
  launchMode: 'ticket',
  sweep: true,
  confirmProposals: 'ask',
  pinned: null,
  checks: [],
  docs: [],
  sections: [],
  milestones: [],
  decisions: [],
  launches: [],
  batches: [],
  suggestions: [],
  proposals: [],
  messages: []
}
