import { EditorView } from '@codemirror/view'
import { ArrowLeft, ArrowRight, BookOpen, Bot, Copy, FileText, FolderOpen, GitCommitHorizontal, GitPullRequest, Map as MapIcon, MessagesSquare, PanelLeft, PanelRight, Pencil, Puzzle, SquareTerminal, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImplementationRequest, MapDetail, MapLaunch, MapLink, Project, TerminalInfo, TerminalKind, TerminalLink, ThreadInfo, Worktree } from '../../shared/ipc'
import { BranchCompareView } from './components/CompareView'
import { PullRequestReview } from './components/PullRequestReview'
import { Editor, type EditorMode } from './components/Editor'
import { ImplementDialog } from './components/ImplementDialog'
import { AddMapDocDialog } from './components/AddMapDocDialog'
import { ContextMenu, type MenuItem } from './components/ContextMenu'
import { MapDialog } from './components/MapDialog'
import { MapView, type MapScreen } from './components/MapView'
import { NewTabButton } from './components/NewTabButton'
import { OpenLinkDialog } from './components/OpenLinkDialog'
import { PluginsView } from './components/PluginsView'
import { QuickOpen } from './components/QuickOpen'
import { QuickFixPicker } from './components/QuickFixPicker'
import { SymbolPicker } from './components/SymbolPicker'
import { ResizeHandle } from './components/ResizeHandle'
import { RightPanel, type PanelTab, type SearchRequest } from './components/RightPanel'
import { Sidebar, worktreeName } from './components/Sidebar'
import { StatusBar, type StatusMessage } from './components/StatusBar'
import { TerminalView } from './components/TerminalView'
import { ThreadView } from './components/ThreadView'
import { withoutIpcPrefix } from './lib/errors'
import { useFiles, useImplementationChecks, useMapDocPaths, useMaps, usePersistentSet, usePersistentWidth, useTerminals } from './lib/hooks'
import { applyEditorTheme } from './lib/editorTheme'
import { editorKey, mountedEditor, setFileOpener } from './lib/lsp/navigation'
import { stateLabel } from './lib/terminalStatus'
import { displayName } from './lib/tree'
import { canStep, emptyHistory, prune, recordVisit, step, type NavDirection, type NavHistory } from './lib/navHistory'
import { reorder } from './lib/tabOrder'
import { contextExists, inProject } from './lib/places'
import { touchWarm } from './lib/warmContexts'

const api = window.manta

/** Where the user is working: the docs repo, one worktree of a code project, or a context map. */
interface WorkContext {
  root: string
  label: string
  kind: 'docs' | 'worktree' | 'map'
  /** Worktree name shown beside the project name. */
  detail?: string
  /** The map of a map context, whose root is the docs repo. */
  map?: string
  /** The code project a worktree context belongs to. */
  project?: string
}

/** Which tab set a context shows: its root, except that each map has its own set beside the docs repo's. */
function contextKey(context: WorkContext): string {
  return context.kind === 'map' && context.map ? mapKey(context.map) : context.root
}

const mapKey = (map: string): string => `map:${map}`

/** Files under `.manta/` (a map's own files) aren't docs: no threads on them. */
const isMantaFile = (relPath: string): boolean => relPath.startsWith('.manta/')

interface OpenFile {
  root: string
  relPath: string
  mode: EditorMode
}

/** A thread open in its own tab (D25). */
interface ThreadTab {
  root: string
  relPath: string
  thread: string
  title: string
}

/** A terminal in its own tab. The process lives in main, so closing the tab is what ends it. */
interface TerminalTab {
  root: string
  terminal: string
  title: string
}

/** A read-only diff of a file between two commits, from the Branch tab. */
interface CompareTab {
  root: string
  relPath: string
  /** Null when the file is new in `to`. */
  from: string | null
  /** A renamed file's path at `from`. */
  fromPath?: string
  to: string
  /** e.g. "auth.md (vs main)" or "auth.md (1a2b3c4)". */
  title: string
  /** The branch's whole diff, which takes review comments; a single commit's diff doesn't. */
  review?: boolean
}

/**
 * A context map's tab, the first in its context. Its pages (Overview, Milestones, Docs, Decisions,
 * Activity, Ask the map, a ticket) switch inside it; `screen` and `ticket` are the page it opens at,
 * kept for tabs saved when each page was a tab of its own.
 */
interface MapTab {
  root: string
  map: string
  title: string
  /** Home when absent. */
  screen?: MapScreen
  ticket?: string
}

/** The Plugins view: language servers, linters, formatters and editor themes. One per context. */
interface PluginsTab {
  root: string
  plugins: true
  title: string
}

/** A pull request's review: its changed files, each ticked as viewed, and the selected file's diff. */
interface ReviewTab {
  root: string
  pullRequest: number
  title: string
}

type Tab = OpenFile | ThreadTab | TerminalTab | CompareTab | MapTab | PluginsTab | ReviewTab

const isMapTab = (tab: Tab): tab is MapTab => 'map' in tab
/** A map's Home is its context's anchor: it can't be closed. */
const isMapHome = (tab: Tab): tab is MapTab => isMapTab(tab) && (tab.screen ?? 'home') === 'home'
const isThreadTab = (tab: Tab): tab is ThreadTab => 'thread' in tab
const isTerminalTab = (tab: Tab): tab is TerminalTab => 'terminal' in tab
const isCompareTab = (tab: Tab): tab is CompareTab => 'to' in tab
const isPluginsTab = (tab: Tab): tab is PluginsTab => 'plugins' in tab
const isReviewTab = (tab: Tab): tab is ReviewTab => 'pullRequest' in tab
const isFileTab = (tab: Tab): tab is OpenFile => !isThreadTab(tab) && !isTerminalTab(tab) && !isCompareTab(tab) && !isMapTab(tab) && !isPluginsTab(tab) && !isReviewTab(tab)
const tabKey = (tab: Tab): string =>
  isMapTab(tab)
    ? `map:${tab.root}:${tab.map}:${tab.screen ?? 'home'}:${tab.ticket ?? ''}`
    : isThreadTab(tab)
    ? `thread:${tab.root}:${tab.thread}`
    : isTerminalTab(tab)
      ? `terminal:${tab.root}:${tab.terminal}`
      : isCompareTab(tab)
        ? `compare:${tab.root}:${tab.relPath}:${tab.from ?? ''}:${tab.to}`
        : isPluginsTab(tab)
          ? `plugins:${tab.root}`
          : isReviewTab(tab)
          ? `review:${tab.root}:${tab.pullRequest}`
          : `file:${tab.root}:${tab.relPath}:${tab.mode}`

/** A first guess at a new terminal's size; its view fits it to the pane as soon as it mounts. */
const INITIAL_TERMINAL = { cols: 120, rows: 32 }

/** The drag data type of a tab being dragged within the tab strip; its value is the tab's key. */
const TAB_DRAG = 'application/x-manta-tab'

interface Tabs {
  tabs: Tab[]
  active: string | null
}

/** One context's tabs. Each docs repo and each worktree keeps its own set, so switching swaps them. */
type TabSet = Tabs

const NO_TABS: TabSet = { tabs: [], active: null }

/** Where the user was: a context and the tab active in it. Back and forward move between these, across contexts. */
interface Place {
  context: WorkContext
  tab: Tab | null
}

const samePlace = (a: Place, b: Place): boolean =>
  contextKey(a.context) === contextKey(b.context) && (a.tab ? tabKey(a.tab) : null) === (b.tab ? tabKey(b.tab) : null)
/** A context entered with no tab open, then its first tab: one place, not two, so Back never lands on a step that changes nothing. */
const supersedesPlace = (current: Place, next: Place): boolean => current.tab === null && contextKey(current.context) === contextKey(next.context)
/**
 * Contexts whose tab pages stay mounted, hidden, after you leave them, counting the current one.
 * Switching back to one keeps its terminals and editors instead of rebuilding them from main's copies.
 */
