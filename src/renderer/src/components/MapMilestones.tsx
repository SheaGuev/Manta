import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Circle, CircleCheck, ClipboardCheck, CircleDot, ExternalLink, MoreHorizontal, MoveRight, Pencil, Pin, Play, Plus, Rocket, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DoneItem, MapDetail, MapMilestoneInfo, MapTicket, MilestoneStatus, TicketStatus } from '../../../shared/ipc'
import { hasWork } from '../lib/mapReview'
import { independentTickets, matchesFilter, needsYou, stripMarks, ticketMeta, type StripMark, type TicketFilter } from '../lib/mapMilestones'
import { ACTIVITY_LABEL, agentActivity, milestoneKey, ticketKey, WORK_LABEL, workState, type AgentActivity, type WorkStatus } from '../lib/mapStatus'
import { currentOf, STATUS_LABEL } from '../lib/mapUpNext'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Chip, type Tone } from './MapOverview'
import { ClampedText, StatusDot } from './MapParts'
import { AgentsCard } from './MapAgents'
import type { MapActions } from './MapView'

const TICKET_STATUSES: readonly TicketStatus[] = ['todo', 'in-progress', 'blocked', 'in-review', 'done']
const MILESTONE_STATUSES: readonly MilestoneStatus[] = ['todo', 'in-progress', 'done']

const FILTERS: readonly { filter: TicketFilter; label: string }[] = [
  { filter: 'open', label: 'All open' },
  { filter: 'needs-you', label: 'Needs you' },
  { filter: 'ready', label: 'Ready' }
]

const WORK_TONE: Record<WorkStatus, Tone> = { ready: 'muted', 'in-progress': 'info', blocked: 'muted', 'in-review': 'done', done: 'done' }

const MARK_LABEL: Record<NonNullable<StripMark>, string> = { done: 'Done', current: 'Current', next: 'Next' }

/** An inline input on the page: a new milestone, a new ticket in the selected one, a rename, or the description. */
type Input = { kind: 'milestone' } | { kind: 'ticket' } | { kind: 'rename' } | { kind: 'description' }

interface Menu {
  x: number
  y: number
  items: MenuItem[]
}

/**
 * The map's plan: a strip of milestones, and the selected one's tickets with their work status kept
 * apart from what their agents are doing. Beside it, what can start now, the milestone's definition
 * of done, and its done tickets (hidden from the table until asked for). Milestones and tickets are
 * added, renamed, reordered, moved, set by hand and removed from their ⋯ menus or by right-click.
 */
