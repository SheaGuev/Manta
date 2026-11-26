import { isClosed, type MapAuthor, type MapDecision, type MapDetail, type MapLaunch, type MapMilestoneInfo, type MapStage, type MapTicket, type TerminalInfo } from '../../../shared/ipc'

export const STAGE_LABEL: Record<MapStage, string> = { planning: 'Planning', building: 'Building', validating: 'Validating', shipped: 'Shipped' }

/**
 * A ticket's work status as the map shows it, kept apart from what its agent is doing. A ticket to do
 * is Ready, or Blocked when it waits on tickets not done or an open decision.
 */
export type WorkStatus = 'ready' | 'in-progress' | 'blocked' | 'in-review' | 'done' | 'cancelled'

export interface WorkState {
  status: WorkStatus
  /** Why it's blocked (the agent's reason, "Depends on OMN-81" or "Decision 006 required") or cancelled; null otherwise. */
  reason: string | null
}

export const WORK_LABEL: Record<WorkStatus, string> = {
  ready: 'Ready',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  'in-review': 'In review',
  done: 'Done',
  cancelled: 'Cancelled'
}

/** What the agent on a ticket is doing, independent of the ticket's status. */
export type AgentActivity = 'none' | 'working' | 'needs-you' | 'paused' | 'finished'

export const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  none: 'Not started',
  working: 'Working',
  'needs-you': 'Needs your answer',
  paused: 'Paused',
  finished: 'Finished'
}

/** `OMN-12`. */
export function ticketKey(map: Pick<MapDetail, 'key'>, ticket: Pick<MapTicket, 'number'>): string {
  return `${map.key}-${ticket.number}`
}

/** `M8`: a milestone's place in the plan. */
export function milestoneKey(map: Pick<MapDetail, 'milestones'>, milestone: Pick<MapMilestoneInfo, 'id'>): string {
  return `M${map.milestones.findIndex((m) => m.id === milestone.id) + 1}`
}

/** `006`. */
export function decisionNumber(decision: Pick<MapDecision, 'number'>): string {
  return String(decision.number).padStart(3, '0')
}

/** The tickets this one waits for that aren't done; a cancelled one no longer holds it back. */
export function waitingOn(map: Pick<MapDetail, 'milestones'>, ticket: MapTicket): MapTicket[] {
  const tickets = map.milestones.flatMap((m) => m.tickets)
  return ticket.after.flatMap((id) => tickets.find((t) => t.id === id) ?? []).filter((t) => !isClosed(t.status))
}

/** Open decisions that hold this ticket back. */
export function openDecisions(map: Pick<MapDetail, 'decisions'>, ticket: string): MapDecision[] {
  return map.decisions.filter((d) => d.status === 'open' && d.blocks.includes(ticket))
}

/** To do, with every dependency done and no open decision in the way. */
export function isReady(map: Pick<MapDetail, 'milestones' | 'decisions'>, ticket: MapTicket): boolean {
  return ticket.status === 'todo' && waitingOn(map, ticket).length === 0 && openDecisions(map, ticket.id).length === 0
}

export function workState(map: Pick<MapDetail, 'key' | 'milestones' | 'decisions'>, ticket: MapTicket): WorkState {
  if (ticket.status === 'blocked') return { status: 'blocked', reason: ticket.blocked }
  if (ticket.status === 'cancelled') return { status: 'cancelled', reason: ticket.cancelled }
  if (ticket.status !== 'todo') return { status: ticket.status, reason: null }
  const waits = waitingOn(map, ticket)
  if (waits.length > 0) return { status: 'blocked', reason: `Depends on ${waits.map((t) => ticketKey(map, t)).join(', ')}` }
  const decisions = openDecisions(map, ticket.id)
  if (decisions.length > 0) return { status: 'blocked', reason: `Decision ${decisions.map(decisionNumber).join(', ')} required` }
  return { status: 'ready', reason: null }
}

