import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { installPackage } from '../installer'
import type { MasonPackage } from '../masonRegistry'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manta-install-'))
  dirs.push(dir)
  return dir
}

/** Release assets as GitHub serves them, made with the system's tar, zip and gzip. */
const assets = new Map<string, Buffer>()
let server: Server
let base = ''

beforeAll(async () => {
  const work = await mkdtemp(path.join(tmpdir(), 'manta-assets-'))
  await mkdir(path.join(work, 'tool-1.0/bin'), { recursive: true })
  await writeFile(path.join(work, 'tool-1.0/bin/tool'), '#!/bin/sh\necho tool 1.0\n', { mode: 0o755 })
  execFileSync('tar', ['-czf', 'tool.tar.gz', 'tool-1.0'], { cwd: work })
  execFileSync('zip', ['-q', '-r', 'tool.zip', 'tool-1.0'], { cwd: work })
  await writeFile(path.join(work, 'single'), '#!/bin/sh\necho single\n')
  execFileSync('gzip', ['-k', 'single'], { cwd: work })
  /** A tarball with an entry that climbs out of the folder it's unpacked in. */
  execFileSync('python3', ['-c', "import tarfile,io\nt=tarfile.open('evil.tar.gz','w:gz')\ni=tarfile.TarInfo('../escaped')\ni.size=2\nt.addfile(i,io.BytesIO(b'hi'))\nt.close()"], { cwd: work })
  for (const name of ['tool.tar.gz', 'tool.zip', 'single.gz', 'single', 'evil.tar.gz']) assets.set(`/${name}`, await readFile(path.join(work, name)))
  await rm(work, { recursive: true, force: true })
  server = createServer((req, res) => {
    const body = assets.get(req.url ?? '')
    res.writeHead(body ? 200 : 404)
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

/** A generic-download package, the shape terraform-ls uses, pointed at the local server. */
function downloadPackage(file: string, bin: string): MasonPackage {
  return {
    name: 'tool',
    description: '',
    homepage: '',
    languages: [],
    categories: ['LSP'],
    sourceId: 'pkg:generic/example/tool@v1.0',
    assets: [],
    downloads: [{ targets: ['darwin', 'linux', 'win'], file: null, files: { [file]: `${base}/${file}` }, bin }],
    extraPackages: [],
    bin: { tool: '{{source.download.bin}}' }
  }
}

const run = (file: string): string => execFileSync(file, { encoding: 'utf8' }).trim()
const env = { PATH: process.env.PATH ?? '' }

describe('installPackage', () => {
  it('downloads and unpacks a .tar.gz, keeping the command executable', async () => {
    const toolsDir = await tempDir()
    const tool = await installPackage({ pkg: downloadPackage('tool.tar.gz', 'tool-1.0/bin/tool'), toolsDir, env })
    expect(tool).toMatchObject({ name: 'tool', version: 'v1.0', bins: { tool: path.join(toolsDir, 'tool/tool-1.0/bin/tool') } })
    expect(run(tool.bins.tool ?? '')).toBe('tool 1.0')
  })

  it('unpacks a .zip', async () => {
    const tool = await installPackage({ pkg: downloadPackage('tool.zip', 'tool-1.0/bin/tool'), toolsDir: await tempDir(), env })
    expect(run(tool.bins.tool ?? '')).toBe('tool 1.0')
  })

  it('gunzips a single-file .gz and makes it executable', async () => {
    const tool = await installPackage({ pkg: downloadPackage('single.gz', 'single'), toolsDir: await tempDir(), env })
    expect(run(tool.bins.tool ?? '')).toBe('single')
  })

  it('makes a raw binary download executable', async () => {
    const tool = await installPackage({ pkg: downloadPackage('single', 'single'), toolsDir: await tempDir(), env })
    expect(run(tool.bins.tool ?? '')).toBe('single')
  })

  it('reports progress, one line per step', async () => {
    const lines: string[] = []
    await installPackage({ pkg: downloadPackage('single', 'single'), toolsDir: await tempDir(), env, onProgress: (line) => lines.push(line) })
    expect(lines).toEqual([`Downloading ${base}/single`, 'Installed tool v1.0'])
  })

  it('fails when a promised command is missing, and leaves the working install alone', async () => {
    const toolsDir = await tempDir()
    const working = await installPackage({ pkg: downloadPackage('single', 'single'), toolsDir, env })
    await expect(installPackage({ pkg: downloadPackage('tool.tar.gz', 'tool-1.0/bin/missing'), toolsDir, env })).rejects.toThrow("its tool command isn't where Mason says (tool-1.0/bin/missing)")
    expect(run(working.bins.tool ?? '')).toBe('single')
    await expect(readFile(path.join(toolsDir, 'tool.previous', 'single'))).rejects.toThrow()
  })

  it('refuses an archive with an entry outside its folder, and writes nothing there', async () => {
    const toolsDir = await tempDir()
    await expect(installPackage({ pkg: downloadPackage('evil.tar.gz', 'x'), toolsDir, env })).rejects.toThrow('would write outside its folder (../escaped)')
    await expect(readFile(path.join(toolsDir, 'escaped'))).rejects.toThrow()
  })

  it('refuses a package name that is a path', async () => {
    const pkg = { ...downloadPackage('single', 'single'), name: '../tool' }
    await expect(installPackage({ pkg, toolsDir: await tempDir(), env })).rejects.toThrow("Won't install a package named")
  })

  it('fails on a download that is not there', async () => {
    await expect(installPackage({ pkg: downloadPackage('nope.zip', 'x'), toolsDir: await tempDir(), env })).rejects.toThrow('404')
  })

  it('refuses a source kind it can\'t install', async () => {
    const pkg = { ...downloadPackage('single', 'single'), sourceId: 'pkg:gem/solargraph@0.50.0' }
    await expect(installPackage({ pkg, toolsDir: await tempDir(), env })).rejects.toThrow("Installing gem packages isn't supported yet")
  })

  it('says which command is missing from the PATH', async () => {
    const pkg = { ...downloadPackage('single', 'single'), sourceId: 'pkg:npm/which@4.0.0', bin: { 'node-which': 'npm:node-which' } }
    await expect(installPackage({ pkg, toolsDir: await tempDir(), env: { PATH: '/nonexistent' } })).rejects.toThrow("tool needs npm, which isn't on your shell's PATH")
  })
})

/** Real installs from npm and PyPI; slow and online, so only with MANTA_NETWORK_TESTS=1. */
describe.runIf(process.env.MANTA_NETWORK_TESTS === '1')('installPackage from the network', () => {
  it('installs an npm package and its command runs', async () => {
    const pkg: MasonPackage = { ...downloadPackage('single', 'single'), name: 'which', sourceId: 'pkg:npm/which@4.0.0', bin: { 'node-which': 'npm:node-which' } }
    const tool = await installPackage({ pkg, toolsDir: await tempDir(), env })
    expect(execFileSync(tool.bins['node-which'] ?? '', ['sh'], { encoding: 'utf8' }).trim()).toMatch(/\/sh$/)
  }, 120_000)

  it('installs a PyPI package into its own virtualenv', async () => {
    const pkg: MasonPackage = { ...downloadPackage('single', 'single'), name: 'cowsay', sourceId: 'pkg:pypi/cowsay@6.1', bin: { cowsay: 'pypi:cowsay' } }
    const tool = await installPackage({ pkg, toolsDir: await tempDir(), env })
    expect(execFileSync(tool.bins.cowsay ?? '', ['-t', 'moo'], { encoding: 'utf8' })).toContain('moo')
  }, 120_000)
})
