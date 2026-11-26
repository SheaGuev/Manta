import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { ChangeStatus, Changes, CommitInfo, ContentMatch, FileChange, Worktree } from '../../shared/ipc'
import { isWatchIgnored } from './watchIgnore'

export type { ChangeStatus, Changes, CommitInfo, ContentMatch, FileChange, Worktree }

const execFileAsync = promisify(execFile)

/** git's well-known empty tree, used to diff against in a repo that has no commits yet. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Parses `git worktree list --porcelain`. The first entry is always the main worktree. */
export function parseWorktrees(output: string): Worktree[] {
  return output
    .split('\n\n')
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => {
      const fields = new Map(block.split('\n').map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)] as const))
      const branch = fields.get('branch')
      return {
        path: fields.get('worktree') ?? '',
        branch: branch ? branch.replace(/^refs\/heads\//, '') : null,
        head: fields.get('HEAD') ?? '',
        isMain: index === 0
      }
    })
}

export interface DiffStat {
  added: number
  removed: number
}

/** Everything the Changes tab and the status bar show, from one `Git.statusSnapshot`. */
export interface StatusSnapshot {
  branch: string
  /** Commits on HEAD its upstream doesn't have; 0 without an upstream. */
  ahead: number
  /** On a branch with commits but no upstream. */
  unpublished: boolean
  changes: Changes
  /** The working tree versus HEAD, untracked files included. */
  stat: DiffStat
}

/** Line count the way git reports it: a final line without a trailing newline still counts. */
export function countLines(text: string): number {
  if (text.length === 0) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** `MANTA_GIT_TRACE=1` logs every git command Manta runs, to measure how often panels refresh. */
const TRACE = process.env['MANTA_GIT_TRACE'] === '1'

/** Untracked files read at once when counting their lines: parallel, without opening thousands of files together. */
const READ_BATCH = 16

/** Per-file counts from `git diff --numstat -z`, keyed by the new path. Binary files count 0. */
export function parseNumstatZ(output: string): Map<string, DiffStat> {
  const counts = new Map<string, DiffStat>()
  const fields = output.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const [a, r, file] = (fields[i] ?? '').split('\t')
    if (a === undefined || r === undefined || file === undefined) continue
    const count = { added: a === '-' ? 0 : Number(a), removed: r === '-' ? 0 : Number(r) }
    // A rename leaves the path empty and puts the old and new paths in the next two fields.
    if (file === '') {
      const to = fields[i + 2]
      if (to) counts.set(to, count)
      i += 2
    } else {
      counts.set(file, count)
    }
  }
  return counts
}

/** Paths and statuses from `git status --porcelain -z`, split into staged and unstaged. */
export function parseStatus(output: string): { staged: StatusEntry[]; unstaged: StatusEntry[] } {
  const staged: StatusEntry[] = []
  const unstaged: StatusEntry[] = []
  const entries = output.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry || entry.startsWith('## ')) continue
    const x = entry.charAt(0)
    const y = entry.charAt(1)
    const file = entry.slice(3)
    // Renames carry the original path as the next NUL-separated field.
    if (x === 'R' || x === 'C') i++
    if (x === '?') {
      unstaged.push({ path: file, status: 'U' })
    } else if (UNMERGED.includes(x + y)) {
      unstaged.push({ path: file, status: 'C' })
    } else {
      const index = statusLetter(x)
      const tree = statusLetter(y)
      if (index) staged.push({ path: file, status: index })
      if (tree) unstaged.push({ path: file, status: tree })
    }
  }
  return { staged, unstaged }
}

/** The branch in `git status --branch`'s `## ` header: empty when detached, as `branch --show-current` reports it. */
export function parseBranchHeader(header: string): { branch: string; unborn: boolean; ahead: number; hasUpstream: boolean } {
  const text = header.replace(/^## /, '')
  if (text.startsWith(NO_COMMITS)) return { branch: text.slice(NO_COMMITS.length), unborn: true, ahead: 0, hasUpstream: false }
  if (text.startsWith('HEAD (no branch)')) return { branch: '', unborn: false, ahead: 0, hasUpstream: false }
  /** Only a branch with an upstream reports `[ahead N, behind M]`. */
  const ahead = Number(/\[ahead (\d+)/.exec(text)?.[1] ?? 0)
  return { branch: text.split('...')[0]?.split(' ')[0] ?? '', unborn: false, ahead, hasUpstream: text.includes('...') }
}

const NO_COMMITS = 'No commits yet on '

/** Parses `git diff --name-status -z`: a status, then the path, or the old and new paths for a rename or copy. */
export function parseNameStatusZ(output: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  const fields = output.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]
    if (!code) continue
    const letter = code.charAt(0)
    if (letter === 'R' || letter === 'C') {
      const from = fields[i + 1]
      const to = fields[i + 2]
      i += 2
      if (to) entries.push(letter === 'R' && from ? { path: to, status: 'R', oldPath: from } : { path: to, status: 'A' })
    } else {
      const file = fields[++i]
      const status = statusLetter(letter)
      if (file && status) entries.push({ path: file, status })
    }
  }
  return entries
}

