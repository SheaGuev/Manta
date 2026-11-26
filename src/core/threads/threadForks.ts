import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import * as Y from 'yjs'
import type { ThreadProposal } from '../../shared/ipc'
import type { Snapshot } from '../docs/docStore'

export type { ThreadProposal }
import { applyTextEdits, computeTextEdits, mergeTextChange } from '../docs/textEdits'

const AGENT_ORIGIN = Symbol('agent')

/**
 * A thread's proposed edit: a copy of the doc's CRDT taken when the thread started. The agent
 * and the user edit the fork, never the doc; approving merges the fork's ops into the doc, so
 * edits the doc received meanwhile survive.
 */
export class ThreadFork {
  readonly ydoc = new Y.Doc()
  readonly text = this.ydoc.getText('md')
  private baseTextCache: string | null = null
  /** What was last written to the thread folder, and the fork's state at that moment. */
  private checkoutSnapshot: Snapshot | null = null

  private constructor(readonly base: Uint8Array) {
    Y.applyUpdate(this.ydoc, base)
  }

  static from(doc: Y.Doc): ThreadFork {
    return new ThreadFork(Y.encodeStateAsUpdate(doc))
  }

  static restore(base: Uint8Array, state: Uint8Array, checkout: Snapshot | null): ThreadFork {
    const fork = new ThreadFork(base)
    Y.applyUpdate(fork.ydoc, state)
    fork.checkoutSnapshot = checkout
    return fork
  }

  get checkout(): Snapshot | null {
    return this.checkoutSnapshot
  }

  /** Records the fork's current text as written to the thread folder. Returns the text to write. */
  checkOut(): string {
    const text = this.text.toString()
    this.checkoutSnapshot = { text, state: Y.encodeStateAsUpdate(this.ydoc) }
    return text
  }

  /**
   * Merges an edit made to the thread folder's file (by the agent) into the fork, the same way
   * an outside edit reaches a doc: as minimal ops replayed at the last checkout. Returns false
   * when the file still matches what was written.
   */
  absorbCheckout(fileText: string): boolean {
    const checkout = this.checkoutSnapshot
    if (!checkout) throw new Error('This thread has no checkout to absorb')
    if (fileText === checkout.text) return false
    const state = mergeTextChange(this.ydoc, checkout, fileText, 'agent', AGENT_ORIGIN)
    this.checkoutSnapshot = { text: fileText, state }
    return true
  }

  /** The doc's text at the fork point. */
  baseText(): string {
    if (this.baseTextCache === null) {
      const doc = new Y.Doc()
      Y.applyUpdate(doc, this.base)
      this.baseTextCache = doc.getText('md').toString()
    }
    return this.baseTextCache
  }

  hasChanges(): boolean {
    return this.text.toString() !== this.baseText()
  }

  /**
   * Replaces the one occurrence of `find` with `replace`, as minimal ops so unchanged characters
   * keep their identity. Errors when `find` is missing or not unique, so an edit can never land
   * somewhere other than where it was aimed.
   */
  replace(find: string, replace: string): void {
    const current = this.text.toString()
    if (find.length === 0) throw new Error('The text to replace is empty')
    const at = current.indexOf(find)
    if (at === -1) throw new Error('The text to replace was not found in the proposed doc')
    if (current.indexOf(find, at + 1) !== -1) throw new Error('The text to replace appears more than once; include more of it')
    const next = current.slice(0, at) + replace + current.slice(at + find.length)
    this.ydoc.transact(() => applyTextEdits(this.text, computeTextEdits(current, next)))
  }

  /** The fork's ops that `doc` doesn't have yet. */
  updateFor(doc: Y.Doc): Uint8Array {
    return Y.encodeStateAsUpdate(this.ydoc, Y.encodeStateVector(doc))
  }
}

/**
 * Fork persistence under `.git/manta/threads/<id>/`: the fork point, the fork's full state, the
 * last checkout snapshot, and the Claude Code session the thread's agent resumes.
 */
export class ThreadForkStore {
  constructor(readonly root: string) {}

  async load(id: string): Promise<ThreadFork | null> {
    const dir = path.join(this.root, id)
    try {
      const [base, state] = await Promise.all([readFile(path.join(dir, 'base.bin')), readFile(path.join(dir, 'fork.bin'))])
      return ThreadFork.restore(base, state, await readCheckout(dir))
    } catch {
      return null
    }
  }

  async save(id: string, fork: ThreadFork): Promise<void> {
    const dir = path.join(this.root, id)
    await mkdir(dir, { recursive: true })
    await atomicWrite(path.join(dir, 'base.bin'), fork.base)
    const checkout = fork.checkout
    if (checkout) {
      await atomicWrite(path.join(dir, 'checkout.bin'), checkout.state)
      await atomicWrite(path.join(dir, 'checkout.txt'), checkout.text)
    }
    // fork.bin goes last: load() needs both files, so a crash before it leaves no half-saved fork.
    await atomicWrite(path.join(dir, 'fork.bin'), Y.encodeStateAsUpdate(fork.ydoc))
  }

  async loadSession(id: string): Promise<string | null> {
    const session = await readFile(path.join(this.root, id, 'session.txt'), 'utf8').catch(() => '')
    return session.trim() || null
  }

  async saveSession(id: string, session: string): Promise<void> {
    await mkdir(path.join(this.root, id), { recursive: true })
    await atomicWrite(path.join(this.root, id, 'session.txt'), session)
  }
}

async function readCheckout(dir: string): Promise<Snapshot | null> {
  try {
    const [state, text] = await Promise.all([readFile(path.join(dir, 'checkout.bin')), readFile(path.join(dir, 'checkout.txt'), 'utf8')])
    return { text, state }
  } catch {
    return null
  }
}

async function atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
  await writeFile(`${file}.tmp`, data)
  await rename(`${file}.tmp`, file)
}
