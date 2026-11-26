#!/usr/bin/env node
/**
 * A stand-in for `claude` in Manta's terminal tests and e2e runs (MANTA_FAKE_AGENT=1). Reads the
 * hooks from `--settings` and runs them like Claude Code does (through a shell, payload on stdin),
 * so Manta's real hook command and server are exercised. Spends nothing.
 *
 * Each line typed is a prompt: `ask <thing>` asks permission (answer y/n), `work <seconds>` stays
 * busy that long, `askafter <seconds> <thing>` works that long then asks permission, `propose <doc>|<find>|<replace>|<why>` calls Manta's `propose_doc_change` tool
 * through `--mcp-config`, `revise <thread>|<find>|<replace>|<why>` and `withdraw <thread>|<why>` call
 * `revise_doc_change` and `withdraw_doc_change` (`last` is the last proposal's id), `tool <name> <json args>` calls any of Manta's tools, `exit` or `/exit` quits; anything else gets a short reply. A first argument that
 * isn't an option is the first prompt, as with `claude "<prompt>"`. Bracketed paste is on, as in Claude Code's TUI:
 * a pasted block of lines is one prompt, named by its first line. Prints the brief's marker line
 * (`--append-system-prompt-file`, an implementation's or a context map's) and the `--add-dir` folders, so tests can see what it was given. Context a `UserPromptSubmit` hook returns is printed as `Context: …`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? null)
}
const settingsFile = option('--settings')
const resumed = option('--resume')
const sessionId = resumed ?? option('--session-id') ?? randomUUID()
const firstPrompt = args[0] !== undefined && !args[0].startsWith('-') ? args[0].trim() : null
const briefFile = option('--append-system-prompt-file')
const mcpConfig = option('--mcp-config')
const addDirIndex = args.indexOf('--add-dir')
const addDirs = []
for (let i = addDirIndex + 1; addDirIndex !== -1 && i < args.length && !args[i].startsWith('-'); i++) addDirs.push(args[i])
const hooks = settingsFile ? (JSON.parse(readFileSync(settingsFile, 'utf8')).hooks ?? {}) : {}

/** Runs the event's hooks; context a `UserPromptSubmit` hook adds is printed as `Context: …`, as if the model saw it. */
function fire(event, fields = {}) {
  const payload = JSON.stringify({ session_id: sessionId, cwd: process.cwd(), hook_event_name: event, ...fields })
  for (const entry of hooks[event] ?? []) {
    for (const hook of entry.hooks ?? []) {
      const ran = spawnSync('/bin/sh', ['-c', hook.command], { input: payload, env: process.env, encoding: 'utf8' })
      if (event !== 'UserPromptSubmit') continue
      try {
        const context = JSON.parse(ran.stdout || '{}')?.hookSpecificOutput?.additionalContext
        if (context) say(`Context: ${context.replace(/\n/g, ' | ')}`)
      } catch {
        /** Not JSON: Claude Code ignores it too. */
      }
    }
  }
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const say = (text) => process.stdout.write(`${text}\r\n`)
const prompt = () => process.stdout.write('\x1b[36mfake-claude>\x1b[0m ')

process.stdout.write('\x1b[?2004h')
say(`\x1b[1mFake Claude\x1b[0m session ${sessionId}${resumed ? ' (resumed)' : ''}`)
if (briefFile) {
  const brief = existsSync(briefFile) ? readFileSync(briefFile, 'utf8') : ''
  say(`Brief: ${brief.split('\n').find((line) => line.includes('Manta thread') || line.includes('Manta map')) ?? `(${brief.length} chars)`}`)
}
if (addDirs.length > 0) say(`Added dirs: ${addDirs.join(' ')}`)
fire('SessionStart', { source: resumed ? 'resume' : 'startup' })
prompt()

const lines = readline.createInterface({ input: process.stdin })
let answer = null
let lastProposal = ''

/** Lines of a bracketed paste so far; null outside one. */
let pasted = null
/** A paste waiting for another Enter. */
let held = null

lines.on('line', (line) => {
  if (held !== null && line === '') {
    const text = held
    held = null
    return handle(text)
  }
  if (pasted === null && !line.includes(PASTE_START)) return handle(line)
  pasted = [...(pasted ?? []), line.replace(PASTE_START, '')]
  if (!line.includes(PASTE_END)) return
  const text = pasted.join('\n').replace(PASTE_END, '')
  pasted = null
  /** Stand-ins for a TUI that drops the Enter after a paste: one takes a second Enter, the other never submits. */
  if (text === 'never submits') return
  if (text === 'needs second enter') return (held = text)
  handle(text)
})
if (firstPrompt) {
  say(firstPrompt)
  handle(firstPrompt)
}

async function handle(line) {
  const text = line.trim()
  if (answer) return answer(text)
  /** Enter on an empty input submits nothing, as in Claude Code. */
  if (text === '') return prompt()
  if (text === 'exit' || text === '/exit') {
    fire('SessionEnd', { reason: 'prompt_input_exit' })
    process.exit(0)
  }
  fire('UserPromptSubmit', { prompt: text })
  if (text.startsWith('ask ')) {
    await askPermission(text.slice(4))
  } else if (text.startsWith('propose ')) {
    const [doc, find, replace, why] = text.slice(8).split('|')
    const reply = await docTool('propose_doc_change', { doc, find, replace, title: `Update ${doc}`, why })
    lastProposal = /thread (t_[0-9a-f]+)/.exec(reply)?.[1] ?? lastProposal
  } else if (text.startsWith('revise ')) {
    const [thread, find, replace, why] = text.slice(7).split('|')
    await docTool('revise_doc_change', { thread: thread === 'last' ? lastProposal : thread, find, replace, why })
  } else if (text.startsWith('withdraw ')) {
    const [thread, why] = text.slice(9).split('|')
    await docTool('withdraw_doc_change', { thread: thread === 'last' ? lastProposal : thread, why })
  } else if (text.startsWith('tool ')) {
    const [, name, ...json] = text.split(' ')
    await docTool(name, JSON.parse(json.join(' ') || '{}'))
  } else if (text.startsWith('askafter ')) {
    const [seconds, ...rest] = text.slice(9).split(' ')
    fire('PreToolUse', { tool_name: 'Read' })
    await sleep(Number(seconds) * 1000)
    await askPermission(rest.join(' '))
  } else if (text.startsWith('work ')) {
    fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep' } })
    await sleep(Number(text.slice(5)) * 1000)
    fire('PostToolUse', { tool_name: 'Bash' })
    say('Done working.')
  } else {
    say(`Scripted reply to: ${text.split('\n')[0]}`)
  }
  fire('Stop')
  prompt()
}

/** Asks to run `command` and waits for y/n, firing the hooks Claude Code fires around a permission prompt. */
async function askPermission(command) {
  fire('PreToolUse', { tool_name: 'Bash', tool_input: { command } })
  fire('PermissionRequest', { tool_name: 'Bash' })
  fire('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' })
  process.stdout.write(`Allow Bash: ${command}? (y/n) `)
  const reply = await new Promise((resolve) => (answer = resolve))
  answer = null
  if (reply === 'y') {
    fire('PostToolUse', { tool_name: 'Bash' })
    say('Ran it.')
  } else {
    say('Denied.')
  }
}

/** Calls one of Manta's doc tools between the hooks Claude Code fires around it, and prints its answer. */
async function docTool(name, args) {
  fire('PreToolUse', { tool_name: `mcp__manta__${name}` })
  const reply = await callTool(name, args)
  say(reply)
  fire('PostToolUse', { tool_name: `mcp__manta__${name}` })
  return reply
}

/** One `tools/call` to the MCP server Manta passed with `--mcp-config`, as Claude Code would make it. */
async function callTool(name, args) {
  const server = mcpConfig ? Object.values(JSON.parse(mcpConfig).mcpServers ?? {})[0] : null
  if (!server) return 'Tool error: no MCP server'
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { ...server.headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const answer = await response.json()
  const text = answer.result?.content?.[0]?.text ?? answer.error?.message ?? `HTTP ${response.status}`
  return answer.result?.isError || answer.error ? `Tool error: ${text}` : `Tool: ${text}`
}
