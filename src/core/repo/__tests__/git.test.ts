import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_TREE, Git, LOG_FORMAT, countLines, isSafeRef, parseLog, parseNameStatusZ, parseNumstatZ, parseStatus } from '../git'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('countLines', () => {
  it.each([
    ['', 0],
    ['one', 1],
    ['one\n', 1],
    ['one\ntwo', 2]
  ])('%j has %i lines', (text, lines) => {
    expect(countLines(text)).toBe(lines)
  })
})

describe('Git.diffStat', () => {
  it('counts tracked changes and untracked files against HEAD', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-git-'))
    dirs.push(dir)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir })
    run('init', '-q', '-b', 'main')
    run('config', 'user.name', 't')
    run('config', 'user.email', 't@t')
    await writeFile(path.join(dir, 'a.md'), 'one\ntwo\n')
    run('add', '-A')
    run('commit', '-qm', 'seed')

    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\nthree\n')
    await writeFile(path.join(dir, 'new.md'), '# New\nbody\n')
    const git = new Git(dir)

    expect(await git.diffStat()).toEqual({ added: 4, removed: 1 })
    expect(await git.currentBranch()).toBe('main')
  })

  it('counts every untracked file when there are more than it reads at once', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-git-'))
    dirs.push(dir)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir })
    run('init', '-q', '-b', 'main')
    for (let i = 0; i < 40; i++) await writeFile(path.join(dir, `note-${i}.md`), 'one\ntwo\n')

    expect(await new Git(dir).diffStat()).toEqual({ added: 80, removed: 0 })
  })
})

describe('worktrees and changes', () => {
  it('creates a worktree, lists it, and reports per-file changes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-git-'))
    const wtParent = await mkdtemp(path.join(tmpdir(), 'manta-wt-'))
    dirs.push(dir, wtParent)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir })
    run('init', '-q', '-b', 'main')
    run('config', 'user.name', 't')
    run('config', 'user.email', 't@t')
    await writeFile(path.join(dir, 'a.ts'), 'one\ntwo\n')
    run('add', '-A')
    run('commit', '-qm', 'seed')
    const git = new Git(dir)

    await git.addWorktree(path.join(wtParent, 'feature'), 'manta/feature')
    const worktrees = await git.worktrees()
    expect(worktrees.map((w) => [w.branch, w.isMain])).toEqual([
      ['main', true],
      ['manta/feature', false]
    ])

    await writeFile(path.join(dir, 'a.ts'), 'one\nTWO\n')
    await writeFile(path.join(dir, 'b.ts'), 'x\ny\nz\n')
    expect(await git.changes()).toEqual({
      staged: [],
      unstaged: [
        { path: 'a.ts', status: 'M', added: 1, removed: 1 },
        { path: 'b.ts', status: 'U', added: 3, removed: 0 }
      ]
    })
    expect(await git.listFiles()).toEqual(['a.ts', 'b.ts'])
  })
})

describe('listFiles and ignored env files', () => {
  it('lists gitignored .env files but not ones in dependency folders, and grep skips them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-env-'))
    dirs.push(dir)
    execFileSync('git', ['init', '-q'], { cwd: dir })
    await writeFile(path.join(dir, '.gitignore'), '.env*\nnode_modules\n')
    await mkdir(path.join(dir, 'app'))
    await mkdir(path.join(dir, 'node_modules'))
    await writeFile(path.join(dir, '.env'), 'SECRET=hunter2\n')
    await writeFile(path.join(dir, 'app', '.env.local'), 'SECRET=hunter2\n')
    await writeFile(path.join(dir, 'node_modules', '.env'), 'x\n')
    const git = new Git(dir)
    expect(await git.listFiles()).toEqual(['.env', '.gitignore', 'app/.env.local'])
    expect(await git.grep('hunter2', 5)).toEqual([])
  })
})

describe('parseStatus', () => {
  it('splits each file into its staged and unstaged parts', () => {
    const output = ['MM both.md', 'A  added.md', ' D gone.md', 'R  new.md', 'old.md', '?? fresh.md', 'UU conflict.md', ''].join('\0')
    expect(parseStatus(output)).toEqual({
      staged: [
        { path: 'both.md', status: 'M' },
        { path: 'added.md', status: 'A' },
        { path: 'new.md', status: 'R' }
      ],
      unstaged: [
        { path: 'both.md', status: 'M' },
        { path: 'gone.md', status: 'D' },
        { path: 'fresh.md', status: 'U' },
        { path: 'conflict.md', status: 'C' }
      ]
    })
  })
})

