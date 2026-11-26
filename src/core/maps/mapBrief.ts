import type { BriefReadiness, ConfirmProposals, DocRef, MapDecision, MapDoc, MapLaunch, MapMilestone, MapTicket, TicketStatus } from '../../shared/ipc'
import { isClosed, ticketProgress } from '../../shared/ipc'
import { fenced } from '../threads/implementationBrief'
import { decisionNumber, findTicket, mapKey, openDecisions, scopeTicketIds, type MapFile, type Tracker } from './mapModel'

/** The trailer a launch's commits end with, so landing can be detected after a squash merge. */
export const LAUNCH_TRAILER = 'Manta-Launch'

export interface LaunchBriefContext {
  map: MapFile
  tracker: Tracker
  launch: MapLaunch
  /** The ticket this session focuses on inside a shared worktree; null for the launch's whole scope. */
  ticket: string | null
  docsRoot: string
  /** The code project's name, and the worktree the session runs in. */
  project: string
  /** The commands that verify work in the project; empty when the map sets none. */
  checks?: readonly string[]
  /** Titles of the other sessions running in the same worktree right now. */
  others?: readonly string[]
  /** Wrap-ups of earlier work in the same milestone, most recent last. */
  earlier?: readonly { title: string; summary: string }[]
  /** The user's note for this start, from the brief page. */
  note?: string
}

/** How many earlier wrap-ups a brief carries, so it stays a pointer and not a history. */
const EARLIER_LIMIT = 5

const STATUS_LABEL: Record<TicketStatus, string> = { todo: 'to do', 'in-progress': 'in progress', blocked: 'blocked', 'in-review': 'in review', done: 'done', cancelled: 'cancelled' }

function firstLines(text: string, lines: number): string {
  const kept = text.trim().split('\n').filter((line) => line.trim()).slice(0, lines).join(' ')
  return kept.length > 400 ? `${kept.slice(0, 397)}…` : kept
}

function docLine(doc: DocRef): string {
  return `- \`${doc.path}\`${doc.heading ? ` § ${doc.heading}` : ''}`
}

function ticketBlock(ticket: MapTicket, level: string, tracker: Tracker): string[] {
  const after = ticket.after.flatMap((id) => findTicket(tracker, id)?.ticket ?? [])
  return [
    `${level} Ticket: ${ticket.title} (\`${ticket.id}\`, ${STATUS_LABEL[ticket.status]})`,
    '',
    ...(ticket.description.trim() ? [ticket.description.trim(), ''] : ['No description.', '']),
    ...(ticket.acceptance.length > 0
      ? ['Done when (each criterion with its index, for `wrap_up`):', ...ticket.acceptance.map((criterion, index) => `- [${index}] ${criterion}`), '']
      : ['It has no acceptance criteria: decide what done means, say it in your journal, and check it before you finish.', '']),
    ...(ticket.constraints.length > 0 ? ['Constraints and non-goals:', ...ticket.constraints.map((c) => `- ${c}`), ''] : []),
    ...(after.length > 0 ? ['It waits for:', ...after.map((t) => `- ${t.title} (\`${t.id}\`, ${STATUS_LABEL[t.status]})`), ''] : []),
    ...decisionLines(openDecisions(tracker, ticket.id)),
    ...(ticket.docs.length > 0 ? ['Docs it relies on:', ...ticket.docs.map(docLine), ''] : [])
  ]
}

function decisionLines(open: readonly MapDecision[]): string[] {
  if (open.length === 0) return []
  return [
    'It waits for decisions the user hasn\'t made yet. Ask the user, or work around them without settling them yourself:',
    ...open.map((d) => `- Decision ${decisionNumber(d)}: ${d.title}${d.question.trim() ? `: ${firstLines(d.question, 2)}` : ''}`),
    ''
  ]
}

