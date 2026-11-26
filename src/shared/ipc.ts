export type OpResult = { ok: true; message: string } | { ok: false; message: string }

export type ProjectKind = 'docs' | 'code'

export interface Project {
  root: string
  name: string
  kind: ProjectKind
}

export interface Worktree {
  path: string
  branch: string | null
  head: string
  isMain: boolean
}

/** A worktree as the app lists it. */
export interface ProjectWorktree extends Worktree {
  /** Manta created it in its own worktrees folder; only these can be removed from the app. */
  managed: boolean
}

/** What changed under `root`, so each panel refreshes only for what it shows. */
export interface FilesChanged {
  root: string
  /** Files or folders were added or removed: the file list changed. */
  structure: boolean
  /** A file outside `.manta/` changed: git status changed. */
  content: boolean
  /** Ids of thread records that changed. */
  records: string[]
  /** Ids of context maps whose files changed. */
  maps: string[]
}

export interface RepoStatus {
  branch: string
  /** Local commits the upstream doesn't have yet; 0 without an upstream. */
  ahead: number
  /** A branch with commits but no upstream, and an `origin` to push it to. */
  unpublished: boolean
  added: number
  removed: number
}

/** M modified, A added, D deleted, R renamed, U untracked, C conflicted (unmerged). */
export type ChangeStatus = 'M' | 'A' | 'D' | 'R' | 'U' | 'C'

export interface FileChange {
  path: string
  status: ChangeStatus
  /** A rename's path before it. */
  oldPath?: string
  added: number
  removed: number
}

/** `staged` is the index versus HEAD; `unstaged` the working tree versus the index. A file can be in both. */
export interface Changes {
  staged: FileChange[]
  unstaged: FileChange[]
}

/** `staged` commits the index; `all` stages every change first. */
export interface CommitInfo {
  sha: string
  /** The first parent; null for the first commit. */
  parent: string | null
  subject: string
  author: string
  /** ISO 8601, author date. */
  date: string
  /** Made since the branch's base, so it's part of "committed on branch". */
  onBranch: boolean
}

/** What this branch has committed since its base, and its recent history. */
export interface BranchSummary {
  /** Null when there is nothing to compare with: the default branch with no upstream. */
  base: { sha: string; label: string } | null
  /** Null before the first commit. */
  head: string | null
  files: FileChange[]
  commits: CommitInfo[]
  /** A chosen base that no longer exists, so `base` is the default instead; null otherwise. */
  missingBase: string | null
}

export type CommitScope = 'staged' | 'all'

/** A line containing the searched text. `line` is 1-based. */
export interface ContentMatch {
  path: string
  line: number
  text: string
}

/** A discarded thread keeps its record and marker like any other; nothing is ever removed. */
export type ThreadStatus = 'open' | 'approved' | 'merged' | 'discarded'

export interface TextRange {
  from: number
  to: number
}

/** One transcript entry. `status` covers what isn't said by either side: errors, cancellation. */
export interface ThreadMessage {
  role: 'user' | 'assistant' | 'tool' | 'status'
  text: string
  at: string
}

/** A thread anywhere in the docs repo. */
export interface ThreadRef {
  doc: string
  thread: string
}

/** A pull request for an implementation thread's branch, as `gh` reports it. */
export interface PullRequestInfo {
  number: number
  state: 'open' | 'merged' | 'closed'
  url: string
}

/** One CI check on a pull request's head. */
export interface PullRequestCheck {
  name: string
  state: 'passed' | 'failed' | 'running' | 'skipped'
  url: string | null
}

export interface PullRequestReply {
  author: string
  body: string
  createdAt: string
}

/** A review thread, a conversation comment or a review's summary on a pull request. */
export interface PullRequestComment {
  /** GitHub's node id: a review thread's, a conversation comment's or a review's. */
  id: string
  kind: 'thread' | 'comment' | 'review'
  author: string
  body: string
  url: string
  createdAt: string
  /** Threads only; null otherwise. `line` is null for an outdated thread with no line left. */
  path: string | null
  line: number | null
  side: 'old' | 'new' | null
  hunk: string | null
  resolved: boolean
  outdated: boolean
  /** A thread's later comments, oldest first. */
  replies: PullRequestReply[]
  /** A review's verdict; null for the other kinds. */
  verdict: 'approved' | 'changes requested' | 'commented' | null
}

/** A branch's pull request as the PR tab shows it. */
export interface PullRequestDetail {
  /** Node id, for GraphQL mutations. */
  id: string
  number: number
  title: string
  state: 'open' | 'draft' | 'merged' | 'closed'
  url: string
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
  author: string
  /** The `gh` user. */
  viewer: string
  checks: PullRequestCheck[]
  comments: PullRequestComment[]
  /** More review threads than one page (100); the rest aren't listed. */
  truncated: boolean
}

export type PullRequestStatus =
  | { kind: 'unavailable'; reason: string }
  | { kind: 'none'; branch: string }
  | { kind: 'found'; pr: PullRequestDetail }

/**
 * Where an implementation thread's work runs: a Claude Code session in a code worktree. Its status
 * reads `open` while in progress, `merged` once the branch has landed, `discarded` when abandoned.
 */
export interface ImplementationLink {
  /** The doc thread it was started from, if any. */
  source: string | null
  /** Root of the code project. */
  project: string
  worktree: string
  branch: string
  /** The Claude Code session doing the work, kept so it can be resumed after its tab is closed. */
  session: string
  /** The terminal running the session on this machine; null once its tab is closed. */
  terminal: string | null
  /** The user hid the Landed chip. */
  hidden: boolean
  /** The branch's commit when the work started; it has landed once a later tip is on the default branch. Null when the work runs on the default branch itself. */
  base: string | null
  /** The branch's pull request, as last checked; null when there is none or `gh` isn't available. */
  pr: PullRequestInfo | null
}

export interface ThreadInfo {
  id: string
  doc: string
  title: string
  status: ThreadStatus
  parent: string | null
  createdAt: string
  /** Where the anchored section is now; null when it is detached. */
  range: TextRange | null
  /** The doc still highlights what approving this thread changed, or an implementation still shows as landed. */
  highlighted: boolean
  /** Set for an implementation thread, which runs in a terminal and has no proposal of its own. */
  implementation: ImplementationLink | null
  /** The implementation thread (and its doc) whose session proposed this thread's edit, if any. */
  proposedBy: ThreadRef | null
  /** The context map agent (a launch's session, the sweep or Ask the map) that proposed this thread's edit, if any. */
  proposedByMap: MapProposer | null
}

/** A context map's agent that proposed a doc change, and what the thread calls it. */
export interface MapProposer {
  map: string
  from: MapAuthor
  /** e.g. the launch's scope title. */
  title: string
}

/** What a thread would change: `base → proposed` is the thread's own edit, `current → merged` is what approving does now. */
export interface ThreadProposal {
  base: string
  proposed: string
  current: string
  merged: string
}

