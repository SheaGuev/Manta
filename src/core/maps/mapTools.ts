import type { McpTool } from '../terminal/mcpEndpoint'

/** Who is calling a map tool: a launched session, the sweep for a launch, Ask the map, or a batch's coordinator. */
export type MapRole = 'session' | 'sweep' | 'ask' | 'coordinator'

type Definition = Omit<McpTool, 'call'> & { roles: readonly MapRole[] }

/** The tools that propose or change something; the coordinator only reads. */
const ALL: readonly MapRole[] = ['session', 'sweep', 'ask']
const READERS: readonly MapRole[] = ['session', 'sweep', 'ask', 'coordinator']
const DOC_REF = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Path of the doc inside the docs repo' },
    heading: { type: 'string', description: 'A heading in it, for one section; omit for the whole doc' }
  },
  required: ['path'],
  additionalProperties: false
}
const TICKET_FIELDS = {
  title: { type: 'string', description: 'What changes, in under eight words' },
  description: { type: 'string', description: 'What to do and why, in one to three short sentences (markdown); detail goes in acceptance and constraints' },
  acceptance: { type: 'array', items: { type: 'string' }, description: 'How to tell it is done: one checkable criterion each' },
  constraints: { type: 'array', items: { type: 'string' }, description: 'Constraints and non-goals: what the work must keep or leave alone, one each' },
  after: {
    type: 'array',
    items: { type: 'string' },
    description: 'Tickets that must be done before this one can start: ids from map_outline, or titles of tickets earlier in the same proposal'
  },
  project: { type: 'string', description: 'The code project it is for, by name (from map_outline), when the map has several' },
  docs: { type: 'array', items: DOC_REF, description: 'The doc sections it comes from' }
}
const PROPOSED_TICKET = {
  type: 'object',
  properties: TICKET_FIELDS,
  required: ['title', 'description', 'acceptance'],
  additionalProperties: false
}
const CONFIRMED = {
  type: 'boolean',
  description: 'The user accepted this in the session (AskUserQuestion), when your brief says to ask first: it applies at once instead of waiting in Needs review'
}
const DONE_WHEN = { type: 'array', items: { type: 'string' }, description: "The milestone's definition of done, one item each" }
const MILESTONE_IDS = { type: 'array', items: { type: 'string' }, description: 'Ids of the milestones it belongs to (from map_outline); may be empty' }

