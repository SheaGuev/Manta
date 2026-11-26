import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInfo } from '../../../shared/ipc'
import { TerminalManager, type ClaudeLaunch, type TerminalManagerOptions } from '../terminals'

const FAKE_CLAUDE = fileURLToPath(new URL('../../../../scripts/fake-claude.mjs', import.meta.url))
const SIZE = { cols: 100, rows: 30 }

const dirs: string[] = []
const managers: TerminalManager[] = []
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-terminals-')))
  dirs.push(dir)
  return dir
}

interface Harness {
  manager: TerminalManager
  output: (id: string) => string
  changes: TerminalInfo[]
  removed: string[]
}

async function open(
  appData: string,
  claude: () => ClaudeLaunch | null = () => ({ file: process.execPath, args: [FAKE_CLAUDE] }),
  extra: Partial<TerminalManagerOptions> = {}
): Promise<Harness> {
  const chunks = new Map<string, string>()
  const changes: TerminalInfo[] = []
  const removed: string[] = []
  const manager = await TerminalManager.open({
    recordsFile: path.join(appData, 'terminals.json'),
    settingsFile: path.join(appData, 'terminal-settings.json'),
    hookSettingsFile: path.join(appData, 'hooks', 'claude-settings.json'),
    claude,
    shell: '/bin/sh',
    baseEnv: async () => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: appData }),
    onData: (id, data) => chunks.set(id, (chunks.get(id) ?? '') + data),
    onChange: (info) => changes.push(info),
    onRemoved: (id) => removed.push(id),
    ...extra
  })
  managers.push(manager)
  return { manager, output: (id) => chunks.get(id) ?? '', changes, removed }
}

const stateOf = (manager: TerminalManager, id: string) => manager.list().find((t) => t.id === id)?.state

