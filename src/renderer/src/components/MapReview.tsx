import { ArrowLeft, Check, Circle, CircleAlert, ExternalLink, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { MapDetail, MapDocProposal, MapTicket } from '../../../shared/ipc'
import { changedLines } from '../lib/diffStats'
import { ticketReview, type ReviewStage, type TicketReview } from '../lib/mapReview'
import { agentActivity, ticketKey, WORK_LABEL, workState } from '../lib/mapStatus'
import { relativeDate } from '../lib/relativeDate'
import { Chip, type Tone } from './MapOverview'
import { Switch } from './MapParts'
import type { MapActions } from './MapView'

const api = window.manta

/** How many changed lines a doc update shows before View full document diff. */
const PREVIEW_LINES = 8

const STATUS_TONE: Record<ReturnType<typeof workState>['status'], Tone> = { ready: 'muted', 'in-progress': 'info', blocked: 'muted', 'in-review': 'done', done: 'done', cancelled: 'muted' }

/**
 * Reviewing a ticket's work (frame "Review and handoff"): what its agent did, the evidence for each
 * acceptance criterion, what it didn't verify, and the doc updates it proposed. The ticket is marked
 * done here once its work is merged, with the doc updates the user includes; or its changes go back
 * to the session.
 */
export function MapReview({ map, ticket, back, actions, busy, onBack }: { map: MapDetail; ticket: MapTicket; back: string; actions: MapActions; busy: boolean; onBack: () => void }): React.JSX.Element {
  const review = ticketReview(map, ticket)
  const [excluded, setExcluded] = useState<string[]>([])
  const [asking, setAsking] = useState<string | null>(null)
  const work = workState(map, ticket)
  const include = review.proposals.filter((p) => !excluded.includes(p.thread))

  const markDone = (): void => {
    void actions.markDone(ticket, include.map((p) => p.thread)).then((ok) => ok && onBack())
  }
  const sendChanges = (): void => {
    const text = asking?.trim()
    if (!text || !review.launch) return
    void actions.requestChanges(review.launch, text).then((ok) => ok && setAsking(null))
  }

  return (
    <div className="map-scroll">
      <div className="map-page">
        <button className="map-link map-brief-back" onClick={onBack}>
          <ArrowLeft size={12} /> {back}
        </button>
        <header className="map-ov-head">
          <div className="map-ov-heading">
            <h1 className="map-rv-title">Review the work. Keep the context.</h1>
            <div className="map-rv-ticket">
              <button className="map-link" onClick={() => actions.openTicket(ticket)}>
                {ticketKey(map, ticket)} · {ticket.title}
              </button>
            </div>
          </div>
          <span className="map-rv-status">
            <Chip tone={STATUS_TONE[work.status]}>{WORK_LABEL[work.status]}</Chip>
          </span>
        </header>

        <AgentBar map={map} ticket={ticket} review={review} actions={actions} />

        <div className="map-ov-grid brief">
          <div className="map-ov-main">
            <Implementation review={review} actions={actions} />
            <Evidence review={review} />
            {(review.unverified.length > 0 || review.risks.length > 0) && (
              <section className="map-rv-residual">
                <h2>
                  <CircleAlert size={14} /> {review.unverified.length > 0 ? 'Still requires' : 'Risks'}
                </h2>
                {review.unverified.map((item) => (
                  <p key={item}>{item}</p>
                ))}
                {review.unverified.length > 0 && review.risks.length > 0 && <h3>Risks</h3>}
                {review.risks.map((item) => (
                  <p key={item}>{item}</p>
                ))}
                <p className="map-brief-muted">Marking it done doesn’t verify these.</p>
              </section>
            )}
          </div>
          <aside className="map-ov-side">
            <section className="map-card map-ov-side-card">
              <h2>Keep the map up to date</h2>
              <p className="map-ov-side-sub">A proposed change, never applied without you.</p>
              {review.proposals.length === 0 && <div className="map-ov-empty">Its agent proposed no doc changes.</div>}
              {review.proposals.map((proposal) => (
                <DocUpdate
                  key={proposal.thread}
                  proposal={proposal}
                  docsRoot={actions.docsRoot}
                  included={!excluded.includes(proposal.thread)}
                  canInclude={review.stage === 'merged'}
                  onInclude={(on) => setExcluded((x) => (on ? x.filter((t) => t !== proposal.thread) : [...x, proposal.thread]))}
                  onOpen={() => actions.openProposal(proposal)}
                />
              ))}
            </section>
          </aside>
        </div>

        {asking !== null && (
          <form
            className="map-rv-ask"
            onSubmit={(e) => {
              e.preventDefault()
              sendChanges()
            }}
          >
            <textarea autoFocus rows={3} value={asking} placeholder="What should change? It goes to the session that did the work." onChange={(e) => setAsking(e.target.value)} onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendChanges()
                if (e.key === 'Escape') setAsking(null)
              }} />
            <div className="map-brief-editor-actions">
              <button type="button" className="map-button" onClick={() => setAsking(null)}>
                Cancel
              </button>
              <button type="submit" className="map-button primary" disabled={busy || !asking.trim()}>
                Send to the session
              </button>
            </div>
          </form>
        )}

        <footer className="map-brief-footer">
          <span>{footerText(review.stage, ticketKey(map, ticket), include.length)}</span>
          <span className="grow" />
          {review.launch && review.stage !== 'done' && asking === null && (
            <button className="map-button" onClick={() => setAsking('')}>
              Request changes
            </button>
          )}
          <PrimaryAction review={review} include={include.length} busy={busy} actions={actions} onMarkDone={markDone} />
        </footer>
      </div>
    </div>
  )
}

