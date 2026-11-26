import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, chmod, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import { findOnPath } from '../terminal/terminalEnv'
import { installPlan, parsePurl, type BinRef, type Download, type MasonPackage } from './masonRegistry'

/** A package installed under Manta's tools folder, and where its commands are. */
export interface InstalledTool {
  name: string
  version: string
  /** Command name → absolute path. */
  bins: Record<string, string>
  installedAt: string
}

export interface InstallOptions {
  pkg: MasonPackage
  /** `<userData>/plugins/tools`; each package gets a folder named after it. */
  toolsDir: string
  /** The user's login shell environment: npm, python3, uv, cargo and go come from its PATH. */
  env: Record<string, string>
  /** One line per step, for the Plugins view. */
  onProgress?: (line: string) => void
  fetch?: typeof fetch
}

/** npm, pip, cargo and go can take minutes on a slow network; past this the install is abandoned. */
const STEP_TIMEOUT_MS = 10 * 60_000

function run({ command, args, cwd, env }: { command: string; args: string[]; cwd: string; env: Record<string, string> }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-4000)
    }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    const timer = setTimeout(() => child.kill('SIGKILL'), STEP_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`${path.basename(command)} didn't start: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} ${args[0] ?? ''} failed: ${output.trim().split('\n').slice(-3).join(' ') || `exit ${code}`}`))
    })
  })
}

async function requireCommand(name: string, env: Record<string, string>, why: string): Promise<string> {
  const found = await findOnPath(name, env.PATH)
  if (!found) throw new Error(`${why} needs ${name}, which isn't on your shell's PATH`)
  return found
}

/** The entries an archive would write, from the archiver's own listing. */
async function archiveEntries({ command, args, cwd, env }: { command: string; args: string[]; cwd: string; env: Record<string, string> }): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out.split('\n').filter(Boolean)) : reject(new Error(`${command} couldn't list the archive`))))
  })
}

/** Refuses an archive with an entry outside the install folder (`../`, or an absolute path) before unpacking it. */
function assertContained(entries: string[], archive: string): void {
  const escaping = entries.find((entry) => path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..'))
  if (escaping) throw new Error(`${path.basename(archive)} would write outside its folder (${escaping}); not installing it`)
}

/** A Mason package name used as a folder name: no path separators or dot-segments. */
const SAFE_NAME = /^[A-Za-z0-9@_][\w.@-]*$/

async function download({ item, dir, fetchImpl, env }: { item: Download; dir: string; fetchImpl: typeof fetch; env: Record<string, string> }): Promise<void> {
  const target = path.join(dir, item.into)
  await mkdir(target, { recursive: true })
  const file = path.join(target, item.name)
  const response = await fetchImpl(item.url)
  if (!response.ok || !response.body) throw new Error(`Downloading ${item.url} failed: ${response.status} ${response.statusText}`)
  /** Streamed to disk: a language server's download can be hundreds of MB (Kotlin's). */
  const reader = response.body.getReader()
  const out = createWriteStream(file)
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      if (!out.write(chunk.value)) await once(out, 'drain')
    }
  } finally {
    out.end()
    await finished(out)
  }
  if (!SAFE_NAME.test(item.name) || item.into.split('/').includes('..') || path.isAbsolute(item.into)) throw new Error(`Won't save a download as ${item.into}/${item.name}`)
  const name = item.name.toLowerCase()
  if (/\.(tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tbz2?|tar)$/.test(name)) {
    assertContained(await archiveEntries({ command: 'tar', args: ['-tf', file], cwd: target, env }), file)
    await run({ command: 'tar', args: ['-xf', file, '-C', target], cwd: target, env })
    await rm(file)
  } else if (/\.(zip|vsix)$/.test(name)) {
    assertContained(await archiveEntries({ command: 'unzip', args: ['-Z1', file], cwd: target, env }), file)
    await run({ command: 'unzip', args: ['-q', '-o', file, '-d', target], cwd: target, env })
    await rm(file)
  } else if (name.endsWith('.gz')) {
    await run({ command: 'gunzip', args: ['-f', file], cwd: target, env })
  } else {
    await chmod(file, 0o755)
  }
}