describe('TerminalManager', () => {
  it('runs a login shell in the root', async () => {
    const appData = await tempDir()
    const root = await tempDir()
    const { manager, output } = await open(appData)
    const shell = await manager.create(root, 'shell', SIZE)
    expect(shell).toMatchObject({ kind: 'shell', title: 'Shell', state: 'running', sessionId: null, root })
    manager.write(shell.id, 'pwd; echo "id=$MANTA_TERMINAL_ID"; exit\r')
    await vi.waitFor(() => expect(stateOf(manager, shell.id)).toBe('exited'))
    expect(output(shell.id)).toContain(root)
    expect(output(shell.id)).toContain(`id=${shell.id}`)
  })

  it('tracks a Claude session through its hooks: idle, working, waiting on a permission, idle', async () => {
    const appData = await tempDir()
    const { manager, output, changes } = await open(appData)
    const claude = await manager.create(await tempDir(), 'claude', SIZE)
    expect(claude.state).toBe('starting')
    /** Each step is the fake session plus a hook round trip; under a full parallel suite that passes waitFor's default second. */
    const slow = { timeout: 5000 }
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)

    manager.write(claude.id, 'work 0.5\r')
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('working'), slow)
    // Half a second of work plus the hooks' round trips; a loaded machine takes longer than waitFor's default second.
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), { timeout: 5000 })

    manager.write(claude.id, 'ask rm -rf build\r')
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('waiting'), slow)
    manager.write(claude.id, 'y\r')
    await vi.waitFor(() => expect(output(claude.id)).toContain('Ran it.'), slow)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)

    const states = changes.filter((c) => c.id === claude.id).map((c) => c.state)
    expect(states).toEqual(['starting', 'idle', 'working', 'idle', 'working', 'waiting', 'working', 'idle'])
    expect(manager.list().find((t) => t.id === claude.id)?.resumable).toBe(true)
  })

  it('launches Claude with the hooks file and its session id, and writes the hooks file', async () => {
    const appData = await tempDir()
    const launches: string[][] = []
    const { manager } = await open(appData, () => {
      launches.push([])
      return { file: process.execPath, args: [FAKE_CLAUDE] }
    })
    const claude = await manager.create(await tempDir(), 'claude', SIZE)
    const settings: unknown = JSON.parse(await readFile(path.join(appData, 'hooks', 'claude-settings.json'), 'utf8'))
    expect(settings).toHaveProperty('hooks.SessionStart')
    expect(launches).toHaveLength(1)
    expect(claude.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("starts Claude with the user's extra arguments before Manta's own, and keeps them after a relaunch", async () => {
    const appData = await tempDir()
    const echo = (): ClaudeLaunch => ({ file: '/bin/sh', args: ['-c', 'echo "argv: $*"', 'claude'] })
    const first = await open(appData, echo)
    expect(first.manager.claudeArgsText()).toBe('')
    expect(await first.manager.setClaudeArgs('--resume abc')).toMatchObject({ ok: false })
    expect(await first.manager.setClaudeArgs('--dangerously-skip-permissions --name "my session"')).toMatchObject({ ok: true })
    const claude = await first.manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(first.output(claude.id)).toContain(`argv: --dangerously-skip-permissions --name my session --settings`))
    expect(first.output(claude.id)).toContain(`--session-id ${claude.sessionId}`)

    await first.manager.shutdown()
    managers.splice(managers.indexOf(first.manager), 1)
    const second = await open(appData, echo)
    expect(second.manager.claudeArgsText()).toBe('--dangerously-skip-permissions --name "my session"')
  })

  it('resumes the conversation after an exit, and starts a new session when there was nothing to resume', async () => {
    const appData = await tempDir()
    const { manager, output } = await open(appData)
    const unused = await manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(manager, unused.id)).toBe('idle'))
    manager.write(unused.id, 'exit\r')
    await vi.waitFor(() => expect(stateOf(manager, unused.id)).toBe('exited'))
    const fresh = await manager.restart(unused.id, SIZE)
    expect(fresh.sessionId).not.toBe(unused.sessionId)

    const used = await manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(manager, used.id)).toBe('idle'))
    manager.write(used.id, 'hello\r')
    await vi.waitFor(() => expect(output(used.id)).toContain('Scripted reply to: hello'))
    await vi.waitFor(() => expect(stateOf(manager, used.id)).toBe('idle'))
    manager.write(used.id, 'exit\r')
    await vi.waitFor(() => expect(stateOf(manager, used.id)).toBe('exited'))
    const resumed = await manager.restart(used.id, SIZE)
    expect(resumed.sessionId).toBe(used.sessionId)
    expect(resumed.startedAt).not.toBe(used.startedAt)
    await vi.waitFor(() => expect(output(used.id)).toContain('(resumed)'))
  })

  it('refuses to restart a terminal that is still running', async () => {
    const { manager } = await open(await tempDir())
    const shell = await manager.create(await tempDir(), 'shell', SIZE)
    await expect(manager.restart(shell.id, SIZE)).rejects.toThrow(/still running/)
  })

  it('lists terminals from before a relaunch as exited, ready to resume', async () => {
    const appData = await tempDir()
    const root = await tempDir()
    const first = await open(appData)
    const claude = await first.manager.create(root, 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(first.manager, claude.id)).toBe('idle'))
    first.manager.write(claude.id, 'hello\r')
    await vi.waitFor(() => expect(first.manager.list().find((t) => t.id === claude.id)?.resumable).toBe(true))
    await first.manager.shutdown()
    managers.splice(managers.indexOf(first.manager), 1)

    const second = await open(appData)
    expect(second.manager.list()).toEqual([
      expect.objectContaining({ id: claude.id, root, state: 'exited', startedAt: null, resumable: true, sessionId: claude.sessionId })
    ])
    expect(await second.manager.snapshot(claude.id)).toEqual({ data: '', seq: 0 })
    second.manager.write(claude.id, 'ignored\r')
    await second.manager.restart(claude.id, SIZE)
    await vi.waitFor(() => expect(second.output(claude.id)).toContain('(resumed)'))
  })

  it('numbers titles per root and kind, and closes a whole root', async () => {
    const { manager, removed } = await open(await tempDir())
    const root = await tempDir()
    const other = await tempDir()
    const a = await manager.create(root, 'shell', SIZE)
    const b = await manager.create(root, 'shell', SIZE)
    const c = await manager.create(other, 'shell', SIZE)
    expect([a.title, b.title, c.title]).toEqual(['Shell', 'Shell 2', 'Shell'])
    expect(manager.runningIn(root).map((t) => t.id).sort()).toEqual([a.id, b.id].sort())
    await manager.closeRoot(root)
    expect(manager.list().map((t) => t.id)).toEqual([c.id])
    expect(removed.sort()).toEqual([a.id, b.id].sort())
  })

  it('renames a terminal, running or exited, and keeps the name across a restart and a relaunch', async () => {
    const appData = await tempDir()
    const root = await tempDir()
    const first = await open(appData)
    const shell = await first.manager.create(root, 'shell', SIZE)
    expect(await first.manager.rename(shell.id, '  Deploys  ')).toMatchObject({ id: shell.id, title: 'Deploys', state: 'running' })
    expect(first.changes.at(-1)).toMatchObject({ id: shell.id, title: 'Deploys' })
    await expect(first.manager.rename(shell.id, '   ')).rejects.toThrow(/needs a name/)
    first.manager.write(shell.id, 'exit\r')
    await vi.waitFor(() => expect(stateOf(first.manager, shell.id)).toBe('exited'))
    expect((await first.manager.restart(shell.id, SIZE)).title).toBe('Deploys')
    await first.manager.shutdown()
    managers.splice(managers.indexOf(first.manager), 1)

    const second = await open(appData)
    expect(second.manager.list()).toEqual([expect.objectContaining({ id: shell.id, title: 'Deploys', state: 'exited' })])
    expect(await second.manager.rename(shell.id, 'Staging')).toMatchObject({ title: 'Staging', state: 'exited' })
    expect(second.changes.at(-1)).toMatchObject({ id: shell.id, title: 'Staging' })
  })

  it('says so when Claude Code is not installed, and starts nothing', async () => {
    const { manager } = await open(await tempDir(), () => null)
    await expect(manager.create(await tempDir(), 'claude', SIZE)).rejects.toThrow(/not installed/)
    expect(manager.list()).toEqual([])
  })
})

