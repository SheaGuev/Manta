import type { Project } from '../../../shared/ipc'

/** The parts of a work context that say whether it still exists. */
export interface PlaceContext {
  root: string
  kind: 'docs' | 'worktree' | 'map'
  /** The map of a map context. */
  map?: string
  /** The code project a worktree belongs to; missing in sessions saved before contexts named it. */
  project?: string
}

/** Whether a context can still be opened: its project, its worktree's project, or its map is still there. */
export function contextExists(context: PlaceContext, known: { projects: readonly Project[]; docsRoot: string | null; maps: readonly string[] | null }): boolean {
  if (context.kind === 'map') return context.root === known.docsRoot && context.map !== undefined && (known.maps ?? []).includes(context.map)
  if (context.kind === 'worktree') {
    const { project } = context
    return project !== undefined
      ? known.projects.some((p) => p.kind === 'code' && p.root === project)
      : known.projects.some((p) => p.root === context.root || p.kind === 'code')
  }
  return known.projects.some((p) => p.root === context.root)
}

/** Whether a context belongs to a project being removed: the project itself, one of its worktrees, or a folder inside it. */
export function inProject(context: PlaceContext, projectRoot: string): boolean {
  return context.project === projectRoot || context.root === projectRoot || context.root.startsWith(`${projectRoot}/`)
}
