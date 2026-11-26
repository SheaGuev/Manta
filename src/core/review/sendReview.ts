import path from 'node:path'
import type { OpResult, PullRequestDetail, ReviewAnchor, ReviewTarget } from '../../shared/ipc'
import type { TerminalManager, TerminalSize } from '../terminal/terminals'
import { formatPullRequestMessage } from './pullRequestMessage'
import type { ReviewCommentStore } from './reviewComments'
import { formatReviewMessage } from './reviewMessage'

type Terminals = Pick<TerminalManager, 'sendPrompt' | 'create' | 'list'>

export interface DeliverRequest {
  terminals: Terminals
  /** The worktree a new session starts in. */
  root: string
  message: string
  target: ReviewTarget
  /** A new session's size until its tab fits it. */
  size: TerminalSize
}

/** Pastes `message` into a running Claude session, or starts a new one with it; `to` is the session's title once it's sent. */
export async function deliverPrompt({ terminals, root, message, target, size }: DeliverRequest): Promise<{ result: OpResult; to: string | null }> {
  if ('terminal' in target) {
    const result = await terminals.sendPrompt(target.terminal, message)
    const title = terminals.list().find((t) => t.id === target.terminal)?.title ?? null
    return { result, to: result.ok ? title : null }
  }
  const created = await terminals.create(root, 'claude', size, { prompt: message })
  return { result: { ok: true, message: `Sent to a new session, ${created.title}` }, to: created.title }
}

export interface SendReviewRequest extends Omit<DeliverRequest, 'message'> {
  store: ReviewCommentStore
  /** The worktree the comments were made in; its folder name heads the message. */
  ids: readonly string[]
}

/** Sends stored comments as one prompt, to a running Claude session or a new one, and marks them sent to it. */
export async function sendReview({ store, ids, ...request }: SendReviewRequest): Promise<OpResult> {
  const comments = (await store.list()).filter((comment) => ids.includes(comment.id))
  if (comments.length === 0) return { ok: false, message: 'Nothing to send' }
  const { result, to } = await deliverPrompt({ ...request, message: formatReviewMessage(comments, path.basename(request.root)) })
  if (to) await store.markSent(comments.map((comment) => comment.id), to)
  return result
}

/** Sends one comment straight from a PR review's comment box, without storing it: it would look like a pending GitHub comment. */
export async function sendReviewDraft({ anchor, body, ...request }: Omit<DeliverRequest, 'message'> & { anchor: ReviewAnchor; body: string }): Promise<OpResult> {
  const comment = { ...anchor, id: '', body, createdAt: new Date().toISOString(), sent: null }
  return (await deliverPrompt({ ...request, message: formatReviewMessage([comment], path.basename(request.root)) })).result
}

export interface SendPullRequestCommentsRequest extends SendReviewRequest {
  pr: PullRequestDetail
  /** The user's prompt, put in front of the comments. */
  template: string
}

/** Sends a pull request's chosen comments behind the user's template, and marks them sent to the agent. */
export async function sendPullRequestComments({ store, ids, pr, template, ...request }: SendPullRequestCommentsRequest): Promise<OpResult> {
  const comments = pr.comments.filter((comment) => ids.includes(comment.id))
  if (comments.length === 0) return { ok: false, message: 'Nothing to send' }
  const message = formatPullRequestMessage(template, pr, comments, path.basename(request.root))
  const { result, to } = await deliverPrompt({ ...request, message })
  if (to) await store.markPullRequestSent(comments.map((comment) => comment.id), to)
  return result
}
