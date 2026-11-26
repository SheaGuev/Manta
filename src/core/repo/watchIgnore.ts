/**
 * Folders whose changes never matter to Manta's panels: git's own, dependencies and build output.
 * The same set VS Code and Orca exclude from recursive watches; `node_modules` alone can churn
 * thousands of events during an install.
 */
const WATCH_IGNORED: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'target', '.venv', '__pycache__'])

/** Whether a changed path (relative to the watched root, `/`-separated) is inside an ignored folder, at any depth. */
export function isWatchIgnored(relPath: string): boolean {
  return relPath.split('/').some((part) => WATCH_IGNORED.has(part))
}
