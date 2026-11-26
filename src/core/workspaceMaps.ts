import { access as fsAccess, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  DocRef,
  MapAuthor,
  MapBatch,
  MapDetail,
  MapDoc,
  MapDocProposal,
  MapDocsEdit,
  MapEvent,
  MapLaunch,
  MapSettings,
  MapSuggestion,
  MapSummary,
  NewMapInput,
  OpResult,
  PermissionDecision,
  SuggestionResult,
  ThreadEvent,
  ThreadMessage,
  TicketStatus,
  TrackerEdit
} from '../shared/ipc'
import { ticketProgress } from '../shared/ipc'
import type { McpAccess, ThreadAgent } from './agent/threadAgent'
import { askSystemPrompt, breakDownPrompt, mapOutline } from './maps/mapBrief'
import { migrateLegacy, parseLegacyMap } from './maps/mapMigration'
import {
  addProposedMilestones,
  applyDocsEdit,
  applyPlanChange,
  applySettings,
  applyTrackerEdit,
  cleanDocPath,
  currentMilestone,
  EMPTY_TRACKER,
  findTicket,
  LAUNCH_MODES,
  MAP_ID,
  mapKey,
  mapPath,
  mapStage,
  milestoneInfos,
  newMapId,
  newSuggestionId,
  removeMilestone,
  removeTicket,
  setTicketStatuses,
  updateMilestone,
  type MapFile,
  type Tracker
} from './maps/mapModel'
import { backfillEvents, event, launchEvents, suggestionEvent, trackerEvents } from './maps/mapActivity'
import { MapStore } from './maps/mapStore'
import { ThreadTurns, type PreparedTurn } from './threadTurns'
import { ThreadRecordStore } from './threads/threadRecords'
import type { WorkspaceAccess } from './workspaceThreads'

export interface MapOptions {
  /** Where each map agent's folder (its working directory) is created. */
  mapsDir?: string
  agent?: ThreadAgent
  onMapEvent?: (id: string, event: ThreadEvent) => void
  /** Every code project, by the names maps use for them. */
  codeProjects?: () => readonly { name: string; root: string }[]
  /** Manta's MCP endpoint for Ask the map's agent; null when it isn't running (tests without terminals). */
  mapAgentMcp?: (map: string) => McpAccess | null
}

/** Ask the map's checkout: the map's outline, which it reads but never edits. */
const OUTLINE_FILE = 'map.md'

/** What a map's agent suggests; `id`, `from` and `at` are filled in. */
export type SuggestionInput =
  | { kind: 'add-doc'; path: string; why: string; milestones: string[] }
  | { kind: 'write-doc'; title: string; why: string; milestones: string[] }
  | { kind: 'plan'; why: string; milestones: Extract<MapSuggestion, { kind: 'plan' }>['milestones'] }
  | { kind: 'ticket'; milestone: string; ticket: Extract<MapSuggestion, { kind: 'ticket' }>['ticket']; why: string }
  | { kind: 'plan-change'; changes: Extract<MapSuggestion, { kind: 'plan-change' }>['changes']; why: string }

/**
 * The context maps of one docs repo (`workspace.maps`): their settings, docs and sections, the
 * tracker, launches and journals as stored, suggestions waiting for review, and Ask the map's agent.
 * Launching work lives in `MapLaunches`, which composes this with the terminals.
 */
export class WorkspaceMaps {
  private readonly store: MapStore
  private readonly records: ThreadRecordStore
  private readonly turns: ThreadTurns
  private migrated: Promise<void> | null = null

  constructor(
    private readonly access: WorkspaceAccess,
    mantaDir: string,
    private readonly options: MapOptions
  ) {
    this.store = new MapStore(access.repoRoot, path.join(mantaDir, 'maps'))
    this.records = new ThreadRecordStore(access.repoRoot)
    this.turns = new ThreadTurns(
      {
        begin: (_relPath, id, text, mapsDir) => this.beginTurn(id, text, mapsDir),
        absorbCheckout: async () => false,
        saveSession: (id, session) => this.access.serial(async () => this.store.saveState(id, { ...(await this.store.state(id)), session })),
        finish: (_relPath, id, transcript) => this.finishTurn(id, transcript)
      },
      {
        ...(options.agent ? { agent: options.agent } : {}),
        ...(options.mapsDir ? { threadsDir: options.mapsDir } : {}),
        onThreadEvent: (_relPath, id, event) => options.onMapEvent?.(id, event)
      }
    )
  }

