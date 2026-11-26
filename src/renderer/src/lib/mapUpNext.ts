import type { MapDetail, MapDocInfo, MapDocProposal, MapLaunch, MapMilestoneInfo, MapSuggestion, MapTicket, PullRequestInfo, TerminalInfo } from '../../../shared/ipc'
import { isReady, ticketLaunches, waitingOn } from './mapStatus'

/** Something waiting on the user, in the order Needs review shows it. */
export type ReviewItem =
  | { kind: 'proposal'; proposal: MapDocProposal }
  | { kind: 'suggestion'; suggestion: MapSuggestion }
  | { kind: 'waiting'; terminal: TerminalInfo; launch: MapLaunch }
  | { kind: 'blocked'; ticket: MapTicket }
  | { kind: 'pr'; launch: MapLaunch; pr: PullRequestInfo }
  | { kind: 'ready'; launch: MapLaunch }
  | { kind: 'checks'; launch: MapLaunch; pr: PullRequestInfo }
  | { kind: 'changes'; launch: MapLaunch; pr: PullRequestInfo }

/** What the Up next block's button does. */
export type UpNextAction =
  | { kind: 'review'; item: ReviewItem }
  | { kind: 'open-session'; launch: MapLaunch; terminal: string | null }
  | { kind: 'start-ticket'; ticket: MapTicket }
  | { kind: 'start-ready'; tickets: MapTicket[] }
  | { kind: 'start-milestone'; milestone: MapMilestoneInfo }
  | { kind: 'review-pr'; pr: PullRequestInfo }
  | { kind: 'open-doc'; doc: MapDocInfo }
  | { kind: 'break-down' }
  | { kind: 'write-doc' }

export interface UpNext {
  sentence: string
  button: string
  action: UpNextAction
}

const isLive = (terminal: TerminalInfo): boolean => terminal.state !== 'exited'

/** The map's sessions that are running, with their launches. */
export function liveSessions(map: MapDetail, terminals: readonly TerminalInfo[]): { terminal: TerminalInfo; launch: MapLaunch }[] {
  return map.launches.flatMap((launch) =>
    launch.sessions.flatMap((session) => {
      const terminal = terminals.find((t) => t.id === session.terminal)
      return terminal && isLive(terminal) ? [{ terminal, launch }] : []
    })
  )
}

/** A launch whose session is working right now: what was sent to it is being dealt with. */
function working(launch: MapLaunch, terminals: readonly TerminalInfo[]): boolean {
  return launch.sessions.some((s) => terminals.some((t) => t.id === s.terminal && t.state === 'working'))
}

/** What a launch's pull request needs from the user, most urgent first: failing checks, changes asked for, then review. */
function pullRequestItem(launch: MapLaunch, pr: PullRequestInfo, terminals: readonly TerminalInfo[]): ReviewItem {
  const health = launch.health
  if (health && !working(launch, terminals)) {
    if (health.checks === 'failed') return { kind: 'checks', launch, pr }
    if (health.review === 'changes-requested' || (health.unresolved > 0 && health.review !== 'approved')) return { kind: 'changes', launch, pr }
  }
  return { kind: 'pr', launch, pr }
}

/** What a launch itself waits on the user for: its finished work's pull request, or what that pull request needs. */
function launchItem(launch: MapLaunch, terminals: readonly TerminalInfo[]): ReviewItem | null {
  if (launch.landed) return null
  if (launch.pr?.state === 'open') return pullRequestItem(launch, launch.pr, terminals)
  if (launch.readyAt && !launch.pr && !working(launch, terminals)) return { kind: 'ready', launch }
  return null
}

/** Everything waiting on the user: doc changes and suggestions, sessions asking, blocked tickets, finished work and open pull requests. */
export function needsReview(map: MapDetail, terminals: readonly TerminalInfo[]): ReviewItem[] {
  const tickets = map.milestones.flatMap((m) => m.tickets)
  return [
    ...map.proposals.map((proposal): ReviewItem => ({ kind: 'proposal', proposal })),
    ...map.suggestions.map((suggestion): ReviewItem => ({ kind: 'suggestion', suggestion })),
    ...liveSessions(map, terminals)
      .filter(({ terminal }) => terminal.state === 'waiting')
      .map(({ terminal, launch }): ReviewItem => ({ kind: 'waiting', terminal, launch })),
    ...tickets.filter((t) => t.status === 'blocked').map((ticket): ReviewItem => ({ kind: 'blocked', ticket })),
    ...map.launches.flatMap((launch) => launchItem(launch, terminals) ?? [])
  ]
}

