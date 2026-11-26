import { execFile } from 'node:child_process'
import type { PullRequestCheck, PullRequestComment, PullRequestDetail, PullRequestInfo, PullRequestReply } from '../../shared/ipc'

/** `{ found }` with the branch's newest pull request (null for none), or null when GitHub couldn't be asked. */
export type PullRequestLookup = (repoRoot: string, branch: string) => Promise<{ found: PullRequestInfo | null } | null>

/** The branch's pull request in full (null for none), or why `gh` couldn't say. */
export type PullRequestDetailLookup = (
  root: string,
  branch: string,
  options?: { force?: boolean }
) => Promise<{ found: PullRequestDetail | null } | { failed: string }>

export interface GhOptions {
  /** The `gh` executable; null when it isn't installed. */
  gh: () => string | null
  env: () => Promise<Record<string, string>>
}

export type GhResult = { ok: true; stdout: string } | { ok: false; message: string }

/** Runs `gh` in `cwd`; `input` goes to its stdin. Every GitHub call goes through one, so tests can stand in for it. */
export type GhRunner = (cwd: string, args: readonly string[], input?: string) => Promise<GhResult>

/** How long an answer is reused, so window focus changes don't each cost a GitHub call. */
const CACHE_MS = 60_000
const TIMEOUT_MS = 20_000
const UNREADABLE = "gh's answer wasn't understood"

/**
 * The user's own `gh`, which uses their GitHub login and works out the repository from the folder's
 * remotes. Prompts are off, so a missing login fails instead of waiting on a terminal that isn't there.
 */
export function ghRunner(options: GhOptions): GhRunner {
  return async (cwd, args, input) => {
    const gh = options.gh()
    if (!gh) return { ok: false, message: "gh isn't installed" }
    const env = { ...(await options.env()), GH_PROMPT_DISABLED: '1' }
    return new Promise((resolve) => {
      const child = execFile(gh, [...args], { cwd, env, timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) resolve({ ok: true, stdout })
        else if (error.killed) resolve({ ok: false, message: `gh didn't answer within ${TIMEOUT_MS / 1000} s` })
        else resolve({ ok: false, message: stderr.trim() || error.message })
      })
      /** Closed even with no input: a `gh` reading stdin would otherwise wait out the timeout. */
      child.stdin?.end(input ?? '')
    })
  }
}

/**
 * Looks pull requests up with `gh pr list --head <branch> --state all`, for implementation chips.
 * Read-only, and cached for a minute.
 */
export function ghPullRequests(options: GhOptions): PullRequestLookup {
  const run = ghRunner(options)
  const cache = new Map<string, { at: number; answer: { found: PullRequestInfo | null } }>()
  return async (repoRoot, branch) => {
    if (!options.gh()) return null
    const key = `${repoRoot}\0${branch}`
    const cached = cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.answer
    const result = await run(repoRoot, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state,url', '--limit', '1'])
    const found = result.ok ? parsePullRequests(result.stdout) : undefined
    if (found === undefined) return null
    const answer = { found }
    cache.set(key, { at: Date.now(), answer })
    return answer
  }
}

const STATES: Record<string, PullRequestInfo['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }

/** The first pull request in `gh pr list --json number,state,url` output; null for none, undefined for output it doesn't recognise. */
export function parsePullRequests(output: string): PullRequestInfo | null | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const first: unknown = parsed[0]
  if (first === undefined) return null
  if (typeof first !== 'object' || first === null) return undefined
  const number = 'number' in first ? first.number : undefined
  const state = 'state' in first && typeof first.state === 'string' ? STATES[first.state] : undefined
  const url = 'url' in first ? first.url : undefined
  if (typeof number !== 'number' || !state || typeof url !== 'string') return undefined
  return { number, state, url }
}

const VIEW_FIELDS = 'id,number,title,state,isDraft,url,baseRefName,baseRefOid,headRefName,headRefOid,author,comments,reviews,statusCheckRollup'

/** Review threads aren't in `gh pr view`'s JSON; the viewer comes along so the PR tab knows whose PR it is. */
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          id isResolved isOutdated path line originalLine diffSide
          comments(first: 50) { nodes { author { login } body url createdAt diffHunk } }
        }
      }
    }
  }
}`

/**
 * The branch's pull request with its checks, conversation and review threads: `gh pr list` finds it,
 * then `gh pr view` and one GraphQL query read it. Cached a minute per worktree and branch unless
 * forced; failures aren't cached.
 */
export function ghPullRequestDetail(run: GhRunner): PullRequestDetailLookup {
  const cache = new Map<string, { at: number; answer: { found: PullRequestDetail | null } }>()
  return async (root, branch, options = {}) => {
    const key = `${root}\0${branch}`
    const cached = cache.get(key)
    if (!options.force && cached && Date.now() - cached.at < CACHE_MS) return cached.answer
    const list = await run(root, ['pr', 'list', '--head', branch, '--state', 'all', '--json', 'number', '--limit', '1'])
    if (!list.ok) return { failed: list.message }
    const number = firstNumber(list.stdout)
    if (number === undefined) return { failed: UNREADABLE }
    let answer: { found: PullRequestDetail | null } = { found: null }
    if (number !== null) {
      const [view, threads] = await Promise.all([
        run(root, ['pr', 'view', String(number), '--json', VIEW_FIELDS]),
        run(root, ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${number}`, '-f', `query=${THREADS_QUERY}`])
      ])
      if (!view.ok) return { failed: view.message }
      if (!threads.ok) return { failed: threads.message }
      const pr = parsePullRequestDetail(view.stdout, threads.stdout)
      if (!pr) return { failed: UNREADABLE }
      answer = { found: pr }
    }
    cache.set(key, { at: Date.now(), answer })
    return answer
  }
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function text(object: Json, key: string): string | undefined {
  const value = object[key]
  return typeof value === 'string' ? value : undefined
}

