import { ArrowUp, CloudUpload, Check, ChevronRight, FileText, Minus, Plus, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Changes, FileChange, OpResult } from '../../../shared/ipc'
import { usePersistentSet, useRepoStatus } from '../lib/hooks'

const api = window.manta

interface ChangesPanelProps {
  root: string
  changes: Changes
  openPath: string | null
  /** Changes when the message box should take focus (the status bar's Commit). */
  focusRequest: number
  onOpenFile: (relPath: string) => void
  onOpenDiff: (relPath: string) => void
  onResult: (result: OpResult) => void
  onError: (message: string) => void
}

/** VS Code-style source control: a commit message, then staged and unstaged files with stage, unstage and discard. */
export function ChangesPanel({ root, changes, openPath, focusRequest, onOpenFile, onOpenDiff, onResult, onError }: ChangesPanelProps): React.JSX.Element {
  const draftKey = `manta.commit-message:${root}`
  const [draft, setDraft] = useState(() => localStorage.getItem(draftKey) ?? '')
  const [committing, setCommitting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const repoStatus = useRepoStatus(root)
  const ahead = repoStatus?.ahead ?? 0
  const unpublished = repoStatus?.unpublished ?? false
  const [isCollapsed, toggleCollapsed] = usePersistentSet(`manta.changes-collapsed:${root}`)
  const message = useRef<HTMLTextAreaElement>(null)
  const { staged, unstaged } = changes

  useEffect(() => {
    if (draft) localStorage.setItem(draftKey, draft)
    else localStorage.removeItem(draftKey)
  }, [draftKey, draft])

  useEffect(() => {
    if (focusRequest > 0) message.current?.focus()
  }, [focusRequest])

  const report = (error: unknown): void => onError(error instanceof Error ? error.message : String(error))

  const act = (action: Promise<OpResult | null>): void =>
    void action.then((result) => result && !result.ok && onResult(result)).catch(report)

  const commit = (): void => {
    const text = draft.trim()
    if (!text || committing || staged.length + unstaged.length === 0) return
    setCommitting(true)
    api
      .commit(root, text, 'staged')
      .then((result) => {
        onResult(result)
        if (result.ok) setDraft('')
      })
      .catch(report)
      .finally(() => setCommitting(false))
  }

  const push = (): void => {
    if (pushing) return
    setPushing(true)
    api
      .push(root)
      .then(onResult)
      .catch(report)
      .finally(() => setPushing(false))
  }

  const nothingToCommit = staged.length + unstaged.length === 0
  const commitTitle = nothingToCommit
    ? 'No changes to commit'
    : staged.length > 0
      ? `Commit ${count(staged.length, 'staged file')} (⌘↵)`
      : `Nothing is staged: commits all ${count(unstaged.length, 'change')} (⌘↵)`

  return (
    <div className="changes">
      <div className="commit-box">
        <textarea
          ref={message}
          rows={3}
          value={draft}
          placeholder="Message"
          spellCheck
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.metaKey) {
              e.preventDefault()
              commit()
            }
          }}
        />
        {nothingToCommit && (ahead > 0 || unpublished) ? (
          <button
            className="primary-button accent commit-button"
            title={ahead > 0 ? `Push ${count(ahead, 'commit')} to the remote` : 'Publish this branch to origin'}
            disabled={pushing}
            onClick={push}
          >
            {ahead > 0 ? <ArrowUp size={14} /> : <CloudUpload size={14} />}{' '}
            {ahead > 0 ? (pushing ? 'Pushing…' : `Push ${ahead}`) : pushing ? 'Publishing…' : 'Publish branch'}
          </button>
        ) : (
          <button className="primary-button accent commit-button" title={commitTitle} disabled={!draft.trim() || committing || nothingToCommit} onClick={commit}>
            <Check size={14} /> {committing ? 'Committing…' : 'Commit'}
          </button>
        )}
      </div>

      {nothingToCommit && <div className="row muted-row">No changes since the last commit</div>}

      {staged.length > 0 && (
        <ChangeSection
          label="Staged changes"
          files={staged}
          open={!isCollapsed('staged')}
          onToggle={() => toggleCollapsed('staged')}
          actions={
            <button className="icon-button" title="Unstage all" onClick={() => act(api.unstage(root, staged.map((c) => c.path)))}>
              <Minus size={14} />
            </button>
          }
          renderActions={(change) => (
            <button className="icon-button" title="Unstage" onClick={() => act(api.unstage(root, [change.path]))}>
              <Minus size={14} />
            </button>
          )}
          openPath={openPath}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      )}

      {unstaged.length > 0 && (
        <ChangeSection
          label="Changes"
          files={unstaged}
          open={!isCollapsed('unstaged')}
          onToggle={() => toggleCollapsed('unstaged')}
          actions={
            <>
              <button className="icon-button" title="Discard all changes" onClick={() => act(api.discardChanges(root, unstaged.map((c) => c.path)))}>
                <Undo2 size={14} />
              </button>
              <button className="icon-button" title="Stage all" onClick={() => act(api.stage(root, unstaged.map((c) => c.path)))}>
                <Plus size={14} />
              </button>
            </>
          }
          renderActions={(change) => (
            <>
              <button className="icon-button" title="Discard changes" onClick={() => act(api.discardChanges(root, [change.path]))}>
                <Undo2 size={14} />
              </button>
              <button className="icon-button" title="Stage" onClick={() => act(api.stage(root, [change.path]))}>
                <Plus size={14} />
              </button>
            </>
          )}
          openPath={openPath}
          onOpenFile={onOpenFile}
          onOpenDiff={onOpenDiff}
        />
      )}
    </div>
  )
}

