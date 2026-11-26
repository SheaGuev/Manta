import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isReviewDiff, type ReviewAnchor, type ReviewComment } from '../../shared/ipc'

/** Which agent a pull request comment was sent to, by GitHub node id. */
export type PullRequestSentMarks = Record<string, { to: string; at: string }>

/** Per pull request number, each file ticked as viewed with the fingerprint of its diff then. */
type ViewedFiles = Record<string, Record<string, string>>

/** Per pull request number, the files whose last viewed change GitHub didn't take: Manta's state wins for them. */
type UnsyncedViewed = Record<string, string[]>

interface StoredReview {
  comments: ReviewComment[]
  prSent: PullRequestSentMarks
  viewed: ViewedFiles
  unsyncedViewed: UnsyncedViewed
}

/**
 * One worktree's review comments, plus which pull request comments were sent to an agent, in a JSON
 * file under its git dir. Every call runs on the store's own queue, so concurrent adds and sends never
 * drop each other's writes.
 */
export class ReviewCommentStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: () => Promise<string>) {}

  list(): Promise<ReviewComment[]> {
    return this.enqueue(async () => (await this.read()).comments)
  }

  pullRequestSent(): Promise<PullRequestSentMarks> {
    return this.enqueue(async () => (await this.read()).prSent)
  }

  viewed(pr: number): Promise<Record<string, string>> {
    return this.enqueue(async () => (await this.read()).viewed[String(pr)] ?? {})
  }

  unsyncedViewed(pr: number): Promise<string[]> {
    return this.enqueue(async () => (await this.read()).unsyncedViewed[String(pr)] ?? [])
  }

  /** Null unticks. `synced` false keeps the file in `unsyncedViewed` until a later change is synced. */
  setViewed(pr: number, relPath: string, fingerprint: string | null, { synced = true }: { synced?: boolean } = {}): Promise<void> {
    return this.enqueue(async () => {
      const stored = await this.read()
      const files = { ...(stored.viewed[String(pr)] ?? {}) }
      if (fingerprint === null) delete files[relPath]
      else files[relPath] = fingerprint
      const others = (stored.unsyncedViewed[String(pr)] ?? []).filter((p) => p !== relPath)
      const unsynced = synced ? others : [...others, relPath].sort()
      await this.write({ ...stored, viewed: { ...stored.viewed, [String(pr)]: files }, unsyncedViewed: { ...stored.unsyncedViewed, [String(pr)]: unsynced } })
    })
  }

  markPullRequestSent(ids: readonly string[], to: string): Promise<void> {
    const sent = { to, at: new Date().toISOString() }
    return this.enqueue(async () => {
      const stored = await this.read()
      await this.write({ ...stored, prSent: { ...stored.prSent, ...Object.fromEntries(ids.map((id) => [id, sent])) } })
    })
  }

  add(anchor: ReviewAnchor, body: string): Promise<ReviewComment> {
    return this.enqueue(async () => {
      const comment: ReviewComment = { ...anchor, id: `rc_${randomBytes(6).toString('hex')}`, body, createdAt: new Date().toISOString(), sent: null }
      const stored = await this.read()
      await this.write({ ...stored, comments: [...stored.comments, comment] })
      return comment
    })
  }

  edit(id: string, body: string): Promise<void> {
    return this.change((comments) => comments.map((c) => (c.id === id ? { ...c, body } : c)))
  }

  remove(ids: readonly string[]): Promise<void> {
    return this.change((comments) => comments.filter((c) => !ids.includes(c.id)))
  }

  markSent(ids: readonly string[], to: string): Promise<void> {
    const sent = { to, at: new Date().toISOString() }
    return this.change((comments) => comments.map((c) => (ids.includes(c.id) ? { ...c, sent } : c)))
  }

  private change(update: (comments: ReviewComment[]) => ReviewComment[]): Promise<void> {
    return this.enqueue(async () => {
      const stored = await this.read()
      await this.write({ ...stored, comments: update(stored.comments) })
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task)
    /** The caller sees the failure; later calls still run. */
    this.queue = next.catch(() => undefined)
    return next
  }

  /** An unreadable file reads as empty, and the next write replaces it. */
  private async read(): Promise<StoredReview> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(await this.file(), 'utf8'))
    } catch {
      return { comments: [], prSent: {}, viewed: {}, unsyncedViewed: {} }
    }
    if (typeof parsed !== 'object' || parsed === null) return { comments: [], prSent: {}, viewed: {}, unsyncedViewed: {} }
    const entries = 'comments' in parsed && Array.isArray(parsed.comments) ? parsed.comments : []
    const comments = entries.flatMap((entry: unknown) => {
      const comment = parseComment(entry)
      if (!comment) console.error('manta: skipping an unreadable review comment')
      return comment ? [comment] : []
    })
    return {
      comments,
      prSent: parseSentMarks('prSent' in parsed ? parsed.prSent : undefined),
      viewed: parseViewed('viewed' in parsed ? parsed.viewed : undefined),
      unsyncedViewed: parseUnsynced('unsyncedViewed' in parsed ? parsed.unsyncedViewed : undefined)
    }
  }

  private async write(stored: StoredReview): Promise<void> {
    const file = await this.file()
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, `${JSON.stringify(stored, null, 2)}\n`)
    await rename(`${file}.tmp`, file)
  }
}