/** Which Claude Code thread agents run, and whether it can reach a model. */
export interface ClaudeCodeStatus {
  /** The user's own `claude`; null when not found, so threads use the copy bundled with Manta. */
  path: string | null
  version: string | null
  loggedIn: boolean
  /** As reported by `claude auth status`, e.g. `third_party` for Bedrock or Vertex. */
  authMethod: string | null
  /** e.g. `firstParty`, `bedrock`, `vertex`. */
  apiProvider: string | null
  error: string | null
}

/** The user's answer to an agent's permission request. `always` holds for the rest of the thread's session. */
export type PermissionDecision = 'allow' | 'always' | 'deny'

/** `claude` is a tracked Claude Code session; `shell` is the user's login shell. */
export type TerminalKind = 'claude' | 'shell'

/**
 * Shells are `running` until they exit. Claude sessions go `starting` → `idle` / `working` /
 * `waiting` (on the user: a permission or a question) → `exited`.
 */
export type TerminalState = 'starting' | 'running' | 'working' | 'waiting' | 'idle' | 'exited'

/** The doc section a Claude terminal is implementing: an implementation thread in the docs repo. */
export interface TerminalLink {
  docsRoot: string
  doc: string
  thread: string
}

/** A Claude terminal started from a context map: the launch it works on, and the ticket it focuses on. Sessions from before launches have neither. */
export interface MapLink {
  docsRoot: string
  map: string
  launch: string | null
  ticket: string | null
  /** The batch a coordinator session watches; absent for every other map session. */
  coordinator?: string
}

export interface TerminalInfo {
  id: string
  /** The context root the terminal runs in: the docs repo or a worktree. */
  root: string
  kind: TerminalKind
  title: string
  /** The Claude Code session it shows, for `claude --resume`; null for shells. */
  sessionId: string | null
  /** The session has had a prompt, so Claude Code has saved it and `--resume` can reopen it. */
  resumable: boolean
  createdAt: string
  /** When the current process started; null when none is running since a relaunch. A restart changes it. */
  startedAt: string | null
  state: TerminalState
  exitCode: number | null
  link: TerminalLink | null
  map: MapLink | null
}

/** Starting an implementation thread: where in the docs, which code project and worktree, and the first prompt. */
export interface ImplementationRequest {
  /** The docs repo root. */
  docsRoot: string
  doc: string
  /** The section around `offset`, or the section of the doc thread `thread`. */
  from: { offset: number } | { thread: string }
  title: string
  /** Root of the code project. */
  project: string
  /** A new worktree with this name, or an existing worktree of the project. */
  worktree: { name: string } | { path: string }
  prompt: string
  cols: number
  rows: number
}

export type ImplementationStart = { ok: true; message: string; thread: ThreadInfo; terminal: TerminalInfo } | { ok: false; message: string }

/** How the tracker's work gets its worktrees: one per ticket, or one per milestone shared by its tickets. */
export type LaunchMode = 'ticket' | 'milestone'

/** `in-review`: a pull request of its own is open. `done`: its work is merged and verified, reported by its agent with the user or set by hand. */
export type TicketStatus = 'todo' | 'in-progress' | 'blocked' | 'in-review' | 'done'

export type MilestoneStatus = 'todo' | 'in-progress' | 'done'

/** A doc in the docs repo, or one section of it. */
export interface DocRef {
  path: string
  heading: string | null
}

export interface MapTicket {
  /** Stable (`tk_<hex>`), so a later sync with an outside tracker can map it. */
  id: string
  /** Its number in the map, shown with the map's key (`OMN-12`); never reused. */
  number: number
  title: string
  /** Markdown: what to do. The UI calls it the objective. */
  description: string
  /** How to tell it's done, one checkable criterion each. */
  acceptance: string[]
  /** Constraints and non-goals: what the work must keep or leave alone. */
  constraints: string[]
  /** Ids of tickets that must be done before this one can start. */
  after: string[]
  /** The docs or doc sections it relies on. */
  docs: DocRef[]
  /** The code project it's for, by name; null to use the map's. */
  project: string | null
  status: TicketStatus
  /** Why it's blocked, as the agent reported it; null unless blocked. */
  blocked: string | null
}

/** One item of a milestone's definition of done, ticked by the user once it holds. */
export interface DoneItem {
  text: string
  done: boolean
}

export interface MapMilestone {
  /** Stable (`ms_<hex>`). */
  id: string
  title: string
  description: string
  /** Its definition of done, one item each. */
  doneWhen: DoneItem[]
  tickets: MapTicket[]
  /** Its own branch (a launch of the whole milestone) has landed. */
  landed: boolean
  /** Set by hand; the next real event (a launch, a status report, a landing) clears it. */
  manual: MilestoneStatus | null
}

/** A milestone with its status worked out. */
export interface MapMilestoneInfo extends MapMilestone {
  status: MilestoneStatus
}

/** A user-named group of docs. */
export interface MapSection {
  id: string
  title: string
}

/** What a doc is for on the map; suggested, never required. */
export type DocRole = 'product' | 'design' | 'technical' | 'decision' | 'release'

/** A web page listed as a map doc: a design, a prototype. */
export interface DocLink {
  /** An http or https address, opened in the browser. */
  url: string
  title: string
}

/** A doc the map lists. */
export interface MapDoc {
  /** Path inside the docs repo; for a link, a stable `link:` key that is no file. */
  path: string
  /** Milestone ids it belongs to, any number. */
  milestones: string[]
  section: string | null
  roles: DocRole[]
  /** Set for a web link instead of a file in the docs repo. */
  link?: DocLink
}

export interface MapDocInfo extends MapDoc {
  exists: boolean
  /** Its first `# ` heading, else its file name. */
  title: string
  /** When the file last changed on disk (ISO); null when it isn't there. */
  updatedAt: string | null
}

export type DecisionStatus = 'open' | 'decided' | 'superseded'

/** One way to settle a decision. */
export interface DecisionOption {
  title: string
  detail: string
  /** Whoever raised the decision recommends it; at most one option is. */
  recommended: boolean
}

/** A value a decision can't be confirmed without, such as "Production domain". */
export interface DecisionInput {
  label: string
  /** Empty until the user fills it in. */
  value: string
}

/** A question the work waits on, and once decided, what was chosen. */
export interface MapDecision {
  /** Stable (`dc_<hex>`). */
  id: string
  /** Shown as `006`; never reused. */
  number: number
  title: string
  question: string
  status: DecisionStatus
  /** What was decided and why; empty while open. */
  outcome: string
  options: DecisionOption[]
  /** Index into `options` of the one chosen; null while open, or when it was decided in words. */
  chosen: number | null
  input: DecisionInput | null
  /** Tickets that can't start until it's decided. */
  blocks: string[]
  /** The doc sections it comes from or changes. */
  docs: DocRef[]
  /** The agent that raised it; null when the user added it. */
  from: MapAuthor | null
  createdAt: string
  decidedAt: string | null
}

/** Where the map's feature is; `null` in settings lets Manta work it out from the tracker. */
export type MapStage = 'planning' | 'building' | 'validating' | 'shipped'

/** What one launch covers: a ticket, a group of tickets, or a whole milestone. */
export type LaunchScope = { ticket: string } | { tickets: string[] } | { milestone: string }

