import { randomBytes } from 'node:crypto'
import type { MapDecision, MapEvent, MapEventKind, MapLaunch, MapSuggestion, TicketStatus } from '../../shared/ipc'
import { milestoneInfos, scopeMilestone, scopeTitle, type Tracker } from './mapModel'

/**
 * A map's activity log: what changed, worked out by comparing the tracker, a launch or the
 * suggestions before and after a write, and the one-time backfill from what the map already dates.
 * Pure but for the ids it gives out.
 */

const KINDS: readonly MapEventKind[] = [
  'agent-started',
  'agent-finished',
  'agent-wrapped-up',
  'pr-opened',
  'pr-merged',
  'ticket-done',
  'ticket-blocked',
  'ticket-in-review',
  'ticket-cancelled',
  'milestone-done',
  'decision-raised',
  'decision-decided',
  'decision-superseded',
  'decision-reopened',
  'suggestion',
  'suggestion-accepted',
  'suggestion-dismissed',
  'doc-change-proposed'
]

export const newEventId = (): string => `ev_${randomBytes(5).toString('hex')}`

type EventFields = Partial<Omit<MapEvent, 'id' | 'kind' | 'at' | 'title'>> & { kind: MapEventKind; at: string; title: string }

export function event(fields: EventFields): MapEvent {
  return { id: newEventId(), detail: '', ticket: null, milestone: null, launch: null, decision: null, suggestion: null, doc: null, thread: null, ...fields }
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** A stored event, or null for anything malformed. */
export function parseMapEvent(value: unknown): MapEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = Object.fromEntries(Object.entries(value))
  const kind = KINDS.find((k) => k === v['kind'])
  const id = text(v['id'])
  const at = text(v['at'])
  const title = text(v['title'])
  if (!kind || !id || !at || title === null) return null
  return {
    id,
    at,
    kind,
    title,
    detail: text(v['detail']) ?? '',
    ticket: text(v['ticket']),
    milestone: text(v['milestone']),
    launch: text(v['launch']),
    decision: text(v['decision']),
    suggestion: text(v['suggestion']),
    doc: text(v['doc']),
    thread: text(v['thread'])
  }
}

const STATUS_EVENT: Partial<Record<TicketStatus, MapEventKind>> = { done: 'ticket-done', blocked: 'ticket-blocked', 'in-review': 'ticket-in-review', cancelled: 'ticket-cancelled' }

/** The tracker's changes as events: tickets done, blocked, in review or cancelled; milestones done; decisions raised, decided, superseded or reopened. */
export function trackerEvents(before: Tracker, after: Tracker, launches: readonly MapLaunch[], at: string): MapEvent[] {
  const events: MapEvent[] = []
  const was = new Map(before.milestones.flatMap((m) => m.tickets.map((t): [string, TicketStatus] => [t.id, t.status])))
  for (const milestone of after.milestones) {
    for (const ticket of milestone.tickets) {
      const kind = STATUS_EVENT[ticket.status]
      if (!kind || was.get(ticket.id) === ticket.status) continue
      events.push(event({ kind, at, title: ticket.title, detail: ticket.status === 'blocked' ? (ticket.blocked ?? '') : ticket.status === 'cancelled' ? (ticket.cancelled ?? '') : '', ticket: ticket.id, milestone: milestone.id }))
    }
  }
  const done = new Set(milestoneInfos(before, launches).filter((m) => m.status === 'done').map((m) => m.id))
  for (const milestone of milestoneInfos(after, launches)) {
    if (milestone.status === 'done' && !done.has(milestone.id) && before.milestones.some((m) => m.id === milestone.id)) {
      events.push(event({ kind: 'milestone-done', at, title: milestone.title, milestone: milestone.id }))
    }
  }
  const decisions = new Map(before.decisions.map((d) => [d.id, d]))
  for (const decision of after.decisions) {
    const kind = decisionChange(decisions.get(decision.id), decision)
    if (kind) events.push(decisionEvent(kind, decision, at))
  }
  return events
}

function decisionChange(before: MapDecision | undefined, after: MapDecision): MapEventKind | null {
  if (!before) return 'decision-raised'
  if (before.status === after.status) return null
  if (after.status === 'decided') return 'decision-decided'
  if (after.status === 'superseded') return 'decision-superseded'
  return 'decision-reopened'
}

function decisionEvent(kind: MapEventKind, decision: MapDecision, at: string): MapEvent {
  const detail = kind === 'decision-raised' ? decision.question : kind === 'decision-decided' ? decision.outcome : ''
  return event({ kind, at, title: decision.title, detail: firstLine(detail), decision: decision.id })
}