describe('parseNumstatZ', () => {
  it('keys renames by their new path and counts binaries as 0', () => {
    const output = ['3\t1\ta.md', '2\t0\t', 'old.md', 'new.md', '-\t-\timage.png', ''].join('\0')
    expect(parseNumstatZ(output)).toEqual(
      new Map([
        ['a.md', { added: 3, removed: 1 }],
        ['new.md', { added: 2, removed: 0 }],
        ['image.png', { added: 0, removed: 0 }]
      ])
    )
  })
})

describe('staging', () => {
  async function repo(commit = true): Promise<{ dir: string; git: Git; run: (...args: string[]) => string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-git-'))
    dirs.push(dir)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    run('init', '-q', '-b', 'main')
    run('config', 'user.name', 't')
    run('config', 'user.email', 't@t')
    await writeFile(path.join(dir, 'a.md'), 'one\ntwo\n')
    if (commit) {
      run('add', '-A')
      run('commit', '-qm', 'seed')
    }
    return { dir, git: new Git(dir), run }
  }

  it('stages, unstages and commits only what is staged', async () => {
    const { dir, git, run } = await repo()
    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\n')
    await writeFile(path.join(dir, 'b.md'), 'b\n')

    await git.stage(['a.md'])
    expect(await git.changes()).toEqual({
      staged: [{ path: 'a.md', status: 'M', added: 1, removed: 1 }],
      unstaged: [{ path: 'b.md', status: 'U', added: 1, removed: 0 }]
    })
    expect(await git.hasStagedChanges()).toBe(true)

    const sha = await git.commitStaged('a only')
    expect(run('show', '--name-only', '--format=', sha).trim()).toBe('a.md')
    expect((await git.changes()).unstaged).toEqual([{ path: 'b.md', status: 'U', added: 1, removed: 0 }])
    expect(await git.hasStagedChanges()).toBe(false)

    await git.stage(['b.md'])
    await git.unstage(['b.md'])
    expect(await git.changes()).toEqual({ staged: [], unstaged: [{ path: 'b.md', status: 'U', added: 1, removed: 0 }] })
  })

  it('stages a deletion and shows a file staged then edited again in both lists', async () => {
    const { dir, git } = await repo()
    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\n')
    await git.stage(['a.md'])
    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\nthree\n')
    expect(await git.changes()).toEqual({
      staged: [{ path: 'a.md', status: 'M', added: 1, removed: 1 }],
      unstaged: [{ path: 'a.md', status: 'M', added: 1, removed: 0 }]
    })

    await unlink(path.join(dir, 'a.md'))
    await git.stage(['a.md'])
    expect((await git.changes()).staged).toEqual([{ path: 'a.md', status: 'D', added: 0, removed: 2 }])
  })

  it('discards back to the staged version and deletes untracked files, leaving the index alone', async () => {
    const { dir, git } = await repo()
    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\n')
    await git.stage(['a.md'])
    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\nthree\n')
    await writeFile(path.join(dir, 'b.md'), 'b\n')

    await git.discard(['a.md', 'b.md'])

    expect(await readFile(path.join(dir, 'a.md'), 'utf8')).toBe('one\nTWO\n')
    expect(await git.changes()).toEqual({ staged: [{ path: 'a.md', status: 'M', added: 1, removed: 1 }], unstaged: [] })
  })

  it('unstages before the first commit', async () => {
    const { git } = await repo(false)
    await git.stage(['a.md'])
    expect((await git.changes()).staged).toEqual([{ path: 'a.md', status: 'A', added: 2, removed: 0 }])
    await git.unstage(['a.md'])
    expect(await git.changes()).toEqual({ staged: [], unstaged: [{ path: 'a.md', status: 'U', added: 2, removed: 0 }] })
  })
})

