import { Git } from './git'

export interface LandingCheck {
  /** A commit trailer the work's commits carry, e.g. `Manta-Thread: t_1`. */
  trailer: { key: string; value: string }
  branch: string
  /** The branch's commit when the work started; null when it runs on the default branch. */
  base: string | null
}

/**
 * Whether work has landed on the project's default branch (local or `origin`'s): a commit with its
 * trailer is there (survives squash merges that keep the message), or the branch has moved past
 * `base` and its tip is there. Doesn't fetch.
 */
export async function branchLanded(projectRoot: string, check: LandingCheck): Promise<boolean> {
  const git = new Git(projectRoot)
  const target = await git.defaultBranch()
  const refs: string[] = []
  for (const ref of target ? [target, `origin/${target}`] : []) if (await git.resolve(ref)) refs.push(ref)
  for (const ref of refs) if (await git.commitWithTrailer(check.trailer.key, check.trailer.value, ref)) return true
  if (!check.base || !check.branch || check.branch === target) return false
  const tip = await git.resolve(check.branch)
  if (!tip || tip === check.base) return false
  for (const ref of refs) if (await git.isAncestor(tip, ref)) return true
  return false
}
