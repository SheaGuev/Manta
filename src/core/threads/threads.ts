import * as Y from 'yjs'
import type { ImplementationLink, MapAuthor, MapProposer, PullRequestInfo, TextRange, ThreadInfo, ThreadMessage, ThreadRef, ThreadStatus } from '../../shared/ipc'

export type { ImplementationLink, TextRange, ThreadInfo, ThreadMessage, ThreadStatus }

const STATUSES: readonly ThreadStatus[] = ['open', 'approved', 'merged', 'discarded']

/**
 * The anchored text plus a little on each side, so the section can be found again in a doc
 * whose CRDT history is gone (a fresh clone).
 */
export interface Quote {
  exact: string
  prefix: string
  suffix: string
}

/** Two Yjs relative positions, base64-encoded so they fit in JSON and in a Y.Map unchanged. */
export interface Anchor {
  start: string
  end: string
}

/**
 * What approving a thread changed in the doc: the inserted span (as relative positions, so it
 * follows later edits) and the text it replaced. Kept until the user hides it.
 */
export interface LandedChange {
  start: string
  end: string
  removed: string
}

/** One thread in a doc's CRDT index. `anchor` is null when the section could not be found again. */
export interface ThreadEntry {
  title: string
  status: ThreadStatus
  parent: string | null
  createdAt: string
  anchor: Anchor | null
  landed?: LandedChange[]
  implementation?: ImplementationLink
  proposedBy?: ThreadRef
  proposedByMap?: MapProposer
}

const ROLES: readonly ThreadMessage['role'][] = ['user', 'assistant', 'tool', 'status']

/** A thread as committed to `.manta/threads/<id>.json`. */
export interface ThreadRecord {
  version: 1
  id: string
  doc: string
  title: string
  status: ThreadStatus
  parent: string | null
  createdAt: string
  anchor: { crdt: Anchor | null; quote: Quote }
  messages: ThreadMessage[]
  implementation?: ImplementationLink
  proposedBy?: ThreadRef
  proposedByMap?: MapProposer
}

const QUOTE_CONTEXT = 32

