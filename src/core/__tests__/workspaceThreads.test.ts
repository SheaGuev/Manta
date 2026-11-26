import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { ThreadEvent } from '../../shared/ipc'
import { ScriptedAgent, type AgentTurn, type ThreadAgent, type ThreadTurnContext } from '../agent/threadAgent'
import { sectionAt, ThreadIndex, type ThreadInfo } from '../threads/threads'
import { Workspace } from '../workspace'

const dirs: string[] = []
const workspaces: Workspace[] = []

afterEach(async () => {
  for (const ws of workspaces.splice(0)) ws.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
  })
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manta-threads-'))
  dirs.push(dir)
  return dir
}

async function clone(origin: string): Promise<string> {
  const dir = await tempDir()
  git(dir, 'clone', origin, '.')
  git(dir, 'config', 'user.name', 't')
  git(dir, 'config', 'user.email', 't@t')
  return dir
}

/** Stands in for how `.manta/` will travel between machines (its own ref, later a cloud store): git no longer carries it. */
async function syncMantaDir(from: string, to: string): Promise<void> {
  await cp(path.join(from, '.manta'), path.join(to, '.manta'), { recursive: true })
}

/** A bare "origin" seeded with `files`, plus clones `app` (opened in Manta) and `other` (a teammate). */
async function setup(files: Record<string, string>): Promise<{ origin: string; app: string; other: string }> {
  const origin = await tempDir()
  git(origin, 'init', '--bare', '-b', 'main')
  const seed = await tempDir()
  git(seed, 'init', '-b', 'main')
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(seed, name), text)
  git(seed, 'add', '-A')
  git(seed, 'commit', '-m', 'seed')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-u', 'origin', 'main')
  return { origin, app: await clone(origin), other: await clone(origin) }
}

const replicas = new WeakMap<Workspace, Map<string, Y.Doc>>()

async function openWorkspace(dir: string): Promise<Workspace> {
  const open = new Map<string, Y.Doc>()
  const ws = await Workspace.open(dir, (relPath, update) => {
    const replica = open.get(relPath)
    if (replica) Y.applyUpdate(replica, update, 'main')
  })
  replicas.set(ws, open)
  workspaces.push(ws)
  return ws
}

/** An editor replica wired to the workspace both ways, the way the renderer is. */
async function openReplica(ws: Workspace, relPath: string): Promise<Y.Text> {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, await ws.openDoc(relPath), 'main')
  replicas.get(ws)?.set(relPath, doc)
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'main') ws.applyEditorUpdate(relPath, update)
  })
  return doc.getText('md')
}

async function threadSection(ws: Workspace, root: string, relPath: string, id: string): Promise<string | null> {
  const thread = (await ws.threads.list(relPath)).find((t) => t.id === id)
  if (!thread?.range) return null
  const text = await readFile(path.join(root, relPath), 'utf8')
  return text.slice(thread.range.from, thread.range.to)
}

async function startThread(ws: Workspace, root: string, relPath: string, at: string, title: string): Promise<ThreadInfo> {
  const text = await readFile(path.join(root, relPath), 'utf8')
  return ws.threads.create(relPath, sectionAt(text, text.indexOf(at)), title)
}

const AUTH = '# Auth\n\nWe use magic links for login.\n\n## Sessions\n\nSessions last 30 days.\n\n## Open questions\n\nNone yet.\n'
const BILLING = '# Billing\n\n## Plans\n\nFree and Pro.\n\n## Open questions\n\nNone yet.\n'

