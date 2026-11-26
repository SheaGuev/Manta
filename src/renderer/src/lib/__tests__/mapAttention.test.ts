import { describe, expect, it } from 'vitest'
import type { MapDecision, MapDetail, MapEvent, MapLaunch, MapMilestoneInfo, MapTicket, PullRequestInfo, TerminalInfo } from '../../../../shared/ipc'
import { attentionItems, decisionSummaries, docSummaries, overviewReview, recommendedNext, sinceLastVisit } from '../mapAttention'

function ticket(id: string, status: MapTicket['status'] = 'todo', extra: Partial<MapTicket> = {}): MapTicket {
  return { id, number: 1, title: `T${id}`, description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status, blocked: null, ...extra }
}

function milestone(tickets: MapTicket[]): MapMilestoneInfo {
  return { id: 'ms_1', title: 'Release', description: '', doneWhen: [], tickets, landed: false, manual: null, status: 'in-progress' }
}

function decision(id: string, blocks: string[], extra: Partial<MapDecision> = {}): MapDecision {
  return { id, number: 6, title: 'Production domain', question: 'Which?', status: 'open', outcome: '', options: [], chosen: null, input: null, blocks, docs: [], from: null, createdAt: '2026-11-20T00:00:00Z', decidedAt: null, ...extra }
}