function doneWhenLines(milestone: MapMilestone | null): string[] {
  if (!milestone || milestone.doneWhen.length === 0) return []
  return ['The milestone is done when (ticked items the user has confirmed):', ...milestone.doneWhen.map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`), '']
}

/** The docs of the milestone, with each ticket's own doc sections, once each. */
function scopeDocs(map: MapFile, milestone: MapMilestone | null, tickets: readonly MapTicket[]): DocRef[] {
  const seen = new Set<string>()
  const docs: DocRef[] = []
  const add = (doc: DocRef): void => {
    const key = `${doc.path}#${doc.heading ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    docs.push(doc)
  }
  for (const ticket of tickets) for (const doc of ticket.docs) add(doc)
  const forMilestone = (doc: MapDoc): boolean => milestone !== null && doc.milestones.includes(milestone.id)
  for (const doc of map.docs.filter((d) => !d.link && forMilestone(d))) add({ path: doc.path, heading: null })
  return docs
}

/** The docs a one-ticket brief points to: the ticket's own sections, then its milestone's docs. */
export function ticketBriefDocs(map: MapFile, tracker: Tracker, ticket: string): DocRef[] {
  const found = findTicket(tracker, ticket)
  return found ? scopeDocs(map, found.milestone, [found.ticket]) : []
}

/**
 * Whether a ticket's brief gives an agent enough to work from: an objective, acceptance criteria and
 * source context, with nothing it waits for still open. Advisory: the page says so, starting is never refused.
 */
export function briefReadiness(map: Pick<MapFile, 'key' | 'title'>, tracker: Tracker, ticket: MapTicket, docs: readonly DocRef[]): BriefReadiness {
  const parts: [boolean, string, string][] = [
    [ticket.description.trim() !== '', 'Objective', 'No objective'],
    [ticket.acceptance.length > 0, 'criteria', 'No acceptance criteria'],
    [docs.length > 0, 'source context', 'No source context']
  ]
  const waits = ticket.after.flatMap((id) => findTicket(tracker, id)?.ticket ?? []).filter((t) => !isClosed(t.status))
  const blocking = [
    ...waits.map((t) => `Waits for ${mapKey(map)}-${t.number}`),
    ...openDecisions(tracker, ticket.id).map((d) => `Decision ${decisionNumber(d)} is open`)
  ]
  const missing = parts.filter(([has]) => !has).map(([, , lack]) => lack)
  return { ready: missing.length === 0 && blocking.length === 0, included: parts.filter(([has]) => has).map(([, name]) => name), missing, blocking }
}

/**
 * What a session launched from the map is told, appended to its system prompt. Scoped: the map in a
 * line or two, its milestone, its ticket(s) in full, and the paths (not contents) of the docs it
 * relies on, plus how to work under the map. Rebuilt on every start, so a resumed session sees the
 * map as it is now.
 */