export function reviewSentence(item: ReviewItem): string {
  switch (item.kind) {
    case 'proposal':
      return `A change is proposed to ${docName(item.proposal.doc)}: ${item.proposal.title}`
    case 'suggestion': {
      const s = item.suggestion
      if (s.kind === 'add-doc') return `Add ${docName(s.path)} to the map?`
      if (s.kind === 'write-doc') return `Write a doc: ${s.title}?`
      if (s.kind === 'ticket') return `A new ticket is proposed: ${s.ticket.title}`
      if (s.kind === 'plan-change') return `${s.changes.length} change${s.changes.length === 1 ? '' : 's'} to the plan ${s.changes.length === 1 ? 'is' : 'are'} proposed`
      return `A plan of ${s.milestones.length} milestone${s.milestones.length === 1 ? '' : 's'} is proposed`
    }
    case 'waiting':
      return `“${item.terminal.title}” is waiting for you`
    case 'blocked':
      return `“${item.ticket.title}” is blocked${item.ticket.blocked ? `: ${item.ticket.blocked}` : ''}`
    case 'pr': {
      const health = item.launch.health
      if (health?.review === 'approved' && health.checks !== 'failed' && health.checks !== 'running') return `Pull request #${item.pr.number} is approved: merge it`
      if (health?.checks === 'running') return `Pull request #${item.pr.number} is open; its checks are running`
      return `Pull request #${item.pr.number} is ready for review`
    }
    case 'ready':
      return `“${item.launch.wrapUp?.summary ? firstSentence(item.launch.wrapUp.summary) : item.launch.branch}” is finished: open its pull request`
    case 'checks':
      return `Checks failed on pull request #${item.pr.number}${item.launch.health?.failing.length ? `: ${item.launch.health.failing.slice(0, 3).join(', ')}` : ''}`
    case 'changes':
      return `Pull request #${item.pr.number} has review comments to address${item.launch.health?.unresolved ? ` (${item.launch.health.unresolved} unresolved)` : ''}`
  }
}

function firstSentence(text: string): string {
  const first = text.trim().split(/(?<=[.!?])\s/)[0] ?? text
  return first.length > 80 ? `${first.slice(0, 77)}…` : first.replace(/[.!?]$/, '')
}

export function reviewButton(item: ReviewItem): string {
  if (item.kind === 'waiting' || item.kind === 'blocked') return 'Open session'
  if (item.kind === 'pr') return 'Review PR'
  if (item.kind === 'ready') return 'Open PR'
  if (item.kind === 'checks' || item.kind === 'changes') return 'Send to session'
  return 'Review'
}

/** The ticket's session: one of its launches' sessions focused on it, else the launch's latest. */
export function ticketSession(map: MapDetail, ticket: string, terminals: readonly TerminalInfo[]): { launch: MapLaunch; terminal: string | null; live: TerminalInfo | null } | null {
  const launch = ticketLaunches(map, ticket).at(-1)
  if (!launch) return null
  const sessions = launch.sessions.filter((s) => s.ticket === ticket || s.ticket === null || !('milestone' in launch.scope))
  const session = sessions.at(-1) ?? launch.sessions.at(-1)
  const live = session ? (terminals.find((t) => t.id === session.terminal && isLive(t)) ?? null) : null
  return { launch, terminal: session?.terminal ?? null, live }
}

export function currentOf(map: MapDetail): MapMilestoneInfo | null {
  return map.milestones.find((m) => m.id === map.current?.id) ?? null
}

/** What to do about a milestone: start its next ticket, start it whole, or carry on with what's running. Null when nothing is left in it. */
function milestoneStep(map: MapDetail, milestone: MapMilestoneInfo, terminals: readonly TerminalInfo[]): UpNext | null {
  const ready = milestone.tickets.filter((t) => isReady(map, t))
  /** Each in its own worktree; in a shared one they would trip over each other. */
  if (ready.length > 1 && map.launchMode === 'ticket') {
    return { sentence: `${ready.length} tickets can start now, in parallel: ${ready.map((t) => `“${t.title}”`).join(', ')}`, button: `Start ${ready.length}`, action: { kind: 'start-ready', tickets: ready } }
  }
  const next = ready[0]
  if (next) return { sentence: `Start “${next.title}”`, button: 'Start', action: { kind: 'start-ticket', ticket: next } }
  const launched = map.launches.some((l) => 'milestone' in l.scope && l.scope.milestone === milestone.id)
  if (milestone.tickets.length === 0 && !launched && milestone.status !== 'done') {
    return { sentence: `Start the milestone “${milestone.title}”`, button: 'Start milestone', action: { kind: 'start-milestone', milestone } }
  }
  const unfinished = milestone.tickets.find((t) => t.status === 'in-progress')
  const session = unfinished ? ticketSession(map, unfinished.id, terminals) : null
  if (unfinished && session) return { sentence: `Finish “${unfinished.title}”`, button: 'Open session', action: { kind: 'open-session', launch: session.launch, terminal: session.terminal } }
  return null
}

