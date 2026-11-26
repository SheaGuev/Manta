import { Hammer, MessageSquarePlus } from 'lucide-react'
import { useState } from 'react'
import type { ThreadInfo } from '../../../shared/ipc'
import { useThreads } from '../lib/hooks'
import { threadStatusLabel } from '../lib/threadMarkers'

const api = window.manta

interface ThreadListProps {
  root: string
  relPath: string
  /** Where the editor's cursor is in the doc; the new thread anchors to that section. */
  cursor: () => number
  onOpenThread: (thread: ThreadInfo) => void
  /** Start implementing the section under the cursor in a code worktree. */
  onImplement: () => void
  onError: (message: string) => void
}

const GROUPS: { label: string; match: (t: ThreadInfo) => boolean }[] = [
  { label: 'Implementations', match: (t) => t.implementation !== null && t.range !== null && t.status !== 'discarded' },
  { label: 'Open', match: (t) => t.implementation === null && t.range !== null && t.status === 'open' },
  { label: 'Merged', match: (t) => t.implementation === null && t.range !== null && (t.status === 'merged' || t.status === 'approved') },
  { label: 'Discarded', match: (t) => t.range !== null && t.status === 'discarded' },
  { label: 'Detached', match: (t) => t.range === null }
]

/** The open doc's threads, every one kept forever (D24), grouped by where they ended up. */
export function ThreadList({ root, relPath, cursor, onOpenThread, onImplement, onError }: ThreadListProps): React.JSX.Element {
  const threads = useThreads(root, relPath)
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')

  const create = (): void => {
    const name = title.trim()
    if (!name) return
    api
      .createThread(root, relPath, cursor(), name)
      .then((thread) => {
        setAdding(false)
        setTitle('')
        onOpenThread(thread)
      })
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  }

  return (
    <>
      {adding ? (
        <form
          className="tree-row"
          style={{ '--depth': 0 }}
          onSubmit={(e) => {
            e.preventDefault()
            create()
          }}
        >
          <input
            className="inline-input"
            autoFocus
            value={title}
            placeholder="What should this thread figure out?"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(false)}
            onBlur={() => !title.trim() && setAdding(false)}
          />
        </form>
      ) : (
        <div className="row" title="Start a thread on the section under the cursor" onClick={() => setAdding(true)}>
          <MessageSquarePlus size={14} />
          <span className="label">New thread on this section</span>
        </div>
      )}
      <div className="row" title="Implement the section under the cursor in a code worktree" onClick={onImplement}>
        <Hammer size={14} />
        <span className="label">Implement this section…</span>
      </div>
      {threads.length === 0 && <div className="row muted-row">No threads in this doc yet</div>}
      {GROUPS.map(({ label, match }) => {
        const group = threads.filter(match)
        if (group.length === 0) return null
        return (
          <div key={label} className="thread-group">
            <div className="group-label">{label}</div>
            {group.map((thread) => (
              <div key={thread.id} className="row thread-row" title={thread.title} onClick={() => onOpenThread(thread)}>
                <span className={`thread-dot ${thread.range ? thread.status : 'detached'}${thread.implementation ? ' implementation' : ''}`} />
                <span className="label">{thread.title}</span>
                {thread.implementation && <span className="thread-row-detail">{threadStatusLabel(thread)}</span>}
              </div>
            ))}
          </div>
        )
      })}
    </>
  )
}
