import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findOnPath, loginShellEnv, parseEnvOutput, terminalEnv, withoutSessionScoped } from '../terminalEnv'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const INHERITED = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/someone',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'parent',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
  ORCA_AGENT_HOOK_PORT: '4242',
  ORCA_PANE_KEY: 'p1',
  SUPERSET_HOME_DIR: '/x',
  TERM_PROGRAM: 'Orca',
  CLAUDE_CODE_USE_BEDROCK: '1',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
  AWS_REGION: 'eu-west-1'
}

describe('terminal environment', () => {
  it("drops a parent Claude Code session's, Orca's and Superset's variables, and keeps the user's configuration", () => {
    const env = withoutSessionScoped(INHERITED)
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_DEFAULT_OPUS_MODEL', 'AWS_REGION', 'CLAUDE_CODE_USE_BEDROCK', 'HOME', 'PATH'])
  })

  it('adds the terminal type and Manta ids, with extras last', () => {
    const env = terminalEnv({ base: INHERITED, terminalId: 'term_1', root: '/repo', extra: { MANTA_HOOK_PORT: '5000' } })
    expect(env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Manta',
      MANTA_TERMINAL_ID: 'term_1',
      MANTA_ROOT: '/repo',
      MANTA_HOOK_PORT: '5000',
      PATH: '/usr/bin:/bin'
    })
    expect(env).not.toHaveProperty('ORCA_AGENT_HOOK_PORT')
    expect(env).not.toHaveProperty('CLAUDECODE')
  })

  it('parses env -0 output between the markers, ignoring what rc files print around it', () => {
    const output = 'Welcome!\n__MANTA_ENV__A=1\0B=x=y\0EMPTY=\0__MANTA_ENV__bye\n'
    expect(parseEnvOutput(output)).toEqual({ A: '1', B: 'x=y', EMPTY: '' })
    expect(parseEnvOutput('no markers')).toBeNull()
  })

  it("reads a login shell's environment without the session-scoped variables", async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'manta-env-'))
    dirs.push(home)
    const env = await loginShellEnv('/bin/sh', { ...INHERITED, HOME: home, FROM_PARENT: 'yes' })
    expect(env['FROM_PARENT']).toBe('yes')
    expect(env['PATH']).toContain('/bin')
    expect(env).not.toHaveProperty('CLAUDECODE')
    expect(env).not.toHaveProperty('ORCA_PANE_KEY')
  })

  it('falls back to the inherited environment when the shell cannot run', async () => {
    const env = await loginShellEnv('/nonexistent/shell', INHERITED)
    expect(env).toEqual(withoutSessionScoped(INHERITED))
  })
})

describe('findOnPath', () => {
  it('finds the first executable file of that name, skipping folders, plain files and relative entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'manta-path-'))
    dirs.push(root)
    const plain = path.join(root, 'plain')
    const folder = path.join(root, 'folder')
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    for (const dir of [plain, folder, first, second]) await mkdir(dir)
    await writeFile(path.join(plain, 'claude'), '')
    await mkdir(path.join(folder, 'claude'))
    for (const dir of [first, second]) {
      await writeFile(path.join(dir, 'claude'), '#!/bin/sh\n')
      await chmod(path.join(dir, 'claude'), 0o755)
    }

    expect(await findOnPath('claude', ['relative', plain, folder, first, second].join(':'))).toBe(path.join(first, 'claude'))
    expect(await findOnPath('claude', [plain, folder].join(':'))).toBeNull()
    expect(await findOnPath('claude', undefined)).toBeNull()
  })
})