function firstLine(value: string): string {
  const line = value.trim().split('\n')[0] ?? ''
  return line.length > 160 ? `${line.slice(0, 157)}…` : line
}

/** What a launch is about, for its events: its title, and its ticket and milestone when it has them. */
function launchSubject(tracker: Tracker, launch: MapLaunch): Pick<MapEvent, 'title' | 'ticket' | 'milestone' | 'launch'> {
  const ticket = 'ticket' in launch.scope ? launch.scope.ticket : null
  return { title: scopeTitle(tracker, launch.scope), ticket, milestone: scopeMilestone(tracker, launch.scope)?.id ?? null, launch: launch.id }
}

/** A launch's changes as events: sessions started, a wrap-up recorded, its pull request opened or landed. */
export function launchEvents(tracker: Tracker, before: MapLaunch | null, after: MapLaunch, at: string): MapEvent[] {
  const subject = launchSubject(tracker, after)
  const events: MapEvent[] = []
  const known = new Set(before?.sessions.map((s) => s.terminal) ?? [])
  for (const session of after.sessions) if (!known.has(session.terminal)) events.push(event({ ...subject, kind: 'agent-started', at: session.startedAt || at }))
  const wrapUp = after.wrapUp
  if (wrapUp && wrapUp.at !== before?.wrapUp?.at) events.push(event({ ...subject, kind: wrapUp.finished ? 'agent-finished' : 'agent-wrapped-up', at: wrapUp.at || at, detail: firstLine(wrapUp.summary) }))
  if (after.pr && after.pr.number !== before?.pr?.number) events.push(event({ ...subject, kind: 'pr-opened', at, detail: `Pull request #${after.pr.number}` }))
  if (after.landed && !before?.landed) events.push(event({ ...subject, kind: 'pr-merged', at, detail: after.pr ? `Pull request #${after.pr.number}` : after.branch }))
  return events
}

/** A suggestion in a few words, for its events. */
export function suggestionTitle(suggestion: MapSuggestion): string {
  switch (suggestion.kind) {
    case 'add-doc':
      return `Add ${suggestion.path} to the map`
    case 'write-doc':
      return `Write a doc: ${suggestion.title}`
    case 'ticket':
      return `A new ticket: ${suggestion.ticket.title}`
    case 'plan-change':
      return `${suggestion.changes.length} ${suggestion.changes.length === 1 ? 'change' : 'changes'} to the plan`
    case 'plan':
      return `A plan of ${suggestion.milestones.length} ${suggestion.milestones.length === 1 ? 'milestone' : 'milestones'}`
  }
}

export function suggestionEvent(kind: 'suggestion' | 'suggestion-accepted' | 'suggestion-dismissed', suggestion: MapSuggestion, at: string): MapEvent {
  return event({ kind, at, title: suggestionTitle(suggestion), detail: kind === 'suggestion' ? firstLine(suggestion.why) : '', suggestion: suggestion.id })
}

/**
 * A map's history from what it already dates, for a map without a log: sessions started, wrap-ups,
 * decisions raised and decided, suggestions waiting. When tickets were done or work merged wasn't
 * kept, so those aren't made up. Oldest first.
 */
export function backfillEvents(tracker: Tracker, launches: readonly MapLaunch[], suggestions: readonly MapSuggestion[]): MapEvent[] {
  const events: MapEvent[] = []
  for (const launch of launches) {
    const subject = launchSubject(tracker, launch)
    for (const session of launch.sessions) if (session.startedAt) events.push(event({ ...subject, kind: 'agent-started', at: session.startedAt }))
    const wrapUp = launch.wrapUp
    if (wrapUp?.at) events.push(event({ ...subject, kind: wrapUp.finished ? 'agent-finished' : 'agent-wrapped-up', at: wrapUp.at, detail: firstLine(wrapUp.summary) }))
  }
  for (const decision of tracker.decisions) {
    if (decision.createdAt) events.push(decisionEvent('decision-raised', decision, decision.createdAt))
    if (decision.decidedAt && decision.status !== 'open') events.push(decisionEvent(decision.status === 'superseded' ? 'decision-superseded' : 'decision-decided', decision, decision.decidedAt))
  }
  for (const suggestion of suggestions) if (suggestion.at) events.push(suggestionEvent('suggestion', suggestion, suggestion.at))
  return events.sort((a, b) => a.at.localeCompare(b.at))
}
