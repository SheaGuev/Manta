import { describe, expect, it } from 'vitest'
import type { MapDetail, MapEvent, MapMilestoneInfo, MapTicket } from '../../../../shared/ipc'
import { feedDays, inFilter, itemTitle, needsAction, sinceSummary } from '../mapActivity'

const NOW = Date.parse('2026-11-24T15:00:00')

function ev(id: string, kind: MapEvent['kind'], at: string, extra: Partial<MapEvent> = {}): MapEvent {
  return { id, at: new Date(at).toISOString(), kind, title: `T${id}`, detail: '', ticket: null, milestone: null, launch: null, decision: null, suggestion: null, doc: null, thread: null, ...extra }
}

function ticket(id: string, status: MapTicket['status']): MapTicket {
  return { id, number: 1, title: id, description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status, blocked: null }
}

const milestones: MapMilestoneInfo[] = [{ id: 'ms_1', title: 'Release', description: '', doneWhen: [], tickets: [ticket('a', 'done'), ticket('b', 'blocked')], landed: false, manual: null, status: 'in-progress' }]

describe('the activity feed', () => {
  it('groups by day, and tickets done in one milestone in a row as one entry', () => {
    const days = feedDays(
      [
        ev('1', 'agent-finished', '2026-11-24T14:00:00'),
        ev('2', 'ticket-done', '2026-11-23T18:00:00', { milestone: 'ms_1' }),
        ev('3', 'ticket-done', '2026-11-23T17:00:00', { milestone: 'ms_1' }),
        ev('4', 'ticket-done', '2026-11-23T16:00:00', { milestone: 'ms_1' }),
        ev('5', 'decision-raised', '2026-11-20T09:00:00')
      ],
      NOW
    )
    expect(days.map((d) => [d.label, d.today, d.items.length])).toEqual([
      ['Today', true, 1],
      ['Yesterday', false, 1],
      [expect.any(String), false, 1]
    ])
    expect(itemTitle(days[0]?.items[0] ?? { key: '', events: [] }, { milestones, docs: [] })).toBe('T1 is ready for review')
    expect(itemTitle(days[1]?.items[0] ?? { key: '', events: [] }, { milestones, docs: [] })).toBe('3 tickets done in M1')
  })

  it('filters by kind, and knows what still waits on the user', () => {
    expect(inFilter(ev('1', 'pr-opened', '2026-11-24T10:00:00'), 'agents')).toBe(true)
    expect(inFilter(ev('1', 'pr-opened', '2026-11-24T10:00:00'), 'docs')).toBe(false)
    const full: MapDetail = { ...fullDetail(), milestones, proposals: [{ thread: 't_1', doc: 'a.md', title: 'x', from: { ask: true } }] }
    expect(needsAction(ev('1', 'ticket-blocked', '2026-11-24T10:00:00', { ticket: 'b' }), full, [])).toBe(true)
    expect(needsAction(ev('1', 'ticket-blocked', '2026-11-24T10:00:00', { ticket: 'a' }), full, [])).toBe(false)
    expect(needsAction(ev('1', 'doc-change-proposed', '2026-11-24T10:00:00', { thread: 't_1' }), full, [])).toBe(true)
  })

  it('counts what is new since the later of the last visit and Mark all as seen', () => {
    const activity = [ev('1', 'agent-finished', '2026-11-24T14:00:00'), ev('2', 'doc-change-proposed', '2026-11-24T13:00:00'), ev('3', 'doc-change-proposed', '2026-11-24T09:00:00')]
    const summary = sinceSummary({ activity, lastVisitedAt: new Date('2026-11-24T08:00:00').toISOString(), seenAt: new Date('2026-11-24T10:00:00').toISOString(), decisions: [], milestones })
    expect([summary.fresh.length, summary.reviews, summary.docChanges, summary.decisions]).toEqual([2, 1, 1, 0])
  })
})

function fullDetail(): MapDetail {
  return {
    id: 'm_1',
    title: 'Omni',
    description: '',
    createdAt: '',
    current: null,
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
    milestones: [],
    decisions: [],
    launches: [],
    batches: [],
    suggestions: [],
    proposals: [],
    messages: []
  }
}
