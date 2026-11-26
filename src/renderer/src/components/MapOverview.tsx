import { ArrowRight, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import type { MapDetail, MapMilestoneInfo, MapTicket } from '../../../shared/ipc'
import { ticketProgress } from '../../../shared/ipc'
import { attentionItems, decisionSummaries, docSummaries, overviewReview, recommendedNext, sinceLastVisit, type AttentionItem, type Recommendation } from '../lib/mapAttention'
import { agentActivity, decisionNumber, milestoneKey, STAGE_LABEL, workState } from '../lib/mapStatus'
import { currentOf, liveSessions } from '../lib/mapUpNext'
import { externalLink } from '../lib/externalLink'
import { relativeDate } from '../lib/relativeDate'
import { NeedsReview } from './MapNeedsReview'
import { ClampedText } from './MapParts'
import type { MapActions } from './MapView'

/** How many attention items show before View all. */
const ATTENTION_SHOWN = 3

export type Tone = 'you' | 'info' | 'done' | 'muted'

/** A small label: amber when it needs the user, grey otherwise. The tone also says why, for callers that sort or filter by it. */
export function Chip({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }): React.JSX.Element {
  return (
    <span className={`map-chip ${tone}`} title={title}>
      {children}
    </span>
  )
}

/**
 * A map's Overview: what the feature is and where it stands, the one thing to do next and why, what
 * needs the user, the current milestone's work in motion, and the feature's docs, decisions and what
 * changed since the last visit.
 */
export function MapOverview({ map, actions, busy }: { map: MapDetail; actions: MapActions; busy: boolean }): React.JSX.Element {
  const items = attentionItems(map, actions.terminals)
  const recommendation = recommendedNext(map, actions.terminals, items)
  const [showAll, setShowAll] = useState(false)
  const [newTicket, setNewTicket] = useState<string | null>(null)
  const current = currentOf(map)

  const openItem = (item: AttentionItem): void => {
    const target = item.target
    if (target.kind === 'decision') actions.openDecision(target.decision.id)
    else if (target.kind === 'session') actions.openSession(target.launch, target.terminal)
    else if (target.kind === 'review-ticket') actions.reviewTicket(target.ticket)
    else if (target.kind === 'review') actions.review(target.item)
    else if (target.kind === 'doc') actions.openDocs(target.path)
    else document.getElementById('map-needs-review')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const addTicket = (): void => {
    const title = newTicket?.trim()
    if (!title || !current) return
    void actions.edit({ kind: 'add-ticket', milestone: current.id, title }).then((ok) => ok && setNewTicket(null))
  }

  return (
    <div className="map-scroll">
      <div className="map-page">
        <header className="map-ov-head">
          <div className="map-ov-heading">
            <div className="map-ov-title">
              <h1>{map.title}</h1>
              <Chip tone="info" title={map.stageSet ? 'Set by hand in the map’s settings' : 'Worked out from the tickets'}>
                {STAGE_LABEL[map.stage]}
              </Chip>
            </div>
            {map.description && <p className="map-ov-description">{map.description}</p>}
          </div>
          <div className="map-ov-actions">
            <button className="map-button" disabled={!current} title={current ? `Add a ticket to ${current.title}` : 'Add a milestone first'} onClick={() => setNewTicket('')}>
              <Plus size={13} /> New ticket
            </button>
          </div>
        </header>

        {newTicket !== null && current && (
          <form
            className="map-ov-new-ticket"
            onSubmit={(e) => {
              e.preventDefault()
              addTicket()
            }}
          >
            <input autoFocus value={newTicket} placeholder={`A ticket for ${current.title}`} onChange={(e) => setNewTicket(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNewTicket(null)} />
            <button type="submit" className="map-button primary" disabled={!newTicket.trim()}>
              Add
            </button>
            <button type="button" className="map-button" onClick={() => setNewTicket(null)}>
              Cancel
            </button>
          </form>
        )}

        <RecommendedCard recommendation={recommendation} busy={busy} onAct={(event) => (recommendation.next.kind === 'attention' ? openItem(recommendation.next.item) : actions.act(recommendation.next.next, event))} />

        <div className="map-ov-grid">
          <div className="map-ov-main">
            <section className="map-ov-section">
              <div className="map-ov-section-head">
                <h2>Needs your attention</h2>
                {items.length > 0 && <Chip tone="muted">{items.length}</Chip>}
                <span className="grow" />
                {items.length > ATTENTION_SHOWN && (
                  <button className="map-link" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show fewer' : 'View all'} <ArrowRight size={11} />
                  </button>
                )}
              </div>
              <div className="map-card map-ov-list">
                {items.length === 0 && <div className="map-ov-empty">Nothing needs you right now.</div>}
                {(showAll ? items : items.slice(0, ATTENTION_SHOWN)).map((item) => (
                  <button key={item.key} className="map-ov-item" onClick={() => openItem(item)}>
                    <span className="map-ov-item-text">
                      <span className="map-ov-item-title">{item.title}</span>
                      <span className="map-ov-item-detail">{item.detail}</span>
                    </span>
                    <Chip tone={item.tone === 'you' ? 'you' : 'info'}>{item.verb}</Chip>
                  </button>
                ))}
              </div>
            </section>

            <NeedsReview items={overviewReview(map, actions.terminals, items)} map={map} actions={actions} />

            <section className="map-ov-section">
              <div className="map-ov-section-head">
                <h2>Current milestone</h2>
                <span className="grow" />
                <button className="map-link" onClick={() => actions.openScreen('milestones')}>
                  All milestones <ArrowRight size={11} />
                </button>
              </div>
              {current ? <CurrentMilestone map={map} milestone={current} actions={actions} /> : <NoMilestone actions={actions} />}
              <AgentsLine map={map} actions={actions} />
            </section>
          </div>

          <aside className="map-ov-side">
            <FeatureContext map={map} actions={actions} />
            <DecisionsCard map={map} actions={actions} />
            <SinceLastVisit map={map} actions={actions} />
          </aside>
        </div>
      </div>
    </div>
  )
}

function RecommendedCard({ recommendation, busy, onAct }: { recommendation: Recommendation; busy: boolean; onAct: (event: React.MouseEvent) => void }): React.JSX.Element {
  return (
    <section className="map-ov-recommended">
      <div className="map-ov-recommended-text">
        <div className="map-ov-recommended-label">
          <span>Recommended next</span>
          <Chip tone={recommendation.actor === 'you' ? 'you' : 'info'}>{recommendation.actor === 'you' ? 'Needs you' : 'Ready for an agent'}</Chip>
        </div>
        <h2>{recommendation.title}</h2>
        {recommendation.why && <p>{recommendation.why}</p>}
      </div>
      <div className="map-ov-recommended-act">
        <button className="map-button primary large" disabled={busy} onClick={onAct}>
          {recommendation.button} <ArrowRight size={13} />
        </button>
        {(recommendation.reason || recommendation.others > 0) && (
          <span className="map-ov-why">
            {recommendation.reason && `Why this? ${recommendation.reason}`}
            {recommendation.reason && recommendation.others > 0 && ' · '}
            {recommendation.others > 0 && `${recommendation.others} more below`}
          </span>
        )}
      </div>
    </section>
  )
}

/** A ticket row's chip: what its agent is doing, else why it's held up, else where its work stands. */
function ticketChip(map: MapDetail, ticket: MapTicket, terminals: MapActions['terminals']): { tone: Tone; label: string; title?: string } | null {
  const activity = agentActivity(map, ticket, terminals)
  if (activity === 'needs-you') return { tone: 'you', label: 'Needs your answer' }
  if (activity === 'working') return { tone: 'info', label: 'Agent working' }
  if (ticket.status === 'in-review') return { tone: 'done', label: 'In review' }
  const work = workState(map, ticket)
  if (work.status === 'blocked') return { tone: 'muted', label: 'Blocked', ...(work.reason ? { title: work.reason } : {}) }
  if (ticket.status === 'in-progress') return { tone: 'muted', label: 'Paused' }
  return null
}

function CurrentMilestone({ map, milestone, actions }: { map: MapDetail; milestone: MapMilestoneInfo; actions: MapActions }): React.JSX.Element {
  const { done, total } = ticketProgress(milestone.tickets)
  const moving = milestone.tickets.flatMap((ticket) => {
    const chip = ticketChip(map, ticket, actions.terminals)
    return chip ? [{ ticket, chip }] : []
  })
  const ready = milestone.tickets.filter((t) => workState(map, t).status === 'ready').length
  return (
    <div className="map-card map-ov-milestone">
      <div className="map-ov-milestone-head">
        <span className="map-key">{milestoneKey(map, milestone)}</span>
        <button className="map-ov-milestone-title" onClick={() => actions.openScreen('milestones')}>
          {milestone.title}
        </button>
        {total > 0 && <Chip tone="done">{`${done} / ${total} done`}</Chip>}
      </div>
      {milestone.description && (
        <ClampedText lines={2} className="map-ov-milestone-description">
          {milestone.description}
        </ClampedText>
      )}
      {total > 0 && (
        <div className="map-ov-progress" title={`${done} of ${total} done`}>
          <span style={{ width: `${Math.round((done / total) * 100)}%` }} />
        </div>
      )}
      {moving.map(({ ticket, chip }) => (
        <button key={ticket.id} className="map-ov-ticket" onClick={() => actions.openTicket(ticket)}>
          <span className="map-ov-ticket-title">{ticket.title}</span>
          <Chip tone={chip.tone} {...(chip.title ? { title: chip.title } : {})}>
            {chip.label}
          </Chip>
        </button>
      ))}
      {moving.length === 0 && (
        <div className="map-ov-empty">
          {total === 0 ? 'No tickets: an agent works on the milestone as a whole.' : ready > 0 ? `Nothing in motion. ${ready} ${ready === 1 ? 'ticket is' : 'tickets are'} ready to start.` : 'Nothing in motion.'}
        </div>
      )}
    </div>
  )
}

function NoMilestone({ actions }: { actions: MapActions }): React.JSX.Element {
  return (
    <div className="map-card map-ov-milestone">
      <div className="map-ov-empty">
        No milestones yet.{' '}
        <button className="map-link" onClick={actions.breakDown}>
          Break the docs down
        </button>{' '}
        or{' '}
        <button className="map-link" onClick={() => actions.openScreen('milestones')}>
          add one by hand
        </button>
        .
      </div>
    </div>
  )
}

function AgentsLine({ map, actions }: { map: MapDetail; actions: MapActions }): React.JSX.Element | null {
  const live = liveSessions(map, actions.terminals)
  if (live.length === 0 && map.launches.length === 0) return null
  const working = live.filter(({ terminal }) => terminal.state === 'working' || terminal.state === 'starting').length
  const waiting = live.filter(({ terminal }) => terminal.state === 'waiting').length
  const parts = [...(working > 0 ? [`${working} ${working === 1 ? 'agent' : 'agents'} working`] : []), ...(waiting > 0 ? [`${waiting} waiting for you`] : [])]
  if (parts.length === 0) parts.push(live.length > 0 ? `${live.length} ${live.length === 1 ? 'session' : 'sessions'} open, none working` : 'No agents running')
  return (
    <div className="map-ov-agents">
      <span>{parts.join(' · ')}</span>
      <span className="grow" />
      <button className="map-link" onClick={() => actions.openActivity('agents')}>
        Open agent sessions <ArrowRight size={11} />
      </button>
    </div>
  )
}

/** Whether a side card is folded, per map and card, kept in this browser only. */
function useCollapsed(key: string): [boolean, () => void] {
  const read = (): boolean => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  }
  const [collapsed, setCollapsed] = useState(read)
  const toggle = (): void => {
    setCollapsed((was) => {
      try {
        if (was) localStorage.removeItem(key)
        else localStorage.setItem(key, '1')
      } catch {
        /** Storage can be unavailable; the card still folds for this session. */
      }
      return !was
    })
  }
  return [collapsed, toggle]
}

/** A right-column card that folds to its header. */
function SideCard({ map, name, title, extra, children }: { map: MapDetail; name: string; title: string; extra?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const [collapsed, toggle] = useCollapsed(`manta.map.${map.id}.${name}.collapsed`)
  return (
    <section className={`map-card map-ov-side-card ${collapsed ? 'collapsed' : ''}`}>
      <div className="map-ov-section-head">
        <button className="map-ov-fold" aria-expanded={!collapsed} onClick={toggle}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <h2>{title}</h2>
        </button>
        <span className="grow" />
        {extra}
      </div>
      {!collapsed && children}
    </section>
  )
}

function FeatureContext({ map, actions }: { map: MapDetail; actions: MapActions }): React.JSX.Element {
  const docs = docSummaries(map)
  return (
    <SideCard map={map} name="docs" title="Feature context">
      <p className="map-ov-side-sub">The source of truth for you and your agents.</p>
      {docs.length === 0 && <div className="map-ov-empty">No docs yet.</div>}
      {docs.map(({ doc, roles, tickets, proposals }) => {
        const meta = [
          ...(doc.updatedAt ? [`Updated ${relativeDate(doc.updatedAt)}`] : []),
          ...(tickets > 0 ? [`${tickets} linked ${tickets === 1 ? 'ticket' : 'tickets'}`] : []),
          ...(proposals > 0 ? [`${proposals} proposed ${proposals === 1 ? 'change' : 'changes'}`] : [])
        ]
        return (
          <button key={doc.path} className="map-ov-doc" title={doc.link ? doc.link.url : doc.exists ? doc.path : `${doc.path} is not in the docs repo`} onClick={() => actions.openDocs(doc.path)}>
            {roles && <span className="map-ov-doc-role">{roles}</span>}
            <span className={`map-ov-doc-title ${doc.exists ? '' : 'missing'}`}>{doc.title}</span>
            <span className="map-ov-doc-meta">{meta.length > 0 ? meta.join(' · ') : doc.link ? externalLink(doc.link.url).where : doc.path}</span>
          </button>
        )
      })}
      <div className="map-ov-side-links">
        <button className="map-link" onClick={actions.addExistingDoc}>
          <Plus size={11} /> Add document
        </button>
        {map.docs.length > docs.length && (
          <button className="map-link" onClick={() => actions.openScreen('docs')}>
            Show all {map.docs.length} <ArrowRight size={11} />
          </button>
        )}
      </div>
    </SideCard>
  )
}

function DecisionsCard({ map, actions }: { map: MapDetail; actions: MapActions }): React.JSX.Element {
  const open = map.decisions.filter((d) => d.status === 'open')
  const shown = decisionSummaries(map)
  return (
    <SideCard map={map} name="decisions" title="Decisions" extra={open.length > 0 && <Chip tone="muted">{`${open.length} open`}</Chip>}>
      {shown.length === 0 && <div className="map-ov-empty">No decisions recorded.</div>}
      {shown.map((decision) => (
        <button key={decision.id} className="map-ov-doc" onClick={() => actions.openDecision(decision.id)}>
          <span className="map-ov-doc-title">
            {decisionNumber(decision)} · {decision.title}
          </span>
          <span className="map-ov-doc-meta">{decision.status === 'open' ? decision.question || 'Waiting to be decided.' : `${decision.status === 'superseded' ? 'Superseded' : 'Decided'}: ${decision.outcome}`}</span>
        </button>
      ))}
      <div className="map-ov-side-links">
        <button className="map-link" onClick={() => actions.openDecision('new')}>
          <Plus size={11} /> Record a decision
        </button>
        {map.decisions.length > shown.length && (
          <button className="map-link" onClick={() => actions.openDecision(null)}>
            Show all {map.decisions.length} <ArrowRight size={11} />
          </button>
        )}
      </div>
    </SideCard>
  )
}

function SinceLastVisit({ map, actions }: { map: MapDetail; actions: MapActions }): React.JSX.Element | null {
  const events = sinceLastVisit(map)
  if (!events || !map.lastVisitedAt) return null
  return (
    <SideCard map={map} name="since" title="Since your last visit">
      {events.length === 0 && <div className="map-ov-empty">Nothing new since {relativeDate(map.lastVisitedAt)}.</div>}
      {events.map((event) => (
        <div key={`${event.at}${event.text}`} className="map-ov-event">
          <span>
            {event.text} · {relativeDate(event.at)}
          </span>
        </div>
      ))}
      {events.length > 0 && (
        <div className="map-ov-side-links">
          <button className="map-link" onClick={() => actions.openActivity('all')}>
            Show all <ArrowRight size={11} />
          </button>
        </div>
      )}
    </SideCard>
  )
}
