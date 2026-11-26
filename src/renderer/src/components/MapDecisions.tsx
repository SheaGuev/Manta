import { ExternalLink, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { DecisionInput, DecisionOption, DecisionStatus, DocRef, MapDecision, MapDetail, TrackerEdit } from '../../../shared/ipc'
import { isClosed } from '../../../shared/ipc'
import { authorLabel, decisionNumber, milestoneKey, raisedIn, ticketKey } from '../lib/mapStatus'
import { relativeDate } from '../lib/relativeDate'
import { Chip } from './MapOverview'
import type { MapActions } from './MapView'
import { MultiSelect } from './MultiSelect'

/** Which decision the page shows: one by id, the form for a new one, or none picked yet. */
export type DecisionSelection = string | 'new' | null

const STATUS_LABEL: Record<DecisionStatus, string> = { open: 'Open', decided: 'Decided', superseded: 'Superseded' }
const FILTERS: readonly DecisionStatus[] = ['open', 'decided', 'superseded']

/**
 * A map's Decisions (frame "Decisions"): the register on the left, open ones first, and the picked
 * decision on the right, where the user chooses an option, fills in what it requires and confirms it.
 * A decision blocks the tickets it names until it's decided.
 */
export function MapDecisions({ map, actions, selected, onSelect }: { map: MapDetail; actions: MapActions; selected: DecisionSelection; onSelect: (selection: DecisionSelection) => void }): React.JSX.Element {
  const open = map.decisions.filter((d) => d.status === 'open')
  const [filter, setFilter] = useState<DecisionStatus>(open.length > 0 || map.decisions.length === 0 ? 'open' : 'decided')
  const [search, setSearch] = useState('')
  const needle = search.trim().toLowerCase()
  const shown = map.decisions
    .filter((d) => d.status === filter && (!needle || [d.title, d.question, d.outcome].some((text) => text.toLowerCase().includes(needle))))
    .sort((a, b) => b.number - a.number)
  const picked = selected === 'new' ? null : (map.decisions.find((d) => d.id === selected) ?? shown[0] ?? null)
  const waiting = new Set(open.flatMap((d) => d.blocks))

  return (
    <div className="map-scroll">
      <div className="map-page">
        <header className="map-ov-head">
          <div className="map-ov-heading">
            <div className="map-ov-title">
              <h1>Decisions</h1>
              {open.length > 0 && <Chip tone="muted">{`${open.length} open`}</Chip>}
            </div>
            <p className="map-ov-description">The choices, trade-offs and rationale that keep everyone moving in the same direction.</p>
          </div>
          <div className="map-ov-actions">
            <button className="map-button" onClick={() => onSelect('new')}>
              <Plus size={13} /> New decision
            </button>
          </div>
        </header>

        <div className="map-dc-grid">
          <aside className="map-dc-register">
            <section className={`map-card map-dc-summary ${open.length > 0 ? 'needs-you' : ''}`}>
              <h2>{open.length === 0 ? 'Nothing needs you' : open.length === 1 ? 'One decision needs you' : `${open.length} decisions need you`}</h2>
              <p>
                {open.length === 0
                  ? `${map.decisions.length} ${map.decisions.length === 1 ? 'decision' : 'decisions'} on record.`
                  : waiting.size > 0
                    ? `${waiting.size} ${waiting.size === 1 ? 'ticket is' : 'tickets are'} waiting on ${open.length === 1 ? 'it' : 'them'}.`
                    : 'No tickets wait on them.'}
              </p>
            </section>
            <label className="map-dc-search">
              <input value={search} placeholder="Search decisions…" onChange={(e) => setSearch(e.target.value)} />
              <Search size={14} />
            </label>
            <div className="map-dc-filters">
              {FILTERS.map((status) => (
                <button key={status} className={`map-dc-filter ${filter === status ? 'active' : ''}`} onClick={() => setFilter(status)}>
                  {STATUS_LABEL[status]} <span>{map.decisions.filter((d) => d.status === status).length}</span>
                </button>
              ))}
            </div>
            <span className="map-ov-doc-role">Decision log</span>
            {shown.length === 0 && <div className="map-ov-empty">{needle ? 'Nothing matches.' : filter === 'open' ? 'Nothing open. Record one when the work needs a choice made.' : `No ${STATUS_LABEL[filter].toLowerCase()} decisions.`}</div>}
            {shown.map((decision) => (
              <DecisionCard key={decision.id} map={map} decision={decision} selected={selected !== 'new' && picked?.id === decision.id} onSelect={() => onSelect(decision.id)} />
            ))}
            <section className="map-card map-dc-note">
              <h3>A recommendation is not approval.</h3>
              <p>Agents can propose a choice. You keep the final say, and the map keeps the rationale and source history.</p>
              <span>Decided choices can be superseded.</span>
            </section>
          </aside>

          {selected === 'new' ? (
            <DecisionEditor key="new" map={map} decision={null} actions={actions} onDone={(ok) => ok && onSelect(null)} onCancel={() => onSelect(null)} />
          ) : picked ? (
            <DecisionDetail key={picked.id} map={map} decision={picked} actions={actions} onKeep={() => onSelect(picked.id)} />
          ) : (
            <section className="map-card map-dc-detail">
              <div className="map-ov-empty">{map.decisions.length === 0 ? 'No decisions yet. Record one when the work needs a choice made.' : 'Pick a decision on the left.'}</div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function DecisionCard({ map, decision, selected, onSelect }: { map: MapDetail; decision: MapDecision; selected: boolean; onSelect: () => void }): React.JSX.Element {
  const keys = raisedIn(map, decision.from)
  const blocking = decision.blocks.length
  const meta = [...(keys.length > 0 ? [`Raised in ${keys.join(', ')}`] : []), ...(decision.status === 'open' && blocking > 0 ? [`Blocks ${blocking} ${blocking === 1 ? 'ticket' : 'tickets'}`] : [])]
  return (
    <button className={`map-card map-dc-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className="map-dc-card-top">
        <span className="map-key">{decisionNumber(decision)}</span>
        <Chip tone={decision.status === 'open' ? 'you' : 'muted'}>{decision.status === 'open' ? 'Needs you' : STATUS_LABEL[decision.status]}</Chip>
      </span>
      <span className="map-dc-card-title">{decision.title}</span>
      <span className="map-dc-card-line">{decision.status === 'open' ? decision.question || 'Waiting to be decided.' : decision.outcome}</span>
      {meta.length > 0 && <span className="map-dc-card-meta">{meta.join(' · ')}</span>}
    </button>
  )
}

/** The option the page starts on: the one chosen, else the recommended one while it's open. */
function startingChoice(decision: MapDecision): number | null {
  if (decision.chosen !== null) return decision.chosen
  if (decision.status !== 'open') return null
  const recommended = decision.options.findIndex((o) => o.recommended)
  return recommended >= 0 ? recommended : null
}

/** `onKeep` pins the page to this decision, so deciding or reopening it doesn't swap it for another as it changes filter. */
function DecisionDetail({ map, decision, actions, onKeep }: { map: MapDetail; decision: MapDecision; actions: MapActions; onKeep: () => void }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [choice, setChoice] = useState<number | null>(() => startingChoice(decision))
  const [value, setValue] = useState(decision.input?.value ?? '')
  const [outcome, setOutcome] = useState('')
  if (editing) return <DecisionEditor map={map} decision={decision} actions={actions} onDone={(ok) => ok && setEditing(false)} onCancel={() => setEditing(false)} />

  const open = decision.status === 'open'
  const keys = raisedIn(map, decision.from)
  const tickets = map.milestones.flatMap((m) => m.tickets)
  const blocked = decision.blocks.flatMap((id) => tickets.find((t) => t.id === id) ?? [])
  const needsChoice = decision.options.length > 0 && choice === null
  const needsValue = decision.input !== null && !value.trim()
  const needsWords = decision.options.length === 0 && !outcome.trim()
  const hint = needsChoice ? 'Choose an option to confirm' : needsValue ? `Enter ${decision.input?.label.toLowerCase() ?? 'a value'} to confirm` : needsWords ? 'Say what was decided to confirm' : ''
  const set = (edit: Omit<Extract<TrackerEdit, { kind: 'update-decision' }>, 'kind' | 'decision'>): void => {
    onKeep()
    void actions.edit({ kind: 'update-decision', decision: decision.id, ...edit })
  }
  const confirm = (): void =>
    set({
      status: 'decided',
      ...(decision.options.length > 0 ? { chosen: choice } : { outcome }),
      ...(decision.input ? { input: { label: decision.input.label, value } } : {})
    })
  const raisedBy = decision.from ? `Raised by ${'ask' in decision.from ? 'Ask the map' : 'agent'}${keys.length > 0 ? ` · ${keys.join(', ')}` : ''}` : 'Added by you'

  return (
    <section className="map-card map-dc-detail">
      <div className="map-dc-detail-top">
        <Chip tone={open ? 'you' : 'muted'}>{`${STATUS_LABEL[decision.status].toUpperCase()} / ${decisionNumber(decision)}`}</Chip>
        <span className="map-dc-raised" title={decision.from ? `Raised by ${authorLabel(map, decision.from)}` : undefined}>
          {raisedBy}
          {decision.createdAt ? ` · ${relativeDate(decision.createdAt)}` : ''}
        </span>
        <span className="grow" />
        <button className="map-link" onClick={() => setEditing(true)}>
          <Pencil size={11} /> Edit
        </button>
      </div>
      <h2 className="map-dc-title">{decision.title}</h2>
      {decision.question && <p className="map-dc-question">{decision.question}</p>}

      {decision.options.length > 0 && (
        <div className="map-dc-block">
          <span className="map-ov-doc-role">{open ? 'Proposed choice' : 'Chosen'}</span>
          {open && decision.options.some((o) => o.recommended) && <p className="map-dc-sub">{`Recommendation from ${decision.from ? 'the agent' : 'you'} · Not yet approved`}</p>}
          <div className="map-dc-options">
            {decision.options.map((option, index) => (
              <button key={`${index}${option.title}`} className={`map-dc-option ${choice === index ? 'chosen' : ''}`} disabled={!open} onClick={() => setChoice(index)}>
                <span className="map-dc-option-title">
                  <span className="map-dc-radio" />
                  {option.title}
                </span>
                <span className="map-dc-option-kind">{option.recommended ? 'Recommended' : 'Alternative'}</span>
                {option.detail && <span className="map-dc-option-detail">{option.detail}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {decision.input && (
        <div className="map-dc-block">
          <div className="map-dc-input-head">
            <span>{decision.input.label}</span>
            {open && needsValue && <span className="map-dc-required">Required to confirm this choice</span>}
          </div>
          <input className="map-dc-input" value={value} disabled={!open} placeholder={`Enter the approved ${decision.input.label.toLowerCase()}`} onChange={(e) => setValue(e.target.value)} />
        </div>
      )}

      {open && decision.options.length === 0 && (
        <div className="map-dc-block">
          <span className="map-ov-doc-role">What was decided, and why</span>
          <textarea className="map-dc-input" rows={3} value={outcome} placeholder="The choice, and the reason for it" onChange={(e) => setOutcome(e.target.value)} />
        </div>
      )}

      {!open && decision.outcome && (
        <div className="map-dc-block">
          <span className="map-ov-doc-role">{`Decided${decision.decidedAt ? ` ${relativeDate(decision.decidedAt)}` : ''}`}</span>
          <p className="map-dc-question">{decision.outcome}</p>
        </div>
      )}

      {decision.docs.length > 0 && (
        <div className="map-dc-block">
          <span className="map-ov-doc-role">Connected context</span>
          <div className="map-dc-chips">
            {decision.docs.map((ref) => (
              <button key={`${ref.path}#${ref.heading ?? ''}`} className="map-dc-doc" title={ref.path} onClick={() => actions.openDoc(ref)}>
                {docLabel(map, ref)} <ExternalLink size={11} />
              </button>
            ))}
          </div>
        </div>
      )}

      {blocked.length > 0 && (
        <div className="map-dc-block">
          <span className="map-ov-doc-role">{open ? 'Affected work' : 'Work it held'}</span>
          <div className="map-dc-tickets">
            {blocked.map((ticket) => (
              <button key={ticket.id} className="map-dc-ticket" onClick={() => actions.openTicket(ticket)}>
                {ticketKey(map, ticket)} · {ticket.title}
              </button>
            ))}
          </div>
        </div>
      )}

      <footer className="map-dc-footer">
        <button className="map-button" onClick={() => actions.askAbout(`About decision ${decisionNumber(decision)} “${decision.title}”: `)}>
          Ask a question
        </button>
        <span className="grow" />
        {open ? (
          <>
            {hint && <span className="map-dc-hint">{hint}</span>}
            <button className="map-button primary large" disabled={hint !== ''} onClick={confirm}>
              Confirm decision
            </button>
          </>
        ) : (
          <>
            {decision.status === 'decided' && (
              <button className="map-button" onClick={() => set({ status: 'superseded' })}>
                Mark superseded
              </button>
            )}
            <button className="map-button" onClick={() => set({ status: 'open' })}>
              Reopen
            </button>
          </>
        )}
      </footer>
    </section>
  )
}

/** A doc reference as its title, then the section: "Production setup runbook · Domains". */
function docLabel(map: MapDetail, ref: DocRef): string {
  const title = map.docs.find((d) => d.path === ref.path)?.title ?? ref.path
  return ref.heading ? `${title} · ${ref.heading}` : title
}

/** The tickets a decision blocks, by milestone; done ones left out unless already picked. */
function BlocksPicker({ map, value, onChange }: { map: MapDetail; value: readonly string[]; onChange: (ids: string[]) => void }): React.JSX.Element {
  const options = map.milestones.flatMap((milestone) =>
    milestone.tickets
      .filter((t) => !isClosed(t.status) || value.includes(t.id))
      .map((ticket) => ({ id: ticket.id, key: ticketKey(map, ticket), label: ticket.title, group: `${milestoneKey(map, milestone)} · ${milestone.title}` }))
  )
  return <MultiSelect options={options} value={value} onChange={onChange} placeholder="Blocks nothing" />
}

/** Every field of a decision, for a new one or to edit one: options, what it requires, its docs and the tickets that wait. */
function DecisionEditor({ map, decision, actions, onDone, onCancel }: { map: MapDetail; decision: MapDecision | null; actions: MapActions; onDone: (ok: boolean) => void; onCancel?: () => void }): React.JSX.Element {
  const [title, setTitle] = useState(decision?.title ?? '')
  const [question, setQuestion] = useState(decision?.question ?? '')
  const [options, setOptions] = useState<DecisionOption[]>(decision?.options ?? [])
  const [requires, setRequires] = useState(decision?.input?.label ?? '')
  const [docs, setDocs] = useState<DocRef[]>(decision?.docs ?? [])
  const [blocks, setBlocks] = useState<string[]>(decision?.blocks ?? [])
  const [outcome, setOutcome] = useState(decision?.outcome ?? '')
  const [adding, setAdding] = useState<string>(map.docs[0]?.path ?? '')

  const setOption = (index: number, change: Partial<DecisionOption>): void =>
    setOptions((list) => list.map((o, i) => (i === index ? { ...o, ...change } : change.recommended ? { ...o, recommended: false } : o)))
  const input: DecisionInput | null = requires.trim() ? { label: requires.trim(), value: decision?.input?.label === requires.trim() ? decision.input.value : '' } : null
  const save = (): void => {
    const fields = { title, question, options, input, docs, blocks }
    const edit: TrackerEdit = decision ? { kind: 'update-decision', decision: decision.id, ...fields, ...(decision.status !== 'open' ? { outcome } : {}) } : { kind: 'add-decision', ...fields }
    void actions.edit(edit).then(onDone)
  }

  return (
    <form
      className="map-card map-dc-detail map-decision-detail"
      onSubmit={(e) => {
        e.preventDefault()
        if (title.trim()) save()
      }}
    >
      <h2>{decision ? `Edit decision ${decisionNumber(decision)}` : 'New decision'}</h2>
      <label className="dialog-field">
        <span>Title</span>
        <input autoFocus={!decision} value={title} placeholder="Production domain" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="dialog-field">
        <span>The question</span>
        <textarea rows={3} value={question} placeholder="Which domain do we ship on, and who owns its DNS?" onChange={(e) => setQuestion(e.target.value)} />
      </label>

      <div className="dialog-field">
        <span>Options</span>
        {options.map((option, index) => (
          <div key={index} className="map-dc-option-edit">
            <input value={option.title} placeholder="A few words" onChange={(e) => setOption(index, { title: e.target.value })} />
            <input value={option.detail} placeholder="What it means and costs" onChange={(e) => setOption(index, { detail: e.target.value })} />
            <label className="map-check">
              <input type="radio" checked={option.recommended} onChange={() => setOption(index, { recommended: true })} /> Recommended
            </label>
            <button type="button" className="icon-button" title="Remove this option" onClick={() => setOptions((list) => list.filter((_, i) => i !== index))}>
              <X size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="map-link" onClick={() => setOptions((list) => [...list, { title: '', detail: '', recommended: false }])}>
          <Plus size={11} /> Add option
        </button>
      </div>

      <label className="dialog-field">
        <span>Requires a value to confirm (optional)</span>
        <input value={requires} placeholder="Production domain" onChange={(e) => setRequires(e.target.value)} />
      </label>

      <div className="dialog-field">
        <span>Connected docs</span>
        {docs.map((ref, index) => (
          <div key={`${ref.path}#${ref.heading ?? ''}`} className="map-dc-option-edit">
            <span className="map-dc-doc-name">{docLabel(map, ref)}</span>
            <button type="button" className="icon-button" title="Unlink this doc" onClick={() => setDocs((list) => list.filter((_, i) => i !== index))}>
              <X size={12} />
            </button>
          </div>
        ))}
        {map.docs.length > 0 ? (
          <div className="map-dc-option-edit">
            <select className="map-select-field" value={adding} onChange={(e) => setAdding(e.target.value)}>
              {map.docs.map((doc) => (
                <option key={doc.path} value={doc.path}>
                  {doc.title}
                </option>
              ))}
            </select>
            <button type="button" className="map-link" disabled={!adding || docs.some((d) => d.path === adding && d.heading === null)} onClick={() => setDocs((list) => [...list, { path: adding, heading: null }])}>
              <Plus size={11} /> Link
            </button>
          </div>
        ) : (
          <span className="map-brief-muted">The map has no docs to link yet.</span>
        )}
      </div>

      {decision && decision.status !== 'open' && (
        <label className="dialog-field">
          <span>What was decided, and why</span>
          <textarea rows={3} value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        </label>
      )}

      <div className="dialog-field">
        <span>Tickets that wait for it</span>
        <BlocksPicker map={map} value={blocks} onChange={setBlocks} />
      </div>

      <div className="dialog-actions">
        {decision && (
          <button type="button" className="icon-button" title="Remove this decision" onClick={() => void actions.edit({ kind: 'remove-decision', decision: decision.id })}>
            <Trash2 size={13} />
          </button>
        )}
        <span className="grow" />
        {onCancel && (
          <button type="button" className="map-button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="map-button primary" disabled={!title.trim() || options.some((o) => !o.title.trim())}>
          {decision ? 'Save' : 'Add decision'}
        </button>
      </div>
    </form>
  )
}