/** The map tools by name, and which callers get each. Handlers are bound in `MapLaunches.tools`. */
export const MAP_TOOLS: readonly Definition[] = [
  {
    name: 'map_outline',
    roles: READERS,
    description: "The context map's outline: its milestones in order with their status and tickets (ids, statuses), the current milestone, and its docs with the milestones and sections they belong to.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'map_milestone',
    roles: READERS,
    description: 'One milestone in full: its description, status, its tickets with their descriptions and statuses, and its docs.',
    inputSchema: { type: 'object', properties: { milestone: { type: 'string', description: 'The milestone id' } }, required: ['milestone'], additionalProperties: false }
  },
  {
    name: 'map_ticket',
    roles: READERS,
    description: 'One ticket in full: its description, status, the docs and doc sections it relies on, and the launches that worked on it.',
    inputSchema: { type: 'object', properties: { ticket: { type: 'string', description: 'The ticket id' } }, required: ['ticket'], additionalProperties: false }
  },
  {
    name: 'map_docs',
    roles: READERS,
    description: 'The paths of the docs the map lists, all of them or those of one milestone or section. Read the docs themselves from the docs repo.',
    inputSchema: {
      type: 'object',
      properties: { milestone: { type: 'string', description: 'A milestone id' }, section: { type: 'string', description: 'A section id' } },
      additionalProperties: false
    }
  },
  {
    name: 'map_journal',
    roles: READERS,
    description:
      'Journal entries of launches: what earlier sessions decided, where they departed from the plan, docs they found wrong. Without arguments: your own launch (or, for Ask the map, the most recent launches).',
    inputSchema: {
      type: 'object',
      properties: {
        launch: { type: 'string', description: 'A launch id; omit for your own' },
        ticket: { type: 'string', description: 'A ticket id: the journals of the launches that worked on it' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'report_progress',
    roles: ['session'],
    description:
      "Say where you are, in one line, for the map's board (what the user and the coordinator read instead of your transcript). Overwrites your last report. Call it when your phase changes, and set `needs` before you ask the user anything (clear it once answered by reporting again without it).",
    inputSchema: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['exploring', 'building', 'verifying', 'finishing'] },
        summary: { type: 'string', description: 'One short line: what you are doing or have done' },
        needs: {
          type: 'object',
          description: 'What you need from the user, if anything: a decision, a review of something finished, or to unblock you',
          properties: { kind: { type: 'string', enum: ['decision', 'review', 'unblock'] }, ask: { type: 'string', description: 'The question or request, in a sentence' } },
          required: ['kind', 'ask'],
          additionalProperties: false
        },
        next: { type: 'string', description: 'What you will do next, in a few words' }
      },
      required: ['phase', 'summary'],
      additionalProperties: false
    }
  },
  {
    name: 'board',
    roles: ['coordinator'],
    description:
      "The map's board: a line per running agent (every live launch, your batch first, most urgent first) with its phase, its own one-line report, its session's state, its pull request, and what it needs from the user.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'set_ticket_status',
    roles: ['session', 'sweep'],
    description:
      "Report a ticket's status, for tickets in your launch's scope: in-progress when you start it (and again once the user has unblocked it), blocked (with the reason) when you cannot go on without the user, done once the whole ticket is finished, merged and verified with the user (ask them first). A ticket on its own branch is in review while its pull request is open and can't be done until it merges; a ticket can take several pull requests, so don't report done for one part. Applies at once; no approval.",
    inputSchema: {
      type: 'object',
      properties: {
        ticket: { type: 'string', description: 'The ticket id' },
        status: { type: 'string', enum: ['in-progress', 'blocked', 'done'] },
        reason: { type: 'string', description: 'Why it is blocked; required for blocked' }
      },
      required: ['ticket', 'status'],
      additionalProperties: false
    }
  },
  {
    name: 'journal',
    roles: ['session'],
    description:
      "Append a short entry to your launch's journal, as you go: a decision and why, a departure from the plan or a doc, a doc found wrong, a doc you relied on. Later sessions and the user read it instead of your transcript.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['decision', 'departure', 'doc-wrong', 'doc-used', 'note'] },
        entry: { type: 'string', description: 'One or two sentences' }
      },
      required: ['kind', 'entry'],
      additionalProperties: false
    }
  },
  {
    name: 'wrap_up',
    roles: ['session', 'sweep'],
    description:
      'Record that you wrapped up: statuses set, doc changes proposed only where a doc is wrong or missing a decision, docs suggested. Call it last, before you stop. Say whether the work went to plan, whether it is finished, which acceptance criteria it meets and how you know, the checks you ran, what you could not verify, decisions you made and remaining risks: the user reviews the work from this.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What happened, in one or two sentences and under 40 words; detail goes in criteria, unverified and risks' },
        went_to_plan: { type: 'boolean' },
        finished: { type: 'boolean', description: "The work in your scope is finished: committed, and the project's checks pass. Ready for a pull request." },
        criteria: {
          type: 'array',
          description: "Each acceptance criterion of your scope's tickets, judged",
          items: {
            type: 'object',
            properties: {
              ticket: { type: 'string', description: 'The ticket id' },
              index: { type: 'integer', description: "The criterion's place in the ticket's list, from 0" },
              met: { type: 'boolean' },
              evidence: { type: 'string', description: 'How you know: a test, a command run, what you checked' },
              source: { type: 'string', description: 'Where the evidence is, in a few words, e.g. "Run output · Authentication" or "auth.test.ts"' }
            },
            required: ['ticket', 'index', 'met', 'evidence'],
            additionalProperties: false
          }
        },
        checks: {
          type: 'array',
          description: 'The checks you ran (tests, typecheck, scripts) and whether each passed',
          items: { type: 'object', properties: { command: { type: 'string' }, passed: { type: 'boolean' } }, required: ['command', 'passed'], additionalProperties: false }
        },
        unverified: { type: 'array', items: { type: 'string' }, description: 'What the work did not verify and still needs, e.g. a run on a real device' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions you made or assumptions you introduced, one each' },
        risks: { type: 'array', items: { type: 'string' }, description: 'Risks that remain, one each' }
      },
      required: ['summary', 'went_to_plan', 'finished'],
      additionalProperties: false
    }
  },
  {
    name: 'suggest_doc',
    roles: ALL,
    description: 'Suggest an existing doc of the docs repo the map should list, because the work relied on it. The user adds it with one click.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path of the doc inside the docs repo' }, why: { type: 'string' }, milestones: MILESTONE_IDS, confirmed_with_user: CONFIRMED },
      required: ['path', 'why'],
      additionalProperties: false
    }
  },
  {
    name: 'suggest_doc_to_write',
    roles: ALL,
    description: 'Suggest a doc worth writing for this work (a decision or design nobody wrote down). The user creates it with one click.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A title of a few words that becomes its heading, e.g. "Production setup runbook"; not a file name' },
        why: { type: 'string' },
        milestones: MILESTONE_IDS
      },
      required: ['title', 'why'],
      additionalProperties: false
    }
  },
  {
    name: 'suggest_ticket',
    roles: ALL,
    description: 'Suggest a new ticket for work you found that also needs doing. It waits for the user to approve, unless they already accepted it in the session.',
    inputSchema: {
      type: 'object',
      properties: { milestone: { type: 'string', description: 'The milestone id it belongs to' }, ...TICKET_FIELDS, why: { type: 'string' }, confirmed_with_user: CONFIRMED },
      required: ['milestone', 'title', 'description', 'acceptance', 'why'],
      additionalProperties: false
    }
  },
  {
    name: 'propose_decision',
    roles: ['session', 'ask'],
    description:
      'Raise a question only the user can settle (a product choice, a name, a trade-off), naming the tickets that wait for it. It goes on the map as an open decision at once; the user decides it there. Not for choices you can make yourself: journal those.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A few words, e.g. "Production domain"' },
        question: { type: 'string', description: 'The question and what hangs on it, in a sentence or two' },
        options: {
          type: 'array',
          description: 'The choices you see, two or more when there are; mark the one you recommend',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'A few words, e.g. "Dedicated production host"' },
              detail: { type: 'string', description: 'What it means and costs, in a line or two' },
              recommended: { type: 'boolean', description: 'Your recommendation; at most one' }
            },
            required: ['title'],
            additionalProperties: false
          }
        },
        requires: { type: 'string', description: 'A value the user has to supply to confirm it, e.g. "Production domain"; omit when choosing is enough' },
        blocks: { type: 'array', items: { type: 'string' }, description: 'Ids of the tickets that cannot go on until it is decided (from map_outline)' },
        docs: { type: 'array', items: DOC_REF, description: 'The doc sections the question comes from or would change' },
        outcome: { type: 'string', description: 'Only when the user already decided it with you (AskUserQuestion): what was decided and why, in one sentence. Needs confirmed_with_user.' },
        confirmed_with_user: { type: 'boolean', description: 'The user decided it with you in the session: it is recorded as decided, with the outcome' }
      },
      required: ['title', 'question'],
      additionalProperties: false
    }
  },
  {
    name: 'propose_plan_change',
    roles: ALL,
    description:
      'Propose changes to the existing plan: reword, split (update one ticket and add another), reorder, move or drop tickets, or change what they wait for. Use it when the work departed from the plan or found the plan wrong. The user approves each change, unless they already accepted them in the session.',
    inputSchema: {
      type: 'object',
      properties: {
        why: { type: 'string', description: 'What showed the plan should change' },
        confirmed_with_user: CONFIRMED,
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['update-ticket', 'add-ticket', 'move-ticket', 'remove-ticket', 'update-milestone', 'move-milestone'] },
              ticket: { type: 'string', description: 'The ticket id (update, move, remove)' },
              milestone: { type: 'string', description: 'The milestone id (add-ticket and move-ticket: where it goes; update and move milestone: which)' },
              before: { type: 'string', description: 'Id of the ticket or milestone to put it before; omit for the end' },
              done_when: DONE_WHEN,
              ...TICKET_FIELDS
            },
            required: ['kind'],
            additionalProperties: false
          }
        }
      },
      required: ['why', 'changes'],
      additionalProperties: false
    }
  },
  {
    name: 'propose_milestones',
    roles: ['ask'],
    description:
      'Propose milestones (each with its tickets) to add to the end of the plan. The user approves them whole or milestone by milestone. Call it once per plan, with the milestones in order.',
    inputSchema: {
      type: 'object',
      properties: {
        why: { type: 'string', description: 'What the plan is based on' },
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'What it delivers, without a number: Manta numbers milestones by their place in the plan' },
              description: {
                type: 'string',
                description: 'What it delivers, in one sentence under 20 words. What it needs from the user goes in done_when or a decision, not here.'
              },
              done_when: DONE_WHEN,
              tickets: { type: 'array', items: PROPOSED_TICKET }
            },
            required: ['title', 'description', 'tickets'],
            additionalProperties: false
          }
        }
      },
      required: ['why', 'milestones'],
      additionalProperties: false
    }
  }
]

export function mapToolDefinitions(role: MapRole): Definition[] {
  return MAP_TOOLS.filter((tool) => tool.roles.includes(role))
}
