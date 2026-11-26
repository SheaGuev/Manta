import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readZip } from '../zip'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** A zip made by the system's `zip`, as release assets are. */
async function zipOf(files: Record<string, string>, flags: string[] = []): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manta-zip-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, 'src', name)), { recursive: true })
    await writeFile(path.join(dir, 'src', name), text)
  }
  execFileSync('zip', ['-q', '-r', ...flags, path.join(dir, 'out.zip'), '.'], { cwd: path.join(dir, 'src') })
  return readFile(path.join(dir, 'out.zip'))
}

describe('readZip', () => {
  it('reads deflated files, including in folders, and skips the folders themselves', async () => {
    const big = 'registry '.repeat(5000)
    const files = readZip(await zipOf({ 'registry.json': big, 'extension/package.json': '{"name":"x"}' }))
    expect(files.get('registry.json')?.toString()).toBe(big)
    expect(files.get('extension/package.json')?.toString()).toBe('{"name":"x"}')
    expect([...files.keys()].some((name) => name.endsWith('/'))).toBe(false)
  })

  it('reads stored (uncompressed) files', async () => {
    const files = readZip(await zipOf({ 'a.txt': 'plain' }, ['-0']))
    expect(files.get('a.txt')?.toString()).toBe('plain')
  })

  it('refuses something that is not a zip', () => {
    expect(() => readZip(Buffer.from('not a zip at all, just some text that is long enough'))).toThrow('Not a zip archive')
  })
})