export function newThreadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5))
  return `t_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Whether a committed record is out of date. CRDT positions differ on every machine and the quote's
 * context shifts with every edit nearby; neither is worth rewriting the file for on its own.
 */
export function recordIsStale(previous: ThreadRecord, next: ThreadRecord): boolean {
  const essence = (record: ThreadRecord): string =>
    JSON.stringify({ ...record, anchor: { crdt: null, quote: { exact: record.anchor.quote.exact } } })
  return essence(previous) !== essence(next)
}

/**
 * The thread index stored in a doc's CRDT, next to its markdown. Anchors are relative positions
 * into the `md` text, so they move with every edit that reaches the CRDT as ops.
 */
export class ThreadIndex {
  readonly text: Y.Text
  readonly map: Y.Map<unknown>

  constructor(readonly ydoc: Y.Doc) {
    this.text = ydoc.getText('md')
    this.map = ydoc.getMap<unknown>('threads')
  }

  ids(): string[] {
    return [...this.map.keys()]
  }

  /** Every thread in the doc, newest first. */
  list(doc: string): ThreadInfo[] {
    const threads: ThreadInfo[] = []
    for (const id of this.ids()) {
      const entry = this.get(id)
      if (!entry) continue
      const { anchor: _, landed: __, implementation, proposedBy, proposedByMap, ...fields } = entry
      const highlighted = implementation ? entry.status === 'merged' && !implementation.hidden : this.landed(id).length > 0
      threads.push({ id, doc, ...fields, range: this.resolve(id), highlighted, implementation: implementation ?? null, proposedBy: proposedBy ?? null, proposedByMap: proposedByMap ?? null })
    }
    return threads.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(id: string): ThreadEntry | null {
    return parseEntry(this.map.get(id))
  }

  create(id: string, range: TextRange, fields: Omit<ThreadEntry, 'anchor'>): void {
    if (this.map.has(id)) throw new Error(`Thread ${id} already exists`)
    const length = this.text.length
    if (range.from < 0 || range.to > length || range.from >= range.to) {
      throw new Error(`Range ${range.from}–${range.to} is not inside the doc`)
    }
    this.map.set(id, { ...fields, anchor: this.anchorFor(range) })
  }

  /** Records what approving the thread changed, as spans of the doc's current text. */
  setLanded(id: string, changes: readonly { from: number; to: number; removed: string }[]): void {
    const entry = this.require(id)
    this.map.set(id, { ...entry, landed: changes.map(({ from, to, removed }) => ({ ...this.anchorFor({ from, to }), removed })) })
  }

  clearLanded(id: string): void {
    const { landed: _, ...entry } = this.require(id)
    this.map.set(id, entry)
  }

  /** Where the thread's landed changes are now. Spans whose text was deleted since come back empty. */
  landed(id: string): { from: number; to: number; removed: string }[] {
    return (this.get(id)?.landed ?? []).flatMap((change) => {
      const range = this.resolveAnchor(change)
      return range ? [{ ...range, removed: change.removed }] : []
    })
  }

  setImplementation(id: string, implementation: ImplementationLink): void {
    const entry = this.require(id)
    if (!entry.implementation) throw new Error(`Thread ${id} is not an implementation thread`)
    this.map.set(id, { ...entry, implementation })
  }

  setStatus(id: string, status: ThreadStatus): void {
    const entry = this.require(id)
    this.map.set(id, { ...entry, status })
  }

  /**
   * Where the thread's section is now. Null when it can't be resolved in this CRDT (anchor lost,
   * or positions from another CRDT history) or when the anchored text was deleted.
   */
  resolve(id: string): TextRange | null {
    const anchor = this.get(id)?.anchor
    if (!anchor) return null
    const range = this.resolveAnchor(anchor)
    return range && range.from < range.to ? range : null
  }

  quote(range: TextRange): Quote {
    const text = this.text.toString()
    return {
      exact: text.slice(range.from, range.to),
      prefix: text.slice(Math.max(0, range.from - QUOTE_CONTEXT), range.from),
      suffix: text.slice(range.to, range.to + QUOTE_CONTEXT)
    }
  }

  /** Builds the committed record. A detached thread keeps the quote from its previous record. */
  toRecord(id: string, doc: string, previous: ThreadRecord | null): ThreadRecord {
    const entry = this.require(id)
    const range = this.resolve(id)
    const quote = range ? this.quote(range) : (previous?.anchor.quote ?? { exact: '', prefix: '', suffix: '' })
    return {
      version: 1,
      id,
      doc,
      title: entry.title,
      status: entry.status,
      parent: entry.parent,
      createdAt: entry.createdAt,
      anchor: { crdt: entry.anchor, quote },
      messages: previous?.messages ?? [],
      ...(entry.implementation ? { implementation: entry.implementation } : {}),
      ...(entry.proposedBy ? { proposedBy: entry.proposedBy } : {}),
      ...(entry.proposedByMap ? { proposedByMap: entry.proposedByMap } : {})
    }
  }

  /**
   * Brings a committed record into the index when the CRDT doesn't have a usable anchor for it:
   * first the record's own CRDT positions, then a search for its quote. Fields already in the
   * CRDT win over the record. Returns true when the index changed.
   */
  adopt(record: ThreadRecord): boolean {
    const existing = this.get(record.id)
    if (existing?.anchor && this.resolveAnchor(existing.anchor)) return false

    let anchor: Anchor | null = null
    if (record.anchor.crdt && this.resolveAnchor(record.anchor.crdt)) anchor = record.anchor.crdt
    else {
      const found = findQuote(this.text.toString(), record.anchor.quote)
      if (found) anchor = this.anchorFor(found)
    }
    if (existing && anchor === null && existing.anchor === null) return false

    const fields = existing ?? {
      title: record.title,
      status: record.status,
      parent: record.parent,
      createdAt: record.createdAt,
      ...(record.implementation ? { implementation: record.implementation } : {}),
      ...(record.proposedBy ? { proposedBy: record.proposedBy } : {}),
      ...(record.proposedByMap ? { proposedByMap: record.proposedByMap } : {})
    }
    this.map.set(record.id, { ...fields, anchor })
    return true
  }

  private anchorFor(range: TextRange): Anchor {
    // Start sticks to the first anchored character and end to the last, so typing just
    // outside the section never widens it.
    return {
      start: encodePosition(Y.createRelativePositionFromTypeIndex(this.text, range.from, 0)),
      end: encodePosition(Y.createRelativePositionFromTypeIndex(this.text, range.to, -1))
    }
  }

  /** Null when either position refers to CRDT items this doc has never seen. */
  private resolveAnchor(anchor: Anchor): TextRange | null {
    const from = Y.createAbsolutePositionFromRelativePosition(decodePosition(anchor.start), this.ydoc)
    const to = Y.createAbsolutePositionFromRelativePosition(decodePosition(anchor.end), this.ydoc)
    if (!from || !to || from.type !== this.text || to.type !== this.text) return null
    return { from: from.index, to: Math.max(from.index, to.index) }
  }

  private require(id: string): ThreadEntry {
    const entry = this.get(id)
    if (!entry) throw new Error(`No thread ${id} in this doc`)
    return entry
  }
}

/**
 * Finds a quote in `text`. Every exact match is scored by how much of the recorded prefix and
 * suffix surrounds it, so repeated text (two "## Open questions" sections) resolves to the
 * right one. Null when the exact text is gone.
 */
export function findQuote(text: string, quote: Quote): TextRange | null {
  if (quote.exact.length === 0) return null
  let best: TextRange | null = null
  let bestScore = -1
  for (let at = text.indexOf(quote.exact); at !== -1; at = text.indexOf(quote.exact, at + 1)) {
    const end = at + quote.exact.length
    const score = commonSuffix(text.slice(0, at), quote.prefix) + commonPrefix(text.slice(end), quote.suffix)
    if (score > bestScore) {
      best = { from: at, to: end }
      bestScore = score
    }
  }
  return best
}

const HEADING = /^(#{1,6})[ \t]/
const FENCE = /^(```|~~~)/

