import { mkdir, readFile, readdir, rename, writeFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'

export interface Snapshot {
  text: string
  state: Uint8Array
}

/** The CRDT state that matches a git commit's version of a file. Pulls fork from here. */
export interface SyncPoint extends Snapshot {
  commit: string
}

export interface DocMeta {
  /** What the app last wrote to (or read from) the working tree, and the CRDT state at that moment. */
  lastDisk: Snapshot
  syncPoint: SyncPoint | null
  /** The disk contents when the doc was last staged, so a commit of the index can become the sync point. Null when not staged. */
  staged: Snapshot | null
}

export interface StoredDoc {
  update: Uint8Array
  meta: DocMeta
}

interface MetaJson {
  lastDiskText: string
  syncPoint: { commit: string; text: string } | null
  /** Absent in meta written before staging existed. */
  staged?: { text: string } | null
}

/**
 * Per-doc CRDT persistence: an append-only Yjs update log plus the two snapshots pulls and
 * external edits fork from. Lives under `.git/manta/` so it stays out of the working tree,
 * out of commits, and out of Obsidian's view.
 */
export class DocStore {
  private readonly queues = new Map<string, Promise<void>>()
  /** The sync-point and staged states on disk for each doc, by reference. */
  private readonly written = new Map<string, { syncPoint: Uint8Array | null; staged: Uint8Array | null }>()

  constructor(readonly root: string) {}

  async listDocs(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => decodeURIComponent(e.name))
    } catch {
      return []
    }
  }

  load(relPath: string): Promise<StoredDoc | null> {
    return this.enqueue(relPath, async (dir) => {
      let metaJson: MetaJson
      try {
        metaJson = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf8'))
      } catch {
        return null
      }
      const update = Y.mergeUpdates(decodeLog(await readFile(path.join(dir, 'log.bin'))))
      await atomicWrite(path.join(dir, 'log.bin'), encodeLogEntry(update))
      const meta: DocMeta = {
        lastDisk: { text: metaJson.lastDiskText, state: await readFile(path.join(dir, 'last-disk.bin')) },
        syncPoint: metaJson.syncPoint
          ? { ...metaJson.syncPoint, state: await readFile(path.join(dir, 'sync-point.bin')) }
          : null,
        staged: metaJson.staged ? { text: metaJson.staged.text, state: await readFile(path.join(dir, 'staged.bin')) } : null
      }
      this.written.set(relPath, { syncPoint: meta.syncPoint?.state ?? null, staged: meta.staged?.state ?? null })
      return { update, meta }
    })
  }

  appendUpdate(relPath: string, update: Uint8Array): Promise<void> {
    return this.enqueue(relPath, async (dir) => {
      await appendFile(path.join(dir, 'log.bin'), encodeLogEntry(update))
    })
  }

  /**
   * Most saves only move `lastDisk`; the sync point and staged states change on commit, pull and
   * staging. Their files are rewritten only when the state differs from the one last written or loaded.
   */
  saveMeta(relPath: string, meta: DocMeta): Promise<void> {
    return this.enqueue(relPath, async (dir) => {
      const written = this.written.get(relPath) ?? { syncPoint: null, staged: null }
      await atomicWrite(path.join(dir, 'last-disk.bin'), meta.lastDisk.state)
      if (meta.syncPoint && meta.syncPoint.state !== written.syncPoint) await atomicWrite(path.join(dir, 'sync-point.bin'), meta.syncPoint.state)
      if (meta.staged && meta.staged.state !== written.staged) await atomicWrite(path.join(dir, 'staged.bin'), meta.staged.state)
      this.written.set(relPath, { syncPoint: meta.syncPoint?.state ?? null, staged: meta.staged?.state ?? null })
      const json: MetaJson = {
        lastDiskText: meta.lastDisk.text,
        syncPoint: meta.syncPoint ? { commit: meta.syncPoint.commit, text: meta.syncPoint.text } : null,
        staged: meta.staged ? { text: meta.staged.text } : null
      }
      // meta.json goes last: load() treats its presence as "this doc's files are complete".
      await atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(json))
    })
  }

  private dirFor(relPath: string): string {
    return path.join(this.root, encodeURIComponent(relPath))
  }

  /** Serialises all file access per doc, so appends, snapshots and compaction never interleave. */
  private enqueue<T>(relPath: string, task: (dir: string) => Promise<T>): Promise<T> {
    const dir = this.dirFor(relPath)
    const previous = this.queues.get(relPath) ?? Promise.resolve()
    const next = previous.then(async () => {
      await mkdir(dir, { recursive: true })
      return task(dir)
    })
    this.queues.set(relPath, next.then(() => undefined, () => undefined))
    return next
  }
}

function encodeLogEntry(update: Uint8Array): Uint8Array {
  const entry = new Uint8Array(4 + update.length)
  new DataView(entry.buffer).setUint32(0, update.length)
  entry.set(update, 4)
  return entry
}

function decodeLog(buffer: Uint8Array): Uint8Array[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const updates: Uint8Array[] = []
  let offset = 0
  // A crash mid-append leaves a truncated tail; drop it rather than fail the whole doc.
  while (offset + 4 <= buffer.length) {
    const length = view.getUint32(offset)
    if (offset + 4 + length > buffer.length) break
    updates.push(buffer.subarray(offset + 4, offset + 4 + length))
    offset += 4 + length
  }
  return updates
}

async function atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, data)
  await rename(tmp, file)
}
