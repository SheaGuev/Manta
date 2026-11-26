import { describe, expect, it } from 'vitest'
import type { MapLaunch } from '../../../shared/ipc'
import { breakDownPrompt, briefReadiness, coordinatorBrief, landingPrompt, launchBrief, mapOutline, sweepPrompt, ticketBriefDocs, workingUnderAMap } from '../mapBrief'
import { applyTrackerEdit, EMPTY_TRACKER, milestoneInfos, type MapFile, type Tracker } from '../mapModel'

const MAP: MapFile = {
  version: 2,
  id: 'm_abc',
  title: 'Maps v2',
  description: 'A home for each feature.\nSecond line.\nThird line, left out.',
  createdAt: '2026-11-19T00:00:00.000Z',
  projects: ['app'],
  launchMode: 'ticket',
  sweep: true,
  confirmProposals: 'ask',
  pinned: null,
  checks: [],
  docs: [
    { path: 'docs/tracker.md', milestones: ['ms_1'], section: null, roles: [] },
    { path: 'docs/later.md', milestones: ['ms_2'], section: null, roles: [] }
  ],
  sections: [],
  key: null,
  stage: null,
}

const TRACKER: Tracker = {
  ...EMPTY_TRACKER,
  nextTicket: 3,
  milestones: [
    {
      id: 'ms_1',
      title: 'Tracker',
      description: 'Milestones and tickets.',
      doneWhen: [{ text: 'Plans survive a restart', done: false }, { text: 'Schema reviewed', done: true }],
      landed: false,
      manual: null,
      tickets: [
        { id: 'tk_1', number: 1, title: 'Data model', description: 'Types and guards.', acceptance: ['Guards reject bad input'], constraints: ['No new dependencies'], after: [], docs: [{ path: 'docs/rfc.md', heading: 'Data' }], project: null, status: 'todo', blocked: null, cancelled: null },
        { id: 'tk_2', number: 2, title: 'Store', description: 'Atomic writes.', acceptance: [], constraints: [], after: ['tk_1'], docs: [], project: null, status: 'done', blocked: null, cancelled: null }
      ]
    },
    { id: 'ms_2', title: 'Screens', description: '', doneWhen: [], landed: false, manual: null, tickets: [] }
  ]
}

function launch(scope: MapLaunch['scope']): MapLaunch {
  return { id: 'l_1', scope, project: '/code/app', worktree: '/wt/x', branch: 'manta/x', base: null, sessions: [], pr: null, landed: false, createdAt: '', wrappedUpAt: null, sweptAt: null, readyAt: null, wrapUp: null, health: null, landingSweptAt: null, batch: null }
}

const context = (scope: MapLaunch['scope'], ticket: string | null = null) => ({ map: MAP, tracker: TRACKER, launch: launch(scope), ticket, docsRoot: '/docs', project: 'app' })

