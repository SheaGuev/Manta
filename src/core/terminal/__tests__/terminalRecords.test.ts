import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTerminalRecord, TerminalRecordStore, type TerminalRecord } from '../terminalRecords'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function storeFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'manta-terms-'))
  dirs.push(dir)
  return path.join(dir, 'nested', 'terminals.json')
}

const record = (id: string, extra: Partial<TerminalRecord> = {}): TerminalRecord => ({
  id,
  root: '/repo',
  kind: 'claude',
  title: 'Claude',
  sessionId: '6b0f3f3e-1d6e-4c55-9a51-2f5d1c3a9b01',
  resumable: false,
  createdAt: '2026-10-20T10:00:00.000Z',
  link: null,
  map: null,
  brief: null,
  addDirs: [],
  ...extra
})

describe('TerminalRecordStore', () => {
  it('reads as empty before anything is written', async () => {
    expect(await new TerminalRecordStore(await storeFile()).list()).toEqual([])
  })

  it('puts, replaces and removes records, and they persist', async () => {
    const file = await storeFile()
    const store = new TerminalRecordStore(file)
    await store.put(record('term_a'))
    await store.put(record('term_b', { kind: 'shell', sessionId: null }))
    await store.put(record('term_a', { title: 'Renamed', resumable: true }))
    await store.remove('term_b')
    expect(await new TerminalRecordStore(file).list()).toEqual([record('term_a', { title: 'Renamed', resumable: true })])
  })

  it('keeps every write when they are not awaited one by one', async () => {
    const store = new TerminalRecordStore(await storeFile())
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => store.put(record(`term_${id}`))))
    expect((await store.list()).map((r) => r.id).sort()).toEqual(['term_a', 'term_b', 'term_c', 'term_d'])
  })

  it('drops unreadable entries and treats an unreadable file as empty', async () => {
    const file = await storeFile()
    const store = new TerminalRecordStore(file)
    await store.put(record('term_a'))
    const good: unknown = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify([...(Array.isArray(good) ? good : []), { id: 'term_bad', kind: 'emacs' }, 7]))
    expect((await store.list()).map((r) => r.id)).toEqual(['term_a'])
    await writeFile(file, '{ not json')
    expect(await store.list()).toEqual([])
  })
})

describe('parseTerminalRecord', () => {
  it('keeps a link, brief and extra folders, and reads records from before them with none', async () => {
    const link = { docsRoot: '/docs', doc: 'auth.md', thread: 't_1' }
    expect(parseTerminalRecord(record('term_a', { link, brief: '/b.md', addDirs: ['/docs'] }))).toMatchObject({ link, brief: '/b.md', addDirs: ['/docs'] })
    const { link: _, brief: __, addDirs: ___, ...older } = record('term_b')
    expect(parseTerminalRecord(older)).toMatchObject({ id: 'term_b', link: null, brief: null, addDirs: [] })
    expect(parseTerminalRecord({ ...older, link: { doc: 'auth.md' } })?.link).toBeNull()
  })

  it('keeps a context map link, and reads records from before maps with none', () => {
    const map = { docsRoot: '/docs', map: 'm_1', launch: null, ticket: null }
    expect(parseTerminalRecord(record('term_a', { map }))?.map).toEqual(map)
    const { map: _, ...older } = record('term_b')
    expect(parseTerminalRecord(older)?.map).toBeNull()
    expect(parseTerminalRecord({ ...older, map: { map: 'm_1' } })?.map).toBeNull()
  })
})
