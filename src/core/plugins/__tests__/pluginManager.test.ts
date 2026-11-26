import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { LanguageServerSpec } from '../../lsp/serverCatalog'
import { PluginManager, parsePluginState } from '../pluginManager'

const dirs: string[] = []
/** Each manager caches the SchemaStore catalog in the background; it must finish before its folder goes. */
const managers: PluginManager[] = []
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.schemasLoaded))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manta-plugins-'))
  dirs.push(dir)
  return dir
}

let server: Server
let base = ''
const served = new Map<string, Buffer>()
beforeAll(async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'manta-plugin-assets-'))
  await writeFile(path.join(work, 'terraform-ls'), '#!/bin/sh\necho terraform-ls\n', { mode: 0o755 })
  execFileSync('zip', ['-q', 'terraform-ls.zip', 'terraform-ls'], { cwd: work })
  served.set('/terraform-ls.zip', await readFile(path.join(work, 'terraform-ls.zip')))
  await rm(work, { recursive: true, force: true })
  server = createServer((req, res) => {
    const body = served.get(req.url ?? '')
    res.writeHead(body ? 200 : 404)
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** Mason's registry as it's published: `registry.json` inside a zip. */
async function registryZip(packages: unknown[]): Promise<Buffer> {
  const work = await tempDir()
  await writeFile(path.join(work, 'registry.json'), JSON.stringify(packages))
  execFileSync('zip', ['-q', 'registry.json.zip', 'registry.json'], { cwd: work })
  return readFile(path.join(work, 'registry.json.zip'))
}

/** A generic-download package like terraform-ls; `name` and `command` let one fixture stand in for others. */
const terraform = (name = 'terraform-ls', command = 'terraform-ls') => ({
  name,
  description: 'Terraform Language Server',
  homepage: 'https://github.com/hashicorp/terraform-ls',
  languages: ['Terraform'],
  categories: ['LSP'],
  source: { id: 'pkg:generic/hashicorp/terraform-ls@v0.39.0', download: [{ target: ['darwin', 'linux'], files: { 'terraform-ls.zip': `${base}/terraform-ls.zip` }, bin: 'terraform-ls' }] },
  bin: { [command]: '{{source.download.bin}}' }
})
const gem = { name: 'solargraph', description: 'Ruby', homepage: '', languages: ['Ruby'], categories: ['LSP'], source: { id: 'pkg:gem/solargraph@0.50.0' }, bin: {} }
const builtIn: LanguageServerSpec = { id: 'typescript', name: 'TypeScript', languages: ['typescript'], role: 'primary', launch: async () => null }

async function manager(options: { dir?: string; registry?: unknown[]; offline?: boolean; now?: () => number } = {}) {
  const dir = options.dir ?? (await tempDir())
  const zip = await registryZip(options.registry ?? [terraform(), gem])
  let registryFetches = 0
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input)
    if (url.includes('mason-registry')) {
      registryFetches++
      if (options.offline) throw new Error('offline')
      return new Response(new Uint8Array(zip))
    }
    if (url.includes('schemastore')) return new Response(JSON.stringify({ schemas: [{ name: 'pkg', fileMatch: ['package.json'], url: 'https://json.schemastore.org/package.json' }, { name: 'none', url: 'x' }] }))
    return fetch(url)
  }
  const plugins = await PluginManager.open({
    dir,
    env: async () => ({ PATH: process.env.PATH ?? '' }),
    builtIn: [builtIn],
    toolRoots: async (root) => [root],
    fetch: fakeFetch,
    ...(options.now ? { now: options.now } : {})
  })
  managers.push(plugins)
  return { plugins, dir, fetches: () => registryFetches }
}

