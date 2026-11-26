import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { OpResult, Project, ProjectKind, ProjectWorktree, ThreadEvent } from '../../shared/ipc'
import { Git, GitError, type Worktree } from './git'
import type { McpAccess, ThreadAgent } from '../agent/threadAgent'
import { Workspace, type UpdateListener } from '../workspace'

interface Settings {
  projects: Project[]
}

export interface ProjectRegistryOptions {
  settingsFile: string
  /** Where app-managed worktrees are created, one folder per project. */
  worktreesDir: string
  onUpdate: (root: string, relPath: string, update: Uint8Array) => void
  /** Called once per workspace the first time it opens, e.g. to start a file watcher. */
  onWorkspaceOpened?: (root: string, workspace: Workspace) => void
  /** Called after a workspace is closed because its worktree is being removed. */
  onWorkspaceClosed?: (root: string) => void
  /** Where thread folders (each thread agent's working directory) are created. */
  threadsDir?: string
  agent?: ThreadAgent
  onThreadEvent?: (root: string, relPath: string, threadId: string, event: ThreadEvent) => void
  /** Where context map folders (each map agent's working directory) are created. */
  mapsDir?: string
  onMapEvent?: (root: string, id: string, event: ThreadEvent) => void
  /** Manta's MCP endpoint for a map's Ask the map agent. */
  mapAgentMcp?: (root: string, map: string) => McpAccess | null
}

/** The worktree folder and `manta/<slug>` branch name for a name. */
export function worktreeSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * The user's projects: one docs repo (source of truth for docs and threads) plus code repos.
 * It is also the gatekeeper for which folders the renderer may touch: project roots and the
 * worktrees of those projects, nothing else.
 */
export class ProjectRegistry {
  private projects: Project[] = []
  private readonly workspaces = new Map<string, Promise<Workspace>>()

  private constructor(private readonly options: ProjectRegistryOptions) {}

  static async load(options: ProjectRegistryOptions): Promise<ProjectRegistry> {
    const registry = new ProjectRegistry(options)
    registry.projects = await readSettings(options.settingsFile)
    return registry
  }