/** One session of a launch: its terminal on this machine, and the ticket it focuses on inside a shared worktree. */
export interface LaunchSession {
  terminal: string
  /** The Claude Code session, for resuming it once its terminal is closed. */
  session: string
  ticket: string | null
  /** When it last started (or resumed). */
  startedAt: string
  /** What the session last reported with `report_progress`; null until it has. */
  progress: SessionProgress | null
  /** The user's note for this start only, from the brief page; absent without one. */
  note?: string
}

export type ProgressPhase = 'exploring' | 'building' | 'verifying' | 'finishing'

/** What the user is needed for: a decision, a review of something finished, or to unblock the session. */
export interface ProgressNeed {
  kind: 'decision' | 'review' | 'unblock'
  ask: string
}

/** A session's own one-line account of where it is, overwritten each time; what the board shows. */
export interface SessionProgress {
  phase: ProgressPhase
  summary: string
  needs: ProgressNeed | null
  next: string | null
  at: string
}

/** Launches started together (Start N, or ticked tickets launched each in its own worktree), and the session coordinating them. */
export interface MapBatch {
  id: string
  createdAt: string
  coordinator: { terminal: string; session: string; startedAt: string } | null
  /** The user said no to the offer of a coordinator. */
  declined: boolean
}

/** One start of work from the map: its scope, worktree and branch, sessions, pull request and journal. */
export interface MapLaunch {
  id: string
  scope: LaunchScope
  /** Root of the code project. */
  project: string
  worktree: string
  branch: string
  /** The branch's commit when the work started; it has landed once a later tip is on the default branch. */
  base: string | null
  sessions: LaunchSession[]
  pr: PullRequestInfo | null
  landed: boolean
  createdAt: string
  /** When a session last recorded its wrap-up; null when none has. */
  wrappedUpAt: string | null
  /** When the sweep last ran for it; null when it never has. */
  sweptAt: string | null
  /** When its agent said the work is finished (checks pass, committed); a pull request is the next step. */
  readyAt: string | null
  /** The last wrap-up, by its session or the sweep. */
  wrapUp: LaunchWrapUp | null
  /** Checks and review on its open pull request, as last seen; null with none open. */
  health: PullRequestHealth | null
  /** When the landing pass (docs checked against what landed) ran; null until it has. */
  landingSweptAt: string | null
  /** The batch it was started in; null when started on its own. */
  batch: string | null
}

/** One acceptance criterion of a ticket, as a wrap-up judged it. `index` is its place in the ticket's list. */
export interface CriterionResult {
  ticket: string
  index: number
  met: boolean
  evidence: string
  /** Where the evidence is, in a few words ("Run output · Authentication"); empty when not given. */
  source: string
}

/** A check a session ran before finishing. */
export interface CheckRun {
  command: string
  passed: boolean
}

export interface LaunchWrapUp {
  summary: string
  wentToPlan: boolean
  /** The work in its scope is finished and its checks pass. */
  finished: boolean
  criteria: CriterionResult[]
  checks: CheckRun[]
  /** What the work did not verify and still needs (a device run, a manual check). */
  unverified: string[]
  /** Decisions made or assumptions introduced along the way. */
  decisions: string[]
  risks: string[]
  at: string
  /** The sweep wrote it, not the session. */
  sweep: boolean
}

/** What a launch's open pull request needs: its checks (failing ones by name) and its review. */
export interface PullRequestHealth {
  checks: 'passed' | 'failed' | 'running' | 'none'
  failing: string[]
  review: 'approved' | 'changes-requested' | 'none'
  /** Review threads not resolved yet. */
  unresolved: number
}

/** The commands that tell whether work in one of the map's code projects is right (tests, typecheck). */
export interface MapProjectChecks {
  project: string
  commands: string[]
}

/** A milestone or ticket an agent proposed, waiting for the user. */
export interface ProposedTicket {
  title: string
  description: string
  acceptance: string[]
  constraints: string[]
  /** Tickets it waits for: ids of existing tickets, or titles of tickets earlier in the same proposal. */
  after: string[]
  /** A code project of the map, by name; null when it doesn't say. */
  project: string | null
  docs: DocRef[]
}

/** One change to the existing plan an agent proposed; each is approved on its own. */
export type PlanChange =
  | { kind: 'update-ticket'; ticket: string; title?: string; description?: string; acceptance?: string[]; constraints?: string[]; after?: string[]; project?: string | null }
  | { kind: 'add-ticket'; milestone: string; before: string | null; ticket: ProposedTicket }
  | { kind: 'move-ticket'; ticket: string; milestone: string; before: string | null }
  | { kind: 'remove-ticket'; ticket: string }
  | { kind: 'update-milestone'; milestone: string; title?: string; description?: string; doneWhen?: string[] }
  | { kind: 'move-milestone'; milestone: string; before: string | null }

export interface ProposedMilestone {
  title: string
  description: string
  doneWhen: string[]
  tickets: ProposedTicket[]
}

/** Who raised something waiting for review: a launch, the sweep, or Ask the map. */
export type MapAuthor = { launch: string } | { sweep: string } | { ask: true }

/** Something an agent suggested, waiting on the user in Needs review. */
export type MapSuggestion =
  | { id: string; kind: 'add-doc'; path: string; why: string; milestones: string[]; from: MapAuthor; at: string }
  | { id: string; kind: 'write-doc'; title: string; why: string; milestones: string[]; from: MapAuthor; at: string }
  | { id: string; kind: 'plan'; why: string; milestones: ProposedMilestone[]; from: MapAuthor; at: string }
  | { id: string; kind: 'ticket'; milestone: string; ticket: ProposedTicket; why: string; from: MapAuthor; at: string }
  | { id: string; kind: 'plan-change'; changes: PlanChange[]; why: string; from: MapAuthor; at: string }

/** A doc change proposed by one of the map's agents: an open doc thread. */
export interface MapDocProposal {
  thread: string
  doc: string
  title: string
  from: MapAuthor
}

/** The map as the sidebar lists it. */
export interface MapSummary {
  id: string
  title: string
  description: string
  createdAt: string
  /** The current milestone: the pinned one, else the first not done; `done` counts done tickets. Null with no milestones left. */
  current: { id: string; title: string; done: number; total: number } | null
  /** Items in Needs review, blocked tickets and pull requests waiting for the user. */
  waiting: number
  /** Ask the map is answering. */
  running: boolean
}

/**
 * How a launched session proposes changes to the map: 'ask' puts them to the user in the session first
 * (and applies tickets, plan changes and docs to list once accepted); 'queue' sends them straight to
 * Needs review, for runs nobody is watching.
 */
export type ConfirmProposals = 'ask' | 'queue'

/** What happened on a map, as the Activity page lists it. */
export type MapEventKind =
  | 'agent-started'
  | 'agent-finished'
  | 'agent-wrapped-up'
  | 'pr-opened'
  | 'pr-merged'
  | 'ticket-done'
  | 'ticket-blocked'
  | 'ticket-in-review'
  | 'milestone-done'
  | 'decision-raised'
  | 'decision-decided'
  | 'decision-superseded'
  | 'decision-reopened'
  | 'suggestion'
  | 'suggestion-accepted'
  | 'suggestion-dismissed'
  | 'doc-change-proposed'

