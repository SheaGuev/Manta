import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImplementationRequest, TerminalLink } from '../../shared/ipc'
import type { PullRequestLookup } from '../repo/github'
import { Implementations, proposeDocChangeTool, reviseDocChangeTool, withdrawDocChangeTool } from '../implementations'
import { ProjectRegistry } from '../repo/projects'
import { TerminalManager } from '../terminal/terminals'

const FAKE_CLAUDE = fileURLToPath(new URL('../../../scripts/fake-claude.mjs', import.meta.url))
const AUTH = '# Auth\n\nWe use magic links for login.\n\n## Sessions\n\nSessions last 30 days.\n'

const NOT_READY = { text: 'starting', error: true }

const dirs: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-impl-')))
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

interface Setup {
  implementations: Implementations
  projects: ProjectRegistry
  terminals: TerminalManager
  docs: string
  code: string
  output: (id: string) => string
  request: (extra?: Partial<ImplementationRequest>) => ImplementationRequest
}

async function setup(options: { claude?: boolean; refreshFails?: boolean; pullRequests?: PullRequestLookup } = {}): Promise<Setup & { proposals: string[] }> {
  const appData = await tempDir()
  const docs = await repo({ 'auth.md': AUTH })
  const code = await repo({ 'app.ts': 'export {}\n' })
  const projects = await ProjectRegistry.load({
    settingsFile: path.join(appData, 'settings.json'),
    worktreesDir: path.join(appData, 'worktrees'),
    onUpdate: () => undefined
  })
  await projects.add(docs, 'docs')
  await projects.add(code, 'code')
  const chunks = new Map<string, string>()
  const proposals: string[] = []
  let implementations: Implementations | null = null
  const terminals = await TerminalManager.open({
    recordsFile: path.join(appData, 'terminals.json'),
    settingsFile: path.join(appData, 'terminal-settings.json'),
    hookSettingsFile: path.join(appData, 'hooks', 'claude-settings.json'),
    claude: () => (options.claude === false ? null : { file: process.execPath, args: [FAKE_CLAUDE] }),
    shell: '/bin/sh',
    baseEnv: async () => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: appData }),
    onData: (id, data) => chunks.set(id, (chunks.get(id) ?? '') + data),
    onChange: () => undefined,
    onRemoved: () => undefined,
    refreshBrief: async (link: TerminalLink, file: string) => {
      if (options.refreshFails) throw new Error('The doc is gone')
      await implementations?.refreshBrief(link, file)
    },
    mcpTools: (session) =>
      'terminal' in session && session.terminal.link
        ? [
            proposeDocChangeTool(async (terminalId, args) => (implementations ? implementations.proposeDocChange(terminalId, args) : NOT_READY)),
            reviseDocChangeTool(async (terminalId, args) => (implementations ? implementations.reviseDocChange(terminalId, args) : NOT_READY)),
            withdrawDocChangeTool(async (terminalId, args) => (implementations ? implementations.withdrawDocChange(terminalId, args) : NOT_READY))
          ]
        : []
  })
  implementations = new Implementations({
    projects,
    terminals,
    briefsDir: path.join(appData, 'implementations'),
    onProposal: (_docsRoot, thread) => proposals.push(thread.title),
    ...(options.pullRequests ? { pullRequests: options.pullRequests } : {})
  })
  cleanups.push(async () => {
    await terminals.shutdown()
    await projects.closeAll()
  })
  return {
    implementations,
    projects,
    terminals,
    docs,
    code,
    proposals,
    output: (id) => chunks.get(id) ?? '',
    request: (extra = {}) => ({
      docsRoot: docs,
      doc: 'auth.md',
      from: { offset: AUTH.indexOf('last 30') },
      title: 'Sessions',
      project: code,
      worktree: { name: 'Session length' },
      prompt: 'Start with a plan',
      cols: 100,
      rows: 30,
      ...extra
    })
  }
}

