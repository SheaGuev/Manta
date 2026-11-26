import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PullRequestDetail, ReviewAnchor } from '../../../shared/ipc'
import { Git } from '../../repo/git'
import type { GhResult, GhRunner } from '../../repo/github'
import { PullRequestReviews, fetchPullRequestDiff, hunkRanges, reviewTargetProblem, staleComments } from '../pullRequestReview'
import { ReviewCommentStore } from '../reviewComments'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/**
 * A bare origin standing in for GitHub: `main`, plus a `feature` branch pushed from a second clone and
 * exposed as `refs/pull/7/head`, the way GitHub serves a pull request. The worktree never saw `feature`.
 */
async function prSetup(): Promise<{
  origin: string
  author: string
  dir: string
  git: Git
  run: (...args: string[]) => string
  runAuthor: (...args: string[]) => string
  fork: string
  publish: () => string
}> {
  const base = await mkdtemp(path.join(tmpdir(), 'manta-pr-review-'))
  dirs.push(base)
  const origin = path.join(base, 'origin.git')
  const author = path.join(base, 'author')
  const dir = path.join(base, 'work')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, author])
  const runAuthor = (...args: string[]) => execFileSync('git', args, { cwd: author, encoding: 'utf8' })
  runAuthor('config', 'user.name', 't')
  runAuthor('config', 'user.email', 't@t')
  await writeFile(path.join(author, 'a.ts'), 'one\ntwo\nthree\n')
  runAuthor('add', '-A')
  runAuthor('commit', '-qm', 'seed')
  runAuthor('push', '-q', 'origin', 'main')
  const fork = runAuthor('rev-parse', 'HEAD').trim()
  execFileSync('git', ['clone', '-q', origin, dir])
  const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  run('config', 'user.name', 't')
  run('config', 'user.email', 't@t')
  runAuthor('checkout', '-q', '-b', 'feature')
  await writeFile(path.join(author, 'a.ts'), 'one\nTWO\nthree\n')
  runAuthor('commit', '-qam', 'change two')
  await writeFile(path.join(author, 'b.ts'), 'new\n')
  runAuthor('add', '-A')
  runAuthor('commit', '-qm', 'add b')
  /** Pushes the author's feature tip and points the PR ref at it. */
  const publish = (): string => {
    runAuthor('push', '-q', '-f', 'origin', 'feature')
    const tip = runAuthor('rev-parse', 'HEAD').trim()
    execFileSync('git', ['update-ref', 'refs/pull/7/head', tip], { cwd: origin })
    return tip
  }
  publish()
  /** main moves on after the fork, so the merge-base isn't main's tip. */
  runAuthor('checkout', '-q', 'main')
  await writeFile(path.join(author, 'c.ts'), 'later\n')
  runAuthor('add', '-A')
  runAuthor('commit', '-qm', 'later on main')
  runAuthor('push', '-q', 'origin', 'main')
  runAuthor('checkout', '-q', 'feature')
  return { origin, author, dir, git: new Git(dir), run, runAuthor, fork, publish }
}

describe('hunkRanges', () => {
  it('reads hunk ranges for both sides, including one-line and empty sides', () => {
    const patch = ['diff --git a/a b/a', '@@ -3,7 +3,9 @@ fn', ' x', '@@ -10 +12 @@', '-y', '+z', '@@ -0,0 +1,4 @@', '+n'].join('\n')
    expect(hunkRanges(patch)).toEqual({
      old: [
        [3, 9],
        [10, 10]
      ],
      new: [
        [3, 11],
        [12, 12],
        [1, 4]
      ]
    })
    expect(hunkRanges('')).toEqual({ old: [], new: [] })
  })
})