/** One entry of a map's activity log. Titles are as they were then, so an event reads right after a rename or removal. */
export interface MapEvent {
  id: string
  at: string
  kind: MapEventKind
  /** What it's about: a ticket's, milestone's, decision's or proposal's title. */
  title: string
  /** A line more: the blocked reason, the outcome, the wrap-up's first sentence; empty for none. */
  detail: string
  ticket: string | null
  milestone: string | null
  launch: string | null
  decision: string | null
  suggestion: string | null
  /** A doc change's doc and thread. */
  doc: string | null
  thread: string | null
}

export interface MapDetail extends MapSummary {
  /** Prefix of ticket keys (`OMN` in `OMN-12`). */
  key: string
  stage: MapStage
  /** The stage as set by hand; null when Manta works it out. */
  stageSet: MapStage | null
  /** When the user last opened the map before this visit; null on the first. */
  lastVisitedAt: string | null
  /** When the user last marked the map's activity as seen; null when never. */
  seenAt: string | null
  /** The map's activity, newest first: its log and the doc changes its agents proposed. */
  activity: MapEvent[]
  /** Code projects it works in, by name. */
  projects: string[]
  launchMode: LaunchMode
  /** The sweep runs when a session ends without wrapping up. */
  sweep: boolean
  confirmProposals: ConfirmProposals
  /** The milestone the user pinned as current; null for the first not done. */
  pinned: string | null
  checks: MapProjectChecks[]
  docs: MapDocInfo[]
  sections: MapSection[]
  milestones: MapMilestoneInfo[]
  decisions: MapDecision[]
  launches: MapLaunch[]
  batches: MapBatch[]
  suggestions: MapSuggestion[]
  proposals: MapDocProposal[]
  /** Ask the map's conversation, oldest first. */
  messages: ThreadMessage[]
}

export interface NewMapInput {
  title: string
  description: string
  projects: string[]
  launchMode: LaunchMode
}

/** A change to the map's own settings; omitted fields stay. */
export interface MapSettings {
  title?: string
  description?: string
  projects?: string[]
  launchMode?: LaunchMode
  sweep?: boolean
  confirmProposals?: ConfirmProposals
  /** A milestone id, or null to unpin. */
  pinned?: string | null
  /** Replaces every project's checks. */
  checks?: MapProjectChecks[]
  key?: string
  /** Null hands the stage back to Manta. */
  stage?: MapStage | null
}

/** A hand edit to the tracker. `before` is an id to insert before; null appends. */
export type TrackerEdit =
  | { kind: 'add-milestone'; title: string; description?: string; before?: string | null }
  | { kind: 'update-milestone'; milestone: string; title?: string; description?: string; doneWhen?: DoneItem[] }
  | { kind: 'move-milestone'; milestone: string; before: string | null }
  | { kind: 'set-milestone-status'; milestone: string; status: MilestoneStatus | null }
  | { kind: 'add-ticket'; milestone: string; title: string; description?: string; before?: string | null }
  | { kind: 'update-ticket'; ticket: string; title?: string; description?: string; acceptance?: string[]; constraints?: string[]; after?: string[]; docs?: DocRef[]; project?: string | null }
  | { kind: 'move-ticket'; ticket: string; milestone: string; before: string | null }
  | { kind: 'set-ticket-status'; ticket: string; status: TicketStatus; reason?: string }
  | { kind: 'add-decision'; title: string; question?: string; blocks?: string[]; docs?: DocRef[]; options?: DecisionOption[]; input?: DecisionInput | null; outcome?: string; from?: MapAuthor | null }
  | {
      kind: 'update-decision'
      decision: string
      title?: string
      question?: string
      status?: DecisionStatus
      outcome?: string
      blocks?: string[]
      docs?: DocRef[]
      options?: DecisionOption[]
      chosen?: number | null
      input?: DecisionInput | null
    }
  | { kind: 'remove-decision'; decision: string }

/** A hand edit to the map's docs and sections. */
export type MapDocsEdit =
  | { kind: 'add-doc'; path: string; milestones: string[]; section: string | null }
  | { kind: 'add-link'; url: string; title: string; roles: DocRole[]; milestones: string[] }
  /** `link` changes a link's address and title; refused for a file. */
  | { kind: 'update-doc'; path: string; milestones?: string[]; section?: string | null; roles?: DocRole[]; link?: DocLink }
  | { kind: 'remove-doc'; path: string }
  /** `doc` files that doc in the new section. */
  | { kind: 'add-section'; title: string; doc?: string }
  | { kind: 'rename-section'; section: string; title: string }
  | { kind: 'remove-section'; section: string }

/** Starting work from the tracker. `mode` overrides the map's default for this launch; `project` is a code project's root, needed when the map has several. */
export interface MapLaunchRequest {
  docsRoot: string
  map: string
  scope: LaunchScope
  mode: LaunchMode
  project: string | null
  /** The batch it starts in, a `b_…` id the caller makes up for several launches started together. */
  batch?: string | null
  /** A note for this start only, added to the session's brief. */
  note?: string
  cols: number
  rows: number
}

/** What the brief page asks about one ticket before starting it. */
export interface MapBriefRequest {
  docsRoot: string
  map: string
  ticket: string
  mode: LaunchMode
  /** The code project chosen on the page; null for the one a launch would pick. */
  project: string | null
  note: string
}

/** A doc or section the agent is pointed to; `linked` ones are the ticket's own and can be unlinked from the page. */
export interface MapBriefDoc extends DocRef {
  title: string
  roles: DocRole[]
  linked: boolean
}

/** Whether the brief has what an agent needs, and what would hold it back; advisory, never a refusal. */
export interface BriefReadiness {
  ready: boolean
  /** What it carries: "Objective", "criteria", "source context". */
  included: string[]
  /** What it lacks: "No acceptance criteria". */
  missing: string[]
  /** What it waits on: "Waits for OMN-81", "Decision 006 is open". */
  blocking: string[]
}

/** Where the session would run: a new worktree, the one it already has, or a project still to pick. */
export type BriefWorkspace =
  | { kind: 'new'; project: string; root: string; branch: string; from: string; shared: boolean }
  | { kind: 'reuse'; project: string; root: string; branch: string; worktree: string; shared: boolean }
  | { kind: 'pick'; projects: string[] }
  | { kind: 'none'; message: string }

/** A doc of the map with its headings, for attaching a section to a ticket. */
export interface MapDocOutline {
  path: string
  title: string
  headings: string[]
}

/** The brief page's view of one ticket's launch: what the agent receives and how its session starts. */
export interface MapBriefPreview {
  /** The brief as the session would get it. */
  text: string
  docs: MapBriefDoc[]
  readiness: BriefReadiness
  workspace: BriefWorkspace
  /** What the session may do, from the Claude command's flags, the map tools and the map's checks. */
  permissions: string[]
  outline: MapDocOutline[]
}

/** A refused launch that needs a code project picked lists the candidates' roots in `projects`. */
export type MapLaunchStart = { ok: true; message: string; launch: MapLaunch; terminal: TerminalInfo } | { ok: false; message: string; projects?: string[] }