  list(): Project[] {
    return [...this.projects].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'docs' ? -1 : 1))
  }

  /** Adds a repo. There is one docs project; adding another docs repo replaces it and closes the old one's workspace. */
  async add(folder: string, kind: ProjectKind): Promise<Project> {
    const root = await realpath(folder)
    if (!(await new Git(root).isRepoRoot())) throw new Error(`${root} is not the top-level folder of a git repository`)
    const project: Project = { root, name: path.basename(root), kind }
    const replaced = kind === 'docs' ? this.projects.find((p) => p.kind === 'docs' && p.root !== root) : undefined
    this.projects = [...this.projects.filter((p) => p.root !== root && !(kind === 'docs' && p.kind === 'docs')), project]
    await this.save()
    if (replaced) await this.closeWorkspace(replaced.root)
    return project
  }

  async remove(root: string): Promise<void> {
    this.projects = this.projects.filter((p) => p.root !== root)
    await this.save()
  }

  async worktrees(projectRoot: string): Promise<ProjectWorktree[]> {
    const worktrees = await new Git(this.requireProject(projectRoot).root).worktrees()
    const managedDir = await realpath(this.options.worktreesDir).catch(() => this.options.worktreesDir)
    return Promise.all(
      worktrees.map(async (worktree) => {
        const real = await realpath(worktree.path).catch(() => worktree.path)
        return { ...worktree, managed: !worktree.isMain && real.startsWith(managedDir + path.sep) }
      })
    )
  }

  async createWorktree(projectRoot: string, name: string): Promise<ProjectWorktree> {
    const project = this.requireProject(projectRoot)
    const slug = worktreeSlug(name)
    if (!slug) throw new Error('Give the worktree a name')
    const git = new Git(project.root)
    const existing = await git.worktrees()
    if (existing.some((w) => w.branch === `manta/${slug}`)) throw new Error(`A worktree named ${slug} already exists`)
    const projectKey = `${project.name}-${createHash('sha1').update(project.root).digest('hex').slice(0, 8)}`
    const parent = path.join(this.options.worktreesDir, projectKey)
    await mkdir(parent, { recursive: true })
    const worktreePath = path.join(parent, slug)
    await git.addWorktree(worktreePath, `manta/${slug}`)
    const created = (await this.worktrees(project.root)).find((w) => w.branch === `manta/${slug}`)
    if (!created) throw new Error(`git did not report the new worktree at ${worktreePath}`)
    return created
  }

  /**
   * Removes a worktree Manta created, keeping its branch. Refuses one with uncommitted or
   * untracked files before asking `confirm`; returns null when the user cancels.
   */
  async removeWorktree(
    projectRoot: string,
    worktreePath: string,
    confirm: (worktree: ProjectWorktree) => Promise<boolean>
  ): Promise<OpResult | null> {
    const project = this.requireProject(projectRoot)
    const resolved = await realpath(worktreePath)
    const worktrees = await this.worktrees(project.root)
    const real = await Promise.all(worktrees.map((w) => realpath(w.path).catch(() => w.path)))
    const worktree = worktrees.find((_, i) => real[i] === resolved)
    if (!worktree) throw new Error(`${worktreePath} is not a worktree of ${project.name}`)
    if (!worktree.managed) return { ok: false, message: 'Manta only removes worktrees it created; remove this one with git worktree remove' }
    if (await new Git(worktree.path).hasChanges()) {
      return { ok: false, message: `${path.basename(worktree.path)} has uncommitted or untracked files: commit or discard them first` }
    }
    if (!(await confirm(worktree))) return null

    await this.closeWorkspace(resolved)
    try {
      await new Git(project.root).removeWorktree(worktree.path)
    } catch (error) {
      if (error instanceof GitError) return { ok: false, message: error.message }
      throw error
    }
    return { ok: true, message: `Removed worktree ${path.basename(worktree.path)}${worktree.branch ? `; branch ${worktree.branch} kept` : ''}` }
  }

  /** The real path of a project root or one of its worktrees; throws for anything else. */
  async resolveRoot(root: string): Promise<string> {
    const resolved = await realpath(root)
    if (!(await this.isAllowedRoot(resolved))) throw new Error(`${root} is not a project or a worktree of one`)
    return resolved
  }

  /** The workspace for a project root or one of its worktrees, opened on first use. */
  async workspace(root: string): Promise<Workspace> {
    const resolved = await this.resolveRoot(root)
    let opening = this.workspaces.get(resolved)
    if (!opening) {
      const onUpdate: UpdateListener = (relPath, update) => this.options.onUpdate(resolved, relPath, update)
      const { threadsDir, mapsDir, agent, onThreadEvent, onMapEvent, mapAgentMcp } = this.options
      opening = Workspace.open(resolved, onUpdate, {
        ...(threadsDir ? { threadsDir } : {}),
        ...(mapsDir ? { mapsDir } : {}),
        ...(agent ? { agent } : {}),
        ...(onThreadEvent ? { onThreadEvent: (relPath, id, event) => onThreadEvent(resolved, relPath, id, event) } : {}),
        ...(onMapEvent ? { onMapEvent: (id, event) => onMapEvent(resolved, id, event) } : {}),
        ...(mapAgentMcp ? { mapAgentMcp: (map: string) => mapAgentMcp(resolved, map) } : {}),
        codeProjects: () => this.list().filter((p) => p.kind === 'code').map((p) => ({ name: p.name, root: p.root }))
      }).then((workspace) => {
        this.options.onWorkspaceOpened?.(resolved, workspace)
        return workspace
      })
      opening.catch(() => this.workspaces.delete(resolved))
      this.workspaces.set(resolved, opening)
    }
    return opening
  }

  /** Waits for pending writes in every open workspace, then stops their timers. */
  async closeAll(): Promise<void> {
    for (const opening of this.workspaces.values()) {
      const workspace = await opening.catch(() => null)
      await workspace?.idle()
      workspace?.close()
    }
    this.workspaces.clear()
  }

  /** Waits for the workspace's pending writes, then closes it, if one is open for `root`. */
  private async closeWorkspace(root: string): Promise<void> {
    const resolved = await realpath(root).catch(() => root)
    const opening = this.workspaces.get(resolved)
    if (!opening) return
    this.workspaces.delete(resolved)
    const workspace = await opening.catch(() => null)
    await workspace?.idle()
    workspace?.close()
    this.options.onWorkspaceClosed?.(resolved)
  }

  private requireProject(root: string): Project {
    const project = this.projects.find((p) => p.root === root)
    if (!project) throw new Error(`${root} is not a project`)
    return project
  }

  private async isAllowedRoot(root: string): Promise<boolean> {
    if (this.projects.some((p) => p.root === root)) return true
    for (const project of this.projects) {
      const worktrees = await new Git(project.root).worktrees().catch(() => [])
      for (const worktree of worktrees) {
        if ((await realpath(worktree.path).catch(() => worktree.path)) === root) return true
      }
    }
    return false
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.options.settingsFile), { recursive: true })
    const settings: Settings = { projects: this.projects }
    await writeFile(this.options.settingsFile, JSON.stringify(settings, null, 2))
  }
}

async function readSettings(file: string): Promise<Project[]> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null) return []
  if ('projects' in raw && Array.isArray(raw.projects)) return raw.projects.filter(isProject)
  // Step 1 stored a single folder; it was always the docs repo.
  if ('lastFolder' in raw && typeof raw.lastFolder === 'string') {
    return [{ root: raw.lastFolder, name: path.basename(raw.lastFolder), kind: 'docs' }]
  }
  return []
}

function isProject(value: unknown): value is Project {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'kind' in value &&
    (value.kind === 'docs' || value.kind === 'code')
  )
}
