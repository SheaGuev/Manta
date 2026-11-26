import { chmod, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { firstErrorLine, resolveFormatter, runFormatter, type CommandFormatter } from '../formatters'

/** Real Prettier and Biome, copied from the project `MANTA_FORMATTER_PROJECT` names, when it has them installed. */
const FORMATTER_PROJECT = process.env['MANTA_FORMATTER_PROJECT'] ?? ''
const PRETTIER_SOURCE = path.join(FORMATTER_PROJECT, 'node_modules/prettier')
const BIOME_SOURCE = path.join(FORMATTER_PROJECT, `node_modules/@biomejs/cli-${process.platform}-${process.arch}`)

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-format-')))
  dirs.push(root)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), text)
  }
  return root
}

const resolve = (root: string, file: string, toolRoots: string[] = []) =>
  resolveFormatter({ root, file: path.join(root, file), toolRoots, node: process.execPath, env: { PATH: process.env.PATH ?? '' } })

const script = (body: string): CommandFormatter => ({ id: 'prettier', name: 'Fake', command: process.execPath, args: ['-e', body], env: {} })

describe('resolveFormatter', () => {
  it('finds nothing without a config, so the language server formats', async () => {
    const root = await project({ 'src/a.ts': '', 'node_modules/prettier/bin/prettier.cjs': '' })
    expect(await resolve(root, 'src/a.ts')).toBeNull()
  })

  it('needs the tool installed as well as configured', async () => {
    const root = await project({ 'src/a.ts': '', '.prettierrc': '{}' })
    expect(await resolve(root, 'src/a.ts')).toBeNull()
  })

  it('runs Prettier with Node for a configured project, finding the config in a parent folder', async () => {
    const root = await project({ 'packages/x/src/a.ts': '', '.prettierrc': '{}', 'node_modules/prettier/bin/prettier.cjs': '' })
    const file = path.join(root, 'packages/x/src/a.ts')
    expect(await resolve(root, 'packages/x/src/a.ts')).toMatchObject({
      id: 'prettier',
      command: process.execPath,
      args: [path.join(root, 'node_modules/prettier/bin/prettier.cjs'), '--stdin-filepath', file],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })

  it('counts a "prettier" key in package.json as a config', async () => {
    const root = await project({ 'a.ts': '', 'package.json': '{"prettier":{}}', 'node_modules/prettier/bin/prettier.cjs': '' })
    expect((await resolve(root, 'a.ts'))?.id).toBe('prettier')
  })

  it('prefers Prettier over Biome when the project has both, as its lint:fix leaves files', async () => {
    const files = { 'a.ts': '', '.prettierrc': '{}', 'biome.json': '{}', 'node_modules/prettier/bin/prettier.cjs': '', [`node_modules/@biomejs/cli-${process.platform}-${process.arch}/biome`]: '' }
    const root = await project(files)
    expect((await resolve(root, 'a.ts'))?.id).toBe('prettier')
  })

  it('uses Biome for a file type Prettier is not configured to format, or without Prettier', async () => {
    const root = await project({ 'a.ts': '', 'biome.json': '{}', [`node_modules/@biomejs/cli-${process.platform}-${process.arch}/biome`]: '' })
    expect(await resolve(root, 'a.ts')).toMatchObject({ id: 'biome', args: ['format', `--stdin-file-path=${path.join(root, 'a.ts')}`] })
  })

  it('finds the tool in the project\'s main checkout when a worktree has no node_modules', async () => {
    const main = await project({ 'node_modules/prettier/bin/prettier.cjs': '' })
    const worktree = await project({ 'a.ts': '', '.prettierrc': '{}' })
    expect((await resolve(worktree, 'a.ts', [worktree, main]))?.args[0]).toBe(path.join(main, 'node_modules/prettier/bin/prettier.cjs'))
  })

  it('uses Ruff for Python when pyproject.toml configures it, from the project\'s virtualenv', async () => {
    const root = await project({ 'pkg/a.py': '', 'pyproject.toml': '[project]\nname = "x"\n\n[tool.ruff]\nline-length = 100\n', '.venv/bin/ruff': '' })
    expect(await resolve(root, 'pkg/a.py')).toMatchObject({ id: 'ruff', command: path.join(root, '.venv/bin/ruff'), args: ['format', '--stdin-filename', path.join(root, 'pkg/a.py'), '-'] })
  })

  it('falls back to the Ruff plugin when the project has none of its own', async () => {
    const root = await project({ 'a.py': '', 'ruff.toml': '' })
    const formatter = await resolveFormatter({ root, file: path.join(root, 'a.py'), toolRoots: [], node: process.execPath, env: { PATH: '/nonexistent' }, pluginRuff: '/plugins/ruff' })
    expect(formatter).toMatchObject({ id: 'ruff', command: '/plugins/ruff' })
  })

  it('leaves Python alone without a Ruff config, and file types no formatter takes', async () => {
    const root = await project({ 'a.py': '', 'pyproject.toml': '[project]\n', '.venv/bin/ruff': '', 'a.swift': '', '.prettierrc': '{}', 'node_modules/prettier/bin/prettier.cjs': '' })
    expect(await resolve(root, 'a.py')).toBeNull()
    expect(await resolve(root, 'a.swift')).toBeNull()
  })
})

describe('firstErrorLine', () => {
  it('keeps Prettier\'s message, without its tag, the path or the code frame', () => {
    const stderr = "[error] web/bad.ts: SyntaxError: '}' expected. (2:1)\n[error]   1 | const broken = {\n[error] > 2 |\n"
    expect(firstErrorLine(stderr)).toBe("SyntaxError: '}' expected. (2:1)")
  })

  it('keeps a line without a path as it is, and is null for no output', () => {
    expect(firstErrorLine('\n  error: Failed to parse a.py:1:5\n')).toBe('error: Failed to parse a.py:1:5')
    expect(firstErrorLine('  \n')).toBeNull()
  })
})

describe('runFormatter', () => {
  it('pipes the text through and returns the output', async () => {
    const formatter = script("process.stdin.on('data', d => process.stdout.write(String(d).toUpperCase()))")
    expect(await runFormatter({ formatter, text: 'héllo', cwd: tmpdir() })).toBe('HÉLLO')
  })

  it('rejects with the end of the error output when the formatter fails', async () => {
    const formatter = script("process.stderr.write('SyntaxError: Unexpected token (1:5)\\n'); process.exit(2)")
    await expect(runFormatter({ formatter, text: 'x', cwd: tmpdir() })).rejects.toThrow('Fake failed: SyntaxError: Unexpected token (1:5)')
  })

  it('gives up after the timeout', async () => {
    const formatter = script('setTimeout(() => {}, 10000)')
    await expect(runFormatter({ formatter, text: 'x', cwd: tmpdir(), timeoutMs: 300 })).rejects.toThrow('took longer than 0.3 s')
  })

  it('says so when the command does not exist', async () => {
    const formatter: CommandFormatter = { id: 'ruff', name: 'Ruff', command: '/nonexistent/ruff', args: [], env: {} }
    await expect(runFormatter({ formatter, text: 'x', cwd: tmpdir() })).rejects.toThrow("Ruff didn't start")
  })
})

describe.runIf(FORMATTER_PROJECT !== '' && existsSync(PRETTIER_SOURCE) && existsSync(BIOME_SOURCE))('the real formatters', () => {
  it('formats TypeScript with Prettier and the project\'s config', async () => {
    const root = await project({ 'a.ts': '', '.prettierrc': '{"semi":false,"singleQuote":true}' })
    await cp(PRETTIER_SOURCE, path.join(root, 'node_modules/prettier'), { recursive: true })
    const formatter = await resolve(root, 'a.ts')
    if (!formatter) throw new Error('no formatter')
    expect(await runFormatter({ formatter, text: 'const a = {b:"c"};\n', cwd: root })).toBe("const a = { b: 'c' }\n")
  })

  it('formats with Biome', async () => {
    const root = await project({ 'a.ts': '', 'biome.json': '{}' })
    const bin = path.join(root, `node_modules/@biomejs/cli-${process.platform}-${process.arch}`)
    await cp(BIOME_SOURCE, bin, { recursive: true })
    await chmod(path.join(bin, 'biome'), 0o755)
    const formatter = await resolve(root, 'a.ts')
    if (!formatter) throw new Error('no formatter')
    expect(await runFormatter({ formatter, text: 'const a = {b:"c"}\n', cwd: root })).toBe('const a = { b: "c" };\n')
  })
})
