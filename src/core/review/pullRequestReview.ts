import type { OpResult, PullRequestDetail, PullRequestReviewInfo, PullRequestReviewOpen, ReviewAnchor, ReviewComment, ReviewEvent } from '../../shared/ipc'
import { GitError, isSafeRef, type Git } from '../repo/git'
import { MARK_VIEWED, UNMARK_VIEWED, VIEWED_QUERY, parseViewedFiles, type GhResult, type GhRunner, type ViewedState } from '../repo/github'
import { reviewProblem, reviewRequest, singleCommentRequest } from './pullRequestRequests'
import { repoOfUrl, type PullRequests } from './pullRequests'
import type { ReviewCommentStore } from './reviewComments'

/** Inclusive line numbers. */
export type LineRange = [number, number]

/** The lines a unified diff's hunks cover on each side: where GitHub accepts a line comment. */
export function hunkRanges(patch: string): { old: LineRange[]; new: LineRange[] } {
  const ranges: { old: LineRange[]; new: LineRange[] } = { old: [], new: [] }
  for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [, oldStart = '0', oldCount = '1', newStart = '0', newCount = '1'] = match
    if (Number(oldCount) > 0) ranges.old.push([Number(oldStart), Number(oldStart) + Number(oldCount) - 1])
    if (Number(newCount) > 0) ranges.new.push([Number(newStart), Number(newStart) + Number(newCount) - 1])
  }
  return ranges
}

/**
 * Fetches a pull request's head into `refs/manta/pr/<n>` (outside `refs/heads` and `refs/remotes`, so
 * no branch list shows it) and its base branch, and returns the PR's diff the way GitHub draws it: from
 * the merge-base with the base branch to the head. Both come from the remote that points at the PR's
 * repo, which isn't `origin` when `origin` is a fork; `origin` when none does.
 */
export async function fetchPullRequestDiff(git: Git, pr: Pick<PullRequestDetail, 'number' | 'baseRefName' | 'url'>): Promise<{ base: string; head: string }> {
  const { number, baseRefName } = pr
  if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid pull request number ${number}`)
  if (!isSafeRef(baseRefName)) throw new Error(`Invalid base branch ${baseRefName}`)
  const repo = repoOfUrl(pr.url)?.toLowerCase()
  const holder = (await git.remotes()).find((remote) => repo !== undefined && repoOfUrl(remote.url)?.toLowerCase() === repo && isSafeRef(remote.name))
  const remote = holder?.name ?? 'origin'
  const ref = `refs/manta/pr/${number}`
  const tracking = `refs/remotes/${remote}/${baseRefName}`
  try {
    await git.fetchRefspecs(remote, [`+refs/pull/${number}/head:${ref}`, `+refs/heads/${baseRefName}:${tracking}`])
  } catch (error) {
    if (holder || !repo) throw error
    throw new Error(`Couldn't fetch #${number} from origin, and no remote points at ${repo}; add one with git remote add upstream <its URL>`)
  }
  const head = await git.resolve(ref)
  if (!head) throw new Error(`Couldn't read the fetched head of #${number}`)
  const base = await git.mergeBase(head, tracking)
  if (!base) throw new Error(`No common history with ${remote}/${baseRefName}`)
  return { base, head }
}

/**
 * Why a review tab's action mustn't go ahead: the worktree has left the PR's branch, or its branch now
 * has another PR than the one the tab is for. Null when it's still the same PR on the same branch.
 */
export async function reviewTargetProblem(git: Git, pr: Pick<PullRequestDetail, 'number' | 'headRefName'>, number: number): Promise<string | null> {
  const branch = await git.currentBranch()
  if (branch !== pr.headRefName) return `This worktree is on ${branch || 'no branch'}, not ${pr.headRefName}, the branch of PR #${pr.number}; switch back to review it`
  if (pr.number !== number) return `This worktree's branch now has PR #${pr.number}, not #${number}; open its review from the PR tab`
  return null
}

/** Pending comments whose line no longer reads as it did when they were written: the PR moved under them. */
export async function staleComments(
  comments: readonly ReviewComment[],
  fileAt: (side: 'old' | 'new', relPath: string) => Promise<string | null>
): Promise<ReviewComment[]> {
  const stale: ReviewComment[] = []
  for (const comment of comments) {
    const text = await fileAt(comment.side, comment.relPath)
    /** Split the way the editor does, so a CRLF file's lines carry no `\r`. */
    if (text?.split(/\r\n|\r|\n/)[comment.line - 1] !== comment.lineText) stale.push(comment)
  }
  return stale
}

