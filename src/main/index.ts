import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { execFile } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { ClaudeCodeAgent } from '../core/agent/claudeCodeAgent'
import { claudeCodeStatus } from '../core/agent/claudeStatus'
import { Git, isSafeRef } from '../core/repo/git'
import { ghPullRequestDetail, ghPullRequests, ghRunner } from '../core/repo/github'
import type { FileEvent } from '../core/repo/repoCache'
import { isWatchIgnored } from '../core/repo/watchIgnore'
import { ProjectRegistry } from '../core/repo/projects'
import { ScriptedAgent, type AgentTurn, type ScriptStep, type ThreadAgent } from '../core/agent/threadAgent'
import { Implementations, proposeDocChangeTool, reviseDocChangeTool, withdrawDocChangeTool } from '../core/implementations'
import { MapLaunches } from '../core/mapLaunches'
import { batchId, briefRequest, docsEdit, launchRequest, mapDoc, mapFeedback, mapId, mapSettings, newMapInput, picks, threadIds, trackerEdit, trackerTarget } from '../core/maps/mapArgs'
import { PullRequestReviews, reviewTargetProblem } from '../core/review/pullRequestReview'
import { PullRequests } from '../core/review/pullRequests'
import { ReviewSettings } from '../core/review/reviewSettings'
import { sendReview, sendReviewDraft } from '../core/review/sendReview'
import { resolveFormatter, runFormatter } from '../core/format/formatters'
import { LanguageServerHost, type FileChangeType } from '../core/lsp/languageServerHost'
import { nativeTypescriptBinary, typescriptServer } from '../core/lsp/serverCatalog'
import { PluginManager } from '../core/plugins/pluginManager'
import { RECIPES } from '../core/plugins/recipes'
import { parseEditorTheme, searchThemes, themeVariants } from '../core/plugins/themes'
import { findOnPath, loginShellEnv } from '../core/terminal/terminalEnv'
import { TerminalManager, type ClaudeLaunch } from '../core/terminal/terminals'
import { Channel, isReviewDiff, type PullRequestDetail, type ReviewEvent, type CustomServerInput, type FormatResult, type CommitScope, type ImplementationRequest, type OpResult, type PermissionDecision, type ProjectKind, type ReviewAnchor, type ReviewTarget, type TerminalKind, type ThreadStatus } from '../shared/ipc'

// Lets a test instance run with its own projects and settings, isolated from the user's app.
// `electron-vite dev` (it sets ELECTRON_RENDERER_URL) gets a profile of its own too: a dev restart
// ends every terminal, so it must never be the copy holding the user's real sessions.
if (process.env['MANTA_USER_DATA']) app.setPath('userData', process.env['MANTA_USER_DATA'])
else if (process.env['ELECTRON_RENDERER_URL']) app.setPath('userData', path.join(app.getPath('appData'), 'manta-dev'))

let window: BrowserWindow | null = null
let registry: ProjectRegistry | null = null
let terminals: TerminalManager | null = null
let implementations: Implementations | null = null
let mapLaunches: MapLaunches | null = null
let languageServers: LanguageServerHost | null = null
let plugins: PluginManager | null = null
/** TypeScript 7's native binary from Manta's own dependencies; language servers' library files under it open read-only. */
const BUNDLED_TYPESCRIPT = nativeTypescriptBinary(path.join(app.getAppPath(), 'node_modules'))
const watchers = new Map<string, FSWatcher>()
/** File events per root not yet classified and sent; `unknown` when fs.watch didn't say which path. */
const pendingEvents = new Map<string, FileEvent[] | 'unknown'>()
/** `lib.dom.d.ts` is about 2 MB; anything much larger isn't worth showing in an editor. */
const READ_ONLY_MAX_BYTES = 8 * 1024 * 1024
/** Events are sent in batches at most this long after the first, even while files keep changing. */
const FILE_EVENT_BATCH_MS = 250
/** How often open map launches' pull requests are looked up in the background. */
const MAP_CHECK_MS = 5 * 60_000

function createWindow(): void {
  window = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 760,
    minHeight: 480,
    title: 'Manta',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    // Matches --bg so the window doesn't flash white before the renderer paints.
    backgroundColor: '#1d1e21',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  if (process.env['ELECTRON_RENDERER_URL']) void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  // Links in agent replies open in the user's browser; the app window never leaves the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalLink(url)
    return { action: 'deny' }
  })
  window.on('focus', () => void refreshOnFocus().catch((error: unknown) => console.error('manta: focus refresh', error)))
  const contents = window.webContents
  contents.on('will-navigate', (event, url) => {
    const origin = parsedUrl(url)?.origin
    if (origin !== undefined && origin === parsedUrl(contents.getURL())?.origin) return
    event.preventDefault()
    openExternalLink(url)
  })
  window.on('closed', () => {
    window = null
  })
}

const EXTERNAL_PROTOCOLS: readonly string[] = ['http:', 'https:', 'mailto:']

function openExternalLink(url: string): void {
  if (EXTERNAL_PROTOCOLS.includes(parsedUrl(url)?.protocol ?? '')) void shell.openExternal(url)
}

function parsedUrl(url: string): URL | null {
  return URL.canParse(url) ? new URL(url) : null
}

function send(channel: string, ...args: unknown[]): void {
  window?.webContents.send(channel, ...args)
}


function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Only full shas the renderer got from git, so a ref like `--output=x` can never reach a git command. */
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error('sha must be a full commit sha')
  return value
}

function strArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array of strings`)
  return value.map((item, index) => str(item, `${name}[${index}]`))
}

function commitScope(value: unknown): CommitScope {
  if (value !== 'staged' && value !== 'all') throw new Error('scope must be staged or all')
  return value
}

const THREAD_STATUSES: readonly ThreadStatus[] = ['open', 'approved', 'merged', 'discarded']

function status(value: unknown): ThreadStatus {
  const found = THREAD_STATUSES.find((s) => s === value)
  if (!found) throw new Error(`status must be one of ${THREAD_STATUSES.join(', ')}`)
  return found
}

function int(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name} must be an integer`)
  return value
}

/**
 * The user's own `claude` and `gh`, from their login shell's PATH (an app launched from the Dock
 * gets a minimal one). Null `claude` falls back to the copy bundled with the Agent SDK; null `gh`
 * means pull requests aren't looked up. Read synchronously by callers, so anything that launches
 * Claude awaits `commandsFound()` first.
 */
let claudePath: string | null = null
let ghPath: string | null = null
let commandsLookup: Promise<void> | null = null

/** Uses the environment terminals read anyway, so finding the commands starts no extra shell. */
function findCommands(): Promise<void> {
  commandsLookup = terminalBaseEnv().then(async ({ PATH }) => {
    ;[claudePath, ghPath] = await Promise.all([findOnPath('claude', PATH), findOnPath('gh', PATH)])
  })
  return commandsLookup
}

const commandsFound = (): Promise<void> => commandsLookup ?? findCommands()
const userClaude = (): string | null => claudePath
/** `MANTA_FAKE_GH` stands a script in for `gh`, for UI checks that must not reach GitHub. */
const userGh = (): string | null => process.env['MANTA_FAKE_GH'] ?? ghPath

/**
 * `MANTA_FAKE_AGENT=1` swaps in a scripted agent, for UI e2e runs that must not spend tokens.
 * A message of the form `find => replace` makes it edit the doc; `ask <command>` makes it ask permission.
 */
function threadAgent(): ThreadAgent {
  if (process.env['MANTA_FAKE_AGENT'] === '1') {
    return new ScriptedAgent((turn) => {
      if ('map' in turn.context) return fakeMapTurn(turn)
      if (turn.prompt.startsWith('ask ')) return [{ ask: { tool: 'Bash', summary: turn.prompt.slice(4) } }, { text: 'Done.' }]
      const [find, replace] = turn.prompt.split(' => ')
      if (find === undefined || replace === undefined) return [{ text: `Scripted reply to: ${turn.prompt}` }]
      return [{ text: 'Proposing an edit. ' }, { edit: { find, replace } }, { text: 'Done.' }]
    })
  }
  return new ClaudeCodeAgent(userClaude)
}