export function launchBrief(context: LaunchBriefContext): string {
  const { map, tracker, launch } = context
  const scope = launch.scope
  const milestone =
    'milestone' in scope ? (tracker.milestones.find((m) => m.id === scope.milestone) ?? null) : (tracker.milestones.find((m) => m.tickets.some((t) => scopeTicketIds(scope).includes(t.id))) ?? null)
  const all = tracker.milestones.flatMap((m) => m.tickets)
  const focusId = context.ticket ?? ('ticket' in scope ? scope.ticket : null)
  const focus = focusId ? (all.find((t) => t.id === focusId) ?? null) : null
  const scoped = focus ? [focus] : 'milestone' in scope ? (milestone?.tickets ?? []) : scopeTicketIds(scope).flatMap((id) => all.find((t) => t.id === id) ?? [])
  const docs = scopeDocs(map, milestone, scoped)

  const lines = [
    '# Manta context map brief',
    '',
    `You were started from Manta's context map "${map.title}" (Manta map ${map.id}, launch ${launch.id}). The map is the user's home for this work: its plan (milestones and tickets), its docs, and what earlier sessions did.`,
    ...(map.description.trim() ? ['', `The map: ${firstLines(map.description, 2)}`] : []),
    ''
  ]

  if (focus) {
    lines.push(`## Your scope: one ticket`, '')
    if (milestone) lines.push(`It belongs to the milestone "${milestone.title}"${milestone.description.trim() ? `: ${firstLines(milestone.description, 2)}` : '.'}`, '', ...doneWhenLines(milestone))
    if ('milestone' in scope || 'tickets' in scope) lines.push('You work in a worktree shared with other tickets of the same launch; other sessions may be working there too. Stay within your ticket.', '')
    lines.push(...ticketBlock(focus, '###', tracker))
  } else if ('milestone' in scope && milestone) {
    lines.push(`## Your scope: the milestone "${milestone.title}"`, '')
    lines.push(...(milestone.description.trim() ? [milestone.description.trim(), ''] : []), ...doneWhenLines(milestone))
    if (milestone.tickets.length > 0) {
      lines.push('Its tickets, in order:', ...milestone.tickets.map((t) => `- ${t.title} (\`${t.id}\`, ${STATUS_LABEL[t.status]})`), '')
      lines.push('Use `map_ticket` for a ticket in full. Work through the tickets that are not done, in order, reporting each one.', '')
    } else {
      lines.push('It has no tickets: the milestone is the unit of work.', '')
    }
  } else {
    lines.push(`## Your scope: ${scoped.length} tickets, together`, '')
    if (milestone) lines.push(`In the milestone "${milestone.title}"${milestone.description.trim() ? `: ${firstLines(milestone.description, 2)}` : '.'}`, '', ...doneWhenLines(milestone))
    for (const ticket of scoped) lines.push(...ticketBlock(ticket, '###', tracker))
  }

  const note = context.note?.trim()
  if (note) lines.push('## A note from the user for this start', '', note, '')

  const others = context.others ?? []
  if (others.length > 0) {
    lines.push(
      '## Others in this worktree',
      '',
      `Other sessions are working in this worktree right now: ${others.map((title) => `“${title}”`).join(', ')}. You share its files and git index, so commit only the paths you changed (\`git add <paths>\`, never \`git add -A\` or \`git commit -a\`), and leave their changes alone.`,
      ''
    )
  }

  const earlier = (context.earlier ?? []).slice(-EARLIER_LIMIT)
  if (earlier.length > 0) {
    lines.push('## Earlier work in this milestone', '', 'How earlier sessions wrapped up (`map_journal` with their ticket gives the rest):', ...earlier.map((e) => `- ${e.title}: ${firstLines(e.summary, 3)}`), '')
  }

  lines.push(
    '## Where things are',
    '',
    `- You work in a worktree of the code project \`${context.project}\` on the branch \`${launch.branch}\`.`,
    `- The docs repo is \`${context.docsRoot}\`; doc paths below are inside it. It is read-only for you: never edit, create or delete files in it. Doc changes go through \`propose_doc_change\`.`,
    ...(docs.length > 0 ? ['- Docs for this work (read them when you need them; they are not quoted here):', ...docs.map((doc) => `  ${docLine(doc)}`)] : ['- The map lists no docs for this work yet; `map_docs` lists all of its docs.']),
    `- End every commit message with the trailer \`${LAUNCH_TRAILER}: ${launch.id}\`, so Manta can tell when this work has landed.`,
    '',
    ...workingUnderAMap(context.map.confirmProposals),
    '',
    ...finishingSteps(context.checks ?? [], launch, context.map.confirmProposals)
  )
  return `${lines.join('\n')}\n`
}

/** Every doc proposal from a map agent: the smallest edit that makes the doc right, since every later session reads it. */
export const MINIMAL_DOC_CHANGES =
  'Keep doc changes minimal: the smallest edit that makes the doc right, at its own level of detail and in its own voice. No new sections, examples, restating or tidying; every line added is read by every later session.'

