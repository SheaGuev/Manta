import { describe, expect, it } from 'vitest'
import type { DocRef, MapDecision, MapDetail, MapLaunch, MapMilestoneInfo, MapTicket, TerminalInfo } from '../../../../shared/ipc'
import { independentTickets, matchesFilter, needsYou, stripMarks, ticketMeta } from '../mapMilestones'

function ticket(id: string, number: number, status: MapTicket['status'] = 'todo', extra: Partial<MapTicket> = {}): MapTicket {
  return { id, number, title: `T${id}`, description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status, blocked: null, cancelled: null, ...extra }
}

function milestone(id: string, tickets: MapTicket[], status: MapMilestoneInfo['status'] = 'in-progress'): MapMilestoneInfo {
  return { id, title: `M${id}`, description: '', doneWhen: [], tickets, landed: false, manual: null, status }
}

function decision(blocks: string[]): MapDecision {
  return { id: 'dc_1', number: 6, title: 'Domain', question: '', status: 'open', outcome: '', options: [], chosen: null, input: null, blocks, docs: [], from: null, createdAt: '', decidedAt: null }
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

function map(milestones: MapMilestoneInfo[], extra: Partial<Map> = {}): Map {
  return { key: 'OMN', milestones, decisions: [], launches: [], ...extra }
}

const doc = (path: string, heading: string | null = null): DocRef => ({ path, heading })

describe('filters', () => {
  it('counts a ticket as needing you when its agent asks or an open decision holds it', () => {
    const asking = ticket('a', 81, 'in-progress')
    const decided = ticket('b', 82, 'in-progress')
    const free = ticket('c', 83)
    const m = map([milestone('ms_1', [asking, decided, free])], { decisions: [decision(['b'])], launches: [launch({ ticket: 'a' })] })
    expect(needsYou(m, asking, [terminal('waiting')])).toBe(true)
    expect(needsYou(m, decided, [])).toBe(true)
    expect(needsYou(m, free, [])).toBe(false)
    expect(matchesFilter(m, free, 'ready', [])).toBe(true)
    expect(matchesFilter(m, ticket('d', 84, 'done'), 'open', [])).toBe(false)
  })
})

describe('the meta line', () => {
  it('says why a ticket is held, what its agent attached, its dependencies, else its doc section', () => {
    const first = ticket('a', 81, 'in-progress', { docs: [doc('rfc.md', 'API safety')] })
    const waits = ticket('b', 86, 'todo', { after: ['a'] })
    const reviewed = ticket('c', 82, 'in-review')
    const free = ticket('d', 88)
    const afterDone = ticket('e', 89, 'todo', { after: ['f'] })
    const done = ticket('f', 80, 'done')
    const wrapUp = { summary: '', wentToPlan: true, finished: true, criteria: [1, 2, 3, 4].map((index) => ({ ticket: 'c', index, met: true, evidence: '', source: '' })), checks: [], unverified: [], decisions: [], risks: [], at: '', sweep: false }
    const m = map([milestone('ms_1', [first, waits, reviewed, free, afterDone, done])], { launches: [launch({ ticket: 'c' }, { wrapUp })] })
    expect(ticketMeta(m, first)).toBe('API safety')
    expect(ticketMeta(m, waits)).toBe('Depends on OMN-81')
    expect(ticketMeta(m, reviewed)).toBe('4 checks attached')
    expect(ticketMeta(m, free)).toBe('No dependencies')
    expect(ticketMeta(m, afterDone)).toBe('After OMN-80')
    expect(ticketMeta({ ...m, decisions: [decision(['a'])] }, first)).toBe('Decision 006 required')
  })
})

describe('independent tickets', () => {
  it('starts ready tickets together unless they share a doc section', () => {
    const a = ticket('a', 1, 'todo', { docs: [doc('rfc.md', 'Store')] })
    const b = ticket('b', 2, 'todo', { docs: [doc('rfc.md', 'Screens')] })
    const c = ticket('c', 3, 'todo', { docs: [doc('rfc.md')] })
    const d = ticket('d', 4, 'todo', { after: ['x'] })
    const x = ticket('x', 5, 'in-progress')
    const ms = milestone('ms_1', [a, b, c, d, x])
    const { tickets, held } = independentTickets(map([ms]), ms)
    expect(tickets.map((t) => t.id)).toEqual(['a', 'b'])
    expect(held.map((t) => t.id)).toEqual(['c'])
  })
})

describe('the milestone strip', () => {
  it('marks done milestones, the current one, and the next one not done after it', () => {
    const m = map([milestone('m1', [], 'done'), milestone('m2', []), milestone('m3', [], 'done'), milestone('m4', [])])
    expect([...stripMarks(m, 'm2').values()]).toEqual(['done', 'current', 'done', 'next'])
    expect([...stripMarks(m, null).values()]).toEqual(['done', null, 'done', null])
  })
})
