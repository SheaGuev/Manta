import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type {
  CheckRun,
  ConfirmProposals,
  DecisionInput,
  DecisionOption,
  DecisionStatus,
  DocLink,
  DocRole,
  DoneItem,
  MapDecision,
  MapStage,
  MapBatch,
  ProgressNeed,
  ProgressPhase,
  SessionProgress,
  CriterionResult,
  DocRef,
  LaunchMode,
  LaunchScope,
  LaunchSession,
  LaunchWrapUp,
  MapAuthor,
  MapDoc,
  MapLaunch,
  MapMilestone,
  MapMilestoneInfo,
  MapProjectChecks,
  MapSection,
  MapSettings,
  MapDocsEdit,
  MapSuggestion,
  MapTicket,
  MilestoneStatus,
  OpResult,
  PlanChange,
  ProposedMilestone,
  ProposedTicket,
  PullRequestDetail,
  PullRequestHealth,
  PullRequestInfo,
  TicketStatus,
  TrackerEdit
} from '../../shared/ipc'
import { MANTA_DIR } from '../threads/threadRecords'
import { parseMapAuthor } from '../threads/threads'

export const MAPS_DIR = path.join(MANTA_DIR, 'maps')
export const MAP_ID = /^m_[0-9a-f]+$/
export const LAUNCH_ID = /^l_[0-9a-f]+$/
export const BATCH_ID = /^b_[0-9a-f]{6,32}$/
export const PROGRESS_PHASES: readonly ProgressPhase[] = ['exploring', 'building', 'verifying', 'finishing']
const NEED_KINDS: readonly ProgressNeed['kind'][] = ['decision', 'review', 'unblock']

/** `map.json`: what the map is, its docs and sections. Shared later with `.manta/`, so nothing in it is machine-specific. */
export interface MapFile {
  version: 2
  id: string
  title: string
  description: string
  createdAt: string
  /** Code projects by name. */
  projects: string[]
  launchMode: LaunchMode
  sweep: boolean
  confirmProposals: ConfirmProposals
  pinned: string | null
  /** Per code project, the commands that verify work in it. */
  checks: MapProjectChecks[]
  docs: MapDoc[]
  sections: MapSection[]
  /** Prefix of ticket keys; null to derive it from the title. */
  key: string | null
  /** Set by hand; null to work it out from the tracker. */
  stage: MapStage | null
}

/** `tracker.json`: the milestones in order, each with its tickets, the decisions, and the next numbers to give out. */
export interface Tracker {
  milestones: MapMilestone[]
  decisions: MapDecision[]
  nextTicket: number
  nextDecision: number
}

export const EMPTY_TRACKER: Tracker = { milestones: [], decisions: [], nextTicket: 1, nextDecision: 1 }

export const TICKET_STATUSES: readonly TicketStatus[] = ['todo', 'in-progress', 'blocked', 'in-review', 'done']
export const MILESTONE_STATUSES: readonly MilestoneStatus[] = ['todo', 'in-progress', 'done']
export const LAUNCH_MODES: readonly LaunchMode[] = ['ticket', 'milestone']
export const CONFIRM_MODES: readonly ConfirmProposals[] = ['ask', 'queue']
export const MAP_STAGES: readonly MapStage[] = ['planning', 'building', 'validating', 'shipped']
export const DOC_ROLES: readonly DocRole[] = ['product', 'design', 'technical', 'decision', 'release']
export const DECISION_STATUSES: readonly DecisionStatus[] = ['open', 'decided', 'superseded']
export const MAP_KEY = /^[A-Z][A-Z0-9]{0,5}$/

const hex = (bytes: number): string => randomBytes(bytes).toString('hex')
export const newMapId = (): string => `m_${hex(6)}`
export const newMilestoneId = (): string => `ms_${hex(5)}`
export const newTicketId = (): string => `tk_${hex(5)}`
export const newSectionId = (): string => `sec_${hex(4)}`
export const newLaunchId = (): string => `l_${hex(5)}`
export const newSuggestionId = (): string => `sg_${hex(5)}`
export const newDecisionId = (): string => `dc_${hex(5)}`
/** A link doc's key: `:` keeps it apart from the docs repo's files, which `cleanDocPath` maps without one. */
export const newLinkKey = (): string => `link:${hex(4)}`

/** A file of map `id` as a path inside the docs repo, `/`-separated like git's. */
export function mapPath(id: string, file: string): string {
  return [MANTA_DIR, 'maps', id, file].join('/')
}

// ---------------------------------------------------------------------------------------------
// Guards for the stored files: anything unexpected reads as absent, never as a crash.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

export function parseMapFile(value: unknown): MapFile | null {
  if (!isObject(value) || value.version !== 2) return null
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.createdAt !== 'string') return null
  const launchMode = LAUNCH_MODES.find((mode) => mode === value.launchMode) ?? 'ticket'
  const sections = Array.isArray(value.sections) ? value.sections.flatMap((section) => (isObject(section) && typeof section.id === 'string' && typeof section.title === 'string' ? [{ id: section.id, title: section.title }] : [])) : []
  const docs = Array.isArray(value.docs)
    ? value.docs.flatMap((doc): MapDoc[] => {
        if (!isObject(doc) || typeof doc.path !== 'string') return []
        const link = parseDocLink(doc.link)
        return [{ path: doc.path, milestones: strings(doc.milestones), section: strOrNull(doc.section), roles: docRoles(doc.roles), ...(link ? { link } : {}) }]
      })
    : []
  const checks = Array.isArray(value.checks)
    ? value.checks.flatMap((entry) => (isObject(entry) && typeof entry.project === 'string' ? [{ project: entry.project, commands: strings(entry.commands) }] : []))
    : []
  return {
    version: 2,
    id: value.id,
    title: value.title,
    description: str(value.description),
    createdAt: value.createdAt,
    projects: strings(value.projects),
    launchMode,
    sweep: value.sweep !== false,
    confirmProposals: CONFIRM_MODES.find((mode) => mode === value.confirmProposals) ?? 'ask',
    pinned: strOrNull(value.pinned),
    checks,
    docs,
    sections,
    key: typeof value.key === 'string' && MAP_KEY.test(value.key) ? value.key : null,
    stage: MAP_STAGES.find((stage) => stage === value.stage) ?? null
  }
}

/** A stored link: an http or https address and a title; anything else reads as no link. */
export function parseDocLink(value: unknown): DocLink | null {
  if (!isObject(value) || typeof value.url !== 'string' || typeof value.title !== 'string') return null
  const url = webAddress(value.url)
  const title = cleanTitle(value.title)
  return url && title ? { url, title } : null
}