/** Everything a map agent writes for the map's screens (titles, descriptions, summaries, outcomes), which are read at a glance in narrow columns. */
export const MAP_WRITING =
  'Write for a glance: titles of a few words, descriptions and summaries of a sentence or two. Lead with the point in plain words. Leave out spec section numbers, file paths and ids unless they are the point, and don\'t repeat what another field already says.'

/**
 * How to work under a map: the "skill" every launched session gets in its brief. With `ask`, the
 * session puts its proposals to the user (AskUserQuestion) before raising them.
 */
export function workingUnderAMap(confirm: ConfirmProposals): string[] {
  const proposing =
    confirm === 'ask'
      ? [
          '- **Ask the user before you propose anything to the map.** Collect proposals as you go (tickets, plan changes, docs to list or write, doc changes) and put them to the user with AskUserQuestion at a decision point or at wrap-up, never one at a time mid-task: one question per proposal, up to four per call, each saying what you propose and why in a sentence or two, with the options to propose it or skip it. Raise only the ones the user accepts.',
          '- **Accepted tickets, plan changes and docs to list** (`suggest_ticket`, `propose_plan_change`, `suggest_doc`): pass `confirmed_with_user: true` and they apply at once. **Docs to write and doc changes** (`suggest_doc_to_write`, `propose_doc_change`) always wait for the user in Manta, even when accepted: they review the diff there.'
        ]
      : ['- **Proposals wait in Needs review** for the user; the user is not watching this session, so raise them with the tools directly, without asking first.']
  return [
    '## Working under the map',
    '',
    'The map tools (`mcp__manta__…`) are your link to the map. They are allowed without asking.',
    '',
    '- **Query the map instead of guessing.** `map_outline` gives the milestones, their statuses and the docs; `map_milestone`, `map_ticket`, `map_docs` and `map_journal` give more.',
    `- **Report status as it changes**, for tickets in your scope: \`set_ticket_status\` with \`in-progress\` when you start one, \`blocked\` with the reason when you cannot go on without the user (and \`in-progress\` again once they have answered), ${confirm === 'ask' ? '`done` once the whole ticket is finished, its work merged, and verified with the user (ask them with AskUserQuestion first)' : 'and leave `done` to the user, who marks a ticket done once its work is merged and verified'}. A ticket on its own branch goes in review by itself when its pull request opens, and cannot be done until that pull request merges; a ticket can take several pull requests.`,
    '- **Report progress for the board** (`report_progress`): your phase and a one-line summary whenever the phase changes, and `needs` before you ask the user anything (report again without it once answered). The user, and a coordinator when one runs, read the board instead of your session.',
    `- **What you write to the map** (titles, descriptions, progress, the wrap-up) is read at a glance on its screens. ${MAP_WRITING}`,
    '- **Journal as you go**, not only at the end (`journal`): what you decided and why, where you departed from the plan or a doc, docs you found wrong, docs you relied on. A line or two each.',
    '- **If the plan is wrong**, say so with `propose_plan_change` (reword, split, reorder, drop tickets, or change what they wait for) rather than quietly doing something else.',
    confirm === 'ask'
      ? "- **A question only the user can settle** (a product choice, a name, a trade-off the docs leave open): ask them (AskUserQuestion), with an option to decide it later. Record an answer later work depends on with `propose_decision`, its `outcome` and `confirmed_with_user: true`. If they decide later, raise it open with the tickets it blocks and go on with what it doesn't block; Manta sends you the outcome here once they decide."
      : "- **A question only the user can settle** (a product choice, a name, a trade-off the docs leave open): `propose_decision` with the tickets it blocks, then go on with what it doesn't block. Manta sends you the outcome here once the user decides it.",
    ...proposing,
    `- **Doc changes** (\`propose_doc_change\`) only where a doc is wrong or missing a decision. ${MINIMAL_DOC_CHANGES}`,
    '- **Wrap up before you stop**: read your journal (`map_journal`), set the statuses, work out the doc changes, docs the map should list (`suggest_doc`) or that are worth writing (`suggest_doc_to_write`) and tickets for work you found (`suggest_ticket`), raise them as above, then call `wrap_up` with each acceptance criterion judged (with its evidence and where to find it), the checks you ran and whether they passed, anything you could not verify, decisions or assumptions you made, and remaining risks. The user reviews the work from it. If the work went to plan, say so and propose nothing.'
  ]
}