function footerText(stage: ReviewStage, key: string, include: number): string {
  if (stage === 'done') return `${key} is done. Its review stays in the map’s history.`
  if (stage === 'merged') return `Marking ${key} done records this review${include > 0 ? ` and applies ${include} doc ${include === 1 ? 'update' : 'updates'}` : ''}.`
  if (stage === 'pr-open') return `${key} is done once its pull request merges.`
  if (stage === 'finished') return 'Its agent finished. Review goes on in a pull request.'
  return 'Its agent hasn’t finished yet.'
}

function PrimaryAction({ review, include, busy, actions, onMarkDone }: { review: TicketReview; include: number; busy: boolean; actions: MapActions; onMarkDone: () => void }): React.JSX.Element | null {
  const launch = review.launch
  if (review.stage === 'merged') {
    return (
      <button className="map-button primary large" disabled={busy} onClick={onMarkDone}>
        {include > 0 ? 'Mark done & update map' : 'Mark done'}
      </button>
    )
  }
  if (review.stage === 'finished' && launch) {
    return (
      <button className="map-button primary large" disabled={busy} onClick={() => actions.review({ kind: 'ready', launch })}>
        Open pull request
      </button>
    )
  }
  if (review.stage === 'pr-open' && launch?.pr) {
    const pr = launch.pr
    return (
      <>
        {launch.health?.checks === 'failed' && (
          <button className="map-button" disabled={busy} onClick={() => actions.review({ kind: 'checks', launch, pr })}>
            Send failing checks
          </button>
        )}
        {launch.health?.review === 'changes-requested' && (
          <button className="map-button" disabled={busy} onClick={() => actions.review({ kind: 'changes', launch, pr })}>
            Send PR review
          </button>
        )}
        <button className="map-button primary large" onClick={() => window.open(pr.url, '_blank')}>
          Review PR #{pr.number} <ExternalLink size={12} />
        </button>
      </>
    )
  }
  return null
}