/** What goes back to a launch's session from its pull request: the failing checks, or the review. */
export type MapFeedback = 'checks' | 'review'

/** Accepting a suggestion of a doc worth writing creates the doc: `doc` is its path. */
export type SuggestionResult = { ok: true; message: string; doc: string | null } | { ok: false; message: string }

/**
 * Which diff a review comment was made on: the Changes tab's (uncommitted), the Branch tab's, or a
 * pull request's review (`pr:<number>`), where it waits in the pending review until Finish review.
 */
export type ReviewDiff = 'changes' | 'branch' | `pr:${number}`

export function isReviewDiff(value: unknown): value is ReviewDiff {
  return value === 'changes' || value === 'branch' || (typeof value === 'string' && /^pr:[1-9]\d*$/.test(value))
}

/** A file in a pull request's review, with whether it's ticked as viewed for its current diff. */
export interface PullRequestReviewFile extends FileChange {
  viewed: boolean
  /** Its old and new blobs: viewed holds only while this is unchanged. */
  fingerprint: string
}

/** A pull request opened for review: its diff from the merge-base to the fetched head. */
export interface PullRequestReviewInfo {
  number: number
  base: string
  head: string
  files: PullRequestReviewFile[]
  /** The worktree has commits the PR's head doesn't: the review shows what's on GitHub. */
  unpushed: boolean
  /** The viewer wrote the PR: GitHub allows only a comment review. */
  own: boolean
}

export type PullRequestReviewOpen = { ok: true; review: PullRequestReviewInfo } | { ok: false; message: string }

export type ReviewEvent = 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'

/** Where a review comment sits: a line of one side of a diff, its text then, and the diff lines around it. */
export interface ReviewAnchor {
  relPath: string
  diff: ReviewDiff
  side: 'old' | 'new'
  line: number
  lineText: string
  hunk: string
}

/** A comment on a diff line, kept in Manta per worktree until sent to an agent; never sent to GitHub. */
export interface ReviewComment extends ReviewAnchor {
  id: string
  body: string
  createdAt: string
  /** `to` is the agent's tab title when it was sent. */
  sent: { to: string; at: string } | null
}

export type ReviewTarget = { terminal: string } | { newSession: true }

/** A terminal's screen as of `seq`: replay `data`, then apply only output with a later `seq`. */
export interface TerminalSnapshot {
  data: string
  seq: number
}

/**
 * What formatting a file with the project's formatter did. `formatter` is null when the project has
 * none for the file; the editor then asks its language server, if any.
 */
export interface FormatResult {
  formatter: string | null
  ok: boolean
  message: string
}

/** A language server a plugin provides, as the Plugins view lists it. */
export interface PluginServer {
  id: string
  name: string
  role: LanguageServerRole
  languages: string[]
  enabled: boolean
  core: boolean
  beta: boolean
  description: string
}

/** One package in the Plugins view: from Mason's registry, or a server that comes with the system. */
export interface PluginEntry {
  name: string
  description: string
  homepage: string
  languages: string[]
  categories: string[]
  /** The registry's current version; null for a system server. */
  version: string | null
  installed: { version: string; installedAt: string } | null
  /** The servers Manta runs from it; empty for a package without a launch recipe (add it as a custom server). */
  servers: PluginServer[]
  /** Why it can't be installed on this machine, if it can't. */
  unsupported: string | null
}

/** A colour theme on Open VSX. */
export interface ThemeEntry {
  /** `<publisher>.<name>`. */
  id: string
  name: string
  description: string
  publisher: string
  downloads: number
  icon: string | null
}

/** A VS Code colour theme converted for the code editor: `--code-*` CSS variables. */
export interface EditorTheme {
  name: string
  dark: boolean
  vars: Record<string, string>
}

/** A server for a package without a recipe: its command and the languages it takes, given once by the user. */
export interface CustomServerInput {
  package: string
  command: string
  args: string[]
  languages: string[]
}

/** `primary`: completion, hover, definitions; `lint`: only adds diagnostics beside the primary server. */
export type LanguageServerRole = 'primary' | 'lint'

/** A language server Manta started for one root, as an LSP client in the renderer talks to it. */
export interface LanguageServerSession {
  session: string
  /** The server's id in Manta's catalog, e.g. `typescript`. */
  server: string
  name: string
  role: LanguageServerRole
  /** For the client's `initialize`. */
  initializationOptions: unknown
  /** The root as a `file://` URI, after symlinks, the form the server reports paths in. */
  rootUri: string
}

/** `stopped`: shut down after its files closed or its root went away; opening a file starts it again. */
export type LanguageServerState = 'starting' | 'ready' | 'crashed' | 'stopped'

export interface LanguageServerStatus {
  session: string
  root: string
  server: string
  name: string
  /** The language it was opened for, to open it again. */
  languageId: string
  state: LanguageServerState
  /** Why it crashed: the end of its error output. */
  message: string | null
  /** False once it crashed too often to start again by itself; Restart still works. */
  canRestart: boolean
}

/** A merged thread's change as committed: the doc before and after its commit. */
export interface ThreadLanded {
  commit: string
  before: string
  after: string
}

/** What a thread's agent is doing, streamed to the renderer while a turn runs. */
export type ThreadEvent =
  | { type: 'turn-start' }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; summary: string }
  /** The agent edited the thread's proposed doc. */
  | { type: 'proposal-changed' }
  | { type: 'error'; message: string }
  /** The agent is waiting for the user to allow a tool call. */
  | { type: 'permission'; id: string; tool: string; summary: string; title: string | null }
  | { type: 'permission-resolved'; id: string; decision: PermissionDecision }
  | { type: 'turn-end'; cancelled: boolean }

/**
 * The only surface the renderer gets. It has no Node access; everything goes through here.
 * `root` is a project root or one of its worktrees; main rejects anything else.
 */
export interface MantaApi {
  listProjects(): Promise<Project[]>
  addProject(kind: ProjectKind): Promise<Project | null>
  removeProject(root: string): Promise<void>
  listWorktrees(projectRoot: string): Promise<ProjectWorktree[]>
  createWorktree(projectRoot: string, name: string): Promise<ProjectWorktree>
  /** Asks the user to confirm, then removes the worktree and keeps its branch. Null when cancelled. */
  removeWorktree(projectRoot: string, worktreePath: string): Promise<OpResult | null>

  listFiles(root: string, scope: 'docs' | 'all'): Promise<string[]>
  changes(root: string): Promise<Changes>
  fileAtHead(root: string, relPath: string): Promise<string | null>
  /** `sha` is a full commit sha from `branch` or `commitFiles`. Null when the file doesn't exist there. */
  fileAt(root: string, sha: string, relPath: string): Promise<string | null>
  /** Against `base` when given, else the default base. */
  branch(root: string, base: string | null): Promise<BranchSummary>
  /** Local then remote branches, most recently committed first. */
  branches(root: string): Promise<string[]>
  /** What one commit changed against its first parent. */
  commitFiles(root: string, sha: string): Promise<FileChange[]>
  repoStatus(root: string): Promise<RepoStatus>
  /** Case-insensitive literal search over the files `listFiles(root, 'all')` returns. */
  searchContent(root: string, query: string): Promise<ContentMatch[]>
  createFile(root: string, relPath: string): Promise<void>
  createFolder(root: string, relPath: string): Promise<void>
  /** Moves a file or folder to the Trash after main asks; null when the user cancels. */
  deletePath(root: string, relPath: string): Promise<OpResult | null>