describe('Workspace threads', () => {
  it('creates a thread anchored to a section and writes its record', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)

    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    expect(thread).toMatchObject({ doc: 'auth.md', title: 'Session length', status: 'open', parent: null })
    expect(thread.id).toMatch(/^t_[0-9a-f]{10}$/)
    expect(await threadSection(ws, app, 'auth.md', thread.id)).toBe('## Sessions\n\nSessions last 30 days.')
    const record = JSON.parse(await readFile(path.join(app, '.manta/threads', `${thread.id}.json`), 'utf8'))
    expect(record).toMatchObject({ version: 1, id: thread.id, doc: 'auth.md', status: 'open' })
    expect(record.anchor.quote.exact).toBe('## Sessions\n\nSessions last 30 days.')
  })

  it('keeps the anchor through in-app edits, an outside edit and a pull', async () => {
    const { app, other } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    const text = await openReplica(ws, 'auth.md')

    text.insert(text.toString().indexOf('30'), 'about ')
    text.insert(0, '> Draft\n\n')
    await ws.idle()
    expect(await threadSection(ws, app, 'auth.md', thread.id)).toBe('## Sessions\n\nSessions last about 30 days.')

    const disk = await readFile(path.join(app, 'auth.md'), 'utf8')
    await writeFile(path.join(app, 'auth.md'), disk.replace('days.', 'days, then refresh.'))
    await ws.fileChanged('auth.md')
    await ws.idle()
    expect(await threadSection(ws, app, 'auth.md', thread.id)).toBe('## Sessions\n\nSessions last about 30 days, then refresh.')

    await writeFile(path.join(other, 'auth.md'), AUTH.replace('# Auth\n', '# Authentication\n\n> Owner: platform\n').replace('Sessions last', 'Web sessions last'))
    git(other, 'commit', '-am', 'teammate edit')
    git(other, 'push')
    expect(await ws.pull()).toMatchObject({ ok: true })
    await ws.idle()

    expect(await threadSection(ws, app, 'auth.md', thread.id)).toBe('## Sessions\n\nWeb sessions last about 30 days, then refresh.')
  })

  it('moves a thread to detached when its section is deleted, and keeps it listed', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    const text = await openReplica(ws, 'auth.md')

    const from = text.toString().indexOf('## Sessions')
    text.delete(from, text.toString().indexOf('## Open') - from)
    await ws.idle()

    expect(await ws.threads.list('auth.md')).toEqual([expect.objectContaining({ id: thread.id, range: null })])
  })

  it('lets a clone with no .git/manta/ re-find every thread from .manta/threads/, once the records reach it', async () => {
    const { origin, app } = await setup({ 'auth.md': AUTH, 'billing.md': BILLING })
    const ws = await openWorkspace(app)
    const sessions = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    const authQuestions = await startThread(ws, app, 'auth.md', 'None yet', 'Auth questions')
    const billingQuestions = await startThread(ws, app, 'billing.md', 'None yet', 'Billing questions')
    await ws.threads.setStatus('auth.md', sessions.id, 'approved')
    const text = await openReplica(ws, 'auth.md')
    text.insert(text.toString().indexOf('30'), 'about ')
    expect((await ws.commit('docs: threads'))).toMatchObject({ ok: true })
    git(app, 'push')

    const fresh = await clone(origin)
    expect(await readdir(path.join(fresh, '.git'))).not.toContain('manta')
    expect(await readdir(fresh)).not.toContain('.manta')
    await syncMantaDir(app, fresh)
    const freshWs = await openWorkspace(fresh)

    expect(await threadSection(freshWs, fresh, 'auth.md', sessions.id)).toBe('## Sessions\n\nSessions last about 30 days.')
    expect(await threadSection(freshWs, fresh, 'auth.md', authQuestions.id)).toBe('## Open questions\n\nNone yet.')
    expect(await threadSection(freshWs, fresh, 'billing.md', billingQuestions.id)).toBe('## Open questions\n\nNone yet.')
    expect((await freshWs.threads.list('auth.md')).find((t) => t.id === sessions.id)).toMatchObject({ status: 'approved', title: 'Session length' })
    expect(git(fresh, 'status', '--porcelain')).toBe('')

    const freshText = await openReplica(freshWs, 'auth.md')
    freshText.insert(freshText.toString().indexOf('Sessions last'), 'Web ')
    await freshWs.idle()
    expect(await threadSection(freshWs, fresh, 'auth.md', sessions.id)).toBe('## Sessions\n\nWeb Sessions last about 30 days.')
  })

  it('refreshes committed quotes on commit, without rewriting records whose text is unchanged', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const sessions = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    const questions = await startThread(ws, app, 'auth.md', 'None yet', 'Questions')
    await ws.commit('docs: start threads')
    const recordFile = (id: string): string => path.join(app, '.manta/threads', `${id}.json`)
    const questionsBefore = await readFile(recordFile(questions.id), 'utf8')

    const text = await openReplica(ws, 'auth.md')
    text.insert(text.toString().indexOf('30'), 'about ')
    await ws.commit('docs: edit sessions')

    expect(JSON.parse(await readFile(recordFile(sessions.id), 'utf8')).anchor.quote.exact).toBe('## Sessions\n\nSessions last about 30 days.')
    expect(await readFile(recordFile(questions.id), 'utf8')).toBe(questionsBefore)
    expect(git(app, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(['auth.md'])
    expect(git(app, 'ls-files', '.manta')).toBe('')
  })

  it("picks up a teammate's thread when its record arrives alongside a pull", async () => {
    const { app, other } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    await openReplica(ws, 'auth.md')
    const teammate = await openWorkspace(other)
    const thread = await startThread(teammate, other, 'auth.md', 'None yet', 'Questions')
    const theirs = await openReplica(teammate, 'auth.md')
    theirs.insert(theirs.toString().indexOf('magic'), 'passwordless ')
    expect(await teammate.commit('docs: passwordless')).toMatchObject({ ok: true })
    git(other, 'push')
    await syncMantaDir(other, app)

    expect(await ws.pull()).toMatchObject({ ok: true })

    expect(await threadSection(ws, app, 'auth.md', thread.id)).toBe('## Open questions\n\nNone yet.')
  })

  it('keeps a discarded thread listed, anchored and recorded', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    expect(await ws.threads.setStatus('auth.md', thread.id, 'discarded')).toMatchObject({ status: 'discarded' })

    expect(await threadSection(ws, app, 'auth.md', thread.id)).toBe('## Sessions\n\nSessions last 30 days.')
    const record = JSON.parse(await readFile(path.join(app, '.manta/threads', `${thread.id}.json`), 'utf8'))
    expect(record.status).toBe('discarded')
  })

  it('skips an unreadable record instead of failing to open the repo', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    ws.close()
    await writeFile(path.join(app, '.manta/threads/t_broken.json'), '{ not json')

    const reopened = await openWorkspace(app)
    expect((await reopened.threads.list('auth.md')).map((t) => t.id)).toEqual([thread.id])
  })
})