function AgentBar({ map, ticket, review, actions }: { map: MapDetail; ticket: MapTicket; review: TicketReview; actions: MapActions }): React.JSX.Element {
  const launch = review.launch
  const activity = agentActivity(map, ticket, actions.terminals)
  const passed = review.checks.filter((c) => c.passed).length
  const chips = [
    ...(review.checks.length > 0 ? [passed === review.checks.length ? `${passed} automated ${passed === 1 ? 'check' : 'checks'} passed` : `${passed} of ${review.checks.length} checks passed`] : []),
    ...(review.proposals.length > 0 ? [`${review.proposals.length} doc ${review.proposals.length === 1 ? 'update' : 'updates'} proposed`] : [])
  ]
  const label = activity === 'finished' ? 'Agent finished' : activity === 'working' ? 'Agent working' : activity === 'needs-you' ? 'Agent needs your answer' : launch ? 'Agent stopped before finishing' : 'Not started'
  return (
    <section className={`map-rv-agent ${activity === 'finished' ? 'finished' : ''}`}>
      <span className="map-rv-agent-who">
        <strong>{label}</strong>
        {launch && <span>{`Claude Code · ${launch.project.split('/').at(-1) ?? launch.project} / ${launch.worktree.split('/').at(-1) ?? launch.branch}`}</span>}
      </span>
      {chips.map((c) => (
        <Chip key={c} tone="muted">
          {c}
        </Chip>
      ))}
      <span className="grow" />
      {launch && (
        <button className="map-button" onClick={() => actions.openSession(launch, null)}>
          Open session <ExternalLink size={12} />
        </button>
      )}
    </section>
  )
}

