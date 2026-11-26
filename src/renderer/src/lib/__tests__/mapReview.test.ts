import { describe, expect, it } from 'vitest'
import type { LaunchWrapUp, MapDetail, MapLaunch, MapTicket } from '../../../../shared/ipc'
import { hasWork, ticketReview } from '../mapReview'

function ticket(status: MapTicket['status'] = 'in-review'): MapTicket {
  return { id: 'tk_1', number: 82, title: 'E2E', description: '', acceptance: ['Auth works', 'Launch works'], constraints: [], after: [], docs: [], project: null, status, blocked: null }
}

function wrapUp(at: string, extra: Partial<LaunchWrapUp> = {}): LaunchWrapUp {
  return { summary: 'Did it', wentToPlan: true, finished: true, criteria: [], checks: [], unverified: [], decisions: [], risks: [], at, sweep: false, ...extra }
}

function launch(id: string, extra: Partial<MapLaunch> = {}): MapLaunch {
  return {
    id,
    scope: { ticket: 'tk_1' },
    project: '/c',
    worktree: '/w',
    branch: 'manta/e2e',
    base: null,
    sessions: [],
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

type Map = Pick<MapDetail, 'milestones' | 'launches' | 'proposals'>

function map(t: MapTicket, launches: MapLaunch[], extra: Partial<Map> = {}): Map {
  return { milestones: [{ id: 'ms_1', title: 'M', description: '', doneWhen: [], tickets: [t], landed: false, manual: null, status: 'in-progress' }], launches, proposals: [], ...extra }
}

describe('ticketReview', () => {
  it('gathers the latest judgement of each criterion, the latest wrap-up and the doc changes its launches proposed', () => {
    const first = launch('l_1', { readyAt: 'x', wrapUp: wrapUp('2026-11-01', { criteria: [{ ticket: 'tk_1', index: 0, met: false, evidence: 'failed', source: 'Run' }] }) })
    const second = launch('l_2', {
      pr: { number: 7, state: 'open', url: 'u' },
      wrapUp: wrapUp('2026-11-02', { criteria: [{ ticket: 'tk_1', index: 0, met: true, evidence: 'passed', source: 'Run output' }], checks: [{ command: 'npm test', passed: true }], unverified: ['A physical phone'] })
    })
    const t = ticket()
    const review = ticketReview(map(t, [first, second], { proposals: [{ thread: 't_1', doc: 'runbook.md', title: 'Staging', from: { launch: 'l_2' } }, { thread: 't_2', doc: 'x.md', title: 'Other', from: { ask: true } }] }), t)
    expect(review.wrapUps.map((w) => w.launch.id)).toEqual(['l_2', 'l_1'])
    expect(review.criteria).toEqual([
      { index: 0, text: 'Auth works', result: { ticket: 'tk_1', index: 0, met: true, evidence: 'passed', source: 'Run output' } },
      { index: 1, text: 'Launch works', result: null }
    ])
    expect(review.checks).toEqual([{ command: 'npm test', passed: true }])
    expect(review.unverified).toEqual(['A physical phone'])
    expect(review.proposals.map((p) => p.thread)).toEqual(['t_1'])
    expect(review).toMatchObject({ stage: 'pr-open', launch: { id: 'l_2' }, shared: false })
  })

  it('moves from working to finished, a pull request, merged and done', () => {
    const t = ticket('in-progress')
    expect(ticketReview(map(t, [launch('l_1')]), t).stage).toBe('working')
    expect(ticketReview(map(t, [launch('l_1', { readyAt: 'x' })]), t).stage).toBe('finished')
    expect(ticketReview(map(t, [launch('l_1', { landed: true, pr: { number: 7, state: 'merged', url: 'u' } })]), t).stage).toBe('merged')
    expect(ticketReview(map(ticket('done'), [launch('l_1', { landed: true })]), ticket('done')).stage).toBe('done')
    const shared = launch('l_m', { scope: { milestone: 'ms_1' }, sessions: [{ terminal: 'x', session: 's', ticket: 'tk_1', startedAt: '', progress: null }], wrapUp: wrapUp('2026-11-03') })
    expect(ticketReview(map(t, [shared]), t)).toMatchObject({ stage: 'merged', shared: true })
    expect(hasWork(map(t, [launch('l_1')]), t)).toBe(false)
    expect(hasWork(map(t, [shared]), t)).toBe(true)
  })
})
