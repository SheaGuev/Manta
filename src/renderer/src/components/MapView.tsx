import { MoreHorizontal, Pencil, Pin, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DocRef, LaunchMode, MapDetail, MapDocProposal, MapDocsEdit, MapLaunch, MapTicket, OpResult, TerminalInfo, ThreadInfo, TrackerEdit } from '../../../shared/ipc'
import { useMapDetail } from '../lib/hooks'
import type { ActivityFilter } from '../lib/mapActivity'
import { milestoneKey, ticketKey, waitingOn } from '../lib/mapStatus'
import { ticketSession, type ReviewItem, type UpNext } from '../lib/mapUpNext'
import { currentOf } from '../lib/mapUpNext'
import { AddMapDocDialog } from './AddMapDocDialog'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { MapAsk } from './MapAsk'
import { MapActivity } from './MapActivity'
import { MapBrief, type BriefStart } from './MapBrief'
import { MapDecisions, type DecisionSelection } from './MapDecisions'
import { MapDocs } from './MapDocs'
import { MapMilestones } from './MapMilestones'
import { MapOverview } from './MapOverview'
import { MapReview } from './MapReview'
import { launchProjects, LaunchPopover, type LaunchTarget } from './MapParts'
import { MapTicketView } from './MapTicket'

const api = window.manta

/** The pages of a map, inside its one tab: the Overview (`home`), its plan, docs, decisions, activity, Ask the map, a ticket, the agent brief before a start, and the review of a ticket's work. */
export type MapScreen = 'home' | 'docs' | 'milestones' | 'decisions' | 'ask' | 'ticket' | 'activity' | 'brief' | 'review'

/** The map's own navigation, in the order the bar shows it. */
const NAV: readonly { screen: MapScreen; label: string }[] = [
  { screen: 'home', label: 'Overview' },
  { screen: 'milestones', label: 'Milestones' },
  { screen: 'docs', label: 'Docs' },
  { screen: 'decisions', label: 'Decisions' },
  { screen: 'activity', label: 'Activity' }
]

interface MapPage {
  screen: MapScreen
  ticket: string | null
  decision: DecisionSelection
  /** The nav item lit while on a page the bar doesn't list (a ticket): where it was opened from. */
  from: MapScreen
  /** On the brief page: the tickets to start, one brief each, and the page to go back to. */
  brief: { tickets: string[]; back: MapPage } | null
  /** The milestone selected on Milestones; null for the current one. */
  milestone: string | null
  /** On the review page: the page to go back to (the ticket is `ticket`). */
  back: MapPage | null
  /** On Ask the map: a question to start the draft with. */
  ask?: string
  /** On Docs: the doc open in the reader; null for the first listed. */
  doc?: string | null
  /** On Activity: the filter it opens with. */
  activity?: ActivityFilter
}

/** A first guess at a new terminal's size; its view fits it to the pane as soon as it mounts. */
const TERMINAL_SIZE = { cols: 100, rows: 30 }

