import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import type { ImplementationLink, MapProposer, OpResult, PermissionDecision, ThreadLanded, ThreadRef } from '../shared/ipc'
import type { LivingDoc } from './docs/livingDoc'
import { changedRanges } from './docs/textEdits'
import type { Git } from './repo/git'
import { ThreadFork, ThreadForkStore, type ThreadProposal } from './threads/threadForks'
import { implementationBrief } from './threads/implementationBrief'
import { ThreadRecordStore } from './threads/threadRecords'
import { ThreadTurns, type PreparedTurn, type ThreadOptions } from './threadTurns'
import { newThreadId, recordIsStale, sectionAt, ThreadIndex, type TextRange, type ThreadEntry, type ThreadInfo, type ThreadMessage, type ThreadRecord, type ThreadStatus } from './threads/threads'

/** What the thread code may use from its `Workspace`. Methods marked "inside `serial` only" never queue. */
export interface WorkspaceAccess {
  readonly repoRoot: string
  readonly git: Git
  serial<T>(task: () => Promise<T>): Promise<T>
  /** Loaded, or loaded now; null when the file doesn't exist. Inside `serial` only. */
  doc(relPath: string): Promise<LivingDoc | null>
  docs(): Iterable<LivingDoc>
  /** Absorbs an outside edit the watcher hasn't delivered yet. Inside `serial` only. */
  absorbDisk(doc: LivingDoc): Promise<void>
  /** Cancels the debounced write and writes now. Inside `serial` only. */
  writeNow(doc: LivingDoc): Promise<void>
}

/** Inside a folder so it can never collide with the doc's checkout, which sits at the top of the thread folder. */
const PARENT_THREADS_FILE = path.join('.manta', 'parent-threads.md')
const THREAD_ORIGIN = Symbol('thread')

/** The threads of one workspace's docs: their entries, records, forks and agent turns. */
export class WorkspaceThreads {
  private readonly records: ThreadRecordStore
  private readonly forkStore: ThreadForkStore
  private readonly forks = new Map<string, ThreadFork>()
  private readonly turns: ThreadTurns

  constructor(
    private readonly access: WorkspaceAccess,
    mantaDir: string,
    options: ThreadOptions
  ) {
    this.records = new ThreadRecordStore(access.repoRoot)
    this.forkStore = new ThreadForkStore(path.join(mantaDir, 'threads'))
    this.turns = new ThreadTurns(
      {
        begin: (relPath, id, text, threadsDir) => this.beginTurn(relPath, id, text, threadsDir),
        absorbCheckout: (relPath, id, file) => this.absorbCheckout(relPath, id, file),
        saveSession: (id, session) => this.forkStore.saveSession(id, session),
        finish: (relPath, id, transcript) =>
          this.access.serial(async () => this.appendTranscript((await this.locate(relPath, id)).index, relPath, id, transcript))
      },
      options
    )
  }

  create(relPath: string, range: TextRange, title: string): Promise<ThreadInfo> {
    return this.access.serial(async () => {
      const doc = await this.requireDoc(relPath)
      const threads = new ThreadIndex(doc.ydoc)
      const id = newThreadId()
      threads.create(id, range, { title, status: 'open', parent: null, createdAt: new Date().toISOString() })
      await this.records.write(threads.toRecord(id, relPath, null))
      const fork = ThreadFork.from(doc.ydoc)
      this.forks.set(id, fork)
      await this.forkStore.save(id, fork)
      return threadInfo(threads, relPath, id)
    })
  }