/** Each renamed file's old path, by its new one. */
async function renames(git: Git, base: string, head: string): Promise<Map<string, string>> {
  return new Map((await git.diffFiles(base, head)).flatMap((file) => (file.oldPath ? [[file.path, file.oldPath]] : [])))
}

const VERDICTS: Record<ReviewEvent, string> = { COMMENT: '', APPROVE: ' (approved)', REQUEST_CHANGES: ' (changes requested)' }

const message = (error: unknown): string => (error instanceof GitError ? error.stderr.trim() : error instanceof Error ? error.message : String(error))

export interface PullRequestReviewsOptions {
  run: GhRunner
  /** Told when Manta changed the PR on GitHub, so its next status skips the cache. */
  pullRequests: Pick<PullRequests, 'markStale'>
}

/**
 * Reviewing a pull request inside Manta: its diff and viewed files, single comments posted at once,
 * and the pending review (the worktree's `pr:<n>` review comments) submitted in one request.
 */
export class PullRequestReviews {
  constructor(private readonly options: PullRequestReviewsOptions) {}

  async open(git: Git, store: ReviewCommentStore, pr: PullRequestDetail): Promise<PullRequestReviewOpen> {
    let diff: { base: string; head: string }
    try {
      diff = await fetchPullRequestDiff(git, pr)
    } catch (error) {
      return { ok: false, message: message(error) }
    }
    const [files, blobs, viewed, unsynced, contained, onGitHub] = await Promise.all([
      git.diffFiles(diff.base, diff.head),
      git.diffBlobs(diff.base, diff.head),
      store.viewed(pr.number),
      store.unsyncedViewed(pr.number),
      git.isAncestor('HEAD', diff.head),
      this.viewedOnGitHub(git.cwd, pr.number)
    ])
    /**
     * GitHub's tick wins, and Manta's copy follows it, so it holds when GitHub can't be asked. A change
     * GitHub refused earlier wins over GitHub instead, and goes to GitHub again.
     */
    const reviewed = []
    for (const file of files) {
      const fingerprint = blobs.get(file.path) ?? ''
      const inManta = fingerprint !== '' && viewed[file.path] === fingerprint
      const github = onGitHub.get(file.path)
      let isViewed = inManta
      if (unsynced.includes(file.path)) {
        if ((await this.mirror(git.cwd, pr, file.path, inManta)).ok) await store.setViewed(pr.number, file.path, inManta ? fingerprint : null)
      } else if (github !== undefined) {
        /** DISMISSED: GitHub saw the file change since it was ticked. */
        isViewed = github === 'VIEWED' && fingerprint !== ''
        if (isViewed !== inManta) await store.setViewed(pr.number, file.path, isViewed ? fingerprint : null)
      }
      reviewed.push({ ...file, fingerprint, viewed: isViewed })
    }
    return {
      ok: true,
      review: {
        number: pr.number,
        ...diff,
        files: reviewed,
        unpushed: !contained,
        own: pr.author === pr.viewer
      }
    }
  }

  /** Where GitHub takes a line comment on `relPath`; a renamed file is diffed against its old path, as GitHub does. */
  async commentable(git: Git, base: string, head: string, relPath: string): Promise<{ old: LineRange[]; new: LineRange[] }> {
    return hunkRanges(await git.fileHunks(base, head, relPath, (await renames(git, base, head)).get(relPath)))
  }

  /**
   * GitHub's own viewed tick, then Manta's, so the two match. A GitHub refusal still keeps Manta's,
   * marked unsynced, so the next open keeps it over GitHub's and sends it again.
   */
  async setViewed(root: string, store: ReviewCommentStore, pr: Pick<PullRequestDetail, 'number' | 'id'>, relPath: string, fingerprint: string | null): Promise<OpResult> {
    const mirrored = await this.mirror(root, pr, relPath, fingerprint !== null)
    await store.setViewed(pr.number, relPath, fingerprint, { synced: mirrored.ok })
    if (!mirrored.ok) {
      return { ok: true, message: `Kept as ${fingerprint ? 'viewed' : 'not viewed'} in Manta; GitHub didn't take it, so Manta tries again when the review next opens: ${mirrored.message}` }
    }
    /** Nothing worth saying when both took it; the tick itself shows it. */
    return { ok: true, message: '' }
  }