describe('launchBrief', () => {
  it('carries constraints, the milestone’s definition of done and open decisions', () => {
    const decided = applyTrackerEdit(TRACKER, { kind: 'add-decision', title: 'Storage format', question: 'JSON or SQLite?', blocks: ['tk_1'] })
    if (!decided.ok) throw new Error(decided.message)
    const brief = launchBrief({ ...context({ ticket: 'tk_1' }), tracker: decided.value })
    expect(brief).toContain('Constraints and non-goals:\n- No new dependencies')
    expect(brief).toContain('The milestone is done when (ticked items the user has confirmed):\n- [ ] Plans survive a restart\n- [x] Schema reviewed')
    expect(brief).toContain('- Decision 001: Storage format: JSON or SQLite?')
    expect(mapOutline(MAP, milestoneInfos(decided.value, []), 'ms_1', decided.value.decisions)).toContain('- 001 Storage format (open); blocks Data model')
  })

  it('gives a ticket in full with its docs as paths, the map and milestone in a line or two, and how to work', () => {
    const brief = launchBrief(context({ ticket: 'tk_1' }))
    expect(brief).toContain('(Manta map m_abc, launch l_1)')
    expect(brief).toContain('The map: A home for each feature. Second line.')
    expect(brief).not.toContain('Third line')
    expect(brief).toContain('It belongs to the milestone "Tracker": Milestones and tickets.')
    expect(brief).toContain('### Ticket: Data model (`tk_1`, to do)\n\nTypes and guards.')
    expect(brief).toContain('- `docs/rfc.md` § Data')
    expect(brief).toContain('  - `docs/tracker.md`')
    expect(brief).not.toContain('docs/later.md')
    expect(brief).toContain('`Manta-Launch: l_1`')
    expect(brief).toContain(workingUnderAMap('ask')[0])
  })

  it('tells sessions to ask the user before proposing, unless the map queues proposals; doc changes always wait and stay minimal', () => {
    const asking = launchBrief(context({ ticket: 'tk_1' }))
    expect(asking).toContain('AskUserQuestion')
    expect(asking).toContain('`confirmed_with_user: true`')
    expect(asking).toContain('always wait for the user in Manta')
    expect(asking).toContain('Keep doc changes minimal')
    const queueing = launchBrief({ ...context({ ticket: 'tk_1' }), map: { ...MAP, confirmProposals: 'queue' } })
    expect(queueing).not.toContain('AskUserQuestion')
    expect(queueing).toContain('Proposals wait in Needs review')
    expect(queueing).toContain('Keep doc changes minimal')
  })

  it('tells sessions to raise questions only the user can settle as decisions, asking first when the user is watching', () => {
    const asking = launchBrief(context({ ticket: 'tk_1' }))
    expect(asking).toContain('ask them (AskUserQuestion), with an option to decide it later')
    expect(asking).toContain('`propose_decision`, its `outcome` and `confirmed_with_user: true`')
    const queueing = launchBrief({ ...context({ ticket: 'tk_1' }), map: { ...MAP, confirmProposals: 'queue' } })
    expect(queueing).toContain('`propose_decision` with the tickets it blocks')
    expect(queueing).not.toContain('`outcome`')
  })

  it('gives a milestone with its tickets and statuses, and a ticket inside a shared worktree its own scope', () => {
    const whole = launchBrief(context({ milestone: 'ms_1' }))
    expect(whole).toContain('## Your scope: the milestone "Tracker"')
    expect(whole).toContain('- Store (`tk_2`, done)')
    const focused = launchBrief(context({ milestone: 'ms_1' }, 'tk_1'))
    expect(focused).toContain('## Your scope: one ticket')
    expect(focused).toContain('shared with other tickets')
  })

  it('gives a group its tickets in full', () => {
    const group = launchBrief(context({ tickets: ['tk_1', 'tk_2'] }))
    expect(group).toContain('## Your scope: 2 tickets, together')
    expect(group).toContain('### Ticket: Store')
  })
})

describe('the brief page', () => {
  it('adds the note for this start after the scope', () => {
    const brief = launchBrief({ ...context({ ticket: 'tk_1' }), note: '  Use the v2 schema.  ' })
    expect(brief).toContain('## A note from the user for this start\n\nUse the v2 schema.\n')
    expect(launchBrief({ ...context({ ticket: 'tk_1' }), note: ' ' })).not.toContain('A note from the user')
  })

  it('points a ticket at its own sections, then its milestone’s docs', () => {
    expect(ticketBriefDocs(MAP, TRACKER, 'tk_1')).toEqual([
      { path: 'docs/rfc.md', heading: 'Data' },
      { path: 'docs/tracker.md', heading: null }
    ])
    expect(ticketBriefDocs(MAP, TRACKER, 'gone')).toEqual([])
  })

  it('is ready with an objective, criteria and context and nothing open it waits on', () => {
    const [first, second] = TRACKER.milestones[0]?.tickets ?? []
    if (!first || !second) throw new Error('tickets missing')
    const docs = ticketBriefDocs(MAP, TRACKER, first.id)
    expect(briefReadiness(MAP, TRACKER, first, docs)).toEqual({ ready: true, included: ['Objective', 'criteria', 'source context'], missing: [], blocking: [] })
    const decided = applyTrackerEdit(TRACKER, { kind: 'add-decision', title: 'Format', blocks: ['tk_2'] })
    if (!decided.ok) throw new Error(decided.message)
    expect(briefReadiness({ ...MAP, key: 'MV' }, decided.value, { ...second, status: 'todo' }, [])).toEqual({
      ready: false,
      included: ['Objective'],
      missing: ['No acceptance criteria', 'No source context'],
      blocking: ['Waits for MV-1', 'Decision 001 is open']
    })
  })
})

describe('coordinatorBrief', () => {
  it('lists the batch tickets in a line each with what they wait for, the board as it is, and coordinating only', () => {
    const brief = coordinatorBrief({ map: MAP, tracker: TRACKER, launches: [launch({ ticket: 'tk_1' })], batch: 'b_123456', board: '- Data model [launch l_1] (working)' })
    expect(brief).toContain('(Manta map m_abc, batch b_123456)')
    expect(brief).toContain('- **Data model** (`tk_1`, launch `l_1`, branch `manta/x`): Types and guards.')
    expect(brief).toContain('## The board now\n\n- Data model [launch l_1] (working)')
    expect(brief).toContain('**Coordinate only.**')
    expect(brief).toContain('Manta: changed since you last looked')
  })

  it('tells launched sessions to report progress for the board', () => {
    expect(launchBrief(context({ ticket: 'tk_1' }))).toContain('`report_progress`')
  })
})

