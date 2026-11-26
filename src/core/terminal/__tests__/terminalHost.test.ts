import { Terminal as Screen } from '@xterm/headless'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalInfo, TerminalKind } from '../../../shared/ipc'
import { TerminalHost, type TerminalSpec } from '../terminalHost'

interface Chunk {
  id: string
  data: string
  seq: number
}

const hosts: TerminalHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.closeAll()
})

function setup(killGraceMs?: number): { host: TerminalHost; chunks: Chunk[]; changes: TerminalInfo[]; output: (id: string) => string } {
  const chunks: Chunk[] = []
  const changes: TerminalInfo[] = []
  const host = new TerminalHost({
    onData: (id, data, seq) => chunks.push({ id, data, seq }),
    onChange: (info) => changes.push(info),
    ...(killGraceMs === undefined ? {} : { killGraceMs })
  })
  hosts.push(host)
  const output = (id: string): string =>
    chunks
      .filter((c) => c.id === id)
      .map((c) => c.data)
      .join('')
  return { host, chunks, changes, output }
}

let counter = 0
function spec(script: string | null, kind: TerminalKind = 'shell'): TerminalSpec {
  counter += 1
  return {
    id: `term_${counter}`,
    root: tmpdir(),
    kind,
    title: kind,
    sessionId: kind === 'claude' ? '6b0f3f3e-1d6e-4c55-9a51-2f5d1c3a9b01' : null,
    resumable: false,
    createdAt: new Date().toISOString(),
    link: null,
    map: null,
    file: '/bin/sh',
    args: script === null ? [] : ['-c', script],
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    cols: 80,
    rows: 24
  }
}

/** What a fresh xterm shows after being fed `data`, one string per non-empty line. */
function render(data: string): Promise<string[]> {
  const screen = new Screen({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true })
  return new Promise((resolve) =>
    screen.write(data, () => {
      const buffer = screen.buffer.active
      const lines: string[] = []
      for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
      screen.dispose()
      resolve(lines.filter((line) => line.trim() !== ''))
    })
  )
}

describe('TerminalHost', () => {
  it('sends output in numbered batches and reports the exit code', async () => {
    const { host, chunks, changes, output } = setup()
    const { id } = host.create(spec('printf "one\\n"; printf "two\\n"; exit 3'))
    expect(host.info(id)?.state).toBe('running')
    await vi.waitFor(() => expect(host.info(id)?.state).toBe('exited'))
    expect(output(id)).toContain('one\r\ntwo')
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i + 1))
    expect(changes.at(-1)).toMatchObject({ id, state: 'exited', exitCode: 3 })
  })

  it('gives a snapshot that, followed by later output only, shows every line exactly once', async () => {
    const { host, chunks } = setup()
    const script = 'i=1; while [ $i -le 40 ]; do echo line-$i; i=$((i+1)); sleep 0.01; done'
    const { id } = host.create(spec(script))
    // Five `sleep`s in, under the same load as the wait below.
    await vi.waitFor(() => expect(chunks.some((c) => c.data.includes('line-5'))).toBe(true), { timeout: 5000 })
    const snapshot = await host.snapshot(id)
    // The script spawns 40 `sleep`s; on a busy machine that alone takes over waitFor's default second.
    await vi.waitFor(() => expect(host.info(id)?.state).toBe('exited'), { timeout: 5000 })
    const later = chunks.filter((c) => c.seq > snapshot.seq).map((c) => c.data)
    expect(later.length).toBeGreaterThan(0)
    const lines = await render(snapshot.data + later.join(''))
    for (let i = 1; i <= 40; i++) expect(lines.filter((line) => line === `line-${i}`)).toHaveLength(1)
  })

  it('resizes the program and the screen', async () => {
    const { host, output } = setup()
    const { id } = host.create(spec(null))
    host.resize(id, 100, 30)
    host.write(id, 'stty size; exit\r')
    await vi.waitFor(() => expect(host.info(id)?.state).toBe('exited'))
    expect(output(id)).toContain('30 100')
  })

  it('kills the whole process group, including what the shell started', async () => {
    const { host, output } = setup()
    const { id } = host.create(spec('sleep 60 & echo child:$!; wait'))
    await vi.waitFor(() => expect(output(id)).toMatch(/child:\d+/))
    const child = Number(/child:(\d+)/.exec(output(id))?.[1])
    await host.kill(id)
    expect(host.info(id)?.state).toBe('exited')
    expect(() => process.kill(child, 0)).toThrow()
  })

  it('SIGKILLs a program that ignores the hangup', async () => {
    const { host, output } = setup(200)
    const { id } = host.create(spec('trap "" HUP; echo ready; sleep 60'))
    await vi.waitFor(() => expect(output(id)).toContain('ready'))
    await host.kill(id)
    expect(host.info(id)?.state).toBe('exited')
  })

  it('moves a Claude terminal through hook events, and nothing else', async () => {
    const { host, changes } = setup()
    const claude = host.create(spec('sleep 60', 'claude'))
    const shell = host.create(spec('sleep 60'))
    expect(claude.state).toBe('starting')
    expect(host.applyHook(claude.id, { hook_event_name: 'SessionStart', source: 'startup' })).toBe(true)
    expect(host.applyHook(claude.id, { hook_event_name: 'SessionStart', source: 'startup' })).toBe(true)
    expect(host.applyHook(claude.id, { hook_event_name: 'UserPromptSubmit' })).toBe(true)
    expect(changes.filter((c) => c.id === claude.id).map((c) => c.state)).toEqual(['idle', 'working'])
    expect(host.applyHook(shell.id, { hook_event_name: 'UserPromptSubmit' })).toBe(false)
    expect(host.info(shell.id)?.state).toBe('running')
    expect(host.applyHook('term_unknown', { hook_event_name: 'Stop' })).toBe(false)
  })

  it('follows the session id across /clear and marks a session resumable once it has a prompt', async () => {
    const { host } = setup()
    const { id, sessionId } = host.create(spec('sleep 60', 'claude'))
    host.applyHook(id, { hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId })
    expect(host.info(id)).toMatchObject({ sessionId, resumable: false })
    host.applyHook(id, { hook_event_name: 'UserPromptSubmit', session_id: sessionId })
    expect(host.info(id)?.resumable).toBe(true)
    host.applyHook(id, { hook_event_name: 'SessionStart', source: 'clear', session_id: 'cleared' })
    expect(host.info(id)).toMatchObject({ sessionId: 'cleared', resumable: false })
    host.applyHook(id, { hook_event_name: 'SessionStart', source: 'startup', session_id: 'subagent', agent_id: 'a1' })
    expect(host.info(id)?.sessionId).toBe('cleared')
  })

  it('ignores input after exit, and close forgets the terminal', async () => {
    const { host } = setup()
    const { id } = host.create(spec('exit 0'))
    await vi.waitFor(() => expect(host.info(id)?.state).toBe('exited'))
    host.write(id, 'ignored\r')
    host.resize(id, 100, 30)
    await host.close(id)
    expect(host.info(id)).toBeNull()
    expect(host.list()).toEqual([])
    expect(() => host.write(id, 'x')).toThrow(/Unknown terminal/)
  })
})
