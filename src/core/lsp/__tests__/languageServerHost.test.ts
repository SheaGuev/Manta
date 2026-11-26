import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageServerStatus } from '../../../shared/ipc'
import { LanguageServerHost } from '../languageServerHost'
import { languageIdFor } from '../../../shared/languages'
import { nativeTypescriptBinary, typescriptServer, type LanguageServerSpec } from '../serverCatalog'

const FAKE_SERVER = path.resolve('scripts/fake-language-server.mjs')
const BUNDLED_TSC = nativeTypescriptBinary(path.resolve('node_modules'))

const fakeSpec: LanguageServerSpec = {
  id: 'fake',
  name: 'Fake',
  languages: ['fake'],
  role: 'primary',
  launch: async () => ({ command: process.execPath, args: [FAKE_SERVER] })
}

const hosts: LanguageServerHost[] = []
const dirs: string[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.shutdown()))
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-lsp-')))
  dirs.push(dir)
  return dir
}

/** A host plus a client stand-in: requests by id, everything the renderer would have received, and statuses. */
function harness(options: { catalog?: LanguageServerSpec[]; idleStopMs?: number; now?: () => number } = {}) {
  const received: { session: string; value: Record<string, unknown> }[] = []
  const statuses: LanguageServerStatus[] = []
  const host = new LanguageServerHost({
    catalog: () => options.catalog ?? [fakeSpec],
    env: async () => ({ PATH: process.env.PATH ?? '' }),
    onMessage: (session, message) => received.push({ session, value: JSON.parse(message) }),
    onStatus: (status) => statuses.push(status),
    ...(options.idleStopMs === undefined ? {} : { idleStopMs: options.idleStopMs }),
    ...(options.now ? { now: options.now } : {})
  })
  hosts.push(host)
  let nextId = 1
  const request = async (session: string, method: string, params: unknown = null): Promise<unknown> => {
    const id = nextId++
    host.send(session, JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    let response: { value: Record<string, unknown> } | undefined
    await vi.waitFor(() => {
      response = received.find((m) => m.session === session && m.value.id === id)
      expect(response).toBeDefined()
    }, { timeout: 10_000 })
    return response?.value.result
  }
  const notify = (session: string, method: string, params: unknown = null): void => host.send(session, JSON.stringify({ jsonrpc: '2.0', method, params }))
  const initialize = async (session: string, rootUri: string): Promise<unknown> => {
    const result = await request(session, 'initialize', { processId: null, rootUri, capabilities: {} })
    notify(session, 'initialized', {})
    return result
  }
  return { host, received, statuses, request, notify, initialize }
}

describe('languageIdFor', () => {
  it('maps TypeScript and JavaScript extensions', () => {
    expect(languageIdFor('src/a.ts')).toBe('typescript')
    expect(languageIdFor('src/A.TSX')).toBe('typescriptreact')
    expect(languageIdFor('lib/x.mjs')).toBe('javascript')
    expect(languageIdFor('x.jsx')).toBe('javascriptreact')
  })

  it('is null for other files, dotfiles and files without an extension', () => {
    expect(languageIdFor('README.md')).toBeNull()
    expect(languageIdFor('.ts')).toBeNull()
    expect(languageIdFor('Makefile')).toBeNull()
  })
})

describe('LanguageServerHost', () => {
  it('returns null for a language no server takes, and starts nothing', async () => {
    const { host, statuses } = harness()
    expect(await host.open({ root: await tempDir(), languageId: 'cobol', force: false, owner: 'window-1' })).toEqual([])
    expect(statuses).toEqual([])
  })

  it('starts a server, reports it starting then ready, and passes messages both ways', async () => {
    const root = await tempDir()
    const { host, statuses, request, initialize } = harness()
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    expect(session).toMatchObject({ server: 'fake', name: 'Fake', rootUri: pathToFileURL(root).href })
    if (!session) return
    await initialize(session.session, session.rootUri)
    expect(statuses.map((s) => s.state)).toEqual(['starting', 'ready'])
    expect(await request(session.session, 'test/echo', { hello: 'é' })).toEqual({ hello: 'é' })
  })

  it('answers configuration, registration and refresh requests itself, and passes the refresh on as a notification', async () => {
    const root = await tempDir()
    const { host, received, request, initialize } = harness()
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await initialize(session.session, session.rootUri)
    await vi.waitFor(async () => expect(await request(session.session, 'test/answers')).toHaveLength(4))
    const answers = await request(session.session, 'test/answers')
    expect(answers).toEqual([
      { jsonrpc: '2.0', id: 'srv-config', result: [null, null] },
      { jsonrpc: '2.0', id: 'srv-register', result: null },
      { jsonrpc: '2.0', id: 'srv-refresh', result: null },
      { jsonrpc: '2.0', id: 'srv-unknown', error: { code: -32601, message: 'custom/thing is not supported' } }
    ])
    expect(received.some((m) => m.value.method === 'workspace/diagnostic/refresh' && m.value.id === undefined)).toBe(true)
    expect(received.some((m) => m.value.method === 'workspace/configuration')).toBe(false)
  })

  it('keeps info logs in main and passes errors and warnings on', async () => {
    const root = await tempDir()
    const { host, received, request, initialize } = harness()
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await initialize(session.session, session.rootUri)
    await vi.waitFor(async () => expect(await request(session.session, 'test/answers')).toHaveLength(4))
    const logs = received.filter((m) => m.value.method === 'window/logMessage').map((m) => JSON.stringify(m.value.params))
    expect(logs).toEqual([JSON.stringify({ type: 1, message: 'something broke' })])
  })

  it('answers configuration from the server\'s settings by section, and its own requests, async ones too', async () => {
    const root = await tempDir()
    const configured: LanguageServerSpec = {
      ...fakeSpec,
      settings: (r) => ({ a: { root: r } }),
      requests: { 'custom/thing': async (params) => ({ handled: params === null }) }
    }
    const { host, request, initialize } = harness({ catalog: [configured] })
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await initialize(session.session, session.rootUri)
    await vi.waitFor(async () => expect(await request(session.session, 'test/answers')).toHaveLength(4))
    expect(await request(session.session, 'test/answers')).toEqual([
      { jsonrpc: '2.0', id: 'srv-config', result: [{ root }, null] },
      { jsonrpc: '2.0', id: 'srv-register', result: null },
      { jsonrpc: '2.0', id: 'srv-refresh', result: null },
      { jsonrpc: '2.0', id: 'srv-unknown', result: { handled: true } }
    ])
  })

  it('names the root as a workspace folder in initialize, and pushes the server\'s settings once initialized', async () => {
    const root = await tempDir()
    const configured: LanguageServerSpec = { ...fakeSpec, settings: () => ({ yaml: { validate: true } }) }
    const { host, request, initialize } = harness({ catalog: [configured] })
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await initialize(session.session, session.rootUri)
    expect(await request(session.session, 'test/init')).toMatchObject({
      rootUri: session.rootUri,
      workspaceFolders: [{ uri: session.rootUri, name: path.basename(root) }],
      capabilities: { workspace: { configuration: true, workspaceFolders: true } }
    })
    await vi.waitFor(async () => expect(await request(session.session, 'test/notes')).toEqual([{ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings: { yaml: { validate: true } } } }]))
  })

  it('reports a failing request handler to the server as an error', async () => {
    const root = await tempDir()
    const failing: LanguageServerSpec = { ...fakeSpec, requests: { 'custom/thing': () => Promise.reject(new Error('no schema')) } }
    const { host, request, initialize } = harness({ catalog: [failing] })
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await initialize(session.session, session.rootUri)
    await vi.waitFor(async () => expect(await request(session.session, 'test/answers')).toHaveLength(4))
    const answers = await request(session.session, 'test/answers')
    expect(Array.isArray(answers) ? answers[3] : null).toEqual({ jsonrpc: '2.0', id: 'srv-unknown', error: { code: -32603, message: 'no schema' } })
  })

  it('opens the primary server and every lint server for a language, primary first, and stops them by id', async () => {
    const root = await tempDir()
    const lint: LanguageServerSpec = { ...fakeSpec, id: 'fake-lint', name: 'Fake lint', role: 'lint' }
    const second: LanguageServerSpec = { ...fakeSpec, id: 'fake-2', name: 'Second primary' }
    const { host } = harness({ catalog: [lint, fakeSpec, second] })
    const sessions = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    expect(sessions.map((s) => [s.server, s.role])).toEqual([['fake', 'primary'], ['fake-lint', 'lint']])
    await host.stopServers(['fake-lint'])
    expect(host.list().map((s) => s.server)).toEqual(['fake'])
  })

  it('sends file events to a server that registered for them', async () => {
    const root = await tempDir()
    const { host, request, initialize } = harness()
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await initialize(session.session, session.rootUri)
    await vi.waitFor(async () => expect(await request(session.session, 'test/answers')).toHaveLength(4))
    host.filesChanged(root, [{ path: path.join(root, 'a.ts'), type: 'created' }, { path: path.join(root, 'b.ts'), type: 'deleted' }])
    host.filesChanged('/somewhere/else', [{ path: '/somewhere/else/c.ts', type: 'changed' }])
    await vi.waitFor(async () =>
      expect(await request(session.session, 'test/watched')).toEqual([
        { uri: pathToFileURL(path.join(root, 'a.ts')).href, type: 1 },
        { uri: pathToFileURL(path.join(root, 'b.ts')).href, type: 3 }
      ])
    )
  })

  it('starts one process when the same owner opens a server twice at once', async () => {
    const root = await tempDir()
    let launches = 0
    const counted: LanguageServerSpec = { ...fakeSpec, launch: async () => (launches++, { command: process.execPath, args: [FAKE_SERVER] }) }
    const { host } = harness({ catalog: [counted] })
    const [a, b] = await Promise.all([host.open({ root, languageId: 'fake', force: false, owner: 'window-1' }), host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })])
    expect(launches).toBe(1)
    expect(a?.[0]?.session).toBe(b?.[0]?.session)
    expect(host.list()).toHaveLength(1)
  })

  it('gives the same owner the server it already has', async () => {
    const root = await tempDir()
    const { host, statuses } = harness()
    const [first] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    const [again] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    expect(again).toEqual(first)
    expect(statuses.map((s) => s.state)).toEqual(['starting'])
  })

  it('replaces the server for another owner, so a reloaded window\'s client can initialize', async () => {
    const root = await tempDir()
    const { host, statuses, initialize, request } = harness()
    const [first] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    const [second] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-2' })
    if (!first || !second) throw new Error('no session')
    expect(second.session).not.toBe(first.session)
    expect(statuses.some((s) => s.session === first.session && s.state === 'stopped')).toBe(true)
    await initialize(second.session, second.rootUri)
    expect(await request(second.session, 'test/echo', 1)).toBe(1)
    expect(host.list().map((s) => s.session)).toEqual([second.session])
  })

  it('reports a crash with the end of its error output, and refuses to start a server that keeps crashing unless forced', async () => {
    const root = await tempDir()
    const { host, statuses, notify } = harness()
    for (let i = 0; i < 3; i++) {
      const [session] = await host.open({ root, languageId: 'fake', force: false, owner: `window-${i}` })
      if (!session) throw new Error(`no session on try ${i}`)
      notify(session.session, 'test/crash')
      await vi.waitFor(() => expect(statuses.filter((s) => s.state === 'crashed')).toHaveLength(i + 1), { timeout: 10_000 })
    }
    const last = statuses.filter((s) => s.state === 'crashed').at(-1)
    expect(last?.message).toContain('boom: the fake server crashed')
    expect(last?.canRestart).toBe(false)
    expect(host.list().map((s) => s.state)).toEqual(['crashed'])
    expect(await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })).toEqual([])
    expect(await host.open({ root, languageId: 'fake', force: true, owner: 'window-1' })).toHaveLength(1)
  })

  it('stops a server once no file of its is open, and not while one is', async () => {
    const root = await tempDir()
    /** The idle timer starts when the server spawns, so it must outlast a slow start under a full parallel suite, or the server stops before it hears of the file. */
    const { host, statuses, notify, initialize } = harness({ idleStopMs: 3000 })
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await initialize(session.session, session.rootUri)
    const uri = pathToFileURL(path.join(root, 'a.fake')).href
    notify(session.session, 'textDocument/didOpen', { textDocument: { uri, languageId: 'fake', version: 0, text: '' } })
    await new Promise((resolve) => setTimeout(resolve, 3500))
    expect(statuses.some((s) => s.state === 'stopped')).toBe(false)
    notify(session.session, 'textDocument/didClose', { textDocument: { uri } })
    await vi.waitFor(() => expect(statuses.at(-1)?.state).toBe('stopped'), { timeout: 8000 })
    expect(host.list()).toEqual([])
  })

  it('closes the servers of a root and the roots below it, leaving others running', async () => {
    const parent = await tempDir()
    const child = path.join(parent, 'worktree')
    await mkdir(child)
    const other = await tempDir()
    const { host } = harness()
    await host.open({ root: child, languageId: 'fake', force: false, owner: 'window-1' })
    const [kept] = await host.open({ root: other, languageId: 'fake', force: false, owner: 'window-1' })
    await host.closeRoot(parent)
    expect(host.list().map((s) => s.session)).toEqual([kept?.session])
  })

  it('drops messages for a session that has ended', async () => {
    const root = await tempDir()
    const { host, received } = harness()
    const [session] = await host.open({ root, languageId: 'fake', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await host.closeRoot(root)
    host.send(session.session, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test/echo', params: 1 }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(received).toEqual([])
  })
})

describe('LanguageServerHost with TypeScript 7', () => {
  it('jumps to a definition in another file, hovers its type and reports a type error', async () => {
    const root = await tempDir()
    await mkdir(path.join(root, 'src'))
    await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', moduleResolution: 'bundler' } }))
    await writeFile(path.join(root, 'src/a.ts'), 'export function greet(name: string): string {\n  return name\n}\n')
    const text = "import { greet } from './a'\nconst n: number = greet('x')\n"
    await writeFile(path.join(root, 'src/b.ts'), text)
    const { host, request, notify, initialize } = harness({ catalog: [typescriptServer({ bundledBinary: BUNDLED_TSC })] })
    const [session] = await host.open({ root, languageId: languageIdFor('src/b.ts') ?? '', force: false, owner: 'window-1' })
    if (!session) throw new Error('no session')
    await initialize(session.session, session.rootUri)
    const uri = `${session.rootUri}/src/b.ts`
    notify(session.session, 'textDocument/didOpen', { textDocument: { uri, languageId: 'typescript', version: 0, text } })
    const at = { textDocument: { uri }, position: { line: 1, character: 19 } }
    expect(await request(session.session, 'textDocument/definition', at)).toEqual([
      { uri: `${session.rootUri}/src/a.ts`, range: { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } } }
    ])
    expect(JSON.stringify(await request(session.session, 'textDocument/hover', at))).toContain('function greet(name: string): string')
    const report = await request(session.session, 'textDocument/diagnostic', { textDocument: { uri } })
    expect(JSON.stringify(report)).toContain("Type 'string' is not assignable to type 'number'.")
  })

  it('prefers a project\'s own TypeScript 7 or later, and falls back to the bundled one for older versions', async () => {
    const root = await tempDir()
    const spec = typescriptServer({ bundledBinary: '/bundled/tsc' })
    expect(await spec.launch(root)).toEqual({ command: '/bundled/tsc', args: ['--lsp', '--stdio'] })
    await mkdir(path.join(root, 'node_modules/typescript'), { recursive: true })
    await writeFile(path.join(root, 'node_modules/typescript/package.json'), JSON.stringify({ version: '6.0.3' }))
    expect((await spec.launch(root))?.command).toBe('/bundled/tsc')
    await writeFile(path.join(root, 'node_modules/typescript/package.json'), JSON.stringify({ version: '7.1.0' }))
    const own = nativeTypescriptBinary(path.join(root, 'node_modules'))
    expect((await spec.launch(root))?.command).toBe('/bundled/tsc')
    await mkdir(path.dirname(own), { recursive: true })
    await writeFile(own, '')
    expect((await spec.launch(root))?.command).toBe(own)
  })
})
