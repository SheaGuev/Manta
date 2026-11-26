import { ChevronRight, CircleCheck, CircleMinus, CircleX, ExternalLink, FileSearch, LoaderCircle, RotateCw } from 'lucide-react'
import { useCallback, useState } from 'react'
import type { OpResult, PullRequestCheck, PullRequestComment, PullRequestDetail, ReviewTarget } from '../../../shared/ipc'
import { usePersistentSet, usePersistentString, usePullRequest, usePullRequestSent, useFocusCount } from '../lib/hooks'
import { checkSummary, chosenToSend, initiallyTicked, orderComments, readTicks } from '../lib/pullRequestView'
import { AgentPicker } from './AgentPicker'
import { DraftPullRequestDialog } from './DraftPullRequestDialog'
import { PromptTemplateDialog } from './PromptTemplateDialog'

const api = window.manta

interface PullRequestPanelProps {
  root: string
  /** The Branch tab's compare choice: a new draft PR's default base. */
  chosenBase: string | null
  onReviewFiles: (pullRequest: number) => void
  onResult: (result: OpResult) => void
  onError: (message: string) => void
}

const fileName = (relPath: string): string => relPath.split('/').pop() ?? relPath

const CHECK_ICONS: Record<PullRequestCheck['state'], React.JSX.Element> = {
  passed: <CircleCheck size={14} className="pr-check-icon passed" />,
  failed: <CircleX size={14} className="pr-check-icon failed" />,
  running: <LoaderCircle size={14} className="pr-check-icon running spin" />,
  skipped: <CircleMinus size={14} className="pr-check-icon skipped" />
}

function place(comment: PullRequestComment): string {
  if (comment.kind === 'comment') return 'conversation'
  if (comment.kind === 'review') return comment.verdict ?? 'review'
  return `${fileName(comment.path ?? '')}${comment.line === null ? '' : `:${comment.line}`}`
}

/** A template prompt waiting on the user: before the first send, or edited from the picker. */
type TemplatePrompt = { text: string; send: ReviewTarget | null }

/**
 * The PR tab: the worktree branch's pull request, its CI checks and its comments. Ticked comments go
 * to an agent behind the user's prompt template; with no PR, a draft can be created.
 */