  openDoc(root: string, relPath: string): Promise<Uint8Array>
  createDoc(root: string, relPath: string): Promise<{ relPath: string; state: Uint8Array }>
  pushUpdate(root: string, relPath: string, update: Uint8Array): void
  /** Writes the doc to disk now instead of after typing pauses; updates pushed before it are included. */
  saveFile(root: string, relPath: string): Promise<void>
  /** Formats an open file with the project's own formatter (Prettier, Biome, Ruff) as minimal edits, then saves it. */
  formatFile(root: string, relPath: string): Promise<FormatResult>
  revealDoc(root: string, relPath: string): Promise<void>

  commit(root: string, message: string, scope: CommitScope): Promise<OpResult>
  stage(root: string, paths: string[]): Promise<OpResult>
  unstage(root: string, paths: string[]): Promise<OpResult>
  /** Asks the user to confirm, then puts the files back to their staged version, deleting untracked ones. Null when cancelled. */
  discardChanges(root: string, paths: string[]): Promise<OpResult | null>
  pull(root: string): Promise<OpResult>
  /** Pushes the current branch to origin, setting its upstream the first time. */
  push(root: string): Promise<OpResult>

  /** Starts a thread on the section containing `offset`. */
  createThread(root: string, relPath: string, offset: number, title: string): Promise<ThreadInfo>
  listThreads(root: string, relPath: string): Promise<ThreadInfo[]>
  /** Starts a thread inside `parentId`, on the parent's section as the parent proposes it. */
  createSubthread(root: string, relPath: string, parentId: string, title: string): Promise<ThreadInfo>
  listSubthreads(root: string, relPath: string, parentId: string): Promise<ThreadInfo[]>
  getThread(root: string, relPath: string, id: string): Promise<ThreadInfo | null>
  setThreadStatus(root: string, relPath: string, id: string, status: ThreadStatus): Promise<ThreadInfo>
  threadProposal(root: string, relPath: string, id: string): Promise<ThreadProposal>
  threadTranscript(root: string, id: string): Promise<ThreadMessage[]>
  approveThread(root: string, relPath: string, id: string): Promise<OpResult>
  /** The commit a merged thread landed in, with the doc before and after it; null otherwise. */
  threadLanded(root: string, relPath: string, id: string): Promise<ThreadLanded | null>
  /** Stops highlighting what the thread changed in the doc. */
  dismissThreadChanges(root: string, relPath: string, id: string): Promise<void>
  /** Resolves when the agent's turn ends; progress arrives through `onThreadEvent`. */
  sendThreadMessage(root: string, relPath: string, id: string, text: string): Promise<OpResult>
  cancelThreadTurn(root: string, id: string): Promise<boolean>
  answerThreadPermission(root: string, threadId: string, requestId: string, decision: PermissionDecision): Promise<boolean>
  onThreadEvent(listener: (root: string, relPath: string, threadId: string, event: ThreadEvent) => void): () => void