/**
 * The scripted map agents: the sweep wraps up as "went to plan"; Ask the map proposes a two-milestone
 * plan when asked to break the work down, suggests a doc for `suggest <path>`, and otherwise answers.
 */
function fakeMapTurn(turn: AgentTurn): ScriptStep[] {
  if (turn.prompt.startsWith('A session working on')) {
    return [{ text: 'Sweeping. ' }, { call: { tool: 'wrap_up', args: { summary: 'Went to plan (scripted sweep).', went_to_plan: true } } }]
  }
  if (turn.prompt.startsWith('Break the work down')) {
    const milestones = [
      { title: 'Foundations', description: 'The data model and its store.', tickets: [{ title: 'Define the data model', description: 'Types and guards.' }, { title: 'Store it', description: 'Atomic writes.' }] },
      { title: 'Screens', description: 'The UI on top.', tickets: [{ title: 'Home screen', description: 'Up next first.' }] }
    ]
    return [{ text: 'Reading the docs. ' }, { call: { tool: 'propose_milestones', args: { why: 'From the docs (scripted).', milestones } } }, { text: 'Proposed a plan.' }]
  }
  if (turn.prompt.startsWith('suggest ')) {
    return [{ call: { tool: 'suggest_doc', args: { path: turn.prompt.slice(8).trim(), why: 'It explains the moving parts (scripted).' } } }, { text: 'Suggested it.' }]
  }
  return [{ text: `Scripted map answer to: ${turn.prompt.split('\n')[0] ?? ''}` }]
}

const TERMINAL_KINDS: readonly TerminalKind[] = ['claude', 'shell']

function terminalKind(value: unknown): TerminalKind {
  const found = TERMINAL_KINDS.find((k) => k === value)
  if (!found) throw new Error(`kind must be one of ${TERMINAL_KINDS.join(', ')}`)
  return found
}

/** Columns or rows of a terminal. */
function cells(value: unknown, name: string): number {
  const n = int(value, name)
  if (n < 1 || n > 1000) throw new Error(`${name} must be between 1 and 1000`)
  return n
}

function reviewAnchor(value: unknown): ReviewAnchor {
  if (typeof value !== 'object' || value === null) throw new Error('anchor must be an object')
  const relPath = str('relPath' in value ? value.relPath : undefined, 'anchor.relPath')
  const diff = 'diff' in value ? value.diff : undefined
  if (!isReviewDiff(diff)) throw new Error('anchor.diff must be changes, branch or pr:<number>')
  const side = 'side' in value ? value.side : undefined
  if (side !== 'old' && side !== 'new') throw new Error('anchor.side must be old or new')
  const line = int('line' in value ? value.line : undefined, 'anchor.line')
  if (line < 1) throw new Error('anchor.line must be at least 1')
  const lineText = 'lineText' in value ? value.lineText : undefined
  const hunk = 'hunk' in value ? value.hunk : undefined
  if (typeof lineText !== 'string' || typeof hunk !== 'string') throw new Error('anchor.lineText and anchor.hunk must be strings')
  return { relPath, diff, side, line, lineText, hunk }
}

function reviewTarget(value: unknown): ReviewTarget {
  if (typeof value === 'object' && value !== null && 'newSession' in value && value.newSession === true) return { newSession: true }
  if (typeof value === 'object' && value !== null && 'terminal' in value) return { terminal: str(value.terminal, 'target.terminal') }
  throw new Error('target must name a terminal or a new session')
}

/** A new session's size until its tab mounts and fits it. */
const REVIEW_SESSION_SIZE = { cols: 120, rows: 32 }

const userShell = (): string => process.env['SHELL'] ?? '/bin/zsh'

let shellEnv: Promise<Record<string, string>> | null = null

/** Read once per run: the login shell can take a second or two to start. */
function terminalBaseEnv(): Promise<Record<string, string>> {
  shellEnv ??= loginShellEnv(userShell(), process.env)
  return shellEnv
}

/** `MANTA_FAKE_AGENT=1` runs a scripted stand-in for `claude` with Electron's own Node, so e2e runs spend nothing. */
function claudeLaunch(): ClaudeLaunch | null {
  if (process.env['MANTA_FAKE_AGENT'] === '1') {
    return { file: process.execPath, args: [path.join(app.getAppPath(), 'scripts', 'fake-claude.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } }
  }
  const executable = userClaude()
  return executable ? { file: executable, args: [] } : null
}

/** Electron's default menu, except ⌘W closes the active tab (as in an editor) and ⌘⇧W the window, plus Go → Back and Forward. */
function appMenu(): Menu {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send(Channel.closeTab) },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Go',
      submenu: [
        /** Taking ⌘[ and ⌘] from the code editor's indent and outdent, as VS Code does; Tab and Shift+Tab still indent. */
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => send(Channel.navigate, 'back') },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => send(Channel.navigate, 'forward') }
      ]
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
  ])
}

/** The doc tools implementation sessions get; `call` is late-bound because the terminal manager is created first. */
const implementationTools = [
  proposeDocChangeTool((terminalId, args) => requireImplementations().proposeDocChange(terminalId, args)),
  reviseDocChangeTool((terminalId, args) => requireImplementations().reviseDocChange(terminalId, args)),
  withdrawDocChangeTool((terminalId, args) => requireImplementations().withdrawDocChange(terminalId, args))
]

function requireImplementations(): Implementations {
  if (!implementations) throw new Error('Manta is still starting')
  return implementations
}

function implementationRequest(value: unknown): ImplementationRequest {
  if (typeof value !== 'object' || value === null) throw new Error('request must be an object')
  const field = (name: string): unknown => (name in value ? Reflect.get(value, name) : undefined)
  const from = field('from')
  const worktree = field('worktree')
  if (typeof from !== 'object' || from === null) throw new Error('from must be an object')
  if (typeof worktree !== 'object' || worktree === null) throw new Error('worktree must be an object')
  const offset = 'offset' in from ? from.offset : undefined
  const thread = 'thread' in from ? from.thread : undefined
  const name = 'name' in worktree ? worktree.name : undefined
  const worktreePath = 'path' in worktree ? worktree.path : undefined
  const prompt = field('prompt')
  if (typeof prompt !== 'string') throw new Error('prompt must be a string')
  return {
    docsRoot: str(field('docsRoot'), 'docsRoot'),
    doc: str(field('doc'), 'doc'),
    from: thread !== undefined ? { thread: str(thread, 'from.thread') } : { offset: int(offset, 'from.offset') },
    title: str(field('title'), 'title'),
    project: str(field('project'), 'project'),
    worktree: worktreePath !== undefined ? { path: str(worktreePath, 'worktree.path') } : { name: str(name, 'worktree.name') },
    prompt,
    cols: cells(field('cols'), 'cols'),
    rows: cells(field('rows'), 'rows')
  }
}

function requireMapLaunches(): MapLaunches {
  if (!mapLaunches) throw new Error('Manta is still starting')
  return mapLaunches
}

function decision(value: unknown): PermissionDecision {
  if (value !== 'allow' && value !== 'always' && value !== 'deny') throw new Error('decision must be allow, always or deny')
  return value
}

/** The maps of the docs repo; any other root is refused. */
async function docsMaps(root: unknown) {
  const resolved = await requireRegistry().resolveRoot(str(root, 'docsRoot'))
  if (!requireRegistry().list().some((p) => p.kind === 'docs' && p.root === resolved)) throw new Error('Context maps live in the docs repo')
  return (await requireRegistry().workspace(resolved)).maps
}