  /**
   * Starts an implementation thread on the section containing `from.offset`, or on the section of
   * the doc thread `from.thread`. It has no fork: the work runs in `link`'s Claude Code session.
   */
  createImplementation(
    relPath: string,
    from: { offset: number } | { thread: string },
    title: string,
    link: Omit<ImplementationLink, 'source' | 'hidden' | 'pr'>
  ): Promise<ThreadInfo> {
    return this.access.serial(async () => {
      const doc = await this.requireDoc(relPath)
      const threads = new ThreadIndex(doc.ydoc)
      let range: TextRange | null
      let source: string | null = null
      if ('thread' in from) {
        const entry = threads.get(from.thread)
        if (!entry || entry.parent !== null) throw new Error(`No top-level thread ${from.thread} in ${relPath}`)
        if (entry.implementation) throw new Error('That thread is an implementation already')
        range = threads.resolve(from.thread)
        if (!range) throw new Error("The thread's section is gone from the doc")
        source = from.thread
      } else {
        const text = doc.text.toString()
        range = sectionAt(text, Math.min(Math.max(0, from.offset), text.length))
      }
      const id = newThreadId()
      threads.create(id, range, {
        title,
        status: 'open',
        parent: null,
        createdAt: new Date().toISOString(),
        implementation: { ...link, source, hidden: false, pr: null }
      })
      await this.records.write(threads.toRecord(id, relPath, null))
      return threadInfo(threads, relPath, id)
    })
  }

  /**
   * A doc change proposed from outside the doc (an implementation session): a new thread on the
   * section containing `find`, with `find → replace` already in its fork and `why` as its first
   * agent message. Approved, discarded or discussed like any thread. Refusals explain what to fix.
   */
  propose(relPath: string, change: DocChange): Promise<{ ok: true; thread: ThreadInfo } | { ok: false; message: string }> {
    return this.access.serial(async () => {
      const doc = await this.access.doc(relPath)
      if (!doc) return { ok: false, message: `There is no doc ${relPath} in the docs repo` }
      const text = doc.text.toString()
      const at = text.indexOf(change.find)
      if (!change.find || at === -1) return { ok: false, message: `The text to replace isn't in ${relPath}; read the doc again and quote it exactly` }
      const count = text.split(change.find).length - 1
      if (count > 1) return { ok: false, message: `The text to replace appears ${count} times in ${relPath}; include more of the surrounding text so it appears once` }
      if (change.find === change.replace) return { ok: false, message: 'The replacement is the same as the text it replaces' }

      const threads = new ThreadIndex(doc.ydoc)
      const id = newThreadId()
      threads.create(id, sectionAt(text, at), {
        title: change.title,
        status: 'open',
        parent: null,
        createdAt: new Date().toISOString(),
        ...('map' in change.from.ref ? { proposedByMap: change.from.ref } : { proposedBy: { doc: change.from.ref.doc, thread: change.from.ref.thread } })
      })
      await this.records.write(threads.toRecord(id, relPath, null))
      const fork = ThreadFork.from(doc.ydoc)
      fork.replace(change.find, change.replace)
      this.forks.set(id, fork)
      await this.forkStore.save(id, fork)
      await this.appendTranscript(threads, relPath, id, authorLines('Proposed', change.from, change.why))
      return { ok: true, thread: threadInfo(threads, relPath, id) }
    })
  }

  /** Takes back an open proposal `by` made with `propose`: the thread is discarded, with the reason in its transcript. */
  withdraw(id: string, by: ProposalAuthor, why: string): Promise<{ ok: true; thread: ThreadInfo } | { ok: false; message: string }> {
    return this.access.serial(async () => {
      const own = await this.ownProposal(id, by)
      if (!own.ok) return own
      own.index.setStatus(id, 'discarded')
      await this.appendTranscript(own.index, own.relPath, id, authorLines('Withdrawn', by, why))
      return { ok: true, thread: threadInfo(own.index, own.relPath, id) }
    })
  }

  /**
   * Changes an open proposal `by` made with `propose`. `find` is quoted from the proposed version,
   * so edits the user or the thread agent made in the fork since stay. Throws when `find` isn't there once.
   */
  revise(id: string, by: ProposalAuthor, edit: { find: string; replace: string; why: string }): Promise<{ ok: true; thread: ThreadInfo } | { ok: false; message: string }> {
    return this.access.serial(async () => {
      const own = await this.ownProposal(id, by)
      if (!own.ok) return own
      const fork = await this.fork(own.relPath, id)
      fork.replace(edit.find, edit.replace)
      await this.forkStore.save(id, fork)
      await this.appendTranscript(own.index, own.relPath, id, authorLines('Revised', by, edit.why))
      return { ok: true, thread: threadInfo(own.index, own.relPath, id) }
    })
  }