describe('TerminalManager Claude session options', () => {
  it('sends the first prompt once, passes the brief and folders on every start, and refreshes the brief first', async () => {
    const appData = await tempDir()
    const docs = await tempDir()
    const brief = path.join(appData, 'brief.md')
    const refreshed: string[] = []
    const chunks = new Map<string, string>()
    const manager = await TerminalManager.open({
      recordsFile: path.join(appData, 'terminals.json'),
      settingsFile: path.join(appData, 'terminal-settings.json'),
      hookSettingsFile: path.join(appData, 'hooks', 'claude-settings.json'),
      claude: () => ({ file: process.execPath, args: [FAKE_CLAUDE] }),
      shell: '/bin/sh',
      baseEnv: async () => ({ PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: appData }),
      onData: (id, data) => chunks.set(id, (chunks.get(id) ?? '') + data),
      onChange: () => undefined,
      onRemoved: () => undefined,
      refreshBrief: async (link, file) => {
        refreshed.push(link.thread)
        await writeFile(file, `# Brief\n\nManta thread ${link.thread}, take ${refreshed.length}\n`)
      }
    })
    managers.push(manager)
    const link = { docsRoot: docs, doc: 'auth.md', thread: 't_1' }
    const output = (id: string): string => chunks.get(id) ?? ''

    const claude = await manager.create(await tempDir(), 'claude', SIZE, { prompt: 'work 0.2', title: 'Sessions', link, brief, addDirs: [docs] })
    expect(claude).toMatchObject({ title: 'Sessions', link })
    // Starting the fake session plus 0.2 s of work; a loaded machine takes longer than waitFor's default second.
    await vi.waitFor(() => expect(output(claude.id)).toContain('Done working.'), { timeout: 5000 })
    expect(output(claude.id)).toContain('Manta thread t_1, take 1')
    expect(output(claude.id)).toContain(`Added dirs: ${docs}`)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'))
    expect(manager.list().find((t) => t.id === claude.id)?.resumable).toBe(true)

    manager.write(claude.id, 'exit\r')
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('exited'))
    await manager.restart(claude.id, SIZE)
    await vi.waitFor(() => expect(output(claude.id)).toContain('Manta thread t_1, take 2'))
    expect(output(claude.id).split('Done working.')).toHaveLength(2)
    expect(refreshed).toEqual(['t_1', 't_1'])
  })

  it('puts the prompt before every option, so a variadic flag cannot swallow it, and keeps a leading dash from reading as one', async () => {
    const { manager, output } = await open(await tempDir())
    const claude = await manager.create(await tempDir(), 'claude', SIZE, { prompt: '- step one', addDirs: ['/docs'] })
    await vi.waitFor(() => expect(output(claude.id)).toContain('Scripted reply to: - step one'))
    expect(output(claude.id)).toContain('Added dirs: /docs')
  })

  it('resumes a given session instead of starting a new one', async () => {
    const { manager, output } = await open(await tempDir())
    const session = '0b4f1c2e-3d5a-4b6c-8d7e-9f0a1b2c3d4e'
    const claude = await manager.create(await tempDir(), 'claude', SIZE, { resume: session })
    expect(claude).toMatchObject({ sessionId: session, resumable: true })
    await vi.waitFor(() => expect(output(claude.id)).toContain(`session ${session} (resumed)`))
  })

  it('ignores Claude options for a shell', async () => {
    const { manager } = await open(await tempDir())
    const shell = await manager.create(await tempDir(), 'shell', SIZE, { title: 'Nope', link: { docsRoot: '/d', doc: 'a.md', thread: 't_1' } })
    expect(shell).toMatchObject({ title: 'Shell', link: null })
  })
})

