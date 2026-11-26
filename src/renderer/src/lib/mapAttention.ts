import type { MapDecision, MapDetail, MapDocInfo, MapDocProposal, MapEventKind, MapLaunch, MapTicket, TerminalInfo } from '../../../shared/ipc'
import { eventSentence, sinceSummary } from './mapActivity'
import { mapBoardRows } from './mapBoard'
import { authorLabel, decisionNumber, launchTitle, ticketLaunches } from './mapStatus'
import { homeUpNext, needsReview, reviewSentence, type ReviewItem, type UpNext } from './mapUpNext'

/** Where an attention item leads. */
export type AttentionTarget =
  | { kind: 'decision'; decision: MapDecision }
  | { kind: 'session'; launch: MapLaunch; terminal: string | null }
  /** A ticket's work, on its review page. */
  | { kind: 'review-ticket'; ticket: MapTicket }
  | { kind: 'review'; item: ReviewItem }
  /** A doc's proposed changes, on the Docs page with the doc open. */
  | { kind: 'doc'; path: string }
  /** The suggestions, in the Overview's Needs review. */
  | { kind: 'suggestions' }

/** One thing on the Overview's Needs your attention list. */
export interface AttentionItem {
  key: string
  title: string
  detail: string
  /** The action's word on its chip: Decide, Answer, Review, Fix, Merge. */
  verb: string
  /** `you`: held up until the user answers; `review`: finished work or proposals to look at. */
  tone: 'you' | 'review'
  /** Lower first: 0 decisions and agents waiting, 1 reviews, 2 pull requests needing fixes, 3 ready to merge. */
  rank: number
  /** Tickets not done it holds back; among equals, more comes first. */
  blocks: number
  target: AttentionTarget
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const allTickets = (map: Pick<MapDetail, 'milestones'>): MapTicket[] => map.milestones.flatMap((m) => m.tickets)

/** Tickets not done waiting on any of these. */
function waitingFor(map: Pick<MapDetail, 'milestones'>, ids: readonly string[]): number {
  return allTickets(map).filter((t) => t.status !== 'done' && t.after.some((a) => ids.includes(a))).length
}

function decisionItem(map: MapDetail, decision: MapDecision): AttentionItem {
  const open = allTickets(map).filter((t) => decision.blocks.includes(t.id) && t.status !== 'done')
  return {
    key: `decision:${decision.id}`,
    title: decision.title,
    detail: `Decision ${decisionNumber(decision)}${open.length > 0 ? ` · Blocking ${plural(open.length, 'ticket')}` : ''}`,
    verb: 'Decide',
    tone: 'you',
    rank: 0,
    blocks: open.length,
    target: { kind: 'decision', decision }
  }
}

/** Acceptance criteria judged across the ticket's wrap-ups, each counted once. */
function checksAttached(map: MapDetail, ticket: MapTicket): number {
  const judged = new Set(ticketLaunches(map, ticket.id).flatMap((l) => (l.wrapUp?.criteria ?? []).filter((c) => c.ticket === ticket.id).map((c) => c.index)))
  return judged.size
}

/**
 * A ticket whose own work is out for review or merged: Review while its pull request is open, Verify
 * once it merged and nobody has called it done. Null for neither.
 */
function reviewItem(map: MapDetail, ticket: MapTicket): AttentionItem | null {
  const own = ticketLaunches(map, ticket.id).filter((l) => 'ticket' in l.scope)
  const open = own.find((l) => !l.landed && l.pr?.state === 'open')
  const merged = own.filter((l) => l.landed).at(-1)
  const checks = checksAttached(map, ticket)
  const attached = checks > 0 ? [`${plural(checks, 'acceptance check')} attached`] : []
  const base: Omit<AttentionItem, 'detail' | 'verb'> = { key: `ticket:${ticket.id}`, title: ticket.title, tone: 'review', rank: 1, blocks: waitingFor(map, [ticket.id]), target: { kind: 'review-ticket', ticket } }
  if (open?.pr) return { ...base, detail: [`Pull request #${open.pr.number} open`, ...attached].join(' · '), verb: 'Review' }
  if (merged) return { ...base, detail: [merged.pr ? `Pull request #${merged.pr.number} merged` : 'Merged', 'verify it and mark it done'].join(' · '), verb: 'Verify' }
  return null
}

function proposalItems(map: MapDetail): AttentionItem[] {
  const byDoc = new Map<string, MapDocProposal[]>()
  for (const proposal of map.proposals) byDoc.set(proposal.doc, [...(byDoc.get(proposal.doc) ?? []), proposal])
  return [...byDoc].map(([doc, proposals]) => {
    const first = proposals[0]
    const sessions = new Set(proposals.map((p) => ('launch' in p.from ? p.from.launch : 'sweep' in p.from ? p.from.sweep : 'ask'))).size
    const title = proposals.length === 1 && first ? first.title : `${proposals.length} documentation changes proposed`
    return {
      key: `doc:${doc}`,
      title,
      detail: `${docTitle(map.docs, doc)} · From ${plural(sessions, 'agent session')}`,
      verb: 'Review',
      tone: 'review',
      rank: 1,
      blocks: 0,
      target: proposals.length === 1 && first ? { kind: 'review', item: { kind: 'proposal', proposal: first } } : { kind: 'doc', path: doc }
    }
  })
}

function suggestionItem(map: MapDetail): AttentionItem | null {
  const first = map.suggestions[0]
  if (!first) return null
  const one = map.suggestions.length === 1
  return {
    key: 'suggestions',
    title: one ? reviewSentence({ kind: 'suggestion', suggestion: first }) : `${map.suggestions.length} suggestions for the plan and docs`,
    detail: one ? (first.why.trim() || 'Waiting for your yes') : 'Tickets, plan changes and docs agents proposed',
    verb: 'Review',
    tone: 'review',
    rank: 1,
    blocks: 0,
    target: { kind: 'suggestions' }
  }
}

/** A doc's title as the map lists it, else its file name. */
export function docTitle(docs: readonly MapDocInfo[], path: string): string {
  return docs.find((d) => d.path === path)?.title ?? (path.split('/').pop() ?? path).replace(/\.md$/, '')
}

/**
 * Everything waiting on the user, most pressing first: open decisions and agents waiting for an
 * answer (the board's ranking), then finished tickets, doc changes and suggestions to review, then
 * pull requests to fix or merge. Within a rank, what holds back more tickets comes first.
 */
export function attentionItems(map: MapDetail, terminals: readonly TerminalInfo[]): AttentionItem[] {
  const items: AttentionItem[] = map.decisions.filter((d) => d.status === 'open').map((d) => decisionItem(map, d))
  for (const row of mapBoardRows(map, terminals)) {
    if (row.rank > 1 || !row.attention) continue
    const launch = map.launches.find((l) => l.id === row.launch)
    if (!launch) continue
    items.push({ key: `session:${row.launch}:${row.ticket ?? ''}`, title: row.title, detail: row.attention, verb: 'Answer', tone: 'you', rank: 0, blocks: row.unblocks, target: { kind: 'session', launch, terminal: row.terminal } })
  }
  for (const ticket of allTickets(map).filter((t) => t.status !== 'done')) {
    const item = reviewItem(map, ticket)
    if (item) items.push(item)
  }
  items.push(...proposalItems(map))
  const suggestions = suggestionItem(map)
  if (suggestions) items.push(suggestions)
  for (const item of needsReview(map, terminals)) {
    const scope = item.kind === 'ready' ? item.launch.scope : null
    const own = scope && 'ticket' in scope ? allTickets(map).find((t) => t.id === scope.ticket) : undefined
    if (item.kind === 'ready' && own) {
      const checks = checksAttached(map, own)
      const detail = ['Agent finished', ...(checks > 0 ? [`${plural(checks, 'acceptance check')} attached`] : [])].join(' · ')
      items.push({ key: `ready:${item.launch.id}`, title: own.title, detail, verb: 'Review', tone: 'review', rank: 1, blocks: waitingFor(map, [own.id]), target: { kind: 'review-ticket', ticket: own } })
    } else if (item.kind === 'ready') {
      items.push({ key: `ready:${item.launch.id}`, title: reviewSentence(item), detail: 'Its agent finished; review starts with the pull request', verb: 'Open PR', tone: 'review', rank: 1, blocks: 0, target: { kind: 'review', item } })
    } else if (item.kind === 'checks' || item.kind === 'changes') {
      items.push({ key: `pr:${item.launch.id}`, title: reviewSentence(item), detail: 'Send it back to the session that made it', verb: 'Fix', tone: 'you', rank: 2, blocks: 0, target: { kind: 'review', item } })
    } else if (item.kind === 'pr' && item.launch.health?.review === 'approved' && item.launch.health.checks !== 'failed' && item.launch.health.checks !== 'running') {
      items.push({ key: `pr:${item.launch.id}`, title: reviewSentence(item), detail: 'Approved, with its checks green', verb: 'Merge', tone: 'review', rank: 3, blocks: 0, target: { kind: 'review', item } })
    }
  }
  return items.sort((a, b) => a.rank - b.rank || b.blocks - a.blocks)
}

/**
 * The Overview's Needs review: what waits on the user that Needs your attention doesn't act on
 * itself. Suggestions, approved there one by one; blocked tickets; and open pull requests the
 * attention list leaves out (not yet approved, from a milestone's or a group's launch).
 */
export function overviewReview(map: MapDetail, terminals: readonly TerminalInfo[], items: readonly AttentionItem[]): ReviewItem[] {
  const listed = new Set(items.map((i) => i.key))
  return needsReview(map, terminals).filter((item) => {
    if (item.kind === 'suggestion' || item.kind === 'blocked') return true
    if (item.kind !== 'pr') return false
    const scope = item.launch.scope
    return !listed.has(`pr:${item.launch.id}`) && !('ticket' in scope && listed.has(`ticket:${scope.ticket}`))
  })
}

/** The Overview's one recommended action: what it is, why now, and who acts. */
export interface Recommendation {
  title: string
  why: string
  /** `you`: needs the user; `agent`: ready for an agent to start. */
  actor: 'you' | 'agent'
  button: string
  /** "Blocks 2 tickets", or why it comes first; null when nothing needs saying. */
  reason: string | null
  /** How many other items need the user too. */
  others: number
  next: { kind: 'attention'; item: AttentionItem } | { kind: 'up-next'; next: UpNext }
}

function titles(tickets: readonly MapTicket[]): string {
  const names = tickets.map((t) => t.title)
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${plural(names.length - 2, 'more ticket')}`
}

function fromItem(map: MapDetail, item: AttentionItem, others: number): Recommendation {
  const blocking = item.blocks > 0 ? `Blocks ${plural(item.blocks, 'ticket')}` : null
  const next: Recommendation['next'] = { kind: 'attention', item }
  const base = { others, next }
  switch (item.target.kind) {
    case 'decision': {
      const decision = item.target.decision
      const held = allTickets(map).filter((t) => decision.blocks.includes(t.id) && t.status !== 'done')
      const why = held.length > 0 ? `Unblocks ${titles(held)}.` : decision.question.trim() || 'An open question the work is waiting on.'
      return { ...base, title: decision.title, why, actor: 'you', button: 'Review decision', reason: blocking }
    }
    case 'session':
      return { ...base, title: item.title, why: item.detail, actor: 'you', button: 'Open session', reason: blocking ?? 'Its agent is waiting for you' }
    case 'review-ticket':
      if (item.verb === 'Verify') return { ...base, title: `Verify “${item.title}”`, why: 'Its work is merged. Check it, then mark it done (or its agent does, with you).', actor: 'you', button: 'Review work', reason: blocking ?? 'Merged work waits to be called done' }
      if (item.key.startsWith('ready:')) return { ...base, title: `Review “${item.title}”`, why: `${item.detail}. Check the evidence, then open its pull request.`, actor: 'you', button: 'Review', reason: blocking ?? 'Its agent finished' }
      return { ...base, title: `Review “${item.title}”`, why: `${item.detail}. Review it; once it's merged and verified, it's done.`, actor: 'you', button: 'Review', reason: blocking ?? 'Its pull request waits for your review' }
    case 'review':
    case 'doc':
    case 'suggestions':
      return { ...base, title: item.title, why: item.detail, actor: 'you', button: item.verb === 'Fix' ? 'Send to session' : item.verb, reason: blocking }
  }
}

function whyNext(next: UpNext): string {
  switch (next.action.kind) {
    case 'start-ready':
      return "They don't depend on each other: each gets its own worktree and a focused brief."
    case 'start-ticket':
      return 'Nothing it depends on is unfinished.'
    case 'start-milestone':
      return 'The milestone has no tickets: an agent works on it as a whole.'
    case 'open-session':
      return 'An agent is on it; nothing needs you yet.'
    case 'break-down':
      return 'Turn the docs into milestones and tickets agents can pick up.'
    case 'write-doc':
      return 'Agents work from the docs: say what this is and why.'
    default:
      return ''
  }
}

/**
 * The Overview's recommendation: the most pressing item that needs the user, else the next step of
 * the plan (resume or start work, or plan more), with who acts.
 */
export function recommendedNext(map: MapDetail, terminals: readonly TerminalInfo[], items: readonly AttentionItem[] = attentionItems(map, terminals)): Recommendation {
  const first = items[0]
  if (first) return fromItem(map, first, items.length - 1)
  const next = homeUpNext(map, terminals)
  const kind = next.action.kind
  const actor = kind === 'start-ready' || kind === 'start-ticket' || kind === 'start-milestone' || kind === 'open-session' ? 'agent' : 'you'
  return { title: next.sentence, why: whyNext(next), actor, button: next.button, reason: null, others: 0, next: { kind: 'up-next', next } }
}

/** One line of Since your last visit. */
export interface VisitEvent {
  at: string
  text: string
  tone: 'done' | 'info'
}

const DONE_KINDS: readonly MapEventKind[] = ['agent-finished', 'pr-merged', 'ticket-done', 'milestone-done', 'decision-decided']

/** What happened on the map since the user last looked (their last visit, or Mark all as seen), newest first; null before either. */
export function sinceLastVisit(map: MapDetail, limit = 3): VisitEvent[] | null {
  const summary = sinceSummary(map)
  if (summary.since === null) return null
  return summary.fresh.slice(0, limit).map((event) => ({ at: event.at, text: eventSentence(event, map), tone: DONE_KINDS.includes(event.kind) ? 'done' : 'info' }))
}

/** A doc as Feature context shows it. */
export interface DocSummary {
  doc: MapDocInfo
  /** Its roles as one label ("PRODUCT + TECHNICAL"); empty without roles. */
  roles: string
  tickets: number
  proposals: number
}

/** The docs of the current milestone first, then the rest, with how many tickets link them and changes wait on them. */
export function docSummaries(map: MapDetail, limit = 3): DocSummary[] {
  const current = map.current?.id ?? null
  const ordered = [...map.docs].sort((a, b) => Number(current !== null && b.milestones.includes(current)) - Number(current !== null && a.milestones.includes(current)))
  return ordered.slice(0, limit).map((doc) => ({
    doc,
    roles: doc.roles.map((r) => r.toUpperCase()).join(' + '),
    tickets: allTickets(map).filter((t) => t.docs.some((d) => d.path === doc.path)).length,
    proposals: map.proposals.filter((p) => p.doc === doc.path).length
  }))
}

/** The Overview's decisions: open ones first, in plan order, then the most recently decided. */
export function decisionSummaries(map: MapDetail, limit = 3): MapDecision[] {
  const open = map.decisions.filter((d) => d.status === 'open')
  const closed = map.decisions.filter((d) => d.status !== 'open').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))
  return [...open, ...closed].slice(0, limit)
}
