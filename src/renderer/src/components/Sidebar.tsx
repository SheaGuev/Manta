import { ArrowLeftRight, BookOpen, Bot, ChevronRight, FileText, Folder, FolderPlus, GitBranch, Map as MapIcon, MapPlus, PanelLeft, Plus, Search, Settings2, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import type { MapSummary, Project, ProjectWorktree, TerminalInfo, Worktree } from '../../../shared/ipc'
import { useWorktrees } from '../lib/hooks'
import { mostUrgent, rootState } from '../lib/terminalStatus'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { InlineInput } from './InlineInput'

export interface SidebarProps {
  projects: Project[]
  contextRoot: string | null
  /** Bumped after worktrees are created, so project rows reload their list. */
  worktreeVersion: number
  isExpanded: (key: string) => boolean
  onToggle: (key: string) => void
  onToggleSidebar: () => void
  onSelectDocs: (project: Project) => void
  /** Picks another folder as the docs repo, replacing this one. */
  onChangeDocs: () => void
  onSelectWorktree: (project: Project, worktree: Worktree) => void
  onCreateWorktree: (project: Project, name: string) => Promise<void>
  onRemoveWorktree: (project: Project, worktree: ProjectWorktree) => void
  /** Every terminal, for the Claude status dot on each context's row. */
  terminals: TerminalInfo[]
  onNewClaude: (project: Project, worktree: Worktree) => void
  onAddProject: (kind: Project['kind']) => void
  onRemoveProject: (project: Project) => void
  /** The docs repo's context maps; null while loading. */
  maps: MapSummary[] | null
  /** The map whose context is open, if any. */
  contextMap: string | null
  onSelectMap: (map: MapSummary) => void
  onNewMap: () => void
  /** Opens Quick open; null while there is no context to search. */
  onSearch: (() => void) | null
  /** Opens the Plugins tab; null while there is no context to open it in. */
  onOpenSettings: (() => void) | null
  resizeHandle: React.ReactNode
}

export function Sidebar(props: SidebarProps): React.JSX.Element {
  const docs = props.projects.find((p) => p.kind === 'docs')
  const code = props.projects.filter((p) => p.kind === 'code')
  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <button className="icon-button" title="Hide sidebar" onClick={props.onToggleSidebar}>
          <PanelLeft size={16} />
        </button>
      </div>
      <button className="sidebar-search" disabled={!props.onSearch} onClick={() => props.onSearch?.()}>
        <Search size={14} />
        <span className="label">Search anything</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="sidebar-scroll">
        <SectionLabel
          label="Workspace"
          action={docs ? 'Change docs repo…' : 'Choose your docs repo…'}
          icon={docs ? <ArrowLeftRight size={14} /> : undefined}
          onClick={docs ? props.onChangeDocs : () => props.onAddProject('docs')}
        />
        {docs ? (
          <DocsCard project={docs} {...props} />
        ) : (
          <div className="row muted-row" onClick={() => props.onAddProject('docs')}>
            <BookOpen size={15} />
            <span className="label">Choose your docs repo…</span>
          </div>
        )}
        {docs && (
          <>
            <SectionLabel label="Context maps" action="New context map" onClick={props.onNewMap} gap />
            <MapList {...props} />
          </>
        )}
        <SectionLabel label="Repositories" action="Add code repository" onClick={() => props.onAddProject('code')} gap />
        {code.map((project) => (
          <CodeProject key={project.root} project={project} {...props} />
        ))}
        {code.length === 0 && (
          <div className="row muted-row" onClick={() => props.onAddProject('code')} title="Worktrees live in code repositories">
            <FolderPlus size={15} />
            <span className="label">Add code repository…</span>
          </div>
        )}
      </div>
      <div className="sidebar-footer">
        <div className={`row ${props.onOpenSettings ? '' : 'muted-row'}`} onClick={() => props.onOpenSettings?.()}>
          <Settings2 size={15} />
          <span className="label">Workspace settings</span>
        </div>
      </div>
      {props.resizeHandle}
    </aside>
  )
}

interface SectionLabelProps {
  label: string
  action: string
  /** Defaults to a plus. */
  icon?: React.ReactNode
  onClick: () => void
  gap?: boolean
}

function SectionLabel({ label, action, icon, onClick, gap }: SectionLabelProps): React.JSX.Element {
  return (
    <div className={`section-label ${gap ? 'section-gap' : ''}`}>
      <span>{label}</span>
      <span className="section-actions">
        <button className="icon-button" title={action} onClick={onClick}>
          {icon ?? <Plus size={14} />}
        </button>
      </span>
    </div>
  )
}

