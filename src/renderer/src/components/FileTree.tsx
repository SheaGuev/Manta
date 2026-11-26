import { ChevronRight } from 'lucide-react'
import { useMemo } from 'react'
import { buildTree, type TreeNode } from '../lib/tree'

interface FileTreeProps {
  files: readonly string[]
  /** Folders with no files yet, which `files` can't express. */
  folders?: readonly string[]
  /** Base depth, so a tree nested under a project row indents past it. */
  depth?: number
  /** Docs trees read like Obsidian, without `.md`; code trees show real file names. */
  hideMarkdownExtension?: boolean
  selectedPath: string | null
  isExpanded: (folderPath: string) => boolean
  onToggle: (folderPath: string) => void
  onOpen: (filePath: string) => void
  onContextMenu?: (event: React.MouseEvent, node: TreeNode) => void
  /** An inline input shown first inside folder `parent` ('' for the top level). */
  pendingInput?: { parent: string; render: (depth: number) => React.ReactNode }
}

export function FileTree({ files, folders, depth = 0, hideMarkdownExtension = true, ...props }: FileTreeProps): React.JSX.Element {
  const nodes = useMemo(() => buildTree(files, { hideMarkdownExtension, folders }), [files, folders, hideMarkdownExtension])
  return <TreeLevel nodes={nodes} parent="" depth={depth} {...props} />
}

type TreeLevelProps = Omit<FileTreeProps, 'files' | 'folders' | 'hideMarkdownExtension'> & {
  nodes: TreeNode[]
  parent: string
  depth: number
}

function TreeLevel({ nodes, parent, depth, ...props }: TreeLevelProps): React.JSX.Element {
  const openMenu = (event: React.MouseEvent, node: TreeNode): void => {
    if (!props.onContextMenu) return
    event.preventDefault()
    event.stopPropagation()
    props.onContextMenu(event, node)
  }
  return (
    <>
      {props.pendingInput?.parent === parent && props.pendingInput.render(depth)}
      {nodes.map((node) =>
        node.kind === 'folder' ? (
          <div key={node.path}>
            <div
              className="row tree-row folder"
              style={{ '--depth': depth }}
              onClick={() => props.onToggle(node.path)}
              onContextMenu={(e) => openMenu(e, node)}
              title={node.path}
            >
              <ChevronRight size={14} className={`chevron ${props.isExpanded(node.path) ? 'open' : ''}`} />
              <span className="label">{node.name}</span>
            </div>
            {props.isExpanded(node.path) && (
              <div className="tree-children" style={{ '--guide': `${21 + depth * 16}px` }}>
                <TreeLevel nodes={node.children} parent={node.path} depth={depth + 1} {...props} />
              </div>
            )}
          </div>
        ) : (
          <div
            key={node.path}
            className={`row tree-row ${props.selectedPath === node.path ? 'selected' : ''}`}
            style={{ '--depth': depth }}
            onClick={() => props.onOpen(node.path)}
            onContextMenu={(e) => openMenu(e, node)}
            title={node.path}
          >
            <span className="spacer-icon" />
            <span className="label">{node.name}</span>
          </div>
        )
      )}
    </>
  )
}
