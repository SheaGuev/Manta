import { useEffect, useState } from 'react'
import type { MapDetail, MapSummary } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'
import { milestoneKey } from '../lib/mapStatus'
import { Switch } from './MapParts'
import { MultiSelect } from './MultiSelect'

const api = window.manta

interface AddMapDocDialogProps {
  /** The map to add to; null asks which, from `maps` (Add to map… on a doc). */
  map: MapDetail | null
  maps?: readonly MapSummary[]
  docsRoot: string
  /** `new` creates a doc; `existing` lists one the docs repo has. */
  mode: 'new' | 'existing'
  /** Milestones ticked to begin with. */
  milestones: readonly string[]
  /** Markdown files in the docs repo, for an existing doc. */
  docFiles: readonly string[]
  /** An existing doc to start from (Add to map… on a doc). */
  initialPath?: string
  onClose: () => void
  /** `path` is the doc added or created; `brainstorm` asks for a thread on it. */
  onDone: (path: string | null, brainstorm: boolean) => void
  onError: (message: string) => void
}

/** Adds a doc to a map: a new one in the docs repo (with an optional brainstorm thread), or an existing one, with its milestones and section. */
export function AddMapDocDialog(props: AddMapDocDialogProps): React.JSX.Element {
  const [mapId, setMapId] = useState(props.map?.id ?? props.maps?.[0]?.id ?? '')
  const [detail, setDetail] = useState<MapDetail | null>(props.map)
  const map = props.map ?? detail
  const docsRoot = props.docsRoot
  const folder = map ? slug(map.title) : ''
  const [title, setTitle] = useState('')
  const [path, setPath] = useState(props.initialPath ?? (props.mode === 'new' ? `${folder}/` : ''))
  /** A new doc's path follows its title until the user types one. */
  const [pathTyped, setPathTyped] = useState(props.mode !== 'new')
  const docPath = !pathTyped && title.trim() ? `${folder}/${slug(title)}.md` : path
  const [milestones, setMilestones] = useState<string[]>([...props.milestones])
  const [section, setSection] = useState<string | null>(null)
  const [brainstorm, setBrainstorm] = useState(props.mode === 'new')
  const [error, setError] = useState<string | null>(null)

  const { onError } = props
  /** Add to map… loads the chosen map, for its milestones and sections. */
  useEffect(() => {
    if (props.map || !mapId) return
    let live = true
    api
      .getMap(docsRoot, mapId)
      .then((next) => live && setDetail(next))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [props.map, mapId, docsRoot, onError])

  const pickMap = (id: string): void => {
    setMapId(id)
    setMilestones([])
    setSection(null)
  }

  const save = (): void => {
    if (!map || !docPath.trim()) return
    const run =
      props.mode === 'new'
        ? api.createMapDoc(docsRoot, map.id, { path: docPath, milestones, section, roles: [] }, title.trim() || undefined).then((created) => props.onDone(created, brainstorm))
        : api.editMapDocs(docsRoot, map.id, { kind: 'add-doc', path, milestones, section }).then((result) => (result.ok ? props.onDone(path, false) : setError(result.message)))
    run.catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form
        className="dialog implement-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose()}
      >
        <h2>{props.mode === 'new' ? 'New doc' : props.map ? 'Add an existing doc' : 'Add to map'}</h2>
        {!props.map && props.maps && (
          <label className="dialog-field">
            <span>Map</span>
            <select value={mapId} onChange={(e) => pickMap(e.target.value)}>
              {props.maps.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {props.mode === 'new' && (
          <label className="dialog-field">
            <span>Title</span>
            <input autoFocus value={title} placeholder="Production setup runbook" onChange={(e) => setTitle(e.target.value)} />
          </label>
        )}
        <label className="dialog-field">
          <span>{props.mode === 'new' ? 'Path in the docs repo' : 'Doc'}</span>
          <input
            autoFocus={props.mode !== 'new'}
            list="map-doc-files"
            value={docPath}
            placeholder={props.mode === 'new' ? `${folder}/prd.md` : 'docs/feature.md'}
            onChange={(e) => {
              setPath(e.target.value)
              setPathTyped(true)
            }}
          />
          {props.mode === 'existing' && (
            <datalist id="map-doc-files">
              {props.docFiles
                .filter((f) => !map?.docs.some((d) => d.path === f))
                .map((f) => (
                  <option key={f} value={f} />
                ))}
            </datalist>
          )}
        </label>
        {map && map.milestones.length > 0 && (
          <div className="dialog-field">
            <span>Milestones</span>
            <MultiSelect options={map.milestones.map((m) => ({ id: m.id, key: milestoneKey(map, m), label: m.title }))} value={milestones} onChange={setMilestones} placeholder="No milestone" />
          </div>
        )}
        {map && map.sections.length > 0 && (
          <label className="dialog-field">
            <span>Section</span>
            <select value={section ?? ''} onChange={(e) => setSection(e.target.value || null)}>
              <option value="">None</option>
              {map.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {props.mode === 'new' && (
          <Switch checked={brainstorm} onChange={setBrainstorm}>
            Start a thread to brainstorm it with the agent
          </Switch>
        )}
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button accent" disabled={!map || !docPath.trim()}>
            {props.mode === 'new' ? 'Create' : 'Add'}
          </button>
        </div>
      </form>
    </div>
  )
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