  async list(): Promise<MapSummary[]> {
    await this.migrate()
    const summaries: MapSummary[] = []
    for (const map of await this.store.list()) summaries.push(await this.summary(map))
    return summaries
  }

  async get(id: string): Promise<MapDetail> {
    await this.migrate()
    const map = await this.requireMap(id)
    const tracker = await this.store.tracker(id)
    const launches = await this.store.launches(id)
    const milestones = milestoneInfos(tracker, launches)
    const state = await this.store.state(id)
    const activity = await this.activity(id)
    return {
      ...(await this.summary(map)),
      key: mapKey(map),
      stage: mapStage(map, tracker, launches),
      stageSet: map.stage,
      lastVisitedAt: state.lastVisitedAt,
      seenAt: state.seenAt,
      activity,
      projects: map.projects,
      launchMode: map.launchMode,
      sweep: map.sweep,
      confirmProposals: map.confirmProposals,
      pinned: map.pinned,
      checks: map.checks,
      docs: await Promise.all(map.docs.map(async (doc) => ({ ...doc, ...(doc.link ? { exists: true, title: doc.link.title, updatedAt: null } : await this.docTitle(doc.path)) }))),
      sections: map.sections,
      milestones,
      decisions: tracker.decisions,
      launches,
      batches: await this.store.batches(id),
      suggestions: await this.store.suggestions(id),
      proposals: await this.proposals(id),
      messages: state.messages
    }
  }

  /**
   * The user opened the map. "Since your last visit" counts from the visit before this one; opening it
   * again within half an hour is the same visit.
   */
  /** The user has seen the map's activity so far. */
  markSeen(id: string): Promise<void> {
    return this.access.serial(async () => {
      await this.requireMap(id)
      const state = await this.store.state(id)
      await this.store.saveState(id, { ...state, seenAt: new Date().toISOString() })
    })
  }

  visit(id: string): Promise<void> {
    return this.access.serial(async () => {
      await this.requireMap(id)
      const state = await this.store.state(id)
      const now = new Date()
      const sameVisit = state.visitedAt !== null && now.getTime() - Date.parse(state.visitedAt) < SAME_VISIT_MS
      await this.store.saveState(id, { ...state, lastVisitedAt: sameVisit ? state.lastVisitedAt : state.visitedAt, visitedAt: now.toISOString() })
    })
  }

  async create(input: NewMapInput): Promise<MapSummary> {
    const title = input.title.replace(/\s+/g, ' ').trim()
    if (!title) throw new Error('Give the map a title')
    const map: MapFile = {
      version: 2,
      id: newMapId(),
      title,
      description: input.description.trim(),
      createdAt: new Date().toISOString(),
      projects: [...new Set(input.projects)],
      launchMode: LAUNCH_MODES.includes(input.launchMode) ? input.launchMode : 'ticket',
      sweep: true,
      confirmProposals: 'ask',
      pinned: null,
      checks: [],
      docs: [],
      sections: [],
      key: null,
      stage: null
    }
    await this.access.serial(async () => {
      await this.store.writeTracker(map.id, EMPTY_TRACKER)
      await this.store.writeMap(map)
    })
    return this.summary(map)
  }

  update(id: string, settings: MapSettings): Promise<OpResult> {
    return this.access.serial(async () => {
      const map = await this.requireMap(id)
      const tracker = await this.store.tracker(id)
      const result = applySettings(map, settings, new Set(tracker.milestones.map((m) => m.id)))
      if (!result.ok) return result
      await this.store.writeMap(result.value)
      return { ok: true, message: result.message }
    })
  }

  /** Deletes the map after `confirm` agrees; null when it doesn't. Its docs, worktrees and branches stay. */
  async remove(id: string, confirm: (map: MapFile) => Promise<boolean>): Promise<OpResult | null> {
    const map = await this.requireMap(id)
    if (!(await confirm(map))) return null
    this.turns.cancel(id)
    await this.access.serial(() => this.store.remove(id))
    return { ok: true, message: `Removed the map ${map.title}` }
  }