describe('PluginManager', () => {
  it('starts with only the built-in servers and those that need no install (Swift)', async () => {
    const { plugins } = await manager()
    expect(plugins.specs().map((s) => s.id)).toEqual(['typescript', 'biome', 'sourcekit'])
  })

  it('installs a package, after which its recipe runs with the installed command', async () => {
    const { plugins } = await manager()
    expect(await plugins.install({ name: 'terraform-ls' })).toEqual({ ok: true, message: 'Installed terraform-ls v0.39.0' })
    const spec = plugins.specs().find((s) => s.id === 'terraform')
    const launch = await spec?.launch(await tempDir())
    expect(launch?.args).toEqual(['serve'])
    expect(execFileSync(launch?.command ?? '', { encoding: 'utf8' }).trim()).toBe('terraform-ls')
  })

  it('remembers installs across a reopen, and forgets them after a remove', async () => {
    const first = await manager()
    await first.plugins.install({ name: 'terraform-ls' })
    const again = await manager({ dir: first.dir })
    expect(again.plugins.specs().some((s) => s.id === 'terraform')).toBe(true)
    expect(await again.plugins.remove('terraform-ls')).toEqual({ ok: true, message: 'Removed terraform-ls' })
    expect(again.plugins.specs().some((s) => s.id === 'terraform')).toBe(false)
    expect(await again.plugins.remove('terraform-ls')).toEqual({ ok: false, message: "terraform-ls isn't installed" })
  })

  it('leaves a switched-off server out, and puts it back when switched on', async () => {
    const { plugins } = await manager()
    await plugins.install({ name: 'terraform-ls' })
    await plugins.setEnabled({ server: 'terraform', enabled: false })
    expect(plugins.specs().some((s) => s.id === 'terraform')).toBe(false)
    await plugins.setEnabled({ server: 'terraform', enabled: true })
    expect(plugins.specs().some((s) => s.id === 'terraform')).toBe(true)
  })

  it('starts a linter only in a project with its config', async () => {
    const { plugins } = await manager()
    const biome = plugins.specs().find((s) => s.id === 'biome')
    const root = await tempDir()
    expect(await biome?.launch(root)).toBeNull()
    await writeFile(path.join(root, 'biome.json'), '{}')
    const own = path.join(root, `node_modules/@biomejs/cli-${process.platform}-${process.arch}/biome`)
    await mkdir(path.dirname(own), { recursive: true })
    await writeFile(own, '')
    expect(await biome?.launch(root)).toEqual({ command: own, args: ['lsp-proxy'] })
  })

  it('lists packages for the Plugins view: system servers, then core ones, with why one can\'t install', async () => {
    const { plugins } = await manager()
    const entries = await plugins.entries({ refresh: false })
    expect(entries.map((e) => e.name)).toEqual(['sourcekit', 'terraform-ls', 'solargraph'])
    expect(entries[1]).toMatchObject({ version: 'v0.39.0', installed: null, servers: [{ id: 'terraform', core: true, enabled: true }], unsupported: null })
    expect(entries[2]).toMatchObject({ servers: [], unsupported: "Installing gem packages isn't supported yet" })
  })

  it('reads the registry from its cache while fresh, refetches when asked, and uses the cache when offline', async () => {
    let now = 1_000_000
    const first = await manager({ now: () => now })
    await first.plugins.registry({ refresh: false })
    await first.plugins.registry({ refresh: false })
    expect(first.fetches()).toBe(1)
    await first.plugins.registry({ refresh: true })
    expect(first.fetches()).toBe(2)
    now += 2 * 24 * 60 * 60_000
    const offline = await manager({ dir: first.dir, offline: true, now: () => now })
    expect((await offline.plugins.registry({ refresh: false })).map((p) => p.name)).toEqual(['terraform-ls', 'solargraph'])
  })

  it('fails to browse offline with nothing cached', async () => {
    const { plugins } = await manager({ offline: true })
    await expect(plugins.registry({ refresh: false })).rejects.toThrow('offline')
  })

  it('refuses to install what isn\'t in the registry, and says why an install fails', async () => {
    const { plugins } = await manager()
    expect(await plugins.install({ name: 'nope' })).toEqual({ ok: false, message: "nope isn't in Mason's registry" })
    expect(await plugins.install({ name: 'solargraph' })).toEqual({ ok: false, message: "Installing gem packages isn't supported yet" })
  })

  it('runs an installed package without a recipe as a custom server, once given its command and languages', async () => {
    const { plugins } = await manager({ registry: [terraform('mystery-ls', 'mystery-ls')] })
    expect(await plugins.addCustom({ package: 'mystery-ls', command: 'mystery-ls', args: ['--stdio'], languages: ['mystery'] })).toEqual({ ok: false, message: 'Install mystery-ls first' })
    await plugins.install({ name: 'mystery-ls' })
    expect((await plugins.addCustom({ package: 'mystery-ls', command: 'wrong', args: [], languages: ['mystery'] })).ok).toBe(false)
    expect(await plugins.addCustom({ package: 'mystery-ls', command: 'mystery-ls', args: ['--stdio'], languages: ['mystery'] })).toEqual({ ok: true, message: 'mystery-ls now runs for mystery' })
    const spec = plugins.specs().find((s) => s.id === 'custom:mystery-ls')
    expect(spec?.languages).toEqual(['mystery'])
    expect((await spec?.launch(await tempDir()))?.args).toEqual(['--stdio'])
  })

  it('gives JSON the SchemaStore catalog once it has loaded', async () => {
    const { plugins } = await manager()
    const withJson = await manager({ registry: [terraform('json-lsp', 'vscode-json-language-server')] })
    await withJson.plugins.install({ name: 'json-lsp' })
    await withJson.plugins.schemasLoaded
    const settings = withJson.plugins.specs().find((s) => s.id === 'json')?.settings?.('/project')
    expect(settings).toMatchObject({ json: { schemas: [{ fileMatch: ['package.json'], url: 'https://json.schemastore.org/package.json' }] } })
    expect(plugins.specs().some((s) => s.id === 'json')).toBe(false)
  })
})

describe('parsePluginState', () => {
  it('drops entries it can\'t read and reads garbage as empty', () => {
    expect(parsePluginState({ tools: { a: { name: 'a', version: '1', bins: { a: '/x', b: 2 } }, b: 'junk' }, disabled: ['x', 3], custom: [{ id: 1 }] })).toEqual({
      tools: { a: { name: 'a', version: '1', bins: { a: '/x' }, installedAt: '' } },
      disabled: ['x'],
      custom: [],
      theme: null
    })
    expect(parsePluginState('nonsense')).toEqual({ tools: {}, disabled: [], custom: [], theme: null })
  })
})