  /** Inside `serial` only. */
  private async ownProposal(id: string, by: ProposalAuthor): Promise<{ ok: true; relPath: string; index: ThreadIndex } | { ok: false; message: string }> {
    const record = await this.records.read(id)
    const doc = record ? await this.access.doc(record.doc) : null
    const index = doc ? new ThreadIndex(doc.ydoc) : null
    const entry = index?.get(id)
    if (!record || !index || !entry) return { ok: false, message: `There is no proposal ${id}; use the id propose_doc_change returned` }
    if (!sameProposer(entry, by)) return { ok: false, message: `${id} is not a proposal from this ${'map' in by.ref ? 'session' : 'implementation'}` }
    if (entry.status !== 'open') return { ok: false, message: `${id} is already ${entry.status}; propose a new change instead` }
    return { ok: true, relPath: record.doc, index }
  }

  /** Points an implementation thread at a new terminal (or none), records its pull request, or hides its Landed chip. */
  updateImplementation(relPath: string, id: string, change: Partial<Pick<ImplementationLink, 'terminal' | 'hidden' | 'pr'>>): Promise<ThreadInfo> {
    return this.access.serial(async () => {
      const threads = new ThreadIndex((await this.requireDoc(relPath)).ydoc)
      const implementation = threads.get(id)?.implementation
      if (!implementation) throw new Error(`No implementation thread ${id} in ${relPath}`)
      threads.setImplementation(id, { ...implementation, ...change })
      await this.records.write(threads.toRecord(id, relPath, await this.records.read(id)))
      return threadInfo(threads, relPath, id)
    })
  }

  /** The brief an implementation session starts with, from the section and source thread as they are now. */
  implementationBrief(relPath: string, id: string): Promise<string> {
    return this.access.serial(async () => {
      const threads = new ThreadIndex((await this.requireDoc(relPath)).ydoc)
      const entry = threads.get(id)
      if (!entry?.implementation) throw new Error(`No implementation thread ${id} in ${relPath}`)
      const range = threads.resolve(id)
      const section = range ? threads.text.toString().slice(range.from, range.to) : ((await this.records.read(id))?.anchor.quote.exact ?? '')
      const sourceId = entry.implementation.source
      const source = sourceId ? await this.records.read(sourceId) : null
      return implementationBrief({
        threadId: id,
        title: entry.title,
        doc: relPath,
        docsRoot: this.access.repoRoot,
        section,
        source: source ? { title: source.title, messages: source.messages } : null
      })
    })
  }

  /**
   * Starts a thread inside another: anchored to the parent's section as the parent currently
   * proposes it, editing a fork of the parent's fork. Approving it merges into the parent.
   */
  createSubthread(relPath: string, parentId: string, title: string): Promise<ThreadInfo> {
    return this.access.serial(async () => {
      const { index: parentIndex } = await this.locate(relPath, parentId)
      const parentStatus = parentIndex.get(parentId)?.status
      if (parentStatus !== 'open') throw new Error(`The parent thread is ${parentStatus ?? 'missing'}; only open threads take subthreads`)
      if (parentIndex.get(parentId)?.implementation) throw new Error('Implementation threads run in a terminal and take no subthreads')
      const parentFork = await this.fork(relPath, parentId)
      const index = new ThreadIndex(parentFork.ydoc)
      const range = index.resolve(parentId)
      if (!range) throw new Error("The parent thread's section is gone from its proposal")
      const id = newThreadId()
      index.create(id, range, { title, status: 'open', parent: parentId, createdAt: new Date().toISOString() })
      await this.forkStore.save(parentId, parentFork)
      await this.records.write(index.toRecord(id, relPath, null))
      const fork = ThreadFork.from(parentFork.ydoc)
      this.forks.set(id, fork)
      await this.forkStore.save(id, fork)
      return threadInfo(index, relPath, id)
    })
  }