describe('Implementations.start', () => {
  it('creates the worktree, the thread and a Claude session that gets the prompt, the brief and the docs repo', async () => {
    const { implementations, projects, terminals, docs, code, output, request } = await setup()

    const started = await implementations.start(request())
    if (!started.ok) throw new Error(started.message)

    const worktree = (await projects.worktrees(code)).find((w) => w.branch === 'manta/session-length')
    expect(worktree).toBeDefined()
    const worktreeRoot = await realpath(worktree?.path ?? '')
    expect(started.terminal).toMatchObject({ root: worktreeRoot, kind: 'claude', title: 'Sessions', link: { docsRoot: docs, doc: 'auth.md', thread: started.thread.id } })
    expect(started.thread.implementation).toMatchObject({
      project: code,
      worktree: worktreeRoot,
      branch: 'manta/session-length',
      session: started.terminal.sessionId,
      terminal: started.terminal.id
    })
    await vi.waitFor(() => expect(output(started.terminal.id)).toContain('Scripted reply to: Start with a plan'))
    expect(output(started.terminal.id)).toContain(`Manta thread ${started.thread.id}`)
    expect(output(started.terminal.id)).toContain(`Added dirs: ${docs}`)
    await vi.waitFor(() => expect(terminals.list().find((t) => t.id === started.terminal.id)?.state).toBe('idle'))
    expect(git(worktreeRoot, 'status', '--porcelain')).toBe('')
  })

  it('uses an existing worktree of the project', async () => {
    const { implementations, code, request } = await setup()
    const started = await implementations.start(request({ worktree: { path: code } }))
    expect(started).toMatchObject({ ok: true, terminal: { root: code }, thread: { implementation: { branch: 'main' } } })
  })

  it('refuses without Claude Code or a prompt, before creating anything', async () => {
    const { implementations, projects, docs, code, request } = await setup({ claude: false })
    expect(await implementations.start(request())).toMatchObject({ ok: false, message: expect.stringMatching(/not installed/) })
    expect(await implementations.start(request({ prompt: '  ' }))).toMatchObject({ ok: false, message: expect.stringMatching(/first prompt/) })
    expect(await projects.worktrees(code)).toHaveLength(1)
    expect(await (await projects.workspace(docs)).threads.list('auth.md')).toEqual([])
  })

  it('refuses a worktree name already taken', async () => {
    const { implementations, request } = await setup()
    expect((await implementations.start(request())).ok).toBe(true)
    expect(await implementations.start(request())).toMatchObject({ ok: false, message: expect.stringMatching(/already exists/) })
  })

  it('removes the new worktree and discards the thread when the session fails to start', async () => {
    const { implementations, projects, docs, code, terminals, request } = await setup({ refreshFails: true })
    expect(await implementations.start(request())).toMatchObject({ ok: false, message: 'The doc is gone' })
    expect(await projects.worktrees(code)).toHaveLength(1)
    expect(await (await projects.workspace(docs)).threads.list('auth.md')).toEqual([expect.objectContaining({ status: 'discarded' })])
    expect(terminals.list()).toEqual([])
  })
})

describe('Implementations.openSession', () => {
  it('returns the open terminal, and resumes the session in a new one once that is closed', async () => {
    const { implementations, projects, terminals, docs, output, request } = await setup()
    const started = await implementations.start(request())
    if (!started.ok) throw new Error(started.message)
    const size = { cols: 100, rows: 30 }

    expect((await implementations.openSession(docs, 'auth.md', started.thread.id, size)).id).toBe(started.terminal.id)
    await terminals.close(started.terminal.id)
    const reopened = await implementations.openSession(docs, 'auth.md', started.thread.id, size)
    expect(reopened).toMatchObject({ sessionId: started.terminal.sessionId, resumable: true, link: started.terminal.link })
    expect(reopened.id).not.toBe(started.terminal.id)
    await vi.waitFor(() => expect(output(reopened.id)).toContain(`session ${started.terminal.sessionId} (resumed)`))
    expect((await (await projects.workspace(docs)).threads.get('auth.md', started.thread.id))?.implementation?.terminal).toBe(reopened.id)
  })
})

describe('Implementations.refreshBrief', () => {
  it('writes the brief from the section as it is now', async () => {
    const { implementations, docs, request } = await setup()
    const started = await implementations.start(request())
    if (!started.ok) throw new Error(started.message)
    const file = path.join(await tempDir(), 'brief.md')
    await implementations.refreshBrief({ docsRoot: docs, doc: 'auth.md', thread: started.thread.id }, file)
    expect(await readFile(file, 'utf8')).toContain('## Sessions\n\nSessions last 30 days.')
  })
})

