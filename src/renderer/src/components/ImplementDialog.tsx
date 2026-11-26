import { useEffect, useState } from 'react'
import type { ImplementationRequest, ImplementationStart, MapDetail, MapLaunch, MapSummary, Project, ProjectWorktree, TerminalInfo } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'

const api = window.manta

export const DEFAULT_IMPLEMENT_PROMPT = 'Implement the doc section in your brief. Start with a short plan before changing code.'

const NEW_WORKTREE = ''
const LAST_PROJECT_KEY = 'manta.implement-project'

interface ImplementDialogProps {
  docsRoot: string
  doc: string
  from: ImplementationRequest['from']
  /** The default thread title: the section's heading, or the source thread's title. */
  title: string
  projects: Project[]
  /** The size the session's terminal starts at, before its tab fits it. */
  size: { cols: number; rows: number }
  /** The docs repo's context maps: one that lists the doc can take the work as a ticket instead. */
  maps: readonly MapSummary[]
  onClose: () => void
  onStarted: (started: Extract<ImplementationStart, { ok: true }>) => void
  /** Started as a ticket on a map: its session's terminal. */
  onStartedTicket: (started: { launch: MapLaunch; terminal: TerminalInfo }, message: string) => void
}

/** No map: an implementation thread on the section. */
const AS_THREAD = ''

/**
 * Starts an implementation thread: which code project, a new worktree or an existing one, and the
 * first prompt the Claude session gets. When a context map lists the doc, the work can go on the map
 * as a ticket of its current milestone instead, launched from there (so its status, journal and pull
 * request show on the map). Enter in a field starts it; Escape or a click outside cancels.
 */