  landed(relPath: string, id: string): Promise<ThreadLanded | null> {
    return this.access.serial(async () => {
      const { git } = this.access
      const commit = await git.commitWithTrailer('Manta-Thread', id)
      if (!commit) return null
      const [before, after] = await Promise.all([git.show(`${commit}~1`, relPath), git.show(commit, relPath)])
      return { commit, before: before ?? '', after: after ?? '' }
    })
  }

  dismissLanded(relPath: string, id: string): Promise<void> {
    return this.access.serial(async () => {
      const doc = await this.requireDoc(relPath)
      const threads = new ThreadIndex(doc.ydoc)
      const implementation = threads.get(id)?.implementation
      if (implementation) {
        threads.setImplementation(id, { ...implementation, hidden: true })
        await this.records.write(threads.toRecord(id, relPath, await this.records.read(id)))
      } else if (threads.get(id)?.landed) doc.ydoc.transact(() => threads.clearLanded(id), THREAD_ORIGIN)
    })
  }

  /** A thread or subthread, wherever its entry lives. */
  get(relPath: string, id: string): Promise<ThreadInfo | null> {
    return this.access.serial(async () => {
      const { index } = await this.locate(relPath, id)
      return index.list(relPath).find((thread) => thread.id === id) ?? null
    })
  }

  /** The thread's direct subthreads, newest first. */
  listSubthreads(relPath: string, parentId: string): Promise<ThreadInfo[]> {
    return this.access.serial(async () => {
      await this.adoptSubthreadRecords(relPath, parentId)
      const doc = await this.requireDoc(relPath)
      const merged = new ThreadIndex(doc.ydoc).list(relPath).filter((thread) => thread.parent === parentId)
      const inDoc = new Set(merged.map((thread) => thread.id))
      const proposed = new ThreadIndex((await this.fork(relPath, parentId)).ydoc)
        .list(relPath)
        .filter((thread) => thread.parent === parentId && !inDoc.has(thread.id))
      return [...merged, ...proposed].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    })
  }

  /** Edits the thread's fork (its proposed version of the doc). The doc itself is untouched. */
  proposeEdit(relPath: string, id: string, find: string, replace: string): Promise<ThreadProposal> {
    return this.access.serial(async () => {
      const { index, target } = await this.locate(relPath, id)
      const status = index.get(id)?.status
      if (status !== 'open') throw new Error(`Thread ${id} is ${status ?? 'missing'}; only open threads can change`)
      const fork = await this.fork(relPath, id)
      fork.replace(find, replace)
      await this.forkStore.save(id, fork)
      return proposalOf(target, fork)
    })
  }

  /** For a subthread, `current → merged` is the parent's proposal before and after approving it. */
  proposal(relPath: string, id: string): Promise<ThreadProposal> {
    return this.access.serial(async () => {
      const { target } = await this.locate(relPath, id)
      return proposalOf(target, await this.fork(relPath, id))
    })
  }