  editTracker(id: string, edit: TrackerEdit): Promise<OpResult> {
    return this.changeTracker(id, (tracker) => applyTrackerEdit(tracker, edit))
  }

  /**
   * Removes a ticket or milestone. `confirm` is asked first when the ticket has launches, or the
   * milestone has tickets or launches; null when it says no.
   */
  async removeFromTracker(id: string, target: { ticket: string } | { milestone: string }, confirm: (question: string) => Promise<boolean>): Promise<OpResult | null> {
    const tracker = await this.store.tracker(id)
    const launches = await this.store.launches(id)
    if ('ticket' in target) {
      const found = findTicket(tracker, target.ticket)
      if (!found) return { ok: false, message: 'That ticket is gone' }
      const launched = launches.some((launch) => ('ticket' in launch.scope && launch.scope.ticket === target.ticket) || ('tickets' in launch.scope && launch.scope.tickets.includes(target.ticket)))
      const question = `Delete the ticket “${found.ticket.title}”? It can't be brought back; cancel it instead to keep it on the map.${launched ? ' Work was launched on it; its worktree, branch and journal stay.' : ''}`
      if (!(await confirm(question))) return null
      return this.changeTracker(id, (current) => ({ ok: true, value: removeTicket(current, target.ticket), message: `Deleted ${found.ticket.title}` }))
    }
    const milestone = tracker.milestones.find((m) => m.id === target.milestone)
    if (!milestone) return { ok: false, message: 'That milestone is gone' }
    const launched = launches.some((launch) => 'milestone' in launch.scope && launch.scope.milestone === milestone.id)
    if ((milestone.tickets.length > 0 || launched) && !(await confirm(`Delete the milestone “${milestone.title}”${milestone.tickets.length > 0 ? ` and its ${milestone.tickets.length} tickets` : ''}?`))) return null
    const result = await this.changeTracker(id, (current) => ({ ok: true, value: removeMilestone(current, milestone.id), message: `Deleted ${milestone.title}` }))
    if (result.ok) await this.access.serial(async () => {
      const map = await this.requireMap(id)
      await this.store.writeMap({ ...map, pinned: map.pinned === milestone.id ? null : map.pinned, docs: map.docs.map((doc) => ({ ...doc, milestones: doc.milestones.filter((m) => m !== milestone.id) })) })
    })
    return result
  }

  editDocs(id: string, edit: MapDocsEdit): Promise<OpResult> {
    return this.access.serial(async () => {
      const map = await this.requireMap(id)
      const tracker = await this.store.tracker(id)
      const result = applyDocsEdit(map, edit, new Set(tracker.milestones.map((m) => m.id)))
      if (!result.ok) return result
      await this.store.writeMap(result.value)
      return { ok: true, message: result.message }
    })
  }

  /** Creates a doc in the docs repo (refused when it exists), headed by `title` or else its file name, and lists it on the map. Returns its path. */
  async createDoc(id: string, doc: MapDoc, title?: string): Promise<string> {
    const cleaned = cleanDocPath(doc.path.endsWith('.md') ? doc.path : `${doc.path}.md`)
    if (!cleaned) throw new Error(`${doc.path} isn't a path in the docs repo`)
    await this.access.serial(async () => {
      await this.requireMap(id)
      const absolute = path.join(this.access.repoRoot, cleaned)
      if (await this.docExists(cleaned)) throw new Error(`${cleaned} already exists`)
      await mkdir(path.dirname(absolute), { recursive: true })
      await writeFile(absolute, `# ${title?.trim() || path.basename(cleaned, '.md')}\n`)
    })
    const added = await this.editDocs(id, { kind: 'add-doc', path: cleaned, milestones: doc.milestones, section: doc.section })
    if (!added.ok) throw new Error(added.message)
    return cleaned
  }

  // -------------------------------------------------------------------------------------------
  // Suggestions and Needs review