describe('Git hidden paths', () => {
  async function repoWithTrackedHidden(): Promise<{ dir: string; run: (...args: string[]) => string }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-hidden-'))
    dirs.push(dir)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    run('init', '-q', '-b', 'main')
    run('config', 'user.name', 't')
    run('config', 'user.email', 't@t')
    await writeFile(path.join(dir, 'doc.md'), 'one\n')
    await mkdir(path.join(dir, '.manta', 'threads'), { recursive: true })
    await writeFile(path.join(dir, '.manta', 'threads', 't_old.json'), '{}\n')
    run('add', '-A')
    run('commit', '-qm', 'seed, from before .manta/ was kept out of git')
    return { dir, run }
  }

  it('adds a local exclude once, without touching any committed file', async () => {
    const { dir, run } = await repoWithTrackedHidden()
    const git = new Git(dir, ['.manta'])
    await git.excludeLocally('/.manta/')
    await git.excludeLocally('/.manta/')
    const exclude = await readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('\n').filter((line) => line === '/.manta/')).toHaveLength(1)
    expect(run('status', '--porcelain')).toBe('')
  })

  it('leaves hidden paths out of changes, stats and commit-all, even when they were tracked', async () => {
    const { dir, run } = await repoWithTrackedHidden()
    const git = new Git(dir, ['.manta'])
    await git.excludeLocally('/.manta/')
    await writeFile(path.join(dir, '.manta', 'threads', 't_old.json'), '{"changed":true}\n')
    await writeFile(path.join(dir, '.manta', 'threads', 't_new.json'), '{}\n')

    expect(await git.hasChanges()).toBe(false)
    expect(await git.changes()).toEqual({ staged: [], unstaged: [] })
    expect(await git.diffStat()).toEqual({ added: 0, removed: 0 })

    await writeFile(path.join(dir, 'doc.md'), 'one\ntwo\n')
    expect(await git.hasChanges()).toBe(true)
    await git.commitAll('docs: two')
    expect(run('show', '--name-only', '--format=', 'HEAD').trim()).toBe('doc.md')
    expect(run('ls-files', '.manta').trim()).toBe('.manta/threads/t_old.json')
  })

  it('keeps hidden paths out of commit-all in a repo with no commits yet', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-hidden-'))
    dirs.push(dir)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    run('init', '-q', '-b', 'main')
    run('config', 'user.name', 't')
    run('config', 'user.email', 't@t')
    await writeFile(path.join(dir, 'doc.md'), 'one\n')
    await mkdir(path.join(dir, '.manta'), { recursive: true })
    await writeFile(path.join(dir, '.manta', 'r.json'), '{}\n')
    await new Git(dir, ['.manta']).commitAll('first')
    expect(run('ls-files').trim()).toBe('doc.md')
  })

  it('a Git without hidden paths sees everything', async () => {
    const { dir } = await repoWithTrackedHidden()
    await writeFile(path.join(dir, '.manta', 'threads', 't_old.json'), '{"changed":true}\n')
    expect(await new Git(dir).hasChanges()).toBe(true)
  })
})

describe('parseNameStatusZ', () => {
  it('reads modified, added, deleted, renames by their new path with the old one beside it, and copies as added', () => {
    const out = ['M', 'a.md', 'A', 'b.md', 'D', 'c.md', 'R087', 'old.md', 'new.md', 'C100', 'src.md', 'copy.md', ''].join('\0')
    expect(parseNameStatusZ(out)).toEqual([
      { path: 'a.md', status: 'M' },
      { path: 'b.md', status: 'A' },
      { path: 'c.md', status: 'D' },
      { path: 'new.md', status: 'R', oldPath: 'old.md' },
      { path: 'copy.md', status: 'A' }
    ])
  })
})

describe('parseLog', () => {
  it('reads each commit, its first parent, and whether it is on the branch', () => {
    const record = (...fields: string[]) => `${fields.join('\x1f')}\x1e\n`
    const out = record('b'.repeat(40), `${'a'.repeat(40)} ${'f'.repeat(40)}`, 'Ada', '2026-10-21T09:00:00+01:00', 'Merge: a | b') + record('a'.repeat(40), '', 'Bo', '2026-10-20T09:00:00+01:00', 'first')
    expect(parseLog(out, new Set(['b'.repeat(40)]))).toEqual([
      { sha: 'b'.repeat(40), parent: 'a'.repeat(40), author: 'Ada', date: '2026-10-21T09:00:00+01:00', subject: 'Merge: a | b', onBranch: true },
      { sha: 'a'.repeat(40), parent: null, author: 'Bo', date: '2026-10-20T09:00:00+01:00', subject: 'first', onBranch: false }
    ])
    expect(LOG_FORMAT).toContain('%x1e')
  })
})