  /**
   * Merges the thread's fork into the doc and commits just that doc, with a `Manta-Thread:`
   * trailer linking the commit back to the thread. Other changes in the working tree and index
   * are left as they were. Refused while the doc has uncommitted edits, so the commit (and its
   * trailer) carries only the thread's change.
   */
  approve(relPath: string, id: string, subject?: string): Promise<OpResult> {
    return this.access.serial(async () => {
      const { doc, index, parent } = await this.locate(relPath, id)
      const entry = index.get(id)
      if (!entry) throw new Error(`No thread ${id} in ${relPath}`)
      if (entry.status !== 'open') return { ok: false, message: `Thread is already ${entry.status}` }
      if (entry.implementation) return { ok: false, message: 'An implementation thread lands through its branch, not by approving' }
      const fork = await this.fork(relPath, id)
      if (!fork.hasChanges()) return { ok: false, message: 'This thread has no proposed change to approve' }
      const openSubthreads = new ThreadIndex(fork.ydoc).list(relPath).filter((t) => t.parent === id && t.status === 'open')
      if (openSubthreads.length > 0) {
        return { ok: false, message: `Approve or discard its ${openSubthreads.length} open subthread(s) first` }
      }

      if (parent) {
        // A subthread lands in its parent's proposal; the doc changes only when the parent is approved.
        if (parent.index.get(parent.id)?.status !== 'open') return { ok: false, message: 'The parent thread is no longer open' }
        Y.applyUpdate(parent.fork.ydoc, fork.updateFor(parent.fork.ydoc), THREAD_ORIGIN)
        index.setStatus(id, 'approved')
        await this.forkStore.save(parent.id, parent.fork)
        await this.records.write(index.toRecord(id, relPath, await this.records.read(id)))
        return { ok: true, message: "Merged into the parent thread's proposal" }
      }

      // Absorb an outside edit the watcher hasn't delivered yet, so it counts as uncommitted.
      await this.access.absorbDisk(doc)
      if ((await this.access.git.show('HEAD', relPath)) !== doc.text.toString()) {
        return { ok: false, message: `${relPath} has uncommitted edits that aren't part of this thread; commit them first` }
      }

      // The merge also brings the subthread entries the fork collected; approved ones have now landed.
      const threads = new ThreadIndex(doc.ydoc)
      const before = doc.text.toString()
      Y.applyUpdate(doc.ydoc, fork.updateFor(doc.ydoc), THREAD_ORIGIN)
      doc.ydoc.transact(() => {
        threads.setStatus(id, 'merged')
        // The doc matched HEAD before the merge (checked above), so this diff is exactly the thread's change.
        threads.setLanded(id, changedRanges(before, doc.text.toString()))
        for (const threadId of threads.ids()) {
          if (threads.get(threadId)?.status === 'approved' && descendsFrom(threads, threadId, id)) {
            threads.setStatus(threadId, 'merged')
          }
        }
      }, THREAD_ORIGIN)
      // Written now rather than by the debounced timer, so the commit has the merged text.
      await this.access.writeNow(doc)

      for (const threadId of threads.ids()) {
        const previous = await this.records.read(threadId)
        const next = threads.toRecord(threadId, relPath, previous)
        if (!previous || recordIsStale(previous, next)) await this.records.write(next)
      }
      const message = `${subject ?? `docs(${relPath}): ${entry.title}`}\n\nManta-Thread: ${id}\n`
      const sha = await this.access.git.commitPaths([relPath], message)
      await doc.markCommitted(sha)
      return { ok: true, message: `Committed ${sha.slice(0, 7)}` }
    })
  }

  /**
   * Starts a thread on the section containing `offset` (see `sectionAt`), computed on this copy
   * of the doc rather than the caller's, so the anchor never lands on stale text.
   */
  createAt(relPath: string, offset: number, title: string): Promise<ThreadInfo> {
    return this.access.serial(async () => {
      const doc = await this.requireDoc(relPath)
      const text = doc.text.toString()
      return sectionAt(text, Math.min(Math.max(0, offset), text.length))
    }).then((range) => this.create(relPath, range, title))
  }

  /** The doc's top-level threads, newest first, including merged, discarded and detached ones. Subthreads are listed by their parent. */
  list(relPath: string): Promise<ThreadInfo[]> {
    return this.access.serial(async () => {
      const doc = await this.access.doc(relPath)
      return doc ? new ThreadIndex(doc.ydoc).list(relPath).filter((thread) => thread.parent === null) : []
    })
  }

