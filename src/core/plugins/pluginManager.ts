import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CustomServerInput, OpResult, PluginEntry, PluginServer } from '../../shared/ipc'
import type { LanguageServerSpec } from '../lsp/serverCatalog'
import { installPackage, type InstalledTool } from './installer'
import { installPlan, parsePurl, parseRegistry, type MasonPackage } from './masonRegistry'
import { eslintNodePath, RECIPES, type Recipe } from './recipes'
import { readZip } from './zip'

const REGISTRY_URL = 'https://github.com/mason-org/mason-registry/releases/latest/download/registry.json.zip'
const SCHEMA_CATALOG_URL = 'https://www.schemastore.org/api/json/catalog.json'
/** Mason publishes a new registry a few times a day; a day old is fresh enough to browse. */
const REGISTRY_MAX_AGE_MS = 24 * 60 * 60_000
const SCHEMAS_MAX_AGE_MS = 7 * 24 * 60 * 60_000

interface CustomServer extends CustomServerInput {
  id: string
}

/** `<plugins dir>/plugins.json`: what's installed, what's switched off, custom servers, the editor theme. */
export interface PluginState {
  tools: Record<string, InstalledTool>
  /** Server ids the user switched off. */
  disabled: string[]
  custom: CustomServer[]
  /** The editor theme's data, as the renderer applies it; null for Manta's own colours. */
  theme: unknown
}

const EMPTY: PluginState = { tools: {}, disabled: [], custom: [], theme: null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTool(value: unknown): InstalledTool | null {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.version !== 'string' || !isRecord(value.bins)) return null
  const bins = Object.fromEntries(Object.entries(value.bins).filter((e): e is [string, string] => typeof e[1] === 'string'))
  return { name: value.name, version: value.version, bins, installedAt: typeof value.installedAt === 'string' ? value.installedAt : '' }
}

function parseCustom(value: unknown): CustomServer | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.package !== 'string' || typeof value.command !== 'string') return null
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
  return { id: value.id, package: value.package, command: value.command, args: strings(value.args), languages: strings(value.languages) }
}

/** Unreadable entries are dropped, and an unreadable file reads as empty. */
export function parsePluginState(value: unknown): PluginState {
  if (!isRecord(value)) return EMPTY
  const tools: Record<string, InstalledTool> = {}
  if (isRecord(value.tools)) for (const [name, entry] of Object.entries(value.tools)) {
    const tool = parseTool(entry)
    if (tool) tools[name] = tool
  }
  return {
    tools,
    disabled: Array.isArray(value.disabled) ? value.disabled.filter((s): s is string => typeof s === 'string') : [],
    custom: Array.isArray(value.custom) ? value.custom.flatMap((c) => parseCustom(c) ?? []) : [],
    theme: value.theme ?? null
  }
}

const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

async function writeAtomic(file: string, json: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(`${file}.tmp`, `${JSON.stringify(json, null, 2)}\n`)
  await rename(`${file}.tmp`, file)
}

export interface PluginManagerOptions {
  /** `<userData>/plugins`: `plugins.json`, the cached registry and schemas, and `tools/`. */
  dir: string
  env: () => Promise<Record<string, string>>
  /** Servers that need no plugin: TypeScript. They come first in the catalog. */
  builtIn: LanguageServerSpec[]
  /** The root, then the project's main checkout: where a worktree's `node_modules` may be. */
  toolRoots: (root: string) => Promise<string[]>
  fetch?: typeof fetch
  now?: () => number
}

/**
 * Plugins: language servers, linters and formatters installed from Mason's registry into Manta's
 * own tools folder, run with Manta's recipes. Nothing a plugin ships runs inside Manta; its
 * servers are separate processes, like the user's own tools.
 */
export class PluginManager {
  private state: PluginState = EMPTY
  private schemas: { fileMatch: string[]; url: string }[] = []
  private readonly nodePaths = new Map<string, string | null>()
  private queue: Promise<unknown> = Promise.resolve()
  /** Resolves once the SchemaStore catalog is loaded (or failed to); JSON's settings use it from then on. */
  schemasLoaded: Promise<void> = Promise.resolve()
  private readonly fetch: typeof fetch
  private readonly now: () => number