interface ChangeSectionProps {
  label: string
  /** Shown after the label, e.g. what a branch is compared with. */
  detail?: string
  files: FileChange[]
  open: boolean
  onToggle: () => void
  actions: React.ReactNode
  renderActions: (change: FileChange) => React.ReactNode
  openPath: string | null
  onOpenFile: (relPath: string) => void
  onOpenDiff: (relPath: string) => void
  /** Rows of deleted files open a diff too, when both sides come from commits. */
  diffDeleted?: boolean
}

export function ChangeSection({ label, detail, files, open, onToggle, actions, renderActions, openPath, onOpenFile, onOpenDiff, diffDeleted = false }: ChangeSectionProps): React.JSX.Element {
  return (
    <section className="change-section">
      <div className="row change-section-head" onClick={onToggle}>
        <ChevronRight size={14} className={`chevron ${open ? 'open' : ''}`} />
        <span className="label">{label}</span>
        {detail && <span className="section-detail">{detail}</span>}
        {/* Header buttons act on the section, not toggle it. */}
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
        <span className="badge">{files.length}</span>
      </div>
      {open &&
        files.map((change) => (
          <ChangeRow
            key={change.path}
            change={change}
            selected={openPath === change.path}
            onOpenFile={onOpenFile}
            onOpenDiff={() => onOpenDiff(change.path)}
            actions={renderActions(change)}
            diffDeleted={diffDeleted}
          />
        ))}
    </section>
  )
}

interface ChangeRowProps {
  change: FileChange
  selected: boolean
  onOpenFile: (relPath: string) => void
  /** A deleted file has nothing in the working tree to diff against, so its row doesn't open one. */
  onOpenDiff: () => void
  actions?: React.ReactNode
  diffDeleted?: boolean
}

/** One changed file: status letter, name and folder, hover actions, +/− counts. Clicking opens its diff. */
export function ChangeRow({ change, selected, onOpenFile, onOpenDiff, actions, diffDeleted = false }: ChangeRowProps): React.JSX.Element {
  const folder = change.path.includes('/') ? change.path.slice(0, change.path.lastIndexOf('/')) : ''
  const deleted = change.status === 'D'
  return (
    <div className={`row change-row ${selected ? 'selected' : ''}`} title={change.path} onClick={() => (diffDeleted || !deleted) && onOpenDiff()}>
      <span className={`status-letter ${change.status}`}>{change.status}</span>
      <span className="label">
        {change.path.split('/').pop()}
        {folder && <span className="muted-row"> {folder}</span>}
      </span>
      <span className="row-actions" onClick={(e) => e.stopPropagation()}>
        {!deleted && (
          <button className="icon-button" title="Open file" onClick={() => onOpenFile(change.path)}>
            <FileText size={14} />
          </button>
        )}
        {actions}
      </span>
      <span className="stat">
        <span className="add">+{change.added}</span> <span className="del">−{change.removed}</span>
      </span>
    </div>
  )
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