  setStatus(relPath: string, id: string, status: ThreadStatus): Promise<ThreadInfo> {
    return this.access.serial(async () => {
      const { index, parent } = await this.locate(relPath, id)
      index.setStatus(id, status)
      if (parent) await this.forkStore.save(parent.id, parent.fork)
      await this.records.write(index.toRecord(id, relPath, await this.records.read(id)))
      return threadInfo(index, relPath, id)
    })
  }

  transcript(id: string): Promise<ThreadMessage[]> {
    return this.access.serial(async () => (await this.records.read(id))?.messages ?? [])
  }

  /** Runs one agent turn on the thread (see `ThreadTurns.send`). Resolves when the turn ends. */
  send(relPath: string, id: string, text: string): Promise<OpResult> {
    return this.turns.send(relPath, id, text)
  }

  /** Answers a permission request from the thread's running turn. False when it is no longer waiting. */
  answerPermission(threadId: string, requestId: string, decision: PermissionDecision): boolean {
    return this.turns.answerPermission(threadId, requestId, decision)
  }

  /** Stops the thread's running turn. Edits the agent already made stay in the proposal. */
  cancel(id: string): boolean {
    return this.turns.cancel(id)
  }

  /** Stops every running turn. */
  close(): void {
    this.turns.close()
  }

  /** Whether any thread, open or not, is anchored in the doc. */
  hasThreads(doc: LivingDoc): boolean {
    return new ThreadIndex(doc.ydoc).ids().length > 0
  }

  /**
   * Gives every thread record a live anchor in its doc's CRDT, loading the doc if needed. This is
   * how a repo with records but no `.git/manta/` (records copied in, or CRDT state lost) finds
   * its threads' sections again. Inside `serial` only.
   */
  async adoptRecords(): Promise<void> {
    for (const record of await this.records.list()) {
      // Subthreads anchor in their parent's fork, and are adopted there when first looked up.
      if (record.parent !== null) continue
      const doc = await this.access.doc(record.doc)
      if (doc) new ThreadIndex(doc.ydoc).adopt(record)
    }
  }

  /**
   * Refreshes `.manta/threads/` from the CRDT index so the records' quotes match the docs'
   * text. Inside `serial` only.
   */
  async exportRecords(): Promise<void> {
    for (const doc of this.access.docs()) {
      const threads = new ThreadIndex(doc.ydoc)
      for (const id of threads.ids()) {
        const previous = await this.records.read(id)
        const next = threads.toRecord(id, doc.relPath, previous)
        if (!previous || recordIsStale(previous, next)) await this.records.write(next)
      }
    }
  }

  /** Brings subthread records into the parent's fork when it doesn't have them (no `.git/manta/` state). */
  private async adoptSubthreadRecords(relPath: string, parentId: string): Promise<void> {
    const threads = new ThreadIndex((await this.requireDoc(relPath)).ydoc)
    const records = (await this.records.list()).filter((r) => r.doc === relPath && r.parent === parentId && !threads.get(r.id))
    if (records.length === 0) return
    const parentFork = await this.fork(relPath, parentId)
    const index = new ThreadIndex(parentFork.ydoc)
    let changed = false
    for (const record of records) changed = index.adopt(record) || changed
    if (changed) await this.forkStore.save(parentId, parentFork)
  }