  private constructor(private readonly options: PluginManagerOptions) {
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  static async open(options: PluginManagerOptions): Promise<PluginManager> {
    const manager = new PluginManager(options)
    manager.state = parsePluginState(await readJson(manager.stateFile))
    /** Schemas only improve JSON validation, so a slow or failed fetch never holds up opening. */
    manager.schemasLoaded = manager.loadSchemas().catch((error: unknown) => console.warn('manta: SchemaStore catalog', error))
    return manager
  }

  private get stateFile(): string {
    return path.join(this.options.dir, 'plugins.json')
  }

  get toolsDir(): string {
    return path.join(this.options.dir, 'tools')
  }

  /** The servers to run, built-in first: recipes whose package is installed (or not needed) and that aren't switched off. */
  specs(): LanguageServerSpec[] {
    const fromRecipes = RECIPES.filter((recipe) => !this.state.disabled.includes(recipe.id) && (recipe.package === null || recipe.projectTool || this.state.tools[recipe.package])).map((recipe) => this.spec(recipe))
    const custom = this.state.custom.filter((c) => !this.state.disabled.includes(c.id) && this.state.tools[c.package]).map((c) => this.customSpec(c))
    return [...this.options.builtIn, ...fromRecipes, ...custom]
  }

  private spec(recipe: Recipe): LanguageServerSpec {
    return {
      id: recipe.id,
      name: recipe.name,
      languages: recipe.languages,
      role: recipe.role,
      initializationOptions: recipe.initializationOptions,
      ...(recipe.requests ? { requests: recipe.requests } : {}),
      launch: async (root) => {
        if (recipe.requires && !(await Promise.all(recipe.requires.map((name) => exists(path.join(root, name))))).some(Boolean)) return null
        const toolRoots = await this.options.toolRoots(root)
        if (recipe.id === 'eslint') this.nodePaths.set(root, await eslintNodePath(toolRoots))
        const bins = recipe.package ? (this.state.tools[recipe.package]?.bins ?? {}) : {}
        return recipe.launch({ root, bins, toolRoots })
      },
      settings: (root) => recipe.settings?.({ root, nodePath: this.nodePaths.get(root) ?? null, schemas: this.schemas }) ?? {}
    }
  }

  private customSpec(custom: CustomServer): LanguageServerSpec {
    return {
      id: custom.id,
      name: custom.package,
      languages: custom.languages,
      role: 'primary',
      launch: async () => {
        const command = this.state.tools[custom.package]?.bins[custom.command] ?? null
        return command ? { command, args: custom.args } : null
      }
    }
  }

  /** Mason's registry, from the cache unless it's a day old or `refresh` is set; the cache when offline. */
  async registry({ refresh }: { refresh: boolean }): Promise<MasonPackage[]> {
    const cache = path.join(this.options.dir, 'registry.json')
    const cached = await readJson(cache)
    const fetchedAt = isRecord(cached) && typeof cached.fetchedAt === 'number' ? cached.fetchedAt : 0
    if (isRecord(cached) && !refresh && this.now() - fetchedAt < REGISTRY_MAX_AGE_MS) return parseRegistry(cached.packages)
    try {
      const response = await this.fetch(REGISTRY_URL)
      if (!response.ok) throw new Error(`Mason registry: ${response.status} ${response.statusText}`)
      const json = readZip(Buffer.from(await response.arrayBuffer())).get('registry.json')
      if (!json) throw new Error('Mason registry download has no registry.json')
      const packages: unknown = JSON.parse(json.toString('utf8'))
      const parsed = parseRegistry(packages)
      await writeAtomic(cache, { fetchedAt: this.now(), packages })
      return parsed
    } catch (error) {
      if (isRecord(cached)) return parseRegistry(cached.packages)
      throw error
    }
  }

  /** Every Mason package, plus system servers, for the Plugins view; installed and core ones first. */
  async entries({ refresh }: { refresh: boolean }): Promise<PluginEntry[]> {
    const packages = await this.registry({ refresh })
    const serverOf = (id: string, recipe: Pick<Recipe, 'name' | 'role' | 'languages' | 'core' | 'beta' | 'description'>): PluginServer => ({
      id,
      name: recipe.name,
      role: recipe.role,
      languages: recipe.languages,
      enabled: !this.state.disabled.includes(id),
      core: recipe.core,
      beta: recipe.beta,
      description: recipe.description
    })
    const entries: PluginEntry[] = packages.map((pkg) => {
      const plan = installPlan(pkg)
      const tool = this.state.tools[pkg.name]
      const servers = [
        ...RECIPES.filter((r) => r.package === pkg.name).map((r) => serverOf(r.id, r)),
        ...this.state.custom.filter((c) => c.package === pkg.name).map((c) => serverOf(c.id, { name: c.package, role: 'primary', languages: c.languages, core: false, beta: false, description: `${c.command} ${c.args.join(' ')}` }))
      ]
      return {
        name: pkg.name,
        description: pkg.description,
        homepage: pkg.homepage,
        languages: pkg.languages,
        categories: pkg.categories,
        version: parsePurl(pkg.sourceId)?.version ?? null,
        installed: tool ? { version: tool.version, installedAt: tool.installedAt } : null,
        servers,
        unsupported: 'unsupported' in plan ? plan.unsupported : null
      }
    })
    const system = RECIPES.filter((r) => r.package === null).map((r) => ({
      name: r.id,
      description: r.description,
      homepage: '',
      languages: r.languages,
      categories: ['LSP'],
      version: null,
      installed: { version: 'system', installedAt: '' },
      servers: [serverOf(r.id, r)],
      unsupported: null
    }))
    const rank = (e: PluginEntry): number => (e.installed ? 0 : e.servers.some((s) => s.core) ? 1 : e.servers.length > 0 ? 2 : 3)
    return [...system, ...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  }

  install({ name, onProgress }: { name: string; onProgress?: (line: string) => void }): Promise<OpResult> {
    return this.serial(async () => {
      const pkg = (await this.registry({ refresh: false })).find((p) => p.name === name)
      if (!pkg) return { ok: false, message: `${name} isn't in Mason's registry` }
      try {
        const tool = await installPackage({ pkg, toolsDir: this.toolsDir, env: await this.options.env(), fetch: this.fetch, ...(onProgress ? { onProgress } : {}) })
        await this.save({ ...this.state, tools: { ...this.state.tools, [name]: tool } })
        return { ok: true, message: `Installed ${name} ${tool.version}` }
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  remove(name: string): Promise<OpResult> {
    return this.serial(async () => {
      if (!this.state.tools[name]) return { ok: false, message: `${name} isn't installed` }
      await rm(path.join(this.toolsDir, name), { recursive: true, force: true })
      const { [name]: _removed, ...tools } = this.state.tools
      await this.save({ ...this.state, tools, custom: this.state.custom.filter((c) => c.package !== name) })
      return { ok: true, message: `Removed ${name}` }
    })
  }

  setEnabled({ server, enabled }: { server: string; enabled: boolean }): Promise<void> {
    return this.serial(async () => {
      const disabled = this.state.disabled.filter((id) => id !== server)
      await this.save({ ...this.state, disabled: enabled ? disabled : [...disabled, server] })
    })
  }

  /** A server for an installed package without a recipe, from the command and languages the user gave. */
  addCustom(input: CustomServerInput): Promise<OpResult> {
    return this.serial(async () => {
      const tool = this.state.tools[input.package]
      if (!tool) return { ok: false, message: `Install ${input.package} first` }
      if (!tool.bins[input.command]) return { ok: false, message: `${input.package} has no ${input.command} command; it has ${Object.keys(tool.bins).join(', ') || 'none'}` }
      if (input.languages.length === 0) return { ok: false, message: 'Give at least one language id, such as rust or lua' }
      const id = `custom:${input.package}`
      await this.save({ ...this.state, custom: [...this.state.custom.filter((c) => c.id !== id), { ...input, id }] })
      return { ok: true, message: `${input.package} now runs for ${input.languages.join(', ')}` }
    })
  }

  /** An installed package's command, e.g. Ruff's for Cmd+S; null when it isn't installed. */
  installedCommand({ pkg, command }: { pkg: string; command: string }): string | null {
    return this.state.tools[pkg]?.bins[command] ?? null
  }

  get theme(): unknown {
    return this.state.theme
  }

  setTheme(theme: unknown): Promise<void> {
    return this.serial(() => this.save({ ...this.state, theme }))
  }

  private async loadSchemas(): Promise<void> {
    const cache = path.join(this.options.dir, 'schemastore.json')
    const cached = await readJson(cache)
    const fetchedAt = isRecord(cached) && typeof cached.fetchedAt === 'number' ? cached.fetchedAt : 0
    let catalog: unknown = isRecord(cached) ? cached.catalog : null
    if (!catalog || this.now() - fetchedAt > SCHEMAS_MAX_AGE_MS) {
      const response = await this.fetch(SCHEMA_CATALOG_URL)
      if (response.ok) {
        catalog = await response.json()
        await writeAtomic(cache, { fetchedAt: this.now(), catalog })
      }
    }
    const schemas = isRecord(catalog) && Array.isArray(catalog.schemas) ? catalog.schemas : []
    this.schemas = schemas.flatMap((s: unknown) =>
      isRecord(s) && typeof s.url === 'string' && Array.isArray(s.fileMatch) && s.fileMatch.length > 0 ? [{ url: s.url, fileMatch: s.fileMatch.filter((m): m is string => typeof m === 'string') }] : []
    )
  }

  private async save(state: PluginState): Promise<void> {
    this.state = state
    await writeAtomic(this.stateFile, state)
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    /** The caller sees the failure; later tasks still run. */
    this.queue = next.catch(() => undefined)
    return next
  }
}
