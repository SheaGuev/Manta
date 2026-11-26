import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import type { BranchSummary, CommitInfo, FileChange } from '../../../shared/ipc'
import { usePersistentSet } from '../lib/hooks'
import { relativeDate } from '../lib/relativeDate'
import { BranchPicker } from './BranchPicker'
import { ChangeRow, ChangeSection } from './ChangesPanel'

const api = window.manta

/** Abbreviated sha, as git shows it. */
const short = (sha: string): string => sha.slice(0, 7)
const fileName = (relPath: string): string => relPath.split('/').pop() ?? relPath

export interface BranchPanelProps {
  root: string
  branch: BranchSummary
  /** The branch chosen to compare with; null for the default. */
  base: string | null
  onChooseBase: (base: string | null) => void
  /**
   * Opens a read-only diff of `relPath` between two commits; `from` null means the file is new. `review`
   * marks the branch's whole diff, which takes comments; `fromPath` is a renamed file's path at `from`.
   */
  onOpenCompare: (relPath: string, from: string | null, to: string, title: string, options?: { review?: boolean; fromPath?: string }) => void
  onOpenFile: (relPath: string) => void
  onError: (message: string) => void
}

/** Orca-style branch view: what this branch has committed since its base, then its commits (collapsed) at the bottom. */
export function BranchPanel({ root, branch, base: chosen, onChooseBase, onOpenCompare, onOpenFile, onError }: BranchPanelProps): React.JSX.Element {
  const [isCollapsed, toggleCollapsed] = usePersistentSet(`manta.branch-collapsed:${root}`)
  const [isOpen, toggleOpen] = usePersistentSet(`manta.branch-open:${root}`)
  const { base, head, files, commits } = branch

  return (
    <div className="branch-panel">
      {head && (
        <div className="row branch-compare">
          <BranchPicker root={root} current={chosen} label={base?.label ?? null} onChoose={onChooseBase} />
        </div>
      )}
      {branch.missingBase && (
        <div className="row muted-row branch-missing">
          {branch.missingBase} no longer exists; {base ? `comparing with ${base.label}` : 'nothing to compare with'}
        </div>
      )}
      {base && head ? (
        files.length > 0 ? (
          <ChangeSection
            label="Committed on branch"
            files={files}
            open={!isCollapsed('committed')}
            onToggle={() => toggleCollapsed('committed')}
            actions={null}
            renderActions={() => null}
            openPath={null}
            diffDeleted
            onOpenFile={onOpenFile}
            onOpenDiff={(relPath) =>
              onOpenCompare(relPath, base.sha, head, `${fileName(relPath)} (vs ${base.label})`, { review: true, fromPath: files.find((f) => f.path === relPath)?.oldPath })
            }
          />
        ) : (
          <div className="row muted-row">No commits since {base.label}</div>
        )
      ) : (
        <div className="row muted-row">{head ? 'Nothing to compare with: this is the default branch and it has no upstream' : 'No commits yet'}</div>
      )}

      {commits.length > 0 && (
        <section className="change-section commits-section">
          <div className="row change-section-head" onClick={() => toggleOpen('commits')}>
            <ChevronRight size={14} className={`chevron ${isOpen('commits') ? 'open' : ''}`} />
            <span className="label">Commits</span>
            <span className="badge">{commits.length}</span>
          </div>
          {isOpen('commits') &&
            commits.map((commit) => (
              <CommitRow key={commit.sha} root={root} commit={commit} onOpenCompare={onOpenCompare} onOpenFile={onOpenFile} onError={onError} />
            ))}
        </section>
      )}
    </div>
  )
}

interface CommitRowProps {
  root: string
  commit: CommitInfo
  onOpenCompare: BranchPanelProps['onOpenCompare']
  onOpenFile: (relPath: string) => void
  onError: (message: string) => void
}

/** A commit; expanding it loads the files it changed. */
function CommitRow({ root, commit, onOpenCompare, onOpenFile, onError }: CommitRowProps): React.JSX.Element {
  const [files, setFiles] = useState<FileChange[] | null>(null)
  const [open, setOpen] = useState(false)

  const toggle = (): void => {
    setOpen((was) => !was)
    if (files) return
    api
      .commitFiles(root, commit.sha)
      .then(setFiles)
      .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  }

  return (
    <>
      <div
        className={`row commit-row ${commit.onBranch ? 'on-branch' : ''}`}
        title={`${commit.subject}\n${commit.author} · ${new Date(commit.date).toLocaleString()}\n${commit.sha}${commit.onBranch ? '\nOn this branch' : ''}`}
        onClick={toggle}
      >
        <ChevronRight size={13} className={`chevron ${open ? 'open' : ''}`} />
        <span className="label">{commit.subject}</span>
        <span className="commit-meta">
          {short(commit.sha)} · {relativeDate(commit.date)}
        </span>
      </div>
      {open &&
        (files === null ? (
          <div className="row muted-row commit-file">Loading…</div>
        ) : files.length === 0 ? (
          <div className="row muted-row commit-file">No file changes</div>
        ) : (
          files.map((change) => (
            <div key={change.path} className="commit-file">
              <ChangeRow
                change={change}
                selected={false}
                diffDeleted
                onOpenFile={onOpenFile}
                onOpenDiff={() => onOpenCompare(change.path, commit.parent, commit.sha, `${fileName(change.path)} (${short(commit.sha)})`, { fromPath: change.oldPath })}
              />
            </div>
          ))
        ))}
    </>
  )
}