  private beginTurn(relPath: string, id: string, text: string, threadsDir: string): Promise<PreparedTurn> {
    return this.access.serial(async () => {
      const { index } = await this.locate(relPath, id)
      const entry = index.get(id)
      if (!entry) throw new Error(`No thread ${id} in ${relPath}`)
      if (entry.status !== 'open') throw new Error(`Thread is ${entry.status}; only open threads take messages`)
      if (entry.implementation) throw new Error('This implementation runs in its Claude session; send messages there')
      const fork = await this.fork(relPath, id)
      const dir = path.join(threadsDir, id)
      const file = path.join(dir, path.basename(relPath))
      await mkdir(dir, { recursive: true })
      // Keep edits from a turn that never finished (the app quit mid-turn) before rewriting the file.
      if (fork.checkout) {
        const leftover = await readFile(file, 'utf8').catch(() => null)
        if (leftover !== null) fork.absorbCheckout(leftover)
      }
      await writeFile(file, fork.checkOut())
      await this.forkStore.save(id, fork)
      await this.appendTranscript(index, relPath, id, [{ role: 'user', text, at: new Date().toISOString() }])
      const range = index.resolve(id)
      const section = range
        ? index.text.toString().slice(range.from, range.to)
        : ((await this.records.read(id))?.anchor.quote.exact ?? '')
      const parents = await this.ancestorRecords(id)
      const parentsFile = path.join(dir, PARENT_THREADS_FILE)
      if (parents.length > 0) {
        await mkdir(path.dirname(parentsFile), { recursive: true })
        await writeFile(parentsFile, parentThreadsMarkdown(parents))
      }
      // Claude Code reports resolved paths (/private/tmp on macOS), so keep both forms to shorten tool lines.
      const realDir = await realpath(dir)
      return {
        file,
        dir,
        realDir,
        session: await this.forkStore.loadSession(id),
        context: {
          title: entry.title,
          doc: relPath,
          section,
          repoRoot: this.access.repoRoot,
          parents: parents.length > 0 ? { titles: parents.map((record) => record.title), file: parentsFile } : null
        }
      }
    })
  }

  private absorbCheckout(relPath: string, id: string, file: string): Promise<boolean> {
    return this.access.serial(async () => {
      const fork = await this.fork(relPath, id)
      const text = await readFile(file, 'utf8').catch(() => null)
      if (text === null || !fork.absorbCheckout(text)) return false
      await this.forkStore.save(id, fork)
      return true
    })
  }

  /** Records of the threads `id` was started from, outermost first; empty for a top-level thread. */
  private async ancestorRecords(id: string): Promise<ThreadRecord[]> {
    const chain: ThreadRecord[] = []
    let parentId = (await this.records.read(id))?.parent ?? null
    for (let depth = 0; parentId !== null && depth <= MAX_THREAD_DEPTH; depth++) {
      const record = await this.records.read(parentId)
      if (!record) break
      chain.unshift(record)
      parentId = record.parent
    }
    return chain
  }

  private async appendTranscript(index: ThreadIndex, relPath: string, id: string, messages: readonly ThreadMessage[]): Promise<void> {
    if (messages.length === 0) return
    const record = index.toRecord(id, relPath, await this.records.read(id))
    await this.records.write({ ...record, messages: [...record.messages, ...messages] })
  }

  private async requireDoc(relPath: string): Promise<LivingDoc> {
    const doc = await this.access.doc(relPath)
    if (!doc) throw new Error(`${relPath} does not exist`)
    return doc
  }

  /**
   * Where a thread's entry lives and what approving it merges into: the doc for a top-level
   * thread, the parent's fork for a subthread (at any depth).
   */
  private async locate(relPath: string, id: string, depth = 0): Promise<Located> {
    if (depth > MAX_THREAD_DEPTH) throw new Error(`Thread ${id} is nested too deeply`)
    const doc = await this.requireDoc(relPath)
    // A subthread whose parent has merged is in the doc's index too, and that copy is current.
    const threads = new ThreadIndex(doc.ydoc)
    if (threads.get(id)) return { doc, index: threads, target: doc.ydoc, parent: null }
    const record = await this.records.read(id)
    const parentId = record?.parent ?? null
    if (!record || parentId === null) throw new Error(`No thread ${id} in ${relPath}`)
    const { index: parentIndex } = await this.locate(relPath, parentId, depth + 1)
    const parentFork = await this.fork(relPath, parentId, depth + 1)
    const index = new ThreadIndex(parentFork.ydoc)
    if (!index.get(id)) {
      index.adopt(record)
      await this.forkStore.save(parentId, parentFork)
    }
    return { doc, index, target: parentFork.ydoc, parent: { id: parentId, index: parentIndex, fork: parentFork } }
  }