const FIELD = '\x1f'
const RECORD = '\x1e'
/** `git log --format` for `parseLog`: sha, parents, author, author date, subject. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%aI', '%s'].join('%x1f') + '%x1e'

/** Parses `git log --format=LOG_FORMAT`. `onBranch` is set from `branchShas`. */
export function parseLog(output: string, branchShas: ReadonlySet<string>): CommitInfo[] {
  const commits: CommitInfo[] = []
  for (const record of output.split(RECORD)) {
    const [sha, parents, author, date, subject] = record.trim().split(FIELD)
    if (!sha || parents === undefined || author === undefined || date === undefined || subject === undefined) continue
    commits.push({ sha, parent: parents.split(' ')[0] || null, subject, author, date, onBranch: branchShas.has(sha) })
  }
  return commits
}

export interface StatusEntry {
  path: string
  status: ChangeStatus
  /** A rename's path before it. */
  oldPath?: string
}

const UNMERGED: readonly string[] = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']

/** One column of a porcelain status code; null for unchanged (space) and ignored (`!`). */
function statusLetter(code: string): ChangeStatus | null {
  if (code === 'M' || code === 'T') return 'M'
  if (code === 'A' || code === 'C') return 'A'
  if (code === 'D') return 'D'
  if (code === 'R') return 'R'
  return null
}

/** Parses `git grep -z -n`: `path NUL line NUL text` per line. */
export function parseGrep(output: string): ContentMatch[] {
  const matches: ContentMatch[] = []
  for (const entry of output.split('\n')) {
    const [file, line, ...rest] = entry.split('\0')
    if (!file || !line) continue
    matches.push({ path: file, line: Number(line), text: rest.join('\0') })
  }
  return matches
}

/** A ref from outside that git can't mistake for an option or a range. */
export function isSafeRef(ref: string): boolean {
  return ref.length > 0 && !ref.startsWith('-') && !ref.includes('..') && !/[\s\x00-\x1f\x7f]/.test(ref)
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly stderr: string,
    readonly exitCode: number | null = null
  ) {
    super(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  }
}

/**
 * Thin wrapper over the git CLI. Shelling out (rather than a JS git library) keeps
 * worktrees, hooks, credentials and user config behaving exactly as in the terminal.
 */
export class Git {
  /** `hidden` paths are left out of status, diff stats, `hasChanges` and `commitAll`, as if git didn't track them. */
  constructor(
    readonly cwd: string,
    private readonly hidden: readonly string[] = []
  ) {}

  /** Pathspec arguments that leave out the hidden paths; `--` included. */
  private visible(): string[] {
    return this.hidden.length === 0 ? [] : ['--', '.', ...this.hidden.map((hidden) => `:(exclude)${hidden}`)]
  }

