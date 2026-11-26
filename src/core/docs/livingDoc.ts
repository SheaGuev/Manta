import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import type { DocMeta, DocStore, Snapshot, SyncPoint } from './docStore'
import type { Git } from '../repo/git'
import { mergeTextChange } from './textEdits'

/** Transaction origin for updates that arrived from the editor replica, so they aren't echoed back. */
export const RENDERER_ORIGIN = Symbol('renderer')
const EXTERNAL_ORIGIN = Symbol('external')
const LOAD_ORIGIN = Symbol('load')

export interface DocContext {
  repoRoot: string
  git: Git
  store: DocStore
}

/**
 * One markdown file, with a Yjs CRDT as the source of truth. The file on disk is an export of
 * the CRDT; outside changes (another editor, a git pull) come back in as minimal CRDT ops, so
 * unchanged text keeps its identity.
 */
export class LivingDoc {
  readonly ydoc = new Y.Doc()
  readonly text = this.ydoc.getText('md')
  /** Which actor made each external change, keyed by the Yjs client id that wrote it. */
  readonly actors = this.ydoc.getMap<string>('actors')

  private constructor(
    readonly relPath: string,
    private readonly ctx: DocContext,
    private meta: DocMeta
  ) { }

  /** Opens the doc's stored CRDT, or creates one from git HEAD and the working tree. Null when the file is missing. */
  static async open(relPath: string, ctx: DocContext): Promise<LivingDoc | null> {
    const disk = await readDisk(ctx.repoRoot, relPath)
    if (disk === null) return null
    if (disk.includes('\0')) throw new Error(`${relPath} looks like a binary file and can't be edited`)

    const stored = await ctx.store.load(relPath)
    if (stored) {
      const doc = new LivingDoc(relPath, ctx, stored.meta)
      Y.applyUpdate(doc.ydoc, stored.update, LOAD_ORIGIN)
      doc.persistUpdates()
      await doc.absorbDiskChange(disk)
      return doc
    }

    // First open: seed from the committed version when there is one, then replay any
    // uncommitted working-tree changes on top, so the sync point matches HEAD exactly.
    const head = await ctx.git.resolve('HEAD')
    const headText = head ? await ctx.git.show(head, relPath) : null
    const seed = headText ?? disk
    const doc = new LivingDoc(relPath, ctx, { lastDisk: { text: seed, state: new Uint8Array() }, syncPoint: null, staged: null })
    doc.ydoc.transact(() => doc.text.insert(0, seed), LOAD_ORIGIN)
    const seedSnapshot: Snapshot = { text: seed, state: Y.encodeStateAsUpdate(doc.ydoc) }
    doc.meta = {
      lastDisk: seedSnapshot,
      syncPoint: head && headText !== null ? { commit: head, ...seedSnapshot } : null,
      staged: null
    }
    await ctx.store.appendUpdate(relPath, seedSnapshot.state)
    doc.persistUpdates()
    if (disk !== seed) await doc.absorbDiskChange(disk)
    else await ctx.store.saveMeta(relPath, doc.meta)
    return doc
  }

  get syncPoint(): SyncPoint | null {
    return this.meta.syncPoint
  }

  get diskText(): string {
    return this.meta.lastDisk.text
  }

  /** Merges a working-tree edit made outside the app. Returns false when the disk already matches. */
  async absorbDiskChange(diskText: string): Promise<boolean> {
    if (diskText === this.meta.lastDisk.text) return false
    const state = this.mergeExternal(this.meta.lastDisk, diskText, 'disk')
    this.meta = { ...this.meta, lastDisk: { text: diskText, state } }
    await this.ctx.store.saveMeta(this.relPath, this.meta)
    return true
  }

  /** Writes the CRDT's text to the working tree. Returns false when nothing changed. */
  async writeToDisk(): Promise<boolean> {
    const text = this.text.toString()
    if (text === this.meta.lastDisk.text) return false
    // lastDisk is set before the write so the file watcher recognises the app's own write.
    this.meta = { ...this.meta, lastDisk: { text, state: Y.encodeStateAsUpdate(this.ydoc) } }
    await writeFile(path.join(this.ctx.repoRoot, this.relPath), text)
    await this.ctx.store.saveMeta(this.relPath, this.meta)
    return true
  }