const WARM_CONTEXTS = 4

const modeFor = (relPath: string): EditorMode => (relPath.endsWith('.md') ? 'doc' : 'code')

/** A read-only file's folder, from `node_modules` on when it's in one, so the header stays short. */
function readOnlyFolder(absolutePath: string): string {
  const parts = absolutePath.split('/').slice(0, -1)
  const modules = parts.lastIndexOf('node_modules')
  return (modules >= 0 ? parts.slice(modules) : parts.slice(-2)).join(' / ')
}

const SESSION_KEY = 'manta.session'

const SIDEBAR_WIDTH = { initial: 280, min: 200, max: 480 }
const PANEL_WIDTH = { initial: 300, min: 240, max: 560 }
/** Resizing either pane stops short of squeezing the editor below this. */
const MIN_EDITOR_WIDTH = 360

interface Session {
  context: WorkContext | null
  /** Keyed by context root. */
  tabSets: Record<string, TabSet>
}

/** Where the user left off, so a relaunch reopens the same tabs. */
function readSession(): Session {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null')
    if (typeof parsed === 'object' && parsed !== null && 'context' in parsed) {
      const context = isWorkContext(parsed.context) ? parsed.context : null
      if ('tabSets' in parsed && typeof parsed.tabSets === 'object' && parsed.tabSets !== null) {
        const tabSets: Record<string, TabSet> = {}
        for (const [root, set] of Object.entries(parsed.tabSets)) tabSets[root] = readTabSet(set)
        return { context, tabSets }
      }
      // Sessions saved before each context had its own tabs.
      if (context) return { context, tabSets: { [context.root]: readTabSet(parsed) } }
      return { context, tabSets: {} }
    }
  } catch {
    // Corrupt or missing session: start fresh.
  }
  return { context: null, tabSets: {} }
}

function readTabSet(value: unknown): TabSet {
  if (typeof value !== 'object' || value === null) return NO_TABS
  if ('tabs' in value && Array.isArray(value.tabs)) {
    const tabs = value.tabs.filter(
      (tab: unknown): tab is Tab =>
        isMapTabValue(tab) || isOpenFile(tab) || isThreadTabValue(tab) || isTerminalTabValue(tab) || isCompareTabValue(tab) || isPluginsTabValue(tab) || isReviewTabValue(tab)
    )
    const active = 'active' in value && typeof value.active === 'string' && tabs.some((t) => tabKey(t) === value.active) ? value.active : null
    return { tabs, active }
  }
  // Sessions saved before tabs held a single open file.
  if ('open' in value && isOpenFile(value.open)) return { tabs: [value.open], active: tabKey(value.open) }
  return NO_TABS
}

function isMapTabValue(value: unknown): value is MapTab {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'map' in value &&
    typeof value.map === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    (!('screen' in value) || MAP_SCREENS.some((screen) => screen === value.screen)) &&
    (!('ticket' in value) || typeof value.ticket === 'string')
  )
}

const MAP_SCREENS: readonly MapScreen[] = ['home', 'docs', 'milestones', 'decisions', 'ask', 'ticket', 'activity']

function isThreadTabValue(value: unknown): value is ThreadTab {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'relPath' in value &&
    typeof value.relPath === 'string' &&
    'thread' in value &&
    typeof value.thread === 'string' &&
    'title' in value &&
    typeof value.title === 'string'
  )
}

function isTerminalTabValue(value: unknown): value is TerminalTab {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'terminal' in value &&
    typeof value.terminal === 'string' &&
    'title' in value &&
    typeof value.title === 'string'
  )
}

function isPluginsTabValue(value: unknown): value is PluginsTab {
  return typeof value === 'object' && value !== null && 'root' in value && typeof value.root === 'string' && 'plugins' in value && value.plugins === true && 'title' in value && typeof value.title === 'string'
}

function isReviewTabValue(value: unknown): value is ReviewTab {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'pullRequest' in value &&
    typeof value.pullRequest === 'number' &&
    Number.isInteger(value.pullRequest) &&
    'title' in value &&
    typeof value.title === 'string'
  )
}

function isCompareTabValue(value: unknown): value is CompareTab {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'relPath' in value &&
    typeof value.relPath === 'string' &&
    'from' in value &&
    (value.from === null || typeof value.from === 'string') &&
    (!('fromPath' in value) || typeof value.fromPath === 'string') &&
    'to' in value &&
    typeof value.to === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    (!('review' in value) || typeof value.review === 'boolean')
  )
}

function isWorkContext(value: unknown): value is WorkContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'label' in value &&
    typeof value.label === 'string' &&
    'kind' in value &&
    (value.kind === 'docs' || value.kind === 'worktree' || (value.kind === 'map' && 'map' in value && typeof value.map === 'string')) &&
    (!('project' in value) || typeof value.project === 'string')
  )
}

function isOpenFile(value: unknown): value is OpenFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'root' in value &&
    typeof value.root === 'string' &&
    'relPath' in value &&
    typeof value.relPath === 'string' &&
    'mode' in value &&
    (value.mode === 'doc' || value.mode === 'code' || value.mode === 'diff' || value.mode === 'readonly')
  )
}

