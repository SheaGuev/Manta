import type { OpResult, PullRequestDetail, PullRequestStatus } from '../../shared/ipc'
import { GitError, type Git } from '../repo/git'
import { ghPullRequestDetail, parseRepoName, type GhRunner, type PullRequestDetailLookup } from '../repo/github'
import type { ReviewCommentStore } from './reviewComments'
import { sendPullRequestComments, type DeliverRequest } from './sendReview'

/** True when one of the remotes is on github.com, in https or ssh form. */
export function hasGitHubRemote(urls: readonly string[]): boolean {
  return urls.some((url) => /^(?:https:\/\/(?:[^@/]+@)?|ssh:\/\/git@|git@)github\.com[:/]/.test(url))
}

/** A base as `gh pr create --base` wants it: a branch name on GitHub, not a remote-tracking ref. */
export function prBaseName(ref: string, remotes: readonly string[] = ['origin']): string {
  const remote = remotes.find((name) => ref.startsWith(`${name}/`))
  return remote ? ref.slice(remote.length + 1) : ref
}

/**
 * `owner/repo` from a remote URL in any form (https, ssh, an ssh host alias, a local path)
 * or a pull request's URL; null when there aren't two path parts to read.
 */
export function repoOfUrl(url: string): string | null {
  const trimmed = url
    .replace(/\/pull\/\d+.*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
  const match = /([^/:]+)\/([^/:]+)$/.exec(trimmed)
  return match ? `${match[1]}/${match[2]}` : null
}

export interface PullRequestsOptions {
  run: GhRunner
  ghInstalled: () => boolean
}

export interface SendCommentsRequest extends Omit<DeliverRequest, 'message'> {
  store: ReviewCommentStore
  ids: readonly string[]
  template: string
}

const message = (error: unknown): string => (error instanceof GitError ? error.stderr.trim() : error instanceof Error ? error.message : String(error))

/**
 * The PR tab's side of GitHub, per worktree: whether it can work at all, the branch's pull request,
 * sending its comments to an agent, and creating a draft. Creating a draft is the only write.
 */
export class PullRequests {
  private readonly detail: PullRequestDetailLookup
  /** The last pull request found per worktree, for sending its comments by id. */
  private readonly found = new Map<string, PullRequestDetail>()
  /** Worktrees whose next status skips the cache: a draft was just created there. */
  private readonly stale = new Set<string>()

  constructor(private readonly options: PullRequestsOptions) {
    this.detail = ghPullRequestDetail(options.run)
  }

  async status(root: string, git: Git, options: { force?: boolean } = {}): Promise<PullRequestStatus> {
    if (!this.options.ghInstalled()) return { kind: 'unavailable', reason: "Install GitHub's gh and run gh auth login to see pull requests" }
    const branch = await git.currentBranch()
    if (!branch) return { kind: 'unavailable', reason: 'Not on a branch' }
    const force = options.force === true || this.stale.delete(root)
    /** `gh` decides which remote is GitHub: an ssh host alias (`git@github-work:o/r`) only it can place. */
    const answer = await this.detail(root, branch, { force })
    if ('failed' in answer) {
      const reason = hasGitHubRemote(await git.remoteUrls()) ? answer.failed : 'This repo has no GitHub remote'
      return { kind: 'unavailable', reason }
    }
    if (!answer.found) {
      this.found.delete(root)
      return { kind: 'none', branch }
    }
    this.found.set(root, answer.found)
    return { kind: 'found', pr: answer.found }
  }

  /** The next status for `root` skips the cache: something there just changed the PR. */
  markStale(root: string): void {
    this.stale.add(root)
  }

  cached(root: string): PullRequestDetail | null {
    return this.found.get(root) ?? null
  }

  async draftDefaults(git: Git, chosenBase: string | null): Promise<{ title: string; base: string }> {
    const [title, base] = await Promise.all([git.lastCommitSubject(), chosenBase ? Promise.resolve(chosenBase) : git.branchBase(null).then((found) => found?.label ?? 'main')])
    return { title, base: prBaseName(base, (await git.remotes()).map((remote) => remote.name)) }
  }

  /** Pushes the branch when GitHub doesn't have all of it, then `gh pr create --draft`. */
  async createDraft(root: string, git: Git, input: { title: string; body: string; base: string }): Promise<OpResult> {
    const title = input.title.trim()
    if (!title) return { ok: false, message: 'Give the PR a title' }
    const branch = await git.currentBranch()
    if (!branch) return { ok: false, message: 'Not on a branch' }
    const base = prBaseName(input.base.trim(), (await git.remotes()).map((remote) => remote.name))
    if (!base || base === branch) return { ok: false, message: 'Pick a base other than this branch' }
    try {
      if (!(await git.upstream())) await git.pushBranch(branch, true)
      else if ((await git.aheadOfUpstream()) > 0) await git.pushBranch(branch, false)
    } catch (error) {
      return { ok: false, message: message(error) }
    }
    /** `--head` keeps `gh` from asking where to push. */
    const head = await this.headLabel(root, git, branch)
    const created = await this.options.run(root, ['pr', 'create', '--draft', '--title', title, '--body', input.body, '--base', base, '--head', head])
    if (!created.ok) return { ok: false, message: created.message }
    this.stale.add(root)
    return { ok: true, message: `Draft PR created: ${created.stdout.trim()}` }
  }

  /**
   * The branch as `--head` names it: `owner:branch` when it was pushed to a fork of the repo `gh`
   * opens pull requests on, the bare branch otherwise (or when either repo can't be told).
   */
  private async headLabel(root: string, git: Git, branch: string): Promise<string> {
    const [asked, upstream, remotes] = await Promise.all([this.options.run(root, ['repo', 'view', '--json', 'nameWithOwner']), git.upstream(), git.remotes()])
    const target = asked.ok ? parseRepoName(asked.stdout) : undefined
    const pushed = remotes.find((remote) => upstream?.startsWith(`${remote.name}/`))
    const pushedTo = pushed ? repoOfUrl(pushed.url) : null
    /** GitHub's names ignore case. */
    if (!target || !pushedTo || pushedTo.toLowerCase() === target.toLowerCase()) return branch
    return `${pushedTo.split('/')[0]}:${branch}`
  }

  sendComments({ store, ids, template, ...request }: SendCommentsRequest): Promise<OpResult> {
    const pr = this.cached(request.root)
    if (!pr) return Promise.resolve({ ok: false, message: 'Refresh the PR tab and try again' })
    return sendPullRequestComments({ store, ids, template, pr, ...request })
  }
}