function Implementation({ review, actions }: { review: TicketReview; actions: MapActions }): React.JSX.Element {
  const viewChanges = (launch: TicketReview['wrapUps'][number]['launch']): void => (launch.pr ? void window.open(launch.pr.url, '_blank') : actions.openSession(launch, null))
  const latest = review.wrapUps[0]?.launch
  return (
    <section className="map-rv-block">
      <div className="map-ov-section-head">
        <h2>Implementation</h2>
        <span className="grow" />
        {latest && (
          <button className="map-button" onClick={() => viewChanges(latest)}>
            View changes <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="map-card map-rv-card">
      {review.wrapUps.length === 0 && <div className="map-ov-empty">No wrap-up yet: its agent reports what it did when it finishes.</div>}
      {review.wrapUps.map(({ launch, wrapUp }, i) => (
        <div key={launch.id} className={`map-rv-wrapup ${i > 0 ? 'earlier' : ''}`}>
          <div className="map-rv-wrapup-head">
            <span className="map-brief-muted">
              {launch.branch}
              {launch.pr && ` · PR #${launch.pr.number} ${launch.pr.state}`} · {relativeDate(wrapUp.at)}
              {wrapUp.sweep && ' · by the sweep'}
            </span>
            <span className="grow" />
            {i > 0 && (
              <button className="map-link" onClick={() => viewChanges(launch)}>
                View changes <ExternalLink size={11} />
              </button>
            )}
          </div>
          <p className="map-brief-text">{wrapUp.summary}</p>
          {!wrapUp.wentToPlan && <p className="map-brief-muted">It departed from the plan; its journal says how.</p>}
          {wrapUp.decisions.length > 0 && (
            <ul className="map-rv-list">
              {wrapUp.decisions.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      </div>
    </section>
  )
}

function Evidence({ review }: { review: TicketReview }): React.JSX.Element {
  const [open, setOpen] = useState<number[]>([])
  const met = review.criteria.filter((c) => c.result?.met).length
  return (
    <section className="map-rv-block">
      <div className="map-ov-section-head">
        <h2>Acceptance evidence</h2>
        <span className="grow" />
        {review.criteria.length > 0 && <span className="map-rv-count">{`${met} / ${review.criteria.length} met`}</span>}
      </div>
      <div className="map-card map-rv-criteria">
      {review.criteria.length === 0 && <div className="map-ov-empty">The ticket has no acceptance criteria; its wrap-up says what done meant.</div>}
      {review.criteria.map(({ index, text, result }) => (
        <div key={index} className="map-rv-criterion">
          <span className={`map-rv-mark ${result ? (result.met ? 'met' : 'unmet') : ''}`}>{result ? result.met ? <Check size={13} /> : <X size={13} /> : <Circle size={11} />}</span>
          <span className="map-rv-criterion-text">
            <span>{text}</span>
            <span className="map-brief-muted">{result ? result.source || (result.met ? 'Met' : 'Not met') : 'Not judged yet'}</span>
            {result && open.includes(index) && <span className="map-rv-evidence">{result.evidence || 'No evidence given.'}</span>}
          </span>
          {result && (
            <button className="map-link" onClick={() => setOpen((o) => (o.includes(index) ? o.filter((i) => i !== index) : [...o, index]))}>
              {open.includes(index) ? 'Hide evidence' : 'View evidence'}
            </button>
          )}
        </div>
      ))}
      {review.checks.length > 0 && (
        <div className="map-rv-checks">
          {review.checks.map((c) => (
            <span key={c.command} className={c.passed ? 'met' : 'unmet'}>
              {c.passed ? <Check size={11} /> : <X size={11} />} <code>{c.command}</code>
            </span>
          ))}
        </div>
      )}
      </div>
    </section>
  )
}

function DocUpdate(props: { proposal: MapDocProposal; docsRoot: string; included: boolean; canInclude: boolean; onInclude: (on: boolean) => void; onOpen: () => void }): React.JSX.Element {
  const { proposal } = props
  const [change, setChange] = useState<{ removed: string[]; added: string[] } | null | 'loading' | 'failed'>('loading')
  useEffect(() => {
    let current = true
    api
      .threadProposal(props.docsRoot, proposal.doc, proposal.thread)
      .then((p) => current && setChange(changedLines(p.current, p.merged)))
      .catch(() => current && setChange('failed'))
    return () => {
      current = false
    }
  }, [props.docsRoot, proposal.doc, proposal.thread])
  const lines = change && change !== 'loading' && change !== 'failed' ? [...change.removed.map((text) => ({ text, added: false })), ...change.added.map((text) => ({ text, added: true }))] : []
  const addition = lines.length > 0 && lines.every((line) => line.added)
  return (
    <div className="map-rv-update">
      <Chip tone="muted">PROPOSED</Chip>
      <span className="map-ov-doc-title">{proposal.title}</span>
      <span className="map-ov-doc-meta">{proposal.doc}</span>
      {addition && (
        <>
          <span className="map-ov-doc-role">Addition</span>
          <div className="map-rv-addition">
            {lines.slice(0, PREVIEW_LINES).map((line, i) => (
              <span key={i}>{line.text}</span>
            ))}
            {lines.length > PREVIEW_LINES && <span className="more">{`${lines.length - PREVIEW_LINES} more lines`}</span>}
          </div>
        </>
      )}
      {lines.length > 0 && !addition && (
        <pre className="map-rv-diff">
          {lines.slice(0, PREVIEW_LINES).map((line, i) => (
            <span key={i} className={line.added ? 'added' : 'removed'}>
              {line.added ? '+ ' : '− '}
              {line.text}
              {'\n'}
            </span>
          ))}
          {lines.length > PREVIEW_LINES && <span className="more">{`${lines.length - PREVIEW_LINES} more lines`}</span>}
        </pre>
      )}
      {change === 'failed' && <span className="map-brief-muted">Couldn’t load the change; open it to see it in the doc.</span>}
      <button className="map-link" onClick={props.onOpen}>
        View full document diff <ExternalLink size={11} />
      </button>
      {props.canInclude && (
        <Switch className="map-rv-include" checked={props.included} onChange={props.onInclude}>
          <span>Include this update when marking done</span>
          <span className="map-brief-muted">The map keeps the session it came from and its history.</span>
        </Switch>
      )}
    </div>
  )
}