function parseViewed(value: unknown): ViewedFiles {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([pr, files]: [string, unknown]) => {
      if (!/^[1-9]\d*$/.test(pr) || typeof files !== 'object' || files === null) return []
      const kept = Object.entries(files).flatMap(([relPath, fingerprint]: [string, unknown]) => (typeof fingerprint === 'string' ? [[relPath, fingerprint]] : []))
      return [[pr, Object.fromEntries(kept)]]
    })
  )
}

function parseUnsynced(value: unknown): UnsyncedViewed {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([pr, paths]: [string, unknown]) =>
      /^[1-9]\d*$/.test(pr) && Array.isArray(paths) ? [[pr, paths.filter((p: unknown): p is string => typeof p === 'string')]] : []
    )
  )
}

function parseSentMarks(value: unknown): PullRequestSentMarks {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, mark]: [string, unknown]) =>
      typeof mark === 'object' && mark !== null && 'to' in mark && typeof mark.to === 'string' && 'at' in mark && typeof mark.at === 'string'
        ? [[id, { to: mark.to, at: mark.at }]]
        : []
    )
  )
}

export function parseComment(value: unknown): ReviewComment | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('id' in value) || typeof value.id !== 'string') return null
  if (!('relPath' in value) || typeof value.relPath !== 'string') return null
  if (!('diff' in value) || !isReviewDiff(value.diff)) return null
  if (!('side' in value) || (value.side !== 'old' && value.side !== 'new')) return null
  if (!('line' in value) || typeof value.line !== 'number' || !Number.isInteger(value.line) || value.line < 1) return null
  if (!('lineText' in value) || typeof value.lineText !== 'string') return null
  if (!('hunk' in value) || typeof value.hunk !== 'string') return null
  if (!('body' in value) || typeof value.body !== 'string') return null
  if (!('createdAt' in value) || typeof value.createdAt !== 'string') return null
  const raw = 'sent' in value ? value.sent : null
  const sent =
    typeof raw === 'object' && raw !== null && 'to' in raw && typeof raw.to === 'string' && 'at' in raw && typeof raw.at === 'string' ? { to: raw.to, at: raw.at } : null
  return {
    id: value.id,
    relPath: value.relPath,
    diff: value.diff,
    side: value.side,
    line: value.line,
    lineText: value.lineText,
    hunk: value.hunk,
    body: value.body,
    createdAt: value.createdAt,
    sent
  }
}
