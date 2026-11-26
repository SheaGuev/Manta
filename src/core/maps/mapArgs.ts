import type { ConfirmProposals, DecisionStatus, DocLink, DocRef, DoneItem, MapBriefRequest, DocRole, LaunchMode, MapDoc, MapDocsEdit, MapFeedback, MapLaunchRequest, MapProjectChecks, MapSettings, MapStage, MilestoneStatus, NewMapInput, TicketStatus, TrackerEdit } from '../../shared/ipc'
import { BATCH_ID, CONFIRM_MODES, DECISION_STATUSES, decisionInput, decisionOptions, DOC_ROLES, LAUNCH_MODES, MAP_ID, MAP_STAGES, MILESTONE_STATUSES, parseDocRef, parseScope, TICKET_STATUSES } from './mapModel'

/**
 * Validators for the context map IPC arguments, which main treats as untrusted: each returns the
 * typed value or throws naming the bad field.
 */

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return Object.fromEntries(Object.entries(value))
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return value
}

function optionalText(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : text(value, name)
}

function textOrNull(value: unknown, name: string): string | null {
  return value === null ? null : text(value, name)
}

function texts(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`${name} must be a list of strings`)
  return value.filter((item): item is string => typeof item === 'string')
}

function doneItems(value: unknown, name: string): DoneItem[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be a list`)
  return value.map((item, index) => {
    const entry = object(item, `${name}[${index}]`)
    if (entry['done'] !== undefined && typeof entry['done'] !== 'boolean') throw new Error(`${name}[${index}].done must be true or false`)
    return { text: text(entry['text'], `${name}[${index}].text`), done: entry['done'] === true }
  })
}

function oneOf<T extends string>(value: unknown, options: readonly T[], name: string): T {
  const found = options.find((option) => option === value)
  if (!found) throw new Error(`${name} must be one of ${options.join(', ')}`)
  return found
}

function cells(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1000) throw new Error(`${name} must be between 1 and 1000`)
  return value
}

export function mapId(value: unknown): string {
  if (typeof value !== 'string' || !MAP_ID.test(value)) throw new Error('id must be a context map id')
  return value
}

export function newMapInput(value: unknown): NewMapInput {
  const input = object(value, 'input')
  return {
    title: text(input['title'], 'title'),
    description: text(input['description'] ?? '', 'description'),
    projects: texts(input['projects'] ?? [], 'projects'),
    launchMode: oneOf<LaunchMode>(input['launchMode'] ?? 'ticket', LAUNCH_MODES, 'launchMode')
  }
}

export function mapSettings(value: unknown): MapSettings {
  const input = object(value, 'settings')
  const settings: MapSettings = {}
  if (input['title'] !== undefined) settings.title = text(input['title'], 'title')
  if (input['description'] !== undefined) settings.description = text(input['description'], 'description')
  if (input['projects'] !== undefined) settings.projects = texts(input['projects'], 'projects')
  if (input['launchMode'] !== undefined) settings.launchMode = oneOf<LaunchMode>(input['launchMode'], LAUNCH_MODES, 'launchMode')
  if (input['sweep'] !== undefined) {
    if (typeof input['sweep'] !== 'boolean') throw new Error('sweep must be a boolean')
    settings.sweep = input['sweep']
  }
  if (input['confirmProposals'] !== undefined) settings.confirmProposals = oneOf<ConfirmProposals>(input['confirmProposals'], CONFIRM_MODES, 'confirmProposals')
  if (input['pinned'] !== undefined) settings.pinned = textOrNull(input['pinned'], 'pinned')
  if (input['checks'] !== undefined) settings.checks = projectChecks(input['checks'])
  if (input['key'] !== undefined) settings.key = text(input['key'], 'key')
  if (input['stage'] !== undefined) settings.stage = input['stage'] === null ? null : oneOf<MapStage>(input['stage'], MAP_STAGES, 'stage')
  return settings
}

function projectChecks(value: unknown): MapProjectChecks[] {
  if (!Array.isArray(value)) throw new Error('checks must be a list')
  return value.map((entry, index) => {
    const checks = object(entry, `checks[${index}]`)
    return { project: text(checks['project'], `checks[${index}].project`), commands: texts(checks['commands'], `checks[${index}].commands`) }
  })
}

const FEEDBACK: readonly MapFeedback[] = ['checks', 'review']

export function mapFeedback(value: unknown): MapFeedback {
  return oneOf<MapFeedback>(value, FEEDBACK, 'kind')
}

function docRef(value: unknown, name: string): DocRef {
  const parsed = parseDocRef(value)
  if (!parsed) throw new Error(`${name} must have a path`)
  return parsed
}

function chosenIndex(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error('chosen must be an option index or null')
  return value
}

function docLink(value: unknown): DocLink {
  const link = object(value, 'link')
  return { url: text(link['url'], 'link.url'), title: text(link['title'], 'link.title') }
}

function roles(value: unknown): DocRole[] {
  return texts(value, 'roles').map((role, index) => oneOf<DocRole>(role, DOC_ROLES, `roles[${index}]`))
}

function docRefs(value: unknown): DocRef[] {
  if (!Array.isArray(value)) throw new Error('docs must be a list')
  return value.map((doc, index) => {
    const parsed = parseDocRef(doc)
    if (!parsed) throw new Error(`docs[${index}] must have a path`)
    return parsed
  })
}

export function trackerEdit(value: unknown): TrackerEdit {
  const edit = object(value, 'edit')
  const before = (): { before?: string | null } => (edit['before'] === undefined ? {} : { before: textOrNull(edit['before'], 'before') })
  const description = (): { description?: string } => {
    const parsed = optionalText(edit['description'], 'description')
    return parsed === undefined ? {} : { description: parsed }
  }
  switch (edit['kind']) {
    case 'add-milestone':
      return { kind: 'add-milestone', title: text(edit['title'], 'title'), ...description(), ...before() }
    case 'update-milestone': {
      const title = optionalText(edit['title'], 'title')
      return {
        kind: 'update-milestone',
        milestone: text(edit['milestone'], 'milestone'),
        ...(title !== undefined ? { title } : {}),
        ...description(),
        ...(edit['doneWhen'] !== undefined ? { doneWhen: doneItems(edit['doneWhen'], 'doneWhen') } : {})
      }
    }
    case 'move-milestone':
      return { kind: 'move-milestone', milestone: text(edit['milestone'], 'milestone'), before: textOrNull(edit['before'] ?? null, 'before') }
    case 'set-milestone-status':
      return { kind: 'set-milestone-status', milestone: text(edit['milestone'], 'milestone'), status: edit['status'] === null ? null : oneOf<MilestoneStatus>(edit['status'], MILESTONE_STATUSES, 'status') }
    case 'add-ticket':
      return { kind: 'add-ticket', milestone: text(edit['milestone'], 'milestone'), title: text(edit['title'], 'title'), ...description(), ...before() }
    case 'update-ticket': {
      const title = optionalText(edit['title'], 'title')
      return {
        kind: 'update-ticket',
        ticket: text(edit['ticket'], 'ticket'),
        ...(title !== undefined ? { title } : {}),
        ...description(),
        ...(edit['acceptance'] !== undefined ? { acceptance: texts(edit['acceptance'], 'acceptance') } : {}),
        ...(edit['constraints'] !== undefined ? { constraints: texts(edit['constraints'], 'constraints') } : {}),
        ...(edit['after'] !== undefined ? { after: texts(edit['after'], 'after') } : {}),
        ...(edit['docs'] !== undefined ? { docs: docRefs(edit['docs']) } : {}),
        ...(edit['project'] !== undefined ? { project: textOrNull(edit['project'], 'project') } : {})
      }
    }
    case 'move-ticket':
      return { kind: 'move-ticket', ticket: text(edit['ticket'], 'ticket'), milestone: text(edit['milestone'], 'milestone'), before: textOrNull(edit['before'] ?? null, 'before') }
    case 'set-ticket-status': {
      const reason = optionalText(edit['reason'], 'reason')
      return { kind: 'set-ticket-status', ticket: text(edit['ticket'], 'ticket'), status: oneOf<TicketStatus>(edit['status'], TICKET_STATUSES, 'status'), ...(reason !== undefined ? { reason } : {}) }
    }
    case 'add-decision': {
      const question = optionalText(edit['question'], 'question')
      return {
        kind: 'add-decision',
        title: text(edit['title'], 'title'),
        ...(question !== undefined ? { question } : {}),
        ...(edit['blocks'] !== undefined ? { blocks: texts(edit['blocks'], 'blocks') } : {}),
        ...(edit['docs'] !== undefined ? { docs: docRefs(edit['docs']) } : {}),
        ...(edit['options'] !== undefined ? { options: decisionOptions(edit['options']) } : {}),
        ...(edit['input'] !== undefined ? { input: decisionInput(edit['input']) } : {})
      }
    }
    case 'update-decision': {
      const title = optionalText(edit['title'], 'title')
      const question = optionalText(edit['question'], 'question')
      const outcome = optionalText(edit['outcome'], 'outcome')
      return {
        kind: 'update-decision',
        decision: text(edit['decision'], 'decision'),
        ...(title !== undefined ? { title } : {}),
        ...(question !== undefined ? { question } : {}),
        ...(outcome !== undefined ? { outcome } : {}),
        ...(edit['status'] !== undefined ? { status: oneOf<DecisionStatus>(edit['status'], DECISION_STATUSES, 'status') } : {}),
        ...(edit['blocks'] !== undefined ? { blocks: texts(edit['blocks'], 'blocks') } : {}),
        ...(edit['docs'] !== undefined ? { docs: docRefs(edit['docs']) } : {}),
        ...(edit['options'] !== undefined ? { options: decisionOptions(edit['options']) } : {}),
        ...(edit['input'] !== undefined ? { input: decisionInput(edit['input']) } : {}),
        ...(edit['chosen'] !== undefined ? { chosen: chosenIndex(edit['chosen']) } : {})
      }
    }
    case 'remove-decision':
      return { kind: 'remove-decision', decision: text(edit['decision'], 'decision') }
    default:
      throw new Error('edit.kind is not a tracker edit')
  }
}

export function trackerTarget(value: unknown): { ticket: string } | { milestone: string } {
  const target = object(value, 'target')
  if (typeof target['ticket'] === 'string') return { ticket: target['ticket'] }
  if (typeof target['milestone'] === 'string') return { milestone: target['milestone'] }
  throw new Error('target must name a ticket or a milestone')
}

export function docsEdit(value: unknown): MapDocsEdit {
  const edit = object(value, 'edit')
  switch (edit['kind']) {
    case 'add-doc':
      return { kind: 'add-doc', path: text(edit['path'], 'path'), milestones: texts(edit['milestones'] ?? [], 'milestones'), section: textOrNull(edit['section'] ?? null, 'section') }
    case 'update-doc':
      return {
        kind: 'update-doc',
        path: text(edit['path'], 'path'),
        ...(edit['milestones'] !== undefined ? { milestones: texts(edit['milestones'], 'milestones') } : {}),
        ...(edit['section'] !== undefined ? { section: textOrNull(edit['section'], 'section') } : {}),
        ...(edit['roles'] !== undefined ? { roles: roles(edit['roles']) } : {}),
        ...(edit['link'] !== undefined ? { link: docLink(edit['link']) } : {})
      }
    case 'add-link':
      return { kind: 'add-link', url: text(edit['url'], 'url'), title: text(edit['title'], 'title'), roles: roles(edit['roles'] ?? []), milestones: texts(edit['milestones'] ?? [], 'milestones') }
    case 'remove-doc':
      return { kind: 'remove-doc', path: text(edit['path'], 'path') }
    case 'add-section':
      return { kind: 'add-section', title: text(edit['title'], 'title'), ...(edit['doc'] !== undefined ? { doc: text(edit['doc'], 'doc') } : {}) }
    case 'rename-section':
      return { kind: 'rename-section', section: text(edit['section'], 'section'), title: text(edit['title'], 'title') }
    case 'remove-section':
      return { kind: 'remove-section', section: text(edit['section'], 'section') }
    default:
      throw new Error('edit.kind is not a docs edit')
  }
}

export function mapDoc(value: unknown): MapDoc {
  const doc = object(value, 'doc')
  return { path: text(doc['path'], 'path'), milestones: texts(doc['milestones'] ?? [], 'milestones'), section: textOrNull(doc['section'] ?? null, 'section'), roles: roles(doc['roles'] ?? []) }
}

export function launchRequest(value: unknown): MapLaunchRequest {
  const request = object(value, 'request')
  const scope = parseScope(request['scope'])
  if (!scope) throw new Error('scope must name a ticket, tickets or a milestone')
  return {
    docsRoot: text(request['docsRoot'], 'docsRoot'),
    map: mapId(request['map']),
    scope,
    mode: oneOf<LaunchMode>(request['mode'], LAUNCH_MODES, 'mode'),
    project: textOrNull(request['project'] ?? null, 'project'),
    batch: batchId(request['batch'] ?? null),
    ...(request['note'] !== undefined ? { note: text(request['note'], 'note') } : {}),
    cols: cells(request['cols'], 'cols'),
    rows: cells(request['rows'], 'rows')
  }
}

export function briefRequest(value: unknown): MapBriefRequest {
  const request = object(value, 'request')
  return {
    docsRoot: text(request['docsRoot'], 'docsRoot'),
    map: mapId(request['map']),
    ticket: text(request['ticket'], 'ticket'),
    mode: oneOf<LaunchMode>(request['mode'], LAUNCH_MODES, 'mode'),
    project: textOrNull(request['project'] ?? null, 'project'),
    note: text(request['note'] ?? '', 'note')
  }
}

/** A batch id the renderer made up for launches started together, or null. */
export function batchId(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !BATCH_ID.test(value)) throw new Error('batch must be a batch id')
  return value
}

/** Ids of doc-change threads to approve. */
export function threadIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && id.length > 0)) throw new Error('include must be a list of thread ids')
  return value.filter((id): id is string => typeof id === 'string')
}

export function picks(value: unknown): number[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || !value.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) throw new Error('pick must be a list of indexes or null')
  return value.filter((n): n is number => typeof n === 'number')
}