  /**
   * The thread's fork, from memory or `.git/manta/`. A fresh clone has no fork state, so the
   * fork starts again from what it would merge into, as that is now.
   */
  private async fork(relPath: string, id: string, depth = 0): Promise<ThreadFork> {
    const cached = this.forks.get(id)
    if (cached) return cached
    const { target } = await this.locate(relPath, id, depth)
    let fork = await this.forkStore.load(id)
    if (!fork) {
      fork = ThreadFork.from(target)
      await this.forkStore.save(id, fork)
    }
    this.forks.set(id, fork)
    return fork
  }
}

/** A doc change an implementation session proposes; see `WorkspaceThreads.propose`. */
export interface DocChange {
  find: string
  replace: string
  title: string
  why: string
  from: ProposalAuthor
}

/** The implementation thread or context map agent a proposal comes from, and what its transcript calls it (`the implementation “X” (branch)`). */
export interface ProposalAuthor {
  ref: ThreadRef | MapProposer
  label: string
}

function sameProposer(entry: ThreadEntry, by: ProposalAuthor): boolean {
  if ('map' in by.ref) {
    const theirs = entry.proposedByMap
    return theirs !== undefined && theirs.map === by.ref.map && JSON.stringify(theirs.from) === JSON.stringify(by.ref.from)
  }
  return entry.proposedBy?.doc === by.ref.doc && entry.proposedBy.thread === by.ref.thread
}

function authorLines(action: 'Proposed' | 'Revised' | 'Withdrawn', by: ProposalAuthor, why: string): ThreadMessage[] {
  const at = new Date().toISOString()
  return [
    { role: 'status', text: `${action} by ${by.label}`, at },
    { role: 'assistant', text: why, at }
  ]
}

interface Located {
  doc: LivingDoc
  /** The index holding the thread's entry. */
  index: ThreadIndex
  /** What approving the thread merges into. */
  target: Y.Doc
  parent: { id: string; index: ThreadIndex; fork: ThreadFork } | null
}

const MAX_THREAD_DEPTH = 16

function threadInfo(index: ThreadIndex, relPath: string, id: string): ThreadInfo {
  const info = index.list(relPath).find((thread) => thread.id === id)
  if (!info) throw new Error(`No thread ${id} in ${relPath}`)
  return info
}

function descendsFrom(index: ThreadIndex, id: string, ancestor: string): boolean {
  let parent = index.get(id)?.parent ?? null
  for (let depth = 0; parent !== null && depth <= MAX_THREAD_DEPTH; depth++) {
    if (parent === ancestor) return true
    parent = index.get(parent)?.parent ?? null
  }
  return false
}

function proposalOf(target: Y.Doc, fork: ThreadFork): ThreadProposal {
  const preview = new Y.Doc()
  Y.applyUpdate(preview, Y.encodeStateAsUpdate(target))
  Y.applyUpdate(preview, fork.updateFor(preview))
  return {
    base: fork.baseText(),
    proposed: fork.text.toString(),
    current: target.getText('md').toString(),
    merged: preview.getText('md').toString()
  }
}

/** The parents' conversations for a subthread's agent. Tool and status lines are left out: they're noise without their output. */
function parentThreadsMarkdown(parents: readonly ThreadRecord[]): string {
  const sections = parents.map((record, index) => {
    const role = index === parents.length - 1 ? 'Parent thread' : 'Ancestor thread'
    const messages = record.messages.flatMap((message) =>
      message.role === 'user' ? [`**User:** ${message.text}`] : message.role === 'assistant' ? [`**Agent:** ${message.text}`] : []
    )
    return [`## ${role}: "${record.title}" (${record.status})`, '', ...(messages.length > 0 ? messages : ['No messages yet.'])].join('\n\n')
  })
  return `# Parent threads\n\nOutermost first; the last one is this subthread's direct parent.\n\n${sections.join('\n\n')}\n`
}
