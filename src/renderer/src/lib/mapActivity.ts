import type { MapDetail, MapEvent, MapEventKind, TerminalInfo } from '../../../shared/ipc'
import { decisionNumber, milestoneKey } from './mapStatus'

export type ActivityFilter = 'all' | 'agents' | 'docs' | 'decisions' | 'milestones'

export const FILTER_LABEL: Record<ActivityFilter, string> = { all: 'All', agents: 'Agents', docs: 'Docs', decisions: 'Decisions', milestones: 'Milestones' }

const CATEGORY: Record<MapEventKind, Exclude<ActivityFilter, 'all'>> = {
  'agent-started': 'agents',
  'agent-finished': 'agents',
  'agent-wrapped-up': 'agents',
  'pr-opened': 'agents',
  'pr-merged': 'agents',
  'ticket-done': 'milestones',
  'ticket-blocked': 'milestones',
  'ticket-in-review': 'milestones',
  'milestone-done': 'milestones',
  'decision-raised': 'decisions',
  'decision-decided': 'decisions',
  'decision-superseded': 'decisions',
  'decision-reopened': 'decisions',
  suggestion: 'milestones',
  'suggestion-accepted': 'milestones',
  'suggestion-dismissed': 'milestones',
  'doc-change-proposed': 'docs'
}

/** The small label over an event's title. */
export const KIND_LABEL: Record<MapEventKind, string> = {
  'agent-started': 'Agent started',
  'agent-finished': 'Agent finished',
  'agent-wrapped-up': 'Agent wrapped up',
  'pr-opened': 'Pull request opened',
  'pr-merged': 'Merged',
  'ticket-done': 'Ticket done',
  'ticket-blocked': 'Blocked',
  'ticket-in-review': 'In review',
  'milestone-done': 'Milestone done',
  'decision-raised': 'Decision needed',
  'decision-decided': 'Decided',
  'decision-superseded': 'Superseded',
  'decision-reopened': 'Decision reopened',
  suggestion: 'Suggestion',
  'suggestion-accepted': 'Suggestion accepted',
  'suggestion-dismissed': 'Suggestion dismissed',
  'doc-change-proposed': 'Doc change proposed'
}

export function inFilter(event: MapEvent, filter: ActivityFilter): boolean {
  return filter === 'all' || CATEGORY[event.kind] === filter
}

/**
 * Whether what the event is about still waits on the user now: a decision still open, finished work
 * not reviewed, a pull request still open, a doc change or suggestion still waiting, a ticket still
 * blocked, an agent asking.
 */
export function needsAction(event: MapEvent, map: MapDetail, terminals: readonly TerminalInfo[]): boolean {
  const launch = event.launch ? map.launches.find((l) => l.id === event.launch) : undefined
  const ticket = event.ticket ? map.milestones.flatMap((m) => m.tickets).find((t) => t.id === event.ticket) : undefined
  switch (event.kind) {
    case 'decision-raised':
    case 'decision-reopened':
      return map.decisions.some((d) => d.id === event.decision && d.status === 'open')
    case 'agent-finished':
      return launch !== undefined && !launch.landed && (ticket ? ticket.status !== 'done' : true)
    case 'pr-opened':
      return launch?.pr?.state === 'open' && !launch.landed
    case 'agent-started':
      return launch !== undefined && launch.sessions.some((s) => terminals.some((t) => t.id === s.terminal && t.state === 'waiting'))
    case 'doc-change-proposed':
      return map.proposals.some((p) => p.thread === event.thread)
    case 'suggestion':
      return map.suggestions.some((s) => s.id === event.suggestion)
    case 'ticket-blocked':
      return ticket?.status === 'blocked'
    default:
      return false
  }
}

/** One entry of the feed: an event, or several alike in a row (tickets done in one milestone, changes to one doc). */
export interface FeedItem {
  key: string
  events: MapEvent[]
}

/** One day of the feed. */
export interface FeedDay {
  label: string
  /** Today's entries show as cards; older ones as rows. */
  today: boolean
  items: FeedItem[]
}

function dayStart(time: number): number {
  const d = new Date(time)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayLabel(at: string, now: number): string {
  const start = dayStart(Date.parse(at))
  const today = dayStart(now)
  if (start === today) return 'Today'
  if (start === today - 86_400_000) return 'Yesterday'
  return new Date(start).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

/** Events alike enough to show as one: tickets done in the same milestone, or changes to the same doc. */
function groupsWith(a: MapEvent, b: MapEvent): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'ticket-done') return a.milestone !== null && a.milestone === b.milestone
  if (a.kind === 'doc-change-proposed') return a.doc !== null && a.doc === b.doc
  return false
}