export function App(): React.JSX.Element {
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [initialSession] = useState(readSession)
  const [context, setContext] = useState<WorkContext | null>(initialSession.context)
  const [tabSets, setTabSets] = useState(initialSession.tabSets)
  /** The current context's tab set. */
  const here = context ? contextKey(context) : null
  const view = (here !== null ? tabSets[here] : undefined) ?? NO_TABS
  const [warmRoots, setWarmRoots] = useState<string[]>([])
  const mountedRoots = here ? touchWarm({ warm: warmRoots, root: here, max: WARM_CONTEXTS }) : warmRoots
  useEffect(() => {
    if (mountedRoots !== warmRoots) setWarmRoots(mountedRoots)
  }, [mountedRoots, warmRoots])
  const activeTab = view.tabs.find((t) => tabKey(t) === view.active) ?? null
  const open = activeTab && isFileTab(activeTab) ? activeTab : null
  const activeThread = activeTab && isThreadTab(activeTab) ? activeTab : null
  const activeCompare = activeTab && isCompareTab(activeTab) ? activeTab : null
  const activeMap = activeTab && isMapTab(activeTab) ? activeTab : null
  const terminals = useTerminals()
  const terminalById = new Map((terminals ?? []).map((t) => [t.id, t]))
  const activeTerminal = activeTab && isTerminalTab(activeTab) ? (terminalById.get(activeTab.terminal) ?? null) : null
  /** Back and forward, across every context in the window. Not persisted. */
  const [nav, setNav] = useState<NavHistory<Place>>(emptyHistory)
  useEffect(() => {
    if (context) setNav((history) => recordVisit(history, { context, tab: activeTab }, samePlace, { supersedes: supersedesPlace }))
    // Only a change of context or active tab is a new place; `activeTab` and `context` are read for it.
  }, [here, view.active])
  /** A line to scroll an editor tab to, e.g. a search match; `seq` makes the same line reveal again. */
  const [reveal, setReveal] = useState<{ key: string; line: number; seq: number; side?: 'old' | 'new' } | null>(null)
  /** A tab being dragged in the tab strip, and where it would land. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ key: string; side: 'before' | 'after' } | null>(null)
  const cursors = useRef(new Map<string, number>())
  const [sidebarVisible, setSidebarVisible] = useState(true)
  /** Open by default: the sidebar lists contexts, and their files live here. */
  const [panel, setPanel] = useState<{ visible: boolean; tab: PanelTab }>({ visible: true, tab: 'files' })
  const [sidebarWidth, setSidebarWidth] = usePersistentWidth('manta.sidebar-width', SIDEBAR_WIDTH)
  const [panelWidth, setPanelWidth] = usePersistentWidth('manta.panel-width', PANEL_WIDTH)
  const [message, setMessage] = useState<StatusMessage | null>(null)
  /** Bumped by the status bar's Commit to focus the Changes tab's message box. */
  const [commitFocus, setCommitFocus] = useState(0)
  const [isExpanded, toggle] = usePersistentSet('manta.expanded')
  const [worktreeVersion, setWorktreeVersion] = useState(0)
  const [quickOpen, setQuickOpen] = useState(false)
  /** The editor Cmd+Shift+O lists the symbols of. */
  const [symbolsOf, setSymbolsOf] = useState<EditorView | null>(null)
  /** The editor Cmd+. lists quick fixes for. */
  const [fixesFor, setFixesFor] = useState<EditorView | null>(null)
  /** Cmd+Shift+F: focus the panel's search, filled with this text when it isn't empty. */
  const [searchRequest, setSearchRequest] = useState<SearchRequest | null>(null)
  useEffect(() => setSearchRequest(null), [context?.root])
  /** The section the Implement dialog is open for. */
  const [implementing, setImplementing] = useState<{ doc: string; from: ImplementationRequest['from']; title: string } | null>(null)
  /** The New context map dialog (no map), or a map's settings. */
  const [mapDialog, setMapDialog] = useState<{ map: MapDetail | null } | null>(null)
  /** Add to map… for a doc of the docs repo. */
  const [addToMap, setAddToMap] = useState<string | null>(null)
  /** A tab's right-click menu. */
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  /** The key of the tab whose name is being edited in the tab strip. */
  const [renaming, setRenaming] = useState<string | null>(null)
  /** A terminal hyperlink waiting for the user to say it may open. */
  const [linkToOpen, setLinkToOpen] = useState<string | null>(null)
  /** Bumped after a map is created or removed, so the list reloads at once. */
  const [mapsVersion, setMapsVersion] = useState(0)
  /** A map just created, opened once the reloaded list has it (before that, its context would read as stale). */
  const [createdMap, setCreatedMap] = useState<{ id: string; title: string } | null>(null)

  const showError = useCallback((text: string) => setMessage({ text: withoutIpcPrefix(text), error: true }), [])
  const run = useCallback(
    async (task: () => Promise<void>) => {
      try {
        await task()
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error))
      }
    },
    [showError]
  )

  const reloadProjects = useCallback(() => run(async () => setProjects(await api.listProjects())), [run])
  useEffect(() => void run(async () => applyEditorTheme(await api.editorTheme())), [run])
  useEffect(() => void reloadProjects(), [reloadProjects])

  useEffect(() => {
    const saved = Object.fromEntries(Object.entries(tabSets).map(([root, { tabs, active }]) => [root, { tabs, active }]))
    localStorage.setItem(SESSION_KEY, JSON.stringify({ context, tabSets: saved }))
  }, [context, tabSets])

  const updateTabs = useCallback(
    (root: string, update: (set: TabSet) => TabSet) => setTabSets((sets) => ({ ...sets, [root]: update(sets[root] ?? NO_TABS) })),
    []
  )

  // Start in the docs repo: it is the source of truth and the default place to work. A restored
  // session pointing at a project that has since been removed falls back to it too.
  const docs = projects?.find((p) => p.kind === 'docs') ?? null
  const viewedDoc = context && docs && context.root === docs.root && open?.mode === 'doc' ? open.relPath : null
  useImplementationChecks(docs?.root ?? null, viewedDoc, terminals)
  const maps = useMaps(docs?.root ?? null, mapsVersion)
  const mapDocPaths = useMapDocPaths(context?.kind === 'map' ? context.root : null, context?.kind === 'map' ? (context.map ?? null) : null)
  /** The docs repo's markdown files, for adding an existing doc to a map; only fetched while a map is open. */
  const docFiles = useFiles(docs?.root ?? null, 'docs', context?.kind === 'map' || addToMap !== null)
  const codeProjects = (projects ?? []).filter((p) => p.kind === 'code').map((p) => ({ root: p.root, name: p.name }))
  /** A map context whose map is gone (removed elsewhere, or the docs repo changed) falls back to the docs repo. */
  useEffect(() => {
    if (context?.kind === 'map' && maps && docs && (context.root !== docs.root || !maps.some((m) => m.id === context.map))) {
      setContext({ root: docs.root, label: docs.name, kind: 'docs' })
    }
  }, [context, maps, docs])
  useEffect(() => {
    if (!createdMap || !maps?.some((m) => m.id === createdMap.id)) return
    setCreatedMap(null)
    selectMap(createdMap)
  })
  useEffect(() => {
    if (!docs || !projects) return
    const stale = context && context.kind !== 'map' && !contextExists(context, { projects, docsRoot: docs.root, maps: null })
    if (!context || stale) setContext({ root: docs.root, label: docs.name, kind: 'docs' })
  }, [docs, projects, context])

  /** Focuses the tab if it's open, otherwise adds it at the end, in the tab set `key`: its own root's by default, or a map context's. */
  const openTab = useCallback(
    (next: Tab, key: string = next.root) => {
      updateTabs(key, (set) => {
        const key = tabKey(next)
        const known = set.tabs.find((t) => tabKey(t) === key)
        /**
         * A compare tab from before review comments, or from before it knew a rename's old path, opened
         * again from the branch's diff, takes them from now on.
         */
        const upgrade =
          known !== undefined && isCompareTab(known) && isCompareTab(next) && ((next.review === true && known.review !== true) || (next.fromPath !== undefined && known.fromPath === undefined))
        if (key === set.active && !upgrade) return set
        const tabs = !known ? [...set.tabs, next] : upgrade ? set.tabs.map((t) => (t === known ? next : t)) : set.tabs
        return { tabs, active: key }
      })
      setMessage(null)
    },
    [updateTabs]
  )

  /** `side` 'old' reveals a line of a diff's original file. */
  const openFile = (next: OpenFile, line?: number, key?: string, side?: 'old' | 'new'): void => {
    openTab(next, key)
    if (line !== undefined) setReveal((r) => ({ key: tabKey(next), line, seq: (r?.seq ?? 0) + 1, ...(side ? { side } : {}) }))
  }

  const removeTab = (setKey: string, key: string): void =>
    updateTabs(setKey, (set) => {
      const index = set.tabs.findIndex((t) => tabKey(t) === key)
      const tabs = set.tabs.filter((t) => tabKey(t) !== key)
      if (set.active !== key) return { ...set, tabs }
      const neighbour = tabs[index] ?? tabs[index - 1]
      return { ...set, tabs, active: neighbour ? tabKey(neighbour) : null }
    })

  /** After a file or folder is deleted, its file and thread tabs close in every context. */
  const closeDeleted = (root: string, relPath: string): void => {
    const gone = (tab: Tab): boolean =>
      tab.root === root && (isFileTab(tab) || isThreadTab(tab)) && (tab.relPath === relPath || tab.relPath.startsWith(`${relPath}/`))
    setTabSets((sets) =>
      Object.fromEntries(
        Object.entries(sets).map(([key, set]) => {
          if (!set.tabs.some(gone)) return [key, set]
          const index = set.tabs.findIndex((t) => tabKey(t) === set.active)
          const tabs = set.tabs.filter((t) => !gone(t))
          if (tabs.some((t) => tabKey(t) === set.active)) return [key, { ...set, tabs }]
          const neighbour = set.tabs.slice(index + 1).find((t) => !gone(t)) ?? tabs[tabs.length - 1]
          return [key, { tabs, active: neighbour ? tabKey(neighbour) : null }]
        })
      )
    )
  }

  /** Closing a terminal's tab ends the terminal; main asks first if a Claude session is busy. Tabs close in the current context. */
  const closeTab = (tab: Tab): void => {
    if (isMapHome(tab)) return
    const setKey = here ?? tab.root
    if (!isTerminalTab(tab)) return removeTab(setKey, tabKey(tab))
    void run(async () => {
      if (await api.closeTerminal(tab.terminal)) removeTab(setKey, tabKey(tab))
    })
  }

  /**
   * A terminal's name lives in main, so every tab and list showing it follows. Other tabs are renamed
   * in every context that has them open. File tabs keep their file's name.
   */
  const renameTab = (tab: Tab, title: string): void => {
    setRenaming(null)
    const name = title.trim()
    if (!name || isFileTab(tab)) return
    if (isTerminalTab(tab)) {
      void run(async () => void (await api.renameTerminal(tab.terminal, name)))
      return
    }
    const key = tabKey(tab)
    setTabSets((sets) =>
      Object.fromEntries(Object.entries(sets).map(([setKey, set]) => [setKey, { ...set, tabs: set.tabs.map((t) => (tabKey(t) === key ? retitled(t, name) : t)) }]))
    )
  }

  const tabMenuItems = (tab: Tab, terminal: TerminalInfo | undefined): MenuItem[] => {
    const items: MenuItem[] = []
    if (!isFileTab(tab)) items.push({ label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setRenaming(tabKey(tab)) })
    const sessionId = terminal?.sessionId
    if (sessionId) {
      items.push({
        label: 'Copy session ID',
        icon: <Copy size={14} />,
        onSelect: () =>
          void navigator.clipboard
            .writeText(sessionId)
            .then(() => setMessage({ text: `Copied session ID ${sessionId}`, error: false }))
            .catch(() => showError("Couldn't copy the session ID"))
      })
    }
    if (isFileTab(tab) && tab.mode === 'doc' && tab.root === docs?.root && !isMantaFile(tab.relPath) && maps?.length) {
      const relPath = tab.relPath
      items.push({ label: 'Add to map…', icon: <MapIcon size={14} />, onSelect: () => setAddToMap(relPath) })
    }
    return items
  }

  const openTerminal = (root: string, kind: TerminalKind, key: string = root): void =>
    void run(async () => {
      const info = await api.createTerminal(root, kind, INITIAL_TERMINAL.cols, INITIAL_TERMINAL.rows)
      openTab({ root, terminal: info.id, title: info.title }, key)
    })

  /** New Claude session or shell in the current context; in a map's context it runs in the docs repo. Work on the map is launched from its tracker. */
  const newTerminal = (kind: TerminalKind): void => {
    if (!context) return
    openTerminal(context.root, kind, contextKey(context))
  }

  /** Read through a ref so the menu listener is added once but always closes the current tab. */
  const closeActiveTab = useRef<() => void>(() => undefined)
  closeActiveTab.current = () => {
    if (activeTab) closeTab(activeTab)
  }
  useEffect(() => api.onCloseTab(() => closeActiveTab.current()), [])
  useEffect(() => api.onNavigate((direction) => navigateRef.current(direction)), [])
  /** The mouse's back and forward buttons. */
  useEffect(() => {
    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 3 && event.button !== 4) return
      event.preventDefault()
      navigateRef.current(event.button === 3 ? 'back' : 'forward')
    }
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])

  /** A doc change proposed by an implementation session shows in the status bar; the thread itself is in the doc. */
  useEffect(
    () => api.onDocProposed((_docsRoot, thread) => setMessage({ text: `Doc change proposed on ${thread.doc}: ${thread.title}`, error: false })),
    []
  )

  /** Read through a ref so the shortcut listener is added once but always sees the current context. */
  const newClaudeSession = useRef<() => void>(() => undefined)
  newClaudeSession.current = () => newTerminal('claude')

  /** Cmd+Shift+F searches across files for the editor's selection when it's on one line. */
  const searchFiles = useRef<() => void>(() => undefined)
  searchFiles.current = () => {
    if (!context) return
    const focused = document.activeElement?.closest('.cm-editor')
    const editor = focused instanceof HTMLElement ? EditorView.findFromDOM(focused) : null
    const selection = editor ? editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to) : ''
    setPanel((p) => ({ ...p, visible: true }))
    setSearchRequest((r) => ({ root: context.root, text: selection.includes('\n') ? '' : selection, seq: (r?.seq ?? 0) + 1 }))
  }

  /** Cmd+Shift+O lists the symbols of the code file in the active tab. */
  const goToSymbol = useRef<() => void>(() => undefined)
  goToSymbol.current = () => {
    const target = activeCodeEditor()
    if (target) setSymbolsOf(target)
  }
  /** Cmd+. lists quick fixes for the cursor's line in the active code file. */
  const showQuickFixes = useRef<() => void>(() => undefined)
  showQuickFixes.current = () => {
    const target = activeCodeEditor()
    if (target) setFixesFor(target)
  }
  const activeCodeEditor = (): EditorView | null => (open && open.mode === 'code' ? mountedEditor(editorKey(open.root, open.relPath)) : null)

  /** ⌘T starts a Claude session, ⌘P (or ⌘K) opens a file, ⌘⇧F searches files, ⌘⇧O a symbol in the file. Capture phase, so they work from the editor or a terminal. */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.altKey || event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key === 't' && !event.shiftKey) newClaudeSession.current()
      else if ((key === 'p' || key === 'k') && !event.shiftKey) setQuickOpen(true)
      else if (key === 'f' && event.shiftKey) searchFiles.current()
      else if (key === 'o' && event.shiftKey) goToSymbol.current()
      else if (key === '.' && !event.shiftKey) showQuickFixes.current()
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  /** Tabs of terminals that are gone (closed elsewhere, or their worktree removed) close too. */
  useEffect(() => {
    if (!terminals) return
    const live = new Set(terminals.map((t) => t.id))
    setTabSets((sets) => {
      let changed = false
      const next: Record<string, TabSet> = {}
      for (const [root, set] of Object.entries(sets)) {
        const tabs = set.tabs.filter((tab) => !isTerminalTab(tab) || live.has(tab.terminal))
        if (tabs.length === set.tabs.length) {
          next[root] = set
          continue
        }
        changed = true
        const active = tabs.some((t) => tabKey(t) === set.active) ? set.active : (tabs[0] ? tabKey(tabs[0]) : null)
        next[root] = { tabs, active }
      }
      return changed ? next : sets
    })
  }, [terminals])

  /** Switches to the implementation's worktree and its Claude session's tab. */
  const showImplementation = (thread: ThreadInfo, terminal: TerminalInfo): void => {
    const implementation = thread.implementation
    if (!implementation) return
    const project = projects?.find((p) => p.root === implementation.project)
    const detail = implementation.branch.replace(/^manta\//, '') || (implementation.worktree.split('/').pop() ?? '')
    setContext({ root: implementation.worktree, label: project?.name ?? implementation.project, kind: 'worktree', detail, project: implementation.project })
    openTab({ root: implementation.worktree, terminal: terminal.id, title: terminal.title })
  }

  /** An implementation thread opens its Claude session (resumed when its tab was closed); any other thread opens its view. */
  const openThread = (thread: ThreadInfo): void => {
    if (thread.implementation) {
      const docsRoot = docs?.root
      if (!docsRoot) return
      void run(async () => {
        const terminal = await api.openImplementationSession(docsRoot, thread.doc, thread.id, INITIAL_TERMINAL.cols, INITIAL_TERMINAL.rows)
        showImplementation(thread, terminal)
      })
      return
    }
    if (context) openTab({ root: context.root, relPath: thread.doc, thread: thread.id, title: thread.title }, contextKey(context))
  }

  const openLink = (link: TerminalLink): void => {
    const project = projects?.find((p) => p.root === link.docsRoot)
    if (project) setContext({ root: project.root, label: project.name, kind: 'docs' })
    openFile({ root: link.docsRoot, relPath: link.doc, mode: 'doc' })
  }

  /**
   * Where a jump to definition lands: the file's own tab when it's one of the context's files, a
   * read-only tab otherwise (`node_modules`, TypeScript's library). Returns the key its editor registers under.
   */
  const openJumpTarget = useRef<Parameters<typeof setFileOpener>[0]>(null)
  openJumpTarget.current = async (root, { relPath, absolutePath }) => {
    const listed = relPath !== null && (await api.listFiles(root, 'all')).includes(relPath)
    if (listed && relPath !== null) {
      openFile({ root, relPath, mode: modeFor(relPath) }, undefined, here ?? undefined)
      return editorKey(root, relPath)
    }
    openFile({ root, relPath: absolutePath, mode: 'readonly' }, undefined, here ?? undefined)
    return editorKey(root, absolutePath)
  }
  useEffect(() => {
    setFileOpener((root, target) => openJumpTarget.current?.(root, target) ?? Promise.resolve(null))
    return () => setFileOpener(null)
  }, [])

  /** A doc from a thread: in the map's context when that's where the thread is open, else in the docs repo's. */
  const openDocsFile = (root: string, relPath: string): void => {
    if (context?.kind === 'map' && context.root === root) return openFile({ root, relPath, mode: modeFor(relPath) }, undefined, contextKey(context))
    if (docs && root === docs.root) setContext({ root, label: docs.name, kind: 'docs' })
    openFile({ root, relPath, mode: modeFor(relPath) })
  }

  /** Opens the map's context where its tabs were left, with its Home tab first if it was lost (sessions saved before Home was pinned). */
  const selectMap = (map: { id: string; title: string }): void => {
    if (!docs) return
    const next: WorkContext = { root: docs.root, label: map.title, kind: 'map', map: map.id }
    const home: MapTab = { root: docs.root, map: map.id, title: map.title }
    setContext(next)
    updateTabs(contextKey(next), (set) => (set.tabs.some(isMapHome) ? set : { tabs: [home, ...set.tabs], active: set.active ?? tabKey(home) }))
    setPanel((p) => ({ ...p, visible: true }))
  }

  /**
   * A map's session belongs to its launch's worktree, so its tab opens in that worktree's context, not
   * the map's. `focus` switches there; several started at once stay put.
   */
  const openMapSession = (terminal: TerminalInfo, launch: MapLaunch | null, focus: boolean): void => {
    setWorktreeVersion((v) => v + 1)
    openTab({ root: terminal.root, terminal: terminal.id, title: terminal.title })
    if (!focus) return
    const project = launch ? projects?.find((p) => p.root === launch.project) : undefined
    const detail = launch?.branch.replace(/^manta\//, '') || (terminal.root.split('/').pop() ?? '')
    setContext({ root: terminal.root, label: project?.name ?? detail, kind: 'worktree', detail, ...(launch ? { project: launch.project } : {}) })
    setPanel((p) => ({ ...p, visible: true }))
  }

  const openMapLink = (link: MapLink): void => {
    const map = maps?.find((m) => m.id === link.map)
    if (map) selectMap(map)
  }

  /** A removed map's context and tabs go; Manta goes back to the docs repo if it was open. */
  const mapRemoved = (id: string): void => {
    setTabSets(({ [mapKey(id)]: _removed, ...rest }) => rest)
    setNav((history) => prune(history, (place) => place.context.map !== id, samePlace))
    if (context?.kind === 'map' && context.map === id && docs) setContext({ root: docs.root, label: docs.name, kind: 'docs' })
    setMapsVersion((v) => v + 1)
  }

  const selectWorktree = (project: Project, worktree: Worktree): void => {
    setContext({ root: worktree.path, label: project.name, kind: 'worktree', detail: worktreeName(worktree), project: project.root })
    setPanel((p) => ({ ...p, visible: true }))
  }

  /** A place back or forward can return to: its context still exists, and so does its terminal if its tab is one. */
  const usable = (place: Place): boolean => {
    const { context: target, tab } = place
    if (!contextExists(target, { projects: projects ?? [], docsRoot: docs?.root ?? null, maps: maps?.map((m) => m.id) ?? null })) return false
    return !tab || !isTerminalTab(tab) || terminalById.has(tab.terminal)
  }

  /** A tabless place shows whatever tab its context has active now. */
  const shows = (place: Place): Place => {
    if (place.tab) return place
    const set = tabSets[contextKey(place.context)]
    return { ...place, tab: set?.tabs.find((t) => tabKey(t) === set.active) ?? null }
  }

  /** Back or forward across contexts, reopening the place's tab if it was closed since. */
  const navigate = (direction: NavDirection): void => {
    const result = step(nav, direction, usable, shows, samePlace)
    if (!result) return
    const { context: target, tab } = result.entry
    setNav(result.history)
    setContext(target)
    if (tab) {
      const key = tabKey(tab)
      updateTabs(contextKey(target), (set) => ({ tabs: set.tabs.some((t) => tabKey(t) === key) ? set.tabs : [...set.tabs, tab], active: key }))
    }
  }
  const navigateRef = useRef<(direction: NavDirection) => void>(() => undefined)
  navigateRef.current = navigate

  if (projects === null) return <div className="app" />

  const addProject = (kind: Project['kind']): void =>
    void run(async () => {
      const added = await api.addProject(kind)
      if (!added) return
      await reloadProjects()
      // Open a new code repo straight away so its worktrees and "New worktree" are visible.
      if (added.kind === 'code' && !isExpanded(added.root)) toggle(added.root)
    })

  if (!docs) return <Onboarding onChoose={() => addProject('docs')} />

  const crumbs = !open
    ? ''
    : open.mode === 'readonly'
      ? readOnlyFolder(open.relPath)
      : [context?.label, context?.detail, ...open.relPath.split('/').slice(0, -1)].filter(Boolean).join(' / ')
  const showPanel = panel.visible && context !== null
  const threadDoc =
    context?.kind === 'worktree' || !context ? null : activeThread ? activeThread.relPath : open?.mode === 'doc' && !isMantaFile(open.relPath) ? open.relPath : null

  /** In tab-set order, not recency, so a switch never moves a mounted page in the DOM. */
  const mountedTabs = Object.entries(tabSets)
    .filter(([key]) => mountedRoots.includes(key))
    .flatMap(([key, set]) => set.tabs.map((tab) => ({ tab, setKey: key, visible: key === here && tabKey(tab) === set.active })))

  /** This context's tabs that Back would return to, most recent first. */
  const visitedHere = nav.entries
    .slice(0, nav.index + 1)
    .flatMap((place) => (place.tab && contextKey(place.context) === here ? [place.tab] : []))
    .reverse()
  /** Newest first: the open tab, then the tabs Back would return to, then the other open tabs. */
  const recentFiles = [
    ...new Set(
      [activeTab, ...visitedHere, ...view.tabs].flatMap((tab) => (tab && isFileTab(tab) && tab.mode !== 'diff' && tab.mode !== 'readonly' ? [tab.relPath] : []))
    )
  ]

  const roomFor = (otherPane: number): number => window.innerWidth - otherPane - MIN_EDITOR_WIDTH

  return (
    <div
      className={`app ${sidebarVisible ? '' : 'sidebar-hidden'}`}
      style={{ '--sidebar-width': `${sidebarWidth}px`, '--panel-width': `${panelWidth}px` }}
    >
      {sidebarVisible && (
        <Sidebar
          projects={projects}
          contextRoot={context?.root ?? null}
          worktreeVersion={worktreeVersion}
          isExpanded={isExpanded}
          onToggle={toggle}
          onToggleSidebar={() => setSidebarVisible(false)}
          maps={maps}
          contextMap={context?.kind === 'map' ? (context.map ?? null) : null}
          onSelectMap={selectMap}
          onNewMap={() => setMapDialog({ map: null })}
          onSearch={context ? () => setQuickOpen(true) : null}
          onOpenSettings={context ? () => openTab({ root: context.root, plugins: true, title: 'Plugins' }, contextKey(context)) : null}
          onSelectDocs={(project) => {
            setContext({ root: project.root, label: project.name, kind: 'docs' })
            setPanel((p) => ({ ...p, visible: true }))
          }}
          onChangeDocs={() =>
            void run(async () => {
              const added = await api.addProject('docs')
              if (!added) return
              await reloadProjects()
              setContext({ root: added.root, label: added.name, kind: 'docs' })
              setPanel({ visible: true, tab: 'files' })
              setMessage({ text: `Docs repo is now ${added.name}`, error: false })
            })
          }
          onSelectWorktree={selectWorktree}
          terminals={terminals ?? []}
          onNewClaude={(project, worktree) => {
            selectWorktree(project, worktree)
            openTerminal(worktree.path, 'claude')
          }}
          onCreateWorktree={(project, name) =>
            run(async () => {
              const worktree = await api.createWorktree(project.root, name)
              setWorktreeVersion((v) => v + 1)
              selectWorktree(project, worktree)
              setMessage({ text: `Created worktree ${worktree.branch ?? ''}`, error: false })
            })
          }
          onRemoveWorktree={(project, worktree) =>
            void run(async () => {
              const result = await api.removeWorktree(project.root, worktree.path)
              if (!result) return
              setMessage({ text: result.message, error: !result.ok })
              if (!result.ok) return
              setWorktreeVersion((v) => v + 1)
              setTabSets(({ [worktree.path]: _removed, ...rest }) => rest)
              setNav((history) => prune(history, (place) => place.context.root !== worktree.path, samePlace))
              if (context?.root === worktree.path) setContext(null)
            })
          }
          onAddProject={addProject}
          onRemoveProject={(project) =>
            void run(async () => {
              await api.removeProject(project.root)
              if (context && inProject(context, project.root)) setContext(null)
              setNav((history) => prune(history, (place) => !inProject(place.context, project.root), samePlace))
              await reloadProjects()
            })
          }
          resizeHandle={
            <ResizeHandle
              edge="right"
              width={sidebarWidth}
              onResize={(width) => setSidebarWidth(Math.min(width, roomFor(showPanel ? panelWidth : 0)))}
              onReset={() => setSidebarWidth(SIDEBAR_WIDTH.initial)}
            />
          }
        />
      )}

      <div className={`main ${showPanel ? 'with-panel' : ''}`}>
        <header className="header drag">
          {!sidebarVisible && (
            <button className="icon-button" title="Show sidebar" onClick={() => setSidebarVisible(true)}>
              <PanelLeft size={16} />
            </button>
          )}
          <button className="icon-button" title="Back (⌘[)" disabled={!canStep(nav, 'back', usable, shows, samePlace)} onClick={() => navigate('back')}>
            <ArrowLeft size={16} />
          </button>
          <button className="icon-button" title="Forward (⌘])" disabled={!canStep(nav, 'forward', usable, shows, samePlace)} onClick={() => navigate('forward')}>
            <ArrowRight size={16} />
          </button>
          <div className="title">
            {activeMap ? (
              <>
                <MapIcon size={16} />
                <span className="name">{activeMap.title}</span>
                <span className="badge">Context map</span>
              </>
            ) : activeTerminal ? (
              <>
                <span className="crumbs">{[context?.label, context?.detail].filter(Boolean).join(' / ')} /</span>
                <span className="name">{activeTerminal.title}</span>
                <span className={`badge terminal-state state-${activeTerminal.state}`}>{stateLabel(activeTerminal)}</span>
              </>
            ) : activeCompare ? (
              <>
                {activeCompare.relPath.includes('/') && <span className="crumbs">{activeCompare.relPath.slice(0, activeCompare.relPath.lastIndexOf('/'))} /</span>}
                <span className="name">{activeCompare.title}</span>
                <span className="badge">Committed</span>
              </>
            ) : activeThread ? (
              <>
                <span className="crumbs">{displayName(activeThread.relPath)} /</span>
                <span className="name">{activeThread.title}</span>
                <span className="badge">Thread</span>
              </>
            ) : open ? (
              <>
                {crumbs && <span className="crumbs">{crumbs} /</span>}
                <span className="name">
                  {open.mode === 'doc' ? displayName(open.relPath) : open.relPath.split('/').pop()}
                </span>
                {open.mode === 'diff' && <span className="badge">Changes</span>}
                {open.mode === 'readonly' && <span className="badge">Read-only</span>}
              </>
            ) : (
              <>
                <span className="name">{context?.label ?? ''}</span>
                {context?.detail && <span className="crumbs">{context.detail}</span>}
              </>
            )}
          </div>
          <span className="grow" />
          {open && open.mode !== 'readonly' && (
            <button className="icon-button" title="Reveal in Finder" onClick={() => void run(() => api.revealDoc(open.root, open.relPath))}>
              <FolderOpen size={16} />
            </button>
          )}
          <button
            className="icon-button"
            title={context?.kind === 'map' ? 'New Claude session from this map (⌘T)' : 'New Claude session (⌘T)'}
            disabled={!context}
            onClick={() => newTerminal('claude')}
          >
            <Bot size={16} />
          </button>
          <button className="icon-button" title="New shell" disabled={!context} onClick={() => newTerminal('shell')}>
            <SquareTerminal size={16} />
          </button>
          <button
            className={`icon-button ${showPanel ? 'active' : ''}`}
            title="Files and changes"
            disabled={!context}
            onClick={() => setPanel((p) => ({ ...p, visible: !p.visible }))}
          >
            <PanelRight size={16} />
          </button>
        </header>

        <div className="content">
          {context && (
            <div className="tab-strip">
              {view.tabs.map((tab) => {
                const key = tabKey(tab)
                const terminal = isTerminalTab(tab) ? terminalById.get(tab.terminal) : undefined
                const label = terminal ? terminal.title : !isFileTab(tab) ? tab.title : tab.mode === 'doc' ? displayName(tab.relPath) : (tab.relPath.split('/').pop() ?? tab.relPath)
                const hint = isMapTab(tab)
                  ? `Context map ${tab.title}`
                  : isThreadTab(tab)
                    ? `Thread on ${tab.relPath}`
                    : terminal
                      ? `${terminal.title}: ${stateLabel(terminal)}`
                      : isFileTab(tab)
                        ? tab.relPath
                        : tab.title
                const drop = dropAt?.key === key ? ` drop-${dropAt.side}` : ''
                return (
                  <div
                    key={key}
                    className={`tab kind-${tabKind(tab, terminal)} ${key === view.active ? 'active' : ''}${isMapHome(tab) ? ' pinned' : ''}${drop}`}
                    title={hint}
                    draggable={renaming !== key}
                    onClick={() => openTab(tab, here ?? tab.root)}
                    onDoubleClick={() => !isFileTab(tab) && setRenaming(key)}
                    onAuxClick={(e) => e.button === 1 && closeTab(tab)}
                    onContextMenu={(e) => {
                      const items = tabMenuItems(tab, terminal)
                      if (items.length === 0) return
                      e.preventDefault()
                      setTabMenu({ x: e.clientX, y: e.clientY, items })
                    }}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData(TAB_DRAG, key)
                      setDragging(key)
                    }}
                    onDragOver={(e) => {
                      if (!dragging) return
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const side = e.clientX > rect.left + rect.width / 2 ? 'after' : 'before'
                      if (dropAt?.key !== key || dropAt.side !== side) setDropAt({ key, side })
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null)) setDropAt(null)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const moving = e.dataTransfer.getData(TAB_DRAG)
                      const side = dropAt?.key === key ? dropAt.side : 'before'
                      if (moving) updateTabs(here ?? tab.root, (set) => ({ ...set, tabs: [...reorder(set.tabs, moving, key, side, tabKey)] }))
                      setDragging(null)
                      setDropAt(null)
                    }}
                    onDragEnd={() => {
                      setDragging(null)
                      setDropAt(null)
                    }}
                  >
                    <TabIcon tab={tab} terminal={terminal} />
                    {renaming === key ? (
                      <TabNameInput initial={label} onDone={(name) => renameTab(tab, name)} onCancel={() => setRenaming(null)} />
                    ) : (
                      <span className="tab-label">
                        {label}
                        {isFileTab(tab) && tab.mode === 'diff' && ' (changes)'}
                      </span>
                    )}
                    {terminal && terminal.kind === 'claude' && <span className={`terminal-dot state-${terminal.state}`} />}
                    {!isMapHome(tab) && (
                      <button
                        className="tab-close"
                        title="Close tab"
                        onClick={(e) => {
                          e.stopPropagation()
                          closeTab(tab)
                        }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                )
              })}
              <NewTabButton
                onNewClaude={() => newTerminal('claude')}
                onNewShell={() => newTerminal('shell')}
                onPlugins={() => openTab({ root: context.root, plugins: true, title: 'Plugins' }, contextKey(context))}
                onResult={(result) => setMessage({ text: result.message, error: !result.ok })}
              />
            </div>
          )}
          <div className="tab-pages">
            {mountedTabs.map(({ tab, setKey, visible }) => (
              <div key={`${setKey}|${tabKey(tab)}`} className="tab-page" hidden={!visible}>
                {isMapTab(tab) ? (
                  <MapView
                    docsRoot={tab.root}
                    id={tab.map}
                    screen={tab.screen ?? 'home'}
                    ticket={tab.ticket ?? null}
                    terminals={terminals ?? []}
                    codeProjects={codeProjects}
                    docFiles={docFiles}
                    onOpenDoc={(relPath) => openFile({ root: tab.root, relPath, mode: modeFor(relPath) }, undefined, setKey)}
                    onOpenThread={(thread) => openTab({ root: tab.root, relPath: thread.doc, thread: thread.id, title: thread.title }, setKey)}
                    onOpenSession={openMapSession}
                    onOpenMapSession={(terminal) => openTab({ root: terminal.root, terminal: terminal.id, title: terminal.title }, setKey)}
                    onEditMap={(map) => setMapDialog({ map })}
                    onRemoved={() => mapRemoved(tab.map)}
                    onMessage={(text, error) => setMessage({ text: withoutIpcPrefix(text), error })}
                  />
                ) : isTerminalTab(tab) ? (
                  <TerminalTabPage
                    info={terminalById.get(tab.terminal) ?? null}
                    visible={visible}
                    onError={showError}
                    onOpenLink={openLink}
                    onOpenMap={openMapLink}
                    onOpenUrl={setLinkToOpen}
                    mapTitle={maps?.find((m) => m.id === terminalById.get(tab.terminal)?.map?.map)?.title}
                  />
                ) : isThreadTab(tab) ? (
                  <ThreadView
                    root={tab.root}
                    relPath={tab.relPath}
                    id={tab.thread}
                    onOpenDoc={(relPath) => openDocsFile(tab.root, relPath)}
                    onOpenThread={openThread}
                    onImplement={(thread) => setImplementing({ doc: thread.doc, from: { thread: thread.id }, title: thread.title })}
                    onError={showError}
                  />
                ) : isReviewTab(tab) ? (
                  <PullRequestReview
                    root={tab.root}
                    pullRequest={tab.pullRequest}
                    onError={showError}
                    onResult={(result) => setMessage({ text: result.message, error: !result.ok })}
                  />
                ) : isPluginsTab(tab) ? (
                  <PluginsView onResult={(result) => setMessage({ text: result.message, error: !result.ok })} />
                ) : isCompareTab(tab) ? (
                  <BranchCompareView
                    root={tab.root}
                    relPath={tab.relPath}
                    from={tab.from}
                    fromPath={tab.fromPath}
                    to={tab.to}
                    review={tab.review === true}
                    onError={showError}
                    onResult={(result) => setMessage({ text: result.message, error: !result.ok })}
                  />
                ) : (
                  <Editor
                    root={tab.root}
                    relPath={tab.relPath}
                    mode={tab.mode}
                    visible={visible}
                    revealLine={reveal?.key === tabKey(tab) ? reveal : undefined}
                    onError={showError}
                    onCursor={(offset) => cursors.current.set(`${tab.root}:${tab.relPath}`, offset)}
                    onSaved={(result) => setMessage({ text: result.message, error: !result.ok })}
                    onResult={(result) => setMessage({ text: result.message, error: !result.ok })}
                    {...(tab.mode === 'doc' && tab.root === docs.root && !isMantaFile(tab.relPath)
                      ? {
                          threads: {
                            onOpen: openThread,
                            onCreate: (offset: number, title: string) =>
                              void run(async () => openThread(await api.createThread(tab.root, tab.relPath, offset, title))),
                            onDismiss: (thread: ThreadInfo) => void run(() => api.dismissThreadChanges(tab.root, tab.relPath, thread.id)),
                            onImplement: (offset: number, title: string) => setImplementing({ doc: tab.relPath, from: { offset }, title }),
                            onAbandon: (thread: ThreadInfo) => {
                              if (!window.confirm(`Mark “${thread.title}” abandoned? Its session and worktree stay as they are.`)) return
                              void run(async () => void (await api.setThreadStatus(tab.root, tab.relPath, thread.id, 'discarded')))
                            }
                          }
                        }
                      : {})}
                  />
                )}
              </div>
            ))}
            {!activeTab && (
              <EmptyContext
                context={context}
                onShowPanel={() => setPanel({ visible: true, tab: 'files' })}
                onOpenMap={() => context?.map && openTab({ root: context.root, map: context.map, title: context.label }, contextKey(context))}
              />
            )}
          </div>
        </div>

        {showPanel && context && (
          <RightPanel
            key={contextKey(context)}
            root={context.root}
            tab={panel.tab}
            openPath={open && open.root === context.root ? open.relPath : null}
            onTab={(tab) => setPanel({ visible: true, tab })}
            onOpenFile={(relPath, line) => openFile({ root: context.root, relPath, mode: modeFor(relPath) }, line, contextKey(context))}
            onDeleted={(relPath) => closeDeleted(context.root, relPath)}
            onOpenDiff={(relPath, line, side) => openFile({ root: context.root, relPath, mode: 'diff' }, line, contextKey(context), side)}
            onOpenCompare={(relPath, from, to, title, { review, fromPath } = {}) =>
              openTab({ root: context.root, relPath, from, to, title, ...(review ? { review } : {}), ...(fromPath ? { fromPath } : {}) }, contextKey(context))
            }
            onReviewFiles={(pullRequest) => openTab({ root: context.root, pullRequest, title: `Review #${pullRequest}` }, contextKey(context))}
            threadDoc={threadDoc}
            showBranch={context.kind === 'worktree'}
            cursor={() => (threadDoc ? (cursors.current.get(`${context.root}:${threadDoc}`) ?? 0) : 0)}
            onOpenThread={openThread}
            onImplement={() => {
              if (!threadDoc || !context) return
              const offset = cursors.current.get(`${context.root}:${threadDoc}`) ?? 0
              setImplementing({ doc: threadDoc, from: { offset }, title: displayName(threadDoc) })
            }}
            onError={showError}
            onResult={(result) => setMessage({ text: result.message, error: !result.ok })}
            commitFocus={commitFocus}
            searchRequest={searchRequest}
            mapDocs={context.kind === 'map' && mapDocPaths ? { title: context.label, paths: mapDocPaths } : null}
            resizeHandle={
              <ResizeHandle
                edge="left"
                width={panelWidth}
                onResize={(width) => setPanelWidth(Math.min(width, roomFor(sidebarVisible ? sidebarWidth : 0)))}
                onReset={() => setPanelWidth(PANEL_WIDTH.initial)}
              />
            }
          />
        )}
      </div>

      {quickOpen && context && (
        <QuickOpen
          root={context.root}
          recent={recentFiles}
          onOpen={(relPath, line) => openFile({ root: context.root, relPath, mode: modeFor(relPath) }, line, contextKey(context))}
          onClose={() => setQuickOpen(false)}
        />
      )}

      {symbolsOf && <SymbolPicker view={symbolsOf} onClose={() => setSymbolsOf(null)} />}
      {fixesFor && <QuickFixPicker view={fixesFor} onClose={() => setFixesFor(null)} onResult={(result) => setMessage({ text: result.message, error: !result.ok })} />}

      {implementing && (
        <ImplementDialog
          docsRoot={docs.root}
          doc={implementing.doc}
          from={implementing.from}
          title={implementing.title}
          projects={projects}
          size={INITIAL_TERMINAL}
          maps={maps ?? []}
          onClose={() => setImplementing(null)}
          onStartedTicket={(started, text) => {
            setImplementing(null)
            openMapSession(started.terminal, started.launch, true)
            setMessage({ text, error: false })
          }}
          onStarted={(started) => {
            setImplementing(null)
            setWorktreeVersion((v) => v + 1)
            showImplementation(started.thread, started.terminal)
            setMessage({ text: started.message, error: false })
          }}
        />
      )}

      {mapDialog && (
        <MapDialog
          docsRoot={docs.root}
          codeProjects={codeProjects.map((p) => p.name)}
          map={mapDialog.map}
          onClose={() => setMapDialog(null)}
          onSaved={(created) => {
            setMapDialog(null)
            setMapsVersion((v) => v + 1)
            if (created) setCreatedMap(created)
          }}
        />
      )}

      {addToMap !== null && (
        <AddMapDocDialog
          docsRoot={docs.root}
          map={null}
          maps={maps ?? []}
          mode="existing"
          milestones={[]}
          docFiles={docFiles}
          initialPath={addToMap}
          onClose={() => setAddToMap(null)}
          onDone={(path) => {
            setAddToMap(null)
            setMapsVersion((v) => v + 1)
            if (path) setMessage({ text: `Added ${path} to the map`, error: false })
          }}
          onError={showError}
        />
      )}

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenu.items}
          onClose={() => setTabMenu(null)}
        />
      )}

      {linkToOpen && <OpenLinkDialog url={linkToOpen} onClose={() => setLinkToOpen(null)} />}

      <StatusBar
        root={context?.root ?? null}
        label={context?.label ?? null}
        message={message}
        onPull={() =>
          void run(async () => {
            if (!context) return
            setMessage({ text: 'Pulling…', error: false })
            const result = await api.pull(context.root)
            setMessage({ text: result.message, error: !result.ok })
          })
        }
        onCommit={() => {
          setPanel({ visible: true, tab: 'changes' })
          setCommitFocus((n) => n + 1)
        }}
      />
    </div>
  )
}