describe('fetchPullRequestDiff', () => {
  it("fetches a PR's head into a hidden ref and diffs it from the merge-base with its base", async () => {
    const { git, run, fork, runAuthor } = await prSetup()
    const tip = runAuthor('rev-parse', 'HEAD').trim()
    expect(await fetchPullRequestDiff(git, { number: 7, baseRefName: 'main', url: 'https://github.com/o/r/pull/7' })).toEqual({ base: fork, head: tip })
    expect(run('rev-parse', 'refs/manta/pr/7').trim()).toBe(tip)
    expect(run('branch', '-a')).not.toContain('manta/pr')
    expect((await git.diffFiles(fork, tip)).map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('refuses an unsafe base name and a non-positive number', async () => {
    const { git } = await prSetup()
    const pr = { number: 7, baseRefName: 'main', url: 'https://github.com/o/r/pull/7' }
    await expect(fetchPullRequestDiff(git, { ...pr, baseRefName: '--upload-pack=x' })).rejects.toThrow()
    await expect(fetchPullRequestDiff(git, { ...pr, number: 0 })).rejects.toThrow()
    await expect(fetchPullRequestDiff(git, { ...pr, number: 1.5 })).rejects.toThrow()
  })

  it("fetches from the remote that holds the PR's repo when origin is a fork", async () => {
    const { git, run, fork, runAuthor, origin } = await prSetup()
    const tip = runAuthor('rev-parse', 'HEAD').trim()
    /** The PR's repo as `upstream`; `origin` a fork that has no pull request refs. */
    const forked = path.join(path.dirname(origin), 'fork.git')
    execFileSync('git', ['clone', '-q', '--bare', origin, forked])
    run('remote', 'rename', 'origin', 'upstream')
    run('remote', 'add', 'origin', forked)
    const url = `https://github.com/${path.basename(path.dirname(origin))}/origin/pull/7`
    expect(await fetchPullRequestDiff(git, { number: 7, baseRefName: 'main', url })).toEqual({ base: fork, head: tip })
    expect(run('rev-parse', 'upstream/main').trim()).toBe(runAuthor('rev-parse', 'main').trim())
  })
})

const detail = (head: string, fields: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  id: 'PR_7',
  number: 7,
  title: 'Feature',
  state: 'open',
  url: 'https://github.com/o/r/pull/7',
  baseRefName: 'main',
  baseRefOid: 'a'.repeat(40),
  headRefName: 'feature',
  headRefOid: head,
  author: 'alice',
  viewer: 'me',
  checks: [],
  comments: [],
  truncated: false,
  ...fields
})

/** A `gh` that records each call with its stdin and answers `answer`. */
function ghStub(answer: GhResult = { ok: true, stdout: '{}' }): { run: GhRunner; calls: { args: string[]; input: string | undefined }[] } {
  const calls: { args: string[]; input: string | undefined }[] = []
  return {
    calls,
    run: async (_cwd, args, input) => {
      /** Only writes are recorded; `open` also asks GitHub which files are viewed. */
      if (args[1] === '--method') calls.push({ args: [...args], input })
      return answer
    }
  }
}

async function reviewSetup(answer?: GhResult) {
  const setup = await prSetup()
  const store = new ReviewCommentStore(async () => path.join(setup.dir, '.git', 'manta', 'review-comments.json'))
  const gh = ghStub(answer)
  const stale: string[] = []
  const reviews = new PullRequestReviews({ run: gh.run, pullRequests: { markStale: (root) => stale.push(root) } })
  const head = setup.runAuthor('rev-parse', 'HEAD').trim()
  return { ...setup, store, gh, stale, reviews, head, pr: detail(head) }
}

const anchor = (fields: Partial<ReviewAnchor> = {}): ReviewAnchor => ({ relPath: 'a.ts', diff: 'pr:7', side: 'new', line: 2, lineText: 'TWO', hunk: '+TWO', ...fields })

describe('PullRequestReviews', () => {
  it('marks a file viewed only while its diff is unchanged', async () => {
    const { reviews, git, store, pr, author, runAuthor, publish, dir: setupRoot } = await reviewSetup()
    const opened = await reviews.open(git, store, pr)
    if (!opened.ok) throw new Error(opened.message)
    expect(opened.review.files.map((f) => [f.path, f.viewed])).toEqual([
      ['a.ts', false],
      ['b.ts', false]
    ])
    const a = opened.review.files.find((f) => f.path === 'a.ts')
    await reviews.setViewed(setupRoot, store, pr, 'a.ts', a?.fingerprint ?? null)
    const again = await reviews.open(git, store, pr)
    expect(again.ok && again.review.files.map((f) => f.viewed)).toEqual([true, false])

    await writeFile(path.join(author, 'a.ts'), 'one\nTWO\nTHREE\n')
    runAuthor('commit', '-qam', 'change three')
    const tip = publish()
    const moved = await reviews.open(git, store, detail(tip))
    expect(moved.ok && moved.review.files.map((f) => f.viewed)).toEqual([false, false])
  })

  it('reports unpushed local commits and an own PR', async () => {
    const { reviews, git, store, pr, dir, run, head } = await reviewSetup()
    const first = await reviews.open(git, store, pr)
    expect(first.ok && [first.review.unpushed, first.review.own]).toEqual([false, false])
    run('checkout', '-q', '-b', 'feature', head)
    await writeFile(path.join(dir, 'local.ts'), 'mine\n')
    run('add', '-A')
    run('commit', '-qm', 'local only')
    const second = await reviews.open(git, store, detail(head, { author: 'me' }))
    expect(second.ok && [second.review.unpushed, second.review.own]).toEqual([true, true])
  })

  it('posts a single comment with the PR head and refreshes the PR', async () => {
    const { reviews, gh, stale, dir, pr, head } = await reviewSetup()
    expect(await reviews.postSingle(dir, pr, head, anchor(), 'Rename')).toEqual({ ok: true, message: 'Comment posted' })
    expect(gh.calls[0]?.args).toEqual(['api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/7/comments', '--input', '-'])
    expect(JSON.parse(gh.calls[0]?.input ?? '')).toEqual({ body: 'Rename', commit_id: head, path: 'a.ts', line: 2, side: 'RIGHT' })
    expect(stale).toEqual([dir])
  })

  it('submits one review with all pending comments and clears them', async () => {
    const { reviews, gh, git, store, dir, pr, stale } = await reviewSetup()
    const opened = await reviews.open(git, store, pr)
    if (!opened.ok) throw new Error(opened.message)
    await store.add(anchor(), 'Rename')
    await store.add(anchor({ relPath: 'a.ts', side: 'old', line: 2, lineText: 'two', hunk: '-two' }), 'Why?')
    const kept = await store.add(anchor({ diff: 'branch' }), 'Not part of the review')
    const result = await reviews.submit(dir, git, store, pr, opened.review, { event: 'APPROVE', body: 'Nice' })
    expect(result).toEqual({ ok: true, message: 'Review submitted (approved)' })
    expect(gh.calls).toHaveLength(1)
    expect(gh.calls[0]?.args).toEqual(['api', '--method', 'POST', 'repos/{owner}/{repo}/pulls/7/reviews', '--input', '-'])
    const body = JSON.parse(gh.calls[0]?.input ?? '')
    expect(body.event).toBe('APPROVE')
    expect(body.commit_id).toBe(opened.review.head)
    expect(body.comments).toEqual([
      { path: 'a.ts', line: 2, side: 'RIGHT', body: 'Rename' },
      { path: 'a.ts', line: 2, side: 'LEFT', body: 'Why?' }
    ])
    expect((await store.list()).map((c) => c.id)).toEqual([kept.id])
    expect(stale).toEqual([dir])
  })

  it('refuses to submit while a pending comment no longer matches the head, and posts nothing', async () => {
    const { reviews, gh, git, store, dir, pr } = await reviewSetup()
    const opened = await reviews.open(git, store, pr)
    if (!opened.ok) throw new Error(opened.message)
    await store.add(anchor({ lineText: 'two (as it was)' }), 'Stale')
    const result = await reviews.submit(dir, git, store, pr, opened.review, { event: 'COMMENT', body: '' })
    expect(result).toEqual({ ok: false, message: '1 pending comment no longer matches the PR (a.ts:2); delete or rewrite it' })
    expect(gh.calls).toEqual([])
    expect(await store.list()).toHaveLength(1)
  })

  it('keeps every pending comment when GitHub refuses the review', async () => {
    const { reviews, git, store, dir, pr } = await reviewSetup({ ok: false, message: 'HTTP 422: Unprocessable Entity' })
    const opened = await reviews.open(git, store, pr)
    if (!opened.ok) throw new Error(opened.message)
    await store.add(anchor(), 'Rename')
    expect(await reviews.submit(dir, git, store, pr, opened.review, { event: 'COMMENT', body: '' })).toEqual({ ok: false, message: 'HTTP 422: Unprocessable Entity' })
    expect(await store.list()).toHaveLength(1)
  })

  it('refuses Approve on your own PR even if asked directly', async () => {
    const { reviews, gh, git, store, dir, head } = await reviewSetup()
    const own = detail(head, { author: 'me' })
    const opened = await reviews.open(git, store, own)
    if (!opened.ok) throw new Error(opened.message)
    expect(await reviews.submit(dir, git, store, own, opened.review, { event: 'APPROVE', body: '' })).toEqual({
      ok: false,
      message: "You can't approve or request changes on your own PR"
    })
    expect(gh.calls).toEqual([])
  })

  it('diffs, offers and takes comments on a renamed file against its old path', async () => {
    const { reviews, gh, git, store, dir, author, runAuthor, publish } = await reviewSetup()
    runAuthor('mv', 'a.ts', 'moved.ts')
    await writeFile(path.join(author, 'moved.ts'), 'one\ntwo\nthree\nfour\n')
    runAuthor('commit', '-qam', 'move a')
    const pr = detail(publish())
    const opened = await reviews.open(git, store, pr)
    if (!opened.ok) throw new Error(opened.message)
    expect(opened.review.files.find((f) => f.path === 'moved.ts')).toMatchObject({ status: 'R', oldPath: 'a.ts' })
    expect(await reviews.commentable(git, opened.review.base, opened.review.head, 'moved.ts')).toEqual({ old: [[1, 3]], new: [[1, 4]] })
    await store.add(anchor({ relPath: 'moved.ts', side: 'old', line: 2, lineText: 'two', hunk: '-two' }), 'Why?')
    expect(await reviews.submit(dir, git, store, pr, opened.review, { event: 'COMMENT', body: '' })).toEqual({ ok: true, message: 'Review submitted' })
    expect(JSON.parse(gh.calls[0]?.input ?? '').comments).toEqual([{ path: 'moved.ts', line: 2, side: 'LEFT', body: 'Why?' }])
  })

  it('reports a fetch failure as a refusal', async () => {
    const { reviews, git, store, pr, run } = await reviewSetup()
    run('remote', 'set-url', 'origin', '/nowhere/at/all.git')
    const opened = await reviews.open(git, store, pr)
    expect(opened.ok).toBe(false)
  })
})

/** A `gh` for the viewed mirror: answers the files query with `states`, and records mutations; `refuse` fails them. */
function viewedGh(states: Record<string, string>, refuse = false): { run: GhRunner; mutations: string[][] } {
  const mutations: string[][] = []
  const run: GhRunner = async (_cwd, args) => {
    const query = args.find((arg) => arg.startsWith('query=')) ?? ''
    if (query.includes('viewerViewedState')) {
      const nodes = Object.entries(states).map(([path, viewerViewedState]) => ({ path, viewerViewedState }))
      return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: { files: { nodes } } } } }) }
    }
    if (query.includes('FileAsViewed')) {
      mutations.push([...args])
      return refuse ? { ok: false, message: 'Resource not accessible by integration' } : { ok: true, stdout: '{}' }
    }
    return { ok: true, stdout: '{}' }
  }
  return { run, mutations }
}

