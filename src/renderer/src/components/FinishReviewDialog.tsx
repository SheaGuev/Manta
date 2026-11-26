import { useState } from 'react'
import type { OpResult, ReviewEvent } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'

interface FinishReviewDialogProps {
  /** The viewer wrote the PR: GitHub allows only a comment review. */
  own: boolean
  pending: number
  onSubmit: (input: { event: ReviewEvent; body: string }) => Promise<OpResult>
  onClose: () => void
}

const EVENTS: { event: ReviewEvent; label: string; hint: string }[] = [
  { event: 'COMMENT', label: 'Comment', hint: 'Feedback without a verdict' },
  { event: 'APPROVE', label: 'Approve', hint: 'Ready to merge' },
  { event: 'REQUEST_CHANGES', label: 'Request changes', hint: 'Must be addressed before merging' }
]

/** Submits the pending review to GitHub with a summary and a verdict, as GitHub's own Finish review does. */
export function FinishReviewDialog({ own, pending, onSubmit, onClose }: FinishReviewDialogProps): React.JSX.Element {
  const [body, setBody] = useState('')
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const submit = (): void => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    onSubmit({ event, body })
      .then((result) => {
        if (result.ok) onClose()
        else setError(result.message)
      })
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
      .finally(() => setSubmitting(false))
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog implement-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>Finish review</h2>
        <label className="dialog-field">
          <span>Summary</span>
          <textarea
            autoFocus
            rows={5}
            value={body}
            placeholder="Leave a summary"
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                submit()
              }
            }}
          />
        </label>
        <div className="review-events">
          {EVENTS.map((option) => {
            const blocked = own && option.event !== 'COMMENT'
            return (
              <label key={option.event} className={`review-event${blocked ? ' disabled' : ''}`} title={blocked ? "You can't approve or request changes on your own PR" : undefined}>
                <input type="radio" name="review-event" checked={event === option.event} disabled={blocked} onChange={() => setEvent(option.event)} />
                <span>{option.label}</span>
                <span className="muted-row">{option.hint}</span>
              </label>
            )
          })}
        </div>
        {error ? (
          <p className="dialog-error">{error}</p>
        ) : (
          <p className="muted-row">{pending === 0 ? 'No pending comments.' : pending === 1 ? '1 pending comment goes with it.' : `${pending} pending comments go with it.`}</p>
        )}
        <div className="dialog-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button accent" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit review'}
          </button>
        </div>
      </form>
    </div>
  )
}
