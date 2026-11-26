import { describe, expect, it } from 'vitest'
import type { MapDecision, MapDetail, MapLaunch, MapTicket, TerminalInfo } from '../../../../shared/ipc'
import { agentActivity, authorLabel, isReady, milestoneKey, ticketKey, workState } from '../mapStatus'

function ticket(id: string, number: number, status: MapTicket['status'] = 'todo', extra: Partial<MapTicket> = {}): MapTicket {
  return { id, number, title: `T${id}`, description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status, blocked: null, cancelled: null, ...extra }
}

function decision(blocks: string[], status: MapDecision['status'] = 'open'): MapDecision {
  return { id: 'dc_1', number: 6, title: 'Domain', question: '', status, outcome: status === 'decided' ? 'x' : '', options: [], chosen: null, input: null, blocks, docs: [], from: null, createdAt: '', decidedAt: null }
}

function launch(scope: MapLaunch['scope'], extra: Partial<MapLaunch> = {}): MapLaunch {
  return {
    id: 'l_1',
    scope,
    project: '/c',
    worktree: '/w',
    branch: 'manta/x',
    base: null,
    sessions: [{ terminal: 'term_1', session: 's', ticket: null, startedAt: '', progress: null }],
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

function terminal(state: TerminalInfo['state']): TerminalInfo {
  return { id: 'term_1', root: '/w', kind: 'claude', title: 'Session', sessionId: 's', resumable: true, createdAt: '', startedAt: '', state, exitCode: null, link: null, map: null }
}

type Map = Pick<MapDetail, 'key' | 'milestones' | 'decisions' | 'launches'>

function map(tickets: MapTicket[], extra: Partial<Map> = {}): Map {
  return { key: 'OMN', milestones: [{ id: 'ms_1', title: 'M', description: '', doneWhen: [], tickets, landed: false, manual: null, status: 'in-progress' }], decisions: [], launches: [], ...extra }
}

describe('keys', () => {
  it('keys tickets by the map and number, milestones by their place', () => {
    const m = map([ticket('a', 81)])
    expect(ticketKey(m, { number: 81 })).toBe('OMN-81')
    expect(milestoneKey(m, { id: 'ms_1' })).toBe('M1')
  })
})

describe('authorLabel', () => {
  it('names the agent by what its launch works on, the sweep, Ask the map, or a launch that is gone', () => {
    const m = map([ticket('a', 81), ticket('b', 82)], { launches: [launch({ ticket: 'a' }), launch({ tickets: ['a', 'b'] }, { id: 'l_2' })] })
    expect(authorLabel(m, { launch: 'l_1' })).toBe('the agent on “Ta”')
    expect(authorLabel(m, { sweep: 'l_2' })).toBe('the sweep of “Ta and 1 more”')
    expect(authorLabel(m, { ask: true })).toBe('Ask the map')
    expect(authorLabel(m, { launch: 'l_gone' })).toBe('the agent on a removed launch')
  })
})

describe('work status', () => {
  it('shows a ticket to do as ready, or blocked by what it depends on or an open decision', () => {
    const first = ticket('a', 81, 'in-progress')
    const waits = ticket('b', 86, 'todo', { after: ['a'] })
    const free = ticket('c', 88)
    const m = map([first, waits, free])
    expect(workState(m, waits)).toEqual({ status: 'blocked', reason: 'Depends on OMN-81' })
    expect(workState(m, free)).toEqual({ status: 'ready', reason: null })
    expect(isReady(m, free)).toBe(true)

    const held = map([first, waits, free], { decisions: [decision(['c'])] })
    expect(workState(held, free)).toEqual({ status: 'blocked', reason: 'Decision 006 required' })
    expect(isReady(held, free)).toBe(false)
    expect(workState(map([free], { decisions: [decision(['c'], 'decided')] }), free).status).toBe('ready')
  })

  it('keeps the other statuses, with the agent’s reason when it reported blocked', () => {
    const m = map([])
    expect(workState(m, ticket('a', 1, 'in-review'))).toEqual({ status: 'in-review', reason: null })
    expect(workState(m, ticket('a', 1, 'blocked', { blocked: 'Needs a key' }))).toEqual({ status: 'blocked', reason: 'Needs a key' })
  })
})

describe('agent activity', () => {
  it('is none before any launch, then follows its session', () => {
    const t = ticket('a', 1, 'in-progress')
    expect(agentActivity(map([t]), t, [])).toBe('none')
    const launched = map([t], { launches: [launch({ ticket: 'a' })] })
    expect(agentActivity(launched, t, [terminal('working')])).toBe('working')
    expect(agentActivity(launched, t, [terminal('waiting')])).toBe('needs-you')
    expect(agentActivity(launched, t, [terminal('idle')])).toBe('paused')
    expect(agentActivity(launched, t, [terminal('exited')])).toBe('paused')
  })

  it('is finished once the agent says so, and needs you when it reported a need or a block', () => {
    const t = ticket('a', 1, 'in-progress')
    expect(agentActivity(map([t], { launches: [launch({ ticket: 'a' }, { readyAt: 'now' })] }), t, [])).toBe('finished')
    const review = ticket('a', 1, 'in-review')
    expect(agentActivity(map([review], { launches: [launch({ ticket: 'a' })] }), review, [terminal('idle')])).toBe('finished')
    const blocked = ticket('a', 1, 'blocked', { blocked: 'Key' })
    expect(agentActivity(map([blocked], { launches: [launch({ ticket: 'a' })] }), blocked, [])).toBe('needs-you')
    const asking = launch({ ticket: 'a' }, { sessions: [{ terminal: 'term_1', session: 's', ticket: null, startedAt: '', progress: { phase: 'building', summary: '', needs: { kind: 'decision', ask: 'Which?' }, next: null, at: '' } }] })
    expect(agentActivity(map([t], { launches: [asking] }), t, [terminal('idle')])).toBe('needs-you')
  })

  it('works again when new work starts on a finished ticket', () => {
    const t = ticket('a', 1, 'in-progress')
    const done = launch({ ticket: 'a' }, { id: 'l_1', readyAt: 'then' })
    const again = launch({ ticket: 'a' }, { id: 'l_2', sessions: [{ terminal: 'term_1', session: 's2', ticket: null, startedAt: '', progress: null }] })
    expect(agentActivity(map([t], { launches: [done, again] }), t, [terminal('working')])).toBe('working')
  })
})