/**
 * The one thing to do next on the map's Home: something waiting on the user, then work that's
 * running, then the current milestone's next step, then the next milestone's, then planning.
 */
export function homeUpNext(map: MapDetail, terminals: readonly TerminalInfo[]): UpNext {
  const waiting = needsReview(map, terminals)
  const first = waiting[0]
  if (first) {
    const more = waiting.length - 1
    return { sentence: `${reviewSentence(first)}${more > 0 ? ` (and ${more} more waiting)` : ''}`, button: reviewButton(first), action: { kind: 'review', item: first } }
  }
  const running = liveSessions(map, terminals)[0]
  if (running) {
    return { sentence: `“${running.terminal.title}” is running`, button: 'Open session', action: { kind: 'open-session', launch: running.launch, terminal: running.terminal.id } }
  }
  const current = currentOf(map)
  const index = current ? map.milestones.indexOf(current) : -1
  for (const milestone of current ? [current, ...map.milestones.slice(index + 1).filter((m) => m.status !== 'done')] : []) {
    const step = milestoneStep(map, milestone, terminals)
    if (step) return milestone === current ? step : { ...step, sentence: `“${current?.title}” is done. ${step.sentence}` }
  }
  return planningStep(map)
}

function planningStep(map: MapDetail): UpNext {
  if (map.milestones.length > 0) return { sentence: 'Every milestone is done. Plan what comes next', button: 'Plan more', action: { kind: 'break-down' } }
  if (map.docs.length > 0) return { sentence: 'Break the work down into milestones and tickets', button: 'Break down', action: { kind: 'break-down' } }
  return { sentence: 'Start with a PRD: what this is and why', button: 'Write a PRD', action: { kind: 'write-doc' } }
}

/** A ticket leads with starting it, opening its session, or reviewing its pull request; nothing when done. A block's reason is the ticket page's notice, so it isn't repeated here. */
export function ticketUpNext(map: MapDetail, ticket: MapTicket, terminals: readonly TerminalInfo[]): UpNext | null {
  if (ticket.status === 'done') return null
  const session = ticketSession(map, ticket.id, terminals)
  if (session) {
    const { launch } = session
    const item = launchItem(launch, terminals)
    if (item && item.kind !== 'pr') return { sentence: reviewSentence(item), button: reviewButton(item), action: { kind: 'review', item } }
  }
  if (ticket.status === 'in-review' && session?.launch.pr) return { sentence: `Pull request #${session.launch.pr.number} is open`, button: 'Review PR', action: { kind: 'review-pr', pr: session.launch.pr } }
  if (session && (ticket.status !== 'todo' || session.live)) {
    const sentence = session.live?.state === 'waiting' ? 'Its session is waiting for you' : session.live ? 'Its session is running' : ticket.status === 'blocked' ? 'Answer what it’s blocked on in its session' : 'Pick up where its session left off'
    return { sentence, button: 'Open session', action: { kind: 'open-session', launch: session.launch, terminal: session.terminal } }
  }
  const waits = waitingOn(map, ticket)
  if (waits.length > 0) return { sentence: `It waits for ${waits.map((t) => `“${t.title}”`).join(', ')}; start it anyway?`, button: 'Start', action: { kind: 'start-ticket', ticket } }
  return { sentence: 'Start work on this ticket', button: 'Start', action: { kind: 'start-ticket', ticket } }
}

export function docName(relPath: string): string {
  return (relPath.split('/').pop() ?? relPath).replace(/\.md$/, '')
}

export const STATUS_LABEL: Record<MapTicket['status'] | MapMilestoneInfo['status'], string> = {
  todo: 'to do',
  'in-progress': 'in progress',
  blocked: 'blocked',
  'in-review': 'in review',
  done: 'done'
}