  async suggest(id: string, input: SuggestionInput, from: MapAuthor): Promise<MapSuggestion> {
    return this.access.serial(async () => {
      await this.requireMap(id)
      const suggestion: MapSuggestion = { ...input, id: newSuggestionId(), from, at: new Date().toISOString() }
      await this.log(id, [suggestionEvent('suggestion', suggestion, suggestion.at)])
      await this.store.writeSuggestions(id, [...(await this.store.suggestions(id)), suggestion])
      return suggestion
    })
  }

  /**
   * Accepts or dismisses a suggestion. Accepting adds the doc, creates the doc worth writing (its
   * path is returned), adds the proposed milestones or ticket, or applies the plan changes (`pick`:
   * which milestones or changes, by index). Plan changes that no longer apply are skipped and named.
   */
  async resolveSuggestion(id: string, suggestionId: string, accept: boolean, pick: readonly number[] | null): Promise<SuggestionResult> {
    const suggestion = (await this.store.suggestions(id)).find((s) => s.id === suggestionId)
    if (!suggestion) return { ok: false, message: 'That suggestion is gone' }
    let doc: string | null = null
    let message = 'Dismissed'
    if (accept) {
      if (suggestion.kind === 'add-doc') {
        const added = await this.editDocs(id, { kind: 'add-doc', path: suggestion.path, milestones: suggestion.milestones, section: null })
        if (!added.ok) return added
        message = added.message
      } else if (suggestion.kind === 'write-doc') {
        const map = await this.requireMap(id)
        doc = await this.createDoc(id, { path: `${slug(map.title)}/${slug(suggestion.title) || 'untitled'}.md`, milestones: suggestion.milestones, section: null, roles: [] }, suggestion.title)
        message = `Created ${doc}`
      } else if (suggestion.kind === 'plan') {
        const chosen = pick === null ? suggestion.milestones : suggestion.milestones.filter((_, index) => pick.includes(index))
        if (chosen.length === 0) return { ok: false, message: 'Pick at least one milestone' }
        const { projects } = await this.requireMap(id)
        const result = await this.changeTracker(id, (tracker) => ({ ok: true, value: addProposedMilestones(tracker, chosen, projects), message: `Added ${chosen.length} milestone${chosen.length === 1 ? '' : 's'}` }))
        if (!result.ok) return result
        message = result.message
      } else if (suggestion.kind === 'ticket') {
        const { projects } = await this.requireMap(id)
        const result = await this.changeTracker(id, (tracker) =>
          applyPlanChange(tracker, { kind: 'add-ticket', milestone: suggestion.milestone, before: null, ticket: suggestion.ticket }, projects)
        )
        if (!result.ok) return result
        message = result.message
      } else {
        const chosen = pick === null ? suggestion.changes : suggestion.changes.filter((_, index) => pick.includes(index))
        if (chosen.length === 0) return { ok: false, message: 'Pick at least one change' }
        const { projects } = await this.requireMap(id)
        const skipped: string[] = []
        const result = await this.changeTracker(id, (tracker) => {
          let next = tracker
          for (const change of chosen) {
            const applied = applyPlanChange(next, change, projects)
            if (applied.ok) next = applied.value
            else skipped.push(applied.message)
          }
          const done = chosen.length - skipped.length
          if (done === 0) return { ok: false, message: `Nothing applied: ${skipped.join('; ')}` }
          return { ok: true, value: next, message: `Applied ${done} change${done === 1 ? '' : 's'}${skipped.length > 0 ? `; skipped ${skipped.length}: ${skipped.join('; ')}` : ''}` }
        })
        if (!result.ok) return result
        message = result.message
      }
    }
    await this.access.serial(async () => {
      await this.log(id, [suggestionEvent(accept ? 'suggestion-accepted' : 'suggestion-dismissed', suggestion, new Date().toISOString())])
      await this.store.writeSuggestions(id, (await this.store.suggestions(id)).filter((s) => s.id !== suggestionId))
    })
    return { ok: true, message, doc }
  }