export function MapMilestones(props: { map: MapDetail; actions: MapActions; busy: boolean; selected: string | null; onSelect: (milestone: string) => void }): React.JSX.Element {
  const { map, actions, busy, selected: chosen } = props
  const current = currentOf(map)
  const milestone = map.milestones.find((m) => m.id === chosen) ?? current ?? map.milestones[0] ?? null
  const [filter, setFilter] = useState<TicketFilter>('open')
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [showDone, setShowDone] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [input, setInput] = useState<Input | null>(null)
  const [text, setText] = useState('')
  const marks = stripMarks(map, current?.id ?? null)
  const strip = useRef<HTMLElement>(null)
  const milestoneId = milestone?.id ?? null

  useEffect(() => {
    strip.current?.querySelector('.map-ms-card.selected')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [milestoneId])

  /** A mouse wheel scrolls vertically; on the strip it should move along the milestones. React's wheel listener is passive, so this one is added by hand. */
  useEffect(() => {
    const element = strip.current
    if (!element) return
    const onWheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY) || element.scrollWidth <= element.clientWidth) return
      event.preventDefault()
      element.scrollLeft += event.deltaY
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
    }
  }, [milestoneId])

  const select = (id: string): void => {
    props.onSelect(id)
    setSelected([])
    setInput(null)
  }

  const startInput = (next: Input, value = ''): void => {
    setInput(next)
    setText(value)
  }

  const submit = (): void => {
    const value = text.trim()
    const target = input
    setInput(null)
    if (!target) return
    if (target.kind === 'description') {
      if (milestone && value !== milestone.description.trim()) void actions.edit({ kind: 'update-milestone', milestone: milestone.id, description: value })
      return
    }
    if (!value) return
    if (target.kind === 'milestone') void actions.edit({ kind: 'add-milestone', title: value })
    else if (milestone && target.kind === 'ticket') void actions.edit({ kind: 'add-ticket', milestone: milestone.id, title: value })
    else if (milestone && value !== milestone.title) void actions.edit({ kind: 'update-milestone', milestone: milestone.id, title: value })
  }

  const inlineInput = (placeholder: string, className = ''): React.JSX.Element => (
    <form
      className={`map-ms-inline ${className}`}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <input autoFocus value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={submit} onKeyDown={(e) => e.key === 'Escape' && setInput(null)} />
    </form>
  )

  const openMenu = (event: React.MouseEvent, items: MenuItem[]): void => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ x: event.clientX, y: event.clientY, items })
  }

  const milestoneMenu = (target: MapMilestoneInfo, event: React.MouseEvent): void => {
    const index = map.milestones.indexOf(target)
    openMenu(event, [
      { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => (select(target.id), startInput({ kind: 'rename' }, target.title)) },
      { label: 'Edit description', icon: <Pencil size={14} />, onSelect: () => (select(target.id), startInput({ kind: 'description' }, target.description)) },
      ...(index > 0 ? [{ label: 'Move earlier', icon: <ArrowLeft size={14} />, onSelect: () => void actions.edit({ kind: 'move-milestone', milestone: target.id, before: map.milestones[index - 1]?.id ?? null }) }] : []),
      ...(index < map.milestones.length - 1 ? [{ label: 'Move later', icon: <ArrowRight size={14} />, onSelect: () => void actions.edit({ kind: 'move-milestone', milestone: target.id, before: map.milestones[index + 2]?.id ?? null }) }] : []),
      map.pinned === target.id
        ? { label: 'Unpin as current', icon: <Pin size={14} />, onSelect: () => actions.pin(null) }
        : { label: 'Make current', icon: <Pin size={14} />, onSelect: () => actions.pin(target.id) },
      ...MILESTONE_STATUSES.map((status) => ({ label: `Mark ${STATUS_LABEL[status]}`, icon: <StatusDot status={status} />, onSelect: () => void actions.edit({ kind: 'set-milestone-status', milestone: target.id, status }) })),
      ...(target.manual ? [{ label: 'Status from its work', icon: <CircleDot size={14} />, onSelect: () => void actions.edit({ kind: 'set-milestone-status', milestone: target.id, status: null }) }] : []),
      { label: 'Start milestone', icon: <Rocket size={14} />, onSelect: () => actions.launch({ milestone: target.id }, target.title, event) },
      { label: 'Remove…', icon: <Trash2 size={14} />, onSelect: () => actions.remove({ milestone: target.id }) }
    ])
  }

  const ticketMenu = (ticket: MapTicket, owner: MapMilestoneInfo, event: React.MouseEvent): void => {
    const index = owner.tickets.indexOf(ticket)
    openMenu(event, [
      { label: 'Open', icon: <ExternalLink size={14} />, onSelect: () => actions.openTicket(ticket) },
      ...(hasWork(map, ticket) ? [{ label: 'Review the work', icon: <ClipboardCheck size={14} />, onSelect: () => actions.reviewTicket(ticket) }] : []),
      ...(ticket.status === 'todo' ? [{ label: 'Start', icon: <Play size={14} />, onSelect: () => actions.launch({ ticket: ticket.id }, ticket.title, event, ticket) }] : []),
      ...TICKET_STATUSES.filter((s) => s !== ticket.status).map((status) => ({ label: `Mark ${STATUS_LABEL[status]}`, icon: <StatusDot status={status} />, onSelect: () => void actions.edit({ kind: 'set-ticket-status', ticket: ticket.id, status }) })),
      ...(index > 0 ? [{ label: 'Move up', icon: <ArrowUp size={14} />, onSelect: () => void actions.edit({ kind: 'move-ticket', ticket: ticket.id, milestone: owner.id, before: owner.tickets[index - 1]?.id ?? null }) }] : []),
      ...(index < owner.tickets.length - 1 ? [{ label: 'Move down', icon: <ArrowDown size={14} />, onSelect: () => void actions.edit({ kind: 'move-ticket', ticket: ticket.id, milestone: owner.id, before: owner.tickets[index + 2]?.id ?? null }) }] : []),
      ...map.milestones
        .filter((m) => m.id !== owner.id)
        .map((m) => ({ label: `Move to ${milestoneKey(map, m)} ${m.title}`, icon: <MoveRight size={14} />, onSelect: () => void actions.edit({ kind: 'move-ticket', ticket: ticket.id, milestone: m.id, before: null }) })),
      { label: 'Remove…', icon: <Trash2 size={14} />, onSelect: () => actions.remove({ ticket: ticket.id }) }
    ])
  }

  const header = (
    <header className="map-ov-head">
      <div className="map-ov-heading">
        <h1>Milestones</h1>
        <p className="map-ov-description">Plan the work. Keep delivery status separate from agent activity.</p>
      </div>
      <div className="map-ov-actions">
        <button className="map-button" onClick={() => startInput({ kind: 'milestone' })}>
          <Plus size={13} /> Milestone
        </button>
      </div>
    </header>
  )

  if (!milestone) {
    return (
      <div className="map-scroll">
        <div className="map-page">
          {header}
          {input?.kind === 'milestone' && inlineInput('Milestone title')}
          <div className="map-card map-ov-empty">
            No milestones yet.{' '}
            <button className="map-link" onClick={actions.breakDown}>
              Break the docs down
            </button>{' '}
            or add one with + Milestone.
          </div>
        </div>
      </div>
    )
  }

  const tickets = milestone.tickets
  const done = tickets.filter((t) => t.status === 'done')
  const counts = new Map(FILTERS.map(({ filter: f }) => [f, tickets.filter((t) => matchesFilter(map, t, f, actions.terminals)).length]))
  const shown = tickets.filter((t) => matchesFilter(map, t, filter, actions.terminals) || (showDone && t.status === 'done'))
  const picked = tickets.filter((t) => selected.includes(t.id))
  const mark = marks.get(milestone.id) ?? null
  const toggle = (id: string): void => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  const launchPicked = (event: React.MouseEvent): void => {
    const [only] = picked
    if (picked.length === 1 && only) actions.launch({ ticket: only.id }, only.title, event, only)
    else actions.launch({ tickets: picked.map((t) => t.id) }, `${picked.length} tickets`, event)
  }

  return (
    <div className="map-scroll">
      <div className="map-page">
        {header}
        {input?.kind === 'milestone' && inlineInput('Milestone title')}

        <nav ref={strip} className="map-ms-strip">
          {map.milestones.map((m) => {
            const stripMark = marks.get(m.id) ?? null
            return (
              <button
                key={m.id}
                className={`map-ms-card ${m.id === milestone.id ? 'selected' : ''} ${stripMark ?? ''}`}
                title={m.title}
                onClick={() => select(m.id)}
                onContextMenu={(e) => milestoneMenu(m, e)}
              >
                <span className="map-ms-card-top">
                  <span className="map-ms-card-key">{milestoneKey(map, m)}</span>
                  {stripMark === 'done' ? <Check size={11} className="map-ms-card-mark" /> : stripMark && <span className="map-ms-card-mark">{MARK_LABEL[stripMark]}</span>}
                </span>
                <span className="map-ms-card-title">{m.title}</span>
              </button>
            )
          })}
        </nav>

        <section className="map-ms-head">
          <div className="map-ms-head-text">
            <div className="map-ms-head-title">
              {input?.kind === 'rename' ? (
                inlineInput('Milestone title', 'title')
              ) : (
                <h2 onDoubleClick={() => startInput({ kind: 'rename' }, milestone.title)}>
                  {milestoneKey(map, milestone)} · {milestone.title}
                </h2>
              )}
              {mark && <Chip tone={mark === 'current' ? 'info' : mark === 'done' ? 'done' : 'muted'}>{MARK_LABEL[mark]}</Chip>}
              <button className="icon-button" title="Edit, reorder, set status, start or remove" onClick={(e) => milestoneMenu(milestone, e)}>
                <MoreHorizontal size={14} />
              </button>
            </div>
            {input?.kind === 'description' ? (
              inlineInput('What this milestone delivers')
            ) : milestone.description ? (
              <ClampedText lines={2} className="map-ov-description" onDoubleClick={() => startInput({ kind: 'description' }, milestone.description)}>
                {milestone.description}
              </ClampedText>
            ) : (
              <button className="map-link map-ms-add-description" onClick={() => startInput({ kind: 'description' })}>
                <Plus size={11} /> Description
              </button>
            )}
          </div>
          {tickets.length > 0 && (
            <div className="map-ms-progress">
              <span>{`${done.length} of ${tickets.length} done`}</span>
              <div className="map-ov-progress">
                <span style={{ width: `${Math.round((done.length / tickets.length) * 100)}%` }} />
              </div>
            </div>
          )}
        </section>

        <div className="map-ov-grid milestones">
          <div className="map-ov-main">
            <div className="map-ms-toolbar">
              {FILTERS.map(({ filter: f, label }) => (
                <button key={f} className={`map-ms-filter ${f === filter ? 'active' : ''} ${f === 'needs-you' ? 'you' : ''}`} onClick={() => setFilter(f)}>
                  {label} <span className="map-ms-count">{counts.get(f) ?? 0}</span>
                </button>
              ))}
              <span className="grow" />
              {selecting && picked.length > 0 && (
                <button className="map-button primary" disabled={busy} onClick={launchPicked}>
                  <Play size={12} /> Launch ({picked.length})
                </button>
              )}
              <button
                className="map-button"
                onClick={() => {
                  setSelecting((s) => !s)
                  setSelected([])
                }}
              >
                {selecting ? 'Cancel' : 'Select tickets'}
              </button>
            </div>

            <div className={`map-card map-ms-table ${selecting ? 'selecting' : ''}`}>
              <div className="map-ms-row head">
                {selecting && <span />}
                <span>Ticket</span>
                <span>Work status</span>
                <span>Agent activity</span>
                <span />
              </div>
              {shown.map((ticket) => (
                <TicketRow
                  key={ticket.id}
                  map={map}
                  ticket={ticket}
                  activity={agentActivity(map, ticket, actions.terminals)}
                  selecting={selecting}
                  selected={selected.includes(ticket.id)}
                  onOpen={() => (selecting ? toggle(ticket.id) : ticket.status === 'in-review' && hasWork(map, ticket) ? actions.reviewTicket(ticket) : actions.openTicket(ticket))}
                  onToggle={() => toggle(ticket.id)}
                  onMenu={(e) => ticketMenu(ticket, milestone, e)}
                />
              ))}
              {shown.length === 0 && <div className="map-ov-empty">{emptyText(filter, tickets.length, milestoneKey(map, milestone))}</div>}
              {input?.kind === 'ticket' ? (
                inlineInput('Ticket title', 'row')
              ) : (
                <button className="map-link map-ms-add" onClick={() => startInput({ kind: 'ticket' })}>
                  <Plus size={12} /> Ticket
                </button>
              )}
            </div>
          </div>

          <aside className="map-ov-side">
            <ReadyCard map={map} milestone={milestone} actions={actions} busy={busy} />
            <AgentsCard map={map} actions={actions} busy={busy} />
            <DefinitionOfDone milestone={milestone} actions={actions} />
            {done.length > 0 && (
              <section className="map-card map-ov-side-card">
                <span className="map-ms-done-title">
                  <Check size={13} /> {done.length} {done.length === 1 ? 'ticket' : 'tickets'} done
                </span>
                <p className="map-ov-side-sub">Reviewed work is out of your way.</p>
                <div className="map-ov-side-links">
                  <button className="map-link" onClick={() => setShowDone((v) => !v)}>
                    {showDone ? 'Hide done tickets' : 'Show done tickets'} <ArrowRight size={11} />
                  </button>
                </div>
              </section>
            )}
          </aside>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  )
}