export interface CoordinatorBriefContext {
  map: MapFile
  tracker: Tracker
  /** The batch's launches, in the order they started. */
  launches: readonly MapLaunch[]
  batch: string
  /** `boardText` as it is now. */
  board: string
}

/**
 * The brief of a batch's coordinator: a session that watches the batch's agents through the board and
 * tells the user what needs them, in order. It never does the work, and keeps its own context small.
 */
export function coordinatorBrief(context: CoordinatorBriefContext): string {
  const { map, tracker, launches } = context
  const lines = [
    '# Manta coordinator brief',
    '',
    `You coordinate ${launches.length} agents started together from the context map "${map.title}" (Manta map ${map.id}, batch ${context.batch}). Each works on its own ticket in its own worktree and session.`,
    '',
    '## The batch',
    ''
  ]
  for (const launch of launches) {
    for (const id of scopeTicketIds(launch.scope)) {
      const found = findTicket(tracker, id)
      if (!found) continue
      const { ticket } = found
      const waits = ticket.after.map((a) => findTicket(tracker, a)?.ticket.title).filter((t): t is string => Boolean(t))
      lines.push(
        `- **${ticket.title}** (\`${ticket.id}\`, launch \`${launch.id}\`, branch \`${launch.branch}\`): ${firstLines(ticket.description, 1) || 'no description'}${ticket.acceptance.length > 0 ? ` ${ticket.acceptance.length} acceptance criteria.` : ''}${waits.length > 0 ? ` Waits for ${waits.map((t) => `“${t}”`).join(', ')}.` : ''}`
      )
    }
  }
  lines.push(
    '',
    '## The board now',
    '',
    context.board,
    '',
    '## Your job',
    '',
    '- **Tell the user what needs them, in order**, one line each: what, which session (its ticket title, which is its tab), and why it ranks there. Rank by what unblocks most: a session waiting or blocked that other tickets wait for first, then decisions, then finished work to review or open a pull request for, then pull requests with failing checks or changes requested, then ones ready to merge. Say plainly when nothing needs them.',
    '- **Coordinate only.** Never edit code or docs, run builds or tests, or propose changes to the map. You can\'t type into other sessions: when one needs an answer, tell the user what it asks and, if you can, what you would answer.',
    '- **Keep your context small.** Read the board (`board`), not code, diffs or transcripts. Use `map_ticket` or `map_journal` for one launch only when the user asks about it or the board isn\'t enough.',
    '- **Manta tells you when something changes** with a prompt that starts "Manta: changed since you last looked". Reply with the updated order only when the order or what needs the user changed; otherwise one line. Don\'t poll.',
    '',
    'Start by reading the board and giving the user the current order.'
  )
  return `${lines.join('\n')}\n`
}