describe('Workspace thread approval', () => {
  it('refuses while the doc has other uncommitted edits, then merges onto them in one commit of that doc', async () => {
    const { app } = await setup({ 'auth.md': AUTH, 'billing.md': BILLING })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    const billing = await openReplica(ws, 'billing.md')
    billing.insert(0, '> WIP\n\n')
    const head = git(app, 'rev-parse', 'HEAD').trim()

    await ws.threads.proposeEdit('auth.md', thread.id, 'Sessions last 30 days.', 'Sessions last 14 days, then refresh.')
    const text = await openReplica(ws, 'auth.md')
    text.insert(text.toString().indexOf('magic'), 'passwordless ')
    await ws.idle()
    const disk = await readFile(path.join(app, 'auth.md'), 'utf8')
    await writeFile(path.join(app, 'auth.md'), disk.replace('None yet.', 'None yet. Ask security.'))

    expect(await ws.threads.approve('auth.md', thread.id)).toMatchObject({ ok: false, message: expect.stringContaining('commit them first') })
    expect(git(app, 'rev-parse', 'HEAD').trim()).toBe(head)
    expect(text.toString()).toBe(AUTH.replace('magic', 'passwordless magic').replace('None yet.', 'None yet. Ask security.'))
    expect(git(app, 'commit', '-qm', 'docs: other edits', '--', 'auth.md')).toBe('')
    const afterOtherEdits = git(app, 'rev-parse', 'HEAD').trim()

    expect(await ws.threads.approve('auth.md', thread.id)).toMatchObject({ ok: true })
    await ws.idle()

    const merged = AUTH.replace('magic', 'passwordless magic')
      .replace('Sessions last 30 days.', 'Sessions last 14 days, then refresh.')
      .replace('None yet.', 'None yet. Ask security.')
    expect(text.toString()).toBe(merged)
    expect(git(app, 'show', 'HEAD:auth.md')).toBe(merged)
    expect(git(app, 'rev-list', '--count', `${afterOtherEdits}..HEAD`).trim()).toBe('1')
    expect(git(app, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(['auth.md'])
    expect(git(app, 'log', '-1', '--format=%(trailers:key=Manta-Thread,valueonly)').trim()).toBe(thread.id)
    expect(git(app, 'log', '-1', '--format=%s')).toBe('docs(auth.md): Session length\n')
    expect(git(app, 'status', '--porcelain', '--', 'billing.md').trim()).toBe('M billing.md')
    const [info] = await ws.threads.list('auth.md')
    expect(info).toMatchObject({ status: 'merged' })
    expect(await threadSection(ws, app, 'auth.md', thread.id)).toBe('## Sessions\n\nSessions last 14 days, then refresh.')
    expect(JSON.parse(await readFile(path.join(app, '.manta/threads', `${thread.id}.json`), 'utf8')).status).toBe('merged')
  })

  it('records what approving changed, finds the commit it landed in, and hides it on request', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await ws.threads.proposeEdit('auth.md', thread.id, '30 days.', '14 days, then refresh.')
    expect(await ws.threads.landed('auth.md', thread.id)).toBeNull()

    await ws.threads.approve('auth.md', thread.id)

    const replica = new Y.Doc()
    Y.applyUpdate(replica, await ws.openDoc('auth.md'))
    const index = new ThreadIndex(replica)
    const text = index.text.toString()
    expect(index.landed(thread.id).map(({ from, to, removed }) => [text.slice(from, to), removed])).toEqual([
      ['14', '30'],
      [', then refresh', '']
    ])
    expect(await ws.threads.landed('auth.md', thread.id)).toEqual({
      commit: git(app, 'rev-parse', 'HEAD').trim(),
      before: AUTH,
      after: AUTH.replace('30 days.', '14 days, then refresh.')
    })

    expect(await ws.threads.get('auth.md', thread.id)).toMatchObject({ highlighted: true })

    await ws.threads.dismissLanded('auth.md', thread.id)
    const after = new Y.Doc()
    Y.applyUpdate(after, await ws.openDoc('auth.md'))
    expect(new ThreadIndex(after).landed(thread.id)).toEqual([])
    expect(await ws.threads.get('auth.md', thread.id)).toMatchObject({ status: 'merged', highlighted: false })
  })

  it('keeps what approving changed across a restart', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const first = await openWorkspace(app)
    const thread = await startThread(first, app, 'auth.md', 'last 30', 'Session length')
    await first.threads.proposeEdit('auth.md', thread.id, '30 days.', '14 days.')
    await first.threads.approve('auth.md', thread.id)
    await first.idle()
    first.close()

    const second = await openWorkspace(app)
    const replica = new Y.Doc()
    Y.applyUpdate(replica, await second.openDoc('auth.md'))
    const index = new ThreadIndex(replica)
    expect(index.landed(thread.id).map(({ from, to, removed }) => [index.text.toString().slice(from, to), removed])).toEqual([['14', '30']])
  })

  it('leaves staged changes to other files staged and out of the commit', async () => {
    const { app } = await setup({ 'auth.md': AUTH, 'billing.md': BILLING })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await writeFile(path.join(app, 'billing.md'), `${BILLING}Staged.\n`)
    git(app, 'add', 'billing.md')

    await ws.threads.proposeEdit('auth.md', thread.id, '30 days', '14 days')
    expect(await ws.threads.approve('auth.md', thread.id, 'docs: shorter sessions')).toMatchObject({ ok: true })

    expect(git(app, 'show', '--name-only', '--format=', 'HEAD')).not.toContain('billing.md')
    expect(git(app, 'log', '-1', '--format=%B')).toBe(`docs: shorter sessions\n\nManta-Thread: ${thread.id}\n\n`)
    expect(git(app, 'diff', '--cached', '--name-only').trim()).toBe('billing.md')
  })

  it('previews the merge against the current doc without changing it', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await ws.threads.proposeEdit('auth.md', thread.id, '30 days', '14 days')
    const text = await openReplica(ws, 'auth.md')
    text.insert(0, '> Draft\n\n')
    await ws.idle()

    const proposal = await ws.threads.proposal('auth.md', thread.id)

    expect(proposal).toEqual({
      base: AUTH,
      proposed: AUTH.replace('30 days', '14 days'),
      current: `> Draft\n\n${AUTH}`,
      merged: `> Draft\n\n${AUTH.replace('30 days', '14 days')}`
    })
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(`> Draft\n\n${AUTH}`)
  })

  it('refuses to approve with no change, twice, or to edit a thread that is not open', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    const head = git(app, 'rev-parse', 'HEAD')

    expect(await ws.threads.approve('auth.md', thread.id)).toMatchObject({ ok: false, message: expect.stringContaining('no proposed change') })
    expect(git(app, 'rev-parse', 'HEAD')).toBe(head)

    await ws.threads.proposeEdit('auth.md', thread.id, '30 days', '14 days')
    await ws.threads.approve('auth.md', thread.id)
    expect(await ws.threads.approve('auth.md', thread.id)).toMatchObject({ ok: false, message: 'Thread is already merged' })
    await expect(ws.threads.proposeEdit('auth.md', thread.id, '14 days', '7 days')).rejects.toThrow('only open threads')

    const discarded = await startThread(ws, app, 'auth.md', 'None yet', 'Questions')
    await ws.threads.setStatus('auth.md', discarded.id, 'discarded')
    await expect(ws.threads.proposeEdit('auth.md', discarded.id, 'None yet.', 'Some.')).rejects.toThrow('discarded')
  })

  it('keeps the proposed edit across a restart', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const first = await openWorkspace(app)
    const thread = await startThread(first, app, 'auth.md', 'last 30', 'Session length')
    await first.threads.proposeEdit('auth.md', thread.id, '30 days', '14 days')
    first.close()

    const second = await openWorkspace(app)

    expect(await second.threads.proposal('auth.md', thread.id)).toMatchObject({ base: AUTH, proposed: AUTH.replace('30 days', '14 days') })
    expect(await second.threads.approve('auth.md', thread.id)).toMatchObject({ ok: true })
    expect(git(app, 'show', 'HEAD:auth.md')).toBe(AUTH.replace('30 days', '14 days'))
  })

  it('starts a fresh fork from the current doc in a clone that has no fork state', async () => {
    const { origin, app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await ws.threads.proposeEdit('auth.md', thread.id, '30 days', '14 days')
    await ws.commit('docs: start thread')
    git(app, 'push')

    const fresh = await clone(origin)
    await syncMantaDir(app, fresh)
    const freshWs = await openWorkspace(fresh)

    expect(await freshWs.threads.proposal('auth.md', thread.id)).toEqual({ base: AUTH, proposed: AUTH, current: AUTH, merged: AUTH })
    await freshWs.threads.proposeEdit('auth.md', thread.id, '30 days', '7 days')
    expect(await freshWs.threads.approve('auth.md', thread.id)).toMatchObject({ ok: true })
    expect(git(fresh, 'show', 'HEAD:auth.md')).toBe(AUTH.replace('30 days', '7 days'))
  })
})

