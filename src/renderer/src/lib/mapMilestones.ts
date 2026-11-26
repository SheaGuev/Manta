import type { DocRef, MapDetail, MapMilestoneInfo, MapTicket, TerminalInfo } from '../../../shared/ipc'
import { isClosed } from '../../../shared/ipc'
import { agentActivity, decisionNumber, openDecisions, ticketKey, ticketLaunches, workState } from './mapStatus'

type MapPart = Pick<MapDetail, 'key' | 'milestones' | 'decisions' | 'launches'>

/** The Milestones page's table filters. */
export type TicketFilter = 'open' | 'needs-you' | 'ready'

/** Whether a ticket waits on the user: its agent is asking, or an open decision holds it. Done tickets never do. */
export function needsYou(map: MapPart, ticket: MapTicket, terminals: readonly TerminalInfo[]): boolean {
  if (isClosed(ticket.status)) return false
  return agentActivity(map, ticket, terminals) === 'needs-you' || openDecisions(map, ticket.id).length > 0
}

export function matchesFilter(map: MapPart, ticket: MapTicket, filter: TicketFilter, terminals: readonly TerminalInfo[]): boolean {
  if (filter === 'open') return !isClosed(ticket.status)
  if (filter === 'needs-you') return needsYou(map, ticket, terminals)
  return workState(map, ticket).status === 'ready'
}

/**
 * The line under a ticket's title: why it's held up, the checks its agent attached once finished,
 * whether a ticket to do has dependencies, else the doc section it works from.
 */
export function ticketMeta(map: MapPart, ticket: MapTicket): string | null {
  const work = workState(map, ticket)
  if (work.reason) return work.reason
  const decisions = openDecisions(map, ticket.id)
  if (decisions.length > 0 && !isClosed(ticket.status)) return `Decision ${decisions.map(decisionNumber).join(', ')} required`
  if (ticket.status === 'in-review' || ticket.status === 'done') {
    const wrapUp = ticketLaunches(map, ticket.id).flatMap((l) => (l.wrapUp ? [l.wrapUp] : [])).at(-1)
    const checks = wrapUp ? wrapUp.criteria.filter((c) => c.ticket === ticket.id).length || wrapUp.checks.length : 0
    if (checks > 0) return `${checks} ${checks === 1 ? 'check' : 'checks'} attached`
  }
  if (ticket.status === 'todo') {
    const tickets = map.milestones.flatMap((m) => m.tickets)
    const after = ticket.after.flatMap((id) => tickets.find((t) => t.id === id) ?? [])
    return after.length === 0 ? 'No dependencies' : `After ${after.map((t) => ticketKey(map, t)).join(', ')}`
  }
  return ticket.docs.find((d) => d.heading)?.heading ?? null
}

/** Two refs touch the same text: the same section, or a whole doc and anything in it. */
function overlaps(a: DocRef, b: DocRef): boolean {
  return a.path === b.path && (a.heading === null || b.heading === null || a.heading === b.heading)
}

/**
 * The milestone's ready tickets that can start together, each in its own worktree: none waits on
 * another and no two work from the same doc section. Earlier tickets win a clash; `held` are the
 * ready ones left out.
 */
export function independentTickets(map: MapPart, milestone: MapMilestoneInfo): { tickets: MapTicket[]; held: MapTicket[] } {
  const tickets: MapTicket[] = []
  const held: MapTicket[] = []
  for (const ticket of milestone.tickets) {
    if (workState(map, ticket).status !== 'ready') continue
    const clash = tickets.some((t) => t.after.includes(ticket.id) || ticket.after.includes(t.id) || t.docs.some((a) => ticket.docs.some((b) => overlaps(a, b))))
    if (clash) held.push(ticket)
    else tickets.push(ticket)
  }
  return { tickets, held }
}

/** What a milestone's card in the strip says beside its key. */
export type StripMark = 'done' | 'current' | 'next' | null

/** Done, the current milestone, or the next one not done after it. */
export function stripMarks(map: Pick<MapDetail, 'milestones'>, current: string | null): Map<string, StripMark> {
  const index = map.milestones.findIndex((m) => m.id === current)
  const next = index === -1 ? undefined : map.milestones.slice(index + 1).find((m) => m.status !== 'done')
  return new Map(map.milestones.map((m): [string, StripMark] => [m.id, m.id === current ? 'current' : m.status === 'done' ? 'done' : m.id === next?.id ? 'next' : null]))
}
