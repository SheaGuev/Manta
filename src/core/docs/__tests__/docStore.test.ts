import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DocStore, type DocMeta } from '../docStore'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const state = (byte: number): Uint8Array => new Uint8Array([byte])

describe('DocStore.saveMeta', () => {
  it('rewrites the sync point and staged files only when their state changed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'manta-store-'))
    dirs.push(root)
    const store = new DocStore(root)
    const file = (name: string): string => path.join(root, encodeURIComponent('auth.md'), name)
    const syncPoint = { commit: 'abc', text: 'one', state: state(1) }
    const staged = { text: 'two', state: state(2) }
    const meta = (lastDisk: number, next: Partial<DocMeta> = {}): DocMeta => ({ lastDisk: { text: 'x', state: state(lastDisk) }, syncPoint, staged, ...next })

    await store.saveMeta('auth.md', meta(3))
    await writeFile(file('sync-point.bin'), 'untouched')
    await writeFile(file('staged.bin'), 'untouched')

    await store.saveMeta('auth.md', meta(4, { syncPoint: { ...syncPoint, commit: 'def' } }))
    expect(await readFile(file('sync-point.bin'), 'utf8')).toBe('untouched')
    expect(await readFile(file('staged.bin'), 'utf8')).toBe('untouched')
    expect([...(await readFile(file('last-disk.bin')))]).toEqual([4])
    expect(JSON.parse(await readFile(file('meta.json'), 'utf8')).syncPoint.commit).toBe('def')

    await store.saveMeta('auth.md', meta(5, { syncPoint: { commit: 'ghi', text: 'one!', state: state(6) } }))
    expect([...(await readFile(file('sync-point.bin')))]).toEqual([6])
    expect(await readFile(file('staged.bin'), 'utf8')).toBe('untouched')
  })

  it('treats what it loaded as already written', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'manta-store-'))
    dirs.push(root)
    const first = new DocStore(root)
    await first.appendUpdate('auth.md', state(0))
    await first.saveMeta('auth.md', { lastDisk: { text: 'x', state: state(1) }, syncPoint: { commit: 'abc', text: 'x', state: state(2) }, staged: null })

    const second = new DocStore(root)
    const loaded = await second.load('auth.md')
    if (!loaded) throw new Error('not stored')
    const file = path.join(root, encodeURIComponent('auth.md'), 'sync-point.bin')
    await writeFile(file, 'untouched')
    await second.saveMeta('auth.md', { ...loaded.meta, lastDisk: { text: 'y', state: state(3) } })
    expect(await readFile(file, 'utf8')).toBe('untouched')
  })
})