/** Ends what runs in a root that is going away: its terminals and language servers. */
async function closeRootProcesses(root: string): Promise<void> {
  await Promise.all([requireTerminals().closeRoot(root), languageServers?.closeRoot(root)])
}

function customServerInput(value: unknown): CustomServerInput {
  if (typeof value !== 'object' || value === null) throw new Error('custom server must be an object')
  const field = (key: string): unknown => (key in value ? Reflect.get(value, key) : undefined)
  const list = (key: string): string[] => {
    const v = field(key)
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  }
  return { package: str(field('package'), 'package'), command: str(field('command'), 'command'), args: list('args'), languages: list('languages') }
}

function requirePlugins(): PluginManager {
  if (!plugins) throw new Error('Manta is still starting')
  return plugins
}

/** The root, then its repo's main checkout: a fresh worktree's tools are usually installed there. */
async function toolRoots(root: string): Promise<string[]> {
  const main = await (await workspace(root)).mainCheckout().catch(() => root)
  return main === root ? [root] : [root, main]
}

function requireLanguageServers(): LanguageServerHost {
  if (!languageServers) throw new Error('Manta is still starting')
  return languageServers
}

function requireTerminals(): TerminalManager {
  if (!terminals) throw new Error('Manta is still starting')
  return terminals
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function requireRegistry(): ProjectRegistry {
  if (!registry) throw new Error('Manta is still starting')
  return registry
}

const workspace = (root: unknown) => requireRegistry().workspace(str(root, 'root'))

function watchWorkspace(root: string, onChange: (relPath: string) => void): void {
  // Watch the whole tree, not single files: editors often save by writing a temp file and
  // renaming it over the original, which a per-file watch stops following.
  const watcher = watch(root, { recursive: true }, (event, filename) => {
    if (!filename) return queueFileEvent(root, 'unknown')
    const relPath = filename.split(path.sep).join('/')
    if (isWatchIgnored(relPath)) return
    onChange(relPath)
    queueFileEvent(root, { kind: event === 'rename' ? 'rename' : 'change', relPath })
  })
  watchers.set(root, watcher)
}

function queueFileEvent(root: string, event: FileEvent | 'unknown'): void {
  const queued = pendingEvents.get(root)
  if (queued === undefined) setTimeout(() => void sendFileEvents(root), FILE_EVENT_BATCH_MS)
  if (event === 'unknown' || queued === 'unknown') pendingEvents.set(root, 'unknown')
  else if (queued) queued.push(event)
  else pendingEvents.set(root, [event])
}

/** Tells the renderer what a batch of events changed, after marking those caches stale. */
async function sendFileEvents(root: string): Promise<void> {
  const events = pendingEvents.get(root)
  pendingEvents.delete(root)
  if (!events || !watchers.has(root)) return
  try {
    const change = await (await workspace(root)).cache.noteEvents(events)
    if (change.structure || change.content || change.records.length > 0 || change.maps.length > 0) send(Channel.filesChanged, { root, ...change })
    if (events !== 'unknown') await tellLanguageServers(root, events)
  } catch (error) {
    console.error('manta: file events', error)
  }
}

/** Language servers that watch files learn of edits made outside the editor, such as by a Claude session. */
async function tellLanguageServers(root: string, events: FileEvent[]): Promise<void> {
  const host = languageServers
  if (!host) return
  const real = await realpath(root).catch(() => root)
  const changes = await Promise.all(
    [...new Map(events.map((e) => [e.relPath, e])).values()].map(async ({ kind, relPath }) => {
      const absolute = path.join(real, relPath)
      const type: FileChangeType = kind === 'change' ? 'changed' : (await stat(absolute).then(() => true, () => false)) ? 'created' : 'deleted'
      return { path: absolute, type }
    })
  )
  host.filesChanged(real, changes)
}

/** After a git operation from Manta: every panel of `root` reloads, without waiting out the status gap. */
async function gitChanged(root: string): Promise<void> {
  send(Channel.filesChanged, { root, ...(await workspace(root)).cache.invalidateAll() })
}

/** Commits and staging made in a terminal touch only `.git`, which isn't watched; they show when the window regains focus. */
async function refreshOnFocus(): Promise<void> {
  for (const root of watchers.keys()) {
    const ws = await workspace(root)
    ws.cache.status.invalidate()
    send(Channel.filesChanged, { root, structure: false, content: true, records: [], maps: [] })
  }
}

async function pickFolder(kind: ProjectKind): Promise<string | null> {
  const picked = await dialog.showOpenDialog({
    title: kind === 'docs' ? 'Choose your docs repository' : 'Add a code repository',
    properties: ['openDirectory', 'createDirectory']
  })
  const folder = picked.filePaths[0]
  if (picked.canceled || !folder) return null
  const git = new Git(folder)
  if (await git.isRepoRoot()) return folder
  const choice = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Initialize git repo', 'Cancel'],
    message: `${path.basename(folder)} is not the top-level folder of a git repository.`,
    detail: 'Manta keeps projects in git. Initialize a new repository here?'
  })
  if (choice.response !== 0) return null
  await git.init()
  return folder
}

async function afterGitOp(root: string, result: Promise<OpResult>): Promise<OpResult> {
  const settled = await result.catch(
    (error: unknown): OpResult => ({ ok: false, message: error instanceof Error ? error.message : String(error) })
  )
  await gitChanged(root)
  return settled
}

