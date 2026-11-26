import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadEvent } from '../../shared/ipc'
import { ScriptedAgent, type AgentTurn, type ScriptStep } from '../agent/threadAgent'
import { Workspace } from '../workspace'

const AUTH = '# Auth\n\nWe use magic links.\n\n## Sessions\n\nSessions last 30 days.\n'

const dirs: string[] = []
const workspaces: Workspace[] = []
afterEach(async () => {
  for (const ws of workspaces.splice(0)) ws.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-maps-')))
  dirs.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  })
}

async function repo(files: Record<string, string>): Promise<string> {
  const dir = await tempDir()
  git(dir, 'init', '-b', 'main')
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), text)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

async function setup(script: (turn: AgentTurn) => ScriptStep[] = (turn) => [{ text: `Answer to ${turn.prompt}` }]) {
  const docs = await repo({ 'docs/auth.md': AUTH, 'docs/billing.md': '# Billing\n' })
  const agent = new ScriptedAgent(script)
  const events: ThreadEvent[] = []
  const ws = await Workspace.open(docs, () => undefined, {
    mapsDir: await tempDir(),
    agent,
    onMapEvent: (_id, event) => events.push(event),
    codeProjects: () => [{ name: 'app', root: '/code/app' }]
  })
  workspaces.push(ws)
  return { ws, docs, agent, events }
}

async function created(ws: Workspace): Promise<string> {
  return (await ws.maps.create({ title: 'Auth', description: 'Sign-in', projects: ['app'], launchMode: 'ticket' })).id
}

