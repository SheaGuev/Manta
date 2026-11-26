import { readFile, writeFile, mkdir, access, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import { DocStore } from './docs/docStore'
import { Git, isSafeRef, type Changes } from './repo/git'
import { RepoCache } from './repo/repoCache'
import { ReviewCommentStore } from './review/reviewComments'
import type { BranchSummary, CommitScope, ContentMatch, FileChange, OpResult } from '../shared/ipc'
import { LivingDoc, RENDERER_ORIGIN, type DocContext } from './docs/livingDoc'
import { applyTextEdits, computeTextEdits } from './docs/textEdits'
import { MANTA_DIR } from './threads/threadRecords'
import type { ThreadOptions } from './threadTurns'
import { WorkspaceMaps, type MapOptions } from './workspaceMaps'
import { WorkspaceThreads, type WorkspaceAccess } from './workspaceThreads'

/** Forwards CRDT updates that did not come from the editor (external edits, pulls) to it. */
export type UpdateListener = (relPath: string, update: Uint8Array) => void

export type { ThreadEventListener } from './threadTurns'

export type WorkspaceOptions = ThreadOptions & MapOptions

const WRITE_DEBOUNCE_MS = 300
/** Enough to scan; past this the user should narrow the query rather than scroll. */
const MAX_CONTENT_MATCHES = 500
const MAX_MATCHES_PER_FILE = 20
/** How far back the Branch tab's Commits list goes. */
const MAX_COMMITS = 100
/** Minified files put a whole bundle on one line; show the part around the match instead. */
const MAX_MATCH_TEXT = 200
/** The origin of a formatter's edits: not the renderer's, so they reach the editor like any outside change. */
const FORMAT_ORIGIN = Symbol('format')

/**
 * An open docs repo. Every operation that touches the working tree or git runs through one
 * serial queue, so a debounced write can never land in the middle of a pull.
 */
export class Workspace {
  private readonly docs = new Map<string, LivingDoc>()
  private readonly writeTimers = new Map<string, NodeJS.Timeout>()
  private mainCheckoutPath: Promise<string> | null = null
  private tail: Promise<unknown> = Promise.resolve()
  readonly threads: WorkspaceThreads
  /** The context maps in `.manta/maps/`; a docs repo's, though every workspace has the folder's API. */
  readonly maps: WorkspaceMaps
  /** Git status and the file list as the panels show them, refreshed only when something changed. */
  readonly cache: RepoCache
  /** Review comments on this worktree's diffs, in its own git dir, so removing the worktree removes them. */
  readonly review: ReviewCommentStore

  /** For the PR tab, which reads remotes and pushes the branch. */
  get git(): Git {
    return this.ctx.git
  }

  private constructor(
    private readonly ctx: DocContext,
    private readonly onUpdate: UpdateListener,
    mantaDir: string,
    options: WorkspaceOptions
  ) {
    this.cache = new RepoCache(ctx.git, ctx.repoRoot)
    this.review = new ReviewCommentStore(async () => path.join(mantaDir, 'review-comments.json'))
    const access: WorkspaceAccess = {
      repoRoot: ctx.repoRoot,
      git: ctx.git,
      serial: (task) => this.serial(task),
      doc: async (relPath) => this.docs.get(relPath) ?? (await this.load(relPath)),
      docs: () => this.docs.values(),
      absorbDisk: (doc) => this.absorbDisk(doc),
      writeNow: (doc) => this.writeNow(doc)
    }
    this.threads = new WorkspaceThreads(access, mantaDir, options)
    this.maps = new WorkspaceMaps(access, mantaDir, options)
  }

  static async open(repoRoot: string, onUpdate: UpdateListener, options: WorkspaceOptions = {}): Promise<Workspace> {
    const git = new Git(repoRoot, [MANTA_DIR])
    if (!(await git.isRepoRoot())) throw new Error(`${repoRoot} is not the top-level folder of a git repository`)
    await git.excludeLocally(`/${MANTA_DIR}/`)
    const mantaDir = path.join(await git.gitDir(), 'manta')
    const store = new DocStore(path.join(mantaDir, 'docs'))
    const workspace = new Workspace({ repoRoot, git, store }, onUpdate, mantaDir, options)
    // Load every doc with stored state up front, so edits made while the app was closed are
    // absorbed before anything can commit or pull over them.
    for (const relPath of await store.listDocs()) await workspace.load(relPath)
    await workspace.threads.adoptRecords()
    return workspace
  }

  get repoRoot(): string {
    return this.ctx.repoRoot
  }

  listFiles(scope: 'docs' | 'all' = 'docs'): Promise<string[]> {
    return scope === 'docs' ? this.ctx.git.listMarkdown() : this.ctx.git.listFiles()
  }

  changes(): Promise<Changes> {
    return this.ctx.git.changes()
  }

  /** Stages `paths`. Thread records stay out of git (`MANTA_DIR`). */
  stage(paths: readonly string[]): Promise<OpResult> {
    for (const relPath of paths) this.insideRepo(relPath)
    return this.serial(async () => {
      await this.flushWrites()
      await this.threads.exportRecords()
      const docs = this.loadedDocs(paths)
      await this.ctx.git.stage(paths)
      for (const doc of docs) await doc.markStaged()
      return { ok: true, message: `Staged ${plural(paths.length, 'file')}` }
    })
  }

  /** Unstages `paths`. */
  unstage(paths: readonly string[]): Promise<OpResult> {
    for (const relPath of paths) this.insideRepo(relPath)
    return this.serial(async () => {
      const docs = this.loadedDocs(paths)
      await this.ctx.git.unstage(paths)
      for (const doc of docs) await doc.clearStaged()
      return { ok: true, message: `Unstaged ${plural(paths.length, 'file')}` }
    })
  }

  /**
   * Puts `paths` back to their staged version (untracked files are deleted) after `confirm`
   * agrees; null when it doesn't. Open docs take the restored text as an outside edit, so
   * threads anchored to text that's gone show as detached.
   */
  async discardChanges(paths: readonly string[], confirm: (summary: DiscardSummary) => Promise<boolean>): Promise<OpResult | null> {
    for (const relPath of paths) this.insideRepo(relPath)
    const requested = new Set(paths)
    const untracked = (await this.ctx.git.changes()).unstaged.filter((change) => change.status === 'U' && requested.has(change.path))
    const docsWithThreads = this.loadedDocs(paths).filter((doc) => this.threads.hasThreads(doc)).map((doc) => doc.relPath)
    if (!(await confirm({ paths, deleted: untracked.length, docsWithThreads }))) return null
    return this.serial(async () => {
      // Flushing first cancels pending writes, which would otherwise put the discarded text back.
      await this.flushWrites()
      await this.ctx.git.discard(paths)
      for (const doc of this.loadedDocs(paths)) await this.absorbDisk(doc)
      return { ok: true, message: `Discarded changes to ${plural(paths.length, 'file')}` }
    })
  }

  async searchContent(query: string): Promise<ContentMatch[]> {
    const matches = await this.ctx.git.grep(query, MAX_MATCHES_PER_FILE)
    return matches.slice(0, MAX_CONTENT_MATCHES).map((match) => ({ ...match, text: excerpt(match.text, query) }))
  }

  /** An empty file at `relPath`; fails if anything is already there. */
  createFile(relPath: string): Promise<void> {
    const absolute = this.insideRepo(relPath)
    return this.serial(async () => {
      if (await exists(absolute)) throw new Error(`${relPath} already exists`)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, '')
    })
  }

  createFolder(relPath: string): Promise<void> {
    const absolute = this.insideRepo(relPath)
    return this.serial(async () => {
      if (await exists(absolute)) throw new Error(`${relPath} already exists`)
      await mkdir(absolute, { recursive: true })
    })
  }

  /**
   * Removes a file or a folder after `confirm` agrees; null when it doesn't. `remove` does the deleting,
   * so main can move it to the Trash. Open docs under it are dropped first, so a pending write can't
   * bring the file back; their CRDT state is kept, so a file restored later keeps its threads.
   */
  async deletePath(
    relPath: string,
    confirm: (summary: DeleteSummary) => Promise<boolean>,
    remove: (absolute: string) => Promise<void> = (absolute) => rm(absolute, { recursive: true })
  ): Promise<OpResult | null> {
    const absolute = this.insideRepo(relPath)
    const info = await stat(absolute).catch(() => null)
    if (!info) return { ok: false, message: `${relPath} no longer exists` }
    const folder = info.isDirectory()
    const under = (file: string): boolean => file === relPath || file.startsWith(`${relPath}/`)
    const files = folder ? (await this.ctx.git.listFiles([`:(literal)${relPath}`])).length : 1
    const docsWithThreads = [...this.docs.values()].filter((doc) => under(doc.relPath) && this.threads.hasThreads(doc)).map((doc) => doc.relPath)
    if (!(await confirm({ relPath, folder, files, docsWithThreads }))) return null
    return this.serial(async () => {
      for (const doc of [...this.docs.values()].filter((d) => under(d.relPath))) {
        clearTimeout(this.writeTimers.get(doc.relPath))
        this.writeTimers.delete(doc.relPath)
        this.docs.delete(doc.relPath)
      }
      await remove(absolute)
      return { ok: true, message: `Deleted ${relPath}` }
    })
  }

  /** The committed version of a file, for diffing. Null when it is new since HEAD. */
  fileAtHead(relPath: string): Promise<string | null> {
    return this.ctx.git.show('HEAD', relPath)
  }

  /** A file as committed in `sha`, for a committed diff. Null when it doesn't exist there. */
  fileAt(sha: string, relPath: string): Promise<string | null> {
    return this.ctx.git.show(sha, relPath)
  }

  /**
   * What this branch has committed since its base, and its newest commits. The base is `chosen` when
   * given; one that no longer resolves falls back to the default and comes back as `missingBase`.
   */
  async branch(chosen: string | null = null): Promise<BranchSummary> {
    if (chosen !== null && !isSafeRef(chosen)) throw new Error(`Invalid branch ${chosen}`)
    const git = this.ctx.git
    const missingBase = chosen !== null && !(await git.resolve(chosen)) ? chosen : null
    const [base, head] = await Promise.all([git.branchBase(missingBase ? null : chosen), git.resolve('HEAD')])
    const [files, commits] = await Promise.all([base && head ? git.diffFiles(base.sha, head) : [], git.log(MAX_COMMITS, base?.sha ?? null)])
    return { base, head, files, commits, missingBase }
  }

  branches(): Promise<string[]> {
    return this.ctx.git.branches()
  }

  commitFiles(sha: string): Promise<FileChange[]> {
    return this.ctx.git.commitFiles(sha)
  }

  /** Full CRDT state for the editor replica to start from. */
  openDoc(relPath: string): Promise<Uint8Array> {
    return this.serial(async () => {
      const doc = this.docs.get(relPath) ?? (await this.load(relPath))
      if (!doc) throw new Error(`${relPath} does not exist`)
      return Y.encodeStateAsUpdate(doc.ydoc)
    })
  }

  createDoc(relPath: string): Promise<{ relPath: string; state: Uint8Array }> {
    const normalized = relPath.endsWith('.md') ? relPath : `${relPath}.md`
    const absolute = this.insideRepo(normalized)
    return this.serial(async () => {
      if (await exists(absolute)) throw new Error(`${normalized} already exists`)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, `# ${path.basename(normalized, '.md')}\n`)
    }).then(async () => ({ relPath: normalized, state: await this.openDoc(normalized) }))
  }

  applyEditorUpdate(relPath: string, update: Uint8Array): void {
    const doc = this.docs.get(relPath)
    if (!doc) return
    Y.applyUpdate(doc.ydoc, update, RENDERER_ORIGIN)
  }

  /** An open doc's current text, with every editor update applied so far; null when it isn't open. */
  docText(relPath: string): Promise<string | null> {
    return this.serial(async () => this.docs.get(relPath)?.text.toString() ?? null)
  }

  /**
   * Replaces an open doc's text with a formatter's output as minimal edits, so cursors, undo and thread
   * anchors survive, then saves it. `changed` when the text moved on while the formatter ran: nothing is applied.
   */
  applyFormatted(relPath: string, { before, after }: { before: string; after: string }): Promise<'applied' | 'unchanged' | 'changed'> {
    return this.serial(async () => {
      const doc = this.docs.get(relPath)
      if (!doc || doc.text.toString() !== before) return 'changed'
      if (after !== before) doc.ydoc.transact(() => applyTextEdits(doc.text, computeTextEdits(before, after)), FORMAT_ORIGIN)
      await this.writeNow(doc)
      return after === before ? 'unchanged' : 'applied'
    })
  }

  /** The repo's main checkout, where a worktree's tools (`node_modules`) usually are installed. */
  mainCheckout(): Promise<string> {
    this.mainCheckoutPath ??= this.ctx.git.worktrees().then(
      (list) => list.find((w) => w.isMain)?.path ?? this.repoRoot,
      () => this.repoRoot
    )
    return this.mainCheckoutPath
  }

  /** Writes a doc to disk now rather than on the debounce: Cmd+S, or an edit a language server must read. */
  saveNow(relPath: string): Promise<void> {
    return this.serial(async () => {
      const doc = this.docs.get(relPath)
      if (doc) await this.writeNow(doc)
    })
  }

  /** Called by the file watcher for any changed path under the repo. */
  fileChanged(relPath: string): Promise<void> {
    const doc = this.docs.get(relPath)
    if (!doc) return Promise.resolve()
    return this.serial(() => this.absorbDisk(doc))
  }

  /** With `staged` and nothing staged, commits everything, like VS Code's smart commit. */
  commit(message: string, scope: CommitScope = 'all'): Promise<OpResult> {
    return this.serial(async () => {
      await this.flushWrites()
      if (scope === 'staged' && (await this.ctx.git.hasStagedChanges())) {
        const sha = await this.ctx.git.commitStaged(message)
        // Unstaged docs keep their old text in this commit, staged ones their staged snapshot: reconcileHead matches either.
        for (const doc of this.docs.values()) await doc.reconcileHead(sha)
        return { ok: true, message: `Committed ${sha.slice(0, 7)}` }
      }
      await this.threads.exportRecords()
      if (!(await this.ctx.git.hasChanges())) return { ok: true, message: 'Nothing to commit' }
      const sha = await this.ctx.git.commitAll(message)
      for (const doc of this.docs.values()) await doc.markCommitted(sha)
      return { ok: true, message: `Committed ${sha.slice(0, 7)}` }
    })
  }

  /** Whether there is an `origin` to push to. */
  async hasOrigin(): Promise<boolean> {
    return (await this.ctx.git.remotes()).some((remote) => remote.name === 'origin')
  }

  push(): Promise<OpResult> {
    return this.serial(async () => {
      const { git } = this.ctx
      const branch = await git.currentBranch()
      if (!branch) return { ok: false, message: 'Not on a branch' }
      try {
        await git.pushBranch(branch, !(await git.upstream()))
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      return { ok: true, message: `Pushed ${branch}` }
    })
  }

  pull(): Promise<OpResult> {
    return this.serial(async () => {
      const { git } = this.ctx
      await this.flushWrites()
      const upstream = await git.upstream()
      if (!upstream) return { ok: false, message: 'Current branch has no upstream to pull from' }
      await git.fetch()
      const head = await git.resolve('HEAD')
      const target = await git.resolve(upstream)
      if (!head || !target) return { ok: false, message: 'Could not resolve HEAD or upstream' }
      if (head === target || (await git.isAncestor(target, head))) return { ok: true, message: 'Already up to date' }
      if (!(await git.isAncestor(head, target))) {
        return { ok: false, message: `Local and ${upstream} have diverged; merging diverged history is not supported yet` }
      }

      const changed = new Set(await git.changedFiles(head, target))
      const affected: { doc: LivingDoc; upstreamText: string }[] = []
      for (const doc of this.docs.values()) {
        if (!changed.has(doc.relPath)) continue
        if (!(await doc.reconcileHead(head))) {
          return { ok: false, message: `${doc.relPath} changed outside Manta since its last commit; commit it first` }
        }
        const upstreamText = await git.show(target, doc.relPath)
        if (upstreamText === null) {
          return { ok: false, message: `${doc.relPath} was deleted upstream; not supported yet` }
        }
        affected.push({ doc, upstreamText })
      }

      // Put the affected files back to their committed text so git can fast-forward over
      // them; in-app edits stay in the CRDT and are written back after the merge.
      for (const { doc } of affected) await doc.writeSyncPointToDisk()
      try {
        await git.mergeFastForward(target)
      } catch (error) {
        for (const { doc } of affected) await doc.writeToDisk()
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      for (const { doc, upstreamText } of affected) {
        await doc.mergeUpstream(target, upstreamText)
        await doc.writeToDisk()
      }
      for (const doc of this.docs.values()) await doc.reconcileHead(target)
      await this.threads.adoptRecords()
      return { ok: true, message: `Pulled ${target.slice(0, 7)} (${affected.length} doc(s) merged)` }
    })
  }

  close(): void {
    this.threads.close()
    this.maps.close()
    for (const timer of this.writeTimers.values()) clearTimeout(timer)
    this.writeTimers.clear()
  }

  /** Resolves once all queued work has finished. */
  idle(): Promise<void> {
    return this.serial(async () => {
      await this.flushWrites()
    })
  }

  private async load(relPath: string): Promise<LivingDoc | null> {
    const doc = await LivingDoc.open(relPath, this.ctx)
    if (!doc) return null
    this.docs.set(relPath, doc)
    doc.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== RENDERER_ORIGIN) this.onUpdate(relPath, update)
      this.scheduleWrite(relPath)
    })
    return doc
  }

  private scheduleWrite(relPath: string): void {
    clearTimeout(this.writeTimers.get(relPath))
    this.writeTimers.set(
      relPath,
      setTimeout(() => {
        this.writeTimers.delete(relPath)
        this.serial(async () => {
          await this.docs.get(relPath)?.writeToDisk()
        }).catch((error: unknown) => console.error(`manta: failed to write ${relPath}`, error))
      }, WRITE_DEBOUNCE_MS)
    )
  }

  /**
   * Brings disk and CRDT into agreement for every doc: absorbs outside edits the watcher hasn't
   * delivered yet, then writes pending in-app edits. Must run inside `serial`.
   */
  private async flushWrites(): Promise<void> {
    for (const [relPath, timer] of this.writeTimers) {
      clearTimeout(timer)
      this.writeTimers.delete(relPath)
    }
    for (const doc of this.docs.values()) {
      await this.absorbDisk(doc)
      await doc.writeToDisk()
    }
  }

  /** Absorbs an outside edit the watcher hasn't delivered yet. Must run inside `serial`. */
  private async absorbDisk(doc: LivingDoc): Promise<void> {
    const disk = await readFile(path.join(this.repoRoot, doc.relPath), 'utf8').catch(() => null)
    if (disk !== null) await doc.absorbDiskChange(disk)
  }

  /** Writes now rather than on the debounce. Must run inside `serial`. */
  private async writeNow(doc: LivingDoc): Promise<void> {
    clearTimeout(this.writeTimers.get(doc.relPath))
    this.writeTimers.delete(doc.relPath)
    await doc.writeToDisk()
  }

  private loadedDocs(paths: readonly string[]): LivingDoc[] {
    return paths.flatMap((relPath) => this.docs.get(relPath) ?? [])
  }

  private insideRepo(relPath: string): string {
    const absolute = path.join(this.repoRoot, relPath)
    const top = absolute.slice(this.repoRoot.length + 1).split(path.sep)[0]
    if (!absolute.startsWith(this.repoRoot + path.sep) || top === '.git') throw new Error('Files must live inside the repo')
    return absolute
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.catch(() => undefined)
    return result
  }
}

/** What deleting would remove, for the confirmation. */
export interface DeleteSummary {
  relPath: string
  folder: boolean
  /** Files git lists under it (tracked or untracked, not ignored); 1 for a file. */
  files: number
  /** Open docs under it that have threads. */
  docsWithThreads: string[]
}

/** What discarding would do, for the confirmation. */
export interface DiscardSummary {
  paths: readonly string[]
  /** Untracked files among `paths`, which are deleted. */
  deleted: number
  /** Docs among `paths` that have threads, whose anchors may detach. */
  docsWithThreads: string[]
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function excerpt(text: string, query: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_MATCH_TEXT) return trimmed
  const at = Math.max(0, trimmed.toLowerCase().indexOf(query.toLowerCase()) - MAX_MATCH_TEXT / 4)
  const end = at + MAX_MATCH_TEXT
  return `${at > 0 ? '…' : ''}${trimmed.slice(at, end)}${end < trimmed.length ? '…' : ''}`
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}