describe('mapOutline and sweepPrompt', () => {
  it('outlines milestones with statuses and the current one, then docs with their milestones', () => {
    const outline = mapOutline(MAP, milestoneInfos(TRACKER, []), 'ms_1')
    expect(outline).toContain('- Tracker (`ms_1`, in-progress, 1/2 done) ← current')
    expect(outline).toContain('  - Data model (`tk_1`, to do)')
    expect(outline).toContain('- `docs/tracker.md` (Tracker)')
  })

  it('quotes the journal and the diff summary, or says there is none', () => {
    const prompt = sweepPrompt({ scopeTitle: 'Data model', launch: launch({ ticket: 'tk_1' }), journal: '', diffSummary: 'abc Add types', docs: [] })
    expect(prompt).toContain('"Data model" (launch l_1, branch manta/x)')
    expect(prompt).toContain('Empty: the session wrote no journal.')
    expect(prompt).toContain('abc Add types')
  })
})

describe('what finishing and sharing look like in a brief', () => {
  it("lists a ticket's acceptance criteria with their indexes, and what it waits for", () => {
    expect(launchBrief(context({ ticket: 'tk_1' }))).toContain('Done when (each criterion with its index, for `wrap_up`):\n- [0] Guards reject bad input')
    const store = launchBrief(context({ ticket: 'tk_2' }))
    expect(store).toContain('It has no acceptance criteria')
    expect(store).toContain('It waits for:\n- Data model (`tk_1`, to do)')
  })

  it("ends with Finishing: the project's checks, the trailer, a draft pull request, and finished: true", () => {
    const brief = launchBrief({ ...context({ ticket: 'tk_1' }), checks: ['npm run typecheck', 'npm test'] })
    expect(brief).toContain('## Finishing')
    expect(brief).toContain('   - `npm run typecheck`\n   - `npm test`')
    expect(brief).toContain('push `manta/x` and open a draft pull request with `gh pr create --draft`')
    expect(brief).toContain('Wrap up with `finished: true`')
    expect(launchBrief(context({ ticket: 'tk_1' }))).toContain("Run the project's own tests and type checks")
  })

  it('warns of other sessions in the worktree, and carries earlier wrap-ups of the milestone, at most five', () => {
    const earlier = Array.from({ length: 7 }, (_, i) => ({ title: `Earlier ${i}`, summary: `Did ${i}.` }))
    const brief = launchBrief({ ...context({ milestone: 'ms_1' }, 'tk_1'), others: ['Store'], earlier })
    expect(brief).toContain('Other sessions are working in this worktree right now: “Store”')
    expect(brief).toContain('never `git add -A`')
    expect(brief).toContain('- Earlier 6: Did 6.')
    expect(brief).not.toContain('Earlier 1:')
  })

  it('asks Break down for criteria, dependencies and, with several projects, each ticket’s project', () => {
    expect(breakDownPrompt([], ['app'])).toContain('acceptance criteria')
    expect(breakDownPrompt([], ['app'])).not.toContain('give each ticket its `project`')
    expect(breakDownPrompt([], ['app', 'api'])).toContain('(app, api): give each ticket its `project`')
  })

  it('outlines code projects and what tickets wait for', () => {
    const outline = mapOutline(MAP, milestoneInfos(TRACKER, []), 'ms_1')
    expect(outline).toContain('Code projects: app')
    expect(outline).toContain('  - Store (`tk_2`, done); waits for Data model')
  })

  it('gives the sweep the criteria and the pull request, and the landing pass what landed', () => {
    const tickets = TRACKER.milestones[0]?.tickets ?? []
    const sweep = sweepPrompt({ scopeTitle: 'Data model', launch: launch({ ticket: 'tk_1' }), journal: '', diffSummary: '', docs: [], pullRequest: 'Data model\n\nAdds guards.', criteria: tickets.map((ticket) => ({ ticket })) })
    expect(sweep).toContain('- `tk_1` [0] Guards reject bad input')
    expect(sweep).toContain('Adds guards.')
    const landing = landingPrompt({ scopeTitle: 'Data model', launch: launch({ ticket: 'tk_1' }), journal: '- decided', diffSummary: 'abc Guards', docs: [{ path: 'docs/rfc.md', heading: null }], wrappedUp: false })
    expect(landing).toContain('has landed on the default branch')
    expect(landing).toContain('never wrapped up: set the statuses')
    expect(landing).toContain('- `docs/rfc.md`')
  })
})

