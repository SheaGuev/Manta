import { describe, expect, it } from 'vitest'
import { buildTree, displayName, type TreeNode } from '../tree'

function outline(nodes: TreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(depth)}${n.kind === 'folder' ? n.name + '/' : n.name}`,
    ...(n.kind === 'folder' ? outline(n.children, depth + 1) : [])
  ])
}

describe('buildTree', () => {
  it('nests folders, puts folders first, sorts case-insensitively and drops .md', () => {
    const tree = buildTree(['zeta.md', 'docs/plans/b.md', 'Alpha.md', 'docs/archive/old.md', 'docs/a.md'])
    expect(outline(tree)).toEqual(['docs/', '  archive/', '    old', '  plans/', '    b', '  a', 'Alpha', 'zeta'])
  })

  it('keeps full paths on nodes', () => {
    const [docs] = buildTree(['docs/plans/b.md'])
    expect(docs).toMatchObject({ kind: 'folder', path: 'docs' })
    expect(docs?.kind === 'folder' && docs.children[0]).toMatchObject({ path: 'docs/plans' })
  })

  it('keeps full file names for code trees', () => {
    expect(outline(buildTree(['README.md', 'src/a.ts'], { hideMarkdownExtension: false }))).toEqual(['src/', '  a.ts', 'README.md'])
  })

  it('adds empty folders, merging with folders that have files', () => {
    expect(outline(buildTree(['src/a.ts'], { hideMarkdownExtension: false, folders: ['src/new', 'empty'] }))).toEqual([
      'empty/',
      'src/',
      '  new/',
      '  a.ts'
    ])
  })
})

describe('displayName', () => {
  it('strips folders and the .md extension', () => {
    expect(displayName('docs/inbox/brainstorming iteration.md')).toBe('brainstorming iteration')
  })
})