export function ImplementDialog({ docsRoot, doc, from, title, projects, size, maps, onClose, onStarted, onStartedTicket }: ImplementDialogProps): React.JSX.Element {
  const code = projects.filter((p) => p.kind === 'code')
  const remembered = localStorage.getItem(LAST_PROJECT_KEY)
  const [project, setProject] = useState(code.find((p) => p.root === remembered)?.root ?? code[0]?.root ?? '')
  const [worktrees, setWorktrees] = useState<ProjectWorktree[]>([])
  const [worktree, setWorktree] = useState(NEW_WORKTREE)
  const [threadTitle, setThreadTitle] = useState(title)
  /** Follows the title until edited. */
  const [name, setName] = useState<string | null>(null)
  const [prompt, setPrompt] = useState(DEFAULT_IMPLEMENT_PROMPT)
  const [error, setError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [onMaps, setOnMaps] = useState<MapDetail[]>([])
  const [asTicket, setAsTicket] = useState(AS_THREAD)
  const chosenMap = onMaps.find((m) => m.id === asTicket) ?? null

  /** A key rather than the list, so a list rebuilt each render doesn't refetch every map each render. */
  const mapIds = maps.map((m) => m.id).join(',')
  useEffect(() => {
    let live = true
    Promise.all((mapIds ? mapIds.split(',') : []).map((id) => api.getMap(docsRoot, id).catch(() => null)))
      .then((details) => {
        if (!live) return
        const listing = details.flatMap((d) => (d && d.docs.some((entry) => entry.path === doc) && d.current ? [d] : []))
        setOnMaps(listing)
        setAsTicket(listing[0]?.id ?? AS_THREAD)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [docsRoot, doc, mapIds])

  useEffect(() => {
    setWorktree(NEW_WORKTREE)
    if (!project) return
    api
      .listWorktrees(project)
      .then(setWorktrees)
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
  }, [project])

  /** A ticket in the map's current milestone, linked to the section, then launched like any ticket. */
  const startTicket = async (map: MapDetail): Promise<void> => {
    const milestone = map.current?.id
    if (!milestone) throw new Error(`“${map.title}” has no current milestone to add the ticket to`)
    const ticketTitle = threadTitle.trim() || title
    const added = await api.editMapTracker(docsRoot, map.id, { kind: 'add-ticket', milestone, title: ticketTitle, ...(prompt !== DEFAULT_IMPLEMENT_PROMPT ? { description: prompt } : {}) })
    if (!added.ok) throw new Error(added.message)
    const ticket = (await api.getMap(docsRoot, map.id)).milestones.find((m) => m.id === milestone)?.tickets.at(-1)
    if (!ticket) throw new Error('The new ticket is gone')
    const heading = 'offset' in from ? title : null
    await api.editMapTracker(docsRoot, map.id, { kind: 'update-ticket', ticket: ticket.id, docs: [{ path: doc, heading }] })
    const started = await api.launchMapWork({ docsRoot, map: map.id, scope: { ticket: ticket.id }, mode: map.launchMode, project, ...size })
    if (!started.ok) throw new Error(`${started.message}; the ticket “${ticket.title}” is on the map, start it from there`)
    onStartedTicket(started, `${started.message}, as a ticket on “${map.title}”`)
  }

  const start = (): void => {
    if (!project || starting) return
    if (chosenMap) {
      setStarting(true)
      setError(null)
      localStorage.setItem(LAST_PROJECT_KEY, project)
      startTicket(chosenMap)
        .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
        .finally(() => setStarting(false))
      return
    }
    setStarting(true)
    setError(null)
    localStorage.setItem(LAST_PROJECT_KEY, project)
    api
      .startImplementation({
        docsRoot,
        doc,
        from,
        title: threadTitle.trim() || title,
        project,
        worktree: worktree === NEW_WORKTREE ? { name: name ?? threadTitle } : { path: worktree },
        prompt,
        ...size
      })
      .then((started) => (started.ok ? onStarted(started) : setError(started.message)))
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
      .finally(() => setStarting(false))
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog implement-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          start()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>Implement a section</h2>
        <p className="muted-row">A Claude session in a code worktree, told about this section. The section shows its progress until the branch lands.</p>
        {code.length === 0 ? (
          <p className="dialog-error">Add a code repository first: the + on Repositories in the sidebar.</p>
        ) : (
          <>
            <label className="dialog-field">
              <span>Title</span>
              <input value={threadTitle} onChange={(e) => setThreadTitle(e.target.value)} />
            </label>
            <label className="dialog-field">
              <span>Project</span>
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                {code.map((p) => (
                  <option key={p.root} value={p.root}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            {onMaps.length > 0 && (
              <label className="dialog-field">
                <span>Track it</span>
                <select value={asTicket} onChange={(e) => setAsTicket(e.target.value)}>
                  {onMaps.map((m) => (
                    <option key={m.id} value={m.id}>
                      As a ticket on “{m.title}”, in “{m.current?.title}”
                    </option>
                  ))}
                  <option value={AS_THREAD}>As an implementation thread on the section</option>
                </select>
              </label>
            )}
            {!chosenMap && (
            <label className="dialog-field">
              <span>Worktree</span>
              <select value={worktree} onChange={(e) => setWorktree(e.target.value)}>
                <option value={NEW_WORKTREE}>New worktree</option>
                {worktrees.map((w) => (
                  <option key={w.path} value={w.path}>
                    {w.branch ?? w.path}
                  </option>
                ))}
              </select>
            </label>
            )}
            {!chosenMap && worktree === NEW_WORKTREE && (
              <label className="dialog-field">
                <span>Name</span>
                <input spellCheck={false} value={name ?? threadTitle} onChange={(e) => setName(e.target.value)} placeholder="session-length" />
              </label>
            )}
            <label className="dialog-field">
              <span>First prompt</span>
              <textarea
                autoFocus
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    start()
                  }
                }}
              />
            </label>
          </>
        )}
        {error ? <p className="dialog-error">{error}</p> : <p className="muted-row">⌘Enter starts. The session can read the docs repo; it's told not to edit it.</p>}
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button accent" disabled={!project || !prompt.trim() || starting}>
            {starting ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </div>
  )
}
