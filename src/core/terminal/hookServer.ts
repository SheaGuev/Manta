import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/** The Claude Code hook events Manta listens to; every one is accepted by Claude Code 2.1.285. */
export const CLAUDE_HOOK_EVENTS: readonly string[] = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'PostCompact',
  'SessionEnd'
]

const MAX_BODY = 1024 * 1024

/**
 * Posts the hook payload (Claude Code's stdin) to Manta and prints Manta's answer, which is `{}`
 * (so a hook that must answer, a permission request, defers to Claude Code's normal flow) unless
 * Manta adds context to a prompt. Never fails: outside a Manta terminal the variables are unset,
 * and with Manta gone or refusing (`-f`) it prints `{}`. `--noproxy` keeps a user's HTTP proxy off
 * the loopback call; the timeouts keep a stuck Manta from holding up Claude.
 */
export const HOOK_COMMAND = [
  'out=""; if [ -n "${MANTA_HOOK_PORT:-}" ]; then',
  'out=$(curl -sSf -X POST "http://127.0.0.1:${MANTA_HOOK_PORT}/hook" --noproxy 127.0.0.1 --connect-timeout 0.5 --max-time 1.5',
  '-H "Content-Type: application/json" -H "X-Manta-Hook-Token: ${MANTA_HOOK_TOKEN}" -H "X-Manta-Terminal: ${MANTA_TERMINAL_ID}"',
  '--data-binary @- 2>/dev/null); fi; if [ -n "$out" ]; then printf "%s\\n" "$out"; else printf "{}\\n"; fi'
].join(' ')

/** What Manta answers a hook with: Claude Code reads it as the hook's JSON output; null for `{}`. */
export type HookAnswer = (terminalId: string, payload: unknown) => Promise<Record<string, unknown> | null>

interface ClaudeHookSettings {
  hooks: Record<string, { hooks: { type: 'command'; command: string; timeout: number }[] }[]>
}

/** The settings passed to `claude --settings`; Claude Code adds these hooks to the user's own. */
export function claudeHookSettings(): ClaudeHookSettings {
  const hooks: ClaudeHookSettings['hooks'] = {}
  for (const event of CLAUDE_HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 5 }] }]
  return { hooks }
}

export interface HookServerAddress {
  port: number
  token: string
}

/** Answers one MCP JSON-RPC message from a terminal's Claude session; null for a notification. */
export type McpHandler = (terminalId: string, message: unknown) => Promise<Record<string, unknown> | null>

/**
 * Loopback HTTP endpoint for Manta's Claude sessions: the hook command posts to `/hook`, and linked
 * sessions reach Manta's MCP tools at `/mcp/<terminal id>` (Bearer token), agents Manta runs at `/mcp/agent_<…>`. A fresh token per start;
 * anything without it is refused.
 */
export class HookServer {
  private constructor(
    private readonly server: Server,
    readonly address: HookServerAddress
  ) {}

  static start(onHook: (terminalId: string, payload: unknown) => void, onMcp?: McpHandler, answer?: HookAnswer): Promise<HookServer> {
    const token = randomBytes(24).toString('hex')
    const server = createServer((request, response) => {
      if (request.url?.startsWith(MCP_PATH)) handleMcp(request, response, token, onMcp)
      else handle(request, response, token, onHook, answer)
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') return reject(new Error('Hook server has no TCP port'))
        resolve(new HookServer(server, { port: address.port, token }))
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
}

function handle(request: IncomingMessage, response: ServerResponse, token: string, onHook: (terminalId: string, payload: unknown) => void, answer?: HookAnswer): void {
  const reply = (status: number, body: Record<string, unknown> | null = null): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(body ? JSON.stringify(body) : '{}')
  }
  if (request.method !== 'POST' || request.url !== '/hook') return reply(404)
  if (!sameToken(request.headers['x-manta-hook-token'], token)) return reply(403)
  const terminalId = request.headers['x-manta-terminal']
  if (typeof terminalId !== 'string' || terminalId === '') return reply(400)
  readJson(request, (payload) => {
    if (payload === undefined) return reply(400)
    onHook(terminalId, payload)
    if (!answer) return reply(200)
    answer(terminalId, payload).then(
      (body) => reply(200, body),
      (error: unknown) => {
        console.error('manta: answering a hook', error)
        reply(200)
      }
    )
  })
}

const MCP_PATH = '/mcp/'

/** Streamable HTTP with JSON responses only: no event stream, so a `GET` for one gets 405, as the spec allows. */
function handleMcp(request: IncomingMessage, response: ServerResponse, token: string, onMcp: McpHandler | undefined): void {
  const reply = (status: number, body?: Record<string, unknown>): void => {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(body ? JSON.stringify(body) : undefined)
  }
  const terminalId = decodeURIComponent(request.url?.slice(MCP_PATH.length) ?? '')
  if (!onMcp || !/^(term|agent)_[a-z0-9_]+$/.test(terminalId)) return reply(404)
  const authorization = request.headers['authorization']
  if (!sameToken(typeof authorization === 'string' ? authorization.replace(/^Bearer /, '') : undefined, token)) return reply(401)
  if (request.method !== 'POST') return reply(405)
  readJson(request, (message) => {
    if (message === undefined) return reply(400)
    onMcp(terminalId, message).then(
      (answer) => (answer ? reply(200, answer) : reply(202)),
      (error: unknown) => reply(500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } })
    )
  })
}

/** Calls back with the parsed body, or undefined when it isn't JSON. Bodies over `MAX_BODY` are dropped. */
function readJson(request: IncomingMessage, done: (value: unknown) => void): void {
  const chunks: Buffer[] = []
  let size = 0
  request.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_BODY) request.destroy()
    else chunks.push(chunk)
  })
  request.on('end', () => {
    let value: unknown
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      value = undefined
    }
    done(value)
  })
}

function sameToken(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length || token === '') return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(token))
}
