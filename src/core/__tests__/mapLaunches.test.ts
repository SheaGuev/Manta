import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MapBriefRequest, MapLaunchRequest, OpResult, PullRequestDetail, PullRequestInfo } from '../../shared/ipc'
import { ScriptedAgent, type AgentTurn, type ScriptStep } from '../agent/threadAgent'
import { MapLaunches, needsSweep } from '../mapLaunches'
import { ProjectRegistry } from '../repo/projects'
import { TerminalManager } from '../terminal/terminals'

const FAKE_CLAUDE = fileURLToPath(new URL('../../../scripts/fake-claude.mjs', import.meta.url))
/** Each wait is the fake session starting plus a hook round trip; under a full parallel suite that passes waitFor's default second. */
const slow = { timeout: 8000 }

const dirs: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-launch-')))
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
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'seed')
  return dir
}

interface Options {
  claude?: boolean
  pullRequests?: (branch: string) => PullRequestInfo | null
  sweep?: (turn: AgentTurn) => ScriptStep[]
  secondProject?: boolean
  detail?: (branch: string) => PullRequestDetail | null
  openPullRequest?: (worktree: string, input: { title: string; body: string }) => Promise<OpResult>
}

function prDetail(extra: Partial<PullRequestDetail> = {}): PullRequestDetail {
  return {
    id: 'PR_1',
    number: 7,
    title: 'Shorter sessions',
    state: 'open',
    url: 'https://github.com/o/r/pull/7',
    baseRefName: 'main',
    baseRefOid: 'a',
    headRefName: 'manta/shorter-sessions',
    headRefOid: 'b',
    author: 'me',
    viewer: 'me',
    checks: [],
    comments: [],
    truncated: false,
    ...extra
  }
}

async function setup(options: Options = {}) {
  const appData = await tempDir()
  const docs = await repo({ 'auth.md': '# Auth\n\n## Sessions\n\nSessions last 30 days.\n' })
  const code = await repo({ 'app.ts': 'export {}\n' })
  const other = options.secondProject ? await repo({ 'lib.ts': 'export {}\n' }) : null
  let launches: MapLaunches | null = null
  const projects = await ProjectRegistry.load({
    settingsFile: path.join(appData, 'settings.json'),
    worktreesDir: path.join(appData, 'worktrees'),
    mapsDir: path.join(appData, 'maps'),
    agent: new ScriptedAgent((turn) => [{ text: `Answer to ${turn.prompt}` }]),
    onUpdate: () => undefined,
    mapAgentMcp: (root, map) => launches?.askMcp(root, map) ?? null
  })
  await projects.add(docs, 'docs')
  await projects.add(code, 'code')
  if (other) await projects.add(other, 'code')
  const chunks = new Map<string, string>()
  const changed: string[] = []
  const sweepAgent = new ScriptedAgent(options.sweep ?? (() => [{ call: { tool: 'wrap_up', args: { summary: 'Went to plan.', went_to_plan: true } } }]))
  const terminals = await TerminalManager.open({
    recordsFile: path.join(appData, 'terminals.json'),
    settingsFile: path.join(appData, 'terminal-settings.json'),
    hookSettingsFile: path.join(appData, 'hooks', 'claude-settings.json'),
    claude: () => (options.claude === false ? null : { file: process.execPath, args: [FAKE_CLAUDE] }),
    shell: '/bin/sh',
    baseEnv: async () => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: appData }),
    onData: (id, data) => chunks.set(id, (chunks.get(id) ?? '') + data),
    onChange: (info) => launches?.terminalChanged(info),
    onRemoved: (id) => launches?.terminalRemoved(id),
    refreshMapBrief: async (link, file, terminal) => launches?.refreshBrief(link, file, terminal),
    promptContext: async (record) => (launches ? launches.promptContext(record.id) : null),
    mcpTools: (session) => launches?.toolsFor(session) ?? []
  })
  launches = new MapLaunches({
    projects,
    terminals,
    briefsDir: path.join(appData, 'map-briefs'),
    agentsDir: path.join(appData, 'map-agents'),
    agent: sweepAgent,
    ...(options.pullRequests ? { pullRequests: async (_root: string, branch: string) => ({ found: options.pullRequests?.(branch) ?? null }) } : {}),
    ...(options.detail ? { pullRequestDetail: async (_root: string, branch: string) => ({ found: options.detail?.(branch) ?? null }) } : {}),
    ...(options.openPullRequest ? { openPullRequest: options.openPullRequest } : {}),
    onMapChanged: (_root, map) => changed.push(map),
    coordinatorDelayMs: 100
  })
  cleanups.push(async () => {
    launches?.close()
    await terminals.shutdown()
    await projects.closeAll()
  })
  const ws = await projects.workspace(docs)
  const map = await ws.maps.create({ title: 'Auth', description: 'Sign-in', projects: [], launchMode: 'ticket' })
  await ws.maps.editTracker(map.id, { kind: 'add-milestone', title: 'Sessions' })
  const milestone = (await ws.maps.get(map.id)).milestones[0]?.id ?? ''
  await ws.maps.editTracker(map.id, { kind: 'add-ticket', milestone, title: 'Shorter sessions', description: 'Make them 7 days.' })
  await ws.maps.editTracker(map.id, { kind: 'add-ticket', milestone, title: 'Remember me' })
  const [first, second] = (await ws.maps.get(map.id)).milestones[0]?.tickets ?? []
  if (!first || !second) throw new Error('tickets missing')
  await ws.maps.editTracker(map.id, { kind: 'update-ticket', ticket: first.id, docs: [{ path: 'auth.md', heading: 'Sessions' }] })
  const request = (extra: Partial<MapLaunchRequest> = {}): MapLaunchRequest => ({ docsRoot: docs, map: map.id, scope: { ticket: first.id }, mode: 'ticket', project: null, cols: 100, rows: 30, ...extra })
  const state = (terminal: string) => terminals.list().find((t) => t.id === terminal)?.state
  return { launches, terminals, projects, ws, docs, code, other, appData, map: map.id, milestone, first: first.id, second: second.id, request, sweepAgent, changed, state, output: (id: string) => chunks.get(id) ?? '' }
}

