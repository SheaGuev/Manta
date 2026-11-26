import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LanguageServerRole } from '../../shared/ipc'
import type { ServerLaunch } from '../lsp/serverCatalog'

/** What a recipe's launch knows: the installed package's commands, and where the project's own tools are. */
export interface LaunchContext {
  root: string
  /** Command name → path, from the installed Mason package; empty for a system server. */
  bins: Record<string, string>
  /** The root, then the project's main checkout: where `node_modules` may be. */
  toolRoots: string[]
}

/** What a recipe's settings know: the root, and the SchemaStore catalog when it has been fetched. */
export interface SettingsContext {
  root: string
  /** `node_modules` with the project's ESLint, from the launch. */
  nodePath: string | null
  schemas: { fileMatch: string[]; url: string }[]
}

/**
 * How Manta runs one language server: the launch settings Mason doesn't have (it only knows how
 * to install), written from nvim-lspconfig's specs for the core set.
 */
export interface Recipe {
  id: string
  name: string
  /** The Mason package that installs it; null for a server that comes with the system (Xcode's Swift). */
  package: string | null
  languages: string[]
  role: LanguageServerRole
  /** Part of the core set the Plugins view offers first. */
  core: boolean
  /** Works, but young or rough (JetBrains' Kotlin server). */
  beta: boolean
  description: string
  /** Starts only when one of these exists in the root: a linter without its project config only complains. */
  requires?: string[]
  /** Runs from the project's own install too (Biome), so it needs no plugin installed. */
  projectTool?: boolean
  launch: (context: LaunchContext) => Promise<ServerLaunch | null>
  settings?: (context: SettingsContext) => Record<string, unknown>
  initializationOptions?: unknown
  requests?: Record<string, (params: unknown) => unknown | Promise<unknown>>
}

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)

/** The installed command, or null when the package isn't installed. */
const bin =
  (command: string, args: string[]) =>
  async ({ bins }: LaunchContext): Promise<ServerLaunch | null> => {
    const file = bins[command]
    return file ? { command: file, args } : null
  }

/** CloudFormation's tags, so `serverless.yml` and templates don't show `!Ref` and `!GetAtt` as errors. */
const CLOUDFORMATION_TAGS = [
  '!And sequence',
  '!Base64 scalar',
  '!Cidr sequence',
  '!Condition scalar',
  '!Equals sequence',
  '!FindInMap sequence',
  '!GetAZs scalar',
  '!GetAtt scalar',
  '!GetAtt sequence',
  '!If sequence',
  '!ImportValue scalar',
  '!Join sequence',
  '!Not sequence',
  '!Or sequence',
  '!Ref scalar',
  '!Select sequence',
  '!Split sequence',
  '!Sub scalar',
  '!Sub sequence',
  '!Transform mapping'
]

const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml'
]
const GRAPHQL_CONFIGS = [
  'graphql.config.ts',
  'graphql.config.js',
  'graphql.config.cjs',
  'graphql.config.mjs',
  'graphql.config.json',
  'graphql.config.yml',
  'graphql.config.yaml',
  '.graphqlrc',
  '.graphqlrc.ts',
  '.graphqlrc.js',
  '.graphqlrc.json',
  '.graphqlrc.yml',
  '.graphqlrc.yaml'
]

/** The project's own Biome, so its version matches the project's `biome.json`; else the installed one. */
async function biomeLaunch({ bins, toolRoots }: LaunchContext): Promise<ServerLaunch | null> {
  for (const dir of toolRoots) {
    const own = path.join(dir, 'node_modules', '@biomejs', `cli-${process.platform}-${process.arch}`, 'biome')
    if (await exists(own)) return { command: own, args: ['lsp-proxy'] }
  }
  return bins.biome ? { command: bins.biome, args: ['lsp-proxy'] } : null
}

/** The `node_modules` the project's ESLint loads from: the worktree's, or the main checkout's for a fresh worktree. */
export async function eslintNodePath(toolRoots: string[]): Promise<string | null> {
  for (const dir of toolRoots) if (await exists(path.join(dir, 'node_modules', 'eslint'))) return path.join(dir, 'node_modules')
  return null
}

/** The project's virtualenv, so imports of its packages resolve; Pyright's own search otherwise. */
function venvPython(root: string): { pythonPath?: string } {
  const python = path.join(root, '.venv', 'bin', 'python')
  return existsSync(python) ? { pythonPath: python } : {}
}

