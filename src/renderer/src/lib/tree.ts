export interface TreeFile {
  kind: 'file'
  name: string
  path: string
}

export interface TreeFolder {
  kind: 'folder'
  name: string
  path: string
  children: TreeNode[]
}

export type TreeNode = TreeFile | TreeFolder

/**
 * Builds a folders-first, alphabetical tree from repo-relative paths, like Obsidian's file
 * explorer. Docs trees hide the `.md` extension; code trees show full file names. `folders`
 * adds folders that hold no files yet, which git doesn't list.
 */
export function buildTree(
  paths: readonly string[],
  { hideMarkdownExtension = true, folders = [] }: { hideMarkdownExtension?: boolean; folders?: readonly string[] } = {}
): TreeNode[] {
  const root: TreeFolder = { kind: 'folder', name: '', path: '', children: [] }
  for (const folderPath of folders) folderAt(root, folderPath.split('/'))
  for (const filePath of paths) {
    const parts = filePath.split('/')
    const folder = folderAt(root, parts.slice(0, -1))
    const name = hideMarkdownExtension ? displayName(filePath) : (parts.at(-1) ?? filePath)
    folder.children.push({ kind: 'file', name, path: filePath })
  }
  sortTree(root)
  return root.children
}

function folderAt(root: TreeFolder, parts: readonly string[]): TreeFolder {
  let folder = root
  parts.forEach((part, index) => {
    let next = folder.children.find((c): c is TreeFolder => c.kind === 'folder' && c.name === part)
    if (!next) {
      next = { kind: 'folder', name: part, path: parts.slice(0, index + 1).join('/'), children: [] }
      folder.children.push(next)
    }
    folder = next
  })
  return folder
}

/** File name without its folder or `.md` extension. */
export function displayName(filePath: string): string {
  return (filePath.split('/').pop() ?? filePath).replace(/\.md$/, '')
}

function sortTree(folder: TreeFolder): void {
  folder.children.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) : a.kind === 'folder' ? -1 : 1
  )
  for (const child of folder.children) if (child.kind === 'folder') sortTree(child)
}