describe('Workspace thread agent turns', () => {
  async function agentWorkspace(dir: string, agent: ScriptedAgent): Promise<{ ws: Workspace; events: string[] }> {
    const threadsDir = await tempDir()
    const events: string[] = []
    const ws = await Workspace.open(dir, () => {}, {
      threadsDir,
      agent,
      onThreadEvent: (_relPath, _id, event) => events.push(event.type)
    })
    workspaces.push(ws)
    return { ws, events }
  }

  it('drives a thread end to end: message, agent edit, proposal, approve, commit', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent = new ScriptedAgent(() => [
      { text: 'Shorter sessions are safer. ' },
      { edit: { find: 'Sessions last 30 days.', replace: 'Sessions last 14 days, then refresh.' } },
      { text: 'I proposed 14 days.' }
    ])
    const { ws, events } = await agentWorkspace(app, agent)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    expect(await ws.threads.send('auth.md', thread.id, 'How long should sessions last?')).toEqual({ ok: true, message: 'Done' })

    const [first] = agent.turns
    expect(first).toMatchObject({ prompt: 'How long should sessions last?', session: null, context: { title: 'Session length', section: '## Sessions\n\nSessions last 30 days.' } })
    expect(path.dirname(first?.file ?? '')).toBe(first?.cwd)
    expect(events).toEqual(['turn-start', 'text', 'tool', 'proposal-changed', 'text', 'turn-end'])
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(AUTH)
    expect((await ws.threads.proposal('auth.md', thread.id)).proposed).toBe(AUTH.replace('Sessions last 30 days.', 'Sessions last 14 days, then refresh.'))
    expect((await ws.threads.transcript(thread.id)).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'How long should sessions last?' },
      { role: 'assistant', text: 'Shorter sessions are safer. ' },
      { role: 'tool', text: 'Edit auth.md' },
      { role: 'assistant', text: 'I proposed 14 days.' }
    ])

    await ws.commit('docs: thread transcript')
    expect(await ws.threads.approve('auth.md', thread.id)).toMatchObject({ ok: true })
    expect(git(app, 'show', 'HEAD:auth.md')).toBe(AUTH.replace('Sessions last 30 days.', 'Sessions last 14 days, then refresh.'))
    expect(JSON.parse(await readFile(path.join(app, '.manta/threads', `${thread.id}.json`), 'utf8')).messages).toHaveLength(4)
  })

  it("gives a subthread's agent its parent's conversation, refreshed every turn", async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent = new ScriptedAgent((turn) => [{ text: `Reply to: ${turn.prompt}` }])
    const { ws } = await agentWorkspace(app, agent)
    const parent = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await ws.threads.send('auth.md', parent.id, 'Is 30 days too long?')
    const sub = await ws.threads.createSubthread('auth.md', parent.id, 'Refresh rules')

    await ws.threads.send('auth.md', sub.id, 'When do we refresh?')

    const [top, first] = agent.turns
    expect(threadContext(top)?.parents).toBeNull()
    expect(threadContext(first)?.parents?.titles).toEqual(['Session length'])
    const file = threadContext(first)?.parents?.file ?? ''
    expect(path.dirname(path.dirname(file))).toBe(first?.cwd)
    const context = await readFile(file, 'utf8')
    expect(context).toContain('## Parent thread: "Session length" (open)')
    expect(context).toContain('**User:** Is 30 days too long?')
    expect(context).toContain('**Agent:** Reply to: Is 30 days too long?')
    expect(context).not.toContain('When do we refresh?')

    await ws.threads.send('auth.md', parent.id, 'Make it 14 days.')
    await ws.threads.send('auth.md', sub.id, 'And now?')

    expect(await readFile(file, 'utf8')).toContain('**User:** Make it 14 days.')
    expect((await ws.threads.proposal('auth.md', sub.id)).proposed).toBe(AUTH)
  })

  it("asks the user through a permission event and continues with the answer", async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent = new ScriptedAgent(() => [{ ask: { tool: 'Bash', summary: 'curl https://example.com' } }, { text: 'after' }])
    const threadsDir = await tempDir()
    let workspace: Workspace | null = null
    const events: ThreadEvent[] = []
    const ws = await Workspace.open(app, () => {}, {
      threadsDir,
      agent,
      onThreadEvent: (_relPath, threadId, event) => {
        events.push(event)
        if (event.type === 'permission') workspace?.threads.answerPermission(threadId, event.id, 'allow')
      }
    })
    workspace = ws
    workspaces.push(ws)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    await ws.threads.send('auth.md', thread.id, 'Fetch it')

    expect(events.map((e) => e.type)).toEqual(['turn-start', 'permission', 'permission-resolved', 'text', 'text', 'turn-end'])
    expect(events.find((e) => e.type === 'permission')).toMatchObject({ tool: 'Bash', summary: 'curl https://example.com', title: null })
    expect(agent.turns[0]?.context.repoRoot).toBe(app)
    const transcript = (await ws.threads.transcript(thread.id)).map((m) => `${m.role}: ${m.text}`)
    expect(transcript).toContain('status: Allowed: Bash curl https://example.com')
    expect(transcript).toContain('assistant: Permission for Bash: allow. after')
    expect(ws.threads.answerPermission(thread.id, 'stale', 'allow')).toBe(false)
  })

  it('denies a pending permission request when the turn is cancelled', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent = new ScriptedAgent(() => [{ ask: { tool: 'mcp__slack__send_message', summary: '' } }])
    const threadsDir = await tempDir()
    const events: ThreadEvent[] = []
    const ws = await Workspace.open(app, () => {}, { threadsDir, agent, onThreadEvent: (_r, _id, event) => events.push(event) })
    workspaces.push(ws)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    const running = ws.threads.send('auth.md', thread.id, 'Post it')
    await vi.waitFor(() => expect(events.some((e) => e.type === 'permission')).toBe(true))
    ws.threads.cancel(thread.id)

    expect(await running).toEqual({ ok: true, message: 'Cancelled' })
    expect(events.find((e) => e.type === 'permission-resolved')).toMatchObject({ decision: 'deny' })
  })

  it('shortens tool paths inside the thread folder, including its resolved path', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent: ThreadAgent = {
      async *run(turn) {
        yield { type: 'tool', name: 'Read', summary: path.join(await realpath(turn.cwd), 'auth.md') }
        yield { type: 'tool', name: 'Read', summary: '/etc/hosts' }
      }
    }
    const threadsDir = await tempDir()
    const ws = await Workspace.open(app, () => {}, { threadsDir, agent })
    workspaces.push(ws)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    await ws.threads.send('auth.md', thread.id, 'Read it')

    expect((await ws.threads.transcript(thread.id)).filter((m) => m.role === 'tool').map((m) => m.text)).toEqual(['Read auth.md', 'Read /etc/hosts'])
  })

  it('resumes the same session on the next turn and builds on the earlier proposal', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    let turnNumber = 0
    const agent = new ScriptedAgent(() =>
      ++turnNumber === 1
        ? [{ edit: { find: '30 days', replace: '14 days' } }]
        : [{ edit: { find: 'None yet.', replace: 'Should refresh be silent?' } }]
    )
    const { ws } = await agentWorkspace(app, agent)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    await ws.threads.send('auth.md', thread.id, 'Shorten it')
    await ws.threads.send('auth.md', thread.id, 'Any open questions?')

    expect(agent.turns.map((t) => t.session)).toEqual([null, 'scripted-1'])
    expect((await ws.threads.proposal('auth.md', thread.id)).proposed).toBe(AUTH.replace('30 days', '14 days').replace('None yet.', 'Should refresh be silent?'))
  })

  it('keeps agent edits and edits to the doc made during the turn', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent = new ScriptedAgent(() => [{ edit: { find: '30 days', replace: '14 days' } }, { text: 'done' }])
    const { ws } = await agentWorkspace(app, agent)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    const text = await openReplica(ws, 'auth.md')

    const turn = ws.threads.send('auth.md', thread.id, 'Shorten it')
    text.insert(text.toString().indexOf('magic'), 'passwordless ')
    await turn
    await ws.idle()
    await ws.commit('docs: passwordless')

    expect(await ws.threads.approve('auth.md', thread.id)).toMatchObject({ ok: true })
    expect(git(app, 'show', 'HEAD:auth.md')).toBe(AUTH.replace('magic', 'passwordless magic').replace('30 days', '14 days'))
  })

  it('cancels a running turn, keeping what the agent already changed', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent = new ScriptedAgent(() => [{ edit: { find: '30 days', replace: '14 days' } }, { waitForCancel: true }, { text: 'never sent' }])
    const { ws, events } = await agentWorkspace(app, agent)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    const turn = ws.threads.send('auth.md', thread.id, 'Shorten it')
    await vi.waitFor(() => expect(events).toContain('proposal-changed'))
    expect(await ws.threads.send('auth.md', thread.id, 'Again')).toMatchObject({ ok: false, message: expect.stringContaining('still answering') })
    expect(ws.threads.cancel(thread.id)).toBe(true)

    expect(await turn).toEqual({ ok: true, message: 'Cancelled' })
    expect(events.at(-1)).toBe('turn-end')
    expect(events).not.toContain('text')
    expect((await ws.threads.transcript(thread.id)).at(-1)).toMatchObject({ role: 'status', text: 'Cancelled' })
    expect((await ws.threads.proposal('auth.md', thread.id)).proposed).toBe(AUTH.replace('30 days', '14 days'))
    expect(ws.threads.cancel(thread.id)).toBe(false)
  })

  it('refuses messages to threads that are not open, and without an agent', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const { ws } = await agentWorkspace(app, new ScriptedAgent(() => []))
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await ws.threads.setStatus('auth.md', thread.id, 'discarded')

    expect(await ws.threads.send('auth.md', thread.id, 'hi')).toMatchObject({ ok: false, message: expect.stringContaining('discarded') })
    const plain = await openWorkspace(app)
    expect(await plain.threads.send('auth.md', thread.id, 'hi')).toMatchObject({ ok: false, message: expect.stringContaining('No agent') })
  })

  it('records an agent error in the transcript and still ends the turn', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent = new ScriptedAgent(() => [{ edit: { find: 'not in the doc', replace: 'x' } }])
    const { ws, events } = await agentWorkspace(app, agent)
    const thread = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')

    await ws.threads.send('auth.md', thread.id, 'Edit something')

    expect(events).toEqual(['turn-start', 'tool', 'error', 'turn-end'])
    expect((await ws.threads.transcript(thread.id)).at(-1)).toMatchObject({ role: 'status', text: expect.stringContaining('Error:') })
  })
})