describe('Implementations.check', () => {
  async function started(extra: Parameters<typeof setup>[0] = {}) {
    const ctx = await setup(extra)
    const result = await ctx.implementations.start(ctx.request())
    if (!result.ok) throw new Error(result.message)
    const worktree = result.thread.implementation?.worktree ?? ''
    const commit = (message: string): void => {
      git(worktree, 'commit', '--allow-empty', '-q', '-m', message)
    }
    const check = () => ctx.implementations.check(ctx.docs, 'auth.md', result.thread.id)
    return { ...ctx, thread: result.thread, worktree, commit, check }
  }

  it('is not landed while the new branch has nothing of its own, even though its tip is on main', async () => {
    const { check } = await started()
    expect(await check()).toMatchObject({ status: 'open', highlighted: false })
  })

  it('lands when the branch is merged into main, with or without the trailer', async () => {
    const { code, commit, check } = await started()
    commit('feat: sessions')
    expect((await check()).status).toBe('open')
    git(code, 'merge', '--ff-only', '-q', 'manta/session-length')
    expect(await check()).toMatchObject({ status: 'merged', highlighted: true })
  })

  it('lands through the trailer when the branch was squash-merged', async () => {
    const { code, commit, check, thread } = await started()
    commit(`feat: sessions\n\nManta-Thread: ${thread.id}`)
    git(code, 'merge', '--squash', '-q', 'manta/session-length')
    git(code, 'commit', '--allow-empty', '-q', '-m', `feat: sessions (#3)\n\n* feat: sessions\n\nManta-Thread: ${thread.id}`)
    expect((await check()).status).toBe('merged')
  })

  it("records the branch's pull request, lands when it is merged, and keeps the last one when GitHub can't be asked", async () => {
    let answer: Awaited<ReturnType<PullRequestLookup>> = { found: { number: 4, state: 'open', url: 'https://github.com/o/r/pull/4' } }
    const branches: string[] = []
    const { check } = await started({
      pullRequests: async (_root, branch) => {
        branches.push(branch)
        return answer
      }
    })
    expect(await check()).toMatchObject({ status: 'open', implementation: { pr: { number: 4, state: 'open' } } })
    answer = null
    expect((await check()).implementation?.pr).toMatchObject({ number: 4 })
    answer = { found: { number: 4, state: 'merged', url: 'https://github.com/o/r/pull/4' } }
    expect(await check()).toMatchObject({ status: 'merged', implementation: { pr: { state: 'merged' } } })
    expect(branches).toEqual(['manta/session-length', 'manta/session-length', 'manta/session-length'])
  })

  it('never looks up a pull request for work on the default branch itself', async () => {
    const lookups: string[] = []
    const ctx = await setup({
      pullRequests: async (_root, branch) => {
        lookups.push(branch)
        return { found: null }
      }
    })
    const result = await ctx.implementations.start(ctx.request({ worktree: { path: ctx.code } }))
    if (!result.ok) throw new Error(result.message)
    expect(result.thread.implementation?.base).toBeNull()
    expect((await ctx.implementations.check(ctx.docs, 'auth.md', result.thread.id)).status).toBe('open')
    expect(lookups).toEqual([])
  })
})

