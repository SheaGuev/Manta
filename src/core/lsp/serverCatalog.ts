import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LanguageServerRole } from '../../shared/ipc'

export interface ServerLaunch {
  command: string
  args: string[]
  /** Added to the environment the host starts servers with. */
  env?: Record<string, string>
}

/** A language server Manta knows how to start, and the languages it serves. */
export interface LanguageServerSpec {
  id: string
  /** Shown in the status bar, e.g. "TypeScript". */
  name: string
  /** LSP language ids, as `languageIdFor` (`shared/languages.ts`) returns them. */
  languages: readonly string[]
  /**
   * `primary` drives completion, hover and definitions; one per file. `lint` servers (ESLint, Biome,
   * Ruff) run beside it and only add their errors and warnings.
   */
  role: LanguageServerRole
  /** How to start it for a root; null when it isn't available there (not installed, or no config). */
  launch: (root: string) => Promise<ServerLaunch | null>
  /** What the server gets for `workspace/configuration`, by section; servers like ESLint stop without it. */
  settings?: (root: string) => Record<string, unknown>
  /** Sent by the client in `initialize`. */
  initializationOptions?: unknown
  /** Answers to requests only this server sends, such as ESLint's `eslint/confirmESLintExecution`. */
  requests?: Record<string, (params: unknown) => unknown | Promise<unknown>>
}

/** Where TypeScript 7's native binary sits inside a `node_modules`. */
export function nativeTypescriptBinary(nodeModules: string): string {
  return path.join(nodeModules, '@typescript', `typescript-${process.platform}-${process.arch}`, 'lib', 'tsc')
}

async function projectNativeTypescript(root: string): Promise<string | null> {
  const nodeModules = path.join(root, 'node_modules')
  try {
    const pkg: unknown = JSON.parse(await readFile(path.join(nodeModules, 'typescript', 'package.json'), 'utf8'))
    const version = typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : ''
    if (Number(version.split('.')[0]) < 7) return null
    const binary = nativeTypescriptBinary(nodeModules)
    await access(binary)
    return binary
  } catch {
    return null
  }
}

/**
 * TypeScript and JavaScript through TypeScript 7's own language server (`tsc --lsp --stdio`), native
 * code with no Node wrapper. A project on TypeScript 7 or later gets its own copy, so types match its
 * version; anything older, or a worktree without `node_modules`, gets the copy bundled with Manta.
 */
export function typescriptServer({ bundledBinary }: { bundledBinary: string }): LanguageServerSpec {
  return {
    id: 'typescript',
    name: 'TypeScript',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    role: 'primary',
    launch: async (root) => ({ command: (await projectNativeTypescript(root)) ?? bundledBinary, args: ['--lsp', '--stdio'] })
  }
}