/**
 * The range a thread started at `offset` anchors to: the enclosing heading's section (up to the
 * next heading of the same or higher level), or the paragraph when no heading encloses it.
 * Trailing blank lines are left out.
 */
export function sectionAt(markdown: string, offset: number): TextRange {
  const lines: { start: number; end: number; level: number; blank: boolean }[] = []
  let inFence = false
  let start = 0
  for (const line of markdown.split('\n')) {
    const fence = FENCE.test(line)
    const heading = !inFence && !fence ? HEADING.exec(line) : null
    if (fence) inFence = !inFence
    lines.push({ start, end: start + line.length, level: heading?.[1]?.length ?? 0, blank: line.trim() === '' })
    start += line.length + 1
  }

  const at = Math.max(0, lines.findIndex((line) => offset <= line.end))
  let headingIndex = -1
  for (let i = at; i >= 0; i--) {
    if ((lines[i]?.level ?? 0) > 0) {
      headingIndex = i
      break
    }
  }

  let first: number
  let last: number
  if (headingIndex >= 0) {
    const level = lines[headingIndex]?.level ?? 0
    first = headingIndex
    last = lines.length - 1
    for (let i = headingIndex + 1; i < lines.length; i++) {
      const lineLevel = lines[i]?.level ?? 0
      if (lineLevel > 0 && lineLevel <= level) {
        last = i - 1
        break
      }
    }
  } else {
    first = at
    last = at
    while (first > 0 && !lines[first - 1]?.blank) first--
    while (last < lines.length - 1 && !lines[last + 1]?.blank) last++
  }
  while (last > first && lines[last]?.blank) last--
  return { from: lines[first]?.start ?? 0, to: lines[last]?.end ?? markdown.length }
}

export function parseEntry(value: unknown): ThreadEntry | null {
  if (!isObject(value)) return null
  const { title, status, parent, createdAt, anchor } = value
  if (typeof title !== 'string' || !isStatus(status) || typeof createdAt !== 'string') return null
  if (parent !== null && typeof parent !== 'string') return null
  if (anchor !== null && !isAnchor(anchor)) return null
  const implementation = optionalImplementation(value.implementation)
  if (implementation === null) return null
  const entry: ThreadEntry = { title, status, parent, createdAt, anchor, ...implementation, ...optionalProposedBy(value.proposedBy), ...optionalProposedByMap(value.proposedByMap) }
  const landed = value.landed
  if (landed === undefined) return entry
  if (!Array.isArray(landed) || !landed.every(isLanded)) return null
  return { ...entry, landed }
}

function optionalProposedBy(value: unknown): { proposedBy?: ThreadRef } {
  return isObject(value) && typeof value.doc === 'string' && typeof value.thread === 'string' ? { proposedBy: { doc: value.doc, thread: value.thread } } : {}
}