function list(object: Json, key: string): unknown[] {
  const value = object[key]
  return Array.isArray(value) ? value : []
}

/** GitHub shows a deleted account as `ghost`. */
function login(value: unknown): string {
  return isObject(value) && typeof value['login'] === 'string' ? value['login'] : 'ghost'
}

function firstNumber(output: string): number | null | undefined {
  const parsed = parseJson(output)
  if (!Array.isArray(parsed)) return undefined
  const first: unknown = parsed[0]
  if (first === undefined) return null
  return isObject(first) && typeof first['number'] === 'number' ? first['number'] : undefined
}

const PR_STATES: Record<string, PullRequestDetail['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }
const CONCLUSIONS: Record<string, PullRequestCheck['state']> = {
  SUCCESS: 'passed',
  NEUTRAL: 'passed',
  SKIPPED: 'skipped',
  FAILURE: 'failed',
  TIMED_OUT: 'failed',
  CANCELLED: 'failed',
  ACTION_REQUIRED: 'failed',
  STARTUP_FAILURE: 'failed',
  STALE: 'failed'
}
const CONTEXT_STATES: Record<string, PullRequestCheck['state']> = { SUCCESS: 'passed', FAILURE: 'failed', ERROR: 'failed', PENDING: 'running', EXPECTED: 'running' }
const VERDICTS: Record<string, PullRequestComment['verdict']> = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', COMMENTED: 'commented' }

/** A `statusCheckRollup` entry: a GitHub Actions check run or a commit status. */
function parseCheck(entry: unknown): PullRequestCheck | null {
  if (!isObject(entry)) return null
  if (entry['__typename'] === 'CheckRun') {
    const name = text(entry, 'name')
    const status = text(entry, 'status')
    const conclusion = text(entry, 'conclusion') ?? ''
    const state = status === 'COMPLETED' ? CONCLUSIONS[conclusion] : status ? 'running' : undefined
    return name && state ? { name, state, url: text(entry, 'detailsUrl') || null } : null
  }
  if (entry['__typename'] === 'StatusContext') {
    const name = text(entry, 'context')
    const state = CONTEXT_STATES[text(entry, 'state') ?? '']
    return name && state ? { name, state, url: text(entry, 'targetUrl') || null } : null
  }
  return null
}

const comment = (fields: Pick<PullRequestComment, 'id' | 'kind' | 'author' | 'body' | 'url' | 'createdAt'> & Partial<PullRequestComment>): PullRequestComment => ({
  path: null,
  line: null,
  side: null,
  hunk: null,
  resolved: false,
  outdated: false,
  replies: [],
  verdict: null,
  ...fields
})

function parseThread(node: unknown): PullRequestComment | null {
  if (!isObject(node)) return null
  const id = text(node, 'id')
  const path = text(node, 'path')
  const comments = isObject(node['comments']) ? list(node['comments'], 'nodes').filter(isObject) : []
  const [first, ...rest] = comments
  if (!id || !path || !first) return null
  const body = text(first, 'body')
  const url = text(first, 'url')
  const createdAt = text(first, 'createdAt')
  if (body === undefined || !url || !createdAt) return null
  const line = node['line'] ?? node['originalLine']
  const replies = rest.flatMap((reply): PullRequestReply[] => {
    const replyBody = text(reply, 'body')
    const at = text(reply, 'createdAt')
    return replyBody !== undefined && at ? [{ author: login(reply['author']), body: replyBody, createdAt: at }] : []
  })
  return comment({
    id,
    kind: 'thread',
    author: login(first['author']),
    body,
    url,
    createdAt,
    path,
    line: typeof line === 'number' ? line : null,
    side: node['diffSide'] === 'LEFT' ? 'old' : 'new',
    hunk: text(first, 'diffHunk') ?? null,
    resolved: node['isResolved'] === true,
    outdated: node['isOutdated'] === true,
    replies
  })
}

/** Skips an entry it doesn't recognise, saying so, so one odd entry never hides the rest. */
function each<T>(entries: readonly unknown[], parse: (entry: unknown) => T | null, what: string): T[] {
  return entries.flatMap((entry) => {
    const parsed = parse(entry)
    if (parsed === null) console.error(`manta: skipped a pull request ${what} gh reported`, entry)
    return parsed === null ? [] : [parsed]
  })
}

/**
 * `gh pr view --json …` output plus the review-threads GraphQL answer, as the PR tab shows them.
 * Undefined for output it doesn't recognise; unrecognised entries inside are skipped.
 */
export function parsePullRequestDetail(view: string, threads: string): PullRequestDetail | undefined {
  const pr = parseJson(view)
  const data = parseJson(threads)
  if (!isObject(pr) || !isObject(data) || !isObject(data['data'])) return undefined
  const viewer = data['data']['viewer']
  const repository = data['data']['repository']
  const pullRequest = isObject(repository) ? repository['pullRequest'] : undefined
  const reviewThreads = isObject(pullRequest) ? pullRequest['reviewThreads'] : undefined
  if (!isObject(viewer) || typeof viewer['login'] !== 'string' || !isObject(reviewThreads)) return undefined

  const id = text(pr, 'id')
  const number = pr['number']
  const title = text(pr, 'title')
  const state = PR_STATES[text(pr, 'state') ?? '']
  const url = text(pr, 'url')
  const baseRefName = text(pr, 'baseRefName')
  const baseRefOid = text(pr, 'baseRefOid')
  const headRefName = text(pr, 'headRefName')
  const headRefOid = text(pr, 'headRefOid')
  if (!id || typeof number !== 'number' || title === undefined || !state || !url || !baseRefName || !baseRefOid || !headRefName || !headRefOid) {
    return undefined
  }

  const threadNodes = list(reviewThreads, 'nodes').filter((node) => !isObject(node) || !isObject(node['comments']) || list(node['comments'], 'nodes').length > 0)
  const conversation = each(
    list(pr, 'comments'),
    (entry) => {
      if (!isObject(entry)) return null
      const [commentId, body, at, link] = [text(entry, 'id'), text(entry, 'body'), text(entry, 'createdAt'), text(entry, 'url')]
      return commentId && body !== undefined && at && link ? comment({ id: commentId, kind: 'comment', author: login(entry['author']), body, url: link, createdAt: at }) : null
    },
    'comment'
  )
  const reviews = each(
    /** Empty summaries say nothing, and pending or dismissed reviews aren't shown. */
    list(pr, 'reviews').filter((entry) => !isObject(entry) || (text(entry, 'body') !== '' && !['PENDING', 'DISMISSED'].includes(text(entry, 'state') ?? ''))),
    (entry) => {
      if (!isObject(entry)) return null
      const [reviewId, body, at] = [text(entry, 'id'), text(entry, 'body'), text(entry, 'submittedAt')]
      const verdict = VERDICTS[text(entry, 'state') ?? '']
      /** `gh` gives reviews no URL; the PR's own is the nearest. */
      const link = text(entry, 'url') ?? url
      return reviewId && body && at && verdict ? comment({ id: reviewId, kind: 'review', author: login(entry['author']), body, url: link, createdAt: at, verdict }) : null
    },
    'review'
  )

  return {
    id,
    number,
    title,
    state: state === 'open' && pr['isDraft'] === true ? 'draft' : state,
    url,
    baseRefName,
    baseRefOid,
    headRefName,
    headRefOid,
    author: login(pr['author']),
    viewer: viewer['login'],
    checks: each(list(pr, 'statusCheckRollup'), parseCheck, 'check'),
    comments: [...each(threadNodes, parseThread, 'review thread'), ...conversation, ...reviews],
    truncated: isObject(reviewThreads['pageInfo']) && reviewThreads['pageInfo']['hasNextPage'] === true
  }
}

export type ViewedState = 'VIEWED' | 'UNVIEWED' | 'DISMISSED'

/** What the `gh` user has ticked as viewed on github.com, per file (the first 100). */
export const VIEWED_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 100) { nodes { path viewerViewedState } } } }
}`

export const MARK_VIEWED = `mutation($id: ID!, $path: String!) { markFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`
export const UNMARK_VIEWED = `mutation($id: ID!, $path: String!) { unmarkFileAsViewed(input: { pullRequestId: $id, path: $path }) { clientMutationId } }`

const VIEWED_STATES: readonly ViewedState[] = ['VIEWED', 'UNVIEWED', 'DISMISSED']

/** The `VIEWED_QUERY` answer; undefined for output it doesn't recognise, and unknown states are skipped. */
export function parseViewedFiles(output: string): Map<string, ViewedState> | undefined {
  const data = parseJson(output)
  const repository = isObject(data) && isObject(data['data']) ? data['data']['repository'] : undefined
  const pullRequest = isObject(repository) ? repository['pullRequest'] : undefined
  const files = isObject(pullRequest) ? pullRequest['files'] : undefined
  if (!isObject(files)) return undefined
  const states = new Map<string, ViewedState>()
  for (const node of list(files, 'nodes')) {
    if (!isObject(node)) continue
    const path = text(node, 'path')
    const state = VIEWED_STATES.find((s) => s === node['viewerViewedState'])
    if (path && state) states.set(path, state)
  }
  return states
}

/** `gh repo view --json nameWithOwner`: the repo `gh` takes this checkout's pull requests to be on. */
export function parseRepoName(output: string): string | undefined {
  const data = parseJson(output)
  return isObject(data) ? text(data, 'nameWithOwner') : undefined
}
