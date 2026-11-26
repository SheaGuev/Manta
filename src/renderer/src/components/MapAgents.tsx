import { Radar } from 'lucide-react'
import type { MapBatch, MapDetail } from '../../../shared/ipc'
import type { BoardRow } from '../../../shared/mapBoard'
import { boardGroups, coordinatorState } from '../lib/mapBoard'
import { Chip } from './MapOverview'
import type { MapActions } from './MapView'

const STATE_LABEL: Record<BoardRow['state'], string> = {
  starting: 'Starting',
  running: 'Running',
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'At its prompt',
  exited: 'Exited',
  closed: 'Closed'
}

/**
 * The Milestones page's Agents card: every agent working from the map, batches (started together)
 * first with their coordinator, then other work. A row opens its session.
 */
export function AgentsCard({ map, actions, busy }: { map: MapDetail; actions: MapActions; busy: boolean }): React.JSX.Element | null {
  const groups = boardGroups(map, actions.terminals)
  if (groups.length === 0) return null
  return (
    <section className="map-card map-ov-side-card">
      <h2>Agents</h2>
      {groups.map((group) => (
        <div key={group.batch?.id ?? 'rest'} className="map-ag-group">
          <div className="map-ag-group-head">
            <span className="map-dk-rail-label">{group.batch ? `Started together · ${group.rows.length}` : 'Other work'}</span>
          </div>
          {group.batch && <CoordinatorControls batch={group.batch} actions={actions} busy={busy} />}
          {group.rows.map((row) => (
            <AgentRow key={`${row.launch}/${row.ticket ?? ''}`} row={row} map={map} actions={actions} />
          ))}
        </div>
      ))}
    </section>
  )
}

function AgentRow({ row, map, actions }: { row: BoardRow; map: MapDetail; actions: MapActions }): React.JSX.Element {
  const launch = map.launches.find((l) => l.id === row.launch)
  return (
    <button className="map-ov-doc map-ag-row" title="Open its session" onClick={() => launch && actions.openSession(launch, row.terminal)}>
      <span className="map-ag-row-top">
        <span className="map-ov-doc-title">{row.title}</span>
        <Chip tone={row.state === 'waiting' ? 'you' : 'muted'}>{STATE_LABEL[row.state]}</Chip>
      </span>
      {(row.attention || row.progress) && <span className="map-ov-doc-meta">{row.attention ?? `${row.progress?.summary ?? ''}${row.progress?.next ? ` · next: ${row.progress.next}` : ''}`}</span>}
      {row.pr && <span className="map-ov-doc-meta">Pull request #{row.pr.number}</span>}
    </button>
  )
}

/** A batch's coordinator: open or resume it, or the offer of one (Start / Not now) until the user turns it down. */
export function CoordinatorControls({ batch, actions, busy }: { batch: MapBatch; actions: MapActions; busy: boolean }): React.JSX.Element {
  const state = coordinatorState(batch, actions.terminals)
  if (state === 'none' && !batch.declined) {
    return (
      <div className="map-ag-offer">
        <span>A coordinator session can watch these agents and tell you what needs you, in order. It runs on your Claude Code and reads only the map.</span>
        <span className="map-ag-offer-actions">
          <button className="map-button" disabled={busy} onClick={() => actions.coordinate(batch.id)}>
            <Radar size={13} /> Start coordinator
          </button>
          <button className="map-button" onClick={() => actions.declineCoordinator(batch.id)}>
            Not now
          </button>
        </span>
      </div>
    )
  }
  return (
    <button className="map-link map-ag-coordinator" disabled={busy} title="The session coordinating this batch" onClick={() => actions.coordinate(batch.id)}>
      <Radar size={11} /> {state === 'running' ? 'Open coordinator' : state === 'stopped' ? 'Resume coordinator' : 'Start coordinator'}
    </button>
  )
}
