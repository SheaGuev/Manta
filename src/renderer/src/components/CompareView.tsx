import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { unifiedMergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import type { OpResult } from '../../../shared/ipc'
import { codeHighlight } from '../lib/codeHighlight'
import { diffInsertions } from '../lib/diffInsertions'
import { diffOverview } from '../lib/diffOverview'
import { overlayScrollbars } from '../lib/overlayScrollbars'
import { useDiffComments, type DiffCommentsHandle } from './DiffComments'

const api = window.manta

interface CompareViewProps {
  root: string
  relPath: string
  /** Null compares with nothing: the file was added. */
  from: string | null
  /** The file's path at `from` when it was renamed since. */
  fromPath?: string
  to: string
  /** The comment gutter, from whoever owns the diff's comments; null for none. */
  comments: DiffCommentsHandle | null
  onError: (message: string) => void
}

interface BranchCompareViewProps extends Omit<CompareViewProps, 'comments'> {
  /** Takes review comments: the branch's whole diff, not a single commit's. */
  review: boolean
  /** What sending review comments did. */
  onResult: (result: OpResult) => void
}

/** A compare tab from the Branch tab: the branch's whole diff takes Manta's own review comments. */
export function BranchCompareView({ review, onResult, ...props }: BranchCompareViewProps): React.JSX.Element {
  const comments = useDiffComments({ root: review ? props.root : null, relPath: props.relPath, diff: 'branch', onResult, onError: props.onError })
  return <CompareView {...props} comments={review ? comments : null} />
}

/** A read-only diff of one file between two commits, e.g. a branch's base and HEAD. */
export function CompareView({ root, relPath, from, fromPath = relPath, to, comments, onError }: CompareViewProps): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let disposed = false
    let view: EditorView | null = null
    const language = LanguageDescription.matchFilename(languages, relPath)
    Promise.all([from ? api.fileAt(root, from, fromPath) : null, api.fileAt(root, to, relPath), language ? language.load() : []])
      .then(([before, after, support]) => {
        if (disposed || !host.current) return
        view = new EditorView({
          parent: host.current,
          doc: after ?? '',
          extensions: [
            /** `readOnly` only stops commands; without `editable` false, typing still changes the DOM's text. */
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            lineNumbers(),
            support,
            codeHighlight,
            unifiedMergeView({ original: before ?? '', mergeControls: false, gutter: true }),
            diffInsertions,
            diffOverview,
            overlayScrollbars,
            ...(comments ? [comments.extension] : [])
          ]
        })
        comments?.attach(view)
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
    return () => {
      disposed = true
      comments?.attach(null)
      view?.destroy()
    }
  }, [root, relPath, from, fromPath, to, onError, comments?.extension, comments?.attach])

  return (
    <>
      <div className="editor code" ref={host} />
      {comments?.picker}
    </>
  )
}