/** The docs repo's context maps, each a context of its own. */
function MapList(props: SidebarProps): React.JSX.Element {
  const maps = props.maps ?? []
  return (
    <div className="maps-list">
      {maps.map((map) => (
        <div
          key={map.id}
          className={`row map-row ${props.contextMap === map.id ? 'selected' : ''}`}
          title={mapHint(map)}
          onClick={() => props.onSelectMap(map)}
        >
          <MapIcon size={15} />
          <span className="label">{map.title}</span>
          <MapBadge map={map} />
          <MapSessionsDot terminals={props.terminals} map={map.id} />
        </div>
      ))}
      {props.maps !== null && maps.length === 0 && (
        <div className="row muted-row" onClick={() => props.onNewMap()}>
          <MapPlus size={15} />
          <span className="label">New context map</span>
        </div>
      )}
    </div>
  )
}

/** The map's description and its current milestone's progress, on hover. */
function mapHint(map: MapSummary): string {
  const progress = map.current ? `${map.current.title}: ${map.current.done}/${map.current.total} done` : 'No milestone in progress'
  return [map.description || map.title, progress, map.waiting > 0 ? `${map.waiting} waiting on you` : null].filter(Boolean).join('\n')
}

/** Ask the map is answering, or something waits on the user. */
function MapBadge({ map }: { map: MapSummary }): React.JSX.Element | null {
  if (map.running) return <span className="map-badge working" title="Ask the map is answering" />
  if (map.waiting > 0) return <span className="map-badge waiting" title={`${map.waiting} waiting on you`} />
  return null
}

function MapSessionsDot({ terminals, map }: { terminals: TerminalInfo[]; map: string }): React.JSX.Element | null {
  const state = mostUrgent(terminals.filter((t) => t.map?.map === map))
  return state ? <span className={`terminal-dot state-${state}`} title={`Claude: ${state}`} /> : null
}

function DocsCard({ project, ...props }: SidebarProps & { project: Project }): React.JSX.Element {
  return (
    <div
      className={`row docs-card ${props.contextRoot === project.root && props.contextMap === null ? 'selected' : ''}`}
      title={project.root}
      onClick={() => props.onSelectDocs(project)}
    >
      <FileText size={16} />
      <span className="docs-card-text">
        <span className="label">{project.name}</span>
        <span className="docs-card-detail">Shared documents</span>
      </span>
      <StatusDot terminals={props.terminals} root={project.root} />
    </div>
  )
}

function CodeProject({ project, ...props }: SidebarProps & { project: Project }): React.JSX.Element {
  const expanded = props.isExpanded(project.root)
  const creating = props.isExpanded(`new-worktree:${project.root}`)
  const worktrees = useWorktrees(expanded ? project.root : null, props.worktreeVersion)
  return (
    <div>
      <div className="row project-row" onClick={() => props.onToggle(project.root)}>
        <ChevronRight size={14} className={`chevron ${expanded ? 'open' : ''}`} />
        <Folder size={15} />
        <span className="label">{project.name}</span>
        <span className="row-actions">
          <button
            className="icon-button"
            title="New worktree"
            onClick={(e) => {
              e.stopPropagation()
              if (!expanded) props.onToggle(project.root)
              props.onToggle(`new-worktree:${project.root}`)
            }}
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-button"
            title="Remove from Manta"
            onClick={(e) => {
              e.stopPropagation()
              props.onRemoveProject(project)
            }}
          >
            <X size={14} />
          </button>
        </span>
      </div>
      {expanded && (
        <div className="project-children">
          {worktrees.map((worktree) => (
            <div
              key={worktree.path}
              className={`row tree-row ${props.contextRoot === worktree.path ? 'selected' : ''}`}
              style={{ '--depth': 1 }}
              onClick={() => props.onSelectWorktree(project, worktree)}
              title={worktree.path}
            >
              <GitBranch size={14} />
              <span className="label">{worktreeName(worktree)}</span>
              {worktree.isMain && <span className="muted-row">primary</span>}
              <StatusDot terminals={props.terminals} root={worktree.path} />
              <span className="row-actions">
                <button
                  className="icon-button"
                  title="New Claude session"
                  onClick={(e) => {
                    e.stopPropagation()
                    props.onNewClaude(project, worktree)
                  }}
                >
                  <Bot size={14} />
                </button>
                {worktree.managed && (
                  <button
                    className="icon-button"
                    title="Remove worktree (keeps the branch)"
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onRemoveWorktree(project, worktree)
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </span>
            </div>
          ))}
          {creating && (
            <InlineInput
              depth={1}
              placeholder="Worktree name"
              onCancel={() => props.onToggle(`new-worktree:${project.root}`)}
              onSubmit={async (name) => {
                await props.onCreateWorktree(project, name)
                props.onToggle(`new-worktree:${project.root}`)
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** Manta-made branches are `manta/<slug>`; the prefix is noise in a list of them. */
export function worktreeName(worktree: Worktree): string {
  return worktree.branch?.replace(/^manta\//, '') ?? `detached ${worktree.head.slice(0, 7)}`
}

/** The most urgent Claude session in this context: waiting on you, working, or ready. */
function StatusDot({ terminals, root }: { terminals: TerminalInfo[]; root: string }): React.JSX.Element | null {
  const state = rootState(terminals, root)
  return state ? <span className={`terminal-dot state-${state}`} title={`Claude: ${state}`} /> : null
}