ipcMain.handle(Channel.listProjects, () => requireRegistry().list())
ipcMain.handle(Channel.addProject, async (_e, kind: unknown) => {
  if (kind !== 'docs' && kind !== 'code') throw new Error('kind must be docs or code')
  const folder = await pickFolder(kind)
  if (!folder) return null
  const previousDocs = kind === 'docs' ? requireRegistry().list().find((p) => p.kind === 'docs')?.root : undefined
  const added = await requireRegistry().add(folder, kind)
  if (previousDocs && previousDocs !== added.root) await closeRootProcesses(await realpath(previousDocs).catch(() => previousDocs))
  return added
})
ipcMain.handle(Channel.removeProject, async (_e, root: unknown) => {
  const projectRoot = str(root, 'root')
  const roots = await Promise.all(
    [projectRoot, ...(await requireRegistry().worktrees(projectRoot)).map((w) => w.path)].map((p) => realpath(p).catch(() => p))
  )
  for (const closing of new Set(roots)) await closeRootProcesses(closing)
  return requireRegistry().remove(projectRoot)
})
ipcMain.handle(Channel.listWorktrees, (_e, root: unknown) => requireRegistry().worktrees(str(root, 'root')))
ipcMain.handle(Channel.createWorktree, (_e, root: unknown, name: unknown) =>
  requireRegistry().createWorktree(str(root, 'root'), str(name, 'name'))
)
ipcMain.handle(Channel.removeWorktree, (_e, root: unknown, worktreePath: unknown) =>
  requireRegistry().removeWorktree(str(root, 'root'), str(worktreePath, 'worktreePath'), async (worktree) => {
    const real = await realpath(worktree.path).catch(() => worktree.path)
    const running = requireTerminals().runningIn(real).length
    const choice = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Remove worktree', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove the worktree ${path.basename(worktree.path)}?`,
      detail: `Deletes ${worktree.path}, including files git ignores (like node_modules or .env).${
        worktree.branch ? ` The branch ${worktree.branch} is kept, so its commits stay.` : ''
      }${running > 0 ? ` Its ${plural(running, 'running terminal')} will be closed.` : ''}`
    })
    if (choice.response !== 0) return false
    /** Terminals and language servers hold the folder open as their working directory; close them before git deletes it. */
    await closeRootProcesses(real)
    return true
  })
)
ipcMain.handle(Channel.listFiles, async (_e, root: unknown, scope: unknown) => {
  const ws = await workspace(root)
  return scope === 'all' ? ws.cache.files.read() : ws.listFiles('docs')
})
ipcMain.handle(Channel.changes, async (_e, root: unknown) => (await (await workspace(root)).cache.status.read()).changes)
ipcMain.handle(Channel.fileAtHead, async (_e, root: unknown, relPath: unknown) =>
  (await workspace(root)).fileAtHead(str(relPath, 'relPath'))
)
ipcMain.handle(Channel.fileAt, async (_e, root: unknown, ref: unknown, relPath: unknown) =>
  (await workspace(root)).fileAt(sha(ref), str(relPath, 'relPath'))
)
ipcMain.handle(Channel.branch, async (_e, root: unknown, base: unknown) => (await workspace(root)).branch(base === null ? null : str(base, 'base')))
ipcMain.handle(Channel.branches, async (_e, root: unknown) => (await workspace(root)).branches())
ipcMain.handle(Channel.commitFiles, async (_e, root: unknown, ref: unknown) => (await workspace(root)).commitFiles(sha(ref)))
ipcMain.handle(Channel.repoStatus, async (_e, root: unknown) => {
  const { branch, ahead, unpublished, stat } = await (await workspace(root)).cache.status.read()
  /** Only asked of a branch without an upstream, so a tracking branch costs no extra git run. */
  const publishable = unpublished && (await (await workspace(root)).hasOrigin())
  return { branch, ahead, unpublished: publishable, ...stat }
})
ipcMain.handle(Channel.searchContent, async (_e, root: unknown, query: unknown) =>
  (await workspace(root)).searchContent(str(query, 'query'))
)
ipcMain.handle(Channel.createFile, async (_e, root: unknown, relPath: unknown) =>
  (await workspace(root)).createFile(str(relPath, 'relPath'))
)
ipcMain.handle(Channel.createFolder, async (_e, root: unknown, relPath: unknown) =>
  (await workspace(root)).createFolder(str(relPath, 'relPath'))
)
ipcMain.handle(Channel.deletePath, async (_e, root: unknown, relPath: unknown) =>
  (await workspace(root)).deletePath(
    str(relPath, 'relPath'),
    async ({ relPath: target, folder, files, docsWithThreads }) => {
      const notes = [
        folder ? `Moves the folder and ${plural(files, 'file')} in it to the Trash.` : 'Moves the file to the Trash.',
        ...(docsWithThreads.length > 0 ? [`Threads on ${docsWithThreads.join(', ')} won't show until the file is restored.`] : [])
      ]
      const choice = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Move to Trash', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `Delete ${path.basename(target)}?`,
        detail: notes.join(' ')
      })
      return choice.response === 0
    },
    (absolute) => shell.trashItem(absolute)
  )
)
ipcMain.handle(Channel.openDoc, async (_e, root: unknown, relPath: unknown) =>
  (await workspace(root)).openDoc(str(relPath, 'relPath'))
)
ipcMain.handle(Channel.createDoc, async (_e, root: unknown, relPath: unknown) =>
  (await workspace(root)).createDoc(str(relPath, 'relPath'))
)
/** Editor updates applied in the order they arrived, so a save that follows them includes them all. */
let editorUpdates: Promise<void> = Promise.resolve()
ipcMain.on(Channel.pushUpdate, (_e, root: unknown, relPath: unknown, update: unknown) => {
  if (typeof root !== 'string' || typeof relPath !== 'string' || !(update instanceof Uint8Array)) return
  editorUpdates = editorUpdates
    .then(async () => (await workspace(root)).applyEditorUpdate(relPath, update))
    .catch((error: unknown) => console.error('manta: push update', error))
})
ipcMain.handle(Channel.saveFile, async (_e, root: unknown, relPath: unknown) => {
  await editorUpdates
  await (await workspace(root)).saveNow(str(relPath, 'relPath'))
})
ipcMain.handle(Channel.formatFile, async (_e, root: unknown, relPath: unknown): Promise<FormatResult> => {
  await editorUpdates
  const ws = await workspace(root)
  const rel = str(relPath, 'relPath')
  const file = path.join(ws.repoRoot, rel)
  if (!file.startsWith(ws.repoRoot + path.sep)) throw new Error('Path is outside the repo')
  const env = await terminalBaseEnv()
  const pluginRuff = plugins?.installedCommand({ pkg: 'ruff', command: 'ruff' }) ?? null
  const formatter = await resolveFormatter({ root: ws.repoRoot, file, toolRoots: [await ws.mainCheckout()], node: process.execPath, env, pluginRuff })
  if (!formatter) return { formatter: null, ok: true, message: '' }
  const before = await ws.docText(rel)
  if (before === null) return { formatter: formatter.name, ok: false, message: `${rel} isn't open` }
  try {
    const after = await runFormatter({ formatter, text: before, cwd: path.dirname(file) })
    const applied = await ws.applyFormatted(rel, { before, after })
    if (applied === 'changed') return { formatter: formatter.name, ok: false, message: `Not formatted: ${path.basename(rel)} changed while ${formatter.name} ran` }
    return { formatter: formatter.name, ok: true, message: applied === 'applied' ? `Formatted with ${formatter.name}` : `Saved; already formatted (${formatter.name})` }
  } catch (error) {
    return { formatter: formatter.name, ok: false, message: error instanceof Error ? error.message : String(error) }
  }
})
ipcMain.handle(Channel.revealDoc, async (_e, root: unknown, relPath: unknown) => {
  const repoRoot = (await workspace(root)).repoRoot
  const absolute = path.join(repoRoot, str(relPath, 'relPath'))
  if (!absolute.startsWith(repoRoot + path.sep)) throw new Error('Path is outside the repo')
  shell.showItemInFolder(absolute)
})
ipcMain.handle(Channel.commit, async (_e, root: unknown, message: unknown, scope: unknown) =>
  afterGitOp(str(root, 'root'), (await workspace(root)).commit(str(message, 'message'), commitScope(scope)))
)
ipcMain.handle(Channel.stage, async (_e, root: unknown, paths: unknown) =>
  afterGitOp(str(root, 'root'), (await workspace(root)).stage(strArray(paths, 'paths')))
)
ipcMain.handle(Channel.unstage, async (_e, root: unknown, paths: unknown) =>
  afterGitOp(str(root, 'root'), (await workspace(root)).unstage(strArray(paths, 'paths')))
)
ipcMain.handle(Channel.discardChanges, async (_e, root: unknown, paths: unknown) => {
  const result = await (await workspace(root)).discardChanges(strArray(paths, 'paths'), async ({ paths: files, deleted, docsWithThreads }) => {
    const target = files.length === 1 ? path.basename(files[0] ?? '') : `${files.length} files`
    const notes = [
      'Your changes will be lost. This can’t be undone.',
      ...(deleted > 0 ? [`${deleted === 1 ? '1 untracked file' : `${deleted} untracked files`} will be deleted.`] : []),
      ...(docsWithThreads.length > 0 ? [`Threads on ${docsWithThreads.join(', ')} may show as detached if the text they're about goes away.`] : [])
    ]
    const choice = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Discard changes', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Discard changes to ${target}?`,
      detail: notes.join(' ')
    })
    return choice.response === 0
  })
  if (result) await gitChanged(str(root, 'root'))
  return result
})
ipcMain.handle(Channel.push, async (_e, root: unknown) => afterGitOp(str(root, 'root'), (await workspace(root)).push()))
ipcMain.handle(Channel.pull, async (_e, root: unknown) => afterGitOp(str(root, 'root'), (await workspace(root)).pull()))
ipcMain.handle(Channel.createThread, async (_e, root: unknown, relPath: unknown, offset: unknown, title: unknown) =>
  (await workspace(root)).threads.createAt(str(relPath, 'relPath'), int(offset, 'offset'), str(title, 'title'))
)
ipcMain.handle(Channel.listThreads, async (_e, root: unknown, relPath: unknown) =>
  (await workspace(root)).threads.list(str(relPath, 'relPath'))
)
ipcMain.handle(Channel.createSubthread, async (_e, root: unknown, relPath: unknown, parentId: unknown, title: unknown) =>
  (await workspace(root)).threads.createSubthread(str(relPath, 'relPath'), str(parentId, 'parentId'), str(title, 'title'))
)
ipcMain.handle(Channel.listSubthreads, async (_e, root: unknown, relPath: unknown, parentId: unknown) =>
  (await workspace(root)).threads.listSubthreads(str(relPath, 'relPath'), str(parentId, 'parentId'))
)
ipcMain.handle(Channel.getThread, async (_e, root: unknown, relPath: unknown, id: unknown) =>
  (await workspace(root)).threads.get(str(relPath, 'relPath'), str(id, 'id'))
)
ipcMain.handle(Channel.listTerminals, () => requireTerminals().list())
ipcMain.handle(Channel.claudeArgs, () => requireTerminals().claudeArgsText())
ipcMain.handle(Channel.setClaudeArgs, (_e, text: unknown) => {
  if (typeof text !== 'string') throw new Error('text must be a string')
  return requireTerminals().setClaudeArgs(text)
})
ipcMain.handle(Channel.createTerminal, async (_e, root: unknown, kind: unknown, cols: unknown, rows: unknown) => {
  await commandsFound()
  return requireTerminals().create(await requireRegistry().resolveRoot(str(root, 'root')), terminalKind(kind), {
    cols: cells(cols, 'cols'),
    rows: cells(rows, 'rows')
  })
})
ipcMain.handle(Channel.startImplementation, async (_e, request: unknown) => {
  const parsed = implementationRequest(request)
  await commandsFound()
  const started = await requireImplementations().start(parsed)
  if (started.ok) await gitChanged(parsed.project)
  return started
})
ipcMain.handle(Channel.openImplementationSession, async (_e, docsRoot: unknown, doc: unknown, id: unknown, cols: unknown, rows: unknown) => {
  await commandsFound()
  return requireImplementations().openSession(str(docsRoot, 'docsRoot'), str(doc, 'doc'), str(id, 'id'), {
    cols: cells(cols, 'cols'),
    rows: cells(rows, 'rows')
  })
})
ipcMain.handle(Channel.checkImplementation, (_e, docsRoot: unknown, doc: unknown, id: unknown) =>
  requireImplementations().check(str(docsRoot, 'docsRoot'), str(doc, 'doc'), str(id, 'id'))
)
ipcMain.handle(Channel.listMaps, async (_e, docsRoot: unknown) => (await docsMaps(docsRoot)).list())
ipcMain.handle(Channel.getMap, async (_e, docsRoot: unknown, id: unknown) => (await docsMaps(docsRoot)).get(mapId(id)))
ipcMain.handle(Channel.markMapSeen, async (_e, docsRoot: unknown, id: unknown) => (await docsMaps(docsRoot)).markSeen(mapId(id)))
ipcMain.handle(Channel.visitMap, async (_e, docsRoot: unknown, id: unknown) => (await docsMaps(docsRoot)).visit(mapId(id)))
ipcMain.handle(Channel.createMap, async (_e, docsRoot: unknown, input: unknown) => (await docsMaps(docsRoot)).create(newMapInput(input)))
ipcMain.handle(Channel.updateMap, async (_e, docsRoot: unknown, id: unknown, settings: unknown) => {
  const result = await (await docsMaps(docsRoot)).update(mapId(id), mapSettings(settings))
  if (!result.ok) throw new Error(result.message)
})
ipcMain.handle(Channel.removeMap, async (_e, docsRoot: unknown, id: unknown) =>
  (await docsMaps(docsRoot)).remove(mapId(id), async (map) => {
    const choice = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Remove map', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Remove the context map ${map.title}?`,
      detail: 'Deletes the map, its tracker, journals and Ask the map conversation. Its docs, worktrees and branches are not touched.'
    })
    return choice.response === 0
  })
)
ipcMain.handle(Channel.editMapTracker, async (_e, docsRoot: unknown, id: unknown, edit: unknown) =>
  mapLaunches ? mapLaunches.editTracker(str(docsRoot, 'docsRoot'), mapId(id), trackerEdit(edit)) : (await docsMaps(docsRoot)).editTracker(mapId(id), trackerEdit(edit))
)
ipcMain.handle(Channel.removeFromTracker, async (_e, docsRoot: unknown, id: unknown, target: unknown) =>
  (await docsMaps(docsRoot)).removeFromTracker(mapId(id), trackerTarget(target), async (question) => {
    const choice = await dialog.showMessageBox({ type: 'warning', buttons: ['Delete', 'Cancel'], defaultId: 1, cancelId: 1, message: question })
    return choice.response === 0
  })
)
ipcMain.handle(Channel.editMapDocs, async (_e, docsRoot: unknown, id: unknown, edit: unknown) => (await docsMaps(docsRoot)).editDocs(mapId(id), docsEdit(edit)))
ipcMain.handle(Channel.mapDocText, async (_e, docsRoot: unknown, relPath: unknown) => (await docsMaps(docsRoot)).docText(str(relPath, 'relPath')))
ipcMain.handle(Channel.createMapDoc, async (_e, docsRoot: unknown, id: unknown, doc: unknown, title: unknown) =>
  (await docsMaps(docsRoot)).createDoc(mapId(id), mapDoc(doc), typeof title === 'string' ? title : undefined)
)
ipcMain.handle(Channel.resolveMapSuggestion, async (_e, docsRoot: unknown, id: unknown, suggestion: unknown, accept: unknown, pick: unknown) => {
  if (typeof accept !== 'boolean') throw new Error('accept must be a boolean')
  return (await docsMaps(docsRoot)).resolveSuggestion(mapId(id), str(suggestion, 'suggestion'), accept, picks(pick))
})
ipcMain.handle(Channel.mapJournal, async (_e, docsRoot: unknown, id: unknown, launch: unknown) => (await docsMaps(docsRoot)).journal(mapId(id), str(launch, 'launch')))
ipcMain.handle(Channel.launchMapWork, async (_e, request: unknown) => {
  const parsed = launchRequest(request)
  await commandsFound()
  const started = await requireMapLaunches().launch(parsed)
  if (started.ok) await gitChanged(started.launch.project)
  return started
})
ipcMain.handle(Channel.previewMapBrief, async (_e, request: unknown) => requireMapLaunches().previewBrief(briefRequest(request)))
ipcMain.handle(Channel.openMapLaunch, async (_e, docsRoot: unknown, id: unknown, launch: unknown, terminal: unknown, cols: unknown, rows: unknown) => {
  await commandsFound()
  return requireMapLaunches().openSession(str(docsRoot, 'docsRoot'), mapId(id), str(launch, 'launch'), terminal === null ? null : str(terminal, 'terminal'), {
    cols: cells(cols, 'cols'),
    rows: cells(rows, 'rows')
  })
})
ipcMain.handle(Channel.checkMap, async (_e, docsRoot: unknown, id: unknown) => {
  await commandsFound()
  await requireMapLaunches().check(str(docsRoot, 'docsRoot'), mapId(id))
})
ipcMain.handle(Channel.openMapPullRequest, async (_e, docsRoot: unknown, id: unknown, launch: unknown) => {
  await commandsFound()
  return requireMapLaunches().openPullRequest(str(docsRoot, 'docsRoot'), mapId(id), str(launch, 'launch'))
})
ipcMain.handle(Channel.sendMapFeedback, async (_e, docsRoot: unknown, id: unknown, launch: unknown, kind: unknown, cols: unknown, rows: unknown) => {
  await commandsFound()
  return requireMapLaunches().sendFeedback(str(docsRoot, 'docsRoot'), mapId(id), str(launch, 'launch'), mapFeedback(kind), { cols: cells(cols, 'cols'), rows: cells(rows, 'rows') })
})
ipcMain.handle(Channel.requestMapChanges, async (_e, docsRoot: unknown, id: unknown, launch: unknown, text: unknown, cols: unknown, rows: unknown) => {
  await commandsFound()
  return requireMapLaunches().requestChanges(str(docsRoot, 'docsRoot'), mapId(id), str(launch, 'launch'), str(text, 'text'), { cols: cells(cols, 'cols'), rows: cells(rows, 'rows') })
})
ipcMain.handle(Channel.markMapTicketDone, async (_e, docsRoot: unknown, id: unknown, ticket: unknown, include: unknown) => {
  const root = str(docsRoot, 'docsRoot')
  return afterGitOp(root, requireMapLaunches().markDone(root, mapId(id), str(ticket, 'ticket'), threadIds(include)))
})
ipcMain.handle(Channel.coordinateMapBatch, async (_e, docsRoot: unknown, id: unknown, batch: unknown, cols: unknown, rows: unknown) => {
  await commandsFound()
  return requireMapLaunches().coordinate(str(docsRoot, 'docsRoot'), mapId(id), batchId(batch) ?? '', { cols: cells(cols, 'cols'), rows: cells(rows, 'rows') })
})
ipcMain.handle(Channel.declineMapBatch, async (_e, docsRoot: unknown, id: unknown, batch: unknown) =>
  requireMapLaunches().declineCoordinator(str(docsRoot, 'docsRoot'), mapId(id), batchId(batch) ?? '')
)
ipcMain.handle(Channel.sendMapMessage, async (_e, docsRoot: unknown, id: unknown, text: unknown) => {
  await commandsFound()
  return (await docsMaps(docsRoot)).send(mapId(id), str(text, 'text'))
})
ipcMain.handle(Channel.breakDownMap, async (_e, docsRoot: unknown, id: unknown, docs: unknown) => {
  await commandsFound()
  return (await docsMaps(docsRoot)).breakDown(mapId(id), Array.isArray(docs) && docs.length === 0 ? [] : strArray(docs, 'docs'))
})
ipcMain.handle(Channel.cancelMapTurn, async (_e, docsRoot: unknown, id: unknown) => (await docsMaps(docsRoot)).cancel(mapId(id)))
ipcMain.handle(Channel.answerMapPermission, async (_e, docsRoot: unknown, id: unknown, requestId: unknown, answer: unknown) =>
  (await docsMaps(docsRoot)).answerPermission(mapId(id), str(requestId, 'requestId'), decision(answer))
)
ipcMain.handle(Channel.reviewComments, async (_e, root: unknown) => (await workspace(root)).review.list())
ipcMain.handle(Channel.addReviewComment, async (_e, root: unknown, anchor: unknown, body: unknown) => {
  const added = await (await workspace(root)).review.add(reviewAnchor(anchor), str(body, 'body'))
  send(Channel.reviewCommentsChanged, root)
  return added
})
ipcMain.handle(Channel.editReviewComment, async (_e, root: unknown, id: unknown, body: unknown) => {
  await (await workspace(root)).review.edit(str(id, 'id'), str(body, 'body'))
  send(Channel.reviewCommentsChanged, root)
})
ipcMain.handle(Channel.removeReviewComments, async (_e, root: unknown, ids: unknown) => {
  await (await workspace(root)).review.remove(strArray(ids, 'ids'))
  send(Channel.reviewCommentsChanged, root)
})
ipcMain.handle(Channel.sendReviewComments, async (_e, root: unknown, ids: unknown, target: unknown) => {
  const ws = await workspace(root)
  const parsed = reviewTarget(target)
  if ('newSession' in parsed) await commandsFound()
  const result = await sendReview({ store: ws.review, terminals: requireTerminals(), root: ws.repoRoot, ids: strArray(ids, 'ids'), target: parsed, size: REVIEW_SESSION_SIZE })
  send(Channel.reviewCommentsChanged, root)
  return result
})
const ghRun = ghRunner({ gh: userGh, env: terminalBaseEnv })
const pullRequests = new PullRequests({ run: ghRun, ghInstalled: () => userGh() !== null })
const pullRequestReviews = new PullRequestReviews({ run: ghRun, pullRequests })

