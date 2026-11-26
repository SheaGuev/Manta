import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ClaudeCodeStatus } from '../../shared/ipc'

const execFileAsync = promisify(execFile)

/** `claude --version` prints e.g. `2.1.285 (Claude Code)`. */
export function parseVersion(output: string): string | null {
  return /\d+\.\d+\.\d+\S*/.exec(output)?.[0] ?? null
}

/** `claude auth status --json`: `{ loggedIn, authMethod, apiProvider, ... }`. */
export function parseAuthStatus(value: unknown): Pick<ClaudeCodeStatus, 'loggedIn' | 'authMethod' | 'apiProvider'> {
  if (typeof value !== 'object' || value === null) return { loggedIn: false, authMethod: null, apiProvider: null }
  const loggedIn = 'loggedIn' in value && value.loggedIn === true
  const authMethod = 'authMethod' in value && typeof value.authMethod === 'string' ? value.authMethod : null
  const apiProvider = 'apiProvider' in value && typeof value.apiProvider === 'string' ? value.apiProvider : null
  return { loggedIn, authMethod, apiProvider }
}

/**
 * Whether thread agents can run: which `claude` they use and whether it is signed in. `executable`
 * is the user's own install; null means threads fall back to the copy bundled with the Agent SDK.
 */
export async function claudeCodeStatus(executable: string | null): Promise<ClaudeCodeStatus> {
  if (!executable) {
    return { path: null, version: null, loggedIn: false, authMethod: null, apiProvider: null, error: null }
  }
  try {
    const [version, auth] = await Promise.all([
      execFileAsync(executable, ['--version'], { timeout: 15_000 }),
      // `auth status` exits non-zero when signed out but still prints its JSON.
      execFileAsync(executable, ['auth', 'status', '--json'], { timeout: 15_000 }).catch((error: unknown) =>
        error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? { stdout: error.stdout } : Promise.reject(error)
      )
    ])
    return { path: executable, version: parseVersion(version.stdout), ...parseAuthStatus(JSON.parse(auth.stdout)), error: null }
  } catch (error) {
    return {
      path: executable,
      version: null,
      loggedIn: false,
      authMethod: null,
      apiProvider: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