describe('Workspace.createThreadAt', () => {
  it('anchors to the section around an offset, clamping offsets outside the doc', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)

    const sessions = await ws.threads.createAt('auth.md', AUTH.indexOf('last 30'), 'Session length')
    const last = await ws.threads.createAt('auth.md', 10_000, 'Questions')

    expect(await threadSection(ws, app, 'auth.md', sessions.id)).toBe('## Sessions\n\nSessions last 30 days.')
    expect(await threadSection(ws, app, 'auth.md', last.id)).toBe('## Open questions\n\nNone yet.')
  })
})

describe('Workspace subthreads', () => {
  async function parentWithEdit(app: string): Promise<{ ws: Workspace; parent: ThreadInfo }> {
    const ws = await openWorkspace(app)
    const parent = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await ws.threads.proposeEdit('auth.md', parent.id, '30 days.', '14 days.')
    return { ws, parent }
  }

  it("anchors to the parent's section as the parent proposes it, and stays out of the doc's list", async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const { ws, parent } = await parentWithEdit(app)

    const sub = await ws.threads.createSubthread('auth.md', parent.id, 'Refresh rules')

    expect(sub).toMatchObject({ parent: parent.id, status: 'open', doc: 'auth.md' })
    const proposal = await ws.threads.proposal('auth.md', sub.id)
    expect(proposal.current).toBe(AUTH.replace('30 days.', '14 days.'))
    expect(proposal.current.slice(sub.range?.from, sub.range?.to)).toBe('## Sessions\n\nSessions last 14 days.')
    expect((await ws.threads.list('auth.md')).map((t) => t.id)).toEqual([parent.id])
    expect((await ws.threads.listSubthreads('auth.md', parent.id)).map((t) => t.id)).toEqual([sub.id])
    expect(await ws.threads.get('auth.md', sub.id)).toMatchObject({ id: sub.id, parent: parent.id })
    expect(JSON.parse(await readFile(path.join(app, '.manta/threads', `${sub.id}.json`), 'utf8'))).toMatchObject({ parent: parent.id })
  })

  it("approving a subthread merges into the parent's proposal, not the doc", async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const { ws, parent } = await parentWithEdit(app)
    const sub = await ws.threads.createSubthread('auth.md', parent.id, 'Refresh rules')
    await ws.threads.proposeEdit('auth.md', sub.id, '14 days.', '14 days, then refresh silently.')
    const head = git(app, 'rev-parse', 'HEAD')

    expect(await ws.threads.approve('auth.md', sub.id)).toEqual({ ok: true, message: "Merged into the parent thread's proposal" })

    expect((await ws.threads.proposal('auth.md', parent.id)).proposed).toBe(AUTH.replace('30 days.', '14 days, then refresh silently.'))
    expect(await ws.threads.get('auth.md', sub.id)).toMatchObject({ status: 'approved' })
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(AUTH)
    expect(git(app, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('refuses to approve a parent with open subthreads, then lands both in one commit', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const { ws, parent } = await parentWithEdit(app)
    const sub = await ws.threads.createSubthread('auth.md', parent.id, 'Refresh rules')
    const dropped = await ws.threads.createSubthread('auth.md', parent.id, 'Remember me')
    await ws.threads.setStatus('auth.md', dropped.id, 'discarded')
    await ws.threads.proposeEdit('auth.md', sub.id, '14 days.', '14 days, then refresh.')
    await ws.commit('docs: start threads')

    expect(await ws.threads.approve('auth.md', parent.id)).toMatchObject({ ok: false, message: expect.stringContaining('1 open subthread') })
    await ws.threads.approve('auth.md', sub.id)
    await ws.commit('docs: thread records')
    const head = git(app, 'rev-parse', 'HEAD').trim()
    expect(await ws.threads.approve('auth.md', parent.id)).toMatchObject({ ok: true })

    expect(git(app, 'show', 'HEAD:auth.md')).toBe(AUTH.replace('30 days.', '14 days, then refresh.'))
    expect(git(app, 'rev-list', '--count', `${head}..HEAD`).trim()).toBe('1')
    expect(git(app, 'show', '--name-only', '--format=', 'HEAD').trim()).toBe('auth.md')
    expect(JSON.parse(await readFile(path.join(app, '.manta/threads', `${sub.id}.json`), 'utf8')).status).toBe('merged')
    expect(await ws.threads.get('auth.md', sub.id)).toMatchObject({ status: 'merged' })
    expect(await ws.threads.get('auth.md', dropped.id)).toMatchObject({ status: 'discarded' })
    expect((await ws.threads.list('auth.md')).map((t) => t.id)).toEqual([parent.id])
    expect((await ws.threads.listSubthreads('auth.md', parent.id)).map((t) => [t.id, t.status]).sort()).toEqual(
      [[sub.id, 'merged'], [dropped.id, 'discarded']].sort()
    )
  })

  it("runs an agent turn on a subthread against the parent's proposal", async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const agent = new ScriptedAgent(() => [{ edit: { find: '14 days.', replace: '7 days.' } }])
    const threadsDir = await tempDir()
    const ws = await Workspace.open(app, () => {}, { threadsDir, agent })
    workspaces.push(ws)
    const parent = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await ws.threads.proposeEdit('auth.md', parent.id, '30 days.', '14 days.')
    const sub = await ws.threads.createSubthread('auth.md', parent.id, 'Even shorter?')

    await ws.threads.send('auth.md', sub.id, 'Go to a week')

    expect(threadContext(agent.turns[0])?.section).toBe('## Sessions\n\nSessions last 14 days.')
    expect((await ws.threads.proposal('auth.md', sub.id)).proposed).toBe(AUTH.replace('30 days.', '7 days.'))
    expect((await ws.threads.proposal('auth.md', parent.id)).proposed).toBe(AUTH.replace('30 days.', '14 days.'))
  })

  it('a fresh clone re-finds a merged subthread', async () => {
    const { origin, app } = await setup({ 'auth.md': AUTH })
    const { ws, parent } = await parentWithEdit(app)
    const sub = await ws.threads.createSubthread('auth.md', parent.id, 'Refresh rules')
    await ws.threads.proposeEdit('auth.md', sub.id, '14 days.', '14 days, then refresh.')
    await ws.threads.approve('auth.md', sub.id)
    await ws.commit('docs: records')
    await ws.threads.approve('auth.md', parent.id)
    git(app, 'push')

    const fresh = await clone(origin)
    await syncMantaDir(app, fresh)
    const freshWs = await openWorkspace(fresh)

    expect((await freshWs.threads.list('auth.md')).map((t) => t.id)).toEqual([parent.id])
    const found = await freshWs.threads.get('auth.md', sub.id)
    expect(found).toMatchObject({ status: 'merged', parent: parent.id })
    expect((await readFile(path.join(fresh, 'auth.md'), 'utf8')).slice(found?.range?.from, found?.range?.to)).toBe('## Sessions\n\nSessions last 14 days, then refresh.')
  })
})