/**
 * The PR a review tab is for, as the PR tab last showed it, refused when the worktree has since left
 * its branch or the branch now has another PR: nothing then lands on the wrong pull request.
 */
async function reviewedPullRequest(root: string, git: Git, number: unknown): Promise<{ pr: PullRequestDetail } | { ok: false; message: string }> {
  const pr = pullRequests.cached(root)
  if (!pr) return { ok: false, message: 'Open the PR tab first' }
  const problem = await reviewTargetProblem(git, pr, int(number, 'pullRequest'))
  return problem ? { ok: false, message: problem } : { pr }
}

function reviewEvent(value: unknown): ReviewEvent {
  if (value !== 'COMMENT' && value !== 'APPROVE' && value !== 'REQUEST_CHANGES') throw new Error('event must be COMMENT, APPROVE or REQUEST_CHANGES')
  return value
}
let reviewSettingsStore: ReviewSettings | null = null
/** Made on first use: `MANTA_USER_DATA` has moved userData by then. */
const reviewSettings = (): ReviewSettings => (reviewSettingsStore ??= new ReviewSettings(path.join(app.getPath('userData'), 'review-settings.json')))

function draftInput(value: unknown): { title: string; body: string; base: string } {
  if (typeof value !== 'object' || value === null) throw new Error('input must be an object')
  const title = 'title' in value ? value.title : undefined
  const body = 'body' in value ? value.body : undefined
  const base = 'base' in value ? value.base : undefined
  if (typeof title !== 'string' || typeof body !== 'string' || typeof base !== 'string') throw new Error('input.title, input.body and input.base must be strings')
  if (base.trim() && !isSafeRef(base.trim())) throw new Error(`Invalid base ${base}`)
  return { title, body, base }
}

