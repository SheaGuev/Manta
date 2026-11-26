import { useState } from 'react'
import type { LaunchMode, MapDetail, MapStage, MapSummary } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'
import { STAGE_LABEL } from '../lib/mapStatus'
import { Switch } from './MapParts'
import { MultiSelect } from './MultiSelect'

const api = window.manta

const STAGES: readonly MapStage[] = ['planning', 'building', 'validating', 'shipped']

interface MapDialogProps {
  docsRoot: string
  /** The code projects Manta has, by name. */
  codeProjects: readonly string[]
  /** The map being edited; null creates a new one. */
  map: MapDetail | null
  onClose: () => void
  onSaved: (map: MapSummary | null) => void
}

/**
 * New context map, or its settings: title, a short description, the code projects it works in (with
 * the checks that verify work in each), and how launches get worktrees by default; when editing, the
 * ticket key, the stage, the sweep, and how agents propose changes too. Escape or a click
 * outside cancels.
 */
export function MapDialog({ docsRoot, codeProjects, map, onClose, onSaved }: MapDialogProps): React.JSX.Element {
  const [title, setTitle] = useState(map?.title ?? '')
  const [description, setDescription] = useState(map?.description ?? '')
  const [projects, setProjects] = useState<string[]>(map?.projects ?? (codeProjects.length === 1 ? [...codeProjects] : []))
  const [launchMode, setLaunchMode] = useState<LaunchMode>(map?.launchMode ?? 'ticket')
  const [sweep, setSweep] = useState(map?.sweep ?? true)
  const [confirmProposals, setConfirmProposals] = useState(map?.confirmProposals !== 'queue')
  const [key, setKey] = useState(map?.key ?? '')
  const [stage, setStage] = useState<MapStage | null>(map?.stageSet ?? null)
  /** One command per line, by project name. */
  const [checks, setChecks] = useState<Record<string, string>>(Object.fromEntries((map?.checks ?? []).map((c) => [c.project, c.commands.join('\n')])))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const save = (): void => {
    if (!title.trim() || saving) return
    setSaving(true)
    setError(null)
    const projectChecks = projects.map((project) => ({ project, commands: (checks[project] ?? '').split('\n') }))
    const done = map
      ? api
          .updateMap(docsRoot, map.id, {
            title,
            description,
            projects,
            launchMode,
            sweep,
            confirmProposals: confirmProposals ? 'ask' : 'queue',
            checks: projectChecks,
            ...(key.trim().toUpperCase() !== map.key ? { key } : {}),
            stage
          })
          .then(() => onSaved(null))
      : api.createMap(docsRoot, { title, description, projects, launchMode }).then(async (created) => {
          if (projectChecks.some((c) => c.commands.some((cmd) => cmd.trim()))) await api.updateMap(docsRoot, created.id, { checks: projectChecks })
          onSaved(created)
        })
    done.catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e)))).finally(() => setSaving(false))
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog implement-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>{map ? 'Edit map' : 'New context map'}</h2>
        {!map && <p className="muted-row">Your home for one feature or project: its docs, a plan of milestones and tickets, and the sessions working on it.</p>}
        <label className="dialog-field">
          <span>Title</span>
          <input autoFocus value={title} placeholder="Context maps v2" onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="dialog-field">
          <span>Description</span>
          <textarea rows={3} value={description} placeholder="What it is and why, in a sentence or two." onChange={(e) => setDescription(e.target.value)} />
        </label>
        {codeProjects.length > 0 && (
          <div className="dialog-field">
            <span>Code projects it works in</span>
            <MultiSelect options={codeProjects.map((name) => ({ id: name, label: name }))} value={projects} onChange={setProjects} placeholder="No code projects" />
          </div>
        )}
        {projects.map((project) => (
          <label key={project} className="dialog-field">
            <span>Checks for {project}: the commands that tell an agent its work is right, one per line</span>
            <textarea
              rows={2}
              className="map-mono"
              value={checks[project] ?? ''}
              placeholder={'npm run typecheck\nnpm test'}
              onChange={(e) => setChecks((c) => ({ ...c, [project]: e.target.value }))}
            />
          </label>
        ))}
        <div className="dialog-field">
          <span>Launching work gives</span>
          <div className="map-check-list">
            <label className="map-check">
              <input type="radio" checked={launchMode === 'ticket'} onChange={() => setLaunchMode('ticket')} /> a worktree per ticket
            </label>
            <label className="map-check">
              <input type="radio" checked={launchMode === 'milestone'} onChange={() => setLaunchMode('milestone')} /> a worktree per milestone
            </label>
          </div>
        </div>
        {map && (
          <div className="map-dialog-row">
            <label className="dialog-field">
              <span>Ticket key</span>
              <input className="map-mono" value={key} maxLength={6} placeholder="OMN" title="Tickets show as KEY-12; leave empty to take it from the title" onChange={(e) => setKey(e.target.value.toUpperCase())} />
            </label>
            <label className="dialog-field">
              <span>Stage</span>
              <select
                className="map-select-field"
                value={stage ?? ''}
                onChange={(e) => setStage(STAGES.find((s) => s === e.target.value) ?? null)}
              >
                <option value="">Worked out from the tickets{map.stageSet === null ? ` (${STAGE_LABEL[map.stage]})` : ''}</option>
                {STAGES.map((s) => (
                  <option key={s} value={s}>
                    {STAGE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {map && (
          <Switch checked={sweep} onChange={setSweep}>
            Wrap up sessions that end without doing it (a small model, on your Claude Code)
          </Switch>
        )}
        {map && (
          <Switch checked={confirmProposals} onChange={setConfirmProposals}>
            Sessions ask me before proposing tickets, plan or doc changes (off: they go straight to Needs review)
          </Switch>
        )}
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button accent" disabled={!title.trim() || saving}>
            {saving ? 'Saving…' : map ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}
