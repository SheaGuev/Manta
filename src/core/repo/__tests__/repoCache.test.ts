import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Git, parseBranchHeader } from '../git'
import { RepoCache } from '../repoCache'

const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function repo(files: Record<string, string> = { 'a.md': 'one\ntwo\n' }): Promise<{ dir: string; run: (...args: string[]) => void }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'manta-cache-')))
  dirs.push(dir)
  const run = (...args: string[]): void => void execFileSync('git', args, { cwd: dir })
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 't')
  run('config', 'user.email', 't@t')
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), text)
  }
  if (Object.keys(files).length > 0) {
    run('add', '-A')
    run('commit', '-qm', 'seed')
  }
  return { dir, run }
}

describe('parseBranchHeader', () => {
  it.each([
    ['## main', { branch: 'main', unborn: false, ahead: 0, hasUpstream: false }],
    ['## main...origin/main [ahead 1, behind 2]', { branch: 'main', unborn: false, ahead: 1, hasUpstream: true }],
    ['## main...origin/main [behind 2]', { branch: 'main', unborn: false, ahead: 0, hasUpstream: true }],
    ['## manta/login...origin/manta/login', { branch: 'manta/login', unborn: false, ahead: 0, hasUpstream: true }],
    ['## No commits yet on main', { branch: 'main', unborn: true, ahead: 0, hasUpstream: false }],
    ['## HEAD (no branch)', { branch: '', unborn: false, ahead: 0, hasUpstream: false }]
  ])('%s', (header, expected) => {
    expect(parseBranchHeader(header)).toEqual(expected)
  })
})

describe('Git.statusSnapshot', () => {
  it('gives the branch, changes and stats the separate commands gave, in four git commands', async () => {
    const { dir, run } = await repo({ 'a.md': 'one\ntwo\n', 'b.md': 'bee\n', 'c.md': 'sea\n' })
    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\nthree\n')
    run('add', 'a.md')
    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\nthree\nfour\n')
    await unlink(path.join(dir, 'b.md'))
    run('mv', 'c.md', 'see.md')
    await writeFile(path.join(dir, 'new.md'), 'x\ny\n')
    const git = new Git(dir)
    const branch = await git.currentBranch()

    const spawns = vi.spyOn(git, 'run')
    const snapshot = await git.statusSnapshot()
    expect(spawns).toHaveBeenCalledTimes(4)
    expect(snapshot.branch).toBe(branch)
    expect(snapshot.changes).toEqual({
      staged: [
        { path: 'a.md', status: 'M', added: 2, removed: 1 },
        { path: 'see.md', status: 'R', added: 0, removed: 0 }
      ],
      unstaged: [
        { path: 'a.md', status: 'M', added: 1, removed: 0 },
        { path: 'b.md', status: 'D', added: 0, removed: 1 },
        { path: 'new.md', status: 'U', added: 2, removed: 0 }
      ]
    })
    expect(snapshot.stat).toEqual({ added: 5, removed: 2 })
  })

  it('works before the first commit', async () => {
    const { dir, run } = await repo({})
    await writeFile(path.join(dir, 'a.md'), 'one\n')
    run('add', 'a.md')
    await writeFile(path.join(dir, 'b.md'), 'two\nthree\n')

    const snapshot = await new Git(dir).statusSnapshot()
    expect(snapshot.branch).toBe('main')
    expect(snapshot.changes.staged).toEqual([{ path: 'a.md', status: 'A', added: 1, removed: 0 }])
    expect(snapshot.stat).toEqual({ added: 3, removed: 0 })
  })
})