function emptyText(filter: TicketFilter, total: number, key: string): string {
  if (total === 0) return `No tickets in ${key}: an agent works on the milestone as a whole. Start it from its ⋯ menu, or add tickets.`
  if (filter === 'needs-you') return `Nothing in ${key} needs you.`
  if (filter === 'ready') return `Nothing in ${key} is ready to start.`
  return `Every ticket in ${key} is done.`
}

const ACTIVITY_CLASS: Record<AgentActivity, string> = { none: '', working: 'info', 'needs-you': 'you', paused: '', finished: 'done' }

function TicketRow(props: {
  map: MapDetail
  ticket: MapTicket
  activity: AgentActivity
  selecting: boolean
  selected: boolean
  onOpen: () => void
  onToggle: () => void
  onMenu: (event: React.MouseEvent) => void
}): React.JSX.Element {
  const { map, ticket, activity } = props
  const work = workState(map, ticket)
  const meta = ticketMeta(map, ticket)
  return (
    <div className={`map-ms-row ${ticket.status === 'done' ? 'done' : ''} ${props.selected ? 'selected' : ''}`} role="button" tabIndex={0} onClick={props.onOpen} onKeyDown={(e) => e.key === 'Enter' && props.onOpen()} onContextMenu={props.onMenu}>
      {props.selecting && <input type="checkbox" className="map-select" checked={props.selected} onClick={(e) => e.stopPropagation()} onChange={props.onToggle} />}
      <span className="map-ms-ticket">
        <span className="map-ms-ticket-title">{ticket.title}</span>
        <span className="map-ms-ticket-meta">
          {ticketKey(map, ticket)}
          {meta && ` · ${meta}`}
        </span>
      </span>
      <span>
        <Chip tone={WORK_TONE[work.status]} {...(work.reason ? { title: work.reason } : {})}>
          {WORK_LABEL[work.status]}
        </Chip>
      </span>
      <span className={`map-ms-activity ${ACTIVITY_CLASS[activity]}`}>{ACTIVITY_LABEL[activity]}</span>
      <button className="icon-button map-ms-row-more" title="More" onClick={props.onMenu}>
        <MoreHorizontal size={13} />
      </button>
    </div>
  )
}