/** What a tab holds, which sets its colour: files (docs, code, diffs and other views), shells, or agents (Claude sessions and threads). */
type TabKind = 'file' | 'terminal' | 'agent'

function tabKind(tab: Tab, terminal: TerminalInfo | undefined): TabKind {
  if (isThreadTab(tab)) return 'agent'
  if (isTerminalTab(tab)) return terminal?.kind === 'shell' ? 'terminal' : 'agent'
  return 'file'
}

const retitled = (tab: Tab, title: string): Tab => (isFileTab(tab) ? tab : { ...tab, title })

/**
 * A tab's name, edited in place. Enter or leaving the field keeps it, Escape cancels. Keys stay in the
 * field so the app's shortcuts don't fire while typing.
 */
function TabNameInput({ initial, onDone, onCancel }: { initial: string; onDone: (name: string) => void; onCancel: () => void }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  /** Enter and Escape unmount the field, and a blur can still follow; only the first ending counts. */
  const ended = useRef(false)
  const end = (keep: boolean): void => {
    if (ended.current) return
    ended.current = true
    if (keep && value.trim() && value.trim() !== initial) onDone(value)
    else onCancel()
  }
  return (
    <input
      className="tab-rename"
      autoFocus
      value={value}
      size={Math.max(value.length, 4)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') end(true)
        else if (e.key === 'Escape') end(false)
      }}
      onBlur={() => end(true)}
    />
  )
}