/** What a launch works on, in a few words: its milestone, its ticket, or its first ticket and how many more. */
export function launchTitle(map: Pick<MapDetail, 'milestones'>, launch: MapLaunch): string {
  const scope = launch.scope
  if ('milestone' in scope) return map.milestones.find((m) => m.id === scope.milestone)?.title ?? 'A milestone'
  const ids = 'ticket' in scope ? [scope.ticket] : scope.tickets
  const found = map.milestones.flatMap((m) => m.tickets).filter((t) => ids.includes(t.id))
  return found.length > 1 ? `${found[0]?.title ?? 'Tickets'} and ${found.length - 1} more` : (found[0]?.title ?? 'A removed ticket')
}

/** Who raised something on the map, to follow "Raised by". */
export function authorLabel(map: Pick<MapDetail, 'milestones' | 'launches'>, from: MapAuthor): string {
  if ('ask' in from) return 'Ask the map'
  const id = 'launch' in from ? from.launch : from.sweep
  const launch = map.launches.find((l) => l.id === id)
  const title = launch ? `“${launchTitle(map, launch)}”` : 'a removed launch'
  return 'launch' in from ? `the agent on ${title}` : `the sweep of ${title}`
}

/** The ticket keys a decision was raised in ("OMN-81"), from the launch that raised it; empty when the user added it or the launch is gone. */
export function raisedIn(map: Pick<MapDetail, 'milestones' | 'launches' | 'key'>, from: MapAuthor | null): string[] {
  if (!from || 'ask' in from) return []
  const launch = map.launches.find((l) => l.id === ('launch' in from ? from.launch : from.sweep))
  if (!launch) return []
  const scope = launch.scope
  const ids = 'ticket' in scope ? [scope.ticket] : 'tickets' in scope ? scope.tickets : (map.milestones.find((m) => m.id === scope.milestone)?.tickets.map((t) => t.id) ?? [])
  const tickets = map.milestones.flatMap((m) => m.tickets)
  return ids.flatMap((id) => {
    const ticket = tickets.find((t) => t.id === id)
    return ticket ? [ticketKey(map, ticket)] : []
  })
}

/** The launches that worked on a ticket, newest last. */
export function ticketLaunches(map: Pick<MapDetail, 'milestones' | 'launches'>, ticket: string): MapLaunch[] {
  const milestone = map.milestones.find((m) => m.tickets.some((t) => t.id === ticket))
  return map.launches.filter((launch) => {
    const scope = launch.scope
    if ('ticket' in scope) return scope.ticket === ticket
    if ('tickets' in scope) return scope.tickets.includes(ticket)
    return scope.milestone === milestone?.id && launch.sessions.some((s) => s.ticket === ticket || s.ticket === null)
  })
}

/**
 * What the agent on a ticket is doing, from its latest launch: asking the user (a session waiting, a
 * reported need, or a blocked report), working, finished, paused (stopped without finishing), or none.
 */
export function agentActivity(map: Pick<MapDetail, 'milestones' | 'launches'>, ticket: MapTicket, terminals: readonly TerminalInfo[]): AgentActivity {
  const launch = ticketLaunches(map, ticket.id).at(-1)
  if (!launch) return 'none'
  const sessions = launch.sessions.filter((s) => s.ticket === ticket.id || s.ticket === null || !('milestone' in launch.scope))
  const session = sessions.at(-1) ?? null
  const live = session ? terminals.find((t) => t.id === session.terminal && t.state !== 'exited') : undefined
  if (live?.state === 'waiting') return 'needs-you'
  if (live?.state === 'working' || live?.state === 'starting') return 'working'
  const finished = ticket.status === 'in-review' || ticket.status === 'done' || launch.readyAt !== null || launch.wrapUp?.finished === true
  if (finished) return 'finished'
  if (ticket.status === 'blocked' || session?.progress?.needs) return 'needs-you'
  return 'paused'
}