  /** Every terminal, in every context: running, and exited ones kept for their tab (and Resume) until closed. */
  listTerminals(): Promise<TerminalInfo[]>
  /** Starts a terminal in `root` (the docs repo or a worktree). */
  /** Creates the worktree, the implementation thread and its Claude session; refusals come back as `ok: false`. */
  startImplementation(request: ImplementationRequest): Promise<ImplementationStart>
  /** The implementation thread's session: its open terminal, or a new one that resumes it. */
  openImplementationSession(docsRoot: string, doc: string, id: string, cols: number, rows: number): Promise<TerminalInfo>
  /** Checks whether the implementation has landed and what its pull request is; landing marks it merged. */
  checkImplementation(docsRoot: string, doc: string, id: string): Promise<ThreadInfo>
  createTerminal(root: string, kind: TerminalKind, cols: number, rows: number): Promise<TerminalInfo>
  /** Starts an exited terminal again; a Claude session resumes its conversation when it has one. */
  restartTerminal(id: string, cols: number, rows: number): Promise<TerminalInfo>
  /** Asks first when a Claude session is busy. False when the user cancelled. */
  closeTerminal(id: string): Promise<boolean>
  /** Kept across restarts and relaunches; every tab and list showing the terminal follows. */
  renameTerminal(id: string, title: string): Promise<TerminalInfo>
  terminalSnapshot(id: string): Promise<TerminalSnapshot>
  writeTerminal(id: string, data: string): void
  resizeTerminal(id: string, cols: number, rows: number): void
  onTerminalData(listener: (id: string, data: string, seq: number) => void): () => void
  onTerminalChanged(listener: (info: TerminalInfo) => void): () => void
  onTerminalRemoved(listener: (id: string) => void): () => void
  /** An implementation session proposed a doc change; `thread` is the new thread holding it. */
  onDocProposed(listener: (docsRoot: string, thread: ThreadInfo) => void): () => void
  listMaps(docsRoot: string): Promise<MapSummary[]>
  getMap(docsRoot: string, id: string): Promise<MapDetail>
  /** Marks everything on the map's Activity as seen. */
  markMapSeen(docsRoot: string, id: string): Promise<void>
  /** The user opened the map: starts a visit, so `lastVisitedAt` marks the one before. */
  visitMap(docsRoot: string, id: string): Promise<void>
  createMap(docsRoot: string, input: NewMapInput): Promise<MapSummary>
  updateMap(docsRoot: string, id: string, settings: MapSettings): Promise<void>
  /** Asks the user to confirm, then deletes the map. Null when cancelled. */
  removeMap(docsRoot: string, id: string): Promise<OpResult | null>
  editMapTracker(docsRoot: string, id: string, edit: TrackerEdit): Promise<OpResult>
  /** Removes a ticket or a milestone, asking first when it has launches or tickets. Null when cancelled. */
  removeFromTracker(docsRoot: string, id: string, target: { ticket: string } | { milestone: string }): Promise<OpResult | null>
  editMapDocs(docsRoot: string, id: string, edit: MapDocsEdit): Promise<OpResult>
  /** Creates a doc in the docs repo and lists it on the map; resolves to its path. */
  /** `title` heads the new doc; without one it's headed by its file name. */
  createMapDoc(docsRoot: string, id: string, doc: MapDoc, title?: string): Promise<string>
  /** A doc's text as it stands now (the open editor's, else the file's); null when it isn't there. */
  mapDocText(docsRoot: string, relPath: string): Promise<string | null>
  /** Accepts or dismisses a suggestion. For a plan or a plan change, `pick` holds the indexes of the milestones or changes to accept; all when null. */
  resolveMapSuggestion(docsRoot: string, id: string, suggestion: string, accept: boolean, pick: number[] | null): Promise<SuggestionResult>
  /** A launch's journal, as markdown; empty when it has none. */
  mapJournal(docsRoot: string, id: string, launch: string): Promise<string>
  /** Creates the worktree (or reuses the milestone's) and starts a session on the scope; refusals come back as `ok: false`. */
  launchMapWork(request: MapLaunchRequest): Promise<MapLaunchStart>
  previewMapBrief(request: MapBriefRequest): Promise<MapBriefPreview>
  /** A session of the launch: its terminal when open, else a new one resuming it. `terminal` picks one; null for the latest. */
  openMapLaunch(docsRoot: string, id: string, launch: string, terminal: string | null, cols: number, rows: number): Promise<TerminalInfo>
  /** Looks up the launches' pull requests and whether they landed; ticket and milestone statuses follow. */
  checkMap(docsRoot: string, id: string): Promise<void>
  /** Pushes a finished launch's branch and opens a draft pull request for it. */
  openMapPullRequest(docsRoot: string, id: string, launch: string): Promise<OpResult>
  /** Sends a launch's failing checks or its pull request's review to its session, resuming the session when it's closed. */
  sendMapFeedback(docsRoot: string, id: string, launch: string, kind: MapFeedback, cols: number, rows: number): Promise<OpResult>
  /** Sends the user's review of a launch's work to its session. */
  requestMapChanges(docsRoot: string, id: string, launch: string, text: string, cols: number, rows: number): Promise<OpResult>
  /** Marks a ticket done after review, approving the doc updates (thread ids) its launches proposed that the user included. */
  markMapTicketDone(docsRoot: string, id: string, ticket: string, include: string[]): Promise<OpResult>
  /** The batch's coordinator session: its terminal when open, else started (or resumed). */
  coordinateMapBatch(docsRoot: string, id: string, batch: string, cols: number, rows: number): Promise<TerminalInfo>
  /** The user turned down a coordinator for the batch. */
  declineMapBatch(docsRoot: string, id: string, batch: string): Promise<void>
  /** Ask the map: resolves when the map agent's turn ends; progress arrives through `onMapEvent`. */
  sendMapMessage(docsRoot: string, id: string, text: string): Promise<OpResult>
  /** Asks the map agent to propose milestones and tickets from these docs. */
  breakDownMap(docsRoot: string, id: string, docs: string[]): Promise<OpResult>
  cancelMapTurn(docsRoot: string, id: string): Promise<boolean>
  answerMapPermission(docsRoot: string, id: string, requestId: string, decision: PermissionDecision): Promise<boolean>
  onMapEvent(listener: (docsRoot: string, id: string, event: ThreadEvent) => void): () => void
  /** The worktree's review comments, oldest first. */
  reviewComments(root: string): Promise<ReviewComment[]>
  addReviewComment(root: string, anchor: ReviewAnchor, body: string): Promise<ReviewComment>
  editReviewComment(root: string, id: string, body: string): Promise<void>
  removeReviewComments(root: string, ids: string[]): Promise<void>
  /** Sends the comments to a Claude session as one prompt, without switching to it; refusals come back as `ok: false`. */
  sendReviewComments(root: string, ids: string[], target: ReviewTarget): Promise<OpResult>
  onReviewCommentsChanged(listener: (root: string) => void): () => void
  /** The worktree branch's pull request, or why the PR tab can't show one. `force` skips the minute-long cache. */
  pullRequest(root: string, force: boolean): Promise<PullRequestStatus>
  /** Which of the worktree's pull request comments were sent to which agent, by GitHub node id. */
  pullRequestSent(root: string): Promise<Record<string, { to: string; at: string }>>
  /** Sends the PR's chosen comments behind the user's prompt template, without switching to the agent. */
  sendPullRequestComments(root: string, ids: string[], target: ReviewTarget): Promise<OpResult>
  /** The prompt put in front of PR comments; unconfirmed until the user has saved it once. */
  prTemplate(): Promise<{ text: string; confirmed: boolean }>
  setPrTemplate(text: string): Promise<void>
  /** `chosenBase` is the Branch tab's choice, if any. */
  draftPullRequestDefaults(root: string, chosenBase: string | null): Promise<{ title: string; base: string }>
  /** Pushes the branch if GitHub lacks any of it, then creates a draft PR. */
  createDraftPullRequest(root: string, input: { title: string; body: string; base: string }): Promise<OpResult>
  /**
   * Fetches the worktree branch's PR (as the PR tab last showed it) for review: its files and viewed ticks.
   * This and the other review calls refuse when the worktree has left the PR's branch, or `pullRequest`
   * isn't its PR any more.
   */
  openPullRequestReview(root: string, pullRequest: number): Promise<PullRequestReviewOpen>
  /** The line ranges, per side, that GitHub takes comments on in one file of the PR's diff. */
  pullRequestCommentable(root: string, base: string, head: string, relPath: string): Promise<{ old: [number, number][]; new: [number, number][] }>
  /** `fingerprint` from the review's file; null unticks. */
  setPullRequestFileViewed(root: string, pr: number, relPath: string, fingerprint: string | null): Promise<OpResult>
  /** Posts one line comment to GitHub at once, on `head`. */
  postPullRequestComment(root: string, pullRequest: number, head: string, anchor: ReviewAnchor, body: string): Promise<OpResult>
  /** Submits the pending review (the worktree's `pr:<n>` comments) with a verdict. */
  submitPullRequestReview(root: string, pullRequest: number, base: string, head: string, input: { event: ReviewEvent; body: string }): Promise<OpResult>
  /** Sends one comment to an agent without storing it, from a PR review's comment box. */
  sendReviewDraft(root: string, anchor: ReviewAnchor, body: string, target: ReviewTarget): Promise<OpResult>
  /** Manta changed a worktree's PR on GitHub: the PR tab refreshes past its cache. */
  onPullRequestChanged(listener: (root: string) => void): () => void
  /** The app menu's Close Tab (⌘W). */
  onCloseTab(listener: () => void): () => void
  /** The app menu's Go → Back (⌘[) and Forward (⌘]). */
  onNavigate(listener: (direction: 'back' | 'forward') => void): () => void
  /** Extra arguments every new or resumed Claude session gets after `claude`, as the user typed them. */
  claudeArgs(): Promise<string>
  /** Refused when the text has an open quote or a flag Manta sets itself. */
  setClaudeArgs(text: string): Promise<OpResult>

  claudeStatus(): Promise<ClaudeCodeStatus>
  /** Runs `claude auth login` (opens the browser) and resolves with the status once it exits. */
  claudeSignIn(): Promise<ClaudeCodeStatus>

