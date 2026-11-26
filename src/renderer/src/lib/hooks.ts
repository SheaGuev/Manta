import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BranchSummary, Changes, FilesChanged, LanguageServerStatus, MapDetail, MapSummary, ProjectWorktree, PullRequestStatus, RepoStatus, ReviewComment, TerminalInfo, ThreadInfo } from '../../../shared/ipc'

import { withoutIpcPrefix } from './errors'
import { nextStatus, refreshInterval } from './pullRequestView'

const api = window.manta

/** Which file changes a panel's data depends on. */
type RefreshOn = (change: FilesChanged) => boolean

const onStructure: RefreshOn = (change) => change.structure
const onGitStatus: RefreshOn = (change) => change.content || change.structure
const never: RefreshOn = () => false

/**
 * Loads `load()` for `root` and reloads when a file change it depends on arrives (`refreshOn`), or when
 * `version` changes (for changes no file event reports, like a commit made in a terminal). While not
 * `active` it keeps its last data and stops reloading. A reload that returns equal data keeps the old
 * value, so nothing downstream re-renders.
 */
function useRootData<T>({
  root,
  initial,
  load,
  refreshOn,
  version = 0,
  active = true
}: {
  root: string | null
  initial: T
  load: (root: string) => Promise<T>
  refreshOn: RefreshOn
  /** Any change reloads; a string combines several counters. */
  version?: number | string
  active?: boolean
}): T {
  const [state, setState] = useState<{ root: string | null; data: T }>({ root: null, data: initial })
  useEffect(() => {
    if (!root) {
      setState({ root: null, data: initial })
      return
    }
    if (!active) return
    let live = true
    const refresh = (): void => {
      load(root)
        .then((next) => {
          if (!live) return
          setState((current) => (current.root === root && sameData(current.data, next) ? current : { root, data: next }))
        })
        .catch((error: unknown) => console.error('manta:', error))
    }
    refresh()
    const stop = api.onFilesChanged((change) => change.root === root && refreshOn(change) && refresh())
    return () => {
      live = false
      stop()
    }
    // `initial`, `load` and `refreshOn` are stable per call site; re-run only when the root, version or activity changes.
  }, [root, version, active])
  return state.root === root ? state.data : initial
}

/** IPC results are plain JSON, so comparing their serialised form is exact. */
const sameData = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b)

const NO_FILES: string[] = []
const NO_CHANGES: Changes = { staged: [], unstaged: [] }
const NO_WORKTREES: ProjectWorktree[] = []
const NO_BRANCH: BranchSummary = { base: null, head: null, files: [], commits: [], missingBase: null }

/** `active`: whether anything showing needs the list; a big repo's list is costly to fetch on every change. */
export const useFiles = (root: string | null, scope: 'docs' | 'all', active = true): string[] =>
  useRootData({ root, initial: NO_FILES, load: (r) => api.listFiles(r, scope), refreshOn: onStructure, active })

export const useChanges = (root: string | null, version = 0): Changes =>
  useRootData({ root, initial: NO_CHANGES, load: api.changes, refreshOn: onGitStatus, version })

/**
 * Commits only: file edits can't change it, so it reloads on `version` (focus, git operations in Manta),
 * when it opens, and when `base` (the branch it compares with; null for the default) changes.
 */
export const useBranch = (root: string | null, base: string | null, version = 0): BranchSummary =>
  useRootData({ root, initial: NO_BRANCH, load: (r) => api.branch(r, base), refreshOn: never, version: `${version}:${base ?? ''}` })

const NO_REVIEW_COMMENTS: ReviewComment[] = []

/** The worktree's review comments; they change only through Manta, which says so. Null `root` loads nothing. */
export function useReviewComments(root: string | null): ReviewComment[] {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const stop = api.onReviewCommentsChanged((changed) => {
      if (changed === root) setVersion((v) => v + 1)
    })
    return stop
  }, [root])
  return useRootData({ root, initial: NO_REVIEW_COMMENTS, load: api.reviewComments, refreshOn: never, version })
}

const NO_SENT_MARKS: Record<string, { to: string; at: string }> = {}

/** Which pull request comments went to which agent; they change only through Manta, which says so. */
export function usePullRequestSent(root: string | null): Record<string, { to: string; at: string }> {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const stop = api.onReviewCommentsChanged((changed) => {
      if (changed === root) setVersion((v) => v + 1)
    })
    return stop
  }, [root])
  return useRootData({ root, initial: NO_SENT_MARKS, load: api.pullRequestSent, refreshOn: never, version })
}