describe('branch history', () => {
  async function repo(): Promise<{ dir: string; run: (...args: string[]) => string; commit: (file: string, text: string, message: string) => Promise<string> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-branch-'))
    dirs.push(dir)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    run('init', '-q', '-b', 'main')
    run('config', 'user.name', 't')
    run('config', 'user.email', 't@t')
    const commit = async (file: string, text: string, message: string) => {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true })
      await writeFile(path.join(dir, file), text)
      run('add', '-A')
      run('commit', '-qm', message)
      return run('rev-parse', 'HEAD').trim()
    }
    return { dir, run, commit }
  }

  it('has nothing to compare with on the default branch without an upstream, but still lists its commits', async () => {
    const { dir, commit } = await repo()
    const git = new Git(dir)
    expect(await git.branchBase()).toBeNull()
    expect(await git.log(10, null)).toEqual([])
    const first = await commit('a.md', 'one\n', 'first')
    expect(await git.branchBase()).toBeNull()
    expect(await git.log(10, null)).toEqual([expect.objectContaining({ sha: first, parent: null, subject: 'first', author: 't', onBranch: false })])
  })

  it('compares a worktree branch with the main worktree’s branch, and marks its own commits', async () => {
    const { dir, run, commit } = await repo()
    const base = await commit('a.md', 'one\n', 'base')
    const worktree = path.join(dir, '..', `${path.basename(dir)}-wt`)
    dirs.push(worktree)
    await new Git(dir).addWorktree(worktree, 'manta/feature')
    const wt = new Git(worktree)
    const wrun = (...args: string[]) => execFileSync('git', args, { cwd: worktree, encoding: 'utf8' })
    await writeFile(path.join(worktree, 'a.md'), 'one\ntwo\n')
    await writeFile(path.join(worktree, 'b.md'), 'new\n')
    wrun('add', '-A')
    wrun('commit', '-qm', 'feature work')
    const feature = wrun('rev-parse', 'HEAD').trim()
    /** main moving on after the fork doesn't count as the branch's work. */
    await commit('c.md', 'later\n', 'main moves on')

    expect(await wt.branchBase()).toEqual({ sha: base, label: 'main' })
    expect(await wt.diffFiles(base, 'HEAD')).toEqual([
      { path: 'a.md', status: 'M', added: 1, removed: 0 },
      { path: 'b.md', status: 'A', added: 1, removed: 0 }
    ])
    const log = await wt.log(10, base)
    expect(log.map((c) => [c.subject, c.onBranch])).toEqual([
      ['feature work', true],
      ['base', false]
    ])
    expect(log[0]?.parent).toBe(base)
    expect(await wt.commitFiles(feature)).toHaveLength(2)
    expect(run('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')
  })

  it('compares a feature branch checked out in the main repo with main', async () => {
    const { dir, run, commit } = await repo()
    const base = await commit('a.md', 'one\n', 'base')
    run('switch', '-q', '-c', 'feature')
    await commit('b.md', 'b\n', 'feature work')
    expect(await new Git(dir).branchBase()).toEqual({ sha: base, label: 'main' })
  })

  it('compares with a chosen branch through their merge-base', async () => {
    const { dir, run, commit } = await repo()
    const base = await commit('a.md', 'one\n', 'base')
    run('switch', '-q', '-c', 'other')
    await commit('o.md', 'o\n', 'other work')
    run('switch', '-q', 'main')
    run('switch', '-q', '-c', 'feature')
    await commit('f.md', 'f\n', 'feature work')
    expect(await new Git(dir).branchBase('other')).toEqual({ sha: base, label: 'other' })
    expect(await new Git(dir).branchBase('missing')).toBeNull()
  })

  it('lists local then remote branches, most recent first, without remote HEADs', async () => {
    const { dir, run } = await repo()
    const commitAt = async (file: string, date: string) => {
      await writeFile(path.join(dir, file), file)
      run('add', '-A')
      execFileSync('git', ['commit', '-qm', file], { cwd: dir, env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } })
    }
    await commitAt('a.md', '2026-01-01T00:00:00Z')
    run('switch', '-q', '-c', 'older')
    await commitAt('b.md', '2026-02-01T00:00:00Z')
    run('switch', '-q', '-c', 'newer')
    await commitAt('c.md', '2026-03-01T00:00:00Z')
    const remote = await mkdtemp(path.join(tmpdir(), 'manta-remote-'))
    dirs.push(remote)
    execFileSync('git', ['init', '-q', '--bare', remote])
    run('remote', 'add', 'origin', remote)
    run('push', '-q', 'origin', 'main')
    run('remote', 'set-head', 'origin', 'main')
    expect(await new Git(dir).branches()).toEqual(['newer', 'older', 'main', 'origin/main'])
  })

  it('refuses refs git would read as options or ranges', () => {
    for (const ref of ['', '-x', '--output=f', 'a..b', 'a b', 'a\tb', 'a\nb']) expect(isSafeRef(ref)).toBe(false)
    for (const ref of ['main', 'origin/main', 'feature/x-1', 'v1.2']) expect(isSafeRef(ref)).toBe(true)
  })

  it('compares the default branch with its upstream: unpushed commits', async () => {
    const { dir, commit } = await repo()
    await commit('a.md', 'one\n', 'pushed')
    const remote = await mkdtemp(path.join(tmpdir(), 'manta-remote-'))
    dirs.push(remote)
    execFileSync('git', ['init', '-q', '--bare', remote])
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    run('remote', 'add', 'origin', remote)
    run('push', '-q', '-u', 'origin', 'main')
    const pushed = run('rev-parse', 'HEAD').trim()
    await commit('docs/b.md', 'b\n', 'not pushed')
    expect(await new Git(dir).branchBase()).toEqual({ sha: pushed, label: 'origin/main' })
    expect((await new Git(dir).diffFiles(pushed, 'HEAD')).map((f) => f.path)).toEqual(['docs/b.md'])
  })

  it('lists the first commit’s files against the empty tree, and renames by their new path', async () => {
    const { dir, run, commit } = await repo()
    const first = await commit('a.md', 'one\ntwo\n', 'first')
    const git = new Git(dir)
    expect(await git.commitFiles(first)).toEqual([{ path: 'a.md', status: 'A', added: 2, removed: 0 }])
    run('mv', 'a.md', 'renamed.md')
    run('commit', '-qm', 'rename')
    expect(await git.commitFiles('HEAD')).toEqual([{ path: 'renamed.md', status: 'R', oldPath: 'a.md', added: 0, removed: 0 }])
    expect(await git.diffFiles(EMPTY_TREE, 'HEAD')).toEqual([{ path: 'renamed.md', status: 'A', added: 2, removed: 0 }])
  })

  it('leaves hidden paths out of committed files', async () => {
    const { dir, commit } = await repo()
    await commit('a.md', 'one\n', 'first')
    const sha = await commit('.manta/r.json', '{}\n', 'records')
    expect(await new Git(dir, ['.manta']).commitFiles(sha)).toEqual([])
  })
})