describe('WorkspaceMaps', () => {
  it('creates a map with an empty tracker, in .manta/maps/<id>/', async () => {
    const { ws, docs } = await setup()
    const summary = await ws.maps.create({ title: '  Auth  ', description: 'Sign-in', projects: ['app', 'app'], launchMode: 'milestone' })
    expect(summary).toMatchObject({ title: 'Auth', description: 'Sign-in', current: null, waiting: 0, running: false })

    const detail = await ws.maps.get(summary.id)
    expect(detail).toMatchObject({ projects: ['app'], launchMode: 'milestone', sweep: true, pinned: null, milestones: [], docs: [], launches: [], suggestions: [], proposals: [] })
    const stored = JSON.parse(await readFile(path.join(docs, '.manta/maps', summary.id, 'map.json'), 'utf8'))
    expect(stored).toMatchObject({ version: 2, id: summary.id, title: 'Auth' })
    expect(JSON.parse(await readFile(path.join(docs, '.manta/maps', summary.id, 'tracker.json'), 'utf8'))).toEqual({ milestones: [], decisions: [], nextTicket: 1, nextDecision: 1 })
    expect(git(docs, 'status', '--porcelain')).toBe('')
    await expect(ws.maps.create({ title: ' ', description: '', projects: [], launchMode: 'ticket' })).rejects.toThrow('Give the map a title')
  })

  it('edits the tracker by hand and reports the current milestone and progress', async () => {
    const { ws } = await setup()
    const id = await created(ws)
    expect(await ws.maps.editTracker(id, { kind: 'add-milestone', title: 'Tracker' })).toMatchObject({ ok: true })
    expect(await ws.maps.editTracker(id, { kind: 'add-milestone', title: 'Screens' })).toMatchObject({ ok: true })
    const [tracker, screens] = (await ws.maps.get(id)).milestones
    if (!tracker || !screens) throw new Error('milestones missing')
    await ws.maps.editTracker(id, { kind: 'add-ticket', milestone: tracker.id, title: 'Data model' })
    await ws.maps.editTracker(id, { kind: 'add-ticket', milestone: tracker.id, title: 'Store' })
    const [model] = (await ws.maps.get(id)).milestones[0]?.tickets ?? []
    if (!model) throw new Error('ticket missing')
    await ws.maps.editTracker(id, { kind: 'set-ticket-status', ticket: model.id, status: 'done' })

    const summary = (await ws.maps.list())[0]
    expect(summary?.current).toEqual({ id: tracker.id, title: 'Tracker', done: 1, total: 2 })
    expect(await ws.maps.update(id, { pinned: screens.id })).toMatchObject({ ok: true })
    expect((await ws.maps.list())[0]?.current?.title).toBe('Screens')
    expect((await ws.maps.get(id)).milestones.map((m) => m.status)).toEqual(['in-progress', 'todo'])
  })

  it('numbers tickets from before numbers, keys the map, keeps decisions and counts visits', async () => {
    const { ws, docs } = await setup()
    const id = await created(ws)
    const trackerFile = path.join(docs, '.manta/maps', id, 'tracker.json')
    await writeFile(trackerFile, JSON.stringify({ milestones: [{ id: 'ms_1', title: 'M', tickets: [{ id: 'tk_a', title: 'A', status: 'done' }, { id: 'tk_b', title: 'B' }] }] }))
    const before = await ws.maps.get(id)
    expect(before).toMatchObject({ key: 'AUT', stage: 'building', stageSet: null, lastVisitedAt: null, seenAt: null, decisions: [] })
    expect(before.milestones[0]?.tickets.map((t) => [t.number, t.status])).toEqual([
      [1, 'done'],
      [2, 'todo']
    ])

    expect(await ws.maps.editTracker(id, { kind: 'add-ticket', milestone: 'ms_1', title: 'C' })).toMatchObject({ ok: true })
    expect(await ws.maps.editTracker(id, { kind: 'add-decision', title: 'Domain', blocks: ['tk_b'] })).toMatchObject({ ok: true, message: 'Added decision 001' })
    const stored = JSON.parse(await readFile(trackerFile, 'utf8'))
    expect(stored).toMatchObject({ nextTicket: 4, nextDecision: 2, milestones: [{ tickets: [{ number: 1 }, { number: 2 }, { number: 3 }] }], decisions: [{ number: 1, blocks: ['tk_b'] }] })
    expect(await ws.maps.update(id, { key: 'au', stage: 'validating' })).toMatchObject({ ok: true })
    expect(await ws.maps.get(id)).toMatchObject({ key: 'AU', stage: 'validating', stageSet: 'validating', decisions: [{ title: 'Domain', status: 'open' }] })

    await ws.maps.visit(id)
    await ws.maps.visit(id)
    expect((await ws.maps.get(id)).lastVisitedAt).toBeNull()
    const state = path.join(docs, '.git/manta/maps', id, 'state.json')
    const earlier = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    await writeFile(state, JSON.stringify({ ...JSON.parse(await readFile(state, 'utf8')), visitedAt: earlier }))
    await ws.maps.visit(id)
    expect((await ws.maps.get(id)).lastVisitedAt).toBe(earlier)
  })

  it('asks before removing a ticket that has launches or a milestone with tickets, and unpins and untags a removed milestone', async () => {
    const { ws } = await setup()
    const id = await created(ws)
    await ws.maps.editTracker(id, { kind: 'add-milestone', title: 'Tracker' })
    const milestone = (await ws.maps.get(id)).milestones[0]?.id ?? ''
    await ws.maps.editTracker(id, { kind: 'add-ticket', milestone, title: 'Data model' })
    await ws.maps.editDocs(id, { kind: 'add-doc', path: 'docs/auth.md', milestones: [milestone], section: null })
    await ws.maps.update(id, { pinned: milestone })
    const questions: string[] = []

    expect(await ws.maps.removeFromTracker(id, { milestone }, async (q) => (questions.push(q), false))).toBeNull()
    expect(await ws.maps.removeFromTracker(id, { milestone }, async () => true)).toMatchObject({ ok: true })
    expect(questions).toEqual(['Remove the milestone “Tracker” and its 1 tickets?'])
    const detail = await ws.maps.get(id)
    expect(detail).toMatchObject({ milestones: [], pinned: null, docs: [{ path: 'docs/auth.md', milestones: [] }] })
  })

  it('lists docs with milestones and sections, flags missing ones, and creates new docs in the docs repo', async () => {
    const { ws, docs } = await setup()
    const id = await created(ws)
    await ws.maps.editDocs(id, { kind: 'add-section', title: 'UI' })
    const section = (await ws.maps.get(id)).sections[0]?.id ?? null
    expect(await ws.maps.editDocs(id, { kind: 'add-doc', path: 'docs/auth.md', milestones: [], section })).toMatchObject({ ok: true })
    expect(await ws.maps.editDocs(id, { kind: 'add-doc', path: 'docs/gone.md', milestones: [], section: null })).toMatchObject({ ok: true })
    expect(await ws.maps.createDoc(id, { path: 'auth/prd', milestones: [], section: null, roles: [] })).toBe('auth/prd.md')
    expect(await readFile(path.join(docs, 'auth/prd.md'), 'utf8')).toBe('# prd\n')
    await expect(ws.maps.createDoc(id, { path: 'docs/auth.md', milestones: [], section: null, roles: [] })).rejects.toThrow('docs/auth.md already exists')
    expect(await ws.maps.editDocs(id, { kind: 'update-doc', path: 'docs/auth.md', roles: ['technical', 'product'] })).toMatchObject({ ok: true })

    const listed = (await ws.maps.get(id)).docs
    expect(listed).toEqual([
      { path: 'docs/auth.md', milestones: [], section, roles: ['product', 'technical'], exists: true, title: 'Auth', updatedAt: expect.any(String) },
      { path: 'docs/gone.md', milestones: [], section: null, roles: [], exists: false, title: 'gone', updatedAt: null },
      { path: 'auth/prd.md', milestones: [], section: null, roles: [], exists: true, title: 'prd', updatedAt: expect.any(String) }
    ])
    expect(Number.isNaN(Date.parse(listed[0]?.updatedAt ?? ''))).toBe(false)
    expect(await ws.maps.docText('docs/auth.md')).toBe(AUTH)
    expect(await ws.maps.docText('docs/gone.md')).toBeNull()
    expect(await ws.maps.docText('../outside.md')).toBeNull()

    expect(await ws.maps.editDocs(id, { kind: 'add-link', url: 'https://figma.com/file/x', title: 'Login flow', roles: ['design'], milestones: [] })).toMatchObject({ ok: true })
    expect((await ws.maps.get(id)).docs.at(-1)).toMatchObject({ link: { url: 'https://figma.com/file/x', title: 'Login flow' }, exists: true, title: 'Login flow', updatedAt: null })
    expect(await ws.maps.docsFor(id, {})).not.toContainEqual(expect.objectContaining({ path: expect.stringMatching(/^link:/) }))
    expect(await ws.maps.editDocs(id, { kind: 'remove-doc', path: 'docs/auth.md' })).toMatchObject({ ok: true })
    expect(await readFile(path.join(docs, 'docs/auth.md'), 'utf8')).toBe(AUTH)
  })

  it('accepts suggestions: a doc, a doc worth writing, a ticket, and a plan milestone by milestone', async () => {
    const { ws, docs } = await setup()
    const id = await created(ws)
    await ws.maps.editTracker(id, { kind: 'add-milestone', title: 'Tracker' })
    const milestone = (await ws.maps.get(id)).milestones[0]?.id ?? ''
    const from = { launch: 'l_0123456789' }
    const addDoc = await ws.maps.suggest(id, { kind: 'add-doc', path: 'docs/billing.md', why: 'Relied on it', milestones: [milestone] }, from)
    const write = await ws.maps.suggest(id, { kind: 'write-doc', title: 'Store format', why: 'Undecided', milestones: [] }, from)
    const ticket = await ws.maps.suggest(id, { kind: 'ticket', milestone, ticket: { title: 'Migrate', description: 'Old maps', acceptance: ['Old maps open'], constraints: [], after: [], project: null, docs: [] }, why: 'Found it' }, from)
    const plan = await ws.maps.suggest(
      id,
      {
        kind: 'plan',
        why: 'From the PRD',
        milestones: [
          {
            title: 'One',
            description: '',
            doneWhen: [],
            tickets: [
              { title: 'A', description: '', acceptance: [], constraints: [], after: [], project: null, docs: [{ path: 'docs/auth.md', heading: 'Sessions' }] },
              { title: 'B', description: '', acceptance: [], constraints: [], after: ['A'], project: null, docs: [] }
            ]
          },
          { title: 'Two', description: '', doneWhen: [], tickets: [] }
        ]
      },
      { ask: true }
    )
    expect((await ws.maps.list())[0]?.waiting).toBe(4)

    expect(await ws.maps.resolveSuggestion(id, addDoc.id, true, null)).toMatchObject({ ok: true, doc: null })
    expect(await ws.maps.resolveSuggestion(id, write.id, true, null)).toEqual({ ok: true, message: 'Created auth/store-format.md', doc: 'auth/store-format.md' })
    expect(await readFile(path.join(docs, 'auth/store-format.md'), 'utf8')).toBe('# Store format\n')
    expect(await ws.maps.resolveSuggestion(id, ticket.id, true, null)).toMatchObject({ ok: true })
    expect(await ws.maps.resolveSuggestion(id, plan.id, true, [])).toEqual({ ok: false, message: 'Pick at least one milestone' })
    expect(await ws.maps.resolveSuggestion(id, plan.id, true, [0])).toMatchObject({ ok: true, message: 'Added 1 milestone' })
    expect(await ws.maps.resolveSuggestion(id, plan.id, false, null)).toEqual({ ok: false, message: 'That suggestion is gone' })

    const detail = await ws.maps.get(id)
    expect(detail.suggestions).toEqual([])
    expect(detail.docs.map((d) => [d.path, d.milestones])).toEqual([
      ['docs/billing.md', [milestone]],
      ['auth/store-format.md', []]
    ])
    expect(detail.milestones.map((m) => [m.title, m.tickets.map((t) => t.title)])).toEqual([
      ['Tracker', ['Migrate']],
      ['One', ['A', 'B']]
    ])
    expect(detail.milestones[1]?.tickets[0]?.docs).toEqual([{ path: 'docs/auth.md', heading: 'Sessions' }])
    expect(detail.milestones[0]?.tickets[0]?.acceptance).toEqual(['Old maps open'])
    /** B named A by title in the same plan: it waits for A's new id. */
    expect(detail.milestones[1]?.tickets[1]?.after).toEqual([detail.milestones[1]?.tickets[0]?.id])
  })

  it('lists open doc changes proposed by its agents as waiting for review', async () => {
    const { ws } = await setup()
    const id = await created(ws)
    const proposed = await ws.threads.propose('docs/auth.md', {
      find: 'last 30 days',
      replace: 'last 7 days',
      title: 'Sessions are 7 days',
      why: 'The store expires them after 7.',
      from: { ref: { map: id, from: { launch: 'l_0123456789' }, title: 'Store' }, label: 'the map session “Store”' }
    })
    if (!proposed.ok) throw new Error(proposed.message)
    expect(proposed.thread.proposedByMap).toEqual({ map: id, from: { launch: 'l_0123456789' }, title: 'Store' })
    expect((await ws.maps.get(id)).proposals).toEqual([{ thread: proposed.thread.id, doc: 'docs/auth.md', title: 'Sessions are 7 days', from: { launch: 'l_0123456789' } }])
    expect((await ws.threads.transcript(proposed.thread.id))[0]?.text).toBe('Proposed by the map session “Store”')

    const other = { ref: { map: id, from: { launch: 'l_9999999999' }, title: 'Other' }, label: 'x' }
    expect(await ws.threads.withdraw(proposed.thread.id, other, 'no')).toEqual({ ok: false, message: `${proposed.thread.id} is not a proposal from this session` })
    await ws.threads.setStatus('docs/auth.md', proposed.thread.id, 'discarded')
    expect((await ws.maps.get(id)).proposals).toEqual([])
  })

  it('logs activity in .manta beside the journals: backfilled once, then each change, with proposals from their records', async () => {
    const { ws, docs } = await setup()
    const id = await created(ws)
    const first = await ws.maps.get(id)
    expect(first.activity).toEqual([])
    expect(await readFile(path.join(docs, '.manta', 'maps', id, 'activity.jsonl'), 'utf8')).toBe('')

    await ws.maps.editTracker(id, { kind: 'add-milestone', title: 'Launch' })
    const milestone = (await ws.maps.get(id)).milestones[0]?.id ?? ''
    await ws.maps.editTracker(id, { kind: 'add-ticket', milestone, title: 'Domains' })
    const ticket = (await ws.maps.get(id)).milestones[0]?.tickets[0]?.id ?? ''
    await ws.maps.editTracker(id, { kind: 'add-decision', title: 'Production domain', question: 'Which?' })
    await ws.maps.editTracker(id, { kind: 'set-ticket-status', ticket, status: 'done' })
    const suggestion = await ws.maps.suggest(id, { kind: 'add-doc', path: 'docs/billing.md', why: 'Prices', milestones: [] }, { ask: true })
    await ws.maps.resolveSuggestion(id, suggestion.id, false, null)
    await ws.threads.propose('docs/auth.md', { find: 'last 30 days', replace: 'last 7 days', title: 'Sessions are 7 days', why: 'x', from: { ref: { map: id, from: { launch: 'l_0123456789' }, title: 'Store' }, label: 'x' } })

    const detail = await ws.maps.get(id)
    expect(detail.activity.map((e) => e.kind).sort()).toEqual(['decision-raised', 'doc-change-proposed', 'milestone-done', 'suggestion', 'suggestion-dismissed', 'ticket-done'])
    expect(detail.activity.find((e) => e.kind === 'doc-change-proposed')).toMatchObject({ title: 'Sessions are 7 days', doc: 'docs/auth.md', launch: 'l_0123456789' })
    expect(detail.activity.find((e) => e.kind === 'ticket-done')).toMatchObject({ title: 'Domains', ticket, milestone })
    expect(detail.seenAt).toBeNull()
    await ws.maps.markSeen(id)
    expect((await ws.maps.get(id)).seenAt).toEqual(expect.any(String))
  })

  it('backfills a map that has history but no log', async () => {
    const { ws, docs } = await setup()
    const id = await created(ws)
    await ws.maps.editTracker(id, { kind: 'add-decision', title: 'Production domain', question: 'Which?' })
    await rm(path.join(docs, '.manta', 'maps', id, 'activity.jsonl'))
    expect((await ws.maps.get(id)).activity).toMatchObject([{ kind: 'decision-raised', title: 'Production domain' }])
  })

  it('runs Ask the map with the outline as its checkout and keeps the conversation, never writing the map', async () => {
    const { ws, agent, events } = await setup((turn) => [{ text: `Read ${path.basename(turn.file)}. ` }, { text: 'It has one milestone.' }])
    const id = await created(ws)
    await ws.maps.editTracker(id, { kind: 'add-milestone', title: 'Tracker' })

    expect(await ws.maps.send(id, "What's left?")).toMatchObject({ ok: true })
    const turn = agent.turns[0]
    if (!turn || !('map' in turn.context)) throw new Error('no map turn')
    expect(await readFile(turn.file, 'utf8')).toContain('- Tracker (`')
    expect(turn.context.map.prompt).toContain('You never change the map or the docs directly')
    expect(turn.context.mcp).toBeNull()
    expect((await ws.maps.get(id)).messages.map((m) => [m.role, m.text])).toEqual([
      ['user', "What's left?"],
      ['assistant', 'Read map.md. It has one milestone.']
    ])
    expect(events.map((e) => e.type)).toContain('turn-end')
  })

  it('converts a v1 map on first listing, keeping its docs and the old map.md', async () => {
    const { ws, docs } = await setup()
    const id = 'm_0a1b2c3d4e5f'
    const folder = path.join(docs, '.manta/maps', id)
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, 'map.json'), JSON.stringify({ id, title: 'Old', about: 'From v1', createdAt: '2026-10-01T00:00:00.000Z', refreshedAt: null, basis: {} }))
    await writeFile(path.join(folder, 'map.md'), '# Old\n\n## Docs\n\n- [Auth](docs/auth.md#Sessions) — it\n')
    await writeFile(path.join(folder, 'product.md'), '# Old: Product\n')

    expect((await ws.maps.list()).map((m) => [m.id, m.title, m.description])).toEqual([[id, 'Old', 'From v1']])
    expect((await ws.maps.get(id)).docs).toEqual([{ path: 'docs/auth.md', milestones: [], section: null, roles: [], exists: true, title: 'Auth', updatedAt: expect.any(String) }])
    expect(await readFile(path.join(folder, 'map.v1.md'), 'utf8')).toContain('## Docs')
    expect(await readFile(path.join(folder, 'product.md'), 'utf8')).toBe('# Old: Product\n')
  })

  it('removes a map after confirming, leaving its docs', async () => {
    const { ws, docs } = await setup()
    const id = await created(ws)
    expect(await ws.maps.remove(id, async () => false)).toBeNull()
    expect(await ws.maps.remove(id, async () => true)).toEqual({ ok: true, message: 'Removed the map Auth' })
    expect(await ws.maps.list()).toEqual([])
    await expect(ws.maps.get(id)).rejects.toThrow(`No context map ${id}`)
    await vi.waitFor(async () => expect(await readFile(path.join(docs, 'docs/auth.md'), 'utf8')).toBe(AUTH))
  })

  it('keeps journals with the map, moving any left with the machine-local state, and keeps the projects’ checks', async () => {
    const { ws, docs } = await setup()
    const id = await created(ws)
    const legacy = path.join(docs, '.git/manta/maps', id, 'journals')
    await mkdir(legacy, { recursive: true })
    await writeFile(path.join(legacy, 'l_0123456789.md'), '- old **note**: before the move\n')
    await ws.maps.list()
    expect(await ws.maps.journal(id, 'l_0123456789')).toBe('- old **note**: before the move\n')
    expect(await readFile(path.join(docs, '.manta/maps', id, 'journals/l_0123456789.md'), 'utf8')).toContain('before the move')
    await ws.maps.appendJournal(id, 'l_0123456789', 'note', 'after')
    expect(await ws.maps.journal(id, 'l_0123456789')).toContain('**note**: after')
    expect(git(docs, 'status', '--porcelain')).toBe('')

    expect(await ws.maps.update(id, { checks: [{ project: 'app', commands: [' npm test ', ''] }, { project: 'api', commands: [''] }] })).toMatchObject({ ok: true })
    expect((await ws.maps.get(id)).checks).toEqual([{ project: 'app', commands: ['npm test'] }])
  })

  it('applies the plan changes picked, skipping ones that no longer apply', async () => {
    const { ws } = await setup()
    const id = await created(ws)
    await ws.maps.editTracker(id, { kind: 'add-milestone', title: 'Tracker' })
    const milestone = (await ws.maps.get(id)).milestones[0]?.id ?? ''
    await ws.maps.editTracker(id, { kind: 'add-ticket', milestone, title: 'Store' })
    await ws.maps.editTracker(id, { kind: 'add-ticket', milestone, title: 'Screens' })
    const [store, screens] = (await ws.maps.get(id)).milestones[0]?.tickets ?? []
    if (!store || !screens) throw new Error('tickets missing')
    const suggestion = await ws.maps.suggest(
      id,
      {
        kind: 'plan-change',
        why: 'Screens need the store',
        changes: [
          { kind: 'update-ticket', ticket: screens.id, after: [store.id] },
          { kind: 'remove-ticket', ticket: 'tk_gone' },
          { kind: 'update-milestone', milestone, title: 'Tracker v2' }
        ]
      },
      { ask: true }
    )
    expect((await ws.maps.list())[0]?.waiting).toBe(1)
    expect(await ws.maps.resolveSuggestion(id, suggestion.id, true, null)).toEqual({ ok: true, message: 'Applied 2 changes; skipped 1: That ticket is gone', doc: null })
    const detail = await ws.maps.get(id)
    expect(detail.milestones[0]?.title).toBe('Tracker v2')
    expect(detail.milestones[0]?.tickets[1]?.after).toEqual([store.id])
    expect(detail.suggestions).toEqual([])
  })
})

