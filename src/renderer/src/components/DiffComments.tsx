import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpResult, ReviewDiff } from '../../../shared/ipc'
import { commentGutter, setReviewComments, type BoxAction, type CommentHandlers } from '../lib/commentGutter'
import { useReviewComments } from '../lib/hooks'
import { AgentPicker } from './AgentPicker'

const api = window.manta

interface DiffCommentsOptions {
  /** Null turns review comments off (an editor that isn't showing a diff). */
  root: string | null
  relPath: string
  diff: ReviewDiff
  onResult: (result: OpResult) => void
  onError: (message: string) => void
}

/**
 * Review comments for one diff view: the gutter extension to add to its editor, `attach` to call
 * with the view once it exists (and null when it goes), and the agent picker to render when a
 * comment is sent straight away.
 */
const COMMENT_ACTIONS: readonly BoxAction[] = [{ id: 'comment', label: 'Comment', accent: true }]
const SEND_TITLE = 'Comment and send to an agent…'

/** What a diff view needs for comments: the extension, `attach` for its view, and a picker to render. */
export interface DiffCommentsHandle {
  extension: Extension
  attach: (view: EditorView | null) => void
  picker: React.JSX.Element | null
}

export function useDiffComments({ root, relPath, diff, onResult, onError }: DiffCommentsOptions): DiffCommentsHandle {
  const all = useReviewComments(root)
  const comments = useMemo(() => all.filter((c) => c.relPath === relPath && c.diff === diff), [all, relPath, diff])
  const [sending, setSending] = useState<{ ids: string[]; rect: DOMRect } | null>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(comments)
  latest.current = comments
  const failed = (error: unknown): void => onError(error instanceof Error ? error.message : String(error))

  const handlers = useRef<CommentHandlers>({ onSave: async () => false, onRemove: () => undefined, actions: () => COMMENT_ACTIONS, sendTitle: SEND_TITLE })
  handlers.current = {
    onSave: async (anchor, body, action, rect) => {
      if (!root) return false
      try {
        const comment = await api.addReviewComment(root, { ...anchor, relPath, diff }, body)
        if (action === 'send' && rect) setSending({ ids: [comment.id], rect })
        return true
      } catch (error) {
        failed(error)
        return false
      }
    },
    onRemove: (id) => {
      if (root) api.removeReviewComments(root, [id]).catch(failed)
    },
    actions: () => COMMENT_ACTIONS,
    sendTitle: SEND_TITLE
  }

  const extension = useMemo(() => commentGutter(handlers), [])
  const attach = useCallback((next: EditorView | null) => {
    view.current = next
    next?.dispatch({ effects: setReviewComments.of(latest.current) })
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: setReviewComments.of(comments) })
  }, [comments])

  const closePicker = useCallback(() => setSending(null), [])
  const picker =
    root && sending ? (
      <AgentPicker
        root={root}
        anchorRect={sending.rect}
        onClose={closePicker}
        onPick={(target) => {
          setSending(null)
          api.sendReviewComments(root, sending.ids, target).then(onResult).catch(failed)
        }}
      />
    ) : null

  return { extension, attach, picker }
}