describe('Git remotes and pushing', () => {
  async function clone(): Promise<{ origin: string; dir: string; run: (...args: string[]) => string; git: Git }> {
    const base = await mkdtemp(path.join(tmpdir(), 'manta-git-push-'))
    dirs.push(base)
    const origin = path.join(base, 'origin.git')
    const dir = path.join(base, 'work')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['clone', '-q', origin, dir])
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    run('config', 'user.name', 't')
    run('config', 'user.email', 't@t')
    return { origin, dir, run, git: new Git(dir) }
  }

  it('lists remote URLs once each', async () => {
    const { origin, run, git } = await clone()
    run('remote', 'add', 'upstream', 'git@github.com:o/r.git')
    expect((await git.remoteUrls()).sort()).toEqual([origin, 'git@github.com:o/r.git'].sort())
  })

  it('pushes a branch, setting its upstream, and counts commits ahead of it', async () => {
    const { origin, dir, run, git } = await clone()
    run('checkout', '-q', '-b', 'feature')
    await writeFile(path.join(dir, 'a.md'), 'one\n')
    run('add', '-A')
    run('commit', '-qm', 'one')
    expect(await git.aheadOfUpstream()).toBe(0)
    await git.pushBranch('feature', true)
    expect(await git.upstream()).toBe('origin/feature')
    await writeFile(path.join(dir, 'a.md'), 'two\n')
    run('commit', '-qam', 'two')
    expect(await git.aheadOfUpstream()).toBe(1)
    await git.pushBranch('feature', false)
    expect(await git.aheadOfUpstream()).toBe(0)
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'feature'], { cwd: origin, encoding: 'utf8' }).trim()).toBe('two')
  })

  it('gives up on a push that hangs instead of waiting for ever', async () => {
    const { dir, run, git } = await clone()
    await writeFile(path.join(dir, 'a.md'), 'one\n')
    run('add', '-A')
    run('commit', '-qm', 'one')
    /** A transport that never answers, like ssh waiting on a host-key prompt. */
    run('config', 'protocol.ext.allow', 'always')
    run('remote', 'set-url', 'origin', 'ext::sleep 30')
    const started = Date.now()
    await expect(git.pushBranch('main', true, 500)).rejects.toThrow(/didn't finish/)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reads the last commit subject, empty with no commits', async () => {
    const { dir, run, git } = await clone()
    expect(await git.lastCommitSubject()).toBe('')
    await writeFile(path.join(dir, 'a.md'), 'one\n')
    run('add', '-A')
    run('commit', '-qm', 'Add the login form\n\nWith a body')
    expect(await git.lastCommitSubject()).toBe('Add the login form')
  })
})