/** The address when it's an http or https URL, else null. */
export function webAddress(value: string): string | null {
  const trimmed = value.trim()
  if (!URL.canParse(trimmed)) return null
  const url = new URL(trimmed)
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}

export function docRoles(value: unknown): DocRole[] {
  return DOC_ROLES.filter((role) => strings(value).includes(role))
}

/** The key a map's tickets show: its own, else the first letters of its title (`Omni` → `OMN`). */
export function mapKey(map: Pick<MapFile, 'key' | 'title'>): string {
  if (map.key) return map.key
  const letters = map.title.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim()
  const words = letters.split(/\s+/).filter(Boolean)
  const derived = words.length > 2 ? words.map((w) => w[0]).join('').slice(0, 4) : (words[0] ?? '').slice(0, 3)
  return /^[A-Z]/.test(derived) ? derived : 'TK'
}

/** The stage set by hand, else: planning until work starts, building while any is open, validating once every ticket is in review or done, shipped once all are accepted. */
export function mapStage(map: Pick<MapFile, 'stage'>, tracker: Tracker, launches: readonly MapLaunch[]): MapStage {
  if (map.stage) return map.stage
  const tickets = tracker.milestones.flatMap((m) => m.tickets)
  if (tickets.length === 0 || (launches.length === 0 && tickets.every((t) => t.status === 'todo'))) return 'planning'
  if (tickets.every((t) => t.status === 'done')) return 'shipped'
  if (tickets.every((t) => t.status === 'done' || t.status === 'in-review')) return 'validating'
  return 'building'
}

export function parseDocRef(value: unknown): DocRef | null {
  if (!isObject(value) || typeof value.path !== 'string') return null
  return { path: value.path, heading: strOrNull(value.heading) }
}

/** Options with a title, trimmed; only the first one marked recommended stays so. */
export function decisionOptions(value: unknown): DecisionOption[] {
  if (!Array.isArray(value)) return []
  let recommended = false
  return value.flatMap((option) => {
    if (!isObject(option) || typeof option.title !== 'string' || !option.title.trim()) return []
    const pick = option.recommended === true && !recommended
    recommended ||= pick
    return [{ title: option.title.trim(), detail: str(option.detail).trim(), recommended: pick }]
  })
}

/** Null without a label: the input is what the user has to supply, so it needs a name. */
export function decisionInput(value: unknown): DecisionInput | null {
  if (!isObject(value) || typeof value.label !== 'string' || !value.label.trim()) return null
  return { label: value.label.trim(), value: str(value.value).trim() }
}

const docRefs = (value: unknown): DocRef[] => {
  const refs = Array.isArray(value) ? value.flatMap((ref) => parseDocRef(ref) ?? []) : []
  return refs.filter((ref, i) => refs.findIndex((r) => r.path === ref.path && r.heading === ref.heading) === i)
}

const optionIndex = (value: unknown, options: readonly DecisionOption[]): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < options.length ? value : null

const positive = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0)

/** `accepted` is what `done` was briefly called. */
const ticketStatus = (value: unknown): TicketStatus => (value === 'accepted' ? 'done' : (TICKET_STATUSES.find((s) => s === value) ?? 'todo'))

function parseTicket(value: unknown): MapTicket | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return null
  const status = ticketStatus(value.status)
  const docs = Array.isArray(value.docs) ? value.docs.flatMap((doc) => parseDocRef(doc) ?? []) : []
  return {
    id: value.id,
    number: positive(value.number),
    title: value.title,
    description: str(value.description),
    acceptance: strings(value.acceptance),
    constraints: strings(value.constraints),
    after: strings(value.after),
    docs,
    project: strOrNull(value.project),
    status,
    blocked: status === 'blocked' ? strOrNull(value.blocked) : null
  }
}

/** A definition of done as stored; a plain string is an item from before items could be ticked. */
function parseDoneItems(value: unknown): DoneItem[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): DoneItem[] => {
    if (typeof item === 'string') return item.trim() ? [{ text: item.trim(), done: false }] : []
    if (isObject(item) && typeof item.text === 'string' && item.text.trim()) return [{ text: item.text.trim(), done: item.done === true }]
    return []
  })
}

function parseMilestone(value: unknown): MapMilestone | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return null
  const tickets = Array.isArray(value.tickets) ? value.tickets.flatMap((ticket) => parseTicket(ticket) ?? []) : []
  const manual = MILESTONE_STATUSES.find((s) => s === value.manual) ?? null
  return { id: value.id, title: milestoneTitle(value.title) || value.title, description: str(value.description), doneWhen: parseDoneItems(value.doneWhen), tickets, landed: value.landed === true, manual }
}

function parseDecision(value: unknown): MapDecision | null {
  if (!isObject(value) || typeof value.id !== 'string' || typeof value.title !== 'string') return null
  const status = DECISION_STATUSES.find((s) => s === value.status) ?? 'open'
  const options = decisionOptions(value.options)
  const legacyDoc = parseDocRef(value.doc)
  return {
    id: value.id,
    number: positive(value.number),
    title: value.title,
    question: str(value.question),
    status,
    outcome: str(value.outcome),
    options,
    chosen: status === 'open' ? null : optionIndex(value.chosen, options),
    input: decisionInput(value.input),
    blocks: strings(value.blocks),
    docs: Array.isArray(value.docs) ? docRefs(value.docs) : legacyDoc ? [legacyDoc] : [],
    from: parseMapAuthor(value.from),
    createdAt: str(value.createdAt),
    decidedAt: status === 'open' ? null : strOrNull(value.decidedAt)
  }
}

/**
 * Tickets and decisions stored without a number (from before numbers existed) get the next ones in
 * plan order, so the same file always numbers the same way until it's written back.
 */
export function parseTracker(value: unknown): Tracker {
  if (!isObject(value)) return EMPTY_TRACKER
  const milestones = Array.isArray(value.milestones) ? value.milestones.flatMap((milestone) => parseMilestone(milestone) ?? []) : []
  const decisions = Array.isArray(value.decisions) ? value.decisions.flatMap((decision) => parseDecision(decision) ?? []) : []
  let nextTicket = Math.max(positive(value.nextTicket), 1, ...milestones.flatMap((m) => m.tickets.map((t) => t.number + 1)))
  let nextDecision = Math.max(positive(value.nextDecision), 1, ...decisions.map((d) => d.number + 1))
  const numbered = milestones.map((m) => ({ ...m, tickets: m.tickets.map((t) => (t.number > 0 ? t : { ...t, number: nextTicket++ })) }))
  const decided = decisions.map((d) => (d.number > 0 ? d : { ...d, number: nextDecision++ }))
  return { milestones: numbered, decisions: decided, nextTicket, nextDecision }
}