/** What "finished" means for a launch: the project's checks, commits with the trailer, then a draft pull request. */
export function finishingSteps(checks: readonly string[], launch: Pick<MapLaunch, 'id' | 'branch' | 'scope'>, confirm: ConfirmProposals = 'ask'): string[] {
  /** Done needs the user to have seen the result; a session nobody watches leaves it to them. */
  const verify = confirm === 'ask' ? 'verify the result with the user (AskUserQuestion) and report' : 'leave it to the user to mark'
  return [
    '## Finishing',
    '',
    'When the work in your scope is done:',
    '',
    ...(checks.length > 0
      ? ['1. Run the checks, and fix what fails before going on:', ...checks.map((command) => `   - \`${command}\``)]
      : ["1. Run the project's own tests and type checks (its README or package scripts say which), and fix what fails before going on."]),
    `2. Commit, each message ending with \`${LAUNCH_TRAILER}: ${launch.id}\`.`,
    `3. If \`gh\` is set up, push \`${launch.branch}\` and open a draft pull request with \`gh pr create --draft\`: the ticket's title, and a body saying what changed, how each acceptance criterion is met, and the checks you ran, kept short. Without \`gh\`, skip this; Manta offers to open it.`,
    'ticket' in launch.scope
      ? `4. Wrap up with \`finished: true\`. The ticket goes in review when its pull request opens, and Manta follows it: review comments and failing checks come back to you here. Once it has merged, ${verify} the ticket \`done\`.`
      : `4. Wrap up with \`finished: true\`; for each finished ticket, ${verify} it \`done\`. Manta follows the pull request from there: review comments and failing checks come back to you here.`
  ]
}

/** Ask the map's system prompt: who it works for and what it may change. */
export function askSystemPrompt(map: MapFile, docsRoot: string, projects: readonly { name: string; root: string }[], outlineFile: string): string {
  return [
    `You are the agent of the Manta context map "${map.title}". The map is the user's home for one feature or project: a plan of milestones and tickets, the docs about it, and the work launched from it.`,
    ...(map.description.trim() ? [`What it is: ${map.description.trim()}`] : []),
    '',
    `${outlineFile} in your working directory is the map's outline as of the start of this turn. The map tools (\`mcp__manta__…\`) query it live: milestones, tickets, docs, journals of past work.`,
    `The docs repo is ${docsRoot}; read docs there. ${projects.length > 0 ? `The code projects are: ${projects.map((p) => `${p.name} (${p.root})`).join(', ')}.` : 'The map has no code projects yet.'}`,
    '',
    'You answer questions about the work and help plan it. You never change the map or the docs directly:',
    '- New milestones and tickets go through `propose_milestones` or `suggest_ticket`; the user reviews them.',
    `- Doc changes go through \`propose_doc_change\`, only where a doc is wrong or missing something. ${MINIMAL_DOC_CHANGES}`,
    '- Docs worth listing or writing go through `suggest_doc` and `suggest_doc_to_write`.',
    '- Questions only the user can settle go through `propose_decision`, with the tickets they block; the user decides them on the Decisions page.',
    `- What you propose is read on the map's screens. ${MAP_WRITING}`
  ].join('\n')
}

/** The sweep's system prompt: a small, cheap wrap-up of a session that didn't do its own. */
export function sweepSystemPrompt(map: MapFile, docsRoot: string): string {
  return [
    `You are the sweep of the Manta context map "${map.title}": you do the wrap-up of a session that ended without one, quickly and cheaply.`,
    `The docs repo is ${docsRoot}. The map tools (\`mcp__manta__…\`) query the map and record the wrap-up; nothing else is allowed. You never edit files.`
  ].join('\n')
}

/** Asks the map agent to break the chosen docs down into milestones and tickets. */
export function breakDownPrompt(docs: readonly string[], projects: readonly string[] = []): string {
  return [
    'Break the work down into milestones and tickets.',
    '',
    docs.length > 0 ? 'Read these docs from the docs repo:' : 'Read the docs the map lists (`map_docs`).',
    ...docs.map((doc) => `- ${doc}`),
    '',
    'Then call `propose_milestones` once with the plan: milestones in the order to do them, each with a short description, its definition of done (\`done_when\`: what must be true for the milestone as a whole, a few items) and its tickets. Give each ticket a title, a description of what to do (its objective), acceptance criteria (one checkable statement each: a behaviour, a test that passes), constraints and non-goals where the docs set them, the tickets it waits for (`after`, by title; leave it empty when it can start at once, so independent tickets can run in parallel), and the doc sections it comes from (`path` and `heading`).',
    ...(projects.length > 1 ? [`The map works in several code projects (${projects.join(', ')}): give each ticket its \`project\`.`] : []),
    'Keep milestones shippable on their own. Check `map_outline` first and don’t repeat milestones the map already has.',
    'Title each milestone by what it delivers ("Production release candidate"). Manta numbers milestones itself (M1, M2, …) by their place in the plan, so leave milestone numbers like "M8 –" out of titles, even when the docs use them.',
    `A milestone's description is one sentence on what it delivers; what it needs from the user goes in \`done_when\` or a decision. ${MAP_WRITING}`
  ].join('\n')
}

