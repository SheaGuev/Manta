import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ReviewAnchor } from '../../../shared/ipc'
import { ReviewCommentStore } from '../reviewComments'

const ANCHOR: ReviewAnchor = { relPath: 'src/a.ts', diff: 'branch', side: 'new', line: 3, lineText: 'const a = 1', hunk: ' x\n+const a = 1' }

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'manta-review-'))
  file = path.join(dir, 'manta', 'review-comments.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function open(): ReviewCommentStore {
  return new ReviewCommentStore(async () => file)
}

describe('ReviewCommentStore', () => {
  it('adds, edits, marks sent and removes comments, and survives a reopen', async () => {
    const store = open()
    const first = await store.add(ANCHOR, 'Rename this')
    const second = await store.add({ ...ANCHOR, side: 'old', line: 2, lineText: 'old' }, 'Why removed?')
    expect(first.id).toMatch(/^rc_[0-9a-f]{12}$/)
    expect(first).toMatchObject({ ...ANCHOR, body: 'Rename this', sent: null })

    await store.edit(first.id, 'Rename this to b')
    await store.markSent([second.id], 'Claude')

    const reopened = await open().list()
    expect(reopened.map((c) => c.body)).toEqual(['Rename this to b', 'Why removed?'])
    expect(reopened[0]?.sent).toBeNull()
    expect(reopened[1]?.sent?.to).toBe('Claude')

    await store.remove([first.id])
    expect((await open().list()).map((c) => c.id)).toEqual([second.id])
  })

  it('reads a corrupt file as empty and rewrites it on the next add', async () => {
    await open().add(ANCHOR, 'seed')
    await writeFile(file, '{not json')
    const store = open()
    expect(await store.list()).toEqual([])
    await store.add(ANCHOR, 'fresh')
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect(parsed).toMatchObject({ comments: [{ body: 'fresh' }] })
  })

  it('skips entries that are not comments', async () => {
    const valid = await open().add(ANCHOR, 'keep me')
    await writeFile(file, JSON.stringify({ comments: [{ id: 'rc_x' }, { ...valid, id: 'rc_zero', line: 0 }, valid] }))
    expect(await open().list()).toEqual([valid])
  })

  it('queues concurrent adds so none is lost', async () => {
    const store = open()
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.add(ANCHOR, `comment ${n}`)))
    expect(await store.list()).toHaveLength(5)
  })

  it('keeps PR sent marks beside the comments, and tolerates a file without them', async () => {
    const store = open()
    const comment = await store.add(ANCHOR, 'Rename this')
    expect(await store.pullRequestSent()).toEqual({})
    await store.markPullRequestSent(['PRRT_1', 'IC_2'], 'Claude 2')
    const marks = await open().pullRequestSent()
    expect(Object.keys(marks).sort()).toEqual(['IC_2', 'PRRT_1'])
    expect(marks['PRRT_1']?.to).toBe('Claude 2')
    expect((await open().list()).map((c) => c.id)).toEqual([comment.id])
    await store.remove([comment.id])
    expect(Object.keys(await open().pullRequestSent())).toHaveLength(2)

    await writeFile(file, JSON.stringify({ comments: [{ ...ANCHOR, id: 'rc_1', body: 'b', createdAt: 'now', sent: null }] }))
    expect(await open().pullRequestSent()).toEqual({})
    expect(await open().list()).toHaveLength(1)
    await writeFile(file, JSON.stringify({ comments: [], prSent: { x: 'nope', y: { to: 'Claude', at: 'now' } } }))
    expect(await open().pullRequestSent()).toEqual({ y: { to: 'Claude', at: 'now' } })
  })

  it('stores pending PR comments beside the branch ones, and rejects a malformed pr diff', async () => {
    const store = open()
    await store.add(ANCHOR, 'Branch note')
    await store.add({ ...ANCHOR, diff: 'pr:7' }, 'Pending')
    expect((await open().list()).map((c) => c.diff)).toEqual(['branch', 'pr:7'])
    const valid = { ...ANCHOR, id: 'rc_ok', body: 'b', createdAt: 'now', sent: null }
    await writeFile(file, JSON.stringify({ comments: [{ ...valid, diff: 'pr:0' }, { ...valid, diff: 'pr:x' }, { ...valid, diff: 'pr:12' }] }))
    expect((await open().list()).map((c) => c.diff)).toEqual(['pr:12'])
  })

  it('keeps viewed fingerprints per PR and tolerates a file without them', async () => {
    const store = open()
    await store.add(ANCHOR, 'Keep me')
    expect(await store.viewed(7)).toEqual({})
    await store.setViewed(7, 'a.ts', 'b1:b2')
    await store.setViewed(7, 'b.ts', 'b3:b4')
    await store.setViewed(8, 'a.ts', 'b5:b6')
    await store.setViewed(7, 'b.ts', null)
    expect(await open().viewed(7)).toEqual({ 'a.ts': 'b1:b2' })
    expect(await open().viewed(8)).toEqual({ 'a.ts': 'b5:b6' })
    expect(await open().list()).toHaveLength(1)
    await writeFile(file, JSON.stringify({ comments: [], viewed: { '7': { 'a.ts': 3, 'b.ts': 'x:y' }, bad: 'no' } }))
    expect(await open().viewed(7)).toEqual({ 'b.ts': 'x:y' })
  })

  it("remembers which viewed changes GitHub hasn't taken yet, until one is taken", async () => {
    const store = open()
    expect(await store.unsyncedViewed(7)).toEqual([])
    await store.setViewed(7, 'a.ts', null, { synced: false })
    await store.setViewed(7, 'b.ts', 'b1:b2', { synced: false })
    await store.setViewed(8, 'a.ts', 'b3:b4', { synced: false })
    expect(await open().unsyncedViewed(7)).toEqual(['a.ts', 'b.ts'])
    await store.setViewed(7, 'b.ts', 'b1:b2')
    expect(await open().unsyncedViewed(7)).toEqual(['a.ts'])
    expect(await open().unsyncedViewed(8)).toEqual(['a.ts'])
    await writeFile(file, JSON.stringify({ comments: [], unsyncedViewed: { '7': ['a.ts', 3], x: ['b.ts'] } }))
    expect(await open().unsyncedViewed(7)).toEqual(['a.ts'])
  })
})