export function PullRequestPanel({ root, chosenBase, onReviewFiles, onResult, onError }: PullRequestPanelProps): React.JSX.Element {
  const focusCount = useFocusCount()
  const { status, error, loading, refresh } = usePullRequest(root, focusCount)
  const sent = usePullRequestSent(root)
  const [isCollapsed, toggleCollapsed] = usePersistentSet(`manta.pr-collapsed:${root}`)
  /**
   * Kept per worktree and PR, so switching tabs or relaunching doesn't lose them. Null until the user
   * ticks or unticks anything: then unresolved current threads not yet sent are ticked.
   */
  const [storedTicks, storeTicks] = usePersistentString(`manta.pr-ticks:${root}:${status?.kind === 'found' ? status.pr.number : 'none'}`)
  const ticked = readTicks(storedTicks)
  const setTicked = (next: ReadonlySet<string>): void => storeTicks(JSON.stringify([...next]))
  const [checksOpen, setChecksOpen] = useState<boolean | null>(null)
  const [picking, setPicking] = useState<DOMRect | null>(null)
  const [template, setTemplate] = useState<TemplatePrompt | null>(null)
  const [drafting, setDrafting] = useState(false)
  const closePicker = useCallback(() => setPicking(null), [])
  const report = (error: unknown): void => onError(error instanceof Error ? error.message : String(error))

  const refreshButton = (
    <button className="icon-button" title="Refresh" onClick={refresh}>
      <RotateCw size={14} className={loading ? 'spin' : ''} />
    </button>
  )

  if (!status) {
    return (
      <div className="pr-panel">
        <div className="row muted-row pr-message">
          <span className="pr-message-text">Looking for this branch's pull request…</span>
          {refreshButton}
        </div>
      </div>
    )
  }
  if (status.kind === 'unavailable') {
    return (
      <div className="pr-panel">
        <div className="row muted-row pr-message">
          <span className="pr-message-text">{status.reason}</span>
          {refreshButton}
        </div>
      </div>
    )
  }
  if (status.kind === 'none') {
    return (
      <div className="pr-panel">
        <div className="row muted-row pr-message">
          <span className="pr-message-text">No pull request for {status.branch}</span>
          {refreshButton}
        </div>
        <div className="pr-actions">
          <button className="primary-button small accent" onClick={() => setDrafting(true)}>
            Create draft PR
          </button>
        </div>
        {drafting && (
          <DraftPullRequestDialog
            root={root}
            chosenBase={chosenBase}
            onClose={() => setDrafting(false)}
            onDone={(result) => {
              setDrafting(false)
              onResult(result)
              refresh()
            }}
          />
        )}
      </div>
    )
  }

  const pr: PullRequestDetail = status.pr
  const { open, resolved } = orderComments(pr.comments)
  const ticks = ticked ?? new Set([...initiallyTicked(pr.comments)].filter((id) => !sent[id]))
  const resolvedOpen = isCollapsed('resolved-shown')
  /** Only what's in sight: a ticked thread that has since been resolved isn't sent from a closed group. */
  const chosen = chosenToSend(pr.comments, ticks, resolvedOpen)
  const showChecks = checksOpen ?? pr.checks.some((c) => c.state !== 'passed' && c.state !== 'skipped')
  const commentsOpen = !isCollapsed('comments')
  const tick = (id: string): void => {
    const next = new Set(ticks)
    if (!next.delete(id)) next.add(id)
    setTicked(next)
  }

  const send = (target: ReviewTarget, ids: string[]): void => {
    api
      .sendPullRequestComments(root, ids, target)
      .then((result) => {
        onResult(result)
        if (result.ok) setTicked(new Set([...ticks].filter((id) => !ids.includes(id))))
      })
      .catch(report)
  }

  const row = (comment: PullRequestComment): React.JSX.Element => {
    const mark = sent[comment.id]
    return (
      <div
        key={comment.id}
        className={`row review-comment-row pr-comment-row${mark ? ' sent' : ''}`}
        title={`@${comment.author}\n${comment.body}`}
        onClick={() => tick(comment.id)}
      >
        <input type="checkbox" checked={ticks.has(comment.id)} onClick={(e) => e.stopPropagation()} onChange={() => tick(comment.id)} />
        <span className="pr-comment-author">@{comment.author}</span>
        <span className={`review-comment-place${comment.outdated ? ' outdated' : ''}`}>{place(comment)}</span>
        <span className="review-comment-body">{comment.body.split('\n')[0]}</span>
        {mark && <span className="review-comment-sent">sent to {mark.to}</span>}
        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
          <a className="icon-button" href={comment.url} target="_blank" rel="noreferrer" title="Open on GitHub">
            <ExternalLink size={13} />
          </a>
        </span>
      </div>
    )
  }

  return (
    <div className="pr-panel">
      <div className="pr-head">
        <div className="pr-title">
          {pr.title} <span className="pr-number">#{pr.number}</span>
        </div>
        <div className="pr-meta">
          <span className={`badge pr-state ${pr.state}`}>{pr.state}</span>
          <span className="pr-refs">
            {pr.baseRefName} ← {pr.headRefName}
          </span>
          <button className="icon-button" title="Review files" onClick={() => onReviewFiles(pr.number)}>
            <FileSearch size={14} />
          </button>
          <a className="icon-button" href={pr.url} target="_blank" rel="noreferrer" title="Open on GitHub">
            <ExternalLink size={14} />
          </a>
          {refreshButton}
        </div>
        {error && <div className="pr-error">Couldn't refresh: {error}</div>}
      </div>

      {pr.checks.length > 0 && (
        <section className="change-section">
          <div className="row change-section-head" onClick={() => setChecksOpen(!showChecks)}>
            <ChevronRight size={14} className={`chevron ${showChecks ? 'open' : ''}`} />
            <span className="label">Checks</span>
            <span className="pr-section-summary">{checkSummary(pr.checks)}</span>
          </div>
          {showChecks &&
            pr.checks.map((check, index) =>
              check.url ? (
                /** Names repeat when a workflow runs on both push and pull_request. */
                <a key={`${index}:${check.name}`} className="row pr-check-row" href={check.url} target="_blank" rel="noreferrer" title="Open its logs">
                  {CHECK_ICONS[check.state]}
                  <span className="pr-check-name">{check.name}</span>
                </a>
              ) : (
                <div key={`${index}:${check.name}`} className="row pr-check-row">
                  {CHECK_ICONS[check.state]}
                  <span className="pr-check-name">{check.name}</span>
                </div>
              )
            )}
        </section>
      )}

      <section className="change-section review-comments">
        <div className="row change-section-head" onClick={() => toggleCollapsed('comments')}>
          <ChevronRight size={14} className={`chevron ${commentsOpen ? 'open' : ''}`} />
          <span className="label">Comments</span>
          {pr.comments.length > 0 && <span className="badge">{pr.comments.length}</span>}
        </div>
        {commentsOpen && (
          <>
            {pr.comments.length === 0 && <div className="row muted-row pr-indent">No comments yet</div>}
            {open.map(row)}
            {resolved.length > 0 && (
              <div className="row muted-row pr-resolved-head" onClick={() => toggleCollapsed('resolved-shown')}>
                <ChevronRight size={12} className={`chevron ${resolvedOpen ? 'open' : ''}`} />
                Resolved ({resolved.length})
              </div>
            )}
            {resolvedOpen && resolved.map(row)}
            {pr.truncated && <div className="row muted-row pr-indent">Only the first 100 review threads are shown</div>}
            {pr.comments.length > 0 && (
              <div className="review-comments-actions">
                <button className="primary-button small accent" disabled={chosen.length === 0} onClick={(e) => setPicking(e.currentTarget.getBoundingClientRect())}>
                  Send {chosen.length} to agent…
                </button>
              </div>
            )}
          </>
        )}
      </section>

      {picking && (
        <AgentPicker
          root={root}
          anchorRect={picking}
          onClose={closePicker}
          footer={
            <button
              className="link-button"
              onClick={() => {
                setPicking(null)
                api
                  .prTemplate()
                  .then(({ text }) => setTemplate({ text, send: null }))
                  .catch(report)
              }}
            >
              Edit prompt…
            </button>
          }
          onPick={(target) => {
            setPicking(null)
            api
              .prTemplate()
              .then(({ text, confirmed }) => (confirmed ? send(target, chosen) : setTemplate({ text, send: target })))
              .catch(report)
          }}
        />
      )}
      {template && (
        <PromptTemplateDialog
          initial={template.text}
          confirmLabel={template.send ? 'Send' : 'Save'}
          onClose={() => setTemplate(null)}
          onConfirm={(text) => {
            const target = template.send
            setTemplate(null)
            api
              .setPrTemplate(text)
              .then(() => target && send(target, chosen))
              .catch(report)
          }}
        />
      )}
    </div>
  )
}