/** A batch id like core's (`b_` and hex), made here since launches in a batch start one by one from the renderer. */
function newBatchId(): string {
  return `b_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
}

interface Point {
  x: number
  y: number
}

/** Under the button that asked, so a keyboard press (no pointer position) places it too. */
function anchor(event: React.MouseEvent): Point {
  const rect = event.currentTarget instanceof Element ? event.currentTarget.getBoundingClientRect() : null
  return rect ? { x: Math.max(8, rect.right - 290), y: rect.bottom } : { x: event.clientX, y: event.clientY }
}

/** What every map screen can do, wired once here. */
export interface MapActions {
  docsRoot: string
  terminals: readonly TerminalInfo[]
  act: (next: UpNext, event: React.MouseEvent) => void
  /** A ticket opens its brief; a group or a milestone opens the launch popover at the click. */
  launch: (scope: LaunchTarget['scope'], title: string, event: React.MouseEvent, ticket?: MapTicket) => void
  /** Opens the tickets' briefs one after another, to start them together. */
  startReady: (tickets: readonly MapTicket[], event: React.MouseEvent) => void
  /** The review page of a ticket's work. */
  reviewTicket: (ticket: MapTicket) => void
  /** Marks a ticket done after review, approving the doc updates (thread ids) included. */
  markDone: (ticket: MapTicket, include: string[]) => Promise<boolean>
  /** Sends the user's requested changes to the launch's session. */
  requestChanges: (launch: MapLaunch, text: string) => Promise<boolean>
  openSession: (launch: MapLaunch, terminal: string | null) => void
  /** Opens the batch's coordinator session, starting or resuming it as needed. */
  coordinate: (batch: string) => void
  declineCoordinator: (batch: string) => void
  openTicket: (ticket: MapTicket) => void
  openScreen: (screen: MapScreen) => void
  /** Ask the map, with a question already in the box for the user to finish or send. */
  askAbout: (draft: string) => void
  /** The Decisions page at one decision, the form for a new one, or the newest. */
  openDecision: (selection: DecisionSelection) => void
  /** Opens a doc in the editor, or a link doc in the browser. */
  openDoc: (doc: DocRef | string) => void
  /** The Docs page with the doc open in its reader. */
  openDocs: (path: string | null) => void
  /** The Milestones page with the milestone selected. */
  openMilestone: (id: string) => void
  /** The Activity page, filtered. */
  openActivity: (filter: ActivityFilter) => void
  /** Marks everything on Activity as seen. */
  markSeen: () => void
  openProposal: (proposal: MapDocProposal) => void
  review: (item: ReviewItem) => void
  edit: (edit: TrackerEdit) => Promise<boolean>
  editDocs: (edit: MapDocsEdit) => Promise<boolean>
  remove: (target: { ticket: string } | { milestone: string }) => void
  resolve: (suggestion: string, accept: boolean, pick?: number[] | null) => void
  pin: (milestone: string | null) => void
  breakDown: () => void
  writeDoc: (milestones?: string[]) => void
  addExistingDoc: () => void
  editMap: () => void
  removeMap: () => void
  report: (error: unknown) => void
}

interface MapViewProps {
  docsRoot: string
  id: string
  screen: MapScreen
  ticket: string | null
  terminals: TerminalInfo[]
  codeProjects: { root: string; name: string }[]
  /** Every markdown file in the docs repo, for Add existing doc. */
  docFiles: readonly string[]
  /** Opens the doc at a heading when given. */
  onOpenDoc: (relPath: string, heading?: string | null) => void
  onOpenThread: (thread: ThreadInfo) => void
  /** Opens a launch's session in its worktree's context; `focus` switches there. */
  onOpenSession: (terminal: TerminalInfo, launch: MapLaunch | null, focus: boolean) => void
  /** Opens a session of the map itself (a coordinator) in the map's context. */
  onOpenMapSession: (terminal: TerminalInfo) => void
  onEditMap: (map: MapDetail) => void
  onRemoved: () => void
  onMessage: (text: string, error: boolean) => void
}

/**
 * A context map's tab: its navigation bar (Overview, Milestones, Docs, Decisions, Activity, Ask the
 * map) and the page it's on, a ticket included. Loads the map once and wires the actions every page
 * shares: launching, opening sessions and docs, hand edits, and what needs review.
 */
export function MapView(props: MapViewProps): React.JSX.Element {
  const { docsRoot, id, terminals, onMessage } = props
  const { map, reload, error } = useMapDetail(docsRoot, id, terminals)
  useEffect(() => {
    api.visitMap(docsRoot, id).then(reload, (e: unknown) => console.error('manta: recording a map visit', e))
  }, [docsRoot, id, reload])
  const [launchTarget, setLaunchTarget] = useState<LaunchTarget | null>(null)
  const [busy, setBusy] = useState(false)
  const [addDoc, setAddDoc] = useState<{ mode: 'new' | 'existing'; milestones: string[] } | null>(null)
  const [page, setPage] = useState<MapPage>({ screen: props.screen === 'brief' ? 'home' : props.screen, ticket: props.ticket, decision: null, from: 'home', brief: null, milestone: null, back: null })
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const go = (screen: MapScreen, extra: Partial<MapPage> = {}): void => setPage((p) => ({ screen, ticket: null, decision: null, from: NAV.some((n) => n.screen === p.screen) ? p.screen : p.from, brief: null, milestone: null, back: null, ...extra }))
  const openBriefs = (tickets: string[]): void => setPage((p) => ({ screen: 'brief', ticket: null, decision: null, from: NAV.some((n) => n.screen === p.screen) ? p.screen : p.from, brief: { tickets, back: p }, milestone: null, back: null }))

  const report = useCallback((e: unknown) => onMessage(e instanceof Error ? e.message : String(e), true), [onMessage])
  const result = useCallback(
    (r: OpResult): boolean => {
      if (!r.ok) onMessage(r.message, true)
      reload()
      return r.ok
    },
    [onMessage, reload]
  )

  if (!map) return <div className="map-view">{error && <div className="empty-state"><p>{error}</p></div>}</div>

  const done = (r: OpResult): void => {
    onMessage(r.message, !r.ok)
    reload()
  }

  /**
   * Starts each ticket in its own session, one after another, as its brief set it up. One that
   * fails stops the run with what went wrong; the rest are left to their own Start. Returns whether
   * all started.
   */
  const startEach = async (starts: readonly BriefStart[]): Promise<boolean> => {
    setBusy(true)
    /** Several started together are a batch: the Board groups them and offers a coordinator. */
    const batch = starts.length > 1 ? newBatchId() : null
    try {
      for (const { ticket, mode, project, note } of starts) {
        const started = await api.launchMapWork({ docsRoot, map: id, scope: { ticket: ticket.id }, mode, project, batch, ...(note.trim() ? { note } : {}), ...TERMINAL_SIZE })
        if (started.ok) {
          props.onOpenSession(started.terminal, started.launch, starts.length === 1)
          continue
        }
        onMessage(started.projects && started.projects.length > 0 ? `Pick the code project for “${ticket.title}” on its brief` : started.message, true)
        return false
      }
      onMessage(starts.length === 1 ? `Started “${starts[0]?.ticket.title ?? ''}”` : `Started ${starts.length} tickets`, false)
      return true
    } catch (e) {
      report(e)
      return false
    } finally {
      setBusy(false)
      reload()
    }
  }

  const startLaunch = (target: LaunchTarget, mode: LaunchMode, project: string | null): void => {
    setLaunchTarget(null)
    if ('tickets' in target.scope && mode === 'ticket') {
      const ids = target.scope.tickets
      const starts = map.milestones.flatMap((m) => m.tickets).filter((t) => ids.includes(t.id)).map((ticket): BriefStart => ({ ticket, mode: 'ticket', project, note: '' }))
      void startEach(starts).then((ok) => ok && starts.length > 1 && go('activity', { activity: 'agents' }))
      return
    }
    setBusy(true)
    api
      .launchMapWork({ docsRoot, map: id, scope: target.scope, mode, project, ...TERMINAL_SIZE })
      .then((started) => {
        if (started.ok) {
          props.onOpenSession(started.terminal, started.launch, true)
          onMessage(started.message, false)
        } else if (started.projects && started.projects.length > 0) {
          setLaunchTarget({ ...target, projects: props.codeProjects.filter((p) => started.projects?.includes(p.root)) })
        } else onMessage(started.message, true)
        reload()
      })
      .catch(report)
      .finally(() => setBusy(false))
  }

  /** A session already working in the ticket's milestone worktree would share its files and index with this one. */
  const crowdedFor = (ticket: MapTicket): boolean => {
    const milestone = map.milestones.find((m) => m.tickets.some((t) => t.id === ticket.id))
    return map.launchMode === 'milestone' && map.launches.some((l) => 'milestone' in l.scope && l.scope.milestone === milestone?.id && !l.landed && l.sessions.some((s) => terminals.some((t) => t.id === s.terminal && t.state !== 'exited')))
  }

  /** The launch popover at `at` for a group or a milestone, with what to know before starting. */
  const ask = (scope: LaunchTarget['scope'], title: string, at: Point, ticket?: MapTicket): void => {
    const waits = ticket ? waitingOn(map, ticket) : []
    const crowded = ticket !== undefined && crowdedFor(ticket)
    const notes = [
      ...(waits.length > 0 ? [`It waits for ${waits.map((t) => `“${t.title}”`).join(', ')}, not done yet.`] : []),
      ...(crowded ? ['A session is already working in the milestone’s worktree; its own worktree keeps them apart.'] : [])
    ]
    setLaunchTarget({ ...at, title, scope, projects: launchProjects(map, props.codeProjects, ticket ?? null), mode: crowded ? 'ticket' : map.launchMode, notes })
  }

  const actions: MapActions = {
    docsRoot,
    terminals,
    report,
    act: (next, event) => {
      const action = next.action
      if (action.kind === 'review') actions.review(action.item)
      else if (action.kind === 'open-session') actions.openSession(action.launch, action.terminal)
      else if (action.kind === 'start-ticket') actions.launch({ ticket: action.ticket.id }, action.ticket.title, event, action.ticket)
      else if (action.kind === 'start-ready') actions.startReady(action.tickets, event)
      else if (action.kind === 'start-milestone') actions.launch({ milestone: action.milestone.id }, action.milestone.title, event)
      else if (action.kind === 'review-pr') window.open(action.pr.url, '_blank')
      else if (action.kind === 'open-doc') actions.openDoc(action.doc.path)
      else if (action.kind === 'break-down') actions.breakDown()
      else actions.writeDoc(map.current ? [map.current.id] : [])
    },
    launch: (scope, title, event, ticket) => ('ticket' in scope ? openBriefs([scope.ticket]) : ask(scope, title, anchor(event), ticket)),
    startReady: (tickets) => openBriefs(tickets.map((t) => t.id)),
    reviewTicket: (ticket) => setPage((p) => ({ screen: 'review', ticket: ticket.id, decision: null, from: NAV.some((n) => n.screen === p.screen) ? p.screen : p.from, brief: null, milestone: null, back: p })),
    markDone: (ticket, include) => {
      setBusy(true)
      return api
        .markMapTicketDone(docsRoot, id, ticket.id, include)
        .then((r) => {
          if (r.ok) onMessage(r.message, false)
          return result(r)
        })
        .catch((e: unknown) => (report(e), false))
        .finally(() => setBusy(false))
    },
    requestChanges: (launch, text) => {
      setBusy(true)
      return api
        .requestMapChanges(docsRoot, id, launch.id, text, TERMINAL_SIZE.cols, TERMINAL_SIZE.rows)
        .then((r) => {
          if (r.ok) {
            onMessage(r.message, false)
            actions.openSession(launch, null)
          }
          return result(r)
        })
        .catch((e: unknown) => (report(e), false))
        .finally(() => setBusy(false))
    },
    openSession: (launch, terminal) =>
      void api
        .openMapLaunch(docsRoot, id, launch.id, terminal, TERMINAL_SIZE.cols, TERMINAL_SIZE.rows)
        .then((info) => props.onOpenSession(info, launch, true))
        .catch(report),
    coordinate: (batch) => {
      setBusy(true)
      api
        .coordinateMapBatch(docsRoot, id, batch, TERMINAL_SIZE.cols, TERMINAL_SIZE.rows)
        .then((terminal) => {
          props.onOpenMapSession(terminal)
          reload()
        })
        .catch(report)
        .finally(() => setBusy(false))
    },
    declineCoordinator: (batch) => void api.declineMapBatch(docsRoot, id, batch).then(reload).catch(report),
    openTicket: (ticket) => go('ticket', { ticket: ticket.id }),
    openScreen: (screen) => go(screen),
    askAbout: (draft) => go('ask', { ask: draft }),
    openDecision: (selection) => go('decisions', { decision: selection }),
    openDoc: (doc) => {
      const ref = typeof doc === 'string' ? { path: doc, heading: null } : doc
      const link = map.docs.find((d) => d.path === ref.path)?.link
      if (link) window.open(link.url, '_blank')
      else props.onOpenDoc(ref.path, ref.heading)
    },
    openDocs: (path) => go('docs', { doc: path }),
    openMilestone: (milestone) => go('milestones', { milestone }),
    openActivity: (activity) => go('activity', { activity }),
    markSeen: () => void api.markMapSeen(docsRoot, id).then(reload).catch(report),
    openProposal: (proposal) =>
      void api
        .getThread(docsRoot, proposal.doc, proposal.thread)
        .then((thread) => (thread ? props.onOpenThread(thread) : onMessage('That proposal is gone', true)))
        .catch(report),
    review: (item) => {
      if (item.kind === 'proposal') actions.openProposal(item.proposal)
      else if (item.kind === 'suggestion') go('home')
      else if (item.kind === 'pr') window.open(item.pr.url, '_blank')
      else if (item.kind === 'waiting') actions.openSession(item.launch, item.terminal.id)
      else if (item.kind === 'ready') void api.openMapPullRequest(docsRoot, id, item.launch.id).then(done).catch(report)
      else if (item.kind === 'checks' || item.kind === 'changes')
        void api
          .sendMapFeedback(docsRoot, id, item.launch.id, item.kind === 'checks' ? 'checks' : 'review', TERMINAL_SIZE.cols, TERMINAL_SIZE.rows)
          .then((r) => {
            done(r)
            if (r.ok) actions.openSession(item.launch, null)
          })
          .catch(report)
      else {
        const session = ticketSession(map, item.ticket.id, terminals)
        if (session) actions.openSession(session.launch, session.terminal)
        else actions.openTicket(item.ticket)
      }
    },
    edit: (edit) => api.editMapTracker(docsRoot, id, edit).then(result).catch((e: unknown) => (report(e), false)),
    editDocs: (edit) => api.editMapDocs(docsRoot, id, edit).then(result).catch((e: unknown) => (report(e), false)),
    remove: (target) =>
      void api
        .removeFromTracker(docsRoot, id, target)
        .then((r) => r && result(r))
        .catch(report),
    resolve: (suggestion, accept, pick = null) =>
      void api
        .resolveMapSuggestion(docsRoot, id, suggestion, accept, pick)
        .then((r) => {
          if (r.ok) onMessage(r.message, false)
          if (r.ok && r.doc) props.onOpenDoc(r.doc)
          result(r)
        })
        .catch(report),
    pin: (milestone) =>
      void api
        .updateMap(docsRoot, id, { pinned: milestone })
        .then(reload)
        .catch(report),
    breakDown: () => {
      go('ask')
      void api
        .breakDownMap(docsRoot, id, map.docs.filter((d) => d.exists && !d.link).map((d) => d.path))
        .then((r) => {
          if (r.ok) onMessage('Proposed plans wait in Needs review, on the Overview', false)
          result(r)
        })
        .catch(report)
    },
    writeDoc: (milestones = []) => setAddDoc({ mode: 'new', milestones }),
    addExistingDoc: () => setAddDoc({ mode: 'existing', milestones: map.current ? [map.current.id] : [] }),
    editMap: () => props.onEditMap(map),
    removeMap: () =>
      void api
        .removeMap(docsRoot, id)
        .then((r) => r?.ok && props.onRemoved())
        .catch(report)
  }

  const ticket = page.ticket ? map.milestones.flatMap((m) => m.tickets).find((t) => t.id === page.ticket) : undefined
  const current = currentOf(map)
  const menuItems: MenuItem[] = [
    { label: 'Edit map and settings…', icon: <Pencil size={14} />, onSelect: actions.editMap },
    { label: 'Break down into milestones', icon: <Sparkles size={14} />, onSelect: actions.breakDown },
    ...(map.pinned ? [{ label: 'Unpin the current milestone', icon: <Pin size={14} />, onSelect: () => actions.pin(null) }] : []),
    ...map.milestones
      .filter((m) => m.id !== current?.id)
      .slice(0, 6)
      .map((m) => ({ label: `Make “${m.title}” current`, icon: <Pin size={14} />, onSelect: () => actions.pin(m.id) })),
    { label: 'Remove map…', icon: <Trash2 size={14} />, onSelect: actions.removeMap }
  ]
  const lit = NAV.some((n) => n.screen === page.screen) ? page.screen : page.screen === 'ask' ? null : page.from

  return (
    <div className="map-view">
      <nav className="map-nav">
        {NAV.map((item) => (
          <button key={item.screen} className={`map-nav-item ${lit === item.screen ? 'active' : ''}`} onClick={() => go(item.screen)}>
            {item.label}
          </button>
        ))}
        <span className="grow" />
        <button className={`map-nav-ask ${page.screen === 'ask' ? 'active' : ''}`} onClick={() => go('ask')}>
          Ask the map
        </button>
        <button className="icon-button" title="The map’s settings and more" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}>
          <MoreHorizontal size={14} />
        </button>
      </nav>
      <div className="map-page-body">
      {page.screen === 'home' && <MapOverview map={map} actions={actions} busy={busy} />}
      {page.screen === 'docs' && <MapDocs map={map} actions={actions} selected={page.doc ?? null} onSelect={(doc) => setPage((p) => ({ ...p, doc }))} />}
      {page.screen === 'milestones' && <MapMilestones map={map} actions={actions} busy={busy} selected={page.milestone} onSelect={(milestone) => setPage((p) => ({ ...p, milestone }))} />}
      {page.screen === 'decisions' && <MapDecisions map={map} actions={actions} selected={page.decision} onSelect={(decision) => setPage((p) => ({ ...p, decision }))} />}
      {page.screen === 'activity' && <MapActivity key={page.activity ?? 'all'} map={map} actions={actions} busy={busy} filter={page.activity ?? 'all'} />}
      {page.screen === 'review' &&
        (ticket ? (
          <MapReview map={map} ticket={ticket} back={page.back ? backLabel(map, page.back) : 'Back'} actions={actions} busy={busy} onBack={() => setPage(page.back ?? { ...page, screen: 'home', ticket: null })} />
        ) : (
          <div className="empty-state">
            <h2>Ticket removed</h2>
            <p>This ticket is no longer on the map.</p>
          </div>
        ))}
      {page.screen === 'brief' && page.brief && (
        <MapBrief
          map={map}
          tickets={page.brief.tickets}
          back={backLabel(map, page.brief.back)}
          actions={actions}
          busy={busy}
          codeProjects={props.codeProjects}
          defaultMode={(t) => (crowdedFor(t) ? 'ticket' : map.launchMode)}
          onBack={() => setPage(page.brief?.back ?? page)}
          onStart={(starts) => {
            const back = page.brief?.back
            void startEach(starts).then((ok) => {
              if (!ok) return
              if (starts.length > 1) go('activity', { activity: 'agents' })
              else if (back) setPage(back)
            })
          }}
        />
      )}
      {page.screen === 'ask' && <MapAsk key={page.ask ?? ''} map={map} actions={actions} draft={page.ask ?? ''} onReload={reload} />}
      {page.screen === 'ticket' &&
        (ticket ? (
          <MapTicketView map={map} ticket={ticket} actions={actions} busy={busy} codeProjects={props.codeProjects} />
        ) : (
          <div className="empty-state">
            <h2>Ticket removed</h2>
            <p>This ticket is no longer on the map.</p>
          </div>
        ))}
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
      {launchTarget && <LaunchPopover target={launchTarget} defaultMode={launchTarget.mode} onClose={() => setLaunchTarget(null)} onLaunch={(mode, project) => startLaunch(launchTarget, mode, project)} />}
      {addDoc && (
        <AddMapDocDialog
          docsRoot={docsRoot}
          map={map}
          mode={addDoc.mode}
          milestones={addDoc.milestones}
          docFiles={props.docFiles}
          onClose={() => setAddDoc(null)}
          onDone={(path, brainstorm) => {
            setAddDoc(null)
            reload()
            if (!path) return
            if (!brainstorm) return props.onOpenDoc(path)
            void api
              .createThread(docsRoot, path, 0, 'Brainstorm')
              .then((thread) => {
                props.onOpenDoc(path)
                props.onOpenThread(thread)
              })
              .catch(report)
          }}
          onError={(message) => onMessage(message, true)}
        />
      )}
    </div>
  )
}

/** "Back to M8": where the brief page returns to, by what that page shows. */
function backLabel(map: MapDetail, page: MapPage): string {
  if (page.screen === 'ticket') {
    const ticket = map.milestones.flatMap((m) => m.tickets).find((t) => t.id === page.ticket)
    return ticket ? `Back to ${ticketKey(map, ticket)}` : 'Back'
  }
  if (page.screen === 'milestones') {
    const shown = map.milestones.find((m) => m.id === page.milestone) ?? currentOf(map)
    return shown ? `Back to ${milestoneKey(map, shown)}` : 'Back to Milestones'
  }
  return `Back to ${NAV.find((n) => n.screen === page.screen)?.label ?? 'the map'}`
}
