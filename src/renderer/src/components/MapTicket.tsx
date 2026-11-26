import { Bot, Check, Circle, ExternalLink, FileText, GitBranch, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import 'streamdown/styles.css'
import type { CriterionResult, MapDetail, MapLaunch, MapTicket, PullRequestHealth, TicketStatus, TrackerEdit } from '../../../shared/ipc'
import { hasWork } from '../lib/mapReview'
import { milestoneKey, ticketKey, ticketLaunches } from '../lib/mapStatus'
import { docName, STATUS_LABEL, ticketUpNext } from '../lib/mapUpNext'
import { stateLabel } from '../lib/terminalStatus'
import { MarkdownField } from './MarkdownField'
import { CancelTicketForm, ClampedText, StatusDot, UpNextBlock } from './MapParts'
import type { MapActions } from './MapView'
import { MultiSelect } from './MultiSelect'
import { LINK_SAFETY } from './ThreadView'

const api = window.manta
const STATUSES: readonly TicketStatus[] = ['todo', 'in-progress', 'blocked', 'in-review', 'done', 'cancelled']

/**
 * One ticket: its title, milestone, status, description, acceptance criteria (with how the last
 * wrap-up judged them), the tickets it waits for, the docs it relies on, and the launches that
 * worked on it (worktree, branch, sessions, wrap-up, pull request and its health, landed) and their journals.
 */
export function MapTicketView({ map, ticket, actions, busy, codeProjects }: { map: MapDetail; ticket: MapTicket; actions: MapActions; busy: boolean; codeProjects: { root: string; name: string }[] }): React.JSX.Element {
  const milestone = map.milestones.find((m) => m.tickets.some((t) => t.id === ticket.id))
  const launches = ticketLaunches(map, ticket.id)
  const results = latestCriteria(launches, ticket.id)
  const others = map.milestones.flatMap((m) => m.tickets.filter((t) => t.id !== ticket.id).map((t) => ({ id: t.id, key: ticketKey(map, t), label: t.title, group: `${milestoneKey(map, m)} · ${m.title}` })))
  const unlinked = map.docs.filter((d) => !ticket.docs.some((linked) => linked.path === d.path && linked.heading === null)).map((d) => ({ id: d.path, label: d.title }))
  const [cancelling, setCancelling] = useState(false)
  const remove = (): void =>
    void actions.remove({ ticket: ticket.id }).then((deleted) => {
      if (deleted) actions.openScreen('milestones')
    })
  const update = (patch: Omit<Extract<TrackerEdit, { kind: 'update-ticket' }>, 'kind' | 'ticket'>): void => void actions.edit({ kind: 'update-ticket', ticket: ticket.id, ...patch })

  return (
    <div className="map-scroll">
      <div className="map-page map-tk">
        <div className="map-crumbs">
          <button className="map-crumb" onClick={() => actions.openScreen('home')}>
            {map.title}
          </button>{' '}
          /{' '}
          <button className="map-crumb" onClick={() => actions.openScreen('milestones')}>
            {milestone ? `${milestoneKey(map, milestone)} · ${milestone.title}` : 'Milestones'}
          </button>{' '}
          / <span className="map-key">{ticketKey(map, ticket)}</span>
        </div>
        <div className="map-tk-grid">
          <div className="map-tk-main">
            <TitleField key={ticket.id} title={ticket.title} onSave={(title) => update({ title })} />
            {ticket.blocked && <div className="thread-notice error">Blocked: {ticket.blocked}</div>}
            {ticket.status === 'cancelled' && <div className="map-tk-cancelled">Cancelled{ticket.cancelled ? `: ${ticket.cancelled}` : ''}</div>}
            <UpNextBlock next={ticketUpNext(map, ticket, actions.terminals)} busy={busy} onAct={actions.act} />

            <section className="map-tk-section">
              <span className="group-label">Description</span>
              <MarkdownField value={ticket.description} placeholder="What to do and why" onSave={(description) => update({ description })} />
            </section>

            <section className="map-tk-section">
              <span className="group-label">Done when</span>
              <Criteria key={ticket.id} criteria={ticket.acceptance} results={results} onSave={(acceptance) => update({ acceptance })} />
            </section>

            <section className="map-tk-section">
              <span className="group-label">Launches</span>
              {launches.length === 0 && <div className="muted-row map-empty">Not launched yet.</div>}
              {launches.map((launch) => (
                <LaunchCard key={launch.id} map={map} launch={launch} actions={actions} />
              ))}
            </section>
          </div>

          <aside className="map-tk-side">
            {hasWork(map, ticket) && (
              <button className="map-button map-ticket-review" onClick={() => actions.reviewTicket(ticket)}>
                Review the work <ExternalLink size={12} />
              </button>
            )}
            <Property label="Status">
              <label className="map-status-select">
                <StatusDot status={ticket.status} />
                <select
                  value={ticket.status}
                  title="Set by hand; the next real event (a launch, a report, a pull request) changes it again"
                  onChange={(e) => {
                    const status = STATUSES.find((s) => s === e.target.value)
                    if (status === 'cancelled') setCancelling(true)
                    else if (status) void actions.edit({ kind: 'set-ticket-status', ticket: ticket.id, status })
                  }}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              {cancelling && (
                <CancelTicketForm
                  title={ticket.title}
                  onCancel={(reason) => void actions.edit({ kind: 'set-ticket-status', ticket: ticket.id, status: 'cancelled', reason })}
                  onClose={() => setCancelling(false)}
                />
              )}
            </Property>
            {ticket.status === 'cancelled' && (
              <Property label="Why it was cancelled">
                <ReasonField key={ticket.id} reason={ticket.cancelled ?? ''} onSave={(reason) => void actions.edit({ kind: 'set-ticket-status', ticket: ticket.id, status: 'cancelled', reason })} />
              </Property>
            )}
            <Property label="Waits for">
              <MultiSelect options={others} value={ticket.after} onChange={(after) => update({ after })} placeholder="Nothing" />
            </Property>
            <Property label="Docs it relies on">
              {ticket.docs.map((doc) => (
                <div key={`${doc.path}#${doc.heading ?? ''}`} className="row map-doc-row" onClick={() => actions.openDoc(doc)}>
                  <FileText size={13} />
                  <span className="label">{doc.heading ? `§ ${doc.heading}` : (map.docs.find((d) => d.path === doc.path)?.title ?? docName(doc.path))}</span>
                  <span className="grow" />
                  <button
                    className="icon-button map-row-more"
                    title="Unlink"
                    onClick={(e) => {
                      e.stopPropagation()
                      update({ docs: ticket.docs.filter((d) => d !== doc) })
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
              {unlinked.length > 0 && <MultiSelect single options={unlinked} value={[]} onChange={([path]) => path && update({ docs: [...ticket.docs, { path, heading: null }] })} placeholder="Link a doc…" />}
            </Property>
            {codeProjects.length > 1 && (
              <Property label="Code project">
                <select className="map-select-field" value={ticket.project ?? ''} onChange={(e) => update({ project: e.target.value || null })}>
                  <option value="">The map’s ({map.projects.join(', ') || 'ask on launch'})</option>
                  {codeProjects.map((p) => (
                    <option key={p.root} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Property>
            )}
            <button className="map-link map-tk-delete" onClick={remove}>
              <Trash2 size={11} /> Delete ticket…
            </button>
          </aside>
        </div>
      </div>
    </div>
  )
}

function Property({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="map-tk-property">
      <span className="map-tk-property-label">{label}</span>
      {children}
    </div>
  )
}

/** A cancelled ticket's reason, typed into in place and saved on a click away or Enter. */
function ReasonField({ reason, onSave }: { reason: string; onSave: (reason: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(reason)
  useEffect(() => {
    setDraft(reason)
  }, [reason])
  return (
    <input
      className="map-select-field"
      value={draft}
      placeholder="No reason given"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft.trim() !== reason && onSave(draft.trim())}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

/** The ticket's title as a heading you can type into: Enter or a click away saves, Escape puts it back. */
function TitleField({ title, onSave }: { title: string; onSave: (title: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(title)
  useEffect(() => {
    setDraft(title)
  }, [title])
  const commit = (): void => {
    const next = draft.trim()
    if (next && next !== title) onSave(next)
    else setDraft(title)
  }
  return (
    <textarea
      className="map-tk-title"
      rows={1}
      value={draft}
      aria-label="Ticket title"
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ' '))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
        if (e.key === 'Escape') {
          const input = e.currentTarget
          setDraft(title)
          requestAnimationFrame(() => input.blur())
        }
      }}
    />
  )
}

/**
 * Acceptance criteria, one input each, with how the last wrap-up judged them. Enter adds one below,
 * Backspace in an empty one removes it; leaving the list saves it.
 */
function Criteria({ criteria, results, onSave }: { criteria: readonly string[]; results: readonly CriterionResult[]; onSave: (criteria: string[]) => void }): React.JSX.Element {
  const [draft, setDraft] = useState<string[] | null>(null)
  const [focus, setFocus] = useState<number | null>(null)
  const list = useRef<HTMLDivElement>(null)
  /** Escape blurs too, and that blur must not save what Escape threw away. */
  const discarding = useRef(false)
  const items = draft ?? [...criteria]

  useEffect(() => {
    if (focus === null) return
    list.current?.querySelectorAll('input')[focus]?.focus()
    setFocus(null)
  }, [focus])

  const change = (next: string[], at: number | null = null): void => {
    setDraft(next)
    if (at !== null) setFocus(at)
  }
  const commit = (event: React.FocusEvent): void => {
    if (event.relatedTarget instanceof Node && list.current?.contains(event.relatedTarget)) return
    if (discarding.current) {
      discarding.current = false
      return
    }
    if (!draft) return
    const cleaned = draft.map((c) => c.trim()).filter(Boolean)
    setDraft(null)
    if (cleaned.join('\n') !== criteria.join('\n')) onSave(cleaned)
  }

  return (
    <div className="map-tk-criteria" ref={list} onBlur={commit}>
      {items.map((criterion, index) => {
        const result = draft ? undefined : results.find((r) => r.index === index)
        return (
          <div key={index} className={`map-criterion ${result?.met ? 'met' : result ? 'unmet' : ''}`} title={result?.evidence || (result ? 'Not met' : 'Not judged yet')}>
            {result?.met ? <Check size={13} /> : result ? <X size={13} /> : <Circle size={11} />}
            <input
              value={criterion}
              placeholder="A checkable criterion"
              onChange={(e) => change(items.map((c, i) => (i === index ? e.target.value : c)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  change([...items.slice(0, index + 1), '', ...items.slice(index + 1)], index + 1)
                } else if (e.key === 'Backspace' && criterion === '' && items.length > 0) {
                  e.preventDefault()
                  change(
                    items.filter((_, i) => i !== index),
                    Math.max(0, index - 1)
                  )
                } else if (e.key === 'Escape') {
                  discarding.current = true
                  setDraft(null)
                  e.currentTarget.blur()
                }
              }}
            />
          </div>
        )
      })}
      <button className="map-link" onMouseDown={(e) => e.preventDefault()} onClick={() => change([...items, ''], items.length)}>
        <Plus size={11} /> Add a criterion
      </button>
    </div>
  )
}

function LaunchCard({ map, launch, actions }: { map: MapDetail; launch: MapLaunch; actions: MapActions }): React.JSX.Element {
  const [journal, setJournal] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api
      .mapJournal(actions.docsRoot, map.id, launch.id)
      .then((text) => live && setJournal(text))
      .catch(actions.report)
    return () => {
      live = false
    }
  }, [actions.docsRoot, actions.report, map.id, launch.id, launch.wrappedUpAt, launch.sweptAt])
  return (
    <div className="map-launch-card">
      <div className="map-launch-line">
        <GitBranch size={13} />
        <span className="map-mono">{launch.branch}</span>
        <span className="muted-row">{launch.worktree.split('/').pop()}</span>
        <span className="grow" />
        {launch.pr && (
          <a className="map-link" href={launch.pr.url} target="_blank" rel="noreferrer">
            PR #{launch.pr.number} {launch.pr.state} <ExternalLink size={11} />
          </a>
        )}
        {launch.landed && <span className="map-tag landed">landed</span>}
        {!launch.landed && !launch.pr && launch.readyAt && <span className="map-tag current">ready for PR</span>}
      </div>
      {launch.health && <div className="muted-row map-health">{healthLine(launch.health)}</div>}
      {launch.wrapUp && (
        <ClampedText lines={3} className="map-wrap-up">
          <span className="group-label">{launch.wrapUp.sweep ? 'Wrap-up (sweep)' : 'Wrap-up'}</span> {launch.wrapUp.summary}
        </ClampedText>
      )}
      {launch.sessions.map((session) => {
        const terminal = actions.terminals.find((t) => t.id === session.terminal)
        return (
          <div key={session.session} className="row map-session-row" onClick={() => actions.openSession(launch, session.terminal)}>
            <Bot size={13} />
            <span className="label">{terminal?.title ?? 'Session'}</span>
            <span className="muted-row">{terminal ? stateLabel(terminal) : 'closed, resumable'}</span>
            {terminal && <span className={`terminal-dot state-${terminal.state}`} />}
          </div>
        )
      })}
      {journal !== null && journal.trim() && (
        <details className="map-journal">
          <summary>Journal</summary>
          <div className="message assistant map-markdown">
            <Streamdown controls={false} linkSafety={LINK_SAFETY}>
              {readableJournal(journal)}
            </Streamdown>
          </div>
        </details>
      )}
    </div>
  )
}

/** How the most recent wrap-up that judged the ticket's criteria judged them. */
function latestCriteria(launches: readonly MapLaunch[], ticket: string): CriterionResult[] {
  const judged = launches
    .filter((l) => l.wrapUp?.criteria.some((c) => c.ticket === ticket))
    .sort((a, b) => (a.wrapUp?.at ?? '').localeCompare(b.wrapUp?.at ?? ''))
    .at(-1)
  return judged?.wrapUp?.criteria.filter((c) => c.ticket === ticket) ?? []
}

function healthLine(health: PullRequestHealth): string {
  const checks = { passed: 'checks pass', failed: `checks failing: ${health.failing.join(', ')}`, running: 'checks running', none: 'no checks' }[health.checks]
  const review = { approved: 'approved', 'changes-requested': 'changes requested', none: 'not reviewed yet' }[health.review]
  return [checks, review, ...(health.unresolved > 0 ? [`${health.unresolved} unresolved thread${health.unresolved === 1 ? '' : 's'}`] : [])].join(' · ')
}

/** The journal as stored, with each entry's ISO time shown as a short local time. */
function readableJournal(journal: string): string {
  return journal.replace(/^- (\d{4}-\d\d-\d\dT[\d:.]+Z) /gm, (_line, iso: string) => {
    const at = new Date(iso)
    return Number.isNaN(at.getTime()) ? `- ${iso} ` : `- ${at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · `
  })
}
