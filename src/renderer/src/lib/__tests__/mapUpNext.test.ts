import { describe, expect, it } from 'vitest'
import type { MapDetail, MapLaunch, MapMilestoneInfo, MapTicket, PullRequestInfo, TerminalInfo } from '../../../../shared/ipc'
import { homeUpNext, needsReview, ticketUpNext } from '../mapUpNext'

function ticket(id: string, status: MapTicket['status'] = 'todo', extra: Partial<MapTicket> = {}): MapTicket {
  return { id, number: 1, title: `T${id}`, description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status, blocked: null, cancelled: null, ...extra }
}

function milestone(id: string, tickets: MapTicket[], status: MapMilestoneInfo['status'] = 'todo'): MapMilestoneInfo {
  return { id, title: `M${id}`, description: '', doneWhen: [], tickets, landed: false, manual: null, status }
}

function launch(scope: MapLaunch['scope'], extra: Partial<MapLaunch> = {}): MapLaunch {
  return { id: 'l_1', scope, project: '/c', worktree: '/w', branch: 'manta/x', base: null, sessions: [{ terminal: 'term_1', session: 's', ticket: null, startedAt: '', progress: null }], pr: null, landed: false, createdAt: '', wrappedUpAt: null, sweptAt: null, readyAt: null, wrapUp: null, health: null, landingSweptAt: null, batch: null, ...extra }
}

function terminal(state: TerminalInfo['state']): TerminalInfo {
  return { id: 'term_1', root: '/w', kind: 'claude', title: 'Session', sessionId: 's', resumable: true, createdAt: '', startedAt: '', state, exitCode: null, link: null, map: null }
}

function map(extra: Partial<MapDetail> = {}): MapDetail {
  const milestones = extra.milestones ?? []
  const current = milestones.find((m) => m.status !== 'done') ?? null
  return {
    id: 'm_1',
    title: 'Map',
    description: '',
    createdAt: '',
    current: current ? { id: current.id, title: current.title, done: 0, total: current.tickets.length } : null,
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
    milestones,
    decisions: [],
    launches: [],
    batches: [],
    suggestions: [],
    proposals: [],
    messages: [],
    ...extra
  }
}

describe('Up next on Home', () => {
  it('plans first: a PRD with no docs, a breakdown with docs, more once everything is done', () => {
    expect(homeUpNext(map(), [])).toMatchObject({ button: 'Write a PRD', action: { kind: 'write-doc' } })
    expect(homeUpNext(map({ docs: [{ path: 'prd.md', milestones: [], section: null, roles: [], exists: true, title: 'prd', updatedAt: null }] }), [])).toMatchObject({ button: 'Break down', action: { kind: 'break-down' } })
    expect(homeUpNext(map({ milestones: [milestone('a', [ticket('1', 'done')], 'done')] }), [])).toMatchObject({ button: 'Plan more' })
  })

  it("starts the current milestone's next ticket, or the milestone itself when it has none", () => {
    expect(homeUpNext(map({ milestones: [milestone('a', [ticket('1', 'done'), ticket('2')], 'in-progress')] }), [])).toMatchObject({ sentence: 'Start “T2”', action: { kind: 'start-ticket', ticket: { id: '2' } } })
    expect(homeUpNext(map({ milestones: [milestone('a', [])] }), [])).toMatchObject({ button: 'Start milestone', action: { kind: 'start-milestone' } })
  })

  it('moves on to the next milestone when the current one has nothing left to start', () => {
    const detail = map({ milestones: [milestone('a', [ticket('1', 'in-review')], 'in-progress'), milestone('b', [ticket('2')])] })
    expect(homeUpNext(detail, [])).toMatchObject({ sentence: '“Ma” is done. Start “T2”', action: { kind: 'start-ticket', ticket: { id: '2' } } })
  })

  it('puts what waits on the user first and counts the rest, then running work', () => {
    const blocked = map({ milestones: [milestone('a', [ticket('1', 'blocked', { blocked: 'Needs a key' }), ticket('2')], 'in-progress')], proposals: [{ thread: 't_1', doc: 'docs/rfc.md', title: 'Fix it', from: { launch: 'l_1' } }] })
    expect(homeUpNext(blocked, [])).toMatchObject({ sentence: 'A change is proposed to rfc: Fix it (and 1 more waiting)', button: 'Review' })
    expect(needsReview(blocked, []).map((i) => i.kind)).toEqual(['proposal', 'blocked'])

    const running = map({ milestones: [milestone('a', [ticket('1', 'in-progress'), ticket('2')], 'in-progress')], launches: [launch({ ticket: '1' })] })
    expect(homeUpNext(running, [terminal('working')])).toMatchObject({ button: 'Open session', action: { kind: 'open-session', terminal: 'term_1' } })
    expect(homeUpNext(running, [terminal('waiting')])).toMatchObject({ sentence: '“Session” is waiting for you', action: { kind: 'review' } })
    expect(homeUpNext(running, [terminal('exited')])).toMatchObject({ action: { kind: 'start-ticket', ticket: { id: '2' } } })
  })
})

