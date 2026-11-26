import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  BriefWorkspace,
  LaunchScope,
  MapBatch,
  MapBriefDoc,
  MapBriefPreview,
  MapBriefRequest,
  MapDocOutline,
  LaunchWrapUp,
  MapAuthor,
  MapFeedback,
  MapLaunch,
  MapLaunchRequest,
  MapLaunchStart,
  MapLink,
  MapProposer,
  MapTicket,
  OpResult,
  PermissionDecision,
  PlanChange,
  ProjectWorktree,
  PullRequestComment,
  PullRequestHealth,
  PullRequestInfo,
  SessionProgress,
  TerminalInfo,
  TerminalState,
  ThreadInfo,
  TicketStatus,
  TrackerEdit
} from '../shared/ipc'
import type { ThreadAgent } from './agent/threadAgent'
import { proposeDocChangeTool, reviseDocChangeTool, withdrawDocChangeTool } from './implementations'
import { boardRows, boardText, signalOf, type BoardRow } from '../shared/mapBoard'
import { formatPullRequestMessage } from './review/pullRequestMessage'
import { briefReadiness, coordinatorBrief, LAUNCH_TRAILER, landingPrompt, launchBrief, sweepPrompt, sweepSystemPrompt, ticketBriefDocs } from './maps/mapBrief'
import {
  cleanDocPath,
  decisionNumber,
  findTicket,
  launchTickets,
  milestoneInfos,
  newLaunchId,
  notes,
  parseCheckRuns,
  parseCriteria,
  parseNeed,
  decisionInput,
  decisionOptions,
  parseDocRef,
  parsePlanChange,
  parseProposedTicket,
  PROGRESS_PHASES,
  pullRequestHealth,
  scopeMilestone,
  scopeTicketIds,
  scopeTitle,
  type MapFile,
  type Tracker
} from './maps/mapModel'
import { mapToolDefinitions, type MapRole } from './maps/mapTools'
import { Git } from './repo/git'
import type { PullRequestDetailLookup, PullRequestLookup } from './repo/github'
import { branchLanded } from './repo/landing'
import { worktreeSlug, type ProjectRegistry } from './repo/projects'
import { parseClaudeArgs, permissionSummary } from './terminal/claudeArgs'
import type { McpSession, McpTool } from './terminal/mcpEndpoint'
import type { TerminalManager, TerminalSize } from './terminal/terminals'
import type { Workspace } from './workspace'
import type { SuggestionInput } from './workspaceMaps'
import type { ProposalAuthor } from './workspaceThreads'

export interface MapLaunchesOptions {
  projects: ProjectRegistry
  terminals: TerminalManager
  /** Where each session's brief is written. */
  briefsDir: string
  /** Where the sweep's working folders go. */
  agentsDir: string
  /** The sweep's agent; without one there is no sweep. */
  agent?: ThreadAgent
  /** Finds a branch's pull request; without it, only git decides whether work has landed. */
  pullRequests?: PullRequestLookup
  /** A branch's pull request in full (checks, reviews, threads), for its health and for sending feedback. */
  pullRequestDetail?: PullRequestDetailLookup
  /** A pull request's title and body, for the sweep and the landing pass. */
  pullRequestText?: (project: string, number: number) => Promise<string | null>
  /** Pushes the worktree's branch and opens a draft pull request. */
  openPullRequest?: (worktree: string, input: { title: string; body: string }) => Promise<OpResult>
  /** A map agent proposed a doc change, now a thread waiting for review. */
  onProposal?: (docsRoot: string, thread: ThreadInfo) => void
  /** Something in the map's machine-local state changed (launches, journals, suggestions), which the file watcher doesn't see. */
  onMapChanged?: (docsRoot: string, map: string) => void
  /** How long a coordinator's wake-up waits for more changes to gather into one prompt. */
  coordinatorDelayMs?: number
}

/** Long enough that a burst of reports (a session finishing, its PR opening) is one prompt to the coordinator. */
const COORDINATOR_DELAY_MS = 20_000

/** The smallest current Claude model, as Claude Code names it, for the sweep. */
export const SWEEP_MODEL = 'haiku'

type ToolResult = Awaited<ReturnType<McpTool['call']>>

/** Who is calling a map tool, resolved from its terminal or agent id. */
interface Caller {
  docsRoot: string
  docs: Workspace
  map: string
  role: MapRole
  launch: MapLaunch | null
  /** The session's terminal; null for Manta's own agents. */
  terminal: string | null
  /** The batch a coordinator watches. */
  batch: string | null
}

/** A running coordinator: what it was last told about each board row, and its pending wake-up. */
interface Watch {
  docsRoot: string
  map: string
  batch: string
  told: Map<string, string>
  timer: NodeJS.Timeout | null
  /** Changes are waiting for it to come back to its prompt. */
  pending: boolean
}

/** What an agent may report; `done` only once its work is merged (on its own branch) and verified with the user. */
type Reported = 'in-progress' | 'blocked' | 'done'
const REPORTABLE: readonly Reported[] = ['in-progress', 'blocked', 'done']

/** What a running session last saw of its scope, so the next prompt can say what moved since. */
interface Seen {
  tickets: Map<string, string>
  docs: Map<string, string>
  landed: Set<string>
}

/** Above this the hook answer is dropped; the hook command itself gives up at 1.5 s. */
const PROMPT_CONTEXT_MS = 1000

const REVIEW_TEMPLATE =
  'Review feedback on your pull request. Address each comment (or say in your reply why not), run the checks, commit and push, then report the tickets and wrap up again.'

/**
 * Work launched from a context map's tracker, end to end: the worktree and branch, the tracked Claude
 * session with its scoped brief, statuses that follow the work (launch, reports, pull requests,
 * landing), the map tools sessions call, and the sweep that wraps up a session that didn't.
 * Composes the project registry, the docs workspace's maps and the terminal manager.
 */
export class MapLaunches {
  /** Agents Manta runs itself that may call map tools, by agent id. */
  private readonly agents = new Map<string, { docsRoot: string; map: string; role: MapRole; launch: string | null }>()
  /** Map sessions seen running, so a closed one can still be traced to its launch. */
  private readonly links = new Map<string, MapLink>()
  private readonly sweeping = new Set<string>()
  /** By terminal id. */
  private readonly seen = new Map<string, Seen>()
  /** Coordinators by terminal id. */
  private readonly watches = new Map<string, Watch>()
  /** A starting session's note by its brief file, until the session is saved with it; the brief is written before that. */
  private readonly pendingNotes = new Map<string, string>()
  /** Set when Manta quits: sessions it kills on the way out didn't end, so they get no sweep. */
  private closed = false

  constructor(private readonly options: MapLaunchesOptions) {}

  /** Called before the terminals shut down. */
  close(): void {
    this.closed = true
    for (const watch of this.watches.values()) if (watch.timer) clearTimeout(watch.timer)
    this.watches.clear()
  }

  // -------------------------------------------------------------------------------------------
  // Launching

