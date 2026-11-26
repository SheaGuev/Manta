import { describe, expect, it } from 'vitest'
import type { LaunchWrapUp, MapDecision, MapLaunch, MapMilestone, MapSuggestion, MapTicket, PullRequestInfo } from '../../../shared/ipc'
import { backfillEvents, launchEvents, parseMapEvent, trackerEvents } from '../mapActivity'
import { EMPTY_TRACKER, type Tracker } from '../mapModel'

const AT = '2026-11-24T10:00:00.000Z'

function ticket(id: string, status: MapTicket['status'] = 'todo', blocked: string | null = null): MapTicket {
  return { id, number: 1, title: `Ticket ${id}`, description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status, blocked }
}

function tracker(tickets: MapTicket[], decisions: MapDecision[] = []): Tracker {
  const milestone: MapMilestone = { id: 'ms_1', title: 'Release', description: '', doneWhen: [], tickets, landed: false, manual: null }
  return { ...EMPTY_TRACKER, milestones: [milestone], decisions }
}

function decision(status: MapDecision['status'], extra: Partial<MapDecision> = {}): MapDecision {
  return { id: 'dc_1', number: 6, title: 'Production domain', question: 'Which domain?', status, outcome: '', options: [], chosen: null, input: null, blocks: [], docs: [], from: null, createdAt: '2026-11-20T00:00:00.000Z', decidedAt: null, ...extra }
}

function wrapUp(finished: boolean, at = AT): LaunchWrapUp {
  return { summary: 'Staging passes. Next the phone.', wentToPlan: false, finished, criteria: [], checks: [], unverified: [], decisions: [], risks: [], at, sweep: false }
}

function launch(extra: Partial<MapLaunch> = {}): MapLaunch {
  return { id: 'l_1', scope: { ticket: 'a' }, project: '/c', worktree: '/w', branch: 'manta/a', base: null, sessions: [], pr: null, landed: false, createdAt: '', wrappedUpAt: null, sweptAt: null, readyAt: null, wrapUp: null, health: null, landingSweptAt: null, batch: null, ...extra }
}

describe('tracker events', () => {
  it('logs tickets done, blocked and in review, and the milestone once all are done', () => {
    const before = tracker([ticket('a', 'in-progress'), ticket('b', 'done')])
    const after = tracker([ticket('a', 'done'), ticket('b', 'done')])
    expect(trackerEvents(before, after, [], AT).map((e) => [e.kind, e.title, e.milestone])).toEqual([
      ['ticket-done', 'Ticket a', 'ms_1'],
      ['milestone-done', 'Release', 'ms_1']
    ])
    const blocked = trackerEvents(before, tracker([ticket('a', 'blocked', 'Waiting on DNS'), ticket('b', 'done')]), [], AT)
    expect(blocked).toMatchObject([{ kind: 'ticket-blocked', detail: 'Waiting on DNS', ticket: 'a', at: AT }])
    expect(trackerEvents(before, before, [], AT)).toEqual([])
  })

  it('logs decisions raised, decided, superseded and reopened', () => {
    const none = tracker([])
    expect(trackerEvents(none, tracker([], [decision('open')]), [], AT)).toMatchObject([{ kind: 'decision-raised', title: 'Production domain', detail: 'Which domain?', decision: 'dc_1' }])
    expect(trackerEvents(tracker([], [decision('open')]), tracker([], [decision('decided', { outcome: 'omni.app\nbecause' })]), [], AT)).toMatchObject([{ kind: 'decision-decided', detail: 'omni.app' }])
    expect(trackerEvents(tracker([], [decision('decided')]), tracker([], [decision('superseded')]), [], AT)).toMatchObject([{ kind: 'decision-superseded' }])
    expect(trackerEvents(tracker([], [decision('decided')]), tracker([], [decision('open')]), [], AT)).toMatchObject([{ kind: 'decision-reopened' }])
  })
})

describe('launch events', () => {
  const t = tracker([ticket('a')])

  it('logs sessions started, wrap-ups, pull requests opened and merged, once each', () => {
    const started = launch({ sessions: [{ terminal: 'term_1', session: 's', ticket: null, startedAt: '2026-11-24T09:00:00.000Z', progress: null }] })
    expect(launchEvents(t, null, started, AT)).toMatchObject([{ kind: 'agent-started', title: 'Ticket a', ticket: 'a', milestone: 'ms_1', launch: 'l_1', at: '2026-11-24T09:00:00.000Z' }])
    const finished = { ...started, wrapUp: wrapUp(true) }
    expect(launchEvents(t, started, finished, AT)).toMatchObject([{ kind: 'agent-finished', detail: 'Staging passes. Next the phone.' }])
    expect(launchEvents(t, finished, { ...finished, wrapUp: wrapUp(false, '2026-11-24T11:00:00.000Z') }, AT)).toMatchObject([{ kind: 'agent-wrapped-up' }])
    const info: PullRequestInfo = { number: 7, state: 'open', url: 'https://x/7' }
    const pr = { ...finished, pr: info }
    expect(launchEvents(t, finished, pr, AT)).toMatchObject([{ kind: 'pr-opened', detail: 'Pull request #7' }])
    expect(launchEvents(t, pr, { ...pr, landed: true }, AT)).toMatchObject([{ kind: 'pr-merged' }])
    expect(launchEvents(t, pr, pr, AT)).toEqual([])
  })
})

describe('backfill and parsing', () => {
  it('dates what the map already dates, oldest first, and invents nothing else', () => {
    const suggestion: MapSuggestion = { id: 'sg_1', kind: 'write-doc', title: 'Runbook', why: 'No one knows the steps', milestones: [], from: { ask: true }, at: '2026-11-22T00:00:00.000Z' }
    const launches = [launch({ sessions: [{ terminal: 't', session: 's', ticket: null, startedAt: '2026-11-21T00:00:00.000Z', progress: null }], wrapUp: wrapUp(true, '2026-11-23T00:00:00.000Z'), landed: true })]
    const events = backfillEvents(tracker([ticket('a', 'done')], [decision('decided', { decidedAt: '2026-11-21T12:00:00.000Z' })]), launches, [suggestion])
    expect(events.map((e) => [e.kind, e.at])).toEqual([
      ['decision-raised', '2026-11-20T00:00:00.000Z'],
      ['agent-started', '2026-11-21T00:00:00.000Z'],
      ['decision-decided', '2026-11-21T12:00:00.000Z'],
      ['suggestion', '2026-11-22T00:00:00.000Z'],
      ['agent-finished', '2026-11-23T00:00:00.000Z']
    ])
    expect(events.find((e) => e.kind === 'suggestion')).toMatchObject({ title: 'Write a doc: Runbook', detail: 'No one knows the steps', suggestion: 'sg_1' })
  })

  it('reads stored events leniently', () => {
    expect(parseMapEvent({ id: 'ev_1', at: AT, kind: 'ticket-done', title: 'T' })).toMatchObject({ detail: '', ticket: null, thread: null })
    expect(parseMapEvent({ id: 'ev_1', at: AT, kind: 'ticket-accepted', title: 'T' })).toBeNull()
    expect(parseMapEvent('junk')).toBeNull()
  })
})
