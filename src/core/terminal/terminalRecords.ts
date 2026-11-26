import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { MapLink, TerminalKind, TerminalLink } from '../../shared/ipc'

/** What outlives a terminal's process: enough to show its tab after a relaunch and resume its Claude session. */
export interface TerminalRecord {
  id: string
  root: string
  kind: TerminalKind
  title: string
  sessionId: string | null
  resumable: boolean
  createdAt: string
  link: TerminalLink | null
  /** The context map the session was started from, which its brief is built from. */
  map: MapLink | null
  /** Appended to Claude Code's system prompt on every start; null for none. */
  brief: string | null
  /** Passed as `--add-dir` on every start. */
  addDirs: string[]
}

const KINDS: readonly TerminalKind[] = ['claude', 'shell']

export function parseTerminalRecord(value: unknown): TerminalRecord | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('id' in value) || typeof value.id !== 'string') return null
  if (!('root' in value) || typeof value.root !== 'string') return null
  const kind = 'kind' in value ? KINDS.find((k) => k === value.kind) : undefined
  if (!kind) return null
  if (!('title' in value) || typeof value.title !== 'string') return null
  if (!('sessionId' in value) || (value.sessionId !== null && typeof value.sessionId !== 'string')) return null
  if (!('createdAt' in value) || typeof value.createdAt !== 'string') return null
  const resumable = 'resumable' in value && value.resumable === true
  /** Records from before implementation threads have no link, brief or extra folders. */
  const link = 'link' in value && isLink(value.link) ? value.link : null
  /** Records from before context maps have no map. */
  const map = 'map' in value ? parseMapLink(value.map) : null
  const brief = 'brief' in value && typeof value.brief === 'string' ? value.brief : null
  const addDirs = 'addDirs' in value && Array.isArray(value.addDirs) ? value.addDirs.filter((dir) => typeof dir === 'string') : []
  return { id: value.id, root: value.root, kind, title: value.title, sessionId: value.sessionId, resumable, createdAt: value.createdAt, link, map, brief, addDirs }
}

function isLink(value: unknown): value is TerminalLink {
  return (
    typeof value === 'object' &&
    value !== null &&
    'docsRoot' in value &&
    typeof value.docsRoot === 'string' &&
    'doc' in value &&
    typeof value.doc === 'string' &&
    'thread' in value &&
    typeof value.thread === 'string'
  )
}

/** Map sessions from before launches have no launch or ticket. */
function parseMapLink(value: unknown): MapLink | null {
  if (typeof value !== 'object' || value === null || !('docsRoot' in value) || typeof value.docsRoot !== 'string' || !('map' in value) || typeof value.map !== 'string') return null
  const launch = 'launch' in value && typeof value.launch === 'string' ? value.launch : null
  const ticket = 'ticket' in value && typeof value.ticket === 'string' ? value.ticket : null
  const coordinator = 'coordinator' in value && typeof value.coordinator === 'string' ? value.coordinator : null
  return { docsRoot: value.docsRoot, map: value.map, launch, ticket, ...(coordinator ? { coordinator } : {}) }
}

/** Every terminal Manta has open, in `<userData>/terminals.json`. Writes run one at a time. */
export class TerminalRecordStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  /** Unreadable entries are dropped, and an unreadable file reads as empty. */
  async list(): Promise<TerminalRecord[]> {
    await this.queue
    return this.read()
  }

  put(record: TerminalRecord): Promise<void> {
    return this.update((records) => [...records.filter((r) => r.id !== record.id), record])
  }

  remove(id: string): Promise<void> {
    return this.update((records) => records.filter((r) => r.id !== id))
  }

  private update(change: (records: TerminalRecord[]) => TerminalRecord[]): Promise<void> {
    const next = this.queue.then(async () => {
      const json = `${JSON.stringify(change(await this.read()), null, 2)}\n`
      await mkdir(path.dirname(this.file), { recursive: true })
      await writeFile(`${this.file}.tmp`, json)
      await rename(`${this.file}.tmp`, this.file)
    })
    /** The caller sees the failure; later writes still run. */
    this.queue = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<TerminalRecord[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return Array.isArray(parsed) ? parsed.flatMap((entry) => parseTerminalRecord(entry) ?? []) : []
    } catch {
      return []
    }
  }
}