  /**
   * Starts work on a ticket, a group or a milestone: creates a worktree and `manta/<slug>` branch (or
   * reuses the milestone's, or the ticket's own when it's still there), then a session with the
   * scope's brief. A worktree made for it is removed again if the session fails to start.
   */
  async launch(request: MapLaunchRequest): Promise<MapLaunchStart> {
    const { projects, terminals } = this.options
    const { docsRoot, docs } = await this.docsWorkspace(request.docsRoot)
    const map = await docs.maps.map(request.map)
    const tracker = await docs.maps.tracker(map.id)
    if (!terminals.claudeAvailable()) return { ok: false, message: 'Claude Code is not installed: install it, then try again' }

    let scope: LaunchScope = 'tickets' in request.scope && request.scope.tickets.length === 1 && request.scope.tickets[0] ? { ticket: request.scope.tickets[0] } : request.scope
    if ('milestone' in scope) {
      const id = scope.milestone
      if (!tracker.milestones.some((m) => m.id === id)) return { ok: false, message: 'That milestone is gone' }
    } else if (launchTickets(tracker, scope).length !== scopeTicketIds(scope).length) {
      return { ok: false, message: 'A ticket in it is gone' }
    }
    /** Per milestone, a ticket's session works in the milestone's worktree, focused on the ticket. */
    let focus: string | null = null
    if ('ticket' in scope && request.mode === 'milestone') {
      const milestone = findTicket(tracker, scope.ticket)?.milestone
      if (milestone) {
        focus = scope.ticket
        scope = { milestone: milestone.id }
      }
    }

    const existing = await this.reusable(await docs.maps.launches(map.id), scope)
    const project = existing ? projects.list().find((p) => p.kind === 'code' && p.root === existing.project) : await this.pickProject(map, tracker, request, focus)
    if (!project) return { ok: false, message: existing ? 'The launch’s code project is no longer in Manta' : 'Add a code project to Manta first' }
    if ('pick' in project) return { ok: false, message: 'Pick the code project to work in', projects: project.pick }

    let launch: MapLaunch
    let undo = async (): Promise<void> => undefined
    if (existing) {
      launch = existing
    } else {
      let worktree: ProjectWorktree
      try {
        worktree = await this.createWorktree(project.root, scopeTitle(tracker, scope))
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      const id = newLaunchId()
      const created = worktree
      /** No confirm: the worktree was made a moment ago by this launch and holds nothing of the user's. */
      undo = async () => {
        await docs.maps.dropLaunch(map.id, id)
        await projects.removeWorktree(project.root, created.path, async () => true).catch(() => null)
      }
      const fresh: MapLaunch = {
        id,
        scope,
        project: project.root,
        worktree: worktree.path,
        branch: worktree.branch ?? '',
        base: await new Git(await realpath(worktree.path)).resolve('HEAD'),
        sessions: [],
        pr: null,
        landed: false,
        createdAt: new Date().toISOString(),
        wrappedUpAt: null,
        sweptAt: null,
        readyAt: null,
        wrapUp: null,
        health: null,
        landingSweptAt: null,
        batch: request.batch ?? null
      }
      const batch = request.batch
      if (batch) await docs.maps.saveBatch(map.id, batch, (current) => current ?? { id: batch, createdAt: new Date().toISOString(), coordinator: null, declined: false })
      launch = await docs.maps.saveLaunch(map.id, id, () => fresh)
    }

    const session = randomUUID()
    const note = request.note?.trim() ?? ''
    const briefFile = this.briefFile(launch.id, session)
    if (note) this.pendingNotes.set(briefFile, note)
    const title = focus ? (findTicket(tracker, focus)?.ticket.title ?? map.title) : scopeTitle(tracker, scope)
    const others = projects
      .list()
      .filter((p) => p.kind === 'code' && map.projects.includes(p.name) && p.root !== launch.project)
      .map((p) => p.root)
    let terminal: TerminalInfo
    try {
      terminal = await terminals.create(await realpath(launch.worktree), 'claude', { cols: request.cols, rows: request.rows }, {
        prompt: `Work on “${title}”, as your brief describes.`,
        title,
        map: { docsRoot, map: map.id, launch: launch.id, ticket: focus },
        brief: briefFile,
        addDirs: [docsRoot, ...others],
        session
      })
    } catch (error) {
      this.pendingNotes.delete(briefFile)
      await undo()
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    this.links.set(terminal.id, { docsRoot, map: map.id, launch: launch.id, ticket: focus })
    launch = await docs.maps.saveLaunch(map.id, launch.id, (current) => ({
      ...(current ?? launch),
      sessions: [...(current ?? launch).sessions, { terminal: terminal.id, session, ticket: focus, startedAt: new Date().toISOString(), progress: null, ...(note ? { note } : {}) }]
    }))
    this.pendingNotes.delete(briefFile)

    /** New work on a ticket in review or done reopens it: it's a follow-up, often its own pull request. */
    const started = focus ? [focus] : 'milestone' in scope ? [] : scopeTicketIds(scope)
    await docs.maps.setStatuses(map.id, started, 'in-progress')
    const milestone = scopeMilestone(tracker, scope)
    if (milestone && started.length === 0) await docs.maps.clearManual(map.id, milestone.id)
    this.changed(docsRoot, map.id)
    return { ok: true, message: `Started “${title}” in ${path.basename(launch.worktree)}`, launch, terminal }
  }

  /** A session of the launch: its terminal when still open, else a new terminal resuming its Claude session. */
  async openSession(docsRoot: string, mapId: string, launchId: string, terminalId: string | null, size: TerminalSize, prompt?: string): Promise<TerminalInfo> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    const launch = (await docs.maps.launches(mapId)).find((l) => l.id === launchId)
    if (!launch) throw new Error(`No launch ${launchId} on this map`)
    const session = terminalId ? launch.sessions.find((s) => s.terminal === terminalId) : launch.sessions.at(-1)
    if (!session) throw new Error('This launch has no session to open')
    const open = this.options.terminals.list().find((t) => t.id === session.terminal)
    if (open) return open
    const worktree = await realpath(launch.worktree).catch(() => null)
    if (!worktree) throw new Error(`The worktree ${path.basename(launch.worktree)} is gone; its branch ${launch.branch} was kept`)
    const tracker = await docs.maps.tracker(mapId)
    const map = await docs.maps.map(mapId)
    const others = this.options.projects
      .list()
      .filter((p) => p.kind === 'code' && map.projects.includes(p.name) && p.root !== launch.project)
      .map((p) => p.root)
    const terminal = await this.options.terminals.create(worktree, 'claude', size, {
      title: session.ticket ? (findTicket(tracker, session.ticket)?.ticket.title ?? map.title) : scopeTitle(tracker, launch.scope),
      map: { docsRoot: root, map: mapId, launch: launchId, ticket: session.ticket },
      brief: this.briefFile(launchId, session.session),
      addDirs: [root, ...others],
      resume: session.session,
      ...(prompt ? { prompt } : {})
    })
    this.links.set(terminal.id, { docsRoot: root, map: mapId, launch: launchId, ticket: session.ticket })
    await docs.maps.saveLaunch(mapId, launchId, (current) => {
      const base = current ?? launch
      return { ...base, sessions: base.sessions.map((s) => (s.session === session.session ? { ...s, terminal: terminal.id } : s)) }
    })
    this.changed(root, mapId)
    return terminal
  }

  /** A launch session's brief: the map as it is now, the other sessions in its worktree, and earlier work in its milestone. */
  private sessionBrief(input: { docsRoot: string; map: MapFile; tracker: Tracker; launches: readonly MapLaunch[]; launch: MapLaunch; ticket: string | null; terminalId: string | null; note?: string }): string {
    const { map, tracker, launch } = input
    const project = this.options.projects.list().find((p) => p.root === launch.project)?.name ?? path.basename(launch.project)
    const others = this.options.terminals
      .list()
      .filter((t) => t.id !== input.terminalId && t.state !== 'exited' && launch.sessions.some((s) => s.terminal === t.id))
      .map((t) => t.title)
    const milestone = scopeMilestone(tracker, launch.scope)
    const earlier = input.launches
      .filter((l) => l.id !== launch.id && l.wrapUp && milestone !== null && scopeMilestone(tracker, l.scope)?.id === milestone.id)
      .sort((a, b) => (a.wrapUp?.at ?? '').localeCompare(b.wrapUp?.at ?? ''))
      .map((l) => ({ title: scopeTitle(tracker, l.scope), summary: l.wrapUp?.summary ?? '' }))
    const checks = map.checks.find((c) => c.project === project)?.commands ?? []
    return launchBrief({ map, tracker, launch, ticket: input.ticket, docsRoot: input.docsRoot, project, checks, others, earlier, ...(input.note ? { note: input.note } : {}) })
  }

  /**
   * What the brief page shows before a ticket starts: the brief its session would get, the docs it
   * points to, whether it's ready, where it would run and what it may do. Changes nothing.
   */
  async previewBrief(request: MapBriefRequest): Promise<MapBriefPreview> {
    const { docsRoot, docs } = await this.docsWorkspace(request.docsRoot)
    const map = await docs.maps.map(request.map)
    const tracker = await docs.maps.tracker(map.id)
    const found = findTicket(tracker, request.ticket)
    if (!found) throw new Error('That ticket is gone')
    const shared = request.mode === 'milestone'
    const scope: LaunchScope = shared ? { milestone: found.milestone.id } : { ticket: found.ticket.id }
    const launches = await docs.maps.launches(map.id)
    const existing = await this.reusable(launches, scope)
    const workspace = await this.briefWorkspace(map, tracker, scope, existing, request, shared)
    const root = workspace.kind === 'new' || workspace.kind === 'reuse' ? workspace.root : ''
    const draft: MapLaunch = existing ?? {
      id: 'l_…',
      scope,
      project: root,
      worktree: '',
      branch: workspace.kind === 'new' ? workspace.branch : '',
      base: null,
      sessions: [],
      pr: null,
      landed: false,
      createdAt: '',
      wrappedUpAt: null,
      sweptAt: null,
      readyAt: null,
      wrapUp: null,
      health: null,
      landingSweptAt: null,
      batch: null
    }
    const note = request.note.trim()
    const text = this.sessionBrief({ docsRoot, map, tracker, launches, launch: draft, ticket: shared ? found.ticket.id : null, terminalId: null, ...(note ? { note } : {}) })
    const refs = ticketBriefDocs(map, tracker, found.ticket.id)
    const outline = await docOutlines(docsRoot, [...new Set([...map.docs.map((d) => d.path), ...refs.map((r) => r.path)])])
    const briefDocs = refs.map(
      (ref): MapBriefDoc => ({
        ...ref,
        title: outline.find((o) => o.path === ref.path)?.title ?? path.basename(ref.path, '.md'),
        roles: map.docs.find((d) => d.path === ref.path)?.roles ?? [],
        linked: found.ticket.docs.some((d) => d.path === ref.path && d.heading === ref.heading)
      })
    )
    const project = workspace.kind === 'new' || workspace.kind === 'reuse' ? workspace.project : null
    const args = parseClaudeArgs(this.options.terminals.claudeArgsText())
    const checks = project ? (map.checks.find((c) => c.project === project)?.commands ?? []) : []
    const permissions = [...permissionSummary(args.ok ? args.args : []), 'Map tools without asking', ...checks.map((command) => `Runs ${command}`)]
    return { text, docs: briefDocs, readiness: briefReadiness(map, tracker, found.ticket, refs), workspace, permissions, outline }
  }

  /** Where a launch would run, worked out the way `launch` does it but without creating anything. */
  private async briefWorkspace(map: MapFile, tracker: Tracker, scope: LaunchScope, existing: MapLaunch | null, request: MapBriefRequest, shared: boolean): Promise<BriefWorkspace> {
    const code = this.options.projects.list().filter((p) => p.kind === 'code')
    if (existing) {
      const project = code.find((p) => p.root === existing.project)
      if (!project) return { kind: 'none', message: 'The launch’s code project is no longer in Manta' }
      return { kind: 'reuse', project: project.name, root: project.root, branch: existing.branch, worktree: path.basename(existing.worktree), shared }
    }
    const picked = await this.pickProject(map, tracker, { project: request.project, scope }, shared ? request.ticket : null)
    if (!picked) return { kind: 'none', message: 'Add a code project to Manta first' }
    if ('pick' in picked) return { kind: 'pick', projects: picked.pick }
    const git = new Git(picked.root)
    const taken = new Set((await git.worktrees().catch(() => [])).map((w) => w.branch))
    const slug = worktreeSlug(scopeTitle(tracker, scope))
    let branch = `manta/${slug}`
    for (let attempt = 2; taken.has(branch) && attempt <= 20; attempt++) branch = `manta/${worktreeSlug(`${slug} ${attempt}`)}`
    return { kind: 'new', project: picked.name, root: picked.root, branch, from: (await git.currentBranch().catch(() => '')) || 'HEAD', shared }
  }

  /**
   * Writes a map session's brief from the map as it is now, and notes when it (re)started; the
   * terminal manager calls it before each start. Sessions from before launches get the outline.
   */
  async refreshBrief(link: MapLink, file: string, terminalId: string): Promise<void> {
    const batch = link.coordinator
    if (batch) return this.writeCoordinatorBrief({ ...link, coordinator: batch }, file, terminalId)
    const { docs, docsRoot } = await this.docsWorkspace(link.docsRoot)
    const map = await docs.maps.map(link.map)
    const tracker = await docs.maps.tracker(link.map)
    const launch = link.launch ? (await docs.maps.launches(link.map)).find((l) => l.id === link.launch) : undefined
    let brief: string
    if (launch) {
      const launches = await docs.maps.launches(link.map)
      const note = launch.sessions.find((s) => s.terminal === terminalId)?.note ?? this.pendingNotes.get(file)
      brief = this.sessionBrief({ docsRoot, map, tracker, launches, launch, ticket: link.ticket, terminalId, ...(note ? { note } : {}) })
      this.seen.set(terminalId, await this.snapshot(docsRoot, map, tracker, launches, launch, link.ticket))
      const now = new Date().toISOString()
      if (launch.sessions.some((s) => s.terminal === terminalId)) {
        await docs.maps.saveLaunch(link.map, launch.id, (current) => {
          const base = current ?? launch
          return { ...base, sessions: base.sessions.map((s) => (s.terminal === terminalId ? { ...s, startedAt: now } : s)) }
        })
      }
      this.links.set(terminalId, link)
    } else {
      brief = `# Manta context map brief\n\nYou were started from Manta's context map "${map.title}" (Manta map ${map.id}). The docs repo is \`${docsRoot}\`; it is read-only for you.\n\n${await docs.maps.outline(map.id)}`
    }
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, brief)
    await rename(`${file}.tmp`, file)
  }

