import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Variables a parent Claude Code session, Orca or Superset sets for its own children. A Manta
 * started from one of their terminals inherits them, and tools in Manta's terminals would then
 * report to that parent: Orca's hooks in `~/.claude/settings.json` post to Orca when `ORCA_*` is set.
 * The user's own Claude Code configuration (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_*`) is kept.
 */
const SESSION_SCOPED: readonly RegExp[] = [
  /^CLAUDECODE$/,
  /^CLAUDE_PID$/,
  /^CLAUDE_EFFORT$/,
  /^CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN)$/,
  /^ORCA_/,
  /^SUPERSET_/,
  /^TERM_PROGRAM(_VERSION)?$/
]

export function withoutSessionScoped(env: NodeJS.ProcessEnv): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !SESSION_SCOPED.some((pattern) => pattern.test(key))) kept[key] = value
  }
  return kept
}

export interface TerminalEnvOptions {
  base: Record<string, string>
  terminalId: string
  root: string
  /** e.g. the hook server's port and token, for Claude terminals. */
  extra?: Record<string, string>
}

export function terminalEnv({ base, terminalId, root, extra }: TerminalEnvOptions): Record<string, string> {
  return {
    ...withoutSessionScoped(base),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'Manta',
    MANTA_TERMINAL_ID: terminalId,
    MANTA_ROOT: root,
    ...extra
  }
}

const MARKER = '__MANTA_ENV__'

/** Parses `env -0` output printed between two markers, ignoring whatever the shell's rc files print around it. */
export function parseEnvOutput(output: string): Record<string, string> | null {
  const start = output.indexOf(MARKER)
  const end = output.lastIndexOf(MARKER)
  if (start === -1 || end <= start) return null
  const env: Record<string, string> = {}
  for (const entry of output.slice(start + MARKER.length, end).split('\0')) {
    const equals = entry.indexOf('=')
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1)
  }
  return env
}

/**
 * The environment the user's interactive login shell sets up (PATH from `.zprofile` and `.zshrc`,
 * version managers), since an app launched from the Dock gets a minimal one. Falls back to `base`.
 */
export async function loginShellEnv(shell: string, base: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const fallback = withoutSessionScoped(base)
  try {
    const { stdout } = await execFileAsync(shell, ['-ilc', `printf '%s' ${MARKER}; command env -0; printf '%s' ${MARKER}`], {
      env: fallback,
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024
    })
    const env = parseEnvOutput(stdout)
    return env ? withoutSessionScoped(env) : fallback
  } catch {
    return fallback
  }
}

/** The first executable named `command` in a `PATH` value, like `command -v` but without starting a shell. */
export async function findOnPath(command: string, pathValue: string | undefined): Promise<string | null> {
  for (const dir of (pathValue ?? '').split(':')) {
    if (!path.isAbsolute(dir)) continue
    const candidate = path.join(dir, command)
    const executable = await access(candidate, constants.X_OK).then(() => stat(candidate)).then((s) => s.isFile(), () => false)
    if (executable) return candidate
  }
  return null
}
