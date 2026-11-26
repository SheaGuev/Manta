import type { PermissionUpdate, PreToolUseHookInput, SDKPartialAssistantMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PermissionDecision } from '../../../shared/ipc'
import { claudeCodeOptions, eventsFrom, fenceDenial } from '../claudeCodeAgent'
import type { AgentTurn, PermissionRequest } from '../threadAgent'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A thread folder holding `auth.md`, plus a sibling folder outside it. */
async function folders(): Promise<{ root: string; outside: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-fence-')))
  dirs.push(base)
  const root = path.join(base, 'thread')
  const outside = path.join(base, 'docs')
  await mkdir(root)
  await mkdir(outside)
  await writeFile(path.join(root, 'auth.md'), '# Auth\n')
  await writeFile(path.join(outside, 'auth.md'), '# Auth\n')
  return { root, outside }
}

function turn(cwd: string, answer: PermissionDecision = 'allow', session: string | null = null): AgentTurn & { asked: PermissionRequest[] } {
  const asked: PermissionRequest[] = []
  return {
    prompt: 'hi',
    cwd,
    file: path.join(cwd, 'auth.md'),
    session,
    context: { title: 'Session length', doc: 'auth.md', section: '## Sessions', repoRoot: '/docs', parents: null },
    signal: new AbortController().signal,
    asked,
    requestPermission: async (request) => {
      asked.push(request)
      return answer
    }
  }
}

const ask = { signal: new AbortController().signal, toolUseID: 'u', requestId: 'r' }

describe('fenceDenial', () => {
  it('lets file writes land only inside the thread folder', async () => {
    const { root, outside } = await folders()
    await symlink(outside, path.join(root, 'link'))
    expect(await fenceDenial(root, 'Edit', { file_path: 'auth.md', old_string: 'a', new_string: 'b' })).toBeNull()
    expect(await fenceDenial(root, 'Write', { file_path: path.join(root, 'notes/new.md'), content: 'x' })).toBeNull()
    const escapes: [string, unknown][] = [
      ['Edit', { file_path: path.join(outside, 'auth.md') }],
      ['Write', { file_path: '../docs/auth.md' }],
      ['Write', { file_path: '~/.zshrc' }],
      ['MultiEdit', { file_path: path.join(root, 'link/auth.md') }],
      ['NotebookEdit', { notebook_path: path.join(outside, 'n.ipynb') }]
    ]
    for (const [tool, input] of escapes) expect(await fenceDenial(root, tool, input)).toContain('outside')
  })

  it('leaves reads, Bash, web and MCP tools to the sandbox and the permission flow', async () => {
    const { root, outside } = await folders()
    expect(await fenceDenial(root, 'Read', { file_path: path.join(outside, 'auth.md') })).toBeNull()
    expect(await fenceDenial(root, 'Grep', { pattern: 'x', path: outside })).toBeNull()
    expect(await fenceDenial(root, 'Bash', { command: 'ls ~' })).toBeNull()
    expect(await fenceDenial(root, 'WebSearch', { query: 'session length' })).toBeNull()
    expect(await fenceDenial(root, 'mcp__notion__search', { query: 'auth' })).toBeNull()
  })
})