  private mirror(root: string, pr: Pick<PullRequestDetail, 'id'>, relPath: string, viewed: boolean): Promise<GhResult> {
    const mutation = viewed ? MARK_VIEWED : UNMARK_VIEWED
    return this.options.run(root, ['api', 'graphql', '-f', `id=${pr.id}`, '-f', `path=${relPath}`, '-f', `query=${mutation}`])
  }

  /** GitHub's viewed ticks; empty when it can't be asked, so Manta's own stand. */
  private async viewedOnGitHub(root: string, number: number): Promise<Map<string, ViewedState>> {
    const result = await this.options.run(root, ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${number}`, '-f', `query=${VIEWED_QUERY}`])
    return (result.ok ? parseViewedFiles(result.stdout) : undefined) ?? new Map()
  }

  /** Posts one line comment to GitHub at once, on the head the review shows. */
  async postSingle(root: string, pr: PullRequestDetail, head: string, anchor: ReviewAnchor, body: string): Promise<OpResult> {
    const request = singleCommentRequest({ commitId: head, relPath: anchor.relPath, side: anchor.side, line: anchor.line, body })
    const posted = await this.post(root, `repos/{owner}/{repo}/pulls/${pr.number}/comments`, request)
    if (!posted.ok) return posted
    this.options.pullRequests.markStale(root)
    return { ok: true, message: 'Comment posted' }
  }

  /** Submits the pending review in one request; nothing is cleared unless GitHub took it. */
  async submit(
    root: string,
    git: Git,
    store: ReviewCommentStore,
    pr: PullRequestDetail,
    review: Pick<PullRequestReviewInfo, 'base' | 'head'>,
    input: { event: ReviewEvent; body: string }
  ): Promise<OpResult> {
    const pending = (await store.list()).filter((comment) => comment.diff === `pr:${pr.number}`)
    const problem = reviewProblem({ ...input, count: pending.length, own: pr.author === pr.viewer })
    if (problem) return { ok: false, message: problem }
    const renamed = await renames(git, review.base, review.head)
    /** A renamed file's old side is at its old path. */
    const stale = await staleComments(pending, (side, relPath) => (side === 'old' ? git.show(review.base, renamed.get(relPath) ?? relPath) : git.show(review.head, relPath)))
    if (stale.length > 0) {
      const places = stale.map((c) => `${c.relPath}:${c.line}`).join(', ')
      return stale.length === 1
        ? { ok: false, message: `1 pending comment no longer matches the PR (${places}); delete or rewrite it` }
        : { ok: false, message: `${stale.length} pending comments no longer match the PR (${places}); delete or rewrite them` }
    }
    /** GitHub refuses the whole review over one comment outside its diff: a reverted change, or a file gone from the PR. */
    const refused: ReviewComment[] = []
    const ranges = new Map<string, { old: LineRange[]; new: LineRange[] }>()
    for (const comment of pending) {
      const file = ranges.get(comment.relPath) ?? hunkRanges(await git.fileHunks(review.base, review.head, comment.relPath, renamed.get(comment.relPath)))
      ranges.set(comment.relPath, file)
      if (!file[comment.side].some(([from, to]) => comment.line >= from && comment.line <= to)) refused.push(comment)
    }
    if (refused.length > 0) {
      const places = refused.map((c) => `${c.relPath}:${c.line}`).join(', ')
      return refused.length === 1
        ? { ok: false, message: `1 pending comment is on a line GitHub won't take any more (${places}); delete it` }
        : { ok: false, message: `${refused.length} pending comments are on lines GitHub won't take any more (${places}); delete them` }
    }
    const request = reviewRequest({ commitId: review.head, event: input.event, body: input.body, comments: pending })
    const posted = await this.post(root, `repos/{owner}/{repo}/pulls/${pr.number}/reviews`, request)
    if (!posted.ok) return posted
    await store.remove(pending.map((comment) => comment.id))
    this.options.pullRequests.markStale(root)
    return { ok: true, message: `Review submitted${VERDICTS[input.event]}` }
  }

  private async post(root: string, endpoint: string, body: object): Promise<OpResult> {
    const result = await this.options.run(root, ['api', '--method', 'POST', endpoint, '--input', '-'], JSON.stringify(body))
    return result.ok ? { ok: true, message: '' } : { ok: false, message: result.message }
  }
}