describe('Workspace implementation threads', () => {
  const LINK = { project: '/code/app', worktree: '/code/app.worktrees/sessions', branch: 'manta/sessions', session: 's-1', terminal: 'term_1', base: null }

  it('anchors to the section around an offset, records the link, and needs no fork', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)

    const thread = await ws.threads.createImplementation('auth.md', { offset: AUTH.indexOf('last 30') }, 'Sessions', LINK)

    expect(thread).toMatchObject({ status: 'open', parent: null, implementation: { ...LINK, source: null, hidden: false } })
    expect(await threadSection(ws, app, 'auth.md', thread.id)).toBe('## Sessions\n\nSessions last 30 days.')
    const record = JSON.parse(await readFile(path.join(app, '.manta/threads', `${thread.id}.json`), 'utf8'))
    expect(record.implementation).toMatchObject({ branch: 'manta/sessions', session: 's-1' })
    expect(await readdir(path.join(app, '.git/manta'))).not.toContain('threads')
  })

  it("starts from a doc thread's section and puts that thread's conversation in the brief", async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await Workspace.open(app, () => {}, { threadsDir: await tempDir(), agent: new ScriptedAgent(() => [{ text: 'Make it 7 days.' }]) })
    workspaces.push(ws)
    const design = await startThread(ws, app, 'auth.md', 'last 30', 'Session length')
    await ws.threads.send('auth.md', design.id, 'How long should sessions last?')

    const thread = await ws.threads.createImplementation('auth.md', { thread: design.id }, 'Session length', LINK)
    expect(thread.implementation?.source).toBe(design.id)
    expect(thread.range).toEqual((await ws.threads.get('auth.md', design.id))?.range)

    const brief = await ws.threads.implementationBrief('auth.md', thread.id)
    expect(brief).toContain('## Sessions\n\nSessions last 30 days.')
    expect(brief).toContain(`Manta-Thread: ${thread.id}`)
    expect(brief).toContain('**User:** How long should sessions last?\n\n**Agent:** Make it 7 days.')
    await expect(ws.threads.createImplementation('auth.md', { thread: thread.id }, 'Again', LINK)).rejects.toThrow(/implementation already/)
    await expect(ws.threads.send('auth.md', thread.id, 'hi')).resolves.toMatchObject({ ok: false })
  })

  it('refuses approve, agent messages and subthreads', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await ws.threads.createImplementation('auth.md', { offset: 0 }, 'Auth', LINK)

    expect(await ws.threads.approve('auth.md', thread.id)).toMatchObject({ ok: false, message: expect.stringMatching(/lands through its branch/) })
    await expect(ws.threads.createSubthread('auth.md', thread.id, 'Sub')).rejects.toThrow(/take no subthreads/)
  })

  it('moves to a new terminal, lands, hides its Landed chip, and keeps all of it in the record', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await ws.threads.createImplementation('auth.md', { offset: 0 }, 'Auth', LINK)

    expect((await ws.threads.updateImplementation('auth.md', thread.id, { terminal: null })).implementation?.terminal).toBeNull()
    expect(await ws.threads.setStatus('auth.md', thread.id, 'merged')).toMatchObject({ status: 'merged', highlighted: true })
    await ws.threads.dismissLanded('auth.md', thread.id)
    expect((await ws.threads.get('auth.md', thread.id))?.highlighted).toBe(false)
    const record = JSON.parse(await readFile(path.join(app, '.manta/threads', `${thread.id}.json`), 'utf8'))
    expect(record).toMatchObject({ status: 'merged', implementation: { terminal: null, hidden: true } })
  })

  it('a clone with no .git/manta/ re-finds the implementation and its link from the record', async () => {
    const { origin, app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const thread = await ws.threads.createImplementation('auth.md', { offset: AUTH.indexOf('last 30') }, 'Sessions', LINK)

    const fresh = await clone(origin)
    await syncMantaDir(app, fresh)
    const freshWs = await openWorkspace(fresh)
    expect(await threadSection(freshWs, fresh, 'auth.md', thread.id)).toBe('## Sessions\n\nSessions last 30 days.')
    expect((await freshWs.threads.get('auth.md', thread.id))?.implementation).toMatchObject({ branch: 'manta/sessions' })
  })
})