/**
 * The worktree branch's pull request for the PR tab. Loads while `root` is set (the tab shows) and on
 * each focus, from main's minute-long cache; while a check runs it refreshes past the cache every 30 s,
 * and `refresh` does so at once. One request at a time: a slow `gh` never piles them up.
 */
export function usePullRequest(
  root: string | null,
  focusCount: number
): { status: PullRequestStatus | null; error: string | null; loading: boolean; refresh: () => void } {
  const [state, setState] = useState<{ root: string | null; status: PullRequestStatus | null; error: string | null }>({ root: null, status: null, error: null })
  const [loading, setLoading] = useState(false)
  const inFlight = useRef(false)
  const load = useCallback(
    (force: boolean) => {
      if (!root || inFlight.current) return
      inFlight.current = true
      setLoading(true)
      api
        .pullRequest(root, force)
        .catch((error: unknown): PullRequestStatus => ({ kind: 'unavailable', reason: withoutIpcPrefix(error instanceof Error ? error.message : String(error)) }))
        .then((status) => setState((current) => ({ root, ...nextStatus(current.root === root ? current.status : null, status) })))
        .finally(() => {
          inFlight.current = false
          setLoading(false)
        })
    },
    [root]
  )
  useEffect(() => {
    load(false)
  }, [load, focusCount])
  /** A comment or review Manta posted: show it without waiting out the cache. */
  useEffect(() => {
    const stop = api.onPullRequestChanged((changed) => {
      if (changed === root) load(true)
    })
    return stop
  }, [root, load])
  const status = state.root === root ? state.status : null
  const error = state.root === root ? state.error : null
  const interval = refreshInterval(status)
  useEffect(() => {
    if (!interval) return
    const timer = setInterval(() => load(true), interval)
    return () => clearInterval(timer)
  }, [interval, load])
  const refresh = useCallback(() => load(true), [load])
  return { status, error, loading, refresh }
}

/** Worktrees change only through git: Manta's own operations bump `version`, and ones made in a terminal show on focus. */
export function useWorktrees(projectRoot: string | null, version: number): ProjectWorktree[] {
  const focus = useFocusCount()
  return useRootData({ root: projectRoot, initial: NO_WORKTREES, load: api.listWorktrees, refreshOn: never, version: `${version}:${focus}` })
}