function optionalProposedByMap(value: unknown): { proposedByMap?: MapProposer } {
  if (!isObject(value) || typeof value.map !== 'string' || typeof value.title !== 'string') return {}
  const from = parseMapAuthor(value.from)
  return from ? { proposedByMap: { map: value.map, from, title: value.title } } : {}
}

/** Who in a context map raised something: a launch, the sweep for a launch, or Ask the map. */
export function parseMapAuthor(value: unknown): MapAuthor | null {
  if (!isObject(value)) return null
  if (typeof value.launch === 'string') return { launch: value.launch }
  if (typeof value.sweep === 'string') return { sweep: value.sweep }
  if (value.ask === true) return { ask: true }
  return null
}

/** `{}` when absent (a doc thread), the field when valid, null when present but malformed. */
function optionalImplementation(value: unknown): { implementation?: ImplementationLink } | null {
  if (value === undefined) return {}
  const implementation = parseImplementation(value)
  return implementation ? { implementation } : null
}

function parseImplementation(value: unknown): ImplementationLink | null {
  if (!isObject(value)) return null
  const { source, project, worktree, branch, session, terminal, hidden } = value
  const valid =
    (source === null || typeof source === 'string') &&
    typeof project === 'string' &&
    typeof worktree === 'string' &&
    typeof branch === 'string' &&
    typeof session === 'string' &&
    (terminal === null || typeof terminal === 'string') &&
    typeof hidden === 'boolean'
  if (!valid) return null
  const base = typeof value.base === 'string' ? value.base : null
  const pr = isPullRequest(value.pr) ? value.pr : null
  return { source, project, worktree, branch, session, terminal, hidden, base, pr }
}

const PR_STATES: readonly PullRequestInfo['state'][] = ['open', 'merged', 'closed']

function isPullRequest(value: unknown): value is PullRequestInfo {
  return isObject(value) && typeof value.number === 'number' && PR_STATES.some((s) => s === value.state) && typeof value.url === 'string'
}

function isLanded(value: unknown): value is LandedChange {
  return isAnchor(value) && 'removed' in value && typeof value.removed === 'string'
}

export function parseRecord(value: unknown): ThreadRecord | null {
  if (!isObject(value) || value.version !== 1) return null
  const { id, doc, title, status, parent, createdAt, anchor } = value
  if (typeof id !== 'string' || typeof doc !== 'string' || typeof title !== 'string') return null
  if (!isStatus(status) || typeof createdAt !== 'string') return null
  if (parent !== null && typeof parent !== 'string') return null
  if (!isObject(anchor) || !isQuote(anchor.quote)) return null
  const crdt = anchor.crdt
  if (crdt !== null && !isAnchor(crdt)) return null
  // Records written before transcripts existed have no `messages`.
  const messages = value.messages ?? []
  if (!Array.isArray(messages) || !messages.every(isMessage)) return null
  const implementation = optionalImplementation(value.implementation)
  if (implementation === null) return null
  return {
    version: 1,
    id,
    doc,
    title,
    status,
    parent,
    createdAt,
    anchor: { crdt, quote: anchor.quote },
    messages,
    ...implementation,
    ...optionalProposedBy(value.proposedBy),
    ...optionalProposedByMap(value.proposedByMap)
  }
}

export function isMessage(value: unknown): value is ThreadMessage {
  return (
    isObject(value) &&
    ROLES.some((role) => role === value.role) &&
    typeof value.text === 'string' &&
    typeof value.at === 'string'
  )
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStatus(value: unknown): value is ThreadStatus {
  return STATUSES.some((status) => status === value)
}

function isAnchor(value: unknown): value is Anchor {
  return isObject(value) && typeof value.start === 'string' && typeof value.end === 'string'
}

function isQuote(value: unknown): value is Quote {
  return (
    isObject(value) &&
    typeof value.exact === 'string' &&
    typeof value.prefix === 'string' &&
    typeof value.suffix === 'string'
  )
}

function commonPrefix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

function commonSuffix(a: string, b: string): number {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

/** btoa/atob rather than Buffer, so the renderer can resolve anchors from its own replica. */
function encodePosition(position: Y.RelativePosition): string {
  return btoa(String.fromCharCode(...Y.encodeRelativePosition(position)))
}

function decodePosition(encoded: string): Y.RelativePosition {
  return Y.decodeRelativePosition(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)))
}