function launch(id: string, scope: MapLaunch['scope'], extra: Partial<MapLaunch> = {}): MapLaunch {
  return {
    id,
    scope,
    project: '/c',
    worktree: '/w',
    branch: 'manta/x',
    base: null,
    sessions: [{ terminal: `term_${id}`, session: 's', ticket: null, startedAt: '2026-11-20T00:00:00Z', progress: null }],
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

function terminal(id: string, state: TerminalInfo['state']): TerminalInfo {
  return { id, root: '/w', kind: 'claude', title: 'Session', sessionId: 's', resumable: true, createdAt: '', startedAt: '', state, exitCode: null, link: null, map: null }
}

function map(extra: Partial<MapDetail> = {}): MapDetail {
  const milestones = extra.milestones ?? []
  return {
    id: 'm_1',
    title: 'Omni',
    description: '',
    createdAt: '',
    current: milestones[0] ? { id: milestones[0].id, title: milestones[0].title, done: 0, total: milestones[0].tickets.length } : null,
    waiting: 0,
    running: false,
    key: 'OMN',
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

describe('attention items', () => {
  it('puts open decisions and waiting agents first, by how much they hold back, then reviews', () => {
    const build = ticket('a', 'todo')
    const run = ticket('b', 'todo')
    const asking = ticket('c', 'in-progress', { after: [] })
    const waitsOnC = ticket('d', 'todo', { after: ['c'] })
    const finished = ticket('e', 'in-review')
    const m = map({
      milestones: [milestone([build, run, asking, waitsOnC, finished])],
      decisions: [decision('dc_1', ['a', 'b'])],
      launches: [launch('l_c', { ticket: 'c' }), launch('l_e', { ticket: 'e' }, { pr: { number: 4, state: 'open', url: 'u' }, wrapUp: { summary: '', wentToPlan: true, finished: true, criteria: [{ ticket: 'e', index: 0, met: true, evidence: '', source: '' }, { ticket: 'e', index: 1, met: true, evidence: '', source: '' }], checks: [], unverified: [], decisions: [], risks: [], at: '', sweep: false } })],
      proposals: [
        { thread: 't1', doc: 'run.md', title: 'One', from: { launch: 'l_c' } },
        { thread: 't2', doc: 'run.md', title: 'Two', from: { launch: 'l_e' } }
      ],
      docs: [{ path: 'run.md', milestones: [], section: null, roles: ['release'], exists: true, title: 'Production runbook', updatedAt: null }]
    })
    const items = attentionItems(m, [terminal('term_l_c', 'waiting')])
    expect(items.map((i) => [i.verb, i.title, i.detail])).toEqual([
      ['Decide', 'Production domain', 'Decision 006 · Blocking 2 tickets'],
      ['Answer', 'Tc', 'Waiting for you in its session'],
      ['Review', 'Te', 'Pull request #4 open · 2 acceptance checks attached'],
      ['Review', '2 documentation changes proposed', 'Production runbook · From 2 agent sessions']
    ])
    expect(items[1]?.blocks).toBe(1)
  })

  it('asks to verify merged work, and to review finished work', () => {
    const merged = ticket('a', 'in-review')
    const finished = ticket('b', 'in-progress')
    const m = map({
      milestones: [milestone([merged, finished])],
      launches: [launch('l_a', { ticket: 'a' }, { landed: true, pr: { number: 3, state: 'merged', url: 'u' } }), launch('l_b', { ticket: 'b' }, { readyAt: '2026-11-23T00:00:00Z' })]
    })
    expect(attentionItems(m, []).map((i) => [i.verb, i.detail])).toEqual([
      ['Verify', 'Pull request #3 merged · verify it and mark it done'],
      ['Review', 'Agent finished']
    ])
    expect(attentionItems(m, []).map((i) => i.target.kind)).toEqual(['review-ticket', 'review-ticket'])
    expect(recommendedNext(m, [])).toMatchObject({ title: 'Verify “Ta”', button: 'Review work' })
  })

  it('leaves out decided decisions and agents just working', () => {
    const m = map({ milestones: [milestone([ticket('a', 'in-progress')])], decisions: [decision('dc_1', ['a'], { status: 'decided', outcome: 'x' })], launches: [launch('l_a', { ticket: 'a' })] })
    expect(attentionItems(m, [terminal('term_l_a', 'working')])).toEqual([])
  })
})

describe('Overview Needs review', () => {
  it('opens several proposals for one doc on the Docs page, and suggestions in Needs review', () => {
    const proposal = (thread: string): MapDetail['proposals'][number] => ({ thread, doc: 'docs/run.md', title: thread, from: { launch: 'l_1' } })
    const suggestion: MapDetail['suggestions'][number] = { id: 'sg_1', kind: 'add-doc', path: 'x.md', why: '', milestones: [], from: { ask: true }, at: '' }
    const m = map({ proposals: [proposal('a'), proposal('b')], suggestions: [suggestion] })
    expect(attentionItems(m, []).map((i) => i.target)).toEqual([{ kind: 'doc', path: 'docs/run.md' }, { kind: 'suggestions' }])
  })

  it('lists suggestions, blocked tickets and pull requests the attention list leaves out', () => {
    const pr: PullRequestInfo = { number: 7, url: 'https://x/7', state: 'open' }
    const blocked = ticket('2', 'blocked', { blocked: 'waiting on keys' })
    const suggestion: MapDetail['suggestions'][number] = { id: 'sg_1', kind: 'add-doc', path: 'x.md', why: '', milestones: [], from: { ask: true }, at: '' }
    const m = map({ milestones: [milestone([ticket('1', 'in-progress'), blocked])], suggestions: [suggestion], launches: [launch('l_1', { milestone: 'ms_1' }, { pr }), launch('l_2', { ticket: '1' }, { pr })] })
    const items = attentionItems(m, [])
    expect(overviewReview(m, [], items).map((i) => i.kind)).toEqual(['suggestion', 'blocked', 'pr'])
    expect(overviewReview(m, [], items).find((i) => i.kind === 'pr')).toMatchObject({ launch: { id: 'l_1' } })
  })
})

describe('recommended next', () => {
  it('recommends the first item with why and who acts', () => {
    const m = map({ milestones: [milestone([ticket('a'), ticket('b')])], decisions: [decision('dc_1', ['a', 'b'])] })
    expect(recommendedNext(m, [])).toMatchObject({ title: 'Production domain', why: 'Unblocks Ta and Tb.', actor: 'you', button: 'Review decision', reason: 'Blocks 2 tickets', others: 0 })
  })

  it('falls back to the plan: ready tickets are for an agent', () => {
    const m = map({ milestones: [milestone([ticket('a'), ticket('b')])] })
    expect(recommendedNext(m, [])).toMatchObject({ actor: 'agent', button: 'Start 2', reason: null, next: { kind: 'up-next' } })
    expect(recommendedNext(map(), [])).toMatchObject({ actor: 'you', button: 'Write a PRD' })
  })
})

describe('since your last visit', () => {
  it('is null before a visit or Mark all as seen, then lists the log after the later of them, newest first', () => {
    const ev = (kind: MapEvent['kind'], at: string, extra: Partial<MapEvent> = {}): MapEvent => ({ id: at, at, kind, title: 'Ta', detail: '', ticket: null, milestone: null, launch: null, decision: null, suggestion: null, doc: null, thread: null, ...extra })
    const base = { decisions: [decision('dc_1', [], { status: 'decided', outcome: 'x' })], activity: [ev('decision-decided', '2026-11-22T11:00:00Z', { decision: 'dc_1' }), ev('agent-finished', '2026-11-22T10:00:00Z')] }
    expect(sinceLastVisit(map(base))).toBeNull()
    expect(sinceLastVisit(map({ ...base, lastVisitedAt: '2026-11-21T00:00:00Z' }))?.map((e) => [e.text, e.tone])).toEqual([
      ['Decision 006 decided', 'done'],
      ['Ta finished', 'done']
    ])
    expect(sinceLastVisit(map({ ...base, lastVisitedAt: '2026-11-21T00:00:00Z', seenAt: '2026-11-22T10:30:00Z' }))?.map((e) => e.text)).toEqual(['Decision 006 decided'])
    expect(sinceLastVisit(map({ ...base, lastVisitedAt: '2026-11-23T00:00:00Z' }))).toEqual([])
  })
})

describe('doc summaries', () => {
  it('lists the current milestone’s docs first, with roles, linked tickets and waiting changes', () => {
    const m = map({
      milestones: [milestone([ticket('a', 'todo', { docs: [{ path: 'plan.md', heading: null }] })])],
      docs: [
        { path: 'old.md', milestones: [], section: null, roles: [], exists: true, title: 'Old', updatedAt: null },
        { path: 'plan.md', milestones: ['ms_1'], section: null, roles: ['product', 'technical'], exists: true, title: 'Plan', updatedAt: null }
      ],
      proposals: [{ thread: 't', doc: 'plan.md', title: 'x', from: { ask: true } }]
    })
    expect(docSummaries(m).map((d) => [d.doc.title, d.roles, d.tickets, d.proposals])).toEqual([
      ['Plan', 'PRODUCT + TECHNICAL', 1, 1],
      ['Old', '', 0, 0]
    ])
  })
})

describe('decision summaries', () => {
  it('lists open decisions first, then the most recently decided, three at most', () => {
    const m = map({
      decisions: [
        decision('dc_old', [], { status: 'decided', decidedAt: '2026-11-20T00:00:00Z' }),
        decision('dc_new', [], { status: 'decided', decidedAt: '2026-11-22T00:00:00Z' }),
        decision('dc_open', []),
        decision('dc_gone', [], { status: 'superseded', decidedAt: '2026-11-21T00:00:00Z' })
      ]
    })
    expect(decisionSummaries(m).map((d) => d.id)).toEqual(['dc_open', 'dc_new', 'dc_gone'])
  })

  it('caps the doc list at three', () => {
    const doc = (path: string): MapDetail['docs'][number] => ({ path, milestones: [], section: null, roles: [], exists: true, title: path, updatedAt: null })
    expect(docSummaries(map({ docs: [doc('a.md'), doc('b.md'), doc('c.md'), doc('d.md')] }))).toHaveLength(3)
  })
})