function binPath(dir: string, ref: BinRef): string {
  switch (ref.kind) {
    case 'npm':
      return path.join(dir, 'node_modules', '.bin', ref.name)
    case 'pypi':
      return path.join(dir, 'venv', 'bin', ref.name)
    case 'cargo':
    case 'golang':
      return path.join(dir, 'bin', ref.name)
    case 'path':
      return path.join(dir, ref.path)
  }
}

/**
 * Installs a Mason package into its own folder: npm (`--ignore-scripts`), PyPI (a virtualenv, with
 * `uv` when it's there), GitHub release assets and other downloads, cargo and go. A failed install,
 * or one missing a command it promises, puts the previous install back, so it never breaks a working one.
 */
export async function installPackage(options: InstallOptions): Promise<InstalledTool> {
  const { pkg, toolsDir, env } = options
  const progress = options.onProgress ?? (() => undefined)
  const fetchImpl = options.fetch ?? fetch
  if (!SAFE_NAME.test(pkg.name) || pkg.name.includes('..')) throw new Error(`Won't install a package named ${JSON.stringify(pkg.name)}`)
  const plan = installPlan(pkg)
  if ('unsupported' in plan) throw new Error(plan.unsupported)
  const version = parsePurl(pkg.sourceId)?.version ?? ''
  /** Installed in place: a virtualenv's scripts name its absolute path, so it can't be moved after. The previous install waits aside. */
  const dir = path.join(toolsDir, pkg.name)
  const previous = `${dir}.previous`
  await rm(previous, { recursive: true, force: true })
  const hadPrevious = await rename(dir, previous).then(() => true, () => false)
  await mkdir(dir, { recursive: true })
  try {
    switch (plan.kind) {
      case 'npm': {
        const npm = await requireCommand('npm', env, pkg.name)
        progress(`npm install ${plan.packages.join(' ')}`)
        await run({ command: npm, args: ['install', '--prefix', dir, '--no-save', '--no-package-lock', '--ignore-scripts', '--no-audit', '--no-fund', ...plan.packages], cwd: dir, env })
        break
      }
      case 'pypi': {
        const uv = await findOnPath('uv', env.PATH)
        const venv = path.join(dir, 'venv')
        progress(`${uv ? 'uv' : 'pip'} install ${plan.packages.join(' ')}`)
        if (uv) {
          await run({ command: uv, args: ['venv', '--quiet', venv], cwd: dir, env })
          await run({ command: uv, args: ['pip', 'install', '--quiet', '--python', path.join(venv, 'bin', 'python'), ...plan.packages], cwd: dir, env })
        } else {
          const python = await requireCommand('python3', env, pkg.name)
          await run({ command: python, args: ['-m', 'venv', venv], cwd: dir, env })
          await run({ command: path.join(venv, 'bin', 'pip'), args: ['install', '--quiet', ...plan.packages], cwd: dir, env })
        }
        break
      }
      case 'download':
        for (const item of plan.downloads) {
          progress(`Downloading ${item.url}`)
          await download({ item, dir, fetchImpl, env })
        }
        break
      case 'cargo': {
        const cargo = await requireCommand('cargo', env, pkg.name)
        progress(`cargo install ${plan.crate}`)
        const source = plan.git ? ['--git', plan.git, '--tag', plan.version] : ['--version', plan.version]
        await run({ command: cargo, args: ['install', '--root', dir, ...source, plan.crate], cwd: dir, env })
        break
      }
      case 'golang': {
        const go = await requireCommand('go', env, pkg.name)
        progress(`go install ${plan.module}@${plan.version}`)
        await run({ command: go, args: ['install', `${plan.module}@${plan.version}`], cwd: dir, env: { ...env, GOBIN: path.join(dir, 'bin') } })
        break
      }
    }
    for (const [command, ref] of Object.entries(plan.bins)) {
      const file = binPath(dir, ref)
      await access(file).catch(() => {
        throw new Error(`${pkg.name} installed, but its ${command} command isn't where Mason says (${path.relative(dir, file)})`)
      })
      if (ref.kind === 'path') await chmod(file, 0o755)
    }
    await rm(previous, { recursive: true, force: true })
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    if (hadPrevious) await rename(previous, dir)
    throw error
  }
  progress(`Installed ${pkg.name} ${version}`)
  return { name: pkg.name, version, bins: Object.fromEntries(Object.entries(plan.bins).map(([command, ref]) => [command, binPath(dir, ref)])), installedAt: new Date().toISOString() }
}