/** The tickets that can start now, together, each after its brief is reviewed. */
function ReadyCard({ map, milestone, actions, busy }: { map: MapDetail; milestone: MapMilestoneInfo; actions: MapActions; busy: boolean }): React.JSX.Element {
  const { tickets, held } = independentTickets(map, milestone)
  const waiting = milestone.tickets.filter((t) => needsYou(map, t, actions.terminals)).length
  if (tickets.length === 0) {
    return (
      <section className="map-ms-ready empty">
        <span className="map-ms-ready-label">Ready to start</span>
        <h2>Nothing ready</h2>
        <p>{milestone.tickets.length === 0 ? 'This milestone has no tickets yet.' : waiting > 0 ? `Every open ticket is under way or held back; ${waiting} ${waiting === 1 ? 'needs' : 'need'} you.` : 'Every open ticket is under way or held back.'}</p>
      </section>
    )
  }
  const one = tickets.length === 1
  return (
    <section className="map-ms-ready">
      <span className="map-ms-ready-label">Ready to start</span>
      <h2>{one ? '1 ticket ready' : `${tickets.length} independent tickets`}</h2>
      <p>
        {held.length > 0 ? `${held.length} more ${held.length === 1 ? 'shares' : 'share'} a doc section with these; start ${held.length === 1 ? 'it' : 'them'} after.` : one ? 'No dependencies left.' : 'No shared dependencies detected.'}{' '}
        {one ? 'It gets its own worktree and a focused context brief.' : 'Each agent gets its own worktree and a focused context brief.'}
      </p>
      <button className="map-button primary large" disabled={busy} title={tickets.map((t) => ticketKey(map, t)).join(', ')} onClick={(e) => actions.startReady(tickets, e)}>
        {one ? 'Review the brief' : `Review ${tickets.length} briefs`} <ArrowRight size={13} />
      </button>
    </section>
  )
}