function TabIcon({ tab, terminal }: { tab: Tab; terminal: TerminalInfo | undefined }): React.JSX.Element {
  if (isMapTab(tab)) return <MapIcon size={13} />
  if (isThreadTab(tab)) return <MessagesSquare size={13} />
  if (isTerminalTab(tab)) return terminal?.kind === 'shell' ? <SquareTerminal size={13} /> : <Bot size={13} />
  if (isCompareTab(tab)) return <GitCommitHorizontal size={13} />
  if (isPluginsTab(tab)) return <Puzzle size={13} />
  if (isReviewTab(tab)) return <GitPullRequest size={13} />
  return <FileText size={13} />
}

interface TerminalTabPageProps {
  info: TerminalInfo | null
  visible: boolean
  onError: (message: string) => void
  onOpenLink: (link: TerminalLink) => void
  onOpenMap: (link: MapLink) => void
  onOpenUrl: (url: string) => void
  mapTitle: string | undefined
}

/** Keyed by when the process started, so a restart gets a fresh screen. */
function TerminalTabPage({ info, visible, onError, onOpenLink, onOpenMap, onOpenUrl, mapTitle }: TerminalTabPageProps): React.JSX.Element | null {
  if (!info) return null
  return (
    <TerminalView
      key={info.startedAt ?? 'not-running'}
      info={info}
      visible={visible}
      onError={onError}
      onOpenLink={onOpenLink}
      onOpenMap={onOpenMap}
      onOpenUrl={onOpenUrl}
      mapTitle={mapTitle}
    />
  )
}