describe('PullRequestReviews and GitHub viewed state', () => {
  it('takes viewed files from GitHub that Manta did not know', async () => {
    const setup = await reviewSetup()
    const { run } = viewedGh({ 'b.ts': 'VIEWED', 'a.ts': 'UNVIEWED' })
    const reviews = new PullRequestReviews({ run, pullRequests: { markStale: () => undefined } })
    const opened = await reviews.open(setup.git, setup.store, setup.pr)
    expect(opened.ok && opened.review.files.map((f) => [f.path, f.viewed])).toEqual([
      ['a.ts', false],
      ['b.ts', true]
    ])
    const b = opened.ok ? opened.review.files.find((f) => f.path === 'b.ts') : undefined
    expect(await setup.store.viewed(7)).toEqual({ 'b.ts': b?.fingerprint })
  })

  it('treats a dismissed file as not viewed', async () => {
    const setup = await reviewSetup()
    const first = await setup.reviews.open(setup.git, setup.store, setup.pr)
    const a = first.ok ? first.review.files.find((f) => f.path === 'a.ts') : undefined
    await setup.store.setViewed(7, 'a.ts', a?.fingerprint ?? null)
    const { run } = viewedGh({ 'a.ts': 'DISMISSED' })
    const reviews = new PullRequestReviews({ run, pullRequests: { markStale: () => undefined } })
    const opened = await reviews.open(setup.git, setup.store, setup.pr)
    expect(opened.ok && opened.review.files.find((f) => f.path === 'a.ts')?.viewed).toBe(false)
  })

  it("marks and unmarks a file on GitHub, and keeps Manta's state when GitHub refuses", async () => {
    const setup = await reviewSetup()
    const { run, mutations } = viewedGh({})
    const reviews = new PullRequestReviews({ run, pullRequests: { markStale: () => undefined } })
    expect(await reviews.setViewed(setup.dir, setup.store, setup.pr, 'a.ts', 'x:y')).toEqual({ ok: true, message: '' })
    expect(await reviews.setViewed(setup.dir, setup.store, setup.pr, 'a.ts', null)).toEqual({ ok: true, message: '' })
    expect(mutations.map((args) => [args.find((a) => a.startsWith('query='))?.includes('unmarkFileAsViewed'), args.includes('id=PR_7'), args.includes('path=a.ts')])).toEqual([
      [false, true, true],
      [true, true, true]
    ])

    const refusing = new PullRequestReviews({ run: viewedGh({}, true).run, pullRequests: { markStale: () => undefined } })
    expect(await refusing.setViewed(setup.dir, setup.store, setup.pr, 'b.ts', 'p:q')).toEqual({
      ok: true,
      message: "Kept as viewed in Manta; GitHub didn't take it, so Manta tries again when the review next opens: Resource not accessible by integration"
    })
    expect(await setup.store.viewed(7)).toEqual({ 'b.ts': 'p:q' })
    expect(await setup.store.unsyncedViewed(7)).toEqual(['b.ts'])
  })

  it('follows GitHub when a file was unticked there', async () => {
    const setup = await reviewSetup()
    const first = await setup.reviews.open(setup.git, setup.store, setup.pr)
    const a = first.ok ? first.review.files.find((f) => f.path === 'a.ts') : undefined
    await setup.store.setViewed(7, 'a.ts', a?.fingerprint ?? null)
    const { run } = viewedGh({ 'a.ts': 'UNVIEWED' })
    const reviews = new PullRequestReviews({ run, pullRequests: { markStale: () => undefined } })
    const opened = await reviews.open(setup.git, setup.store, setup.pr)
    expect(opened.ok && opened.review.files.find((f) => f.path === 'a.ts')?.viewed).toBe(false)
    expect(await setup.store.viewed(7)).toEqual({})
  })

  it("keeps a change GitHub didn't take over GitHub's state, and sends it again on the next open", async () => {
    const setup = await reviewSetup()
    const first = await setup.reviews.open(setup.git, setup.store, setup.pr)
    const b = first.ok ? first.review.files.find((f) => f.path === 'b.ts') : undefined
    /** An untick of a.ts and a tick of b.ts, both refused by GitHub earlier. */
    await setup.store.setViewed(7, 'a.ts', null, { synced: false })
    await setup.store.setViewed(7, 'b.ts', b?.fingerprint ?? null, { synced: false })

    const refusing = viewedGh({ 'a.ts': 'VIEWED', 'b.ts': 'UNVIEWED' }, true)
    const still = await new PullRequestReviews({ run: refusing.run, pullRequests: { markStale: () => undefined } }).open(setup.git, setup.store, setup.pr)
    expect(still.ok && still.review.files.map((f) => [f.path, f.viewed])).toEqual([
      ['a.ts', false],
      ['b.ts', true]
    ])
    expect(await setup.store.unsyncedViewed(7)).toEqual(['a.ts', 'b.ts'])

    const taking = viewedGh({ 'a.ts': 'VIEWED', 'b.ts': 'UNVIEWED' })
    const synced = await new PullRequestReviews({ run: taking.run, pullRequests: { markStale: () => undefined } }).open(setup.git, setup.store, setup.pr)
    expect(synced.ok && synced.review.files.map((f) => f.viewed)).toEqual([false, true])
    expect(taking.mutations.map((args) => [args.find((arg) => arg.startsWith('path=')), args.some((arg) => arg.includes('unmarkFileAsViewed'))])).toEqual([
      ['path=a.ts', true],
      ['path=b.ts', false]
    ])
    expect(await setup.store.unsyncedViewed(7)).toEqual([])
  })
})