export function parseScope(value: unknown): LaunchScope | null {
  if (!isObject(value)) return null
  if (typeof value.ticket === 'string') return { ticket: value.ticket }
  if (typeof value.milestone === 'string') return { milestone: value.milestone }
  if (Array.isArray(value.tickets)) {
    const tickets = strings(value.tickets)
    return tickets.length > 0 ? { tickets } : null
  }
  return null
}

const PR_STATES: readonly PullRequestInfo['state'][] = ['open', 'merged', 'closed']

function parsePr(value: unknown): PullRequestInfo | null {
  if (!isObject(value) || typeof value.number !== 'number' || typeof value.url !== 'string') return null
  const state = PR_STATES.find((s) => s === value.state)
  return state ? { number: value.number, state, url: value.url } : null
}

const CHECK_STATES: readonly PullRequestHealth['checks'][] = ['passed', 'failed', 'running', 'none']
const REVIEW_STATES: readonly PullRequestHealth['review'][] = ['approved', 'changes-requested', 'none']

function parseHealth(value: unknown): PullRequestHealth | null {
  if (!isObject(value)) return null
  const checks = CHECK_STATES.find((s) => s === value.checks) ?? 'none'
  const review = REVIEW_STATES.find((s) => s === value.review) ?? 'none'
  return { checks, failing: strings(value.failing), review, unresolved: typeof value.unresolved === 'number' ? value.unresolved : 0 }
}

export function parseCriteria(value: unknown): CriterionResult[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) =>
    isObject(entry) && typeof entry.ticket === 'string' && typeof entry.index === 'number' && Number.isInteger(entry.index) && entry.index >= 0
      ? [{ ticket: entry.ticket, index: entry.index, met: entry.met === true, evidence: str(entry.evidence), source: str(entry.source) }]
      : []
  )
}

export function parseCheckRuns(value: unknown): CheckRun[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => (isObject(entry) && typeof entry.command === 'string' && entry.command.trim() ? [{ command: entry.command.trim(), passed: entry.passed === true }] : []))
}