/** The events, newest first, by day, with alike events in a row grouped. */
export function feedDays(events: readonly MapEvent[], now: number = Date.now()): FeedDay[] {
  const days: FeedDay[] = []
  for (const event of events) {
    const label = dayLabel(event.at, now)
    let day = days.at(-1)
    if (!day || day.label !== label) {
      day = { label, today: label === 'Today', items: [] }
      days.push(day)
    }
    const last = day.items.at(-1)
    const first = last?.events[0]
    if (last && first && groupsWith(first, event)) last.events.push(event)
    else day.items.push({ key: event.id, events: [event] })
  }
  return days
}

/** A feed entry's headline: "Staging verification is ready for review", "3 tickets done in M4". */
export function itemTitle(item: FeedItem, map: Pick<MapDetail, 'milestones' | 'docs'>): string {
  const first = item.events[0]
  if (!first) return ''
  const n = item.events.length
  if (first.kind === 'ticket-done' && n > 1) {
    const milestone = map.milestones.find((m) => m.id === first.milestone)
    return `${n} tickets done in ${milestone ? milestoneKey(map, milestone) : 'a removed milestone'}`
  }
  if (first.kind === 'doc-change-proposed' && n > 1) return `${n} changes proposed to ${map.docs.find((d) => d.path === first.doc)?.title ?? docTitleOf(first)}`
  switch (first.kind) {
    case 'agent-finished':
      return `${first.title} is ready for review`
    case 'agent-started':
      return `An agent started on ${first.title}`
    case 'pr-merged':
      return `${first.title} merged`
    case 'milestone-done':
      return `${first.title} is done`
    default:
      return first.title
  }
}

function docTitleOf(event: MapEvent): string {
  return (event.doc?.split('/').pop() ?? 'a doc').replace(/\.md$/, '')
}

/** What happened since the user last looked: the later of their last visit and Mark all as seen. */
export interface SinceSummary {
  /** Null on the first visit with nothing marked seen. */
  since: string | null
  fresh: MapEvent[]
  reviews: number
  docChanges: number
  decisions: number
}

export function sinceSummary(map: Pick<MapDetail, 'activity' | 'lastVisitedAt' | 'seenAt' | 'decisions' | 'milestones'>): SinceSummary {
  const marks = [map.lastVisitedAt, map.seenAt].filter((at): at is string => at !== null).sort()
  const since = marks.at(-1) ?? null
  const fresh = since === null ? [...map.activity] : map.activity.filter((e) => e.at > since)
  const openTickets = new Set(map.milestones.flatMap((m) => m.tickets).filter((t) => t.status !== 'done').map((t) => t.id))
  const blocking = (id: string | null): boolean => map.decisions.some((d) => d.id === id && d.status === 'open' && d.blocks.some((t) => openTickets.has(t)))
  return {
    since,
    fresh,
    reviews: fresh.filter((e) => e.kind === 'agent-finished').length,
    docChanges: fresh.filter((e) => e.kind === 'doc-change-proposed').length,
    decisions: fresh.filter((e) => e.kind === 'decision-raised' && blocking(e.decision)).length
  }
}

/** One event as a sentence, for the Overview's Since your last visit. */
export function eventSentence(event: MapEvent, map: Pick<MapDetail, 'decisions'>): string {
  const decision = map.decisions.find((d) => d.id === event.decision)
  const number = decision ? `Decision ${decisionNumber(decision)}` : 'A decision'
  switch (event.kind) {
    case 'decision-raised':
      return `${number} raised: ${event.title}`
    case 'decision-decided':
      return `${number} decided`
    case 'decision-superseded':
      return `${number} superseded`
    case 'decision-reopened':
      return `${number} reopened`
    case 'agent-finished':
      return `${event.title} finished`
    case 'agent-wrapped-up':
      return `${event.title} wrapped up`
    case 'agent-started':
      return `Agent started on ${event.title}`
    case 'pr-opened':
      return `${event.detail} opened for ${event.title}`
    case 'pr-merged':
      return `${event.title} merged`
    case 'ticket-done':
      return `${event.title} done`
    case 'ticket-blocked':
      return `${event.title} blocked`
    case 'ticket-in-review':
      return `${event.title} in review`
    case 'milestone-done':
      return `${event.title} done`
    case 'doc-change-proposed':
      return `Doc change proposed: ${event.title}`
    case 'suggestion':
      return `Suggested: ${event.title}`
    case 'suggestion-accepted':
      return `Accepted: ${event.title}`
    case 'suggestion-dismissed':
      return `Dismissed: ${event.title}`
  }
}
