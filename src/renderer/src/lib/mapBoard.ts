import type { MapBatch, MapDetail, MapLaunch, MapTicket, TerminalInfo } from '../../../shared/ipc'
import { isClosed } from '../../../shared/ipc'
import { boardRows, sortBoard, type BoardRow } from '../../../shared/mapBoard'

/** One group on the Board screen: a batch with its rows, or the work started on its own (`batch` null). */
export interface BoardGroup {
  batch: MapBatch | null
  rows: BoardRow[]
}

/** One row per live launch session of the map, with what each needs from the user; unsorted. */
export function mapBoardRows(map: Pick<MapDetail, 'milestones' | 'launches'>, terminals: readonly TerminalInfo[]): BoardRow[] {
  const tickets = map.milestones.flatMap((m) => m.tickets)
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const scope = (launch: MapLaunch, ticket: string | null): MapTicket[] => {
    const one = ticket ?? ('ticket' in launch.scope ? launch.scope.ticket : null)
    if (one) {
      const found = byId.get(one)
      return found ? [found] : []
    }
    if ('tickets' in launch.scope) {
      const ids = launch.scope.tickets
      return tickets.filter((t) => ids.includes(t.id))
    }
    if (!('milestone' in launch.scope)) return []
    const milestone = launch.scope.milestone
    return map.milestones.find((m) => m.id === milestone)?.tickets ?? []
  }
  const title = (launch: MapLaunch, ticket: string | null): string => {
    const own = scope(launch, ticket)
    if ('milestone' in launch.scope && !ticket) {
      const milestone = launch.scope.milestone
      return map.milestones.find((m) => m.id === milestone)?.title ?? 'Milestone'
    }
    return own.length === 1 ? (own[0]?.title ?? 'Ticket') : `${own[0]?.title ?? 'Tickets'} and ${own.length - 1} more`
  }
  return boardRows({
    launches: map.launches,
    states: new Map(terminals.map((t) => [t.id, t.state])),
    title,
    blocked: (launch, ticket) => scope(launch, ticket).find((t) => t.status === 'blocked')?.blocked ?? null,
    unblocks: (launch, ticket) => {
      const ids = scope(launch, ticket).map((t) => t.id)
      return tickets.filter((t) => !isClosed(t.status) && t.after.some((a) => ids.includes(a))).length
    }
  })
}

/** The map's board from its detail and the live terminals: batches with live work first, newest first, then the rest. */
export function boardGroups(map: MapDetail, terminals: readonly TerminalInfo[]): BoardGroup[] {
  const rows = mapBoardRows(map, terminals)
  const groups: BoardGroup[] = []
  for (const batch of [...map.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const own = rows.filter((r) => r.batch === batch.id)
    if (own.length > 0) groups.push({ batch, rows: sortBoard(own) })
  }
  const shown = new Set(groups.flatMap((g) => g.rows))
  const rest = rows.filter((r) => !shown.has(r))
  if (rest.length > 0) groups.push({ batch: null, rows: sortBoard(rest) })
  return groups
}

/** A batch's coordinator as the Board shows it: running, closed or exited (resume it), or none yet. */
export function coordinatorState(batch: MapBatch, terminals: readonly TerminalInfo[]): 'running' | 'stopped' | 'none' {
  const coordinator = batch.coordinator
  if (!coordinator) return 'none'
  const terminal = terminals.find((t) => t.id === coordinator.terminal)
  return terminal && terminal.state !== 'exited' ? 'running' : 'stopped'
}

/** How many board rows need the user: what Home's Board link counts. */
export function needsYou(groups: readonly BoardGroup[]): number {
  return groups.reduce((n, g) => n + g.rows.filter((r) => r.attention !== null).length, 0)
}
