import { access, stat } from 'node:fs/promises'
import path from 'node:path'
import type { FilesChanged } from '../../shared/ipc'
import { CachedRead } from './cachedRead'
import type { Git, StatusSnapshot } from './git'

/** One file-system event, from `fs.watch`: `rename` for a path added or removed (or saved by renaming over it), `change` for its contents. */
export interface FileEvent {
  kind: 'change' | 'rename'
  /** Relative to the repo root, `/`-separated. */
  relPath: string
}

export type ChangeKinds = Omit<FilesChanged, 'root'>

/** A Claude session saving file after file costs a status run every 3 s at most, as in Orca. */
export const STATUS_MIN_GAP_MS = 3000

/** Creating many files lists them again once a second at most; a big repo's list is costly to send. */
const FILES_MIN_GAP_MS = 1000

const RECORD = /^\.manta\/threads\/(t_[0-9a-f]+)\.json$/
const MAP = /^\.manta\/maps\/(m_[0-9a-f]+)(\/|$)/
const EVERYTHING: ChangeKinds = { structure: true, content: true, records: [], maps: [] }

/**
 * A repo's git status and file list, loaded once and shared by every panel showing them, and the
 * classification of file events that decides which of them went stale.
 */
export class RepoCache {
  readonly status: CachedRead<StatusSnapshot>
  readonly files: CachedRead<string[]>
  /** Line counts of untracked files, kept while their size and modification time stay the same. */
  private readonly lineCounts = new Map<string, { size: number; mtimeMs: number; lines: number }>()

  constructor(
    private readonly git: Git,
    private readonly root: string,
    options: { statusGapMs?: number } = {}
  ) {
    this.status = new CachedRead(() => this.loadStatus(), { minGapMs: options.statusGapMs ?? STATUS_MIN_GAP_MS })
    this.files = new CachedRead(() => git.listFiles(), { minGapMs: FILES_MIN_GAP_MS })
  }

  /** After a git operation from Manta: everything may have changed, and the user is waiting for it. */
  invalidateAll(): ChangeKinds {
    this.status.invalidate(true)
    this.files.invalidate(true)
    return EVERYTHING
  }

  /** Marks what a batch of events made stale and says what changed; `'unknown'` when the watcher couldn't say which paths. */
  async noteEvents(events: readonly FileEvent[] | 'unknown'): Promise<ChangeKinds> {
    if (events === 'unknown') {
      this.status.invalidate()
      this.files.invalidate()
      return EVERYTHING
    }
    const known = this.files.last
    const listed = known ? new Set(known) : null
    const records = new Set<string>()
    const maps = new Set<string>()
    let structure = false
    let content = false
    for (const event of events) {
      const record = RECORD.exec(event.relPath)?.[1]
      if (record) records.add(record)
      const map = MAP.exec(event.relPath)?.[1]
      if (map) maps.add(map)
      if (event.relPath === '.manta' || event.relPath.startsWith('.manta/')) continue
      content = true
      if (structure) continue
      if (event.relPath === '.gitignore' || event.relPath.endsWith('/.gitignore')) structure = true
      else if (event.kind === 'rename') structure = await this.addedOrRemoved(event.relPath, listed)
    }
    if (content) this.status.invalidate()
    if (structure) this.files.invalidate()
    return { structure, content, records: [...records], maps: [...maps] }
  }

  /**
   * Whether a `rename` event added or removed something. A path that exists and is listed was saved
   * by renaming over it; one that is gone and was never listed (an editor's temporary file) changed nothing.
   */
  private async addedOrRemoved(relPath: string, listed: ReadonlySet<string> | null): Promise<boolean> {
    if (!listed) return true
    const exists = await access(path.join(this.root, relPath)).then(
      () => true,
      () => false
    )
    if (exists) return !listed.has(relPath)
    if (listed.has(relPath)) return true
    const folder = `${relPath}/`
    for (const file of listed) if (file.startsWith(folder)) return true
    return false
  }

  private async loadStatus(): Promise<StatusSnapshot> {
    const snapshot = await this.git.statusSnapshot((file) => this.untrackedLines(file))
    const untracked = new Set(snapshot.changes.unstaged.filter((change) => change.status === 'U').map((change) => change.path))
    for (const file of this.lineCounts.keys()) if (!untracked.has(file)) this.lineCounts.delete(file)
    return snapshot
  }

  private async untrackedLines(file: string): Promise<number> {
    const info = await stat(path.join(this.root, file)).catch(() => null)
    if (!info) return 0
    const known = this.lineCounts.get(file)
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.lines
    const lines = await this.git.lineCount(file)
    this.lineCounts.set(file, { size: info.size, mtimeMs: info.mtimeMs, lines })
    return lines
  }
}