  /**
   * The map's activity, newest first: its log (backfilled the first time) and the doc changes its
   * agents proposed, read from their thread records, which outlive the proposal.
   */
  private async activity(id: string): Promise<MapEvent[]> {
    const logged =
      (await this.store.activity(id)) ??
      (await this.access.serial(async () => {
        await this.ensureLog(id)
        return (await this.store.activity(id)) ?? []
      }))
    const proposed = (await this.records.list())
      .filter((record) => record.proposedByMap?.map === id)
      .map((record) => {
        const from = record.proposedByMap?.from
        return event({ kind: 'doc-change-proposed', at: record.createdAt, title: record.title, detail: record.proposedByMap?.title ?? '', doc: record.doc, thread: record.id, launch: from && 'launch' in from ? from.launch : from && 'sweep' in from ? from.sweep : null })
      })
    return [...logged, ...proposed].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_SHOWN)
  }

  /** Writes the backfill for a map without a log yet. Callers are on the serial queue. */
  private async ensureLog(id: string): Promise<void> {
    if ((await this.store.activity(id)) !== null) return
    await this.store.appendActivity(id, backfillEvents(await this.store.tracker(id), await this.store.launches(id), await this.store.suggestions(id)))
  }

  /** Appends events to the map's log, backfilling it first when it has none. Callers are on the serial queue. */
  private async log(id: string, events: readonly MapEvent[]): Promise<void> {
    await this.ensureLog(id)
    if (events.length > 0) await this.store.appendActivity(id, events)
  }

  /** Open doc threads proposed by this map's agents. */
  private async proposals(id: string): Promise<MapDocProposal[]> {
    return (await this.records.list())
      .filter((record) => record.status === 'open' && record.proposedByMap?.map === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((record) => (record.proposedByMap ? [{ thread: record.id, doc: record.doc, title: record.title, from: record.proposedByMap.from }] : []))
  }

  // -------------------------------------------------------------------------------------------
  // Launches, statuses and journals, for `MapLaunches` and the map tools

  async map(id: string): Promise<MapFile> {
    return this.requireMap(id)
  }

  tracker(id: string): Promise<Tracker> {
    return this.store.tracker(id)
  }

  launches(id: string): Promise<MapLaunch[]> {
    return this.store.launches(id)
  }

  /** Changes one launch (or adds it, when `change` is given none) on the serial queue; returns it. */
  saveLaunch(id: string, launchId: string, change: (launch: MapLaunch | null) => MapLaunch): Promise<MapLaunch> {
    return this.access.serial(async () => {
      const launches = await this.store.launches(id)
      const before = launches.find((l) => l.id === launchId) ?? null
      const next = change(before)
      await this.log(id, launchEvents(await this.store.tracker(id), before, next, new Date().toISOString()))
      await this.store.writeLaunches(id, launches.some((l) => l.id === launchId) ? launches.map((l) => (l.id === launchId ? next : l)) : [...launches, next])
      return next
    })
  }

  batches(id: string): Promise<MapBatch[]> {
    return this.store.batches(id)
  }

  /** Changes one batch (or adds it, when `change` is given none) on the serial queue; returns it. */
  saveBatch(id: string, batchId: string, change: (batch: MapBatch | null) => MapBatch): Promise<MapBatch> {
    return this.access.serial(async () => {
      const batches = await this.store.batches(id)
      const next = change(batches.find((b) => b.id === batchId) ?? null)
      await this.store.writeBatches(id, batches.some((b) => b.id === batchId) ? batches.map((b) => (b.id === batchId ? next : b)) : [...batches, next])
      return next
    })
  }

  /** Forgets a launch whose session never started. */
  dropLaunch(id: string, launchId: string): Promise<void> {
    return this.access.serial(async () => this.store.writeLaunches(id, (await this.store.launches(id)).filter((l) => l.id !== launchId)))
  }

  /** Sets ticket statuses as events happen (no approval). `keepDone` leaves done tickets done. */
  setStatuses(id: string, tickets: readonly string[], status: TicketStatus, options: { reason?: string; keepDone?: boolean } = {}): Promise<OpResult> {
    if (tickets.length === 0) return Promise.resolve({ ok: true, message: 'Nothing to change' })
    return this.changeTracker(id, (tracker) => ({ ok: true, value: setTicketStatuses(tracker, tickets, status, options), message: 'Status set' }))
  }

  /** A milestone's own branch landed; its hand-set status gives way. */
  markMilestoneLanded(id: string, milestone: string): Promise<OpResult> {
    return this.changeTracker(id, (tracker) => ({ ok: true, value: updateMilestone(tracker, milestone, (m) => ({ ...m, landed: true, manual: null })), message: 'Landed' }))
  }

  /** A launch of the milestone started: its hand-set status gives way. */
  clearManual(id: string, milestone: string): Promise<OpResult> {
    return this.changeTracker(id, (tracker) => ({ ok: true, value: updateMilestone(tracker, milestone, (m) => ({ ...m, manual: null })), message: 'Cleared' }))
  }

  journal(id: string, launch: string): Promise<string> {
    return this.store.journal(id, launch)
  }

  async appendJournal(id: string, launch: string, kind: string, text: string): Promise<void> {
    const entry = `- ${new Date().toISOString()} **${kind}**: ${text.trim().replace(/\n+/g, ' ')}\n`
    await this.access.serial(() => this.store.appendJournal(id, launch, entry))
  }

  async outline(id: string): Promise<string> {
    const map = await this.requireMap(id)
    const tracker = await this.store.tracker(id)
    const milestones = milestoneInfos(tracker, await this.store.launches(id))
    return mapOutline(map, milestones, currentMilestone(milestones, map.pinned)?.id ?? null, tracker.decisions)
  }

  /** The docs listed for a milestone or a section (or all of them), as paths. */
  async docsFor(id: string, filter: { milestone?: string; section?: string }): Promise<DocRef[]> {
    const map = await this.requireMap(id)
    return map.docs
      .filter((doc) => !doc.link && (filter.milestone === undefined || doc.milestones.includes(filter.milestone)) && (filter.section === undefined || doc.section === filter.section))
      .map((doc) => ({ path: doc.path, heading: null }))
  }

  codeProjects(): readonly { name: string; root: string }[] {
    return this.options.codeProjects?.() ?? []
  }

  // -------------------------------------------------------------------------------------------
  // Ask the map

  /** One turn of Ask the map. Resolves when it ends; progress goes out through `onMapEvent`. */
  async send(id: string, text: string): Promise<OpResult> {
    await this.requireMap(id)
    return this.turns.send(mapPath(id, OUTLINE_FILE), id, text)
  }

  /** Asks the map agent to propose milestones and tickets from `docs` (the map's docs when empty). */
  async breakDown(id: string, docs: readonly string[]): Promise<OpResult> {
    const map = await this.requireMap(id)
    return this.send(id, breakDownPrompt(docs, map.projects))
  }

  running(id: string): boolean {
    return this.turns.running(id)
  }

  cancel(id: string): boolean {
    return this.turns.cancel(id)
  }

  answerPermission(id: string, requestId: string, decision: PermissionDecision): boolean {
    return this.turns.answerPermission(id, requestId, decision)
  }

  close(): void {
    this.turns.close()
  }

  private beginTurn(id: string, text: string, mapsDir: string): Promise<PreparedTurn> {
    return this.access.serial(async () => {
      const map = await this.requireMap(id)
      const state = await this.store.state(id)
      const dir = path.join(mapsDir, id)
      const file = path.join(dir, OUTLINE_FILE)
      await mkdir(dir, { recursive: true })
      await writeFile(file, await this.outline(id))
      await this.store.saveState(id, { ...state, messages: [...state.messages, { role: 'user', text, at: new Date().toISOString() }] })
      const projects = this.codeProjects().filter((p) => map.projects.includes(p.name))
      return {
        file,
        dir,
        realDir: await realpath(dir),
        session: state.session,
        context: {
          repoRoot: this.access.repoRoot,
          map: { id, title: map.title, prompt: askSystemPrompt(map, this.access.repoRoot, projects, OUTLINE_FILE) },
          mcp: this.options.mapAgentMcp?.(id) ?? null
        }
      }
    })
  }

  private finishTurn(id: string, transcript: readonly ThreadMessage[]): Promise<void> {
    return this.access.serial(async () => {
      if (!(await this.store.map(id))) return
      const state = await this.store.state(id)
      await this.store.saveState(id, { ...state, messages: [...state.messages, ...transcript] })
    })
  }

  // -------------------------------------------------------------------------------------------

  private async summary(map: MapFile): Promise<MapSummary> {
    const tracker = await this.store.tracker(map.id)
    const launches = await this.store.launches(map.id)
    const milestones = milestoneInfos(tracker, launches)
    const current = currentMilestone(milestones, map.pinned)
    const blocked = tracker.milestones.flatMap((m) => m.tickets).filter((t) => t.status === 'blocked').length
    const prs = launches.filter((l) => !l.landed && l.pr?.state === 'open').length
    const ready = launches.filter((l) => !l.landed && l.readyAt !== null && l.pr === null).length
    return {
      id: map.id,
      title: map.title,
      description: map.description,
      createdAt: map.createdAt,
      current: current ? { id: current.id, title: current.title, ...ticketProgress(current.tickets) } : null,
      waiting: (await this.store.suggestions(map.id)).length + (await this.proposals(map.id)).length + blocked + prs + ready,
      running: this.turns.running(map.id)
    }
  }

  private changeTracker(id: string, change: (tracker: Tracker) => { ok: true; value: Tracker; message: string } | { ok: false; message: string }): Promise<OpResult> {
    return this.access.serial(async () => {
      await this.requireMap(id)
      const before = await this.store.tracker(id)
      const result = change(before)
      if (!result.ok) return result
      await this.log(id, trackerEvents(before, result.value, await this.store.launches(id), new Date().toISOString()))
      await this.store.writeTracker(id, result.value)
      return { ok: true, message: result.message }
    })
  }

  /** Converts maps from before v2 the first time the maps are listed; the old `map.md` is kept as `map.v1.md`. */
  private migrate(): Promise<void> {
    this.migrated ??= this.access
      .serial(async () => {
        for (const id of await this.store.ids()) {
          if (await this.store.map(id)) continue
          const legacy = parseLegacyMap(await this.store.raw(id))
          if (!legacy || legacy.id !== id) {
            console.error(`manta: skipping unreadable context map ${id}`)
            continue
          }
          await this.store.writeMap(migrateLegacy(legacy, await this.store.text(id, 'map.md')))
          await this.store.writeTracker(id, EMPTY_TRACKER)
          await this.store.keepAs(id, 'map.md', 'map.v1.md')
        }
        for (const id of await this.store.ids()) await this.store.moveLocalJournals(id)
      })
      .catch((error: unknown) => {
        this.migrated = null
        throw error
      })
    return this.migrated
  }

  /** Never migrates: it runs inside `serial`. `list` and `get` migrate first, and come before anything else. */
  private async requireMap(id: string): Promise<MapFile> {
    const map = MAP_ID.test(id) ? await this.store.map(id) : null
    if (!map) throw new Error(`No context map ${id}`)
    return map
  }

  /** A doc's text as it stands: the open doc's, else the file's. Null when it isn't in the docs repo. */
  async docText(relPath: string): Promise<string | null> {
    const clean = cleanDocPath(relPath)
    if (!clean) return null
    for (const doc of this.access.docs()) if (doc.relPath === clean) return doc.text.toString()
    return readFile(path.join(this.access.repoRoot, clean), 'utf8').catch(() => null)
  }

  /** Whether the doc is there, its title (its first `# ` heading, else its file name), and when its file last changed. */
  private async docTitle(relPath: string): Promise<{ exists: boolean; title: string; updatedAt: string | null }> {
    const fallback = path.basename(relPath, '.md')
    const clean = cleanDocPath(relPath)
    if (!clean) return { exists: false, title: fallback, updatedAt: null }
    const file = path.join(this.access.repoRoot, clean)
    const text = await this.docText(clean)
    const updatedAt = await stat(file).then((s) => s.mtime.toISOString(), () => null)
    const heading = text ? /^#[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]?.trim() : undefined
    return { exists: text !== null, title: heading || fallback, updatedAt }
  }

  private async docExists(relPath: string): Promise<boolean> {
    const clean = cleanDocPath(relPath)
    if (!clean) return false
    for (const doc of this.access.docs()) if (doc.relPath === clean) return true
    return fsAccess(path.join(this.access.repoRoot, clean)).then(
      () => true,
      () => false
    )
  }
}

/** How many events the map's detail carries; the page shows the newest. */
const ACTIVITY_SHOWN = 300
const SAME_VISIT_MS = 30 * 60 * 1000

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
