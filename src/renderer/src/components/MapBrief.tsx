import { ArrowLeft, ArrowRight, Check, CircleAlert, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LaunchMode, MapBriefPreview, MapDetail, MapTicket } from '../../../shared/ipc'
import { milestoneKey, ticketKey, WORK_LABEL, workState } from '../lib/mapStatus'
import { Chip, type Tone } from './MapOverview'
import type { MapActions } from './MapView'

const api = window.manta

/** What the user chose for one ticket on its brief, kept while walking several. */
export interface BriefChoice {
  note: string
  mode: LaunchMode
  /** A code project root; null for the one a launch would pick. */
  project: string | null
}

export interface BriefStart extends BriefChoice {
  ticket: MapTicket
}

const READY_TONE: Record<ReturnType<typeof workState>['status'], Tone> = { ready: 'done', 'in-progress': 'info', blocked: 'you', 'in-review': 'done', done: 'done', cancelled: 'muted' }

const MODES: readonly LaunchMode[] = ['ticket', 'milestone']

/** How long typing in the note waits before the preview catches up. */
const PREVIEW_DELAY_MS = 300

/**
 * The agent brief before a ticket starts (frame "Agent launch brief"): what the agent is asked to do,
 * whether that's enough to work from, the docs it's pointed to, and where its session runs. Several
 * tickets are walked one brief at a time, then started together. Edits change the ticket itself; the
 * note is for this start only.
 */
