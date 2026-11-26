import { describe, expect, it } from 'vitest'
import { answerMcp, mcpToolName, type McpTool } from '../mcpEndpoint'

const calls: { terminalId: string; args: Record<string, unknown> }[] = []
const TOOL: McpTool = {
  name: 'echo',
  description: 'Echoes',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  call: async (terminalId, args) => {
    calls.push({ terminalId, args })
    if (args['text'] === 'boom') throw new Error('it broke')
    return args['text'] === 'no' ? { text: 'refused', error: true } : { text: `said ${String(args['text'])}` }
  }
}

describe('answerMcp', () => {
  it('initializes with the protocol version the client asked for, and lists tools without their handlers', async () => {
    expect(await answerMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, 'term_1', [TOOL])).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'manta', version: '1' } }
    })
    expect(await answerMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'term_1', [TOOL])).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { tools: [{ name: 'echo', description: 'Echoes', inputSchema: TOOL.inputSchema }] }
    })
    expect(mcpToolName(TOOL)).toBe('mcp__manta__echo')
  })

  it('calls a tool for the terminal, reporting refusals and throws as tool errors', async () => {
    calls.length = 0
    const call = (text: string) => answerMcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text } } }, 'term_9', [TOOL])
    expect(await call('hi')).toMatchObject({ result: { content: [{ type: 'text', text: 'said hi' }], isError: false } })
    expect(await call('no')).toMatchObject({ result: { content: [{ text: 'refused' }], isError: true } })
    expect(await call('boom')).toMatchObject({ result: { content: [{ text: 'it broke' }], isError: true } })
    expect(calls.map((c) => c.terminalId)).toEqual(['term_9', 'term_9', 'term_9'])
  })

  it('gives notifications no answer, and errors for unknown tools, unknown methods and non-requests', async () => {
    expect(await answerMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, 'term_1', [TOOL])).toBeNull()
    expect(await answerMcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, 'term_1', [TOOL])).toMatchObject({ error: { code: -32602 } })
    expect(await answerMcp({ jsonrpc: '2.0', id: 5, method: 'server/discover' }, 'term_1', [TOOL])).toMatchObject({ error: { code: -32601 } })
    expect(await answerMcp('hello', 'term_1', [TOOL])).toMatchObject({ error: { code: -32600 } })
  })
})