ipcMain.handle(Channel.pullRequest, async (_e, root: unknown, force: unknown) => {
  const ws = await workspace(root)
  await commandsFound()
  return pullRequests.status(ws.repoRoot, ws.git, { force: force === true })
})
ipcMain.handle(Channel.pullRequestSent, async (_e, root: unknown) => (await workspace(root)).review.pullRequestSent())
ipcMain.handle(Channel.sendPullRequestComments, async (_e, root: unknown, ids: unknown, target: unknown) => {
  const ws = await workspace(root)
  const parsed = reviewTarget(target)
  if ('newSession' in parsed) await commandsFound()
  const { text } = await reviewSettings().template()
  const result = await pullRequests.sendComments({
    store: ws.review,
    terminals: requireTerminals(),
    root: ws.repoRoot,
    ids: strArray(ids, 'ids'),
    template: text,
    target: parsed,
    size: REVIEW_SESSION_SIZE
  })
  send(Channel.reviewCommentsChanged, root)
  return result
})
ipcMain.handle(Channel.prTemplate, () => reviewSettings().template())
ipcMain.handle(Channel.setPrTemplate, (_e, text: unknown) => reviewSettings().setTemplate(str(text, 'text')))
ipcMain.handle(Channel.draftPullRequestDefaults, async (_e, root: unknown, chosenBase: unknown) => {
  const base = chosenBase === null ? null : str(chosenBase, 'chosenBase')
  if (base !== null && !isSafeRef(base)) throw new Error(`Invalid base ${base}`)
  return pullRequests.draftDefaults((await workspace(root)).git, base)
})
ipcMain.handle(Channel.createDraftPullRequest, async (_e, root: unknown, input: unknown) => {
  const ws = await workspace(root)
  await commandsFound()
  return pullRequests.createDraft(ws.repoRoot, ws.git, draftInput(input))
})
ipcMain.handle(Channel.openPullRequestReview, async (_e, root: unknown, number: unknown) => {
  const ws = await workspace(root)
  const target = await reviewedPullRequest(ws.repoRoot, ws.git, number)
  return 'pr' in target ? pullRequestReviews.open(ws.git, ws.review, target.pr) : target
})
ipcMain.handle(Channel.pullRequestCommentable, async (_e, root: unknown, base: unknown, head: unknown, relPath: unknown) =>
  pullRequestReviews.commentable((await workspace(root)).git, sha(base), sha(head), str(relPath, 'relPath'))
)
ipcMain.handle(Channel.setPullRequestFileViewed, async (_e, root: unknown, pr: unknown, relPath: unknown, fingerprint: unknown) => {
  const ws = await workspace(root)
  const print = fingerprint === null ? null : str(fingerprint, 'fingerprint')
  const target = await reviewedPullRequest(ws.repoRoot, ws.git, pr)
  if (!('pr' in target)) return target
  return pullRequestReviews.setViewed(ws.repoRoot, ws.review, target.pr, str(relPath, 'relPath'), print)
})
ipcMain.handle(Channel.postPullRequestComment, async (_e, root: unknown, number: unknown, head: unknown, anchor: unknown, body: unknown) => {
  const ws = await workspace(root)
  const target = await reviewedPullRequest(ws.repoRoot, ws.git, number)
  if (!('pr' in target)) return target
  const result = await pullRequestReviews.postSingle(ws.repoRoot, target.pr, sha(head), reviewAnchor(anchor), str(body, 'body'))
  if (result.ok) send(Channel.pullRequestChanged, root)
  return result
})
ipcMain.handle(Channel.submitPullRequestReview, async (_e, root: unknown, number: unknown, base: unknown, head: unknown, input: unknown) => {
  const ws = await workspace(root)
  const target = await reviewedPullRequest(ws.repoRoot, ws.git, number)
  if (!('pr' in target)) return target
  if (typeof input !== 'object' || input === null) throw new Error('input must be an object')
  const event = reviewEvent('event' in input ? input.event : undefined)
  const body = 'body' in input && typeof input.body === 'string' ? input.body : ''
  const result = await pullRequestReviews.submit(ws.repoRoot, ws.git, ws.review, target.pr, { base: sha(base), head: sha(head) }, { event, body })
  send(Channel.reviewCommentsChanged, root)
  if (result.ok) send(Channel.pullRequestChanged, root)
  return result
})
ipcMain.handle(Channel.sendReviewDraft, async (_e, root: unknown, anchor: unknown, body: unknown, target: unknown) => {
  const ws = await workspace(root)
  const parsed = reviewTarget(target)
  if ('newSession' in parsed) await commandsFound()
  return sendReviewDraft({ terminals: requireTerminals(), root: ws.repoRoot, anchor: reviewAnchor(anchor), body: str(body, 'body'), target: parsed, size: REVIEW_SESSION_SIZE })
})
ipcMain.handle(Channel.restartTerminal, async (_e, id: unknown, cols: unknown, rows: unknown) => {
  await commandsFound()
  return requireTerminals().restart(str(id, 'id'), { cols: cells(cols, 'cols'), rows: cells(rows, 'rows') })
})
ipcMain.handle(Channel.renameTerminal, (_e, id: unknown, title: unknown) => requireTerminals().rename(str(id, 'id'), str(title, 'title')))
ipcMain.handle(Channel.closeTerminal, async (_e, id: unknown) => {
  const terminalId = str(id, 'id')
  const info = requireTerminals()
    .list()
    .find((t) => t.id === terminalId)
  if (!info) return true
  if (info.kind === 'claude' && (info.state === 'working' || info.state === 'waiting')) {
    const choice = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Close session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Close ${info.title}?`,
      detail:
        info.state === 'working'
          ? 'Claude Code is in the middle of a turn; closing stops it.'
          : 'Claude Code is waiting for your answer; closing stops the session.'
    })
    if (choice.response !== 0) return false
  }
  await requireTerminals().close(terminalId)
  return true
})
ipcMain.handle(Channel.lspOpen, async (_e, root: unknown, languageId: unknown, force: unknown, owner: unknown) =>
  requireLanguageServers().open({
    root: await requireRegistry().resolveRoot(str(root, 'root')),
    languageId: str(languageId, 'languageId'),
    owner: str(owner, 'owner'),
    force: force === true
  })
)
ipcMain.on(Channel.lspSend, (_e, session: unknown, message: unknown) => {
  if (typeof session === 'string' && typeof message === 'string') languageServers?.send(session, message)
})
ipcMain.handle(Channel.pluginEntries, (_e, refresh: unknown) => requirePlugins().entries({ refresh: refresh === true }))
ipcMain.handle(Channel.installPlugin, (_e, name: unknown) => {
  const pkg = str(name, 'name')
  return requirePlugins().install({ name: pkg, onProgress: (line) => send(Channel.pluginProgress, pkg, line) })
})
/** A removed or switched-off plugin's running servers stop; open editors drop them when they reattach. */
ipcMain.handle(Channel.removePlugin, async (_e, name: unknown) => {
  const pkg = str(name, 'name')
  const result = await requirePlugins().remove(pkg)
  if (result.ok) await languageServers?.stopServers([...RECIPES.filter((r) => r.package === pkg).map((r) => r.id), `custom:${pkg}`])
  return result
})
ipcMain.handle(Channel.setPluginServerEnabled, async (_e, server: unknown, enabled: unknown) => {
  const id = str(server, 'server')
  await requirePlugins().setEnabled({ server: id, enabled: enabled === true })
  if (enabled !== true) await languageServers?.stopServers([id])
})
ipcMain.handle(Channel.addCustomServer, (_e, input: unknown) => requirePlugins().addCustom(customServerInput(input)))
ipcMain.handle(Channel.searchThemes, (_e, query: unknown) => searchThemes({ query: typeof query === 'string' ? query : '' }))
ipcMain.handle(Channel.themeVariants, (_e, id: unknown) => themeVariants({ id: str(id, 'id') }))
ipcMain.handle(Channel.setEditorTheme, (_e, theme: unknown) => requirePlugins().setTheme(theme === null ? null : parseEditorTheme(theme)))
ipcMain.handle(Channel.editorTheme, () => parseEditorTheme(requirePlugins().theme))
ipcMain.handle(Channel.lspStatuses, () => languageServers?.list() ?? [])
/** Read-only files for go to definition: anything inside the root, or TypeScript's own library files. */
ipcMain.handle(Channel.readOnlyFile, async (_e, root: unknown, absolutePath: unknown) => {
  const allowed = [await requireRegistry().resolveRoot(str(root, 'root')), await realpath(path.dirname(BUNDLED_TYPESCRIPT)).catch(() => null)]
  const file = await realpath(str(absolutePath, 'absolutePath')).catch(() => null)
  if (!file || !allowed.some((dir) => dir && file.startsWith(`${dir}/`))) return null
  if ((await stat(file)).size > READ_ONLY_MAX_BYTES) return null
  return readFile(file, 'utf8')
})
ipcMain.handle(Channel.terminalSnapshot, (_e, id: unknown) => requireTerminals().snapshot(str(id, 'id')))
ipcMain.on(Channel.writeTerminal, (_e, id: unknown, data: unknown) => {
  if (typeof id === 'string' && typeof data === 'string') terminals?.write(id, data)
})
ipcMain.on(Channel.resizeTerminal, (_e, id: unknown, cols: unknown, rows: unknown) => {
  try {
    terminals?.resize(str(id, 'id'), { cols: cells(cols, 'cols'), rows: cells(rows, 'rows') })
  } catch (error) {
    console.error('manta: resize terminal', error)
  }
})
ipcMain.handle(Channel.claudeStatus, async () => {
  // Re-resolve on every check, so installing Claude Code while Manta runs is picked up.
  await findCommands()
  return claudeCodeStatus(userClaude())
})
ipcMain.handle(Channel.claudeSignIn, async () => {
  await commandsFound()
  const executable = userClaude()
  if (!executable) throw new Error('Claude Code is not installed: install it, then check again')
  await new Promise<void>((resolve) => {
    // Opens the browser sign-in flow and exits once it completes (or is abandoned).
    execFile(executable, ['auth', 'login'], { timeout: 5 * 60_000 }, () => resolve())
  })
  return claudeCodeStatus(executable)
})
ipcMain.handle(Channel.setThreadStatus, async (_e, root: unknown, relPath: unknown, id: unknown, next: unknown) =>
  (await workspace(root)).threads.setStatus(str(relPath, 'relPath'), str(id, 'id'), status(next))
)
ipcMain.handle(Channel.threadProposal, async (_e, root: unknown, relPath: unknown, id: unknown) =>
  (await workspace(root)).threads.proposal(str(relPath, 'relPath'), str(id, 'id'))
)
ipcMain.handle(Channel.threadTranscript, async (_e, root: unknown, id: unknown) =>
  (await workspace(root)).threads.transcript(str(id, 'id'))
)
ipcMain.handle(Channel.approveThread, async (_e, root: unknown, relPath: unknown, id: unknown) =>
  afterGitOp(str(root, 'root'), (await workspace(root)).threads.approve(str(relPath, 'relPath'), str(id, 'id')))
)
ipcMain.handle(Channel.threadLanded, async (_e, root: unknown, relPath: unknown, id: unknown) =>
  (await workspace(root)).threads.landed(str(relPath, 'relPath'), str(id, 'id'))
)
ipcMain.handle(Channel.dismissThreadChanges, async (_e, root: unknown, relPath: unknown, id: unknown) =>
  (await workspace(root)).threads.dismissLanded(str(relPath, 'relPath'), str(id, 'id'))
)
ipcMain.handle(Channel.sendThreadMessage, async (_e, root: unknown, relPath: unknown, id: unknown, text: unknown) => {
  await commandsFound()
  return (await workspace(root)).threads.send(str(relPath, 'relPath'), str(id, 'id'), str(text, 'text'))
})
ipcMain.handle(Channel.cancelThreadTurn, async (_e, root: unknown, id: unknown) =>
  (await workspace(root)).threads.cancel(str(id, 'id'))
)
ipcMain.handle(Channel.answerThreadPermission, async (_e, root: unknown, threadId: unknown, requestId: unknown, answer: unknown) => {
  return (await workspace(root)).threads.answerPermission(str(threadId, 'threadId'), str(requestId, 'requestId'), decision(answer))
})

void app.whenReady().then(async () => {
  void commandsFound()
  Menu.setApplicationMenu(appMenu())
  registry = await ProjectRegistry.load({
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    worktreesDir: path.join(app.getPath('userData'), 'worktrees'),
    threadsDir: path.join(app.getPath('userData'), 'threads'),
    mapsDir: path.join(app.getPath('userData'), 'maps'),
    agent: threadAgent(),
    onThreadEvent: (root, relPath, id, event) => send(Channel.threadEvent, root, relPath, id, event),
    onMapEvent: (root, id, event) => send(Channel.mapEvent, root, id, event),
    mapAgentMcp: (root, id) => mapLaunches?.askMcp(root, id) ?? null,
    onUpdate: (root, relPath, update) => send(Channel.remoteUpdate, root, relPath, update),
    onWorkspaceOpened: (root, ws) =>
      watchWorkspace(root, (relPath) =>
        ws.fileChanged(relPath).catch((error: unknown) => console.error('manta: watcher', error))
      ),
    onWorkspaceClosed: (root) => {
      watchers.get(root)?.close()
      watchers.delete(root)
    }
  })
  terminals = await TerminalManager.open({
    recordsFile: path.join(app.getPath('userData'), 'terminals.json'),
    settingsFile: path.join(app.getPath('userData'), 'terminal-settings.json'),
    hookSettingsFile: path.join(app.getPath('userData'), 'hooks', 'claude-settings.json'),
    claude: claudeLaunch,
    shell: userShell(),
    baseEnv: terminalBaseEnv,
    onData: (id, data, seq) => send(Channel.terminalData, id, data, seq),
    onChange: (info) => {
      send(Channel.terminalChanged, info)
      mapLaunches?.terminalChanged(info)
    },
    onRemoved: (id) => {
      send(Channel.terminalRemoved, id)
      mapLaunches?.terminalRemoved(id)
    },
    refreshBrief: (link, file) => requireImplementations().refreshBrief(link, file),
    refreshMapBrief: (map, file, terminal) => requireMapLaunches().refreshBrief(map, file, terminal),
    promptContext: async (record) => (mapLaunches ? mapLaunches.promptContext(record.id) : null),
    /** Implementation sessions get the doc tools; map sessions and the map's agents get the map tools too. */
    mcpTools: (session) => mapLaunches?.toolsFor(session) ?? ('terminal' in session && session.terminal.link ? implementationTools : [])
  })
  implementations = new Implementations({
    projects: registry,
    terminals,
    briefsDir: path.join(app.getPath('userData'), 'implementations'),
    pullRequests: ghPullRequests({ gh: userGh, env: terminalBaseEnv }),
    onProposal: (docsRoot, thread) => send(Channel.docProposed, docsRoot, thread)
  })
  const pluginManager = await PluginManager.open({
    dir: path.join(app.getPath('userData'), 'plugins'),
    env: terminalBaseEnv,
    builtIn: [typescriptServer({ bundledBinary: BUNDLED_TYPESCRIPT })],
    toolRoots
  })
  plugins = pluginManager
  languageServers = new LanguageServerHost({
    catalog: () => pluginManager.specs(),
    env: terminalBaseEnv,
    onMessage: (session, message) => send(Channel.lspMessage, session, message),
    onStatus: (status) => send(Channel.lspStatus, status)
  })
  mapLaunches = new MapLaunches({
    projects: registry,
    terminals,
    briefsDir: path.join(app.getPath('userData'), 'map-briefs'),
    agentsDir: path.join(app.getPath('userData'), 'map-agents'),
    agent: threadAgent(),
    pullRequests: ghPullRequests({ gh: userGh, env: terminalBaseEnv }),
    pullRequestDetail: ghPullRequestDetail(ghRun),
    pullRequestText: async (project, number) => {
      const viewed = await ghRun(project, ['pr', 'view', String(number), '--json', 'title,body', '--template', '{{.title}}\n\n{{.body}}'])
      return viewed.ok ? viewed.stdout : null
    },
    openPullRequest: async (worktree, input) => {
      const ws = await requireRegistry().workspace(worktree)
      const { base } = await pullRequests.draftDefaults(ws.git, null)
      const opened = await pullRequests.createDraft(ws.repoRoot, ws.git, { ...input, base })
      if (opened.ok) await gitChanged(ws.repoRoot)
      return opened
    },
    onProposal: (docsRoot, thread) => send(Channel.docProposed, docsRoot, thread),
    onMapChanged: (root, id) => send(Channel.filesChanged, { root, structure: false, content: false, records: [], maps: [id] })
  })
  /** Pull requests merge while the map is closed too; `gh` only, never an agent, and only for work not landed. */
  setInterval(() => {
    const launches = mapLaunches
    if (!launches) return
    void commandsFound()
      .then(async () => {
        for (const project of requireRegistry().list()) if (project.kind === 'docs') await launches.checkAll(project.root)
      })
      .catch((error: unknown) => console.error('manta: checking maps', error))
  }, MAP_CHECK_MS)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting || !registry) return
  // Flush pending debounced writes so the last keystrokes reach disk before exit.
  event.preventDefault()
  quitting = true
  for (const watcher of watchers.values()) watcher.close()
  mapLaunches?.close()
  void Promise.allSettled([registry.closeAll(), terminals?.shutdown(), languageServers?.shutdown()]).finally(() => app.quit())
})