  /** Adds `pattern` to the repo's local ignore file (`info/exclude`), which is never committed. */
  async excludeLocally(pattern: string): Promise<void> {
    const file = path.resolve(this.cwd, (await this.run(['rev-parse', '--git-path', 'info/exclude'])).trim())
    const current = await readFile(file, 'utf8').catch(() => '')
    if (current.split('\n').some((line) => line.trim() === pattern)) return
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${pattern}\n`)
  }

  async run(args: readonly string[]): Promise<string> {
    if (TRACE) console.log(`manta:git ${this.cwd} ${args.slice(0, 3).join(' ')}`)
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 })
      return stdout
    } catch (error) {
      const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error)
      const exitCode = error instanceof Error && 'code' in error && typeof error.code === 'number' ? error.code : null
      throw new GitError(args, stderr, exitCode)
    }
  }

  async isRepoRoot(): Promise<boolean> {
    try {
      const top = (await this.run(['rev-parse', '--show-toplevel'])).trim()
      // git reports symlink-resolved paths (macOS /var -> /private/var), so compare real paths.
      return (await realpath(top)) === (await realpath(this.cwd))
    } catch {
      return false
    }
  }

  async init(): Promise<void> {
    await this.run(['init'])
  }

  async gitDir(): Promise<string> {
    return path.resolve(this.cwd, (await this.run(['rev-parse', '--git-dir'])).trim())
  }

  /** Commit sha for `ref`, or null when it doesn't resolve (e.g. HEAD in a repo with no commits). */
  async resolve(ref: string): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim()
    } catch {
      return null
    }
  }

  /** File contents at `ref`, or null when the file doesn't exist there. */
  async show(ref: string, relPath: string): Promise<string | null> {
    try {
      return await this.run(['show', `${ref}:${relPath}`])
    } catch {
      return null
    }
  }

  async upstream(): Promise<string | null> {
    try {
      return (await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim()
    } catch {
      return null
    }
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.run(['merge-base', '--is-ancestor', ancestor, descendant])
      return true
    } catch {
      return false
    }
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    const out = await this.run(['diff', '--name-only', '-z', from, to])
    return out.split('\0').filter(Boolean)
  }

  async listMarkdown(): Promise<string[]> {
    return this.listFiles(['*.md'])
  }

  /**
   * Tracked plus untracked-but-not-ignored files, optionally limited to pathspecs. With no pathspecs it
   * also lists gitignored `.env*` files outside dependency and build folders, which are config you edit
   * even though git ignores them. `grep` doesn't search those, so secrets stay out of search results.
   */
  async listFiles(pathspecs: readonly string[] = []): Promise<string[]> {
    const out = await this.run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs])
    const files = out.split('\0').filter(Boolean)
    if (pathspecs.length === 0) {
      const env = await this.run(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--', ':(glob)**/.env*'])
      for (const file of env.split('\0')) if (file && !isWatchIgnored(file)) files.push(file)
    }
    return [...new Set(files)].sort()
  }

  /**
   * Lines containing `query` (literal, case-insensitive) in the same files `listFiles` returns
   * (except ignored `.env*` files), binaries skipped. At most `perFile` lines per file, so one huge file can't flood the results.
   */
  async grep(query: string, perFile: number): Promise<ContentMatch[]> {
    try {
      const out = await this.run(['grep', '-z', '-n', '-I', '-i', '-F', '--untracked', '--no-color', '-m', String(perFile), '-e', query])
      return parseGrep(out)
    } catch (error) {
      // git grep exits 1 when nothing matches.
      if (error instanceof GitError && error.exitCode === 1) return []
      throw error
    }
  }

  async worktrees(): Promise<Worktree[]> {
    return parseWorktrees(await this.run(['worktree', 'list', '--porcelain']))
  }

  async addWorktree(worktreePath: string, branch: string): Promise<void> {
    await this.run(['worktree', 'add', '-q', '-b', branch, worktreePath, 'HEAD'])
  }

  /** Without `--force`, git refuses a worktree with modified or untracked files. Ignored files are deleted. */
  async removeWorktree(worktreePath: string): Promise<void> {
    await this.run(['worktree', 'remove', worktreePath])
  }

  /**
   * The branch, staged and unstaged changes with per-file line counts, and the working tree's
   * lines added and removed versus HEAD, in four git commands. `--no-optional-locks` keeps `status`
   * from rewriting the index, so reading never looks like a change. `lines` counts an untracked file.
   */
  async statusSnapshot(lines: (file: string) => Promise<number> = (file) => this.lineCount(file)): Promise<StatusSnapshot> {
    const status = await this.run(['--no-optional-locks', 'status', '--porcelain', '-z', '--branch', '--untracked-files=all', ...this.visible()])
    const { branch, unborn, ahead, hasUpstream } = parseBranchHeader(status.split('\0')[0] ?? '')
    const base = unborn ? EMPTY_TREE : 'HEAD'
    const [cached, tree, sinceHead] = await Promise.all([
      this.run(['diff', '--cached', '--numstat', '-z', base, ...this.visible()]),
      this.run(['diff', '--numstat', '-z', ...this.visible()]),
      this.run(['diff', '--numstat', '-z', base, ...this.visible()])
    ])
    const { staged, unstaged } = parseStatus(status)
    const untracked = new Map<string, number>()
    const untrackedPaths = unstaged.filter((entry) => entry.status === 'U').map((entry) => entry.path)
    for (let i = 0; i < untrackedPaths.length; i += READ_BATCH) {
      const batch = untrackedPaths.slice(i, i + READ_BATCH)
      const counts = await Promise.all(batch.map(lines))
      batch.forEach((file, at) => untracked.set(file, counts[at] ?? 0))
    }
    const withCounts = (entry: StatusEntry, counts: Map<string, DiffStat>): FileChange => ({
      ...entry,
      ...(counts.get(entry.path) ?? { added: entry.status === 'U' ? (untracked.get(entry.path) ?? 0) : 0, removed: 0 })
    })
    const byPath = (a: FileChange, b: FileChange): number => a.path.localeCompare(b.path)
    const stat = { added: 0, removed: 0 }
    for (const count of [...parseNumstatZ(sinceHead).values(), ...[...untracked.values()].map((added) => ({ added, removed: 0 }))]) {
      stat.added += count.added
      stat.removed += count.removed
    }
    const unpublished = !!branch && !unborn && !hasUpstream
    return {
      branch,
      ahead,
      unpublished,
      changes: {
        staged: staged.map((entry) => withCounts(entry, parseNumstatZ(cached))).sort(byPath),
        unstaged: unstaged.map((entry) => withCounts(entry, parseNumstatZ(tree))).sort(byPath)
      },
      stat
    }
  }

  /** Staged changes (index versus HEAD) and unstaged ones (working tree versus index), with per-file line counts. */
  async changes(): Promise<Changes> {
    return (await this.statusSnapshot()).changes
  }

  /** A file's lines; a file that went between listing and reading counts 0. */
  async lineCount(file: string): Promise<number> {
    return countLines(await readFile(path.join(this.cwd, file), 'utf8').catch(() => ''))
  }

  /** `-A` so a deleted file stages its deletion. */
  async stage(paths: readonly string[]): Promise<void> {
    await this.run(['add', '-A', '--', ...paths])
  }

  /** Back to HEAD's version in the index; the working tree is untouched. */
  async unstage(paths: readonly string[]): Promise<void> {
    // `restore --staged` needs a HEAD to restore from; before the first commit, unstaging means leaving the index.
    if (await this.resolve('HEAD')) await this.run(['restore', '--staged', '--', ...paths])
    else await this.run(['rm', '--cached', '-q', '-f', '--', ...paths])
  }

  /** Puts tracked files back to their staged version and deletes untracked ones. The index is untouched. */
  async discard(paths: readonly string[]): Promise<void> {
    const untracked = new Set((await this.run(['ls-files', '-z', '--others', '--exclude-standard', '--', ...paths])).split('\0').filter(Boolean))
    const tracked = paths.filter((file) => !untracked.has(file))
    if (untracked.size > 0) await this.run(['clean', '-f', '-q', '--', ...untracked])
    if (tracked.length > 0) await this.run(['restore', '--worktree', '--', ...tracked])
  }

  async hasChanges(): Promise<boolean> {
    return (await this.run(['status', '--porcelain', ...this.visible()])).trim().length > 0
  }

  async commitAll(message: string): Promise<string> {
    await this.run(['add', '-A'])
    await this.unstageHidden()
    await this.run(['commit', '-m', message])
    return (await this.run(['rev-parse', 'HEAD'])).trim()
  }

  /**
   * Takes hidden paths back out of the index after a broad `add`. Not done with an exclude pathspec
   * on `add` itself: git exits 1 when a pathspec names an ignored path, even to exclude it.
   */
  private async unstageHidden(): Promise<void> {
    if (this.hidden.length === 0) return
    if (await this.resolve('HEAD')) await this.run(['reset', '-q', 'HEAD', '--', ...this.hidden])
    else await this.run(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', ...this.hidden])
  }

  async commitStaged(message: string): Promise<string> {
    await this.run(['commit', '-q', '-m', message])
    return (await this.run(['rev-parse', 'HEAD'])).trim()
  }

  async hasStagedChanges(): Promise<boolean> {
    return (await this.run(['diff', '--cached', '--name-only'])).trim().length > 0
  }

  /** The newest commit on `ref` whose message contains the trailer `key: value`. */
  async commitWithTrailer(key: string, value: string, ref = 'HEAD'): Promise<string | null> {
    const sha = (await this.run(['log', '-1', '--format=%H', '--fixed-strings', `--grep=${key}: ${value}`, ref, '--'])).trim()
    return sha || null
  }

  /** The branch work lands on: `origin`'s default branch when known, otherwise the one checked out here. */
  async defaultBranch(): Promise<string | null> {
    try {
      const remote = (await this.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim()
      if (remote) return remote.replace(/^origin\//, '')
    } catch {
      /** No `origin`, or its HEAD was never fetched. */
    }
    return (await this.currentBranch()) || null
  }

  /** Commits only `paths`, leaving everything else staged or modified exactly as it was. */
  async commitPaths(paths: readonly string[], message: string): Promise<string> {
    await this.run(['add', '--', ...paths])
    await this.run(['commit', '--only', '-m', message, '--', ...paths])
    return (await this.run(['rev-parse', 'HEAD'])).trim()
  }

  async currentBranch(): Promise<string> {
    return (await this.run(['branch', '--show-current'])).trim()
  }

  /** Lines added and removed in the working tree versus HEAD, untracked files included. */
  async diffStat(): Promise<DiffStat> {
    return (await this.statusSnapshot()).stat
  }

  /**
   * Where this branch left `chosen`, or by default the branch work lands on (its upstream when it is
   * that branch). Null when there is nothing to compare with: no commits yet, the default branch with
   * no upstream, or a chosen ref that doesn't resolve.
   */
  async branchBase(chosen: string | null = null): Promise<{ sha: string; label: string } | null> {
    if (!(await this.resolve('HEAD'))) return null
    let compareWith = chosen
    if (!compareWith) {
      const branch = await this.currentBranch()
      const target = await this.baseBranch(branch)
      compareWith = target && target !== branch && target !== `origin/${branch}` ? target : await this.upstream()
    }
    if (!compareWith) return null
    try {
      const sha = (await this.run(['merge-base', 'HEAD', compareWith])).trim()
      return sha ? { sha, label: compareWith } : null
    } catch {
      /** Unrelated histories. */
      return null
    }
  }

  /**
   * The branch work lands on, to compare against. Unlike `defaultBranch` it never falls back to the
   * current branch, which in a worktree is the worktree's own.
   */
  private async baseBranch(current: string): Promise<string | null> {
    try {
      const remote = (await this.run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).trim()
      if (remote) return remote
    } catch {
      /** No `origin`, or its HEAD was never fetched. */
    }
    /** The main checkout may itself be on a feature branch; then fall through to main / master. */
    const main = (await this.worktrees().catch(() => [])).find((w) => w.isMain)?.branch
    if (main && main !== current) return main
    for (const name of ['main', 'master']) if (await this.resolve(name)) return name
    return null
  }

  /** Local then remote-tracking branches, most recently committed first, without remotes' `HEAD`. */
  async branches(): Promise<string[]> {
    const refs = (await this.run(['for-each-ref', '--sort=-committerdate', '--format=%(refname)', 'refs/heads', 'refs/remotes'])).split('\n')
    return refs.flatMap((ref) => {
      if (ref.startsWith('refs/heads/')) return [ref.slice('refs/heads/'.length)]
      if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) return [ref.slice('refs/remotes/'.length)]
      return []
    })
  }

  /** Files that differ between two commits, with line counts. `from` may be `EMPTY_TREE`. */
  async diffFiles(from: string, to: string): Promise<FileChange[]> {
    const [names, numstat] = await Promise.all([
      this.run(['diff', '--name-status', '-z', '-M', from, to, ...this.visible()]),
      this.run(['diff', '--numstat', '-z', '-M', from, to, ...this.visible()])
    ])
    const counts = parseNumstatZ(numstat)
    return parseNameStatusZ(names)
      .map((entry) => ({ ...entry, ...(counts.get(entry.path) ?? { added: 0, removed: 0 }) }))
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  /** What `sha` changed against its first parent; the first commit against the empty tree. */
  async commitFiles(sha: string): Promise<FileChange[]> {
    return this.diffFiles((await this.resolve(`${sha}^`)) ?? EMPTY_TREE, sha)
  }

  /** The newest `limit` commits on HEAD, those after `base` marked `onBranch`. */
  async log(limit: number, base: string | null): Promise<CommitInfo[]> {
    if (!(await this.resolve('HEAD'))) return []
    const [out, since] = await Promise.all([
      this.run(['log', `-n${limit}`, `--format=${LOG_FORMAT}`, 'HEAD']),
      base ? this.run(['rev-list', `${base}..HEAD`]) : Promise.resolve('')
    ])
    return parseLog(out, new Set(since.split('\n').filter(Boolean)))
  }

  async fetch(): Promise<void> {
    await this.run(['fetch', '--quiet'])
  }

  /** `git fetch --quiet <remote> <specs…>`, e.g. a pull request's head into a hidden ref. */
  async fetchRefspecs(remote: string, specs: readonly string[]): Promise<void> {
    await this.run(['fetch', '--quiet', remote, ...specs])
  }

  /** Null for unrelated histories. */
  async mergeBase(a: string, b: string): Promise<string | null> {
    try {
      return (await this.run(['merge-base', a, b])).trim() || null
    } catch {
      return null
    }
  }

  /**
   * Each changed path between two commits, mapped to `<old blob>:<new blob>` (all zeros for a side
   * that doesn't exist): a fingerprint of the file's diff that changes whenever the diff does.
   */
  async diffBlobs(from: string, to: string): Promise<Map<string, string>> {
    const fields = (await this.run(['diff', '--raw', '-z', '--no-abbrev', '-M', from, to])).split('\0')
    const blobs = new Map<string, string>()
    for (let i = 0; i < fields.length; i++) {
      const meta = fields[i] ?? ''
      if (!meta.startsWith(':')) continue
      const [, , oldBlob, newBlob, status = ''] = meta.slice(1).split(' ')
      const renamed = status.startsWith('R') || status.startsWith('C')
      const relPath = renamed ? fields[i + 2] : fields[i + 1]
      i += renamed ? 2 : 1
      if (relPath && oldBlob && newBlob) blobs.set(relPath, `${oldBlob}:${newBlob}`)
    }
    return blobs
  }

  /**
   * One file's diff between two commits with git's usual three lines of context: what GitHub shows.
   * `oldPath` is a renamed file's path in `from`, so the diff is of its edits, not a whole new file.
   */
  async fileHunks(from: string, to: string, relPath: string, oldPath?: string): Promise<string> {
    /** Plain unified output whatever the user's config: an external diff tool or colour would hide the `@@` headers. */
    return this.run(['diff', '--no-ext-diff', '--no-color', '--no-textconv', '-U3', '-M', from, to, '--', ...(oldPath ? [oldPath] : []), relPath])
  }

  /** Each remote's name and fetch URL. */
  async remotes(): Promise<{ name: string; url: string }[]> {
    const out = await this.run(['remote', '-v'])
    return out.split('\n').flatMap((line) => {
      const [name, url] = line.split(/\s+/)
      return line.endsWith(' (fetch)') && name && url ? [{ name, url }] : []
    })
  }

  /** Each remote's fetch URL, once. */
  async remoteUrls(): Promise<string[]> {
    return [...new Set((await this.remotes()).map((remote) => remote.url))]
  }

  /**
   * `git push [-u] origin <branch>`; a refusal throws `GitError` with git's own message. It never
   * waits on a prompt: it runs in its own session with no terminal (so ssh can't ask about a host key)
   * and with git's credential prompts off, and gives up after `timeoutMs`.
   */
  async pushBranch(branch: string, setUpstream: boolean, timeoutMs = 90_000): Promise<void> {
    const args = ['push', '--quiet', ...(setUpstream ? ['-u'] : []), 'origin', branch]
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: this.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      const timer = setTimeout(() => {
        /** The whole group: a transport like ssh would otherwise outlive git and hold the push open. */
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        reject(new GitError(args, `git push didn't finish within ${Math.round(timeoutMs / 1000)} s; check that pushing works in a terminal`))
      }, timeoutMs)
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new GitError(args, error.message))
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new GitError(args, stderr, code))
      })
    })
  }

  /** Commits on HEAD that its upstream doesn't have; 0 without an upstream. */
  async aheadOfUpstream(): Promise<number> {
    try {
      return Number((await this.run(['rev-list', '--count', '@{u}..HEAD'])).trim()) || 0
    } catch {
      return 0
    }
  }

  /** The subject of HEAD's commit; empty when there are no commits. */
  async lastCommitSubject(): Promise<string> {
    if (!(await this.resolve('HEAD'))) return ''
    return (await this.run(['log', '-1', '--format=%s'])).trim()
  }

  async mergeFastForward(ref: string): Promise<void> {
    await this.run(['merge', '--ff-only', '--quiet', ref])
  }
}