export function MapBrief(props: {
  map: MapDetail
  tickets: readonly string[]
  back: string
  actions: MapActions
  busy: boolean
  codeProjects: readonly { root: string; name: string }[]
  defaultMode: (ticket: MapTicket) => LaunchMode
  onBack: () => void
  onStart: (starts: BriefStart[], event: React.MouseEvent) => void
}): React.JSX.Element {
  const { map, actions } = props
  const all = map.milestones.flatMap((m) => m.tickets)
  const queue = props.tickets.flatMap((id) => all.find((t) => t.id === id) ?? [])
  const [index, setIndex] = useState(0)
  const [choices, setChoices] = useState<Record<string, BriefChoice>>({})
  const ticket = queue[Math.min(index, queue.length - 1)]
  if (!ticket) {
    return (
      <div className="empty-state">
        <h2>Ticket removed</h2>
        <p>This ticket is no longer on the map.</p>
        <button className="map-button" onClick={props.onBack}>
          {props.back}
        </button>
      </div>
    )
  }
  const choice = choices[ticket.id] ?? { note: '', mode: props.defaultMode(ticket), project: null }
  const choose = (change: Partial<BriefChoice>): void => setChoices((c) => ({ ...c, [ticket.id]: { ...choice, ...change } }))
  const last = index >= queue.length - 1

  const start = (event: React.MouseEvent): void => {
    props.onStart(
      queue.map((t) => ({ ticket: t, ...(choices[t.id] ?? { note: '', mode: props.defaultMode(t), project: null }) })),
      event
    )
  }

  return (
    <div className="map-scroll">
      <div className="map-page">
        <button className="map-link map-brief-back" onClick={props.onBack}>
          <ArrowLeft size={12} /> {props.back}
        </button>
        <header className="map-ov-head">
          <div className="map-ov-heading">
            <h1>Review the agent brief</h1>
            <p className="map-ov-description">A focused task, grounded in your Context Map. Nothing starts until you’re ready.</p>
          </div>
          <div className="map-brief-steps">
            <Chip tone="info">1 Review {queue.length > 1 ? `brief ${index + 1} of ${queue.length}` : 'brief'}</Chip>
            <ArrowRight size={13} />
            <span>2 Start {queue.length > 1 ? `${queue.length} sessions` : 'session'}</span>
          </div>
        </header>
        <BriefBody key={ticket.id} map={map} ticket={ticket} choice={choice} choose={choose} actions={actions} codeProjects={props.codeProjects} />
        <footer className="map-brief-footer">
          <span>You’ll review the changes before marking {queue.length > 1 ? 'these tickets' : 'this ticket'} done.</span>
          <span className="grow" />
          {index > 0 && (
            <button className="map-button" onClick={() => setIndex(index - 1)}>
              <ArrowLeft size={13} /> Previous
            </button>
          )}
          <button className="map-button" onClick={props.onBack}>
            Cancel
          </button>
          {last ? (
            <button className="map-button primary large" disabled={props.busy} onClick={start}>
              {queue.length > 1 ? `Start ${queue.length} agents` : 'Start agent'} <ArrowRight size={13} />
            </button>
          ) : (
            <button className="map-button primary large" onClick={() => setIndex(index + 1)}>
              Next brief <ArrowRight size={13} />
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function BriefBody({
  map,
  ticket,
  choice,
  choose,
  actions,
  codeProjects
}: {
  map: MapDetail
  ticket: MapTicket
  choice: BriefChoice
  choose: (change: Partial<BriefChoice>) => void
  actions: MapActions
  codeProjects: readonly { root: string; name: string }[]
}): React.JSX.Element {
  const [preview, setPreview] = useState<MapBriefPreview | null>(null)
  const [editing, setEditing] = useState(false)
  const [showText, setShowText] = useState(false)
  const milestone = map.milestones.find((m) => m.tickets.some((t) => t.id === ticket.id))
  const work = workState(map, ticket)

  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      api
        .previewMapBrief({ docsRoot: actions.docsRoot, map: map.id, ticket: ticket.id, mode: choice.mode, project: choice.project, note: choice.note })
        .then((p) => current && setPreview(p))
        .catch(actions.report)
    }, PREVIEW_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [actions.docsRoot, actions.report, map, ticket.id, choice.mode, choice.project, choice.note])

  return (
    <div className="map-ov-grid brief">
      <section className="map-brief-card">
        <div className="map-brief-card-top">
          <span className="map-brief-label">
            {ticketKey(map, ticket)}
            {milestone && ` / ${milestoneKey(map, milestone)} ${milestone.title}`}
          </span>
          <Chip tone={READY_TONE[work.status]} {...(work.reason ? { title: work.reason } : {})}>
            {WORK_LABEL[work.status]}
          </Chip>
        </div>
        {editing ? (
          <BriefEditor
            ticket={ticket}
            note={choice.note}
            actions={actions}
            onDone={(note) => {
              choose({ note })
              setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <div className="map-brief-title-row">
              <h2>{ticket.title}</h2>
              <button className="map-link" onClick={() => setEditing(true)}>
                Edit brief
              </button>
            </div>
            <hr />
            <h3>Objective</h3>
            {ticket.description.trim() ? <p className="map-brief-text">{ticket.description.trim()}</p> : <p className="map-brief-empty">No objective yet. Edit the brief to say what the agent should achieve.</p>}
            <h3>Acceptance criteria</h3>
            {ticket.acceptance.length > 0 ? (
              <ol className="map-brief-criteria">
                {ticket.acceptance.map((criterion, i) => (
                  <li key={`${i}:${criterion}`}>
                    <span className="map-brief-number">{i + 1}</span>
                    <span>{criterion}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="map-brief-empty">None. The agent decides what done means and says so in its journal.</p>
            )}
            <hr />
            <h3>Constraints &amp; non-goals</h3>
            {ticket.constraints.length > 0 ? (
              <ul className="map-brief-constraints">
                {ticket.constraints.map((c, i) => (
                  <li key={`${i}:${c}`}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="map-brief-empty">None set.</p>
            )}
            {choice.note.trim() && (
              <>
                <h3>Note for this start</h3>
                <p className="map-brief-text">{choice.note.trim()}</p>
              </>
            )}
          </>
        )}
        <div className="map-brief-handoff">
          <span>Return for human review</span>
          <span className="map-brief-muted">Implementation summary · Acceptance evidence · Proposed doc updates</span>
        </div>
        <button className="map-link map-brief-show" onClick={() => setShowText((v) => !v)}>
          {showText ? 'Hide the full brief' : 'Show the full brief'}
        </button>
        {showText && <pre className="map-brief-full">{preview?.text ?? 'Loading…'}</pre>}
      </section>

      <aside className="map-ov-side">
        {preview && <Readiness preview={preview} />}
        <SourceContext map={map} ticket={ticket} preview={preview} actions={actions} />
        <SessionSetup map={map} preview={preview} choice={choice} choose={choose} codeProjects={codeProjects} />
      </aside>
    </div>
  )
}

function Readiness({ preview }: { preview: MapBriefPreview }): React.JSX.Element {
  const { readiness } = preview
  const included = readiness.included.length > 0 ? `${readiness.included.join(', ').replace(/^./, (c) => c.toUpperCase())} included.` : 'Nothing included yet.'
  return (
    <section className={`map-brief-ready ${readiness.ready ? 'ok' : 'warn'}`}>
      <h2>
        {readiness.ready ? <Check size={15} /> : <CircleAlert size={15} />} {readiness.ready ? 'Context ready' : 'Context incomplete'}
      </h2>
      <p>{included}</p>
      {readiness.missing.length > 0 && <p>{readiness.missing.join(' · ')}.</p>}
      <p>{readiness.blocking.length > 0 ? `${readiness.blocking.join(' · ')}. You can still start it.` : 'No blocking dependencies.'}</p>
    </section>
  )
}

function SourceContext({ map, ticket, preview, actions }: { map: MapDetail; ticket: MapTicket; preview: MapBriefPreview | null; actions: MapActions }): React.JSX.Element {
  const [adding, setAdding] = useState<{ path: string; heading: string } | null>(null)
  const docs = preview?.docs ?? []
  const sections = docs.filter((d) => d.heading).length
  const whole = docs.length - sections
  const counts = [...(sections > 0 ? [`${sections} linked ${sections === 1 ? 'section' : 'sections'}`] : []), ...(whole > 0 ? [`${whole} source ${whole === 1 ? 'document' : 'documents'}`] : [])]
  const outline = preview?.outline ?? []
  const headings = outline.find((o) => o.path === adding?.path)?.headings ?? []

  const attach = (): void => {
    if (!adding?.path) return
    const heading = adding.heading || null
    setAdding(null)
    if (ticket.docs.some((d) => d.path === adding.path && d.heading === heading)) return
    void actions.edit({ kind: 'update-ticket', ticket: ticket.id, docs: [...ticket.docs, { path: adding.path, heading }] })
  }

  return (
    <section className="map-card map-ov-side-card">
      <div className="map-ov-section-head">
        <h2>Context the agent will receive</h2>
        <span className="grow" />
        {!adding && (
          <button className="map-link" disabled={outline.length === 0} title={outline.length === 0 ? `Add docs to ${map.title} first` : undefined} onClick={() => setAdding({ path: outline[0]?.path ?? '', heading: '' })}>
            <Plus size={11} /> Attach context
          </button>
        )}
      </div>
      <p className="map-ov-side-sub">{preview ? (counts.length > 0 ? counts.join(' · ') : 'No docs yet: the agent only gets the ticket.') : 'Loading…'}</p>
      {docs.map((doc) => (
        <div key={`${doc.path}#${doc.heading ?? ''}`} className="map-brief-doc">
          <button className="map-ov-doc" title={doc.path} onClick={() => actions.openDoc({ path: doc.path, heading: doc.heading })}>
            {doc.roles.length > 0 && <span className="map-ov-doc-role">{doc.roles.map((r) => r.toUpperCase()).join(' + ')}</span>}
            <span className="map-ov-doc-title">{doc.heading ?? doc.title}</span>
            <span className="map-ov-doc-meta">{[...(doc.heading ? [doc.title] : ['The whole doc']), ...(doc.linked ? [] : ['from the milestone'])].join(' · ')}</span>
          </button>
          {doc.linked && (
            <button className="icon-button map-brief-unlink" title="Unlink from the ticket" onClick={() => void actions.edit({ kind: 'update-ticket', ticket: ticket.id, docs: ticket.docs.filter((d) => !(d.path === doc.path && d.heading === doc.heading)) })}>
              <X size={12} />
            </button>
          )}
        </div>
      ))}
      {adding ? (
        <form
          className="map-brief-attach"
          onSubmit={(e) => {
            e.preventDefault()
            attach()
          }}
        >
          <select className="map-select-field" value={adding.path} onChange={(e) => setAdding({ path: e.target.value, heading: '' })}>
            {outline.map((o) => (
              <option key={o.path} value={o.path}>
                {o.title} ({o.path})
              </option>
            ))}
          </select>
          <select className="map-select-field" value={adding.heading} onChange={(e) => setAdding({ ...adding, heading: e.target.value })}>
            <option value="">The whole doc</option>
            {headings.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
          <div className="map-brief-attach-actions">
            <button type="submit" className="map-button primary" disabled={!adding.path}>
              Attach
            </button>
            <button type="button" className="map-button" onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  )
}

function SessionSetup({
  map,
  preview,
  choice,
  choose,
  codeProjects
}: {
  map: MapDetail
  preview: MapBriefPreview | null
  choice: BriefChoice
  choose: (change: Partial<BriefChoice>) => void
  codeProjects: readonly { root: string; name: string }[]
}): React.JSX.Element {
  const workspace = preview?.workspace
  const choosable = workspace?.kind === 'pick' ? codeProjects.filter((p) => workspace.projects.includes(p.root)) : workspace?.kind === 'new' && codeProjects.length > 1 ? codeProjects : []
  return (
    <section className="map-card map-ov-side-card map-brief-setup">
      <h2>Session setup</h2>
      <span className="map-brief-field">Agent</span>
      <span className="map-brief-value">Claude Code</span>
      <hr />
      <span className="map-brief-field">Workspace</span>
      {!workspace && <span className="map-brief-muted">Loading…</span>}
      {workspace?.kind === 'new' && (
        <>
          <span className="map-brief-value">
            {workspace.project} / {workspace.branch}
          </span>
          <span className="map-brief-muted">{workspace.shared ? `New worktree for the milestone, from ${workspace.from}; its other tickets share it` : `New isolated worktree from ${workspace.from}`}</span>
        </>
      )}
      {workspace?.kind === 'reuse' && (
        <>
          <span className="map-brief-value">
            {workspace.project} / {workspace.branch}
          </span>
          <span className="map-brief-muted">{workspace.shared ? `The milestone’s worktree ${workspace.worktree}, shared with its other tickets` : `Carries on in its worktree ${workspace.worktree}`}</span>
        </>
      )}
      {workspace?.kind === 'pick' && <span className="map-brief-muted">Pick the code project to work in.</span>}
      {workspace?.kind === 'none' && <span className="map-brief-muted">{workspace.message}</span>}
      {choosable.length > 0 && (
        <select className="map-select-field" value={choice.project ?? (workspace?.kind === 'new' ? workspace.root : '')} onChange={(e) => choose({ project: e.target.value || null })}>
          {workspace?.kind === 'pick' && <option value="">Pick a code project…</option>}
          {choosable.map((p) => (
            <option key={p.root} value={p.root}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <div className="map-brief-modes" role="radiogroup" aria-label="Worktree">
        {MODES.map((mode) => (
          <button key={mode} role="radio" aria-checked={choice.mode === mode} className={`map-ms-filter ${choice.mode === mode ? 'active' : ''}`} onClick={() => choose({ mode })}>
            {mode === 'ticket' ? 'Its own worktree' : 'The milestone’s worktree'}
          </button>
        ))}
      </div>
      {preview && (
        <div className="map-brief-chips">
          {preview.permissions.map((p) => (
            <Chip key={p} tone="muted">
              {p}
            </Chip>
          ))}
        </div>
      )}
      <span className="map-brief-muted small">Permissions come from the Claude command in Manta’s settings{map.checks.length > 0 ? ' and the map’s checks' : ''}.</span>
    </section>
  )
}

/** Edit brief: the ticket's own title, objective, criteria and constraints, plus the note for this start. */
function BriefEditor({ ticket, note, actions, onDone, onCancel }: { ticket: MapTicket; note: string; actions: MapActions; onDone: (note: string) => void; onCancel: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState({ title: ticket.title, objective: ticket.description, acceptance: ticket.acceptance.join('\n'), constraints: ticket.constraints.join('\n'), note })
  const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter(Boolean)

  const save = async (): Promise<void> => {
    const acceptance = lines(draft.acceptance)
    const constraints = lines(draft.constraints)
    const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])
    const changes = {
      ...(draft.title.trim() && draft.title.trim() !== ticket.title ? { title: draft.title.trim() } : {}),
      ...(draft.objective.trim() !== ticket.description.trim() ? { description: draft.objective.trim() } : {}),
      ...(same(acceptance, ticket.acceptance) ? {} : { acceptance }),
      ...(same(constraints, ticket.constraints) ? {} : { constraints })
    }
    if (Object.keys(changes).length > 0 && !(await actions.edit({ kind: 'update-ticket', ticket: ticket.id, ...changes }))) return
    onDone(draft.note)
  }

  return (
    <form
      className="map-brief-editor"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save()
      }}
    >
      <label>
        <span>Title</span>
        <input autoFocus value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </label>
      <label>
        <span>Objective</span>
        <textarea rows={4} value={draft.objective} placeholder="What the agent should achieve, and why" onChange={(e) => setDraft({ ...draft, objective: e.target.value })} />
      </label>
      <label>
        <span>Acceptance criteria, one per line</span>
        <textarea rows={4} value={draft.acceptance} placeholder="A behaviour or a test that passes" onChange={(e) => setDraft({ ...draft, acceptance: e.target.value })} />
      </label>
      <label>
        <span>Constraints &amp; non-goals, one per line</span>
        <textarea rows={3} value={draft.constraints} placeholder="What the work must keep or leave alone" onChange={(e) => setDraft({ ...draft, constraints: e.target.value })} />
      </label>
      <label>
        <span>Note for this start only (not saved to the ticket)</span>
        <textarea rows={2} value={draft.note} placeholder="Anything the agent should know this time" onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
      </label>
      <div className="map-brief-editor-actions">
        <button type="button" className="map-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="map-button primary">
          Save brief
        </button>
      </div>
    </form>
  )
}