/** How often the window has regained focus: a cue to reload what only git commands in a terminal change. */
export function useFocusCount(): number {
  const [count, setCount] = useState(0)
  useEffect(() => {
    const onFocus = (): void => setCount((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  return count
}

export const useRepoStatus = (root: string | null): RepoStatus | null =>
  useRootData<RepoStatus | null>({ root, initial: null, load: api.repoStatus, refreshOn: onGitStatus })

/** A doc's threads, reloaded when a thread record or a file changes (an outside edit can detach one), or a thread's agent finishes a turn. */
export function useThreads(root: string | null, relPath: string | null): ThreadInfo[] {
  const [threads, setThreads] = useState<ThreadInfo[]>([])
  useEffect(() => {
    if (!root || !relPath) {
      setThreads([])
      return
    }
    let live = true
    const refresh = (): void => {
      api
        .listThreads(root, relPath)
        .then((next) => live && setThreads(next))
        .catch((error: unknown) => console.error('manta:', error))
    }
    refresh()
    const stopFiles = api.onFilesChanged((change) => change.root === root && (change.records.length > 0 || change.content) && refresh())
    const stopThreads = api.onThreadEvent((r, doc, _id, event) => r === root && doc === relPath && event.type === 'turn-end' && refresh())
    return () => {
      live = false
      stopFiles()
      stopThreads()
    }
  }, [root, relPath])
  return threads
}

/**
 * Checks the doc's open implementation threads for a landed branch or a new pull request: when the
 * doc opens, when the window regains focus, and when one of their sessions stops (idle or exited).
 * Results arrive through the doc's CRDT and records, like any other thread change.
 */
export function useImplementationChecks(root: string | null, relPath: string | null, terminals: TerminalInfo[] | null): void {
  const [focus, setFocus] = useState(0)
  useEffect(() => {
    const onFocus = (): void => setFocus((n) => n + 1)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  const resting = (terminals ?? [])
    .filter((t) => t.link?.doc === relPath && (t.state === 'idle' || t.state === 'exited'))
    .map((t) => t.id)
    .join(',')
  useEffect(() => {
    if (!root || !relPath) return
    api
      .listThreads(root, relPath)
      .then((threads) =>
        Promise.all(threads.filter((t) => t.implementation && t.status === 'open').map((t) => api.checkImplementation(root, relPath, t.id)))
      )
      .catch((error: unknown) => console.error('manta: checking implementations', error))
  }, [root, relPath, resting, focus])
}

/**
 * The docs repo's context maps. Reloaded when a map's files or its local state change, when a thread
 * record changes (its open doc changes count as waiting), when Ask the map starts or ends a turn, and on `version`.
 */
export function useMaps(docsRoot: string | null, version = 0): MapSummary[] | null {
  const focus = useFocusCount()
  const [maps, setMaps] = useState<{ root: string; list: MapSummary[] } | null>(null)
  useEffect(() => {
    if (!docsRoot) {
      setMaps(null)
      return
    }
    let live = true
    const refresh = (): void => {
      api
        .listMaps(docsRoot)
        .then((list) => live && setMaps((current) => (current?.root === docsRoot && sameData(current.list, list) ? current : { root: docsRoot, list })))
        .catch((error: unknown) => console.error('manta: listing maps', error))
    }
    refresh()
    const stopFiles = api.onFilesChanged((change) => change.root === docsRoot && (change.maps.length > 0 || change.records.length > 0) && refresh())
    const stopEvents = api.onMapEvent((root, _id, event) => root === docsRoot && (event.type === 'turn-start' || event.type === 'turn-end') && refresh())
    return () => {
      live = false
      stopFiles()
      stopEvents()
    }
  }, [docsRoot, version, focus])
  return maps?.root === docsRoot ? maps.list : null
}

/**
 * One map in full, for its screens. Reloaded when its files or local state change, when a thread
 * record changes, and when Ask the map ends a turn. Its launches' pull requests and landing are
 * checked when it opens, when the window gets focus, and when one of its sessions comes to rest.
 */
export function useMapDetail(docsRoot: string, id: string, terminals: readonly TerminalInfo[]): { map: MapDetail | null; reload: () => void; error: string | null } {
  const focus = useFocusCount()
  const [map, setMap] = useState<MapDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    let live = true
    api
      .getMap(docsRoot, id)
      .then((next) => {
        if (!live) return
        setError(null)
        setMap((current) => (current && sameData(current, next) ? current : next))
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [docsRoot, id, version])
  useEffect(() => {
    const stopFiles = api.onFilesChanged((change) => change.root === docsRoot && (change.maps.includes(id) || change.records.length > 0 || change.structure) && reload())
    const stopEvents = api.onMapEvent((root, mapId, event) => root === docsRoot && mapId === id && (event.type === 'turn-start' || event.type === 'turn-end') && reload())
    return () => {
      stopFiles()
      stopEvents()
    }
  }, [docsRoot, id, reload])
  const resting = terminals
    .filter((t) => t.map?.map === id && (t.state === 'idle' || t.state === 'exited'))
    .map((t) => t.id)
    .join(',')
  useEffect(() => {
    api.checkMap(docsRoot, id).catch((e: unknown) => console.error('manta: checking map launches', e))
  }, [docsRoot, id, focus, resting])
  return { map, reload, error }
}

/** The doc paths a map lists, for limiting the Files tab to them; null without a map. */
export function useMapDocPaths(docsRoot: string | null, id: string | null): string[] | null {
  const [paths, setPaths] = useState<{ key: string; list: string[] } | null>(null)
  const key = docsRoot && id ? `${docsRoot}\0${id}` : null
  useEffect(() => {
    if (!docsRoot || !id || !key) return
    let live = true
    const refresh = (): void => {
      api
        .getMap(docsRoot, id)
        .then((map) => {
          if (!live) return
          const list = map.docs.map((d) => d.path)
          setPaths((current) => (current?.key === key && sameData(current.list, list) ? current : { key, list }))
        })
        .catch((error: unknown) => console.error('manta: reading the map’s docs', error))
    }
    refresh()
    const stop = api.onFilesChanged((change) => change.root === docsRoot && change.maps.includes(id) && refresh())
    return () => {
      live = false
      stop()
    }
  }, [docsRoot, id, key])
  return key && paths?.key === key ? paths.list : null
}

const WIDTH_SAVE_DELAY_MS = 300

/** A pane width in pixels, kept within `min`–`max` and persisted across launches. */
export function usePersistentWidth(
  storageKey: string,
  { initial, min, max }: { initial: number; min: number; max: number }
): [number, (width: number) => void] {
  const clamp = useCallback((width: number) => Math.round(Math.min(max, Math.max(min, width))), [min, max])
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey))
    return stored > 0 ? clamp(stored) : initial
  })
  /** Saved once dragging settles: a drag changes the width on every pointer move. */
  useEffect(() => {
    const save = setTimeout(() => localStorage.setItem(storageKey, String(width)), WIDTH_SAVE_DELAY_MS)
    return () => clearTimeout(save)
  }, [storageKey, width])
  const resize = useCallback((next: number) => setWidth(clamp(next)), [clamp])
  return [width, resize]
}

/** A set of open/expanded keys persisted across launches. */
export function usePersistentSet(storageKey: string, defaults: string[] = []): [(key: string) => boolean, (key: string) => void] {
  const [keys, setKeys] = useState<Set<string>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
      return new Set(Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : defaults)
    } catch {
      return new Set(defaults)
    }
  })
  const has = useCallback((key: string) => keys.has(key), [keys])
  const toggle = useCallback(
    (key: string) =>
      setKeys((current) => {
        const next = new Set(current)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        // Transient UI keys (inline inputs) aren't worth restoring.
        localStorage.setItem(storageKey, JSON.stringify([...next].filter((k) => !k.startsWith('new-'))))
        return next
      }),
    [storageKey]
  )
  return [has, toggle]
}

