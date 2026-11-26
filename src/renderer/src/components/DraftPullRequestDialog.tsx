import { useEffect, useRef, useState } from 'react'
import type { OpResult } from '../../../shared/ipc'
import { withoutIpcPrefix } from '../lib/errors'

const api = window.manta

interface DraftPullRequestDialogProps {
  root: string
  /** The Branch tab's compare choice, the default base; null for the repo's default branch. */
  chosenBase: string | null
  onDone: (result: OpResult) => void
  onClose: () => void
}

/** Pushes the branch if GitHub lacks any of it, then opens a draft PR. Errors from git or `gh` show here as they come. */
export function DraftPullRequestDialog({ root, chosenBase, onDone, onClose }: DraftPullRequestDialogProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [base, setBase] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  /** Closed mid-push: a failure then goes to the status bar instead of a dialog no one sees. */
  const closed = useRef(false)
  useEffect(
    () => () => {
      closed.current = true
    },
    []
  )

  useEffect(() => {
    api
      .draftPullRequestDefaults(root, chosenBase)
      .then((defaults) => {
        setTitle((current) => current || defaults.title)
        setBase((current) => current || defaults.base)
      })
      .catch((e: unknown) => setError(withoutIpcPrefix(e instanceof Error ? e.message : String(e))))
  }, [root, chosenBase])

  const create = (): void => {
    if (!title.trim() || !base.trim() || creating) return
    setCreating(true)
    setError(null)
    api
      .createDraftPullRequest(root, { title, body, base })
      .then((result) => {
        if (result.ok || closed.current) onDone(result)
        else setError(result.message)
      })
      .catch((e: unknown) => {
        const message = withoutIpcPrefix(e instanceof Error ? e.message : String(e))
        if (closed.current) onDone({ ok: false, message })
        else setError(message)
      })
      .finally(() => setCreating(false))
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="dialog implement-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>Create draft PR</h2>
        <label className="dialog-field">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="dialog-field">
          <span>Base</span>
          <input value={base} spellCheck={false} onChange={(e) => setBase(e.target.value)} />
        </label>
        <label className="dialog-field">
          <span>Description</span>
          <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        {error ? <p className="dialog-error">{error}</p> : <p className="muted-row">Pushes the branch first if GitHub doesn't have all of it.</p>}
        <div className="dialog-actions">
          {/** Closing doesn't stop a push under way; its outcome then reaches the status bar. */}
          <button type="button" className="primary-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button accent" disabled={!title.trim() || !base.trim() || creating}>
            {creating ? 'Pushing and creating…' : 'Create draft PR'}
          </button>
        </div>
      </form>
    </div>
  )
}
