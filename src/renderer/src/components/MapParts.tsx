import { ChevronRight, Play } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { LaunchMode, MapDetail, MapMilestoneInfo, MapTicket } from '../../../shared/ipc'
import type { UpNext } from '../lib/mapUpNext'
import { STATUS_LABEL } from '../lib/mapUpNext'

/** The one primary action a map screen leads with. */
export function UpNextBlock({ next, busy, onAct }: { next: UpNext | null; busy?: boolean; onAct: (next: UpNext, event: React.MouseEvent) => void }): React.JSX.Element | null {
  if (!next) return null
  return (
    <section className="map-up-next">
      <div className="map-up-next-label">Up next</div>
      <div className="map-up-next-body">
        <span className="map-up-next-sentence">{next.sentence}</span>
        <button className="primary-button accent" disabled={busy} onClick={(e) => onAct(next, e)}>
          {next.action.kind === 'start-ticket' || next.action.kind === 'start-milestone' || next.action.kind === 'start-ready' ? <Play size={13} /> : null}
          {next.button}
        </button>
      </div>
    </section>
  )
}

/** Text cut to a few lines, with More / Less when it doesn't fit. */
export function ClampedText({ lines, className, children, onDoubleClick }: { lines: number; className?: string; children: React.ReactNode; onDoubleClick?: () => void }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || open) return
    const measure = (): void => {
      setOverflows(element.scrollHeight > element.clientHeight + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [children, open])

  return (
    <div className={`map-clamp-wrap ${className ?? ''}`}>
      <div ref={ref} className={`map-clamp ${open ? 'open' : ''}`} style={{ '--lines': lines }} onDoubleClick={onDoubleClick}>
        {children}
      </div>
      {(open || overflows) && (
        <button className="map-link map-clamp-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  )
}

/** Cancels a ticket with an optional reason: Enter or the button confirms, Escape or Keep it backs out. */
export function CancelTicketForm({ title, onCancel, onClose }: { title: string; onCancel: (reason: string) => void; onClose: () => void }): React.JSX.Element {
  const [reason, setReason] = useState('')
  return (
    <form
      className="map-cancel-form"
      onSubmit={(e) => {
        e.preventDefault()
        onCancel(reason.trim())
        onClose()
      }}
    >
      <span className="map-cancel-title">Cancel “{title}”</span>
      <input
        autoFocus
        className="map-select-field"
        value={reason}
        placeholder="Why? (optional)"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          onClose()
        }}
      />
      <span className="map-cancel-actions">
        <button type="button" className="map-link" onClick={onClose}>
          Keep it
        </button>
        <button type="submit" className="map-button">
          Cancel ticket
        </button>
      </span>
    </form>
  )
}

/** An on/off option: a switch with its label beside it. */
export function Switch({ checked, onChange, children, className }: { checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <label className={`map-switch ${className ?? ''}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="map-ac-switch" />
      <span>{children}</span>
    </label>
  )
}

/** A small coloured dot for a ticket's or milestone's status. */
export function StatusDot({ status, title }: { status: MapTicket['status'] | MapMilestoneInfo['status']; title?: string }): React.JSX.Element {
  return <span className={`map-dot status-${status}`} title={title ?? STATUS_LABEL[status]} />
}

/** Where a launch popover opens, and what it starts. */
export interface LaunchTarget {
  x: number
  y: number
  title: string
  scope: { ticket: string } | { tickets: string[] } | { milestone: string }
  /** Code project roots to pick from; empty when the launch can work it out. */
  projects: { root: string; name: string }[]
  /**
   * The worktree mode it starts with: the map's default unless another session would share the worktree.
   * For a group, 'ticket' is a worktree and session per ticket and 'milestone' is one for them all.
   */
  mode: LaunchMode
  /** Things to know before starting: unmet dependencies, a crowded worktree. */
  notes: string[]
}

/**
 * The launch confirmation: a small popover with the map's default worktree mode (per ticket or per
 * milestone; for a group, one each or one for all) and, when it's ambiguous, the code project. Enter
 * starts it; Escape or a click outside cancels.
 */
export function LaunchPopover({ target, defaultMode, onLaunch, onClose }: { target: LaunchTarget; defaultMode: LaunchMode; onLaunch: (mode: LaunchMode, project: string | null) => void; onClose: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<LaunchMode>(defaultMode)
  const [project, setProject] = useState<string | null>(target.projects[0]?.root ?? null)
  const box = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && !box.current?.contains(event.target)) onClose()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onClose])
  const ticket = 'ticket' in target.scope
  const group = 'tickets' in target.scope ? target.scope.tickets.length : 0
  const left = Math.min(target.x, window.innerWidth - 300)
  const top = Math.min(target.y + 8, window.innerHeight - 200)
  return (
    <form
      ref={box}
      tabIndex={-1}
      className="map-launch-popover"
      style={{ left, top }}
      onSubmit={(e) => {
        e.preventDefault()
        onLaunch(ticket || group > 0 ? mode : 'milestone', project)
      }}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
    >
      <div className="map-launch-title">Start “{target.title}”</div>
      {target.notes.map((note) => (
        <div key={note} className="map-launch-note">
          {note}
        </div>
      ))}
      {ticket && (
        <div className="map-launch-modes">
          <label>
            <input type="radio" checked={mode === 'ticket'} onChange={() => setMode('ticket')} /> Own worktree
          </label>
          <label>
            <input type="radio" checked={mode === 'milestone'} onChange={() => setMode('milestone')} /> Milestone’s worktree
          </label>
        </div>
      )}
      {group > 0 && (
        <div className="map-launch-modes">
          <label>
            <input type="radio" checked={mode === 'ticket'} onChange={() => setMode('ticket')} /> A worktree and session each ({group})
          </label>
          <label>
            <input type="radio" checked={mode === 'milestone'} onChange={() => setMode('milestone')} /> One worktree and session for all
          </label>
        </div>
      )}
      {target.projects.length > 1 && (
        <select value={project ?? ''} onChange={(e) => setProject(e.target.value)}>
          {target.projects.map((p) => (
            <option key={p.root} value={p.root}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <div className="map-launch-actions">
        <span className="muted-row">{group > 0 && mode === 'ticket' ? `${group} worktrees, branches and Claude sessions.` : 'A worktree, a branch and a Claude session.'}</span>
        <button type="submit" className="primary-button accent small" autoFocus>
          <Play size={12} /> {group > 0 && mode === 'ticket' ? `Start ${group}` : 'Start'}
        </button>
      </div>
    </form>
  )
}

/** The code projects a launch could use, when it needs asking: several on the map (or in Manta, with none on the map), and the ticket names none. */
export function launchProjects(map: MapDetail, codeProjects: readonly { root: string; name: string }[], ticket: MapTicket | null): { root: string; name: string }[] {
  if (ticket?.project && codeProjects.some((p) => p.name === ticket.project)) return []
  const candidates = map.projects.length > 0 ? codeProjects.filter((p) => map.projects.includes(p.name)) : [...codeProjects]
  return candidates.length > 1 ? candidates : []
}
