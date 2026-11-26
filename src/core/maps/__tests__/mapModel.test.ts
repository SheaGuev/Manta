import { describe, expect, it } from 'vitest'
import type { MapLaunch, MapMilestone, MapTicket, PullRequestComment } from '../../../shared/ipc'
import {
  addProposedMilestones,
  applyDocsEdit,
  applyPlanChange,
  applySettings,
  applyTrackerEdit,
  pullRequestHealth,
  readyTickets,
  removeTicket,
  waitingOn,
  cleanDocPath,
  currentMilestone,
  EMPTY_TRACKER,
  mapKey,
  mapStage,
  openDecisions,
  milestoneInfos,
  milestoneStatus,
  milestoneTitle,
  parseLaunch,
  parseMapFile,
  parseSuggestion,
  parseTracker,
  scopeTitle,
  setTicketStatuses,
  type MapFile,
  type Tracker
} from '../mapModel'

function ticket(id: string, status: MapTicket['status'] = 'todo'): MapTicket {
  return { id, number: 0, title: `Ticket ${id}`, description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status, blocked: null }
}

function milestone(id: string, tickets: MapTicket[], extra: Partial<MapMilestone> = {}): MapMilestone {
  return { id, title: `Milestone ${id}`, description: '', doneWhen: [], tickets, landed: false, manual: null, ...extra }
}

function tr(milestones: MapMilestone[], extra: Partial<Tracker> = {}): Tracker {
  return { ...EMPTY_TRACKER, milestones, ...extra }
}

