import type { MapLaunch, PullRequestInfo, SessionProgress, TerminalState } from './ipc'

/** One agent's line on a map's board: a session of a live launch (or the launch, before any session). */
export interface BoardRow {
  launch: string
  /** The ticket a session in a shared worktree focuses on; null for the launch's whole scope. */
  ticket: string | null
  terminal: string | null
  title: string
  batch: string | null
  /** 'closed' when its terminal is gone. */
  state: TerminalState | 'closed'
  progress: SessionProgress | null
  /** What the user is needed for, in a few words; null while it just gets on with the work. */
  attention: string | null
  /** Lower comes first: 0 waiting or blocked, 1 a decision, 2 finished work to look at, 3 a pull request needing fixes, 4 one ready to merge, 5 nothing. */
  rank: number
  /** How many unfinished tickets wait for this one: among equals, unblocking more comes first. */
  unblocks: number
  pr: PullRequestInfo | null
}

export interface BoardInput {
  launches: readonly MapLaunch[]
  /** Live terminal states by terminal id. */
  states: ReadonlyMap<string, TerminalState>
  title: (launch: MapLaunch, ticket: string | null) => string
  /** Why a ticket in the row's scope is blocked, if one is. */
  blocked: (launch: MapLaunch, ticket: string | null) => string | null
  unblocks: (launch: MapLaunch, ticket: string | null) => number
}

/** The board: one row per live launch session, with what each needs from the user. Landed work is left out. */
export function boardRows(input: BoardInput): BoardRow[] {
  const rows: BoardRow[] = []
  for (const launch of input.launches) {
    if (launch.landed) continue
    /** A resumed session keeps its entry; several entries share a ticket only when started again later, so the latest wins. */
    const byTicket = new Map<string | null, MapLaunch['sessions'][number]>()
    for (const session of launch.sessions) byTicket.set(session.ticket, session)
    const sessions = byTicket.size > 0 ? [...byTicket.values()] : [null]
    for (const session of sessions) {
      const ticket = session?.ticket ?? null
      const state = session ? (input.states.get(session.terminal) ?? 'closed') : 'closed'
      const progress = session?.progress ?? null
      const { attention, rank } = attentionOf(launch, state, progress, input.blocked(launch, ticket))
      rows.push({
        launch: launch.id,
        ticket,
        terminal: session?.terminal ?? null,
        title: input.title(launch, ticket),
        batch: launch.batch,
        state,
        progress,
        attention,
        rank,
        unblocks: input.unblocks(launch, ticket),
        pr: launch.pr
      })
    }
  }
  return rows
}

function attentionOf(launch: MapLaunch, state: TerminalState | 'closed', progress: SessionProgress | null, blocked: string | null): { attention: string | null; rank: number } {
  const needs = progress?.needs ?? null
  if (state === 'waiting') return { attention: needs ? needs.ask : 'Waiting for you in its session', rank: 0 }
  if (blocked) return { attention: `Blocked: ${blocked}`, rank: 0 }
  if (needs?.kind === 'unblock') return { attention: needs.ask, rank: 0 }
  if (needs?.kind === 'decision') return { attention: needs.ask, rank: 1 }
  if (needs?.kind === 'review') return { attention: needs.ask, rank: 2 }
  if (launch.readyAt && !launch.pr) return { attention: 'Finished: open its pull request', rank: 2 }
  const health = launch.pr?.state === 'open' ? launch.health : null
  if (health && health.checks === 'failed') return { attention: `Checks failing on #${launch.pr?.number ?? ''}`, rank: 3 }
  if (health && health.review === 'changes-requested') return { attention: `Changes requested on #${launch.pr?.number ?? ''}`, rank: 3 }
  if (health && health.review === 'approved' && health.checks !== 'running') return { attention: `Approved: merge #${launch.pr?.number ?? ''}`, rank: 4 }
  return { attention: null, rank: 5 }
}

/** The batch's rows first, then by what needs the user most, then by how much each unblocks. */
export function sortBoard(rows: readonly BoardRow[], batch: string | null = null): BoardRow[] {
  return [...rows].sort((a, b) => Number(b.batch === batch && batch !== null) - Number(a.batch === batch && batch !== null) || a.rank - b.rank || b.unblocks - a.unblocks)
}

const STATE_WORDS: Record<BoardRow['state'], string> = { starting: 'starting', running: 'running', working: 'working', waiting: 'waiting for you', idle: 'at its prompt', exited: 'exited', closed: 'closed' }

/** The board as compact text, a line per row: what a coordinator reads instead of transcripts or code. */
export function boardText(rows: readonly BoardRow[], batch: string | null = null): string {
  if (rows.length === 0) return 'Nothing is running on the map.'
  return sortBoard(rows, batch)
    .map((row) => {
      const where = [row.progress ? row.progress.phase : null, STATE_WORDS[row.state], row.pr ? `PR #${row.pr.number} ${row.pr.state}` : null].filter(Boolean).join(', ')
      const said = row.progress ? ` “${row.progress.summary}”${row.progress.next ? ` next: ${row.progress.next}` : ''}` : ''
      const tags = [row.batch === batch && batch !== null ? 'this batch' : null, row.unblocks > 0 ? `${row.unblocks} wait for it` : null].filter(Boolean).join(', ')
      return `- ${row.title} [launch ${row.launch}${row.ticket ? `, ticket ${row.ticket}` : ''}${tags ? `; ${tags}` : ''}] (${where})${said}${row.attention ? ` → NEEDS YOU: ${row.attention}` : ''}`
    })
    .join('\n')
}

/** What a row needs from the user, as a key that changes only when that does: what wakes a coordinator. */
export function signalOf(row: BoardRow): string {
  return `${row.attention ?? ''}|${row.state === 'exited' || row.state === 'closed' ? 'ended' : 'live'}`
}
