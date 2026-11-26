import { randomUUID } from 'node:crypto'
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ImplementationRequest, ImplementationStart, ProjectWorktree, PullRequestInfo, TerminalInfo, TerminalLink, ThreadInfo } from '../shared/ipc'
import { Git } from './repo/git'
import { branchLanded } from './repo/landing'
import type { PullRequestLookup } from './repo/github'
import type { McpTool } from './terminal/mcpEndpoint'
import type { ProjectRegistry } from './repo/projects'
import type { TerminalManager, TerminalSize } from './terminal/terminals'
import type { Workspace } from './workspace'
import type { ProposalAuthor } from './workspaceThreads'

export interface ImplementationsOptions {
  projects: ProjectRegistry
  terminals: TerminalManager
  /** Where each implementation session's brief is written, one file per thread. */
  briefsDir: string
  /** Finds a branch's pull request; without it, only git decides whether work has landed. */
  pullRequests?: PullRequestLookup
  /** A session proposed a doc change, now a thread waiting for review. */
  onProposal?: (docsRoot: string, thread: ThreadInfo) => void
}

const PROPOSE_ARGS: readonly ('doc' | 'find' | 'replace' | 'title' | 'why')[] = ['doc', 'find', 'replace', 'title', 'why']
const WITHDRAW_ARGS: readonly ('thread' | 'why')[] = ['thread', 'why']
const REVISE_ARGS: readonly ('thread' | 'find' | 'replace' | 'why')[] = ['thread', 'find', 'replace', 'why']

type ToolResult = Awaited<ReturnType<McpTool['call']>>

/**
 * The `propose_doc_change` tool implementation sessions get. `call` is late-bound because the
 * terminal manager that serves it is created before `Implementations`.
 */
export function proposeDocChangeTool(call: McpTool['call']): McpTool {
  return {
    name: 'propose_doc_change',
    description:
      'Propose a change to a doc in the Manta docs repo. Each call becomes a Manta thread on the section containing `find`, ' +
      'with the edit proposed for the user to review and approve; the doc itself is not changed. ' +
      "Use it for high-level corrections at the doc's own level of detail: a statement that is wrong, missing architecture, " +
      'or a decision or fix the doc did not foresee. Never code-level detail. Keep it minimal: the smallest edit that makes the doc right, ' +
      'in its own voice, with no new sections, examples or restating, since every later session reads the doc. Put related points about one section into one proposal. ' +
      '`find` must be text copied exactly from the doc as it is now, appearing once in it.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Path of the doc inside the docs repo, e.g. docs/plans/feature.md' },
        find: { type: 'string', description: 'Exact text in the doc to replace; include enough to appear only once' },
        replace: { type: 'string', description: 'What it should say instead' },
        title: { type: 'string', description: 'A short title for the proposal, under 60 characters' },
        why: { type: 'string', description: 'Why the doc should change: what the implementation found' }
      },
      required: [...PROPOSE_ARGS],
      additionalProperties: false
    },
    call
  }
}

/** The `withdraw_doc_change` tool; `call` is late-bound like `proposeDocChangeTool`'s. */
export function withdrawDocChangeTool(call: McpTool['call']): McpTool {
  return {
    name: 'withdraw_doc_change',
    description:
      'Take back a doc change you proposed with propose_doc_change, when you no longer think the doc should change that way. ' +
      'The proposal is closed as withdrawn, with your reason; it stays in Manta as a record. Only open proposals can be withdrawn.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'The proposal’s thread id, as propose_doc_change returned it' },
        why: { type: 'string', description: 'Why you are withdrawing it' }
      },
      required: [...WITHDRAW_ARGS],
      additionalProperties: false
    },
    call
  }
}

/** The `revise_doc_change` tool; `call` is late-bound like `proposeDocChangeTool`'s. */
export function reviseDocChangeTool(call: McpTool['call']): McpTool {
  return {
    name: 'revise_doc_change',
    description:
      'Change a doc change you proposed with propose_doc_change and that is still open. `find` is exact text in the proposed version ' +
      '(for example part of your earlier `replace`), appearing once in it; it becomes `replace`. Your reason is added to the proposal.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'The proposal’s thread id, as propose_doc_change returned it' },
        find: { type: 'string', description: 'Exact text in the proposed version of the doc; include enough to appear only once' },
        replace: { type: 'string', description: 'What it should say instead' },
        why: { type: 'string', description: 'Why you are changing the proposal' }
      },
      required: [...REVISE_ARGS],
      additionalProperties: false
    },
    call
  }
}

/** The trailer an implementation session ends its commits with, and approved doc threads already use. */
const TRAILER = 'Manta-Thread'

/**
 * Implementation threads end to end: a thread on a doc section in the docs repo, a worktree in a
 * code project, and a Claude Code session there that is told about the section. Composes the
 * project registry, the docs workspace's threads and the terminal manager.
 */
export class Implementations {
  constructor(private readonly options: ImplementationsOptions) {}