describe('Implementations.proposeDocChange', () => {
  it("lets the session propose a doc change through Manta's tool, as a thread from its implementation", async () => {
    const { implementations, projects, terminals, docs, output, request, proposals } = await setup()
    const started = await implementations.start(request({ prompt: 'propose auth.md|last 30 days|last 7 days|The store expires sessions after 7 days.' }))
    if (!started.ok) throw new Error(started.message)

    const workspace = await projects.workspace(docs)
    await vi.waitFor(async () => expect(await workspace.threads.list('auth.md')).toHaveLength(2))
    const proposal = (await workspace.threads.list('auth.md')).find((t) => t.proposedBy?.thread === started.thread.id)
    await vi.waitFor(() => expect(output(started.terminal.id)).toContain(`Tool: Proposed as the Manta thread ${proposal?.id} (“Update auth.md”) on auth.md.`))
    expect(proposal).toMatchObject({ title: 'Update auth.md', status: 'open', implementation: null })
    expect((await workspace.threads.proposal('auth.md', proposal?.id ?? '')).merged).toContain('Sessions last 7 days.')
    expect(proposals).toEqual(['Update auth.md'])
    expect(await readFile(path.join(docs, 'auth.md'), 'utf8')).toBe(AUTH)

    terminals.write(started.terminal.id, 'propose auth.md|last 31 days|x|y\r')
    await vi.waitFor(() => expect(output(started.terminal.id)).toContain("Tool error: The text to replace isn't in auth.md"))
  })

  it('lets the session revise its proposal, then withdraw it', async () => {
    const { implementations, projects, terminals, docs, output, request } = await setup()
    const started = await implementations.start(request({ prompt: 'propose auth.md|last 30 days|last 7 days|Seven days.' }))
    if (!started.ok) throw new Error(started.message)
    const workspace = await projects.workspace(docs)
    await vi.waitFor(() => expect(output(started.terminal.id)).toContain('Tool: Proposed'))
    const id = (await workspace.threads.list('auth.md')).find((t) => t.proposedBy)?.id ?? ''

    terminals.write(started.terminal.id, 'revise last|last 30 days|x|y\r')
    await vi.waitFor(() => expect(output(started.terminal.id)).toContain('Tool error: The text to replace was not found in the proposed doc'))
    terminals.write(started.terminal.id, 'revise last|7 days|14 days|The config says fourteen.\r')
    await vi.waitFor(() => expect(output(started.terminal.id)).toContain(`Tool: Revised the proposal ${id}`))
    expect((await workspace.threads.proposal('auth.md', id)).merged).toContain('Sessions last 14 days.')

    terminals.write(started.terminal.id, 'withdraw last|The doc was right after all.\r')
    await vi.waitFor(() => expect(output(started.terminal.id)).toContain(`Tool: Withdrew the proposal ${id}`))
    expect(await workspace.threads.get('auth.md', id)).toMatchObject({ status: 'discarded' })
    expect((await workspace.threads.transcript(id)).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'status', text: 'Proposed by the implementation “Sessions” (manta/session-length)' },
      { role: 'assistant', text: 'Seven days.' },
      { role: 'status', text: 'Revised by the implementation “Sessions” (manta/session-length)' },
      { role: 'assistant', text: 'The config says fourteen.' },
      { role: 'status', text: 'Withdrawn by the implementation “Sessions” (manta/session-length)' },
      { role: 'assistant', text: 'The doc was right after all.' }
    ])
    expect(await readFile(path.join(docs, 'auth.md'), 'utf8')).toBe(AUTH)

    expect(await implementations.withdrawDocChange(started.terminal.id, { thread: id, why: 'Again' })).toEqual({
      text: `${id} is already discarded; propose a new change instead`,
      error: true
    })
    expect(await implementations.reviseDocChange(started.terminal.id, { thread: id, find: '14', replace: '7', why: 'w' })).toMatchObject({ error: true })
  })

  it("refuses to withdraw or revise anything but the session's own proposals", async () => {
    const { implementations, terminals, output, request } = await setup()
    const first = await implementations.start(request({ prompt: 'propose auth.md|last 30 days|last 7 days|Seven days.' }))
    if (!first.ok) throw new Error(first.message)
    await vi.waitFor(() => expect(output(first.terminal.id)).toContain('Tool: Proposed'))
    const proposal = /thread (t_[0-9a-f]+)/.exec(output(first.terminal.id))?.[1] ?? ''
    const second = await implementations.start(request({ title: 'Other', worktree: { name: 'Other work' } }))
    if (!second.ok) throw new Error(second.message)

    expect(await implementations.withdrawDocChange(second.terminal.id, { thread: proposal, why: 'w' })).toEqual({
      text: `${proposal} is not a proposal from this implementation`,
      error: true
    })
    expect(await implementations.reviseDocChange(second.terminal.id, { thread: proposal, find: '7', replace: '9', why: 'w' })).toMatchObject({ error: true })
    expect(await implementations.withdrawDocChange(first.terminal.id, { thread: first.thread.id, why: 'w' })).toMatchObject({
      text: `${first.thread.id} is not a proposal from this implementation`
    })
    expect(await implementations.withdrawDocChange(first.terminal.id, { thread: 't_0000000000', why: 'w' })).toMatchObject({
      text: expect.stringContaining('There is no proposal t_0000000000')
    })
    expect(await implementations.withdrawDocChange(first.terminal.id, { thread: proposal })).toEqual({ text: 'Give why as text', error: true })
    terminals.write(first.terminal.id, 'exit\r')
  })

  it('gives a session with no implementation no tools', async () => {
    const { terminals, implementations, output } = await setup()
    const plain = await terminals.create(await tempDir(), 'claude', { cols: 100, rows: 30 }, { prompt: 'propose auth.md|a|b|c' })
    await vi.waitFor(() => expect(output(plain.id)).toContain('Tool error: no MCP server'))
    expect(await implementations.proposeDocChange(plain.id, { doc: 'auth.md', find: 'a', replace: 'b', title: 't', why: 'w' })).toMatchObject({ error: true })
  })

  it('asks for every argument as text', async () => {
    const { implementations, request } = await setup()
    const started = await implementations.start(request())
    if (!started.ok) throw new Error(started.message)
    expect(await implementations.proposeDocChange(started.terminal.id, { doc: 'auth.md', find: 'last 30 days' })).toEqual({ text: 'Give replace, title, why as text', error: true })
  })
})
