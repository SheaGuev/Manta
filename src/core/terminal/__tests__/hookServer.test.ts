import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_HOOK_EVENTS, claudeHookSettings, HOOK_COMMAND, HookServer } from '../hookServer'

const execFileAsync = promisify(execFile)

const servers: HookServer[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function start(): Promise<{ server: HookServer; received: { terminalId: string; payload: unknown }[] }> {
  const received: { terminalId: string; payload: unknown }[] = []
  const server = await HookServer.start((terminalId, payload) => received.push({ terminalId, payload }))
  servers.push(server)
  return { server, received }
}

function post(server: HookServer, body: string, headers: Record<string, string>, url = '/hook', method = 'POST'): Promise<number> {
  return fetch(`http://127.0.0.1:${server.address.port}${url}`, { method, body: method === 'POST' ? body : null, headers }).then((r) => r.status)
}

/** Runs the hook command the way Claude Code does: through a shell, with the payload on stdin. */
async function runHookCommand(env: Record<string, string>, payload: string): Promise<string> {
  const child = execFileAsync('/bin/sh', ['-c', HOOK_COMMAND], { env: { PATH: '/usr/bin:/bin', ...env } })
  child.child.stdin?.end(payload)
  return (await child).stdout
}

describe('HookServer', () => {
  it('hands on payloads posted with its token and a terminal id', async () => {
    const { server, received } = await start()
    const headers = { 'X-Manta-Hook-Token': server.address.token, 'X-Manta-Terminal': 'term_1' }
    expect(await post(server, '{"hook_event_name":"Stop"}', headers)).toBe(200)
    expect(received).toEqual([{ terminalId: 'term_1', payload: { hook_event_name: 'Stop' } }])
  })

  it('refuses a wrong or missing token, a missing terminal id, bad JSON and other routes', async () => {
    const { server, received } = await start()
    const token = server.address.token
    expect(await post(server, '{}', { 'X-Manta-Hook-Token': 'x'.repeat(token.length), 'X-Manta-Terminal': 't' })).toBe(403)
    expect(await post(server, '{}', { 'X-Manta-Terminal': 't' })).toBe(403)
    expect(await post(server, '{}', { 'X-Manta-Hook-Token': token })).toBe(400)
    expect(await post(server, 'not json', { 'X-Manta-Hook-Token': token, 'X-Manta-Terminal': 't' })).toBe(400)
    expect(await post(server, '{}', { 'X-Manta-Hook-Token': token, 'X-Manta-Terminal': 't' }, '/other')).toBe(404)
    expect(await post(server, '', { 'X-Manta-Hook-Token': token, 'X-Manta-Terminal': 't' }, '/hook', 'GET')).toBe(404)
    expect(received).toEqual([])
  })

  it('uses a different token each start', async () => {
    const a = await start()
    const b = await start()
    expect(a.server.address.token).not.toBe(b.server.address.token)
  })
})

describe('the hook command', () => {
  it('posts the payload from stdin with the terminal id from the environment, and prints {}', async () => {
    const { server, received } = await start()
    const env = { MANTA_HOOK_PORT: String(server.address.port), MANTA_HOOK_TOKEN: server.address.token, MANTA_TERMINAL_ID: 'term_7' }
    const stdout = await runHookCommand(env, '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}')
    expect(stdout).toBe('{}\n')
    await vi.waitFor(() => expect(received).toEqual([{ terminalId: 'term_7', payload: { hook_event_name: 'UserPromptSubmit', prompt: 'hi' } }]))
  })

  it("prints Manta's answer when it adds context to a prompt, and {} for anything else", async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'The doc moved' } }
    const server = await HookServer.start(
      () => undefined,
      undefined,
      async (_terminal, payload) => (typeof payload === 'object' && payload !== null && 'hook_event_name' in payload && payload.hook_event_name === 'UserPromptSubmit' ? answer : null)
    )
    servers.push(server)
    const env = { MANTA_HOOK_PORT: String(server.address.port), MANTA_HOOK_TOKEN: server.address.token, MANTA_TERMINAL_ID: 'term_7' }
    expect(JSON.parse(await runHookCommand(env, '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}'))).toEqual(answer)
    expect(await runHookCommand(env, '{"hook_event_name":"Stop"}')).toBe('{}\n')
    expect(await runHookCommand({ ...env, MANTA_HOOK_TOKEN: 'wrong' }, '{"hook_event_name":"UserPromptSubmit"}')).toBe('{}\n')
  })

  it('does nothing outside a Manta terminal, or when Manta is gone, and still succeeds', async () => {
    expect(await runHookCommand({}, '{}')).toBe('{}\n')
    expect(await runHookCommand({ MANTA_HOOK_PORT: '1', MANTA_HOOK_TOKEN: 't', MANTA_TERMINAL_ID: 'x' }, '{}')).toBe('{}\n')
  })

  it('is registered for every event Manta listens to', () => {
    const settings = claudeHookSettings()
    expect(Object.keys(settings.hooks)).toEqual([...CLAUDE_HOOK_EVENTS])
    for (const entries of Object.values(settings.hooks)) expect(entries).toEqual([{ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] }])
  })
})

describe('HookServer MCP route', () => {
  async function startMcp(): Promise<{ server: HookServer; calls: { terminalId: string; message: unknown }[] }> {
    const calls: { terminalId: string; message: unknown }[] = []
    const server = await HookServer.start(
      () => undefined,
      async (terminalId, message) => {
        calls.push({ terminalId, message })
        return typeof message === 'object' && message !== null && 'id' in message ? { jsonrpc: '2.0', id: message.id, result: {} } : null
      }
    )
    servers.push(server)
    return { server, calls }
  }

  const mcp = (server: HookServer, body: unknown, options: { token?: string; path?: string; method?: string } = {}) =>
    fetch(`http://127.0.0.1:${server.address.port}/mcp/${options.path ?? 'term_1'}`, {
      method: options.method ?? 'POST',
      headers: { Authorization: `Bearer ${options.token ?? server.address.token}`, 'Content-Type': 'application/json' },
      body: (options.method ?? 'POST') === 'POST' ? JSON.stringify(body) : null
    })

  it('answers requests as JSON and notifications with 202, per terminal', async () => {
    const { server, calls } = await startMcp()
    const answer = await mcp(server, { jsonrpc: '2.0', id: 1, method: 'ping' })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ jsonrpc: '2.0', id: 1, result: {} })
    expect((await mcp(server, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    expect(calls.map((c) => c.terminalId)).toEqual(['term_1', 'term_1'])
  })

  it('refuses a wrong token, a bad terminal id, a GET for an event stream, and bad JSON', async () => {
    const { server, calls } = await startMcp()
    expect((await mcp(server, {}, { token: 'nope' })).status).toBe(401)
    expect((await mcp(server, {}, { path: 'evil%20id' })).status).toBe(404)
    expect((await mcp(server, {}, { method: 'GET' })).status).toBe(405)
    const bad = await fetch(`http://127.0.0.1:${server.address.port}/mcp/term_1`, { method: 'POST', headers: { Authorization: `Bearer ${server.address.token}` }, body: '{' })
    expect(bad.status).toBe(400)
    expect(calls).toEqual([])
  })

  it('has no MCP route without a handler', async () => {
    const { server } = await start()
    expect((await fetch(`http://127.0.0.1:${server.address.port}/mcp/term_1`, { method: 'POST', headers: { Authorization: `Bearer ${server.address.token}` }, body: '{}' })).status).toBe(404)
  })
})