describe('Up next on a ticket', () => {
  it('Ticket: start, open its session, review its pull request, or nothing once done', () => {
    const todo = ticket('1')
    expect(ticketUpNext(map({ milestones: [milestone('a', [todo])] }), todo, [])).toMatchObject({ button: 'Start' })
    const going = ticket('1', 'in-progress')
    const withLaunch = map({ milestones: [milestone('a', [going])], launches: [launch({ ticket: '1' })] })
    expect(ticketUpNext(withLaunch, going, [])).toMatchObject({ button: 'Open session', sentence: 'Pick up where its session left off' })
    const review = ticket('1', 'in-review')
    const withPr = map({ milestones: [milestone('a', [review])], launches: [launch({ ticket: '1' }, { pr: { number: 3, state: 'open', url: 'u' } })] })
    expect(ticketUpNext(withPr, review, [])).toMatchObject({ button: 'Review PR', action: { kind: 'review-pr', pr: { number: 3 } } })
    expect(ticketUpNext(map(), ticket('1', 'done'), [])).toBeNull()
  })

  it('a blocked ticket asks for an answer in its session without repeating the reason, which the page shows once', () => {
    const blocked = ticket('1', 'blocked', { blocked: 'Needs a physical phone' })
    const next = ticketUpNext(map({ milestones: [milestone('a', [blocked])], launches: [launch({ ticket: '1' })] }), blocked, [])
    expect(next).toMatchObject({ button: 'Open session', sentence: 'Answer what it’s blocked on in its session' })
    expect(next?.sentence).not.toContain('physical phone')
  })
})

describe('finishing work and running it in parallel', () => {
  it('offers to open the pull request of finished work, and sends failing checks or change requests back', () => {
    const t = ticket('tk_1', 'in-progress')
    const ready = launch({ ticket: 'tk_1' }, { readyAt: '2026-11-20T00:00:00Z', wrapUp: { summary: 'Shortened sessions. Kept the cookie.', wentToPlan: true, finished: true, criteria: [], checks: [], unverified: [], decisions: [], risks: [], at: '', sweep: false } })
    const m = map({ milestones: [milestone('ms_1', [t], 'in-progress')], launches: [ready] })
    expect(homeUpNext(m, [terminal('idle')])).toMatchObject({ sentence: '“Shortened sessions” is finished: open its pull request', button: 'Open PR' })
    expect(needsReview(m, [terminal('working')])).toEqual([])

    const pr: PullRequestInfo = { number: 7, state: 'open', url: 'u' }
    const failing = launch({ ticket: 'tk_1' }, { pr, health: { checks: 'failed', failing: ['test'], review: 'none', unresolved: 0 } })
    expect(homeUpNext(map({ milestones: [milestone('ms_1', [t], 'in-progress')], launches: [failing] }), [])).toMatchObject({ sentence: 'Checks failed on pull request #7: test', button: 'Send to session' })
    const asked = launch({ ticket: 'tk_1' }, { pr, health: { checks: 'passed', failing: [], review: 'changes-requested', unresolved: 2 } })
    expect(ticketUpNext(map({ milestones: [milestone('ms_1', [t], 'in-progress')], launches: [asked] }), t, [])).toMatchObject({ sentence: 'Pull request #7 has review comments to address (2 unresolved)', button: 'Send to session' })
    const approved = launch({ ticket: 'tk_1' }, { pr, health: { checks: 'passed', failing: [], review: 'approved', unresolved: 0 } })
    expect(homeUpNext(map({ milestones: [milestone('ms_1', [t], 'in-progress')], launches: [approved] }), [])).toMatchObject({ sentence: 'Pull request #7 is approved: merge it', button: 'Review PR' })
  })

  it('starts the tickets that can run now in parallel, each in its own worktree, and skips ones still waiting', () => {
    const tickets = [ticket('a'), ticket('b'), ticket('c', 'todo', { after: ['a'] })]
    const next = homeUpNext(map({ milestones: [milestone('ms_1', tickets)] }), [])
    expect(next).toMatchObject({ button: 'Start 2', action: { kind: 'start-ready' } })
    expect(next.action.kind === 'start-ready' && next.action.tickets.map((x) => x.id)).toEqual(['a', 'b'])
    expect(homeUpNext(map({ milestones: [milestone('ms_1', tickets)], launchMode: 'milestone' }), [])).toMatchObject({ sentence: 'Start “Ta”', button: 'Start' })
    expect(ticketUpNext(map({ milestones: [milestone('ms_1', tickets)] }), tickets[2] ?? ticket('x'), [])).toMatchObject({ sentence: 'It waits for “Ta”; start it anyway?' })
  })
})