/** A string kept in `localStorage`; null when unset, and setting null removes it. */
export function usePersistentString(storageKey: string): [string | null, (value: string | null) => void] {
  const read = (): string | null => {
    try {
      return localStorage.getItem(storageKey)
    } catch {
      return null
    }
  }
  const [state, setState] = useState(() => ({ key: storageKey, value: read() }))
  /** A new key (another worktree's panel) reads its own value. */
  const value = state.key === storageKey ? state.value : read()
  const set = useCallback(
    (next: string | null) => {
      try {
        if (next === null) localStorage.removeItem(storageKey)
        else localStorage.setItem(storageKey, next)
      } catch {
        // Storage unavailable: keep it for this session only.
      }
      setState({ key: storageKey, value: next })
    },
    [storageKey]
  )
  return [value, set]
}

/** Every terminal in every context, kept current from main's change and removal events. Null until loaded. */
export function useTerminals(): TerminalInfo[] | null {
  const [terminals, setTerminals] = useState<Map<string, TerminalInfo> | null>(null)
  useEffect(() => {
    let live = true
    const changes: TerminalInfo[] = []
    const update = (info: TerminalInfo): void => setTerminals((current) => (current ? new Map(current).set(info.id, info) : current))
    const stopChanged = api.onTerminalChanged((info) => {
      changes.push(info)
      update(info)
    })
    const stopRemoved = api.onTerminalRemoved((id) =>
      setTerminals((current) => {
        if (!current) return current
        const next = new Map(current)
        next.delete(id)
        return next
      })
    )
    api
      .listTerminals()
      .then((list) => {
        if (!live) return
        const loaded = new Map(list.map((info) => [info.id, info]))
        /** Changes that arrived while the list was loading are newer than it. */
        for (const info of changes) loaded.set(info.id, info)
        setTerminals(loaded)
      })
      .catch((error: unknown) => console.error('manta:', error))
    return () => {
      live = false
      stopChanged()
      stopRemoved()
    }
  }, [])
  return useMemo(() => (terminals ? [...terminals.values()] : null), [terminals])
}

/** Language servers as main reports them, so the status bar shows starting, ready or crashed; stopped ones drop out. */
export function useLanguageServers(): LanguageServerStatus[] {
  const [servers, setServers] = useState<LanguageServerStatus[]>([])
  useEffect(() => {
    let live = true
    const seen: LanguageServerStatus[] = []
    const apply = (status: LanguageServerStatus): void =>
      setServers((current) => [...current.filter((s) => s.root !== status.root || s.server !== status.server), ...(status.state === 'stopped' ? [] : [status])])
    const stop = api.onLspStatus((status) => {
      seen.push(status)
      apply(status)
    })
    api
      .lspStatuses()
      .then((list) => {
        if (!live) return
        setServers(list)
        /** Statuses that arrived while the list was loading are newer than it. */
        for (const status of seen) apply(status)
      })
      .catch((error: unknown) => console.warn('manta: language servers', error))
    return () => {
      live = false
      stop()
    }
  }, [])
  return servers
}