  // -------------------------------------------------------------------------------------------
  // Status from pull requests and landing

  /**
   * Looks up each open launch's pull request and whether it landed. A pull request opening puts its
   * tickets in review. Landing changes no ticket's status, since a ticket can take several pull
   * requests and only the user accepts it; it marks a milestone's own branch landed and runs the
   * landing pass. Statuses change only when something did.
   */
  async check(docsRoot: string, mapId: string): Promise<void> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    const target = new Map<string, string | null>()
    let changed = false
    for (const launch of await docs.maps.launches(mapId)) {
      if (launch.landed || !launch.branch) continue
      if (!target.has(launch.project)) target.set(launch.project, await new Git(launch.project).defaultBranch().catch(() => null))
      if (launch.branch === target.get(launch.project)) continue
      const lookup = await this.options.pullRequests?.(launch.project, launch.branch)
      const pr = lookup ? lookup.found : launch.pr
      const landed = pr?.state === 'merged' || (await branchLanded(launch.project, { trailer: { key: LAUNCH_TRAILER, value: launch.id }, branch: launch.branch, base: launch.base }).catch(() => false))
      const health = pr?.state === 'open' && !landed ? await this.health(launch) : null
      if (samePullRequest(pr, launch.pr) && sameHealth(health, launch.health) && !landed) continue
      changed = true
      await docs.maps.saveLaunch(mapId, launch.id, (current) => ({ ...(current ?? launch), pr, landed, health }))
      const tickets = 'milestone' in launch.scope ? [] : scopeTicketIds(launch.scope)
      if (landed) {
        if ('milestone' in launch.scope) await docs.maps.markMilestoneLanded(mapId, launch.scope.milestone)
        void this.maybeLandingPass(root, mapId, launch.id)
      } else if (pr?.state === 'open' && launch.pr?.state !== 'open') {
        await docs.maps.setStatuses(mapId, tickets, 'in-review', { keepDone: true })
      }
    }
    if (changed) this.changed(root, mapId)
  }

  /** `check` for every map of the docs repo that has work not landed yet: what the background poll runs. */
  async checkAll(docsRoot: string): Promise<void> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    for (const map of await docs.maps.list()) {
      if (!(await docs.maps.launches(map.id)).some((l) => !l.landed && l.branch)) continue
      await this.check(root, map.id).catch((error: unknown) => console.error(`manta: checking map ${map.id}`, error))
    }
  }

  /** The open pull request's checks and review; the last known health when GitHub can't be asked. */
  private async health(launch: MapLaunch): Promise<PullRequestHealth | null> {
    const lookup = this.options.pullRequestDetail
    if (!lookup) return launch.health
    const answer = await lookup(launch.project, launch.branch).catch(() => null)
    if (!answer || 'failed' in answer) return launch.health
    return answer.found ? pullRequestHealth(answer.found) : null
  }

  // -------------------------------------------------------------------------------------------
  // Pull requests: opening one, and sending its feedback back

  /** Pushes a finished launch's branch and opens a draft pull request, titled after its scope, its body from the wrap-up. */
  async openPullRequest(docsRoot: string, mapId: string, launchId: string): Promise<OpResult> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    const launch = (await docs.maps.launches(mapId)).find((l) => l.id === launchId)
    if (!launch) return { ok: false, message: 'That launch is gone' }
    if (launch.pr?.state === 'open') return { ok: false, message: `It already has pull request #${launch.pr.number}` }
    if (launch.landed) return { ok: false, message: 'It has landed already' }
    if (!this.options.openPullRequest) return { ok: false, message: 'Opening pull requests needs GitHub’s gh' }
    const worktree = await realpath(launch.worktree).catch(() => null)
    if (!worktree) return { ok: false, message: `The worktree ${path.basename(launch.worktree)} is gone` }
    const tracker = await docs.maps.tracker(mapId)
    const opened = await this.options.openPullRequest(worktree, { title: scopeTitle(tracker, launch.scope), body: pullRequestBody(tracker, launch) })
    if (!opened.ok) return opened
    const url = /https:\/\/\S+\/pull\/(\d+)/.exec(opened.message)
    if (url?.[1]) {
      const pr: PullRequestInfo = { number: Number(url[1]), state: 'open', url: url[0] }
      await docs.maps.saveLaunch(mapId, launch.id, (current) => ({ ...(current ?? launch), pr }))
      await docs.maps.setStatuses(mapId, 'milestone' in launch.scope ? [] : scopeTicketIds(launch.scope), 'in-review', { keepDone: true })
    }
    this.changed(root, mapId)
    return opened
  }

  /**
   * Sends the launch's failing checks, or its pull request's unresolved review threads and
   * change requests, to its session: typed into it when it's running, else as the first prompt of
   * the resumed session.
   */
  async sendFeedback(docsRoot: string, mapId: string, launchId: string, kind: MapFeedback, size: TerminalSize): Promise<OpResult> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    const launch = (await docs.maps.launches(mapId)).find((l) => l.id === launchId)
    if (!launch) return { ok: false, message: 'That launch is gone' }
    if (launch.pr?.state !== 'open') return { ok: false, message: 'It has no open pull request' }
    if (!this.options.pullRequestDetail) return { ok: false, message: 'Reading pull requests needs GitHub’s gh' }
    const answer = await this.options.pullRequestDetail(launch.project, launch.branch, { force: true })
    if ('failed' in answer) return { ok: false, message: answer.failed }
    const pr = answer.found
    if (!pr) return { ok: false, message: 'GitHub has no pull request for its branch now' }
    let message: string
    if (kind === 'checks') {
      const failing = pr.checks.filter((c) => c.state === 'failed')
      if (failing.length === 0) return { ok: false, message: 'No checks are failing now' }
      message = [
        `Checks failed on your pull request #${pr.number} “${pr.title}” (${pr.url}):`,
        '',
        ...failing.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ''}`),
        '',
        `Read the failures (\`gh pr checks ${pr.number}\`, then \`gh run view <run id> --log-failed\`), fix them, run the checks again, commit and push. Then report the tickets and wrap up again.`
      ].join('\n')
    } else {
      const comments = reviewFeedback(pr.comments)
      if (comments.length === 0) return { ok: false, message: 'Nothing in the review is waiting: no unresolved threads or change requests' }
      message = formatPullRequestMessage(REVIEW_TEMPLATE, pr, comments, path.basename(launch.worktree))
    }
    const result = await this.deliver(root, mapId, launch, message, kind === 'checks' ? 'failing checks' : 'review', size)
    if (result.ok) await docs.maps.appendJournal(mapId, launch.id, 'note', `Manta sent the ${kind === 'checks' ? 'failing checks' : 'review feedback'} of PR #${pr.number} to the session.`)
    this.changed(root, mapId)
    return result
  }

  /** The user's own review of a launch's work, sent to its session: what to change before it's done. */
  async requestChanges(docsRoot: string, mapId: string, launchId: string, text: string, size: TerminalSize): Promise<OpResult> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    const launch = (await docs.maps.launches(mapId)).find((l) => l.id === launchId)
    if (!launch) return { ok: false, message: 'That launch is gone' }
    const asked = text.trim()
    if (!asked) return { ok: false, message: 'Say what to change' }
    const tracker = await docs.maps.tracker(mapId)
    const message = [
      `The user reviewed your work on “${scopeTitle(tracker, launch.scope)}” and asks for changes:`,
      '',
      asked,
      '',
      `Make them, run the checks again and commit${launch.pr?.state === 'open' ? ', then push to the pull request' : ''}. Then report the tickets and wrap up again.`
    ].join('\n')
    const result = await this.deliver(root, mapId, launch, message, 'requested changes', size)
    if (result.ok) await docs.maps.appendJournal(mapId, launch.id, 'review', `The user asked for changes: ${asked}`)
    this.changed(root, mapId)
    return result
  }

  /**
   * The user's review of a ticket ends with it done: the doc updates its launches proposed that the
   * user included are approved first (none is approved if one fails), then the ticket is set done and
   * the review is journaled on its latest launch.
   */
  async markDone(docsRoot: string, mapId: string, ticketId: string, include: readonly string[]): Promise<OpResult> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    const tracker = await docs.maps.tracker(mapId)
    const found = findTicket(tracker, ticketId)
    if (!found) return { ok: false, message: 'That ticket is gone' }
    const launches = (await docs.maps.launches(mapId)).filter((l) => scopeTicketIds(l.scope).includes(ticketId) || l.sessions.some((s) => s.ticket === ticketId))
    const ids = new Set(launches.map((l) => l.id))
    const proposals = (await docs.maps.get(mapId)).proposals.filter((p) => 'launch' in p.from && ids.has(p.from.launch))
    const chosen = include.map((thread) => proposals.find((p) => p.thread === thread))
    if (chosen.some((p) => p === undefined)) return { ok: false, message: 'A doc update is no longer waiting; reload and try again' }
    const approved: string[] = []
    for (const proposal of chosen) {
      if (!proposal) continue
      const result = await docs.threads.approve(proposal.doc, proposal.thread)
      if (!result.ok) return { ok: false, message: `${proposal.doc}: ${result.message}${approved.length > 0 ? ` (${approved.join(', ')} already updated)` : ''}` }
      approved.push(proposal.doc)
    }
    const set = await docs.maps.editTracker(mapId, { kind: 'set-ticket-status', ticket: ticketId, status: 'done' })
    if (!set.ok) return set
    const latest = launches.at(-1)
    if (latest) await docs.maps.appendJournal(mapId, latest.id, 'review', `The user reviewed “${found.ticket.title}” and marked it done${approved.length > 0 ? `, with the doc updates to ${approved.join(', ')}` : ''}.`)
    this.changed(root, mapId)
    return { ok: true, message: `${found.ticket.title} is done${approved.length > 0 ? `; ${approved.length} ${approved.length === 1 ? 'doc' : 'docs'} updated` : ''}` }
  }

  /**
   * A hand edit to the tracker. Deciding a decision a session raised sends the outcome to that
   * session when it's still running, so the work it held back can go on.
   */
  async editTracker(docsRoot: string, mapId: string, edit: TrackerEdit): Promise<OpResult> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    const before = edit.kind === 'update-decision' ? (await docs.maps.tracker(mapId)).decisions.find((d) => d.id === edit.decision) : undefined
    const result = await docs.maps.editTracker(mapId, edit)
    if (!result.ok || before?.status !== 'open' || !before.from || !('launch' in before.from)) return result
    const raisedBy = before.from.launch
    const tracker = await docs.maps.tracker(mapId)
    const decision = tracker.decisions.find((d) => d.id === before.id)
    const launch = (await docs.maps.launches(mapId)).find((l) => l.id === raisedBy)
    if (decision?.status !== 'decided' || !launch) return result
    const running = launch.sessions.filter((s) => this.options.terminals.list().some((t) => t.id === s.terminal && t.state !== 'exited'))
    const session = running.find((s) => s.ticket !== null && decision.blocks.includes(s.ticket)) ?? running.at(-1)
    if (!session) return result
    const held = decision.blocks.flatMap((id) => {
      const found = findTicket(tracker, id)
      return found && found.ticket.status !== 'done' ? [`“${found.ticket.title}”`] : []
    })
    const message = [
      `The user decided decision ${decisionNumber(decision)} “${decision.title}”, which you raised:`,
      '',
      decision.outcome,
      '',
      `${held.length > 0 ? `${held.join(', ')} can go on. ` : ''}Carry on with the work it held back, following the decision.`
    ].join('\n')
    const sent = await this.options.terminals.sendPrompt(session.terminal, message)
    if (!sent.ok) return result
    await docs.maps.appendJournal(mapId, launch.id, 'note', `Manta sent the outcome of decision ${decisionNumber(decision)} to the session.`)
    this.changed(root, mapId)
    return { ok: true, message: `${result.message}; sent to the session that raised it` }
  }

  /** Sends a prompt to the launch's session: the live one, else its exited tab resumed, else a new tab resuming it. */
  private async deliver(root: string, mapId: string, launch: MapLaunch, message: string, what: string, size: TerminalSize): Promise<OpResult> {
    const terminals = this.options.terminals
    const session = [...launch.sessions].reverse().find((s) => terminals.list().some((t) => t.id === s.terminal && t.state !== 'exited'))
    /** Its tab is still open with the session exited: resume it there, so no tab is left behind. */
    const exited = session ? null : terminals.list().find((t) => t.id === launch.sessions.at(-1)?.terminal)
    if (session) return terminals.sendPrompt(session.terminal, message)
    if (exited && (await realpath(launch.worktree).then(() => true, () => false))) {
      const terminal = await terminals.restart(exited.id, size, message)
      return { ok: true, message: `Resumed ${terminal.title} with the ${what}` }
    }
    const terminal = await this.openSession(root, mapId, launch.id, null, size, message)
    return { ok: true, message: `Resumed ${terminal.title} with the ${what}` }
  }

  // -------------------------------------------------------------------------------------------
  // Each prompt of a running session

  /**
   * What a map session is told as it takes a prompt (the `UserPromptSubmit` hook): what moved in
   * its scope since it last looked (its tickets edited, its docs changed, sibling work landed), and
   * tickets of its own that were blocked, which the user has now answered, go back in progress.
   * Null when there's nothing to say. Bounded, since the hook waits on it.
   */
  async promptContext(terminalId: string): Promise<string | null> {
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PROMPT_CONTEXT_MS)
    })
    try {
      return await Promise.race([this.buildPromptContext(terminalId), late])
    } catch (error) {
      console.error('manta: map prompt context', error)
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async buildPromptContext(terminalId: string): Promise<string | null> {
    const link = this.links.get(terminalId) ?? this.options.terminals.list().find((t) => t.id === terminalId)?.map ?? null
    if (!link?.launch) return null
    const { docs, docsRoot } = await this.docsWorkspace(link.docsRoot)
    const launches = await docs.maps.launches(link.map)
    const launch = launches.find((l) => l.id === link.launch)
    if (!launch) return null
    const map = await docs.maps.map(link.map)
    const tracker = await docs.maps.tracker(link.map)
    const notes: string[] = []

    const own = link.ticket ? launchTickets(tracker, { ticket: link.ticket }) : launchTickets(tracker, launch.scope)
    const blocked = own.filter((t) => t.status === 'blocked')
    if (blocked.length > 0) {
      await docs.maps.setStatuses(link.map, blocked.map((t) => t.id), 'in-progress')
      notes.push(`The user answered, so Manta set ${blocked.map((t) => `“${t.title}”`).join(', ')} back to in progress. Report it blocked again if you still can't go on.`)
      this.changed(docsRoot, link.map)
    }

    const now = await this.snapshot(docsRoot, map, tracker, launches, launch, link.ticket)
    const before = this.seen.get(terminalId)
    this.seen.set(terminalId, now)
    if (before) {
      for (const [id, print] of now.tickets) {
        const was = before.tickets.get(id)
        if (was !== undefined && was !== print) notes.push(`The ticket “${findTicket(tracker, id)?.ticket.title ?? id}” was edited since you last looked: \`map_ticket\` \`${id}\` gives it as it is now.`)
      }
      for (const [doc, hash] of now.docs) {
        const was = before.docs.get(doc)
        if (was !== undefined && was !== hash) notes.push(`\`${doc}\` changed since you last looked; read it again before relying on it.`)
      }
      for (const id of now.landed) {
        if (before.landed.has(id)) continue
        const sibling = launches.find((l) => l.id === id)
        if (sibling) notes.push(`“${scopeTitle(tracker, sibling.scope)}” (${sibling.branch}) landed on the default branch; pull it in if your work touches it.`)
      }
    }
    return notes.length > 0 ? ['From the Manta context map:', ...notes.map((note) => `- ${note}`)].join('\n') : null
  }

  /** The session's scope as it is now: its tickets' text, its docs' contents (hashed) and which sibling launches have landed. */
  private async snapshot(docsRoot: string, map: MapFile, tracker: Tracker, launches: readonly MapLaunch[], launch: MapLaunch, ticket: string | null): Promise<Seen> {
    const tickets = ticket ? launchTickets(tracker, { ticket }) : launchTickets(tracker, launch.scope)
    const milestone = scopeMilestone(tracker, launch.scope)
    const paths = new Set([...tickets.flatMap((t) => t.docs.map((d) => d.path)), ...(milestone ? map.docs.filter((d) => d.milestones.includes(milestone.id)).map((d) => d.path) : [])])
    const docs = new Map<string, string>()
    for (const doc of paths) {
      const clean = cleanDocPath(doc)
      if (!clean) continue
      const text = await readFile(path.join(docsRoot, clean), 'utf8').catch(() => '')
      docs.set(clean, createHash('sha1').update(text).digest('hex'))
    }
    const landed = new Set(launches.filter((l) => l.id !== launch.id && l.landed && milestone !== null && scopeMilestone(tracker, l.scope)?.id === milestone.id).map((l) => l.id))
    return { tickets: new Map(tickets.map((t) => [t.id, ticketPrint(t)])), docs, landed }
  }

  // -------------------------------------------------------------------------------------------
  // The board, and a batch's coordinator

  /** Every live launch's sessions with what each needs from the user, from the tracker and the terminals as they are now. */
  async board(docs: Workspace, mapId: string): Promise<BoardRow[]> {
    const tracker = await docs.maps.tracker(mapId)
    const states = new Map<string, TerminalState>(this.options.terminals.list().map((t) => [t.id, t.state]))
    const scope = (launch: MapLaunch, ticket: string | null): string[] => (ticket ? [ticket] : scopeTicketIds(launch.scope, launchTickets(tracker, launch.scope)))
    const tickets = tracker.milestones.flatMap((m) => m.tickets)
    return boardRows({
      launches: await docs.maps.launches(mapId),
      states,
      title: (launch, ticket) => (ticket ? (findTicket(tracker, ticket)?.ticket.title ?? scopeTitle(tracker, launch.scope)) : scopeTitle(tracker, launch.scope)),
      blocked: (launch, ticket) => {
        const ids = scope(launch, ticket)
        return tickets.find((t) => ids.includes(t.id) && t.status === 'blocked')?.blocked ?? null
      },
      unblocks: (launch, ticket) => {
        const ids = scope(launch, ticket)
        return tickets.filter((t) => t.status !== 'done' && t.after.some((a) => ids.includes(a))).length
      }
    })
  }

  /**
   * The batch's coordinator: a Claude session in the docs repo with the coordinator's brief and the
   * read-only map tools plus `board`. Its terminal when it's running, resumed when it exited or its
   * tab was closed, else a new one.
   */
  async coordinate(docsRoot: string, mapId: string, batchId: string, size: TerminalSize): Promise<TerminalInfo> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    const batch = (await docs.maps.batches(mapId)).find((b) => b.id === batchId)
    if (!batch) throw new Error('That batch is gone')
    const terminals = this.options.terminals
    const known = batch.coordinator
    const open = known ? terminals.list().find((t) => t.id === known.terminal) : undefined
    if (open && open.state !== 'exited') return open
    let terminal: TerminalInfo
    if (open) {
      terminal = await terminals.restart(open.id, size)
    } else {
      if (!terminals.claudeAvailable()) throw new Error('Claude Code is not installed: install it, then try again')
      const map = await docs.maps.map(mapId)
      const session = known?.session ?? randomUUID()
      terminal = await terminals.create(root, 'claude', size, {
        title: `Coordinator: ${map.title}`,
        map: { docsRoot: root, map: mapId, launch: null, ticket: null, coordinator: batchId },
        brief: path.join(this.options.briefsDir, `coordinator-${batchId}-${session}.md`),
        ...(known ? { resume: session } : { session, prompt: 'Coordinate the agents in your brief: read the board and tell me what needs me first.' })
      })
    }
    const coordinator = { terminal: terminal.id, session: terminal.sessionId ?? known?.session ?? '', startedAt: new Date().toISOString() }
    await docs.maps.saveBatch(mapId, batchId, (current): MapBatch => ({ ...(current ?? batch), coordinator, declined: false }))
    this.changed(root, mapId)
    return terminal
  }

  /** The user turned down a coordinator for the batch; the offer goes away. */
  async declineCoordinator(docsRoot: string, mapId: string, batchId: string): Promise<void> {
    const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
    if (!(await docs.maps.batches(mapId)).some((b) => b.id === batchId)) return
    await docs.maps.saveBatch(mapId, batchId, (current): MapBatch => ({ id: batchId, createdAt: '', coordinator: null, ...current, declined: true }))
    this.changed(root, mapId)
  }

  private async writeCoordinatorBrief(link: MapLink & { coordinator: string }, file: string, terminalId: string): Promise<void> {
    const { docs, docsRoot } = await this.docsWorkspace(link.docsRoot)
    const map = await docs.maps.map(link.map)
    const tracker = await docs.maps.tracker(link.map)
    const launches = (await docs.maps.launches(link.map)).filter((l) => l.batch === link.coordinator)
    const rows = await this.board(docs, link.map)
    const brief = coordinatorBrief({ map, tracker, launches, batch: link.coordinator, board: boardText(rows, link.coordinator) })
    const previous = this.watches.get(terminalId)
    if (previous?.timer) clearTimeout(previous.timer)
    this.watches.set(terminalId, { docsRoot, map: link.map, batch: link.coordinator, told: new Map(rows.map((r) => [rowKey(r), signalOf(r)])), timer: null, pending: false })
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, brief)
    await rename(`${file}.tmp`, file)
  }

  /** Something on the map moved: each of its coordinators gets one wake-up after the delay, gathering whatever else moves meanwhile. */
  private nudge(map: string): void {
    for (const [terminal, watch] of this.watches) {
      if (watch.map !== map || watch.timer) continue
      watch.timer = setTimeout(() => {
        watch.timer = null
        void this.wake(terminal).catch((error: unknown) => console.error('manta: waking a coordinator', error))
      }, this.options.coordinatorDelayMs ?? COORDINATOR_DELAY_MS)
    }
  }

  /**
   * Tells a coordinator what now needs the user, or ended, since it was last told; nothing when only
   * progress lines moved. Waits while it's busy or asking something: `terminalChanged` retries once it's back at its prompt.
   */
  private async wake(terminal: string): Promise<void> {
    const watch = this.watches.get(terminal)
    if (!watch || this.closed) return
    const { docs } = await this.docsWorkspace(watch.docsRoot)
    const rows = await this.board(docs, watch.map)
    const now = new Map(rows.map((r) => [rowKey(r), signalOf(r)]))
    const lines: string[] = []
    for (const row of rows) {
      const signal = now.get(rowKey(row)) ?? ''
      if (watch.told.get(rowKey(row)) === signal) continue
      if (row.state === 'exited' || row.state === 'closed') lines.push(`- ${row.title}: its session ended${row.attention ? `; needs you: ${row.attention}` : ''}`)
      else if (row.attention) lines.push(`- ${row.title}: needs you: ${row.attention}`)
    }
    const launches = await docs.maps.launches(watch.map)
    for (const key of watch.told.keys()) {
      if (now.has(key)) continue
      const launch = launches.find((l) => l.id === key.split('/')[0])
      if (launch?.landed) lines.push(`- ${scopeTitle(await docs.maps.tracker(watch.map), launch.scope)}: landed`)
    }
    if (lines.length === 0) {
      watch.told = now
      watch.pending = false
      return
    }
    if (this.options.terminals.list().find((t) => t.id === terminal)?.state !== 'idle') {
      watch.pending = true
      return
    }
    const sent = await this.options.terminals.sendPrompt(terminal, ['Manta: changed since you last looked:', ...lines, '', 'Call `board` for the rest. Give the user the new order only if it changed.'].join('\n'))
    watch.pending = !sent.ok
    if (sent.ok) watch.told = now
  }

  // -------------------------------------------------------------------------------------------
  // Sessions ending, and the sweep

  /** Main forwards every terminal change: a map session that exits may need the sweep, and its coordinators hear of it. */
  terminalChanged(info: TerminalInfo): void {
    const watch = this.watches.get(info.id)
    if (watch) {
      if (info.state === 'idle' && watch.pending && !watch.timer) void this.wake(info.id).catch((error: unknown) => console.error('manta: waking a coordinator', error))
      return
    }
    if (!info.map?.launch) return
    this.links.set(info.id, info.map)
    this.nudge(info.map.map)
    if (info.state === 'exited') void this.maybeSweep(info.map.docsRoot, info.map.map, info.map.launch)
  }

  /** A map session's terminal was closed: the same as it exiting. */
  terminalRemoved(id: string): void {
    const watch = this.watches.get(id)
    if (watch?.timer) clearTimeout(watch.timer)
    this.watches.delete(id)
    const link = this.links.get(id)
    this.links.delete(id)
    this.seen.delete(id)
    if (link) this.nudge(link.map)
    if (link?.launch) void this.maybeSweep(link.docsRoot, link.map, link.launch)
  }

  /**
   * Runs the sweep for a launch when the map has it on, no session of the launch is still running,
   * and nothing (a session's wrap-up or an earlier sweep) covered the work since its last start.
   * One at a time per launch; errors are logged, never thrown at the caller.
   */
  async maybeSweep(docsRoot: string, mapId: string, launchId: string): Promise<void> {
    const key = `${mapId}/${launchId}`
    if (this.closed || this.sweeping.has(key) || !this.options.agent) return
    this.sweeping.add(key)
    try {
      const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
      const map = await docs.maps.map(mapId)
      const launch = (await docs.maps.launches(mapId)).find((l) => l.id === launchId)
      if (!map.sweep || !launch || !needsSweep(launch)) return
      const running = this.options.terminals.list().some((t) => launch.sessions.some((s) => s.terminal === t.id) && t.state !== 'exited')
      if (running) return
      await this.runSweep(root, docs, map, launch, 'sweep')
    } catch (error) {
      console.error(`manta: sweeping ${key}`, error)
    } finally {
      this.sweeping.delete(key)
    }
  }

  /**
   * Once a launch lands, the landing pass checks its docs against what landed, and does the
   * wrap-up too when nothing covered it. Once per launch, when the map has the sweep on.
   */
  async maybeLandingPass(docsRoot: string, mapId: string, launchId: string): Promise<void> {
    const key = `${mapId}/${launchId}`
    if (this.closed || this.sweeping.has(key) || !this.options.agent) return
    this.sweeping.add(key)
    try {
      const { docs, docsRoot: root } = await this.docsWorkspace(docsRoot)
      const map = await docs.maps.map(mapId)
      const launch = (await docs.maps.launches(mapId)).find((l) => l.id === launchId)
      if (!map.sweep || !launch || !launch.landed || launch.landingSweptAt) return
      await this.runSweep(root, docs, map, launch, 'landing')
    } catch (error) {
      console.error(`manta: landing pass of ${key}`, error)
    } finally {
      this.sweeping.delete(key)
    }
  }

  private async runSweep(docsRoot: string, docs: Workspace, map: MapFile, launch: MapLaunch, mode: 'sweep' | 'landing'): Promise<void> {
    const agent = this.options.agent
    if (!agent) return
    const agentId = `agent_sweep_${launch.id}`
    this.agents.set(agentId, { docsRoot, map: map.id, role: 'sweep', launch: launch.id })
    try {
      const tracker = await docs.maps.tracker(map.id)
      const journal = await docs.maps.journal(map.id, launch.id)
      const dir = path.join(this.options.agentsDir, map.id, launch.id)
      const file = path.join(dir, 'journal.md')
      await mkdir(dir, { recursive: true })
      await writeFile(file, journal)
      const milestone = scopeMilestone(tracker, launch.scope)
      const ticketDocs = launchTickets(tracker, launch.scope).flatMap((t) => t.docs)
      const docsOfMilestone = milestone ? map.docs.filter((d) => d.milestones.includes(milestone.id)).map((d) => ({ path: d.path, heading: null })) : []
      const controller = new AbortController()
      const pullRequest = launch.pr ? ((await this.options.pullRequestText?.(launch.project, launch.pr.number).catch(() => null)) ?? undefined) : undefined
      const context = {
        scopeTitle: scopeTitle(tracker, launch.scope),
        launch,
        journal,
        diffSummary: await diffSummary(launch),
        docs: [...ticketDocs, ...docsOfMilestone],
        criteria: launchTickets(tracker, launch.scope).map((ticket) => ({ ticket })),
        ...(pullRequest ? { pullRequest } : {})
      }
      const turn = {
        prompt: mode === 'landing' ? landingPrompt({ ...context, wrappedUp: !needsSweep(launch) }) : sweepPrompt(context),
        cwd: dir,
        file,
        session: null,
        context: { repoRoot: docsRoot, map: { id: map.id, title: map.title, prompt: sweepSystemPrompt(map, docsRoot) }, mcp: this.options.terminals.agentMcp(agentId), model: SWEEP_MODEL },
        signal: controller.signal,
        requestPermission: denyAll
      }
      for await (const event of agent.run(turn)) if (event.type === 'error') console.error(`manta: sweep of ${launch.id}: ${event.message}`)
    } finally {
      this.agents.delete(agentId)
      const at = new Date().toISOString()
      await docs.maps.saveLaunch(map.id, launch.id, (current) => ({ ...(current ?? launch), sweptAt: at, ...(mode === 'landing' ? { landingSweptAt: at } : {}) }))
      this.changed(docsRoot, map.id)
    }
  }

  // -------------------------------------------------------------------------------------------
  // The map tools

  /** Manta's MCP endpoint for Ask the map's agent. */
  askMcp(docsRoot: string, mapId: string): ReturnType<TerminalManager['agentMcp']> {
    const agentId = `agent_ask_${mapId}`
    this.agents.set(agentId, { docsRoot, map: mapId, role: 'ask', launch: null })
    return this.options.terminals.agentMcp(agentId)
  }

  /** The tools a caller gets: map tools for map sessions with a launch and the map's agents; null for anyone else. */
  toolsFor(session: McpSession): McpTool[] | null {
    let role: MapRole | null = null
    if ('agent' in session) role = this.agents.get(session.agent)?.role ?? null
    else if (session.terminal.map?.coordinator) role = 'coordinator'
    else if (session.terminal.map?.launch) role = 'session'
    if (!role) return null
    const call =
      (name: string): McpTool['call'] =>
      (caller, args) =>
        this.callTool(name, caller, args)
    const tools: McpTool[] = mapToolDefinitions(role).map(({ roles: _roles, ...definition }) => ({ ...definition, call: call(definition.name) }))
    if (role !== 'coordinator') tools.push(proposeDocChangeTool(call('propose_doc_change')), reviseDocChangeTool(call('revise_doc_change')), withdrawDocChangeTool(call('withdraw_doc_change')))
    return tools
  }

  private async callTool(name: string, callerId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const caller = await this.caller(callerId)
    if ('error' in caller) return caller
    const result = await this.handle(name, caller, args)
    if (!['map_outline', 'map_milestone', 'map_ticket', 'map_docs', 'map_journal'].includes(name)) this.changed(caller.docsRoot, caller.map)
    return result
  }

  private async caller(id: string): Promise<Caller | { text: string; error: true }> {
    const agent = this.agents.get(id)
    const link = agent ? null : (this.options.terminals.list().find((t) => t.id === id)?.map ?? null)
    const docsRoot = agent?.docsRoot ?? link?.docsRoot
    const map = agent?.map ?? link?.map
    const launchId = agent ? agent.launch : (link?.launch ?? null)
    const batch = agent ? null : (link?.coordinator ?? null)
    if (!docsRoot || !map || (!agent && !launchId && !batch)) return { text: 'This session is not linked to a Manta context map launch', error: true }
    const docs = (await this.docsWorkspace(docsRoot)).docs
    const launch = launchId ? ((await docs.maps.launches(map)).find((l) => l.id === launchId) ?? null) : null
    if (launchId && !launch) return { text: `The launch ${launchId} is gone from the map`, error: true }
    return { docsRoot, docs, map, role: agent?.role ?? (batch ? 'coordinator' : 'session'), launch, terminal: agent ? null : id, batch }
  }

  private async handle(name: string, caller: Caller, args: Record<string, unknown>): Promise<ToolResult> {
    const { docs, map } = caller
    const text = (key: string): string => (typeof args[key] === 'string' ? String(args[key]).trim() : '')
    const tracker = await docs.maps.tracker(map)
    switch (name) {
      case 'map_outline':
        return { text: await docs.maps.outline(map) }
      case 'map_milestone': {
        const milestone = milestoneInfos(tracker, await docs.maps.launches(map)).find((m) => m.id === text('milestone'))
        if (!milestone) return { text: `No milestone ${text('milestone')}; map_outline lists them`, error: true }
        const docPaths = await docs.maps.docsFor(map, { milestone: milestone.id })
        return {
          text: [
            `# ${milestone.title} (${milestone.status})`,
            '',
            milestone.description.trim() || 'No description.',
            '',
            '## Tickets',
            '',
            ...(milestone.tickets.length > 0 ? milestone.tickets.map((t) => `- ${t.title} (\`${t.id}\`, ${t.status}): ${t.description.trim().split('\n')[0] ?? ''}`) : ['None.']),
            '',
            '## Docs',
            '',
            ...(docPaths.length > 0 ? docPaths.map((d) => `- ${d.path}`) : ['None tied to it.'])
          ].join('\n')
        }
      }
      case 'map_ticket': {
        const found = findTicket(tracker, text('ticket'))
        if (!found) return { text: `No ticket ${text('ticket')}; map_outline lists them`, error: true }
        const { ticket, milestone } = found
        const launches = (await docs.maps.launches(map)).filter((l) => scopeTicketIds(l.scope, milestone.tickets).includes(ticket.id))
        return {
          text: [
            `# ${ticket.title} (${ticket.status}${ticket.blocked ? `: ${ticket.blocked}` : ''})`,
            `Milestone: ${milestone.title} (\`${milestone.id}\`)`,
            '',
            ticket.description.trim() || 'No description.',
            '',
            '## Docs',
            ...(ticket.docs.length > 0 ? ticket.docs.map((d) => `- ${d.path}${d.heading ? ` § ${d.heading}` : ''}`) : ['None.']),
            '',
            '## Launches',
            ...(launches.length > 0 ? launches.map((l) => `- ${l.id}: ${l.branch}${l.pr ? `, PR #${l.pr.number} ${l.pr.state}` : ''}${l.landed ? ', landed' : ''}`) : ['None yet.'])
          ].join('\n')
        }
      }
      case 'map_docs': {
        const filter = { ...(text('milestone') ? { milestone: text('milestone') } : {}), ...(text('section') ? { section: text('section') } : {}) }
        const listed = await docs.maps.docsFor(map, filter)
        return { text: listed.length > 0 ? `Docs in ${caller.docsRoot}:\n${listed.map((d) => `- ${d.path}`).join('\n')}` : 'No docs listed.' }
      }
      case 'map_journal':
        return { text: await this.journals(caller, tracker, text('launch'), text('ticket')) }
      case 'set_ticket_status':
        return this.setStatus(caller, tracker, text('ticket'), args['status'], text('reason'))
      case 'journal': {
        if (!caller.launch) return { text: 'Only a launched session keeps a journal', error: true }
        if (!text('entry')) return { text: 'Give the entry as text', error: true }
        await docs.maps.appendJournal(map, caller.launch.id, text('kind') || 'note', text('entry'))
        return { text: 'Added to your journal.' }
      }
      case 'wrap_up':
        return this.wrapUp(caller, tracker, args)
      case 'report_progress':
        return this.reportProgress(caller, args)
      case 'board':
        return { text: boardText(await this.board(docs, map), caller.batch) }
      case 'suggest_doc': {
        const doc = cleanDocPath(text('path'))
        if (!doc) return { text: `${text('path')} isn't a path in the docs repo`, error: true }
        const exists = await access(path.join(caller.docsRoot, doc)).then(
          () => true,
          () => false
        )
        if (!exists) return { text: `There is no ${doc} in the docs repo; suggest_doc_to_write is for docs that don't exist yet`, error: true }
        if ((await docs.maps.map(map)).docs.some((d) => d.path === doc)) return { text: `${doc} is already on the map` }
        return this.suggestion(caller, { kind: 'add-doc', path: doc, why: text('why'), milestones: milestoneIds(args['milestones'], tracker) }, args)
      }
      case 'suggest_doc_to_write':
        if (!text('title')) return { text: 'Give the doc a title', error: true }
        return this.suggestion(caller, { kind: 'write-doc', title: text('title'), why: text('why'), milestones: milestoneIds(args['milestones'], tracker) }, args)
      case 'suggest_ticket': {
        if (!tracker.milestones.some((m) => m.id === text('milestone'))) return { text: `No milestone ${text('milestone')}; map_outline lists them`, error: true }
        const ticket = parseProposedTicket({ ...args, docs: docRefs(args['docs']) })
        if (!ticket || !text('title')) return { text: 'Give the ticket a title', error: true }
        return this.suggestion(caller, { kind: 'ticket', milestone: text('milestone'), why: text('why'), ticket }, args)
      }
      case 'propose_decision':
        return this.raiseDecision(caller, tracker, args)
      case 'propose_plan_change':
        return this.planChange(caller, tracker, args)
      case 'propose_milestones': {
        const milestones = Array.isArray(args['milestones'])
          ? args['milestones'].flatMap((m: unknown) => {
              if (typeof m !== 'object' || m === null || !('title' in m) || typeof m.title !== 'string') return []
              const description = 'description' in m && typeof m.description === 'string' ? m.description : ''
              const doneWhen = 'done_when' in m ? notes(m.done_when) : []
              const tickets = 'tickets' in m && Array.isArray(m.tickets) ? m.tickets.flatMap((t: unknown) => parseProposedTicket(t) ?? []) : []
              return [{ title: m.title, description, doneWhen, tickets }]
            })
          : []
        if (milestones.length === 0) return { text: 'Give at least one milestone with a title', error: true }
        return this.suggestion(caller, { kind: 'plan', why: text('why'), milestones }, args)
      }
      case 'propose_doc_change':
      case 'revise_doc_change':
      case 'withdraw_doc_change':
        return this.docChange(name, caller, tracker, args)
      default:
        return { text: `Unknown tool ${name}`, error: true }
    }
  }

  /** Records a session's own one-line report on its launch session, for the board. */
  private async reportProgress(caller: Caller, args: Record<string, unknown>): Promise<ToolResult> {
    const launch = caller.launch
    if (!launch || caller.role !== 'session') return { text: 'Only a launched session reports progress', error: true }
    const phase = PROGRESS_PHASES.find((p) => p === args['phase'])
    if (!phase) return { text: `phase must be one of ${PROGRESS_PHASES.join(', ')}`, error: true }
    const summary = typeof args['summary'] === 'string' ? args['summary'].trim() : ''
    if (!summary) return { text: 'Give a one-line summary', error: true }
    const next = typeof args['next'] === 'string' && args['next'].trim() ? args['next'].trim() : null
    const progress: SessionProgress = { phase, summary: summary.slice(0, 240), needs: parseNeed(args['needs']), next, at: new Date().toISOString() }
    await caller.docs.maps.saveLaunch(caller.map, launch.id, (current) => {
      const base = current ?? launch
      const mine = base.sessions.some((s) => s.terminal === caller.terminal) ? caller.terminal : (base.sessions.at(-1)?.terminal ?? null)
      return { ...base, sessions: base.sessions.map((s) => (s.terminal === mine ? { ...s, progress } : s)) }
    })
    return { text: progress.needs ? 'On the board, with what you need from the user.' : 'On the board.' }
  }

  private async setStatus(caller: Caller, tracker: Tracker, ticketId: string, status: unknown, reason: string): Promise<ToolResult> {
    const launch = caller.launch
    if (!launch) return { text: 'Only a launched session reports status', error: true }
    const wanted = REPORTABLE.find((s) => s === status)
    if (!wanted) return { text: 'status must be in-progress, blocked or done', error: true }
    const found = findTicket(tracker, ticketId)
    if (!found) return { text: `No ticket ${ticketId}; map_outline lists them`, error: true }
    if (!scopeTicketIds(launch.scope, launchTickets(tracker, launch.scope)).includes(ticketId)) return { text: `${found.ticket.title} isn't in your launch's scope; tell the user instead`, error: true }
    if (wanted === 'blocked' && !reason) return { text: 'Say why it is blocked in reason', error: true }
    if (wanted === 'done') {
      const refused = await this.notDoneYet(caller, found.ticket)
      if (refused) return refused
      await caller.docs.maps.appendJournal(caller.map, launch.id, 'note', `Reported “${found.ticket.title}” done.`)
    }
    await caller.docs.maps.setStatuses(caller.map, [ticketId], wanted, { reason })
    return { text: `“${found.ticket.title}” is now ${wanted}.` }
  }

  /**
   * Why a ticket can't be reported done yet: a pull request of its own still open (it's in review
   * until it merges), or its own branch neither merged nor in a pull request (the next step is the
   * pull request). Pull requests are looked up first, so a merge a moment ago counts. Null when it
   * can be done; tickets on a shared branch are done when the session says so.
   */
  private async notDoneYet(caller: Caller, ticket: MapTicket): Promise<ToolResult | null> {
    await this.check(caller.docsRoot, caller.map).catch((error: unknown) => console.error('manta: checking pull requests before done', error))
    const launches = (await caller.docs.maps.launches(caller.map)).filter((l) => 'ticket' in l.scope && l.scope.ticket === ticket.id)
    const open = launches.find((l) => !l.landed && l.pr?.state === 'open')
    if (open?.pr) return { text: `Pull request #${open.pr.number} isn't merged yet; “${ticket.title}” stays in review until it is. Report done once it's merged and you've verified it with the user.`, error: true }
    const own = launches.find((l) => l.id === caller.launch?.id)
    if (own && !own.landed && own.pr === null) {
      await caller.docs.maps.saveLaunch(caller.map, own.id, (current) => ({ ...(current ?? own), readyAt: (current ?? own).readyAt ?? new Date().toISOString() }))
      return { text: `“${ticket.title}” isn't merged yet. Open its pull request (the user can also open it from the map); it goes in review then, and you report done once it's merged and verified with the user.`, error: true }
    }
    return null
  }

  private async wrapUp(caller: Caller, tracker: Tracker, args: Record<string, unknown>): Promise<ToolResult> {
    const launch = caller.launch
    if (!launch) return { text: 'Only a launch can be wrapped up', error: true }
    const { docs, map } = caller
    const summary = typeof args['summary'] === 'string' ? args['summary'].trim() : ''
    const tickets = launchTickets(tracker, launch.scope)
    const criteria = parseCriteria(args['criteria']).filter((c) => (tickets.find((t) => t.id === c.ticket)?.acceptance.length ?? 0) > c.index)
    const wrapUp: LaunchWrapUp = {
      summary,
      wentToPlan: args['went_to_plan'] === true,
      finished: args['finished'] === true,
      criteria,
      checks: parseCheckRuns(args['checks']),
      unverified: notes(args['unverified']),
      decisions: notes(args['decisions']),
      risks: notes(args['risks']),
      at: new Date().toISOString(),
      sweep: caller.role === 'sweep'
    }
    const total = tickets.reduce((n, t) => n + t.acceptance.length, 0)
    const met = criteria.filter((c) => c.met).length
    const extras = [...(wrapUp.finished ? ['Finished.'] : []), ...(total > 0 ? [`Criteria: ${met} of ${total} met.`] : [])]
    await docs.maps.appendJournal(map, launch.id, caller.role === 'sweep' ? 'wrap-up (sweep)' : 'wrap-up', `${wrapUp.wentToPlan ? 'Went to plan. ' : ''}${summary}${extras.length > 0 ? ` ${extras.join(' ')}` : ''}`)
    await docs.maps.saveLaunch(map, launch.id, (current) => {
      const base = current ?? launch
      /** The landing pass reports on the docs; the session's own account of the work stays. */
      const keep = caller.role === 'sweep' && base.landed && base.wrapUp !== null
      const ready = wrapUp.finished && !base.landed && base.pr === null
      return { ...base, wrappedUpAt: wrapUp.at, wrapUp: keep ? base.wrapUp : wrapUp, readyAt: ready ? (base.readyAt ?? wrapUp.at) : base.readyAt }
    })
    return { text: wrapUp.finished && launch.pr === null ? 'Wrap-up recorded. The work is ready for a pull request. You can stop now.' : 'Wrap-up recorded. You can stop now.' }
  }

  private async planChange(caller: Caller, tracker: Tracker, args: Record<string, unknown>): Promise<ToolResult> {
    const raw = Array.isArray(args['changes']) ? args['changes'] : []
    const problems: string[] = []
    const changes = raw.flatMap((value: unknown, index): PlanChange[] => {
      const change = toolPlanChange(value)
      const problem = change ? planChangeProblem(tracker, change) : 'not a change Manta understands'
      if (problem || !change) {
        problems.push(`change ${index + 1}: ${problem ?? 'unreadable'}`)
        return []
      }
      return [change]
    })
    if (changes.length === 0) return { text: `No changes to propose${problems.length > 0 ? `: ${problems.join('; ')}` : ''}`, error: true }
    const leftOut = problems.length > 0 ? ` Left out: ${problems.join('; ')}.` : ''
    const result = await this.suggestion(caller, { kind: 'plan-change', changes, why: typeof args['why'] === 'string' ? args['why'].trim() : '' }, args, `Proposed ${changes.length} change${changes.length === 1 ? '' : 's'}; they wait in Needs review for the user.`)
    return { ...result, text: `${result.text}${leftOut}` }
  }

  private async journals(caller: Caller, tracker: Tracker, launchId: string, ticketId: string): Promise<string> {
    const launches = await caller.docs.maps.launches(caller.map)
    let chosen: MapLaunch[]
    if (launchId) chosen = launches.filter((l) => l.id === launchId)
    else if (ticketId) chosen = launches.filter((l) => scopeTicketIds(l.scope, launchTickets(tracker, l.scope)).includes(ticketId))
    else if (caller.launch) chosen = [caller.launch]
    else chosen = launches.slice(-3)
    if (chosen.length === 0) return 'No launches match.'
    const parts: string[] = []
    for (const launch of chosen) {
      const journal = await caller.docs.maps.journal(caller.map, launch.id)
      parts.push(`# ${scopeTitle(tracker, launch.scope)} (launch ${launch.id}, ${launch.branch})\n\n${journal.trim() || 'No entries.'}`)
    }
    return parts.join('\n\n')
  }

  /**
   * Raises a suggestion. A session's suggestion the user accepted in the session (`confirmed_with_user`,
   * on a map that asks first) applies at once and is journalled; docs to write never do, so the user
   * sees the doc made in Manta. Anything that fails to apply stays in Needs review.
   */
  private async suggestion(caller: Caller, input: SuggestionInput, args: Record<string, unknown>, queued = 'Suggested; it waits in Needs review for the user.'): Promise<ToolResult> {
    const suggestion = await caller.docs.maps.suggest(caller.map, input, author(caller))
    if (args['confirmed_with_user'] !== true || caller.role !== 'session' || !caller.launch) return { text: queued }
    if ((await caller.docs.maps.map(caller.map)).confirmProposals !== 'ask') return { text: `${queued} This map doesn't apply proposals from sessions.` }
    if (input.kind === 'write-doc') return { text: `${queued} Docs to write always wait for the user in Manta.` }
    const applied = await caller.docs.maps.resolveSuggestion(caller.map, suggestion.id, true, null)
    if (!applied.ok) return { text: `Couldn't apply it (${applied.message}); it waits in Needs review for the user.` }
    await caller.docs.maps.appendJournal(caller.map, caller.launch.id, 'note', `Applied, as the user agreed in the session: ${applied.message}. ${input.why}`.trim())
    return { text: `Applied: ${applied.message}.` }
  }

  /**
   * An agent's question for the user goes on the map as an open decision at once, since deciding it
   * is the review. A session the user already decided it with (`confirmed_with_user`, on a map that
   * asks first) records it decided, with the outcome.
   */
  private async raiseDecision(caller: Caller, tracker: Tracker, args: Record<string, unknown>): Promise<ToolResult> {
    const text = (key: string): string => (typeof args[key] === 'string' ? String(args[key]).trim() : '')
    const title = text('title')
    if (!title) return { text: 'Give the decision a title', error: true }
    const blocks = Array.isArray(args['blocks']) ? args['blocks'].filter((id): id is string => typeof id === 'string') : []
    const unknown = blocks.filter((id) => !findTicket(tracker, id))
    if (unknown.length > 0) return { text: `No ticket ${unknown.join(', ')}; map_outline lists the ids`, error: true }
    const refs = Array.isArray(args['docs']) ? args['docs'].flatMap((ref: unknown) => parseDocRef(ref) ?? []) : []
    const outside = refs.filter((ref) => !cleanDocPath(ref.path))
    if (outside.length > 0) return { text: `${outside.map((ref) => ref.path).join(', ')} isn't a path in the docs repo`, error: true }
    const docs = refs.flatMap((ref) => {
      const clean = cleanDocPath(ref.path)
      return clean ? [{ path: clean, heading: ref.heading }] : []
    })
    const same = tracker.decisions.find((d) => d.status === 'open' && d.title.toLowerCase() === title.toLowerCase())
    if (same) return { text: `Decision ${decisionNumber(same)} “${same.title}” is already open; the user decides it on the map.` }
    let outcome = ''
    let left = ''
    if (text('outcome')) {
      if (args['confirmed_with_user'] !== true || caller.role !== 'session' || !caller.launch) left = ' The outcome was left out: only a session the user decided it with records one, with confirmed_with_user.'
      else if ((await caller.docs.maps.map(caller.map)).confirmProposals !== 'ask') left = " The outcome was left out: this map doesn't take decisions from sessions."
      else outcome = text('outcome')
    }
    const added = await caller.docs.maps.editTracker(caller.map, {
      kind: 'add-decision',
      title,
      question: text('question'),
      blocks,
      docs,
      options: decisionOptions(args['options']),
      input: decisionInput({ label: text('requires') }),
      outcome,
      from: author(caller)
    })
    if (!added.ok) return { text: added.message, error: true }
    const held = blocks.flatMap((id) => findTicket(tracker, id)?.ticket.title ?? []).map((t) => `“${t}”`)
    if (caller.launch) await caller.docs.maps.appendJournal(caller.map, caller.launch.id, outcome ? 'decision' : 'note', outcome ? `${added.message} “${title}”, with the user: ${outcome}` : `${added.message} “${title}” for the user${held.length > 0 ? `, blocking ${held.join(', ')}` : ''}.`)
    if (outcome) return { text: `${added.message} “${title}” as decided.` }
    const wait =
      caller.role === 'session'
        ? ' Manta sends you the outcome here once it is decided, if this session is still running. Until then go on with what it does not block, or report those tickets blocked.'
        : ''
    return { text: `${added.message} “${title}”${held.length > 0 ? `, blocking ${held.join(', ')}` : ''}. The user decides it on the map's Decisions page.${wait}${left}` }
  }

  private async docChange(name: string, caller: Caller, tracker: Tracker, args: Record<string, unknown>): Promise<ToolResult> {
    const fields = name === 'propose_doc_change' ? ['doc', 'find', 'replace', 'title', 'why'] : name === 'revise_doc_change' ? ['thread', 'find', 'replace', 'why'] : ['thread', 'why']
    const missing = fields.filter((field) => typeof args[field] !== 'string' || (field !== 'replace' && args[field] === ''))
    if (missing.length > 0) return { text: `Give ${missing.join(', ')} as text`, error: true }
    const text = (field: string): string => String(args[field])
    const mapFile = await caller.docs.maps.map(caller.map)
    const proposer: MapProposer = { map: caller.map, from: author(caller), title: caller.launch ? scopeTitle(tracker, caller.launch.scope) : mapFile.title }
    const label =
      caller.role === 'ask'
        ? `Ask the map “${mapFile.title}”`
        : `${caller.role === 'sweep' ? 'the sweep of' : 'the map session'} “${proposer.title}”${caller.launch?.branch ? ` (${caller.launch.branch})` : ''}`
    const by: ProposalAuthor = { ref: proposer, label }
    if (name === 'propose_doc_change') {
      const doc = text('doc').replace(/^\.?\//, '')
      const proposed = await caller.docs.threads.propose(doc, { find: text('find'), replace: text('replace'), title: text('title').slice(0, 80), why: text('why'), from: by })
      if (!proposed.ok) return { text: proposed.message, error: true }
      this.options.onProposal?.(caller.docsRoot, proposed.thread)
      return { text: `Proposed as the Manta thread ${proposed.thread.id} (“${proposed.thread.title}”) on ${doc}. The user reviews it in Manta; don't edit the doc yourself. Use this id to revise or withdraw it.` }
    }
    if (name === 'revise_doc_change') {
      const revised = await caller.docs.threads.revise(text('thread'), by, { find: text('find'), replace: text('replace'), why: text('why') })
      return revised.ok ? { text: `Revised the proposal ${revised.thread.id} on ${revised.thread.doc}.` } : { text: revised.message, error: true }
    }
    const withdrawn = await caller.docs.threads.withdraw(text('thread'), by, text('why'))
    return withdrawn.ok ? { text: `Withdrew the proposal ${withdrawn.thread.id} on ${withdrawn.thread.doc}.` } : { text: withdrawn.message, error: true }
  }

  // -------------------------------------------------------------------------------------------

  private async docsWorkspace(root: string): Promise<{ docsRoot: string; docs: Workspace }> {
    const { projects } = this.options
    const docsRoot = await projects.resolveRoot(root)
    if (!projects.list().some((p) => p.kind === 'docs' && p.root === docsRoot)) throw new Error(`${root} is not the docs repo`)
    return { docsRoot, docs: await projects.workspace(docsRoot) }
  }

  /** The launch with this scope whose work can go on: not landed, and its worktree still there. Groups always get a fresh one. */
  private async reusable(launches: readonly MapLaunch[], scope: LaunchScope): Promise<MapLaunch | null> {
    if ('tickets' in scope) return null
    for (const launch of [...launches].reverse()) {
      const same = 'milestone' in scope ? 'milestone' in launch.scope && launch.scope.milestone === scope.milestone : 'ticket' in launch.scope && launch.scope.ticket === scope.ticket
      if (!same || launch.landed) continue
      if (await realpath(launch.worktree).then(() => true, () => false)) return launch
    }
    return null
  }

  /** The code project to work in: the one asked for, the ticket's, the map's only one, or Manta's only one. Several and none asked for: `pick`. */
  private async pickProject(map: MapFile, tracker: Tracker, request: Pick<MapLaunchRequest, 'project' | 'scope'>, focus: string | null): Promise<{ root: string; name: string } | { pick: string[] } | null> {
    const code = this.options.projects.list().filter((p) => p.kind === 'code')
    if (request.project) {
      const chosen = code.find((p) => p.root === request.project)
      if (!chosen) throw new Error(`${request.project} is not a code project`)
      return chosen
    }
    const ticketId = focus ?? ('ticket' in request.scope ? request.scope.ticket : null)
    const named = ticketId ? findTicket(tracker, ticketId)?.ticket.project : null
    const fromTicket = named ? code.find((p) => p.name === named) : undefined
    if (fromTicket) return fromTicket
    const candidates = map.projects.length > 0 ? code.filter((p) => map.projects.includes(p.name)) : code
    if (candidates.length === 1 && candidates[0]) return candidates[0]
    if (candidates.length === 0) return null
    return { pick: candidates.map((p) => p.root) }
  }

  /** A worktree named after the scope; a taken name gets a number. */
  private async createWorktree(projectRoot: string, name: string): Promise<ProjectWorktree> {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= 20; attempt++) {
      try {
        return await this.options.projects.createWorktree(projectRoot, attempt === 1 ? name : `${name} ${attempt}`)
      } catch (error) {
        lastError = error
        if (!(error instanceof Error && error.message.includes('already exists'))) break
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private briefFile(launch: string, session: string): string {
    return path.join(this.options.briefsDir, `${launch}-${session}.md`)
  }

  private changed(docsRoot: string, map: string): void {
    this.options.onMapChanged?.(docsRoot, map)
    this.nudge(map)
  }
}

/** A board row's identity across looks: its launch and the ticket its session focuses on. */
function rowKey(row: BoardRow): string {
  return `${row.launch}/${row.ticket ?? ''}`
}

function author(caller: Caller): MapAuthor {
  if (caller.role === 'ask' || !caller.launch) return { ask: true }
  return caller.role === 'sweep' ? { sweep: caller.launch.id } : { launch: caller.launch.id }
}

/** Since its last start, no wrap-up and no sweep covered the launch's work. */
export function needsSweep(launch: MapLaunch): boolean {
  if (launch.sessions.length === 0) return false
  const lastStart = launch.sessions.map((s) => s.startedAt).sort().at(-1) ?? ''
  const covered = (at: string | null): boolean => at !== null && at >= lastStart
  return !covered(launch.wrappedUpAt) && !covered(launch.sweptAt)
}

function milestoneIds(value: unknown, tracker: Tracker): string[] {
  const ids = new Set(tracker.milestones.map((m) => m.id))
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && ids.has(id)) : []
}

function docRefs(value: unknown): { path: string; heading: string | null }[] {
  return Array.isArray(value) ? value.flatMap((doc) => parseDocRef(doc) ?? []) : []
}

function samePullRequest(a: PullRequestInfo | null, b: PullRequestInfo | null): boolean {
  return a?.number === b?.number && a?.state === b?.state && a?.url === b?.url
}

function sameHealth(a: PullRequestHealth | null, b: PullRequestHealth | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** What of a ticket a session reads: a change to any of it is worth a note. Status is left out, since the session sets it. */
function ticketPrint(ticket: MapTicket): string {
  return JSON.stringify([ticket.title, ticket.description, ticket.acceptance, ticket.after, ticket.docs])
}

/** A pull request's body from the launch's wrap-up: what happened, the criteria judged, and the trailer. */
export function pullRequestBody(tracker: Tracker, launch: MapLaunch): string {
  const tickets = launchTickets(tracker, launch.scope)
  const results = launch.wrapUp?.criteria ?? []
  const criteria = tickets.flatMap((ticket) =>
    ticket.acceptance.map((criterion, index) => {
      const result = results.find((r) => r.ticket === ticket.id && r.index === index)
      return `- [${result?.met ? 'x' : ' '}] ${criterion}${result?.evidence ? ` (${result.evidence})` : ''}`
    })
  )
  return [
    launch.wrapUp?.summary.trim() || `Work on ${scopeTitle(tracker, launch.scope)}.`,
    ...(criteria.length > 0 ? ['', '## Acceptance criteria', '', ...criteria] : []),
    '',
    `${LAUNCH_TRAILER}: ${launch.id}`
  ].join('\n')
}

/**
 * What of a review goes back to the session: unresolved, current review threads, and the summary
 * of each reviewer's latest review when it asked for changes.
 */
export function reviewFeedback(comments: readonly PullRequestComment[]): PullRequestComment[] {
  const latest = new Map<string, PullRequestComment>()
  for (const review of comments.filter((c) => c.kind === 'review' && c.verdict !== null && c.verdict !== 'commented').sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    latest.set(review.author, review)
  }
  const requests = [...latest.values()].filter((c) => c.verdict === 'changes requested' && c.body.trim())
  return [...comments.filter((c) => c.kind === 'thread' && !c.resolved && !c.outdated), ...requests]
}

/** A `propose_plan_change` item: flat fields, where an added ticket's are its own. */
function toolPlanChange(value: unknown): PlanChange | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if ('kind' in value && value.kind === 'add-ticket') {
    const ticket = parseProposedTicket({ ...value, docs: 'docs' in value ? docRefs(value.docs) : [] })
    return parsePlanChange({ kind: 'add-ticket', milestone: 'milestone' in value ? value.milestone : null, before: 'before' in value ? value.before : null, ticket })
  }
  return parsePlanChange('done_when' in value ? { ...value, doneWhen: value.done_when } : value)
}

/** Why a proposed change can't apply to the plan as it is; null when it can. */
function planChangeProblem(tracker: Tracker, change: PlanChange): string | null {
  const ticket = (id: string): string | null => (findTicket(tracker, id) ? null : `no ticket ${id}`)
  const milestone = (id: string): string | null => (tracker.milestones.some((m) => m.id === id) ? null : `no milestone ${id}`)
  switch (change.kind) {
    case 'update-ticket':
    case 'remove-ticket':
      return ticket(change.ticket)
    case 'move-ticket':
      return ticket(change.ticket) ?? milestone(change.milestone)
    case 'add-ticket':
      return milestone(change.milestone) ?? (change.ticket.title.trim() ? null : 'the new ticket has no title')
    case 'update-milestone':
    case 'move-milestone':
      return milestone(change.milestone)
  }
}

/** Commit subjects and a `--stat` of the branch since its base, for the sweep; empty when there's nothing. */
async function diffSummary(launch: MapLaunch): Promise<string> {
  if (!launch.base) return ''
  const git = new Git(launch.project)
  const log = await git.run(['log', '--format=%h %s', `${launch.base}..${launch.branch}`]).catch(() => '')
  const stat = await git.run(['diff', '--stat', `${launch.base}...${launch.branch}`]).catch(() => '')
  return [log.trim(), stat.trim()].filter(Boolean).join('\n\n')
}

/** The sweep may read and call the map tools, which are allowed already; it is never given anything else. */
async function denyAll(): Promise<PermissionDecision> {
  return 'deny'
}

const HEADING_LINE = /^(#{1,6})[ \t]+(.+?)\s*#*\s*$/

/** Each doc that exists, with its title (first `# ` heading) and the headings under it. */
async function docOutlines(docsRoot: string, paths: readonly string[]): Promise<MapDocOutline[]> {
  const outlines = await Promise.all(
    paths.map(async (docPath): Promise<MapDocOutline | null> => {
      const text = await readFile(path.join(docsRoot, docPath), 'utf8').catch(() => null)
      if (text === null) return null
      let inFence = false
      const headings: { level: number; text: string }[] = []
      for (const line of text.split('\n')) {
        if (/^(```|~~~)/.test(line)) inFence = !inFence
        const match = inFence ? null : HEADING_LINE.exec(line)
        if (match?.[1] && match[2]) headings.push({ level: match[1].length, text: match[2] })
      }
      const title = headings.find((h) => h.level === 1)?.text ?? path.basename(docPath, '.md')
      return { path: docPath, title, headings: headings.filter((h) => h.level > 1).map((h) => h.text) }
    })
  )
  return outlines.flatMap((o) => o ?? [])
}