export interface SweepContext {
  scopeTitle: string
  launch: MapLaunch
  journal: string
  /** `git log` and `git diff --stat` of the branch since its base. */
  diffSummary: string
  docs: readonly DocRef[]
  /** The pull request's title and body, when it has one. */
  pullRequest?: string
  /** Acceptance criteria of the scope's tickets, with their ids and indexes. */
  criteria?: readonly { ticket: MapTicket }[]
}

/** The sweep's one turn: the wrap-up a session didn't do. */
export function sweepPrompt(context: SweepContext): string {
  return [
    `A session working on "${context.scopeTitle}" (launch ${context.launch.id}, branch ${context.launch.branch}) ended without wrapping up. Do its wrap-up for it, briefly.`,
    '',
    '## Its journal',
    '',
    context.journal.trim() ? fenced(context.journal.trim()) : 'Empty: the session wrote no journal.',
    '',
    '## What the branch changed',
    '',
    context.diffSummary.trim() ? fenced(context.diffSummary.trim()) : 'No commits on the branch.',
    '',
    ...pullRequestPart(context.pullRequest),
    ...criteriaPart(context.criteria ?? []),
    ...(context.docs.length > 0 ? ['## Its docs', '', ...context.docs.map(docLine), ''] : []),
    '## What to do',
    '',
    '- Set the status of tickets in its scope that the journal or commits show are finished or blocked (`set_ticket_status`). Leave the rest.',
    '- Only if the journal says a doc is wrong or missing a decision, propose the fix (`propose_doc_change`), reading the doc first and keeping the edit minimal. Suggest docs it relied on that the map does not list (`suggest_doc`).',
    '- If the journal records a departure from the plan, propose the plan change (`propose_plan_change`).',
    '- If it went to plan, propose nothing.',
    '- Finish with `wrap_up`: one or two sentences on what happened, `finished` only if the commits show the work done, and each criterion you can judge from what you read.',
    MAP_WRITING,
    'Do not read the whole diff unless you must.'
  ].join('\n')
}

function pullRequestPart(text: string | undefined): string[] {
  return text?.trim() ? ['## Its pull request', '', fenced(text.trim()), ''] : []
}

function criteriaPart(tickets: readonly { ticket: MapTicket }[]): string[] {
  const lines = tickets.flatMap(({ ticket }) => ticket.acceptance.map((criterion, index) => `- \`${ticket.id}\` [${index}] ${criterion}`))
  return lines.length > 0 ? ['## Acceptance criteria', '', ...lines, ''] : []
}

/**
 * The landing pass: once a launch's branch has landed, check its docs against what actually
 * landed (review changes and fixes included), whatever its wrap-up said. One cheap turn.
 */