function launch(scope: MapLaunch['scope'], extra: Partial<MapLaunch> = {}): MapLaunch {
  return {
    id: 'l_1',
    scope,
    project: '/code/app',
    worktree: '/wt/x',
    branch: 'manta/x',
    base: null,
    sessions: [],
    pr: null,
    landed: false,
    createdAt: '2026-11-19T00:00:00.000Z',
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

const MAP: MapFile = {
  version: 2,
  id: 'm_1',
  title: 'Maps v2',
  description: '',
  createdAt: '2026-11-19T00:00:00.000Z',
  projects: ['app'],
  launchMode: 'ticket',
  sweep: true,
  confirmProposals: 'ask',
  pinned: null,
  checks: [],
  docs: [{ path: 'docs/a.md', milestones: ['ms_1'], section: null, roles: [] }],
  sections: [{ id: 'sec_1', title: 'UI' }],
  key: null,
  stage: null,
}

describe('milestone status', () => {
  it('is to do, then in progress once a ticket moves or work launches, then done when every ticket is', () => {
    expect(milestoneStatus(milestone('ms_1', [ticket('a'), ticket('b')]), [])).toBe('todo')
    expect(milestoneStatus(milestone('ms_1', [ticket('a', 'in-review'), ticket('b')]), [])).toBe('in-progress')
    expect(milestoneStatus(milestone('ms_1', [ticket('a'), ticket('b')]), [launch({ ticket: 'a' })])).toBe('in-progress')
    expect(milestoneStatus(milestone('ms_1', [ticket('a', 'done'), ticket('b', 'done')]), [])).toBe('done')
  })

  it('is not done while a ticket is only in review, and landing a branch finishes nothing', () => {
    const own = [launch({ milestone: 'ms_1' })]
    expect(milestoneStatus(milestone('ms_1', [ticket('a', 'done'), ticket('b', 'in-review')]), [])).toBe('in-progress')
    expect(milestoneStatus(milestone('ms_1', [ticket('a', 'done')]), own)).toBe('done')
    expect(milestoneStatus(milestone('ms_1', []), [])).toBe('todo')
    expect(milestoneStatus(milestone('ms_1', []), own)).toBe('in-progress')
    expect(milestoneStatus(milestone('ms_1', [], { landed: true }), own)).toBe('in-progress')
    expect(milestoneStatus(milestone('ms_1', [], { manual: 'done' }), own)).toBe('done')
  })

  it("ignores other milestones' launches, and a status set by hand wins", () => {
    expect(milestoneStatus(milestone('ms_1', [ticket('a')]), [launch({ milestone: 'ms_2' })])).toBe('todo')
    expect(milestoneStatus(milestone('ms_1', [ticket('a')], { manual: 'done' }), [])).toBe('done')
  })

  it('picks the pinned milestone as current, else the first not done', () => {
    const tracker = tr([milestone('ms_1', [ticket('a', 'done')]), milestone('ms_2', [ticket('b')]), milestone('ms_3', [ticket('c')])])
    const infos = milestoneInfos(tracker, [])
    expect(currentMilestone(infos, null)?.id).toBe('ms_2')
    expect(currentMilestone(infos, 'ms_3')?.id).toBe('ms_3')
    expect(currentMilestone(infos, 'ms_gone')?.id).toBe('ms_2')
    expect(currentMilestone(milestoneInfos(tr([milestone('ms_1', [ticket('a', 'done')])]), []), null)).toBeNull()
  })
})

describe('tracker edits', () => {
  const base = tr([milestone('ms_1', [ticket('a'), ticket('b')]), milestone('ms_2', [])], { nextTicket: 3 })

  it('adds milestones and tickets in place, and refuses empty titles', () => {
    const added = applyTrackerEdit(base, { kind: 'add-milestone', title: '  First  ', before: 'ms_1' })
    if (!added.ok) throw new Error(added.message)
    expect(added.value.milestones.map((m) => m.title)).toEqual(['First', 'Milestone ms_1', 'Milestone ms_2'])
    expect(added.value.milestones[0]?.id).toMatch(/^ms_[0-9a-f]{10}$/)

    const ticketAdded = applyTrackerEdit(base, { kind: 'add-ticket', milestone: 'ms_1', title: 'Between', before: 'b' })
    if (!ticketAdded.ok) throw new Error(ticketAdded.message)
    expect(ticketAdded.value.milestones[0]?.tickets.map((t) => t.title)).toEqual(['Ticket a', 'Between', 'Ticket b'])

    expect(applyTrackerEdit(base, { kind: 'add-milestone', title: '   ' })).toEqual({ ok: false, message: 'Give the milestone a title' })
    expect(applyTrackerEdit(base, { kind: 'add-ticket', milestone: 'ms_9', title: 'x' })).toEqual({ ok: false, message: 'That milestone is gone' })
  })

  it('keeps milestone numbers out of titles, since Manta numbers milestones by their place', () => {
    expect(milestoneTitle('M8 – Phase 1 release candidate')).toBe('Phase 1 release candidate')
    expect(milestoneTitle('  m12:  Logs  ')).toBe('Logs')
    expect(milestoneTitle('Milestone 3 - Hardening')).toBe('Hardening')
    expect(milestoneTitle('M5')).toBe('M5')
    expect(milestoneTitle('MVP – first cut')).toBe('MVP – first cut')
    expect(milestoneTitle('Phase 1 release candidate')).toBe('Phase 1 release candidate')

    const added = applyTrackerEdit(base, { kind: 'add-milestone', title: 'M4 – Hardening' })
    if (!added.ok) throw new Error(added.message)
    expect(added.value.milestones.at(-1)?.title).toBe('Hardening')
    const renamed = applyTrackerEdit(base, { kind: 'update-milestone', milestone: 'ms_1', title: 'M1: Device sync' })
    if (!renamed.ok) throw new Error(renamed.message)
    expect(renamed.value.milestones[0]?.title).toBe('Device sync')
    expect(addProposedMilestones(base, [{ title: 'M9 · Permissions', description: '', doneWhen: [], tickets: [] }]).milestones.at(-1)?.title).toBe('Permissions')
    expect(parseTracker({ milestones: [{ id: 'ms_1', title: 'M5 – Device sync', tickets: [] }] }).milestones[0]?.title).toBe('Device sync')
  })

  it('moves tickets across milestones and milestones within the plan', () => {
    const moved = applyTrackerEdit(base, { kind: 'move-ticket', ticket: 'a', milestone: 'ms_2', before: null })
    if (!moved.ok) throw new Error(moved.message)
    expect(moved.value.milestones.map((m) => m.tickets.map((t) => t.id))).toEqual([['b'], ['a']])

    const reordered = applyTrackerEdit(base, { kind: 'move-milestone', milestone: 'ms_2', before: 'ms_1' })
    if (!reordered.ok) throw new Error(reordered.message)
    expect(reordered.value.milestones.map((m) => m.id)).toEqual(['ms_2', 'ms_1'])
  })

  it('sets statuses with a reason for blocked, clearing the milestone’s hand-set status', () => {
    const manual = tr([milestone('ms_1', [ticket('a'), ticket('b', 'done')], { manual: 'done' })])
    const blocked = setTicketStatuses(manual, ['a'], 'blocked', { reason: 'Needs a key' })
    expect(blocked.milestones[0]?.tickets[0]).toMatchObject({ status: 'blocked', blocked: 'Needs a key' })
    expect(blocked.milestones[0]?.manual).toBeNull()
    expect(setTicketStatuses(manual, ['a', 'b'], 'in-progress', { keepDone: true }).milestones[0]?.tickets.map((t) => t.status)).toEqual(['in-progress', 'done'])
  })

  it('names a scope by its ticket, its first ticket and how many more, or its milestone', () => {
    expect(scopeTitle(base, { ticket: 'a' })).toBe('Ticket a')
    expect(scopeTitle(base, { tickets: ['a', 'b'] })).toBe('Ticket a and 1 more')
    expect(scopeTitle(base, { milestone: 'ms_2' })).toBe('Milestone ms_2')
  })
})

describe('docs and settings edits', () => {
  const ids = new Set(['ms_1'])

  it('adds docs with known milestones only, refuses paths outside the repo and duplicates', () => {
    const added = applyDocsEdit(MAP, { kind: 'add-doc', path: './docs/b.md', milestones: ['ms_1', 'ms_gone'], section: 'sec_1' }, ids)
    if (!added.ok) throw new Error(added.message)
    expect(added.value.docs.at(-1)).toEqual({ path: 'docs/b.md', milestones: ['ms_1'], section: 'sec_1', roles: [] })
    expect(applyDocsEdit(MAP, { kind: 'add-doc', path: '../x.md', milestones: [], section: null }, ids).ok).toBe(false)
    expect(applyDocsEdit(MAP, { kind: 'add-doc', path: 'docs/a.md', milestones: [], section: null }, ids)).toEqual({ ok: false, message: 'docs/a.md is already on the map' })
  })

  it('adds web links as docs with a link key, and edits a link only on a link', () => {
    const added = applyDocsEdit(MAP, { kind: 'add-link', url: ' https://figma.com/file/x ', title: ' Login  flow ', roles: ['design'], milestones: ['ms_1', 'ms_gone'] }, ids)
    if (!added.ok) throw new Error(added.message)
    const link = added.value.docs.at(-1)
    expect(link).toEqual({ path: expect.stringMatching(/^link:[0-9a-f]{8}$/), milestones: ['ms_1'], section: null, roles: ['design'], link: { url: 'https://figma.com/file/x', title: 'Login flow' } })
    expect(applyDocsEdit(added.value, { kind: 'add-link', url: 'https://figma.com/file/x', title: 'Again', roles: [], milestones: [] }, ids)).toEqual({ ok: false, message: 'https://figma.com/file/x is already on the map' })
    expect(applyDocsEdit(MAP, { kind: 'add-link', url: 'file:///etc/passwd', title: 'X', roles: [], milestones: [] }, ids)).toEqual({ ok: false, message: 'A link needs an http or https address' })
    expect(applyDocsEdit(MAP, { kind: 'add-link', url: 'https://x.dev', title: '  ', roles: [], milestones: [] }, ids)).toEqual({ ok: false, message: 'Give the link a title' })

    const key = link?.path ?? ''
    const renamed = applyDocsEdit(added.value, { kind: 'update-doc', path: key, link: { url: 'https://figma.com/file/y', title: 'Login' } }, ids)
    if (!renamed.ok) throw new Error(renamed.message)
    expect(renamed.value.docs.at(-1)).toMatchObject({ path: key, roles: ['design'], link: { url: 'https://figma.com/file/y', title: 'Login' } })
    expect(applyDocsEdit(MAP, { kind: 'update-doc', path: 'docs/a.md', link: { url: 'https://x.dev', title: 'X' } }, ids)).toEqual({ ok: false, message: 'docs/a.md is a file, not a link' })
  })

  it('a new section can take a doc in as it is made', () => {
    const added = applyDocsEdit(MAP, { kind: 'add-section', title: 'Release', doc: 'docs/a.md' }, ids)
    if (!added.ok) throw new Error(added.message)
    const section = added.value.sections.at(-1)
    expect(section?.title).toBe('Release')
    expect(added.value.docs.find((d) => d.path === 'docs/a.md')?.section).toBe(section?.id)
  })

  it('removing a section keeps its docs, unsectioned', () => {
    const sectioned = { ...MAP, docs: [{ path: 'docs/a.md', milestones: [], section: 'sec_1', roles: [] }] }
    const removed = applyDocsEdit(sectioned, { kind: 'remove-section', section: 'sec_1' }, ids)
    if (!removed.ok) throw new Error(removed.message)
    expect(removed.value).toMatchObject({ sections: [], docs: [{ path: 'docs/a.md', section: null }] })
  })

  it('pins only milestones that exist', () => {
    const pinned = applySettings(MAP, { pinned: 'ms_1', launchMode: 'milestone' }, ids)
    if (!pinned.ok) throw new Error(pinned.message)
    expect(pinned.value).toMatchObject({ pinned: 'ms_1', launchMode: 'milestone' })
    const unknown = applySettings(MAP, { pinned: 'ms_x' }, ids)
    expect(unknown.ok && unknown.value.pinned).toBeNull()
  })

  it('cleans doc paths', () => {
    expect(cleanDocPath('./a/b.md')).toBe('a/b.md')
    expect(cleanDocPath('/etc/passwd')).toBeNull()
    expect(cleanDocPath('a/../../b.md')).toBeNull()
    expect(cleanDocPath('.git/config')).toBeNull()
  })
})

describe('parsing stored files', () => {
  it('reads map.json leniently and refuses anything that is not v2', () => {
    expect(parseMapFile({ ...MAP, sweep: undefined, launchMode: 'weird', docs: [{ path: 'x.md' }, 'junk'] })).toMatchObject({ sweep: true, launchMode: 'ticket', docs: [{ path: 'x.md', milestones: [], section: null, roles: [] }] })
    expect(parseMapFile({ ...MAP, docs: [{ path: 'link:1', link: { url: 'https://x.dev', title: 'X' } }, { path: 'link:2', link: { url: 'javascript:alert(1)', title: 'Y' } }] })?.docs).toEqual([
      { path: 'link:1', milestones: [], section: null, roles: [], link: { url: 'https://x.dev/', title: 'X' } },
      { path: 'link:2', milestones: [], section: null, roles: [] }
    ])
    expect(parseMapFile({ ...MAP, version: 1 })).toBeNull()
  })

  it('drops malformed tickets and launches, keeps a blocked reason only while blocked, and reads accepted as done', () => {
    const tracker = parseTracker({ milestones: [{ id: 'ms_1', title: 'M', tickets: [{ id: 't', title: 'T', status: 'accepted', blocked: 'old' }, { title: 'no id' }] }, 'junk'] })
    expect(tracker.milestones).toHaveLength(1)
    expect(tracker.milestones[0]?.tickets).toEqual([{ id: 't', number: 1, title: 'T', description: '', acceptance: [], constraints: [], after: [], docs: [], project: null, status: 'done', blocked: null }])
    expect(parseLaunch({ id: 'l_1', scope: { tickets: [] }, project: 'p', worktree: 'w', branch: 'b' })).toBeNull()
    expect(parseLaunch({ id: 'l_1', scope: { ticket: 't' }, project: 'p', worktree: 'w', branch: 'b', sessions: [{ terminal: 'term_1' }] })?.sessions).toEqual([])
  })

  it('reads suggestions by kind', () => {
    expect(parseSuggestion({ id: 'sg_1', kind: 'add-doc', path: 'a.md', from: { launch: 'l_1' } })).toMatchObject({ kind: 'add-doc', milestones: [] })
    expect(parseSuggestion({ id: 'sg_1', kind: 'plan', milestones: [], from: { ask: true } })).toBeNull()
    expect(parseSuggestion({ id: 'sg_1', kind: 'add-doc', path: 'a.md', from: { nobody: true } })).toBeNull()
  })
})

describe('dependencies and plan changes', () => {
  const tracker = (): Tracker => tr([milestone('ms_1', [ticket('a', 'done'), ticket('b'), { ...ticket('c'), after: ['b'] }, { ...ticket('d'), after: ['a'] }])], { nextTicket: 5 })

  it('knows which tickets can start: to do, with everything they wait for done', () => {
    const t = tracker()
    const [m] = t.milestones
    if (!m) throw new Error('no milestone')
    expect(readyTickets(t, m).map((x) => x.id)).toEqual(['b', 'd'])
    expect(waitingOn(t, m.tickets[2] ?? ticket('x')).map((x) => x.id)).toEqual(['b'])
  })

  it('sets dependencies by hand, dropping unknown ids and itself, and refuses a cycle', () => {
    const set = applyTrackerEdit(tracker(), { kind: 'update-ticket', ticket: 'b', after: ['a', 'b', 'gone', 'a'] })
    if (!set.ok) throw new Error(set.message)
    expect(set.value.milestones[0]?.tickets[1]?.after).toEqual(['a'])
    expect(applyTrackerEdit(tracker(), { kind: 'update-ticket', ticket: 'b', after: ['c'] })).toEqual({ ok: false, message: 'That would make tickets wait on each other' })
    expect(removeTicket(tracker(), 'b').milestones[0]?.tickets.find((x) => x.id === 'c')?.after).toEqual([])
  })

  it('resolves dependencies by title inside a proposed plan, and keeps only the map’s projects', () => {
    const plan = addProposedMilestones(
      EMPTY_TRACKER,
      [
        {
          title: 'M',
          description: '',
          doneWhen: [' Shipped ', ''],
          tickets: [
            { title: 'Store', description: '', acceptance: [' Writes atomically ', ''], constraints: [' Keep the API '], after: [], project: 'app', docs: [] },
            { title: 'Screens', description: '', acceptance: [], constraints: [], after: ['store', 'Nothing'], project: 'elsewhere', docs: [] }
          ]
        }
      ],
      ['app']
    )
    const [store, screens] = plan.milestones[0]?.tickets ?? []
    expect(plan.milestones[0]?.doneWhen).toEqual([{ text: 'Shipped', done: false }])
    expect(store).toMatchObject({ number: 1, acceptance: ['Writes atomically'], constraints: ['Keep the API'], project: 'app', after: [] })
    expect(screens).toMatchObject({ number: 2, project: null, after: [store?.id] })
    expect(plan.nextTicket).toBe(3)
  })

  it('applies plan changes one at a time, with refusals for what is gone', () => {
    const projects = ['app']
    const updated = applyPlanChange(tracker(), { kind: 'update-ticket', ticket: 'b', title: 'B2', acceptance: ['works'], project: 'nope' }, projects)
    if (!updated.ok) throw new Error(updated.message)
    expect(updated.value.milestones[0]?.tickets[1]).toMatchObject({ title: 'B2', acceptance: ['works'], project: null })
    const added = applyPlanChange(tracker(), { kind: 'add-ticket', milestone: 'ms_1', before: 'b', ticket: { title: 'New', description: '', acceptance: [], constraints: [], after: ['a', 'zzz'], project: 'app', docs: [] } }, projects)
    if (!added.ok) throw new Error(added.message)
    expect(added.value.milestones[0]?.tickets.map((x) => x.title)).toEqual(['Ticket a', 'New', 'Ticket b', 'Ticket c', 'Ticket d'])
    expect(added.value.milestones[0]?.tickets[1]).toMatchObject({ number: 5, after: ['a'], project: 'app' })
    expect(added.value.nextTicket).toBe(6)
    const removed = applyPlanChange(tracker(), { kind: 'remove-ticket', ticket: 'b' }, projects)
    expect(removed.ok && removed.value.milestones[0]?.tickets.map((x) => x.id)).toEqual(['a', 'c', 'd'])
    expect(applyPlanChange(tracker(), { kind: 'remove-ticket', ticket: 'gone' }, projects)).toEqual({ ok: false, message: 'That ticket is gone' })
    expect(applyPlanChange(tracker(), { kind: 'add-ticket', milestone: 'gone', before: null, ticket: { title: 'X', description: '', acceptance: [], constraints: [], after: [], project: null, docs: [] } }, projects)).toEqual({ ok: false, message: 'Its milestone is gone' })
  })

  it('reads plan-change suggestions, dropping changes it can’t read', () => {
    const parsed = parseSuggestion({
      id: 'sg_1',
      kind: 'plan-change',
      why: 'w',
      from: { sweep: 'l_1' },
      changes: [{ kind: 'remove-ticket', ticket: 'a' }, { kind: 'update-ticket', ticket: 'b' }, { kind: 'explode' }, { kind: 'move-milestone', milestone: 'ms_1' }]
    })
    expect(parsed).toMatchObject({ kind: 'plan-change', changes: [{ kind: 'remove-ticket', ticket: 'a' }, { kind: 'move-milestone', milestone: 'ms_1', before: null }] })
    expect(parseSuggestion({ id: 'sg_1', kind: 'plan-change', why: '', from: { ask: true }, changes: [{ kind: 'explode' }] })).toBeNull()
  })
})

describe('numbers, keys and stage', () => {
  it('numbers unnumbered tickets and decisions in plan order, and never reuses a number', () => {
    const parsed = parseTracker({
      milestones: [{ id: 'ms_1', title: 'M', tickets: [{ id: 'a', title: 'A', number: 4 }, { id: 'b', title: 'B' }] }, { id: 'ms_2', title: 'N', tickets: [{ id: 'c', title: 'C' }] }],
      decisions: [{ id: 'dc_1', title: 'D' }],
      nextTicket: 9
    })
    expect(parsed.milestones.flatMap((m) => m.tickets.map((t) => t.number))).toEqual([4, 9, 10])
    expect(parsed).toMatchObject({ nextTicket: 11, nextDecision: 2, decisions: [{ number: 1, status: 'open' }] })
    expect(parseTracker(parsed)).toEqual(parsed)

    const removed = removeTicket(parsed, 'c')
    const added = applyTrackerEdit(removed, { kind: 'add-ticket', milestone: 'ms_1', title: 'New' })
    expect(added.ok && added.value.milestones[0]?.tickets.at(-1)?.number).toBe(11)
  })

  it('keys a map by its own key, else its title', () => {
    expect(mapKey({ key: null, title: 'Omni' })).toBe('OMN')
    expect(mapKey({ key: null, title: 'Mobile plugin host app' })).toBe('MPHA')
    expect(mapKey({ key: null, title: '42' })).toBe('TK')
    expect(mapKey({ key: 'APP', title: 'Omni' })).toBe('APP')
    expect(applySettings(MAP, { key: ' omn2 ' }, new Set()).ok && applySettings(MAP, { key: ' omn2 ' }, new Set())).toMatchObject({ value: { key: 'OMN2' } })
    expect(applySettings(MAP, { key: '9x' }, new Set())).toEqual({ ok: false, message: 'A key is a letter, then up to five letters or digits' })
    expect(applySettings({ ...MAP, key: 'APP' }, { key: '' }, new Set())).toMatchObject({ value: { key: null } })
  })

  it('works out the stage unless it is set by hand', () => {
    const open = tr([milestone('ms_1', [ticket('a'), ticket('b')])])
    expect(mapStage(MAP, tr([]), [])).toBe('planning')
    expect(mapStage(MAP, open, [])).toBe('planning')
    expect(mapStage(MAP, open, [launch({ ticket: 'a' })])).toBe('building')
    expect(mapStage(MAP, tr([milestone('ms_1', [ticket('a', 'done'), ticket('b', 'in-review')])]), [])).toBe('validating')
    expect(mapStage(MAP, tr([milestone('ms_1', [ticket('a', 'done')])]), [])).toBe('shipped')
    expect(mapStage({ stage: 'validating' }, open, [])).toBe('validating')
  })

  it('edits milestone definitions of done and ticket constraints', () => {
    const base = tr([milestone('ms_1', [ticket('a')])])
    const done = applyTrackerEdit(base, { kind: 'update-milestone', milestone: 'ms_1', doneWhen: [{ text: ' Build on a phone ', done: true }, { text: ' ', done: false }] })
    expect(done.ok && done.value.milestones[0]?.doneWhen).toEqual([{ text: 'Build on a phone', done: true }])
    const limited = applyTrackerEdit(base, { kind: 'update-ticket', ticket: 'a', constraints: ['No auth changes', ''] })
    expect(limited.ok && limited.value.milestones[0]?.tickets[0]?.constraints).toEqual(['No auth changes'])
  })

  it('reads a definition of done stored as plain strings, unticked', () => {
    const parsed = parseTracker({ milestones: [{ id: 'ms_1', title: 'M', doneWhen: [' Shipped ', '', { text: 'Runbook', done: true }, { done: true }], tickets: [] }] })
    expect(parsed.milestones[0]?.doneWhen).toEqual([
      { text: 'Shipped', done: false },
      { text: 'Runbook', done: true }
    ])
  })

  it('keeps ticks on unchanged items when an agent rewrites the definition of done', () => {
    const base = tr([milestone('ms_1', [], { doneWhen: [{ text: 'Runbook', done: true }, { text: 'Phone build', done: true }] })])
    const changed = applyPlanChange(base, { kind: 'update-milestone', milestone: 'ms_1', doneWhen: ['Runbook', 'Phone build on Android'] }, [])
    expect(changed.ok && changed.value.milestones[0]?.doneWhen).toEqual([
      { text: 'Runbook', done: true },
      { text: 'Phone build on Android', done: false }
    ])
  })
})

describe('decisions', () => {
  const base = (): Tracker => tr([milestone('ms_1', [ticket('a'), ticket('b')])])

  it('adds, decides and reopens decisions; a decision needs an outcome', () => {
    const added = applyTrackerEdit(base(), { kind: 'add-decision', title: ' Production domain ', question: 'Which domain?', blocks: ['a', 'gone', 'a'] })
    if (!added.ok) throw new Error(added.message)
    const decision = added.value.decisions[0]
    expect(decision).toMatchObject({ number: 1, title: 'Production domain', status: 'open', blocks: ['a'], decidedAt: null })
    expect(added.message).toBe('Added decision 001')
    if (!decision) throw new Error('no decision')

    expect(applyTrackerEdit(added.value, { kind: 'update-decision', decision: decision.id, status: 'decided' })).toEqual({ ok: false, message: 'Say what was decided' })
    const decided = applyTrackerEdit(added.value, { kind: 'update-decision', decision: decision.id, status: 'decided', outcome: 'omni.app' })
    if (!decided.ok) throw new Error(decided.message)
    expect(decided.value.decisions[0]).toMatchObject({ status: 'decided', outcome: 'omni.app' })
    expect(decided.value.decisions[0]?.decidedAt).toEqual(expect.any(String))

    const reopened = applyTrackerEdit(decided.value, { kind: 'update-decision', decision: decision.id, status: 'open' })
    expect(reopened.ok && reopened.value.decisions[0]).toMatchObject({ status: 'open', decidedAt: null })
    expect(applyTrackerEdit(added.value, { kind: 'remove-decision', decision: 'dc_gone' })).toEqual({ ok: false, message: 'That decision is gone' })
  })

  it('records a decision an agent raised, decided at once when it comes with the outcome, and keeps who raised it', () => {
    const raised = applyTrackerEdit(base(), { kind: 'add-decision', title: 'Cookie name', question: 'Keep it?', docs: [{ path: 'auth.md', heading: null }], from: { launch: 'ln_1' } })
    if (!raised.ok) throw new Error(raised.message)
    expect(raised.value.decisions[0]).toMatchObject({ status: 'open', from: { launch: 'ln_1' }, docs: [{ path: 'auth.md', heading: null }] })
    const recorded = applyTrackerEdit(raised.value, { kind: 'add-decision', title: 'Session length', outcome: ' 7 days ', from: { launch: 'ln_1' } })
    if (!recorded.ok) throw new Error(recorded.message)
    expect(recorded.message).toBe('Recorded decision 002')
    expect(recorded.value.decisions[1]).toMatchObject({ status: 'decided', outcome: '7 days', decidedAt: expect.any(String) })
    const read = parseTracker(JSON.parse(JSON.stringify(recorded.value)))
    expect(read.decisions.map((d) => d.from)).toEqual([{ launch: 'ln_1' }, { launch: 'ln_1' }])
    expect(parseTracker({ decisions: [{ id: 'dc_1', title: 'D', from: { what: 1 } }] }).decisions[0]?.from).toBeNull()
  })

  it('decides by choosing an option, needs the required value first, and can be superseded', () => {
    const options = [
      { title: 'Dedicated production host', detail: 'Separate from staging', recommended: true },
      { title: 'Reuse the staging host', detail: '', recommended: true },
      { title: ' ', detail: 'no title', recommended: false }
    ]
    const added = applyTrackerEdit(base(), { kind: 'add-decision', title: 'Production domain', options, input: { label: 'Production domain', value: '' } })
    if (!added.ok) throw new Error(added.message)
    const decision = added.value.decisions[0]
    if (!decision) throw new Error('no decision')
    expect(decision.options).toEqual([
      { title: 'Dedicated production host', detail: 'Separate from staging', recommended: true },
      { title: 'Reuse the staging host', detail: '', recommended: false }
    ])
    expect(applyTrackerEdit(added.value, { kind: 'update-decision', decision: decision.id, status: 'decided', chosen: 0 })).toEqual({ ok: false, message: 'Fill in Production domain first' })
    expect(applyTrackerEdit(added.value, { kind: 'update-decision', decision: decision.id, status: 'decided', input: { label: 'Production domain', value: 'omni.app' } })).toEqual({ ok: false, message: 'Choose an option or say what was decided' })

    const decided = applyTrackerEdit(added.value, { kind: 'update-decision', decision: decision.id, status: 'decided', chosen: 0, input: { label: 'Production domain', value: ' omni.app ' } })
    if (!decided.ok) throw new Error(decided.message)
    expect(decided.value.decisions[0]).toMatchObject({ status: 'decided', chosen: 0, outcome: 'Dedicated production host (Production domain: omni.app)', input: { value: 'omni.app' } })

    const superseded = applyTrackerEdit(decided.value, { kind: 'update-decision', decision: decision.id, status: 'superseded' })
    if (!superseded.ok) throw new Error(superseded.message)
    expect(superseded.value.decisions[0]).toMatchObject({ status: 'superseded', chosen: 0, decidedAt: decided.value.decisions[0]?.decidedAt })
    expect(openDecisions(superseded.value, 'a')).toEqual([])
  })

  it('reads a decision stored with one doc as a list, and drops a chosen index that points nowhere', () => {
    const [legacy, stray] = parseTracker({
      decisions: [
        { id: 'dc_1', title: 'D', doc: { path: 'auth.md', heading: 'Cookies' } },
        { id: 'dc_2', title: 'E', status: 'decided', outcome: 'x', options: [{ title: 'A' }], chosen: 3 }
      ]
    }).decisions
    expect(legacy).toMatchObject({ docs: [{ path: 'auth.md', heading: 'Cookies' }], options: [], chosen: null, input: null })
    expect(stray).toMatchObject({ options: [{ title: 'A', detail: '', recommended: false }], chosen: null })
  })

  it('holds back the tickets an open decision blocks, and forgets removed tickets', () => {
    const added = applyTrackerEdit(base(), { kind: 'add-decision', title: 'Domain', blocks: ['a', 'b'] })
    if (!added.ok) throw new Error(added.message)
    const [m] = added.value.milestones
    if (!m) throw new Error('no milestone')
    expect(readyTickets(added.value, m)).toEqual([])
    expect(openDecisions(added.value, 'a').map((d) => d.title)).toEqual(['Domain'])
    expect(removeTicket(added.value, 'a').decisions[0]?.blocks).toEqual(['b'])

    const id = added.value.decisions[0]?.id ?? ''
    const decided = applyTrackerEdit(added.value, { kind: 'update-decision', decision: id, status: 'decided', outcome: 'x' })
    expect(decided.ok && readyTickets(decided.value, m).map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('pullRequestHealth', () => {
  const review = (author: string, verdict: 'approved' | 'changes requested', createdAt: string): PullRequestComment => ({
    id: `${author}${createdAt}`,
    kind: 'review',
    author,
    body: '',
    url: '',
    createdAt,
    path: null,
    line: null,
    side: null,
    hunk: null,
    resolved: false,
    outdated: false,
    replies: [],
    verdict
  })

  it('says what the pull request needs: failing checks by name, the latest verdict per reviewer, unresolved threads', () => {
    expect(pullRequestHealth({ checks: [], comments: [] })).toEqual({ checks: 'none', failing: [], review: 'none', unresolved: 0 })
    expect(
      pullRequestHealth({
        checks: [
          { name: 'test', state: 'failed', url: null },
          { name: 'build', state: 'running', url: null }
        ],
        comments: [review('ana', 'changes requested', '1'), review('ana', 'approved', '2'), review('bo', 'approved', '1')]
      })
    ).toEqual({ checks: 'failed', failing: ['test'], review: 'approved', unresolved: 0 })
    expect(pullRequestHealth({ checks: [{ name: 'b', state: 'running', url: null }], comments: [review('ana', 'approved', '1'), review('bo', 'changes requested', '2')] })).toMatchObject({ checks: 'running', review: 'changes-requested' })
  })
})

