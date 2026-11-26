import { ChevronRight, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { OpResult, ReviewComment, ReviewDiff } from '../../../shared/ipc'
import { usePersistentSet, useReviewComments } from '../lib/hooks'
import { AgentPicker } from './AgentPicker'

const api = window.manta

interface ReviewCommentsProps {
  root: string
  /** Which diff's comments: the Changes tab shows its own, the Branch tab its own. */
  diff: ReviewDiff
  onOpen: (comment: ReviewComment) => void
  onResult: (result: OpResult) => void
  onError: (message: string) => void
}

const fileName = (relPath: string): string => relPath.split('/').pop() ?? relPath

/**
 * The worktree's review comments on one diff, for sending to an agent as one message. Unsent ones
 * are ticked; sent ones stay greyed with the agent's name until Clear sent. Nothing when there are none.
 */
export function ReviewComments({ root, diff, onOpen, onResult, onError }: ReviewCommentsProps): React.JSX.Element | null {
  const comments = useReviewComments(root).filter((c) => c.diff === diff)
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const [isCollapsed, toggleCollapsed] = usePersistentSet(`manta.review-collapsed:${root}`)
  const [picking, setPicking] = useState<DOMRect | null>(null)
  const closePicker = useCallback(() => setPicking(null), [])

  if (comments.length === 0) return null

  const report = (error: unknown): void => onError(error instanceof Error ? error.message : String(error))
  const chosen = comments.filter((c) => !c.sent && !unticked.has(c.id))
  const sent = comments.filter((c) => c.sent)
  const open = !isCollapsed(diff)
  const tick = (id: string): void =>
    setUnticked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })

  return (
    <section className="change-section review-comments">
      <div className="row change-section-head" onClick={() => toggleCollapsed(diff)}>
        <ChevronRight size={14} className={`chevron ${open ? 'open' : ''}`} />
        <span className="label">Comments</span>
        <span className="badge">{comments.length}</span>
      </div>
      {open && (
        <>
          {comments.map((comment) => (
            <div
              key={comment.id}
              className={`row review-comment-row${comment.sent ? ' sent' : ''}`}
              title={`${comment.relPath}:${comment.line}\n${comment.body}`}
              onClick={() => onOpen(comment)}
            >
              <input
                type="checkbox"
                checked={!comment.sent && !unticked.has(comment.id)}
                disabled={comment.sent !== null}
                onClick={(e) => e.stopPropagation()}
                onChange={() => tick(comment.id)}
              />
              <span className="review-comment-place">
                {fileName(comment.relPath)}:{comment.line}
              </span>
              <span className="review-comment-body">{comment.body.split('\n')[0]}</span>
              {comment.sent && <span className="review-comment-sent">sent to {comment.sent.to}</span>}
              <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                <button className="icon-button" title="Delete comment" onClick={() => api.removeReviewComments(root, [comment.id]).catch(report)}>
                  <X size={14} />
                </button>
              </span>
            </div>
          ))}
          <div className="review-comments-actions">
            {sent.length > 0 && (
              <button className="primary-button small" onClick={() => api.removeReviewComments(root, sent.map((c) => c.id)).catch(report)}>
                Clear sent
              </button>
            )}
            <button className="primary-button small accent" disabled={chosen.length === 0} onClick={(e) => setPicking(e.currentTarget.getBoundingClientRect())}>
              Send {chosen.length} to agent…
            </button>
          </div>
        </>
      )}
      {picking && (
        <AgentPicker
          root={root}
          anchorRect={picking}
          onClose={closePicker}
          onPick={(target) => {
            setPicking(null)
            const ids = chosen.map((c) => c.id)
            api.sendReviewComments(root, ids, target).then(onResult).catch(report)
          }}
        />
      )}
    </section>
  )
}