/** A list of short texts from an agent, trimmed, empties dropped. */
export function notes(value: unknown): string[] {
  return strings(value)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseWrapUp(value: unknown): LaunchWrapUp | null {
  if (!isObject(value) || typeof value.summary !== 'string') return null
  return {
    summary: value.summary,
    wentToPlan: value.wentToPlan === true,
    finished: value.finished === true,
    criteria: parseCriteria(value.criteria),
    checks: parseCheckRuns(value.checks),
    unverified: notes(value.unverified),
    decisions: notes(value.decisions),
    risks: notes(value.risks),
    at: str(value.at),
    sweep: value.sweep === true
  }
}

function parseSession(value: unknown): LaunchSession | null {
  if (!isObject(value) || typeof value.terminal !== 'string' || typeof value.session !== 'string') return null
  const note = typeof value.note === 'string' && value.note.trim() ? { note: value.note.trim() } : {}
  return { terminal: value.terminal, session: value.session, ticket: strOrNull(value.ticket), startedAt: str(value.startedAt), progress: parseProgress(value.progress), ...note }
}

export function parseProgress(value: unknown): SessionProgress | null {
  if (!isObject(value) || typeof value.summary !== 'string') return null
  const phase = PROGRESS_PHASES.find((p) => p === value.phase)
  if (!phase) return null
  return { phase, summary: value.summary, needs: parseNeed(value.needs), next: strOrNull(value.next), at: str(value.at) }
}

export function parseNeed(value: unknown): ProgressNeed | null {
  if (!isObject(value) || typeof value.ask !== 'string' || !value.ask.trim()) return null
  const kind = NEED_KINDS.find((k) => k === value.kind) ?? 'decision'
  return { kind, ask: value.ask.trim() }
}

export function parseBatch(value: unknown): MapBatch | null {
  if (!isObject(value) || typeof value.id !== 'string' || !BATCH_ID.test(value.id)) return null
  const c = value.coordinator
  const coordinator = isObject(c) && typeof c.terminal === 'string' && typeof c.session === 'string' ? { terminal: c.terminal, session: c.session, startedAt: str(c.startedAt) } : null
  return { id: value.id, createdAt: str(value.createdAt), coordinator, declined: value.declined === true }
}

export function parseLaunch(value: unknown): MapLaunch | null {
  if (!isObject(value) || typeof value.id !== 'string' || !LAUNCH_ID.test(value.id)) return null
  const scope = parseScope(value.scope)
  if (!scope || typeof value.project !== 'string' || typeof value.worktree !== 'string' || typeof value.branch !== 'string') return null
  return {
    id: value.id,
    scope,
    project: value.project,
    worktree: value.worktree,
    branch: value.branch,
    base: strOrNull(value.base),
    sessions: Array.isArray(value.sessions) ? value.sessions.flatMap((session) => parseSession(session) ?? []) : [],
    pr: parsePr(value.pr),
    landed: value.landed === true,
    createdAt: str(value.createdAt),
    wrappedUpAt: strOrNull(value.wrappedUpAt),
    sweptAt: strOrNull(value.sweptAt),
    readyAt: strOrNull(value.readyAt),
    wrapUp: parseWrapUp(value.wrapUp),
    health: parseHealth(value.health),
    landingSweptAt: strOrNull(value.landingSweptAt),
    batch: typeof value.batch === 'string' && BATCH_ID.test(value.batch) ? value.batch : null
  }
}

export function parseProposedTicket(value: unknown): ProposedTicket | null {
  if (!isObject(value) || typeof value.title !== 'string') return null
  return {
    title: value.title,
    description: str(value.description),
    acceptance: strings(value.acceptance),
    constraints: strings(value.constraints),
    after: strings(value.after),
    project: strOrNull(value.project) || null,
    docs: Array.isArray(value.docs) ? value.docs.flatMap((doc) => parseDocRef(doc) ?? []) : []
  }
}

const optionalText = (value: unknown): { present: boolean; value: string } => ({ present: typeof value === 'string', value: str(value) })

/** One proposed change to the plan; anything malformed reads as null and is dropped. */
export function parsePlanChange(value: unknown): PlanChange | null {
  if (!isObject(value)) return null
  const before = strOrNull(value.before)
  switch (value.kind) {
    case 'update-ticket': {
      if (typeof value.ticket !== 'string') return null
      const title = optionalText(value.title)
      const description = optionalText(value.description)
      const change: PlanChange = {
        kind: 'update-ticket',
        ticket: value.ticket,
        ...(title.present ? { title: title.value } : {}),
        ...(description.present ? { description: description.value } : {}),
        ...(Array.isArray(value.acceptance) ? { acceptance: strings(value.acceptance) } : {}),
        ...(Array.isArray(value.constraints) ? { constraints: strings(value.constraints) } : {}),
        ...(Array.isArray(value.after) ? { after: strings(value.after) } : {}),
        ...('project' in value ? { project: strOrNull(value.project) || null } : {})
      }
      return Object.keys(change).length > 2 ? change : null
    }
    case 'add-ticket': {
      const ticket = parseProposedTicket(value.ticket)
      return ticket && typeof value.milestone === 'string' ? { kind: 'add-ticket', milestone: value.milestone, before, ticket } : null
    }
    case 'move-ticket':
      return typeof value.ticket === 'string' && typeof value.milestone === 'string' ? { kind: 'move-ticket', ticket: value.ticket, milestone: value.milestone, before } : null
    case 'remove-ticket':
      return typeof value.ticket === 'string' ? { kind: 'remove-ticket', ticket: value.ticket } : null
    case 'update-milestone': {
      if (typeof value.milestone !== 'string') return null
      const title = optionalText(value.title)
      const description = optionalText(value.description)
      const doneWhen = Array.isArray(value.doneWhen) ? notes(value.doneWhen) : undefined
      if (!title.present && !description.present && !doneWhen) return null
      return {
        kind: 'update-milestone',
        milestone: value.milestone,
        ...(title.present ? { title: title.value } : {}),
        ...(description.present ? { description: description.value } : {}),
        ...(doneWhen ? { doneWhen } : {})
      }
    }
    case 'move-milestone':
      return typeof value.milestone === 'string' ? { kind: 'move-milestone', milestone: value.milestone, before } : null
    default:
      return null
  }
}

function parseProposedMilestone(value: unknown): ProposedMilestone | null {
  if (!isObject(value) || typeof value.title !== 'string') return null
  return { title: value.title, description: str(value.description), doneWhen: notes(value.doneWhen), tickets: Array.isArray(value.tickets) ? value.tickets.flatMap((ticket) => parseProposedTicket(ticket) ?? []) : [] }
}

export function parseSuggestion(value: unknown): MapSuggestion | null {
  if (!isObject(value) || typeof value.id !== 'string') return null
  const from: MapAuthor | null = parseMapAuthor(value.from)
  if (!from) return null
  const base = { id: value.id, why: str(value.why), from, at: str(value.at) }
  switch (value.kind) {
    case 'add-doc':
      return typeof value.path === 'string' ? { ...base, kind: 'add-doc', path: value.path, milestones: strings(value.milestones) } : null
    case 'write-doc':
      return typeof value.title === 'string' ? { ...base, kind: 'write-doc', title: value.title, milestones: strings(value.milestones) } : null
    case 'plan': {
      const milestones = Array.isArray(value.milestones) ? value.milestones.flatMap((m) => parseProposedMilestone(m) ?? []) : []
      return milestones.length > 0 ? { ...base, kind: 'plan', milestones } : null
    }
    case 'ticket': {
      const ticket = parseProposedTicket(value.ticket)
      return ticket && typeof value.milestone === 'string' ? { ...base, kind: 'ticket', milestone: value.milestone, ticket } : null
    }
    case 'plan-change': {
      const changes = Array.isArray(value.changes) ? value.changes.flatMap((change) => parsePlanChange(change) ?? []) : []
      return changes.length > 0 ? { ...base, kind: 'plan-change', changes } : null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------
// Status

/** Every launch of the milestone itself (not of its tickets). */
function milestoneLaunches(milestone: MapMilestone, launches: readonly MapLaunch[]): MapLaunch[] {
  return launches.filter((launch) => 'milestone' in launch.scope && launch.scope.milestone === milestone.id)
}

/**
 * Done when every ticket is done; merging a branch doesn't finish a milestone. One with no
 * tickets is done only when marked so by hand. A status set by hand wins until the next real event.
 */
export function milestoneStatus(milestone: MapMilestone, launches: readonly MapLaunch[]): MilestoneStatus {
  if (milestone.manual) return milestone.manual
  const own = milestoneLaunches(milestone, launches)
  const tickets = milestone.tickets
  const ticketIds = new Set(tickets.map((t) => t.id))
  const started = own.length > 0 || launches.some((launch) => !('milestone' in launch.scope) && scopeTicketIds(launch.scope).some((id) => ticketIds.has(id)))
  if (tickets.length > 0 && tickets.every((ticket) => ticket.status === 'done')) return 'done'
  return started || tickets.some((ticket) => ticket.status !== 'todo') ? 'in-progress' : 'todo'
}

export function milestoneInfos(tracker: Tracker, launches: readonly MapLaunch[]): MapMilestoneInfo[] {
  return tracker.milestones.map((milestone) => ({ ...milestone, status: milestoneStatus(milestone, launches) }))
}

/** The pinned milestone when it still exists, else the first not done; null when none is left. */
export function currentMilestone<M extends { id: string; status: MilestoneStatus }>(milestones: readonly M[], pinned: string | null): M | null {
  return milestones.find((m) => m.id === pinned) ?? milestones.find((m) => m.status !== 'done') ?? null
}

/** The tickets a scope covers: one, a group, or all of a milestone's. */
export function scopeTicketIds(scope: LaunchScope, milestoneTickets?: readonly MapTicket[]): string[] {
  if ('ticket' in scope) return [scope.ticket]
  if ('tickets' in scope) return scope.tickets
  return (milestoneTickets ?? []).map((ticket) => ticket.id)
}

export function findTicket(tracker: Tracker, id: string): { milestone: MapMilestone; ticket: MapTicket } | null {
  for (const milestone of tracker.milestones) {
    const ticket = milestone.tickets.find((t) => t.id === id)
    if (ticket) return { milestone, ticket }
  }
  return null
}

/** The tickets a launch covers, wherever they are now. */
export function launchTickets(tracker: Tracker, scope: LaunchScope): MapTicket[] {
  if ('milestone' in scope) return tracker.milestones.find((m) => m.id === scope.milestone)?.tickets ?? []
  return scopeTicketIds(scope).flatMap((id) => findTicket(tracker, id)?.ticket ?? [])
}

/** What the UI and agents call a launch: its ticket's or milestone's title, or the first ticket and how many more. */
export function scopeTitle(tracker: Tracker, scope: LaunchScope): string {
  if ('milestone' in scope) return tracker.milestones.find((m) => m.id === scope.milestone)?.title ?? 'A removed milestone'
  const tickets = launchTickets(tracker, scope)
  const first = tickets[0]?.title ?? 'A removed ticket'
  return tickets.length > 1 ? `${first} and ${tickets.length - 1} more` : first
}

/** The milestone a scope belongs to: its own, or its first ticket's. */
export function scopeMilestone(tracker: Tracker, scope: LaunchScope): MapMilestone | null {
  if ('milestone' in scope) return tracker.milestones.find((m) => m.id === scope.milestone) ?? null
  const first = scopeTicketIds(scope)[0]
  return first ? (findTicket(tracker, first)?.milestone ?? null) : null
}

/** The tickets this one waits for that aren't done yet. */
export function waitingOn(tracker: Tracker, ticket: MapTicket): MapTicket[] {
  return ticket.after.flatMap((id) => findTicket(tracker, id)?.ticket ?? []).filter((t) => t.status !== 'done')
}

/** Open decisions that hold this ticket back. */
export function openDecisions(tracker: Pick<Tracker, 'decisions'>, ticket: string): MapDecision[] {
  return tracker.decisions.filter((d) => d.status === 'open' && d.blocks.includes(ticket))
}

/** To-do tickets of the milestone with every dependency done and no open decision in the way, in order. */
export function readyTickets(tracker: Tracker, milestone: MapMilestone): MapTicket[] {
  return milestone.tickets.filter((t) => t.status === 'todo' && waitingOn(tracker, t).length === 0 && openDecisions(tracker, t.id).length === 0)
}

/** Whether giving `ticket` these dependencies would make it wait, through others, on itself. */
function makesCycle(tracker: Tracker, ticket: string, after: readonly string[]): boolean {
  const seen = new Set<string>()
  const stack = [...after]
  while (stack.length > 0) {
    const id = stack.pop() ?? ''
    if (id === ticket) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(findTicket(tracker, id)?.ticket.after ?? []))
  }
  return false
}

/** Dependencies as stored: existing tickets other than itself, once each. */
function cleanAfter(tracker: Tracker, ticket: string, after: readonly string[]): string[] {
  return [...new Set(after)].filter((id) => id !== ticket && findTicket(tracker, id) !== null)
}

/**
 * What an open pull request needs, from its detail: failing or running checks, and the review
 * (each reviewer's latest verdict counts; one asking for changes outweighs approvals).
 */
export function pullRequestHealth(pr: Pick<PullRequestDetail, 'checks' | 'comments'>): PullRequestHealth {
  const failing = pr.checks.filter((c) => c.state === 'failed').map((c) => c.name)
  const checks = failing.length > 0 ? 'failed' : pr.checks.some((c) => c.state === 'running') ? 'running' : pr.checks.some((c) => c.state === 'passed') ? 'passed' : 'none'
  const latest = new Map<string, string>()
  for (const review of [...pr.comments].filter((c) => c.kind === 'review' && (c.verdict === 'approved' || c.verdict === 'changes requested')).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    latest.set(review.author, review.verdict ?? '')
  }
  const verdicts = [...latest.values()]
  const review = verdicts.includes('changes requested') ? 'changes-requested' : verdicts.includes('approved') ? 'approved' : 'none'
  const unresolved = pr.comments.filter((c) => c.kind === 'thread' && !c.resolved).length
  return { checks, failing, review, unresolved }
}

/**
 * Sets the statuses of tickets, and clears the hand-set status of the milestones they're in: a real
 * event replaces a manual status. `keepDone` leaves done tickets as they are.
 */
export function setTicketStatuses(tracker: Tracker, ids: readonly string[], status: TicketStatus, options: { reason?: string; keepDone?: boolean } = {}): Tracker {
  const wanted = new Set(ids)
  return {
    ...tracker,
    milestones: tracker.milestones.map((milestone) => {
      if (!milestone.tickets.some((t) => wanted.has(t.id))) return milestone
      return {
        ...milestone,
        manual: null,
        tickets: milestone.tickets.map((ticket) => {
          if (!wanted.has(ticket.id)) return ticket
          if (options.keepDone && ticket.status === 'done') return ticket
          return { ...ticket, status, blocked: status === 'blocked' ? (options.reason?.trim() || 'No reason given') : null }
        })
      }
    })
  }
}

export function updateMilestone(tracker: Tracker, id: string, change: (milestone: MapMilestone) => MapMilestone): Tracker {
  return { ...tracker, milestones: tracker.milestones.map((m) => (m.id === id ? change(m) : m)) }
}

const cleanList = (items: readonly string[]): string[] => items.map((item) => item.trim()).filter(Boolean)

const cleanDone = (items: readonly DoneItem[]): DoneItem[] => items.flatMap((item) => (item.text.trim() ? [{ text: item.text.trim(), done: item.done }] : []))

/** An agent's definition of done as items; one already ticked keeps its tick while its text is unchanged. */
function doneItems(texts: readonly string[], ticked: readonly DoneItem[] = []): DoneItem[] {
  return cleanList(texts).map((text) => ({ text, done: ticked.some((item) => item.done && item.text === text) }))
}

// ---------------------------------------------------------------------------------------------
// Hand edits

type Edited<T> = { ok: true; value: T; message: string } | { ok: false; message: string }

function insertBefore<T extends { id: string }>(items: readonly T[], item: T, before: string | null | undefined): T[] {
  const index = before ? items.findIndex((i) => i.id === before) : -1
  return index === -1 ? [...items, item] : [...items.slice(0, index), item, ...items.slice(index)]
}

const cleanTitle = (title: string): string => title.replace(/\s+/g, ' ').trim()

/**
 * A milestone title without a leading number ("M8 – Release candidate" → "Release candidate"). Manta
 * numbers milestones by their place in the plan, so a number in the title goes stale on the first
 * reorder and shows twice ("M4 · M8 – …"). Docs often number their phases, and agents copy that.
 */
export function milestoneTitle(title: string): string {
  return cleanTitle(title).replace(/^(?:m|milestone\s*)\d+[a-z]?\s*[–—:·.-]\s*(?=\S)/i, '')
}

/** Applies one hand edit to the tracker; refusals say what's wrong. */
export function applyTrackerEdit(tracker: Tracker, edit: TrackerEdit): Edited<Tracker> {
  const milestone = (id: string): MapMilestone | undefined => tracker.milestones.find((m) => m.id === id)
  switch (edit.kind) {
    case 'add-milestone': {
      const title = milestoneTitle(edit.title)
      if (!title) return { ok: false, message: 'Give the milestone a title' }
      const added: MapMilestone = { id: newMilestoneId(), title, description: edit.description ?? '', doneWhen: [], tickets: [], landed: false, manual: null }
      return { ok: true, value: { ...tracker, milestones: insertBefore(tracker.milestones, added, edit.before) }, message: `Added ${title}` }
    }
    case 'update-milestone': {
      if (!milestone(edit.milestone)) return { ok: false, message: 'That milestone is gone' }
      const title = edit.title === undefined ? undefined : milestoneTitle(edit.title)
      if (title === '') return { ok: false, message: 'Give the milestone a title' }
      return {
        ok: true,
        value: updateMilestone(tracker, edit.milestone, (m) => ({
          ...m,
          ...(title ? { title } : {}),
          ...(edit.description !== undefined ? { description: edit.description } : {}),
          ...(edit.doneWhen !== undefined ? { doneWhen: cleanDone(edit.doneWhen) } : {})
        })),
        message: 'Saved'
      }
    }
    case 'move-milestone': {
      const moving = milestone(edit.milestone)
      if (!moving) return { ok: false, message: 'That milestone is gone' }
      if (edit.before === moving.id) return { ok: true, value: tracker, message: 'Moved' }
      return { ok: true, value: { ...tracker, milestones: insertBefore(tracker.milestones.filter((m) => m.id !== moving.id), moving, edit.before) }, message: `Moved ${moving.title}` }
    }
    case 'set-milestone-status': {
      if (!milestone(edit.milestone)) return { ok: false, message: 'That milestone is gone' }
      return { ok: true, value: updateMilestone(tracker, edit.milestone, (m) => ({ ...m, manual: edit.status })), message: 'Status set' }
    }
    case 'add-ticket': {
      const title = cleanTitle(edit.title)
      if (!title) return { ok: false, message: 'Give the ticket a title' }
      if (!milestone(edit.milestone)) return { ok: false, message: 'That milestone is gone' }
      const ticket: MapTicket = { id: newTicketId(), number: tracker.nextTicket, title, description: edit.description ?? '', acceptance: [], constraints: [], after: [], docs: [], project: null, status: 'todo', blocked: null }
      const numbered = { ...tracker, nextTicket: tracker.nextTicket + 1 }
      return { ok: true, value: updateMilestone(numbered, edit.milestone, (m) => ({ ...m, tickets: insertBefore(m.tickets, ticket, edit.before) })), message: `Added ${title}` }
    }
    case 'update-ticket': {
      const found = findTicket(tracker, edit.ticket)
      if (!found) return { ok: false, message: 'That ticket is gone' }
      const title = edit.title === undefined ? undefined : cleanTitle(edit.title)
      if (title === '') return { ok: false, message: 'Give the ticket a title' }
      const after = edit.after === undefined ? undefined : cleanAfter(tracker, edit.ticket, edit.after)
      if (after && makesCycle(tracker, edit.ticket, after)) return { ok: false, message: 'That would make tickets wait on each other' }
      const next: MapTicket = {
        ...found.ticket,
        ...(title ? { title } : {}),
        ...(edit.description !== undefined ? { description: edit.description } : {}),
        ...(edit.acceptance !== undefined ? { acceptance: cleanList(edit.acceptance) } : {}),
        ...(edit.constraints !== undefined ? { constraints: cleanList(edit.constraints) } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(edit.docs !== undefined ? { docs: edit.docs } : {}),
        ...(edit.project !== undefined ? { project: edit.project } : {})
      }
      return { ok: true, value: updateMilestone(tracker, found.milestone.id, (m) => ({ ...m, tickets: m.tickets.map((t) => (t.id === next.id ? next : t)) })), message: 'Saved' }
    }
    case 'move-ticket': {
      const found = findTicket(tracker, edit.ticket)
      if (!found) return { ok: false, message: 'That ticket is gone' }
      if (!milestone(edit.milestone)) return { ok: false, message: 'That milestone is gone' }
      if (edit.before === edit.ticket) return { ok: true, value: tracker, message: 'Moved' }
      const without = updateMilestone(tracker, found.milestone.id, (m) => ({ ...m, tickets: m.tickets.filter((t) => t.id !== edit.ticket) }))
      return { ok: true, value: updateMilestone(without, edit.milestone, (m) => ({ ...m, tickets: insertBefore(m.tickets, found.ticket, edit.before) })), message: `Moved ${found.ticket.title}` }
    }
    case 'set-ticket-status': {
      if (!findTicket(tracker, edit.ticket)) return { ok: false, message: 'That ticket is gone' }
      return { ok: true, value: setTicketStatuses(tracker, [edit.ticket], edit.status, edit.reason !== undefined ? { reason: edit.reason } : {}), message: 'Status set' }
    }
    case 'add-decision': {
      const title = cleanTitle(edit.title)
      if (!title) return { ok: false, message: 'Give the decision a title' }
      const outcome = edit.outcome?.trim() ?? ''
      const now = new Date().toISOString()
      const decision: MapDecision = {
        id: newDecisionId(),
        number: tracker.nextDecision,
        title,
        question: edit.question?.trim() ?? '',
        status: outcome ? 'decided' : 'open',
        outcome,
        options: decisionOptions(edit.options ?? []),
        chosen: null,
        input: decisionInput(edit.input ?? null),
        blocks: cleanBlocks(tracker, edit.blocks ?? []),
        docs: docRefs(edit.docs ?? []),
        from: edit.from ?? null,
        createdAt: now,
        decidedAt: outcome ? now : null
      }
      return {
        ok: true,
        value: { ...tracker, decisions: [...tracker.decisions, decision], nextDecision: tracker.nextDecision + 1 },
        message: `${outcome ? 'Recorded' : 'Added'} decision ${decisionNumber(decision)}`
      }
    }
    case 'update-decision': {
      const found = tracker.decisions.find((d) => d.id === edit.decision)
      if (!found) return { ok: false, message: 'That decision is gone' }
      const title = edit.title === undefined ? undefined : cleanTitle(edit.title)
      if (title === '') return { ok: false, message: 'Give the decision a title' }
      const status = edit.status ?? found.status
      const options = edit.options === undefined ? found.options : decisionOptions(edit.options)
      const input = edit.input === undefined ? found.input : decisionInput(edit.input)
      const chosen = status === 'open' ? null : edit.chosen === undefined ? optionIndex(found.chosen, options) : optionIndex(edit.chosen, options)
      const picked = chosen === null ? undefined : options[chosen]
      const typed = edit.outcome === undefined ? found.outcome : edit.outcome.trim()
      const outcome = typed || (picked ? `${picked.title}${input?.value ? ` (${input.label}: ${input.value})` : ''}` : '')
      if (status === 'decided' && found.status !== 'decided' && input && !input.value) return { ok: false, message: `Fill in ${input.label} first` }
      if (status === 'decided' && !outcome) return { ok: false, message: options.length > 0 ? 'Choose an option or say what was decided' : 'Say what was decided' }
      const next: MapDecision = {
        ...found,
        ...(title ? { title } : {}),
        ...(edit.question !== undefined ? { question: edit.question.trim() } : {}),
        ...(edit.blocks !== undefined ? { blocks: cleanBlocks(tracker, edit.blocks) } : {}),
        ...(edit.docs !== undefined ? { docs: docRefs(edit.docs) } : {}),
        options,
        chosen,
        input,
        outcome,
        status,
        decidedAt: status === 'open' ? null : (found.decidedAt ?? new Date().toISOString())
      }
      return { ok: true, value: { ...tracker, decisions: tracker.decisions.map((d) => (d.id === next.id ? next : d)) }, message: status === 'decided' && found.status === 'open' ? 'Decided' : 'Saved' }
    }
    case 'remove-decision': {
      const found = tracker.decisions.find((d) => d.id === edit.decision)
      if (!found) return { ok: false, message: 'That decision is gone' }
      return { ok: true, value: { ...tracker, decisions: tracker.decisions.filter((d) => d.id !== edit.decision) }, message: `Removed decision ${decisionNumber(found)}` }
    }
  }
}

/** A decision's number as shown: `006`. */
export function decisionNumber(decision: Pick<MapDecision, 'number'>): string {
  return String(decision.number).padStart(3, '0')
}

/** Tickets a decision blocks as stored: existing ones, once each. */
function cleanBlocks(tracker: Tracker, ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => findTicket(tracker, id) !== null)
}

/** Removes tickets, and drops them from what other tickets wait for and what decisions block. */
function withoutTickets(tracker: Tracker, ids: ReadonlySet<string>): Tracker {
  return {
    ...tracker,
    milestones: tracker.milestones.map((m) => ({
      ...m,
      tickets: m.tickets.filter((t) => !ids.has(t.id)).map((t) => (t.after.some((id) => ids.has(id)) ? { ...t, after: t.after.filter((id) => !ids.has(id)) } : t))
    })),
    decisions: tracker.decisions.map((d) => (d.blocks.some((id) => ids.has(id)) ? { ...d, blocks: d.blocks.filter((id) => !ids.has(id)) } : d))
  }
}

export function removeTicket(tracker: Tracker, id: string): Tracker {
  return withoutTickets(tracker, new Set([id]))
}

export function removeMilestone(tracker: Tracker, id: string): Tracker {
  const removed = new Set(tracker.milestones.find((m) => m.id === id)?.tickets.map((t) => t.id) ?? [])
  const without = withoutTickets(tracker, removed)
  return { ...without, milestones: without.milestones.filter((m) => m.id !== id) }
}

/**
 * Adds an agent's proposed milestones (with their tickets) at the end of the plan. A ticket's
 * `after` names existing tickets by id or tickets of the same proposal by title; anything else is dropped.
 */
export function addProposedMilestones(tracker: Tracker, proposed: readonly ProposedMilestone[], projects: readonly string[] = []): Tracker {
  const titled = new Map<string, string>()
  let next = tracker.nextTicket
  const drafts = proposed.map((m) => ({
    milestone: m,
    tickets: m.tickets.map((ticket) => {
      const made = proposedTicket(ticket, next++, projects)
      if (!titled.has(made.title.toLowerCase())) titled.set(made.title.toLowerCase(), made.id)
      return { made, after: ticket.after }
    })
  }))
  const added = drafts.map(
    ({ milestone, tickets }): MapMilestone => ({
      id: newMilestoneId(),
      title: milestoneTitle(milestone.title) || 'Untitled milestone',
      description: milestone.description,
      doneWhen: doneItems(milestone.doneWhen),
      landed: false,
      manual: null,
      tickets: tickets.map(({ made, after }) => ({ ...made, after: resolveAfter(tracker, after, titled, made.id) }))
    })
  )
  return { ...tracker, milestones: [...tracker.milestones, ...added], nextTicket: next }
}

function resolveAfter(tracker: Tracker, after: readonly string[], titled: ReadonlyMap<string, string>, self: string): string[] {
  const ids = after.flatMap((ref) => (findTicket(tracker, ref) ? [ref] : (titled.get(cleanTitle(ref).toLowerCase()) ?? [])))
  return [...new Set(ids)].filter((id) => id !== self)
}

/** A proposed ticket as a new to-do ticket. Its project is kept only when it's one of `projects`; `after` is resolved by the caller. */
export function proposedTicket(ticket: ProposedTicket, number: number, projects: readonly string[] = []): MapTicket {
  return {
    id: newTicketId(),
    number,
    title: cleanTitle(ticket.title) || 'Untitled ticket',
    description: ticket.description,
    acceptance: cleanList(ticket.acceptance),
    constraints: cleanList(ticket.constraints),
    after: [],
    docs: ticket.docs,
    project: ticket.project && projects.includes(ticket.project) ? ticket.project : null,
    status: 'todo',
    blocked: null
  }
}

/** Applies one approved plan change. A ticket proposed alone may wait only on existing tickets. */
export function applyPlanChange(tracker: Tracker, change: PlanChange, projects: readonly string[]): Edited<Tracker> {
  switch (change.kind) {
    case 'update-ticket': {
      const project = change.project === undefined ? undefined : change.project && projects.includes(change.project) ? change.project : null
      const { kind: _kind, ...fields } = change
      return applyTrackerEdit(tracker, { ...fields, kind: 'update-ticket', ...(project !== undefined ? { project } : {}) })
    }
    case 'add-ticket': {
      if (!tracker.milestones.some((m) => m.id === change.milestone)) return { ok: false, message: 'Its milestone is gone' }
      const made = proposedTicket(change.ticket, tracker.nextTicket, projects)
      const ticket = { ...made, after: resolveAfter(tracker, change.ticket.after, new Map(), made.id) }
      const numbered = { ...tracker, nextTicket: tracker.nextTicket + 1 }
      return { ok: true, value: updateMilestone(numbered, change.milestone, (m) => ({ ...m, tickets: insertBefore(m.tickets, ticket, change.before) })), message: `Added ${ticket.title}` }
    }
    case 'move-ticket':
      return applyTrackerEdit(tracker, change)
    case 'remove-ticket': {
      const found = findTicket(tracker, change.ticket)
      if (!found) return { ok: false, message: 'That ticket is gone' }
      return { ok: true, value: removeTicket(tracker, change.ticket), message: `Removed ${found.ticket.title}` }
    }
    case 'update-milestone': {
      const { doneWhen, ...fields } = change
      const ticked = tracker.milestones.find((m) => m.id === change.milestone)?.doneWhen ?? []
      return applyTrackerEdit(tracker, { ...fields, ...(doneWhen !== undefined ? { doneWhen: doneItems(doneWhen, ticked) } : {}) })
    }
    case 'move-milestone':
      return applyTrackerEdit(tracker, change)
  }
}

/** A doc path as the map stores it: inside the docs repo, `/`-separated, no leading `./`. Null for anything outside it. */
export function cleanDocPath(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '')
  if (!trimmed || path.posix.isAbsolute(trimmed)) return null
  const normalized = path.posix.normalize(trimmed)
  if (normalized === '..' || normalized.startsWith('../') || normalized.split('/')[0] === '.git') return null
  return normalized
}

/** Applies one hand edit to the map's docs and sections. */
export function applyDocsEdit(map: MapFile, edit: MapDocsEdit, milestoneIds: ReadonlySet<string>): Edited<MapFile> {
  const keep = (ids: readonly string[]): string[] => [...new Set(ids.filter((id) => milestoneIds.has(id)))]
  const section = (id: string | null | undefined): string | null => (id && map.sections.some((s) => s.id === id) ? id : null)
  switch (edit.kind) {
    case 'add-doc': {
      const doc = cleanDocPath(edit.path)
      if (!doc) return { ok: false, message: `${edit.path} isn't a path in the docs repo` }
      if (map.docs.some((d) => d.path === doc)) return { ok: false, message: `${doc} is already on the map` }
      return { ok: true, value: { ...map, docs: [...map.docs, { path: doc, milestones: keep(edit.milestones), section: section(edit.section), roles: [] }] }, message: `Added ${doc}` }
    }
    case 'add-link': {
      const url = webAddress(edit.url)
      if (!url) return { ok: false, message: 'A link needs an http or https address' }
      const title = cleanTitle(edit.title)
      if (!title) return { ok: false, message: 'Give the link a title' }
      if (map.docs.some((d) => d.link?.url === url)) return { ok: false, message: `${url} is already on the map` }
      return { ok: true, value: { ...map, docs: [...map.docs, { path: newLinkKey(), milestones: keep(edit.milestones), section: null, roles: docRoles(edit.roles), link: { url, title } }] }, message: `Added ${title}` }
    }
    case 'update-doc': {
      const found = map.docs.find((d) => d.path === edit.path)
      if (!found) return { ok: false, message: `${edit.path} isn't on the map` }
      let link = found.link
      if (edit.link) {
        if (!found.link) return { ok: false, message: `${edit.path} is a file, not a link` }
        const url = webAddress(edit.link.url)
        if (!url) return { ok: false, message: 'A link needs an http or https address' }
        const title = cleanTitle(edit.link.title)
        if (!title) return { ok: false, message: 'Give the link a title' }
        link = { url, title }
      }
      const docs = map.docs.map((d) =>
        d.path === edit.path
          ? {
              ...d,
              ...(edit.milestones ? { milestones: keep(edit.milestones) } : {}),
              ...(edit.section !== undefined ? { section: section(edit.section) } : {}),
              ...(edit.roles !== undefined ? { roles: docRoles(edit.roles) } : {}),
              ...(link ? { link } : {})
            }
          : d
      )
      return { ok: true, value: { ...map, docs }, message: 'Saved' }
    }
    case 'remove-doc':
      return { ok: true, value: { ...map, docs: map.docs.filter((d) => d.path !== edit.path) }, message: `Removed ${edit.path} from the map; the doc itself is untouched` }
    case 'add-section': {
      const title = cleanTitle(edit.title)
      if (!title) return { ok: false, message: 'Give the section a name' }
      const id = newSectionId()
      return { ok: true, value: { ...map, sections: [...map.sections, { id, title }], docs: map.docs.map((d) => (d.path === edit.doc ? { ...d, section: id } : d)) }, message: `Added ${title}` }
    }
    case 'rename-section': {
      const title = cleanTitle(edit.title)
      if (!title) return { ok: false, message: 'Give the section a name' }
      return { ok: true, value: { ...map, sections: map.sections.map((s) => (s.id === edit.section ? { ...s, title } : s)) }, message: 'Renamed' }
    }
    case 'remove-section':
      return {
        ok: true,
        value: { ...map, sections: map.sections.filter((s) => s.id !== edit.section), docs: map.docs.map((d) => (d.section === edit.section ? { ...d, section: null } : d)) },
        message: 'Removed the section; its docs stay on the map'
      }
  }
}

export function applySettings(map: MapFile, settings: MapSettings, milestoneIds: ReadonlySet<string>): Edited<MapFile> {
  const title = settings.title === undefined ? map.title : cleanTitle(settings.title)
  if (!title) return { ok: false, message: 'Give the map a title' }
  const pinned = settings.pinned === undefined ? map.pinned : settings.pinned !== null && milestoneIds.has(settings.pinned) ? settings.pinned : null
  const key = settings.key === undefined ? map.key : settings.key.trim().toUpperCase() || null
  if (key !== null && !MAP_KEY.test(key)) return { ok: false, message: 'A key is a letter, then up to five letters or digits' }
  return {
    ok: true,
    value: {
      ...map,
      title,
      description: settings.description ?? map.description,
      projects: settings.projects ? [...new Set(settings.projects)] : map.projects,
      launchMode: settings.launchMode ?? map.launchMode,
      sweep: settings.sweep ?? map.sweep,
      confirmProposals: settings.confirmProposals ?? map.confirmProposals,
      pinned,
      checks: settings.checks ? settings.checks.map((c) => ({ project: c.project, commands: cleanList(c.commands) })).filter((c) => c.commands.length > 0) : map.checks,
      key,
      stage: settings.stage === undefined ? map.stage : settings.stage
    },
    message: 'Saved'
  }
}

/** A refusal with nothing to change, as an `OpResult`. */
export function refusal(result: { ok: false; message: string }): OpResult {
  return { ok: false, message: result.message }
}