describe('MapLaunches', () => {
  it('puts sessions started together in a batch, shows their reports on the board, and runs a coordinator that hears what needs the user', async () => {
    const s = await setup()
    const batch = 'b_abcdef12'
    const one = await s.launches.launch(s.request({ batch }))
    const two = await s.launches.launch(s.request({ batch, scope: { ticket: s.second } }))
    if (!one.ok || !two.ok) throw new Error('launch failed')
    expect([one.launch.batch, two.launch.batch]).toEqual([batch, batch])
    expect((await s.ws.maps.get(s.map)).batches).toEqual([{ id: batch, createdAt: expect.any(String), coordinator: null, declined: false }])
    await vi.waitFor(() => expect(s.state(one.terminal.id)).toBe('idle'), slow)
    await vi.waitFor(() => expect(s.state(two.terminal.id)).toBe('idle'), slow)

    s.terminals.write(one.terminal.id, `tool report_progress ${JSON.stringify({ phase: 'building', summary: 'Store written', next: 'tests' })}\r`)
    await vi.waitFor(() => expect(s.output(one.terminal.id)).toContain('On the board.'), slow)
    expect((await s.ws.maps.get(s.map)).launches[0]?.sessions[0]?.progress).toMatchObject({ phase: 'building', summary: 'Store written', needs: null, next: 'tests' })

    const coordinator = await s.launches.coordinate(s.docs, s.map, batch, { cols: 100, rows: 30 })
    expect(coordinator).toMatchObject({ root: s.docs, title: 'Coordinator: Auth', map: { map: s.map, launch: null, coordinator: batch } })
    await vi.waitFor(() => expect(s.output(coordinator.id)).toContain('Scripted reply to: Coordinate the agents in your brief'), slow)
    await vi.waitFor(() => expect(s.state(coordinator.id)).toBe('idle'), slow)
    const brief = await readFile(path.join(s.appData, 'map-briefs', `coordinator-${batch}-${coordinator.sessionId}.md`), 'utf8')
    expect(brief).toContain(`(Manta map ${s.map}, batch ${batch})`)
    expect(brief).toContain('“Store written” next: tests')
    expect(await s.launches.coordinate(s.docs, s.map, batch, { cols: 100, rows: 30 })).toMatchObject({ id: coordinator.id })
    const names = s.launches.toolsFor({ terminal: { ...coordinator, brief: null, addDirs: [] } })?.map((t) => t.name)
    expect(names).toContain('board')
    expect(names).not.toContain('set_ticket_status')
    expect(names).not.toContain('propose_doc_change')

    s.terminals.write(coordinator.id, 'tool board {}\r')
    await vi.waitFor(() => expect(s.output(coordinator.id)).toContain('this batch'), slow)
    await vi.waitFor(() => expect(s.state(coordinator.id)).toBe('idle'), slow)

    s.terminals.write(two.terminal.id, `tool report_progress ${JSON.stringify({ phase: 'exploring', summary: 'Reading', needs: { kind: 'decision', ask: 'Cookie or token?' } })}\r`)
    await vi.waitFor(() => expect(s.output(coordinator.id)).toContain('Scripted reply to: Manta: changed since you last looked:'), slow)
    const wakeUps = (): number => s.output(coordinator.id).split('Scripted reply to: Manta: changed since you last looked').length - 1
    expect(wakeUps()).toBe(1)
    s.terminals.write(one.terminal.id, `tool report_progress ${JSON.stringify({ phase: 'verifying', summary: 'Running tests' })}\r`)
    await vi.waitFor(() => expect(s.output(one.terminal.id)).toContain('On the board.'), slow)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(wakeUps()).toBe(1)

    await s.launches.declineCoordinator(s.docs, s.map, batch)
    expect((await s.ws.maps.get(s.map)).batches[0]).toMatchObject({ declined: true, coordinator: { terminal: coordinator.id } })
  })

  it('launches a ticket in a new worktree with its scoped brief, and puts it in progress', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)

    expect(started.launch).toMatchObject({ scope: { ticket: s.first }, project: s.code, branch: 'manta/shorter-sessions', landed: false })
    expect(started.launch.base).toBe(git(s.code, 'rev-parse', 'main').trim())
    expect(started.terminal).toMatchObject({ kind: 'claude', title: 'Shorter sessions', map: { docsRoot: s.docs, map: s.map, launch: started.launch.id, ticket: null } })
    expect(started.terminal.root).toBe(await realpath(started.launch.worktree))
    await vi.waitFor(() => expect(s.output(started.terminal.id)).toContain(`(Manta map ${s.map}, launch ${started.launch.id})`), slow)
    await vi.waitFor(() => expect(s.output(started.terminal.id)).toContain('Scripted reply to: Work on “Shorter sessions”, as your brief describes.'), slow)
    expect(s.output(started.terminal.id)).toContain(`Added dirs: ${s.docs}`)

    const detail = await s.ws.maps.get(s.map)
    expect(detail.milestones[0]?.tickets.map((t) => t.status)).toEqual(['in-progress', 'todo'])
    expect(detail.milestones[0]?.status).toBe('in-progress')
    expect(detail.launches[0]?.sessions).toEqual([{ terminal: started.terminal.id, session: started.terminal.sessionId, ticket: null, startedAt: expect.any(String), progress: null }])
    const briefs = path.join(s.appData, 'map-briefs', `${started.launch.id}-${started.terminal.sessionId}.md`)
    const brief = await readFile(briefs, 'utf8')
    expect(brief).toContain('### Ticket: Shorter sessions')
    expect(brief).toContain('- `auth.md` § Sessions')
    expect(brief).toContain('## Working under the map')
  })

  it('previews a brief without starting anything, and puts the start note in the session brief', async () => {
    const s = await setup({ secondProject: true })
    const ask: MapBriefRequest = { docsRoot: s.docs, map: s.map, ticket: s.first, mode: 'ticket', project: null, note: '' }
    const picking = await s.launches.previewBrief(ask)
    expect(picking.workspace).toEqual({ kind: 'pick', projects: expect.arrayContaining([s.code, s.other]) })

    const preview = await s.launches.previewBrief({ ...ask, project: s.code, note: 'Keep the cookie name.' })
    expect(preview.workspace).toEqual({ kind: 'new', project: path.basename(s.code), root: s.code, branch: 'manta/shorter-sessions', from: 'main', shared: false })
    expect(preview.docs).toEqual([{ path: 'auth.md', heading: 'Sessions', title: 'Auth', roles: [], linked: true }])
    expect(preview.readiness).toEqual({ ready: false, included: ['Objective', 'source context'], missing: ['No acceptance criteria'], blocking: [] })
    expect(preview.outline).toEqual([{ path: 'auth.md', title: 'Auth', headings: ['Sessions'] }])
    expect(preview.permissions).toEqual(['Asks before edits and commands', 'Map tools without asking'])
    expect(preview.text).toContain('## A note from the user for this start\n\nKeep the cookie name.')
    expect(preview.text).toContain('on the branch `manta/shorter-sessions`')
    expect((await s.ws.maps.get(s.map)).launches).toEqual([])

    const started = await s.launches.launch(s.request({ project: s.code, note: ' Keep the cookie name. ' }))
    if (!started.ok) throw new Error(started.message)
    await vi.waitFor(() => expect(s.state(started.terminal.id)).toBe('idle'), slow)
    expect((await s.ws.maps.get(s.map)).launches[0]?.sessions[0]?.note).toBe('Keep the cookie name.')
    const brief = await readFile(path.join(s.appData, 'map-briefs', `${started.launch.id}-${started.terminal.sessionId}.md`), 'utf8')
    expect(brief).toContain('Keep the cookie name.')
    expect((await s.launches.previewBrief({ ...ask, project: s.code })).workspace).toMatchObject({ kind: 'reuse', branch: 'manta/shorter-sessions' })
  })

  it("runs a ticket's session in its milestone's worktree when launched per milestone, and a second ticket joins it", async () => {
    const s = await setup()
    const one = await s.launches.launch(s.request({ mode: 'milestone' }))
    if (!one.ok) throw new Error(one.message)
    expect(one.launch).toMatchObject({ scope: { milestone: s.milestone }, branch: 'manta/sessions' })
    expect(one.terminal.map?.ticket).toBe(s.first)

    const two = await s.launches.launch(s.request({ mode: 'milestone', scope: { ticket: s.second } }))
    if (!two.ok) throw new Error(two.message)
    expect(two.launch.id).toBe(one.launch.id)
    expect(two.terminal.root).toBe(one.terminal.root)
    expect((await s.ws.maps.get(s.map)).launches).toHaveLength(1)
    expect((await s.ws.maps.get(s.map)).launches[0]?.sessions.map((x) => x.ticket)).toEqual([s.first, s.second])
    expect((await s.ws.maps.get(s.map)).milestones[0]?.tickets.map((t) => t.status)).toEqual(['in-progress', 'in-progress'])
  })

  it('launches a group in one worktree, and asks which project when the map has several', async () => {
    const s = await setup({ secondProject: true })
    const asked = await s.launches.launch(s.request({ scope: { tickets: [s.first, s.second] } }))
    expect(asked).toMatchObject({ ok: false, message: 'Pick the code project to work in' })
    expect('projects' in asked && asked.projects?.sort()).toEqual([s.code, s.other].sort())

    const started = await s.launches.launch(s.request({ scope: { tickets: [s.first, s.second] }, project: s.other }))
    if (!started.ok) throw new Error(started.message)
    expect(started.launch).toMatchObject({ project: s.other, branch: 'manta/shorter-sessions-and-1-more' })
  })

  it('refuses without Claude Code before making a worktree', async () => {
    const s = await setup({ claude: false })
    expect(await s.launches.launch(s.request())).toEqual({ ok: false, message: 'Claude Code is not installed: install it, then try again' })
    expect((await s.projects.worktrees(s.code)).map((w) => w.branch)).toEqual(['main'])
  })

  it('gives the session the map tools: query, report status in scope, journal, suggest, propose doc changes and wrap up', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    const tool = async (line: string, expected: string): Promise<void> => {
      s.terminals.write(id, `${line}\r`)
      await vi.waitFor(() => expect(s.output(id)).toContain(expected), slow)
    }

    await tool('tool map_outline {}', '- Shorter sessions (`')
    await tool(`tool set_ticket_status {"ticket":"${s.second}","status":"done"}`, "Tool error: Remember me isn't in your launch's scope")
    await tool(`tool set_ticket_status {"ticket":"${s.first}","status":"blocked"}`, 'Tool error: Say why it is blocked in reason')
    await tool(`tool set_ticket_status {"ticket":"${s.first}","status":"blocked","reason":"Needs the store"}`, 'Tool: “Shorter sessions” is now blocked.')
    await tool(`tool set_ticket_status {"ticket":"${s.first}","status":"done"}`, "Tool error: “Shorter sessions” isn't merged yet. Open its pull request")
    await tool('tool journal {"kind":"decision","entry":"Kept the cookie name."}', 'Tool: Added to your journal.')
    await tool('tool suggest_doc {"path":"auth.md","why":"Explains sessions"}', 'Tool: Suggested; it waits in Needs review')
    await tool('tool propose_doc_change {"doc":"auth.md","find":"30 days","replace":"7 days","title":"Seven days","why":"Shortened"}', 'Tool: Proposed as the Manta thread')
    await tool('tool wrap_up {"summary":"Shortened sessions.","went_to_plan":false}', 'Tool: Wrap-up recorded.')

    const detail = await s.ws.maps.get(s.map)
    /** Each line typed after the block is a prompt from the user, which counts as answering it. */
    expect(detail.milestones[0]?.tickets[0]).toMatchObject({ status: 'in-progress', blocked: null })
    expect(detail.suggestions).toMatchObject([{ kind: 'add-doc', path: 'auth.md', from: { launch: started.launch.id } }])
    expect(detail.proposals).toMatchObject([{ doc: 'auth.md', title: 'Seven days', from: { launch: started.launch.id } }])
    /** The doc, the proposal, and the launch ready for a pull request. */
    expect(detail.waiting).toBe(3)
    expect(detail.launches[0]?.readyAt).toEqual(expect.any(String))
    expect(detail.launches[0]?.wrappedUpAt).toEqual(expect.any(String))
    const journal = await s.ws.maps.journal(s.map, started.launch.id)
    expect(journal).toContain('**decision**: Kept the cookie name.')
    expect(journal).toContain('**wrap-up**: Shortened sessions.')
    expect(s.changed).toContain(s.map)
  })

  it('sends the user’s requested changes to the session, and marks a ticket done after review with the doc updates included', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    s.terminals.write(id, 'tool propose_doc_change {"doc":"auth.md","find":"30 days","replace":"7 days","title":"Seven days","why":"Shortened"}\r')
    await vi.waitFor(() => expect(s.output(id)).toContain('Tool: Proposed as the Manta thread'), slow)
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)

    expect(await s.launches.requestChanges(s.docs, s.map, started.launch.id, '  ', { cols: 100, rows: 30 })).toEqual({ ok: false, message: 'Say what to change' })
    expect(await s.launches.requestChanges(s.docs, s.map, started.launch.id, 'Keep the old cookie name.', { cols: 100, rows: 30 })).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(s.output(id)).toContain('Scripted reply to: The user reviewed your work on “Shorter sessions” and asks for changes:'), slow)
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)

    const [proposal] = (await s.ws.maps.get(s.map)).proposals
    if (!proposal) throw new Error('no proposal')
    expect(await s.launches.markDone(s.docs, s.map, s.first, ['gone'])).toEqual({ ok: false, message: 'A doc update is no longer waiting; reload and try again' })
    expect(await s.launches.markDone(s.docs, s.map, s.first, [proposal.thread])).toEqual({ ok: true, message: 'Shorter sessions is done; 1 doc updated' })
    const detail = await s.ws.maps.get(s.map)
    expect(detail.milestones[0]?.tickets[0]?.status).toBe('done')
    expect(detail.proposals).toEqual([])
    expect(await readFile(path.join(s.docs, 'auth.md'), 'utf8')).toContain('Sessions last 7 days.')
    const journal = await s.ws.maps.journal(s.map, started.launch.id)
    expect(journal).toContain('**review**: The user asked for changes: Keep the old cookie name.')
    expect(journal).toContain('**review**: The user reviewed “Shorter sessions” and marked it done, with the doc updates to auth.md.')
  })

  it('marks tickets in review when the pull request opens, and leaves them for the user to accept when the branch lands', async () => {
    let pr: PullRequestInfo | null = null
    const s = await setup({ pullRequests: () => pr })
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    await s.launches.check(s.docs, s.map)
    expect((await s.ws.maps.get(s.map)).milestones[0]?.tickets[0]?.status).toBe('in-progress')

    pr = { number: 7, state: 'open', url: 'https://example.com/7' }
    await s.launches.check(s.docs, s.map)
    expect((await s.ws.maps.get(s.map)).milestones[0]?.tickets[0]?.status).toBe('in-review')
    expect((await s.ws.maps.get(s.map)).waiting).toBe(1)

    const worktree = started.launch.worktree
    await writeFile(path.join(worktree, 'app.ts'), 'export const days = 7\n')
    git(worktree, 'commit', '-am', `Shorter sessions\n\nManta-Launch: ${started.launch.id}`)
    git(s.code, 'merge', '--squash', 'manta/shorter-sessions')
    git(s.code, 'commit', '-m', `Shorter sessions (#7)\n\nManta-Launch: ${started.launch.id}`)
    await s.launches.check(s.docs, s.map)
    const detail = await s.ws.maps.get(s.map)
    expect(detail.launches[0]).toMatchObject({ landed: true, pr: { number: 7 } })
    expect(detail.milestones[0]?.tickets[0]?.status).toBe('in-review')
    /** The landing pass runs in the background; let it finish before the repos are removed. */
    await vi.waitFor(async () => expect((await s.ws.maps.get(s.map)).launches[0]?.landingSweptAt).toEqual(expect.any(String)), slow)
  })

  it('takes a ticket to review when its pull request opens and to done only once it merged, and reopens it for new work', async () => {
    let pr: PullRequestInfo | null = null
    const s = await setup({ pullRequests: () => pr })
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    const tool = async (line: string, expected: string): Promise<void> => {
      s.terminals.write(id, `${line}\r`)
      await vi.waitFor(() => expect(s.output(id)).toContain(expected), slow)
    }
    const status = async (): Promise<string | undefined> => (await s.ws.maps.get(s.map)).milestones[0]?.tickets[0]?.status

    await tool(
      'tool wrap_up {"summary":"Done.","went_to_plan":true,"finished":true,"checks":[{"command":"npm test","passed":true}],"unverified":["A real phone"],"risks":[" "]}',
      'Tool: Wrap-up recorded.'
    )
    expect(await status()).toBe('in-progress')
    expect((await s.ws.maps.get(s.map)).launches[0]).toMatchObject({ readyAt: expect.any(String), wrapUp: { checks: [{ command: 'npm test', passed: true }], unverified: ['A real phone'], decisions: [], risks: [] } })

    pr = { number: 9, state: 'open', url: 'https://example.com/9' }
    await tool(`tool set_ticket_status {"ticket":"${s.first}","status":"done"}`, "Tool error: Pull request #9 isn't merged yet; “Shorter sessions” stays in review")
    expect(await status()).toBe('in-review')

    pr = { number: 9, state: 'merged', url: 'https://example.com/9' }
    await tool(`tool set_ticket_status {"ticket":"${s.first}","status":"done"}`, 'Tool: “Shorter sessions” is now done.')
    expect(await status()).toBe('done')
    await vi.waitFor(async () => expect((await s.ws.maps.get(s.map)).launches[0]?.landingSweptAt).toEqual(expect.any(String)), slow)

    const again = await s.launches.launch(s.request())
    if (!again.ok) throw new Error(again.message)
    expect(await status()).toBe('in-progress')
  })

  it("marks a milestone landed when its own branch's pull request merges, done only once its tickets are", async () => {
    let pr: PullRequestInfo | null = null
    const s = await setup({ pullRequests: () => pr })
    const started = await s.launches.launch(s.request({ scope: { milestone: s.milestone } }))
    if (!started.ok) throw new Error(started.message)
    await s.ws.maps.setStatuses(s.map, [s.first, s.second], 'in-review')
    pr = { number: 8, state: 'merged', url: 'https://example.com/8' }
    await s.launches.check(s.docs, s.map)
    expect((await s.ws.maps.get(s.map)).milestones[0]).toMatchObject({ landed: true, status: 'in-progress' })
    await s.ws.maps.setStatuses(s.map, [s.first, s.second], 'done')
    expect((await s.ws.maps.get(s.map)).milestones[0]?.status).toBe('done')
    /** The landing pass runs in the background; let it finish before the repos are removed. */
    await vi.waitFor(async () => expect((await s.ws.maps.get(s.map)).launches[0]?.landingSweptAt).toEqual(expect.any(String)), slow)
  })

  it('sweeps a session that exits without wrapping up, once, with the small model and the map tools', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    await vi.waitFor(() => expect(s.state(started.terminal.id)).toBe('idle'), slow)
    s.terminals.write(started.terminal.id, 'tool journal {"kind":"note","entry":"Half done."}\r')
    await vi.waitFor(() => expect(s.output(started.terminal.id)).toContain('Added to your journal'), slow)
    s.terminals.write(started.terminal.id, 'exit\r')

    await vi.waitFor(async () => expect((await s.ws.maps.get(s.map)).launches[0]?.sweptAt).toEqual(expect.any(String)), slow)
    const turn = s.sweepAgent.turns[0]
    if (!turn || !('map' in turn.context)) throw new Error('no sweep turn')
    expect(turn.context.model).toBe('haiku')
    expect(turn.context.mcp?.tools).toContain('mcp__manta__wrap_up')
    expect(turn.context.mcp?.tools).not.toContain('mcp__manta__propose_milestones')
    expect(turn.prompt).toContain('**note**: Half done.')
    expect(await s.ws.maps.journal(s.map, started.launch.id)).toContain('**wrap-up (sweep)**: Went to plan. Went to plan.')

    s.launches.terminalChanged({ ...started.terminal, state: 'exited' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(s.sweepAgent.turns).toHaveLength(1)
  })

  it('never sweeps sessions killed because Manta is quitting', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    await vi.waitFor(() => expect(s.state(started.terminal.id)).toBe('idle'), slow)
    s.launches.close()
    await s.terminals.shutdown()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(s.sweepAgent.turns).toHaveLength(0)
  })

  it('skips the sweep when the session wrapped up, or the map has it off', async () => {
    const s = await setup()
    await s.ws.maps.update(s.map, { sweep: false })
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    await vi.waitFor(() => expect(s.state(started.terminal.id)).toBe('idle'), slow)
    await s.terminals.close(started.terminal.id)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(s.sweepAgent.turns).toHaveLength(0)

    const launch = (await s.ws.maps.get(s.map)).launches[0]
    if (!launch) throw new Error('no launch')
    expect(needsSweep(launch)).toBe(true)
    expect(needsSweep({ ...launch, wrappedUpAt: new Date(Date.now() + 1000).toISOString() })).toBe(false)
  })

  it('reopens a closed session by resuming it in the same worktree, with the brief rebuilt', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    await vi.waitFor(() => expect(s.state(started.terminal.id)).toBe('idle'), slow)
    await s.terminals.close(started.terminal.id)
    await s.ws.maps.editTracker(s.map, { kind: 'update-ticket', ticket: s.first, description: 'Make them 3 days.' })

    const reopened = await s.launches.openSession(s.docs, s.map, started.launch.id, null, { cols: 100, rows: 30 })
    expect(reopened.id).not.toBe(started.terminal.id)
    expect(reopened.root).toBe(started.terminal.root)
    await vi.waitFor(() => expect(s.output(reopened.id)).toContain('(resumed)'), slow)
    const brief = await readFile(path.join(s.appData, 'map-briefs', `${started.launch.id}-${started.terminal.sessionId}.md`), 'utf8')
    expect(brief).toContain('Make them 3 days.')
    expect((await s.ws.maps.get(s.map)).launches[0]?.sessions[0]?.terminal).toBe(reopened.id)
  })

  it('gives Ask the map the query, suggest and plan tools through its agent endpoint', async () => {
    const s = await setup()
    const mcp = s.launches.askMcp(s.docs, s.map)
    expect(mcp?.url).toMatch(/\/mcp\/agent_ask_m_[0-9a-f]+$/)
    expect(mcp?.tools).toContain('mcp__manta__propose_milestones')
    expect(mcp?.tools).toContain('mcp__manta__propose_decision')
    expect(mcp?.tools).not.toContain('mcp__manta__set_ticket_status')
    const agent = new ScriptedAgent(() => [
      { call: { tool: 'propose_milestones', args: { why: 'PRD', milestones: [{ title: 'Later', description: '', tickets: [{ title: 'X', description: '' }] }] } } },
      { call: { tool: 'propose_decision', args: { title: 'Domain', question: 'Which?', outcome: 'omni.app', confirmed_with_user: true } } }
    ])
    for await (const _ of agent.run({ prompt: 'plan', cwd: s.appData, file: '', session: null, context: { repoRoot: s.docs, map: { id: s.map, title: 'Auth', prompt: '' }, mcp }, signal: new AbortController().signal, requestPermission: async () => 'deny' })) {
      /** Drains the turn. */
    }
    const detail = await s.ws.maps.get(s.map)
    expect(detail.suggestions).toMatchObject([{ kind: 'plan', from: { ask: true }, milestones: [{ title: 'Later' }] }])
    expect(detail.decisions).toMatchObject([{ title: 'Domain', status: 'open', outcome: '', from: { ask: true } }])
  })

  it('records a finished wrap-up with its criteria, and opens a draft pull request for the finished work', async () => {
    const opened: { worktree: string; title: string; body: string }[] = []
    const s = await setup({
      openPullRequest: async (worktree, input) => {
        opened.push({ worktree, ...input })
        return { ok: true, message: 'Draft PR created: https://github.com/o/r/pull/12' }
      }
    })
    await s.ws.maps.editTracker(s.map, { kind: 'update-ticket', ticket: s.first, acceptance: ['Sessions last 7 days', 'Old cookies still work'] })
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    const criteria = [
      { ticket: s.first, index: 0, met: true, evidence: 'session.test.ts' },
      { ticket: s.first, index: 1, met: false, evidence: 'not tried' },
      { ticket: s.first, index: 9, met: true, evidence: 'no such criterion' }
    ]
    s.terminals.write(id, `tool wrap_up ${JSON.stringify({ summary: 'Shortened sessions.', went_to_plan: true, finished: true, criteria })}\r`)
    await vi.waitFor(() => expect(s.output(id)).toContain('The work is ready for a pull request'), slow)

    let launch = (await s.ws.maps.get(s.map)).launches[0]
    expect(launch?.readyAt).toEqual(expect.any(String))
    expect(launch?.wrapUp).toMatchObject({ summary: 'Shortened sessions.', finished: true, sweep: false, criteria: criteria.slice(0, 2) })
    expect(await s.ws.maps.journal(s.map, started.launch.id)).toContain('Finished. Criteria: 1 of 2 met.')

    expect(await s.launches.openPullRequest(s.docs, s.map, started.launch.id)).toMatchObject({ ok: true })
    expect(opened[0]?.title).toBe('Shorter sessions')
    expect(opened[0]?.body).toContain('- [x] Sessions last 7 days (session.test.ts)')
    expect(opened[0]?.body).toContain('- [ ] Old cookies still work')
    expect(opened[0]?.body).toContain(`Manta-Launch: ${started.launch.id}`)
    const detail = await s.ws.maps.get(s.map)
    launch = detail.launches[0]
    expect(launch?.pr).toEqual({ number: 12, state: 'open', url: 'https://github.com/o/r/pull/12' })
    expect(detail.milestones[0]?.tickets[0]?.status).toBe('in-review')
    expect(await s.launches.openPullRequest(s.docs, s.map, started.launch.id)).toEqual({ ok: false, message: 'It already has pull request #12' })
  })

  it("follows the pull request's checks and review, and sends them to the session, resuming it when closed", async () => {
    const pr: PullRequestInfo = { number: 7, state: 'open', url: 'https://github.com/o/r/pull/7' }
    let detail = prDetail({ checks: [{ name: 'test', state: 'running', url: null }] })
    const s = await setup({ pullRequests: () => pr, detail: () => detail })
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    await s.launches.check(s.docs, s.map)
    expect((await s.ws.maps.get(s.map)).launches[0]?.health).toEqual({ checks: 'running', failing: [], review: 'none', unresolved: 0 })

    detail = prDetail({
      checks: [{ name: 'test', state: 'failed', url: 'https://ci/1' }, { name: 'lint', state: 'passed', url: null }],
      comments: [
        { id: 'r1', kind: 'review', author: 'ana', body: 'Please keep the old cookie name.', url: 'u', createdAt: '2026-11-20T01:00:00Z', path: null, line: null, side: null, hunk: null, resolved: false, outdated: false, replies: [], verdict: 'changes requested' },
        { id: 't1', kind: 'thread', author: 'ana', body: 'Why 7?', url: 'u', createdAt: '2026-11-20T01:00:00Z', path: 'app.ts', line: 1, side: 'new', hunk: '+export const days = 7', resolved: false, outdated: false, replies: [], verdict: null },
        { id: 't2', kind: 'thread', author: 'ana', body: 'Done already', url: 'u', createdAt: '2026-11-20T01:00:00Z', path: 'app.ts', line: 1, side: 'new', hunk: null, resolved: true, outdated: false, replies: [], verdict: null }
      ]
    })
    await s.launches.check(s.docs, s.map)
    expect((await s.ws.maps.get(s.map)).launches[0]?.health).toEqual({ checks: 'failed', failing: ['test'], review: 'changes-requested', unresolved: 1 })

    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    expect(await s.launches.sendFeedback(s.docs, s.map, started.launch.id, 'checks', { cols: 100, rows: 30 })).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(s.output(id)).toContain('Checks failed on your pull request #7'), slow)

    /** Exited with its tab open: resumed in that same tab. */
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    s.terminals.write(id, 'exit\r')
    await vi.waitFor(() => expect(s.state(id)).toBe('exited'), slow)
    const before = s.output(id).length
    expect(await s.launches.sendFeedback(s.docs, s.map, started.launch.id, 'review', { cols: 100, rows: 30 })).toMatchObject({ ok: true, message: expect.stringContaining('Resumed') })
    await vi.waitFor(() => expect(s.output(id).slice(before)).toContain('Review feedback on your pull request'), slow)
    expect(s.output(id).slice(before)).toContain('(resumed)')

    /** Closed: resumed in a new tab. */
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    await s.terminals.close(id)
    expect(await s.launches.sendFeedback(s.docs, s.map, started.launch.id, 'review', { cols: 100, rows: 30 })).toMatchObject({ ok: true, message: expect.stringContaining('Resumed') })
    const reopened = (await s.ws.maps.get(s.map)).launches[0]?.sessions[0]?.terminal ?? ''
    expect(reopened).not.toBe(id)
    await vi.waitFor(() => expect(s.output(reopened)).toContain('Review feedback on your pull request'), slow)
    expect(await s.ws.maps.journal(s.map, started.launch.id)).toContain('sent the review feedback of PR #7')

    detail = prDetail()
    expect(await s.launches.sendFeedback(s.docs, s.map, started.launch.id, 'checks', { cols: 100, rows: 30 })).toEqual({ ok: false, message: 'No checks are failing now' })
  })

  it('tells a running session what moved in its scope, and unblocks its ticket when the user answers', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    s.terminals.write(id, `tool set_ticket_status {"ticket":"${s.first}","status":"blocked","reason":"Which cookie?"}\r`)
    await vi.waitFor(() => expect(s.output(id)).toContain('is now blocked'), slow)
    expect(s.output(id)).not.toContain('Context:')

    await s.ws.maps.editTracker(s.map, { kind: 'update-ticket', ticket: s.first, description: 'Make them 3 days.' })
    await writeFile(path.join(s.docs, 'auth.md'), '# Auth\n\n## Sessions\n\nSessions last 3 days.\n')
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    s.terminals.write(id, 'keep the old one\r')
    await vi.waitFor(() => expect(s.output(id)).toContain('Context: From the Manta context map:'), slow)
    const context = s.output(id).slice(s.output(id).indexOf('Context:'))
    expect(context).toContain('set “Shorter sessions” back to in progress')
    expect(context).toContain('“Shorter sessions” was edited since you last looked')
    expect(context).toContain('`auth.md` changed since you last looked')
    expect((await s.ws.maps.get(s.map)).milestones[0]?.tickets[0]?.status).toBe('in-progress')

    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    const before = s.output(id).length
    s.terminals.write(id, 'thanks\r')
    await vi.waitFor(() => expect(s.output(id).slice(before)).toContain('Scripted reply to: thanks'), slow)
    expect(s.output(id).slice(before)).not.toContain('Context:')
  })

  it('runs the landing pass once the branch lands, even after a wrap-up, and keeps the session’s account', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    s.terminals.write(id, 'tool wrap_up {"summary":"Shortened sessions.","went_to_plan":true,"finished":true}\r')
    await vi.waitFor(() => expect(s.output(id)).toContain('Wrap-up recorded'), slow)

    const worktree = started.launch.worktree
    await writeFile(path.join(worktree, 'app.ts'), 'export const days = 7\n')
    git(worktree, 'commit', '-am', `Shorter sessions\n\nManta-Launch: ${started.launch.id}`)
    git(s.code, 'merge', '--squash', 'manta/shorter-sessions')
    git(s.code, 'commit', '-m', `Shorter sessions\n\nManta-Launch: ${started.launch.id}`)
    await s.launches.check(s.docs, s.map)

    await vi.waitFor(async () => expect((await s.ws.maps.get(s.map)).launches[0]?.landingSweptAt).toEqual(expect.any(String)), slow)
    expect(s.sweepAgent.turns).toHaveLength(1)
    expect(s.sweepAgent.turns[0]?.prompt).toContain('has landed on the default branch')
    expect(s.sweepAgent.turns[0]?.prompt).toContain('Its session already wrapped up; do not set statuses.')
    expect(s.sweepAgent.turns[0]?.prompt).toContain('app.ts')
    expect((await s.ws.maps.get(s.map)).launches[0]?.wrapUp?.summary).toBe('Shortened sessions.')

    await s.launches.check(s.docs, s.map)
    await s.launches.maybeLandingPass(s.docs, s.map, started.launch.id)
    expect(s.sweepAgent.turns).toHaveLength(1)
  })

  it('proposes plan changes from a session, dropping ones that name nothing, and the user approves them one by one', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    const changes = [
      { kind: 'update-ticket', ticket: s.second, title: 'Remember me, 30 days', after: [s.first] },
      { kind: 'add-ticket', milestone: s.milestone, title: 'Expire old sessions', description: 'Sweep the table.', acceptance: ['Old rows go'] },
      { kind: 'remove-ticket', ticket: 'tk_gone' }
    ]
    s.terminals.write(id, `tool propose_plan_change ${JSON.stringify({ why: 'Found during the work', changes })}\r`)
    await vi.waitFor(() => expect(s.output(id)).toContain('Proposed 2 changes'), slow)
    expect(s.output(id)).toContain('change 3: no ticket tk_gone')

    const suggestion = (await s.ws.maps.get(s.map)).suggestions[0]
    if (suggestion?.kind !== 'plan-change') throw new Error('no plan change')
    expect(suggestion.from).toEqual({ launch: started.launch.id })
    expect(await s.ws.maps.resolveSuggestion(s.map, suggestion.id, true, [1])).toMatchObject({ ok: true, message: 'Applied 1 change' })
    const tickets = (await s.ws.maps.get(s.map)).milestones[0]?.tickets ?? []
    expect(tickets.map((t) => t.title)).toEqual(['Shorter sessions', 'Remember me', 'Expire old sessions'])
    expect(tickets[2]?.acceptance).toEqual(['Old rows go'])
  })

  it('raises decisions from a session, records one decided with the user, and sends the outcome to the session once the user decides', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    const tool = async (args: Record<string, unknown>, expected: string): Promise<void> => {
      s.terminals.write(id, `tool propose_decision ${JSON.stringify(args)}\r`)
      await vi.waitFor(() => expect(s.output(id)).toContain(expected), slow)
      await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    }

    await tool({ title: 'Cookie name', question: 'Keep it?', blocks: ['tk_gone'] }, 'Tool error: No ticket tk_gone; map_outline lists the ids')
    await tool(
      {
        title: 'Cookie name',
        question: 'Keep it or rename it?',
        options: [{ title: 'Keep sid', detail: 'No migration', recommended: true }, { title: 'Rename it' }],
        requires: 'Cookie name',
        docs: [{ path: 'docs/auth.md', heading: 'Cookies' }],
        blocks: [s.second]
      },
      'Tool: Added decision 001 “Cookie name”, blocking “Remember me”. The user decides it'
    )
    await tool({ title: 'cookie name', question: 'Again?' }, 'Tool: Decision 001 “Cookie name” is already open')
    await tool({ title: 'Session length', question: 'How long?', outcome: '7 days, as the docs say', confirmed_with_user: true }, 'Tool: Recorded decision 002 “Session length” as decided.')

    let detail = await s.ws.maps.get(s.map)
    expect(detail.decisions).toMatchObject([
      {
        number: 1,
        status: 'open',
        blocks: [s.second],
        from: { launch: started.launch.id },
        options: [
          { title: 'Keep sid', detail: 'No migration', recommended: true },
          { title: 'Rename it', detail: '', recommended: false }
        ],
        input: { label: 'Cookie name', value: '' },
        docs: [{ path: 'docs/auth.md', heading: 'Cookies' }]
      },
      { number: 2, status: 'decided', outcome: '7 days, as the docs say', from: { launch: started.launch.id } }
    ])
    const raised = detail.decisions[0]
    if (!raised) throw new Error('no decision')
    expect(await s.launches.editTracker(s.docs, s.map, { kind: 'update-decision', decision: raised.id, status: 'decided', outcome: 'Keep the old name.' })).toEqual({ ok: false, message: 'Fill in Cookie name first' })
    expect(await s.launches.editTracker(s.docs, s.map, { kind: 'update-decision', decision: raised.id, status: 'decided', chosen: 0, input: { label: 'Cookie name', value: 'sid' }, outcome: 'Keep the old name.' })).toEqual({
      ok: true,
      message: 'Decided; sent to the session that raised it'
    })
    await vi.waitFor(() => expect(s.output(id)).toContain('Scripted reply to: The user decided decision 001 “Cookie name”, which you raised:'), slow)
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    const journal = await s.ws.maps.journal(s.map, started.launch.id)
    expect(journal).toContain('**note**: Added decision 001 “Cookie name” for the user, blocking “Remember me”.')
    expect(journal).toContain('**decision**: Recorded decision 002 “Session length”, with the user: 7 days, as the docs say')
    expect(journal).toContain('Manta sent the outcome of decision 001 to the session.')

    await s.ws.maps.update(s.map, { confirmProposals: 'queue' })
    await tool({ title: 'Domain', question: 'Which?', outcome: 'omni.app', confirmed_with_user: true }, "The outcome was left out: this map doesn't take decisions from sessions.")
    detail = await s.ws.maps.get(s.map)
    expect(detail.decisions[2]).toMatchObject({ number: 3, status: 'open', outcome: '' })
    expect(await s.launches.editTracker(s.docs, s.map, { kind: 'update-decision', decision: detail.decisions[1]?.id ?? '', title: 'Session lifetime' })).toEqual({ ok: true, message: 'Saved' })
  })

  it('applies a ticket and plan changes the user accepted in the session, journals them, and queues docs to write and maps that queue', async () => {
    const s = await setup()
    const started = await s.launches.launch(s.request())
    if (!started.ok) throw new Error(started.message)
    const id = started.terminal.id
    await vi.waitFor(() => expect(s.state(id)).toBe('idle'), slow)
    const ticket = { milestone: s.milestone, title: 'Audit log', description: 'Log sign-ins.', acceptance: ['Rows appear'], why: 'Found it', confirmed_with_user: true }
    s.terminals.write(id, `tool suggest_ticket ${JSON.stringify(ticket)}\r`)
    await vi.waitFor(() => expect(s.output(id)).toContain('Applied:'), slow)
    const change = { why: 'Clearer', confirmed_with_user: true, changes: [{ kind: 'update-ticket', ticket: s.second, title: 'Remember me, 30 days' }] }
    s.terminals.write(id, `tool propose_plan_change ${JSON.stringify(change)}\r`)
    await vi.waitFor(() => expect(s.output(id)).toContain('Applied: Applied 1 change'), slow)
    s.terminals.write(id, `tool suggest_doc_to_write ${JSON.stringify({ title: 'Sessions', why: 'Undocumented', confirmed_with_user: true })}\r`)
    await vi.waitFor(() => expect(s.output(id)).toContain('Docs to write always wait'), slow)

    let detail = await s.ws.maps.get(s.map)
    expect(detail.milestones[0]?.tickets.map((t) => t.title)).toEqual(['Shorter sessions', 'Remember me, 30 days', 'Audit log'])
    expect(detail.suggestions.map((x) => x.kind)).toEqual(['write-doc'])
    expect(await s.ws.maps.journal(s.map, started.launch.id)).toContain('as the user agreed in the session')

    await s.ws.maps.update(s.map, { confirmProposals: 'queue' })
    s.terminals.write(id, `tool suggest_ticket ${JSON.stringify({ ...ticket, title: 'Rate limit' })}\r`)
    await vi.waitFor(() => expect(s.output(id)).toContain("doesn't apply proposals from sessions"), slow)
    detail = await s.ws.maps.get(s.map)
    expect(detail.suggestions.map((x) => x.kind)).toEqual(['write-doc', 'ticket'])
  })
})
