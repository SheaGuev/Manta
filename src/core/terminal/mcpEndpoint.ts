/** The name Claude Code knows Manta's MCP server by; its tools are `mcp__manta__<tool>`. */
export const MCP_SERVER = 'manta'

import type { TerminalRecord } from './terminalRecords'

/** Who is calling the endpoint: a terminal's Claude session, or an agent Manta runs itself (`agent_<…>`). */
export type McpSession = { terminal: TerminalRecord } | { agent: string }

export interface McpTool {
  name: string
  description: string
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>
  /** What the agent reads back; `error` marks a refusal it can act on, such as text it quoted wrongly. `terminalId` is the caller's id, a terminal's or an agent's. */
  call: (terminalId: string, args: Record<string, unknown>) => Promise<{ text: string; error?: boolean }>
}

export const mcpToolName = (tool: Pick<McpTool, 'name'>): string => `mcp__${MCP_SERVER}__${tool.name}`

/** Used when a client doesn't say which protocol version it speaks. */
const FALLBACK_PROTOCOL = '2025-06-18'

/**
 * Answers one JSON-RPC message from a Claude Code session's MCP client (Streamable HTTP, JSON
 * responses only): `initialize`, `ping`, `tools/list`, `tools/call`. Null for a notification,
 * which gets no response body.
 */
export async function answerMcp(message: unknown, terminalId: string, tools: readonly McpTool[]): Promise<Record<string, unknown> | null> {
  if (typeof message !== 'object' || message === null || !('method' in message) || typeof message.method !== 'string') {
    return rpcError(null, -32600, 'Not a JSON-RPC request')
  }
  const id = 'id' in message && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null
  if (id === null) return null
  const params = 'params' in message && typeof message.params === 'object' && message.params !== null ? message.params : {}

  switch (message.method) {
    case 'initialize': {
      const version = 'protocolVersion' in params && typeof params.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL
      return rpcResult(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: MCP_SERVER, version: '1' } })
    }
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call': {
      const name = 'name' in params ? params.name : undefined
      const tool = tools.find((t) => t.name === name)
      if (!tool) return rpcError(id, -32602, `Unknown tool ${String(name)}`)
      const args = 'arguments' in params && typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}
      try {
        const { text, error } = await tool.call(terminalId, Object.fromEntries(Object.entries(args)))
        return rpcResult(id, { content: [{ type: 'text', text }], isError: error === true })
      } catch (cause) {
        return rpcResult(id, { content: [{ type: 'text', text: cause instanceof Error ? cause.message : String(cause) }], isError: true })
      }
    }
    default:
      return rpcError(id, -32601, `Method ${message.method} is not supported`)
  }
}

function rpcResult(id: string | number, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