describe('staleComments', () => {
  it('reads CRLF files the way the editor shows them', async () => {
    const comment = { ...anchor({ line: 2, lineText: 'TWO' }), id: 'rc_1', body: 'b', createdAt: 'now', sent: null }
    expect(await staleComments([comment], async () => 'one\r\nTWO\r\nthree\r\n')).toEqual([])
    expect(await staleComments([comment], async () => 'one\r\ntwo\r\n')).toEqual([comment])
  })
})

describe('PullRequestReviews.submit and lines GitHub would refuse', () => {
  it('refuses a pending comment no longer inside the diff, naming it, and posts nothing', async () => {
    const { reviews, gh, git, store, dir, pr, author, runAuthor, publish } = await reviewSetup()
    /** b.ts's only line is in the diff now; a revert of a.ts takes a.ts:2 out of it while its text stays the same. */
    await store.add(anchor({ relPath: 'a.ts', line: 1, lineText: 'one', hunk: ' one' }), 'Context comment')
    await writeFile(path.join(author, 'a.ts'), 'one\ntwo\nthree\n')
    runAuthor('commit', '-qam', 'revert a')
    const tip = publish()
    const opened = await reviews.open(git, store, detail(tip))
    if (!opened.ok) throw new Error(opened.message)
    const result = await reviews.submit(dir, git, store, detail(tip), opened.review, { event: 'COMMENT', body: '' })
    expect(result).toEqual({ ok: false, message: "1 pending comment is on a line GitHub won't take any more (a.ts:1); delete it" })
    expect(gh.calls).toEqual([])
  })
})

describe('reviewTargetProblem', () => {
  it("refuses when the worktree has left the PR's branch or the PR isn't the one the review is for", async () => {
    const { git, run, head, pr } = await reviewSetup()
    run('fetch', '-q', 'origin', 'feature')
    run('checkout', '-q', '-b', 'feature', head)
    expect(await reviewTargetProblem(git, pr, 7)).toBeNull()
    expect(await reviewTargetProblem(git, pr, 8)).toBe("This worktree's branch now has PR #7, not #8; open its review from the PR tab")
    run('checkout', '-q', '-b', 'elsewhere')
    expect(await reviewTargetProblem(git, pr, 7)).toBe('This worktree is on elsewhere, not feature, the branch of PR #7; switch back to review it')
    run('checkout', '-q', '--detach')
    expect(await reviewTargetProblem(git, pr, 7)).toBe('This worktree is on no branch, not feature, the branch of PR #7; switch back to review it')
  })
})
