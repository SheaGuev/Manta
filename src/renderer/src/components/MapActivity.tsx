import { ArrowRight, ArrowUpRight, Check, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MapDetail, MapDocProposal, MapEvent, MapLaunch } from '../../../shared/ipc'
import { isClosed, ticketProgress } from '../../../shared/ipc'
import { changedLines } from '../lib/diffStats'
import { feedDays, FILTER_LABEL, inFilter, itemTitle, KIND_LABEL, needsAction, sinceSummary, type ActivityFilter, type FeedItem } from '../lib/mapActivity'
import { decisionNumber, milestoneKey, ticketKey } from '../lib/mapStatus'
import { relativeDate } from '../lib/relativeDate'
import { CoordinatorControls } from './MapAgents'
import { Chip } from './MapOverview'
import type { MapActions } from './MapView'

const api = window.manta

const FILTERS: readonly ActivityFilter[] = ['all', 'agents', 'docs', 'decisions', 'milestones']

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * A map's Activity, as in the frame: what changed since the user last looked, the map's log by day
 * (filtered by kind, or to what still needs action), and the picked event in a panel with what it
 * needs and the way to act on it.
 */
export function MapActivity({ map, actions, busy, filter: initialFilter }: { map: MapDetail; actions: MapActions; busy: boolean; filter: ActivityFilter }): React.JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>(initialFilter)
  const [needs, setNeeds] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const summary = sinceSummary(map)
  const fresh = new Set(summary.fresh.map((e) => e.id))
  const acting = (event: MapEvent): boolean => needsAction(event, map, actions.terminals)
  const shown = map.activity.filter((e) => inFilter(e, filter) && (!needs || acting(e)))
  const days = feedDays(shown)
  const items = days.flatMap((d) => d.items)
  const picked = items.find((i) => i.key === selected) ?? items.find((i) => i.events.some(acting)) ?? items[0] ?? null

  return (
    <div className="map-scroll">
      <div className="map-page">
        <header className="map-ov-head">
          <div className="map-ov-heading">
            <div className="map-ov-title">
              <h1>Activity</h1>
            </div>
            <p className="map-ov-description">Meaningful changes, with the context to pick up where you left off.</p>
          </div>
          <div className="map-ov-actions">
            <button className="map-button" disabled={summary.fresh.length === 0} onClick={actions.markSeen}>
              Mark all as seen
            </button>
          </div>
        </header>

        <section className="map-ac-since">
          <div className="map-ac-since-text">
            <span className="map-dk-rail-label">{summary.since ? 'Since your last visit' : 'So far'}</span>
            <h2>{summary.fresh.length === 0 ? `Nothing new since ${summary.since ? relativeDate(summary.since) : 'the map was made'}.` : 'The map has moved forward.'}</h2>
            {summary.fresh.length > 0 && <span className="map-ac-detail-text">{plural(summary.fresh.length, 'update')}{summary.since ? ` since ${relativeDate(summary.since)}` : ''}</span>}
          </div>
          <Stat n={summary.reviews} label={summary.reviews === 1 ? 'review ready' : 'reviews ready'} />
          <Stat n={summary.docChanges} label={summary.docChanges === 1 ? 'doc change proposed' : 'doc changes proposed'} />
          <Stat n={summary.decisions} label={summary.decisions === 1 ? 'blocking decision' : 'blocking decisions'} />
        </section>

        <div className="map-ac-grid">
          <div className="map-ac-feed">
            <div className="map-ac-filters">
              <div className="map-dc-filters">
                {FILTERS.map((f) => (
                  <button key={f} className={`map-dc-filter ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                    {FILTER_LABEL[f]}
                  </button>
                ))}
              </div>
              <label className="map-ac-toggle">
                <input type="checkbox" checked={needs} onChange={(e) => setNeeds(e.target.checked)} />
                <span className="map-ac-switch" />
                Needs action
              </label>
            </div>

            {days.length === 0 && <div className="map-ov-empty">{map.activity.length === 0 ? 'Nothing has happened on the map yet.' : needs ? 'Nothing here needs you.' : 'Nothing of this kind yet.'}</div>}
            {days.map((day) => (
              <section key={day.label} className="map-ac-day">
                <div className="map-dk-label">
                  <span>{day.label}</span>
                  <span>{day.items.length === 1 ? '1 entry' : `${day.items.length} entries`}</span>
                </div>
                <div className="map-ac-timeline">
                  {day.items.map((item) => (
                    <FeedEntry key={item.key} item={item} map={map} card={day.today} fresh={item.events.some((e) => fresh.has(e.id))} acting={item.events.some(acting)} selected={item.key === picked?.key} onSelect={() => setSelected(item.key)} />
                  ))}
                </div>
              </section>
            ))}
          </div>

          <aside className="map-card map-ac-detail">{picked ? <EventDetail key={picked.key} item={picked} map={map} actions={actions} busy={busy} /> : <div className="map-ov-empty">Pick an event to see what it needs.</div>}</aside>
        </div>
      </div>
    </div>
  )
}

function Stat({ n, label }: { n: number; label: string }): React.JSX.Element {
  return (
    <div className="map-ac-stat">
      <strong>{n}</strong>
      <span>{label}</span>
    </div>
  )
}

/** Where an entry's link leads, in words. */
function entryLink(event: MapEvent, map: MapDetail): string {
  if (event.decision) {
    const decision = map.decisions.find((d) => d.id === event.decision)
    return decision ? `Open Decision ${decisionNumber(decision)}` : 'Open decisions'
  }
  if (event.kind === 'doc-change-proposed') return 'Review in Docs'
  if (event.kind === 'milestone-done' || (event.kind === 'ticket-done' && !event.launch)) return 'View milestone'
  return 'View details'
}

/** The line under an entry's title: the ticket's key and what was said, the decision's number, the doc and session. */
function entryMeta(item: FeedItem, map: MapDetail): string {
  const event = item.events[0]
  if (!event) return ''
  const ticket = map.milestones.flatMap((m) => m.tickets).find((t) => t.id === event.ticket)
  const milestone = map.milestones.find((m) => m.id === event.milestone)
  if (item.events.length > 1 && event.kind === 'ticket-done') {
    const { done, total } = ticketProgress(milestone?.tickets ?? [])
    return milestone ? `Milestone progress is now ${done} / ${total} done` : ''
  }
  if (event.kind === 'doc-change-proposed') return [event.detail ? `From “${event.detail}”` : '', event.doc ?? ''].filter(Boolean).join(' · ')
  const where = ticket ? ticketKey(map, ticket) : milestone ? milestoneKey(map, milestone) : ''
  return [where, event.detail].filter(Boolean).join(' · ')
}

function FeedEntry(props: { item: FeedItem; map: MapDetail; card: boolean; fresh: boolean; acting: boolean; selected: boolean; onSelect: () => void }): React.JSX.Element | null {
  const { item, map, card, fresh, acting, selected, onSelect } = props
  const event = item.events[0]
  if (!event) return null
  const meta = entryMeta(item, map)
  const launch = map.launches.find((l) => l.id === event.launch)
  const checks = event.kind === 'agent-finished' ? (launch?.wrapUp?.checks.length ?? 0) : 0
  const updates = event.kind === 'agent-finished' && launch ? proposalsOf(map, launch).length : 0
  return (
    <div className={`map-ac-entry ${fresh ? 'fresh' : ''}`}>
      <span className="map-ac-node" title={fresh ? 'New since you last looked' : undefined} />
      {card ? (
        <div role="button" tabIndex={0} className={`map-card map-ac-card ${selected ? 'selected' : ''}`} onClick={onSelect} onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
          <div className="map-ac-card-top">
            <span className={`map-ac-kind ${acting && event.kind === 'decision-raised' ? 'you' : ''}`}>
              {item.events.length > 1 && event.kind === 'ticket-done' ? 'Tickets done' : item.events.length > 1 && event.kind === 'doc-change-proposed' ? 'Doc changes proposed' : KIND_LABEL[event.kind]}
            </span>
            <span className="map-ac-when">{relativeDate(event.at)}</span>
          </div>
          <h3>{itemTitle(item, map)}</h3>
          {meta && <p>{meta}</p>}
          <div className="map-ac-card-foot">
            {checks > 0 && <Chip tone="muted">{plural(checks, 'check')} reported</Chip>}
            {updates > 0 && <Chip tone="muted">{plural(updates, 'doc update')} proposed</Chip>}
            <span className="map-link">
              {entryLink(event, map)} <ArrowRight size={11} />
            </span>
          </div>
        </div>
      ) : (
        <button className={`map-ac-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
          <span className="map-ac-row-title">{itemTitle(item, map)}</span>
          <span className="map-ac-row-meta">
            {[KIND_LABEL[event.kind], meta, relativeDate(event.at)].filter(Boolean).join(' · ')}
          </span>
        </button>
      )}
    </div>
  )
}

function proposalsOf(map: MapDetail, launch: MapLaunch): MapDocProposal[] {
  return map.proposals.filter((p) => ('launch' in p.from && p.from.launch === launch.id) || ('sweep' in p.from && p.from.sweep === launch.id))
}

function basename(root: string): string {
  return root.split('/').filter(Boolean).pop() ?? root
}

/** The picked entry in full, with the way to act on it. */
function EventDetail({ item, map, actions, busy }: { item: FeedItem; map: MapDetail; actions: MapActions; busy: boolean }): React.JSX.Element | null {
  const event = item.events[0]
  if (!event) return null
  const launch = map.launches.find((l) => l.id === event.launch)
  if (launch && event.kind !== 'doc-change-proposed') return <AgentDetail event={event} launch={launch} map={map} actions={actions} busy={busy} />
  if (event.decision) return <DecisionDetail event={event} map={map} actions={actions} />
  if (event.kind === 'doc-change-proposed') return <DocChangeDetail item={item} map={map} actions={actions} />
  if (event.suggestion) {
    const waiting = map.suggestions.some((s) => s.id === event.suggestion)
    return (
      <div className="map-ac-detail-body">
        <span className="map-dk-rail-label">{KIND_LABEL[event.kind]}</span>
        <h2>{event.title}</h2>
        {event.detail && <p className="map-ac-detail-text">{event.detail}</p>}
        {waiting ? (
          <button className="map-button primary map-ac-primary" onClick={() => actions.openScreen('home')}>
            Review on the Overview <ArrowRight size={13} />
          </button>
        ) : (
          <p className="map-ac-detail-text">No longer waiting: {event.kind === 'suggestion-dismissed' ? 'dismissed' : event.kind === 'suggestion-accepted' ? 'accepted' : 'resolved'}.</p>
        )}
      </div>
    )
  }
  return <WorkDetail item={item} map={map} actions={actions} />
}

function agentState(map: MapDetail, launch: MapLaunch, terminals: MapActions['terminals']): { label: string; you: boolean } {
  const ticket = map.milestones.flatMap((m) => m.tickets).find((t) => 'ticket' in launch.scope && t.id === launch.scope.ticket)
  const live = launch.sessions.flatMap((s) => terminals.filter((t) => t.id === s.terminal && t.state !== 'exited'))
  if (ticket?.status === 'done') return { label: 'Done', you: false }
  if (ticket?.status === 'cancelled') return { label: 'Cancelled', you: false }
  if (launch.landed) return { label: 'Merged', you: false }
  if (live.some((t) => t.state === 'waiting')) return { label: 'Waiting for you', you: true }
  if (live.some((t) => t.state === 'working' || t.state === 'starting')) return { label: 'Working', you: false }
  if (launch.pr?.state === 'open') return { label: 'Pull request open', you: false }
  if (launch.wrapUp?.finished) return { label: 'Ready for review', you: false }
  return { label: 'Paused', you: false }
}

function AgentDetail({ event, launch, map, actions, busy }: { event: MapEvent; launch: MapLaunch; map: MapDetail; actions: MapActions; busy: boolean }): React.JSX.Element {
  const ticket = map.milestones.flatMap((m) => m.tickets).find((t) => t.id === event.ticket)
  const milestone = map.milestones.find((m) => m.id === event.milestone)
  const where = ticket ? ticketKey(map, ticket) : milestone ? milestoneKey(map, milestone) : null
  const state = agentState(map, launch, actions.terminals)
  const wrapUp = launch.wrapUp
  const passed = wrapUp?.checks.filter((c) => c.passed).length ?? 0
  const failed = (wrapUp?.checks.length ?? 0) - passed
  const proposals = proposalsOf(map, launch)
  const batch = launch.batch ? map.batches.find((b) => b.id === launch.batch) : undefined
  const handoff = (): void => {
    if (ticket) actions.reviewTicket(ticket)
    else if (launch.pr) window.open(launch.pr.url, '_blank')
    else actions.openSession(launch, null)
  }
  return (
    <div className="map-ac-detail-body">
      <span className="map-dk-rail-label">Agent session{where ? ` / ${where}` : ''}</span>
      <h2>{event.title}</h2>
      <div>
        <Chip tone={state.you ? 'you' : 'muted'}>{state.label}</Chip>
      </div>
      <p className="map-ac-detail-text">
        Claude Code · {wrapUp ? `${wrapUp.finished ? 'Finished' : 'Wrapped up'} ${relativeDate(wrapUp.at)}` : `Started ${relativeDate(launch.sessions.at(-1)?.startedAt || launch.createdAt)}`}
        <br />
        <strong>
          {basename(launch.project)} / {launch.branch}
        </strong>
      </p>
      {wrapUp && (
        <div className="map-ac-block">
          <span className="map-dk-rail-label">What came back</span>
          {wrapUp.summary && <p className="map-ac-detail-text">{wrapUp.summary}</p>}
          {passed > 0 && (
            <span className="map-ac-line done">
              <Check size={13} /> {plural(passed, 'check')} reported as passing
            </span>
          )}
          {failed > 0 && (
            <span className="map-ac-line">
              <X size={13} /> {plural(failed, 'check')} failing
            </span>
          )}
          {proposals.length > 0 && (
            <span className="map-ac-line">
              <Plus size={13} /> {plural(proposals.length, 'proposed doc update')}
            </span>
          )}
          {wrapUp.unverified.map((u) => (
            <span key={u} className="map-ac-line you">
              {u}
            </span>
          ))}
          {wrapUp.risks.map((r) => (
            <span key={r} className="map-ac-line">
              Risk: {r}
            </span>
          ))}
        </div>
      )}
      {proposals[0] && <ProposalPreview proposal={proposals[0]} docsRoot={actions.docsRoot} />}
      <p className="map-ac-detail-note">Source session and evidence stay attached.</p>
      {batch && <CoordinatorControls batch={batch} actions={actions} busy={busy} />}
      <button className="map-button primary map-ac-primary" onClick={handoff}>
        {ticket ? 'Review handoff' : launch.pr ? 'Open pull request' : 'Open session'} <ArrowRight size={13} />
      </button>
      <button className="map-link" onClick={() => actions.openSession(launch, null)}>
        Open source session <ArrowUpRight size={11} />
      </button>
    </div>
  )
}

/** The first lines a proposal adds, as the frame's "Proposed / not applied" block. */
function ProposalPreview({ proposal, docsRoot }: { proposal: MapDocProposal; docsRoot: string }): React.JSX.Element {
  const [added, setAdded] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    api.threadProposal(docsRoot, proposal.doc, proposal.thread).then(
      (p) => live && setAdded((changedLines(p.current, p.merged)?.added ?? []).filter((l) => l.trim()).slice(0, 4)),
      () => live && setAdded([])
    )
    return () => {
      live = false
    }
  }, [docsRoot, proposal.doc, proposal.thread])
  return (
    <div className="map-ac-proposal">
      <span className="map-dk-rail-label">Proposed / not applied</span>
      <strong>+ {proposal.title}</strong>
      {added && added.length > 0 && <p className="map-ac-detail-text">{added.join(' ').replace(/^#+\s*/, '')}</p>}
    </div>
  )
}

function DecisionDetail({ event, map, actions }: { event: MapEvent; map: MapDetail; actions: MapActions }): React.JSX.Element {
  const decision = map.decisions.find((d) => d.id === event.decision)
  if (!decision) {
    return (
      <div className="map-ac-detail-body">
        <span className="map-dk-rail-label">{KIND_LABEL[event.kind]}</span>
        <h2>{event.title}</h2>
        <p className="map-ac-detail-text">This decision has been removed.</p>
      </div>
    )
  }
  const held = map.milestones.flatMap((m) => m.tickets).filter((t) => decision.blocks.includes(t.id) && !isClosed(t.status))
  return (
    <div className="map-ac-detail-body">
      <span className="map-dk-rail-label">Decision {decisionNumber(decision)}</span>
      <h2>{decision.title}</h2>
      <div>
        <Chip tone={decision.status === 'open' ? 'you' : 'muted'}>{decision.status === 'open' ? 'Needs you' : decision.status === 'superseded' ? 'Superseded' : 'Decided'}</Chip>
      </div>
      {decision.question && <p className="map-ac-detail-text">{decision.question}</p>}
      {decision.status !== 'open' && decision.outcome && <p className="map-ac-detail-text">Decided: {decision.outcome}</p>}
      {decision.status === 'open' && decision.options.length > 0 && (
        <div className="map-ac-block">
          <span className="map-dk-rail-label">Options</span>
          {decision.options.map((o) => (
            <span key={o.title} className="map-ac-line">
              {o.title}
              {o.recommended ? ' (recommended)' : ''}
            </span>
          ))}
        </div>
      )}
      {held.length > 0 && (
        <div className="map-ac-block">
          <span className="map-dk-rail-label">Holds back</span>
          {held.map((t) => (
            <button key={t.id} className="map-dk-rail-item" onClick={() => actions.openTicket(t)}>
              <span className="map-key">{ticketKey(map, t)}</span>
              <span>{t.title}</span>
            </button>
          ))}
        </div>
      )}
      <button className="map-button primary map-ac-primary" onClick={() => actions.openDecision(decision.id)}>
        {decision.status === 'open' ? 'Review decision' : 'Open decision'} <ArrowRight size={13} />
      </button>
    </div>
  )
}

function DocChangeDetail({ item, map, actions }: { item: FeedItem; map: MapDetail; actions: MapActions }): React.JSX.Element {
  const first = item.events[0]
  const doc = map.docs.find((d) => d.path === first?.doc)
  const open = item.events.flatMap((e) => map.proposals.filter((p) => p.thread === e.thread))
  return (
    <div className="map-ac-detail-body">
      <span className="map-dk-rail-label">Doc change / {doc?.title ?? first?.doc ?? 'a doc'}</span>
      <h2>{itemTitle(item, map)}</h2>
      <div>
        <Chip tone="muted">{open.length > 0 ? `${open.length} waiting for review` : 'Reviewed'}</Chip>
      </div>
      <div className="map-ac-block">
        {item.events.map((e) => (
          <span key={e.id} className="map-ac-line">
            {e.title}
            {e.detail ? ` · from “${e.detail}”` : ''}
          </span>
        ))}
      </div>
      {open[0] && <ProposalPreview proposal={open[0]} docsRoot={actions.docsRoot} />}
      {first?.doc && (
        <button className="map-button primary map-ac-primary" onClick={() => first.doc && actions.openDocs(first.doc)}>
          Review in Docs <ArrowRight size={13} />
        </button>
      )}
    </div>
  )
}

/** Tickets and milestones: what changed, and the milestone's progress. */
function WorkDetail({ item, map, actions }: { item: FeedItem; map: MapDetail; actions: MapActions }): React.JSX.Element {
  const event = item.events[0]
  const milestone = map.milestones.find((m) => m.id === event?.milestone)
  const tickets = map.milestones.flatMap((m) => m.tickets)
  const ticket = item.events.length === 1 ? tickets.find((t) => t.id === event?.ticket) : undefined
  const progress = ticketProgress(milestone?.tickets ?? [])
  return (
    <div className="map-ac-detail-body">
      <span className="map-dk-rail-label">{ticket ? `Ticket / ${ticketKey(map, ticket)}` : milestone ? `Milestone / ${milestoneKey(map, milestone)}` : (event && KIND_LABEL[event.kind]) || ''}</span>
      <h2>{itemTitle(item, map)}</h2>
      {event?.detail && <p className="map-ac-detail-text">{event.detail}</p>}
      {item.events.length > 1 && (
        <div className="map-ac-block">
          {item.events.map((e) => (
            <span key={e.id} className="map-ac-line done">
              <Check size={13} /> {e.title}
            </span>
          ))}
        </div>
      )}
      {milestone && progress.total > 0 && (
        <p className="map-ac-detail-text">
          {milestone.title}: {progress.done} / {progress.total} done
        </p>
      )}
      {ticket ? (
        <button className="map-button primary map-ac-primary" onClick={() => actions.openTicket(ticket)}>
          Open ticket <ArrowRight size={13} />
        </button>
      ) : milestone ? (
        <button className="map-button primary map-ac-primary" onClick={() => actions.openMilestone(milestone.id)}>
          View milestone <ArrowRight size={13} />
        </button>
      ) : null}
    </div>
  )
}