  /**
   * The language servers for files of `languageId` in `root`, the primary one first, started if they
   * aren't running for this window. Empty when none takes the language; a server that keeps crashing
   * is left out unless `force` is set.
   */
  lspOpen(root: string, languageId: string, force: boolean): Promise<LanguageServerSession[]>
  /** One JSON-RPC message, without headers. */
  lspSend(session: string, message: string): void
  onLspMessage(listener: (session: string, message: string) => void): () => void
  onLspStatus(listener: (status: LanguageServerStatus) => void): () => void
  /** Language servers running or crashed, for the status bar after a reload. */
  lspStatuses(): Promise<LanguageServerStatus[]>
  /** Every Mason package plus system servers; `refresh` fetches the registry again instead of using the day-old cache. */
  pluginEntries(refresh: boolean): Promise<PluginEntry[]>
  /** Progress arrives through `onPluginProgress`. */
  installPlugin(name: string): Promise<OpResult>
  removePlugin(name: string): Promise<OpResult>
  setPluginServerEnabled(server: string, enabled: boolean): Promise<void>
  addCustomServer(input: CustomServerInput): Promise<OpResult>
  onPluginProgress(listener: (name: string, line: string) => void): () => void
  searchThemes(query: string): Promise<ThemeEntry[]>
  /** Downloads an Open VSX theme extension; one theme per variant it contributes (dark, light). */
  themeVariants(id: string): Promise<EditorTheme[]>
  /** The code editor's theme, or null for Manta's own colours; it's kept with the plugins. */
  setEditorTheme(theme: EditorTheme | null): Promise<void>
  editorTheme(): Promise<EditorTheme | null>
  /** A file the editor may show read-only: inside `root` but ignored by git (`node_modules`), or a language server's own library. */
  readOnlyFile(root: string, absolutePath: string): Promise<string | null>

  onRemoteUpdate(listener: (root: string, relPath: string, update: Uint8Array) => void): () => void
  /** Files changed on disk under a root, or git changed there. */
  onFilesChanged(listener: (change: FilesChanged) => void): () => void
}

export const Channel = {
  listProjects: 'projects:list',
  addProject: 'projects:add',
  removeProject: 'projects:remove',
  listWorktrees: 'worktrees:list',
  createWorktree: 'worktrees:create',
  removeWorktree: 'worktrees:remove',
  listFiles: 'repo:list-files',
  changes: 'repo:changes',
  fileAtHead: 'repo:file-at-head',
  fileAt: 'repo:file-at',
  branch: 'repo:branch',
  branches: 'repo:branches',
  commitFiles: 'repo:commit-files',
  repoStatus: 'repo:status',
  searchContent: 'repo:search-content',
  createFile: 'repo:create-file',
  createFolder: 'repo:create-folder',
  deletePath: 'repo:delete-path',
  openDoc: 'doc:open',
  createDoc: 'doc:create',
  pushUpdate: 'doc:push-update',
  saveFile: 'doc:save',
  formatFile: 'doc:format',
  revealDoc: 'doc:reveal',
  commit: 'repo:commit',
  stage: 'repo:stage',
  unstage: 'repo:unstage',
  discardChanges: 'repo:discard-changes',
  pull: 'repo:pull',
  push: 'repo:push',
  createThread: 'thread:create',
  listThreads: 'thread:list',
  createSubthread: 'thread:create-sub',
  listSubthreads: 'thread:list-sub',
  getThread: 'thread:get',
  setThreadStatus: 'thread:set-status',
  threadProposal: 'thread:proposal',
  threadTranscript: 'thread:transcript',
  approveThread: 'thread:approve',
  threadLanded: 'thread:landed',
  dismissThreadChanges: 'thread:dismiss-changes',
  sendThreadMessage: 'thread:send',
  cancelThreadTurn: 'thread:cancel',
  answerThreadPermission: 'thread:answer-permission',
  threadEvent: 'thread:event',
  listTerminals: 'terminal:list',
  startImplementation: 'implementation:start',
  openImplementationSession: 'implementation:open-session',
  checkImplementation: 'implementation:check',
  createTerminal: 'terminal:create',
  restartTerminal: 'terminal:restart',
  closeTerminal: 'terminal:close',
  renameTerminal: 'terminal:rename',
  terminalSnapshot: 'terminal:snapshot',
  writeTerminal: 'terminal:write',
  resizeTerminal: 'terminal:resize',
  terminalData: 'terminal:data',
  terminalChanged: 'terminal:changed',
  terminalRemoved: 'terminal:removed',
  docProposed: 'implementation:doc-proposed',
  listMaps: 'map:list',
  getMap: 'map:get',
  visitMap: 'map:visit',
  createMap: 'map:create',
  updateMap: 'map:update',
  removeMap: 'map:remove',
  editMapTracker: 'map:edit-tracker',
  removeFromTracker: 'map:remove-from-tracker',
  editMapDocs: 'map:edit-docs',
  createMapDoc: 'map:create-doc',
  mapDocText: 'map:doc-text',
  markMapSeen: 'map:mark-seen',
  resolveMapSuggestion: 'map:resolve-suggestion',
  mapJournal: 'map:journal',
  launchMapWork: 'map:launch',
  previewMapBrief: 'map:preview-brief',
  openMapLaunch: 'map:open-launch',
  checkMap: 'map:check',
  openMapPullRequest: 'map:open-pull-request',
  sendMapFeedback: 'map:send-feedback',
  requestMapChanges: 'map:request-changes',
  markMapTicketDone: 'map:mark-ticket-done',
  coordinateMapBatch: 'map:coordinate-batch',
  declineMapBatch: 'map:decline-batch',
  sendMapMessage: 'map:send',
  breakDownMap: 'map:break-down',
  cancelMapTurn: 'map:cancel',
  answerMapPermission: 'map:answer-permission',
  mapEvent: 'map:event',
  reviewComments: 'review:list',
  addReviewComment: 'review:add',
  editReviewComment: 'review:edit',
  removeReviewComments: 'review:remove',
  sendReviewComments: 'review:send',
  reviewCommentsChanged: 'review:changed',
  pullRequest: 'pr:status',
  pullRequestSent: 'pr:sent',
  sendPullRequestComments: 'pr:send',
  prTemplate: 'pr:template',
  setPrTemplate: 'pr:setTemplate',
  draftPullRequestDefaults: 'pr:draftDefaults',
  createDraftPullRequest: 'pr:createDraft',
  openPullRequestReview: 'pr:openReview',
  pullRequestCommentable: 'pr:commentable',
  setPullRequestFileViewed: 'pr:setViewed',
  postPullRequestComment: 'pr:postComment',
  submitPullRequestReview: 'pr:submitReview',
  sendReviewDraft: 'review:sendDraft',
  pullRequestChanged: 'pr:changed',
  closeTab: 'menu:close-tab',
  navigate: 'menu:navigate',
  claudeArgs: 'terminal:claude-args',
  setClaudeArgs: 'terminal:set-claude-args',
  claudeStatus: 'claude:status',
  claudeSignIn: 'claude:sign-in',
  lspOpen: 'lsp:open',
  lspSend: 'lsp:send',
  lspMessage: 'lsp:message',
  lspStatus: 'lsp:status',
  lspStatuses: 'lsp:statuses',
  readOnlyFile: 'lsp:read-only-file',
  pluginEntries: 'plugins:entries',
  installPlugin: 'plugins:install',
  removePlugin: 'plugins:remove',
  setPluginServerEnabled: 'plugins:set-enabled',
  addCustomServer: 'plugins:add-custom',
  pluginProgress: 'plugins:progress',
  searchThemes: 'themes:search',
  themeVariants: 'themes:variants',
  setEditorTheme: 'themes:set',
  editorTheme: 'themes:get',
  remoteUpdate: 'doc:remote-update',
  filesChanged: 'repo:files-changed'
} as const