export function landingPrompt(context: SweepContext & { wrappedUp: boolean }): string {
  return [
    `The work on "${context.scopeTitle}" (launch ${context.launch.id}, branch ${context.launch.branch}) has landed on the default branch. Check that its docs still describe what landed.`,
    '',
    '## Its journal',
    '',
    context.journal.trim() ? fenced(context.journal.trim()) : 'Empty: the session wrote no journal.',
    '',
    '## What landed',
    '',
    context.diffSummary.trim() ? fenced(context.diffSummary.trim()) : 'No commits found on the branch.',
    '',
    ...pullRequestPart(context.pullRequest),
    ...(context.docs.length > 0 ? ['## Its docs', '', ...context.docs.map(docLine), ''] : []),
    '## What to do',
    '',
    `- Read the docs above where what landed touches what they describe. Where a doc is now wrong or missing a decision that landed, propose the fix (\`propose_doc_change\`). Never tidy a doc that is still right. ${MINIMAL_DOC_CHANGES}`,
    '- Suggest docs it relied on that the map does not list (`suggest_doc`).',
    ...(context.wrappedUp
      ? ['- Its session already wrapped up; do not set statuses.']
      : ['- Its session never wrapped up: set the statuses the commits show (`set_ticket_status`).']),
    '- Finish with `wrap_up`: one sentence on whether the docs needed anything, `went_to_plan` and `finished` both true unless the journal says otherwise.',
    MAP_WRITING,
    'Do not read the whole diff unless you must.'
  ].join('\n')
}

/** The map as Ask the map's checkout and `map_outline` show it: milestones with statuses, then docs. */
export function mapOutline(map: MapFile, milestones: readonly (MapMilestone & { status: string })[], current: string | null, decisions: readonly MapDecision[] = []): string {
  const lines = [
    `# ${map.title}`,
    '',
    ...(map.description.trim() ? [map.description.trim(), ''] : []),
    ...(map.projects.length > 0 ? [`Code projects: ${map.projects.join(', ')}`, ''] : []),
    '## Milestones',
    ''
  ]
  if (milestones.length === 0) lines.push('None yet.', '')
  const ticketTitles = new Map(milestones.flatMap((m) => m.tickets.map((t) => [t.id, t.title])))
  for (const m of milestones) {
    const { done, total } = ticketProgress(m.tickets)
    lines.push(`- ${m.title} (\`${m.id}\`, ${m.status}${total > 0 ? `, ${done}/${total} done` : ''})${m.id === current ? ' ← current' : ''}`)
    for (const t of m.tickets) {
      const extras = [...(t.project ? [`in ${t.project}`] : []), ...(t.after.length > 0 ? [`waits for ${t.after.map((id) => ticketTitles.get(id) ?? id).join(', ')}`] : [])]
      lines.push(`  - ${t.title} (\`${t.id}\`, ${STATUS_LABEL[t.status]}${t.blocked ? `: ${t.blocked}` : t.cancelled ? `: ${t.cancelled}` : ''})${extras.length > 0 ? `; ${extras.join('; ')}` : ''}`)
    }
  }
  if (decisions.length > 0) {
    lines.push('', '## Decisions', '')
    for (const d of decisions) {
      const blocks = d.blocks.flatMap((id) => ticketTitles.get(id) ?? [])
      const options = d.status === 'open' && d.options.length > 0 ? `; options: ${d.options.map((o) => `${o.title}${o.recommended ? ' (recommended)' : ''}`).join(', ')}` : ''
      lines.push(`- ${decisionNumber(d)} ${d.title} (${d.status}${d.status === 'decided' && d.outcome ? `: ${firstLines(d.outcome, 2)}` : ''})${options}${blocks.length > 0 ? `; blocks ${blocks.join(', ')}` : ''}`)
    }
  }
  lines.push('', '## Docs', '')
  if (map.docs.length === 0) lines.push('None yet.')
  const titles = new Map(milestones.map((m) => [m.id, m.title]))
  const sections = new Map(map.sections.map((s) => [s.id, s.title]))
  for (const doc of map.docs) {
    const tags = [...doc.milestones.flatMap((id) => titles.get(id) ?? []), ...(doc.section ? [`section ${sections.get(doc.section) ?? doc.section}`] : [])]
    const where = doc.link ? `[${doc.link.title}](${doc.link.url}) (a web page)` : `\`${doc.path}\``
    lines.push(`- ${where}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}`)
  }
  return `${lines.join('\n')}\n`
}
