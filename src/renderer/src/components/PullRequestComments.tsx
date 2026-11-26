import type { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpResult, PullRequestDetail, PullRequestReviewInfo, ReviewDiff } from '../../../shared/ipc'
import { commentGutter, setReviewComments, setThreadNotes, type BoxAction, type CommentHandlers } from '../lib/commentGutter'
import { useReviewComments } from '../lib/hooks'
import { inRanges, type LineAnchor, type ThreadNote } from '../lib/reviewAnchors'
import { AgentPicker } from './AgentPicker'
import type { DiffCommentsHandle } from './DiffComments'

const api = window.manta

interface PullRequestCommentsOptions {
  root: string
  pr: PullRequestDetail
  review: PullRequestReviewInfo
  relPath: string
  onResult: (result: OpResult) => void
  onError: (message: string) => void
}

type Ranges = { old: [number, number][]; new: [number, number][] }

const SEND_TITLE = 'Send to an agent (not kept)…'

/**
 * Comments in a PR review's diff: **Add single comment** posts to GitHub at once, **Start a review**
 * holds it pending in Manta, the send icon gives it to an agent without keeping it. Only lines inside
 * the diff's hunks take a + (GitHub refuses the rest), and GitHub's threads show under their lines.
 */
export function usePullRequestComments({ root, pr, review, relPath, onResult, onError }: PullRequestCommentsOptions): DiffCommentsHandle {
  const diff: ReviewDiff = `pr:${review.number}`
  const all = useReviewComments(root)
  const pending = useMemo(() => all.filter((c) => c.diff === diff), [all, diff])
  const comments = useMemo(() => pending.filter((c) => c.relPath === relPath), [pending, relPath])
  const notes = useMemo(
    () =>
      pr.comments.flatMap((c): ThreadNote[] =>
        c.kind === 'thread' && c.path === relPath && !c.outdated && c.line !== null && c.side !== null
          ? [{ id: c.id, side: c.side, line: c.line, author: c.author, body: c.body, replies: c.replies.length, url: c.url }]
          : []
      ),
    [pr.comments, relPath]
  )
  /** Nothing takes a comment until the file's hunks are known. */
  const ranges = useRef<Ranges>({ old: [], new: [] })
  const [sending, setSending] = useState<{ anchor: LineAnchor; body: string; rect: DOMRect } | null>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef({ comments, notes })
  latest.current = { comments, notes }
  const failed = (error: unknown): void => onError(error instanceof Error ? error.message : String(error))

  useEffect(() => {
    ranges.current = { old: [], new: [] }
    let live = true
    api
      .pullRequestCommentable(root, review.base, review.head, relPath)
      .then((found) => {
        if (live) ranges.current = found
      })
      .catch(failed)
    return () => {
      live = false
    }
    // `failed` only reports; reload when the file or the diff changes.
  }, [root, review.base, review.head, relPath])

  const actions = (): readonly BoxAction[] => [
    { id: 'single', label: 'Add single comment', accent: false },
    { id: 'review', label: pending.length > 0 ? 'Add review comment' : 'Start a review', accent: true }
  ]
  const handlers = useRef<CommentHandlers>({ onSave: async () => false, onRemove: () => undefined, actions, sendTitle: SEND_TITLE })
  handlers.current = {
    /** A comment GitHub or the store refused keeps its box and text, so nothing typed is lost. */
    onSave: async (anchor, body, action, rect) => {
      try {
        if (action === 'single') {
          const result = await api.postPullRequestComment(root, review.number, review.head, { ...anchor, relPath, diff }, body)
          onResult(result)
          return result.ok
        }
        if (action === 'review') {
          await api.addReviewComment(root, { ...anchor, relPath, diff }, body)
          return true
        }
        if (action === 'send' && rect) setSending({ anchor, body, rect })
        return true
      } catch (error) {
        failed(error)
        return false
      }
    },
    onRemove: (id) => {
      api.removeReviewComments(root, [id]).catch(failed)
    },
    actions,
    canComment: (side, line) => inRanges(ranges.current[side], line),
    sendTitle: SEND_TITLE
  }

  const extension = useMemo(() => commentGutter(handlers), [])
  const attach = useCallback((next: EditorView | null) => {
    view.current = next
    next?.dispatch({ effects: [setReviewComments.of(latest.current.comments), setThreadNotes.of(latest.current.notes)] })
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: [setReviewComments.of(comments), setThreadNotes.of(notes)] })
  }, [comments, notes])

  const closePicker = useCallback(() => setSending(null), [])
  const picker = sending ? (
    <AgentPicker
      root={root}
      anchorRect={sending.rect}
      onClose={closePicker}
      onPick={(target) => {
        setSending(null)
        api.sendReviewDraft(root, { ...sending.anchor, relPath, diff }, sending.body, target).then(onResult).catch(failed)
      }}
    />
  ) : null

  return { extension, attach, picker }
}