describe('RepoCache.noteEvents', () => {
  async function cacheWithList(): Promise<{ dir: string; cache: RepoCache; git: Git }> {
    const { dir } = await repo({ 'a.md': 'one\n', 'docs/b.md': 'two\n', 'docs/c.md': 'three\n' })
    const git = new Git(dir)
    const cache = new RepoCache(git, dir, { statusGapMs: 0 })
    await cache.files.read()
    return { dir, cache, git }
  }

  it('reports a file edit as content only', async () => {
    const { cache } = await cacheWithList()
    expect(await cache.noteEvents([{ kind: 'change', relPath: 'a.md' }])).toEqual({ structure: false, content: true, records: [], maps: [] })
  })

  it('tells an editor saving by renaming over a file from a file added or removed', async () => {
    const { dir, cache } = await cacheWithList()
    await writeFile(path.join(dir, 'a.md.tmp'), 'new')
    await rename(path.join(dir, 'a.md.tmp'), path.join(dir, 'a.md'))
    expect(await cache.noteEvents([{ kind: 'rename', relPath: 'a.md.tmp' }, { kind: 'rename', relPath: 'a.md' }])).toMatchObject({ structure: false, content: true })

    await writeFile(path.join(dir, 'added.md'), 'x')
    expect(await cache.noteEvents([{ kind: 'rename', relPath: 'added.md' }])).toMatchObject({ structure: true })
    await cache.files.read()

    await unlink(path.join(dir, 'a.md'))
    expect(await cache.noteEvents([{ kind: 'rename', relPath: 'a.md' }])).toMatchObject({ structure: true })
  })

  it('counts a removed folder holding listed files as structure', async () => {
    const { dir, cache } = await cacheWithList()
    await rm(path.join(dir, 'docs'), { recursive: true })
    expect(await cache.noteEvents([{ kind: 'rename', relPath: 'docs' }])).toMatchObject({ structure: true })
  })

  it('reports thread records by id, without touching git status', async () => {
    const { cache } = await cacheWithList()
    expect(
      await cache.noteEvents([
        { kind: 'change', relPath: '.manta/threads/t_ab12cd34ef.json' },
        { kind: 'rename', relPath: '.manta/threads/t_ab12cd34ef.json' }
      ])
    ).toEqual({ structure: false, content: false, records: ['t_ab12cd34ef'], maps: [] })
  })

  it('reports context maps by id, without touching git status', async () => {
    const { cache } = await cacheWithList()
    expect(
      await cache.noteEvents([
        { kind: 'change', relPath: '.manta/maps/m_0a1b2c/map.md' },
        { kind: 'rename', relPath: '.manta/maps/m_0a1b2c/product.md' },
        { kind: 'rename', relPath: '.manta/maps/m_ffff00' }
      ])
    ).toEqual({ structure: false, content: false, records: [], maps: ['m_0a1b2c', 'm_ffff00'] })
  })

  it('treats ignore rule changes, unknown paths and a file list never loaded as structure', async () => {
    const { cache } = await cacheWithList()
    expect(await cache.noteEvents([{ kind: 'change', relPath: 'docs/.gitignore' }])).toMatchObject({ structure: true })
    expect(await cache.noteEvents('unknown')).toEqual({ structure: true, content: true, records: [], maps: [] })

    const { dir } = await repo()
    const fresh = new RepoCache(new Git(dir), dir)
    expect(await fresh.noteEvents([{ kind: 'rename', relPath: 'a.md' }])).toMatchObject({ structure: true })
  })

  it('reloads only the caches an event made stale', async () => {
    const { cache, git } = await cacheWithList()
    await cache.status.read()
    const listFiles = vi.spyOn(git, 'listFiles')
    const snapshot = vi.spyOn(git, 'statusSnapshot')

    await cache.noteEvents([{ kind: 'change', relPath: 'a.md' }])
    await Promise.all([cache.status.read(), cache.status.read(), cache.files.read()])
    expect(snapshot).toHaveBeenCalledTimes(1)
    expect(listFiles).not.toHaveBeenCalled()

    await cache.noteEvents([{ kind: 'change', relPath: '.manta/threads/t_ab12cd34ef.json' }])
    await cache.status.read()
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it("keeps an untracked file's line count while it is unchanged", async () => {
    const { dir, git } = await cacheWithList()
    const cache = new RepoCache(git, dir, { statusGapMs: 0 })
    await writeFile(path.join(dir, 'notes.md'), 'one\ntwo\n')
    const lineCount = vi.spyOn(git, 'lineCount')

    expect((await cache.status.read()).stat.added).toBe(2)
    cache.status.invalidate()
    expect((await cache.status.read()).stat.added).toBe(2)
    expect(lineCount).toHaveBeenCalledTimes(1)

    await writeFile(path.join(dir, 'notes.md'), 'one\ntwo\nthree\n')
    cache.status.invalidate()
    expect((await cache.status.read()).stat.added).toBe(3)
    expect(lineCount).toHaveBeenCalledTimes(2)
  })
})