function EmptyContext({ context, onShowPanel, onOpenMap }: { context: WorkContext | null; onShowPanel: () => void; onOpenMap: () => void }): React.JSX.Element {
  if (context?.kind === 'map') {
    return (
      <div className="empty-state">
        <h2>{context.label}</h2>
        <p>A context map: your home for one feature or project, with its docs, its plan and the work launched from it.</p>
        <div className="button-row">
          <button className="primary-button" onClick={onOpenMap}>
            Open the map
          </button>
        </div>
      </div>
    )
  }
  if (context?.kind === 'worktree') {
    return (
      <div className="empty-state">
        <h2>{context.detail ?? context.label}</h2>
        <p>Open a file from Files, or review what changed under Changes.</p>
        <div className="button-row">
          <button className="primary-button" onClick={onShowPanel}>
            Show files
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="empty-state">
      <h2>{context?.label ?? 'Manta'}</h2>
      <p>Open a doc from Files, or create one. Docs here are the source of truth everything else links back to.</p>
      <div className="button-row">
        <button className="primary-button" onClick={onShowPanel}>
          Show files
        </button>
      </div>
    </div>
  )
}

function Onboarding({ onChoose }: { onChoose: () => void }): React.JSX.Element {
  return (
    <div className="onboarding drag">
      <div className="empty-state">
        <BookOpen size={28} />
        <h2>Choose your docs repo</h2>
        <p>
          Manta starts from a git repository of markdown docs. It becomes the source of truth; code projects and their
          worktrees link back to it. Pick an existing repo, or an empty folder to start a new one.
        </p>
        <div className="button-row">
          <button className="primary-button accent" onClick={onChoose}>
            Choose folder…
          </button>
        </div>
      </div>
    </div>
  )
}