/** The JSON server asks the client for schemas it can't fetch itself (`vscode/content`); only HTTPS ones. */
async function fetchSchema(params: unknown): Promise<string> {
  const url = Array.isArray(params) ? params[0] : params
  if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error(`Won't fetch schema ${String(url)}`)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Schema ${url}: ${response.status}`)
  return response.text()
}

/** The core set: the languages a typical TypeScript web and mobile stack uses, plus Python. TypeScript itself is built in (`typescriptServer`). */
export const RECIPES: Recipe[] = [
  {
    id: 'pyright',
    name: 'Pyright',
    package: 'pyright',
    languages: ['python'],
    role: 'primary',
    core: true,
    beta: false,
    description: 'Python types, completion, definitions and errors (Microsoft).',
    launch: bin('pyright-langserver', ['--stdio']),
    settings: ({ root }) => ({
      python: { ...venvPython(root), analysis: { autoSearchPaths: true, useLibraryCodeForTypes: true, diagnosticMode: 'openFilesOnly' } }
    })
  },
  {
    id: 'basedpyright',
    name: 'basedpyright',
    package: 'basedpyright',
    languages: ['python'],
    role: 'primary',
    core: false,
    beta: false,
    description: 'A fork of Pyright with stricter checks; use it instead of Pyright, not with it.',
    launch: bin('basedpyright-langserver', ['--stdio']),
    settings: ({ root }) => ({ python: venvPython(root), basedpyright: { analysis: { diagnosticMode: 'openFilesOnly' } } })
  },
  {
    id: 'ruff',
    name: 'Ruff',
    package: 'ruff',
    languages: ['python'],
    role: 'lint',
    core: true,
    beta: false,
    description: 'Python lint errors as you type; Cmd+S formats with it when the project configures Ruff.',
    launch: bin('ruff', ['server'])
  },
  {
    id: 'eslint',
    name: 'ESLint',
    package: 'eslint-lsp',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    role: 'lint',
    core: true,
    beta: false,
    description: "The project's ESLint rules as you type, in projects with an ESLint config.",
    requires: ESLINT_CONFIGS,
    launch: bin('vscode-eslint-language-server', ['--stdio']),
    /** ESLint asks for its settings with an empty section and stops without them. */
    settings: ({ root, nodePath }) => ({
      validate: 'on',
      packageManager: 'npm',
      useESLintClass: false,
      experimental: { useFlatConfig: true },
      codeAction: { disableRuleComment: { enable: true, location: 'separateLine' }, showDocumentation: { enable: true } },
      codeActionOnSave: { mode: 'all' },
      format: false,
      quiet: false,
      onIgnoredFiles: 'off',
      options: {},
      rulesCustomizations: [],
      run: 'onType',
      problems: { shortenToSingleLine: false },
      nodePath: nodePath ?? '',
      workingDirectory: { mode: 'location' },
      workspaceFolder: { uri: pathToFileURL(root).href, name: path.basename(root) }
    }),
    requests: {
      /** 4 is "approved": the project's ESLint may run. */
      'eslint/confirmESLintExecution': () => 4,
      'eslint/probeFailed': () => ({}),
      'eslint/noLibrary': () => ({}),
      'eslint/noConfig': () => ({}),
      'eslint/openDoc': () => ({})
    }
  },
  {
    id: 'biome',
    name: 'Biome',
    package: 'biome',
    languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'json', 'jsonc', 'graphql'],
    role: 'lint',
    core: true,
    beta: false,
    description: "Biome's lint rules as you type, in projects with a biome.json; uses the project's own Biome when installed.",
    requires: ['biome.json', 'biome.jsonc'],
    projectTool: true,
    launch: biomeLaunch
  },
  {
    id: 'yaml',
    name: 'YAML',
    package: 'yaml-language-server',
    languages: ['yaml'],
    role: 'primary',
    core: true,
    beta: false,
    description: 'YAML validated against its schema from SchemaStore (GitHub workflows, bitrise.yml, serverless.yml), with CloudFormation tags.',
    launch: bin('yaml-language-server', ['--stdio']),
    settings: () => ({
      yaml: {
        validate: true,
        hover: true,
        completion: true,
        format: { enable: true },
        schemaStore: { enable: true, url: 'https://www.schemastore.org/api/json/catalog.json' },
        customTags: CLOUDFORMATION_TAGS
      },
      redhat: { telemetry: { enabled: false } }
    })
  },
  {
    id: 'json',
    name: 'JSON',
    package: 'json-lsp',
    languages: ['json', 'jsonc'],
    role: 'primary',
    core: true,
    beta: false,
    description: 'JSON validated against its schema from SchemaStore (package.json, tsconfig.json, eas.json).',
    launch: bin('vscode-json-language-server', ['--stdio']),
    initializationOptions: { provideFormatter: true },
    settings: ({ schemas }) => ({ json: { validate: { enable: true }, format: { enable: true }, schemas } }),
    requests: { 'vscode/content': fetchSchema }
  },
  {
    id: 'graphql',
    name: 'GraphQL',
    package: 'graphql-language-service-cli',
    languages: ['graphql'],
    role: 'primary',
    core: true,
    beta: false,
    description: 'GraphQL completion, errors and go to definition against the schema in graphql.config.',
    requires: GRAPHQL_CONFIGS,
    launch: bin('graphql-lsp', ['server', '-m', 'stream'])
  },
  {
    id: 'terraform',
    name: 'Terraform',
    package: 'terraform-ls',
    languages: ['terraform', 'terraform-vars'],
    role: 'primary',
    core: true,
    beta: false,
    description: 'Terraform hovers, completion, errors and go to definition (HashiCorp).',
    launch: bin('terraform-ls', ['serve'])
  },
  {
    id: 'sourcekit',
    name: 'Swift',
    package: null,
    languages: ['swift'],
    role: 'primary',
    core: true,
    beta: false,
    description: "Swift through Xcode's sourcekit-lsp; best with a built project or a buildServer.json.",
    launch: async () => ((await exists('/usr/bin/xcrun')) ? { command: '/usr/bin/xcrun', args: ['sourcekit-lsp'] } : null)
  },
  {
    id: 'kotlin',
    name: 'Kotlin',
    package: 'kotlin-lsp',
    languages: ['kotlin'],
    role: 'primary',
    core: true,
    beta: true,
    description: "JetBrains' Kotlin language server. Young: expect gaps.",
    launch: bin('intellij-server', ['--stdio'])
  },
  {
    id: 'buf',
    name: 'Protobuf',
    package: 'buf',
    languages: ['proto'],
    role: 'primary',
    core: true,
    beta: false,
    description: 'Protobuf errors, completion and definitions through buf.',
    launch: bin('buf', ['lsp', 'serve'])
  },
  {
    id: 'bash',
    name: 'Bash',
    package: 'bash-language-server',
    languages: ['shellscript'],
    role: 'primary',
    core: true,
    beta: false,
    description: 'Shell script completion, hovers and errors (with shellcheck when installed).',
    launch: bin('bash-language-server', ['start'])
  }
]
