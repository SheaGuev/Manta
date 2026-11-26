import type { PullRequestCheck, PullRequestComment, PullRequestStatus } from '../../../shared/ipc'

const byPlace = (a: PullRequestComment, b: PullRequestComment): number =>
  Number(a.outdated) - Number(b.outdated) || (a.path ?? '').localeCompare(b.path ?? '') || (a.line ?? 0) - (b.line ?? 0)

/**
 * The PR tab's comment order: unresolved threads by file and line (outdated ones after current
 * ones), then the conversation and reviews oldest first; resolved threads go apart.
 */
export function orderComments(comments: readonly PullRequestComment[]): { open: PullRequestComment[]; resolved: PullRequestComment[] } {
  const threads = comments.filter((c) => c.kind === 'thread')
  const conversation = comments.filter((c) => c.kind !== 'thread').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return {
    open: [...threads.filter((c) => !c.resolved).sort(byPlace), ...conversation],
    resolved: threads.filter((c) => c.resolved).sort(byPlace)
  }
}

/** Unresolved threads on current lines start ticked, so sending them is two clicks. */
export function initiallyTicked(comments: readonly PullRequestComment[]): Set<string> {
  return new Set(comments.filter((c) => c.kind === 'thread' && !c.resolved && !c.outdated).map((c) => c.id))
}

const SUMMARY_ORDER: readonly PullRequestCheck['state'][] = ['failed', 'running', 'passed']

/** e.g. "1 failed · 2 running · 5 passed"; skipped checks and zero counts are left out. */
export function checkSummary(checks: readonly PullRequestCheck[]): string {
  return SUMMARY_ORDER.flatMap((state) => {
    const count = checks.filter((c) => c.state === state).length
    return count ? [`${count} ${state}`] : []
  }).join(' · ')
}

/** How often to refresh while the tab shows: every 30 s while a check runs, otherwise only on open and focus. */
export function refreshInterval(status: PullRequestStatus | null): number | null {
  return status?.kind === 'found' && status.pr.checks.some((c) => c.state === 'running') ? 30_000 : null
}

/**
 * What the tab shows after a refresh: a PR already showing stays when a refresh fails (a network
 * blip), with the failure as an error line, so it keeps refreshing while its checks run.
 */
export function nextStatus(previous: PullRequestStatus | null, next: PullRequestStatus): { status: PullRequestStatus; error: string | null } {
  if (previous?.kind === 'found' && next.kind === 'unavailable') return { status: previous, error: next.reason }
  return { status: next, error: null }
}

/** The ticks kept for one PR (a JSON array of comment ids); null when there are none yet or they can't be read. */
export function readTicks(stored: string | null): Set<string> | null {
  if (stored === null) return null
  try {
    const parsed: unknown = JSON.parse(stored)
    return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === 'string')) : null
  } catch {
    return null
  }
}

/** The ticked comments the user can see, in the list's order: a resolved thread only while its group is open. */
export function chosenToSend(comments: readonly PullRequestComment[], ticks: ReadonlySet<string>, showResolved: boolean): string[] {
  const { open, resolved } = orderComments(comments)
  return [...open, ...(showResolved ? resolved : [])].filter((c) => ticks.has(c.id)).map((c) => c.id)
}