  /**
   * Creates the worktree (when asked for a new one), the thread, the brief and the session, in that
   * order. A failure after the worktree was created removes it again, and a thread whose session
   * never started is discarded, so a failed start leaves nothing running.
   */
  async start(request: ImplementationRequest): Promise<ImplementationStart> {
    const { projects, terminals } = this.options
    const docsRoot = await projects.resolveRoot(request.docsRoot)
    if (!projects.list().some((p) => p.kind === 'docs' && p.root === docsRoot)) throw new Error(`${request.docsRoot} is not the docs repo`)
    const project = projects.list().find((p) => p.kind === 'code' && p.root === request.project)
    if (!project) throw new Error(`${request.project} is not a code project`)
    if (!request.prompt.trim()) return { ok: false, message: 'Give the session a first prompt' }
    if (!terminals.claudeAvailable()) return { ok: false, message: 'Claude Code is not installed: install it, then try again' }

    let worktree: ProjectWorktree
    let created = false
    if ('name' in request.worktree) {
      try {
        worktree = await projects.createWorktree(project.root, request.worktree.name)
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) }
      }
      created = true
    } else {
      const wanted = await realpath(request.worktree.path)
      const found = await this.worktreeAt(project.root, wanted)
      if (!found) throw new Error(`${request.worktree.path} is not a worktree of ${project.name}`)
      worktree = found
    }
    const root = await realpath(worktree.path)
    /** No confirm: the worktree was made a moment ago by this start and holds nothing of the user's. */
    const undoWorktree = async (): Promise<void> => {
      if (created) await projects.removeWorktree(project.root, worktree.path, async () => true).catch(() => null)
    }

    const target = await new Git(project.root).defaultBranch()
    const base = worktree.branch && worktree.branch !== target ? await new Git(root).resolve('HEAD') : null
    const docs = await projects.workspace(docsRoot)
    const session = randomUUID()
    let thread
    try {
      thread = await docs.threads.createImplementation(request.doc, request.from, request.title, {
        project: project.root,
        /** As git reports it, so it matches the worktrees the sidebar lists; terminals get the real path. */
        worktree: worktree.path,
        branch: worktree.branch ?? '',
        session,
        terminal: null,
        base
      })
    } catch (error) {
      await undoWorktree()
      throw error
    }

    let terminal: TerminalInfo
    try {
      const link: TerminalLink = { docsRoot, doc: request.doc, thread: thread.id }
      terminal = await terminals.create(root, 'claude', { cols: request.cols, rows: request.rows }, {
        prompt: request.prompt,
        title: request.title,
        link,
        brief: this.briefFile(thread.id),
        addDirs: [docsRoot],
        session
      })
    } catch (error) {
      await docs.threads.setStatus(request.doc, thread.id, 'discarded')
      await undoWorktree()
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    const linked = await docs.threads.updateImplementation(request.doc, thread.id, { terminal: terminal.id })
    return { ok: true, message: `Started ${request.title} in ${path.basename(root)}`, thread: linked, terminal }
  }

  /**
   * The thread's Claude session: its terminal when that is still open, otherwise a new terminal in the
   * worktree that resumes the session, linked to the thread from then on.
   */
  async openSession(docsRoot: string, doc: string, id: string, size: TerminalSize): Promise<TerminalInfo> {
    const { projects, terminals } = this.options
    const root = await projects.resolveRoot(docsRoot)
    const docs = await projects.workspace(root)
    const thread = await docs.threads.get(doc, id)
    const implementation = thread?.implementation
    if (!thread || !implementation) throw new Error(`No implementation thread ${id} in ${doc}`)
    const open = terminals.list().find((t) => t.id === implementation.terminal)
    if (open) return open
    const worktree = await projects.resolveRoot(implementation.worktree).catch(() => null)
    if (!worktree) throw new Error(`The worktree ${path.basename(implementation.worktree)} is gone; its branch ${implementation.branch} was kept`)
    const terminal = await terminals.create(worktree, 'claude', size, {
      title: thread.title,
      link: { docsRoot: root, doc, thread: id },
      brief: this.briefFile(id),
      addDirs: [root],
      resume: implementation.session
    })
    await docs.threads.updateImplementation(doc, id, { terminal: terminal.id })
    return terminal
  }

  /**
   * Whether the thread's work has landed, and its pull request. Landed: a commit with its trailer is on
   * the default branch (local or `origin`'s; survives squash merges that keep the message), or the
   * branch has moved past `base` and its tip is on the default branch, or its pull request was merged.
   * Landing sets the thread `merged`. Doesn't fetch: a merge on GitHub shows through the pull request.
   */
  async check(docsRoot: string, doc: string, id: string): Promise<ThreadInfo> {
    const docs = await this.options.projects.workspace(await this.options.projects.resolveRoot(docsRoot))
    const thread = await docs.threads.get(doc, id)
    const implementation = thread?.implementation
    if (!thread || !implementation) throw new Error(`No implementation thread ${id} in ${doc}`)
    if (thread.status !== 'open') return thread

    const target = await new Git(implementation.project).defaultBranch()
    let landed = await branchLanded(implementation.project, { trailer: { key: TRAILER, value: id }, branch: implementation.branch, base: implementation.base })

    let next = thread
    const lookup = implementation.branch && implementation.branch !== target ? await this.options.pullRequests?.(implementation.project, implementation.branch) : null
    if (lookup) {
      if (!samePullRequest(lookup.found, implementation.pr)) next = await docs.threads.updateImplementation(doc, id, { pr: lookup.found })
      if (lookup.found?.state === 'merged') landed = true
    }
    if (landed) next = await docs.threads.setStatus(doc, id, 'merged')
    return next
  }

  /**
   * Handles a `propose_doc_change` call from the terminal's session: a thread on the doc section,
   * marked as proposed by the session's implementation thread. Refusals go back to the agent.
   */
  async proposeDocChange(terminalId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const session = await this.proposingSession(terminalId, args, PROPOSE_ARGS)
    if ('error' in session) return session
    const { docs, author, text } = session
    const doc = text('doc').replace(/^\.?\//, '')
    const proposed = await docs.threads.propose(doc, { find: text('find'), replace: text('replace'), title: text('title').slice(0, 80), why: text('why'), from: author })
    if (!proposed.ok) return { text: proposed.message, error: true }
    this.options.onProposal?.(session.docsRoot, proposed.thread)
    return {
      text: `Proposed as the Manta thread ${proposed.thread.id} (“${proposed.thread.title}”) on ${doc}. The user reviews and approves it in Manta; don't edit the doc yourself. Use this id to revise or withdraw it.`
    }
  }

  /** Handles a `withdraw_doc_change` call: discards one of the session's own open proposals. */
  async withdrawDocChange(terminalId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const session = await this.proposingSession(terminalId, args, WITHDRAW_ARGS)
    if ('error' in session) return session
    const { docs, author, text } = session
    const withdrawn = await docs.threads.withdraw(text('thread'), author, text('why'))
    if (!withdrawn.ok) return { text: withdrawn.message, error: true }
    return { text: `Withdrew the proposal ${withdrawn.thread.id} (“${withdrawn.thread.title}”) on ${withdrawn.thread.doc}.` }
  }

  /** Handles a `revise_doc_change` call: edits one of the session's own open proposals. */
  async reviseDocChange(terminalId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const session = await this.proposingSession(terminalId, args, REVISE_ARGS)
    if ('error' in session) return session
    const { docs, author, text } = session
    const revised = await docs.threads.revise(text('thread'), author, { find: text('find'), replace: text('replace'), why: text('why') })
    if (!revised.ok) return { text: revised.message, error: true }
    return { text: `Revised the proposal ${revised.thread.id} (“${revised.thread.title}”) on ${revised.thread.doc}. The user reviews it in Manta.` }
  }

  /** The terminal's linked implementation and the tool call's text arguments, or the refusal to send back. */
  private async proposingSession<Name extends string>(
    terminalId: string,
    args: Record<string, unknown>,
    names: readonly Name[]
  ): Promise<{ docsRoot: string; docs: Workspace; author: ProposalAuthor; text: (name: Name) => string } | { text: string; error: true }> {
    const link = this.options.terminals.list().find((t) => t.id === terminalId)?.link
    if (!link) return { text: 'This session is not linked to a Manta implementation thread', error: true }
    const missing = names.filter((name) => typeof args[name] !== 'string' || (name !== 'replace' && args[name] === ''))
    if (missing.length > 0) return { text: `Give ${missing.join(', ')} as text`, error: true }
    const text = (name: Name): string => String(args[name])
    const docs = await this.options.projects.workspace(link.docsRoot)
    const implementation = await docs.threads.get(link.doc, link.thread)
    const title = implementation?.title ?? link.thread
    const branch = implementation?.implementation?.branch ?? ''
    const author: ProposalAuthor = { ref: { doc: link.doc, thread: link.thread }, label: `the implementation “${title}”${branch ? ` (${branch})` : ''}` }
    return { docsRoot: link.docsRoot, docs, author, text }
  }

  /** Writes the brief for a linked session from the doc as it is now; `TerminalManager` calls it before each start. */
  async refreshBrief(link: TerminalLink, file: string): Promise<void> {
    const docs = await this.options.projects.workspace(link.docsRoot)
    const brief = await docs.threads.implementationBrief(link.doc, link.thread)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, brief)
    await rename(`${file}.tmp`, file)
  }

  private briefFile(threadId: string): string {
    return path.join(this.options.briefsDir, `${threadId}.md`)
  }

  private async worktreeAt(projectRoot: string, real: string): Promise<ProjectWorktree | null> {
    for (const worktree of await this.options.projects.worktrees(projectRoot)) {
      if ((await realpath(worktree.path).catch(() => worktree.path)) === real) return worktree
    }
    return null
  }
}

function samePullRequest(a: PullRequestInfo | null, b: PullRequestInfo | null): boolean {
  return a?.number === b?.number && a?.state === b?.state && a?.url === b?.url
}
