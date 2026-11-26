import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { OpResult, PullRequestDetail, PullRequestReviewFile, PullRequestReviewInfo, PullRequestReviewOpen } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'
import { useFocusCount, usePullRequest, useReviewComments } from '../lib/hooks'
import { CompareView } from './CompareView'
import { FinishReviewDialog } from './FinishReviewDialog'
import { usePullRequestComments } from './PullRequestComments'

const api = window.manta

interface PullRequestReviewProps {
  root: string
  pullRequest: number
  onResult: (result: OpResult) => void
  onError: (message: string) => void
}

const folderOf = (relPath: string): string => (relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '')

/**
 * A pull request's review tab: its changed files on the left, each ticked as viewed, and the selected
 * file's diff on the right with GitHub's threads and the comment box. Reopens when the PR's head moves.
 */
export function PullRequestReview({ root, pullRequest, onResult, onError }: PullRequestReviewProps): React.JSX.Element {
  const focusCount = useFocusCount()
  const { status } = usePullRequest(root, focusCount)
  const pr = status?.kind === 'found' && status.pr.number === pullRequest ? status.pr : null
  const [opened, setOpened] = useState<PullRequestReviewOpen | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)
  const pendingComments = useReviewComments(root).filter((c) => c.diff === `pr:${pullRequest}`)
  const pending = pendingComments.length
  const head = pr?.headRefOid ?? null

  useEffect(() => {
    if (!head) return
    let live = true
    api
      .openPullRequestReview(root, pullRequest)
      .then((result) => {
        if (!live) return
        setOpened(result)
        if (result.ok) setSelected((current) => (current && result.review.files.some((f) => f.path === current) ? current : (result.review.files[0]?.path ?? null)))
      })
      .catch((error: unknown) => live && setOpened({ ok: false, message: withoutIpcPrefix(error instanceof Error ? error.message : String(error)) }))
    return () => {
      live = false
    }
  }, [root, pullRequest, head])

  if (!status || (pr && !opened)) return <div className="pr-review-message muted-row">Fetching the pull request…</div>
  if (!pr) return <div className="pr-review-message muted-row">This branch no longer has pull request #{pullRequest}.</div>
  if (!opened?.ok) return <div className="pr-review-message dialog-error">{opened?.message}</div>

  const review = opened.review
  const viewed = review.files.filter((f) => f.viewed).length
  const file = review.files.find((f) => f.path === selected) ?? null
  const orphans = pendingComments.filter((c) => !review.files.some((f) => f.path === c.relPath))

  const toggleViewed = (target: PullRequestReviewFile): void => {
    const nowViewed = !target.viewed
    api
      .setPullRequestFileViewed(root, review.number, target.path, nowViewed ? target.fingerprint : null)
      .then((result) => {
        if (result.message) onResult(result)
        /** From the current state: a second tick made while this one was on its way must not be undone. */
        setOpened((current) =>
          current?.ok && current.review.head === review.head
            ? { ok: true, review: { ...current.review, files: current.review.files.map((f) => (f.path === target.path ? { ...f, viewed: nowViewed } : f)) } }
            : current
        )
        /** Like GitHub: ticking a file moves on to the next one not yet viewed. */
        if (nowViewed && target.path === selected) {
          const at = review.files.findIndex((f) => f.path === target.path)
          const next = [...review.files.slice(at + 1), ...review.files.slice(0, at)].find((f) => !f.viewed)
          if (next) setSelected(next.path)
        }
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  }

  return (
    <div className="pr-review">
      <aside className="pr-review-files">
        <div className="pr-review-head">
          <span className="pr-review-count">
            {viewed} of {review.files.length} viewed
          </span>
          <button className="primary-button small accent" onClick={() => setFinishing(true)}>
            Finish review {pending > 0 && <span className="badge">{pending}</span>}
          </button>
        </div>
        {review.unpushed && <div className="pr-review-note muted-row">Showing the PR on GitHub; this worktree has commits it doesn't.</div>}
        {orphans.length > 0 && (
          <div className="pr-review-orphans">
            <div className="pr-review-note muted-row">Pending on files no longer in the PR; delete them to finish the review:</div>
            {orphans.map((c) => (
              <div key={c.id} className="row review-comment-row" title={c.body}>
                <span className="review-comment-place">
                  {c.relPath.split('/').pop()}:{c.line}
                </span>
                <span className="review-comment-body">{c.body.split('\n')[0]}</span>
                <button className="icon-button" title="Delete comment" onClick={() => api.removeReviewComments(root, [c.id]).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="pr-review-list">
          {review.files.map((f) => (
            <div key={f.path} className={`row change-row pr-review-row ${f.path === selected ? 'selected' : ''}`} title={f.path} onClick={() => setSelected(f.path)}>
              <input type="checkbox" checked={f.viewed} title="Viewed" onClick={(e) => e.stopPropagation()} onChange={() => toggleViewed(f)} />
              <span className={`label${f.viewed ? ' viewed' : ''}`}>
                {f.path.split('/').pop()}
                {folderOf(f.path) && <span className="muted-row"> {folderOf(f.path)}</span>}
              </span>
              <span className="stat">
                <span className="add">+{f.added}</span> <span className="del">−{f.removed}</span>
              </span>
            </div>
          ))}
        </div>
      </aside>
      <section className="pr-review-diff">
        {file && <ReviewedFile key={`${review.head}:${file.path}`} root={root} pr={pr} review={review} file={file} onResult={onResult} onError={onError} />}
      </section>
      {finishing && (
        <FinishReviewDialog
          own={review.own}
          pending={pending}
          onClose={() => setFinishing(false)}
          onSubmit={async (input) => {
            const result = await api.submitPullRequestReview(root, review.number, review.base, review.head, input)
            if (result.ok) onResult(result)
            return result
          }}
        />
      )}
    </div>
  )
}

interface ReviewedFileProps {
  root: string
  pr: PullRequestDetail
  review: PullRequestReviewInfo
  file: PullRequestReviewFile
  onResult: (result: OpResult) => void
  onError: (message: string) => void
}

function ReviewedFile({ root, pr, review, file, onResult, onError }: ReviewedFileProps): React.JSX.Element {
  const comments = usePullRequestComments({ root, pr, review, relPath: file.path, onResult, onError })
  return <CompareView root={root} relPath={file.path} from={file.status === 'A' ? null : review.base} fromPath={file.oldPath} to={review.head} comments={comments} onError={onError} />
}