describe('Git diff blobs and merge-base', () => {
  async function repo(): Promise<{ dir: string; run: (...args: string[]) => string; git: Git }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'manta-git-blobs-'))
    dirs.push(dir)
    const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    run('init', '-q', '-b', 'main')
    run('config', 'user.name', 't')
    run('config', 'user.email', 't@t')
    return { dir, run, git: new Git(dir) }
  }

  it('maps each changed path to its old and new blob', async () => {
    const { dir, run, git } = await repo()
    await writeFile(path.join(dir, 'edit.md'), 'one\n')
    await writeFile(path.join(dir, 'gone.md'), 'bye\n')
    await writeFile(path.join(dir, 'move.md'), 'a long enough body that a rename is detected\nline two\nline three\n')
    run('add', '-A')
    run('commit', '-qm', 'one')
    const from = run('rev-parse', 'HEAD').trim()
    await writeFile(path.join(dir, 'edit.md'), 'two\n')
    await writeFile(path.join(dir, 'new.md'), 'hello\n')
    await unlink(path.join(dir, 'gone.md'))
    run('mv', 'move.md', 'moved.md')
    run('add', '-A')
    run('commit', '-qm', 'two')
    const to = run('rev-parse', 'HEAD').trim()
    const blob = (rev: string, file: string) => run('rev-parse', `${rev}:${file}`).trim()
    const zeros = '0'.repeat(40)
    const blobs = await git.diffBlobs(from, to)
    expect(Object.fromEntries(blobs)).toEqual({
      'edit.md': `${blob(from, 'edit.md')}:${blob(to, 'edit.md')}`,
      'new.md': `${zeros}:${blob(to, 'new.md')}`,
      'gone.md': `${blob(from, 'gone.md')}:${zeros}`,
      'moved.md': `${blob(from, 'move.md')}:${blob(to, 'moved.md')}`
    })
  })

  it("reads one file's hunks even when the user has an external diff tool and colour on", async () => {
    const { dir, run, git } = await repo()
    await writeFile(path.join(dir, 'a.md'), 'one\ntwo\n')
    run('add', '-A')
    run('commit', '-qm', 'one')
    const from = run('rev-parse', 'HEAD').trim()
    await writeFile(path.join(dir, 'a.md'), 'one\nTWO\n')
    run('commit', '-qam', 'two')
    run('config', 'diff.external', 'echo external')
    run('config', 'color.diff', 'always')
    expect(await git.fileHunks(from, 'HEAD', 'a.md')).toMatch(/^@@ -1,2 \+1,2 @@/m)
  })

  it('finds a merge-base, and null for unrelated histories', async () => {
    const { dir, run, git } = await repo()
    await writeFile(path.join(dir, 'a.md'), 'one\n')
    run('add', '-A')
    run('commit', '-qm', 'one')
    const base = run('rev-parse', 'HEAD').trim()
    run('checkout', '-q', '-b', 'side')
    await writeFile(path.join(dir, 'a.md'), 'two\n')
    run('commit', '-qam', 'two')
    expect(await git.mergeBase('side', 'main')).toBe(base)
    run('checkout', '-q', '--orphan', 'other')
    run('commit', '-q', '--allow-empty', '-m', 'unrelated')
    expect(await git.mergeBase('other', 'main')).toBeNull()
  })
})
