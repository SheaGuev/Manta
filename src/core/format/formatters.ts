import { spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { findOnPath } from '../terminal/terminalEnv'

/** A formatter that reads the file on stdin and writes the formatted text to stdout. */
export interface CommandFormatter {
  id: 'prettier' | 'biome' | 'ruff'
  /** Shown in the status bar: "Formatted with Prettier". */
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

const PRETTIER_CONFIGS = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.json5',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  '.prettierrc.cts',
  '.prettierrc.mts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
  'prettier.config.cts',
  'prettier.config.mts'
]
const BIOME_CONFIGS = ['biome.json', 'biome.jsonc']
const RUFF_CONFIGS = ['ruff.toml', '.ruff.toml']

const PRETTIER_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'json5', 'css', 'scss', 'less', 'html', 'vue', 'yaml', 'yml', 'graphql', 'gql', 'md', 'mdx'])
const BIOME_EXTENSIONS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts', 'json', 'jsonc', 'css', 'graphql', 'gql'])
const PYTHON_EXTENSIONS = new Set(['py', 'pyi'])

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)

/** The folders from the file's own up to `root`, nearest first: where a project's config can sit. */
function foldersUp(root: string, file: string): string[] {
  const folders: string[] = []
  for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
    folders.push(dir)
    if (dir === root) break
  }
  return folders
}

async function hasPrettierConfig(dir: string): Promise<boolean> {
  for (const name of PRETTIER_CONFIGS) if (await exists(path.join(dir, name))) return true
  const pkg = await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => null)
  if (!pkg) return false
  try {
    const parsed: unknown = JSON.parse(pkg)
    return typeof parsed === 'object' && parsed !== null && 'prettier' in parsed
  } catch {
    return false
  }
}

async function hasRuffConfig(dir: string): Promise<boolean> {
  for (const name of RUFF_CONFIGS) if (await exists(path.join(dir, name))) return true
  const pyproject = await readFile(path.join(dir, 'pyproject.toml'), 'utf8').catch(() => null)
  return pyproject !== null && /^\[tool\.ruff/m.test(pyproject)
}

/** The first of `candidates` (relative to a folder) that exists under any of `folders`, nearest first. */
async function findTool(folders: string[], candidates: string[]): Promise<string | null> {
  for (const dir of folders) for (const candidate of candidates) if (await exists(path.join(dir, candidate))) return path.join(dir, candidate)
  return null
}

export interface ResolveOptions {
  root: string
  /** Absolute path of the file. */
  file: string
  /**
   * Where else the project's tools may be installed: the project's main checkout, since a fresh
   * worktree usually has no `node_modules` of its own.
   */
  toolRoots: string[]
  /** Runs Prettier's JavaScript: Electron's own binary as Node in the app, `node` in tests. */
  node: string
  env: Record<string, string>
  /** Ruff installed as a Manta plugin, for a project that configures Ruff without installing it. */
  pluginRuff?: string | null
}

/**
 * The project's own formatter for a file, like its `lint:fix`: Prettier when the project has a Prettier
 * config and Prettier installed (it formats the types it's configured for, so Biome only lints there),
 * then Biome, then Ruff for Python. Null leaves it to the language server.
 */
export async function resolveFormatter(options: ResolveOptions): Promise<CommandFormatter | null> {
  const { root, file, node, env } = options
  const extension = path.extname(file).slice(1).toLowerCase()
  const configFolders = foldersUp(root, file)
  const toolFolders = [...configFolders, ...options.toolRoots.filter((r) => r !== root)]

  if (PRETTIER_EXTENSIONS.has(extension)) {
    const configured = await anyFolder(configFolders, hasPrettierConfig)
    const bin = configured ? await findTool(toolFolders, ['node_modules/prettier/bin/prettier.cjs', 'node_modules/prettier/bin-prettier.js']) : null
    if (bin) return { id: 'prettier', name: 'Prettier', command: node, args: [bin, '--stdin-filepath', file], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
  }
  if (BIOME_EXTENSIONS.has(extension)) {
    const configured = await findTool(configFolders, BIOME_CONFIGS)
    const bin = configured ? await findTool(toolFolders, [`node_modules/@biomejs/cli-${process.platform}-${process.arch}/biome`]) : null
    if (bin) return { id: 'biome', name: 'Biome', command: bin, args: ['format', `--stdin-file-path=${file}`], env }
  }
  if (PYTHON_EXTENSIONS.has(extension) && (await anyFolder(configFolders, hasRuffConfig))) {
    const bin = (await findTool(toolFolders, ['.venv/bin/ruff', 'venv/bin/ruff'])) ?? (await findOnPath('ruff', env.PATH)) ?? options.pluginRuff ?? null
    if (bin) return { id: 'ruff', name: 'Ruff', command: bin, args: ['format', '--stdin-filename', file, '-'], env }
  }
  return null
}

async function anyFolder(folders: string[], test: (dir: string) => Promise<boolean>): Promise<boolean> {
  for (const dir of folders) if (await test(dir)) return true
  return false
}

/**
 * The message from a formatter's error output: its first line, without Prettier's `[error]` tag or the
 * file's path; the code frame after it doesn't fit a status bar.
 */
export function firstErrorLine(stderr: string): string | null {
  const line = stderr.split('\n').map((l) => l.trim()).find(Boolean)
  if (!line) return null
  return line.replace(/^\[error\]\s*/, '').replace(/^[^\s:]*[/.][^\s:]*:\s+/, '')
}

/** How long a formatter gets before the save goes ahead without it. */
export const FORMAT_TIMEOUT_MS = 5000
const STDERR_LIMIT = 2000

/** Runs a formatter on `text`; rejects with the end of its error output when it fails or takes too long. */
export function runFormatter({ formatter, text, cwd, timeoutMs = FORMAT_TIMEOUT_MS }: { formatter: CommandFormatter; text: string; cwd: string; timeoutMs?: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(formatter.command, formatter.args, { cwd, env: formatter.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${formatter.name} took longer than ${timeoutMs / 1000} s`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      err = (err + chunk.toString('utf8')).slice(-STDERR_LIMIT)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`${formatter.name} didn't start: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(`${formatter.name} failed: ${firstErrorLine(err) ?? `exit ${code}`}`))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(text)
  })
}