describe('TerminalManager.sendPrompt', () => {
  /** A fake session plus a hook round trip; a loaded machine passes waitFor's default second. */
  const slow = { timeout: 5000 }

  it('sends a multi-line prompt to an idle Claude session as one prompt, and it starts working', async () => {
    const { manager, output, changes } = await open(await tempDir())
    const claude = await manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)

    expect(await manager.sendPrompt(claude.id, 'line one\nline two')).toEqual({ ok: true, message: 'Sent to Claude' })
    await vi.waitFor(() => expect(output(claude.id)).toContain('Scripted reply to: line one'), slow)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)
    expect(output(claude.id).split('Scripted reply to:')).toHaveLength(2)
    expect(changes.filter((c) => c.id === claude.id).map((c) => c.state)).toContain('working')
  })

  it('refuses a session waiting on a permission prompt, and writes nothing', async () => {
    const { manager, output } = await open(await tempDir())
    const claude = await manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)
    manager.write(claude.id, 'ask ls\r')
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('waiting'), slow)

    const result = await manager.sendPrompt(claude.id, 'please review')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('waiting for you')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(output(claude.id)).not.toContain('please review')
    expect(stateOf(manager, claude.id)).toBe('waiting')
  })

  it('presses Enter only if the session is still at its prompt or working: a permission prompt that comes up meanwhile is left alone', async () => {
    /** A wide gap between paste and Enter, so the permission prompt reliably lands inside it. */
    const { manager, output } = await open(await tempDir(), undefined, { promptTiming: { submitDelayMs: 1500, submitConfirmMs: 1500 } })
    const claude = await manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)
    manager.write(claude.id, 'askafter 0.3 ls\r')
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('working'), slow)

    const result = await manager.sendPrompt(claude.id, 'please review')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('not submitted')
    expect(stateOf(manager, claude.id)).toBe('waiting')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(output(claude.id)).not.toMatch(/Ran it\.|Denied\./)
  })

  it('presses Enter once more when an idle session took the paste but not the first Enter', async () => {
    const { manager, output } = await open(await tempDir(), undefined, { promptTiming: { submitDelayMs: 50, submitConfirmMs: 500 } })
    const claude = await manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)

    expect(await manager.sendPrompt(claude.id, 'needs second enter')).toEqual({ ok: true, message: 'Sent to Claude' })
    await vi.waitFor(() => expect(output(claude.id)).toContain('Scripted reply to: needs second enter'), slow)
  })

  it("says so when an idle session doesn't submit the paste after a second Enter either", async () => {
    const { manager } = await open(await tempDir(), undefined, { promptTiming: { submitDelayMs: 50, submitConfirmMs: 300 } })
    const claude = await manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)

    const result = await manager.sendPrompt(claude.id, 'never submits')
    expect(result.ok).toBe(false)
    expect(result.message).toContain("didn't submit")
  })

  it('refuses shells and exited sessions', async () => {
    const { manager } = await open(await tempDir())
    const shell = await manager.create(await tempDir(), 'shell', SIZE)
    expect(await manager.sendPrompt(shell.id, 'hi')).toEqual({ ok: false, message: 'Only Claude sessions take review comments' })

    const claude = await manager.create(await tempDir(), 'claude', SIZE)
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('idle'), slow)
    manager.write(claude.id, 'exit\r')
    await vi.waitFor(() => expect(stateOf(manager, claude.id)).toBe('exited'), slow)
    expect(await manager.sendPrompt(claude.id, 'hi')).toEqual({ ok: false, message: "Claude isn't running" })
  })
})
