import type { CheckRun, CriterionResult, LaunchWrapUp, MapDetail, MapDocProposal, MapLaunch, MapTicket } from '../../../shared/ipc'
import { ticketLaunches } from './mapStatus'

/**
 * Where a ticket's review stands: its agent still at it, finished without a pull request, a pull
 * request open, merged (or finished on a shared branch) and waiting to be called done, or done.
 */
export type ReviewStage = 'working' | 'finished' | 'pr-open' | 'merged' | 'done'

export interface TicketReview {
  /** Every launch that worked on it, oldest first. */
  launches: MapLaunch[]
  /** Each wrap-up, newest first. */
  wrapUps: { launch: MapLaunch; wrapUp: LaunchWrapUp }[]
  /** Each acceptance criterion with its latest judgement; null when none judged it. */
  criteria: { index: number; text: string; result: CriterionResult | null }[]
  checks: CheckRun[]
  /** What the latest wrap-up said it did not verify. */
  unverified: string[]
  risks: string[]
  /** Doc changes its launches proposed, still waiting. */
  proposals: MapDocProposal[]
  stage: ReviewStage
  /** The launch whose pull request is open, else the finished one waiting for one. */
  launch: MapLaunch | null
  /** Its work is on a branch shared with other tickets, where the agent or the user calls it done without its own pull request. */
  shared: boolean
}

export function ticketReview(map: Pick<MapDetail, 'milestones' | 'launches' | 'proposals'>, ticket: MapTicket): TicketReview {
  const launches = ticketLaunches(map, ticket.id)
  const wrapUps = launches
    .flatMap((launch) => (launch.wrapUp ? [{ launch, wrapUp: launch.wrapUp }] : []))
    .sort((a, b) => b.wrapUp.at.localeCompare(a.wrapUp.at))
  const judged = wrapUps.find(({ wrapUp }) => wrapUp.criteria.some((c) => c.ticket === ticket.id))?.wrapUp.criteria.filter((c) => c.ticket === ticket.id) ?? []
  const latest = wrapUps[0]?.wrapUp
  const ids = new Set(launches.map((l) => l.id))
  const open = launches.find((l) => !l.landed && l.pr?.state === 'open') ?? null
  const ready = [...launches].reverse().find((l) => !l.landed && !l.pr && l.readyAt !== null) ?? null
  const shared = launches.length > 0 && launches.every((l) => !('ticket' in l.scope))
  const merged = launches.some((l) => 'ticket' in l.scope && (l.landed || l.pr?.state === 'merged'))
  const stage: ReviewStage =
    ticket.status === 'done' ? 'done' : open ? 'pr-open' : merged || (shared && latest?.finished === true) ? 'merged' : ready ? 'finished' : 'working'
  return {
    launches,
    wrapUps,
    criteria: ticket.acceptance.map((text, index) => ({ index, text, result: judged.find((c) => c.index === index) ?? null })),
    checks: latest?.checks ?? [],
    unverified: latest?.unverified ?? [],
    risks: latest?.risks ?? [],
    proposals: map.proposals.filter((p) => 'launch' in p.from && ids.has(p.from.launch)),
    stage,
    launch: open ?? ready ?? launches.at(-1) ?? null,
    shared
  }
}

/** Whether a ticket has anything to review yet: a wrap-up or a pull request. */
export function hasWork(map: Pick<MapDetail, 'milestones' | 'launches'>, ticket: MapTicket): boolean {
  return ticketLaunches(map, ticket.id).some((l) => l.wrapUp !== null || l.pr !== null)
}