/** The milestone's definition of done: tick, edit, add and remove items in place. */
function DefinitionOfDone({ milestone, actions }: { milestone: MapMilestoneInfo; actions: MapActions }): React.JSX.Element {
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [text, setText] = useState('')
  const items = milestone.doneWhen
  const save = (next: DoneItem[]): void => void actions.edit({ kind: 'update-milestone', milestone: milestone.id, doneWhen: next })

  const commit = (): void => {
    const value = text.trim()
    const at = editing
    setEditing(null)
    if (at === 'new') {
      if (value) save([...items, { text: value, done: false }])
    } else if (at !== null && value !== items[at]?.text) {
      save(value ? items.map((item, i) => (i === at ? { ...item, text: value } : item)) : items.filter((_, i) => i !== at))
    }
  }

  const field = (
    <form
      className="map-ms-dod-form"
      onSubmit={(e) => {
        e.preventDefault()
        commit()
      }}
    >
      <input autoFocus value={text} placeholder="Something that has to be true" onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
    </form>
  )

  return (
    <section className="map-card map-ov-side-card map-ms-dod">
      <h2>Definition of done</h2>
      {items.length === 0 && editing !== 'new' && <p className="map-ov-side-sub">What has to be true before this milestone is done?</p>}
      {items.map((item, index) => (
        <div key={`${index}:${item.text}`} className={`map-ms-dod-item ${item.done ? 'met' : ''}`}>
          <button className="map-ms-dod-tick" title={item.done ? 'Untick' : 'Tick: this holds'} onClick={() => save(items.map((x, i) => (i === index ? { ...x, done: !x.done } : x)))}>
            {item.done ? <CircleCheck size={13} /> : <Circle size={13} />}
          </button>
          {editing === index ? (
            field
          ) : (
            <span
              className="map-ms-dod-text"
              title="Click to edit"
              onClick={() => {
                setEditing(index)
                setText(item.text)
              }}
            >
              {item.text}
            </span>
          )}
          <button className="icon-button map-ms-dod-remove" title="Remove" onClick={() => save(items.filter((_, i) => i !== index))}>
            <X size={12} />
          </button>
        </div>
      ))}
      {editing === 'new' && <div className="map-ms-dod-item">{field}</div>}
      <div className="map-ov-side-links">
        <button
          className="map-link"
          onClick={() => {
            setEditing('new')
            setText('')
          }}
        >
          <Plus size={11} /> Add item
        </button>
      </div>
    </section>
  )
}