  /** Marks the current disk contents as committed in `commit`. Call only right after committing them. */
  async markCommitted(commit: string): Promise<void> {
    this.meta = { ...this.meta, syncPoint: { commit, ...this.meta.lastDisk }, staged: null }
    await this.ctx.store.saveMeta(this.relPath, this.meta)
  }

  /** Records the current disk contents as staged. Call right after staging them. */
  async markStaged(): Promise<void> {
    this.meta = { ...this.meta, staged: this.meta.lastDisk }
    await this.ctx.store.saveMeta(this.relPath, this.meta)
  }

  async clearStaged(): Promise<void> {
    if (!this.meta.staged) return
    this.meta = { ...this.meta, staged: null }
    await this.ctx.store.saveMeta(this.relPath, this.meta)
  }

  /**
   * Re-aligns the sync point when HEAD moved without `markCommitted`: a commit of the index, a
   * terminal commit or a pull. The staged snapshot covers a doc staged and then edited further.
   * Returns false when the new HEAD's version of this file can't be matched to a CRDT state;
   * the doc must be committed from the app before it can pull.
   */
  async reconcileHead(head: string): Promise<boolean> {
    const syncPoint = this.meta.syncPoint
    if (syncPoint?.commit === head) return true
    const headText = await this.ctx.git.show(head, this.relPath)
    if (headText === null) return false
    if (headText === syncPoint?.text) {
      this.meta = { ...this.meta, syncPoint: { ...syncPoint, commit: head } }
    } else if (headText === this.meta.lastDisk.text) {
      this.meta = { ...this.meta, syncPoint: { commit: head, ...this.meta.lastDisk } }
    } else if (headText === this.meta.staged?.text) {
      this.meta = { ...this.meta, syncPoint: { commit: head, ...this.meta.staged }, staged: null }
    } else {
      return false
    }
    await this.ctx.store.saveMeta(this.relPath, this.meta)
    return true
  }

  /**
   * Applies an upstream commit's version of this file: forks the CRDT at the sync point,
   * replays `syncPoint.text → upstreamText` as ops, and merges the fork into the live doc.
   * In-app edits made since the sync point survive as concurrent edits.
   */
  async mergeUpstream(commit: string, upstreamText: string): Promise<void> {
    const syncPoint = this.meta.syncPoint
    if (!syncPoint) throw new Error(`${this.relPath} has no sync point to merge upstream changes onto`)
    const state = this.mergeExternal(syncPoint, upstreamText, `git:${commit.slice(0, 12)}`)
    this.meta = { ...this.meta, syncPoint: { commit, text: upstreamText, state } }
    await this.ctx.store.saveMeta(this.relPath, this.meta)
  }

  /** Writes the sync point's text to disk, so git sees the file as unmodified. */
  async writeSyncPointToDisk(): Promise<void> {
    const syncPoint = this.meta.syncPoint
    if (!syncPoint) throw new Error(`${this.relPath} has no sync point`)
    this.meta = { ...this.meta, lastDisk: { text: syncPoint.text, state: syncPoint.state } }
    await writeFile(path.join(this.ctx.repoRoot, this.relPath), syncPoint.text)
    await this.ctx.store.saveMeta(this.relPath, this.meta)
  }

  private mergeExternal(base: Snapshot, newText: string, actor: string): Uint8Array {
    try {
      return mergeTextChange(this.ydoc, base, newText, actor, EXTERNAL_ORIGIN)
    } catch (error) {
      throw new Error(`${this.relPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private persistUpdates(): void {
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) return
      this.ctx.store.appendUpdate(this.relPath, update).catch((error: unknown) => {
        console.error(`manta: failed to persist update for ${this.relPath}`, error)
      })
    })
  }
}

async function readDisk(repoRoot: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(repoRoot, relPath), 'utf8')
  } catch {
    return null
  }
}