describe('claudeCodeOptions', () => {
  it('runs a normal Claude Code session with writes sandboxed to the thread folder', () => {
    const options = claudeCodeOptions(turn('/threads/t_1', 'allow', 'session-1'), new AbortController(), '/usr/local/bin/claude')
    expect(options).toMatchObject({
      cwd: '/threads/t_1',
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user'],
      permissionMode: 'default',
      sandbox: { enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false },
      resume: 'session-1',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude'
    })
    expect(options.additionalDirectories).toBeUndefined()
    expect(options.allowedTools).toBeUndefined()
    expect(options.strictMcpConfig).toBeUndefined()
    expect(claudeCodeOptions(turn('/threads/t_1'), new AbortController(), null)).not.toHaveProperty('resume')
  })

  it("points a subthread's agent at its parent threads' conversations", () => {
    const appended = (agentTurn: AgentTurn): string => {
      const prompt = claudeCodeOptions(agentTurn, new AbortController(), null).systemPrompt
      return typeof prompt === 'object' && prompt !== null && 'append' in prompt ? (prompt.append ?? '') : ''
    }
    const top = turn('/threads/t_2')
    const sub = { ...top, context: { ...top.context, parents: { titles: ['Session length', 'Refresh'], file: '/threads/t_2/.manta/parent-threads.md' } } }

    expect(appended(sub)).toContain('This thread is a subthread of "Session length" → "Refresh".')
    expect(appended(sub)).toContain('.manta/parent-threads.md holds the parent threads\' conversations')
    expect(appended(top)).not.toContain('subthread')
  })

  it("gives a map's agent its prompt, Manta's MCP server with the map tools allowed, and the sweep's model", () => {
    const base = turn('/maps/m_1')
    const mcp = { url: 'http://127.0.0.1:1/mcp/agent_ask_m_1', headers: { Authorization: 'Bearer t' }, tools: ['mcp__manta__map_outline'] }
    const mapTurn: AgentTurn = { ...base, file: '/maps/m_1/map.md', context: { repoRoot: '/docs', map: { id: 'm_1', title: 'Auth', prompt: 'You are the agent of the map "Auth".' }, mcp, model: 'haiku' } }
    const options = claudeCodeOptions(mapTurn, new AbortController(), null)
    const prompt = options.systemPrompt
    const appended = typeof prompt === 'object' && prompt !== null && 'append' in prompt ? (prompt.append ?? '') : ''
    expect(appended).toContain('You are the agent of the map "Auth".')
    expect(appended).toContain('You can only write inside your working directory')
    expect(options.mcpServers).toEqual({ manta: { type: 'http', url: mcp.url, headers: mcp.headers } })
    expect(options.allowedTools).toEqual(['mcp__manta__map_outline'])
    expect(options.model).toBe('haiku')
    expect(claudeCodeOptions(turn('/t'), new AbortController(), null).mcpServers).toBeUndefined()
  })

  it('denies writes outside the folder in the PreToolUse hook, whatever the allow rules say', async () => {
    const { root, outside } = await folders()
    const hook = claudeCodeOptions(turn(root), new AbortController(), null).hooks?.PreToolUse?.[0]?.hooks[0]
    if (!hook) throw new Error('fence not installed')
    const input = (toolName: string, toolInput: unknown): PreToolUseHookInput => ({
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '/tmp/t',
      cwd: root,
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'u'
    })

    expect(await hook(input('Write', { file_path: path.join(outside, 'auth.md') }), 'u', ask)).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' }
    })
    expect(await hook(input('Edit', { file_path: path.join(root, 'auth.md') }), 'u', ask)).toEqual({})
    expect(await hook(input('Bash', { command: 'ls' }), 'u', ask)).toEqual({})
  })

  it('allows reads anywhere, and asks the user about everything else that needs approval', async () => {
    const { root, outside } = await folders()
    const allowing = turn(root, 'allow')
    const { canUseTool } = claudeCodeOptions(allowing, new AbortController(), null)
    if (!canUseTool) throw new Error('no canUseTool')

    expect(await canUseTool('Read', { file_path: path.join(outside, 'auth.md') }, ask)).toMatchObject({ behavior: 'allow' })
    expect(await canUseTool('Write', { file_path: path.join(outside, 'auth.md') }, ask)).toMatchObject({ behavior: 'deny' })
    expect(allowing.asked).toEqual([])
    expect(await canUseTool('mcp__slack__send_message', { channel: 'x', text: 'hi' }, { ...ask, title: 'Claude wants to send a Slack message' })).toMatchObject({
      behavior: 'allow'
    })
    expect(allowing.asked).toEqual([{ tool: 'mcp__slack__send_message', summary: '', title: 'Claude wants to send a Slack message' }])

    const denying = turn(root, 'deny')
    const denied = claudeCodeOptions(denying, new AbortController(), null).canUseTool
    expect(await denied?.('Bash', { command: 'curl https://example.com' }, ask)).toMatchObject({ behavior: 'deny' })
    expect(denying.asked).toEqual([{ tool: 'Bash', summary: 'curl https://example.com', title: null }])
  })

  it("keeps 'always' to this session, never the user's settings files", async () => {
    const { root } = await folders()
    const canUseTool = claudeCodeOptions(turn(root, 'always'), new AbortController(), null).canUseTool
    const suggestion: PermissionUpdate = {
      type: 'addRules',
      rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }],
      behavior: 'allow',
      destination: 'localSettings'
    }

    const result = await canUseTool?.('WebFetch', { url: 'https://example.com' }, { ...ask, suggestions: [suggestion] })

    expect(result).toMatchObject({ behavior: 'allow', updatedPermissions: [{ ...suggestion, destination: 'session' }] })
  })
})

describe('eventsFrom', () => {
  function delta(text: string, parent: string | null = null): SDKPartialAssistantMessage {
    return {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      parent_tool_use_id: parent,
      uuid: '00000000-0000-0000-0000-000000000000',
      session_id: 's'
    }
  }

  it("streams the agent's reply as text deltas", () => {
    expect([...eventsFrom(delta('Hel')), ...eventsFrom(delta('lo'))]).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' }
    ])
  })

  it("leaves out subagents' text and deltas that aren't text", () => {
    const toolInput: SDKPartialAssistantMessage = {
      ...delta(''),
      event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a"' } }
    }
    expect([...eventsFrom(delta('from a subagent', 'tool-1')), ...eventsFrom(toolInput)]).toEqual([])
  })
})
