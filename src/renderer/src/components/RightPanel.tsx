import { FileDiff, FilePlus, Files, FolderPlus, GitBranch, GitPullRequest, MessagesSquare, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { OpResult, ThreadInfo } from '../../../shared/ipc'
import { useBranch, useChanges, useFiles, useFocusCount, usePersistentSet, usePersistentString } from '../lib/hooks'
import { BranchPanel, type BranchPanelProps } from './BranchPanel'
import { ChangesPanel } from './ChangesPanel'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { FileTree } from './FileTree'
import { InlineInput } from './InlineInput'
import { PullRequestPanel } from './PullRequestPanel'
import { ReviewComments } from './ReviewComments'
import { SearchResults } from './SearchResults'
import { ThreadList } from './ThreadList'

const api = window.manta

export type PanelTab = 'files' | 'changes' | 'branch' | 'pr' | 'threads'

/** A request to focus the search box; `text`, when not empty, replaces the query. */
export interface SearchRequest {
  root: string
  text: string
  seq: number
}

interface RightPanelProps {
  root: string
  tab: PanelTab
  openPath: string | null
  onTab: (tab: PanelTab) => void
  /** `line` is 1-based, for jumping to a search match. */
  onOpenFile: (relPath: string, line?: number) => void
  /** A file or folder was deleted from the Files tab, so its tabs can close. */
  onDeleted: (relPath: string) => void
  /** `line` scrolls the diff to it, e.g. a review comment's; `side` 'old' is a line of the original file. */
  onOpenDiff: (relPath: string, line?: number, side?: 'old' | 'new') => void
  /** A read-only diff between two commits, from the Branch tab; `review` for the branch's whole diff, which takes comments. */
  onOpenCompare: BranchPanelProps['onOpenCompare']
  /** Opens a pull request's review tab, from the PR tab. */
  onReviewFiles: (pullRequest: number) => void
  /** The docs-repo doc whose threads the Threads tab shows; null hides the tab. */
  threadDoc: string | null
  /** The Branch and PR tabs; off in the docs repo. */
  showBranch: boolean
  cursor: () => number
  onOpenThread: (thread: ThreadInfo) => void
  /** Start implementing the section under the cursor in a code worktree. */
  onImplement: () => void
  onError: (message: string) => void
  /** Outcome of a commit or of a git action that failed, for the status bar. */
  onResult: (result: OpResult) => void
  /** Bumped to focus the commit message box. */
  commitFocus: number
  /** The panel acts on it only for its own root: it remounts per context and the request outlives it. */
  searchRequest: SearchRequest | null
  /** In a context map: its title and the docs it lists, which the Files tab and search show unless the user asks for every file. */
  mapDocs: { title: string; paths: readonly string[] } | null
  resizeHandle: React.ReactNode
}

/** Orca-style workspace panel: search, the worktree's files, and what changed versus HEAD. */
export function RightPanel(props: RightPanelProps): React.JSX.Element {
  const { root, openPath, onOpenFile, onOpenDiff, threadDoc, onError } = props
  /** Main refreshes Changes on focus itself; the Branch tab isn't cached there, so it reloads here when the window regains focus. */
  const focusCount = useFocusCount()
  const changes = useChanges(root)
  /** Loaded only while its tab shows: it runs a merge-base and a log. Commits made in a terminal show on focus, like staging. */
  /** The branch the Branch tab compares with, chosen per worktree; null for the default. */
  const [base, setBase] = usePersistentString(`manta.branch-base:${root}`)
  const branch = useBranch(props.tab === 'branch' && props.showBranch ? root : null, base, focusCount)
  const [isExpanded, toggle] = usePersistentSet(`manta.panel-tree:${root}`)
  const [query, setQuery] = useState('')
  const searchBox = useRef<HTMLInputElement>(null)
  const { searchRequest } = props
  useEffect(() => {
    if (!searchRequest || searchRequest.root !== root) return
    if (searchRequest.text) setQuery(searchRequest.text)
    searchBox.current?.focus()
    searchBox.current?.select()
  }, [searchRequest, root])
  /** `target` is the right-clicked file or folder; null on the tree's empty space. */
  const [menu, setMenu] = useState<{ x: number; y: number; folder: string; target: string | null } | null>(null)
  const [creating, setCreating] = useState<{ parent: string; kind: 'file' | 'folder' } | null>(null)
  /** Folders made here that hold no files yet; git doesn't list them, so the tree wouldn't either. */
  const [newFolders, setNewFolders] = useState<string[]>([])
  const tab = (props.tab === 'threads' && !threadDoc) || ((props.tab === 'branch' || props.tab === 'pr') && !props.showBranch) ? 'files' : props.tab
  const searching = query.trim().length > 0
  const allFiles = useFiles(root, 'all', tab === 'files' || searching)
  const [showAll, setShowAll] = useState(false)
  const only = props.mapDocs && !showAll ? props.mapDocs.paths : null
  const files = useMemo(() => (only ? allFiles.filter((file) => only.includes(file)) : allFiles), [allFiles, only])
  const mapDocs = props.mapDocs
  const changeCount = new Set([...changes.staged, ...changes.unstaged].map((change) => change.path)).size

  const onTab = (next: typeof tab): void => {
    setQuery('')
    props.onTab(next)
  }

  const startCreating = (parent: string, kind: 'file' | 'folder'): void => {
    if (parent && !isExpanded(parent)) toggle(parent)
    setCreating({ parent, kind })
  }

  const create = async (name: string): Promise<void> => {
    if (!creating) return
    const relPath = creating.parent ? `${creating.parent}/${name}` : name
    try {
      if (creating.kind === 'file') {
        await api.createFile(root, relPath)
        onOpenFile(relPath)
      } else {
        await api.createFolder(root, relPath)
        setNewFolders((folders) => [...folders, relPath])
        if (!isExpanded(relPath)) toggle(relPath)
      }
      setCreating(null)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const remove = async (relPath: string): Promise<void> => {
    try {
      const result = await api.deletePath(root, relPath)
      if (!result) return
      if (result.ok) {
        setNewFolders((folders) => folders.filter((f) => f !== relPath && !f.startsWith(`${relPath}/`)))
        props.onDeleted(relPath)
      }
      props.onResult(result)
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    }
  }

  const deleteItem = (relPath: string): MenuItem => ({ label: 'Delete', icon: <Trash2 size={14} />, onSelect: () => void remove(relPath) })

  return (
    <section className="panel">
      <div className="panel-search">
        <Search size={14} />
        <input
          ref={searchBox}
          value={query}
          placeholder="Search files and contents"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
        {query && (
          <button className="icon-button" title="Clear search" onClick={() => setQuery('')}>
            <X size={13} />
          </button>
        )}
      </div>
      <div className="panel-tabs" data-tabs={2 + (props.showBranch ? 2 : 0) + (threadDoc ? 1 : 0)}>
        <button className={`icon-button ${tab === 'files' && !searching ? 'active' : ''}`} title="Files" onClick={() => onTab('files')}>
          <Files size={14} /> <span className="tab-label">Files</span>
        </button>
        <button className={`icon-button ${tab === 'changes' && !searching ? 'active' : ''}`} title="Changes" onClick={() => onTab('changes')}>
          <FileDiff size={14} /> <span className="tab-label">Changes</span> {changeCount > 0 && <span className="badge">{changeCount}</span>}
        </button>
        {props.showBranch && (
          <button className={`icon-button ${tab === 'branch' && !searching ? 'active' : ''}`} title="Branch" onClick={() => onTab('branch')}>
            <GitBranch size={14} /> <span className="tab-label">Branch</span>
          </button>
        )}
        {props.showBranch && (
          <button className={`icon-button ${tab === 'pr' && !searching ? 'active' : ''}`} title="Pull request" onClick={() => onTab('pr')}>
            <GitPullRequest size={14} /> <span className="tab-label">PR</span>
          </button>
        )}
        {threadDoc && (
          <button className={`icon-button ${tab === 'threads' && !searching ? 'active' : ''}`} title="Threads" onClick={() => onTab('threads')}>
            <MessagesSquare size={14} /> <span className="tab-label">Threads</span>
          </button>
        )}
      </div>
      <div
        className="panel-scroll"
        onContextMenu={(e) => {
          if (searching || tab !== 'files') return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, folder: '', target: null })
        }}
      >
        {searching ? (
          <SearchResults root={root} files={files} query={query.trim()} only={only} onOpen={onOpenFile} onError={onError} />
        ) : tab === 'threads' && threadDoc ? (
          <ThreadList
            root={root}
            relPath={threadDoc}
            cursor={props.cursor}
            onOpenThread={props.onOpenThread}
            onImplement={props.onImplement}
            onError={onError}
          />
        ) : tab === 'branch' ? (
          <>
            <ReviewComments
              root={root}
              diff="branch"
              onOpen={(comment) => {
                const { base: from, head, files } = branch
                const fromPath = files.find((f) => f.path === comment.relPath)?.oldPath
                if (from && head) props.onOpenCompare(comment.relPath, from.sha, head, `${comment.relPath.split('/').pop() ?? comment.relPath} (vs ${from.label})`, { review: true, fromPath })
              }}
              onResult={props.onResult}
              onError={onError}
            />
            <BranchPanel root={root} branch={branch} base={base} onChooseBase={setBase} onOpenCompare={props.onOpenCompare} onOpenFile={onOpenFile} onError={onError} />
          </>
        ) : tab === 'pr' ? (
          <PullRequestPanel root={root} chosenBase={base} onReviewFiles={props.onReviewFiles} onResult={props.onResult} onError={onError} />
        ) : tab === 'files' ? (
          <>
          {mapDocs && (
            <div className="panel-scope muted-row">
              <span>{showAll ? 'All files in the docs repo' : `The ${files.length} doc${files.length === 1 ? '' : 's'} on “${mapDocs.title}”`}</span>
              <button className="map-link" onClick={() => setShowAll((all) => !all)}>
                {showAll ? 'Only the map’s docs' : 'Show all files'}
              </button>
            </div>
          )}
          <FileTree
            files={files}
            folders={newFolders}
            hideMarkdownExtension={false}
            selectedPath={openPath}
            isExpanded={isExpanded}
            onToggle={toggle}
            onOpen={onOpenFile}
            onContextMenu={(e, node) => {
              const folder = node.kind === 'folder' ? node.path : node.path.slice(0, Math.max(0, node.path.lastIndexOf('/')))
              setMenu({ x: e.clientX, y: e.clientY, folder, target: node.path })
            }}
            pendingInput={
              creating
                ? {
                    parent: creating.parent,
                    render: (depth) => (
                      <InlineInput
                        key={`${creating.parent}:${creating.kind}`}
                        depth={depth}
                        placeholder={creating.kind === 'file' ? 'File name' : 'Folder name'}
                        onCancel={() => setCreating(null)}
                        onSubmit={create}
                      />
                    )
                  }
                : undefined
            }
          />
          </>
        ) : (
          <>
            <ReviewComments root={root} diff="changes" onOpen={(comment) => onOpenDiff(comment.relPath, comment.line, comment.side)} onResult={props.onResult} onError={onError} />
            <ChangesPanel
              root={root}
              changes={changes}
              openPath={openPath}
              focusRequest={props.commitFocus}
              onOpenFile={onOpenFile}
              onOpenDiff={onOpenDiff}
              onResult={props.onResult}
              onError={onError}
            />
          </>
        )}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: 'New File', icon: <FilePlus size={14} />, onSelect: () => startCreating(menu.folder, 'file') },
            { label: 'New Folder', icon: <FolderPlus size={14} />, onSelect: () => startCreating(menu.folder, 'folder') },
            ...(menu.target === null ? [] : [deleteItem(menu.target)])
          ]}
        />
      )}
      {props.resizeHandle}
    </section>
  )
}