describe('Workspace doc proposals', () => {
  const FROM = { ref: { doc: 'plan.md', thread: 't_impl000001' }, label: 'the implementation “Sessions” (manta/sessions)' }

  it('starts a thread on the section with the edit proposed and the reason in its transcript, and approving commits it', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)

    const proposed = await ws.threads.propose('auth.md', { find: 'last 30 days', replace: 'last 7 days', title: 'Sessions are 7 days', why: 'The store expires them after 7.', from: FROM })
    if (!proposed.ok) throw new Error(proposed.message)

    expect(proposed.thread).toMatchObject({ title: 'Sessions are 7 days', status: 'open', proposedBy: { doc: 'plan.md', thread: FROM.ref.thread }, implementation: null })
    expect(await threadSection(ws, app, 'auth.md', proposed.thread.id)).toBe('## Sessions\n\nSessions last 30 days.')
    expect((await ws.threads.proposal('auth.md', proposed.thread.id)).merged).toContain('Sessions last 7 days.')
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toBe(AUTH)
    expect((await ws.threads.transcript(proposed.thread.id)).map((m) => [m.role, m.text])).toEqual([
      ['status', 'Proposed by the implementation “Sessions” (manta/sessions)'],
      ['assistant', 'The store expires them after 7.']
    ])
    const record = JSON.parse(await readFile(path.join(app, '.manta/threads', `${proposed.thread.id}.json`), 'utf8'))
    expect(record.proposedBy).toEqual({ doc: 'plan.md', thread: FROM.ref.thread })

    expect(await ws.threads.approve('auth.md', proposed.thread.id)).toMatchObject({ ok: true })
    expect(await readFile(path.join(app, 'auth.md'), 'utf8')).toContain('Sessions last 7 days.')
    expect(git(app, 'log', '-1', '--format=%B')).toContain(`Manta-Thread: ${proposed.thread.id}`)
  })

  it('refuses a missing doc, text that is not there or not unique, and a no-op, explaining what to fix', async () => {
    const { app } = await setup({ 'auth.md': AUTH })
    const ws = await openWorkspace(app)
    const change = { find: 'last 30 days', replace: 'last 7 days', title: 't', why: 'w', from: FROM }

    expect(await ws.threads.propose('nope.md', change)).toMatchObject({ ok: false, message: expect.stringMatching(/no doc nope.md/) })
    expect(await ws.threads.propose('auth.md', { ...change, find: 'last 31 days' })).toMatchObject({ ok: false, message: expect.stringMatching(/quote it exactly/) })
    expect(await ws.threads.propose('auth.md', { ...change, find: '## ' })).toMatchObject({ ok: false, message: expect.stringMatching(/appears 2 times/) })
    expect(await ws.threads.propose('auth.md', { ...change, replace: 'last 30 days' })).toMatchObject({ ok: false, message: expect.stringMatching(/same as/) })
    expect(await ws.threads.list('auth.md')).toEqual([])
  })
})

/** The thread variant of a turn's context; a map turn has none. */
function threadContext(turn: AgentTurn | undefined): ThreadTurnContext | null {
  return turn && !('map' in turn.context) ? turn.context : null
}
